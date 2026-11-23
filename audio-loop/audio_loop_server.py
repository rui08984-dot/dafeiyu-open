"""
audio_loop_server.py —— 「一起看」的耳朵：抓取电脑正在播放的声音，切成语句送去识别。

为什么要它：桌宠要「和你同频道一起看剧」，就得听见剧里的对白。
Windows 上最干净的做法是 WASAPI loopback（录制扬声器输出，不需要任何虚拟声卡），
soundcard 这个库直接暴露「默认扬声器的回环设备」，跟随用户切换耳机/音箱。

流程：
  WASAPI loopback 16k 单声道 → 能量 VAD 切句 → 送 SenseVoice(:1000) → 带时间戳的滚动字幕

接口（默认 127.0.0.1:1001）：
  GET  /health              服务状态、是否在录、缓冲区句数
  GET  /segments?since=ms   取 since 之后的句子
  GET  /now?seconds=40      最近 N 秒拼成一段文本（给模型直接读）
  POST /pause {"on":bool}   她自己在说话时暂停采集，避免听见自己
  POST /clear               清空滚动缓冲
"""

from __future__ import annotations

import argparse
import json
import queue
import threading
import time
import urllib.request
import uuid
import warnings as _warnings

# 日志降噪（2026-11-08）：soundcard 的 mediafoundation 后端在长时间回环录制里会周期性抛
# 「data discontinuity in recording」——这是 Windows 音频缓冲的正常抖动，不影响识别，
# 但它每秒打一行堆栈把日志淹掉。只静这一条，别的警告照常。
_warnings.filterwarnings('ignore', message='data discontinuity in recording')

import numpy as np
# 声学层是共用实现（麦克风那一路也用同一套字段），放在 audio_common/ 下
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', 'audio_common')))
from acoustic import acoustic_profile, classify_sound  # noqa: E402
from voice_id import analyze_voice  # noqa: E402

def _voiceprint256(pcm, timeout_s: float = 1.5):
    """resemblyzer 256 维声纹（8020 隔离 venv 服务）；服务不在线返回 None（回落 16 维带指纹）。
    服务本体：audio_common/voiceprint_server.py，由 launch-my-neuro 用 venv-voice python 拉起。"""
    try:
        data = json.dumps({"pcm": [float(x) for x in pcm]}).encode("utf-8")
        req = urllib.request.Request("http://127.0.0.1:8020/embed", data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            j = json.loads(r.read().decode("utf-8"))
            return j.get("embedding")
    except Exception:
        return None
from emotion_arc import build_arc, summarize_arc  # noqa: E402
import ser as ser_mod  # noqa: E402

SAMPLE_RATE = 16000
BLOCK_MS = 100
BLOCK = int(SAMPLE_RATE * BLOCK_MS / 1000)

MIN_SPEECH_MS = 500        # 短于这个当噪声
MAX_SEGMENT_MS = 15000     # 单句上限，防止一直说不切
SILENCE_TAIL_MS = 700      # 静音多久算一句说完
VAD_ON_RMS = 0.006         # 起说阈值
VAD_OFF_RMS = 0.0035       # 停说阈值（滞回，避免抖）



# ────────────────────────── 声学画像 ──────────────────────────
# 为什么不用模型：情绪识别模型（emotion2vec 之类）要 torch，几 GB，还得单独跑一条推理链；
# 而「这段声音是音乐还是人在说话、气氛是吵还是静」用几个频谱统计量就能判得很准，
# 代价是几百微秒。先用这一层兜住 80% 的需求，真需要细粒度情绪再上模型。
class RollingTranscript:
    def __init__(self, keep_seconds: float = 600.0):
        self.keep = keep_seconds
        self.items: list[dict] = []
        self.lock = threading.Lock()

    def add(self, text: str, started_ms: int, ended_ms: int, tone: dict | None = None) -> dict:
        item = {"id": uuid.uuid4().hex[:8], "text": text, "start": started_ms, "end": ended_ms}
        if tone:
            item["tone"] = tone
        with self.lock:
            self.items.append(item)
            self._prune()
        return item

    def _prune(self):
        cutoff = time.time() * 1000 - self.keep * 1000
        self.items = [x for x in self.items if x["end"] >= cutoff]

    def since(self, since_ms: int) -> list[dict]:
        with self.lock:
            return [dict(x) for x in self.items if x["end"] > since_ms]

    def window(self, seconds: float) -> list[dict]:
        since = time.time() * 1000 - seconds * 1000
        with self.lock:
            return [dict(x) for x in self.items if x["end"] >= since]

    def clear(self):
        with self.lock:
            self.items = []


class AudioLoop:
    def __init__(self, asr_url: str, log=print):
        self.asr_url = asr_url.rstrip("/")
        self.log = log
        self.transcript = RollingTranscript()
        self.paused = threading.Event()
        self.stopping = threading.Event()
        self.recording = False
        self.device_name = ""
        self.device_changes = 0
        self.errors: list[str] = []
        self.asr_calls = 0
        self.asr_fails = 0
        self._q: queue.Queue[np.ndarray] = queue.Queue(maxsize=200)

    # ---------- 采集 ----------
    def _capture_loop(self):
        try:
            import soundcard as sc
        except Exception as exc:  # pragma: no cover
            self._fail(f"缺 soundcard 库：{exc}（py -m pip install soundcard）")
            return
        # ⚠ 2026-11-13：`import soundcard` **本身会重置 warnings filters** —— 模块顶部
        #   第 33 行那条 ignore 被它冲掉了，于是「data discontinuity in recording」照样
        #   每秒一行（实测占主日志 50%，12746 行）。必须在 import 之后再压一次。
        #   实测对比：import 之前设 → 无效；import 之后设 → 静音。
        _warnings.filterwarnings('ignore', message='data discontinuity in recording')
        _warnings.filterwarnings('ignore', category=sc.SoundcardRuntimeWarning)

        while not self.stopping.is_set():
            try:
                speaker = sc.default_speaker()
                mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
                if mic is None:
                    self._fail(f"拿不到 {speaker.name} 的回环设备")
                    time.sleep(3)
                    continue
                self.device_name = str(speaker.name)
                self.recording = True
                self.log(f"[loop] 开始监听输出设备：{self.device_name}")
                _last_dev_check = time.time()
                with mic.recorder(samplerate=SAMPLE_RATE, channels=2, blocksize=BLOCK) as rec:
                    while not self.stopping.is_set():
                        # 2026-11-23：跟随默认输出设备切换（扬声器 ↔ 耳机/蓝牙）。
                        # WASAPI 回环录的是「渲染端点」的混音，耳机只要是默认设备就录得到；
                        # 但旧实现只在启动时取一次 default_speaker()，切走后会一直录旧设备
                        # （或录到无声）直到重启服务。这里每 5 秒轻量比较一次设备名。
                        _now = time.time()
                        if _now - _last_dev_check >= 5:
                            _last_dev_check = _now
                            try:
                                _cur = str(sc.default_speaker().name)
                            except Exception:
                                _cur = self.device_name
                            if _cur and _cur != self.device_name:
                                self.device_changes += 1
                                self.log(f"[loop] 输出设备已切换：{self.device_name} → {_cur}，重开回环")
                                break
                        data = rec.record(numframes=BLOCK)
                        if self.paused.is_set():
                            continue
                        mono = np.asarray(data, dtype=np.float32).mean(axis=1)
                        try:
                            self._q.put_nowait(mono)
                        except queue.Full:
                            pass
            except Exception as exc:
                self.recording = False
                self._fail(f"采集中断：{type(exc).__name__}: {exc}")
                time.sleep(2)

    def _fail(self, message: str):
        self.log("[loop][ERR] " + message)
        self.errors.append(message)
        self.errors = self.errors[-8:]

    # ---------- 切句 + 识别 ----------
    def _segment_loop(self):
        buf: list[np.ndarray] = []
        voiced = False
        silence_ms = 0
        seg_start = 0.0

        while not self.stopping.is_set():
            try:
                block = self._q.get(timeout=0.5)
            except queue.Empty:
                continue

            rms = float(np.sqrt(np.mean(block ** 2)) + 1e-9)
            now_ms = int(time.time() * 1000)

            if not voiced:
                if rms >= VAD_ON_RMS:
                    voiced = True
                    silence_ms = 0
                    seg_start = time.time() * 1000
                    buf = [block]
                continue

            buf.append(block)
            if rms < VAD_OFF_RMS:
                silence_ms += BLOCK_MS
            else:
                silence_ms = 0

            seg_len = len(buf) * BLOCK_MS
            finished = silence_ms >= SILENCE_TAIL_MS or seg_len >= MAX_SEGMENT_MS
            if not finished:
                continue

            audio = np.concatenate(buf)
            buf = []
            voiced = False
            silence_ms = 0
            if seg_len < MIN_SPEECH_MS:
                continue
            self._transcribe(audio, int(seg_start), now_ms)

    def _transcribe(self, audio: np.ndarray, start_ms: int, end_ms: int):
        pcm = np.clip(audio, -1.0, 1.0)
        pcm16 = (pcm * 32767.0).astype(np.int16)
        wav = _wav_bytes(pcm16, SAMPLE_RATE)
        boundary = "----pet" + uuid.uuid4().hex
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="chunk.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n"
        ).encode("utf-8") + wav + f"\r\n--{boundary}--\r\n".encode("utf-8")

        self.asr_calls += 1
        try:
            req = urllib.request.Request(
                self.asr_url + "/v1/upload_audio",
                data=body,
                headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            text = str(payload.get("text") or "").strip()
            # ASR 那边用的是同一个 SenseVoice，它自带 SER/AED，比我们这边的声学猜测准
            ser_info = ser_mod.from_result(
                payload.get("emotion") or "",
                payload.get("event") or "",
                payload.get("lang") or "",
            )
            # ASR 那边可能已经合成好了（tone.ser=true），直接用，别再重算一遍
            _t = payload.get("tone") or {}
            if not ser_info and _t.get("ser"):
                ser_info = {"kind": _t.get("kind"), "mood": _t.get("mood"),
                            "arousal": _t.get("arousal"), "cues": _t.get("cues"),
                            "emotion_zh": _t.get("emotion_zh"), "event_zh": _t.get("event_zh")}
        except Exception as exc:
            self.asr_fails += 1
            self._fail(f"识别失败：{exc}")
            return

        # 没有文字也别急着丢：音乐、掌声、吵架的嘈杂都是「气氛」，
        # 一起看的时候她需要知道「现在没人在说话，在放音乐」。
        if not text or len(text) < 2:
            profile = acoustic_profile(pcm, SAMPLE_RATE)
            kinds = classify_sound(profile, False, 0)
            # SER 说这是什么就用什么（BGM/掌声/哭声…），声学结果只作兜底
            if ser_info and ser_info.get("kind"):
                kinds = dict(kinds or {})
                kinds.update({
                    "kind": ser_info["kind"],
                    "mood": ser_info.get("mood") or kinds.get("mood"),
                    "arousal": ser_info.get("arousal") if ser_info.get("arousal") is not None else kinds.get("arousal"),
                    "cues": ser_info.get("cues") or kinds.get("cues"),
                })
            duration_s0 = max(0.001, (end_ms - start_ms) / 1000.0)
            # 太短或太安静就当噪声丢掉，别把 VAD 的碎片也记下来
            if profile and profile.get("rms", 0) > 0.008 and duration_s0 >= 1.2:
                tone = {
                    "rms": profile.get("rms"),
                    "peak": profile.get("peak"),
                    "duration": round(duration_s0, 2),
                    "kind": kinds.get("kind"),
                    "mood": kinds.get("mood"),
                    "arousal": kinds.get("arousal"),
                    "cues": kinds.get("cues"),
                    "centroid": profile.get("centroid"),
                    "flatness": profile.get("flatness"),
                    "flux": profile.get("flux"),
                    "zcr": profile.get("zcr"),
                    "beat": profile.get("beat"),
                    "no_speech": True,
                    "source": "system",
                }
                label = {"music": "[音乐]", "noise": "[嘈杂]", "ambient": "[环境声]", "silence": "[安静]"}.get(kinds.get("kind"), "[声音]")
                item = self.transcript.add(label, start_ms, end_ms, tone)
                self.log(f"[loop] {item['id']} {label} {kinds.get('kind')}/{kinds.get('mood')}")
            return
        # 语气线索：同一句话里，音量、语速、停顿都能透露情绪。
        # 不需要情绪识别模型 —— 大声/小声、说得多快、中间断多久，三个数就够。
        rms_arr = np.sqrt(np.mean(pcm16.astype(np.float32).reshape(-1, 1), axis=1) ** 2) if False else np.sqrt(np.mean(pcm.astype(np.float32) ** 2))
        peak = float(np.max(np.abs(pcm))) if pcm.size else 0.0
        duration_s = max(0.001, (end_ms - start_ms) / 1000.0)
        chars_per_sec = len(text) / duration_s
        # 静音占比：能量低于阈值的帧比例，越高说明说得越断续/犹豫
        frame = max(1, int(SAMPLE_RATE * 0.05))
        frames = [pcm[i:i+frame] for i in range(0, len(pcm) - frame, frame)]
        quiet = sum(1 for f in frames if float(np.sqrt(np.mean(f ** 2))) < VAD_OFF_RMS) if frames else 0
        quiet_ratio = quiet / max(1, len(frames))
        # 声学画像 + 分类：这段声音是什么（人声/音乐/噪声/环境）+ 气氛（静/有动静/很激烈）
        profile = acoustic_profile(pcm, SAMPLE_RATE)
        kinds = classify_sound(profile, bool(text), len(text))
        # 有人在说话时，情绪用 SenseVoice 的 SER（HAPPY/SAD/ANGRY…），这是真情绪语义，
        # 声学层只能给出「激烈/平静」，分不清生气和兴奋。
        if ser_info and ser_info.get("kind") == "speech" and ser_info.get("mood"):
            kinds = dict(kinds or {})
            kinds["mood"] = ser_info["mood"]
            if ser_info.get("arousal") is not None:
                kinds["arousal"] = ser_info["arousal"]
            kinds["cues"] = ser_info.get("cues") or kinds.get("cues")
        # 说话人粗分：基频+谱质心 → 男/女/童声 + 16 维简易声纹（纯 numpy，零模型）。
        # 只有「人声」段才算，音乐/噪声段不浪费 CPU。
        voice = analyze_voice(pcm, SAMPLE_RATE) if kinds.get("kind") == "speech" else None
        # 声纹升级：优先 resemblyzer 256 维（8020 服务），不在线回落 analyze_voice 的 16 维带指纹
        vp256 = _voiceprint256(pcm) if voice is not None else None
        tone = {
            "f0_hz": (voice or {}).get("f0_hz"),
            "voice_class": (voice or {}).get("voice_class"),
            "voiceprint": (voice or {}).get("voiceprint") or [],
            "voiceprint256": vp256,
            "rms": round(float(rms_arr), 4),
            "peak": round(peak, 3),
            "chars_per_sec": round(chars_per_sec, 2),
            "quiet_ratio": round(quiet_ratio, 3),
            "duration": round(duration_s, 2),
            "kind": kinds.get("kind"),
            "mood": kinds.get("mood"),
            "arousal": kinds.get("arousal"),
            "cues": kinds.get("cues"),
            "centroid": profile.get("centroid"),
            "flatness": profile.get("flatness"),
            "flux": profile.get("flux"),
            "zcr": profile.get("zcr"),
            "beat": profile.get("beat"),
            "emotion_zh": (ser_info or {}).get("emotion_zh"),
            "event_zh": (ser_info or {}).get("event_zh"),
            "ser": bool(ser_info),
            "source": "system",     # 这一路永远是「机器在放的声音」，麦克风那一路由 ASR 负责
        }
        item = self.transcript.add(text, start_ms, end_ms, tone)
        self.log(f"[loop] {item['id']} [{kinds.get('kind')}/{kinds.get('mood')}] {text[:50]}")

    # ---------- 生命周期 ----------
    def start(self):
        threading.Thread(target=self._capture_loop, daemon=True).start()
        threading.Thread(target=self._segment_loop, daemon=True).start()

    def stop(self):
        self.stopping.set()


def _wav_bytes(pcm16: np.ndarray, rate: int) -> bytes:
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm16.tobytes())
    return buf.getvalue()


def make_server(service: AudioLoop, port: int):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import urlparse, parse_qs

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            return

        # 客户端（doctor 探活 / 桌宠轮询）连上就断时会抛 ConnectionResetError，
        # 默认实现会打整页 traceback —— 纯噪声，且把真错误淹掉。
        # 这里只吞「连接已断」这一类（OSError 含 WinError 10054/10053），
        # 其余异常照旧抛出（不静默）。首次出现打一行精简提示便于排查。
        def handle_one_request(self):
            try:
                super().handle_one_request()
            except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                if not getattr(Handler, "_reset_logged", False):
                    Handler._reset_logged = True
                    print("[loop] 客户端提前断开连接（正常现象，后续同类不再打印）", flush=True)
                self.close_connection = True

        def _json(self, code: int, obj: dict):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            qs = parse_qs(url.query)
            if url.path == "/health":
                return self._json(200, {
                    "ok": True,
                    "recording": service.recording,
                    "device": service.device_name,
                    "device_changes": service.device_changes,
                    "paused": service.paused.is_set(),
                    "segments": len(service.transcript.items),
                    "asr_calls": service.asr_calls,
                    "asr_fails": service.asr_fails,
                    "errors": service.errors[-3:],
                })
            if url.path == "/segments":
                since = int(qs.get("since", ["0"])[0] or 0)
                items = service.transcript.since(since)
                return self._json(200, {"ok": True, "count": len(items), "items": items,
                                         "cursor": items[-1]["end"] if items else since})
            if url.path == "/arc":
                window_s = float(qs.get("window", ["30"])[0] or 30)
                arc = build_arc(service.transcript.items, window_s=window_s)
                out = summarize_arc(arc)
                return self._json(200, {"ok": True, **out, "windows_tail": arc[-6:]})
            if url.path == "/now":
                seconds = float(qs.get("seconds", ["40"])[0] or 40)
                items = service.transcript.window(seconds)
                text = " ".join(x["text"] for x in items).strip()
                return self._json(200, {"ok": True, "seconds": seconds, "text": text, "count": len(items)})
            return self._json(404, {"ok": False, "error": "not found"})

        def do_POST(self):
            url = urlparse(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                body = {}
            if url.path == "/pause":
                on = bool(body.get("on"))
                if on:
                    service.paused.set()
                else:
                    service.paused.clear()
                return self._json(200, {"ok": True, "paused": on})
            if url.path == "/clear":
                service.transcript.clear()
                return self._json(200, {"ok": True})
            return self._json(404, {"ok": False, "error": "not found"})

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=1001)
    ap.add_argument("--asr", default="http://127.0.0.1:1000")
    args = ap.parse_args()

    service = AudioLoop(args.asr)
    service.start()
    server = make_server(service, args.port)
    print(f"[loop] 一起看·耳朵已启动 http://127.0.0.1:{args.port}  (ASR: {args.asr})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()


if __name__ == "__main__":
    main();