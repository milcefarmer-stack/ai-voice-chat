"""pipecat 管线组装:客户端消息路由 + 整句识别 + 逐句合成。

管线顺序(在官方 quickstart 基础上插入本项目自有处理器):
  transport.input → ClientMessageRouter → UtteranceSTTService → user_aggregator
    → LLM → BotTextRelay → SentenceTTSSpeaker → transport.output → assistant_aggregator

话轮模型(决策见规格书 §2/§4.2):
- VAD 留在浏览器:浏览器切好"完整话语"再上行;服务端不跑 VAD,话轮边界由
  ExternalUserTurnStart/StopStrategy 依据"提议帧"驱动;打字话轮同理;
- 打断:客户端发 interrupt → 广播 InterruptionFrame → 合成器立即静音并终止
  当前合成(剩余文字只显示不播报);LLM 流式继续(思考继续);
- 新话语到达 → 提议新话轮 → 立即回答最新话语(取消过期思考);
- 逐句切分规则与旧版一致:句末标点切句,首句逗号加速,短句攒批防 TTS 乱读。
"""

from __future__ import annotations

import asyncio
import re

from loguru import logger
from pipecat.frames.frames import (
    ErrorFrame,
    Frame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    OutputTransportMessageUrgentFrame,
    ProposedUserStartedSpeakingFrame,
    ProposedUserStoppedSpeakingFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.base_transport import BaseTransport
from pipecat.turns.user_start import ExternalUserTurnStartStrategy
from pipecat.turns.user_stop import ExternalUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .serializers import ClientInterruptFrame, ClientTextFrame, ClientUtteranceFrame
from .services import create_stt_service, create_tts_service
from .settings import Settings


def client_message(type_: str, **fields) -> OutputTransportMessageUrgentFrame:
    """构造发往浏览器的紧急 JSON 消息帧。

    必须用 Urgent 帧:普通消息帧会排进音频节流队列,长回答时文字被
    音频播放节奏卡住几十秒,且打断清队列时一并丢失。
    """
    return OutputTransportMessageUrgentFrame(message={"type": type_, **fields})


class ClientMessageRouter(FrameProcessor):
    """客户端消息语义:打断信号转广播,打字消息转话轮提议,其余透传。"""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, ClientInterruptFrame):
            logger.info("[router] 客户端打断信号(智能打断触发)")
            await self.broadcast_interruption()
            return

        if isinstance(frame, ClientTextFrame):
            await self.push_frame(client_message("user_text", content=frame.content))
            await self.push_frame(ProposedUserStartedSpeakingFrame())
            await self.push_frame(TranscriptionFrame(frame.content, "user", ""))
            await self.push_frame(ProposedUserStoppedSpeakingFrame())
            return

        await self.push_frame(frame, direction)


class UtteranceSTTService(FrameProcessor):
    """整句识别:一段完整语音 → 识别文本 → 提议一个用户话轮。

    识别为空(静音/噪音)不发话轮提议,只发提示;避免空话轮触发 LLM。
    """

    def __init__(self, stt, **kwargs) -> None:
        super().__init__(**kwargs)
        self._stt = stt  # 提供 async transcribe(pcm: bytes, sample_rate: int) -> str

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if not isinstance(frame, ClientUtteranceFrame):
            await self.push_frame(frame, direction)
            return

        try:
            text = await self._stt.transcribe(frame.audio, frame.sample_rate)
        except Exception as e:  # noqa: BLE001 — 识别失败不挂管线,提示后继续
            await self.push_frame(client_message("notice", message=f"识别失败:{e}"))
            return

        if not text:
            await self.push_frame(client_message("notice", message="没听清,请再说一次。"))
            return

        await self.push_frame(client_message("user_text", content=text))
        await self.push_frame(ProposedUserStartedSpeakingFrame())
        await self.push_frame(TranscriptionFrame(text, "user", ""))
        await self.push_frame(ProposedUserStoppedSpeakingFrame())


class BotTextRelay(FrameProcessor):
    """复制 LLM 增量文本为 BotTextChunkFrame(供客户端显示),原帧继续向下游送合成。"""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMTextFrame) and frame.text:
            await self.push_frame(client_message("bot_text", content=frame.text))

        await self.push_frame(frame, direction)


# ---------- 逐句切分(与旧版 splitSentences 行为一致) ----------

_SENTENCE_END = re.compile(r"^[\s\S]*?[。！？；!?;…]")
_FIRST_COMMA = re.compile(r"^[^，,]*[，,]")
_COMMA = re.compile(r"[，、,]")

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF"
    "\u2300-\u23FF\u25A0-\u25FF\uFE0F\u200D]"
)
_DECOR_RE = re.compile("[～·•°★☆✨♪♫►◄→←↑↓①②③④⑤⑥⑦⑧⑨⑩]")


def clean_for_tts(text: str) -> str:
    """入合成前清洗:去 URL/Markdown/表情/装饰符号(与旧版 cleanForTTS 一致)。"""
    text = re.sub(r"https?://\S+", " ", text)
    text = re.sub(r"[`*_#>|~]", " ", text)
    text = _EMOJI_RE.sub(" ", text)
    text = _DECOR_RE.sub(" ", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([，。！？；：、,.!?;:])", r"\1", text)
    return text.strip()


def split_sentences(buf: str, *, aggressive: bool = False) -> tuple[list[str], str]:
    """按句末标点切句;aggressive(首句加速)遇逗号即切;超长句逗号兜底。"""
    m = _SENTENCE_END.match(buf)
    if m:
        seg = m.group(0).strip()
        return ([seg] if seg else []), buf[m.end():]
    if aggressive:
        cm = _FIRST_COMMA.match(buf)
        if cm and len(clean_for_tts(cm.group(0))) >= 2:
            seg = cm.group(0).strip()
            return ([seg] if seg else []), buf[cm.end():]
    if len(buf) >= 40:
        comma = _COMMA.search(buf)
        if comma and comma.start() > 0:
            seg = buf[: comma.end()].strip()
            return ([seg] if seg else []), buf[comma.end():]
        seg = buf.strip()
        return ([seg] if seg else []), ""
    return [], buf


class SentenceTTSSpeaker(FrameProcessor):
    """逐句合成器:聚合 LLM 文本、切句、串行合成。

    process_frame 永不阻塞:文本/结束帧只是入内部队列,唯一的工作协程按
    先到先合成的顺序处理。这消除了一个实测死锁:LLMFullResponseEndFrame
    走 ControlFrame 优先通道,会在上一句仍在合成时并发进入,与音频推送
    互相等待导致整条管线冻死。

    打断语义:InterruptionFrame → 静音 + 取消当前合成 + 清空内部队列
    (LLM 剩余文本只显示不播报);LLMFullResponseStartFrame → 恢复播报。
    """

    # 短句攒批阈值:清洗后不足 4 字先攒着,防 TTS 对短输入乱读
    MIN_SPEAK_CHARS = 4
    # 结尾静音填充时长:把传输层不满一块的音频尾部顶出来播放
    TAIL_SILENCE_SECS = 0.3

    def __init__(self, tts, *, cancel: asyncio.Event, **kwargs) -> None:
        super().__init__(**kwargs)
        self._tts = tts  # 提供 sample_rate 与 async speak(text) -> 块迭代器
        self._cancel = cancel
        self._buf = ""
        self._short = ""
        self._first_done = False
        self._muted = False
        self._queue: asyncio.Queue = asyncio.Queue()
        self._worker: asyncio.Task | None = None

    # ---------- 帧处理(快速路径,只入队) ----------

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, InterruptionFrame):
            logger.info("[speaker] 收到打断:终止合成并静音,剩余文本只显示")
            self._muted = True
            self._cancel.set()
            self._buf = ""
            self._short = ""
            self._drain_queue()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMFullResponseStartFrame):
            # 新一轮 LLM 回答开始:恢复播报、清掉打断取消标志
            self._muted = False
            self._cancel.clear()
            self._first_done = False
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMTextFrame):
            self._ensure_worker()
            self._buf += frame.text
            self._enqueue_sentences()
            return  # 消费:LLMTextFrame 不再下传

        if isinstance(frame, LLMFullResponseEndFrame):
            self._ensure_worker()
            await self._queue.put(("end", ""))
            await self.push_frame(frame, direction)  # 助手聚合器提交本轮回答
            return

        await self.push_frame(frame, direction)

    # ---------- 工作协程(唯一做合成的地方) ----------

    def _ensure_worker(self) -> None:
        if self._worker is not None and not self._worker.done():
            return
        coro = self._worker_loop()
        try:
            self._worker = self.create_task(coro)  # pipecat 托管生命周期
        except Exception:  # noqa: BLE001 — 测试环境无 pipecat 任务管理器
            self._worker = asyncio.get_running_loop().create_task(coro)

    def _drain_queue(self) -> None:
        while not self._queue.empty():
            self._queue.get_nowait()
            self._queue.task_done()

    def _enqueue_sentences(self) -> None:
        if self._muted or self._cancel.is_set():
            return  # 静音期间:文本已在 _buf,恢复播报时由收尾统一处理
        while True:
            first = not self._first_done
            sentences, rest = split_sentences(self._buf, aggressive=first)
            if not sentences:
                return
            self._buf = rest
            for sentence in sentences:
                self._first_done = True
                if first:
                    self._queue.put_nowait(("speak", sentence))  # 首句立即合成
                else:
                    self._short += sentence
                    if len(clean_for_tts(self._short)) >= self.MIN_SPEAK_CHARS:
                        self._queue.put_nowait(("speak", self._short))
                        self._short = ""

    async def _worker_loop(self) -> None:
        while True:
            kind, text = await self._queue.get()
            try:
                if kind == "speak":
                    await self._speak(text)
                elif kind == "end":
                    await self._finish_answer()
            finally:
                self._queue.task_done()

    async def _finish_answer(self) -> None:
        # 冲刷所有残余:_short(不足 4 字的攒批短句)+ _buf(无标点尾段)
        tail, self._buf, self._short = self._short + self._buf, "", ""
        self._first_done = False
        interrupted = self._muted or self._cancel.is_set()
        if tail.strip() and not interrupted:
            await self._speak(tail)
        # 客户端收尾显示(被打断的回答也发,客户端据此结束气泡)
        await self.push_frame(client_message("bot_end"))
        if not interrupted:
            # 静音填充:把传输层不满一块的音频尾部顶出来播放
            pad = int(self.TAIL_SILENCE_SECS * self._tts.sample_rate) * 2
            await self.push_frame(
                OutputAudioRawFrame(
                    audio=bytes(pad),  # 全零即静音
                    sample_rate=self._tts.sample_rate,
                    num_channels=1,
                )
            )

    async def _speak(self, text: str) -> None:
        cleaned = clean_for_tts(text)
        if not cleaned:
            return
        logger.debug(f"[speaker] 合成: {cleaned!r}")
        try:
            async for chunk in self._tts.speak(cleaned):
                if self._muted or self._cancel.is_set():
                    return  # 中途被打断:剩余音频丢弃,文字仍在客户端显示
                await self.push_frame(
                    OutputAudioRawFrame(
                        audio=chunk, sample_rate=self._tts.sample_rate, num_channels=1
                    )
                )
        except Exception as e:  # noqa: BLE001 — 合成失败提示后继续,不挂管线
            if not self._cancel.is_set():
                await self.push_frame(client_message("error", message=f"语音合成失败:{e}"))
                await self.push_frame(ErrorFrame(error=f"语音合成失败:{e}"))

    async def wait_idle(self) -> None:
        """测试辅助:等待内部队列全部处理完。"""
        await self._queue.join()


def build_context(settings: Settings, history: list[dict]) -> LLMContext:
    """会话上下文:系统提示 + 历史消息(只留最近 20 条,防上下文过长)。"""
    messages: list[dict] = [{"role": "system", "content": settings.llm.system_prompt}]
    messages += [
        {"role": m["role"], "content": m["content"]}
        for m in history[-20:]
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content")
    ]
    return LLMContext(messages=messages)


def build_pipeline(
    *,
    settings: Settings,
    engine,
    transport: BaseTransport,
    context: LLMContext,
    llm: FrameProcessor,
    speed: float | None = None,
) -> tuple[Pipeline, LLMContextAggregatorPair]:
    aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                start=[ExternalUserTurnStartStrategy(enable_interruptions=True)],
                stop=[ExternalUserTurnStopStrategy()],
            ),
        ),
    )

    interrupt_event = asyncio.Event()

    processors: list[FrameProcessor] = [
        transport.input(),
        ClientMessageRouter(),
    ]
    stt = create_stt_service(settings, engine)
    if stt is not None:
        processors.append(UtteranceSTTService(stt))
    processors += [
        aggregator.user(),
        llm,
        BotTextRelay(),
    ]
    tts = create_tts_service(settings, engine, speed=speed, should_stop=interrupt_event.is_set)
    if tts is not None:
        processors.append(SentenceTTSSpeaker(tts, cancel=interrupt_event))
    processors += [
        transport.output(),
        aggregator.assistant(),
    ]
    return Pipeline(processors), aggregator
