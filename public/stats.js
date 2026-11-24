// 延迟监控与丢包判定：三个有效采样窗口持续 >5% 视为波动。
export class StatsMonitor {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.lossWindows = [];
    this.agg = { rtt: null, mode: 'unknown', fps: null, bitrate: null, loss: null };
  }

  sample({ rtt, mode, fps, bitrate, loss, codec, width, height }) {
    this.agg = { rtt, mode, fps, bitrate, loss, codec, width, height };
    if (typeof loss === 'number') {
      this.lossWindows.push(loss > 0.05);
      if (this.lossWindows.length > 3) this.lossWindows.shift();
    }
    this.onUpdate?.(this.snapshot());
  }

  get unstable() {
    return this.lossWindows.length === 3 && this.lossWindows.every(Boolean);
  }

  snapshot() {
    return {
      ...this.agg,
      modeText: { relay: '中继', direct: '直连' }[this.agg.mode] ?? '检测中',
      unstable: this.unstable,
      rttText: this.agg.rtt == null ? '—' : `${this.agg.rtt}ms`,
      fpsText: this.agg.fps == null ? '—' : `${Math.round(this.agg.fps)}fps`,
      bitrateText: this.agg.bitrate == null ? '—' : `${this.agg.bitrate}kbps`,
    };
  }
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
