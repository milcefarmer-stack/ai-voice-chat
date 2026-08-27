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
句级切分 → /api/tts ──► 硅基流动 CosyVoice2 自然中文语音播放
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
| **低延迟** | TTS 走**流式 PCM**（首块音频约 0.2~0.6s，非流式 mp3 要 2.4s）+ VAD 说完 0.5s 即判结束 + LLM SSE 流式 |
| **无 CDN 依赖** | VAD 的 ONNX 模型 + onnxruntime WASM 全部本地化到 `public/vendor/` |

## 快速开始

### 0. 一键安装（Windows 推荐）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

自动完成：环境检查 → `npm install`（含 VAD 资源生成）→ 生成 `.env` → 安装 Python 录音依赖 → 把 `voice-chat` skill 装进 Claude Code / agent → 启动服务。

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

### 3. 启动 / 停止（服务管理）

```bash
npm start       # 启动（后台运行，若端口被占自动先杀旧实例，可反复复用）
npm run stop    # 停止（按 .server.pid + 端口双保险杀进程，不留孤儿）
npm run restart # 重启
npm run dev     # 前台调试模式（带日志输出，Ctrl+C 退出）
```

看到 `✅ 服务已启动: http://localhost:3000` 即可。进程 PID 记录在 `.server.pid`（已 gitignore）。

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
| `TTS_SPEED` | `1.0` | 默认语速（0.25~4.0）；页面上的语速选择器可随时覆盖 |
| `PORT` | `3000` | 服务端口 |

## 给 Claude Code / agent 用（voice-chat skill）

本仓库自带 `skill/voice-chat`——一个让 agent 具备**发声 + 收音**能力的 skill（安装脚本会自动装进 `~/.claude/skills` 和 `~/.agents/skills`）。

在 Claude Code 里直接说：

- **"把这段话读出来"** → agent 运行 `speak.ps1`，用 CosyVoice2 自然中文音色朗读
- **"用语音问我一个问题，等我说完再继续"** → `speak.ps1` 提问 → `listen.py` 录音识别 → 拿到你的口头回答继续干活
- **"语音回复我"** → 完成工作后播报结果

skill 结构：

```
skill/voice-chat/
├── SKILL.md              # 触发说明 + 使用指引
├── scripts/
│   ├── speak.ps1         # 文本 → TTS → 播放（支持 -Text / -TextFile / 管道）
│   ├── listen.py         # 录音 → ASR → 输出文字（按回车结束）
│   └── status.ps1        # 检查/启动服务（读 appdir.txt 定位应用）
└── references/api.md     # 后端 API 文档
```

## 常见问题

**Q: AI 回答慢？**
本项目已做全套低延迟优化：
1. **非 thinking 模型**（DeepSeek-V3 无思维链，首 token 快）；
2. **LLM SSE 流式** + **句级切分**，第一句完成立即合成；
3. **TTS 流式 PCM**（`stream:true` + Web Audio 边收边播）——首块音频约 **0.2~0.6 秒**（非流式 mp3 实测 2.4 秒）；
4. **VAD 快速端点**——说完静音 0.5s 即判定结束（默认 1.4s，省近 1 秒）。

实测一轮"说完话 → 听到回答"的语音首字延迟通常在 1~2 秒内（ASR 0.3~0.8s + LLM 首 token 0.3~0.8s + TTS 首块 0.2~0.6s，多段流水线重叠）。

**Q: 识别出错（network / service-not-allowed）？**
那是浏览器自带识别（Chrome 走 Google，国内不可用）。本项目默认走**录音上传识别**（硅基流动 XingChenASR），国内稳定。若仍报错，确认 `.env` 里 `LLM_API_KEY` 已配置。

**Q: VAD 没反应？**
确认浏览器允许了麦克风权限；检查顶部"聆听中"指示灯是否亮着（绿点闪烁）。若被暂停，点「▶ 开始聆听」。

**Q: 换 TTS 音色？**
把 `TTS_VOICE` 换成 `FunAudioLLM/CosyVoice2-0.5B:{alex|bella|anna|david}` 之一即可（当前默认 bella）。换模型（如 MOSS-TTSD）时注意：MOSS 是对话模型，对短句（如"好的"）会合成出乱码，不推荐用于流式对话。

**Q: 怎么调语速？**
页面上「语速」下拉框直接调（0.6 慢 ~ 1.5 快），即时生效并记住选择；也可以改 `.env` 的 `TTS_SPEED`（0.25~4.0）设默认值。语速通过重新合成实现，无音调失真。

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
