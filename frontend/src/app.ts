/**
 * AI 语音对话 - 前端(pipecat 管线版)
 *
 * 职责收窄为三件事:采集(浏览器 AEC)+ 本地 VAD/智能打断 + 播放。
 * 识别、思考、合成都由服务端 pipecat 管线完成,经 WebSocket 交互。
 *
 * 交互(与旧版一致):
 *   - 免点击:直接说话,说完自动识别并回答
 *   - 智能打断:短插话("嗯")不打断,AI 从暂停点继续;持续说话才打断
 *   - 也可打字提问(完整打断语义)
 */

import { InterjectionBuffer } from './interjectionBuffer';
import { InterruptionStateMachine } from './interruption';
import { AudioPlayer } from './player';

(() => {
  'use strict';

  // ---------- 配置(与 settings.InterruptSettings 默认值一致,可由 .env 调整) ----------
  const SUSTAIN_MS = 500; // 持续说话超过此时长才升级为打断
  const MERGE_TIMEOUT_MS = 3000; // 短插话等待后续话语的合并窗口

  // ---------- DOM ----------
  const configBar = document.getElementById('config-bar') as HTMLElement;
  const chatLog = document.getElementById('chat-log') as HTMLElement;
  const listenIndicator = document.getElementById('listen-indicator') as HTMLElement;
  const listenText = document.getElementById('listen-text') as HTMLElement;
  const listenBtn = document.getElementById('listen-btn') as HTMLButtonElement;
  const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  const textInput = document.getElementById('text-input') as HTMLInputElement;
  const statusEl = document.getElementById('status') as HTMLElement;
  const langSelect = document.getElementById('lang-select') as HTMLSelectElement;
  const speedSelect = document.getElementById('speed-select') as HTMLSelectElement;
  const sttWarning = document.getElementById('stt-warning') as HTMLElement;
  const historyBtn = document.getElementById('history-btn') as HTMLButtonElement;
  const historyPanel = document.getElementById('history-panel') as HTMLElement;
  const historyListEl = document.createElement('div');
  historyListEl.className = 'history-list';
  historyPanel.appendChild(historyListEl);

  function newSessionId(): string {
    try {
      return crypto.randomUUID();
    } catch {
      return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
  }

  // ---------- 状态 ----------
  interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
  }
  let sessionId = localStorage.getItem('sessionId') || newSessionId();
  localStorage.setItem('sessionId', sessionId);
  const history: ChatMessage[] = [];

  let micVad: { start(): void; pause(): void } | null = null;
  let listening = true;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  const player = new AudioPlayer();
  let speechCandidate = false;

  // 当前回答的气泡(流式文本)
  let assistantBubble: HTMLDivElement | null = null;
  let assistantText = '';

  // 语速:会话级,改动后重连生效
  const savedSpeed = localStorage.getItem('tts-speed');
  if (savedSpeed) speedSelect.value = savedSpeed;
  function currentSpeed(): number {
    return Number(speedSelect.value) || 1.0;
  }

  // ---------- 打断状态机 ----------
  const machine = new InterruptionStateMachine(
    {
      pauseBotAudio: () => player.pause(),
      resumeBotAudio: () => player.resume(),
      beginInterrupt: () => {
        player.discard();
        send({ type: 'interrupt' });
        setStatus('🎤 正在听…(AI 思考继续)');
      },
    },
    { setTimeout, clearTimeout },
    SUSTAIN_MS,
  );

  const interjections = new InterjectionBuffer(
    { setTimeout, clearTimeout },
    MERGE_TIMEOUT_MS,
    () => setStatus('🟢 聆听中…'),
  );

  // ---------- 历史持久化 ----------
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistSession(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      try {
        await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sessionId, messages: history }),
        });
      } catch (e) {
        console.warn('保存历史失败:', e);
      }
    }, 400);
  }

  function fmtTime(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderMessages(msgs: ChatMessage[]): void {
    chatLog.innerHTML = '';
    for (const m of msgs) {
      const div = document.createElement('div');
      div.className = `msg ${m.role}`;
      div.textContent = m.content;
      chatLog.appendChild(div);
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---------- WebSocket ----------
  function connect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      send({ type: 'hello', messages: history.slice(-20), speed: currentSpeed() });
      if (listening) setStatus('🟢 聆听中…');
    };
    ws.onmessage = (e) => {
      try {
        handleServer(JSON.parse(e.data));
      } catch {
        /* 非法消息忽略 */
      }
    };
    ws.onclose = () => {
      if (!listening) return;
      setStatus('⚠️ 与服务断开,3s 后重连…');
      reconnectTimer = window.setTimeout(connect, 3000);
    };
    ws.onerror = () => ws?.close();
  }

  function send(obj: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  interface ServerMsg {
    type: string;
    data?: string;
    rate?: number;
    content?: string;
    message?: string;
  }

  function handleServer(msg: ServerMsg): void {
    switch (msg.type) {
      case 'audio': {
        const raw = base64ToBytes(msg.data || '');
        if (raw.length >= 2) player.feed(raw.buffer as ArrayBuffer, msg.rate || 24000);
        setStatus('🔊 正在回答…(说话可打断)');
        break;
      }
      case 'bot_text': {
        if (!assistantBubble) {
          assistantBubble = addMessage('assistant', '') as HTMLDivElement;
          assistantText = '';
        }
        assistantText += msg.content || '';
        assistantBubble.textContent = assistantText;
        chatLog.scrollTop = chatLog.scrollHeight;
        break;
      }
      case 'bot_end': {
        if (assistantBubble && assistantText.trim()) {
          history.push({ role: 'assistant', content: assistantText.trim() });
          persistSession();
        }
        assistantBubble = null;
        assistantText = '';
        break;
      }
      case 'user_text': {
        addMessage('user', msg.content || '');
        setStatus('💭 思考中…');
        break;
      }
      case 'notice': {
        setStatus(msg.message || '');
        break;
      }
      case 'error': {
        addMessage('system', `⚠️ ${msg.message || '服务出错'}`);
        setStatus('❌ ' + (msg.message || '服务出错'));
        break;
      }
      default:
        break;
    }
  }

  // ---------- 语音话轮上行 ----------
  function sendUtterance(audio: Float32Array): void {
    const bytes = float32ToInt16(audio);
    send({ type: 'utterance', data: bytesToBase64(bytes), rate: 16000 });
    setStatus('🧠 识别中…');
  }

  // ---------- VAD 事件 ----------
  function onSpeechStart(): void {
    speechCandidate = true;
    if (!player.active) setStatus('🎤 正在听…');
  }

  function onSpeechRealStart(): void {
    speechCandidate = true;
    machine.speechConfirmed(player.active);
    if (machine.state === 'idle') setStatus('🎤 正在听…');
  }

  function onVADMisfire(): void {
    speechCandidate = false;
    if (!player.active) setStatus('🟢 聆听中…');
  }

  function onSpeechEnd(audio: Float32Array): void {
    speechCandidate = false;
    if (!audio || audio.length < 1600) {
      setStatus(player.active ? '🔊 正在回答…' : '🟢 聆听中…');
      return;
    }
    const decision = machine.speechEnded();
    if (decision.kind === 'interjection') {
      interjections.add(audio); // 短插话:等合并窗口内的下一句
      return;
    }
    const buffered = interjections.take();
    const utterance = buffered ? concatFloat32(buffered, audio) : audio;
    sendUtterance(utterance);
  }

  function onVadError(e: unknown): void {
    console.error('VAD 错误:', e);
    const err = e as { name?: string; message?: string };
    if (err && (err.name === 'NotAllowedError' || err.message?.includes('permission'))) {
      setStatus('❌ 麦克风权限被拒绝,请在浏览器地址栏允许麦克风。');
      sttWarning.hidden = false;
    } else {
      setStatus('⚠️ VAD 异常:' + (err?.message || String(e)));
    }
  }

  // ---------- 打字输入(完整打断) ----------
  function submitText(): void {
    const text = textInput.value.trim();
    if (!text) return;
    textInput.value = '';
    player.discard();
    machine.reset();
    interjections.clear();
    send({ type: 'interrupt' });
    send({ type: 'text', content: text });
    addMessage('user', text);
    setStatus('💭 思考中…');
  }

  // ---------- 聆听开关 ----------
  function setListening(on: boolean): void {
    listening = on;
    if (!micVad) return;
    if (on) {
      micVad.start();
      listenBtn.textContent = '⏸ 暂停聆听';
      listenIndicator.hidden = false;
      listenText.textContent = '正在聆听,直接说话即可';
      connect();
      setStatus('🟢 聆听中…');
    } else {
      micVad.pause();
      player.discard();
      machine.reset();
      interjections.clear();
      listenBtn.textContent = '▶ 开始聆听';
      listenIndicator.hidden = true;
      setStatus('⏸ 已暂停聆听(可用文字输入)');
    }
  }

  // ---------- 历史会话 ----------
  async function refreshHistoryList(): Promise<void> {
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
        item.className = 'history-item';
        if (s.id === sessionId) item.classList.add('current');
        const info = document.createElement('div');
        info.className = 'history-item-info';
        const title = document.createElement('div');
        title.className = 'history-item-title';
        title.textContent = s.title;
        const meta = document.createElement('div');
        meta.className = 'history-item-meta';
        meta.textContent = `${fmtTime(s.updatedAt)} · ${s.count} 条`;
        info.appendChild(title);
        info.appendChild(meta);
        const btns = document.createElement('div');
        btns.className = 'history-item-btns';
        const load = document.createElement('button');
        load.textContent = '加载';
        load.dataset.load = s.id;
        const del = document.createElement('button');
        del.textContent = '删除';
        del.className = 'danger';
        del.dataset.del = s.id;
        btns.appendChild(load);
        btns.appendChild(del);
        item.appendChild(info);
        item.appendChild(btns);
        historyListEl.appendChild(item);
      }
    } catch (e) {
      console.warn('读取历史失败:', e);
      historyListEl.innerHTML = '<div class="history-empty">历史读取失败</div>';
    }
  }

  historyBtn.addEventListener('click', () => {
    historyPanel.hidden = !historyPanel.hidden;
    if (!historyPanel.hidden) void refreshHistoryList();
  });

  historyListEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const loadBtn = target.closest('[data-load]') as HTMLElement | null;
    const delBtn = target.closest('[data-del]') as HTMLElement | null;
    if (loadBtn) {
      const id = loadBtn.dataset.load!;
      try {
        const r = await fetch('/api/history/' + id);
        if (!r.ok) throw new Error('会话不存在或已删除');
        const d = await r.json();
        sessionId = id;
        localStorage.setItem('sessionId', sessionId);
        history.length = 0;
        history.push(...(d.session.messages || []));
        renderMessages(history);
        setStatus(`已加载历史对话(${history.length} 条)。`);
        historyPanel.hidden = true;
        void refreshHistoryList();
        connect(); // 新历史 = 新服务端会话
      } catch (err) {
        setStatus('❌ 加载历史失败:' + (err as Error).message);
      }
    } else if (delBtn) {
      try {
        await fetch('/api/history/' + delBtn.dataset.del, { method: 'DELETE' });
        void refreshHistoryList();
      } catch (err) {
        console.warn('删除失败:', err);
      }
    }
  });

  function startNewConversation(): void {
    player.discard();
    machine.reset();
    interjections.clear();
    sessionId = newSessionId();
    localStorage.setItem('sessionId', sessionId);
    history.length = 0;
    renderMessages([]);
    assistantBubble = null;
    assistantText = '';
    setStatus('已开始新对话。');
    void refreshHistoryList();
    connect();
  }

  async function restoreSession(): Promise<void> {
    try {
      const r = await fetch('/api/history/' + sessionId);
      if (!r.ok) return;
      const d = await r.json();
      history.push(...(d.session.messages || []));
      if (history.length) {
        renderMessages(history);
        setStatus(`已恢复上次对话(${history.length} 条)。`);
      }
    } catch (e) {
      console.warn('恢复会话失败:', e);
    }
  }

  // ---------- 工具 ----------
  function addMessage(role: string, content: string): HTMLElement {
    const div = document.createElement('div');
    div.className = `msg ${role}`;
    div.textContent = content;
    chatLog.appendChild(div);
    chatLog.scrollTop = chatLog.scrollHeight;
    return div;
  }

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  function float32ToInt16(f32: Float32Array): ArrayBuffer {
    const buf = new ArrayBuffer(f32.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function bytesToBase64(bytes: ArrayBuffer): string {
    const arr = new Uint8Array(bytes);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < arr.length; i += CHUNK) {
      bin += String.fromCharCode(...arr.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- 配置 ----------
  function renderConfig(cfg: Record<string, unknown>): void {
    const asrInfo =
      cfg.asrProvider === 'local-sherpa'
        ? `本地 sherpa-onnx · SenseVoice${cfg.asrLocalReady ? '' : '(加载中…)'}`
        : cfg.asrProvider === 'siliconflow'
          ? `<code>${cfg.asrModel}</code>`
          : '浏览器识别';
    const ttsInfo =
      cfg.ttsProvider === 'local-sherpa'
        ? `本地 sherpa-onnx${cfg.ttsLocalReady ? '' : '(加载中…)'}`
        : cfg.ttsAvailable
          ? `<code>${cfg.ttsModel}</code> · <code>${cfg.ttsVoice}</code>`
          : '无合成';
    configBar.innerHTML =
      `LLM:<code>${cfg.baseUrl}</code> / <code>${cfg.model}</code> · ` +
      `识别:${asrInfo} · 合成:${ttsInfo}`;
  }

  // ---------- VAD 初始化 ----------
  async function initVAD(): Promise<void> {
    if (!window.vad || !window.vad.MicVAD) {
      sttWarning.hidden = false;
      setStatus('⚠️ VAD 库加载失败,请刷新页面重试。');
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
        // 低延迟 + 防自打断调优(沿用旧版);前补白加大以覆盖首音节
        redemptionMs: 500,
        preSpeechPadMs: 500,
        minSpeechMs: 300,
      });
      listening = true;
      listenIndicator.hidden = false;
      setStatus('🟢 聆听中…');
      addMessage('system', '✅ VAD 就绪:直接说话即可,说完整句后自动识别。');
    } catch (err) {
      console.error('VAD 初始化失败:', err);
      sttWarning.hidden = false;
      setStatus('❌ VAD 初始化失败:' + (err as Error).message + '(仍可使用文字输入)');
    }
  }

  // ---------- 事件 ----------
  listenBtn.addEventListener('click', () => setListening(!listening));
  sendBtn.addEventListener('click', submitText);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitText();
  });
  clearBtn.addEventListener('click', startNewConversation);
  speedSelect.addEventListener('change', () => {
    localStorage.setItem('tts-speed', speedSelect.value);
    connect(); // 语速会话级生效:重连
  });
  // 浏览器自动播放策略:首次需要用户手势
  document.addEventListener(
    'pointerdown',
    () => void player.unlock(),
    { once: true, capture: true },
  );
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && listening) setListening(false);
  });

  // ---------- 启动 ----------
  addMessage('system', '你好!对着麦克风直接说话即可开始对话;AI 回答时说话可以打断它。');

  fetch('/api/config')
    .then((r) => r.json())
    .then(async (cfg) => {
      configBar.hidden = false;
      renderConfig(cfg);
      void refreshHistoryList();
      await initVAD();
      await restoreSession();
      connect();
      if (cfg.asrProvider === 'local-sherpa' || cfg.ttsProvider === 'local-sherpa') {
        setTimeout(async () => {
          try {
            renderConfig(await (await fetch('/api/config')).json());
          } catch {
            /* 忽略 */
          }
        }, 8000);
      }
    })
    .catch(() => setStatus('⚠️ 无法加载配置,请确认服务已启动。'));
})();
