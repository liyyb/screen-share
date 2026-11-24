// 观众控制器：加入、播放、首帧回执、暂停遮罩、ended、录制、重连。
import { PeerLink, setIceConfig } from './rtc.js';
import { StatsMonitor, formatDuration } from './stats.js';
import { LocalRecorder } from './recorder.js';
import { describe, ApiError } from './errors.js';
import { $, el, toast, blocking, setInlineStatus, clearInlineStatus, reportError } from './ui.js';
import { icons } from './icons.js';
import { ChatManager } from './chat.js';

export class ViewerController {
  constructor(signal, code) {
    this.signal = signal;
    this.code = code;
    this.link = null;
    this.monitor = new StatsMonitor((s) => this._renderStats(s));
    this.recorder = null;
    this.recording = false;
    this.remoteStream = null;
    this.paused = false;
    this.ended = false;
    this._left = false;
    this.resumed = false;
    this.firstFrame = false;
    this.firstFrameReported = false;
    this.mediaState = 'joining';
    this.playRequired = false;
    this.iceOk = false;
    this._unsub = [];
    this._firstFrameTimer = null;
    this._cancelFrameWatch = null;
  }

  async start() {
    if (!window.RTCPeerConnection) { blocking('E-003'); return false; }
    try {
      await this.signal.joinRoom(this.code);
    } catch (e) {
      if (e instanceof ApiError) {
        const back = ['E-201', 'E-202', 'E-401A'].includes(e.code);
        blocking(e.code, { text: e.message, onAction: back ? () => location.href = '/' : undefined });
      } else {
        reportError(e, 'E-301');
      }
      return false;
    }
    // 判断是否刷新恢复：同一标签页刷新后 sessionStorage 仍保留，session 与席位复用
    const key = 'share-room';
    this.resumed = sessionStorage.getItem(key) === this.signal.roomId;
    try { sessionStorage.setItem(key, this.signal.roomId); } catch { /* ignore */ }
    try {
      const ice = await this.signal.ice();
      setIceConfig(ice.iceServers);
      this.iceOk = true;
    } catch { /* 默认 STUN */ }

    this._bind();
    this.chat = new ChatManager(this.signal);
    this.chat.init();
    this.signal.subscribe();
    this.signal.onStatus = (s) => {
      if (s === 'reconnecting') setInlineStatus('E-501', 'warn');
      else {
        clearInlineStatus();
        this._reportFirstFrame();
      }
    };
    this._unsub.push(
      this.signal.on('channel-lost', () => this._end('信令服务连接已丢失，本次观看结束。请重新打开邀请链接加入。')),
      this.signal.on('room-gone', () => this._end('信令服务已重启或房间已过期。请重新打开邀请链接加入。')),
    );
    this._renderRecord();
    const muteBtn = $('#viewer-mute');
    if (muteBtn && !muteBtn.innerHTML.trim()) muteBtn.innerHTML = icons.mute();
    this.mediaState = 'connecting';
    this._render();
    return true;
  }

  _bind() {
    this._unsub.push(
      this.signal.on('peer-ready', (d) => {
        if (d.peerId === this.signal.peerId) this._connect();
      }),
      this.signal.on('signal', (d) => this._onSignal(d)),
      this.signal.on('host-state', (d) => this._onHostState(d)),
      this.signal.on('room-closed', () => this._end('演示者已结束共享')),
      this.signal.on('resync', () => this._resync()),
      this.signal.on('snapshot', (d) => this._onSnapshot(d)),
    );
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this._onVisible();
    });
    // 只有真正卸载才释放席位。手机进入全屏常会触发 pagehide 并把页面放进 bfcache
    // （persisted=true），此时释放席位会让返回后的会话失效，看起来像“退出全屏就回首页”。
    window.addEventListener('pagehide', (e) => { if (!e.persisted) this._releaseSeat(); });
  }

  _releaseSeat() {
    if (this.ended || this._left) return;
    this._left = true;
    const { roomId, peerId } = this.signal;
    if (!roomId || !peerId) return;
    try {
      navigator.sendBeacon?.(`/api/rooms/${roomId}/leave`,
        new Blob([JSON.stringify({ peerId })], { type: 'application/json' }));
    } catch { /* 尽力而为 */ }
  }

  async _connect() {
    if (this.link || this.ended) return;
    this.link = new PeerLink({
      role: 'viewer', peerId: this.signal.hostPeerId, signal: this.signal,
      generation: 1, onStats: (s) => this.monitor.sample(s),
    });
    this.link.on('track', (stream) => this._onTrack(stream));
    this.link.on('connected', () => {
      this.mediaState = 'connected';
      clearInlineStatus();
      this._render();
    });
    this.link.on('disconnected', () => {
      this.mediaState = 'reconnecting';
      this._render();
    });
    this.link.on('failed', () => this._retry());
    this.link._createPc();
    if (this.resumed) {
      // 刷新恢复：主机侧可能仍持有旧连接，主动请求重新协商，避免新页面等不到 offer
      this.link.restartIce().catch((e) => console.warn('[viewer] 恢复协商', e));
    }
    this._render();
  }

  async _onSignal(d) {
    if (!this.link) await this._connect();
    try {
      if (d.type === 'offer') await this.link.onOffer(d.payload.sdp, d.generation);
      else if (d.type === 'candidate') await this.link.onCandidate(d.payload.candidate);
    } catch (e) {
      console.error('[viewer] 信号处理失败', d.type, e);
    }
  }

  _onTrack(stream) {
    if (this.ended || this._left) return;
    this.remoteStream = stream;
    const video = $('#viewer-video');
    if (!video) return;
    if (video.srcObject !== stream) {
      this._clearFrameWatch();
      video.srcObject = stream;
    }
    if (!this.firstFrame && !this._cancelFrameWatch && stream.getVideoTracks().length) {
      this._watchFirstFrame(video);
    }
    this._renderPause();
  }

  _watchFirstFrame(video) {
    const confirm = () => {
      if (this.ended || this._left || this.paused || video.paused || video.videoWidth === 0) return false;
      this._onFirstFrame();
      return true;
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      let callbackId;
      const onFrame = () => {
        if (!confirm()) callbackId = video.requestVideoFrameCallback(onFrame);
      };
      callbackId = video.requestVideoFrameCallback(onFrame);
      this._cancelFrameWatch = () => video.cancelVideoFrameCallback(callbackId);
    } else {
      const onTimeUpdate = () => {
        if (video.currentTime > 0) confirm();
      };
      video.addEventListener('timeupdate', onTimeUpdate);
      this._cancelFrameWatch = () => video.removeEventListener('timeupdate', onTimeUpdate);
    }
    this._firstFrameTimer = setTimeout(() => {
      if (!this.paused && !this.playRequired) setInlineStatus('画面加载较慢，请稍候或重新加入', 'warn');
    }, 10_000);
  }

  _clearFrameWatch() {
    clearTimeout(this._firstFrameTimer);
    this._cancelFrameWatch?.();
    this._cancelFrameWatch = null;
  }

  _onFirstFrame() {
    if (this.firstFrame) return;
    this.firstFrame = true;
    this._clearFrameWatch();
    clearInlineStatus();
    this._render();
    this._reportFirstFrame();
  }

  async _reportFirstFrame() {
    if (!this.firstFrame || this.firstFrameReported || this.ended || this._left) return;
    this.firstFrameReported = true;
    try { await this.signal.state('first-frame'); } catch { this.firstFrameReported = false; }
  }

  _retry() {
    const link = this.link;
    if (!link) return;
    this.mediaState = 'reconnecting';
    this._render();
    if (link.restartCount >= 2) {
      if (!this.signal.turnConfigured) {
        blocking('E-303', { onAction: () => location.reload() });
      } else if (!this.iceOk) {
        blocking('E-303', {
          text: '中继凭证获取失败，无法建立连接。请联系部署者检查 TURN 配置后重试。',
          onAction: () => location.reload(),
        });
      } else {
        blocking('E-301', { onAction: () => location.reload() });
      }
      return;
    }
    link.restartCount++;
    const delay = link.restartCount === 1 ? 1000 : 3000;
    setTimeout(async () => {
      try {
        const ice = await this.signal.ice();
        setIceConfig(ice.iceServers);
        this.iceOk = true;
      } catch { /* 沿用旧配置 */ }
      link.restartIce().catch((e) => console.warn('[viewer] restart', e));
    }, delay);
  }

  _onHostState(d) {
    if (typeof d.paused === 'boolean') this.paused = d.paused;
    if (typeof d.audioEnabled === 'boolean') this._renderAudio(d.audioEnabled);
    // 不在此处强制取消静音，保留观众的静音选择
    this._renderPause();
  }

  _onSnapshot(d) {
    if (typeof d.paused === 'boolean') this.paused = d.paused;
    this._renderPause();
  }

  async _resync() {
    try {
      const s = await this.signal.session();
      this.paused = s.paused;
      this._renderPause();
      if (s.role === 'viewer' && this.link && this.link.generation < s.generation) {
        this.link.generation = s.generation;
        this.link.restartIce();
      }
    } catch (e) {
      if (e.code === 'E-401A') blocking('E-401A', { onAction: () => location.href = '/' });
    }
  }

  async _onVisible() {
    if (this.ended) return;
    try {
      const s = await this.signal.session();
      this.paused = s.paused;
      this._renderPause();
      this._reportFirstFrame();
    } catch { /* ignore */ }
  }

  _renderPause() {
    const mask = $('#viewer-pause-mask');
    if (mask) mask.classList.toggle('show', this.paused);
    const video = $('#viewer-video');
    if (video && this.paused) video.pause();
    else if (video && this.remoteStream) this._play();
    this._render();
  }

  toggleFullscreen() {
    const stage = $('#viewer-stage');
    const video = $('#viewer-video');
    if (!stage) return;
    if (document.fullscreenElement) { document.exitFullscreen?.(); return; }
    // iOS Safari 只对 video 元素提供原生全屏；标准 API 失败时退到 webkitEnterFullscreen。
    if (stage.requestFullscreen) {
      stage.requestFullscreen().catch(() => {
        if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else toast('当前环境不支持全屏');
      });
    } else if (video?.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    } else {
      toast('当前环境不支持全屏');
    }
  }

  toggleMute() {
    const video = $('#viewer-video');
    if (!video) return;
    video.muted = !video.muted;
    const btn = $('#viewer-mute');
    if (btn) btn.innerHTML = video.muted ? icons.mute() : icons.audio();
    // 取消静音后若画面尚未播放，尝试继续播放
    if (!video.muted) this._play();
  }

  playManually() {
    this._play(true);
  }

  async _play(manual = false) {
    const video = $('#viewer-video');
    if (!video || !video.srcObject || this.paused || this.ended || this._left) return;
    const source = video.srcObject;
    let rejected = false;
    try {
      await video.play();
    } catch {
      rejected = true;
    }
    if (this.paused || this.ended || this._left || video.srcObject !== source) return;
    this.playRequired = rejected && video.paused;
    if (manual && this.playRequired) toast('无法播放画面，请重新加载');
    this._render();
  }

  toggleRecord() {
    if (!this.recorder) {
      const supported = !!window.MediaRecorder;
      this.recorder = new LocalRecorder(supported);
      this.recorder.onTick = ({ text, bytes }) => {
        const t = $('#viewer-rec-time');
        if (t) t.textContent = `${text} · ${(bytes / 1048576).toFixed(1)}MB`;
      };
      this.recorder.onLimit = () => toast('已达录制上限（10 分钟或 128MB），正在保存');
      this.recorder.onDone = (r) => {
        this.recording = false;
        this._notifyRecording(false);
        this._renderRecord();
        this._showDownload(r);
      };
    }
    if (!this.recording) {
      if (!this.remoteStream) { toast('还没有可录制的画面'); return; }
      if (!this.recorder.start(this.remoteStream)) {
        toast('E-502');
        return;
      }
      this.recording = true;
      this._notifyRecording(true);
      this._renderRecord();
    } else {
      this.recorder.stop();
      toast('正在保存录制…');
    }
  }

  _notifyRecording(value) {
    this.signal.state('recording', { value }).catch(() => { /* 离线不影响录制本身 */ });
  }

  _showDownload(r) {
    if (r && r.empty) {
      toast('录制内容为空，未生成文件');
      return;
    }
    let box = $('#viewer-download');
    if (!box) {
      box = el('div', { id: 'viewer-download', class: 'download-box' });
      document.body.append(box);
    }
    box.innerHTML = '';
    box.append(
      el('div', { text: '录制已保存' }),
      el('a', { href: r.url, download: r.filename, class: 'btn primary', text: '下载文件' }),
      el('button', { class: 'btn ghost', text: '关闭', onclick: () => box.remove() }),
    );
    box.classList.add('show');
  }

  _renderRecord() {
    const btn = $('#viewer-record');
    if (btn) {
      btn.classList.toggle('active', this.recording);
      btn.innerHTML = `${icons.record()}<span>${this.recording ? '停止录制' : '本地录制'}</span>`;
    }
    const t = $('#viewer-rec-time');
    if (t) t.classList.toggle('show', this.recording);
  }

  _renderAudio(enabled) {
    const btn = $('#viewer-mute');
    if (btn) btn.title = enabled ? '本次共享包含声音' : '本次共享未包含声音';
  }

  _renderStats(s) {
    const box = $('#viewer-stats');
    if (!box) return;
    box.innerHTML = `<span>${s.rttText}</span><span>${s.modeText}</span><span>${s.fpsText}</span><span>${s.bitrateText}</span>`;
  }

  _render() {
    const code = $('#viewer-code');
    if (code) code.textContent = this.code;
    const status = $('#viewer-status');
    $('#viewer-play')?.classList.toggle('show', this.playRequired && !this.paused);
    if (!status) return;
    if (this.paused) status.textContent = '演示者已暂停';
    else if (this.mediaState === 'reconnecting') status.textContent = '正在恢复连接…';
    else if (this.playRequired) status.textContent = '点按播放';
    else if (this.firstFrame) status.textContent = '观看中';
    else status.textContent = {
      joining: '正在加入房间…',
      connecting: '正在连接媒体…',
      connected: '正在等待画面…',
    }[this.mediaState];
  }

  _end(reason) {
    if (this.ended) return;
    this.ended = true;
    this._left = true;
    this._clearFrameWatch();
    if (this.recording) this.recorder?.stop();
    this.link?.close();
    this._unsub.forEach((u) => u());
    this._unsub = [];
    this.signal.leave().catch(() => { /* 尽力释放席位 */ });
    this.signal.destroy();
    this.chat?.destroy();
    blocking(reason, {
      title: '共享已结束', text: reason, action: '返回首页',
      onAction: () => location.href = '/',
    });
  }

  leave() {
    this._left = true;
    this._clearFrameWatch();
    this.signal.leave().finally(() => {
      this.link?.close();
      this.recorder?.destroy();
      this.chat?.destroy();
      this.signal.destroy();
      location.href = '/';
    });
  }
}
