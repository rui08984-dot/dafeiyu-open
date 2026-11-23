#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地语音服务：把微软 Edge 的免费 TTS 接口包成一个本地 HTTP 端点，给桌宠用。

为什么要这一层：桌宠的语音接口约定是"POST /tts，返回音频流"，和 GPT-SoVITS 的 api_v2 一致；
这个脚本让它前面挂的是 Edge 的神经音色（中文自然度接近真人），本机不占显卡、几乎不占 CPU。

用法：
    python tts_server.py [--port 9883] [--voice zh-CN-XiaoyiNeural]

请求：POST /tts  {"text": "...", "voice": "zh-CN-XiaoyiNeural", "speed_factor": 1.0}
响应：audio/mpeg 流（边合成边发，首包约 1.2 秒）

不需要任何密钥：Edge 的 readaloud 接口是公开的，edge-tts 库负责握手。
"""
import argparse
import json
import os
import sys
import logging

from aiohttp import web
import edge_tts

DEFAULT_VOICE = "zh-CN-XiaoyiNeural"

# ── 情绪 → 韵律 ───────────────────────────────────────────────────────────
# edge-tts 本身只给「语速/音调/音量」三个旋钮，没有真情绪。
# 但把这三个按情绪调一下，"她"的语气就会明显不一样，而声线还是同一个她。
# 数值来自常识性映射，可以按听感再调。
# 数值是「听感」调出来的，不是越大越像。
# 第一版用了 +14Hz / -12Hz / ±12% 音量，机械感很重——超过 ±8Hz 就明显假，
# 音量超过 ±6% 会忽大忽小。现在都收在自然区间内，靠语速承担主要区分度。
PROSODY = {
    "neutral":   {"rate": 1.00, "pitch": 0, "volume": 0},
    "happy":     {"rate": 1.08, "pitch": 6, "volume": 3},
    "smug":      {"rate": 1.05, "pitch": 4, "volume": 2},
    "tease":     {"rate": 1.06, "pitch": 5, "volume": 2},
    "surprise":  {"rate": 1.10, "pitch": 8, "volume": 4},
    "shy":       {"rate": 0.94, "pitch": 7, "volume": -3},
    "bored":     {"rate": 0.92, "pitch": -4, "volume": -3},
    "sleepy":    {"rate": 0.85, "pitch": -7, "volume": -6},
    "sad":       {"rate": 0.88, "pitch": -7, "volume": -5},
    "aggrieved": {"rate": 0.91, "pitch": -5, "volume": -4},
    "angry":     {"rate": 1.12, "pitch": -5, "volume": 5},
    "guilty":    {"rate": 0.95, "pitch": -3, "volume": -4},
}
CURRENT = {"emotion": "neutral", "strength": 1.0}


def prosody_for(emotion: str, strength: float):
    """按情绪+强度算三个旋钮；强度 0 就是中性（不加工）。"""
    base = PROSODY.get(str(emotion or "neutral"), PROSODY["neutral"])
    k = max(0.0, min(1.5, float(strength if strength is not None else 1.0)))
    rate = 1.0 + (base["rate"] - 1.0) * k
    pitch = base["pitch"] * k
    volume = base["volume"] * k
    return rate, pitch, volume


def rate_of(speed) -> str:
    """把 1.0 = 原速 换算成 Edge 的 +0% / -20% 写法。"""
    try:
        pct = round((float(speed) - 1.0) * 100)
    except (TypeError, ValueError):
        pct = 0
    pct = max(-50, min(100, pct))
    return f"{pct:+d}%"


# ── 分句韵律（论文依据：2508.17494 SSML 分句标注 MOS 3.20→3.87；Edge 免费端点不收
# 自定义 SSML，所以做「分句 + 每句微韵律 + 顺序流式」的等价实现：
# 每个分句独立调一次 Communicate 顺序写出，首包仍=第一分句（不增加感知延迟），
# 句间停顿由 Edge 对标点的天然处理承担，我们只调「每句的旋钮」。
# 单句/短文本走原路径，行为零变化。）
import re as _re
_CLAUSE_SPLIT = _re.compile(r"(?<=[。！？；…\n])")
_TRAIL_ONLY = _re.compile(r"^[嗯啊哦呃唉嘛呢吧咯噢喔哎哟哈欸嘿～—、，。\s]{1,6}$")


def clause_split(text: str, max_len: int = 34):
    """把一段话切成韵律分句：句末标点必切；长分句再按逗号切；语气词碎片并入前句。"""
    parts = [p for p in (s.strip() for s in _CLAUSE_SPLIT.split(text)) if p]
    if len(parts) <= 1:
        return [text.strip()] if text.strip() else []
    merged = []
    for p in parts:
        # 语气词碎片（嗯——/啊？）独立成句会很怪，并进上一句
        if merged and (_TRAIL_ONLY.match(p) or len(merged[-1]) + len(p) <= 6):
            merged[-1] += p
        elif len(p) > max_len and ("，" in p or "、" in p):
            subs = _re.sub(r"([，、])", r"\1\u0001", p).split("\u0001")
            buf = ""
            for s in subs:
                if buf and len(buf) + len(s) > max_len:
                    merged.append(buf)
                    buf = s
                else:
                    buf += s
            if buf:
                merged.append(buf)
        else:
            merged.append(p)
    return [m for m in (s.strip() for s in merged) if m]


def clause_modulation(clause: str, is_last: bool, rnd) -> dict:
    """单分句的旋钮微调：问句上扬、感叹加重、尾句收势、语气词放软、其余随机微漂移。"""
    mod = {"rate": 1.0, "pitch": 0.0, "volume": 0.0}
    c = clause.strip()
    if _TRAIL_ONLY.match(c):
        mod["rate"] -= 0.08
        mod["volume"] -= 2.0
    if c.endswith(("？", "?")):
        mod["pitch"] += 2.0
    elif c.endswith(("！", "!")):
        mod["volume"] += 4.0
        mod["rate"] += 0.03
    if c.endswith(("……", "…", "—")):
        mod["rate"] -= 0.05
    if is_last:
        mod["rate"] -= 0.03
        mod["volume"] -= 2.0
    # 分句间随机微漂移（±2.5% / ±1.5Hz）：连着几句同调像播报，漂移像人
    mod["rate"] += rnd.uniform(-0.025, 0.025)
    mod["pitch"] += rnd.uniform(-1.5, 1.5)
    return mod


async def set_prosody(request: web.Request) -> web.Response:
    """驱动层把「她现在的情绪」推过来，下一句话就按这个语气说。"""
    try:
        body = await request.json()
    except Exception:
        body = {}
    emo = str(body.get("emotion") or "neutral")
    try:
        strength = float(body.get("strength", 1.0))
    except (TypeError, ValueError):
        strength = 1.0

    # ── 统一情绪总线：emotions 数组 + 心气 → pet-core PAD 混合韵律（论文 Top5 之首）──
    # 总线失败/内核缺失时回落离散表（留 warning 不静默）
    emo_list = body.get("emotions")
    if isinstance(emo_list, list) and emo_list:
        import subprocess
        core = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "pet-core", "target", "debug", "pet-core.exe"))
        if os.path.exists(core):
            try:
                payload = json.dumps({"cmd": "prosody", "emotions": emo_list, "mood": float(body.get("mood") or 0.0)})
                out = subprocess.run([core], input=payload, capture_output=True, text=True, timeout=5, encoding="utf-8")
                j = json.loads(out.stdout)
                if j.get("ok"):
                    bus_id = "+".join(str(e.get("id") or "?") for e in emo_list)
                    CURRENT["emotion"] = bus_id
                    CURRENT["strength"] = 1.0
                    return web.json_response({"ok": True, "emotion": bus_id, "rate": round(j["rate"], 3), "pitch": round(j["pitch"], 1), "volume": round(j["volume"], 1), "bus": "pad"})
            except Exception as e:
                logging.warning("prosody bus failed（回落离散表）: %s", e)
        else:
            logging.warning("prosody bus: pet-core.exe 缺失（%s），回落离散表", core)

    CURRENT["emotion"] = emo
    CURRENT["strength"] = strength
    rate, pitch, volume = prosody_for(emo, strength)
    return web.json_response({"ok": True, "emotion": emo, "rate": round(rate, 3), "pitch": round(pitch, 1), "volume": round(volume, 1)})


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "voice": request.app["voice"]})


def prosody_gain_of(body):
    """语义语气增益（2026-11-17，宿主默认**不发**这个字段 → 三个值都是 1，行为零变化）。

    宿主 js/core/voice-style.js 负责「哪一句、要不要用、置信度够不够」，
    这里只做一件事：把它给的乘数**再夹一次** [0.9, 1.1] 再乘上去。
    为什么服务端还要夹：旧客户端/手工请求/以后别的调用方都可能直接发字段，
    服务端的边界不能依赖调用方的自觉；而且这一层是唯一真正碰到
    p_rate/p_pitch/p_vol（情绪算出来的基准韵律）的地方，夹在这里才叫「总增益有上限」。
    pitch/volume 是**偏移量**（Hz / %），乘的是偏移本身：中立情绪偏移为 0 时
    音调增益自然不起作用——这正是我们要的「不给她无中生有的起伏」。
    """
    raw = body.get("prosody_gain")
    if not isinstance(raw, dict) or not raw:
        return 1.0, 1.0, 1.0
    out = []
    for key in ("rate", "pitch", "energy"):
        try:
            v = float(raw.get(key, 1.0))
        except (TypeError, ValueError):
            v = 1.0
        out.append(max(0.9, min(1.1, v)) if v > 0 else 1.0)
    return out[0], out[1], out[2]


async def tts(request: web.Request) -> web.StreamResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    text = (body.get("text") or "").strip()
    if not text:
        return web.json_response({"error": "no text"}, status=400)
    voice = body.get("voice") or request.app["voice"] or DEFAULT_VOICE
    # 语气：请求里可以指定 emotion/strength，否则用驱动推过来的"当前情绪"
    emo = body.get("emotion") or CURRENT["emotion"]
    try:
        strength = float(body.get("strength", CURRENT["strength"]))
    except (TypeError, ValueError):
        strength = CURRENT["strength"]
    p_rate, p_pitch, p_vol = prosody_for(emo, strength)
    # 语义语气：在**情绪算出的基准韵律之上**乘 ≤±10%，不改情绪链路本身。
    g_rate, g_pitch, g_energy = prosody_gain_of(body)
    p_rate *= g_rate
    p_pitch *= g_pitch
    p_vol *= g_energy
    print(f"[tts] request len={len(text)} voice={voice}", file=sys.stderr, flush=True)
    # 语速 = 基础速度 × 情绪系数
    base_speed = float(body.get("speed_factor", 1.0) or 1.0)

    # 分句韵律：多句才启用；每句 = 情绪基韵律 × 分句调制。单句=原路径零变化。
    clauses = clause_split(text)
    use_clauses = len(clauses) > 1
    if not use_clauses:
        clauses = [text]

    # 2026-11-21 根因修复：响应在「确认至少有一个音频块」之前不能 prepare。
    # StreamResponse 一旦 prepare，状态码/响应头就发出去了；原实现先 200 再合成，
    # 全分句失败时就是「200 + 0 字节」—— 客户端按成功处理却拿不到声音，问题被伪装掉。
    # 现在：首个音频块到达才 prepare(200)；一个块都没有 → 502 + X-Tts-Failed: all。
    resp = None
    headers = {"Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Voice": voice,
               "X-Emotion": emo, "X-Clauses": str(len(clauses))}
    import random
    import edge_tts as _et
    rnd = random.Random(hash(text) & 0xFFFF)  # 同文本同漂移（重播一致），不同文本不同
    n_ok = 0
    n_fail = 0
    first_error = None
    for i, clause in enumerate(clauses):
        if use_clauses:
            mod = clause_modulation(clause, i == len(clauses) - 1, rnd)
            c_rate = p_rate * mod["rate"]
            c_pitch = p_pitch + mod["pitch"]
            c_vol = p_vol + mod["volume"]
        else:
            # 原路径：整句基韵律 + 原有的微抖动
            c_rate = p_rate * (1.0 + rnd.uniform(-0.015, 0.015))
            c_pitch = p_pitch + rnd.uniform(-1.0, 1.0)
            c_vol = p_vol
        jitter_rate = 1.0 + rnd.uniform(-0.008, 0.008)
        rate = rate_of(base_speed * c_rate * jitter_rate)
        pitch_v = c_pitch
        pitch = ("%+dHz" % int(round(pitch_v))) if abs(pitch_v) >= 0.5 else "+0Hz"
        volume = ("%+d%%" % int(round(c_vol))) if abs(c_vol) >= 0.5 else "+0%"
        try:
            communicate = _et.Communicate(clause, voice, rate=rate, pitch=pitch, volume=volume)
            got_audio = False
            async for chunk in communicate.stream():
                if chunk.get("type") == "audio" and chunk.get("data"):
                    if resp is None:
                        # 首块到手才提交 200：之前任何失败都还能返回 502
                        resp = web.StreamResponse(status=200, headers=headers)
                        await resp.prepare(request)
                    got_audio = True
                    await resp.write(chunk["data"])
            if got_audio:
                n_ok += 1
            else:
                # 没抛异常但也没吐音频（edge 偶尔返回空流）——同样算失败，不能当成功
                n_fail += 1
                if first_error is None:
                    first_error = "empty audio stream"
                print(f"[tts] clause {i + 1}/{len(clauses)} produced no audio", file=sys.stderr, flush=True)
        except Exception as exc:
            # 单句失败不炸整段（网络抖动只丢一句）；全失败时下面明确返回 502
            n_fail += 1
            if first_error is None:
                first_error = str(exc)
            print(f"[tts] clause {i + 1}/{len(clauses)} failed: {exc}", file=sys.stderr, flush=True)

    if resp is None:
        # 一个音频块都没发出去：绝不能 200 + 0 字节（客户端会误判成功）
        print(f"[tts] all clauses failed ({n_fail}/{len(clauses)}): {first_error}", file=sys.stderr, flush=True)
        return web.json_response(
            {"ok": False, "error": "tts_all_clauses_failed", "failed": n_fail,
             "clauses": len(clauses), "detail": (first_error or "")[:200]},
            status=502, headers={"X-Tts-Failed": "all"})

    if use_clauses:
        print(f"[tts] clause-stream ok={n_ok}/{len(clauses)}", file=sys.stderr, flush=True)
    await resp.write_eof()
    return resp


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=9883)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    args = parser.parse_args()

    app = web.Application()
    app["voice"] = args.voice
    app.router.add_get("/health", health)
    app.router.add_post("/tts", tts)
    app.router.add_post("/prosody", set_prosody)
    print(f"edge-tts service on http://127.0.0.1:{args.port} voice={args.voice}", flush=True)
    web.run_app(app, host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()
