// SSE 事件订阅、编号、有限重放、快照。零第三方依赖。
import { config } from './config.mjs';
import { roomSnapshot, touch, leaveRoom, closeRoom } from './store.mjs';

function encode(event, data, id) {
  let s = '';
  if (id !== undefined) s += `id: ${id}\n`;
  s += `event: ${event}\n`;
  s += `data: ${JSON.stringify(data)}\n\n`;
  return s;
}

// 命名心跳事件：EventSource 会丢弃注释帧（`: heartbeat`），
// 客户端无法感知连接存活，必须用可监听的事件名。
const HEARTBEAT_FRAME = encode('heartbeat', {});

function canReceive(data, peerId) {
  return typeof data?.to !== 'string' || data.to === peerId;
}

export function publish(room, event, data) {
  room.eventSeq++;
  const id = room.eventSeq;
  const frame = encode(event, data, id);
  const buf = room.eventBuffer || (room.eventBuffer = []);
  buf.push({ id, event, data, bytes: Buffer.byteLength(frame), at: Date.now() });
  trimBuffer(buf);
  // 定向事件（signal）：只发给 data.to 指定的接收者，避免多观众互相串扰。
  // 其余事件（snapshot/peer-ready/state/peer-left/room-closed/resync）照常广播。
  for (const [peerId, client] of room.clients) {
    if (!canReceive(data, peerId)) continue;
    try {
      client.res.write(frame);
    } catch {
      room.clients.delete(peerId);
    }
  }
}

function trimBuffer(buf) {
  const t = Date.now();
  while (buf.length > config.sseBufferMax || (buf.length && t - buf[0].at > config.sseBufferTtlMs)) {
    buf.shift();
  }
  let total = buf.reduce((a, b) => a + b.bytes, 0);
  while (total > config.sseBufferBytes && buf.length) {
    total -= buf.shift().bytes;
  }
}

export function subscribe(res, room, peerId, lastEventId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = {
    res,
    buffer: null,
    lastSeen: Date.now(),
  };
  const previous = room.clients.get(peerId);
  room.clients.set(peerId, client);
  previous?.res.end();
  const viewer = room.viewers.get(peerId);
  if (viewer) {
    viewer.subscribedAt ??= Date.now();
    viewer.disconnectedClient = null;
  } else room.disconnectedHost = null;

  // 重放策略：
  // 1) 带合法 Last-Event-ID → 补发该 id 之后该参与者可接收的事件
  // 2) 全新订阅 → 发快照；同时补发缓存中"定向给该 peer"的事件，
  //    覆盖协商信号早于订阅到达的竞态（开发方案 N01）
  const buf = room.eventBuffer || [];
  trimBuffer(buf);
  const lastId = Number(lastEventId) || 0;
  if (lastId > 0 && buf.some((e) => e.id === lastId)) {
    for (const e of buf) {
      if (e.id > lastId && canReceive(e.data, peerId)) res.write(encode(e.event, e.data, e.id));
    }
  } else {
    res.write(encode('snapshot', roomSnapshot(room)));
    for (const e of buf) {
      if (e.id > lastId && e.data?.to === peerId) res.write(encode(e.event, e.data, e.id));
    }
    if (lastId > 0) {
      res.write(encode('resync', { reason: 'window-missed' }, room.eventSeq));
    }
  }

  // 心跳
  const timer = setInterval(() => {
    if (res.destroyed) { clearInterval(timer); return; }
    res.write(HEARTBEAT_FRAME);
    touch(peerId);
  }, config.sseHeartbeatMs);

  const cleanup = () => {
    clearInterval(timer);
    // 只清理属于本次订阅的绑定，避免新订阅被旧的 close 回调误删
    if (room.clients.get(peerId) !== client) return;
    room.clients.delete(peerId);
    // 每次实际断开都重新计算宽限期。
    const v = room.viewers.get(peerId);
    if (v) {
      v.disconnectedClient = client;
      const grace = setTimeout(() => {
        if (room.clients.has(peerId) || v.disconnectedClient !== client) return;
        if (leaveRoom(room, peerId)) {
          publish(room, 'peer-left', { peerId, viewerCount: room.viewers.size });
        }
      }, config.signalGraceMs);
      grace.unref();
    } else if (peerId === room.hostPeerId && !room.closed) {
      room.disconnectedHost = client;
      // 主机断线：给宽限期，到期仍未回连则关房并通知观众
      const grace = setTimeout(() => {
        if (room.closed || room.clients.has(peerId) || room.disconnectedHost !== client) return;
        publish(room, 'room-closed', { roomId: room.roomId, reason: 'host-lost' });
        closeRoom(room);
      }, config.signalGraceMs);
      grace.unref();
    }
  };
  res.on('close', cleanup);
  res.on('error', cleanup);

  return cleanup;
}

export function hasBothSubscriptions(room, viewerPeerId) {
  return room.clients.has(room.hostPeerId) && room.clients.has(viewerPeerId);
}
