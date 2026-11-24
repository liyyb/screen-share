// 观众本地录制：分块缓存、时长/大小上限、封装下载。纯本地不上传。
import { formatDuration } from './stats.js';

const LIMIT_MS = 10 * 60 * 1000;       // 10 分钟
const LIMIT_BYTES = 128 * 1024 * 1024; // 128 MiB

export class LocalRecorder {
  constructor(supported) {
    this.supported = supported;
    this.recorder = null;
    this.chunks = [];
    this.bytes = 0;
    this.startedAt = 0;
    this.mimeType = '';
    this.onTick = null;
    this.onDone = null;
    this.onLimit = null;
    this._timer = null;
    this._blobUrl = null;
  }

  static pickMime() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const m of candidates) {
      if (window.MediaRecorder?.isTypeSupported?.(m)) return m;
    }
    return null;
  }

  start(stream) {
    if (!this.supported) return false;
    const mime = LocalRecorder.pickMime();
    if (!mime) return false;
    this.mimeType = mime;
    this.chunks = [];
    this.bytes = 0;
    try {
      this.recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      return false;
    }
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) {
        this.chunks.push(e.data);
        this.bytes += e.data.size;
      }
    };
    this.recorder.onstop = () => this._finalize();
    this.recorder.start(1000);
    this.startedAt = Date.now();
    this._timer = setInterval(() => {
      const elapsed = Date.now() - this.startedAt;
      this.onTick?.({ elapsed, text: formatDuration(elapsed), bytes: this.bytes });
      if (elapsed >= LIMIT_MS || this.bytes >= LIMIT_BYTES) {
        this.onLimit?.();
        this.stop();
      }
    }, 1000);
    return true;
  }

  stop() {
    if (!this.recorder || this.recorder.state === 'inactive') return;
    clearInterval(this._timer);
    this._timer = null;
    this.recorder.stop();
  }

  _finalize() {
    const blob = new Blob(this.chunks, { type: this.mimeType });
    // 空录制（例如环境对远程流不产出帧）：不生成下载链接
    if (!blob.size) {
      this.chunks = [];
      this.recorder = null;
      this.onDone?.({ empty: true, bytes: 0 });
      return;
    }
    const ext = this.mimeType.includes('webm') ? 'webm' : 'mp4';
    if (this._blobUrl) URL.revokeObjectURL(this._blobUrl);
    this._blobUrl = URL.createObjectURL(blob);
    this.onDone?.({
      url: this._blobUrl,
      filename: `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
      bytes: blob.size,
    });
    this.chunks = [];
    this.recorder = null;
  }

  destroy() {
    clearInterval(this._timer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    if (this._blobUrl) { URL.revokeObjectURL(this._blobUrl); this._blobUrl = null; }
    this.recorder = null;
  }
}
