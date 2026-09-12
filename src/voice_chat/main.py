"""FastAPI 入口:WS 会话(/ws)+ 兼容 REST(/api/*)+ 静态托管 + uvicorn 启动。

运行:uv run python -m voice_chat.main(读取项目根 .env)
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated

from dotenv import load_dotenv
from fastapi import Body, FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .compat import CompatApi
from .history import HistoryStore
from .services import SherpaEngine
from .session import VoiceChatSession
from .settings import PROJECT_ROOT, Settings

load_dotenv(PROJECT_ROOT / ".env")

FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
VENDOR_DIR = PROJECT_ROOT / "public" / "vendor"


def create_app(
    settings: Settings | None = None,
    *,
    engine: SherpaEngine | None = None,
    store: HistoryStore | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    own_engine = engine is None
    engine = engine or SherpaEngine(settings)
    store = store or HistoryStore()
    compat = CompatApi(settings, engine, store)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if own_engine:  # 测试注入的假引擎不初始化
            status = engine.initialize()  # 模型加载放在启动阶段,首请求无冷启动
            if status.tts_ready:
                engine.warmup(settings.sherpa_tts.warmup_text)
        yield

    app = FastAPI(title="ai-voice-chat (pipecat)", lifespan=lifespan)

    # ---------- 语音会话 ----------
    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        session = VoiceChatSession(settings, engine)
        try:
            await session.run(ws)
        except WebSocketDisconnect:
            pass

    # ---------- 兼容 REST(skill 脚本依赖,行为与旧版一致) ----------
    @app.get("/api/config")
    def api_config() -> dict:
        return compat.config_payload()

    @app.post("/api/asr")
    async def api_asr(file: UploadFile) -> object:
        return await compat.asr(file)

    @app.post("/api/tts")
    async def api_tts(body: Annotated[dict, Body()] = None) -> object:
        return await compat.tts(body or {})

    @app.get("/api/history")
    def api_history_list() -> dict:
        return compat.history_list()

    @app.get("/api/history/{session_id}")
    def api_history_get(session_id: str) -> dict:
        return compat.history_get(session_id)

    @app.post("/api/history")
    def api_history_save(body: Annotated[dict, Body()] = None) -> dict:
        return compat.history_save(body or {})

    @app.delete("/api/history/{session_id}")
    def api_history_delete(session_id: str) -> dict:
        return compat.history_delete(session_id)

    # ---------- 静态托管(前端构建产物 + VAD/ONNX vendor 资源) ----------
    if VENDOR_DIR.is_dir():
        app.mount("/vendor", StaticFiles(directory=VENDOR_DIR), name="vendor")
    if FRONTEND_DIST.is_dir():
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="web")

    return app


def main() -> None:
    import uvicorn  # noqa: PLC0415

    settings = Settings.from_env()
    app = create_app(settings)
    uvicorn.run(app, host="127.0.0.1", port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
