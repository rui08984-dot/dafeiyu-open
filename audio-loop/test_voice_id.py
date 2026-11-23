"""test_voice_id.py —— 说话人粗分最小验证（合成信号，纯本地）。"""
import sys
sys.path.insert(0, "..")

import numpy as np
from audio_common.voice_id import analyze_voice

SR = 16000


def voice(f0, dur_s=1.2, harmonics=5, noise=0.02, jitter=0.02):
    """带谐波和微颤的合成人声。相位用累积积分（inst_freq 的精确合成，
    之前直接把 jit 乘进频率参数会造成随时间累积的频率扫掠——测试信号自己的 bug）。"""
    t = np.arange(int(SR * dur_s)) / SR
    out = np.zeros_like(t)
    rng = np.random.default_rng(7)
    for h in range(1, harmonics + 1):
        amp = 1.0 / h
        inst = f0 * h * (1 + jitter * np.sin(2 * np.pi * 5 * t + h))
        phase = 2 * np.pi * np.cumsum(inst) / SR
        out += amp * np.sin(phase)
    out += noise * rng.standard_normal(len(t))
    # 5ms 淡入淡出防爆音
    fade = int(SR * 0.005)
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)
    return (out * 0.3).astype(np.float32)


def test_male():
    r = analyze_voice(voice(110), SR)
    assert r["voice_class"] == "male", f"110Hz 应判男声: {r}"
    assert 100 < (r["f0_hz"] or 0) < 125, f"F0 偏差过大: {r}"
    print("PASS 男声 110Hz →", r["voice_class"], r["f0_hz"], "Hz conf", r["confidence"])


def test_female():
    r = analyze_voice(voice(210), SR)
    assert r["voice_class"] == "female", f"210Hz 应判女声: {r}"
    print("PASS 女声 210Hz →", r["voice_class"], r["f0_hz"], "Hz conf", r["confidence"])


def test_child():
    r = analyze_voice(voice(300), SR)
    assert r["voice_class"] == "child", f"300Hz 应判童声: {r}"
    print("PASS 童声 300Hz →", r["voice_class"], r["f0_hz"], "Hz")


def test_silence_and_noise():
    r = analyze_voice(np.zeros(SR, dtype=np.float32), SR)
    assert r["voice_class"] == "unknown" and r["f0_hz"] is None
    r2 = analyze_voice((np.random.default_rng(1).standard_normal(SR) * 0.05).astype(np.float32), SR)
    assert r2["voice_class"] in ("unknown", "male", "female"), "白噪声不应崩溃"
    print("PASS 静音/白噪声：不崩溃，返回安全值")


def test_voiceprint_stability():
    a = analyze_voice(voice(140, harmonics=6), SR)["voiceprint"]
    b = analyze_voice(voice(140, harmonics=6), SR)["voiceprint"]
    assert a and b and len(a) == 16, "声纹维度应为 16"
    d = np.linalg.norm(np.array(a) - np.array(b))
    assert d < 0.5, f"同一声音两次指纹应几乎一致: d={d:.4f}"
    c = analyze_voice(voice(260, harmonics=6), SR)["voiceprint"]
    d2 = np.linalg.norm(np.array(a) - np.array(c))
    assert d2 > d, f"不同声音的指纹距离应更大: 同={d:.3f} 异={d2:.3f}"
    print(f"PASS 声纹：同人 d={d:.4f} < 异人 d={d2:.4f}")


if __name__ == "__main__":
    test_male()
    test_female()
    test_child()
    test_silence_and_noise()
    test_voiceprint_stability()
    print("ALL PASS")
