# 🎙️ AI 语音对话（本地运行 · 免点击 · 可打断）

一个完全**本地运行**的 AI 语音对话应用，体验接近真实语音助手：

```
麦克风 ──VAD(Silero, 浏览器本地)──► 检测说话开始/结束（免点击）
   │ 说话结束 → 16kHz 音频
   ▼
本地后端 /api/asr ──► 硅基流动 XingChenASR 识别成文字
   ▼
本地后端 /api/chat/stream ──► 硅基流动 LLM（流式 SSE，逐字返回）
   ▼
句级切分 → /api/tts ──► 硅基流动 MOSS-TTSD 自然中文语音播放
   │
   └─ 你随时开口 → 立即打断 AI（停语音 + 中止流式请求）
```

## 核心特性

| 能力 | 实现 |
|---|---|
| **免点击** | Silero VAD（ONNX，浏览器本地运行）自动检测说话开始/结束，说完整句自动识别 |
| **可打断** | 你开口的瞬间，AI 立即停止说话并中止 LLM 流，开始听你的新指令 |
| **流式回答** | LLM 走 SSE 流式输出，文字逐字显示 |
| **边说边答** | 回答按句子切分，第一句出来就开始合成语音，不用等全文 |
| **自然语音** | 硅基流动 CosyVoice2（专业 TTS，短句也正常，音色自然），替代浏览器"机器人音" |
| **无 CDN 依赖** | VAD 的 ONNX 模型 + onnxruntime WASM 全部本地化到 `public/vendor/` |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 `.env`（硅基流动示例，一个 Key 全搞定）

```bash
Copy-Item .env.example .env   # Windows PowerShell
# cp .env.example .env        # macOS / Linux
```

```ini
LLM_API_KEY=sk-你的硅基流动key
LLM_BASE_URL=https://api.siliconflow.cn/v1
LLM_MODEL=deepseek-ai/DeepSeek-V3        # ⚠️ 必须用非 thinking 模型！

ASR_MODEL=XingChenAGI/XingChenASR-V3.2-Ultra

TTS_MODEL=FunAudioLLM/CosyVoice2-0.5B
TTS_VOICE=FunAudioLLM/CosyVoice2-0.5B:bella   # 可选 alex / bella / anna / david
```

> ⚠️ **模型选择（速度关键）**：语音对话必须用**非 thinking** 模型。
> - `deepseek-ai/DeepSeek-V3`（推荐，无思维链，已实测）
> - ❌ `deepseek-ai/DeepSeek-R1-*`、`Qwen/Qwen3-*`（R1 和 Qwen3 在硅基流动上默认输出思维链，回答前先"想"一大段，非常慢）

其他 LLM 源：本地 Ollama（`LLM_API_KEY` 留空，自动连 `http://localhost:11434`）、DeepSeek 官方、OpenAI 等 OpenAI 兼容服务均可，改 `LLM_BASE_URL` / `LLM_MODEL` 即可。

### 3. 启动

```bash
npm start
```

看到 `✅ AI 语音对话已启动: http://localhost:3000` 即可。

### 4. 使用

1. 浏览器打开 `http://localhost:3000`（Chrome / Edge / Firefox 均可），允许麦克风权限。
2. **直接对着麦克风说话**，说完整句后自动识别并回答（VAD 会自动判断你说完了）。
3. **AI 回答时你开口说话** → AI 立即闭嘴，开始听你的新指令（打断/抢话）。
4. 顶部按钮可暂停/恢复聆听；底部输入框可打字提问。
5. 首次播放语音若被浏览器拦截，点击页面任意位置一次即可。

## 接口说明

| 接口 | 说明 |
|---|---|
| `POST /api/chat` | 完整回答（非流式），`{ messages } → { reply }` |
| `POST /api/chat/stream` | **流式回答（SSE）**：`data: {"content":"..."}` 逐字下发，`data: {"done":true}` 结束；客户端可断开连接实现打断 |
| `POST /api/asr` | 录音（multipart `file`，WAV）→ 硅基流动 ASR → `{ text }` |
| `POST /api/tts` | `{ text }` → MOSS-TTSD 合成 → 返回 mp3 音频 |
| `GET /api/config` | LLM / ASR / TTS 配置状态 |

## 环境变量一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_API_KEY` | - | LLM / ASR / TTS 通用 Key（硅基流动） |
| `LLM_BASE_URL` | `http://localhost:11434/v1` | LLM 地址（无 Key 时自动走 Ollama） |
| `LLM_MODEL` | `qwen2.5:7b` | ⚠️ 语音场景用非 thinking 模型 |
| `LLM_MAX_TOKENS` | `200` | 回答长度上限 |
| `ASR_MODEL` | `XingChenAGI/XingChenASR-V3.2-Ultra` | 语音识别模型 |
| `TTS_MODEL` | `FunAudioLLM/CosyVoice2-0.5B` | 语音合成模型（专业 TTS，短句正常） |
| `TTS_VOICE` | `FunAudioLLM/CosyVoice2-0.5B:bella` | 音色（可选 alex / bella / anna / david） |
| `PORT` | `3000` | 服务端口 |

## 常见问题

**Q: AI 回答慢？**
1. 确认用的是非 thinking 模型（见上文模型选择）；
2. 本方案已做流式 + 句级 TTS，第一句语音通常在 1~2 秒内开始；
3. `LLM_MAX_TOKENS` 默认 200，足够短回答。

**Q: 识别出错（network / service-not-allowed）？**
那是浏览器自带识别（Chrome 走 Google，国内不可用）。本项目默认走**录音上传识别**（硅基流动 XingChenASR），国内稳定。若仍报错，确认 `.env` 里 `LLM_API_KEY` 已配置。

**Q: VAD 没反应？**
确认浏览器允许了麦克风权限；检查顶部"聆听中"指示灯是否亮着（绿点闪烁）。若被暂停，点「▶ 开始聆听」。

**Q: 换 TTS 音色？**
把 `TTS_VOICE` 换成 `FunAudioLLM/CosyVoice2-0.5B:{alex|bella|anna|david}` 之一即可（当前默认 bella）。换模型（如 MOSS-TTSD）时注意：MOSS 是对话模型，对短句（如"好的"）会合成出乱码，不推荐用于流式对话。

**Q: 想要完全离线（不联网）？**
LLM 换 Ollama（本地模型），ASR/TTS 可换本地模型（如 sherpa-onnx 的 SenseVoice + Kokoro/Piper），但中文自然语音的本地方案（CosyVoice/fish-speech）需要显卡与更多配置，属于进阶改造。

## 目录结构

```
ai-voice-chat/
├── server/server.js        # Express：流式 LLM / ASR / TTS / 静态文件
├── public/
│   ├── index.html          # 页面（自动聆听模式）
│   ├── app.js              # VAD 自动对话 + 流式展示 + 句级 TTS + 打断
│   ├── style.css
│   └── vendor/             # 本地化资源（无 CDN 依赖）
│       ├── ort/            # onnxruntime-web（WASM）
│       └── vad/            # Silero VAD ONNX 模型 + 封装
├── .env.example
└── README.md
```
