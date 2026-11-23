#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地语音识别服务：SenseVoice(ONNX) + Silero VAD —— 给桌宠当「耳朵」。

契约（严格照 my-neuro 的 js/voice/asr-processor.js 实现）：

  1) POST http://127.0.0.1:1000/v1/upload_audio
     - multipart/form-data，字段名 file，内容是 WAV（16k 单声道 16bit 最省事）
     - 返回 JSON：{"status": "success", "text": "识别结果"}
       （客户端取 result.text || result.status === 'success' && result.text，两个字段都给最稳）

  2) WS  ws://127.0.0.1:1000/v1/ws/vad
     - 客户端把麦克风的 Float32Array（每帧 512 个采样）以**二进制帧**直接 send 过来；
     - 服务端用 Silero VAD 判断，状态变化时回 JSON {"is_speech": true|false}；
       说话期间额外每 200ms 回 {"speech_activity": true} 心跳（供客户端刷新
       「最后一帧人声」，用于抢话判定）。
     - my-neuro 收到 true 开始录音、收到 false 起客户端静音计时（默认 150ms）后结束录音送 ASR。
     - PTT（按住 V 说话）模式下客户端不看 VAD，但仍会连上这个 WS。

模型（本机已有，不下载）：
  ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/{model.int8.onnx,tokens.txt}
  ~/.dsh/speech-to-text/sensevoice/models/silero/silero_vad.onnx

用法：
  py asr_server.py                       # 默认 127.0.0.1:1000
  py asr_server.py --port 1000 --threads 2
  py asr_server.py --itn                 # 打开标点/数字规整（默认关闭 = 纯文本）
  py asr_server.py --model-dir D:/models # 换模型目录

自测：py test_asr.py（见同目录）
"""
import argparse
import asyncio
import io
import json
import os
import socket
import sys
import time
import wave
from concurrent.futures import ThreadPoolExecutor

import numpy as np
# 麦克风这一路也用同一套声学字段（kind/mood/arousal），
# 这样上层处理「用户在说话」和「剧里在说话」时不用写两套分支。
import sys as _sys, os as _os
_sys.path.insert(0, _os.path.abspath(_os.path.join(_os.path.dirname(__file__), '..', 'audio_common')))
from acoustic import acoustic_profile, classify_sound  # noqa: E402
import ser as ser_mod  # noqa: E402  (SenseVoice 自带 SER/AED 解码)
from aiohttp import WSMsgType, web

HOME = os.path.expanduser("~")
DEFAULT_MODEL_DIR = os.path.join(HOME, ".dsh", "speech-to-text", "sensevoice", "models")
SAMPLE_RATE = 16000


# ────────────────────────────── 模型 ──────────────────────────────

class StartupError(RuntimeError):
    """启动期错误：模型缺失/加载失败/端口被占。要求打印清楚后退出，不能静默。"""


class AsrEngine:
    """SenseVoice 离线识别 + Silero VAD 配置。识别串行执行（sherpa 的 recognizer 不保证并发安全）。"""

    def __init__(self, model_dir, threads=2, use_itn=False):
        self.model_dir = model_dir
        self.model = os.path.join(model_dir, "sensevoice-onnx", "model.int8.onnx")
        self.tokens = os.path.join(model_dir, "sensevoice-onnx", "tokens.txt")
        self.vad_model = os.path.join(model_dir, "silero", "silero_vad.onnx")
        self.threads = threads
        self.use_itn = use_itn
        self.recognizer = None
        self.vad_config = None
        self.load_seconds = 0.0
        self.stats = {"requests": 0, "audio_seconds": 0.0, "last_rtf": 0.0, "max_rtf": 0.0}

    def load(self):
        missing = [p for p in (self.model, self.tokens, self.vad_model) if not os.path.exists(p)]
        if missing:
            raise StartupError("缺少模型文件（不会自动下载，请检查）:\n  " + "\n  ".join(missing))
        try:
            import sherpa_onnx
        except ImportError as exc:  # pragma: no cover - 环境问题
            raise StartupError("没有安装 sherpa_onnx：pip install sherpa-onnx（本机应已预装）: " + str(exc))

        began = time.time()
        try:
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=self.model,
                tokens=self.tokens,
                num_threads=max(1, int(self.threads)),
                use_itn=bool(self.use_itn),
                language="auto",     # 中文为主，英文也能识别（SenseVoice 自带语种判别）
                debug=False,
            )
        except Exception as exc:
            raise StartupError("加载 SenseVoice 失败：" + repr(exc))

        # Silero VAD：window_size 在 16k 下是 512（和 my-neuro 每帧发送的采样数一致）
        try:
            cfg = sherpa_onnx.VadModelConfig()
            cfg.silero_vad.model = self.vad_model
            cfg.silero_vad.threshold = 0.5
            cfg.silero_vad.min_silence_duration = 0.25   # 说完 250ms 才算结束
            cfg.silero_vad.min_speech_duration = 0.15    # 至少说 150ms 才算开始
            cfg.sample_rate = SAMPLE_RATE
            self.vad_config = cfg
        except Exception as exc:
            raise StartupError("配置 Silero VAD 失败：" + repr(exc))

        self.load_seconds = time.time() - began
        return self

    def new_vad(self):
        import sherpa_onnx
        if self.vad_config is None:
            raise StartupError("VAD 未加载")
        # 每条 WS 连接一个独立检测器；buffer 给 60s，够长且不至于吃内存
        return sherpa_onnx.VoiceActivityDetector(self.vad_config, buffer_size_in_seconds=60)

    def transcribe(self, audio: np.ndarray) -> dict:
        """audio: 16k 单声道 float32。返回 {text, lang, duration, elapsed, rtf}。"""
        audio = np.ascontiguousarray(audio, dtype=np.float32)
        duration = float(audio.size) / SAMPLE_RATE
        began = time.time()
        stream = self.recognizer.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        self.recognizer.decode_stream(stream)
        elapsed = time.time() - began
        result = stream.result
        text = (result.text or "").strip()
        rtf = elapsed / max(0.001, duration)
        # 语气特征：同一句「我没事」，大声喊和轻轻说完全不同。
        # 这里顺手算几个物理量，不跑情感模型 —— 音量/语速/断续度就够用了。
        tone = None
        try:
            if audio.size > SAMPLE_RATE * 0.2:
                rms = float(np.sqrt(np.mean(audio ** 2)))
                peak = float(np.max(np.abs(audio)))
                frame = max(16, int(SAMPLE_RATE * 0.05))
                frames = [audio[i:i+frame] for i in range(0, max(1, audio.size - frame), frame)]
                quiet = 0
                if frames:
                    quiet = sum(1 for f in frames if float(np.sqrt(np.mean(f ** 2))) < 0.0035) / len(frames)
                tone = {
                    "rms": round(rms, 4),
                    "peak": round(peak, 3),
                    "chars_per_sec": round(len(text) / max(0.001, duration), 2),
                    "quiet_ratio": round(quiet, 3),
                }
                # 统一字段：和回环那一路同一套（kind/mood/arousal/cues）
                try:
                    profile = acoustic_profile(audio, SAMPLE_RATE)
                    kinds = classify_sound(profile, bool(text), len(text))
                    tone.update({
                        "kind": kinds.get("kind"),
                        "mood": kinds.get("mood"),
                        "arousal": kinds.get("arousal"),
                        "cues": kinds.get("cues"),
                        "centroid": profile.get("centroid"),
                        "flatness": profile.get("flatness"),
                        "beat": profile.get("beat"),
                        "source": "mic",
                    })
                except Exception:
                    pass
                # 【关键】SenseVoice 自带 SER(情绪) + AED(音频事件)，比声学猜测准得多，直接覆盖。
                # 词表里本来就有：HAPPY/SAD/ANGRY/NEUTRAL/FEARFUL/DISGUSTED/SURPRISED、
                # Speech/BGM/Laughter/Applause/Cry/Cough...；sherpa 的 result 已经暴露了这三项。
                try:
                    ser_info = ser_mod.from_result(
                        getattr(result, "emotion", ""),
                        getattr(result, "event", ""),
                        getattr(result, "lang", ""),
                    )
                    if ser_info:
                        tone.update({
                            "kind": ser_info.get("kind") or tone.get("kind"),
                            "mood": ser_info.get("mood") or tone.get("mood"),
                            "arousal": ser_info.get("arousal") if ser_info.get("arousal") is not None else tone.get("arousal"),
                            "cues": ser_info.get("cues"),
                            "emotion_zh": ser_info.get("emotion_zh"),
                            "event_zh": ser_info.get("event_zh"),
                            "ser": True,
                        })
                except Exception:
                    pass
        except Exception:
            tone = None
        self.stats["requests"] += 1
        self.stats["audio_seconds"] += duration
        self.stats["last_rtf"] = rtf
        self.stats["max_rtf"] = max(self.stats["max_rtf"], rtf)
        return {
            "text": text,
            "lang": getattr(result, "lang", "") or "",
            "emotion": getattr(result, "emotion", "") or "",
            "event": getattr(result, "event", "") or "",
            "duration": round(duration, 3),
            "elapsed": round(elapsed, 3),
            "rtf": round(rtf, 3),
            "tone": tone,
        }


# ────────────────────────────── 音频解码 ──────────────────────────────

def _to_mono_16k(audio: np.ndarray, rate: int) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if rate != SAMPLE_RATE and audio.size:
        # 有 scipy 用多相重采样（音质好），没有就线性插值兜底
        try:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(int(rate), SAMPLE_RATE)
            audio = resample_poly(audio, SAMPLE_RATE // g, int(rate) // g).astype(np.float32)
        except Exception:
            n = int(round(audio.size * SAMPLE_RATE / rate))
            idx = np.linspace(0, audio.size - 1, n)
            audio = np.interp(idx, np.arange(audio.size), audio).astype(np.float32)
    return np.ascontiguousarray(np.clip(audio, -1.0, 1.0), dtype=np.float32)


def decode_wav(blob: bytes) -> np.ndarray:
    """WAV 字节 → 16k 单声道 float32。先试 soundfile（各种 PCM/浮点/多声道），再用标准库兜底。"""
    if not blob:
        raise ValueError("空音频")
    try:
        import soundfile as sf
        audio, rate = sf.read(io.BytesIO(blob), dtype="float32", always_2d=False)
        return _to_mono_16k(audio, int(rate))
    except Exception:
        pass
    try:
        with wave.open(io.BytesIO(blob), "rb") as wf:
            channels, width, rate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
            frames = wf.readframes(wf.getnframes())
    except Exception as exc:
        raise ValueError("不是可解析的 WAV：" + str(exc))
    if width == 2:
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    elif width == 1:
        audio = np.frombuffer(frames, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
    else:
        raise ValueError("不支持的采样位宽：" + str(width * 8) + "bit")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return _to_mono_16k(audio, int(rate))


# ────────────────────────────── HTTP / WS 处理 ──────────────────────────────

def require_engine(request) -> AsrEngine:
    engine = request.app.get("engine")
    if engine is None or engine.recognizer is None:
        raise web.HTTPServiceUnavailable(text=json.dumps({"status": "error", "error": "ASR 模型还没加载完"}))
    return engine


async def handle_health(request):
    engine = request.app.get("engine")
    loaded = bool(engine and engine.recognizer is not None)
    info = {
        "ok": loaded,
        "service": "asr",
        "engine": "sensevoice+silero",
        "loaded": loaded,
        "itn": bool(engine.use_itn) if engine else None,
        "threads": engine.threads if engine else None,
        "model": os.path.basename(engine.model) if engine else "",
        "uptime": round(time.time() - request.app.get("started_at", time.time()), 1),
        "stats": dict(engine.stats) if engine else {},
    }
    return web.json_response(info)


async def _read_uploaded_wav(request) -> bytes:
    ctype = (request.headers.get("Content-Type") or "").lower()
    if "multipart/form-data" in ctype:
        form = await request.post()
        field = form.get("file")
        if field is None:
            raise ValueError("缺少表单字段 file")
        # FileField 会落到临时文件；直接读出来
        if hasattr(field, "file"):
            return field.file.read()
        return bytes(field)
    # 兼容：直接把 wav 字节 POST 上来
    return await request.read()


async def handle_upload(request):
    began = time.time()
    try:
        blob = await _read_uploaded_wav(request)
    except ValueError as exc:
        return web.json_response({"status": "error", "text": "", "error": str(exc)}, status=400)

    try:
        audio = decode_wav(blob)
    except ValueError as exc:
        return web.json_response({"status": "error", "text": "", "error": str(exc)}, status=400)

    engine = require_engine(request)
    duration = audio.size / SAMPLE_RATE
    if audio.size < SAMPLE_RATE * 0.1:  # 不到 0.1 秒，当空音频
        print("[asr] 音频太短（%.2fs），返回空文本" % duration, flush=True)
        return web.json_response({"status": "success", "text": "", "duration": round(duration, 3)})

    # 识别放到线程池里跑，别堵住事件循环；用锁保证 recognizer 串行
    loop = asyncio.get_running_loop()
    try:
        async with request.app["decode_lock"]:
            result = await loop.run_in_executor(request.app["executor"], engine.transcribe, audio)
    except Exception as exc:  # 识别失败也要给出明确错误
        print("[asr] 识别失败：%r" % (exc,), flush=True)
        return web.json_response({"status": "error", "text": "", "error": "识别失败：" + str(exc)}, status=500)

    wall = time.time() - began
    rtf = result["rtf"]
    line = "[asr] %.2fs 音频 -> %.2fs (RTF %.3f) :: %s" % (result["duration"], wall, rtf, result["text"] or "(空)")
    if result.get("lang"):
        line += "  [%s]" % result["lang"]
    # 日志降噪（2026-11-08）：空识别/单字符（游戏声、环境声碎屑）每 1-2 秒一条，会淹掉整份日志。
    # 这类只在 PET_ASR_DEBUG=1 时打；有内容的识别照常打。
    import os as _os
    if len((result["text"] or "").strip()) > 1 or _os.environ.get("PET_ASR_DEBUG") == "1":
        print(line, flush=True)
    if rtf > 0.5:
        print("[asr] 警告：RTF %.2f 超过 0.5 目标（线程数 %d）" % (rtf, engine.threads), flush=True)

    payload = {"status": "success", "text": result["text"]}
    payload.update({"lang": result["lang"], "duration": result["duration"], "elapsed": result["elapsed"], "rtf": result["rtf"]})
    if result.get("tone"):
        payload["tone"] = result["tone"]
        # SenseVoice 的原始标记也透出来：回环那一路要靠它判断「这段是什么声音/什么情绪」
        payload["emotion"] = result.get("emotion", "")
        payload["event"] = result.get("event", "")
    return web.json_response(payload)


class VadSession:
    """一条 WS 连接的 VAD 状态机：收 float32 帧 → 512 采样窗口 → 状态变化时回 JSON。

    2026-11-20 全双工前置：is_speech:true 期间每 200ms 补发一次
    {type:'vad', is_speech:true, speech_activity:true} 心跳。客户端靠它刷新
    「最后一帧人声」；此前 lastSpeechTime 只在开口时更新，gap<200ms 的抢话判据
    恒不成立（服务端只发状态变化）。状态变化消息本身保持不变。
    """

    # 说话期间的心跳间隔
    HEARTBEAT_SECONDS = 0.2

    def __init__(self, engine: AsrEngine):
        self.vad = engine.new_vad()
        self.window = int(getattr(engine.vad_config.silero_vad, "window_size", 512) or 512)
        self.pending = np.zeros(0, dtype=np.float32)
        self.is_speech = False
        self.events = 0
        self.heartbeats = 0
        self.last_heartbeat = 0.0

    def feed(self, samples: np.ndarray):
        """喂一段 float32，返回 None 或新的 is_speech 状态（只在变化时返回）。"""
        if samples.size == 0:
            return None
        # 首尾是 16bit PCM 的客户端（有些版本会把 ArrayBuffer 直接发 int16）也能兜住
        self.pending = np.concatenate([self.pending, samples.astype(np.float32, copy=False)])
        changed = None
        while self.pending.size >= self.window:
            chunk, self.pending = self.pending[: self.window], self.pending[self.window:]
            self.vad.accept_waveform(np.ascontiguousarray(chunk, dtype=np.float32))
            state = bool(self.vad.is_speech_detected())
            if state != self.is_speech:
                self.is_speech = state
                changed = state
            # 及时清掉已完成的分段，避免缓冲越攒越大（我们只用状态，不用分段）
            while not self.vad.empty():
                self.vad.pop()
        return changed

    def reset(self):
        self.pending = np.zeros(0, dtype=np.float32)
        self.is_speech = False
        self.last_heartbeat = 0.0
        try:
            self.vad.reset()
        except Exception:
            pass


def _frame_to_float32(payload: bytes) -> np.ndarray:
    """客户端发的是 Float32Array（小端）；长度不整除 4 时截断。"""
    usable = len(payload) - (len(payload) % 4)
    if usable <= 0:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(payload[:usable], dtype="<f4").astype(np.float32, copy=True)


async def handle_vad_ws(request):
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    engine = require_engine(request)
    session = VadSession(engine)
    # 先告诉客户端「当前没人在说话」，不然后续第一次 true 之前它没法校准状态
    await ws.send_json({"type": "vad-ready", "is_speech": False, "sample_rate": SAMPLE_RATE, "window": session.window})
    print("[asr] VAD 通道已连接（window=%d）" % session.window, flush=True)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.BINARY:
                samples = _frame_to_float32(msg.data)
                changed = session.feed(samples)
                now = time.monotonic()
                if changed is not None:
                    await ws.send_json({"type": "vad", "is_speech": changed})
                    session.events += 1
                    # 状态切到「说话中」时重置心跳基准，避免同一次循环里再补一条
                    session.last_heartbeat = now if changed else 0.0
                elif session.is_speech and now - session.last_heartbeat >= session.HEARTBEAT_SECONDS:
                    # 说话期间心跳：客户端收到后刷新 lastSpeechTime（抢话 gap<200ms 的前提）
                    session.last_heartbeat = now
                    session.heartbeats += 1
                    await ws.send_json({"type": "vad", "is_speech": True, "speech_activity": True})
            elif msg.type == WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                except Exception:
                    continue
                if isinstance(payload, dict) and payload.get("type") == "reset":
                    session.reset()
                    await ws.send_json({"type": "vad", "is_speech": False})
                elif isinstance(payload, dict) and payload.get("type") == "ping":
                    await ws.send_json({"type": "pong", "is_speech": session.is_speech})
            elif msg.type == WSMsgType.ERROR:
                print("[asr] VAD 通道错误：%r" % (ws.exception(),), flush=True)
                break
    finally:
        try:
            session.vad.flush()
        except Exception:
            pass
        print("[asr] VAD 通道断开（事件 %d 次）" % session.events, flush=True)
    return ws


# ────────────────────────────── 启动 ──────────────────────────────

def ensure_port_free(host: str, port: int):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind((host, port))
    except OSError as exc:
        raise StartupError(
            "端口 %d 已被占用（%s）。可能上一个 asr_server 还在跑：\n"
            "  netstat -ano | findstr :%d      # 看 PID\n"
            "  taskkill /PID <pid> /F          # 确认是自己的再杀\n"
            "或者换端口：py asr_server.py --port 1001（同时改 my-neuro config.asr.*_url）" % (port, exc, port)
        )
    finally:
        probe.close()


def build_app(engine: AsrEngine) -> web.Application:
    app = web.Application(client_max_size=64 * 1024 * 1024)
    app["engine"] = engine
    app["started_at"] = time.time()
    app["decode_lock"] = asyncio.Lock()
    app["executor"] = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr-decode")
    app.router.add_get("/health", handle_health)
    app.router.add_post("/v1/upload_audio", handle_upload)
    app.router.add_post("/upload_audio", handle_upload)       # 兼容老路径
    app.router.add_get("/v1/ws/vad", handle_vad_ws)
    app.router.add_get("/ws/vad", handle_vad_ws)             # 兼容老路径

    async def _on_shutdown(app):
        try:
            app["executor"].shutdown(wait=False)
        except Exception:
            pass

    app.on_shutdown.append(_on_shutdown)
    return app


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="SenseVoice + Silero VAD 本地语音识别服务")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=1000)
    parser.add_argument("--threads", type=int, default=2, help="SenseVoice 推理线程数")
    parser.add_argument("--itn", action="store_true", help="打开标点/数字规整（默认关闭 = 纯文本）")
    parser.add_argument("--model-dir", default=os.environ.get("ASR_MODEL_DIR", DEFAULT_MODEL_DIR))
    args = parser.parse_args(argv)

    print("[asr] 模型目录：%s" % args.model_dir, flush=True)
    try:
        ensure_port_free(args.host, args.port)
        engine = AsrEngine(args.model_dir, threads=args.threads, use_itn=args.itn).load()
    except StartupError as exc:
        print("[asr][FATAL] " + str(exc), file=sys.stderr, flush=True)
        return 1

    print("[asr] SenseVoice 已加载（int8，%d 线程，itn=%s，用时 %.1fs）"
          % (args.threads, "开" if args.itn else "关", engine.load_seconds), flush=True)
    print("[asr] Silero VAD 已就绪（window=%d @ %dHz）"
          % (engine.vad_config.silero_vad.window_size, SAMPLE_RATE), flush=True)
    print("[asr] 监听 http://%s:%d  ·  POST /v1/upload_audio  ·  WS /v1/ws/vad  ·  GET /health"
          % (args.host, args.port), flush=True)

    app = build_app(engine)
    try:
        web.run_app(app, host=args.host, port=args.port, print=None, handle_signals=True)
    except OSError as exc:
        print("[asr][FATAL] 启动失败：" + repr(exc), file=sys.stderr, flush=True)
        return 1
    print("[asr] 已停止", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
