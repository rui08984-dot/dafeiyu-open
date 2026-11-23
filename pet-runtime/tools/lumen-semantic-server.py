#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
lumen-semantic-server.py —— LumenAct 语义选择器常驻服务（2026-11-17 六十五轮）

为什么要有它（对应 ADR-004「小模型不进帧循环」）：
  RBT3-Lumen-38M-v6 实测 CPU 单次 7.5–8.5ms —— 对「每句话一次」够快，
  但绝不能塞进 60fps 的渲染循环，也不该让渲染层去做模型加载（244ms + 146MB）。
  所以做成**常驻 HTTP 服务**：模型只加载一次，渲染层/插件按需调一次。

  HTTP 而不是 stdin/stdout：调用方可能是渲染层 JS、Node 工具、Python 脚本三方，
  HTTP 是最不容易被"谁持有 stdin"搞坏的形态（pet-core 那条管道只服务单一宿主）。

接口：
  GET  /health              → {ok, ready, model, loadedMs, calls, lastMs}
  POST /semantic            → {ok, category, confidence, voice, voiceConfidence,
                               contextIndex, voiceTop, elapsedMs, model}
        body: {"intent": "被夸有点害羞", "text": "你这样说我会不好意思的"}

用法：
  python pet-runtime/tools/lumen-semantic-server.py [--port 8120] [--host 127.0.0.1]
  python pet-runtime/tools/lumen-semantic-server.py --check     # 仅自检（加载+跑一条）
退出码：0 = 正常；1 = 模型/依赖缺失（会把缺什么说清楚）

资产位置：_research/lumenact/models/{selector.onnx,tokenizer.json}
（该目录 gitignored —— 146MB 权重不入库；缺失时本服务如实报错，不降级假装可用）
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))   # pet-runtime/tools -> 仓库根
MODELS = os.path.join(ROOT, "_research", "lumenact", "models")
CFG = os.path.join(ROOT, "_research", "lumenact", "assets", "semantic-config.json")

DEFAULT_PORT = 8120
MAX_BODY = 64 * 1024

LIVE = {"ready": False, "error": None, "loadedMs": None, "calls": 0, "lastMs": None}
SESSION = None
TOKENIZER = None
CFG_DATA = None
LOCK = threading.Lock()


def load_model():
    """加载 ONNX + tokenizer（只做一次）。失败要把原因说清楚，别静默降级。"""
    global SESSION, TOKENIZER, CFG_DATA
    t0 = time.perf_counter()
    if not os.path.exists(CFG):
        raise RuntimeError("缺语义配置：" + CFG + "（先按 §63 从 HuggingFace 取资产）")
    with open(CFG, encoding="utf-8") as f:
        CFG_DATA = json.load(f)
    onnx_path = os.path.join(MODELS, CFG_DATA["model_file"])
    tok_path = os.path.join(MODELS, "tokenizer.json")
    if not os.path.exists(onnx_path):
        raise RuntimeError("缺模型权重：" + onnx_path)
    if not os.path.exists(tok_path):
        raise RuntimeError("缺分词器：" + tok_path)

    import onnxruntime as ort  # 延迟 import：缺依赖时给出人话错误
    from transformers import PreTrainedTokenizerFast

    so = ort.SessionOptions()
    so.intra_op_num_threads = min(4, os.cpu_count() or 4)
    SESSION = ort.InferenceSession(onnx_path, so, providers=["CPUExecutionProvider"])
    TOKENIZER = PreTrainedTokenizerFast(tokenizer_file=tok_path)
    LIVE["loadedMs"] = round((time.perf_counter() - t0) * 1000)
    LIVE["ready"] = True


def softmax(xs):
    import math
    m = max(xs) if xs else 0.0
    ex = [math.exp(x - m) for x in xs]
    s = sum(ex) or 1.0
    return [v / s for v in ex]


def classify(intent, text):
    """(情绪描述, 台词) → 27 类 category + 14 类 voice。返回归一化后的概率列表。"""
    import numpy as np
    enc = TOKENIZER(intent or "", text or "", max_length=int(CFG_DATA.get("max_length") or 96),
                    truncation=True, return_tensors="np")
    feeds = {}
    for inp in SESSION.get_inputs():
        name = inp.name
        if name in enc:
            feeds[name] = np.asarray(enc[name]).astype(np.int64)
        elif name == "token_type_ids":
            feeds[name] = np.zeros_like(np.asarray(enc["input_ids"]), dtype=np.int64)
        elif name == "attention_mask":
            feeds[name] = np.ones_like(np.asarray(enc["input_ids"]), dtype=np.int64)
    outs = SESSION.run(None, feeds)
    names = [o.name for o in SESSION.get_outputs()]
    got = {n: np.array(v).reshape(-1).tolist() for n, v in zip(names, outs)}
    cat_labels = CFG_DATA["catalog"]["labels"]
    voice_labels = CFG_DATA["catalog"]["speech_styles"]

    cat = got.get("category", [])
    cat_p = softmax(cat) if cat else []
    voice = got.get("voice", [])
    voice_p = softmax(voice) if voice else []

    def top(labels, probs, k=3):
        pairs = sorted(zip(labels, probs), key=lambda x: -x[1])[:k]
        return [{"label": a, "p": round(float(b), 4)} for a, b in pairs]

    cat_top = top(cat_labels, cat_p)
    voice_top = top(voice_labels, voice_p)
    return {
        "category": cat_top[0]["label"] if cat_top else None,
        "confidence": cat_top[0]["p"] if cat_top else None,
        "categoryTop": cat_top,
        "voice": voice_top[0]["label"] if voice_top else None,
        "voiceConfidence": voice_top[0]["p"] if voice_top else None,
        "voiceTop": voice_top,
        "model": CFG_DATA.get("name"),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):   # 静音默认访问日志（每句话一条会吵）
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            return self._send(200, {"ok": bool(LIVE["ready"]), "ready": LIVE["ready"],
                                    "error": LIVE["error"], "model": (CFG_DATA or {}).get("name"),
                                    "loadedMs": LIVE["loadedMs"], "calls": LIVE["calls"],
                                    "lastMs": LIVE["lastMs"], "device": "cpu"})
        return self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/semantic":
            return self._send(404, {"ok": False, "error": "not found"})
        if not LIVE["ready"]:
            return self._send(503, {"ok": False, "error": LIVE["error"] or "模型未就绪"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self._send(400, {"ok": False, "error": "body 长度非法"})
            payload = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except Exception as e:
            return self._send(400, {"ok": False, "error": "body 解析失败: " + str(e)})

        intent = str(payload.get("intent") or "").strip()
        text = str(payload.get("text") or "").strip()
        if not intent and not text:
            return self._send(400, {"ok": False, "error": "intent 与 text 至少要给一个"})

        t0 = time.perf_counter()
        try:
            # onnxruntime 的 session.run 对同一 session 并发不安全 → 串行化（8ms 不值得为它写池）
            with LOCK:
                out = classify(intent, text)
        except Exception as e:
            return self._send(500, {"ok": False, "error": "推理失败: " + str(e)})
        ms = round((time.perf_counter() - t0) * 1000, 1)
        LIVE["calls"] += 1
        LIVE["lastMs"] = ms
        out.update({"ok": True, "elapsedMs": ms, "intent": intent, "textLen": len(text)})
        return self._send(200, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--check", action="store_true", help="只做加载+单条推理自检后退出")
    args = ap.parse_args()

    try:
        load_model()
    except Exception as e:
        LIVE["error"] = str(e)
        print("[lumen-semantic] 启动失败：" + str(e), file=sys.stderr)
        return 1

    print("[lumen-semantic] 模型就绪 · %s · 加载 %sms · 端口 %s" %
          (CFG_DATA.get("name"), LIVE["loadedMs"], args.port), flush=True)

    if args.check:
        out = classify("被夸了有点害羞", "你这样说我会不好意思的")
        print(json.dumps(out, ensure_ascii=False, indent=1))
        return 0

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
