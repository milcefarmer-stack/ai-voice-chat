"""兼容 REST 测试:TestClient + 假引擎(注入),覆盖 config / history / asr / tts。"""

import pytest
from fastapi.testclient import TestClient

from voice_chat.history import HistoryStore
from voice_chat.main import create_app
from voice_chat.settings import Settings


class FakeEngine:
    """CompatApi 所需的鸭子类型引擎,不触碰 sherpa。"""

    def __init__(self, *, asr_ready: bool = True, tts_ready: bool = True) -> None:
        self._asr_ready = asr_ready
        self._tts_ready = tts_ready
        self.tts_sample_rate = 44100

    @property
    def asr_ready(self) -> bool:
        return self._asr_ready

    @property
    def tts_ready(self) -> bool:
        return self._tts_ready

    class _Status:
        asr_error = None
        tts_error = None

    @property
    def status(self) -> "FakeEngine._Status":
        return FakeEngine._Status()

    def transcribe_wav(self, wav: bytes) -> str:
        return "你好测试"

    def generate_stream_sync(self, text, *, speed=1.0, should_stop=None, on_chunk=None):
        if on_chunk:
            on_chunk(b"\x00\x01" * 100)
        return [b"\x00\x01" * 100]

    def synthesize_wav(self, text, *, speed=1.0) -> bytes:
        return b"RIFF-fake-wav-bytes"


@pytest.fixture
def client(tmp_path):
    settings = Settings.from_env({"LLM_API_KEY": ""})  # 无云端 Key → 全走本地
    app = create_app(
        settings,
        engine=FakeEngine(),
        store=HistoryStore(data_dir=tmp_path / "data"),
    )
    return TestClient(app)


def test_config_payload(client):
    cfg = client.get("/api/config").json()
    assert cfg["asrProvider"] == "local-sherpa"
    assert cfg["ttsProvider"] == "local-sherpa"
    assert cfg["asrLocalReady"] is True
    assert cfg["ttsAvailable"] is True
    assert cfg["ttsSampleRate"] == 44100
    assert cfg["useOllama"] is True


def test_history_crud_roundtrip(client):
    r = client.post(
        "/api/history",
        json={"id": "s1", "messages": [{"role": "user", "content": "你好"}]},
    )
    assert r.status_code == 200
    assert r.json()["session"]["title"] == "你好"

    assert [s["id"] for s in client.get("/api/history").json()["sessions"]] == ["s1"]
    assert client.get("/api/history/s1").json()["session"]["messages"][0]["content"] == "你好"
    assert client.get("/api/history/none").status_code == 404

    assert client.delete("/api/history/s1").json() == {"ok": True}
    assert client.get("/api/history/s1").status_code == 404


def test_history_save_requires_id(client):
    assert client.post("/api/history", json={"messages": []}).status_code == 400


def test_asr_local(client):
    r = client.post("/api/asr", files={"file": ("a.wav", b"RIFF-fake", "audio/wav")})
    assert r.status_code == 200
    assert r.json() == {"text": "你好测试"}


def test_tts_stream_pcm(client):
    r = client.post("/api/tts", json={"text": "你好", "stream": True})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/octet-stream")
    assert r.headers["x-pcm-sample-rate"] == "44100"
    assert len(r.content) > 0


def test_tts_wav_non_stream(client):
    r = client.post("/api/tts", json={"text": "你好", "format": "wav"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/wav")
    assert r.content == b"RIFF-fake-wav-bytes"


def test_tts_requires_text(client):
    assert client.post("/api/tts", json={"text": "  "}).status_code == 400


def test_tts_without_any_engine_returns_500(tmp_path):
    settings = Settings.from_env({"LLM_API_KEY": ""})
    app = create_app(
        settings,
        engine=FakeEngine(asr_ready=False, tts_ready=False),
        store=HistoryStore(data_dir=tmp_path / "data"),
    )
    client = TestClient(app)
    assert client.post("/api/tts", json={"text": "你好"}).status_code == 500
    assert "未配置云端" in client.post("/api/tts", json={"text": "你好"}).json()["detail"]
