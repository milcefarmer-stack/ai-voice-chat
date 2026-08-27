# ai-voice-chat API 参考

本地服务：`http://localhost:3000`。所有接口鉴权由后端完成（读 `.env` 的硅基流动 Key），调用方无需带 Key。

## GET /api/config

返回当前配置状态：

```json
{
  "baseUrl": "https://api.siliconflow.cn/v1",
  "model": "deepseek-ai/DeepSeek-V3",
  "hasKey": true,
  "asrProvider": "siliconflow",
  "asrModel": "XingChenAGI/XingChenASR-V3.2-Ultra",
  "ttsAvailable": true,
  "ttsModel": "FunAudioLLM/CosyVoice2-0.5B",
  "ttsVoice": "FunAudioLLM/CosyVoice2-0.5B:bella"
}
```

## POST /api/tts — 文本转语音

请求体（JSON）：

```json
{ "text": "你好，我是语音助手。", "stream": false, "format": "wav", "speed": 1.0 }
```

| 字段 | 说明 |
|---|---|
| `text` | 必填，待合成文本（≤200 字） |
| `stream` | `true`=流式 PCM（24kHz 16bit 裸流，响应头 `X-PCM-Sample-Rate`）；`false`=一次性返回 |
| `format` | 非流式时可选 `wav` / `mp3`（默认 mp3） |
| `speed` | 语速 0.25~4.0，默认取 `.env` 的 `TTS_SPEED` |

PowerShell 示例（保存 wav 并播放）：

```powershell
$body = @{ text = '你好'; stream = $false; format = 'wav' } | ConvertTo-Json
Invoke-WebRequest -Uri 'http://localhost:3000/api/tts' -Method Post -ContentType 'application/json' -Body $body -OutFile "$env:TEMP\t.wav" -UseBasicParsing
(New-Object System.Media.SoundPlayer "$env:TEMP\t.wav").PlaySync()
```

## POST /api/asr — 语音转文字

multipart 表单，字段 `file`（wav 最佳，16kHz 单声道）：

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
- TTS 短句可靠（CosyVoice2）；不要换回 MOSS-TTSD（对话模型，短句会乱说）。
