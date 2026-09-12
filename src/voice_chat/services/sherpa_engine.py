"""sherpa-onnx 本地语音引擎(线程安全的同步封装,移植自旧 sherpa.js)。

- ASR:SenseVoice(int8)离线识别,接受 16bit PCM 或 WAV 字节;
- TTS:matcha(声学+声码器)/ vits(melo)离线合成,按句出音频、回调逐块给 16bit PCM;
- 合成加全局锁(单引擎不支持并发),打断用 cancel 标志让原生层尽快停止;
- 任一引擎初始化失败只标记不可用并记录原因,由上层回退云端,服务不挂。

注意:sherpa-onnx Python 的 generate callback 返回【非零】表示停止生成(与 Node 版相反)。
"""

from __future__ import annotations

import asyncio
import struct
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from loguru import logger

from ..settings import Settings, SherpaASRConfig, SherpaTTSConfig


@dataclass(frozen=True)
class EngineStatus:
    asr_ready: bool
    asr_error: str | None
    tts_ready: bool
    tts_error: str | None
    tts_sample_rate: int


def _preload_onnxruntime_dll() -> None:
    """按绝对路径预载 onnxruntime.dll,让 sherpa 的原生扩展绑到正确版本。

    sherpa 扩展按名字依赖 onnxruntime.dll;若不预载,Windows 搜索路径可能
    命中系统里其他程序的旧版副本,GetApi 版本不匹配会直接段错误。
    """
    import ctypes  # noqa: PLC0415

    import onnxruntime  # noqa: F401, PLC0415

    dll = Path(onnxruntime.__file__).parent / "capi" / "onnxruntime.dll"
    if dll.exists():
        ctypes.WinDLL(str(dll))


class SherpaEngine:
    """进程级单例:加载一次,所有会话与兼容 REST 共用。"""

    def __init__(self, settings: Settings) -> None:
        self._asr_cfg: SherpaASRConfig = settings.sherpa_asr
        self._tts_cfg: SherpaTTSConfig = settings.sherpa_tts
        self._asr = None
        self._asr_error: str | None = None
        self._tts = None
        self._tts_error: str | None = None
        self._tts_sample_rate = 0
        self._tts_lock = threading.Lock()
        self._loaded = False
        try:
            _preload_onnxruntime_dll()
            import sherpa_onnx  # noqa: PLC0415

            self._sherpa = sherpa_onnx
            self._loaded = True
        except ImportError as e:
            self._asr_error = f"sherpa-onnx 加载失败:{e}(本地引擎不可用,将回退云端)"
            self._tts_error = self._asr_error

    # ---------- 初始化 ----------

    def initialize(self) -> EngineStatus:
        if not self._loaded:
            logger.warning(f"[sherpa] {self._asr_error}")
            return self.status
        self._init_asr()
        self._init_tts()
        return self.status

    def _init_asr(self) -> None:
        cfg = self._asr_cfg
        try:
            model_file = cfg.model_dir / cfg.model_file
            tokens_file = cfg.model_dir / cfg.tokens
            if not model_file.exists():
                raise FileNotFoundError(f"模型文件不存在: {model_file}")
            if not tokens_file.exists():
                raise FileNotFoundError(f"tokens 文件不存在: {tokens_file}")
            self._asr = self._sherpa.OfflineRecognizer.from_sense_voice(
                model=str(model_file),
                tokens=str(tokens_file),
                num_threads=cfg.num_threads,
                language=cfg.language or "",
                use_itn=True,
            )
            logger.info(f"[sherpa] ASR 就绪:SenseVoice @ {cfg.model_dir}")
        except Exception as e:  # noqa: BLE001 — 任一初始化失败都只降级不崩溃
            self._asr = None
            self._asr_error = str(e)
            logger.warning(f"[sherpa] ASR 初始化失败:{e}(将回退云端)")

    def _init_tts(self) -> None:
        cfg = self._tts_cfg
        try:
            tokens_file = cfg.model_dir / cfg.tokens
            if not tokens_file.exists():
                raise FileNotFoundError(f"tokens 文件不存在: {tokens_file}")
            lexicon = cfg.model_dir / cfg.lexicon
            dict_dir = cfg.model_dir / cfg.dict_dir
            rule_fsts = ",".join(
                str(p)
                for f in (cfg.rule_fsts or "").split(",")
                if f.strip() and (p := cfg.model_dir / f.strip()).exists()
            )
            if cfg.model_type == "matcha":
                acoustic = cfg.model_dir / cfg.model_file
                if not acoustic.exists():
                    raise FileNotFoundError(f"声学模型文件不存在: {acoustic}")
                if not Path(cfg.vocoder).exists():
                    raise FileNotFoundError(f"声码器文件不存在: {cfg.vocoder}")
                model_inner = self._sherpa.OfflineTtsMatchaModelConfig(
                    acoustic_model=str(acoustic),
                    vocoder=str(cfg.vocoder),
                    tokens=str(tokens_file),
                    lexicon=str(lexicon) if lexicon.exists() else "",
                    dict_dir=str(dict_dir) if dict_dir.exists() else "",
                    data_dir="",
                )
            else:
                model_file = cfg.model_dir / cfg.model_file
                if not model_file.exists():
                    raise FileNotFoundError(f"模型文件不存在: {model_file}")
                model_inner = self._sherpa.OfflineTtsVitsModelConfig(
                    model=str(model_file),
                    tokens=str(tokens_file),
                    lexicon=str(lexicon) if lexicon.exists() else "",
                    dict_dir=str(dict_dir) if dict_dir.exists() else "",
                    data_dir="",
                )
            no_matcha = self._sherpa.OfflineTtsMatchaModelConfig()
            no_vits = self._sherpa.OfflineTtsVitsModelConfig()
            model_config = self._sherpa.OfflineTtsModelConfig(
                matcha=model_inner if cfg.model_type == "matcha" else no_matcha,
                vits=model_inner if cfg.model_type == "vits" else no_vits,
                num_threads=cfg.num_threads,
                debug=0,
                provider="cpu",
            )
            tts_config = self._sherpa.OfflineTtsConfig(
                model=model_config,
                rule_fsts=rule_fsts,
                max_num_sentences=cfg.max_sentences,
            )
            tts = self._sherpa.OfflineTts(config=tts_config)
            self._tts_sample_rate = tts.sample_rate
            self._tts = tts
            logger.info(
                f"[sherpa] TTS 就绪({cfg.model_type})@ {cfg.model_dir}, sr={tts.sample_rate}"
            )
        except Exception as e:  # noqa: BLE001
            self._tts = None
            self._tts_error = str(e)
            logger.warning(f"[sherpa] TTS 初始化失败:{e}(将回退云端)")

    def warmup(self, tts_text: str) -> None:
        """预热:挡掉模型首帧冷启动;失败则把对应引擎标记为不可用。"""
        if self.tts_ready:
            try:
                for _ in self.generate_stream_sync(tts_text, speed=1.0):
                    pass
                logger.info("[sherpa] TTS 预热完成,首个真实请求无冷启动")
            except Exception as e:  # noqa: BLE001
                self._tts = None
                self._tts_error = f"预热失败:{e}"
                logger.warning(f"[sherpa] TTS 预热失败:{e}")
        if self.asr_ready:
            try:
                self.transcribe_pcm(b"\x00\x00" * 9600, 16000)
                logger.info("[sherpa] ASR 预热完成")
            except Exception as e:  # noqa: BLE001
                self._asr = None
                self._asr_error = f"预热失败:{e}"
                logger.warning(f"[sherpa] ASR 预热失败:{e}")

    # ---------- 状态 ----------

    @property
    def asr_ready(self) -> bool:
        return self._asr is not None

    @property
    def tts_ready(self) -> bool:
        return self._tts is not None

    @property
    def tts_sample_rate(self) -> int:
        return self._tts_sample_rate

    @property
    def status(self) -> EngineStatus:
        return EngineStatus(
            asr_ready=self.asr_ready,
            asr_error=self._asr_error,
            tts_ready=self.tts_ready,
            tts_error=self._tts_error,
            tts_sample_rate=self._tts_sample_rate,
        )

    # ---------- ASR ----------

    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> str:
        """识别 16bit 单声道 PCM;返回文本(可能为空)。"""
        if not self.asr_ready:
            raise RuntimeError(self._asr_error or "本地 ASR 未就绪")
        stream = self._asr.create_stream()
        stream.accept_waveform(sample_rate, _bytes_to_f32(pcm))
        self._asr.decode_stream(stream)
        return (stream.result.text or "").strip()

    def transcribe_wav(self, wav: bytes) -> str:
        """识别 WAV 文件字节(与旧 /api/asr 行为一致)。"""
        samples, rate = _decode_wav(wav)
        if not samples:
            return ""
        if not self.asr_ready:
            raise RuntimeError(self._asr_error or "本地 ASR 未就绪")
        stream = self._asr.create_stream()
        stream.accept_waveform(rate, samples)
        self._asr.decode_stream(stream)
        return (stream.result.text or "").strip()

    # ---------- TTS ----------

    def generate_stream_sync(
        self,
        text: str,
        *,
        speed: float = 1.0,
        should_stop: Callable[[], bool] | None = None,
        on_chunk: Callable[[bytes], None] | None = None,
    ) -> list[bytes]:
        """阻塞式流式合成:逐块回调 16bit PCM,返回全部块。should_stop 为真时尽早终止。"""
        if not self.tts_ready:
            raise RuntimeError(self._tts_error or "本地 TTS 未就绪")
        chunks: list[bytes] = []
        with self._tts_lock:

            def progress(samples, _progress: float) -> int:
                if should_stop and should_stop():
                    return 1  # 非零 = 停止生成
                pcm = _f32_to_pcm16(samples, self._tts_cfg.gain)
                if pcm:
                    if on_chunk:
                        on_chunk(pcm)
                    chunks.append(pcm)
                return 0  # 零 = 继续

            audio = self._tts.generate(text, sid=self._tts_cfg.sid, speed=speed, callback=progress)
            if not chunks and len(audio.samples) > 0:
                # 兜底:个别版本回调不触发时一次性吐出
                pcm = _f32_to_pcm16(audio.samples, self._tts_cfg.gain)
                if pcm:
                    if on_chunk:
                        on_chunk(pcm)
                    chunks.append(pcm)
        return chunks

    async def generate_stream(
        self,
        text: str,
        *,
        speed: float = 1.0,
        should_stop: Callable[[], bool] | None = None,
    ):
        """异步生成器版本:原生合成在执行器线程跑,块经队列送出;取消靠 should_stop。"""
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[bytes | None] = asyncio.Queue()

        def on_chunk(pcm: bytes) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, pcm)

        def finished() -> None:
            loop.call_soon_threadsafe(queue.put_nowait, None)

        def run() -> None:
            try:
                self.generate_stream_sync(
                    text, speed=speed, should_stop=should_stop, on_chunk=on_chunk
                )
            except Exception as e:  # noqa: BLE001 — 错误以结束哨兵+日志传达
                logger.error(f"[sherpa] 合成失败:{e}")
            finally:
                finished()

        task = loop.run_in_executor(None, run)
        try:
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                yield chunk
        finally:
            # 消费方(打断)停止拉取时,让原生层尽快终止
            if should_stop:
                should_stop()
        await asyncio.gather(task, return_exceptions=True)

    def synthesize_wav(self, text: str, *, speed: float = 1.0) -> bytes:
        """整段合成并打包 WAV(供 /api/tts format=wav,如 speak.ps1)。"""
        chunks = self.generate_stream_sync(text, speed=speed)
        pcm = b"".join(chunks)
        return _wrap_wav(pcm, self._tts_sample_rate)


# ---------- 音频工具 ----------


def _f32_to_pcm16(samples, gain: float = 1.0) -> bytes:
    n = len(samples)
    buf = bytearray(n * 2)
    for i in range(n):
        s = samples[i] * gain
        s = -1.0 if s < -1.0 else 1.0 if s > 1.0 else s
        v = int(round(s * (32768 if s < 0 else 32767)))
        struct.pack_into("<h", buf, i * 2, v)
    return bytes(buf)


def _bytes_to_f32(pcm: bytes) -> list[float]:
    n = len(pcm) // 2
    return [v / 32768 for v in struct.unpack(f"<{n}h", pcm[: n * 2])]


def pcm_to_wav(pcm: bytes, sample_rate: int) -> bytes:
    """16bit PCM → WAV 容器(云端上传用)。"""
    return _wrap_wav(pcm, sample_rate)


def _wrap_wav(pcm: bytes, sample_rate: int, channels: int = 1, bits: int = 16) -> bytes:
    buf = bytearray()
    data_len = len(pcm)
    buf += b"RIFF"
    buf += struct.pack("<I", 36 + data_len)
    buf += b"WAVEfmt "
    buf += struct.pack(
        "<IHHIIHH",
        16,
        1,
        channels,
        sample_rate,
        sample_rate * channels * bits // 8,
        channels * bits // 8,
        bits,
    )
    buf += b"data"
    buf += struct.pack("<I", data_len)
    buf += pcm
    return bytes(buf)


def _decode_wav(wav: bytes) -> tuple[list[float], int]:
    """解析 WAV → (float 样本, 采样率);支持 PCM 8/16/24/32bit 与 float32,多声道取平均。"""
    if len(wav) < 44 or wav[0:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise ValueError("不是有效的 WAV 文件")
    fmt = None
    data = None
    off = 12
    while off + 8 <= len(wav):
        chunk_id = wav[off : off + 4]
        (size,) = struct.unpack_from("<I", wav, off + 4)
        body = off + 8
        if chunk_id == b"fmt " and size >= 16:
            audio_format, channels, rate, _brate, _align, bits = struct.unpack_from(
                "<HHIIHH", wav, body
            )
            fmt = (audio_format, channels, rate, bits)
        elif chunk_id == b"data":
            data = wav[body : body + size]
        off = body + size + (size % 2)
    if fmt is None or data is None:
        raise ValueError("WAV 缺少 fmt/data 块")
    audio_format, channels, rate, bits = fmt
    bytes_per = bits // 8
    frames = len(data) // (bytes_per * channels)
    samples: list[float] = [0.0] * frames
    for i in range(frames):
        acc = 0.0
        for c in range(channels):
            p = (i * channels + c) * bytes_per
            if audio_format == 3 and bits == 32:
                (v,) = struct.unpack_from("<f", data, p)
            elif audio_format == 1 and bits == 16:
                (v,) = struct.unpack_from("<h", data, p)
                v /= 32768
            elif audio_format == 1 and bits == 8:
                v = (data[p] - 128) / 128
            elif audio_format == 1 and bits == 32:
                (v,) = struct.unpack_from("<i", data, p)
                v /= 2147483648
            elif audio_format == 1 and bits == 24:
                raw = data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)
                if raw & 0x800000:
                    raw |= ~0xFFFFFF
                v = raw / 8388608
            else:
                raise ValueError(f"不支持的 WAV 编码:format={audio_format} bits={bits}")
            acc += v
        samples[i] = acc / channels
    return samples, rate
