// UI 组件：Toast、状态条、阻碍层、主题切换、DOM 助手。
import { icons } from './icons.js';
import { describe, ApiError } from './errors.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer = null;
export function toast(codeOrText, overrideText) {
  const info = typeof codeOrText === 'string' && codeOrText.startsWith('E-')
    ? describe(codeOrText, overrideText)
    : { text: codeOrText };
  let box = $('#toast');
  if (!box) {
    box = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.textContent = info.text;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 4000);
}

function inlineBars() {
  return [$('#inline-status'), $('#inline-status-viewer')].filter(Boolean);
}

export function setInlineStatus(codeOrText, tone = 'warn') {
  const text = typeof codeOrText === 'string' && codeOrText.startsWith('E-')
    ? describe(codeOrText).text
    : codeOrText;
  for (const bar of inlineBars()) {
    bar.textContent = text;
    bar.className = `inline-status show ${tone}`;
  }
}

export function clearInlineStatus() {
  for (const bar of inlineBars()) bar.className = 'inline-status';
}

// 按 errors.js 的 level 字段选择呈现层级：inline / toast / block。
export function presentError(codeOrText, { text, tone = 'error', ...blockOpts } = {}) {
  if (typeof codeOrText !== 'string' || !codeOrText.startsWith('E-')) {
    blocking(codeOrText, blockOpts);
    return 'block';
  }
  const info = describe(codeOrText, text);
  if (info.level === 'inline') {
    setInlineStatus(text || codeOrText, tone);
    return 'inline';
  }
  if (info.level === 'toast') {
    toast(codeOrText, text);
    return 'toast';
  }
  blocking(codeOrText, text ? { ...blockOpts, text } : blockOpts);
  return 'block';
}

export function blocking(codeOrText, { title, text, action, onAction, pre = false } = {}) {
  const info = typeof codeOrText === 'string' && codeOrText.startsWith('E-')
    ? describe(codeOrText)
    : { title: '出错了', text: String(codeOrText), action: '知道了' };
  let layer = $('#blocking');
  if (!layer) {
    layer = el('div', { id: 'blocking', class: 'blocking', role: 'alertdialog', 'aria-modal': 'true' });
    document.body.append(layer);
  }
  layer.innerHTML = '';
  const card = el('div', { class: 'blocking-card' }, [
    el('div', { class: 'blocking-icon', html: icons.help() }),
    el('h2', { text: title || info.title || '出错了' }),
    el('p', { text: text || info.text, class: pre ? 'pre' : '' }),
    el('button', {
      class: 'btn primary',
      text: action || info.action || '知道了',
      onclick: () => { closeBlocking(); onAction?.(); },
    }),
  ]);
  layer.append(card);
  layer.classList.add('show');
}

// 统一错误呈现：ApiError 按错误码给用户可读文案；
// 其余异常显示真实原因，不再伪装成"房间码无效"之类的业务错误码。
export function reportError(e, fallback = 'E-501') {
  if (e instanceof ApiError) {
    presentError(e.code, { text: e.message });
    return e.code;
  }
  console.error('[ui] 未预期异常:', e);
  const msg = String(e?.message || e || '未知错误');
  if (e instanceof TypeError || /fetch|network|failed to fetch|load failed/i.test(msg)) {
    presentError(fallback);
    return fallback;
  }
  presentError(`发生异常：${msg}`, {
    title: '出错了',
    action: '刷新重试',
    onAction: () => location.reload(),
  });
  return null;
}

export function closeBlocking() {
  const layer = $('#blocking');
  if (layer) { layer.classList.remove('show'); layer.innerHTML = ''; }
}

export function initTheme() {
  const saved = localStorage.getItem('ss-theme');
  if (saved === 'dark') document.documentElement.classList.add('dark');
  const btn = $('#theme-toggle');
  if (!btn) return;
  btn.innerHTML = document.documentElement.classList.contains('dark') ? icons.sun() : icons.moon();
  btn.addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('ss-theme', dark ? 'dark' : 'light');
    btn.innerHTML = dark ? icons.sun() : icons.moon();
  });
}

export function copyText(text) {
  // 同步兜底：局域网 HTTP 下没有 navigator.clipboard，或权限弹窗被浏览器直接吞掉时仍可复制。
  const legacy = () => new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); resolve(); }
    catch (e) { reject(e); }
    finally { ta.remove(); }
  });
  if (navigator.clipboard?.writeText) {
    // 部分 WebView 里 writeText 既不 resolve 也不 reject，必须超时后降级，否则按钮永远没反馈。
    return Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 800)),
    ]).catch(legacy);
  }
  return legacy();
}

export function maskUrl(url) {
  // 诊断信息不记录完整邀请链接，仅保留域名
  try { const u = new URL(url); return u.origin; } catch { return '(invalid)'; }
}
