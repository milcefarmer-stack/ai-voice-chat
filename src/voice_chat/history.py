"""历史会话存储(JSON 文件持久化),与旧 Node 版 data/history.json 完全兼容。

文件结构:{"<sessionId>": {"id","title","createdAt","updatedAt","messages":[{role,content}]}}
列表按 updatedAt 倒序;超量按最久未更新裁剪;写入用临时文件原子替换。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

MAX_MESSAGES = 200
MAX_TEXT = 8000
MAX_TITLE = 24

_MESSAGE_ROLES = ("user", "assistant")


class HistoryStore:
    def __init__(self, *, data_dir: Path | None = None, max_sessions: int = 200) -> None:
        if data_dir is None:
            env_dir = os.environ.get("DATA_DIR")
            data_dir = Path(env_dir) if env_dir else Path(__file__).resolve().parents[2] / "data"
        self._data_dir = data_dir
        self._file = data_dir / "history.json"
        self._max_sessions = max_sessions if max_sessions > 0 else 200

    # ---------- 读取 ----------

    def _load(self) -> dict:
        try:
            raw = json.loads(self._file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _persist(self, store: dict) -> None:
        self._data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self._file)  # 原子替换,避免半截文件

    # ---------- 对外操作 ----------

    def list(self) -> list[dict]:
        items = [
            {
                "id": s.get("id"),
                "title": s.get("title"),
                "updatedAt": s.get("updatedAt"),
                "count": len(s.get("messages") or []),
            }
            for s in self._load().values()
            if isinstance(s, dict)
        ]
        items.sort(key=lambda x: x["updatedAt"] or 0, reverse=True)
        return items[: self._max_sessions]

    def get(self, session_id: str) -> dict | None:
        s = self._load().get(session_id)
        if not isinstance(s, dict):
            return None
        return {
            "id": s.get("id"),
            "title": s.get("title"),
            "createdAt": s.get("createdAt"),
            "updatedAt": s.get("updatedAt"),
            "messages": s.get("messages") or [],
        }

    def save(self, session_id: str, messages, title: str | None = None) -> dict:
        if not session_id or not isinstance(session_id, str):
            raise ValueError("缺少会话 id")
        store = self._load()
        existing = store.get(session_id) if isinstance(store.get(session_id), dict) else {}
        now = int(time.time() * 1000)
        msgs = _sanitize_messages(messages)
        session = {
            "id": session_id,
            "title": _pick_title(title, existing.get("title"), _title_from_messages(msgs)),
            "createdAt": existing.get("createdAt") or now,
            "updatedAt": now,
            "messages": msgs,
        }
        store[session_id] = session
        self._prune(store)
        self._persist(store)
        return session

    def delete(self, session_id: str) -> bool:
        store = self._load()
        if session_id in store:
            del store[session_id]
            self._persist(store)
            return True
        return False

    # ---------- 内部 ----------

    def _prune(self, store: dict) -> None:
        if len(store) <= self._max_sessions:
            return
        keys = sorted(store, key=lambda k: (store[k].get("updatedAt") or 0))
        for k in keys[: len(store) - self._max_sessions]:
            del store[k]


def _sanitize_messages(messages) -> list[dict]:
    if not isinstance(messages, list):
        return []
    out = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role, content = m.get("role"), m.get("content")
        if role not in _MESSAGE_ROLES or not isinstance(content, str):
            continue
        out.append({"role": role, "content": content[:MAX_TEXT]})
    return out[-MAX_MESSAGES:]


def _title_from_messages(msgs: list[dict]) -> str:
    first = next((m for m in msgs if m["role"] == "user"), None)
    text = " ".join(first["content"].split()) if first else ""
    return text


def _pick_title(*candidates) -> str:
    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()[:MAX_TITLE]
    return "新对话"
