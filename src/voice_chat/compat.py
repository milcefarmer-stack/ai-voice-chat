"""兼容 REST:skill 脚本(speak.ps1 / listen.py)与页面状态栏依赖的三个旧接口。

行为与旧 Node 版逐一对应,脚本零改动。历史会话接口也在这层提供(与旧版同构)。
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from fastapi import HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from loguru import logger

from .history import HistoryStore
from .services import SherpaEngine, effective_stt_provider, effective_tts_provider
from .settings import Settings, clamp_speed


class CompatApi:
    """无状态处理器;FastAPI 路由只做参数搬运。"""

    def __init__(self, settings: Settings, engine: SherpaEngine, store: HistoryStore) -> None:
        self._settings = settings
        self._engine = engine
        self._store = store

    # ---------- /api/config ----------

    def config_payload(self) -> dict:
        s, engine = self._settings, self._engine
        stt_provider = effective_stt_provider(s, engine)
        tts_provider = effective_tts_provider(s, engine)
        return {
            "baseUrl": s.llm.base_url,
            "model": s.llm.model,
            "hasKey": bool(s.llm.api_key),
            "useOllama": not s.llm.api_key,
            "asrProvider": stt_provider,
            "asrModel": s.asr.model,
            "asrLocalReady": engine.asr_ready,
            "asrLocalError": engine.status.asr_error,
            "ttsAvailable": tts_provider != "none",
            "ttsProvider": tts_provider,
            "ttsLocalReady": engine.tts_ready,
            "ttsLocalError": engine.status.tts_error,
            "ttsSampleRate": engine.tts_sample_rate or None,
            "ttsModel": s.tts.model,
            "ttsVoice": s.tts.voice,
        }

    # ---------- /api/asr ----------

    async def asr(self, file: UploadFile) -> JSONResponse:
        wav = await file.read()
        choice = effective_stt_provider(self._settings, self._engine)
        if choice == "local-sherpa":
            try:
                text = await asyncio.to_thread(self._engine.transcribe_wav, wav)
                return JSONResponse({"text": text})
            except Exception as e:  # noqa: BLE001
                if not self._settings.cloud_asr_available:
                    raise HTTPException(status_code=502, detail=f"本地识别失败:{e}") from e
                logger.warning(f"[asr] 本地识别失败,回退云端:{e}")
        if not self._settings.cloud_asr_available:
            raise HTTPException(status_code=500, detail="本地 ASR 未就绪且未配置云端")
        cfg = self._settings.asr
        try:
            async with httpx.AsyncClient(timeout=cfg.timeout_ms / 1000) as client:
                resp = await client.post(
                    f"{cfg.base_url}/audio/transcriptions",
                    headers={"Authorization": f"Bearer {cfg.api_key}"},
                    files={"file": ("audio.wav", wav, "audio/wav")},
                    data={"model": cfg.model},
                )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=resp.status_code,
                    detail=f"语音识别返回 {resp.status_code}: {resp.text[:300]}",
                )
            return JSONResponse({"text": (resp.json().get("text") or "").strip()})
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"语音识别请求失败:{e}") from e

    # ---------- /api/tts ----------

    async def tts(self, body: dict[str, Any]) -> Response:
        text = (body.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="缺少文本")
        want_stream = body.get("stream") is True
        fmt = body.get("format")
        fmt = fmt if fmt in ("mp3", "wav", "pcm") else ("pcm" if want_stream else "mp3")
        speed = clamp_speed(body.get("speed", self._settings.tts.speed))
        choice = effective_tts_provider(self._settings, self._engine)

        if choice == "local-sherpa":
            if want_stream or fmt == "pcm":
                chunks = await asyncio.to_thread(
                    self._engine.generate_stream_sync, text, speed=speed
                )
                pcm = b"".join(chunks)
                return Response(
                    content=pcm,
                    media_type="application/octet-stream",
                    headers={
                        "X-PCM-Sample-Rate": str(self._engine.tts_sample_rate),
                        "Cache-Control": "no-store",
                    },
                )
            # 非流式:本地引擎无 mp3 编码器,mp3 请求也回 WAV(旧版行为)
            wav = await asyncio.to_thread(self._engine.synthesize_wav, text, speed=speed)
            return Response(
                content=wav, media_type="audio/wav", headers={"Cache-Control": "no-store"}
            )

        if not self._settings.cloud_tts_available:
            raise HTTPException(
                status_code=500,
                detail="本地 TTS 未就绪且未配置云端:请检查 models/tts 模型目录,"
                "或在 .env 配置 TTS_API_KEY(或 LLM_API_KEY,硅基流动 Key 通用)",
            )
        cfg = self._settings.tts
        payload = {
            "model": cfg.model,
            "voice": cfg.voice,
            "input": text[:200],
            "response_format": fmt,
            "speed": speed,
        }
        if want_stream:
            payload["sample_rate"] = 24000
        try:
            async with httpx.AsyncClient(timeout=cfg.timeout_ms / 1000) as client:
                resp = await client.post(
                    f"{cfg.base_url}/audio/speech",
                    headers={"Authorization": f"Bearer {cfg.api_key}"},
                    json=payload,
                )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=resp.status_code,
                    detail=f"语音合成返回 {resp.status_code}: {resp.text[:300]}",
                )
            if want_stream:
                return Response(
                    content=resp.content,
                    media_type="application/octet-stream",
                    headers={"X-PCM-Sample-Rate": "24000", "Cache-Control": "no-store"},
                )
            media = "audio/wav" if fmt == "wav" else "audio/mpeg"
            return Response(
                content=resp.content, media_type=media, headers={"Cache-Control": "no-store"}
            )
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(
                status_code=502,
                detail=f"语音合成请求失败({cfg.base_url}/audio/speech):{e}",
            ) from e

    # ---------- /api/history ----------

    def history_list(self) -> JSONResponse:
        return JSONResponse({"sessions": self._store.list()})

    def history_get(self, session_id: str) -> JSONResponse:
        session = self._store.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="会话不存在")
        return JSONResponse({"session": session})

    def history_save(self, body: dict[str, Any]) -> JSONResponse:
        session_id = body.get("id")
        if not session_id:
            raise HTTPException(status_code=400, detail="缺少会话 id")
        try:
            session = self._store.save(
                session_id, body.get("messages"), _clean_title(body.get("title"))
            )
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        return JSONResponse({"session": session})

    def history_delete(self, session_id: str) -> JSONResponse:
        self._store.delete(session_id)
        return JSONResponse({"ok": True})


def _clean_title(title: Any) -> str | None:
    if isinstance(title, str) and title.strip():
        return title.strip()
    return None
