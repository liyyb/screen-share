// HTTP 接口层集成测试：用真实 http server 包装 routes.handle，验证权限、人数上限、
// Origin 校验、信令去重、建房收尾等行为。零第三方依赖。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { handle } from '../server/routes.mjs';
import { sessions, identities, rooms } from '../server/store.mjs';

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      handle(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
});

beforeEach(() => {
  sessions.clear();
  identities.clear();
  rooms.clear();
});

function sid(setCookie) {
  if (!setCookie) return null;
  const m = setCookie.match(/ssid=([^;]+)/);
  return m ? m[1] : null;
}

async function api(path, { method = 'GET', cookie, body, origin } = {}) {
  const headers = {};
  if (cookie) headers.cookie = 'ssid=' + cookie;
  if (body) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, cookie: sid(res.headers.get('set-cookie')), json };
}

async function newSession() {
  const r = await api('/api/bootstrap');
  return r.cookie;
}

function makeRoom(cookie, maxViewers) {
  const body = { requestId: Math.random().toString(36).slice(2) };
  if (maxViewers !== undefined) body.maxViewers = maxViewers;
  return api('/api/rooms', { method: 'POST', cookie, body });
}

async function join(code, requestId) {
  const v = await newSession();
  const r = await api('/api/join', { method: 'POST', cookie: v, body: { code, requestId } });
  // 会话在 bootstrap 时已建立，join 响应不重发 cookie，后续请求沿用 bootstrap 的 session cookie
  return { status: r.status, cookie: v, json: r.json };
}

async function openEvents(t, roomId, peerId, cookie, lastId) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 5000);
  t.after(() => {
    clearTimeout(deadline);
    controller.abort();
  });
  const res = await fetch(`${base}/api/rooms/${roomId}/events?peer=${peerId}`, {
    headers: { cookie: `ssid=${cookie}`, ...(lastId && { 'Last-Event-ID': lastId }) },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => controller.abort(),
    async until(predicate) {
      const events = [];
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end < 0) {
          const { value, done } = await reader.read();
          assert.equal(done, false);
          buffer += decoder.decode(value, { stream: true });
          continue;
        }
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const name = frame.match(/^event: (.*)$/m)?.[1];
        if (!name) continue;
        const event = {
          name,
          id: frame.match(/^id: (.*)$/m)?.[1],
          data: JSON.parse(frame.match(/^data: (.*)$/m)[1]),
        };
        events.push(event);
        if (predicate(event)) return events;
      }
    },
  };
}

test('观众逐对就绪，重连补发仍只交付该观众的定向信令', async (t) => {
  const hostCookie = await newSession();
  const { json: { roomId, code, hostPeerId } } = await makeRoom(hostCookie);
  const a = await join(code, 'viewer-a');
  const b = await join(code, 'viewer-b');
  const aId = a.json.viewerPeerId;
  const bId = b.json.viewerPeerId;
  const host = await openEvents(t, roomId, hostPeerId, hostCookie);
  const viewer = await openEvents(t, roomId, aId, a.cookie);
  await host.until((e) => e.name === 'peer-ready' && e.data.peerId === aId);
  const ready = (await viewer.until((e) => e.name === 'peer-ready')).at(-1);
  viewer.close();

  for (const [to, messageId] of [[bId, 'only-b'], [aId, 'only-a']]) {
    const res = await api(`/api/rooms/${roomId}/signal`, {
      method: 'POST', cookie: hostCookie,
      body: { peerId: hostPeerId, to, type: 'offer', generation: 1, messageId, payload: { sdp: {} } },
    });
    assert.equal(res.status, 202);
  }
  const resumed = await openEvents(t, roomId, aId, a.cookie, ready.id);
  const replay = await resumed.until((e) => e.data.messageId === 'only-a');
  assert.deepEqual(replay.filter((e) => e.name === 'signal').map((e) => e.data.messageId), ['only-a']);
});

test('手填邀请地址按房间保存，重试和观众加入使用同一个房间', async () => {
  const cookie = await newSession();
  const create = (requestId, inviteOrigin) => api('/api/rooms', {
    method: 'POST', cookie, body: { requestId, inviteOrigin },
  });
  const address = 'http://localhost:3010';
  const room = await create('custom-invite', `${address}/`);
  assert.equal(room.status, 201);
  assert.equal(room.json.inviteUrl, `${address}/join/${room.json.code}`);
  const replay = await create('custom-invite', 'http://127.0.0.1:3020');
  assert.equal(replay.json.inviteUrl, room.json.inviteUrl);
  for (const invalid of [`${address}/join/ABC234`, `${address}?x=1`, 'http://external.invalid', 'ftp://localhost']) {
    assert.equal((await create('bad-invite', invalid)).status, 400);
  }
  assert.equal((await join(room.json.code, 'custom-invite-viewer')).json.roomId, room.json.roomId);
  const automatic = await create('automatic-invite');
  assert.equal(automatic.status, 201);
  assert.notEqual(new URL(automatic.json.inviteUrl).origin, address);
});

test('bootstrap 返回全局上限 4', async () => {
  const r = await api('/api/bootstrap');
  assert.equal(r.status, 200);
  assert.equal(r.json.maxViewers, 4);
});

test('默认建房 3 人，第 4 个被拒 E-202', async () => {
  const h = await newSession();
  const room = await makeRoom(h);
  assert.equal(room.status, 201);
  for (let i = 0; i < 3; i++) {
    const j = await join(room.json.code, 'j' + i);
    assert.equal(j.status, 201);
  }
  const over = await join(room.json.code, 'j-over');
  assert.equal(over.status, 409);
  assert.equal(over.json.code, 'E-202');
});

test('4 人房第 5 个被拒，文案带人数', async () => {
  const h = await newSession();
  const room = await makeRoom(h, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal((await join(room.json.code, 'j' + i)).status, 201);
  }
  const over = await join(room.json.code, 'j-over');
  assert.equal(over.status, 409);
  assert.match(over.json.message, /最多 4 人/);
});

test('非法人数上限被拒 400', async () => {
  const h = await newSession();
  assert.equal((await makeRoom(h, 5)).status, 400);
  assert.equal((await makeRoom(h, 0)).status, 400);
});

test('Origin 校验：合法放行、非法拒绝', async () => {
  const h = await newSession();
  const good = await api('/api/rooms', {
    method: 'POST', cookie: h, body: { requestId: 'r1' }, origin: 'http://localhost',
  });
  assert.equal(good.status, 201);
  const evil = await api('/api/rooms', {
    method: 'POST', cookie: h, body: { requestId: 'r2' }, origin: 'http://evil.com',
  });
  assert.equal(evil.status, 403);
});

test('信令 messageId 去重', async () => {
  const h = await newSession();
  const room = await makeRoom(h, 2);
  const { roomId, hostPeerId, code } = room.json;
  const j = await join(code, 'j1');
  const viewerPeerId = j.json.viewerPeerId;

  const sig = (messageId) => api(`/api/rooms/${roomId}/signal`, {
    method: 'POST', cookie: h,
    body: { peerId: hostPeerId, to: viewerPeerId, type: 'offer', generation: 1, messageId, payload: { sdp: 'x' } },
  });

  const s1 = await sig('m1');
  assert.equal(s1.status, 202);
  assert.equal(s1.json.duplicate, undefined);
  const s2 = await sig('m1');
  assert.equal(s2.status, 202);
  assert.equal(s2.json.duplicate, true);
});

test('同会话建房会关闭旧房间', async () => {
  const h = await newSession();
  const r1 = await makeRoom(h, 2);
  const r2 = await makeRoom(h, 2);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  assert.equal(rooms.get(r1.json.roomId).closed, true);
  assert.equal(rooms.get(r2.json.roomId).closed, false);
});

test('观众不能关房，越权 403', async () => {
  const h = await newSession();
  const room = await makeRoom(h, 2);
  const j = await join(room.json.code, 'j1');
  const close = await api(`/api/rooms/${room.json.roomId}/close`, {
    method: 'POST', cookie: j.cookie, body: { peerId: j.json.viewerPeerId },
  });
  assert.equal(close.status, 403);
});

test('观众之间互发信令被拒 403', async () => {
  const h = await newSession();
  const room = await makeRoom(h, 2);
  const a = await join(room.json.code, 'a');
  const b = await join(room.json.code, 'b');
  const cross = await api(`/api/rooms/${room.json.roomId}/signal`, {
    method: 'POST', cookie: a.cookie,
    body: { peerId: a.json.viewerPeerId, to: b.json.viewerPeerId, type: 'offer', generation: 1, messageId: 'x', payload: {} },
  });
  assert.equal(cross.status, 403);
});

test('跨房间信令被拒：peerId 属于 A 房却发到 B 房', async () => {
  const h1 = await newSession();
  const r1 = await makeRoom(h1, 2);
  const h2 = await newSession();
  const r2 = await makeRoom(h2, 2);
  const cross = await api(`/api/rooms/${r2.json.roomId}/signal`, {
    method: 'POST', cookie: h1,
    body: { peerId: r1.json.hostPeerId, to: r2.json.hostPeerId, type: 'offer', generation: 1, messageId: 'x', payload: {} },
  });
  assert.equal(cross.status, 401); // E-401A 会话/房间不匹配
});

test('信令代次校验：offer 只能为当前代或递增一代', async () => {
  const h = await newSession();
  const room = await makeRoom(h, 2);
  const { roomId, hostPeerId, code } = room.json;
  const j = await join(code, 'j1');
  const viewerPeerId = j.json.viewerPeerId;

  const offer = (gen, mid) => api(`/api/rooms/${roomId}/signal`, {
    method: 'POST', cookie: h,
    body: { peerId: hostPeerId, to: viewerPeerId, type: 'offer', generation: gen, messageId: mid, payload: { sdp: 'x' } },
  });

  assert.equal((await offer(1, 'g1')).status, 202); // 当前代 1，接受
  assert.equal((await offer(2, 'g2')).status, 202); // 递增一代，接受并更新到 2
  assert.equal((await offer(1, 'g3')).status, 400); // 过期（当前 2），拒绝
  assert.equal((await offer(4, 'g4')).status, 400); // 跳跃（当前 2），拒绝
  assert.equal((await offer(3, 'g5')).status, 202); // 再递增一代到 3，接受
});

test('聊天：发消息、昵称、限流、历史', async () => {
  const h = await newSession();
  const room = await api('/api/rooms', {
    method: 'POST', cookie: h, body: { requestId: 'r1', maxViewers: 2, nickname: '主播甲' },
  });
  const { roomId, hostPeerId } = room.json;
  const v = await newSession();
  const j = await api('/api/join', {
    method: 'POST', cookie: v, body: { code: room.json.code, requestId: 'j1', nickname: '观众乙' },
  });
  const viewerPeerId = j.json.viewerPeerId;

  // 观众发消息
  const m1 = await api(`/api/rooms/${roomId}/chat`, {
    method: 'POST', cookie: v, body: { peerId: viewerPeerId, text: '你好' },
  });
  assert.equal(m1.status, 201);
  assert.equal(m1.json.nickname, '观众乙');
  assert.equal(m1.json.role, 'viewer');
  assert.equal(m1.json.seq, 1); // 前端重连去重依赖服务端 seq

  // 限流：立即再发第二条 → 429
  const m2 = await api(`/api/rooms/${roomId}/chat`, {
    method: 'POST', cookie: v, body: { peerId: viewerPeerId, text: '太快了' },
  });
  assert.equal(m2.status, 429);

  // 主机发消息（不同 peer，不受观众限流影响）
  const m3 = await api(`/api/rooms/${roomId}/chat`, {
    method: 'POST', cookie: h, body: { peerId: hostPeerId, text: '大家好' },
  });
  assert.equal(m3.status, 201);
  assert.equal(m3.json.nickname, '主播甲');
  assert.equal(m3.json.role, 'host');
  assert.equal(m3.json.seq, 2);

  // 历史：session 返回 chatLog
  const s = await api(`/api/rooms/${roomId}/session?peer=${hostPeerId}`, { cookie: h });
  assert.equal(s.json.chatLog.length, 2);
});
