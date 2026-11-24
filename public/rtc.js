// 每条观众连接一个 PeerConnection：offer/answer、候选队列、generation、ICE restart、统计。
// 固定主机发 offer；观众回 answer；恢复由观众发 restart-request。

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  iceCandidatePoolSize: 2,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

let iceConfigOverride = null;
export function setIceConfig(servers) {
  if (Array.isArray(servers) && servers.length) iceConfigOverride = servers;
}

function makeConfig(relayOnly) {
  return { ...rtcConfig, iceServers: iceConfigOverride || rtcConfig.iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' };
}

export class PeerLink {
  constructor({ role, peerId, signal, generation = 1, onStats }) {
    this.role = role;              // 'host' | 'viewer'
    this.peerId = peerId;          // 对端 id
    this.signal = signal;          // SignalClient
    this.generation = generation;
    this.onStats = onStats;        // ({rtt, mode, fps, bitrate, loss}) => void
    this.pc = null;
    this.candidates = [];          // 早到的远端候选
    this.remoteDescriptionReady = false;
    this.negotiating = false;
    this.restartCount = 0;
    this.closed = false;
    this.handlers = {
      onTrack: null, onConnected: null, onDisconnected: null,
      onFailed: null, onFirstFrame: null,
    };
    this._statsTimer = null;
    this._prev = null;
    this._prevLoss = {};
  }

  // 对外统一用短名，映射到 handlers 的 onXxx
  on(name, fn) {
    const map = {
      track: 'onTrack', connected: 'onConnected',
      disconnected: 'onDisconnected', failed: 'onFailed',
    };
    this.handlers[map[name] || name] = fn;
    return this;
  }

  _createPc() {
    const pc = new RTCPeerConnection(makeConfig(this.signal.relayOnly));
    this.pc = pc;
    this.remoteDescriptionReady = false;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.signal.signal(this.peerId, 'candidate', {
          candidate: e.candidate.toJSON ? e.candidate.toJSON() : {
            candidate: e.candidate.candidate,
            sdpMid: e.candidate.sdpMid,
            sdpMLineIndex: e.candidate.sdpMLineIndex,
            usernameFragment: e.candidate.usernameFragment,
          },
        }, this.generation).catch((err) => console.warn('[rtc] candidate 发送失败', err));
      }
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        this.restartCount = 0;
        this.handlers.onConnected?.();
        this._startStats();
      } else if (s === 'disconnected') {
        this.handlers.onDisconnected?.();
      } else if (s === 'failed') {
        this.handlers.onFailed?.();
      }
    };

    pc.ontrack = (e) => {
      let stream = e.streams?.[0];
      if (!stream) {
        stream = this.streamlessTracks ??= new MediaStream();
        stream.addTrack(e.track);
      }
      // 低延迟：接收端抖动缓冲调低（若浏览器支持 jitterBufferTarget，Chrome 88+）
      try {
        for (const recv of pc.getReceivers()) {
          if (recv.track?.kind === 'video' && 'jitterBufferTarget' in recv) {
            recv.jitterBufferTarget = 100;
          }
        }
      } catch { /* 不支持的浏览器忽略 */ }
      this.handlers.onTrack?.(stream, e.track);
    };

    return pc;
  }

  async _drainCandidates() {
    if (!this.remoteDescriptionReady || !this.pc) return;
    const list = this.candidates.splice(0);
    for (const c of list) {
      try { await this.pc.addIceCandidate(c); }
      catch (e) { console.warn('[rtc] addIceCandidate 失败', e); }
    }
  }

  // 主机：加轨并发 offer
  async addTracks(stream) {
    if (!this.pc) this._createPc();
    for (const track of stream.getTracks()) {
      this.pc.addTrack(track, stream);
    }
  }

  async offer() {
    if (!this.pc) this._createPc();
    if (this.negotiating) return;
    this.negotiating = true;
    try {
      const o = await this.pc.createOffer();
      await this.pc.setLocalDescription(o);
      await this.signal.signal(this.peerId, 'offer', { sdp: o }, this.generation);
    } finally {
      this.negotiating = false;
    }
  }

  // 收到 offer（观众）
  async onOffer(sdp, generation) {
    if (generation && generation > this.generation) this.generation = generation;
    if (!this.pc) this._createPc();
    await this.pc.setRemoteDescription(sdp);
    this.remoteDescriptionReady = true;
    await this._drainCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.signal.signal(this.peerId, 'answer', { sdp: answer }, this.generation);
  }

  // 收到 answer（主机）
  async onAnswer(sdp, generation) {
    if (generation && generation >= this.generation) this.generation = generation;
    if (!this.pc) return;
    await this.pc.setRemoteDescription(sdp);
    this.remoteDescriptionReady = true;
    await this._drainCandidates();
  }

  async onCandidate(candidate) {
    if (this.remoteDescriptionReady && this.pc) {
      try { await this.pc.addIceCandidate(candidate); }
      catch (e) { console.warn('[rtc] addIceCandidate 失败', e); }
    } else {
      this.candidates.push(candidate);
    }
  }

  // ICE 重启：主机重建 offer；观众请求主机重启
  async restartIce() {
    if (this.role === 'viewer') {
      await this.signal.signal(this.hostPeerId || this.peerId, 'restart-request', {}, this.generation);
      return;
    }
    this.generation++;
    this.candidates = [];
    this.remoteDescriptionReady = false;
    if (this.pc) {
      try { this.pc.setConfiguration(makeConfig(this.signal.relayOnly)); } catch { /* 配置不变时忽略 */ }
      this.pc.restartIce();
      await this.offer();
    }
  }

  replaceTrack(oldTrack, newTrack) {
    if (!this.pc) return;
    const sender = this.pc.getSenders().find((s) => s.track && s.track.kind === newTrack.kind);
    if (sender) return sender.replaceTrack(newTrack);
  }

  // 按档位设置编码参数：码率上限 + 分辨率缩放 + 降级策略。
  // 三者逐级降级尝试，兼容不支持 scaleResolutionDownBy / degradationPreference 的浏览器。
  async setBitrate(profile) {
    if (!this.pc) return;
    const p = typeof profile === 'string' ? { bitrate: 4_000_000 } : (profile || {});
    const cap = p.bitrate || 4_000_000;
    const scale = p.scale || 1;
    const degradation = p.degradation || 'maintain-framerate';
    const variants = [
      (q) => { q.encodings[0].scaleResolutionDownBy = scale; q.degradationPreference = degradation; },
      (q) => { q.encodings[0].scaleResolutionDownBy = scale; },
      () => {},
    ];
    for (const sender of this.pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      for (const apply of variants) {
        let params;
        try {
          params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = cap;
          apply(params);
          await sender.setParameters(params);
          break;
        } catch (e) {
          if (apply === variants[2]) console.warn('[rtc] setBitrate 失败', e);
        }
      }
    }
  }

  _intervalLoss(key, lost, recv) {
    if (lost == null || recv == null) return null;
    const prev = this._prevLoss[key];
    this._prevLoss[key] = { lost, recv };
    if (!prev) return null;
    const dl = lost - prev.lost;
    const dr = recv - prev.recv;
    const den = dl + dr;
    return den > 0 ? dl / den : null;
  }

  _startStats() {
    if (this._statsTimer) return;
    this._statsTimer = setInterval(() => this._pollStats(), 2000);
  }

  async _pollStats() {
    if (!this.pc || this.closed) return;
    try {
      const stats = await this.pc.getStats();
      let rtt = null, mode = 'unknown', fps = null, bitrate = null, loss = null;
      let bytesNow = null;
      let codec = null, width = null, height = null;
      let inLost = null, inRecv = null, remLost = null, remRecv = null;

      for (const r of stats.values()) {
        if (r.type === 'transport' && r.selectedCandidatePairId) {
          const pair = stats.get(r.selectedCandidatePairId);
          if (!pair) continue;
          const local = stats.get(pair.localCandidateId)?.candidateType;
          const remote = stats.get(pair.remoteCandidateId)?.candidateType;
          if (local === 'relay' || remote === 'relay') mode = 'relay';
          else if (local && remote && mode !== 'relay') mode = 'direct';
          if (Number.isFinite(pair.currentRoundTripTime)) rtt = Math.round(pair.currentRoundTripTime * 1000);
        }
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          fps = r.framesPerSecond ?? null;
          bytesNow = r.bytesReceived;
          const c = r.codecId ? stats.get(r.codecId) : null;
          codec = codec ?? (c?.mimeType || '').replace('video/', '');
          width = width ?? r.frameWidth ?? null;
          height = height ?? r.frameHeight ?? null;
          if (r.packetsLost != null && r.packetsReceived != null) {
            inLost = r.packetsLost;
            inRecv = r.packetsReceived;
          }
        }
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          fps = fps ?? r.framesPerSecond ?? null;
          bytesNow = bytesNow ?? r.bytesSent;
          const c = r.codecId ? stats.get(r.codecId) : null;
          codec = codec ?? (c?.mimeType || '').replace('video/', '');
          width = width ?? r.frameWidth ?? null;
          height = height ?? r.frameHeight ?? null;
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && r.packetsLost != null) {
          remLost = r.packetsLost;
          remRecv = r.packetsReceived;
        }
      }

      // 丢包率按相邻两次采样的增量计算（累计值会掩盖实时波动）
      const inLoss = this._intervalLoss('in', inLost, inRecv);
      const remLoss = this._intervalLoss('remote', remLost, remRecv);
      loss = inLoss ?? remLoss;

      if (bytesNow != null && this._prev != null) {
        const dt = (Date.now() - this._prev.t) / 1000;
        if (dt > 0) bitrate = Math.round(((bytesNow - this._prev.b) * 8) / dt / 1000); // kbps
      }
      this._prev = { b: bytesNow, t: Date.now() };
      this.onStats?.({ rtt, mode, fps, bitrate, loss, codec, width, height });
    } catch { /* 统计失败不影响媒体 */ }
  }

  close() {
    this.closed = true;
    this.streamlessTracks = null;
    if (this._statsTimer) { clearInterval(this._statsTimer); this._statsTimer = null; }
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      try { this.pc.close(); } catch { /* ignore */ }
      this.pc = null;
    }
    this.candidates = [];
  }
}
