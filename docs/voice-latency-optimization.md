# 语音对话延迟优化笔记

> 学习对象：[Open-LLM-VTuber](file:///E:/hhy/Code_file/workspace/workspace_1/open-llm-vtuber) 的语音链路优化方式，
> 以及本项目（ai-voice-chat）已移植/新增的对照。实测数据见文末。

## 一条语音回复的延迟构成

```
你说完话 ──► ASR 识别 ──► LLM 首 token ──► 首句文本齐 ──► TTS 首块音频 ──► 播放
            (①)          (②)              (③)             (④)
```

感知延迟 ≈ ①+②+③+④，任何一段都要抠。

## Open-LLM-VTuber 的关键优化（源码位置可点）

| # | 优化点 | 实现 | 位置 |
|---|---|---|---|
| 1 | **首句逗号加速**（faster_first_response） | 第一句不等句末标点，遇到逗号立即切分送 TTS，首句音频提前 0.3~1s | `src/open_llm_vtuber/utils/sentence_divider.py` L494-514 |
| 2 | **LLM 流式 + 句级流水线** | LLM 逐 token 输出 → 句子切分器增量断句 → 每出一句立刻丢给 TTS，合成与生成重叠进行 | `conversations/conversation_utils.py`（async for output → tts_manager.speak） |
| 3 | **句切分器** | regex / pysbd 两种切法，避免 TTS 拿到超长文本拖慢首包 | `utils/sentence_divider.py` |
| 4 | **本地离线 ASR** | sherpa-onnx SenseVoice int8，纯 CPU，8s 音频 ~260ms，无上传/网络往返 | `asr/sherpa_onnx_asr.py` |
| 5 | **本地离线 TTS** | sherpa-onnx vits-melo，无云端排队/网络抖动 | `tts/sherpa_onnx_tts.py` |
| 6 | **关闭 LLM 思维链** | 硅基流动 Qwen3 加 `extra_body: {enable_thinking: false}`，砍掉回答前的"思考"段 | `conf.yaml` llm_configs |
| 7 | **TTS 限批** | `max_num_sentences` 控制每次合成的句数，小批量出音频更快 | `tts/sherpa_onnx_tts.py` |
| 8 | **打断分级** | 用户开口 → 先停播放（播报静音），LLM 思考继续；只有打字/清空才中止整个流 | `conversations/` + 前端 |

## 本项目的移植与差异

| 项 | Open-LLM-VTuber | ai-voice-chat（改造后） |
|---|---|---|
| ASR | 本地 sherpa-onnx（Python） | **本地 sherpa-onnx（Node 原生绑定）**，失败自动回退云端 |
| TTS | 本地 sherpa-onnx（整句合成→ws 发音频文件） | **本地 sherpa-onnx 流式合成**（`generateAsync` 的 `onProgress` 逐块下发 PCM，边合成边播） |
| 首句加速 | faster_first_response（逗号断句） | ✅ 已移植：`public/app.js` 的 `splitSentences(buf, aggressive)`，首句遇逗号（清洗后≥2字）立即入队，不走短句攒批 |
| 流水线 | 句级 async 流水线 | ✅ 保留：SSE 逐字 → 断句 → 逐句 TTS，`pendingShort` 攒短句防 TTS 乱说 |
| 思维链 | `enable_thinking: false` | ✅ 服务端丢弃 `reasoning_content` + `.env` 用非 thinking 模型 |
| 打断 | 停播报 / 中止流分级 | ✅ 同款分级 + 新增：客户端断开会通过 `onProgress` 返回 0 **立刻终止原生合成**，不浪费 CPU |
| TTS 预热 | —（首次请求吃冷启动） | ✅ 新增：启动时合成一句话 + 识别一段静音，把 ~4s 模型初始化挡在启动阶段 |

### 本地 TTS 为什么比云端更快更稳（实测）

- sherpa `maxNumSentences=1`：按句出音频，**首个 120ms 音频块 ~190ms**；
  对比 `maxNumSentences=-1`（整段一次出）要 2.7s 才出第一块。
- 4 线程比 2 线程整体 RTF 从 0.49 → 0.34（8s 音频 2.8s 合完）。
- 语速 1.15 还能再快一点点（175ms 首块），音质几乎无差。
- 云端 CosyVoice2 首块 0.2~0.6s 且受网络抖动/限额影响；本地 0.19~0.39s 且恒定。

## 实测数据（本机 CPU，i7 级别，2026-08-29）

| 环节 | 改造前（云端） | 改造后（本地） |
|---|---|---|
| ASR（8s 音频） | 0.3~0.8s（上传+API+下载） | **0.24~0.36s**（RTF 0.03，无上传） |
| TTS 首块 | 0.2~0.6s（受网络抖动） | **0.19~0.39s**（首请求无冷启动） |
| TTS 整句 26 字 | ~1.1s（云端整段） | 1.85s 出 4.28s 音频（边合成边播，无感） |
| LLM 首 token | 0.3~0.8s（未动） | 0.7~0.8s（云端 DeepSeek-V3） |
| 离线可用 | ❌ | ✅（ASR/TTS/VAD 全离线，仅 LLM 需网络） |

一轮「说完话 → 听到回答」感知延迟：**约 1.3~2s**，且不再受网络波动与云端限额影响。

## 还能更快的方向（没做，按收益排序）

1. **LLM 本地化/换更快源**：目前首 token 0.7~0.8s 是链路里最大头。Ollama + 小模型（qwen2.5:7b）或更快的云（如 groq）可压到 0.2~0.3s，代价是回答质量。
2. **流式 ASR**：VAD 边录边喂流式识别（sherpa 支持 streaming zipformer），说完即出文字，省 ~0.3s。
3. **GPU 跑 TTS/ASR**：sherpa-onnx 支持 CUDA provider，RTF 可再降一个量级。
4. **TTS 换 kokoro/matcha**：中文音色不如 melo 自然，但英文 RTF 更低。
5. 首句逗号阈值再激进些（≥1 字就切），风险是碎句音调起伏差。

## 坑位记录

- **Electron 内置 Node 跑不了 sherpa-onnx**：V8 sandbox 拒绝 external buffer，报
  `External buffers are not allowed`（同步）或 `TTS settlement failed`（异步）。
  必须用真正的 node.exe 启动，`scripts/start.ps1` 已自动挑选（按 `process.versions.v8`
  是否含 `electron` 过滤）。
- sherpa-onnx-node 的 `OfflineTtsVitsModelConfig` 传 `dictDir`（jieba）+ 顶层 `ruleFsts`
  即可驱动 vits-melo 中文模型；`maxNumSentences` 放顶层，不是 model 里。
- melo 的 `model.int8.onnx` 在上游仓库是 133 字节的 LFS 指针文件，只能用 fp32 `model.onnx`。
- TTS 单引擎不支持并发合成，服务端用 promise 链串行化；前端本就逐句请求，正常不排队。
