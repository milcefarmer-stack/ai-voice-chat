/**
 * 历史会话存储（JSON 文件持久化，无需数据库）
 *
 * 结构：data/history.json
 * {
 *   "<sessionId>": {
 *     "id": "...", "title": "...", "createdAt": 1234567890000,
 *     "updatedAt": 1234567890000, "messages": [{ "role": "user"|"assistant", "content": "..." }]
 *   }
 * }
 *
 * 提供：列表 / 读取 / upsert / 删除，并自动按 updatedAt 排序、裁剪超量会话。
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'history.json');

const MAX_SESSIONS = Number(process.env.HISTORY_MAX_SESSIONS) > 0 ? Number(process.env.HISTORY_MAX_SESSIONS) : 200;
const MAX_MESSAGES = 200; // 每个会话最多保留的消息数
const MAX_TEXT = 8000; // 单条消息最长字符数
const MAX_TITLE = 24;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, FILE); // 原子替换，避免半截文件
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TEXT) }))
    .slice(-MAX_MESSAGES);
}

function titleFrom(messages) {
  const first = messages.find((m) => m.role === 'user');
  const t = first ? first.content.trim() : '新对话';
  return (t.replace(/\s+/g, ' ').slice(0, MAX_TITLE) || '新对话').trim();
}

/** 会话列表（按更新时间倒序，含标题/条数/时间） */
export function listHistory() {
  const store = load();
  const list = Object.values(store).map((s) => ({
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    count: (s.messages || []).length,
  }));
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list.slice(0, MAX_SESSIONS);
}

/** 读取单个会话（完整消息） */
export function getHistory(id) {
  const s = load()[id];
  if (!s) return null;
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: s.messages || [],
  };
}

/** 新建或更新会话，返回完整会话对象 */
export function saveHistory(id, messages, title) {
  if (!id || typeof id !== 'string') throw new Error('缺少会话 id');
  const store = load();
  const existing = store[id] || {};
  const now = Date.now();
  const msgs = sanitizeMessages(messages);
  const session = {
    id,
    title: (title && title.trim().slice(0, MAX_TITLE)) || existing.title || titleFrom(msgs) || '新对话',
    createdAt: existing.createdAt || now,
    updatedAt: now,
    messages: msgs,
  };
  store[id] = session;

  // 超出上限时按最久未更新裁剪
  if (Object.keys(store).length > MAX_SESSIONS) {
    const keys = Object.keys(store).sort((a, b) => store[a].updatedAt - store[b].updatedAt);
    keys.slice(0, Object.keys(store).length - MAX_SESSIONS).forEach((k) => delete store[k]);
  }

  save(store);
  return session;
}

/** 删除单个会话 */
export function deleteHistory(id) {
  const store = load();
  if (store[id]) {
    delete store[id];
    save(store);
    return true;
  }
  return false;
}
