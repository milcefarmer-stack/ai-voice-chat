import { describe, expect, it } from 'vitest';
import { InterruptionStateMachine, type Timers } from '../src/interruption';

/** 可手动推时钟的假 timer */
function fakeTimers() {
  const pending: Array<{ fn: () => void; at: number; id: number }> = [];
  let now = 0;
  let nextId = 1;
  const timers: Timers & { advance(ms: number): void } = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimeout(id) {
      const i = pending.findIndex((p) => p.id === id);
      if (i >= 0) pending.splice(i, 1);
    },
    advance(ms) {
      now += ms;
      for (const p of [...pending].sort((a, b) => a.at - b.at)) {
        if (p.at <= now) {
          pending.splice(pending.indexOf(p), 1);
          p.fn();
        }
      }
    },
  };
  return timers;
}

function makeMachine(sustainMs = 500) {
  const effects = {
    pauses: 0,
    resumes: 0,
    interrupts: 0,
    pauseBotAudio() {
      this.pauses++;
    },
    resumeBotAudio() {
      this.resumes++;
    },
    beginInterrupt() {
      this.interrupts++;
    },
  };
  const timers = fakeTimers();
  const machine = new InterruptionStateMachine(effects, timers, sustainMs);
  return { machine, effects, timers };
}

describe('InterruptionStateMachine', () => {
  it('AI 未播报时确认语音:不打断、不暂停', () => {
    const { machine, effects } = makeMachine();
    machine.speechConfirmed(false);
    expect(machine.state).toBe('idle');
    expect(effects.pauses).toBe(0);
    machine.speechEnded();
    expect(effects.resumes).toBe(0);
  });

  it('AI 播报中确认语音:先暂停;持续超阈值升级为打断', () => {
    const { machine, effects, timers } = makeMachine(500);
    machine.speechConfirmed(true);
    expect(machine.state).toBe('paused');
    expect(effects.pauses).toBe(1);
    expect(effects.interrupts).toBe(0);
    timers.advance(400);
    expect(effects.interrupts).toBe(0); // 仍未到持续阈值
    timers.advance(150);
    expect(effects.interrupts).toBe(1); // 550ms ≥ 500ms → 打断
    expect(machine.state).toBe('interrupted');
  });

  it('短插话:阈值内结束 → 恢复 AI 播放,判为插话', () => {
    const { machine, effects, timers } = makeMachine(500);
    machine.speechConfirmed(true);
    timers.advance(200);
    const decision = machine.speechEnded();
    expect(decision).toEqual({ kind: 'interjection' });
    expect(effects.resumes).toBe(1); // AI 从暂停点继续
    expect(effects.interrupts).toBe(0);
    expect(machine.state).toBe('idle');
  });

  it('插话后语音继续到阈值 → 打断;该段结束按正常话轮送识别', () => {
    const { machine, effects, timers } = makeMachine(500);
    machine.speechConfirmed(true);
    timers.advance(600);
    expect(machine.state).toBe('interrupted');
    expect(machine.speechEnded()).toEqual({ kind: 'deliver' });
    expect(machine.state).toBe('idle');
    expect(effects.resumes).toBe(0); // 打断后绝不恢复旧音频
  });

  it('打断计时器在语音提前结束时被取消,不会迟到的打断', () => {
    const { machine, effects, timers } = makeMachine(500);
    machine.speechConfirmed(true);
    machine.speechEnded(); // 50ms 结束
    timers.advance(2000);
    expect(effects.interrupts).toBe(0);
  });

  it('reset 清掉计时器与状态,不触发音频效果', () => {
    const { machine, effects, timers } = makeMachine();
    machine.speechConfirmed(true);
    machine.reset();
    timers.advance(2000);
    expect(machine.state).toBe('idle');
    expect(effects.interrupts).toBe(0);
    expect(effects.resumes).toBe(0);
  });

  it('连续两次插话互不干扰', () => {
    const { machine, effects, timers } = makeMachine(500);
    machine.speechConfirmed(true);
    expect(machine.speechEnded()).toEqual({ kind: 'interjection' });
    machine.speechConfirmed(true);
    timers.advance(600);
    expect(effects.interrupts).toBe(1);
    expect(effects.pauses).toBe(2);
  });
});
