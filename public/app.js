/**
 * AI 语音对话 - 前端逻辑（自动对话版）
 *
 * 架构：
 *   VAD(Silero, 浏览器本地) 持续监听麦克风
 *     ├─ 检测到说话开始(onSpeechStart) → 打断当前 AI 回答（停止 TTS + 中止 LLM 流）
 *     ├─ 检测到说话结束(onSpeechEnd)  → 拿到 16kHz 音频 → 上传 /api/asr 识别
 *     └─ 识别出文字 → /api/chat/stream 流式取回答 → 句级切分 → /api/tts 合成语音播放
 *
 * 交互：
 *   - 免点击：直接对着麦克风说话，说完自动识别并回答
 *   - 可打断：AI 说话时你开口，AI 立即闭嘴，开始听你说
 *   - 也可打字提问（不占用麦克风链路）
 */
(() => {
  'use strict';

  // ---------- DOM ----------
  const configBar = document.getElementById('config-bar');
  const chatLog = document.getElementById('chat-log');
  const listenIndicator = document.getElementById('listen-indicator');
  const listenText = document.getElementById('listen-text');
  const listenBtn = document.getElementById('listen-btn');
  const clearBtn = document.getElementById('clear-btn');
  const sendBtn = document.getElementById('send-btn');
  const textInput = document.getElementById('text-input');
  const statusEl = document.getElementById('status');
  const langSelect = document.getElementById('lang-select');
  const sttWarning = document.getElementById('stt-warning');

  // ---------- 状态 ----------
  const history = []; // {role:'user'|'assistant', content}
  let micVad = null;
  let listening = true; // VAD 是否在听
  let busy = false; // 正在处理一轮（ASR/LLM/TTS）
  let interrupted = false; // 本轮被打断
  let streamCompleted = false;
  let abortController = null;
  let ttsQueue = [];
  let ttsPlaying = false;
  let currentAudio = null;
  let turnId = 0; // 语音轮次号：新语音开始会自增，旧语音的 ASR 结果作废

  // ---------- 语音识别（上传硅基流动） ----------
  async function transcribe(wavBlob) {
    const fd = new FormData();
    fd.append('file', wavBlob, 'audio.wav');
    const lang = langSelect.value.split('-')[0];
    if (lang) fd.append('language', lang);
    const resp = await fetch('/api/asr', { method: 'POST', body: fd });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || '语音识别失败');
    return (data.text || '').trim();
  }

  // Float32Array(16kHz) → WAV Blob
  function encodeWav16k(samples) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);
    const w = (off, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    w(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    w(36, 'data');
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ---------- VAD 事件 ----------
  function onSpeechStart() {
    // 用户开口 → 立即打断 AI（停 TTS、中止 LLM 流）
    turnId++; // 让尚未完成的旧轮次 ASR 结果作废
    interruptAll();
    busy = true;
    setStatus('🎤 正在听…');
  }

  function onSpeechEnd(audio) {
    // audio: Float32Array @16kHz，本次说话的完整音频
    const myTurn = turnId;
    if (!audio || audio.length < 1600) {
      // 太短（<0.1s），忽略
      busy = false;
      setStatus('🟢 聆听中…');
      return;
    }
    setStatus('🧠 识别中…');
    const wav = encodeWav16k(audio);
    transcribe(wav)
      .then((text) => {
        if (myTurn !== turnId) return; // 已被更新的语音取代
        if (!text) {
          setStatus('没听清，请再说一次。');
          busy = false;
          return;
        }
        askAI(text);
      })
      .catch((err) => {
        if (myTurn !== turnId) return;
        setStatus('❌ 识别失败：' + err.message);
        busy = false;
      });
  }

  function onVadError(e) {
    console.error('VAD 错误：', e);
    if (e && (e.name === 'NotAllowedError' || e.message?.includes('permission'))) {
      setStatus('❌ 麦克风权限被拒绝，请在浏览器地址栏允许麦克风。');
      sttWarning.hidden = false;
    } else {
      setStatus('⚠️ VAD 异常：' + (e?.message || e));
    }
  }

  // ---------- 打断 ----------
  function interruptAll() {
    interrupted = true;
    if (abortController) {
      try {
        abortController.abort();
      } catch { /* 忽略 */ }
      abortController = null;
    }
    ttsQueue.length = 0;
    if (currentAudio) {
      try {
        currentAudio.pause();
        currentAudio.src = '';
      } catch { /* 忽略 */ }
      currentAudio = null;
    }
    ttsPlaying = false;
  }

  // ---------- 与 AI 对话（流式） ----------
  async function askAI(text) {
    addMessage('user', text);
    setStatus('💭 思考中…');
    busy = true;
    interrupted = false;
    streamCompleted = false;

    const bubble = addMessage('assistant', '');
    let full = '';
    let sentenceBuf = '';
    const ctrl = new AbortController();
    abortController = ctrl;

    try {
      const resp = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: ctrl.signal,
      });

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        for (const line of chunk.split('\n')) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (!payload) continue;

          let j;
          try {
            j = JSON.parse(payload);
          } catch { continue; }

          if (j.error) throw new Error(j.error);
          if (j.done) {
            streamCompleted = true;
            if (sentenceBuf.trim()) {
              enqueueTTS(sentenceBuf.trim());
              sentenceBuf = '';
            }
            continue;
          }
          if (j.content) {
            full += j.content;
            bubble.textContent = full;
            chatLog.scrollTop = chatLog.scrollHeight;
            sentenceBuf += j.content;
            const { sentences, rest } = splitSentences(sentenceBuf);
            sentenceBuf = rest;
            for (const s of sentences) enqueueTTS(s);
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        const msg = err.message || '请求失败';
        addMessage('system', `⚠️ ${msg}`);
        setStatus('❌ ' + msg);
      }
    }

    // 完整回答进历史（被打断的半截不记录）
    if (streamCompleted && full.trim()) {
      history.push({ role: 'assistant', content: full.trim() });
    }
    if (abortController === ctrl) abortController = null;
    busy = false;
    setStatus(ttsQueue.length || ttsPlaying ? '🔊 正在回答…' : '🟢 聆听中…');
  }

  // 按标点切句；句子太长时按逗号兜底切
  function splitSentences(buf) {
    const sentences = [];
    let rest = buf;
    const m = rest.match(/^[\s\S]*?[。！？；!?;…]/);
    if (m) {
      const seg = m[0].trim();
      if (seg) sentences.push(seg);
      rest = rest.slice(m[0].length);
    } else if (rest.length >= 40) {
      const comma = rest.search(/[，、,]/);
      if (comma > 0) {
        const seg = rest.slice(0, comma + 1).trim();
        if (seg) sentences.push(seg);
        rest = rest.slice(comma + 1);
      } else {
        const seg = rest.trim();
        sentences.push(seg);
        rest = '';
      }
    }
    return { sentences, rest };
  }

  // ---------- TTS（句级播放队列） ----------
  // 入队前清洗文本：去掉表情/符号/Markdown/URL，只留可朗读内容，
  // 避免 TTS 对符号合成出奇怪的声音
  function cleanForTTS(text) {
    return text
      .replace(/https?:\/\/\S+/g, ' ') // URL
      .replace(/[`*_#>|~]/g, ' ') // Markdown 标记
      // 表情符号区段
      .replace(
        /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{FE0F}\u{200D}]/gu,
        ' '
      )
      // 装饰性符号
      .replace(/[～·•°★☆✨♪♫►◄→←↑↓①②③④⑤⑥⑦⑧⑨⑩]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([，。！？；：、,.!?;:])/g, '$1') // 中文标点前不留空格
      .trim();
  }

  async function enqueueTTS(text) {
    const t = cleanForTTS(text);
    if (!t) return; // 清洗后为空（如纯表情），跳过
    ttsQueue.push(t);
    pumpTTS();
  }

  async function pumpTTS() {
    if (ttsPlaying || interrupted || ttsQueue.length === 0) return;
    ttsPlaying = true;
    const text = ttsQueue.shift();
    setStatus('🔊 正在回答…（开口可打断）');
    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || 'TTS 失败');
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      currentAudio = new Audio(url);
      await new Promise((resolve) => {
        currentAudio.onended = resolve;
        currentAudio.onerror = resolve;
        currentAudio.play().catch(() => {
          // 浏览器自动播放拦截：提示点击页面任意位置启用
          setStatus('🔊 点击页面任意位置以允许语音播放');
          const unlock = () => {
            document.removeEventListener('pointerdown', unlock, true);
            currentAudio?.play().catch(() => {});
          };
          document.addEventListener('pointerdown', unlock, true);
          setTimeout(resolve, 5000);
        });
      });
      URL.revokeObjectURL(url);
      currentAudio = null;
    } catch (err) {
      console.error('TTS 出错：', err);
    } finally {
      ttsPlaying = false;
      if (interrupted) {
        setStatus('🎤 正在听…');
      } else if (ttsQueue.length) {
        pumpTTS();
      } else {
        setStatus('🟢 聆听中…');
      }
    }
  }

  // ---------- 聆听开关 ----------
  function setListening(on) {
    listening = on;
    if (!micVad) return;
    if (on) {
      micVad.start();
      listenBtn.textContent = '⏸ 暂停聆听';
      listenIndicator.hidden = false;
      listenText.textContent = '正在聆听，直接说话即可';
      setStatus('🟢 聆听中…');
    } else {
      micVad.pause();
      interruptAll();
      listenBtn.textContent = '▶ 开始聆听';
      listenIndicator.hidden = true;
      setStatus('⏸ 已暂停聆听（可用文字输入）');
    }
  }

  listenBtn.addEventListener('click', () => setListening(!listening));

  // ---------- 打字输入（备用） ----------
  sendBtn.addEventListener('click', () => submitText());
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitText();
  });

  function submitText() {
    const text = textInput.value.trim();
    if (!text) return;
    textInput.value = '';
    interruptAll(); // 手动输入同样先打断 AI
    askAI(text);
  }

  // ---------- 清空 ----------
  clearBtn.addEventListener('click', () => {
    history.length = 0;
    chatLog.innerHTML = '';
    interruptAll();
    setStatus('已清空对话。');
  });

  // ---------- 工具 ----------
  function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = content;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    if (role === 'user') history.push({ role: 'user', content });
    return div;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // 页面隐藏时暂停聆听
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && listening) setListening(false);
  });

  // ---------- 初始化 ----------
  addMessage('system', '你好！对着麦克风直接说话即可开始对话；AI 回答时开口可以打断它。');

  fetch('/api/config')
    .then((r) => r.json())
    .then(async (cfg) => {
      configBar.hidden = false;
      const asrInfo = cfg.asrProvider === 'siliconflow' ? `<code>${cfg.asrModel}</code>` : '浏览器识别';
      const ttsInfo = cfg.ttsAvailable ? `<code>${cfg.ttsModel}</code> · <code>${cfg.ttsVoice}</code>` : '浏览器合成';
      configBar.innerHTML =
        `LLM：<code>${cfg.baseUrl}</code> / <code>${cfg.model}</code> · ` +
        `识别：${asrInfo} · 合成：${ttsInfo}`;

      await initVAD();
    })
    .catch(() => setStatus('⚠️ 无法加载配置，请确认服务已启动。'));

  async function initVAD() {
    if (!window.vad || !window.vad.MicVAD) {
      sttWarning.hidden = false;
      setStatus('⚠️ VAD 库加载失败，请刷新页面重试。');
      return;
    }
    try {
      micVad = await window.vad.MicVAD.new({
        model: 'v5',
        baseAssetPath: '/vendor/vad/',
        onnxWASMBasePath: '/vendor/ort/',
        onSpeechStart,
        onSpeechEnd,
        onError: onVadError,
      });
      listening = true;
      listenIndicator.hidden = false;
      setStatus('🟢 聆听中…');
      addMessage('system', '✅ VAD 就绪：直接说话即可，说完整句后自动识别。');
    } catch (err) {
      console.error('VAD 初始化失败：', err);
      sttWarning.hidden = false;
      setStatus('❌ VAD 初始化失败：' + (err?.message || err) + '（仍可使用文字输入）');
    }
  }
})();
