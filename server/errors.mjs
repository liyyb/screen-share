// 统一错误码。对应产品设计第 6.2 节与开发方案第 5 节。

const DEFS = {
  'E-001': { status: 400, message: '当前环境无法使用屏幕共享，请用 HTTPS 或 localhost 打开', retryable: false },
  'E-002': { status: 400, message: '当前浏览器不支持共享，请使用 Chrome / Edge', retryable: false },
  'E-003': { status: 400, message: '当前浏览器过旧，请更新后重试', retryable: false },
  'E-101': { status: 400, message: '需要你允许共享屏幕才能继续', retryable: true },
  'E-102': { status: 400, message: '没有找到可以共享的窗口', retryable: true },
  'E-103': { status: 400, message: '共享已停止', retryable: true },
  'E-201': { status: 404, message: '房间码无效或共享已结束', retryable: false },
  'E-202': { status: 409, message: '当前房间已满', retryable: false },
  'E-203': { status: 404, message: '对方已断开连接', retryable: true },
  'E-301': { status: 503, message: '网络连接失败，请检查网络后重试', retryable: true },
  'E-302': { status: 200, message: '已切换到中继模式，延迟可能升高', retryable: false },
  'E-303': { status: 503, message: '网络受限且未配置中继服务器，无法建立连接', retryable: false },
  'E-401': { status: 200, message: '网络波动，画面可能不流畅', retryable: false },
  'E-402': { status: 400, message: '画面编码出错，请切换画质重试', retryable: true },
  'E-400': { status: 400, message: '请求参数无效', retryable: false },
  'E-401A': { status: 401, message: '会话已失效，请重新开始', retryable: true },
  'E-403': { status: 403, message: '无权执行此操作', retryable: false },
  'E-429': { status: 429, message: '操作过于频繁，请稍后再试', retryable: true },
  'E-501': { status: 503, message: '信令服务暂时不可用', retryable: true },
  'E-502': { status: 400, message: '本地录制不可用', retryable: false },
};

export class ApiError extends Error {
  constructor(code, override, extra = {}) {
    super(override || DEFS[code]?.message || '请求失败');
    this.code = code;
    this.status = DEFS[code]?.status ?? 400;
    this.retryable = DEFS[code]?.retryable ?? false;
    this.extra = extra;
  }
  toJSON(requestId) {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      requestId: requestId || null,
      ...this.extra,
    };
  }
}

export function fail(code, override, extra) {
  throw new ApiError(code, override, extra);
}
