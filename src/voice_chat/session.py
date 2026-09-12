"""单个 WS 会话:hello 握手 → 组装 transport/管线 → WorkerRunner 驱动,断连即取消。

每连接无状态:历史在 hello 里注入上下文;切换会话由客户端重开连接。
"""

from __future__ import annotations

import asyncio
import uuid

from fastapi import WebSocket
from loguru import logger
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frameworks.rtvi import RTVIObserverParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.workers.runner import WorkerRunner

from .pipeline import build_context, build_pipeline
from .serializers import VoiceChatSerializer
from .services import SherpaEngine
from .settings import Settings

HELLO_TIMEOUT_SECS = 10.0


class VoiceChatSession:
    def __init__(self, settings: Settings, engine: SherpaEngine) -> None:
        self._settings = settings
        self._engine = engine

    async def run(self, ws: WebSocket) -> None:
        history, speed = await self._handshake(ws)
        settings = self._settings

        serializer = VoiceChatSerializer()
        transport = FastAPIWebsocketTransport(
            ws,
            params=FastAPIWebsocketParams(
                audio_in_enabled=False,
                audio_out_enabled=True,
                serializer=serializer,
            ),
        )

        context: LLMContext = build_context(settings, history)
        llm = self._build_llm()
        pipeline, _aggregator = build_pipeline(
            settings=settings,
            engine=self._engine,
            transport=transport,
            context=context,
            llm=llm,
            speed=speed,
        )
        worker = PipelineWorker(
            pipeline,
            idle_timeout_secs=None,
            enable_rtvi=False,
            rtvi_observer_params=RTVIObserverParams(
                bot_output_enabled=False,
                bot_llm_enabled=False,
                bot_tts_enabled=False,
                bot_speaking_enabled=False,
                user_llm_enabled=False,
            ),
        )

        @transport.event_handler("on_client_disconnected")
        async def _on_client_disconnected(_transport, _client) -> None:
            await worker.cancel(reason="client_disconnected")

        runner = WorkerRunner(
            name=f"voice-chat-{uuid.uuid4().hex[:8]}", handle_sigint=False, handle_sigterm=False
        )
        await runner.add_workers(worker)
        logger.info("[session] 新语音会话开始")
        await runner.run()
        logger.info("[session] 会话结束")

    def _build_llm(self) -> OpenAILLMService:
        cfg = self._settings.llm
        # pipecat 把 extra 顶层合并进 create() 调用;智谱的思考开关必须走
        # openai SDK 的 extra_body 通道才能落到请求体
        extra = (
            {"extra_body": {"thinking": {"type": "disabled"}}}
            if self._settings.llm_thinking_disabled
            else {}
        )
        return OpenAILLMService(
            api_key=cfg.api_key or "not-needed",  # Ollama 等本地服务忽略鉴权
            base_url=cfg.base_url,
            settings=OpenAILLMService.Settings(
                model=cfg.model,
                max_tokens=cfg.max_tokens,
                extra=extra,
            ),
        )

    async def _handshake(self, ws: WebSocket) -> tuple[list[dict], float | None]:
        """等待 hello 消息(客户端发 {"type":"hello","messages":[...],"speed":1.0})。"""
        try:
            hello = await asyncio.wait_for(ws.receive_json(), timeout=HELLO_TIMEOUT_SECS)
        except TimeoutError:
            logger.warning("[session] 客户端 10s 内未发 hello,按空历史继续")
            return [], None
        if not isinstance(hello, dict) or hello.get("type") != "hello":
            logger.warning("[session] 首条消息不是 hello,按空历史继续")
            return [], None
        messages = hello.get("messages")
        history = [m for m in messages if isinstance(m, dict)] if isinstance(messages, list) else []
        speed = hello.get("speed")
        return history, (float(speed) if isinstance(speed, (int, float)) and speed > 0 else None)
