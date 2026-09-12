"""管线组装测试:不启动,只验证处理器链与上下文种子装配正确。"""

import pytest

from voice_chat.pipeline import build_context, build_pipeline
from voice_chat.settings import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings.from_env(
        {
            "LLM_API_KEY": "sk-test",
            "LLM_BASE_URL": "https://example.invalid/v1",
            "SYSTEM_PROMPT": "你是小暖",
        }
    )


class _FakeEngine:
    """无模型的假引擎:cloud provider 会被选中,本地引擎不参与。"""

    asr_ready = False
    tts_ready = False


class _FakeTransport:
    """只为取 input()/output() 处理器,不做真实传输。"""

    def __init__(self) -> None:
        from pipecat.transports.base_transport import TransportParams

        self._params = TransportParams()

    def input(self):
        from pipecat.transports.base_input import BaseInputTransport  # noqa: PLC0415

        return BaseInputTransport(transport=self, params=self._params)

    def output(self):
        from pipecat.transports.base_output import BaseOutputTransport  # noqa: PLC0415

        return BaseOutputTransport(transport=self, params=self._params)


def _make(settings):
    from pipecat.services.openai.llm import OpenAILLMService

    transport = _FakeTransport()
    context = build_context(settings, [{"role": "user", "content": "你好"}])
    llm = OpenAILLMService(
        api_key="sk-test",
        base_url=settings.llm.base_url,
        settings=OpenAILLMService.Settings(model=settings.llm.model),
    )
    pipeline, aggregator = build_pipeline(
        settings=settings,
        engine=_FakeEngine(),
        transport=transport,
        context=context,
        llm=llm,
    )
    return pipeline, aggregator, context


def test_pipeline_builds_with_cloud_fallback(settings):
    pipeline, aggregator, _ctx = _make(settings)
    names = [p.name for p in pipeline._processors]
    # 顺序:input → router → stt → user_agg → llm → relay → tts → output → assistant_agg
    assert _has(names, "BaseInputTransport")
    assert _has(names, "ClientMessageRouter")
    assert _has(names, "UtteranceSTTService")
    assert _has(names, "SentenceTTSSpeaker")
    assert _has(names, "BotTextRelay")
    assert _idx(names, "UtteranceSTTService") < _idx(names, "LLMUserAggregator")
    assert _idx(names, "BotTextRelay") < _idx(names, "SentenceTTSSpeaker")
    assert aggregator.user() is not None and aggregator.assistant() is not None


def _has(names: list[str], prefix: str) -> bool:
    return any(n.startswith(prefix) for n in names)


def _idx(names: list[str], prefix: str) -> int:
    return next(i for i, n in enumerate(names) if n.startswith(prefix))


def test_context_seeds_system_prompt_and_history(settings):
    _, _, ctx = _make(settings)
    roles = [m["role"] for m in ctx.messages]
    assert roles[0] == "system"
    assert ctx.messages[0]["content"] == "你是小暖"
    assert roles[-1] == "user"
    assert ctx.messages[-1]["content"] == "你好"


def test_context_truncates_to_last_20(settings):
    many = [{"role": "user", "content": f"m{i}"} for i in range(50)]
    ctx = build_context(settings, many)
    # system + 最近 20 条
    assert len(ctx.messages) == 21
    assert ctx.messages[1]["content"] == "m30"
    assert ctx.messages[-1]["content"] == "m49"


def test_context_ignores_non_chat_roles(settings):
    ctx = build_context(settings, [{"role": "system", "content": "injected"}])
    assert len(ctx.messages) == 1  # 只有我们自己的 system


def test_pipeline_builds_without_stt_tts_when_nothing_available():
    """本地未就绪且无云端 Key:识别/合成缺位,管线仍组装(打字输入可用)。"""
    from pipecat.services.openai.llm import OpenAILLMService

    settings = Settings.from_env({"LLM_BASE_URL": "http://localhost:11434/v1"})
    assert settings.cloud_asr_available is False
    pipeline, _agg = build_pipeline(
        settings=settings,
        engine=_FakeEngine(),
        transport=_FakeTransport(),
        context=build_context(settings, []),
        llm=OpenAILLMService(
            api_key="not-needed",  # OpenAI 客户端要求非空;Ollama 忽略鉴权
            base_url=settings.llm.base_url,
            settings=OpenAILLMService.Settings(model="qwen2.5:7b"),
        ),
    )
    names = [p.name for p in pipeline._processors]
    assert not _has(names, "UtteranceSTTService")
    assert not _has(names, "SentenceTTSSpeaker")
    assert _has(names, "ClientMessageRouter")
