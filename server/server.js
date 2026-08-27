/**
 * AI 语音对话 - 后端服务
 *
 * 职责：
 *   1. 提供静态页面（public/）
 *   2. POST /api/chat        —— 完整回答（非流式）
 *   3. POST /api/chat/stream —— 流式回答（SSE，逐字下发，可随时断开实现打断）
 *   4. POST /api/asr         —— 接收录音，转发硅基流动 ASR，返回文字
 *   5. POST /api/tts         —— 文本转语音（硅基流动 MOSS-TTSD，自然中文音色），返回 mp3
 *   6. GET  /api/config      —— 返回 LLM / ASR / TTS 配置状态
 *
 * LLM 支持三种来源，通过 .env 切换：
 *   - 本地 Ollama（LLM_API_KEY 留空，自动连 http://localhost:11434）
 *   - DeepSeek / OpenAI / 硅基流动 / 其他任意 OpenAI 兼容服务
 *
 * ASR / TTS 默认复用 LLM_API_KEY（硅基流动），模型可用 .env 更换。
 * 注意：语音对话请使用【非 thinking】模型（如 deepseek-ai/DeepSeek-V3），
 *       thinking 模型（R1 / Qwen3 默认）回答前会输出思维链，响应很慢。
 */
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

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

// ---------- TTS（语音合成）配置 ----------
const TTS_API_KEY = (process.env.TTS_API_KEY || LLM_API_KEY).trim();
const TTS_BASE_URL = (process.env.TTS_BASE_URL || LLM_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
// CosyVoice2：专业 TTS，短句也正常；MOSS-TTSD 是对话模型，短句会乱说，不推荐
const TTS_MODEL = process.env.TTS_MODEL || 'FunAudioLLM/CosyVoice2-0.5B';
const TTS_VOICE = process.env.TTS_VOICE || 'FunAudioLLM/CosyVoice2-0.5B:bella';
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) > 0 ? Number(process.env.TTS_TIMEOUT_MS) : 30000;
const ttsAvailable = Boolean(TTS_API_KEY);

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
  res.json({
    baseUrl: LLM_BASE_URL,
    model: LLM_MODEL,
    hasKey: Boolean(LLM_API_KEY),
    useOllama: !LLM_API_KEY,
    asrProvider: asrAvailable ? 'siliconflow' : 'browser',
    asrModel: ASR_MODEL,
    ttsAvailable,
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
  if (!ttsAvailable) {
    return res.status(500).json({ error: '未配置 TTS：请在 .env 中配置 TTS_API_KEY（或 LLM_API_KEY，硅基流动 Key 通用）' });
  }

  const wantStream = stream === true;
  // 输出格式：默认流式 pcm；非流式可用 format 指定 wav / mp3（speak 脚本用 wav 直接播放）
  const fmt = ['mp3', 'wav', 'pcm'].includes(req.body.format) ? req.body.format : wantStream ? 'pcm' : 'mp3';
  const body = {
    model: TTS_MODEL,
    voice: TTS_VOICE,
    input: t.slice(0, 200), // 单次合成限长
    response_format: fmt,
    speed: clampSpeed(req.body.speed !== undefined ? req.body.speed : TTS_SPEED), // 语速 0.25~4.0
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

// ---------- 语音识别（ASR）：接收录音并转发给硅基流动 ----------
app.post('/api/asr', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: `上传失败: ${err.message}` });
    if (!asrAvailable) {
      return res.status(500).json({ error: '未配置语音识别：请在 .env 中配置 ASR_API_KEY（或 LLM_API_KEY，硅基流动 Key 通用）' });
    }
    if (!req.file) return res.status(400).json({ error: '缺少音频文件（字段名应为 file）' });

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

app.listen(PORT, () => {
  console.log(`✅ AI 语音对话已启动: http://localhost:${PORT}`);
  console.log(`   LLM: ${LLM_BASE_URL} / ${LLM_MODEL}${LLM_API_KEY ? '（已配置 Key）' : '（未配置 Key → 尝试本地 Ollama）'}`);
  console.log(
    `   ASR: ${asrAvailable ? `${ASR_BASE_URL} / ${ASR_MODEL}` : '未配置，回退到浏览器语音识别（Chrome/Edge）'}`
  );
  console.log(`   TTS: ${ttsAvailable ? `${TTS_BASE_URL} / ${TTS_MODEL} / ${TTS_VOICE}` : '未配置（使用浏览器语音合成）'}`);
});
