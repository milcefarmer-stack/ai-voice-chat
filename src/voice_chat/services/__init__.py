"""pipecat service 工厂:按配置把本地 sherpa / 云端硅基流动装配成管线 service。

provider 语义与旧版一致:
- auto:本地引擎就绪用本地;否则有云端 Key 走云端;都没有则识别退浏览器/合成不可用;
- local / cloud:强制指定。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Protocol

import httpx
from loguru import logger

from ..settings import ProviderChoice, Settings, resolve_provider
from .sherpa_engine import SherpaEngine, pcm_to_wav

INPUT_SAMPLE_RATE = 16000
CLOUD_TTS_SAMPLE_RATE = 24000  # CosyVoice2 原生采样率(与旧版一致)


class STTProvider(Protocol):
    """整句识别器:16bit PCM 进,文本出(可为空字符串)。"""

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str: ...


# ============ STT ============


class SherpaSTT:
    """本地 SenseVoice:整段 16bit PCM 直接送离线识别。"""

    def __init__(self, engine: SherpaEngine) -> None:
        self._engine = engine

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        if not pcm:
            return ""
        return await asyncio.to_thread(self._engine.transcribe_pcm, pcm, sample_rate)


class SiliconFlowSTT:
    """云端识别:整段 PCM 打包 WAV 上传 /audio/transcriptions。"""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(timeout=settings.asr.timeout_ms / 1000)

    async def transcribe(self, pcm: bytes, sample_rate: int) -> str:
        if not pcm:
            return ""
        cfg = self._settings.asr
        wav = pcm_to_wav(pcm, sample_rate)
        try:
            resp = await self._client.post(
                f"{cfg.base_url}/audio/transcriptions",
                headers={"Authorization": f"Bearer {cfg.api_key}"},
                files={"file": ("audio.wav", wav, "audio/wav")},
                data={"model": cfg.model},
            )
            resp.raise_for_status()
            return (resp.json().get("text") or "").strip()
        except Exception as e:  # noqa: BLE001 — 统一转异常上抛,由管线层提示
            logger.error(f"[stt] 云端识别失败:{e}")
            raise RuntimeError(f"云端识别失败:{e}") from e


# ============ TTS ============


class TTSProvider(Protocol):
    """语音合成器:文本进,16bit PCM 块流出。"""

    sample_rate: int

    def speak(self, text: str) -> AsyncIterator[bytes]: ...


class SherpaTTS:
    """本地合成:逐块 PCM;generate_stream 的取消机制负责打断。"""

    def __init__(
        self,
        engine: SherpaEngine,
        *,
        settings: Settings,
        speed: float | None = None,
        should_stop=None,
    ) -> None:
        self._engine = engine
        self._speed = speed or settings.tts.speed
        self._should_stop = should_stop
        self.sample_rate = engine.tts_sample_rate

    async def speak(self, text: str):
        async for chunk in self._engine.generate_stream(
            text, speed=self._speed, should_stop=self._should_stop
        ):
            yield chunk


class SiliconFlowTTS:
    """云端 CosyVoice2:流式 PCM 直出。"""

    def __init__(
        self, *, settings: Settings, speed: float | None = None, should_stop=None
    ) -> None:
        self._settings = settings
        self._speed = speed or settings.tts.speed
        self._should_stop = should_stop
        self._client = httpx.AsyncClient(timeout=settings.tts.timeout_ms / 1000)
        self.sample_rate = CLOUD_TTS_SAMPLE_RATE

    async def speak(self, text: str):
        cfg = self._settings.tts
        body = {
            "model": cfg.model,
            "voice": cfg.voice,
            "input": text[:200],
            "response_format": "pcm",
            "sample_rate": CLOUD_TTS_SAMPLE_RATE,
            "speed": self._speed,
        }
        try:
            async with self._client.stream(
                "POST",
                f"{cfg.base_url}/audio/speech",
                headers={"Authorization": f"Bearer {cfg.api_key}"},
                json=body,
            ) as resp:
                if resp.status_code != 200:
                    detail = (await resp.aread()).decode("utf-8", "replace")[:300]
                    raise RuntimeError(f"语音合成返回 {resp.status_code}: {detail}")
                async for chunk in resp.aiter_bytes():
                    if self._should_stop and self._should_stop():
                        return
                    if chunk:
                        yield chunk
        except Exception as e:  # noqa: BLE001 — 统一转异常,由管线层提示
            if not (self._should_stop and self._should_stop()):
                raise RuntimeError(f"语音合成请求失败:{e}") from e


# ============ 工厂 ============


def _stt_choice(settings: Settings, engine: SherpaEngine) -> ProviderChoice:
    return resolve_provider(
        settings.asr.provider,
        local_ready=engine.asr_ready,
        cloud_available=settings.cloud_asr_available,
    )


def _tts_choice(settings: Settings, engine: SherpaEngine) -> ProviderChoice:
    return resolve_provider(
        settings.tts.provider,
        local_ready=engine.tts_ready,
        cloud_available=settings.cloud_tts_available,
    )


def create_stt_service(settings: Settings, engine: SherpaEngine) -> STTProvider | None:
    match _stt_choice(settings, engine):
        case ProviderChoice.LOCAL:
            return SherpaSTT(engine)
        case ProviderChoice.CLOUD:
            return SiliconFlowSTT(settings)
    logger.warning("[stt] 本地未就绪且未配置云端 Key,语音识别不可用")
    return None


def create_tts_service(
    settings: Settings, engine: SherpaEngine, *, speed: float | None = None, should_stop=None
) -> TTSProvider | None:
    match _tts_choice(settings, engine):
        case ProviderChoice.LOCAL:
            return SherpaTTS(engine, settings=settings, speed=speed, should_stop=should_stop)
        case ProviderChoice.CLOUD:
            return SiliconFlowTTS(settings=settings, speed=speed, should_stop=should_stop)
    logger.warning("[tts] 本地未就绪且未配置云端 Key,语音合成不可用")
    return None


def _provider_name(choice: ProviderChoice, fallback: str) -> str:
    if choice is ProviderChoice.LOCAL:
        return "local-sherpa"
    if choice is ProviderChoice.CLOUD:
        return "siliconflow"
    return fallback


def effective_stt_provider(settings: Settings, engine: SherpaEngine) -> str:
    return _provider_name(_stt_choice(settings, engine), "browser")


def effective_tts_provider(settings: Settings, engine: SherpaEngine) -> str:
    return _provider_name(_tts_choice(settings, engine), "none")
