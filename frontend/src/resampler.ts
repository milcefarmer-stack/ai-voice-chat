/**
 * 流式重采样器(纯逻辑):把任意分块的 16bit PCM 从源采样率线性重采样到目标采样率。
 * 维护跨块的绝对相位与上一块末样本,块边界不丢样本、不重复 —— 修旧版
 * "逐块独立重采样产生块边界 click(机关枪声)"的问题,从而可以边收边播。
 */
export class Resampler {
  private nextPos = 0; // 下一个输出样本对应的输入流绝对位置(样本为单位)
  private consumed = 0; // 已收到的输入样本总数
  private prevLast = 0; // 输入流 consumed-1 号样本的值(跨块插值左端点)
  private readonly step: number;

  constructor(
    readonly srcRate: number,
    readonly dstRate: number,
  ) {
    this.step = srcRate / dstRate;
  }

  /** 输入一段 16bit 小端 PCM,返回重采样后的 Float32(-1..1) */
  push(pcm: ArrayBuffer): Float32Array {
    const n = pcm.byteLength >> 1;
    const view = new DataView(pcm);
    if (n === 0) return new Float32Array(0);

    if (this.srcRate === this.dstRate) {
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
      this.prevLast = out[n - 1];
      this.consumed += n;
      this.nextPos += n;
      return out;
    }

    const out: number[] = [];
    while (true) {
      const i0 = Math.floor(this.nextPos);
      const i1 = i0 + 1;
      if (i1 > this.consumed + n - 1) break; // 右端点还没收到
      const frac = this.nextPos - i0;
      const a = i0 < this.consumed ? this.prevLast : view.getInt16((i0 - this.consumed) * 2, true) / 32768;
      const b = view.getInt16((i1 - this.consumed) * 2, true) / 32768;
      out.push(a + (b - a) * frac);
      this.nextPos += this.step;
    }
    this.prevLast = view.getInt16((n - 1) * 2, true) / 32768;
    this.consumed += n;
    return Float32Array.from(out);
  }
}
