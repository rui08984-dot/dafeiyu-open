"""voiceprint_server.py —— 声纹嵌入常驻服务（隔离 venv 专用）。

为什么隔离：resemblyzer 依赖 torch/旧版 numpy，装进系统 Python 会威胁
MemOS/ASR 的 numpy 2.3.5（0xC0000005 前车之鉴）。所以本服务必须用
pet-runtime/venv-voice 的 python 启动，系统侧通过 HTTP 调用。

  POST /embed   body: {"pcm": [float...]}  (16k 单声道 -1..1)
                → {"ok": true, "embedding": [256 floats]}
  GET  /health  → {"ok": true, "loaded": true}

端口 8020。启动：venv-voice/Scripts/python.exe audio_common/voiceprint_server.py
模型加载 0.03s，单次嵌入 CPU ~30ms。
"""

from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import warnings

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
from resemblyzer import VoiceEncoder  # noqa: E402

PORT = 8020
encoder = None


def embed(pcm_list):
    pcm = np.asarray(pcm_list, dtype=np.float32)
    if pcm.size < 16000 // 2:   # <0.5s 的片段嵌入不稳
        return None
    peak = float(np.max(np.abs(pcm)) + 1e-9)
    if peak > 1.5:
        pcm = pcm / peak        # 防爆音
    return encoder.embed_utterance(pcm).tolist()


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "loaded": encoder is not None})
        return self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            return self._json(404, {"ok": False, "error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"ok": False, "error": "bad length"})
        raw = self.rfile.read(length) if length else b"{}"
        try:
            req = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._json(400, {"ok": False, "error": "bad json"})
        pcm = req.get("pcm")
        if not isinstance(pcm, list) or not pcm:
            return self._json(400, {"ok": False, "error": "pcm required"})
        try:
            emb = embed(pcm)
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)[:200]})
        if emb is None:
            return self._json(200, {"ok": True, "embedding": None, "note": "片段太短"})
        return self._json(200, {"ok": True, "embedding": emb})

    def log_message(self, fmt, *args):
        pass   # 静默访问日志（常驻服务不刷屏）


def main():
    global encoder
    encoder = VoiceEncoder("cpu")
    print(f"[voiceprint] 声纹嵌入服务就绪 :{PORT}（256 维，CPU）", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
