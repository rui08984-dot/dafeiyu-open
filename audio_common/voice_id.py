"""voice_id.py —— 说话人粗分：基频(F0) + 谱质心 → 男/女/童声标签 + 声纹指纹底座。

定位（第一性原理，见 docs/研究-全方向调研）：
  我们要的不是学术级 diarization（pyannote 1GB 那套），
  而是「她能分清身边两三个常出现的声音」：
    ① 基频粗分 男女/童声 —— 纯 numpy 自相关法，零依赖零模型
    ② 声纹指纹接口 —— 留 frame 特征向量均值作「简易声纹」，
       未来接 resemblyzer(3MB) 时同一接口直接升级

用法：
  r = analyze_voice(pcm, sample_rate)
  r = {"f0_hz": 182.4, "voice_class": "female", "confidence": 0.7,
       "centroid_hz": 2100.0, "voiceprint": [ ... 16 维 ... ]}

纪律：纯函数；输入 pcm 为 float32 单声道（-1..1）；静音/非人声返回 unknown。
"""

from __future__ import annotations

import numpy as np

# 基频搜索范围：男低 60Hz ~ 童声/女高 400Hz
F0_MIN, F0_MAX = 60.0, 400.0
# 分类阈值（粗分，边界样本落 unknown 属预期）：成人男声基频大多 85~155Hz，
# 成人女声 165~255Hz，童声 250Hz+。155/255 之间留了重叠带给 unknown。
MALE_MAX = 155.0
CHILD_MIN = 255.0
FRAME = 1024


def _frames(x: np.ndarray, size: int = FRAME):
    for i in range(0, max(1, len(x) - size + 1), size // 2):
        f = x[i:i + size]
        if f.size == size:
            yield f


def _frame_energy(f: np.ndarray) -> float:
    return float(np.sqrt(np.mean(f ** 2)) + 1e-12)


def estimate_f0(x: np.ndarray, sample_rate: int) -> float | None:
    """自相关法 F0：取能量前 30% 的帧，各自找 60~400Hz 的自相关峰，取中位数。"""
    if x.size < FRAME * 3:
        return None
    frames = list(_frames(x))
    if not frames:
        return None
    energies = np.array([_frame_energy(f) for f in frames])
    thresh = np.quantile(energies, 0.70)
    voiced = [f for f, e in zip(frames, energies) if e >= thresh]
    if not voiced:
        return None

    lag_min = int(sample_rate / F0_MAX)
    lag_max = int(sample_rate / F0_MIN)
    f0s = []
    for f in voiced:
        f = f - float(np.mean(f))
        energy = float(np.sum(f ** 2)) + 1e-12
        ac = np.correlate(f, f, mode="full")[FRAME - 1:]
        if lag_max + 1 >= ac.size:
            continue
        seg = ac[lag_min:lag_max + 1]
        if seg.size == 0:
            continue
        lag = int(np.argmax(seg)) + lag_min
        peak = float(ac[lag])
        # 峰值要显著（>30% 零滞后能量），否则是噪声/清音，别硬报基频
        if peak > energy * 0.30:
            f0s.append(sample_rate / lag)
    if len(f0s) < 3:
        return None
    return float(np.median(f0s))


def _spectral_centroid(x: np.ndarray, sample_rate: int) -> float | None:
    frames = list(_frames(x))
    if not frames:
        return None
    win = np.hanning(FRAME)
    cents = []
    for f in frames:
        spec = np.abs(np.fft.rfft(f * win)) + 1e-12
        freqs = np.fft.rfftfreq(FRAME, 1.0 / sample_rate)
        cents.append(float(np.sum(freqs * spec) / np.sum(spec)))
    return float(np.median(cents))


def _voiceprint(x: np.ndarray, sample_rate: int, dim: int = 16) -> list[float]:
    """简易声纹：梅尔式频带能量的对数均值向量（dim 维）。
    跨时间一致性一般但零依赖；接 resemblyzer 后本函数整体替换。"""
    frames = list(_frames(x))
    if not frames:
        return []
    win = np.hanning(FRAME)
    bands = np.array([_spectral_band(e, sample_rate, dim) for e in [np.abs(np.fft.rfft(f * win)) for f in frames]])
    return [round(float(v), 5) for v in np.mean(bands, axis=0)]


def _spectral_band(spec: np.ndarray, sample_rate: int, dim: int) -> np.ndarray:
    freqs = np.fft.rfftfreq(FRAME, 1.0 / sample_rate)
    edges = np.geomspace(80, 6000, dim + 1)
    out = []
    for i in range(dim):
        m = (freqs >= edges[i]) & (freqs < edges[i + 1])
        out.append(float(np.mean(spec[m])) if np.any(m) else 0.0)
    v = np.array(out) + 1e-9
    return np.log(v)  # 对数压缩：贴近人耳响度感，也让指纹更稳


def analyze_voice(pcm: np.ndarray, sample_rate: int) -> dict:
    x = np.asarray(pcm, dtype=np.float32)
    if x.size < FRAME * 3 or float(np.max(np.abs(x)) + 1e-12) < 0.01:
        return {"f0_hz": None, "voice_class": "unknown", "confidence": 0.0,
                "centroid_hz": None, "voiceprint": []}
    f0 = estimate_f0(x, sample_rate)
    centroid = _spectral_centroid(x, sample_rate)
    vp = _voiceprint(x, sample_rate)

    voice_class, conf = "unknown", 0.0
    if f0 is not None:
        if f0 <= MALE_MAX:
            voice_class, conf = "male", min(1.0, (MALE_MAX - f0) / 60.0 + 0.5)
        elif f0 >= CHILD_MIN:
            voice_class, conf = "child", min(1.0, (f0 - CHILD_MIN) / 80.0 + 0.5)
        elif MALE_MAX < f0 < 175 or 235 < f0 < CHILD_MIN:
            voice_class, conf = "female", 0.45   # 重叠带：低置信
        else:
            voice_class, conf = "female", 0.7
    return {
        "f0_hz": None if f0 is None else round(f0, 1),
        "voice_class": voice_class,
        "confidence": round(conf, 2),
        "centroid_hz": None if centroid is None else round(centroid, 1),
        "voiceprint": vp,
    }
