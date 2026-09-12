"""SentenceTTSSpeaker 打桩测试:按真实日志还原的帧序列驱动合成器,验证音频完整性。

背景:浏览器实测出现"回答后半段不播报"。日志显示打断广播发生在 LLM run 开始后
几毫秒,且存在旧回答的 LLMFullResponseEndFrame 与新回答的 StartFrame 交错的可能。
本测试用假 TTS(记录每次 speak 调用)逐帧驱动,验证任何时序下音频不丢。
"""

import asyncio

import pytest
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.processors.frame_processor import FrameProcessor

from voice_chat.pipeline import SentenceTTSSpeaker


class FakeTTS:
    """打桩 TTS:记录 speak 的文本,逐块返回可识别的音频。"""

    def __init__(self) -> None:
        self.spoken: list[str] = []
        self.sample_rate = 22050

    async def speak(self, text: str):
        self.spoken.append(text)
        for i in range(3):  # 每句 3 块
            await asyncio.sleep(0)
            yield f"audio[{text}#{i}]".encode()


class Collector(FrameProcessor):
    """收集下游所有帧,模拟 transport.output。"""

    def __init__(self) -> None:
        super().__init__()
        self.frames: list[Frame] = []

    async def process_frame(self, frame: Frame, direction) -> None:
        await super().process_frame(frame, direction)
        self.frames.append(frame)


def make_speaker():
    tts = FakeTTS()
    cancel = asyncio.Event()
    speaker = SentenceTTSSpeaker(tts, cancel=cancel)
    collector = Collector()
    return tts, cancel, speaker, collector


async def feed(speaker, collector, frames):
    """模拟 pipecat 帧泵:逐帧流经 speaker → collector。"""
    for f in frames:
        await speaker.process_frame(f, None)
        # speaker push_frame 的下游帧进入 collector(简化:直接捕获其下游输出)
        await collector.process_frame(f, None) if False else None


async def run_speaker_collecting(speaker, collector, frames):
    """把 speaker 的下游输出接到 collector:用 push_frame 的旁路观察。

    简化做法:临时替换 speaker.push_frame,把下游帧同时喂给 collector。
    """
    original_push = speaker.push_frame

    async def push(frame, direction=None):
        collector.frames.append(frame)
        await original_push(frame, direction)

    speaker.push_frame = push  # type: ignore[method-assign]
    for f in frames:
        await speaker.process_frame(f, None)
        await asyncio.sleep(0)  # 每帧之间让 worker 跑一步(真实管线中合成随帧流进行)
    await speaker.wait_idle()  # 等队列清空再断言
    await asyncio.sleep(0)


def audio_texts(collector) -> list[str]:
    return [
        f.audio.decode()
        for f in collector.frames
        if isinstance(f, OutputAudioRawFrame) and any(f.audio)  # 排除结尾静音填充
    ]


def messages(collector) -> list[dict]:
    return [f.message for f in collector.frames if isinstance(f, OutputTransportMessageUrgentFrame)]


@pytest.mark.asyncio
async def test_full_answer_after_interruption_plays_completely():
    """日志还原时序:话轮开始打断 → 新回答流式 → 结束。全部句子必须出声。"""
    tts, cancel, speaker, collector = make_speaker()
    frames = [
        InterruptionFrame(),  # 话轮开始时的打断广播
        LLMFullResponseStartFrame(),
        LLMTextFrame(text="好呀，"),
        LLMTextFrame(text="很高兴你想跟我聊天啦。"),
        LLMTextFrame(text="今天过得怎么样，"),
        LLMTextFrame(text="有没有发生什么有趣的事呀？"),
        LLMFullResponseEndFrame(),
    ]
    await run_speaker_collecting(speaker, collector, frames)

    # 每个完整句子单独合成(≥4 字立即出声);"今天过得怎么样，有没有…"在结束帧补合成
    assert tts.spoken == [
        "好呀，",
        "很高兴你想跟我聊天啦。",
        "今天过得怎么样，有没有发生什么有趣的事呀？",
    ]
    audios = audio_texts(collector)
    assert len(audios) == 9  # 3 句 × 3 块
    msgs = messages(collector)
    assert {"type": "bot_end"} in msgs


@pytest.mark.asyncio
async def test_interrupt_midstream_keeps_spoken_part_and_mutes_remainder():
    """播报中被打断:已合成句子照旧,剩余只显示;新回答恢复播报。"""
    tts, cancel, speaker, collector = make_speaker()
    frames = [
        LLMFullResponseStartFrame(),
        LLMTextFrame(text="第一句话。"),
        LLMTextFrame(text="第二句话还没有"),
        InterruptionFrame(),  # 用户插话
        LLMTextFrame(text="说完就被打断了。"),  # 旧回答剩余文本(只显示)
        LLMFullResponseEndFrame(),  # 旧回答结束
        LLMFullResponseStartFrame(),  # 新一轮回答
        LLMTextFrame(text="新的回答。"),
        LLMFullResponseEndFrame(),
    ]
    await run_speaker_collecting(speaker, collector, frames)

    # 已播:"第一句话。";打断后 "第二句话还没有" 未成句,随队列清空丢弃
    assert tts.spoken == ["第一句话。", "新的回答。"]
    audios = audio_texts(collector)
    # 首句被中途截停(1 块)+ 新回答 3 块 —— 截停正是抢断语义
    assert len(audios) == 4
    assert audios[0] == "audio[第一句话。#0]"
    # bot_end 出现两次(旧/新回答各一次)
    msgs = messages(collector)
    assert msgs.count({"type": "bot_end"}) == 2


@pytest.mark.asyncio
async def test_interrupt_arrives_while_speaking_first_sentence():
    """打断帧在首句合成期间到达(pipecat 中 process_frame 阻塞时帧排队):
    当前句播完,后续全静音,直到新回答 StartFrame 恢复。"""
    tts, cancel, speaker, collector = make_speaker()
    frames = [
        LLMFullResponseStartFrame(),
        LLMTextFrame(text="第一句话。"),  # 合成期间"排队"了打断
        InterruptionFrame(),
        LLMTextFrame(text="第二句话。"),
        LLMFullResponseEndFrame(),
        LLMFullResponseStartFrame(),
        LLMTextFrame(text="新回答。"),
        LLMFullResponseEndFrame(),
    ]
    await run_speaker_collecting(speaker, collector, frames)

    assert tts.spoken == ["第一句话。", "新回答。"]


@pytest.mark.asyncio
async def test_short_tail_spoken_at_end():
    """结尾短句(<4 字)在回答结束帧时补合成,不丢。"""
    tts, cancel, speaker, collector = make_speaker()
    frames = [
        LLMFullResponseStartFrame(),
        LLMTextFrame(text="今天聊得开心。"),
        LLMTextFrame(text="嗯。"),  # 短句,攒着
        LLMFullResponseEndFrame(),
    ]
    await run_speaker_collecting(speaker, collector, frames)
    # 回归:结尾短句(清洗后 <4 字)必须随结束帧补合成,不得丢弃
    assert tts.spoken[-1].endswith("嗯。")
    assert "今天聊得开心" in tts.spoken[0]
