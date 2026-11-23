"""emotion_arc.py —— 情绪弧线：把耳朵的逐句 tone 数据聚合成「弧线时间轴」。

为什么存在：watch-screen 的截图表说不出「剧情正从压抑转向爆发」——弧线可以。
数据全部来自 audio_loop 已有的逐句 tone（mood/arousal/kind/beat…），纯本地聚合，零 API。

两层输出：
  build_arc(items, window_s=30)  → 每个时间窗的情绪分布/强度/音乐占比（数值层）
  summarize_arc(arc)             → 中文摘要 + 转折点 + 当前状态（注入她上下文的形态）

设计纪律：
  - 纯函数、无 IO、无模型依赖 —— 可单测、可被任何调用方复用
  - 转折点 = 主导情绪切换 或 强度陡变（|Δ|>0.35），这就是她聊剧的抓手
  - 摘要必须是人话，直接可塞上下文（cowatch 工具改造时从这里取）
"""

from __future__ import annotations

import math

# 强度陡变的阈值：窗口平均 arousal 的差超过它才算「转折」。
# 拍板依据：arousal 本身 0~1，正常剧集起伏在 ±0.2 内，超过 0.35 是真转折。
INTENSITY_TURN_DELTA = 0.35
# 一个窗口里至少要有这么多语音占比才参与情绪统计（纯音乐窗不硬评情绪）
MIN_SPEECH_RATIO_FOR_MOOD = 0.08
# 摘要里单窗台词最多引用多少字
QUOTE_MAX = 24


def _ms(v, default=0):
    try:
        x = float(v)
        return x if math.isfinite(x) else default
    except (TypeError, ValueError):
        return default


def mmss(ms: float) -> str:
    s = int(ms // 1000)
    return f"{s // 60:02d}:{s % 60:02d}"


# SenseVoice 的情绪标签有时是英文（happy/calm/excited…），摘要里统一成中文
_EN_MOOD = {
    "happy": "开心", "sad": "伤心", "angry": "生气", "neutral": "平静",
    "calm": "平静", "surprised": "惊讶", "excited": "兴奋", "relaxed": "放松",
    "fearful": "害怕", "fear": "害怕", "disappointed": "失望", "sleepy": "困",
    "bored": "无聊", "worried": "担忧", "moved": "感动", "tense": "紧张",
}


def _zh_mood(mood: str) -> str:
    m = str(mood or "").strip()
    return _EN_MOOD.get(m.lower(), m) if m else m


def build_arc(items: list[dict], window_s: float = 30.0) -> list[dict]:
    """把逐句 items 切成时间窗并聚合。items: [{start,end,text,tone}, ...]（毫秒 epoch）。"""
    if not items:
        return []
    starts = [_ms(x.get("end")) for x in items]
    t0 = min(_ms(x.get("start")) for x in items)
    t1 = max(starts)
    if t1 <= t0:
        return []
    win_ms = max(5.0, float(window_s)) * 1000.0
    n = int((t1 - t0) // win_ms) + 1
    buckets: list[list[dict]] = [[] for _ in range(n)]
    for x in items:
        idx = int((_ms(x.get("start")) - t0) // win_ms)
        idx = max(0, min(n - 1, idx))
        buckets[idx].append(x)

    arc = []
    for i, bucket in enumerate(buckets):
        if not bucket:
            arc.append({"i": i, "t0": t0 + i * win_ms, "t1": t0 + (i + 1) * win_ms, "empty": True})
            continue
        w0, w1 = t0 + i * win_ms, t0 + (i + 1) * win_ms
        speech, music, other = [], [], []
        for x in bucket:
            tone = x.get("tone") or {}
            kind = str(tone.get("kind") or "")
            if kind in ("music", "song") or tone.get("event_zh") == "音乐":
                music.append(x)
            elif kind == "speech" or tone.get("ser") or x.get("text"):
                speech.append(x)
            else:
                other.append(x)

        span = max(1.0, w1 - w0)
        music_ratio = sum(_ms(x.get("end"), 0) - _ms(x.get("start"), 0) for x in music) / span
        speech_ratio = sum(_ms(x.get("end"), 0) - _ms(x.get("start"), 0) for x in speech) / span

        # 情绪分布：优先 SER 的中文情绪，退回声学 mood
        mood_count: dict[str, int] = {}
        arousals = []
        for x in speech:
            tone = x.get("tone") or {}
            mood = str(tone.get("emotion_zh") or _zh_mood(tone.get("mood")) or "").strip()
            if mood:
                mood_count[mood] = mood_count.get(mood, 0) + 1
            a = tone.get("arousal")
            if a is not None:
                a = _ms(a)
                if 0 <= a <= 1:
                    arousals.append(a)
        n_mood = sum(mood_count.values())
        dominant, share = None, 0.0
        if mood_count and speech_ratio >= MIN_SPEECH_RATIO_FOR_MOOD:
            dominant = max(mood_count, key=mood_count.get)
            share = mood_count[dominant] / n_mood
        intensity = sum(arousals) / len(arousals) if arousals else None

        # 音乐能量：beat（节奏感）与 flux（变化率）的均值，粗判「激烈/舒缓」
        music_energy = None
        if music:
            vals = [(_ms((x.get("tone") or {}).get("beat")), _ms((x.get("tone") or {}).get("flux"))) for x in music]
            vals = [(b, f) for b, f in vals if b > 0 or f > 0]
            if vals:
                music_energy = sum(max(b, f * 2.0) for b, f in vals) / len(vals)

        quote = max((x.get("text") or "" for x in speech), key=len) if speech else ""
        arc.append({
            "i": i, "t0": w0, "t1": w1, "empty": False,
            "dominant": dominant, "share": round(share, 2),
            "moods": mood_count,
            "intensity": None if intensity is None else round(intensity, 2),
            "music_ratio": round(music_ratio, 2),
            "speech_ratio": round(speech_ratio, 2),
            "music_energy": None if music_energy is None else round(music_energy, 3),
            "n": len(bucket),
            "quote": quote[:QUOTE_MAX],
        })
    return arc


def _turns(arc: list[dict]) -> list[dict]:
    """转折点：主导情绪切换，或强度陡变。"""
    turns = []
    prev = None
    for w in arc:
        if w.get("empty"):
            continue
        if prev is not None:
            if w.get("dominant") and prev.get("dominant") and w["dominant"] != prev["dominant"]:
                turns.append({"t": w["t0"], "type": "mood", "from": prev["dominant"], "to": w["dominant"]})
            ia, ib = prev.get("intensity"), w.get("intensity")
            if ia is not None and ib is not None and abs(ib - ia) > INTENSITY_TURN_DELTA:
                turns.append({"t": w["t0"], "type": "intensity",
                              "dir": "升" if ib > ia else "降",
                              "from": round(ia, 2), "to": round(ib, 2)})
        prev = w
    # 相邻同型转折合并窗口（1 窗内的抖动不算两次）
    merged = []
    for t in turns:
        if merged and t["type"] == merged[-1]["type"] and t["t"] - merged[-1]["t"] <= 30000:
            merged[-1] = t
        else:
            merged.append(t)
    return merged


def summarize_arc(arc: list[dict]) -> dict:
    """弧线 → 人话摘要。digest 直接可注入她的上下文。"""
    filled = [w for w in arc if not w.get("empty")]
    if not filled:
        return {"digest": "最近没有可说的声音。", "turns": [], "state": None, "windows": 0}

    turns = _turns(arc)
    cur = filled[-1]
    base = filled[0]["t0"]   # 摘要里的时间一律相对素材起点（片头），不是纪元时间
    cur_mood = cur.get("dominant")
    parts = []
    # 转折叙事（最多 3 个， older→newer）
    for t in turns[-3:]:
        tt = mmss(t["t"] - base)
        if t["type"] == "mood":
            parts.append(f"{tt} 情绪由「{t['from']}」转「{t['to']}」")
        else:
            parts.append(f"{tt} 强度陡{t['dir']}（{t['from']}→{t['to']}）")
    # 当前状态
    state_bits = []
    if cur_mood:
        state_bits.append(f"当前情绪偏「{cur_mood}」")
    elif cur.get("music_ratio", 0) > 0.5:
        state_bits.append("当前以音乐为主")
    else:
        state_bits.append("当前声音稀疏")
    if cur.get("quote"):
        state_bits.append(f"刚提到「{cur['quote']}」")
    state = "，".join(state_bits)
    parts.append(state)

    minutes = (filled[-1]["t1"] - filled[0]["t0"]) / 60000.0
    digest = f"近 {minutes:.0f} 分钟：" + "；".join(parts) + "。"
    return {
        "digest": digest,
        "turns": [{"t": mmss(t["t"] - base), **{k: v for k, v in t.items() if k != "t"}} for t in turns],
        "state": state,
        "windows": len(filled),
    }
