# ai-voice-chat API 参考

本地服务：`http://localhost:3000`。ASR/TTS 默认走**本地 sherpa-onnx 离线引擎**（无需任何 Key）；LLM 需要 `.env` 里的云端 Key（或本地 Ollama）。

## GET /api/config

返回当前配置状态：

```json
{
  "baseUrl": "https://api.siliconflow.cn/v1",
  "model": "deepseek-ai/DeepSeek-V3",
  "hasKey": true,
  "asrProvider": "local-sherpa",
  "asrLocalReady": true,
  "ttsProvider": "local-sherpa",
  "ttsLocalReady": true,
  "ttsSampleRate": 44100,
  "ttsAvailable": true
}
```

`asrProvider` / `ttsProvider` 取值：`local-sherpa`（本地离线，默认优先）、`siliconflow`（云端回退）、`browser`（仅 ASR，浏览器自带识别）。

## POST /api/tts — 文本转语音

请求体（JSON）：

```json
{ "text": "你好，我是语音助手。", "stream": false, "format": "wav", "speed": 1.0 }
```

| 字段 | 说明 |
|---|---|
| `text` | 必填，待合成文本（≤200 字） |
| `stream` | `true`=流式 PCM（16bit 裸流，采样率看响应头 `X-PCM-Sample-Rate`：本地 44100 / 云端 24000）；`false`=一次性返回 |
| `format` | 非流式时可选 `wav` / `mp3`（默认 mp3；本地引擎无 mp3 编码器，请求 mp3 也会返回 wav 容器） |
| `speed` | 语速 0.25~4.0，默认取 `.env` 的 `TTS_SPEED` |

PowerShell 示例（保存 wav 并播放）：

```powershell
$body = @{ text = '你好'; stream = $false; format = 'wav' } | ConvertTo-Json
Invoke-WebRequest -Uri 'http://localhost:3000/api/tts' -Method Post -ContentType 'application/json' -Body $body -OutFile "$env:TEMP\t.wav" -UseBasicParsing
(New-Object System.Media.SoundPlayer "$env:TEMP\t.wav").PlaySync()
```

## POST /api/asr — 语音转文字

multipart 表单，字段 `file`（wav 最佳，16kHz 单声道；本地引擎也接受 44.1k 等采样率，内部自动重采样）：

```bash
curl -F "file=@audio.wav" http://localhost:3000/api/asr
```

返回：

```json
{ "text": "识别出的文字" }
```

静音/无语音内容时 `text` 为空字符串。

## POST /api/chat/stream — LLM 流式对话（SSE）

```json
{ "messages": [ { "role": "user", "content": "你好" } ] }
```

响应为 SSE：每行 `data: {"content":"片段"}` 累积即全文；结束 `data: {"done":true}`；错误 `data: {"error":"..."}`。
请求体内不带 system 提示（后端自动加）。历史只保留最近 20 条。

## 备注

- 语音对话请用非 thinking 模型（`deepseek-ai/DeepSeek-V3`），thinking 模型响应慢。
- 本地引擎优先：ASR/TTS 不耗云端额度、无网络延迟；模型缺失或加载失败时自动回退云端（需 Key）。
- 服务必须用真正的 Node 运行（Electron 内置 Node 无法加载本地引擎，`npm start` 已自动处理）。
- 本地引擎优先：ASR/TTS 不耗云端额度、无网络延迟；模型缺失或加载失败时自动回退云端（需 Key）。
- TTS 默认 matcha（baker 数据集，**仅限非商用**）；换回 melo 就把 `SHERPA_TTS_MODEL_TYPE` 设为 `vits`。
