/**
 * 下行音频播放器:服务端 PCM 块 → 重采样 → Web Audio 排程播放。
 * - 流式:攒够一个小块(~0.25s)就排程,首音频延迟低,且重采样相位跨块连续(无 click)
 * - 打断三态:pause(暂停,短插话后可恢复)/ resume(继续)/ discard(彻底丢弃)
 */

import { Resampler } from './resampler';

const FLUSH_BYTES = 16000; // 约 0.25s @16bit(实际随采样率换算)
const START_MARGIN = 0.02; // 排程提前量,防 currentTime 追上
const IDLE_FLUSH_MS = 150; // 音频流空闲此时长即冲刷缓冲(修"结尾不播报")

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private resampler: Resampler | null = null;
  private pending: ArrayBuffer[] = [];
  private pendingBytes = 0;
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    return this.ctx;
  }

  /** 首次播放可能需要用户手势解锁 */
  async unlock(): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  }

  get suspended(): boolean {
    return this.ctx?.state === 'suspended';
  }

  /** 是否还有正在播放或待播放的音频(用于"AI 正在播报"判断) */
  get active(): boolean {
    return this.sources.size > 0 || this.pendingBytes > 0;
  }

  /** 送入一段 16bit 小端 PCM */
  feed(pcm: ArrayBuffer, srcRate: number): void {
    const ctx = this.ensureCtx();
    if (!this.resampler || this.resampler.srcRate !== srcRate) {
      this.resampler = new Resampler(srcRate, ctx.sampleRate);
      this.pending = [];
      this.pendingBytes = 0;
    }
    this.pending.push(pcm);
    this.pendingBytes += pcm.byteLength;
    this.scheduleIdleFlush();
    // 采样率越高,同样字节数越短,按"至少 ~0.25s"的量来攒
    if (this.pendingBytes >= Math.max(FLUSH_BYTES, Math.ceil((srcRate * 0.25) / 2) * 2)) {
      this.flush();
    }
  }

  /** 音频流短暂停顿时(句间/结尾)把不满阈值的部分也冲刷出去,避免结尾被吞 */
  private scheduleIdleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, IDLE_FLUSH_MS);
  }

  /** 把攒住的块合并重采样后排程 */
  private flush(): void {
    if (!this.pending.length || !this.resampler || !this.ctx) return;
    const ctx = this.ctx;
    const merged = new Uint8Array(this.pendingBytes);
    let off = 0;
    for (const c of this.pending) {
      merged.set(new Uint8Array(c), off);
      off += c.byteLength;
    }
    this.pending = [];
    this.pendingBytes = 0;

    const samples = this.resampler.push(merged.buffer);
    if (samples.length === 0) return;
    const buf = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + START_MARGIN, this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** 暂停播放(短插话):AudioContext 挂起,已排程的音频原地冻结,可无缝恢复 */
  pause(): void {
    if (!this.ctx) return;
    this.flush(); // 先把攒住的排上,避免恢复时"断一截"
    void this.ctx.suspend().catch(() => {});
  }

  /** 恢复播放(短插话结束) */
  resume(): void {
    if (!this.ctx) return;
    void this.ctx.resume().catch(() => {});
  }

  /** 彻底丢弃(打断):清排程、清缓冲、重置时间线 */
  discard(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* 已结束的源忽略 */
      }
    }
    this.sources.clear();
    this.pending = [];
    this.pendingBytes = 0;
    if (this.ctx) {
      void this.ctx.resume().catch(() => {}); // 若在暂停状态被打断,恢复时钟
      this.nextStart = 0;
    }
  }
}
