import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessions, identities, rooms,
  newSession, createRoom, getRoomByCode, getRoomById,
  joinRoom, authenticate, isHost, isViewer, leaveRoom, closeRoom,
  roomSnapshot, sweep, addChatMessage,
} from '../server/store.mjs';
import { config } from '../server/config.mjs';
import { ApiError } from '../server/errors.mjs';

function reset() {
  sessions.clear();
  identities.clear();
  rooms.clear();
}

beforeEach(reset);

test('回收区分未订阅和等待首帧的观众，并关闭过期订阅', () => {
  const room = createRoom(newSession(), 'room');
  const pending = joinRoom(room, newSession(), 'pending').peerId;
  const loading = joinRoom(room, newSession(), 'loading').peerId;
  const now = Date.now();
  room.viewers.get(pending).joinedAt = now - config.seatHoldMs - 1000;
  const viewer = room.viewers.get(loading);
  viewer.joinedAt = room.viewers.get(pending).joinedAt;
  viewer.subscribedAt = viewer.joinedAt + 100;
  let closed = false;
  room.clients.set(loading, { res: { end: () => { closed = true; } } });
  const expired = [];
  const collect = (_room, id) => expired.push(id);
  sweep(collect);
  assert.deepEqual(expired, [pending]);
  assert.equal(room.viewers.has(loading), true);
  viewer.subscribedAt = now - config.firstFrameWaitMs - 1000;
  room.paused = true;
  sweep(collect);
  assert.equal(room.viewers.has(loading), true);
  room.paused = false;
  sweep(collect);
  assert.deepEqual(expired, [pending, loading]);
  assert.equal(room.clients.has(loading), false);
  assert.equal(closed, true);
});

test('创建房间：生成 6 位码、主机身份、默认状态', () => {
  const sid = newSession();
  const room = createRoom(sid, 'req-1');
  assert.equal(room.code.length, 6);
  assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(room.hostSession, sid);
  assert.equal(room.paused, false);
  assert.equal(room.audioEnabled, false);
  assert.equal(room.viewers.size, 0);
  assert.equal(isHost(room, room.hostPeerId), true);
});

test('创建幂等：同一会话同一 requestId 返回同一房间', () => {
  const sid = newSession();
  const a = createRoom(sid, 'same');
  const b = createRoom(sid, 'same');
  assert.equal(a.roomId, b.roomId);
  assert.equal(rooms.size, 1);
});

test('通过房间码查找，大小写与空白不敏感', () => {
  const room = createRoom(newSession(), 'r');
  assert.equal(getRoomByCode(room.code), room);
  assert.equal(getRoomByCode(` ${room.code.toLowerCase()} `), room);
  assert.equal(getRoomByCode('XXXXXX'), null);
});

test('加入房间：分配观众身份，人数上限生效', () => {
  const room = createRoom(newSession(), 'r', 4);
  const sids = [newSession(), newSession(), newSession(), newSession(), newSession()];
  for (let i = 0; i < room.maxViewers; i++) {
    const { peerId } = joinRoom(room, sids[i], `j${i}`);
    assert.equal(isViewer(room, peerId), true);
  }
  assert.throws(() => joinRoom(room, sids[4], 'j4'), (e) => e instanceof ApiError && e.code === 'E-202');
});

test('加入幂等：同一会话重复请求复用席位', () => {
  const room = createRoom(newSession(), 'r');
  const sid = newSession();
  const a = joinRoom(room, sid, 'x');
  const b = joinRoom(room, sid, 'x');
  assert.equal(a.peerId, b.peerId);
  assert.equal(room.viewers.size, 1);
});

test('身份校验：跨会话、跨房间、角色错误均被拒绝', () => {
  const room = createRoom(newSession(), 'r');
  const sid = newSession();
  const { peerId } = joinRoom(room, sid, 'j');
  assert.doesNotThrow(() => authenticate(sid, peerId, room.roomId));
  assert.throws(() => authenticate(newSession(), peerId, room.roomId), (e) => e.code === 'E-401A');
  assert.throws(() => authenticate(sid, room.hostPeerId, room.roomId), (e) => e.code === 'E-401A');
  assert.throws(() => authenticate(sid, peerId, room.roomId, 'host'), (e) => e.code === 'E-403');
});

test('退出与关房：席位/身份被清理，重复退出幂等', () => {
  const room = createRoom(newSession(), 'r');
  const sid = newSession();
  const { peerId } = joinRoom(room, sid, 'j');
  assert.equal(leaveRoom(room, peerId), true);
  assert.equal(leaveRoom(room, peerId), false);
  assert.equal(identities.has(peerId), false);
  assert.equal(isViewer(room, peerId), false);
  closeRoom(room);
  assert.equal(getRoomById(room.roomId), null);
});

test('快照包含人数、暂停、状态版本', () => {
  const room = createRoom(newSession(), 'r');
  joinRoom(room, newSession(), 'j');
  room.paused = true;
  room.stateVersion = 5;
  const snap = roomSnapshot(room);
  assert.equal(snap.viewerCount, 1);
  assert.equal(snap.paused, true);
  assert.equal(snap.stateVersion, 5);
  assert.equal(snap.viewers.length, 1);
});

test('回收：过期房间被关闭并清理', () => {
  const room = createRoom(newSession(), 'r');
  room.expiresAt = Date.now() - 1;
  sweep();
  assert.equal(rooms.has(room.roomId), false);
  assert.equal(getRoomByCode(room.code), null);
});

test('聊天 seq 在历史裁剪后仍递增（前端重连去重依赖）', () => {
  const room = createRoom(newSession(), 'chat-seq');
  for (let i = 0; i < 205; i++) {
    addChatMessage(room, {
      peerId: room.hostPeerId, nickname: '主播', role: 'host', text: `m${i}`,
    });
  }
  assert.equal(room.chatLog.length, 200);
  assert.equal(room.chatLog.at(-1).seq, 205);
});
