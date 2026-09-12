"""WS 协议序列化器:浏览器 JSON 消息 ↔ pipecat Frame。

上行(浏览器 → 管线):
  {"type":"audio","data":"<base64 int16 PCM @16k>"}   → InputAudioRawFrame
  {"type":"utterance","data":"<base64 整句 PCM>","rate":16000}
                                                      → ClientUtteranceFrame(语音话轮)
  {"type":"interrupt"}                                → ClientInterruptFrame(打断广播)
  {"type":"text","content":"..."}                     → ClientTextFrame(打字话轮)

下行(管线 → 浏览器):
  OutputAudioRawFrame   → {"type":"audio","data":...,"rate":<采样率>}
  BotTextChunkFrame     → {"type":"bot_text","content":...}(回答增量文本,供显示)
  ErrorFrame            → {"type":"error","message":...}
  TranscriptionFrame    → {"type":"user_text","content":...}(最终识别结果,供显示)

切换历史会话 = 客户端重开 WS 连接(服务端每连接无状态,历史在 hello 握手里注入)。
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass

from loguru import logger
from pipecat.frames.frames import (
    Frame,
    OutputAudioRawFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer

INPUT_SAMPLE_RATE = 16000



# ---------- 上行自定义帧(由 deserialize 产生,管线内处理器消费) ----------


@dataclass
class ClientUtteranceFrame(Frame):
    """一段完整用户语音(浏览器 VAD 已切好段):交给 UtteranceSTTService 识别。"""

    audio: bytes
    sample_rate: int


@dataclass
class ClientInterruptFrame(Frame):
    """客户端打断信号:由 ClientMessageRouter 转成 InterruptionFrame 广播。"""


@dataclass
class ClientTextFrame(Frame):
    """打字输入话轮:由管线里的 ClientMessageRouter 展开成用户话轮。"""

    content: str


class VoiceChatSerializer(FrameSerializer):
    """自定义极简 JSON 协议;不使用 RTVI/protobuf,浏览器零依赖。"""

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, OutputTransportMessageUrgentFrame):
            message = frame.message
            return json.dumps(message) if isinstance(message, dict) else str(message)
        if isinstance(frame, OutputAudioRawFrame):
            return json.dumps(
                {
                    "type": "audio",
                    "data": base64.b64encode(frame.audio).decode("ascii"),
                    "rate": frame.sample_rate,
                }
            )
        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        try:
            message = json.loads(data)
            if not isinstance(message, dict):
                return None
        except (json.JSONDecodeError, UnicodeDecodeError):
            logger.warning("[ws] 无法解析的客户端消息")
            return None

        kind = message.get("type")
        if kind == "utterance":
            raw = base64.b64decode(message.get("data") or "")
            if not raw:
                return None
            rate = message.get("rate") or INPUT_SAMPLE_RATE
            return ClientUtteranceFrame(audio=raw, sample_rate=int(rate))
        if kind == "interrupt":
            return ClientInterruptFrame()
        if kind == "text":
            content = (message.get("content") or "").strip()
            return ClientTextFrame(content=content) if content else None
        # 未知类型静默忽略,保持前向兼容
        return None
