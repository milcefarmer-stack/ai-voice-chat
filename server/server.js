/**
 * AI 语音对话 - 后端服务
 *
 * 职责：
 *   1. 提供静态页面（public/）
 *   2. POST /api/chat        —— 完整回答（非流式）
 *   3. POST /api/chat/stream —— 流式回答（SSE，逐字下发，可随时断开实现打断）
 *   4. POST /api/asr         —— 接收录音并识别（默认本地 sherpa-onnx SenseVoice，可回退云端）
 *   5. POST /api/tts         —— 文本转语音（默认本地 sherpa-onnx vits-melo 流式 PCM，可回退云端）
 *   6. GET  /api/config      —— 返回 LLM / ASR / TTS 配置状态
 *
 * LLM 支持三种来源，通过 .env 切换：
 *   - 本地 Ollama（LLM_API_KEY 留空，自动连 http://localhost:11434）
 *   - DeepSeek / OpenAI / 硅基流动 / 其他任意 OpenAI 兼容服务
 *
 * ASR / TTS 默认本地离线（sherpa-onnx，无网络延迟、免 Key、免限额）；
 *   - ASR_PROVIDER=TTS_PROVIDER=auto：本地就绪则用本地，否则/失败时回退云端
 *   - 配置为 cloud 则完全走云端（硅基流动，复用 LLM_API_KEY）
 * 注意：语音对话请使用【非 thinking】模型（如 deepseek-ai/DeepSeek-V3），
 *       thinking 模型（R1 / Qwen3 默认）回答前会输出思维链，响应很慢。
 */
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { initSherpa, warmup, sherpaStatus, transcribeWav, synthesizeStream, synthesizeWav } from './sherpa.js';
import { listHistory, getHistory, saveHistory, deleteHistory } from './history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- LLM 配置 ----------
const LLM_API_KEY = (process.env.LLM_API_KEY || '').trim();
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'qwen2.5:7b';
const LLM_MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS) > 0 ? Number(process.env.LLM_MAX_TOKENS) : 200;
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) > 0 ? Number(process.env.LLM_TIMEOUT_MS) : 90000;
const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  '你是一个友好的语音助手，请用简洁、口语化的中文回答，单次回答不超过 100 字。不要使用表情符号、Markdown 标记或特殊符号。';

// ---------- ASR（语音识别）配置 ----------
// 默认复用 LLM 的 Key 与地址（硅基流动），也可单独指定
const ASR_API_KEY = (process.env.ASR_API_KEY || LLM_API_KEY).trim();
const ASR_BASE_URL = (process.env.ASR_BASE_URL || LLM_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
const ASR_MODEL = process.env.ASR_MODEL || 'XingChenAGI/XingChenASR-V3.2-Ultra';
const ASR_TIMEOUT_MS = Number(process.env.ASR_TIMEOUT_MS) > 0 ? Number(process.env.ASR_TIMEOUT_MS) : 60000;
const asrAvailable = Boolean(ASR_API_KEY);

// ASR 提供方：auto（默认，本地就绪则本地，否则/失败回退云端）/ local / cloud
const ASR_PROVIDER = (process.env.ASR_PROVIDER || 'auto').toLowerCase();

// ---------- TTS（语音合成）配置 ----------
const TTS_API_KEY = (process.env.TTS_API_KEY || LLM_API_KEY).trim();
const TTS_BASE_URL = (process.env.TTS_BASE_URL || LLM_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
// CosyVoice2：专业 TTS，短句也正常；MOSS-TTSD 是对话模型，短句会乱说，不推荐
const TTS_MODEL = process.env.TTS_MODEL || 'FunAudioLLM/CosyVoice2-0.5B';
const TTS_VOICE = process.env.TTS_VOICE || 'FunAudioLLM/CosyVoice2-0.5B:bella';
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) > 0 ? Number(process.env.TTS_TIMEOUT_MS) : 30000;
const ttsAvailable = Boolean(TTS_API_KEY);

// TTS 提供方：auto（默认）/ local / cloud，语义同 ASR_PROVIDER
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'auto').toLowerCase();

// 默认语速（0.25 ~ 4.0，1.0 为正常），前端也可每次请求单独指定
function clampSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1.0;
  return Math.min(4.0, Math.max(0.25, n));
}
const TTS_SPEED = clampSpeed(process.env.TTS_SPEED || 1.0);

// ---------- 静态资源 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json({ limit: '1mb' }));

// 录音文件上传（内存存储，最多 25MB）
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ---------- 当前配置状态 ----------
app.get('/api/config', (_req, res) => {
  const st = sherpaStatus();
  // 实际生效的提供方（auto 模式下取决于本地引擎是否就绪）
  const asrEffective = ASR_PROVIDER === 'cloud' || !st.asrReady
    ? (asrAvailable ? 'siliconflow' : 'browser')
    : 'local-sherpa';
  const ttsEffective = TTS_PROVIDER === 'cloud' || !st.ttsReady
    ? (ttsAvailable ? 'siliconflow' : 'none')
    : 'local-sherpa';
  res.json({
    baseUrl: LLM_BASE_URL,
    model: LLM_MODEL,
    hasKey: Boolean(LLM_API_KEY),
    useOllama: !LLM_API_KEY,
    asrProvider: asrEffective,
    asrModel: ASR_MODEL,
    asrLocalReady: st.asrReady,
    asrLocalError: st.asrError,
    ttsAvailable: ttsEffective !== 'none',
    ttsProvider: ttsEffective,
    ttsLocalReady: st.ttsReady,
    ttsLocalError: st.ttsError,
    ttsSampleRate: st.ttsSampleRate || null,
    ttsModel: TTS_MODEL,
    ttsVoice: TTS_VOICE,
  });
});

// ---------- 转发给 LLM ----------
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 必须是非空数组' });
  }

  // 只保留最近的 20 条，防止上下文过长
  const history = messages.slice(-20);
  const payload = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    stream: false,
    max_tokens: LLM_MAX_TOKENS, // 限制回答长度，加快响应（thinking 模型此项包含思维链，语音场景请勿用 thinking 模型）
  };

  const headers = { 'Content-Type': 'application/json' };
  if (LLM_API_KEY) headers.Authorization = `Bearer ${LLM_API_KEY}`;

  try {
    const resp = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS), // 超时保护，防止一直卡住
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(resp.status).json({ error: `LLM 返回 ${resp.status}: ${text.slice(0, 300)}` });
    }

    const data = await resp.json();
    const reply = data.choices?.[0]?.message?.content ?? '';
    if (!reply) return res.status(502).json({ error: 'LLM 返回内容为空' });

    res.json({ reply });
  } catch (err) {
    res.status(502).json({
      error: `无法连接 LLM（${LLM_BASE_URL}，模型 ${LLM_MODEL}）: ${err.message}。` +
        (LLM_API_KEY
          ? '请检查 .env 中的 LLM_BASE_URL / LLM_API_KEY 是否正确。'
          : '当前未配置 LLM_API_KEY，程序在尝试连接本地 Ollama。请先安装并启动 Ollama 并拉取模型，或在 .env 里配置云端 API。'),
    });
  }
});

// ---------- 流式回答（SSE）：逐字下发，前端可随时断开实现"打断" ----------
app.post('/api/chat/stream', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages 必须是非空数组' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const history = messages.slice(-20);
  const payload = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    stream: true,
    max_tokens: LLM_MAX_TOKENS,
  };

  const headers = { 'Content-Type': 'application/json' };
  if (LLM_API_KEY) headers.Authorization = `Bearer ${LLM_API_KEY}`;

  try {
    const upstream = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      const t = await upstream.text();
      res.write(`data: ${JSON.stringify({ error: `LLM 返回 ${upstream.status}: ${t.slice(0, 200)}` })}\n\n`);
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let content = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta || {};
          if (delta.reasoning_content) continue; // 跳过思维链（thinking 模型的推理过程）
          const c = delta.content || '';
          if (c) {
            content += c;
            res.write(`data: ${JSON.stringify({ content: c })}\n\n`);
          }
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    // 前端主动断开（打断）时 reader 会抛错，这里静默结束
    try {
      res.write(`data: ${JSON.stringify({ error: err.message || '流式请求失败' })}\n\n`);
      res.end();
    } catch {
      /* 连接已断开 */
    }
  }
});

// ---------- 语音合成（TTS）：文本 → 自然中文语音 ----------
// 默认流式模式：响应体为 16bit 单声道 PCM（裸流），前端 Web Audio 边收边播，
// 首块音频延迟约 300ms（非流式 mp3 约 2.4s，实测提升 8 倍）。
// 传 { stream:false } 可退回 mp3 一次性返回。
app.post('/api/tts', async (req, res) => {
  const { text, stream } = req.body || {};
  const t = (text || '').trim();
  if (!t) return res.status(400).json({ error: '缺少文本' });

  const wantStream = stream === true;
  // 输出格式：默认流式 pcm；非流式可用 format 指定 wav / mp3（speak 脚本用 wav 直接播放）
  const fmt = ['mp3', 'wav', 'pcm'].includes(req.body.format) ? req.body.format : wantStream ? 'pcm' : 'mp3';
  const speed = clampSpeed(req.body.speed !== undefined ? req.body.speed : TTS_SPEED); // 语速 0.25~4.0

  // ---------- 本地 sherpa-onnx 合成（首选，完全离线） ----------
  const st = sherpaStatus();
  if (TTS_PROVIDER !== 'cloud' && st.ttsReady) {
    try {
      if (wantStream || fmt === 'pcm') {
        // 流式 PCM：边合成边下发，首块音频延迟 ~0.2s
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-PCM-Sample-Rate', String(st.ttsSampleRate || 44100));
        res.setHeader('Cache-Control', 'no-store');
        res.flushHeaders?.();
        let clientGone = false;
        res.on('close', () => { clientGone = true; });
        await synthesizeStream(t, {
          speed,
          shouldStop: () => clientGone || res.writableEnded, // 打断 → 原生层立即停止生成
          onChunk: (buf) => {
            if (!clientGone && !res.writableEnded) res.write(buf);
          },
        });
        return res.end();
      }
      // 非流式 wav（本地引擎无 mp3 编码器，mp3 请求也返回 wav 容器）
      const { buffer } = await synthesizeWav(t, { speed });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(buffer);
    } catch (e) {
      if (res.headersSent) {
        // 中途失败/客户端已断开，无法再回退云端
        try { res.end(); } catch { /* 忽略 */ }
        return;
      }
      console.error('[tts] 本地合成失败，回退云端：', e.message);
      // 落到下方云端逻辑
    }
  }

  // ---------- 云端合成（回退 / 配置为 cloud 时） ----------
  if (!ttsAvailable) {
    return res.status(500).json({
      error: '本地 TTS 未就绪且未配置云端：请检查 models/tts 模型目录，或在 .env 配置 TTS_API_KEY（或 LLM_API_KEY，硅基流动 Key 通用）',
    });
  }

  const body = {
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: t.slice(0, 200), // 单次合成限长
    response_format: fmt,
    speed,
  };
  if (wantStream) body.sample_rate = 24000; // CosyVoice2 原生采样率

  try {
    const resp = await fetch(`${TTS_BASE_URL}/audio/speech`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TTS_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: `语音合成返回 ${resp.status}: ${errText.slice(0, 300)}` });
    }

    if (wantStream) {
      // 流式 PCM：直接转发上游字节流
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-PCM-Sample-Rate', '24000');
      res.setHeader('Cache-Control', 'no-store');
      for await (const chunk of resp.body) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
      res.end();
    } else {
      const buf = Buffer.from(await resp.arrayBuffer());
      res.setHeader('Content-Type', fmt === 'wav' ? 'audio/wav' : 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buf);
    }
  } catch (e) {
    // 客户端打断/连接断开等情况
    if (!res.headersSent) {
      res.status(502).json({ error: `语音合成请求失败（${TTS_BASE_URL}/audio/speech）: ${e.message}` });
    } else {
      try {
        res.end();
      } catch { /* 连接已断开 */ }
    }
  }
});

// ---------- 语音识别（ASR）：本地 sherpa-onnx 优先，失败回退云端 ----------
app.post('/api/asr', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: `上传失败: ${err.message}` });
    if (!req.file) return res.status(400).json({ error: '缺少音频文件（字段名应为 file）' });

    const st = sherpaStatus();
    const canLocal = ASR_PROVIDER !== 'cloud' && st.asrReady;
    if (!canLocal && !asrAvailable) {
      return res.status(500).json({
        error: '本地 ASR 未就绪且未配置云端：请检查 models/asr 模型目录，或在 .env 配置 ASR_API_KEY（或 LLM_API_KEY，硅基流动 Key 通用）',
      });
    }

    // ---- 本地识别（完全离线，无上传/网络延迟） ----
    if (canLocal) {
      try {
        const t0 = Date.now();
        const text = await transcribeWav(req.file.buffer);
        console.log(`[asr] 本地识别 ${Date.now() - t0}ms："${text.slice(0, 50)}"`);
        return res.json({ text });
      } catch (e) {
        if (!asrAvailable) {
          return res.status(502).json({ error: `本地识别失败：${e.message}` });
        }
        console.error('[asr] 本地识别失败，回退云端：', e.message);
        // 落到下方云端逻辑
      }
    }

    // ---- 云端识别（回退） ----
    try {
      const form = new FormData();
      form.append('model', ASR_MODEL);
      form.append(
        'file',
        new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/wav' }),
        req.file.originalname || 'audio.wav'
      );

      const resp = await fetch(`${ASR_BASE_URL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ASR_API_KEY}` },
        body: form,
        signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
      });

      if (!resp.ok) {
        const text = await resp.text();
        return res.status(resp.status).json({ error: `语音识别返回 ${resp.status}: ${text.slice(0, 300)}` });
      }

      const data = await resp.json();
      const text = (data.text || '').trim();
      // 识别到内容才返回文本；静音/无语音内容时返回空文本，由前端提示"没听清"
      res.json({ text });
    } catch (e) {
      res.status(502).json({
        error: `语音识别请求失败（${ASR_BASE_URL}/audio/transcriptions，模型 ${ASR_MODEL}）: ${e.message}`,
      });
    }
  });
});

// ---------- 历史会话 ----------
app.get('/api/history', (_req, res) => {
  res.json({ sessions: listHistory() });
});

app.get('/api/history/:id', (req, res) => {
  const s = getHistory(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json({ session: s });
});

app.post('/api/history', (req, res) => {
  const { id, title, messages } = req.body || {};
  if (!id) return res.status(400).json({ error: '缺少会话 id' });
  try {
    const session = saveHistory(id, messages, title);
    res.json({ session });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/history/:id', (req, res) => {
  deleteHistory(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  const v8 = process.versions.v8 || '';
  console.log(`✅ AI 语音对话已启动: http://localhost:${PORT}`);
  console.log(`   Node: ${process.version}（v8 ${v8}${v8.includes('electron') ? '，⚠️ Electron 运行时，本地 sherpa 引擎不可用' : ''}）`);
  console.log(`   LLM: ${LLM_BASE_URL} / ${LLM_MODEL}${LLM_API_KEY ? '（已配置 Key）' : '（未配置 Key → 尝试本地 Ollama）'}`);
  console.log(`   ASR: ${ASR_PROVIDER === 'cloud' ? `云端 ${ASR_BASE_URL} / ${ASR_MODEL}` : '本地 sherpa-onnx（优先）→ 云端回退'}`);
  console.log(`   TTS: ${TTS_PROVIDER === 'cloud' ? `云端 ${TTS_MODEL} / ${TTS_VOICE}` : '本地 sherpa-onnx（优先）→ 云端回退'}`);

  // 后台初始化 + 预热本地语音引擎（不阻塞 HTTP 服务）
  (async () => {
    const st = sherpaStatus();
    if (!st.loaded && ASR_PROVIDER !== 'cloud' && TTS_PROVIDER !== 'cloud') {
      console.log(`   ⚠️ sherpa-onnx 未加载：${st.loadError}`);
    }
    await initSherpa();
    await warmup();
    const s2 = sherpaStatus();
    console.log(
      `   语音引擎：ASR ${s2.asrReady ? '✅ 本地就绪' : s2.asrError ? `❌ ${s2.asrError}` : '☁️ 走云端'} · ` +
      `TTS ${s2.ttsReady ? `✅ 本地就绪（${s2.ttsSampleRate}Hz）` : s2.ttsError ? `❌ ${s2.ttsError}` : '☁️ 走云端'}`
    );
  })();
});
