"""history 测试:数据格式必须与旧 Node 版 data/history.json 完全兼容。"""

import json

from voice_chat.history import HistoryStore

LEGACY = {
    "s1": {
        "id": "s1",
        "title": "你好呀",
        "createdAt": 1700000000000,
        "updatedAt": 1700000005000,
        "messages": [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "你好呀"},
        ],
    },
    "s2": {
        "id": "s2",
        "title": "天气",
        "createdAt": 1700000010000,
        "updatedAt": 1700000020000,
        "messages": [{"role": "user", "content": "今天天气怎么样"}],
    },
}


def _store(tmp_path, store=None, **env):
    data_dir = tmp_path / "data"
    data_dir.mkdir(exist_ok=True)
    if store is not None:
        (data_dir / "history.json").write_text(
            json.dumps(store, ensure_ascii=False), encoding="utf-8"
        )
    return HistoryStore(data_dir=data_dir, max_sessions=env.get("max_sessions", 200))


def test_list_sorted_by_updated_at_desc(tmp_path):
    st = _store(tmp_path, LEGACY)
    assert st.list() == [
        {"id": "s2", "title": "天气", "updatedAt": 1700000020000, "count": 1},
        {"id": "s1", "title": "你好呀", "updatedAt": 1700000005000, "count": 2},
    ]


def test_get_returns_full_session(tmp_path):
    st = _store(tmp_path, LEGACY)
    s = st.get("s1")
    assert s["id"] == "s1"
    assert s["createdAt"] == 1700000000000
    assert s["messages"][0] == {"role": "user", "content": "你好"}
    assert st.get("missing") is None


def test_save_upsert_keeps_created_at_and_title(tmp_path):
    st = _store(tmp_path, LEGACY)
    session = st.save("s1", [{"role": "user", "content": "新消息"}])
    assert session["createdAt"] == 1700000000000
    assert session["title"] == "你好呀"  # 未传 title 时沿用旧标题
    assert session["messages"] == [{"role": "user", "content": "新消息"}]
    assert st.get("s1")["updatedAt"] >= session["updatedAt"]


def test_save_title_from_first_user_message(tmp_path):
    st = _store(tmp_path, {})
    session = st.save(
        "new",
        [{"role": "assistant", "content": "嗨"}, {"role": "user", "content": "  讲个\n笑话 "}],
    )
    assert session["title"] == "讲个 笑话"
    # title 最多 24 字
    long = st.save("long", [{"role": "user", "content": "字" * 40}])
    assert len(long["title"]) == 24


def test_save_sanitizes_messages(tmp_path):
    st = _store(tmp_path, {})
    session = st.save(
        "s",
        [
            {"role": "system", "content": "should drop"},  # 非 user/assistant 丢弃
            {"role": "user", "content": "x" * 9000},  # 截到 8000
            None,  # 非法丢弃
            {"role": "user"},  # 无 content 丢弃
        ],
    )
    assert len(session["messages"]) == 1
    assert len(session["messages"][0]["content"]) == 8000


def test_save_prunes_over_max_sessions(tmp_path):
    st = _store(tmp_path, {}, max_sessions=2)
    st.save("a", [{"role": "user", "content": "a"}])
    st.save("b", [{"role": "user", "content": "b"}])
    st.save("c", [{"role": "user", "content": "c"}])  # 3 个 > 2:裁掉最久未更新的
    ids = [s["id"] for s in st.list()]
    assert "a" not in ids and set(ids) == {"b", "c"}


def test_delete(tmp_path):
    st = _store(tmp_path, LEGACY)
    assert st.delete("s1") is True
    assert st.get("s1") is None
    assert st.delete("s1") is False


def test_persisted_file_readable_by_legacy_format(tmp_path):
    """落盘文件就是旧版 JSON 结构:顶层 dict,键为会话 id。"""
    st = _store(tmp_path, LEGACY)
    st.save("s3", [{"role": "user", "content": "hi"}])
    raw = json.loads((tmp_path / "data" / "history.json").read_text(encoding="utf-8"))
    assert set(raw) == {"s1", "s2", "s3"}
    assert raw["s3"]["messages"][0]["role"] == "user"


def test_corrupt_file_treated_as_empty(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "history.json").write_text("{broken", encoding="utf-8")
    st = HistoryStore(data_dir=data_dir)
    assert st.list() == []
