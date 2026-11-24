// 长测 L01：连续多轮建房/加入/结束，验证资源回到基线、内存无持续增长。
// 用法：node --expose-gc scripts/longrun.mjs
// 说明：媒体采集在浏览器端（getDisplayMedia），此处验证服务端房间/身份/内存回收。
import {
  sessions, identities, rooms,
  newSession, createRoom, joinRoom, closeRoom, sweep,
} from '../server/store.mjs';

const gc = () => { if (global.gc) global.gc(); };
const heap = () => Number((process.memoryUsage().heapUsed / 1048576).toFixed(2));

function reset() {
  sessions.clear();
  identities.clear();
  rooms.clear();
}

// 一轮：建房 → 3 观众加入 → 模拟首帧 → 关房 → 回收
function round(i, viewerCount = 3) {
  const host = newSession();
  const room = createRoom(host, `r${i}`, 4);
  for (let j = 0; j < viewerCount; j++) {
    const v = newSession();
    joinRoom(room, v, `j${i}-${j}`);
  }
  for (const vp of room.viewers.keys()) room.viewers.get(vp).firstFrame = true;
  closeRoom(room);
  sweep();
}

reset();
gc();
console.log(`开始 heap: ${heap()} MB`);

// 阶段 1：L01 要求的 20 轮
for (let i = 0; i < 20; i++) round(i, 3);
gc();
console.log(`20 轮后 rooms=${rooms.size} identities=${identities.size}（应为 0）`);

// 阶段 2：500 轮内存稳定性，每 100 轮清理过期 session（模拟长期运行）并采样 heap
const trend = [];
for (let i = 0; i < 500; i++) {
  round(1000 + i, 3);
  if ((i + 1) % 100 === 0) {
    sessions.clear();
    gc();
    trend.push(heap());
  }
}
console.log(`500 轮后 rooms=${rooms.size} identities=${identities.size}（应为 0）`);
console.log(`内存趋势（每 100 轮 heap MB）: ${trend.join(' → ')}`);

const growing = trend.length >= 2 && trend[trend.length - 1] > trend[0] * 1.2;
console.log(`内存判定: ${growing ? 'FAIL（持续增长）' : 'PASS（稳定）'}`);

const ok = rooms.size === 0 && identities.size === 0 && !growing;
console.log(`\nL01 服务端结论: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
