// 主机控制器：采集、建房、订阅、逐观众连接、暂停/声音/画质、停止。
import { PeerLink, setIceConfig } from './rtc.js';
import { StatsMonitor } from './stats.js';
import { describe } from './errors.js';
import { $, el, toast, blocking, setInlineStatus, clearInlineStatus, copyText, reportError } from './ui.js';
import { icons } from './icons.js';
import { ChatManager } from './chat.js';
import {
  DEFAULT_QUALITY, getProfile, formatProfile,
  captureConstraints, switchConstraints, encodingProfile,
} from './quality.js';

export class HostController {
  constructor(signal) {
    this.signal = signal;
    this.stream = null;
    this.links = new Map();          // viewerPeerId -> PeerLink
    this.monitors = new Map();       // viewerPeerId -> StatsMonitor
    this.paused = false;
    this.audioEnabled = false;
    this.quality = DEFAULT_QUALITY;
    this._qualitySeq = 0;
    this.stopped = false;
    this.firstFramed = new Set();    // 已回首帧回执的观众
    this.recordingPeers = new Set(); // 正在应用内录制的观众
    this.iceOk = false;
    this.restartTimers = new Map();
    this._unsub = [];
  }

  async start(maxViewers = 3, quality = DEFAULT_QUALITY, inviteOrigin) {
    // 能力预检
    if (!window.isSecureContext) { blocking('E-001'); return false; }
    if (!navigator.mediaDevices?.getDisplayMedia) { blocking('E-002'); return false; }
    if (!window.RTCPeerConnection) { blocking('E-003'); return false; }

    this.quality = getProfile(quality).key;

    // 必须在用户手势中调用
    const constraints = {
      video: captureConstraints(this.quality),
      audio: true,
    };
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia(constraints);
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') blocking('E-101', { onAction: () => location.reload() });
      else blocking('E-102', { onAction: () => location.reload() });
      return false;
    }
    const vtrack = this.stream.getVideoTracks()[0];
    if (!vtrack || vtrack.readyState !== 'live') {
      blocking('E-102', { onAction: () => location.reload() });
      return false;
    }
    if ('contentHint' in vtrack) vtrack.contentHint = getProfile(this.quality).hint;
    vtrack.addEventListener('ended', () => this.stop(true));

    // 本地预览
    const preview = $('#host-preview');
    if (preview) {
      preview.srcObject = this.stream;
      preview.play().catch(() => {});
    }

    const audioTracks = this.stream.getAudioTracks();
    this.audioEnabled = audioTracks.length > 0;
    audioTracks.forEach((t) => { t.enabled = this.audioEnabled; });

    // 建房（getDisplayMedia 已在上方用户手势内完成，此处再做网络初始化）
    try {
      await this.signal.bootstrap();
      await this.signal.createRoom(maxViewers, inviteOrigin);
    } catch (e) {
      this._stopTracks();
      reportError(e);
      return false;
    }

    // ICE 配置
    try {
      const ice = await this.signal.ice();
      setIceConfig(ice.iceServers);
      this.iceOk = true;
    } catch { /* 用默认 STUN */ }

    this._bind();
    this.chat = new ChatManager(this.signal);
    this.chat.init();
    this.signal.subscribe();
    this.signal.onStatus = (s) => {
      if (s === 'reconnecting') setInlineStatus('E-501', 'warn');
      else clearInlineStatus();
    };

    this._render();
    return true;
  }

  _bind() {
    this._unsub.push(
      this.signal.on('peer-ready', (d) => this._onPeerReady(d)),
      this.signal.on('signal', (d) => this._onSignal(d)),
      this.signal.on('viewer-state', (d) => this._onViewerState(d)),
      this.signal.on('snapshot', (d) => this._onSnapshot(d)),
      this.signal.on('peer-left', (d) => this._removeLink(d.peerId)),
      this.signal.on('room-closed', () => this.stop(true)),
      this.signal.on('room-gone', () => this.stop(true, {
        title: '会话已失效',
        text: '信令服务已重启或房间已过期，本次共享已结束。请重新开始共享。',
      })),
      this.signal.on('channel-lost', () => this.stop(true, {
        title: '控制通道失联',
        text: '超过 5 分钟无法连接信令服务，本次共享已结束。确认服务仍在运行后可重新开始共享。',
      })),
    );
  }

  _onViewerState(d) {
    if (d.firstFrame && d.peerId) this.firstFramed.add(d.peerId);
    if (typeof d.recording === 'boolean' && d.peerId) {
      if (d.recording) this.recordingPeers.add(d.peerId);
      else this.recordingPeers.delete(d.peerId);
    }
    this._render();
  }

  _onSnapshot(d) {
    for (const v of d.viewers || []) {
      if (v.firstFrame) this.firstFramed.add(v.peerId);
      if (v.recording) this.recordingPeers.add(v.peerId);
    }
    this._render();
  }

  async _onPeerReady(d) {
    if (this.stopped) return;
    const existing = this.links.get(d.peerId);
    if (existing) {
      // 观众刷新/重加会复用同一 peerId：旧连接已死时必须重新协商，
      // 否则新页面永远等不到 offer（F05 刷新恢复原席位）。
      if (existing.pc?.connectionState !== 'connected') {
        existing.restartIce().catch((e) => console.warn('[host] 重加协商', e));
      }
      return;
    }
    const link = new PeerLink({
      role: 'host', peerId: d.peerId, signal: this.signal, generation: d.generation || 1,
      onStats: (s) => this._onStats(d.peerId, s),
    });
    link.on('failed', () => this._retry(d.peerId));
    link.on('disconnected', () => setInlineStatus('对方连接波动，正在等待恢复…', 'warn'));
    link.on('connected', () => clearInlineStatus());
    this.links.set(d.peerId, link);
    this.monitors.set(d.peerId, new StatsMonitor(() => this._renderStats()));
    await link.addTracks(this.stream);
    link.setBitrate(encodingProfile(this.stream.getVideoTracks()[0], this.quality));
    this._applyPause(link);
    try { await link.offer(); }
    catch (e) { console.error('[host] offer 失败', e); }
    this._render();
  }

  async _onSignal(d) {
    const link = this.links.get(d.from);
    if (!link) return;
    try {
      if (d.type === 'answer') await link.onAnswer(d.payload.sdp, d.generation);
      else if (d.type === 'candidate') await link.onCandidate(d.payload.candidate);
      else if (d.type === 'restart-request') await link.restartIce();
    } catch (e) {
      console.error('[host] 信号处理失败', d.type, e);
    }
  }

  _retry(peerId) {
    if (this.restartTimers.has(peerId)) return;
    const link = this.links.get(peerId);
    if (!link || link.restartCount >= 2) {
      setInlineStatus(this.signal.turnConfigured ? 'E-301' : 'E-303', 'error');
      return;
    }
    link.restartCount++;
    const delay = link.restartCount === 1 ? 1000 : 3000;
    const timer = setTimeout(async () => {
      this.restartTimers.delete(peerId);
      try {
        const ice = await this.signal.ice();
        setIceConfig(ice.iceServers);
        this.iceOk = true;
      } catch { /* 沿用旧配置 */ }
      try { await link.restartIce(); }
      catch (e) { console.warn('[host] restartIce', e); }
    }, delay);
    this.restartTimers.set(peerId, timer);
  }

  _onStats(peerId, s) {
    this.monitors.get(peerId)?.sample(s);
    if (this.monitors.get(peerId)?.unstable) setInlineStatus('E-401', 'warn');
  }

  _applyPause(link) {
    if (!link.pc) return;
    for (const s of link.pc.getSenders()) {
      const t = s.track;
      if (!t) continue;
      t.enabled = t.kind === 'video' ? !this.paused : (!this.paused && this.audioEnabled);
    }
  }

  async togglePause() {
    this.paused = !this.paused;
    for (const track of this.stream.getTracks()) {
      // 恢复时音频遵循原有开关，不因暂停/恢复而被重新打开
      track.enabled = track.kind === 'video' ? !this.paused : (!this.paused && this.audioEnabled);
    }
    for (const link of this.links.values()) this._applyPause(link);
    try { await this.signal.state('paused', { value: this.paused }); }
    catch { /* 离线时本地优先 */ }
    this._render();
  }

  async toggleAudio() {
    const tracks = this.stream.getAudioTracks();
    if (!tracks.length) {
      toast('本次共享未包含声音。请停止后重新选源，并在系统选择器中勾选共享音频。');
      return;
    }
    this.audioEnabled = !this.audioEnabled;
    tracks.forEach((t) => { t.enabled = this.audioEnabled && !this.paused; });
    try { await this.signal.state('audioEnabled', { value: this.audioEnabled }); }
    catch { /* ignore */ }
    this._render();
  }

  async setQuality(q) {
    if (this.stopped) return;
    const p = getProfile(q);
    const seq = ++this._qualitySeq;
    if (p.key === this.quality && !this._qualityBusy) return;
    // 串行化：浏览器对同一轨道的并发 applyConstraints 会互相冲突，
    // 让旧请求先把轨道让出来，再只执行最后一次选择。
    if (this._qualityBusy) {
      try { await this._qualityBusy; } catch { /* ignore */ }
      if (seq !== this._qualitySeq || this.stopped) return;
    }
    const vtrack = this.stream?.getVideoTracks()[0];
    if (!vtrack || vtrack.readyState !== 'live') return;

    let release;
    this._qualityBusy = new Promise((r) => { release = r; });
    try {
      const { frameRate } = switchConstraints(p.key);
      let applied = false;
      try {
        await vtrack.applyConstraints({ frameRate });
        applied = true;
      } catch {
        // 源设备达不到 max 时，去掉 max 只保留理想值再试一次
        try {
          await vtrack.applyConstraints({ frameRate: { ideal: p.fps } });
          applied = true;
        } catch (e) {
          console.warn('[host] 切档失败', e);
        }
      }
      if (seq !== this._qualitySeq || this.stopped) return;
      if (!applied) {
        // 切档失败保持原档位，界面与实际参数一致
        toast('E-402');
        this._render();
        return;
      }

      this.quality = p.key;
      if ('contentHint' in vtrack) vtrack.contentHint = p.hint;
      for (const link of this.links.values()) {
        link.setBitrate(encodingProfile(vtrack, p.key));
      }
      toast(`已切到 ${p.label}（${formatProfile(p.key)}）`);
      this._render();
    } finally {
      this._qualityBusy = null;
      release();
    }
  }

  async copyInvite(btn) {
    try {
      await copyText(this.signal.inviteUrl);
      const old = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => { btn.textContent = old; }, 1600);
    } catch {
      const text = this.signal.inviteUrl;
      blocking('复制链接失败', {
        title: '手动复制', text: '请选中下面的地址手动复制：', action: '关闭',
      });
      const p = document.querySelector('#blocking .blocking-card p');
      if (p) {
        const input = el('input', { class: 'manual-copy', value: text, readonly: 'readonly' });
        p.append(input);
        input.addEventListener('click', () => input.select());
      }
    }
  }

  _removeLink(peerId) {
    this.links.get(peerId)?.close();
    this.links.delete(peerId);
    this.monitors.delete(peerId);
    this.firstFramed.delete(peerId);
    this.recordingPeers.delete(peerId);
    const t = this.restartTimers.get(peerId);
    if (t) { clearTimeout(t); this.restartTimers.delete(peerId); }
    this._render();
  }

  async stop(fromSystem = false, endInfo = null) {
    if (this.stopped) return;
    this.stopped = true;
    $('#host-qr-panel')?.hidePopover?.();
    for (const t of this.restartTimers.values()) clearTimeout(t);
    this.restartTimers.clear();
    for (const link of this.links.values()) link.close();
    this.links.clear();
    this.monitors.clear();
    this._stopTracks();
    this.chat?.destroy();
    for (const un of this._unsub) un();
    this._unsub = [];
    await this.signal.close();
    this.signal.destroy();
    if (endInfo) {
      blocking(endInfo.title, { title: endInfo.title, text: endInfo.text, action: '返回首页', onAction: () => location.href = '/' });
    } else if (fromSystem) {
      // 浏览器原生"停止共享"或服务端关房：显示结束提示，可返回重新开始
      blocking('E-103', { onAction: () => location.href = '/' });
    } else {
      blocking('共享已结束', { title: '已停止共享', text: '所有观众已收到结束提示。', action: '返回首页', onAction: () => location.href = '/' });
    }
  }

  _stopTracks() {
    if (this.stream) {
      for (const t of this.stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
      this.stream = null;
    }
  }

  _render() {
    const codeEl = $('#host-code');
    if (codeEl) codeEl.textContent = this.signal.code;
    const dot = $('#host-dot');
    if (dot) dot.classList.toggle('live', [...this.links.values()].some((l) => l.pc?.connectionState === 'connected'));
    const watching = $('#host-watching');
    if (watching) {
      const all = [...this.links.entries()];
      const watched = all.filter(([id, l]) => l.pc?.connectionState === 'connected' && this.firstFramed.has(id)).length;
      const connecting = all.length - watched;
      const recording = all.filter(([id]) => this.recordingPeers.has(id)).length;
      const parts = [];
      if (watched) parts.push(`${watched} 人正在观看`);
      if (connecting) parts.push(`${connecting} 人正在连接`);
      if (recording) parts.push(`${recording} 人录制中`);
      watching.textContent = parts.length ? parts.join(' · ') : '等待观众加入';
    }
    const pauseBtn = $('#host-pause');
    if (pauseBtn) {
      pauseBtn.innerHTML = `${this.paused ? icons.play() : icons.pause()}<span>${this.paused ? '恢复' : '暂停'}</span>`;
      pauseBtn.setAttribute('aria-pressed', String(this.paused));
    }
    const audioBtn = $('#host-audio');
    if (audioBtn) {
      const hasAudio = !!this.stream?.getAudioTracks().length;
      audioBtn.disabled = !hasAudio;
      audioBtn.innerHTML = `${this.audioEnabled ? icons.audio() : icons.mute()}<span>${hasAudio ? (this.audioEnabled ? '声音开' : '声音关') : '无声音'}</span>`;
    }
    const qSel = $('#host-quality-select');
    if (qSel && qSel.value !== this.quality) qSel.value = this.quality;
    const src = $('#host-source');
    if (src && this.stream) src.textContent = this.stream.getVideoTracks()[0]?.label || '当前窗口';
  }

  _renderStats() {
    const box = $('#host-stats');
    if (!box) return;
    const rows = [...this.monitors.entries()].map(([peerId, m]) => {
      const s = m.snapshot();
      return `<div class="stat-row"><span class="mono">${peerId.slice(0, 6)}</span><span>${s.rttText}</span><span>${s.modeText}</span><span>${s.fpsText}</span><span>${s.bitrateText}</span></div>`;
    });
    box.innerHTML = rows.join('') || '<div class="muted">暂无观众连接</div>';
  }
}
