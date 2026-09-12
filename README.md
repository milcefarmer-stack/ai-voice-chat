# 🎙️ AI 语音对话（本地运行 · 免点击 · 可打断）

一个完全**本地运行**的 AI 语音对话应用，体验接近真实语音助手：

```
麦克风 ──VAD(Silero, 浏览器本地)──► 检测说话开始/结束（免点击）
   │ 说话结束 → 16kHz 音频
   ▼
本地后端 /api/asr ──► sherpa-onnx SenseVoice 本地识别成文字（离线，~0.3s）
   ▼
本地后端 /api/chat/stream ──► LLM（OpenAI 兼容接口，流式 SSE，逐字返回；默认智谱 glm-5.2）
   ▼
首句逗号加速 → /api/tts ──► sherpa-onnx matcha-zh-baker 本地合成（流式 PCM，首块 ~0.2s）
   │
   └─ 你随时开口 → 立即打断 AI（停语音 + 中止流式请求，合成同步终止）
```

## 核心特性

| 能力 | 实现 |
|---|---|
| **免点击** | Silero VAD（ONNX，浏览器本地运行）自动检测说话开始/结束，说完整句自动识别 |
| **离线语音引擎** | ASR/TTS 全部本地（sherpa-onnx，借鉴 Open-LLM-VTuber）：无网络往返、不耗云端额度、识别合成恒定低延迟；模型缺失/加载失败自动回退云端 |
| **可打断（只说别吵）** | 你开口的瞬间，AI **立即停止语音播报**，同时服务端立刻终止合成（省 CPU）；思考/生成继续（气泡里写完）；你的新语音自动排队，等当前轮思考完再处理 |
| **流式回答** | LLM 走 SSE 流式输出，文字逐字显示 |
| **边说边答** | 回答按句子切分，第一句出来就开始合成语音，不用等全文；**首句逗号加速**——第一句不等句末标点，遇逗号立即开口 |
| **自然语音** | 本地 matcha-zh-baker 中文女声（baker 普通话音色）；vits-melo 音色可选；云端 CosyVoice2 作为回退 |
| **历史对话** | 自动保存每次会话（服务端 JSON 持久化，无需数据库）；「📚 历史」可回看、加载、删除；刷新页面自动恢复上次对话 |
| **低延迟** | 本地 ASR ~0.3s + LLM SSE 流式 + 首句逗号加速 + TTS 首块 ~0.2s，多段流水线重叠 |
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

### 2. 配置 `.env`（默认智谱 GLM 示例）

```bash
Copy-Item .env.example .env   # Windows PowerShell
# cp .env.example .env        # macOS / Linux
```

```ini
LLM_API_KEY=你的智谱key                  # https://open.bigmodel.cn 获取
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=glm-5.2                        # ⚠️ 必须用非 thinking 模型！

# 语音默认走本地 sherpa-onnx 离线引擎（见下文），零额度零延迟；
# 云端 ASR/TTS 仅作为本地模型缺失时的回退，回退目标默认硅基流动：
# ASR_BASE_URL=https://api.siliconflow.cn/v1
# TTS_BASE_URL=https://api.siliconflow.cn/v1
```

> ⚠️ **模型选择（速度关键）**：语音对话必须用**非 thinking** 模型。
> - ❌ `deepseek-ai/DeepSeek-R1-*`、`Qwen/Qwen3-*` 等推理模型（回答前先跑思维链，非常慢）
> - ⚠️ **LLM 用智谱等非硅基流动服务时**，云端回退用的 ASR/TTS 是硅基流动的模型，需在 `.env` 单独配 `ASR_API_KEY` / `TTS_API_KEY`（硅基流动 Key），否则云端回退不可用

其他 LLM 源：本地 Ollama（`LLM_API_KEY` 留空，自动连 `http://localhost:11434`）、硅基流动、DeepSeek 官方、OpenAI 等 OpenAI 兼容服务均可，改 `LLM_BASE_URL` / `LLM_MODEL` 即可。

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
| `POST /api/asr` | 录音（multipart `file`，WAV）→ 本地 sherpa-onnx 识别 → `{ text }`（失败自动回退云端） |
| `POST /api/tts` | `{ text }` → 本地 sherpa-onnx 流式合成 → PCM/WAV 音频（失败自动回退云端） |
| `GET /api/config` | LLM / ASR / TTS 配置状态（含本地引擎就绪状态） |
| `GET /api/history` | 历史会话列表（标题 / 时间 / 条数，按更新时间倒序） |
| `GET /api/history/:id` | 读取单个会话的完整消息 |
| `POST /api/history` | 保存 / 更新会话 `{ id, messages, title? }` |
| `DELETE /api/history/:id` | 删除指定会话 |

## 环境变量一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_API_KEY` | - | LLM Key（默认示例为智谱；留空自动尝试本地 Ollama） |
| `LLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | LLM 地址（任意 OpenAI 兼容服务） |
| `LLM_MODEL` | `glm-5.2` | ⚠️ 语音场景用非 thinking 模型 |
| `LLM_MAX_TOKENS` | `1000` | 回答长度上限 |
| `ASR_MODEL` | `XingChenAGI/XingChenASR-V3.2` | 云端语音识别模型（仅回退时使用） |
| `ASR_API_KEY` / `ASR_BASE_URL` | 取 `LLM_API_KEY` / `LLM_BASE_URL` | 云端 ASR 的 Key/地址；LLM 非硅基流动时需单独指定（硅基流动） |
| `TTS_MODEL` | `FunAudioLLM/CosyVoice2-0.5B` | 云端语音合成模型（专业 TTS，短句正常） |
| `TTS_VOICE` | `FunAudioLLM/CosyVoice2-0.5B:bella` | 云端音色（可选 alex / bella / anna / david） |
| `TTS_API_KEY` / `TTS_BASE_URL` | 取 `LLM_API_KEY` / `LLM_BASE_URL` | 云端 TTS 的 Key/地址；LLM 非硅基流动时需单独指定（硅基流动） |
| `TTS_SPEED` | `1.0` | 默认语速（0.25~4.0）；页面上的语速选择器可随时覆盖 |
| `ASR_PROVIDER` / `TTS_PROVIDER` | `local` | `auto`（本地优先失败回退云端）/ `local` / `cloud` |
| `SHERPA_TTS_MODEL_TYPE` | `matcha` | `matcha`（baker 音色）/ `vits`（melo 音色） |
| `SHERPA_TTS_GAIN` | `1.0` | 本地 TTS 音量增益（matcha 天生偏响，可设 0.4 压到 melo 水平） |
| `PORT` | `3000` | 服务端口 |

其余 sherpa 细节参数（模型目录/线程数/按句合成等）见 [.env.example](.env.example) 注释。

## 给 Claude Code / agent 用（voice-chat skill）

本仓库自带 `skill/voice-chat`——一个让 agent 具备**发声 + 收音**能力的 skill（安装脚本会自动装进 `~/.claude/skills` 和 `~/.agents/skills`）。

在 Claude Code 里直接说：

- **"把这段话读出来"** → agent 运行 `speak.ps1`，用本地 baker 音色自然朗读中文
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
本项目已做全套低延迟优化（详见 [docs/voice-latency-optimization.md](docs/voice-latency-optimization.md)）：
1. **本地离线 ASR/TTS**（sherpa-onnx）：识别 ~0.3s、TTS 首块 ~0.2s，无网络往返；
2. **非 thinking 模型**（DeepSeek-V3 无思维链，首 token 快）；
3. **LLM SSE 流式** + **句级切分** + **首句逗号加速**，第一句（甚至第一个逗号后）立即合成；
4. **TTS 按句流式**（本地引擎边合成边下发，首块 ~0.2s）+ 启动预热无冷启动；
5. **VAD 快速端点**——说完静音 0.5s 即判定结束（默认 1.4s，省近 1 秒）。

实测一轮"说完话 → 听到回答"的语音首字延迟约 **1.3~2 秒**，且不受网络波动影响（除 LLM 外全离线）。

## 本地语音引擎（sherpa-onnx）

ASR/TTS 默认走本地离线引擎（与 Open-LLM-VTuber 同款模型，存放在 `models/`，已 gitignore）：

| 引擎 | 模型 | 位置 | 实测 |
|---|---|---|---|
| ASR | SenseVoiceSmall int8（中英日韩粤） | `models/asr/sense-voice/` | 8s 音频识别 ~0.26s |
| TTS | matcha-icefall-zh-baker（中文女声，48kHz→22.05kHz 输出） | `models/tts/matcha-zh-baker/matcha-icefall-zh-baker/` + `vocos-22khz-univ.onnx` | 首块 ~0.08s，RTF 0.077 |

> 默认 TTS 为 **matcha**（最快、自然，baker 音色）；`SHERPA_TTS_MODEL_TYPE=vits` 可切换 melo 音色（模型放 `models/tts/vits-melo-tts-zh_en/`）。注意 **baker 数据集仅限非商用**。

- 模型来源：[sherpa-onnx asr-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) / [tts-models](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models)，目录可在 `.env` 里改；
- `ASR_PROVIDER` / `TTS_PROVIDER`：`auto`（默认，本地优先失败回退云端）/ `local` / `cloud`；
- ⚠️ 服务必须用**真正的 Node**（≥20）运行：Electron 内置 Node 无法加载原生引擎，`npm start` 会自动挑选正确的 node；
- 优化思路与实测数据详见 [docs/voice-latency-optimization.md](docs/voice-latency-optimization.md)。

**Q: 识别出错？**
识别默认走**本地 sherpa-onnx SenseVoice**（离线、国内无障碍）。若本地模型缺失回退云端（硅基流动 XingChenASR），需确认 `.env` 里 Key 已配置（LLM 非硅基流动时要配 `ASR_API_KEY`）。

**Q: VAD 没反应？**
确认浏览器允许了麦克风权限；检查顶部"聆听中"指示灯是否亮着（绿点闪烁）。若被暂停，点「▶ 开始聆听」。

**Q: 换 TTS 音色？**
本地默认 **matcha-zh-baker**（baker 普通话女声）；想换 melo 音色，把 `.env` 的 `SHERPA_TTS_MODEL_TYPE` 改 `vits`、`SHERPA_TTS_MODEL_DIR` 改 `models/tts/vits-melo-tts-zh_en`、`SHERPA_TTS_MODEL_FILE` 改 `model.onnx`，并注释掉 `SHERPA_TTS_VOCODER` 和 `SHERPA_TTS_GAIN` 两行。云端回退音色用 `TTS_VOICE=FunAudioLLM/CosyVoice2-0.5B:{alex|bella|anna|david}`。换模型（如 MOSS-TTSD）时注意：MOSS 是对话模型，对短句（如"好的"）会合成出乱码，不推荐用于流式对话。

**Q: 怎么调语速？**
页面上「语速」下拉框直接调（0.6 慢 ~ 1.5 快），即时生效并记住选择；也可以改 `.env` 的 `TTS_SPEED`（0.25~4.0）设默认值。语速通过重新合成实现，无音调失真。

**Q: 想要完全离线（不联网）？**
ASR/TTS/VAD 已经全部离线（sherpa-onnx + Silero）。只剩 LLM：把 `.env` 的 `LLM_API_KEY` 留空并本地跑 Ollama，即可完全断网使用。

## 目录结构

```
ai-voice-chat/
├── server/
│   ├── server.js           # Express：流式 LLM / ASR / TTS / 历史会话 / 静态文件
│   ├── sherpa.js           # sherpa-onnx 本地语音引擎（SenseVoice ASR + matcha/vits TTS）
│   └── history.js          # 历史会话存储（JSON 文件持久化，无需数据库）
├── data/                   # 历史会话数据（data/history.json，gitignore）
├── models/                 # 本地语音大模型（gitignore）
│   ├── asr/sense-voice/    # SenseVoice int8 + tokens（~240MB）
│   └── tts/
│       ├── matcha-zh-baker/      # matcha 声学模型 + vocos 声码器（默认音色，~130MB）
│       └── vits-melo-tts-zh_en/  # vits-melo + lexicon + jieba dict + 规则 FST（可选音色，~300MB）
├── public/
│   ├── index.html          # 页面（自动聆听模式）
│   ├── app.js              # VAD 自动对话 + 流式展示 + 首句逗号加速 + 句级 TTS + 打断
│   ├── style.css
│   └── vendor/             # 本地化资源（无 CDN 依赖）
│       ├── ort/            # onnxruntime-web（WASM）
│       └── vad/            # Silero VAD ONNX 模型 + 封装
├── docs/
│   └── voice-latency-optimization.md  # 语音延迟优化笔记（学习自 Open-LLM-VTuber）
├── .env.example
└── README.md
```
