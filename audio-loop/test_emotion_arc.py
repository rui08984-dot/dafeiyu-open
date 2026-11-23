"""test_emotion_arc.py —— 情绪弧线聚合器的最小验证（纯本地，不碰在跑的服务）。"""
import sys
sys.path.insert(0, "..")

from audio_common.emotion_arc import build_arc, summarize_arc, mmss

T0 = 1_800_000_000_000  # 任意「现在」


def seg(dt_s, dur_s, text, mood=None, arousal=None, kind="speech", emotion_zh=None):
    tone = {"kind": kind, "mood": mood, "arousal": arousal, "ser": kind == "speech"}
    if emotion_zh:
        tone["emotion_zh"] = emotion_zh
    if kind == "music":
        tone["beat"] = 0.6
        tone["event_zh"] = "音乐"
    return {"text": text, "start": T0 + int(dt_s * 1000), "end": T0 + int((dt_s + dur_s) * 1000), "tone": tone}


def test_calm_to_angry_to_calm():
    items = []
    # 0~90s：平静对白
    for i in range(9):
        items.append(seg(i * 10, 4, f"日常对白{i}", mood="neutral", arousal=0.2, emotion_zh="平静"))
    # 90~120s：爆发（愤怒，强度陡升）
    for i in range(6):
        items.append(seg(90 + i * 5, 4, f"你怎么敢{i}", mood="angry", arousal=0.9, emotion_zh="愤怒"))
    # 120~150s：缓和
    for i in range(6):
        items.append(seg(120 + i * 5, 4, f"算了{i}", mood="sad", arousal=0.25, emotion_zh="伤心"))

    arc = build_arc(items, window_s=30)
    filled = [w for w in arc if not w.get("empty")]
    assert len(filled) >= 4, f"窗口数异常: {len(filled)}"
    doms = [w["dominant"] for w in filled]
    assert doms[0] == "平静" and "愤怒" in doms, f"主导情绪序列异常: {doms}"

    s = summarize_arc(arc)
    assert "愤怒" in s["digest"], f"摘要缺愤怒转折: {s['digest']}"
    types = [t["type"] for t in s["turns"]]
    assert "mood" in types, f"未检出情绪转折: {s['turns']}"
    assert any(t.get("dir") == "升" for t in s["turns"] if t["type"] == "intensity"), f"未检出强度陡升: {s['turns']}"
    print("PASS 平静→愤怒→伤心：转折与强度陡变都被捕获")
    print("  digest =", s["digest"])


def test_music_window_not_force_mood():
    items = [seg(0, 28, "", kind="music"), seg(30, 28, "", kind="music")]
    arc = build_arc(items, window_s=30)
    s = summarize_arc(arc)
    filled = [w for w in arc if not w.get("empty")]
    assert all(w["dominant"] is None for w in filled), f"纯音乐窗不该硬评情绪: {filled}"
    assert "音乐" in s["digest"], f"纯音乐摘要异常: {s['digest']}"
    print("PASS 纯音乐窗：不硬评情绪，摘要标注以音乐为主")


def test_empty():
    s = summarize_arc(build_arc([], 30))
    assert "没有可说的声音" in s["digest"]
    print("PASS 空输入：给出安全摘要")


def test_intensity_turn_only():
    # 情绪不变但强度陡降（大喊→耳语）也应算转折
    items = [seg(i * 5, 4, f"吼{i}", mood="angry", arousal=0.95, emotion_zh="愤怒") for i in range(8)]
    items += [seg(60 + i * 5, 4, f"轻声{i}", mood="angry", arousal=0.1, emotion_zh="愤怒") for i in range(6)]
    s = summarize_arc(build_arc(items, window_s=30))
    assert any(t["type"] == "intensity" and t.get("dir") == "降" for t in s["turns"]), f"同情绪强度陡降未检出: {s['turns']}"
    print("PASS 同情绪不同强度：强度陡降被捕获")
    print("  digest =", s["digest"])


if __name__ == "__main__":
    test_calm_to_angry_to_calm()
    test_music_window_not_force_mood()
    test_empty()
    test_intensity_turn_only()
    print("ALL PASS")
