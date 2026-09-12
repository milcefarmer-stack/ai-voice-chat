"""VoiceChatSerializer 测试:WS JSON 消息 ↔ Frame 的双向映射。"""

import base64
import json

import pytest
from pipecat.frames.frames import (
    OutputAudioRawFrame,
    OutputTransportMessageUrgentFrame,
    StartFrame,
    TranscriptionFrame,
)

from voice_chat.serializers import (
    ClientInterruptFrame,
    ClientTextFrame,
    ClientUtteranceFrame,
    VoiceChatSerializer,
)


@pytest.fixture
def serializer() -> VoiceChatSerializer:
    return VoiceChatSerializer()


async def test_utterance_uplink_becomes_client_frame(serializer):
    pcm = b"" * 160
    frame = await serializer.deserialize(
        json.dumps({"type": "utterance", "data": base64.b64encode(pcm).decode(), "rate": 16000})
    )
    assert isinstance(frame, ClientUtteranceFrame)
    assert frame.audio == pcm
    assert frame.sample_rate == 16000


async def test_utterance_defaults_to_16k(serializer):
    frame = await serializer.deserialize(
        json.dumps({"type": "utterance", "data": base64.b64encode(b"ab").decode()})
    )
    assert isinstance(frame, ClientUtteranceFrame)
    assert frame.sample_rate == 16000


async def test_interrupt_and_text_messages(serializer):
    frame = await serializer.deserialize(json.dumps({"type": "interrupt"}))
    assert isinstance(frame, ClientInterruptFrame)
    frame = await serializer.deserialize(json.dumps({"type": "text", "content": " 你好 "}))
    assert isinstance(frame, ClientTextFrame)
    assert frame.content == "你好"
    assert await serializer.deserialize(json.dumps({"type": "text", "content": "  "})) is None


async def test_empty_payloads_are_dropped(serializer):
    assert await serializer.deserialize(json.dumps({"type": "utterance", "data": ""})) is None
    assert await serializer.deserialize(json.dumps({"type": "future-thing"})) is None
    assert await serializer.deserialize("not-json") is None
    assert await serializer.deserialize("[1,2,3]") is None


async def test_output_audio_downlink_becomes_base64_json(serializer):
    pcm = b"" * 80
    payload = await serializer.serialize(
        OutputAudioRawFrame(audio=pcm, sample_rate=24000, num_channels=1)
    )
    msg = json.loads(payload)
    assert msg["type"] == "audio"
    assert base64.b64decode(msg["data"]) == pcm
    assert msg["rate"] == 24000


async def test_transport_message_frames_pass_through(serializer):
    """客户端可见消息一律走 Urgent 帧(绕过音频节流队列,传输层直发)。"""
    payload = await serializer.serialize(
        OutputTransportMessageUrgentFrame(message={"type": "bot_text", "content": "今天天气不错"})
    )
    assert json.loads(payload) == {"type": "bot_text", "content": "今天天气不错"}

    payload = await serializer.serialize(
        OutputTransportMessageUrgentFrame(message={"type": "bot_end"})
    )
    assert json.loads(payload) == {"type": "bot_end"}

    payload = await serializer.serialize(TranscriptionFrame("问我啥", "user", "t"))
    assert payload is None  # 识别文本由管线显式转 user_text 消息,原始帧不外发


async def test_unrelated_frames_serialize_to_none(serializer):
    assert await serializer.serialize(StartFrame()) is None
