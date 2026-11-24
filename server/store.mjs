// 内存状态：浏览器会话、身份、房间、事件缓存。进程退出即清空，不做持久化。
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { config } from './config.mjs';
import { ApiError, fail } from './errors.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除 O/0/I/1

export const sessions = new Map();   // sessionId -> { id, createdAt }
export const identities = new Map(); // peerId -> { sessionId, roomId, role, createdAt, lastSeen }
export const rooms = new Map();      // roomId -> Room

let activeRooms = 0;
const createRate = new Map();        // sessionId -> { count, resetAt }

function now() { return Date.now(); }

export function newSession() {
  const id = randomBytes(24).toString('base64url');
  sessions.set(id, { id, createdAt: now() });
  return id;
}

export function sessionExists(id) {
  return sessions.has(id);
}

export function newPeerId() {
  return randomUUID();
}

function generateCode() {
  let out = '';
  const bytes = randomBytes(6);
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function uniqueCode() {
  for (let i = 0; i < 50; i++) {
    const c = generateCode();
    let used = false;
    for (const r of rooms.values()) if (r.code === c) { used = true; break; }
    if (!used) return c;
  }
  throw new Error('无法生成唯一房间码');
}

function checkRate(sessionId) {
  const rec = createRate.get(sessionId);
  const t = now();
  if (!rec || t > rec.resetAt) {
    createRate.set(sessionId, { count: 1, resetAt: t + 60_000 });
    return;
  }
  if (rec.count >= 20) fail('E-429');
  rec.count++;
}

export function createRoom(sessionId, requestId, maxViewers = config.maxViewers, nickname = '', inviteOrigin) {
  checkRate(sessionId);
  if (activeRooms >= 200) fail('E-501', '当前房间数量已达上限，请稍后再试');
  // requestId 幂等：同一会话同一 requestId 返回原房间
  for (const r of rooms.values()) {
    if (r.hostSession === sessionId && r.createRequestId === requestId) return r;
  }
  const roomId = randomUUID();
  const code = uniqueCode();
  const hostPeerId = newPeerId();
  const room = {
    roomId,
    code,
    hostPeerId,
    hostSession: sessionId,
    createRequestId: requestId,
    inviteOrigin,
    hostNickname: nickname,      // 主机昵称（聊天/弹幕显示）
    viewers: new Map(),          // peerId -> { sessionId, joinedAt, state }
    maxViewers,                  // 房间级观众上限（建房时选定）
    identities: new Set([hostPeerId]),
    createdAt: now(),
    expiresAt: now() + config.roomTtlMs,
    paused: false,
    audioEnabled: false,
    stateVersion: 1,
    closed: false,
    eventSeq: 0,
    generation: 1,
    clients: new Map(),          // peerId -> { res, buffer, bytes, lastSeen }
    seenMessages: new Map(),     // messageId -> timestamp（信令去重）
    chatLog: [],                 // 聊天历史（本次会话，最多 200 条）
    chatSeq: 0,                  // 消息自增序号（历史裁剪后仍唯一，供前端去重）
    chatRate: new Map(),         // peerId -> 上次发言时间戳（限流）
  };
  identities.set(hostPeerId, {
    sessionId, roomId, role: 'host', createdAt: now(), lastSeen: now(),
  });
  rooms.set(roomId, room);
  activeRooms++;
  return room;
}

export function getRoomByCode(code) {
  const c = String(code || '').trim().toUpperCase();
  for (const r of rooms.values()) {
    if (r.code === c && !r.closed && now() < r.expiresAt) return r;
  }
  return null;
}

export function getRoomById(id) {
  const r = rooms.get(id);
  if (!r || r.closed || now() >= r.expiresAt) return null;
  return r;
}

export function joinRoom(room, sessionId, requestId, nickname = '') {
  checkRate(sessionId);
  // 幂等
  for (const [peerId, v] of room.viewers) {
    if (v.sessionId === sessionId && v.joinRequestId === requestId) {
      return { peerId, room };
    }
  }
  // 同一会话已占用席位则复用
  for (const [peerId, v] of room.viewers) {
    if (v.sessionId === sessionId) return { peerId, room };
  }
  if (room.viewers.size >= room.maxViewers) {
    fail('E-202', `当前房间已满（最多 ${room.maxViewers} 人观看）`);
  }
  const peerId = newPeerId();
  room.viewers.set(peerId, {
    sessionId,
    joinRequestId: requestId,
    joinedAt: now(),
    nickname,                    // 观众昵称（聊天/弹幕显示）
    firstFrame: false,
    recording: false,
    generation: 1,
    lastSeen: now(),
  });
  room.identities.add(peerId);
  identities.set(peerId, {
    sessionId, roomId: room.roomId, role: 'viewer', createdAt: now(), lastSeen: now(),
  });
  return { peerId, room };
}

export function authenticate(sessionId, peerId, roomId, role) {
  const ident = identities.get(peerId);
  if (!ident || ident.sessionId !== sessionId || ident.roomId !== roomId) {
    fail('E-401A');
  }
  if (role && ident.role !== role) fail('E-403');
  return ident;
}

export function isMember(room, peerId) {
  return room.identities.has(peerId);
}

export function isHost(room, peerId) {
  return room.hostPeerId === peerId;
}

export function isViewer(room, peerId) {
  return room.viewers.has(peerId);
}

export function leaveRoom(room, peerId) {
  if (isViewer(room, peerId)) {
    room.viewers.delete(peerId);
    room.identities.delete(peerId);
    identities.delete(peerId);
    const client = room.clients.get(peerId);
    room.clients.delete(peerId);
    client?.res.end();
    return true;
  }
  return false;
}

export function closeRoom(room) {
  if (room.closed) return;
  room.closed = true;
  // 结束所有 SSE 订阅，避免关房后残留长连接
  for (const [, client] of room.clients) {
    try { client.res.end(); } catch { /* ignore */ }
  }
  room.clients.clear();
  for (const peerId of room.identities) identities.delete(peerId);
  room.identities.clear();
  room.viewers.clear();
  activeRooms = Math.max(0, activeRooms - 1);
}

// 追加一条聊天/弹幕消息，返回完整消息对象（含序号与时间）。
export function addChatMessage(room, { peerId, nickname, role, text }) {
  const msg = {
    seq: ++room.chatSeq,
    peerId,
    nickname,
    role,            // 'host' | 'viewer'（用于"主播"徽章）
    text,
    ts: now(),
  };
  room.chatLog.push(msg);
  if (room.chatLog.length > 200) room.chatLog.shift();  // 历史上限
  return msg;
}

export function roomSnapshot(room) {
  return {
    roomId: room.roomId,
    code: room.code,
    hostPeerId: room.hostPeerId,
    hostNickname: room.hostNickname,
    paused: room.paused,
    audioEnabled: room.audioEnabled,
    stateVersion: room.stateVersion,
    generation: room.generation,
    expiresAt: room.expiresAt,
    viewerCount: room.viewers.size,
    chatLog: room.chatLog,
    viewers: [...room.viewers.entries()].map(([peerId, v]) => ({
      peerId,
      nickname: v.nickname,
      firstFrame: v.firstFrame,
      recording: v.recording,
      generation: v.generation,
      joinedAt: v.joinedAt,
    })),
  };
}

export function touch(peerId) {
  const ident = identities.get(peerId);
  if (ident) ident.lastSeen = now();
  if (ident) {
    const v = rooms.get(ident.roomId)?.viewers.get(peerId);
    if (v) v.lastSeen = now();
  }
}

// 定时回收过期房间与失联席位
export function sweep(onViewerExpired) {
  const t = now();
  for (const room of rooms.values()) {
    if (room.closed) { rooms.delete(room.roomId); continue; }
    if (t >= room.expiresAt) {
      closeRoom(room);
      rooms.delete(room.roomId);
      continue;
    }
    for (const [peerId, v] of room.viewers) {
      const deadline = v.subscribedAt == null
        ? v.joinedAt + config.seatHoldMs
        : room.paused ? Infinity : Math.max(v.subscribedAt, room.resumedAt ?? 0) + config.firstFrameWaitMs;
      if (!v.firstFrame && t >= deadline && leaveRoom(room, peerId)) {
        onViewerExpired?.(room, peerId);
      }
    }
    // 清理过期的信令去重记录，防止无界增长
    const cutoff = t - config.signalGraceMs;
    for (const [mid, ts] of room.seenMessages) {
      if (ts < cutoff) room.seenMessages.delete(mid);
    }
  }
  for (const [sid, s] of sessions) {
    if (t - s.createdAt > 24 * 60 * 60 * 1000) sessions.delete(sid);
  }
  for (const [sid, rec] of createRate) {
    if (t > rec.resetAt) createRate.delete(sid);
  }
}
