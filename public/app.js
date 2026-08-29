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
  const speedSelect = document.getElementById('speed-select');
  const sttWarning = document.getElementById('stt-warning');
  const historyBtn = document.getElementById('history-btn');
  const historyPanel = document.getElementById('history-panel');
  const historyListEl = document.createElement('div');
  historyListEl.className = 'history-list';
  historyPanel.appendChild(historyListEl);

  // 历史会话状态
  function newSessionId() {
    try { return crypto.randomUUID(); } catch { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  }
  let sessionId = localStorage.getItem('sessionId') || newSessionId();
  localStorage.setItem('sessionId', sessionId);
  let persistTimer = null;

  // 语速：记住用户选择
  const savedSpeed = localStorage.getItem('tts-speed');
  if (savedSpeed) speedSelect.value = savedSpeed;
  speedSelect.addEventListener('change', () => {
    localStorage.setItem('tts-speed', speedSelect.value);
  });
  function currentSpeed() {
    return Number(speedSelect.value) || 1.0;
  }

  // ---------- 状态 ----------
  const history = []; // {role:'user'|'assistant', content}
  let micVad = null;
  let listening = true; // VAD 是否在听
  let busy = false; // 正在处理一轮（ASR/LLM/TTS）
  let interrupted = false; // 本轮被打断
  let streamActive = false; // LLM 流式生成是否进行中
  let pendingSpeech = null; // 打断期间的语音/输入，等当前轮思考完再处理
  let speechMuted = false; // 打断后：后续句子只显示不播报
  let speechCandidate = false; // VAD 初步判到声音（未确认），用于"确认后才打断"（避免自打断）
  let streamCompleted = false;
  let abortController = null;
  let ttsQueue = [];
  let ttsPlaying = false;
  let ttsAbort = null; // TTS 请求的中止控制器
  let audioCtx = null; // Web Audio 上下文（PCM 流式播放）
  let ttsSources = new Set(); // 正在播放的 AudioBufferSource
  let ttsNextStart = 0; // 下一个 PCM 块的计划播放时间
  let pendingShort = ''; // 太短的句子先攒着，凑够长度再合成，避免 TTS 对短句乱说
  let turnId = 0; // 语音轮次号：新语音开始会自增，旧语音的 ASR 结果作废

  // ---------- 历史会话：持久化 ----------
  // 消息变更后延迟合并保存，避免每 token 都写盘；只保存 user/assistant
  function persistSession() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      try {
        await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, messages: history }),
        });
      } catch (e) {
        console.warn('保存历史失败：', e.message);
      }
    }, 400);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderMessages(msgs) {
    chatLog.innerHTML = '';
    for (const m of msgs) {
      const div = document.createElement('div');
      div.className = `msg ${m.role}`;
      div.textContent = m.content;
      chatLog.appendChild(div);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function refreshHistoryList() {
    if (historyPanel.hidden) return;
    try {
      const r = await fetch('/api/history');
      const d = await r.json();
      const list = d.sessions || [];
      historyListEl.innerHTML = '';
      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'history-empty';
        e.textContent = '暂无历史对话';
        historyListEl.appendChild(e);
        return;
      }
      for (const s of list) {
        const item = document.createElement('div');
        item.className = 'history-item'; if (s.id === sessionId) item.classList.add('current');
        const info = document.createElement('div');
        info.className = 'history-item-info';
        const title = document.createElement('div');
        title.className = 'history-item-title';
        title.textContent = s.title;
        const meta = document.createElement('div');
        meta.className = 'history-item-meta';
        meta.textContent = `${fmtTime(s.updatedAt)} · ${s.count} 条`;
        info.appendChild(title); info.appendChild(meta);
        const btns = document.createElement('div');
        btns.className = 'history-item-btns';
        const load = document.createElement('button');
        load.textContent = '加载'; load.dataset.load = s.id;
        const del = document.createElement('button');
        del.textContent = '删除'; del.className = 'danger'; del.dataset.del = s.id;
        btns.appendChild(load); btns.appendChild(del);
        item.appendChild(info); item.appendChild(btns);
        historyListEl.appendChild(item);
      }
    } catch (e) {
      console.warn('读取历史失败：', e.message);
      historyListEl.innerHTML = '<div class="history-empty">历史读取失败</div>';
    }
  }

  historyBtn.addEventListener('click', () => {
    historyPanel.hidden = !historyPanel.hidden;
    if (!historyPanel.hidden) refreshHistoryList();
  });

  historyListEl.addEventListener('click', async (e) => {
    const loadBtn = e.target.closest('[data-load]');
    const delBtn = e.target.closest('[data-del]');
    if (loadBtn) {
      const id = loadBtn.dataset.load;
      try {
        const r = await fetch('/api/history/' + id);
        if (!r.ok) throw new Error('会话不存在或已删除');
        const d = await r.json();
        sessionId = id;
        localStorage.setItem('sessionId', sessionId);
        history.length = 0;
        history.push(...(d.session.messages || []));
        renderMessages(history);
        setStatus(`已加载历史对话（${history.length} 条）。`);
        historyPanel.hidden = true;
        refreshHistoryList();
      } catch (err) {
        setStatus('❌ 加载历史失败：' + err.message);
      }
    } else if (delBtn) {
      try {
        await fetch('/api/history/' + delBtn.dataset.del, { method: 'DELETE' });
        refreshHistoryList();
      } catch (err) {
        console.warn('删除失败：', err.message);
      }
    }
  });

  // 开启一段全新的对话（新建会话 id）
  function startNewConversation(silent = false) {
    interruptAll();
    sessionId = newSessionId();
    localStorage.setItem('sessionId', sessionId);
    history.length = 0;
    renderMessages([]);
    ttsQueue.length = 0;
    pendingShort = '';
    if (!silent) setStatus('已开始新对话。');
    refreshHistoryList();
  }

  async function restoreSession() {
    const id = localStorage.getItem('sessionId');
    if (!id) return;
    try {
      const r = await fetch('/api/history/' + id);
      if (!r.ok) return;
      const d = await r.json();
      history.length = 0;
      history.push(...(d.session.messages || []));
      if (history.length) {
        renderMessages(history);
        setStatus(`已恢复上次对话（${history.length} 条）。`);
      }
    } catch (e) {
      console.warn('恢复会话失败：', e.message);
    }
  }

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
  // 注意：vad-web 的 onSpeechStart 在"第一帧过阈值"就触发，此时可能只是 TTS 扬声器漏音/误触发。
  // 借鉴 Open-LLM-VTuber：只在 onSpeechRealStart（语音连续确认有效，超过 minSpeechMs）时才真正打断，
  // 短爆音走 onVADMisfire 丢弃，避免"自己 TTS 把自己打断"。
  function onSpeechStart() {
    // 只"武装"：记录候选 + 更新状态，不打断、不停止播报
    speechCandidate = true;
    if (!busy) setStatus('🎤 正在听…');
  }

  function onSpeechRealStart() {
    // 语音确认为真实、持续的（≥minSpeechMs），此时才打断/占位
    speechCandidate = true;
    turnId++; // 让尚未完成的旧轮次 ASR 结果作废
    stopSpeakingOnly(); // 只停语音播报（AI 思考/生成继续，语音输入不受影响）
    busy = true;
    setStatus('🎤 正在听…');
  }

  function onVADMisfire() {
    // 声音太短（如 TTS 漏音爆音），判定为误触发，不打断
    speechCandidate = false;
    if (!busy) setStatus('🟢 聆听中…');
  }

  function onSpeechEnd(audio) {
    // audio: Float32Array @16kHz，本次说话的完整音频
    speechCandidate = false;
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
        requestTurn(text);
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
  // 完整打断：停播报 + 中止 LLM 流（打字输入/清空/暂停聆听时用）
  function interruptAll() {
    interrupted = true;
    speechMuted = true;
    pendingShort = '';
    if (abortController) {
      try {
        abortController.abort();
      } catch { /* 忽略 */ }
      abortController = null;
    }
    stopSpeakingOnly();
  }

  // 只停语音播报：不中止 LLM 流（思考继续），后续句子只显示不播报
  function stopSpeakingOnly() {
    interrupted = true;
    speechMuted = true;
    pendingShort = '';
    if (ttsAbort) {
      try {
        ttsAbort.abort();
      } catch { /* 忽略 */ }
      ttsAbort = null;
    }
    stopAllTTS();
    ttsQueue.length = 0;
  }

  // 停止所有正在播放的 PCM 块
  function stopAllTTS() {
    for (const s of ttsSources) {
      try {
        s.stop();
      } catch { /* 忽略 */ }
    }
    ttsSources.clear();
    ttsNextStart = 0;
  }

  // ---------- 与 AI 对话（流式） ----------
  // 入口：若上一轮还在流式生成，先排队（不打断思考），生成完自动接着处理
  function requestTurn(text) {
    if (streamActive) {
      pendingSpeech = text;
      setStatus('⏳ 上一轮还在思考，稍等马上处理…');
      return;
    }
    askAI(text);
  }

  async function askAI(text) {
    addMessage('user', text);
    setStatus('💭 思考中…');
    busy = true;
    interrupted = false;
    speechMuted = false; // 新一轮恢复播报
    streamCompleted = false;
    streamActive = true;

    const bubble = addMessage('assistant', '');
    let full = '';
    let sentenceBuf = '';
    let firstSentenceDone = false; // 首句加速：第一句未切出前，允许逗号立即断句
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
              if (firstSentenceDone) queueChunk(sentenceBuf.trim());
              else { firstSentenceDone = true; enqueueTTS(sentenceBuf.trim()); }
            }
            sentenceBuf = '';
            // 收尾：把还没凑够长度的短句也合成了（打断静音期间不播）
            if (!speechMuted && pendingShort.trim()) {
              enqueueTTS(pendingShort);
              pendingShort = '';
            }
            continue;
          }
          if (j.content) {
            full += j.content;
            bubble.textContent = full;
            chatLog.scrollTop = chatLog.scrollHeight;
            sentenceBuf += j.content;
            // 首句加速（借鉴 Open-LLM-VTuber 的 faster_first_response）：
            // 第一句遇到逗号就立即切分送 TTS，不等句末标点，首个音频更早响起
            const { sentences, rest } = splitSentences(sentenceBuf, !firstSentenceDone);
            sentenceBuf = rest;
            for (const s of sentences) {
              if (firstSentenceDone) {
                queueChunk(s);
              } else {
                firstSentenceDone = true;
                enqueueTTS(s); // 首句直接入队，不走短句攒批
              }
            }
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
      persistSession();
    }
    if (abortController === ctrl) abortController = null;
    busy = false;
    streamActive = false;
    setStatus(ttsQueue.length || ttsPlaying ? '🔊 正在回答…' : '🟢 聆听中…');

    // 排队中的新输入：上一轮思考完成后自动接着处理
    if (pendingSpeech) {
      const next = pendingSpeech;
      pendingSpeech = null;
      askAI(next);
    }
  }

  // 按标点切句；句子太长时按逗号兜底切。
  // aggressive=true 时（首句加速模式）：遇到逗号就立即断句，不等句末标点
  function splitSentences(buf, aggressive = false) {
    const sentences = [];
    let rest = buf;
    const m = rest.match(/^[\s\S]*?[。！？；!?;…]/);
    if (m) {
      const seg = m[0].trim();
      if (seg) sentences.push(seg);
      rest = rest.slice(m[0].length);
      return { sentences, rest };
    }
    if (aggressive) {
      const cm = rest.match(/^[^，,]*[，,]/);
      if (cm && cleanForTTS(cm[0]).length >= 2) {
        const seg = cm[0].trim();
        if (seg) sentences.push(seg);
        rest = rest.slice(cm[0].length);
        return { sentences, rest };
      }
    }
    if (rest.length >= 40) {
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

  // 短句攒着：清洗后不足 4 个字的先累积，凑够再合成（避免 TTS 对太短输入乱说）
  // 打断静音期间（speechMuted）跳过：思考照常，只是不再播报
  function queueChunk(s) {
    if (speechMuted) return;
    pendingShort += s;
    if (cleanForTTS(pendingShort).length >= 4) {
      enqueueTTS(pendingShort);
      pendingShort = '';
    }
  }

  async function enqueueTTS(text) {
    const t = cleanForTTS(text);
    if (!t) return; // 清洗后为空（如纯表情），跳过
    ttsQueue.push(t);
    pumpTTS();
  }

  // ---------- PCM 流式播放（Web Audio 边收边播） ----------
  function ensureAudioCtx() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    return audioCtx;
  }

  // 把一个 16bit 单声道 PCM 字节块解码并排入播放计划
  function schedulePcm(ctx, bytes, rate) {
    const n = Math.floor(bytes.length / 2);
    if (n < 1) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const srcRate = rate;
    const dstRate = ctx.sampleRate || 44100;
    // 重采样到 AudioContext 原生采样率：避免每块跨采样率重采样在块边界产生 click（"机关枪"声）
    const outN = Math.max(1, Math.round((n * dstRate) / srcRate));
    const buf = ctx.createBuffer(1, outN, dstRate);
    const ch = buf.getChannelData(0);
    if (srcRate === dstRate) {
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    } else {
      for (let i = 0; i < outN; i++) {
        const pos = (i * srcRate) / dstRate;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, n - 1);
        const frac = pos - i0;
        const a = view.getInt16(i0 * 2, true) / 32768;
        const b = view.getInt16(i1 * 2, true) / 32768;
        ch[i] = a + (b - a) * frac;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, ttsNextStart);
    src.start(startAt);
    ttsNextStart = startAt + buf.duration;
    ttsSources.add(src);
    src.onended = () => ttsSources.delete(src);
  }

  // 整段 PCM 一次性播放（合成单个 AudioBuffer，无块边界毛刺）
  function playPcm(ctx, bytes, rate) {
    const n = Math.floor(bytes.length / 2);
    if (n < 1) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dstRate = ctx.sampleRate || 44100;
    const outN = Math.max(1, Math.round((n * dstRate) / rate));
    const buf = ctx.createBuffer(1, outN, dstRate);
    const ch = buf.getChannelData(0);
    if (rate === dstRate) {
      for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    } else {
      for (let i = 0; i < outN; i++) {
        const pos = (i * rate) / dstRate;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, n - 1);
        const frac = pos - i0;
        const a = view.getInt16(i0 * 2, true) / 32768;
        const b = view.getInt16(i1 * 2, true) / 32768;
        ch[i] = a + (b - a) * frac;
      }
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.02, ttsNextStart);
    src.start(startAt);
    ttsNextStart = startAt + buf.duration;
    ttsSources.add(src);
    src.onended = () => ttsSources.delete(src);
  }

  // 等待当前句子的 PCM 播完（被打断则立即返回）
  function waitTTSPlaybackEnd(ctrl) {
    return new Promise((resolve) => {
      const check = () => {
        if (interrupted || ttsAbort !== ctrl) return resolve();
        if (ttsSources.size === 0 && audioCtx && ttsNextStart <= audioCtx.currentTime + 0.08) return resolve();
        setTimeout(check, 80);
      };
      check();
    });
  }

  async function pumpTTS() {
    if (ttsPlaying || interrupted || ttsQueue.length === 0) return;
    ttsPlaying = true;
    const text = ttsQueue.shift();
    setStatus('🔊 正在回答…（开口可打断）');
    const ctrl = new AbortController();
    ttsAbort = ctrl;

    try {
      const resp = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, stream: true, speed: currentSpeed() }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(d.error || 'TTS 失败');
      }

      const rate = Number(resp.headers.get('X-PCM-Sample-Rate')) || 24000;
      const ctx = ensureAudioCtx();

      // 浏览器自动播放策略：首次需要用户手势，等待点击解锁
      if (ctx.state === 'suspended') {
        setStatus('🔊 点击页面任意位置以允许语音播放');
        await new Promise((resolve) => {
          const unlock = () => {
            document.removeEventListener('pointerdown', unlock, true);
            ctx.resume().then(() => resolve());
          };
          document.addEventListener('pointerdown', unlock, true);
          setTimeout(() => {
            document.removeEventListener('pointerdown', unlock, true);
            resolve();
          }, 8000);
        });
      }

      const reader = resp.body.getReader();
      const all = [];
      let total = 0;
      // 整段缓冲后一次性播放：把流式 PCM 合并成一个音频缓冲，
      // 避免大量 50ms 小缓冲在浏览器里逐个重采样造成的块边界 click（即"炸麦"声）
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (interrupted || ttsAbort !== ctrl) {
          try { reader.cancel(); } catch { /* 忽略 */ }
          break;
        }
        all.push(value);
        total += value.length;
      }
      if (total >= 2 && !interrupted && ttsAbort === ctrl) {
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of all) { merged.set(c, off); off += c.length; }
        playPcm(ctx, merged, rate);
      }
      await waitTTSPlaybackEnd(ctrl);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('TTS 出错：', err);
    } finally {
      ttsPlaying = false;
      if (ttsAbort === ctrl) ttsAbort = null;
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
    interruptAll(); // 手动输入：完整打断（停播报 + 中止当前流）
    requestTurn(text);
  }

  // ---------- 清空 / 新对话 ----------
  clearBtn.addEventListener('click', () => {
    startNewConversation();
  });

  // ---------- 工具 ----------
  function addMessage(role, content) {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = content;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    if (role === 'user') { history.push({ role: 'user', content }); persistSession(); }
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
      renderConfig(cfg);
      refreshHistoryList();
      await initVAD();
      await restoreSession();
      // 本地语音模型是后台加载的，几秒后刷新一次状态
      if (cfg.asrProvider === 'local-sherpa' || cfg.ttsProvider === 'local-sherpa') {
        setTimeout(async () => {
          try { renderConfig(await (await fetch('/api/config')).json()); } catch { /* 忽略 */ }
        }, 8000);
      }
    })
    .catch(() => setStatus('⚠️ 无法加载配置，请确认服务已启动。'));

  function renderConfig(cfg) {
    const asrInfo =
      cfg.asrProvider === 'local-sherpa'
        ? `本地 sherpa-onnx · SenseVoice${cfg.asrLocalReady ? '' : '（加载中…）'}`
        : cfg.asrProvider === 'siliconflow'
          ? `<code>${cfg.asrModel}</code>`
          : '浏览器识别';
    const ttsInfo =
      cfg.ttsProvider === 'local-sherpa'
        ? `本地 sherpa-onnx · vits-melo${cfg.ttsLocalReady ? '' : '（加载中…）'}`
        : cfg.ttsAvailable
          ? `<code>${cfg.ttsModel}</code> · <code>${cfg.ttsVoice}</code>`
          : '浏览器合成';
    configBar.innerHTML =
      `LLM：<code>${cfg.baseUrl}</code> / <code>${cfg.model}</code> · ` +
      `识别：${asrInfo} · 合成：${ttsInfo}`;
  }

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
        onSpeechRealStart,
        onVADMisfire,
        onSpeechEnd,
        onError: onVadError,
        // ---- 低延迟 + 防自打断调优 ----
        redemptionMs: 500, // 说完静音 0.5s 即判定结束（默认 1400ms，省近 1 秒）
        preSpeechPadMs: 400, // 语音前补白（默认 800ms）
        minSpeechMs: 300, // 最短语音段（vad-web 默认 400；vtuber v5 用 9 帧≈288ms，取 300 平衡防自打断与丢短句）
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
