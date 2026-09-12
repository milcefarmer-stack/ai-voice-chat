"""配置解析:与旧 Node 版 .env 语义逐项对齐(见 docs/spec-pipecat-refactor.md §4.5)。

约定:
- 字符串配置 trim 后使用;数字配置非法/非正时回退默认值;
- ASR/TTS 未单独指定 key/base_url 时复用 LLM 的(硅基流动 Key 通用,旧版行为);
- provider: auto=本地就绪用本地,否则/失败回退云端;local/cloud 强制。
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class ProviderChoice(Enum):
    LOCAL = "local"
    CLOUD = "cloud"
    NONE = "none"


def resolve_provider(
    provider: str, *, local_ready: bool, cloud_available: bool
) -> ProviderChoice:
    if provider == "cloud":
        return ProviderChoice.CLOUD
    if provider == "local":
        return ProviderChoice.LOCAL
    if local_ready:
        return ProviderChoice.LOCAL
    if cloud_available:
        return ProviderChoice.CLOUD
    return ProviderChoice.NONE


def clamp_speed(v) -> float:
    """语速 0.25~4.0,1.0 正常;非法值回退 1.0(旧版语义)。"""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 1.0
    if not n > 0:
        return 1.0
    return _Env.clamp(n, 0.25, 4.0)


class _Env:
    """读取一个字符串映射(默认进程环境);测试可注入,不污染 os.environ。"""

    def __init__(self, source: Mapping[str, str] | None = None) -> None:
        self._source = os.environ if source is None else source

    def s(self, name: str, default: str = "") -> str:
        v = self._source.get(name)
        if v is None or v.strip() == "":
            return default
        return v.strip()

    def n(self, name: str, default: float, *, positive: bool = True) -> float:
        try:
            value = float(self._source.get(name, ""))
        except (TypeError, ValueError):
            return default
        if positive and value <= 0:
            return default
        return value

    def i(self, name: str, default: int, *, positive: bool = True) -> int:
        return int(self.n(name, default, positive=positive))

    @staticmethod
    def clamp(v: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, v))


@dataclass(frozen=True)
class LLMSettings:
    api_key: str
    base_url: str
    model: str
    max_tokens: int
    timeout_ms: int
    system_prompt: str


@dataclass(frozen=True)
class ASRSettings:
    api_key: str
    base_url: str
    model: str
    timeout_ms: int
    provider: str


@dataclass(frozen=True)
class TTSSettings:
    api_key: str
    base_url: str
    model: str
    voice: str
    timeout_ms: int
    provider: str
    speed: float


@dataclass(frozen=True)
class SherpaTTSConfig:
    """本地合成引擎参数,字段含义与旧 sherpa.js 一一对应。"""

    model_type: str  # 'matcha' | 'vits'
    model_dir: Path
    model_file: str
    vocoder: Path
    lexicon: str
    tokens: str
    dict_dir: str
    rule_fsts: str
    num_threads: int
    max_sentences: int
    sid: int
    gain: float
    warmup_text: str


@dataclass(frozen=True)
class SherpaASRConfig:
    model_dir: Path
    model_file: str
    tokens: str
    num_threads: int
    language: str


@dataclass(frozen=True)
class InterruptSettings:
    """智能打断阈值(浏览器端执行,服务端仅供配置下发)。"""

    confirm_ms: int = 300  # 确认真实语音(≥ 此时长才算一句话,防误触发)
    sustain_ms: int = 500  # 持续时长达到即"打断";不足视为短插话
    merge_timeout_ms: int = 3000  # 短插话缓冲等待后续话语的窗口


@dataclass(frozen=True)
class Settings:
    llm: LLMSettings
    asr: ASRSettings
    tts: TTSSettings
    sherpa_asr: SherpaASRConfig
    sherpa_tts: SherpaTTSConfig
    interrupt: InterruptSettings
    port: int
    ws_port: int

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        e = _Env(env)
        llm_key = e.s("LLM_API_KEY")
        llm_base = e.s("LLM_BASE_URL", "http://localhost:11434/v1").rstrip("/")
        llm_model = e.s("LLM_MODEL", "qwen2.5:7b")
        llm = LLMSettings(
            api_key=llm_key,
            base_url=llm_base,
            model=llm_model,
            max_tokens=e.i("LLM_MAX_TOKENS", 200),
            timeout_ms=e.i("LLM_TIMEOUT_MS", 90_000),
            system_prompt=e.s(
                "SYSTEM_PROMPT",
                "你是一个友好的语音助手，请用简洁、口语化的中文回答，单次回答不超过 100 字。"
                "不要使用表情符号、Markdown 标记或特殊符号。",
            ),
        )
        asr = ASRSettings(
            api_key=e.s("ASR_API_KEY", llm_key),
            base_url=e.s("ASR_BASE_URL", llm_base).rstrip("/"),
            model=e.s("ASR_MODEL", "XingChenAGI/XingChenASR-V3.2-Ultra"),
            timeout_ms=e.i("ASR_TIMEOUT_MS", 60_000),
            provider=e.s("ASR_PROVIDER", "auto").lower(),
        )
        tts = TTSSettings(
            api_key=e.s("TTS_API_KEY", llm_key),
            base_url=e.s("TTS_BASE_URL", llm_base).rstrip("/"),
            model=e.s("TTS_MODEL", "FunAudioLLM/CosyVoice2-0.5B"),
            voice=e.s("TTS_VOICE", "FunAudioLLM/CosyVoice2-0.5B:bella"),
            timeout_ms=e.i("TTS_TIMEOUT_MS", 30_000),
            provider=e.s("TTS_PROVIDER", "auto").lower(),
            speed=_Env.clamp(e.n("TTS_SPEED", 1.0, positive=False), 0.25, 4.0),
        )
        return cls(
            llm=llm,
            asr=asr,
            tts=tts,
            sherpa_asr=_sherpa_asr_from_env(e),
            sherpa_tts=_sherpa_tts_from_env(e),
            interrupt=InterruptSettings(
                confirm_ms=e.i("INTERRUPT_CONFIRM_MS", 300),
                sustain_ms=e.i("INTERRUPT_SUSTAIN_MS", 500),
                merge_timeout_ms=e.i("INTERRUPT_MERGE_TIMEOUT_MS", 3000),
            ),
            port=e.i("PORT", 3000),
            ws_port=e.i("WS_PORT", 3100),
        )

    @property
    def llm_thinking_disabled(self) -> bool:
        """智谱 GLM 默认带思考,语音场景关闭以降低首字延迟(旧版行为)。"""
        return self.llm.model.startswith("glm-")

    @property
    def cloud_asr_available(self) -> bool:
        return bool(self.asr.api_key)

    @property
    def cloud_tts_available(self) -> bool:
        return bool(self.tts.api_key)


def _resolve_model_path(p: str) -> Path:
    path = Path(p)
    return path if path.is_absolute() else (PROJECT_ROOT / path)


def _sherpa_asr_from_env(e: _Env) -> SherpaASRConfig:
    return SherpaASRConfig(
        model_dir=_resolve_model_path(e.s("SHERPA_ASR_MODEL_DIR", "models/asr/sense-voice")),
        model_file=e.s("SHERPA_ASR_MODEL_FILE", "model.int8.onnx"),
        tokens=e.s("SHERPA_ASR_TOKENS", "tokens.txt"),
        num_threads=e.i("SHERPA_ASR_NUM_THREADS", 4),
        language=e.s("SHERPA_ASR_LANGUAGE"),
    )


def _sherpa_tts_from_env(e: _Env) -> SherpaTTSConfig:
    max_sentences = -1 if e.s("SHERPA_TTS_MAX_SENTENCES") == "-1" else e.i(
        "SHERPA_TTS_MAX_SENTENCES", 1
    )
    return SherpaTTSConfig(
        model_type=e.s("SHERPA_TTS_MODEL_TYPE", "matcha").lower(),
        model_dir=_resolve_model_path(
            e.s("SHERPA_TTS_MODEL_DIR", "models/tts/matcha-zh-baker/matcha-icefall-zh-baker")
        ),
        model_file=e.s("SHERPA_TTS_MODEL_FILE", "model-steps-3.onnx"),
        vocoder=_resolve_model_path(
            e.s("SHERPA_TTS_VOCODER", "models/tts/matcha-zh-baker/vocos-22khz-univ.onnx")
        ),
        lexicon=e.s("SHERPA_TTS_LEXICON", "lexicon.txt"),
        tokens=e.s("SHERPA_TTS_TOKENS", "tokens.txt"),
        dict_dir=e.s("SHERPA_TTS_DICT_DIR", "dict"),
        rule_fsts=e.s("SHERPA_TTS_RULE_FSTS", "number.fst,phone.fst,date.fst,new_heteronym.fst"),
        num_threads=e.i("SHERPA_TTS_NUM_THREADS", 4),
        max_sentences=max_sentences,
        sid=e.i("SHERPA_TTS_SID", 0),
        gain=e.n("SHERPA_TTS_GAIN", 1.0, positive=False),
        warmup_text=e.s("SHERPA_TTS_WARMUP_TEXT", "你好，语音服务已经就绪了。"),
    )
