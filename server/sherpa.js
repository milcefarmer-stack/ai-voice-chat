/**
 * sherpa-onnx 本地语音引擎（完全离线的 ASR + TTS）
 *
 * 提供两种能力，全部跑在本机 CPU 上（k2-fsa sherpa-onnx 原生绑定）：
 *   - ASR：SenseVoice（int8）离线识别，替代云端 /audio/transcriptions
 *   - TTS：vits-melo-tts-zh_en 离线合成，流式回调逐块输出 16bit PCM，
 *          替代云端 CosyVoice2 流式
 *
 * 设计要点（延迟相关）：
 *   1. 全部用异步 API（createAsync / generateAsync / decodeAsync），
 *      推理跑在原生线程池，不阻塞 Node 事件循环 —— LLM SSE 转发不受影响。
 *   2. TTS maxNumSentences=1：按句出音频，首个 120ms 音频块实测 ~190ms。
 *   3. TTS onProgress 回调返回 0 会立即终止原生生成 —— 配合 res 'close'
 *      事件，客户端一打断就停止合成，不浪费 CPU。
 *   4. 服务启动即预热（合成一句话 + 识别一段静音），模型加载与首帧开销
 *      全部挡在启动阶段，第一个真实请求不吃冷启动。
 *   5. 任何一步失败都会把对应引擎标记为不可用并写明原因，server.js 自动
 *      回退云端（若配置了 Key），服务不会挂。
 *
 * ⚠️ 依赖真实 Node 运行时（>= 20）。Electron 内置 Node（V8 版本号带
 *    electron 字样）会拒绝原生 external buffer，导致合成/识别失败 ——
 *    scripts/start.ps1 已自动挑选真正的 node。
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ---------- 环境变量读取 ----------
function envStr(name, def = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? def : String(v).trim();
}
function envNum(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function resolveModelPath(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

// ASR（SenseVoice）
const ASR_DIR = resolveModelPath(envStr('SHERPA_ASR_MODEL_DIR', 'models/asr/sense-voice'));
const ASR_MODEL_FILE = envStr('SHERPA_ASR_MODEL_FILE', 'model.int8.onnx');
const ASR_TOKENS_FILE = envStr('SHERPA_ASR_TOKENS', 'tokens.txt');
const ASR_NUM_THREADS = envNum('SHERPA_ASR_NUM_THREADS', 4);
const ASR_LANGUAGE = envStr('SHERPA_ASR_LANGUAGE', ''); // '' 自动；可 zh/en/ja/ko/yue

// TTS（默认 matcha-zh-baker；可切回 vits-melo）
const TTS_MODEL_TYPE = envStr('SHERPA_TTS_MODEL_TYPE', 'matcha').toLowerCase(); // 'matcha' | 'vits'
const TTS_DIR = resolveModelPath(envStr('SHERPA_TTS_MODEL_DIR', 'models/tts/matcha-zh-baker/matcha-icefall-zh-baker'));
const TTS_MODEL_FILE = envStr('SHERPA_TTS_MODEL_FILE', 'model-steps-3.onnx'); // matcha: model-steps-3.onnx；vits: model.onnx
const TTS_VOCODER = resolveModelPath(envStr('SHERPA_TTS_VOCODER', 'models/tts/matcha-zh-baker/vocos-22khz-univ.onnx')); // matcha 专用声码器
const TTS_LEXICON_FILE = envStr('SHERPA_TTS_LEXICON', 'lexicon.txt');
const TTS_TOKENS_FILE = envStr('SHERPA_TTS_TOKENS', 'tokens.txt');
const TTS_DICT_DIR = envStr('SHERPA_TTS_DICT_DIR', 'dict'); // jieba 分词目录（中文多音字）
const TTS_RULE_FSTS = envStr('SHERPA_TTS_RULE_FSTS', 'number.fst,phone.fst,date.fst,new_heteronym.fst');
const TTS_NUM_THREADS = envNum('SHERPA_TTS_NUM_THREADS', 4);
const TTS_MAX_SENTENCES = Number(process.env.SHERPA_TTS_MAX_SENTENCES) === -1
  ? -1
  : envNum('SHERPA_TTS_MAX_SENTENCES', 1); // 按句出音频，首块延迟最低
const TTS_SID = Number.isFinite(Number(process.env.SHERPA_TTS_SID))
  ? Number(process.env.SHERPA_TTS_SID)
  : 0;
// 输出增益：默认 1.0（模型原生响度）。个别模型（如 matcha）天生偏响约 10dB，
// 若觉得"炸麦"可在 .env 设 SHERPA_TTS_GAIN=0.4 左右压到 melo 水平
const TTS_GAIN = envNum('SHERPA_TTS_GAIN', 1.0);
const TTS_WARMUP_TEXT = envStr('SHERPA_TTS_WARMUP_TEXT', '你好，语音服务已经就绪了。');

// ---------- 引擎状态 ----------
const state = {
  loaded: false, // addon 是否成功加载
  loadError: null,
  asr: null,
  asrReady: false,
  asrError: null,
  tts: null,
  ttsReady: false,
  ttsError: null,
  ttsSampleRate: 0,
  ttsLock: Promise.resolve(), // TTS 请求串行化（单引擎不支持并发合成）
};

let sherpa = null;
try {
  sherpa = (await import('sherpa-onnx-node')).default;
  if (!sherpa || typeof sherpa.OfflineTts !== 'function') throw new Error('sherpa-onnx-node 加载异常');
  state.loaded = true;
} catch (e) {
  state.loadError = e.message;
}

function fileExists(...segs) {
  return fs.existsSync(path.join(...segs));
}

// ---------- 初始化 ----------
export async function initSherpa({ log = console } = {}) {
  if (!state.loaded) {
    const msg = `sherpa-onnx-node 加载失败：${state.loadError}（本地引擎不可用，将回退云端）`;
    log.warn?.(msg) ?? log.log(`[sherpa] ⚠️ ${msg}`);
    return state;
  }

  // ----- ASR -----
  try {
    const modelFile = path.join(ASR_DIR, ASR_MODEL_FILE);
    const tokensFile = path.join(ASR_DIR, ASR_TOKENS_FILE);
    if (!fileExists(modelFile)) throw new Error(`模型文件不存在: ${modelFile}`);
    if (!fileExists(tokensFile)) throw new Error(`tokens 文件不存在: ${tokensFile}`);

    const t0 = Date.now();
    state.asr = await sherpa.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: modelFile,
          language: ASR_LANGUAGE,
          useInverseTextNormalization: 1,
        },
        tokens: tokensFile,
        numThreads: ASR_NUM_THREADS,
        provider: 'cpu',
        debug: 0,
      },
    });
    state.asrReady = true;
    log.log(`[sherpa] ✅ ASR 就绪：SenseVoice(int8) @ ${path.relative(ROOT, ASR_DIR)}（init ${Date.now() - t0}ms, threads=${ASR_NUM_THREADS}）`);
  } catch (e) {
    state.asrError = e.message;
    log.log(`[sherpa] ⚠️ ASR 初始化失败：${e.message}（将回退云端）`);
  }

  // ----- TTS -----
  try {
    const tokensFile = path.join(TTS_DIR, TTS_TOKENS_FILE);
    if (!fileExists(tokensFile)) throw new Error(`tokens 文件不存在: ${tokensFile}`);
    const lexiconFile = path.join(TTS_DIR, TTS_LEXICON_FILE);
    const dictDir = path.join(TTS_DIR, TTS_DICT_DIR);

    // 按模型类型拼装 model 配置：matcha（声学+声码器）或 vits
    let engineLabel = '';
    let modelInner;
    if (TTS_MODEL_TYPE === 'matcha') {
      const acousticFile = path.join(TTS_DIR, TTS_MODEL_FILE);
      if (!fileExists(acousticFile)) throw new Error(`声学模型文件不存在: ${acousticFile}`);
      if (!fileExists(TTS_VOCODER)) throw new Error(`声码器文件不存在: ${TTS_VOCODER}`);
      const mc = { acousticModel: acousticFile, vocoder: TTS_VOCODER, tokens: tokensFile, dataDir: '' };
      if (TTS_LEXICON_FILE && fileExists(lexiconFile)) mc.lexicon = lexiconFile;
      if (TTS_DICT_DIR && fs.existsSync(dictDir)) mc.dictDir = dictDir;
      modelInner = { matcha: mc };
      engineLabel = 'matcha-zh-baker';
    } else {
      const modelFile = path.join(TTS_DIR, TTS_MODEL_FILE);
      if (!fileExists(modelFile)) throw new Error(`模型文件不存在: ${modelFile}`);
      const vc = { model: modelFile, tokens: tokensFile, dataDir: '' };
      if (TTS_LEXICON_FILE && fileExists(lexiconFile)) vc.lexicon = lexiconFile;
      if (TTS_DICT_DIR && fs.existsSync(dictDir)) vc.dictDir = dictDir;
      modelInner = { vits: vc };
      engineLabel = 'vits-melo-zh_en';
    }

    const ruleFsts = TTS_RULE_FSTS
      ? TTS_RULE_FSTS.split(',').map((s) => s.trim()).filter(Boolean)
        .map((f) => (path.isAbsolute(f) ? f : path.join(TTS_DIR, f)))
        .filter((f) => fs.existsSync(f))
        .join(',')
      : '';

    const t0 = Date.now();
    state.tts = await sherpa.OfflineTts.createAsync({
      model: { ...modelInner, numThreads: TTS_NUM_THREADS, provider: 'cpu', debug: 0 },
      ruleFsts,
      maxNumSentences: TTS_MAX_SENTENCES,
    });
    state.ttsReady = true;
    state.ttsSampleRate = state.tts.sampleRate;
    log.log(
      `[sherpa] ✅ TTS 就绪：${engineLabel} @ ${path.relative(ROOT, TTS_DIR)}（init ${Date.now() - t0}ms, threads=${TTS_NUM_THREADS}, maxSentences=${TTS_MAX_SENTENCES}, sr=${state.ttsSampleRate}）`
    );
  } catch (e) {
    state.ttsError = e.message;
    log.log(`[sherpa] ⚠️ TTS 初始化失败：${e.message}（将回退云端）`);
  }

  return state;
}

// ---------- 预热（同时验证 external buffer 等运行时兼容性） ----------
export async function warmup({ log = console } = {}) {
  if (state.ttsReady) {
    try {
      const t0 = Date.now();
      await synthesizeStream(TTS_WARMUP_TEXT, { speed: 1.0 });
      log.log(`[sherpa] 🔥 TTS 预热完成（${Date.now() - t0}ms），首个真实请求无冷启动`);
    } catch (e) {
      state.ttsReady = false;
      state.ttsError = `预热失败：${e.message}`;
      log.log(`[sherpa] ⚠️ TTS 预热失败：${e.message}`);
      if (/external buffer/i.test(e.message)) {
        log.log('[sherpa] 💡 当前 Node 是 Electron 内置运行时，无法使用 sherpa 原生引擎。请用真正的 node 启动（npm start 已自动处理），例如 D:\\Nodejs\\node.exe server/server.js');
      }
    }
  }
  if (state.asrReady) {
    try {
      const silence = new Float32Array(9600); // 0.6s @16kHz 静音
      const t0 = Date.now();
      await transcribeSamples(silence, 16000);
      log.log(`[sherpa] 🔥 ASR 预热完成（${Date.now() - t0}ms）`);
    } catch (e) {
      state.asrReady = false;
      state.asrError = `预热失败：${e.message}`;
      log.log(`[sherpa] ⚠️ ASR 预热失败：${e.message}`);
    }
  }
  return state;
}

// ---------- 状态查询 ----------
export function sherpaStatus() {
  return {
    loaded: state.loaded,
    asrReady: state.asrReady,
    asrError: state.asrError,
    ttsReady: state.ttsReady,
    ttsError: state.ttsError,
    ttsSampleRate: state.ttsSampleRate,
    asrModelDir: path.relative(ROOT, ASR_DIR),
    ttsModelDir: path.relative(ROOT, TTS_DIR),
  };
}

// ---------- ASR ----------
async function transcribeSamples(samples, sampleRate) {
  const stream = state.asr.createStream();
  stream.acceptWaveform({ samples, sampleRate });
  await state.asr.decodeAsync(stream);
  const result = state.asr.getResult(stream);
  return (result.text || '').trim();
}

/**
 * 识别一个 WAV 文件（Buffer）。
 * 支持 PCM 16bit / Float32，单/多声道，任意采样率（sherpa 内部会重采样）。
 * @returns {Promise<string>} 识别文本（可能为空字符串）
 */
export async function transcribeWav(buffer) {
  if (!state.asrReady) throw new Error(state.asrError || '本地 ASR 未就绪');
  const { samples, sampleRate } = decodeWav(buffer);
  if (!samples.length) return '';
  return transcribeSamples(samples, sampleRate);
}

// ---------- TTS ----------
function withTtsLock(fn) {
  const prev = state.ttsLock;
  let release;
  state.ttsLock = new Promise((r) => (release = r));
  return (async () => {
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  })();
}

/**
 * 流式合成：每生成一块就回调 onChunk(int16 PCM Buffer)。
 * shouldStop() 返回 true 时立即终止原生生成（客户端打断场景）。
 * @returns {Promise<{sampleRate:number, samples:number}>}
 */
export function synthesizeStream(text, { speed = 1.0, sid = TTS_SID, onChunk, shouldStop } = {}) {
  if (!state.ttsReady) return Promise.reject(new Error(state.ttsError || '本地 TTS 未就绪'));
  return withTtsLock(async () => {
    let total = 0;
    const audio = await state.tts.generateAsync({
      text,
      sid,
      speed,
      onProgress: (info) => {
        if (shouldStop && shouldStop()) return 0; // 通知原生层终止
        const pcm = float32ToInt16(info.samples);
        if (pcm.length && onChunk) {
          total += pcm.length / 2;
          onChunk(pcm);
        }
        return 1; // 继续生成
      },
    });
    // 中断时 native 不再回调，剩余音频直接丢弃
    if (shouldStop && shouldStop()) return { sampleRate: state.ttsSampleRate, samples: total };
    // 兜底：个别版本回调不触发时一次性吐出（正常路径 samples 已在回调中发完）
    if (total === 0 && audio.samples.length) {
      const pcm = float32ToInt16(audio.samples);
      if (onChunk) onChunk(pcm);
      total += pcm.length / 2;
    }
    return { sampleRate: state.ttsSampleRate, samples: total };
  });
}

/**
 * 一次性合成整段音频并打包成 WAV Buffer（供 format=wav 的调用方，如 speak.ps1）。
 */
export function synthesizeWav(text, { speed = 1.0, sid = TTS_SID } = {}) {
  if (!state.ttsReady) return Promise.reject(new Error(state.ttsError || '本地 TTS 未就绪'));
  return withTtsLock(async () => {
    const audio = await state.tts.generateAsync({ text, sid, speed });
    const pcm = float32ToInt16(audio.samples);
    return { buffer: wrapWav(pcm, audio.sampleRate), sampleRate: audio.sampleRate };
  });
}

// ---------- 音频工具 ----------
function float32ToInt16(f32) {
  const n = f32.length;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    // 施加输出增益，把过响模型（如 matcha）压到 melo 水平，避免"炸麦"
    let s = f32[i] * TTS_GAIN;
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    buf.writeInt16LE(Math.round(s * (s < 0 ? 32768 : 32767)), i * 2);
  }
  return buf;
}

function wrapWav(pcmBuf, sampleRate, channels = 1, bits = 16) {
  const header = Buffer.alloc(44);
  const dataLen = pcmBuf.length;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28); // byte rate
  header.writeUInt16LE((channels * bits) / 8, 32); // block align
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuf]);
}

/**
 * 解析 WAV（Buffer）→ { samples: Float32Array, sampleRate }
 * 支持 PCM16 / Float32，多声道取平均。
 */
export function decodeWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件');
  }
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2); // chunk 按字对齐
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt/data 块');

  const { format, channels, bits } = fmt;
  const sampleRate = fmt.sampleRate;
  const bytesPerSample = bits / 8;
  const frames = Math.floor(data.length / (bytesPerSample * channels));
  const samples = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytesPerSample;
      if (format === 3 && bits === 32) acc += data.readFloatLE(p);
      else if (format === 1 && bits === 16) acc += data.readInt16LE(p) / 32768;
      else if (format === 1 && bits === 8) acc += (data.readUInt8(p) - 128) / 128;
      else if (format === 1 && bits === 32) acc += data.readInt32LE(p) / 2147483648;
      else if (format === 1 && bits === 24) acc += readInt24(data, p) / 8388608;
      else throw new Error(`不支持的 WAV 编码：format=${format} bits=${bits}`);
    }
    samples[i] = acc / channels;
  }
  return { samples, sampleRate };
}

function readInt24(buf, p) {
  const v = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
  return v & 0x800000 ? v | (~0xffffff) : v;
}
