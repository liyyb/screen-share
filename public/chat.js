// 聊天室 + 弹幕：一个消息系统两种展示（B 站式弹幕 + 可收起的聊天面板）。
// 主机和观众复用。消息经信令服务 /chat 转发，经 SSE 'chat' 事件到达。
import { toast } from './ui.js';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const MAX_CHAT = 100;        // 消息列表上限
const MAX_DANMAKU = 40;      // 弹幕节点上限，防止后台节流时堆积
const DANMAKU_LANES = 5;     // 弹幕固定轨道数
const DANMAKU_MS = 8000;     // 与 CSS 动画时长一致
const SEND_INTERVAL_MS = 2000; // 与服务端 E-429 限流窗口一致

export class ChatManager {
  constructor(signal) {
    this.signal = signal;
    this.role = signal.role;
    this.chatVisible = true;    // 侧栏消息流常驻显示，可手动收起
    this.danmakuOn = true;
    this._lastSent = 0;
    this._unsub = [];
    this._lane = 0;
    this._seenSeq = new Set();  // 重连后快照与实时事件去重
    this._onResize = null;
  }

  init() {
    // 弹幕容器挂到视频舞台内，而不是覆盖整个视口
    const stage = (this.role === 'host'
      ? document.querySelector('.video-stage')
      : document.querySelector('#viewer-stage')) || document.body;
    this.danmaku = document.createElement('div');
    this.danmaku.id = 'danmaku';
    stage.appendChild(this.danmaku);
    this._syncDanmakuWidth();
    this._onResize = () => this._syncDanmakuWidth();
    window.addEventListener('resize', this._onResize);

    // 聊天侧栏（标题 + 消息流 + 输入框，标题右侧可收起）
    this.panel = document.createElement('div');
    this.panel.id = 'chat-panel';
    this.panel.innerHTML = `
      <div class="chat-head">
        <span class="chat-title">弹幕</span>
        <button class="chat-dm-toggle" title="开关画面弹幕">开</button>
        <button class="chat-toggle" title="收起聊天侧栏" aria-label="收起聊天侧栏">×</button>
      </div>
      <div class="chat-list"></div>
      <div class="chat-input-row">
        <input class="chat-input" placeholder="发个弹幕呗~" maxlength="100">
        <button class="chat-send">发送</button>
      </div>
    `;
    // 挂到当前视图内：桌面端 fixed 抽屉不受影响；手机端观众页可把聊天室排到画面下方，
    // 且离开该视图时聊天面板随之隐藏，不再浮在首页/其他视图上。
    const view = this.role === 'host'
      ? document.querySelector('#view-host')
      : document.querySelector('#view-viewer');
    (view || document.body).appendChild(this.panel);

    this.reopen = document.createElement('button');
    this.reopen.id = 'chat-reopen';
    this.reopen.className = 'chat-reopen';
    this.reopen.title = '展开聊天侧栏';
    this.reopen.setAttribute('aria-label', '展开聊天侧栏');
    this.reopen.textContent = '弹幕';
    (view || document.body).appendChild(this.reopen);

    // 默认状态：桌面端记住用户选择；手机端观众页固定展开（聊天室在画面下方，不是抽屉）
    let hidden = false;
    try {
      const saved = localStorage.getItem('share-chat-hidden');
      hidden = saved === '1';
    } catch { /* 隐私模式下忽略 */ }
    if (this.role === 'viewer' && window.innerWidth <= 640) hidden = false;
    this._setCollapsed(hidden);

    // 事件
    this._unsub.push(this.signal.on('chat', (m) => this._onChat(m)));
    this._unsub.push(this.signal.on('snapshot', (d) => this._onSnapshot(d)));

    const input = this.panel.querySelector('.chat-input');
    const send = this.panel.querySelector('.chat-send');
    const doSend = () => {
      const text = input.value.trim();
      if (!text) return;
      const now = Date.now();
      if (now - this._lastSent < SEND_INTERVAL_MS) {
        toast('发送太频繁，请稍等再发');
        return;
      }
      this._lastSent = now;
      input.value = '';
      this.signal.sendChat(text).catch((e) => {
        input.value = text;
        const code = typeof e?.code === 'string' && e.code.startsWith('E-') ? e.code : null;
        toast(code || '发送失败，请检查网络后重试', code ? e?.message : undefined);
      });
    };
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });

    // 弹幕开关（只开关画面滚动弹幕，不影响侧栏消息流）
    this.panel.querySelector('.chat-dm-toggle').addEventListener('click', (e) => {
      this.danmakuOn = !this.danmakuOn;
      e.currentTarget.classList.toggle('off', !this.danmakuOn);
      e.currentTarget.textContent = this.danmakuOn ? '开' : '关';
    });
    this.panel.querySelector('.chat-toggle').addEventListener('click', () => this._setCollapsed(true));
    this.reopen.addEventListener('click', () => this._setCollapsed(false));
  }

  _setCollapsed(hidden) {
    document.body.classList.toggle('chat-collapsed', Boolean(hidden));
    try { localStorage.setItem('share-chat-hidden', hidden ? '1' : '0'); } catch { /* ignore */ }
  }

  _syncDanmakuWidth() {
    if (!this.danmaku) return;
    const w = this.danmaku.clientWidth || window.innerWidth;
    this.danmaku.style.setProperty('--dm-width', `${w}px`);
  }

  // 服务端消息带 seq；重连快照和事件重放都用同一序号去重
  _record(m) {
    const seq = m?.seq;
    if (seq == null) return true;
    if (this._seenSeq.has(seq)) return false;
    this._seenSeq.add(seq);
    if (this._seenSeq.size > 500) {
      this._seenSeq.delete(this._seenSeq.values().next().value);
    }
    return true;
  }

  _onChat(m) {
    if (!this._record(m)) return;
    if (this.danmakuOn) this._spawnDanmaku(m);
    this._appendChat(m);
  }

  _onSnapshot(d) {
    // 历史只进消息列表，不补放弹幕，避免重连瞬间刷屏
    for (const m of d.chatLog || []) {
      if (!this._record(m)) continue;
      this._appendChat(m);
    }
  }

  _badge(m) {
    return m.role === 'host' ? '<span class="badge-host">主播</span>' : '';
  }

  _spawnDanmaku(m) {
    const el = document.createElement('div');
    el.className = 'danmaku-item';
    el.innerHTML = `${this._badge(m)}<span class="dm-nick">${esc(m.nickname || '观众')}</span>：${esc(m.text)}`;
    this.danmaku.appendChild(el);
    this._lane = (this._lane + 1) % DANMAKU_LANES;
    el.style.top = (8 + this._lane * 16) + '%';

    // 后台标签页会节流 animationend，必须加超时兜底并限制节点数
    const remove = () => { clearTimeout(el._dmTimer); el.remove(); };
    el.addEventListener('animationend', remove, { once: true });
    el._dmTimer = setTimeout(remove, DANMAKU_MS + 1000);
    while (this.danmaku.children.length > MAX_DANMAKU) {
      const old = this.danmaku.firstChild;
      clearTimeout(old._dmTimer);
      old.remove();
    }
  }

  _appendChat(m) {
    const list = this.panel.querySelector('.chat-list');
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="chat-nick">${this._badge(m)}${esc(m.nickname || '观众')}</span><span class="chat-text">${esc(m.text)}</span>`;
    list.appendChild(el);
    while (list.children.length > MAX_CHAT) list.firstChild.remove();
    list.scrollTop = list.scrollHeight;
  }

  destroy() {
    this._unsub.forEach((u) => u());
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this.danmaku?.remove();
    this.panel?.remove();
    this.reopen?.remove();
  }
}
