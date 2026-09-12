/**
 * 智能打断状态机(纯逻辑,无 DOM/音频依赖,可单测)
 *
 * 解决"打断漏字"的核心策略:
 *  - AI 播报中确认了真实语音(vad-web onSpeechRealStart)→ 立刻"暂停"AI 音频,
 *    把人机声音重叠窗口压到最小;此时还不是"打断",只是暂停。
 *  - 若语音持续超过 sustainMs → 升级为打断:停掉后续播报(只显示不播),
 *    通知服务端停止合成;AI 思考继续,新话语进 FIFO 队列。
 *  - 若语音在 sustainMs 内结束 → 属于短插话("嗯""等下"):恢复 AI 播放,
 *    该段音频交给合并缓冲,与下一句一起识别。
 *  - 用户语音开头永不裁剪(裁剪=丢字),重叠残音靠"尽早暂停"+浏览器 AEC 压制。
 */

export interface InterruptionEffects {
  pauseBotAudio(): void;
  resumeBotAudio(): void;
  beginInterrupt(): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export type SpeechEndDecision =
  | { kind: 'deliver' } // 正常送识别(未受影响的话轮 / 打断后的新话轮)
  | { kind: 'interjection' }; // 短插话:交合并缓冲,不打断

export type InterruptState = 'idle' | 'paused' | 'interrupted';

export class InterruptionStateMachine {
  state: InterruptState = 'idle';

  private sustainTimer: unknown = null;

  constructor(
    private readonly effects: InterruptionEffects,
    private readonly timers: Timers,
    private readonly sustainMs: number,
  ) {}

  /** vad-web onSpeechRealStart:语音确认真实、持续。botSpeaking=当时 AI 是否在播报 */
  speechConfirmed(botSpeaking: boolean): void {
    this.cancelSustain();
    if (!botSpeaking) {
      this.state = 'idle'; // 正常话轮,无需打断语义
      return;
    }
    this.effects.pauseBotAudio();
    this.state = 'paused';
    this.sustainTimer = this.timers.setTimeout(() => this.speechSustained(), this.sustainMs);
  }

  /** 持续计时器到点:短插话升级为真打断 */
  speechSustained(): void {
    this.cancelSustain();
    if (this.state !== 'paused') return;
    this.effects.beginInterrupt();
    this.state = 'interrupted';
  }

  /** vad-web onSpeechEnd:一段语音结束 */
  speechEnded(): SpeechEndDecision {
    this.cancelSustain();
    switch (this.state) {
      case 'paused':
        // 短插话:恢复 AI 播放(从暂停点继续,无跳变),音频交合并缓冲
        this.effects.resumeBotAudio();
        this.state = 'idle';
        return { kind: 'interjection' };
      case 'interrupted':
        // 打断后的完整话语:正常送识别(后续由 FIFO 队列调度)
        this.state = 'idle';
        return { kind: 'deliver' };
      default:
        return { kind: 'deliver' };
    }
  }

  /** 新对话 / 暂停聆听 / 页面隐藏:全部复位,不触发任何音频效果 */
  reset(): void {
    this.cancelSustain();
    this.state = 'idle';
  }

  private cancelSustain(): void {
    if (this.sustainTimer !== null) {
      this.timers.clearTimeout(this.sustainTimer);
      this.sustainTimer = null;
    }
  }
}
