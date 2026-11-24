// 配置解析：全部来自环境变量，带开发默认值。零第三方依赖。
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 自动探测局域网 IPv4：双击启动时 HOST=0.0.0.0，邀请链接必须指向真实可访问的 IP。
// 优先家用/办公私有网段，排除虚拟网卡（VPN / Docker / WSL 等）。
//
// 虚拟局域网组网（Radmin LAN / Tailscale / ZeroTier / WireGuard 等）单独探测：
// 这些工具的网卡 IP 才是跨网观众能访问到的地址，单独导出供预检提示。

const VIRTUAL_IFACE = /vpn|virtual|tap|tun|hamachi|radmin|zerotier|tailscale|wireguard|wg|openvpn/i;
const EXCLUDED_IFACE = /vpn|virtual|tap|tun|loopback|docker|wsl|hamachi|radmin|zerotier|tailscale|wireguard|wg|openvpn|vmware|vbox/i;

function collectIPv4(excludeRe) {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (excludeRe && excludeRe.test(name)) continue;
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(127\.|169\.254\.|0\.)/.test(a.address)) continue;
      found.push({ ip: a.address, name });
    }
  }
  return found;
}

function detectLanIPv4() {
  const rank = (ip) => {
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  const found = collectIPv4(EXCLUDED_IFACE);
  found.sort((x, y) => rank(x.ip) - rank(y.ip));
  return found[0]?.ip || '';
}

// 探测虚拟局域网网卡的 IP（Radmin/Tailscale/ZeroTier 等），供跨网组网场景使用
function detectVirtualIPv4() {
  return collectIPv4(null).filter((x) => VIRTUAL_IFACE.test(x.name)).map((x) => x.ip);
}
export const ROOT = path.resolve(__dirname, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} 必须是 ${min}~${max} 的整数，收到 ${raw}`);
  }
  return n;
}

function list(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const host = process.env.HOST || '127.0.0.1';
const port = int('PORT', 3000, 1, 65535);
const tls = Boolean(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);
const explicitOrigin = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
const lanIp = detectLanIPv4();
const virtualIps = detectVirtualIPv4();
// 显式设置 PREFER_VIRTUAL_LAN=1 时，优先用虚拟局域网 IP（Radmin/Tailscale 等）做邀请地址，
// 用于跨网组网场景；否则用物理局域网 IP。显式 PUBLIC_ORIGIN 始终优先。
const preferVirtual = process.env.PREFER_VIRTUAL_LAN === '1';
const autoIp = preferVirtual ? (virtualIps[0] || lanIp) : lanIp;
// 仅当服务监听外部地址且未显式指定 PUBLIC_ORIGIN 时，才自动填邀请地址。
// 默认 127.0.0.1 的本机开发保持原有行为，不影响 localhost 单测。
const publicOrigin = explicitOrigin
  || (host !== '127.0.0.1' && host !== 'localhost' && autoIp
    ? `http${tls ? 's' : ''}://${autoIp}:${port}`
    : '');

export const config = {
  host,
  port,
  publicOrigin,
  tlsCertFile: process.env.TLS_CERT_FILE || '',
  tlsKeyFile: process.env.TLS_KEY_FILE || '',
  tls,
  stunUrls: list('STUN_URLS', ['stun:stun.l.google.com:19302']),
  turnUrls: list('TURN_URLS', []),
  relayOnly: process.env.SHARE_RELAY_ONLY === '1',
  turnSecret: process.env.TURN_SHARED_SECRET || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
  maxViewers: int('MAX_VIEWERS', 4, 1, 4),  // 全局观众上限（最多 4 人）
  roomTtlMs: int('ROOM_TTL_MS', 2 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
  // 内部策略常量
  seatHoldMs: 15_000,          // 未完成加入的席位保留
  firstFrameWaitMs: 90_000,    // 已订阅观众的建连与播放期限
  signalGraceMs: 60_000,       // 已建立会话的信令断线宽限
  sseHeartbeatMs: 15_000,      // SSE 心跳
  sseBufferMax: 128,           // 每参与者事件缓存上限
  sseBufferTtlMs: 60_000,      // 事件缓存时间
  sseBufferBytes: 1_048_576,   // 事件缓存总字节上限 1MB
  bodyMaxBytes: 128 * 1024,
  protocolVersion: 1,
};

// 导出探测到的局域网 IPv4，供 routes 做 Origin 白名单校验
export const LAN_IP = lanIp;
// 导出虚拟局域网网卡 IP（Radmin/Tailscale/ZeroTier 等），供预检提示跨网组网地址
export const VIRTUAL_IPS = virtualIps;

export function inviteUrl(code, origin) {
  const base = origin || config.publicOrigin || `http${config.tls ? 's' : ''}://${config.host}:${config.port}`;
  return `${base}/join/${code}`;
}
