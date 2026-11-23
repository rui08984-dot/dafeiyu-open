# ser.py —— SenseVoice 自带的 SER（情绪）+ AED（音频事件）解码
#
# 之前我以为 sherpa-onnx 把这两样丢了，其实早就暴露了：
#   result.emotion = "<|ANGRY|>"   result.event = "<|Speech|>"   result.lang = "<|zh|>"
# 模型词表里本来就有：
#   情绪 HAPPY / SAD / ANGRY / NEUTRAL / FEARFUL / DISGUSTED / SURPRISED / OTHER / EMO_UNKNOWN
#   事件 Speech / BGM / Laughter / Applause / Cry / Sneeze / Breath / Cough / Sing / Speech_Noise
#
# 所以「听懂情绪」不需要额外模型、不需要 torch、不需要下载——同一个模型同一遍推理。

EMOTIONS = {
    "HAPPY":     {"zh": "开心", "mood": "happy",     "arousal": 0.75},
    "SAD":       {"zh": "难过", "mood": "sad",       "arousal": 0.30},
    "ANGRY":     {"zh": "生气", "mood": "angry",     "arousal": 0.85},
    "NEUTRAL":   {"zh": "平静", "mood": "neutral",   "arousal": 0.40},
    "FEARFUL":   {"zh": "紧张", "mood": "fearful",   "arousal": 0.80},
    "DISGUSTED": {"zh": "反感", "mood": "disgusted", "arousal": 0.60},
    "SURPRISED": {"zh": "惊讶", "mood": "surprised", "arousal": 0.78},
    "OTHER":     {"zh": "说不上来", "mood": "other", "arousal": 0.50},
}

EVENTS = {
    "Speech":       {"kind": "speech",   "zh": "有人在说话"},
    "BGM":          {"kind": "music",    "zh": "背景音乐"},
    "Laughter":     {"kind": "laughter", "zh": "有人在笑"},
    "Applause":     {"kind": "applause", "zh": "掌声"},
    "Cry":          {"kind": "cry",      "zh": "有人在哭"},
    "Sing":         {"kind": "sing",     "zh": "有人在唱"},
    "Cough":        {"kind": "cough",    "zh": "咳嗽声"},
    "Sneeze":       {"kind": "sneeze",   "zh": "喷嚏声"},
    "Breath":       {"kind": "breath",   "zh": "呼吸声"},
    "Speech_Noise": {"kind": "noise",    "zh": "嘈杂"},
}


def _clean(tag):
    """把 <|ANGRY|> 变成 ANGRY"""
    if not tag:
        return ""
    s = str(tag).strip()
    if s.startswith("<|"):
        s = s[2:]
    if s.endswith("|>"):
        s = s[:-2]
    return s.strip()


def from_result(emotion_tag, event_tag, lang_tag):
    """从 SenseVoice 的三个标记算出统一字段。

    返回值与声学层兼容：kind / mood / arousal / cues，另带 emotion_zh / event_zh / confident。
    EMO_UNKNOWN 或 Event_UNK 时返回 None，让调用方回落到声学判据。
    """
    emo = _clean(emotion_tag)
    ev = _clean(event_tag)
    lang = _clean(lang_tag)
    out = {"kind": None, "mood": None, "arousal": None, "cues": [],
           "emotion_zh": None, "event_zh": None, "lang": lang or None, "confident": False}

    e = EMOTIONS.get(emo)
    if e:
        out["mood"] = e["mood"]
        out["arousal"] = e["arousal"]
        out["emotion_zh"] = e["zh"]
        out["confident"] = True
        out["cues"].append("听着像" + e["zh"])

    v = EVENTS.get(ev)
    if v:
        out["kind"] = v["kind"]
        out["event_zh"] = v["zh"]
        out["confident"] = True
        out["cues"].insert(0, v["zh"])

    # 非人声的事件，情绪标签没意义（音乐也会给 EMO_UNKNOWN）
    if out["kind"] and out["kind"] not in ("speech",):
        out["mood"] = out["mood"] or "neutral"

    if not out["cues"]:
        return None
    return out


def describe(ser):
    """给 LLM 看的一句话，例如「有人在说话，听着像生气」。"""
    if not ser:
        return ""
    parts = []
    if ser.get("event_zh"):
        parts.append(ser["event_zh"])
    if ser.get("emotion_zh") and ser.get("kind") == "speech":
        parts.append("听着像" + ser["emotion_zh"])
    return "，".join(parts)
