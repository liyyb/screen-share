// 入口：解析邀请 URL，接管首页/主机/观众视图，绑定操作，错误兜底。
import { SignalClient } from './signaling.js';
import { HostController } from './host.js';
import { ViewerController } from './viewer.js';
import { initTheme, $, toast, blocking, reportError, copyText } from './ui.js';
import { icons } from './icons.js';
import { parseInviteOrigin } from './invite-origin.mjs';
import {
  QUALITY_PROFILES, QUALITY_ORDER, DEFAULT_QUALITY, getProfile, formatProfile,
} from './quality.js';

let controller = null;

function statLine(id, s) {
  const res = s.width && s.height ? `${s.width}x${s.height}` : '-';
  return `观众 ${id}: 编码=${s.codec || '-'} 分辨率=${res} 帧率=${s.fpsText} 码率=${s.bitrateText} RTT=${s.rttText} 路径=${s.modeText}`;
}

function buildDiagnostic() {
  const c = controller;
  const lines = [
    `应用版本: 1.0`,
    `角色: ${c?.signal?.role || '-'}`,
    `浏览器: ${navigator.userAgent}`,
    `时间: ${new Date().toISOString()}`,
  ];
  if (!c) return lines.join('\n');
  if (c.signal.role === 'host') {
    lines.push(
      `房间状态: ${c.stopped ? '已结束' : '共享中'} 暂停=${c.paused} 画质=${getProfile(c.quality).label} (${formatProfile(c.quality)}) 观众=${c.links.size}`,
    );
    for (const [id, m] of c.monitors) lines.push(statLine(id.slice(0, 6), m.snapshot()));
  } else {
    lines.push(
      `房间状态: ${c.ended ? '已结束' : '观看中'} 暂停=${c.paused} 首帧=${c.firstFrame}`,
      statLine('本机接收', c.monitor.snapshot()),
    );
  }
  return lines.join('\n');
}

function showDiagnostic() {
  const text = buildDiagnostic();
  blocking('诊断信息', {
    title: '诊断信息',
    text,
    pre: true,
    action: '复制',
    onAction: () => copyText(text).then(
      () => toast('诊断信息已复制'),
      () => toast('无法复制诊断信息'),
    ),
  });
}

function showView(name) {
  for (const v of ['landing', 'host', 'viewer']) {
    $(`#view-${v}`)?.classList.toggle('active', v === name);
  }
}

// 首次使用询问昵称（聊天/弹幕显示），之后记住。用自定义输入框，不用 prompt()（部分环境不支持）。
function ensureNickname() {
  let saved = null;
  try { saved = localStorage.getItem('share-nick'); } catch { /* 隐私模式下忽略 */ }
  // 空字符串代表用户选择了"跳过"，也是一次明确选择，不再反复询问
  if (saved !== null) return Promise.resolve(saved);
  return new Promise((resolve) => {
    const layer = document.createElement('div');
    layer.className = 'nick-modal';
    layer.innerHTML = `
      <div class="nick-card">
        <h3>取个昵称</h3>
        <p>会显示在聊天和弹幕里</p>
        <input class="nick-input" placeholder="输入昵称" maxlength="24">
        <div class="nick-actions">
          <button class="btn ghost nick-skip">跳过</button>
          <button class="btn primary nick-ok">确定</button>
        </div>
      </div>`;
    document.body.appendChild(layer);
    const input = layer.querySelector('.nick-input');
    const done = (v) => { layer.remove(); resolve(v); };
    const store = (v) => { try { localStorage.setItem('share-nick', v); } catch { /* ignore */ } };
    const ok = () => {
      const v = input.value.trim().slice(0, 24);
      store(v); // 空值也写入，代表用户主动跳过
      done(v);
    };
    layer.querySelector('.nick-ok').addEventListener('click', ok);
    layer.querySelector('.nick-skip').addEventListener('click', () => { store(''); done(''); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    input.focus();
  });
}

async function startHost(btn) {
  const inviteOrigin = readInviteSettings({ validate: true, save: true });
  if (inviteOrigin === null) {
    $('#invite-settings').open = true;
    $('#invite-origin').focus();
    return;
  }
  await ensureNickname();
  const signal = new SignalClient();
  const host = new HostController(signal);
  controller = host;
  btn.disabled = true;
  btn.textContent = '正在请求共享…';
  try {
    // getDisplayMedia 必须在用户手势中调用，bootstrap/建房移到 host.start 拿到流之后执行
    const maxViewers = Number($('#capacity-select')?.value || 3);
    const quality = $('#quality-select')?.value || DEFAULT_QUALITY;
    const ok = await host.start(maxViewers, quality, inviteOrigin);
    if (ok) {
      $('#host-invite-origin').textContent = signal.inviteUrl.slice(0, signal.inviteUrl.lastIndexOf('/join/'));
      showView('host');
    }
    else { btn.disabled = false; btn.textContent = '开始共享'; }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '开始共享';
    reportError(e);
  }
}

async function startViewer(code) {
  await ensureNickname();
  const signal = new SignalClient();
  const viewer = new ViewerController(signal, code);
  controller = viewer;
  try {
    await signal.bootstrap();
    const ok = await viewer.start();
    if (ok) {
      showView('viewer');
      // 无论通过邀请链接还是首页输入加入，都把地址栏改成邀请链接，刷新后能恢复原席位
      history.replaceState(null, '', '/join/' + code);
    }
  } catch (e) {
    reportError(e, 'E-301');
  }
}

const INVITE_ORIGIN_KEY = 'share-invite-origin';

function readInviteSettings({ validate = false, save = false } = {}) {
  const isManual = $('[name="invite-mode"][value="manual"]').checked;
  const input = $('#invite-origin');
  const feedback = $('#invite-origin-feedback');
  $('#invite-manual').hidden = !isManual;
  $('#invite-auto-help').hidden = isManual;
  $('#invite-mode-summary').textContent = isManual ? '手动填写' : '自动选择';
  input.removeAttribute('aria-invalid');
  feedback.textContent = '';
  let origin;
  if (isManual) {
    try { origin = parseInviteOrigin(input.value); }
    catch {
      if (validate) {
        input.setAttribute('aria-invalid', 'true');
        feedback.textContent = '请填写有效入口，例如 http://26.x.x.x:3000。';
      }
      return null;
    }
    feedback.textContent = `邀请预览 ${origin}/join/〈房间码〉`;
  }
  if (save) {
    try {
      if (origin) localStorage.setItem(INVITE_ORIGIN_KEY, origin);
      else localStorage.removeItem(INVITE_ORIGIN_KEY);
    } catch { /* 浏览器可能限制本地保存，当前页面仍可使用。 */ }
  }
  return origin;
}

function initLanding() {
  const startBtn = $('#btn-start');
  const joinBtn = $('#btn-join');
  const joinPanel = $('#join-panel');
  const codeInput = $('#code-input');
  const joinSubmit = $('#join-submit');
  const inviteInput = $('#invite-origin');
  try { inviteInput.value = localStorage.getItem(INVITE_ORIGIN_KEY) || ''; } catch { /* ignore */ }
  if (inviteInput.value) $('[name="invite-mode"][value="manual"]').checked = true;
  readInviteSettings();
  for (const option of document.querySelectorAll('[name="invite-mode"]')) {
    option.addEventListener('change', () => {
      readInviteSettings({ save: true });
      if (option.value === 'manual') inviteInput.focus();
    });
  }
  inviteInput.addEventListener('input', () => readInviteSettings());
  inviteInput.addEventListener('change', () => readInviteSettings({ validate: true, save: true }));

  startBtn?.addEventListener('click', () => startHost(startBtn));
  joinBtn?.addEventListener('click', () => {
    joinPanel?.classList.add('show');
    codeInput?.focus();
  });
  joinSubmit?.addEventListener('click', () => {
    const code = (codeInput?.value || '').trim();
    if (!/^[A-HJ-NP-Z2-9]{6}$/i.test(code)) {
      toast('请输入 6 位房间码');
      return;
    }
    startViewer(code.toUpperCase());
  });
  codeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinSubmit?.click();
  });
  codeInput?.addEventListener('input', () => {
    codeInput.value = codeInput.value.trim().toUpperCase().replace(/[^A-HJ-NP-Z2-9]/gi, '').slice(0, 6);
  });
}

async function showInviteQr() {
  const host = controller;
  const inviteUrl = host?.signal?.inviteUrl;
  const container = $('#host-qr-image');
  const note = $('#host-qr-note');
  if (!inviteUrl || host.stopped) return;
  if (container.dataset.inviteUrl === inviteUrl) return;

  container.replaceChildren();
  delete container.dataset.inviteUrl;
  note.textContent = '正在生成二维码…';
  let makeQr;
  try {
    ({ default: makeQr } = await import('./qrcode-generator.mjs'));
  } catch {
    if (controller === host && !host.stopped) {
      note.textContent = '二维码组件未加载。更新后请重启共享服务，再刷新页面。';
    }
    return;
  }
  if (controller !== host || host.stopped) return;
  try {
    const url = new URL(inviteUrl);
    const qr = makeQr(0, 'M');
    qr.addData(url.href);
    qr.make();
    const cell = 8;
    const image = new Image();
    image.alt = '当前房间的邀请二维码';
    image.src = qr.createDataURL(cell, cell * 4);
    container.append(image);
    container.dataset.inviteUrl = inviteUrl;
    const loopback = ['localhost', '[::1]', '0.0.0.0'].includes(url.hostname) || url.hostname.startsWith('127.');
    note.textContent = loopback
      ? '当前链接仅在本机可用。手机观看请使用手机可访问的邀请地址。'
      : '用手机相机扫码，打开浏览器观看。';
  } catch {
    if (controller === host && !host.stopped) note.textContent = '二维码生成失败，请使用复制链接。';
  }
}

function initHostControls() {
  $('#host-copy')?.addEventListener('click', (e) => controller?.copyInvite(e.currentTarget));
  $('#host-qr')?.addEventListener('click', showInviteQr);
  $('#host-pause')?.addEventListener('click', () => controller?.togglePause());
  $('#host-audio')?.addEventListener('click', () => controller?.toggleAudio());
  $('#host-stop')?.addEventListener('click', () => controller?.stop());
  $('#host-quality-select')?.addEventListener('change', (e) => {
    controller?.setQuality(e.target.value);
  });
  $('#host-details-toggle')?.addEventListener('click', () => {
    $('#host-details')?.classList.toggle('show');
  });
  const diag = $('#host-diagnostic');
  diag?.addEventListener('click', showDiagnostic);
}

function initViewerControls() {
  $('#viewer-fullscreen')?.addEventListener('click', () => controller?.toggleFullscreen());
  $('#viewer-mute')?.addEventListener('click', () => controller?.toggleMute());
  $('#viewer-exit')?.addEventListener('click', () => controller?.leave());
  $('#viewer-play')?.addEventListener('click', () => controller?.playManually());
  $('#viewer-record')?.addEventListener('click', () => controller?.toggleRecord());
  $('#viewer-stats-toggle')?.addEventListener('click', () => {
    $('#viewer-details')?.classList.toggle('show');
  });
  $('#viewer-diagnostic')?.addEventListener('click', showDiagnostic);
  const stage = $('#viewer-stage');
  const controls = $('#viewer-controls');
  let hideTimer;
  const reveal = () => {
    controls?.classList.add('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!document.fullscreenElement) controls?.classList.remove('show');
    }, 3000);
  };
  // 控制条默认隐藏；点按画面顶部的状态区/画面本身才浮现，避免常驻遮挡画面。
  // 播放按钮、暂停遮罩、控制条自身的点击走各自逻辑，不触发这里。
  const onStageTap = (e) => {
    if (e.target.closest?.('#viewer-controls, #viewer-details, #viewer-play, .pause-mask')) return;
    reveal();
  };
  stage?.addEventListener('click', onStageTap);
  stage?.addEventListener('mousemove', (e) => {
    if (e.pointerType !== 'touch') reveal();
  });
  // 全屏时始终显示控制条，便于退出全屏。
  // 手机系统返回键会“退出全屏 + 后退历史”一起做，若没有哨兵条目就会直接退回首页。
  // 进入全屏时压入同 URL 的哨兵，让返回键只消耗哨兵；页面按钮退出时主动弹掉。
  const syncControls = (inFullscreen) => {
    clearTimeout(hideTimer);
    controls?.classList.toggle('show', inFullscreen);
  };
  const pushFsSentinel = () => {
    if (!history.state?.shareFullscreen) history.pushState({ shareFullscreen: true }, '', location.href);
  };
  const popFsSentinel = () => {
    if (history.state?.shareFullscreen) history.back();
  };
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) { pushFsSentinel(); syncControls(true); }
    else { popFsSentinel(); syncControls(false); }
  });
  const video = $('#viewer-video');
  video?.addEventListener('webkitbeginfullscreen', () => syncControls(true));
  video?.addEventListener('webkitendfullscreen', () => syncControls(false));
  // 兜底：手机系统返回键在全屏时会消耗哨兵并后退。发现哨兵被吃掉但仍在全屏，
  // 立即补回哨兵并退出全屏，保证最终停在原观看地址而不是上一页。
  window.addEventListener('popstate', () => {
    if (document.fullscreenElement && !history.state?.shareFullscreen) {
      pushFsSentinel();
      document.exitFullscreen?.();
    }
    const c = controller;
    if (c?.signal?.role === 'viewer' && !c._left && !c.ended && c.code
        && !location.pathname.startsWith('/join/')) {
      history.replaceState(null, '', '/join/' + c.code);
      showView('viewer');
    }
  });
}

// 全局错误兜底：不静默失败
window.addEventListener('unhandledrejection', (e) => {
  console.error('[app] unhandled rejection', e.reason);
  toast('发生了一个错误，请重试');
});
window.addEventListener('error', (e) => {
  console.error('[app] error', e.error || e.message);
});

function fillQualitySelects() {
  for (const id of ['#quality-select', '#host-quality-select']) {
    const sel = $(id);
    if (!sel) continue;
    sel.innerHTML = QUALITY_ORDER.map((key) => {
      const p = QUALITY_PROFILES[key];
      return `<option value="${key}">${p.label}</option>`;
    }).join('');
    sel.value = DEFAULT_QUALITY;
  }
}

function boot() {
  initTheme();
  fillQualitySelects();
  initLanding();
  initHostControls();
  initViewerControls();

  const path = location.pathname;
  const m = path.match(/\/join\/([A-HJ-NP-Z2-9]{6})\/?$/i);
  if (m) {
    showView('viewer');
    startViewer(m[1].toUpperCase());
  } else {
    showView('landing');
  }
}

boot();
