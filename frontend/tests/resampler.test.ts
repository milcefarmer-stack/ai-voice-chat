import { describe, expect, it } from 'vitest';
import { Resampler } from '../src/resampler';

/** 把 Float32 序列编码成 16bit PCM */
function pcm32(f: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(f.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

describe('Resampler', () => {
  it('同采样率直通', () => {
    const r = new Resampler(16000, 16000);
    const out = r.push(pcm32(new Float32Array([0, 0.5, -0.5, 1])));
    expect(out.length).toBe(4);
    expect(out[1]).toBeCloseTo(0.5, 2); // int16 量化误差之内
  });

  it('上采样总量守恒:任意分块,总输出 ≈ 期望长度', () => {
    const src = new Float32Array(16000); // 1s @16k
    for (let i = 0; i < src.length; i++) src[i] = Math.sin((i / 16000) * 628);
    const chunks = [777, 3, 64000, 1599, 4321, 2999]; // 故意不齐的块边界
    const r = new Resampler(16000, 48000);
    let off = 0;
    let total = 0;
    for (const c of chunks) {
      const slice = src.subarray(off, Math.min(off + c, src.length));
      off += c;
      total += r.push(pcm32(slice)).length;
      if (off >= src.length) break;
    }
    // 线性插值下输出长度应为 48000 左右;末尾少数样本因右端点未到而推迟
    // (真实播放由流结束时的 flush 补齐),允许 ≤4 的截断
    expect(Math.abs(total - 48000)).toBeLessThanOrEqual(4);
  });

  it('跨块相位连续:分块输出拼接 ≈ 整块输出', () => {
    const src = new Float32Array(4800);
    for (let i = 0; i < src.length; i++) src[i] = Math.sin((i / 100) * 2);
    const whole = new Resampler(16000, 44100).push(pcm32(src));
    const r = new Resampler(16000, 44100);
    const parts: Float32Array[] = [];
    for (let off = 0; off < src.length; off += 960) {
      parts.push(r.push(pcm32(src.subarray(off, off + 960))));
    }
    const totalLen = parts.reduce((n, p) => n + p.length, 0);
    expect(totalLen).toBe(whole.length);
    // 每个拼接点附近值连续(允许一个样本的相位差)
    const joined = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) {
      joined.set(p, off);
      off += p.length;
    }
    let maxDiff = 0;
    for (let i = 0; i < Math.min(joined.length, whole.length); i++) {
      maxDiff = Math.max(maxDiff, Math.abs(joined[i] - whole[i]));
    }
    expect(maxDiff).toBeLessThan(0.01);
  });

  it('空块安全', () => {
    const r = new Resampler(24000, 48000);
    expect(r.push(new ArrayBuffer(0)).length).toBe(0);
  });
});
