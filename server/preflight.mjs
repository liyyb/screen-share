// 运行环境预检：零第三方依赖，由 启动服务.bat 在启动服务前调用。
// 也可单独运行：node server/preflight.mjs
// 退出码：0 = 环境正常，可启动；1 = 环境有误，服务不启动；2 = 本服务已在运行。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIN_NODE_MAJOR = 18;

// 与 main.mjs 的静态白名单保持一致。整个目录拷走才完整，缺一个都不算可携带。
const REQUIRED = [
  'server/main.mjs', 'server/config.mjs', 'server/routes.mjs',
  'server/store.mjs', 'server/events.mjs', 'server/errors.mjs',
  'public/index.html', 'public/app.css', 'public/app.js',
  'public/host.js', 'public/viewer.js', 'public/rtc.js',
  'public/signaling.js', 'public/stats.js', 'public/recorder.js',
  'public/ui.js', 'public/icons.js', 'public/errors.js',
  'public/manifest.webmanifest', 'public/icon.svg', 'public/chat.js',
  'public/quality.js', 'public/qrcode-generator.mjs', 'public/invite-origin.mjs',
];

function probePort(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve({ ok: false, code: e.code || 'UNKNOWN', message: e.message }));
    s.listen(port, host, () => s.close(() => resolve({ ok: true })));
  });
}

// 端口被占时，判断占用者是不是本项目自己（避免把别人的服务误认成已启动）。
function isOurServer(config) {
  return new Promise((resolve) => {
    const host = ['0.0.0.0', '::', 'localhost'].includes(config.host) ? '127.0.0.1' : config.host;
    const opts = {
      host, port: config.port, path: '/health', timeout: 1500,
      ...(config.tls ? { rejectUnauthorized: false } : {}),
    };
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = (config.tls ? https : http).get(opts, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; if (buf.length > 4096) req.destroy(); });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          finish(Boolean(j && j.ok === true && j.app === 'share'));
        } catch { finish(false); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => finish(false));
  });
}

function checkCert(certEnv, keyEnv) {
  const cf = path.resolve(ROOT, certEnv);
  const kf = path.resolve(ROOT, keyEnv);
  for (const [label, f] of [['证书', cf], ['私钥', kf]]) {
    if (!fs.existsSync(f)) return { level: 'fail', label: 'HTTPS 证书', reason: `${label}文件不存在：${f}`, fix: '重新运行 scripts/generate-cert.sh 生成证书，或清空 TLS_* 变量改用 HTTP' };
  }
  try {
    // createSecureContext 会校验 PEM 格式与公私钥是否匹配，提前拦下启动阶段的崩溃。
    tls.createSecureContext({ cert: fs.readFileSync(cf), key: fs.readFileSync(kf) });
    return { level: 'ok', label: 'HTTPS 证书', detail: 'PEM 格式与公私钥匹配' };
  } catch (e) {
    return { level: 'fail', label: 'HTTPS 证书', reason: e.message, fix: '确认 cert/key 是 PEM 文本且成对生成；必要时重新生成，或清空 TLS_* 变量改用 HTTP' };
  }
}

export async function runPreflight() {
  const results = [];
  const ok = (label, detail = '') => results.push({ level: 'ok', label, detail });
  const warn = (label, detail = '', fix = '') => results.push({ level: 'warn', label, detail, fix });
  const fail = (label, reason, fix) => results.push({ level: 'fail', label, reason, fix });

  // 1. Node 版本（ESM / node: 内置模块 / WebCrypto 的最低要求）
  const nodeVer = process.versions.node || 'unknown';
  const major = Number.parseInt(nodeVer, 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    fail('Node.js 版本', `当前 v${nodeVer}，本项目需要 >= ${MIN_NODE_MAJOR}`, '到 https://nodejs.org 安装 Node.js 18+（推荐 22 LTS），重开窗口后重新双击');
  } else {
    ok(`Node.js v${nodeVer}`, `要求 >= ${MIN_NODE_MAJOR}`);
  }

  // 2. 项目文件完整性与可读性（拷漏文件是最常见的"换机跑不起来"）
  const missing = [];
  let unreadable = '';
  for (const rel of REQUIRED) {
    const f = path.join(ROOT, rel);
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { missing.push(rel); continue; }
    try { fs.accessSync(f, fs.constants.R_OK); } catch { unreadable = rel; }
  }
  if (missing.length) {
    fail('项目文件完整', `缺少 ${missing.length} 个文件：${missing.join('、')}`, '把整个项目文件夹（server/、public/ 与本 bat 同级）完整拷贝，不要只拷启动脚本');
  } else if (unreadable) {
    fail('项目文件可读', `${unreadable} 没有读取权限`, '检查文件是否被占用或权限受限，重新解压/拷贝项目');
  } else {
    ok('项目文件完整', `${REQUIRED.length} 个必需文件齐全`);
  }

  // 3. 配置解析（PORT / MAX_VIEWERS 等非法值会在 import 阶段抛错）
  let config = null;
  let virtualIps = [];
  try {
    const cfg = await import('./config.mjs');
    config = cfg.config;
    virtualIps = cfg.VIRTUAL_IPS || [];
    ok('配置解析', `PORT=${config.port} HOST=${config.host} 观众上限=${config.maxViewers}`);
  } catch (e) {
    fail('配置解析', e.message, '检查 PORT / MAX_VIEWERS / ROOM_TTL_MS 等环境变量是否为合法数值，改好后重新双击');
    warn('端口与地址检查', '配置未解析，本轮已跳过', '先修正上面的配置错误，再重新双击');
  }

  // 4. 邀请地址：显式配置合法性 / 自动探测结果
  if (config) {
    const origin = (process.env.PUBLIC_ORIGIN || '').trim();
    if (origin) {
      try {
        const u = new URL(origin);
        if (!/^https?:$/.test(u.protocol)) throw new Error('协议必须是 http 或 https');
        ok('邀请地址 PUBLIC_ORIGIN', origin);
      } catch (e) {
        fail('邀请地址 PUBLIC_ORIGIN', `${origin} 不是合法地址（${e.message}）`, '改成 http://局域网IP:端口 或 https://域名，或清空该变量让脚本自动探测');
      }
    } else if (config.publicOrigin) {
      ok('邀请地址自动探测', config.publicOrigin);
    } else if (config.host === '0.0.0.0' || config.host === '::') {
      warn('未探测到局域网 IP', '邀请链接可能指向 0.0.0.0，手机打不开', '确认已连上 WiFi/网线；或显式设置 PUBLIC_ORIGIN=http://本机IP:端口');
    } else {
      ok('邀请地址', '本机模式（localhost）');
    }
    // 虚拟局域网组网提示（Radmin / Tailscale / ZeroTier 等）
    if (virtualIps.length) {
      const v = virtualIps[0];
      warn('虚拟局域网网卡', `检测到 ${virtualIps.join('、')}（组网工具虚拟网卡）`,
        `仅已加入同一虚拟网络的观众可使用 ${v}；普通手机跨网观看请使用 Funnel 的公网 HTTPS 邀请链接`);
    }
  }

  if (config) {
    if (Boolean(config.turnUsername) !== Boolean(config.turnCredential)) {
      fail('TURN 配置', '中继用户名和密码必须成对设置', '使用服务商下发的 TURN_USERNAME 和 TURN_CREDENTIAL');
    }
    if (config.relayOnly && !config.turnUrls.length) {
      fail('中继验收', '强制中继需要 TURN 地址', '配置 TURN_URLS 和凭证，或清除 SHARE_RELAY_ONLY');
    }
  }

  // 5. HTTPS 证书
  const certEnv = process.env.TLS_CERT_FILE || '';
  const keyEnv = process.env.TLS_KEY_FILE || '';
  if (Boolean(certEnv) !== Boolean(keyEnv)) {
    fail('HTTPS 证书配置', 'TLS_CERT_FILE 与 TLS_KEY_FILE 必须同时设置', '两个都填，或都清空改用 HTTP');
  } else if (certEnv && keyEnv) {
    results.push(checkCert(certEnv, keyEnv));
  } else {
    ok('HTTPS 证书', '未启用（HTTP 模式，免证书）');
  }

  // 6. 端口可绑定：区分「本服务已在运行」「被其他程序占用」「权限不足」「地址不存在」
  let state = 'ready';
  if (config) {
    const p = await probePort(config.host, config.port);
    if (!p.ok) {
      if (p.code === 'EADDRINUSE') {
        if (await isOurServer(config)) {
          state = 'running';
          ok('服务端口', `${config.port} 上已有本服务在运行`);
        } else {
          fail('服务端口', `端口 ${config.port} 已被其他程序占用（${p.message}）`, `关闭占用程序，或设置 PORT=其他端口后重新双击；用 netstat -ano | findstr :${config.port} 查占用者`);
        }
      } else if (p.code === 'EACCES') {
        fail('服务端口', `没有权限监听 ${config.host}:${config.port}（${p.message}）`, '改用 1024 以上的端口（如 PORT=3000），或以管理员身份运行');
      } else if (p.code === 'EADDRNOTAVAIL' || p.code === 'ENOTFOUND') {
        fail('监听地址 HOST', `本机不存在地址 ${config.host}（${p.message}）`, '把 HOST 改成 0.0.0.0（局域网）或 127.0.0.1（仅本机）');
      } else {
        fail('服务端口', `${p.code}：${p.message}`, '检查 HOST/PORT 设置，改好后重新双击');
      }
    } else {
      ok('服务端口', `${config.host}:${config.port} 可绑定`);
    }
  }

  const failed = results.filter((r) => r.level === 'fail').length;
  const warned = results.filter((r) => r.level === 'warn').length;
  const passed = results.filter((r) => r.level === 'ok').length;
  // 任何失败项都优先于「已在运行」：否则会跳过启动却不报错。
  if (failed > 0) state = 'failed';
  return { results, state, failed, warned, passed };
}

export function printReport({ results, state, failed, warned, passed }) {
  console.log('');
  console.log('  运行环境检测');
  console.log('  ------------------------------------------------------------');
  for (const r of results) {
    const tag = r.level === 'ok' ? '[OK]  ' : r.level === 'warn' ? '[提示]' : '[失败]';
    console.log(`  ${tag} ${r.label}${r.detail ? ' — ' + r.detail : ''}`);
    if (r.level === 'fail') {
      console.log(`         原因：${r.reason}`);
      console.log(`         处理：${r.fix}`);
    } else if (r.level === 'warn' && r.fix) {
      console.log(`         处理：${r.fix}`);
    }
  }
  console.log('  ------------------------------------------------------------');
  if (state === 'running') {
    console.log('  本服务已在运行，无需重复启动，直接打开页面即可。');
    console.log('  如需重启：先关闭旧服务窗口，再重新双击。');
  } else if (state === 'failed') {
    console.log(`  检测未通过：${failed} 项失败。服务未启动。`);
    console.log('  按上面的「处理」修正后，重新双击 启动服务.bat。');
  } else {
    console.log(`  检测通过：${passed} 项正常${warned ? `，${warned} 项提示` : ''}。正在启动服务...`);
  }
  console.log('');
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  runPreflight().then((r) => {
    printReport(r);
    process.exitCode = r.state === 'running' ? 2 : r.state === 'failed' ? 1 : 0;
  }).catch((e) => {
    console.error('  预检程序自身出错：' + (e && e.stack ? e.stack : String(e)));
    console.error('  请检查 Node.js 安装是否完整，或把上面的信息发给开发者。');
    process.exitCode = 1;
  });
}
