"""settings 测试:env 解析、provider 决策(auto/local/cloud 与回退)必须与旧 Node 版语义一致。"""

from voice_chat.settings import ProviderChoice, Settings, resolve_provider


def _base(**over) -> dict:
    env = {
        "LLM_API_KEY": "sk-test",
        "LLM_BASE_URL": "https://api.siliconflow.cn/v1",
        "LLM_MODEL": "deepseek-ai/DeepSeek-V3",
        "LLM_MAX_TOKENS": "200",
        "SYSTEM_PROMPT": "你是小暖",
        "PORT": "3100",
    }
    env.update(over)
    return env


def test_defaults_follow_legacy_env():
    s = Settings.from_env(_base())
    assert s.llm.model == "deepseek-ai/DeepSeek-V3"
    assert s.llm.max_tokens == 200
    assert s.llm.base_url == "https://api.siliconflow.cn/v1"
    assert s.llm.system_prompt == "你是小暖"
    assert s.port == 3100
    # 未单独配置时,ASR/TTS 复用 LLM 的 key 与 base_url(旧版语义)
    assert s.asr.api_key == "sk-test"
    assert s.asr.base_url == "https://api.siliconflow.cn/v1"
    assert s.tts.api_key == "sk-test"
    # 旧版默认模型
    assert s.asr.model == "XingChenAGI/XingChenASR-V3.2-Ultra"
    assert s.tts.model == "FunAudioLLM/CosyVoice2-0.5B"
    assert s.tts.voice == "FunAudioLLM/CosyVoice2-0.5B:bella"
    assert s.tts.speed == 1.0
    # provider 默认 auto
    assert s.asr.provider == "auto"
    assert s.tts.provider == "auto"


def test_speed_clamped_to_legacy_range():
    assert Settings.from_env(_base(TTS_SPEED="9")).tts.speed == 4.0
    assert Settings.from_env(_base(TTS_SPEED="0.1")).tts.speed == 0.25
    assert Settings.from_env(_base(TTS_SPEED="abc")).tts.speed == 1.0


def test_llm_max_tokens_invalid_falls_back():
    assert Settings.from_env(_base(LLM_MAX_TOKENS="x")).llm.max_tokens == 200
    assert Settings.from_env(_base(LLM_MAX_TOKENS="-5")).llm.max_tokens == 200


def test_asr_tts_independent_key_and_base():
    s = Settings.from_env(
        _base(ASR_API_KEY="sk-asr", ASR_BASE_URL="https://a.example/v1", TTS_API_KEY="sk-tts")
    )
    assert s.asr.api_key == "sk-asr"
    assert s.asr.base_url == "https://a.example/v1"
    assert s.tts.api_key == "sk-tts"


# ---------- provider 决策:auto = 本地就绪用本地,否则回退云端 ----------

def test_resolve_provider_auto_local_ready():
    assert resolve_provider("auto", local_ready=True, cloud_available=True) is ProviderChoice.LOCAL
    assert resolve_provider("auto", local_ready=True, cloud_available=False) is ProviderChoice.LOCAL


def test_resolve_provider_auto_falls_back_to_cloud():
    assert resolve_provider("auto", local_ready=False, cloud_available=True) is ProviderChoice.CLOUD


def test_resolve_provider_no_cloud_key_means_browser_none():
    """本地未就绪且没有云端 Key:识别退浏览器、合成不可用(旧版 config 语义)。"""
    assert resolve_provider("auto", local_ready=False, cloud_available=False) is ProviderChoice.NONE


def test_resolve_provider_forced_local_or_cloud():
    assert resolve_provider("local", local_ready=True, cloud_available=True) is ProviderChoice.LOCAL
    assert resolve_provider("cloud", local_ready=True, cloud_available=True) is ProviderChoice.CLOUD


def test_sherpa_tts_defaults_match_legacy():
    s = Settings.from_env(_base())
    assert s.sherpa_tts.model_type == "matcha"
    assert str(s.sherpa_tts.model_dir).endswith("matcha-icefall-zh-baker")
    assert s.sherpa_tts.model_file == "model-steps-3.onnx"
    assert s.sherpa_tts.num_threads == 4
    assert s.sherpa_tts.max_sentences == 1
    assert s.sherpa_tts.gain == 1.0


def test_sherpa_tts_vits_type_switch():
    s = Settings.from_env(_base(SHERPA_TTS_MODEL_TYPE="vits", SHERPA_TTS_MAX_SENTENCES="-1"))
    assert s.sherpa_tts.model_type == "vits"
    assert s.sherpa_tts.max_sentences == -1


def test_interruption_thresholds_defaults():
    s = Settings.from_env(_base())
    # 智能打断:确认真实语音 300ms、持续打断 500ms、短插话合并超时 3s
    assert s.interrupt.confirm_ms == 300
    assert s.interrupt.sustain_ms == 500
    assert s.interrupt.merge_timeout_ms == 3000
