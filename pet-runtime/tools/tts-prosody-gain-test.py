#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""_probe 级单测：服务端 prosody_gain_of 的「夹幅 + 非法值不变」边界。

被测对象：<project-root>/edge-tts/tts_server.py 里的纯函数 prosody_gain_of(body)。
为什么从路径加载：目录名 edge-tts 带连字符，不能普通 import。
为什么不会跑 main：spec_from_file_location 的模块名是 tts_server_probe，
模块底部 `if __name__ == "__main__": main()` 不成立；若环境缺 aiohttp/edge_tts，
则退化为 AST 抽出该函数单独 exec，同样不执行模块级 import 与 main。

用法：<user-home>/AppData/Local/Programs/Python/Python313/python.exe \
        pet-runtime/tools/tts-prosody-gain-test.py
"""

import ast
import importlib.util
import sys
from pathlib import Path

try:  # Windows 管道默认 cp936 → 统一 UTF-8，避免中文断言名乱码
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "edge-tts" / "tts_server.py"

passed = 0
failed = 0


def ok(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS " + name + (" — " + detail if detail else ""))
    else:
        failed += 1
        print("  FAIL " + name + (" — " + detail if detail else ""))


def _function_nodes(tree):
    return [n for n in tree.body
            if isinstance(n, ast.FunctionDef) and n.name == "prosody_gain_of"]


def load_prosody_gain():
    """返回 (函数, 加载方式, 模块名或 None, 源码里是否定义了该函数)。"""
    source = SERVER.read_text(encoding="utf-8")
    tree = ast.parse(source)
    nodes = _function_nodes(tree)
    has_fn = len(nodes) == 1

    try:
        spec = importlib.util.spec_from_file_location("tts_server_probe", str(SERVER))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)  # __name__ != "__main__" → main 不会跑
        return mod.prosody_gain_of, "importlib", mod.__name__, has_fn
    except ImportError as exc:
        # 缺 aiohttp/edge_tts 时只取纯函数：不 import 模块、不碰 web 栈
        if not nodes:
            raise
        ns = {}
        exec(compile(ast.Module(body=[nodes[0]], type_ignores=[]), str(SERVER), "exec"), ns)
        return ns["prosody_gain_of"], "ast-fallback(%s)" % exc, None, has_fn


def main():
    ok("被测文件存在", SERVER.is_file(), str(SERVER))
    fn, how, mod_name, has_fn = load_prosody_gain()
    ok("源码顶层定义了 prosody_gain_of", has_fn)
    ok("加载方式", True, how)
    if mod_name is not None:
        ok("模块名不是 __main__（未执行 main）", mod_name != "__main__", mod_name)

    cases = [
        ("空 body", {}, (1.0, 1.0, 1.0)),
        ("字段不是 dict", {"prosody_gain": "x"}, (1.0, 1.0, 1.0)),
        ("空 dict", {"prosody_gain": {}}, (1.0, 1.0, 1.0)),
        ("rate 1.5 夹到 1.1", {"prosody_gain": {"rate": 1.5}}, (1.1, 1.0, 1.0)),
        ("rate 0.1 夹到 0.9", {"prosody_gain": {"rate": 0.1}}, (0.9, 1.0, 1.0)),
        ("rate 0.9 边界保留", {"prosody_gain": {"rate": 0.9}}, (0.9, 1.0, 1.0)),
        ("rate 1.1 边界保留", {"prosody_gain": {"rate": 1.1}}, (1.1, 1.0, 1.0)),
        ("pitch 非数字 → 1.0", {"prosody_gain": {"pitch": "abc"}}, (1.0, 1.0, 1.0)),
        ("pitch None → 1.0", {"prosody_gain": {"pitch": None}}, (1.0, 1.0, 1.0)),
        ("rate 负数 → 1.0（不反向放大）", {"prosody_gain": {"rate": -3}}, (1.0, 1.0, 1.0)),
        ("energy 2 夹到 1.1", {"prosody_gain": {"energy": 2}}, (1.0, 1.0, 1.1)),
        ("只给 pitch 时其余默认 1.0", {"prosody_gain": {"pitch": 1.05}}, (1.0, 1.05, 1.0)),
    ]
    for name, body, want in cases:
        got = fn(body)
        ok(name, got == want, "got=%r want=%r" % (got, want))

    got = fn({"prosody_gain": {"rate": 1.06, "pitch": 1.08, "energy": 1.08}})
    ok("已合法三元组原样通过", got == (1.06, 1.08, 1.08), repr(got))
    ok("返回值恒为三元组", isinstance(got, tuple) and len(got) == 3, repr(got))
    ok("三个值都是 float", all(isinstance(v, float) for v in got), repr(got))

    print("PASS %d / FAIL %d" % (passed, failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
