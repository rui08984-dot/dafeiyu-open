#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""asr_server.py 的自测脚本：造一段中文 → 走上传接口 → 打印识别结果；再走一遍 VAD WebSocket。

用法（服务先起来）：
  py asr/asr_server.py                    # 另开一个终端，或由 launch-my-neuro.mjs 拉起
  py asr/test_asr.py                      # 默认：edge-tts 造音频 → POST /v1/upload_audio → 打印文本 → 校验 VAD
  py asr/test_asr.py --audio some.wav     # 用现成音频，不联网合成
  py asr/test_asr.py --skip-ws            # 只测上传
  py asr/test_asr.py --fast               # VAD 阶段不按实时速度推帧

退出码：0 = 全部通过；1 = 识别/校验失败；2 = 环境缺东西（edge-tts/ffmpeg/requests）。
"""
import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import wave

import numpy as np

DEFAULT_CN = "你好，我是大肥鱼，现在在测试本地语音识别，听得清楚吗？"
DEFAULT_EN = "Hello, this is a local speech recognition test."
HOME = os.path.expanduser("~")
FALLBACK_AUDIO = os.path.join(
    HOME, "ai人格软件", "_incoming", "my-neuro", "live-2d", "fake_neuro_audio", "Reference_audio", "大肥鱼.wav"
)


# ────────────────────────────── 造测试音频 ──────────────────────────────

def ffmpeg_convert(src: str, dst: str) -> bool:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    try:
        subprocess.run(
            [ffmpeg, "-y", "-loglevel", "error", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst],
            check=True,
        )
        return os.path.exists(dst) and os.path.getsize(dst) > 1000
    except Exception as exc:
        print("  [warn] ffmpeg 转码失败：%s" % exc)
        return False


def synth_with_edge_tts(text: str, voice: str, out_wav: str) -> bool:
    try:
        import edge_tts
    except ImportError:
        return False
    mp3 = out_wav + ".mp3"
    async def _run():
        await edge_tts.Communicate(text, voice).save(mp3)
    try:
        asyncio.run(asyncio.wait_for(_run(), timeout=60))
    except Exception as exc:
        print("  [warn] edge-tts 合成失败（可能没网）：%s" % exc)
        return False
    ok = ffmpeg_convert(mp3, out_wav)
    try:
        os.remove(mp3)
    except OSError:
        pass
    return ok


def synth_with_pyttsx3(text: str, out_wav: str) -> bool:
    try:
        import pyttsx3
    except ImportError:
        return False
    try:
        engine = pyttsx3.init()
        engine.save_to_file(text, out_wav)
        engine.runAndWait()
        return os.path.exists(out_wav) and os.path.getsize(out_wav) > 1000
    except Exception as exc:
        print("  [warn] pyttsx3 合成失败：%s" % exc)
        return False


def make_test_wav(text: str, voice: str, out_wav: str, audio_path: str = "") -> str:
    """返回可用的 16k 单声道 wav 路径；失败返回空串。"""
    if audio_path:
        if ffmpeg_convert(audio_path, out_wav):
            return out_wav
        if audio_path.lower().endswith(".wav"):
            shutil.copyfile(audio_path, out_wav)
            return out_wav
        return ""
    if synth_with_edge_tts(text, voice, out_wav):
        print("  [ok] edge-tts 已生成：%s" % out_wav)
        return out_wav
    if synth_with_pyttsx3(text, out_wav):
        print("  [ok] pyttsx3 已生成：%s" % out_wav)
        return out_wav
    if os.path.exists(FALLBACK_AUDIO) and ffmpeg_convert(FALLBACK_AUDIO, out_wav):
        print("  [warn] 在线合成不可用，退回本机参考音频：%s" % FALLBACK_AUDIO)
        return out_wav
    return ""


# ────────────────────────────── 读音频 ──────────────────────────────

def read_wav(path: str):
    with wave.open(path, "rb") as wf:
        channels, width, rate, frames = wf.getnchannels(), wf.getsampwidth(), wf.getframerate(), wf.getnframes()
        raw = wf.readframes(frames)
    if width != 2:
        raise ValueError("测试音频不是 16bit PCM：%s" % path)
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        n = int(round(audio.size * 16000 / rate))
        idx = np.linspace(0, audio.size - 1, n)
        audio = np.interp(idx, np.arange(audio.size), audio).astype(np.float32)
    return np.ascontiguousarray(audio, dtype=np.float32)


# ────────────────────────────── 上传接口 ──────────────────────────────

def post_upload(url: str, wav_path: str, timeout: float = 30.0):
    try:
        import requests
    except ImportError:
        print("[fail] 需要 requests：pip install requests")
        return None, None, 0.0
    began = time.time()
    try:
        with open(wav_path, "rb") as fh:
            response = requests.post(url, files={"file": ("recording.wav", fh, "audio/wav")}, timeout=timeout)
    except Exception as exc:
        print("[fail] 上传失败：%s" % exc)
        return None, None, time.time() - began
    wall = time.time() - began
    try:
        payload = response.json()
    except Exception:
        payload = {"status": "error", "text": "", "error": response.text[:200]}
    return response.status_code, payload, wall


def parse_recognized(payload):
    """和 asr-processor.js 一样兼容两种返回：{text} 或 {status:'success', text}。"""
    if not isinstance(payload, dict):
        return ""
    text = payload.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    if payload.get("status") == "success" and isinstance(text, str):
        return text.strip()
    return ""


# ────────────────────────────── VAD WebSocket ──────────────────────────────

async def ws_vad_run(ws_url: str, audio: np.ndarray, chunk: int = 512, realtime: bool = True, timeout: float = 30.0):
    """像 my-neuro 一样：把 Float32Array 按 512 采样/帧推给 WS，收集 is_speech 事件。"""
    try:
        from aiohttp import ClientSession
    except ImportError:
        print("[warn] 没有 aiohttp，跳过 WS 测试")
        return []
    events = []
    began = time.time()
    async with ClientSession() as session:
        async with session.ws_connect(ws_url, timeout=timeout) as ws:
            async def reader():
                async for msg in ws:
                    if msg.type != 1:  # TEXT
                        continue
                    try:
                        data = json.loads(msg.data)
                    except Exception:
                        continue
                    if "is_speech" in data:
                        events.append((round(time.time() - began, 2), bool(data["is_speech"])))
                    elif data.get("type") == "vad-ready":
                        events.append((0.0, bool(data.get("is_speech", False))))
            task = asyncio.ensure_future(reader())
            for i in range(0, audio.size, chunk):
                await ws.send_bytes(audio[i:i + chunk].astype("<f4").tobytes())
                if realtime:
                    await asyncio.sleep(chunk / 16000.0)
            await asyncio.sleep(0.6)  # 等最后一段判定（min_silence 250ms + 余量）
            await ws.close()
            try:
                await asyncio.wait_for(task, timeout=3)
            except Exception:
                task.cancel()
    return events


# ────────────────────────────── 主流程 ──────────────────────────────

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="asr_server.py 自测")
    parser.add_argument("--url", default="http://127.0.0.1:1000/v1/upload_audio")
    parser.add_argument("--ws-url", default="ws://127.0.0.1:1000/v1/ws/vad")
    parser.add_argument("--audio", default="", help="用现成音频，不做 TTS 合成")
    parser.add_argument("--cn-text", default=DEFAULT_CN)
    parser.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    parser.add_argument("--skip-ws", action="store_true", help="只测上传接口")
    parser.add_argument("--skip-en", action="store_true", help="不测英文")
    parser.add_argument("--fast", action="store_true", help="VAD 阶段按最快速度推帧")
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args(argv)

    failures = []
    tmpdir = tempfile.mkdtemp(prefix="asr-test-")
    cn_wav = os.path.join(tmpdir, "cn.wav")
    en_wav = os.path.join(tmpdir, "en.wav")

    print("== 1/4 造测试音频 ==")
    cn_path = make_test_wav(args.cn_text, args.voice, cn_wav, args.audio)
    if not cn_path:
        print("[fail] 造不出测试音频：没有 edge-tts 网络、没有 pyttsx3、也没有可用的 --audio")
        return 2
    cn_audio = read_wav(cn_path)
    print("  中文测试音频：%.2fs @16k" % (cn_audio.size / 16000.0))

    print("== 2/4 POST %s ==" % args.url)
    status, payload, wall = post_upload(args.url, cn_path, timeout=args.timeout)
    if status is None:
        failures.append("上传接口不可达（服务没起？）")
    else:
        text = parse_recognized(payload)
        rtf = None
        if isinstance(payload, dict):
            rtf = payload.get("rtf")
        print("  HTTP %s  耗时 %.2fs  RTF=%s" % (status, wall, rtf if rtf is not None else "n/a"))
        print("  识别文本：%r" % text)
        if status != 200:
            failures.append("HTTP %s：%s" % (status, str(payload)[:200]))
        elif not text:
            failures.append("识别结果为空")
        if rtf is not None and rtf > 0.5:
            failures.append("RTF %.2f 超过 0.5" % rtf)

    if not args.skip_en:
        print("== 3/4 英文 ==")
        en_path = make_test_wav(DEFAULT_EN, "en-US-AriaNeural", en_wav, "")
        if en_path:
            status, payload, wall = post_upload(args.url, en_path, timeout=args.timeout)
            text = parse_recognized(payload)
            print("  HTTP %s  识别文本：%r" % (status, text))
            if not text:
                failures.append("英文识别为空")
        else:
            print("  [warn] 英文音频造不出来（没网），跳过")

    if not args.skip_ws:
        print("== 4/4 VAD WebSocket ==")
        events = asyncio.run(ws_vad_run(args.ws_url, cn_audio, realtime=not args.fast, timeout=args.timeout))
        print("  事件：%s" % (events,))
        if not events:
            failures.append("VAD 没有回任何事件")
        else:
            if not any(flag for _, flag in events):
                failures.append("VAD 没有检测到「开始说话」")
            if not any(not flag for _, flag in events):
                failures.append("VAD 没有检测到「说完了」")

    print("")
    if failures:
        for item in failures:
            print("[fail] " + item)
        print("✗ 自测未通过")
        return 1
    print("✓ 自测通过：上传识别 + VAD 事件都正常")
    return 0


if __name__ == "__main__":
    sys.exit(main())
