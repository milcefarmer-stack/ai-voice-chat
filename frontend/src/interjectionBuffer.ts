/**
 * 短插话合并缓冲(纯逻辑):短插话的音频先攒着,
 * 合并窗口内来了下一句就拼在一起送识别;超时没等到就丢弃。
 */

import type { Timers } from './interruption';

export class InterjectionBuffer {
  private chunks: Float32Array[] = [];
  private expireTimer: unknown = null;

  constructor(
    private readonly timers: Pick<Timers, 'setTimeout' | 'clearTimeout'>,
    private readonly timeoutMs: number,
    private readonly onExpire: () => void = () => {},
  ) {}

  /** 是否攒着未合并的插话 */
  get active(): boolean {
    return this.chunks.length > 0;
  }

  add(audio: Float32Array): void {
    this.chunks.push(audio);
    this.restartExpire();
  }

  /** 取走全部缓冲(与后续话语拼接用);取走后停止过期计时 */
  take(): Float32Array | null {
    if (this.chunks.length === 0) return null;
    this.cancelExpire();
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.chunks = [];
    return merged;
  }

  clear(): void {
    this.cancelExpire();
    this.chunks = [];
  }

  private restartExpire(): void {
    this.cancelExpire();
    this.expireTimer = this.timers.setTimeout(() => {
      this.expireTimer = null;
      this.chunks = [];
      this.onExpire();
    }, this.timeoutMs);
  }

  private cancelExpire(): void {
    if (this.expireTimer !== null) {
      this.timers.clearTimeout(this.expireTimer);
      this.expireTimer = null;
    }
  }
}
