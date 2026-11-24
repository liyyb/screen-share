// 入口：HTTP/HTTPS 服务、静态资源白名单、定时清理、优雅退出。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { config, PUBLIC_DIR, ROOT } from './config.mjs';
import { handle } from './routes.mjs';
import { sweep } from './store.mjs';
import { publish } from './events.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// 静态资源白名单：只提供明确列出的文件，防止目录穿越与源码泄露
const ALLOWED = new Set([
  '/', '/index.html', '/join', '/join/', '/app.css', '/app.js',
  '/host.js', '/viewer.js', '/rtc.js', '/signaling.js', '/stats.js',
  '/recorder.js', '/ui.js', '/icons.js', '/errors.js', '/chat.js', '/quality.js', '/manifest.webmanifest',
  '/icon.svg', '/qrcode-generator.mjs', '/invite-origin.mjs',
]);

function resolveStatic(pathname) {
  let p = pathname;
  // 首页、/join、以及邀请链接 /join/ABC234 都返回同一个 SPA 入口
  if (p === '/' || p === '/join' || p === '/join/' || /^\/join\/[A-Z0-9]{6}\/?$/i.test(p)) {
    p = '/index.html';
  }
  if (!ALLOWED.has(p)) return null;
  const file = path.join(PUBLIC_DIR, path.basename(p));
  if (!file.startsWith(PUBLIC_DIR)) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return file;
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const file = resolveStatic(url.pathname);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const requestHandler = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    return handle(req, res);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res);
  }
  res.writeHead(405);
  res.end('405 Method Not Allowed');
};

let server;
if (config.tls) {
  try {
    // 与 preflight.mjs 一致，都按项目根解析，避免从不同 cwd 启动时路径不一致。
    const cert = fs.readFileSync(path.resolve(ROOT, config.tlsCertFile));
    const key = fs.readFileSync(path.resolve(ROOT, config.tlsKeyFile));
    server = https.createServer({ cert, key }, requestHandler);
  } catch (e) {
    console.error(`[server] 启动失败：HTTPS 证书无法加载 — ${e.message}`);
    console.error('[server] 处理：重新运行 scripts/generate-cert.sh，或清空 TLS_CERT_FILE / TLS_KEY_FILE 改用 HTTP。');
    process.exit(1);
  }
  console.log(`[server] HTTPS 已启动`);
} else {
  server = http.createServer(requestHandler);
  console.log(`[server] HTTP 已启动（主机用 localhost 打开；手机观看可直接走 HTTP）`);
}

// 预检之外再兜一层：启动瞬间端口被抢、地址失效等错误也给出可读原因，而不是抛栈。
server.on('error', (e) => {
  console.error(`[server] 启动失败（${e.code || 'UNKNOWN'}）：${e.message}`);
  if (e.code === 'EADDRINUSE') {
    console.error(`[server] 处理：端口 ${config.port} 被占用，关闭占用程序或设置 PORT=其他端口。`);
  } else if (e.code === 'EACCES') {
    console.error('[server] 处理：没有监听权限，换用 1024 以上端口或以管理员身份运行。');
  } else if (e.code === 'EADDRNOTAVAIL' || e.code === 'ENOTFOUND') {
    console.error('[server] 处理：HOST 地址在本机不存在，改成 0.0.0.0 或 127.0.0.1。');
  }
  process.exit(1);
});

// SSE 长连接需要关闭超时
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;

const sweepTimer = setInterval(() => sweep((room, peerId) => {
  publish(room, 'peer-left', { peerId, viewerCount: room.viewers.size });
}), 5_000);
sweepTimer.unref();

server.listen(config.port, config.host, () => {
  const scheme = config.tls ? 'https' : 'http';
  const origin = config.publicOrigin || `${scheme}://${config.host}:${config.port}`;
  console.log(`[server] 监听 ${config.host}:${config.port}`);
  console.log(`[server] 主机打开 ${scheme}://localhost:${config.port}`);
  console.log(`[server] 邀请地址前缀 ${origin}`);
  if (config.publicOrigin) {
    console.log(`[server] 手机请用主机页面上复制的邀请链接（需连同一 WiFi）`);
  } else {
    console.log(`[server] 当前仅本机可用；跨设备请设 HOST=0.0.0.0 或 PUBLIC_ORIGIN`);
  }
  console.log(`[server] 最大观众 ${config.maxViewers}，房间 TTL ${Math.round(config.roomTtlMs / 60000)} 分钟`);
  console.log(`[server] 按 Ctrl+C 或关闭窗口停止服务`);

  // 双击启动脚本会设置该变量。放在 listen 回调里，确保端口已就绪再打开网页端。
  if (process.env.SHARE_OPEN_BROWSER === '1') {
    const url = `${scheme}://localhost:${config.port}`;
    const cmd = process.platform === 'win32'
      ? `explorer "${url}"`
      : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
    console.log(`[server] 已打开浏览器网页端 ${url}`);
  }
});

function shutdown() {
  console.log('[server] 正在关闭...');
  clearInterval(sweepTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { requestHandler };
