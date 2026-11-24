// 信令客户端：bootstrap、建房、加入、SSE 订阅、messageId 去重、错误映射。
import { ApiError } from './errors.js';

// crypto.randomUUID() 仅在安全上下文（HTTPS/localhost）可用。
// 观众用 http://局域网IP 访问时是非安全上下文，必须降级，否则 join 直接抛错。
function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  if (globalThis.crypto?.getRandomValues) {
    const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// 控制通道失联期限：5 分钟收不到任何 SSE 活动（含心跳）才判定失联。
const CHANNEL_LOST_MS = 5 * 60_000;

function storedNickname() {
  try { return localStorage.getItem('share-nick') || ''; } catch { return ''; }
}

export class SignalClient {
  constructor() {
    this.listeners = new Map();     // event -> Set<handler>
    this.es = null;
    this.seen = new Set();          // messageId 去重
    this.peerId = null;
    this.roomId = null;
    this.role = null;
    this.turnConfigured = false;
    this.onStatus = null;          // (state) => void
    this._lastAlive = 0;
    this._aliveTimer = null;
    this._channelLost = false;
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event)?.delete(handler);
  }

  emit(event, data) {
    for (const h of this.listeners.get(event) || []) {
      try { h(data); } catch (e) { console.error('[signal] handler', event, e); }
    }
  }

  async request(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) {
      const err = new ApiError(body?.code || 'E-501', body?.message, body?.retryable);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async bootstrap() {
    const r = await this.request('/api/bootstrap');
    this.turnConfigured = Boolean(r?.capabilities?.turnConfigured);
    this.relayOnly = Boolean(r?.capabilities?.relayOnly);
    return r;
  }

  async createRoom(maxViewers, inviteOrigin) {
    const requestId = newId();
    const nickname = storedNickname();
    const r = await this.request('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ requestId, maxViewers, nickname, inviteOrigin }),
    });
    this.roomId = r.roomId;
    this.peerId = r.hostPeerId;
    this.role = 'host';
    this.code = r.code;
    this.inviteUrl = r.inviteUrl;
    return r;
  }

  async joinRoom(code) {
    const requestId = newId();
    const nickname = storedNickname();
    const r = await this.request('/api/join', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim().toUpperCase(), requestId, nickname }),
    });
    this.roomId = r.roomId;
    this.peerId = r.viewerPeerId;
    this.hostPeerId = r.hostPeerId;
    this.role = 'viewer';
    return r;
  }

  subscribe() {
    if (!this.roomId || !this.peerId) throw new Error('尚未建房或加入');
    const url = `/api/rooms/${this.roomId}/events?peer=${encodeURIComponent(this.peerId)}`;
    this.es = new EventSource(url);
    const types = [
      'snapshot', 'peer-ready', 'signal', 'host-state', 'viewer-state',
      'peer-left', 'room-closed', 'resync', 'heartbeat', 'chat',
    ];
    for (const t of types) {
      this.es.addEventListener(t, (e) => this._onEvent(t, e));
    }
    this._lastAlive = Date.now();
    this._channelLost = false;
    // 控制通道失联期限：5 分钟收不到任何 SSE 活动（含心跳）则主动通知控制器收尾，
    // 避免服务端进程重启后各端长期显示过期状态。
    clearInterval(this._aliveTimer);
    this._aliveTimer = setInterval(() => {
      if (!this._channelLost && Date.now() - this._lastAlive > CHANNEL_LOST_MS) {
        this._channelLost = true;
        this.emit('channel-lost');
      }
    }, 5_000);
    this.es.onopen = () => {
      this._lastAlive = Date.now();
      this.onStatus?.('online');
    };
    this.es.onerror = () => {
      this.onStatus?.('reconnecting');
      // EventSource 自动重连，不手动处理；但服务端进程重启后房间已消失，
      // EventSource 拿不到状态码，只能主动探一次 session 区分"短暂波动"与"房间没了"。
      this._probeRoom();
    };
  }

  _probeRoom() {
    if (this._probing || !this.roomId || !this.peerId) return;
    this._probing = true;
    setTimeout(async () => {
      this._probing = false;
      if (!this.es) return;
      try {
        await this.session();
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'E-201' || e.code === 'E-401A')) {
          this.emit('room-gone');
        }
      }
    }, 3_000);
  }

  _onEvent(type, e) {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    this._lastAlive = Date.now();
    // signal 为定向事件：只处理发给自己的，避免多观众互相串扰
    if (type === 'signal' && data && typeof data.to === 'string' && data.to !== this.peerId) return;
    if (data?.messageId) {
      if (this.seen.has(data.messageId)) return;
      this.seen.add(data.messageId);
      if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    }
    this.emit(type, data);
    this.emit('*', { type, data });
  }

  async signal(to, type, payload, generation = 1) {
    const messageId = newId();
    return this.request(`/api/rooms/${this.roomId}/signal`, {
      method: 'POST',
      body: JSON.stringify({
        peerId: this.peerId, to, type, payload, generation, messageId,
      }),
    });
  }

  async state(type, extra = {}) {
    return this.request(`/api/rooms/${this.roomId}/state`, {
      method: 'POST',
      body: JSON.stringify({ peerId: this.peerId, type, ...extra }),
    });
  }

  async sendChat(text) {
    return this.request(`/api/rooms/${this.roomId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ peerId: this.peerId, text }),
    });
  }

  async session() {
    return this.request(`/api/rooms/${this.roomId}/session?peer=${encodeURIComponent(this.peerId)}`);
  }

  async ice() {
    return this.request(`/api/rooms/${this.roomId}/ice?peer=${encodeURIComponent(this.peerId)}`);
  }

  async leave() {
    if (!this.roomId || !this.peerId) return;
    try {
      await this.request(`/api/rooms/${this.roomId}/leave`, {
        method: 'POST',
        body: JSON.stringify({ peerId: this.peerId }),
      });
    } catch { /* 尽力而为 */ }
  }

  async close() {
    if (!this.roomId || !this.peerId) return;
    try {
      await this.request(`/api/rooms/${this.roomId}/close`, {
        method: 'POST',
        body: JSON.stringify({ peerId: this.peerId }),
      });
    } catch { /* 尽力而为 */ }
  }

  destroy() {
    if (this.es) { this.es.close(); this.es = null; }
    clearInterval(this._aliveTimer);
    this._aliveTimer = null;
    this.listeners.clear();
  }
}
