#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_probe 级单测：WebUI 配置写盘 + 读回校验（2026-11-17 六十五轮）

被测对象：
  - live-2d/webui/state_io.py      : atomic_write_json / json_payload_bytes / verify_json_readback
  - live-2d/webui/config_manager.py: save_config / save_provider_store（以及它们的 HTTP 失败路径）

为什么用「合成包」导入：webui/__init__.py 会 import main_app（连带整个 WebUI 启动逻辑），
单测只需要 config_manager + state_io。往 sys.modules 塞一个只带 __path__ 的 webui 模块，
相对导入（from .state_io import ...）照样解析，而 __init__.py 不执行；也不启动任何服务。

安全：真实 config.json / llm_providers.json 绝不落盘 —— 模块级路径全局
（CONFIG_PATH / CONFIG_TEMPLATE_PATH / PROVIDER_STORE_PATH）在导入后立即改指临时目录。

用法：<user-home>/AppData/Local/Programs/Python/Python313/python.exe \
        _probe/test-webui-config-io.py
退出码：0 = 全过；1 = 有 FAIL
"""

import hashlib
import importlib
import json
import os
import shutil
import sys
import tempfile
import types
from pathlib import Path

try:  # Windows 管道默认 cp936 → 统一 UTF-8，避免中文断言名乱码
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
WEBUI_DIR = ROOT / "_incoming" / "my-neuro" / "live-2d" / "webui"

# ── 合成包：绕开 webui/__init__.py（它会把整个 WebUI 应用拉起来）────────────
_pkg = types.ModuleType("webui")
_pkg.__path__ = [str(WEBUI_DIR)]
sys.modules["webui"] = _pkg
state_io = importlib.import_module("webui.state_io")
config_manager = importlib.import_module("webui.config_manager")

# ── 全部落到临时目录：真实配置文件一个字节都不碰 ───────────────────────────
REAL_CONFIG = Path(config_manager.CONFIG_PATH)
TMP = Path(tempfile.mkdtemp(prefix="webui-config-io-"))
CM_CONFIG = TMP / "config.json"
CM_TEMPLATE = TMP / "config.example.json"
CM_STORE = TMP / "llm_providers.json"
CM_TEMPLATE.write_text("{}\n", encoding="utf-8")
config_manager.CONFIG_PATH = CM_CONFIG
config_manager.CONFIG_TEMPLATE_PATH = CM_TEMPLATE
config_manager.PROVIDER_STORE_PATH = CM_STORE

assert REAL_CONFIG.name == "config.json", "真实配置路径意外"
assert TMP not in REAL_CONFIG.parents and REAL_CONFIG != CM_CONFIG, "测试路径未隔离"

passed = 0
failed = 0


def run(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f"PASS {name}")
    except Exception as exc:  # noqa: BLE001 - 单测统一收口
        failed += 1
        print(f"FAIL {name}: {type(exc).__name__}: {exc}")


def expect_error(exc_type, fn, label):
    try:
        fn()
    except exc_type:
        return
    except Exception as exc:  # noqa: BLE001
        raise AssertionError(f"{label}：期望 {exc_type.__name__}，实际 {type(exc).__name__}: {exc}")
    raise AssertionError(f"{label}：期望 {exc_type.__name__}，实际没有抛异常")


def boom_readback(path, payload):
    raise OSError("simulated read-back mismatch")


def reset_files():
    for path in (CM_CONFIG, CM_STORE, TMP / "a.json"):
        try:
            path.unlink()
        except FileNotFoundError:
            pass


# ── 1. 落盘字节就是「唯一序列化源」产出的字节（不是重新 dump 的近似物）──────
def t_exact_bytes():
    reset_files()
    path = TMP / "a.json"
    data = {"名字": "小七", "nums": [1, 2, 3], "ok": True, "nil": None}
    state_io.atomic_write_json(path, data)
    raw = path.read_bytes()
    expected = state_io.json_payload_bytes(data)
    assert raw == expected, "落盘字节 ≠ json_payload_bytes"
    text = raw.decode("utf-8")
    assert "名字".encode("utf-8") in raw, "ensure_ascii=False 失效（中文被转义）"
    assert text == json.dumps(data, ensure_ascii=False, indent=2) + "\n", "格式/尾换行不符"
    assert json.loads(text) == data, "读回结构不一致"


# ── 2. 写完不留临时文件（temp+replace 的清理仍然有效）──────────────────────
def t_no_temp_leftovers():
    reset_files()
    path = TMP / "a.json"
    state_io.atomic_write_json(path, {"x": 1})
    leftovers = sorted(p.name for p in TMP.glob(".a.json.*"))
    assert not leftovers, f"残留临时文件：{leftovers}"


# ── 3. verify_json_readback：一致返回 True ───────────────────────────────
def t_verify_ok():
    path = TMP / "a.json"
    payload = state_io.json_payload_bytes({"x": 1})
    path.write_bytes(payload)
    assert state_io.verify_json_readback(path, payload) is True


# ── 4. verify_json_readback：少一个字节就必须抛（整文件 digest，不是抽样）──
def t_verify_truncated():
    path = TMP / "a.json"
    payload = state_io.json_payload_bytes({"x": 1})
    path.write_bytes(payload[:-1])
    expect_error(OSError, lambda: state_io.verify_json_readback(path, payload), "截断文件")


# ── 5. verify_json_readback：合法 JSON 但内容不同也要抛（不是「能解析就算过」）─
def t_verify_same_shape_diff_value():
    path = TMP / "a.json"
    expected = state_io.json_payload_bytes({"x": 1})
    path.write_bytes(state_io.json_payload_bytes({"x": 2}))
    expect_error(OSError, lambda: state_io.verify_json_readback(path, expected), "同结构不同值")


# ── 6. atomic_write_json 真的接线到校验（不是死代码）──────────────────────
def t_atomic_is_wired_to_verify():
    reset_files()
    path = TMP / "a.json"
    original = state_io.verify_json_readback
    state_io.verify_json_readback = boom_readback
    try:
        expect_error(OSError, lambda: state_io.atomic_write_json(path, {"x": 1}), "注入校验失败")
    finally:
        state_io.verify_json_readback = original


# ── 7. 真实链路：replace 后文件被截断 → 必须发现（模拟 AV 重写/半截写）────
def t_real_truncation_detected():
    reset_files()
    path = TMP / "a.json"
    real_replace = os.replace

    def truncating_replace(src, dst):
        real_replace(src, dst)
        size = os.path.getsize(dst)
        with open(dst, "r+b") as stream:
            stream.truncate(max(0, size - 3))

    os.replace = truncating_replace
    try:
        expect_error(OSError, lambda: state_io.atomic_write_json(path, {"x": 1}), "截断 replace")
    finally:
        os.replace = real_replace


# ── 8. save_config 成功：返回 True 且磁盘可读、内容正确 ──────────────────
def t_save_config_ok():
    reset_files()
    doc = config_manager.load_config()
    assert not doc._load_error, f"应能新建 config.json：{doc._load_error}"
    doc["ui"] = {"show_chat_box": False, "model_scale": 2.3}
    doc["asr"] = {"ptt_key": "v"}
    assert config_manager.save_config(doc) is True, "save_config 应返回 True"
    disk = json.loads(CM_CONFIG.read_text(encoding="utf-8"))
    assert disk["ui"]["show_chat_box"] is False
    assert disk["ui"]["model_scale"] == 2.3
    assert disk["asr"]["ptt_key"] == "v"
    assert doc._source_snapshot.get("ui") == {"show_chat_box": False, "model_scale": 2.3}, (
        "成功后内存快照应同步"
    )


# ── 9. save_config 读回失败 → False（绝不静默当成功），快照不提交 ────────
def t_save_config_readback_fail():
    reset_files()
    doc = config_manager.load_config()
    doc["persona"] = {"name": "小七"}
    original = state_io.verify_json_readback
    state_io.verify_json_readback = boom_readback
    try:
        assert config_manager.save_config(doc) is False, "校验失败必须返回 False"
    finally:
        state_io.verify_json_readback = original
    assert "persona" not in doc._source_snapshot, "校验失败不得提交内存快照"


# ── 10. save_config 保留原有失败路径：不可序列化 → False，目标文件不动 ──
def t_save_config_unserializable():
    reset_files()
    doc = config_manager.load_config()
    doc["ui"] = {"show_chat_box": True}
    assert config_manager.save_config(doc) is True
    before = CM_CONFIG.read_bytes()
    assert config_manager.save_config({"oops": object()}) is False, "不可序列化应返回 False"
    assert CM_CONFIG.read_bytes() == before, "失败时目标文件不得被改写"
    leftovers = sorted(p.name for p in TMP.glob(".config.json.*"))
    assert not leftovers, f"失败后残留临时文件：{leftovers}"


# ── 11. save_config 保留原有失败路径：load_error 文档拒绝覆盖 ────────────
def t_save_config_load_error():
    reset_files()
    config_manager.load_config()
    before = CM_CONFIG.read_bytes()
    bad = config_manager.ConfigDocument(load_error="unreadable")
    assert config_manager.save_config(bad) is False, "load_error 文档必须拒绝保存"
    assert CM_CONFIG.read_bytes() == before, "拒绝保存时不得碰盘"


# ── 12. save_provider_store 成功：规范化后落盘可读 ──────────────────────
def t_save_store_ok():
    reset_files()
    ok = config_manager.save_provider_store([
        {"id": "p1", "name": "主", "api_key": "k", "api_url": "u", "models": [{"model_id": "m1"}]},
    ])
    assert ok is True, "save_provider_store 应返回 True"
    disk = json.loads(CM_STORE.read_text(encoding="utf-8"))
    assert [p["id"] for p in disk["providers"]] == ["p1"]
    assert disk["providers"][0]["models"][0]["model_id"] == "m1"


# ── 13. save_provider_store 读回失败 → False ───────────────────────────
def t_save_store_readback_fail():
    reset_files()
    original = state_io.verify_json_readback
    state_io.verify_json_readback = boom_readback
    try:
        ok = config_manager.save_provider_store([{"id": "p2", "models": []}])
    finally:
        state_io.verify_json_readback = original
    assert ok is False, "校验失败必须返回 False"


# ── 14. 真链路：写盘被截断 → save_provider_store False ──────────────────
def t_save_store_truncation_is_not_silent():
    reset_files()
    real_replace = os.replace

    def truncating_replace(src, dst):
        real_replace(src, dst)
        size = os.path.getsize(dst)
        with open(dst, "r+b") as stream:
            stream.truncate(max(0, size - 3))

    os.replace = truncating_replace
    try:
        ok = config_manager.save_provider_store([{"id": "p3", "models": []}])
    finally:
        os.replace = real_replace
    assert ok is False, "截断的写盘不能被当作成功"


# ── 15. HTTP 契约：校验失败 → 500（现有失败路径保持，不降级为 200）───────
def t_route_returns_500():
    from flask import Flask

    reset_files()
    app = Flask(__name__)
    app.config.update(TESTING=True)
    app.register_blueprint(config_manager.config_bp)
    client = app.test_client()

    original = state_io.verify_json_readback
    state_io.verify_json_readback = boom_readback
    try:
        resp = client.post(
            "/api/config/llm",
            json={"providers": [{"id": "p1", "models": [{"model_id": "m1"}]}]},
        )
    finally:
        state_io.verify_json_readback = original
    assert resp.status_code == 500, f"期望 500，实际 {resp.status_code}"
    payload = resp.get_json()
    assert payload and "error" in payload, f"应返回错误体：{payload}"


for _name, _fn in [
    ("atomic 落盘字节=唯一序列化源", t_exact_bytes),
    ("atomic 不留临时文件", t_no_temp_leftovers),
    ("readback 一致通过", t_verify_ok),
    ("readback 截断必抛", t_verify_truncated),
    ("readback 同结构不同值必抛", t_verify_same_shape_diff_value),
    ("atomic 接线到 readback", t_atomic_is_wired_to_verify),
    ("真实截断被 atomic 发现", t_real_truncation_detected),
    ("save_config 成功", t_save_config_ok),
    ("save_config 读回失败 → False", t_save_config_readback_fail),
    ("save_config 不可序列化 → False 且不改盘", t_save_config_unserializable),
    ("save_config load_error 拒写", t_save_config_load_error),
    ("save_provider_store 成功", t_save_store_ok),
    ("save_provider_store 读回失败 → False", t_save_store_readback_fail),
    ("save_provider_store 截断不静默", t_save_store_truncation_is_not_silent),
    ("HTTP 校验失败 → 500", t_route_returns_500),
]:
    run(_name, _fn)

shutil.rmtree(TMP, ignore_errors=True)
print(f"PASS {passed} / FAIL {failed}")
sys.exit(0 if failed == 0 else 1)
