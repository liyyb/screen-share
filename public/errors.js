// 错误码映射：用户可读文案 + 呈现层级 + 可操作动作。对应产品设计 6.2。

export class ApiError extends Error {
  constructor(code, message, retryable) {
    super(message || code);
    this.code = code;
    this.retryable = Boolean(retryable);
  }
}

const MAP = {
  'E-001': { level: 'block', title: '环境不支持', text: '当前环境无法使用屏幕共享，请用 HTTPS 或 localhost 打开。', action: '知道了' },
  'E-002': { level: 'block', title: '浏览器不支持', text: '当前浏览器不支持共享，请使用 Chrome 或 Edge。', action: '知道了' },
  'E-003': { level: 'block', title: '浏览器过旧', text: '当前浏览器版本过旧，请更新后重试。', action: '知道了' },
  'E-101': { level: 'block', title: '需要共享权限', text: '需要你允许共享屏幕才能继续。请在地址栏点击图标重新允许。', action: '重试共享' },
  'E-102': { level: 'block', title: '没有可共享的窗口', text: '没有找到可以共享的窗口，请先打开一个应用或文档。', action: '重试' },
  'E-103': { level: 'block', title: '共享已停止', text: '共享已停止。', action: '重新开始' },
  'E-201': { level: 'toast', text: '房间码无效或共享已结束，请确认后重试。' },
  'E-202': { level: 'block', title: '房间已满', text: '当前房间已满，请稍后再试。', action: '返回首页' },
  'E-203': { level: 'inline', text: '对方已断开连接。' },
  'E-301': { level: 'block', title: '连接失败', text: '网络连接失败，请检查网络后重试。', action: '重新连接' },
  'E-302': { level: 'inline', text: '当前网络无法直连，已切换到中继模式，延迟可能升高。' },
  'E-303': { level: 'block', title: '无法建立连接', text: '网络受限且未配置中继服务器。请换网络，或让部署者配置 TURN。', action: '重试' },
  'E-400': { level: 'toast', text: '请求参数有误，请重试。' },
  'E-401': { level: 'toast', text: '网络波动，画面可能不流畅。' },
  'E-401A': { level: 'block', title: '会话已失效', text: '会话已失效，请重新开始共享。', action: '返回首页' },
  'E-402': { level: 'toast', text: '画面编码出错，请切换画质重试。' },
  'E-403': { level: 'toast', text: '无权执行此操作。' },
  'E-429': { level: 'toast', text: '操作过于频繁，请稍后再试。' },
  'E-501': { level: 'inline', text: '信令服务暂时不可用，已建立的共享不受影响。' },
  'E-502': { level: 'toast', text: '当前浏览器不支持本地录制。' },
};

export function describe(code, overrideMessage) {
  const base = MAP[code] || { level: 'toast', text: '发生了一个错误，请重试。' };
  return { code, ...base, text: overrideMessage || base.text };
}

export function isFatal(code) {
  return describe(code).level === 'block';
}
