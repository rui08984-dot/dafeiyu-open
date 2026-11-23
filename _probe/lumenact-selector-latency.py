#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""_probe/lumenact-selector-latency.py —— 量 LumenAct 语义选择器（RBT3-Lumen-38M-v6）的 CPU 延迟

为什么量这个：§61.8 说「情绪/意图路由值得做小分类器」，而 LumenAct 已经把
(情绪描述, 台词) → (emotion, context, speech_style) 训好了（Apache-2.0）。
如果 CPU 单次 < 30ms，它就能直接进我们的实时链路（每句话一次），不用自己训。

只读本地文件，不联网。用法：
  python _probe/lumenact-selector-latency.py
"""
import json
import os
import statistics
import sys
import time

import numpy as np
import onnxruntime as ort

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "_research", "lumenact", "models")
CFG = os.path.join(ROOT, "_research", "lumenact", "assets", "semantic-config.json")


def main():
    cfg = json.load(open(CFG, encoding="utf-8"))
    onnx_path = os.path.join(MODELS, cfg["model_file"])
    tok_path = os.path.join(MODELS, "tokenizer.json")
    if not os.path.exists(onnx_path):
        print("缺模型：", onnx_path)
        return 1
    print("模型", cfg["name"], "max_length", cfg.get("max_length"), "文件",
          round(os.path.getsize(onnx_path) / 1024 / 1024, 1), "MB")

    # ── 分词：transformers 没装 torch 也能用 tokenizer（后端是 tokenizers）──
    try:
        from transformers import PreTrainedTokenizerFast
        tok = PreTrainedTokenizerFast(tokenizer_file=tok_path)
    except Exception as e:
        print("分词器加载失败：", e)
        return 1

    # ── 会话 ──
    so = ort.SessionOptions()
    so.intra_op_num_threads = min(4, os.cpu_count() or 4)
    t0 = time.perf_counter()
    sess = ort.InferenceSession(onnx_path, so, providers=["CPUExecutionProvider"])
    load_ms = (time.perf_counter() - t0) * 1000
    print("加载耗时 %.0f ms" % load_ms)
    print("输入:", [(i.name, i.shape, i.type) for i in sess.get_inputs()])
    print("输出:", [(o.name, o.shape, o.type) for o in sess.get_outputs()])

    max_len = int(cfg.get("max_length") or 96)
    samples = [
        ("开心地打招呼", "早上好！今天也一起加油吧"),
        ("被夸了有点害羞", "你这样说我会不好意思的"),
        ("突然被吓到", "诶？！什么时候来的"),
        ("有点生气但忍着", "……算了，不说了"),
        ("温柔地安慰对方", "没关系，慢慢来就好"),
        ("反问质疑", "你确定是这样吗？"),
    ]

    def run(intent, text):
        # 输入是一对中文字符串：情绪描述 + 台词。用分隔符拼起来最稳（不同模型约定不同，
        # 这里按「[CLS] intent [SEP] text [SEP]」喂，取不到多输入时就是单条 input_ids）。
        enc = tok(intent, text, max_length=max_len, truncation=True, return_tensors="np")
        feeds = {}
        for inp in sess.get_inputs():
            name = inp.name
            if name in enc:
                feeds[name] = np.asarray(enc[name]).astype(np.int64)
            elif name == "token_type_ids":
                # 不带 tokenizer_config 的 fast tokenizer 不产 token_type_ids，补零即可
                feeds[name] = np.zeros_like(np.asarray(enc["input_ids"]), dtype=np.int64)
            elif name == "attention_mask":
                feeds[name] = np.ones_like(np.asarray(enc["input_ids"]), dtype=np.int64)
            elif name == "input_ids" and "input_ids" not in enc:
                ids = tok.encode(intent + " " + text, max_length=max_len, truncation=True)
                feeds[name] = np.array([ids], dtype=np.int64)
        outs = sess.run(None, feeds)
        return outs, [i.name for i in sess.get_outputs()]

    # 预热一次
    try:
        run(*samples[0])
    except Exception as e:
        print("首次推理失败：", type(e).__name__, e)
        return 1

    lat = []
    last = None
    for intent, text in samples * 3:
        t = time.perf_counter()
        outs, names = run(intent, text)
        lat.append((time.perf_counter() - t) * 1000)
        last = (intent, text, names, outs)

    lat_sorted = sorted(lat)
    print("\n单次推理（%d 次）：中位 %.1f ms · p90 %.1f ms · 最小 %.1f · 最大 %.1f" % (
        len(lat), statistics.median(lat), lat_sorted[int(len(lat) * 0.9)], lat_sorted[0], lat_sorted[-1]))

    # ── 解析输出（输出个数与 config 的清单可能差 1，取较小长度对齐）──
    def softmax(x):
        e = np.exp(x - np.max(x))
        return e / e.sum()

    label_sets = [
        ("category", cfg["catalog"]["labels"], 3),
        ("voice", cfg["catalog"]["speech_styles"], 3),
        ("context", [c.get("label") or c.get("context_id") for c in cfg["catalog"].get("contexts", [])], 2),
    ]
    print("\n语义样例（每行：输入 → category / voice / context）")
    for intent, text in samples:
        outs, names = run(intent, text)
        line = []
        for key, names_list, k in label_sets:
            idx = next((i for i, n in enumerate(names) if n == key), None)
            if idx is None:
                continue
            vec = np.array(outs[idx]).reshape(-1)
            n = min(len(vec), len(names_list))
            if n <= 0:
                continue
            prob = softmax(vec[:n])
            top = np.argsort(-prob)[:k]
            line.append("%s: %s" % (key, ", ".join("%s %.2f" % (names_list[i], prob[i]) for i in top)))
        print("  %-16s | %-18s → %s" % (intent, text, " / ".join(line)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
