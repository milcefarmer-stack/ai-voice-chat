---
name: voice-chat
description: >
  通过本地 AI 语音对话应用（ai-voice-chat，服务 http://localhost:3000）让 agent 具备"发声"与"收音"能力：
  把文本朗读出来（TTS）、录音并把用户说的话识别成文字（ASR）、检查/启动本地服务。
  当用户要求"读出来/念给我听/用语音问我/听我说/语音回复"，或提到语音助手、语音对话、ai-voice-chat 时使用。
  脚本位于本 skill 的 scripts/ 目录，均为 Windows PowerShell 或 Python。
---

# Voice Chat（本地语音 I/O）

让 agent 通过本机运行的 `ai-voice-chat` 服务（http://localhost:3000）朗读文本和听取用户语音。

## 前置条件

- 服务运行在 `http://localhost:3000`。不确定时先运行：
  ```powershell
  powershell -ExecutionPolicy Bypass -File "<skill_dir>/scripts/status.ps1"
  ```
  未运行且需要启动：`status.ps1 -Start`（自动 `npm start`）。
  - `status.ps1` 会从 skill 目录的 `appdir.txt` 读取应用路径（由安装脚本 `install.ps1` 自动写入）；如缺失，用 `-AppDir <应用目录>` 指定。
- 服务依赖 `.env` 中的硅基流动 API Key（TTS/ASR 都走它），缺 Key 时 `/api/tts`、`/api/asr` 会返回错误。

## 朗读文本（TTS）→ speak.ps1

把一段文本通过电脑音箱念出来（CosyVoice2 自然中文音色）：

```powershell
powershell -ExecutionPolicy Bypass -File "<skill_dir>/scripts/speak.ps1" -Text "你好，我是语音助手"
```

- 中文文本建议用 `-TextFile` 传 UTF-8 文件，避免命令行编码问题：
  ```powershell
  powershell -ExecutionPolicy Bypass -File "<skill_dir>/scripts/speak.ps1" -TextFile "C:\tmp\msg.txt"
  ```
- 也支持管道：`echo 你好 | powershell ... speak.ps1`
- 语速：`-Speed 1.1`（0.25~4.0，默认 1.0）
- 播放是同步的（播完才返回），适合 agent 说一句话等用户反应。

## 听取用户语音（ASR）→ listen.py

录音（默认按回车结束）并把语音识别成文字，输出到 stdout：

```bash
python "<skill_dir>/scripts/listen.py"
# 指定录音时长（秒）：
python "<skill_dir>/scripts/listen.py" -d 8
# 直接识别已有 wav 文件（测试用）：
python "<skill_dir>/scripts/listen.py" --file C:\tmp\a.wav
```

- 依赖：`pip install sounddevice numpy`（未安装时脚本会提示）。
- 输出只有识别出的文字，方便 agent 直接捕获。
- 典型流程：`speak.ps1` 提出问题 → `listen.py` 获取用户的口头回答 → agent 处理 → 再 `speak.ps1` 回复。这就是一个完整的语音对话回合。

## 服务状态 → status.ps1

```powershell
powershell -ExecutionPolicy Bypass -File "<skill_dir>/scripts/status.ps1"        # 查看状态
powershell -ExecutionPolicy Bypass -File "<skill_dir>/scripts/status.ps1" -Start # 未运行时自动启动
```

## 直接调用 API

完整接口文档见 `references/api.md`（curl / PowerShell 示例）。核心：

| 用途 | 请求 |
|---|---|
| 合成语音 | `POST /api/tts` `{"text":"...","stream":false,"format":"wav","speed":1.0}` → wav 音频 |
| 流式合成 | `POST /api/tts` `{"text":"...","stream":true}` → PCM 裸流（24kHz 16bit） |
| 语音识别 | `POST /api/asr` multipart `file`（wav）→ `{"text":"..."}` |
| 对话（流式） | `POST /api/chat/stream` `{"messages":[...]}` → SSE |
| 配置状态 | `GET /api/config` |

## 注意事项

- 全部为本地服务，无外网依赖（除硅基流动 API）。
- 打断/多轮语音对话：浏览器端 Web 应用（http://localhost:3000）已实现 VAD 自动端点 + 流式 + 打断，agent 需要"免点击连续对话"时应引导用户打开该页面，而不是用脚本模拟。
- 脚本位置用 `<skill_dir>` 占位；agent 应先用脚本所在目录的实际路径替换。
