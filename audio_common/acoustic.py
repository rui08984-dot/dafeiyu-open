# acoustic.py —— 声学画像与声音分类（唯一实现，麦克风与回环两路共用）
#
# 为什么要共用：两条音频链（麦克风=你说话 / 回环=机器在放）原本各算各的，
# 一边只有音量/语速，另一边有类别/气氛，字段对不齐，上层就得写两套分支。
# 抽出来之后，两边都给同一套 kind/mood/arousal/cues。
#
# 判据来自实测标定：
#   spectral flux  语音 ≈0.75 / 持续乐音 ≈0.005（差 160 倍，是最稳的那个）
#   beat（包络自相关）音乐 ≈0.77 / 语音 ≈0.18
#   踩过的坑：放音乐时 ASR 会幻觉出文字（"my life’s been a"），
#   所以音乐判据必须排在「有没有文字」之前。
import numpy as np

def acoustic_profile(pcm: np.ndarray, sample_rate: int) -> dict:
    """把一段 16k 单声道音频压成几个判据：响度 / 亮度 / 平稳度 / 过零率 / 频带能量。"""
    x = np.asarray(pcm, dtype=np.float32)
    if x.size < 64:
        return {}
    # 响度：RMS 与峰值
    rms = float(np.sqrt(np.mean(x ** 2)) + 1e-12)
    peak = float(np.max(np.abs(x)) + 1e-12)
    # 过零率：清音/噪声高，浊音（人声、乐音）低
    zcr = float(np.mean(np.abs(np.diff(np.signbit(x).astype(np.int8)))) )
    # 频谱
    win = 1024
    hop = 512
    if x.size < win:
        x = np.pad(x, (0, win - x.size))
    frames = []
    for start in range(0, max(1, x.size - win + 1), hop):
        seg = x[start:start + win]
        if seg.size < win:
            seg = np.pad(seg, (0, win - seg.size))
        frames.append(np.abs(np.fft.rfft(seg * np.hanning(win))) + 1e-12)
    if not frames:
        return {}
    spec = np.mean(np.vstack(frames), axis=0)
    freqs = np.fft.rfftfreq(win, 1.0 / sample_rate)
    power = spec ** 2
    total = float(np.sum(power) + 1e-12)
    centroid = float(np.sum(freqs * power) / total)
    # 谱平坦度：几何均值/算术均值。纯噪声接近 1，乐音/人声接近 0
    flatness = float(np.exp(np.mean(np.log(spec))) / (np.mean(spec) + 1e-12))
    # 频带能量占比
    def band(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        return float(np.sum(power[m]) / total) if np.any(m) else 0.0
    low = band(0, 300)
    speech = band(300, 3400)
    high = band(3400, 8000)
    # 能量起伏：越大越「有节奏/激烈」
    frame_rms = np.array([float(np.sqrt(np.mean(f ** 2))) for f in np.array_split(x, 12) if f.size], dtype=np.float32)
    rms_std = float(np.std(frame_rms)) if frame_rms.size else 0.0
    # 频谱通量：相邻帧频谱差的和（归一化）。语音变化快 → 高；持续乐音 → 低。
    # 这是区分「音乐」和「人声」最稳的一个量 —— 比单看平坦度可靠得多，
    # 因为音乐被 ASR 幻觉出文字时，语法/字数都骗得过，但频谱帧间变化骗不过。
    mat = np.vstack(frames)
    # 只在「有声部分」算统计量：回环采集会把静音段和起落过渡也录进来，
    # 那些帧频谱乱跳，会把音乐也拉成高 flux（实测干净文件 0.005 → 采集后 0.63）。
    # 取能量前 40% 的帧，等于先做一次粗门限。
    frame_energy = np.sum(mat, axis=1)
    if frame_energy.size >= 5:
        thr = np.quantile(frame_energy, 0.60)
        mat = mat[frame_energy >= thr]
    mat = mat / (np.sum(mat, axis=1, keepdims=True) + 1e-12)
    flux = float(np.mean(np.sum(np.abs(np.diff(mat, axis=0)), axis=1))) if mat.shape[0] > 1 else 0.0
    # 节拍规律性：把能量包络做自相关，看 0.35~1.2 秒（50~170BPM）范围内有没有稳定的峰。
    # 音乐/有节奏的东西高，说话没有稳定节拍。实测：音乐 0.77 / 语音 0.18 / 噪声 0.11。
    beat = 0.0
    try:
        fr = max(1, int(sample_rate * 0.032))
        n_fr = x.size // fr
        if n_fr >= 20:
            env = np.array([float(np.sqrt(np.mean(x[i*fr:(i+1)*fr] ** 2))) for i in range(n_fr)], dtype=np.float32)
            env = env - env.mean()
            if float(np.std(env)) > 1e-6:
                ac = np.correlate(env, env, 'full')[n_fr-1:]
                ac = ac / (ac[0] + 1e-9)
                fps = sample_rate / fr
                lo, hi = int(fps * 0.35), int(fps * 1.2)
                hi = min(hi, len(ac) - 1)
                if hi > lo:
                    beat = float(np.max(ac[lo:hi]))
    except Exception:
        beat = 0.0
    return {
        "rms": round(rms, 4),
        "peak": round(peak, 3),
        "zcr": round(zcr, 4),
        "beat": round(beat, 4),
        "centroid": round(centroid, 1),
        "flatness": round(flatness, 4),
        "band_low": round(low, 3),
        "band_speech": round(speech, 3),
        "band_high": round(high, 3),
        "rms_std": round(rms_std, 4),
        "flux": round(flux, 4),
    }


def classify_sound(profile: dict, has_text: bool, text_len: int = 99) -> dict:
    """把声学画像翻成「这是什么声音 + 什么气氛」。"""
    if not profile:
        return {"kind": "unknown", "mood": "neutral", "cues": []}
    flat = profile.get("flatness", 0)
    centroid = profile.get("centroid", 0)
    high = profile.get("band_high", 0)
    speech_band = profile.get("band_speech", 0)
    rms = profile.get("rms", 0)
    rms_std = profile.get("rms_std", 0)

    cues = []
    kind = "unknown"
    if rms < 0.004:
        kind = "silence"
        cues.append("几乎没声音")
    elif profile.get("beat", 0) > 0.5:
        # 有稳定节拍 = 音乐/有节奏的内容（这条在回环采集下也能站住，因为它是时间域的）
        kind = "music"
        cues.append("有节拍、像音乐")
    elif profile.get("flux", 1) < 0.15 and flat < 0.25:
        # **频谱通量低 = 持续乐音**。这一条必须排在 has_text 前面：
        # 实测放音乐时 SenseVoice 会幻觉出文字（"my life's been a"），只看「有没有字」会判错；
        # 但帧间频谱变化骗不过：语音 flux≈0.75，和弦音乐 flux≈0.005，差 160 倍。
        kind = "music"
        cues.append("像音乐")
    elif has_text and (text_len >= 4 or speech_band > 0.5):
        # 认出 4 个字以上、或者中频明显被语音占据 → 人声。
        # （只看字数的坑：真实语音被识别成 2 个字时会被错判成噪声）
        kind = "speech"
        cues.append("有人说话")
        if profile.get("band_low", 0) > 0.45 and flat < 0.2:
            kind = "speech_music"
            cues.append("像是配乐里有人在说/唱")
    elif flat > 0.5 and profile.get("zcr", 0) > 0.25:
        # 真噪声：谱很平 + 过零率高
        kind = "noise"
        cues.append("嘈杂/噪声")
    elif flat < 0.15 and centroid < 1800:
        kind = "music"
        cues.append("像音乐")
    else:
        kind = "ambient"
        cues.append("环境声")

    # 气氛：靠响度和起伏，不看语义
    arousal = 0.0
    if rms > 0.06: arousal += 0.45
    elif rms > 0.03: arousal += 0.25
    if rms_std > 0.02: arousal += 0.3
    elif rms_std > 0.008: arousal += 0.15
    if high > 0.3: arousal += 0.15
    arousal = min(1.0, arousal)
    if arousal > 0.6:
        mood = "intense"
        cues.append("动静很大")
    elif arousal > 0.3:
        mood = "lively"
        cues.append("有动静")
    else:
        mood = "calm"
    return {"kind": kind, "mood": mood, "arousal": round(arousal, 2), "cues": cues}
