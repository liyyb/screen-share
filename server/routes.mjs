// HTTP 路由：参数校验、身份校验、组织 JSON 响应。
import { randomUUID, createHmac } from 'node:crypto';
import { config, inviteUrl, LAN_IP, VIRTUAL_IPS } from './config.mjs';
import { fail, ApiError } from './errors.mjs';
import {
  sessions, newSession, sessionExists, identities, rooms,
  createRoom, getRoomByCode, getRoomById, joinRoom,
  authenticate, isMember, isHost, isViewer, leaveRoom, closeRoom,
  roomSnapshot, touch, sweep, addChatMessage,
} from './store.mjs';
import { publish, subscribe, hasBothSubscriptions } from './events.mjs';
import { parseInviteOrigin } from '../public/invite-origin.mjs';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function noContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.bodyMaxBytes) {
        reject(new ApiError('E-400', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not object');
        resolve(obj);
      } catch {
        reject(new ApiError('E-400', '请求体不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function str(obj, key, { min = 1, max = 128, upper = false } = {}) {
  const v = obj[key];
  if (typeof v !== 'string') fail('E-400', `缺少字段 ${key}`);
  const s = upper ? v.trim().toUpperCase() : v.trim();
  if (s.length < min || s.length > max) fail('E-400', `字段 ${key} 长度无效`);
  return s;
}

// 可选字符串字段（昵称等），缺省返回空串
function optStr(obj, key, { max = 24 } = {}) {
  const v = obj[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') fail('E-400', `字段 ${key} 无效`);
  return v.trim().slice(0, max);
}

function reqId(obj) {
  return typeof obj.requestId === 'string' ? obj.requestId.slice(0, 128) : randomUUID();
}

// 建房人数：可选 1~全局上限，缺省用保守默认 3（不超过全局上限）
function parseMaxViewers(obj) {
  if (obj.maxViewers === undefined) return Math.min(3, config.maxViewers);
  const n = Number(obj.maxViewers);
  if (!Number.isInteger(n) || n < 1 || n > config.maxViewers) {
    fail('E-400', `可加入人数需为 1~${config.maxViewers} 的整数`);
  }
  return n;
}

// Origin 白名单：同源写入的合法来源。局域网多设备演示时，
// 主机用 localhost、观众用局域网 IP（config.publicOrigin），两者都放行。
const ALLOWED_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
if (LAN_IP) ALLOWED_ORIGIN_HOSTS.add(LAN_IP);
for (const ip of VIRTUAL_IPS) ALLOWED_ORIGIN_HOSTS.add(ip);
if (!['0.0.0.0', '::'].includes(config.host)) ALLOWED_ORIGIN_HOSTS.add(config.host);
if (config.publicOrigin) {
  try { ALLOWED_ORIGIN_HOSTS.add(new URL(config.publicOrigin).hostname); } catch { /* ignore */ }
}

function readInviteOrigin(value) {
  if (value === undefined) return undefined;
  let origin;
  try { origin = parseInviteOrigin(value); }
  catch { fail('E-400', '邀请地址需要以 http:// 或 https:// 开头，只填写主机名和端口。'); }
  const url = new URL(origin);
  if (!ALLOWED_ORIGIN_HOSTS.has(url.hostname)) {
    fail('E-400', '请选择本机局域网、Radmin 网卡或启动时配置的公网地址。');
  }
  if (url.protocol === 'http:' && (config.tls || config.publicOrigin.startsWith('https://'))) {
    fail('E-400', '当前服务使用 HTTPS，请填写 HTTPS 邀请地址。');
  }
  return origin;
}

// 写请求校验 Origin。无 Origin（原生端/curl/sendBeacon）由 SameSite Cookie 与限速兜底。
function assertOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return;
  let host;
  try { host = new URL(origin).hostname; } catch { fail('E-403', '来源无效'); }
  if (!ALLOWED_ORIGIN_HOSTS.has(host)) fail('E-403', '来源不被允许');
}

// Cookie 处理
const COOKIE = 'ssid';
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function ensureSession(req, res) {
  const cookies = parseCookies(req);
  let sid = cookies[COOKIE];
  if (!sid || !sessionExists(sid)) {
    sid = newSession();
    const secure = config.tls || (config.publicOrigin.startsWith('https://'));
    const attrs = [
      `${COOKIE}=${sid}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      ...(secure ? ['Secure'] : []),
    ];
    const existing = res.getHeader('Set-Cookie');
    const set = existing ? [...(Array.isArray(existing) ? existing : [existing]), attrs.join('; ')] : [attrs.join('; ')];
    res.setHeader('Set-Cookie', set);
  }
  return sid;
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const method = req.method;
  const requestId = randomUUID();

  try {
    // 写请求的 Origin 校验（读请求无副作用，不校验）
    if (method === 'POST' && path.startsWith('/api/')) assertOrigin(req);

    // 健康检查
    if (path === '/health' && method === 'GET') {
      return json(res, 200, { ok: true, app: 'share', version: config.protocolVersion, rooms: 0 });
    }

    // bootstrap：建立会话
    if (path === '/api/bootstrap' && method === 'GET') {
      const sid = ensureSession(req, res);
      return json(res, 200, {
        protocolVersion: config.protocolVersion,
        maxViewers: config.maxViewers,
        capabilities: {
          recording: true,
          qualityLevels: ['text', 'motion'],
          turnConfigured: config.turnUrls.length > 0,
          relayOnly: config.relayOnly,
        },
        sessionId: sid.slice(0, 8), // 仅展示前缀，完整值在 HttpOnly Cookie
      });
    }

    // 创建房间
    if (path === '/api/rooms' && method === 'POST') {
      const sid = ensureSession(req, res);
      const body = await readBody(req);
      const rid = reqId(body);
      const room = createRoom(sid, rid, parseMaxViewers(body), optStr(body, 'nickname'), readInviteOrigin(body.inviteOrigin));
      // 主机刷新后重新开始时，立即关闭同会话的旧房间，避免旧房间残留到 TTL
      for (const old of rooms.values()) {
        if (old !== room && !old.closed && old.hostSession === sid) {
          publish(old, 'room-closed', { roomId: old.roomId, reason: 'host-restarted' });
          closeRoom(old);
        }
      }
      return json(res, 201, {
        roomId: room.roomId,
        code: room.code,
        hostPeerId: room.hostPeerId,
        inviteUrl: inviteUrl(room.code, room.inviteOrigin),
        expiresAt: room.expiresAt,
        requestId: rid,
      });
    }

    // 加入房间
    if (path === '/api/join' && method === 'POST') {
      const sid = ensureSession(req, res);
      const body = await readBody(req);
      const rid = reqId(body);
      const code = str(body, 'code', { min: 6, max: 6, upper: true });
      const room = getRoomByCode(code);
      if (!room) {
        console.log(`[诊断] 加入失败 E-201，requestId=${requestId}`);
        fail('E-201');
      }
      const { peerId } = joinRoom(room, sid, rid, optStr(body, 'nickname'));
      return json(res, 201, {
        roomId: room.roomId,
        viewerPeerId: peerId,
        hostPeerId: room.hostPeerId,
        expiresAt: room.expiresAt,
        requestId: rid,
      });
    }

    // 房间子路由：/api/rooms/{roomId}/...
    const m = path.match(/^\/api\/rooms\/([^/]+)\/([a-z]+)$/);
    if (m) {
      const roomId = m[1];
      const action = m[2];
      const cookies = parseCookies(req);
      const sid = cookies[COOKIE];
      if (!sid) fail('E-401A');

      // SSE 订阅
      if (action === 'events' && method === 'GET') {
        const peerId = url.searchParams.get('peer');
        if (!peerId) fail('E-400', '缺少 peer');
        authenticate(sid, peerId, roomId);
        const room = getRoomById(roomId);
        if (!room) fail('E-201');
        // 浏览器 EventSource 重连会把已收到的最后事件 id 放在 Last-Event-ID 请求头里
        const lastId = req.headers['last-event-id'] || url.searchParams.get('lastEventId');
        subscribe(res, room, peerId, lastId);
        // 通知对方就绪
        const ident = identities.get(peerId);
        if (ident.role === 'viewer' && hasBothSubscriptions(room, peerId)) {
          publish(room, 'peer-ready', { peerId, roomId, generation: room.viewers.get(peerId)?.generation || 1 });
        } else if (ident.role === 'host') {
          for (const [v, state] of room.viewers) {
            if (!hasBothSubscriptions(room, v)) continue;
            publish(room, 'peer-ready', { peerId: v, roomId, generation: state.generation || 1 });
          }
        }
        return;
      }

      // 信令转发
      if (action === 'signal' && method === 'POST') {
        const body = await readBody(req);
        const peerId = str(body, 'peerId', { max: 128 });
        const ident = authenticate(sid, peerId, roomId);
        const room = getRoomById(roomId);
        if (!room) fail('E-201');
        const to = str(body, 'to', { max: 128 });
        if (!isMember(room, to)) fail('E-203');
        // 配对校验：信令只能在主机与观众之间交换，观众之间不得互发
        if (ident.role === 'viewer' && !isHost(room, to)) fail('E-403', '观众只能与主机交换信令');
        if (ident.role === 'host' && !isViewer(room, to)) fail('E-403', '主机只能与观众交换信令');
        const type = str(body, 'type', { max: 32 });
        if (!['offer', 'answer', 'candidate', 'restart-request'].includes(type)) fail('E-400', '信令类型无效');
        const generation = Number(body.generation) || 1;
        // 代次校验：主机发起的 offer 必须为当前代次或递增一代（防止旧协商复活房间/连接）
        if (type === 'offer' && ident.role === 'host') {
          const v = room.viewers.get(to);
          const cur = v ? v.generation : 1;
          if (generation !== cur && generation !== cur + 1) {
            fail('E-400', `信令代次无效（当前 ${cur}，收到 ${generation}）`);
          }
          if (generation === cur + 1) v.generation = generation;
        }
        const messageId = str(body, 'messageId', { max: 128 });
        const payload = body.payload;
        if (payload === undefined || typeof payload !== 'object') fail('E-400', '缺少 payload');
        touch(peerId);
        // 去重：同一 messageId 不重复转发，防止网络重试把 SDP 应用两次
        if (room.seenMessages.has(messageId)) {
          return json(res, 202, { accepted: true, messageId, duplicate: true });
        }
        room.seenMessages.set(messageId, Date.now());
        publish(room, 'signal', { from: peerId, to, type, generation, messageId, payload });
        return json(res, 202, { accepted: true, messageId });
      }

      // 状态提交
      if (action === 'state' && method === 'POST') {
        const body = await readBody(req);
        const peerId = str(body, 'peerId', { max: 128 });
        const ident = authenticate(sid, peerId, roomId);
        const room = getRoomById(roomId);
        if (!room) fail('E-201');
        const type = str(body, 'type', { max: 32 });
        touch(peerId);
        if (ident.role === 'host') {
          if (type === 'paused') {
            if (typeof body.value !== 'boolean') fail('E-400');
            if (room.paused && !body.value) room.resumedAt = Date.now();
            room.paused = body.value;
          } else if (type === 'audioEnabled') {
            if (typeof body.value !== 'boolean') fail('E-400');
            room.audioEnabled = body.value;
          } else fail('E-400', '状态类型无效');
          room.stateVersion++;
          publish(room, 'host-state', {
            paused: room.paused,
            audioEnabled: room.audioEnabled,
            stateVersion: room.stateVersion,
          });
          return json(res, 200, { stateVersion: room.stateVersion });
        }
        if (type === 'first-frame') {
          const v = room.viewers.get(peerId);
          if (v) v.firstFrame = true;
          publish(room, 'viewer-state', { peerId, firstFrame: true, viewerCount: room.viewers.size });
          return json(res, 200, { accepted: true });
        }
        if (type === 'recording') {
          if (typeof body.value !== 'boolean') fail('E-400');
          const v = room.viewers.get(peerId);
          if (v) v.recording = body.value;
          publish(room, 'viewer-state', { peerId, recording: body.value, viewerCount: room.viewers.size });
          return json(res, 200, { accepted: true });
        }
        fail('E-403');
      }

      // 聊天/弹幕消息
      if (action === 'chat' && method === 'POST') {
        const body = await readBody(req);
        const peerId = str(body, 'peerId', { max: 128 });
        const ident = authenticate(sid, peerId, roomId);
        const room = getRoomById(roomId);
        if (!room) fail('E-201');
        const text = str(body, 'text', { min: 1, max: 100 });
        // 限流：同一 peer 2 秒内只允许一条
        const last = room.chatRate.get(peerId) || 0;
        if (Date.now() - last < 2000) fail('E-429', '发送太快了，请稍后再试');
        room.chatRate.set(peerId, Date.now());
        const nickname = ident.role === 'host'
          ? (room.hostNickname || '主播')
          : (room.viewers.get(peerId)?.nickname || '观众');
        const msg = addChatMessage(room, { peerId, nickname, role: ident.role, text });
        publish(room, 'chat', msg);
        return json(res, 201, msg);
      }

      // 会话恢复
      if (action === 'session' && method === 'GET') {
        const peerId = url.searchParams.get('peer');
        if (!peerId) fail('E-400', '缺少 peer');
        authenticate(sid, peerId, roomId);
        const room = getRoomById(roomId);
        if (!room) fail('E-201');
        touch(peerId);
        return json(res, 200, {
          ...roomSnapshot(room),
          role: identities.get(peerId).role,
        });
      }

      // ICE 配置（带期限凭证）
      if (action === 'ice' && method === 'GET') {
        const peerId = url.searchParams.get('peer');
        if (!peerId) fail('E-400', '缺少 peer');
        authenticate(sid, peerId, roomId);
        const room = getRoomById(roomId);
        if (!room) fail('E-201');
        const servers = buildIceServers();
        // 诊断日志（脱敏：只记数量与凭证模式，不记密钥/用户名）
        const mode = config.turnUsername
          ? '静态凭证' : config.turnSecret ? '短期HMAC' : '无凭证';
        console.log(`[诊断] ICE 配置：STUN=${config.stunUrls.length} 个，TURN=${config.turnUrls.length} 个（${mode}）`);
        return json(res, 200, {
          iceServers: servers,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
      }

      // 退出
      if (action === 'leave' && method === 'POST') {
        const body = await readBody(req);
        const peerId = str(body, 'peerId', { max: 128 });
        authenticate(sid, peerId, roomId);
        const room = getRoomById(roomId);
        if (!room) return noContent(res);
        if (leaveRoom(room, peerId)) {
          publish(room, 'peer-left', { peerId, viewerCount: room.viewers.size });
        }
        return noContent(res);
      }

      // 关房（仅主机）
      if (action === 'close' && method === 'POST') {
        const body = await readBody(req);
        const peerId = str(body, 'peerId', { max: 128 });
        authenticate(sid, peerId, roomId, 'host');
        const room = getRoomById(roomId);
        if (!room) return noContent(res);
        publish(room, 'room-closed', { roomId, reason: 'host-closed' });
        closeRoom(room);
        return noContent(res);
      }
    }

    fail('E-400', '未知接口');
  } catch (err) {
    if (res.headersSent) {
      try { res.end(); } catch { /* ignore */ }
      return;
    }
    if (err instanceof ApiError) return json(res, err.status, err.toJSON(requestId));
    console.error('[server] 未处理异常', err);
    return json(res, 500, { code: 'E-501', message: '服务内部错误', retryable: true, requestId });
  }
}

function buildIceServers() {
  const servers = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  if (config.turnUrls.length) {
    if (config.turnUsername && config.turnCredential) {
      // 静态凭证（TURN_USERNAME / TURN_CREDENTIAL 成对提供）
      servers.push({
        urls: config.turnUrls,
        username: config.turnUsername,
        credential: config.turnCredential,
      });
    } else if (config.turnSecret) {
      // 短期凭证：用户名 = 过期时间戳，凭证 = HMAC(用户名, secret)
      const username = String(Math.floor(Date.now() / 1000) + 3600);
      const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
      servers.push({ urls: config.turnUrls, username, credential });
    } else {
      servers.push({ urls: config.turnUrls });
    }
  }
  return servers;
}
