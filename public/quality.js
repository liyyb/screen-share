// 画质档位：首页预选、主机页实时切换、编码参数的唯一数据源。
// 帧率通过采集约束限制；分辨率通过编码缩放对齐到目标，避免浏览器忽略 width/height 约束。

export const QUALITY_PROFILES = {
  lite: {
    key: 'lite', label: '省流 480p15', short: '省流',
    width: 854, height: 480, fps: 15,
    bitrate: 600_000, hint: 'motion', degradation: 'maintain-framerate',
    note: '弱网 / 长时间挂机',
  },
  sd: {
    key: 'sd', label: '流畅 720p30', short: '流畅',
    width: 1280, height: 720, fps: 30,
    bitrate: 2_000_000, hint: 'motion', degradation: 'maintain-framerate',
    note: '普通网页 / 视频',
  },
  hd: {
    key: 'hd', label: '高清 1080p30', short: '高清',
    width: 1920, height: 1080, fps: 30,
    bitrate: 5_000_000, hint: 'detail', degradation: 'maintain-resolution',
    note: '默认 / 文字表格',
  },
  highfps: {
    key: 'highfps', label: '高帧 1080p60', short: '高帧',
    width: 1920, height: 1080, fps: 60,
    bitrate: 8_000_000, hint: 'motion', degradation: 'maintain-framerate',
    note: '滚动 / 动画演示',
  },
  ultra: {
    key: 'ultra', label: '极致 2K60', short: '极致',
    width: 2560, height: 1440, fps: 60,
    bitrate: 12_000_000, hint: 'motion', degradation: 'maintain-framerate',
    note: '有线同网 / 大屏',
  },
};

export const DEFAULT_QUALITY = 'hd';
export const QUALITY_ORDER = ['lite', 'sd', 'hd', 'highfps', 'ultra'];

export function getProfile(key) {
  return QUALITY_PROFILES[key] || QUALITY_PROFILES[DEFAULT_QUALITY];
}

export function formatProfile(key) {
  const p = getProfile(key);
  return `${p.width}×${p.height} · ${p.fps}fps`;
}

// 采集始终请求最高分辨率，档位分辨率全部交给编码缩放实现。
// 如果切档时降低采集分辨率，部分浏览器无法再放大回来，切回高档就永久失真。
const CAPTURE_MAX_WIDTH = 2560;
const CAPTURE_MAX_HEIGHT = 1440;

// 首帧采集：帧率用 ideal + max 卡上限，分辨率给最高 ideal。
export function captureConstraints(key) {
  const p = getProfile(key);
  return {
    frameRate: { ideal: p.fps, max: p.fps },
    width: { ideal: CAPTURE_MAX_WIDTH },
    height: { ideal: CAPTURE_MAX_HEIGHT },
  };
}

// 实时切档只改帧率，绝不改采集分辨率，保证任意档位间来回切换都能恢复。
export function switchConstraints(key) {
  const p = getProfile(key);
  return { frameRate: { ideal: p.fps, max: p.fps } };
}

// 编码缩放：把实际采集画面缩到目标分辨率。源比目标小则不放大。
// 浏览器可能忽略采集时的 width/height ideal，所以缩放比必须按实际轨道尺寸算。
export function scaleFor(track, key) {
  const p = getProfile(key);
  const settings = track?.getSettings?.() || {};
  const w = settings.width || p.width;
  const h = settings.height || p.height;
  const raw = Math.max(w / p.width, h / p.height, 1);
  return Math.round(Math.min(raw, 8) * 100) / 100;
}

// 供编码层使用的完整参数对象
export function encodingProfile(track, key) {
  const p = getProfile(key);
  return { ...p, scale: scaleFor(track, key) };
}
