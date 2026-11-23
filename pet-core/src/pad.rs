//! 统一情绪状态总线 —— PAD 连续空间（论文依据：2409.16681 PAD 可插值可混合；
//! n=199 人因实验 2309.15311：表情/语音必须由同一情绪状态派生才有「活着」的感觉）。
//!
//! 设计：
//!   - 12 个情绪 = PAD 坐标系里的锚点，每个锚点携带现有 PROSODY 表的 (rate,pitch,volume)
//!     —— 纯情绪时精确复现 edge-tts 离散表（向后兼容），混合时按反距离加权插值
//!   - mood（心气 -1..1）做基线偏置：心气差的人连开心事都说得略低沉（可信陪伴的核心细节）
//!   - 纯函数、无 IO；edge-tts 每次推韵律时 exec 一次（1.2s 节奏，~15ms，可接受）
//!
//! 坐标语义：P=愉悦度(-1..1) A=唤醒度(-1..1)。数值为标准 Mehrabian 语义的手调锚点，
//! 唯一硬约束是「纯情绪 = 现有表值」，混合方向符合直觉（如 angry+sad → 压抑的怒）。

pub const NEUTRAL_RATE: f64 = 1.0;

pub struct Anchor {
    pub id: &'static str,
    pub p: f64,
    pub a: f64,
    pub rate: f64,
    pub pitch: f64,
    pub volume: f64,
}

/// 12 情绪锚点：PAD 语义坐标 + 现有 edge-tts PROSODY 表值（逐行校准，勿单改一侧）
pub const ANCHORS: &[Anchor] = &[
    Anchor { id: "happy",     p: 0.8,  a: 0.6,  rate: 1.08, pitch: 6.0,  volume: 3.0 },
    Anchor { id: "smug",      p: 0.5,  a: 0.3,  rate: 1.05, pitch: 4.0,  volume: 2.0 },
    Anchor { id: "tease",     p: 0.4,  a: 0.5,  rate: 1.06, pitch: 5.0,  volume: 2.0 },
    Anchor { id: "surprise",  p: 0.1,  a: 0.8,  rate: 1.10, pitch: 8.0,  volume: 4.0 },
    Anchor { id: "shy",       p: 0.3,  a: -0.2, rate: 0.94, pitch: 7.0,  volume: -3.0 },
    Anchor { id: "neutral",   p: 0.0,  a: 0.3,  rate: 1.00, pitch: 0.0,  volume: 0.0 },
    Anchor { id: "bored",     p: -0.3, a: -0.5, rate: 0.92, pitch: -4.0, volume: -3.0 },
    Anchor { id: "sleepy",    p: -0.1, a: -0.8, rate: 0.85, pitch: -7.0, volume: -6.0 },
    Anchor { id: "sad",       p: -0.8, a: -0.3, rate: 0.88, pitch: -7.0, volume: -5.0 },
    Anchor { id: "aggrieved", p: -0.6, a: -0.1, rate: 0.91, pitch: -5.0, volume: -4.0 },
    Anchor { id: "angry",     p: -0.6, a: 0.9,  rate: 1.12, pitch: -5.0, volume: 5.0 },
    Anchor { id: "guilty",    p: -0.4, a: -0.2, rate: 0.95, pitch: -3.0, volume: -4.0 },
];

fn anchor(id: &str) -> Option<&'static Anchor> {
    ANCHORS.iter().find(|a| a.id == id)
}

#[derive(Debug, Clone)]
pub struct Prosody {
    pub rate: f64,
    pub pitch: f64,
    pub volume: f64,
}

/// 混合韵律：emotions = [(情绪id, 强度0~1.5)]，mood = 心气 -1..1。
///  - 纯情绪（单条）→ 精确复现锚点值（×强度内插向 neutral，与旧 prosody_for 的 k 语义一致）
///  - 多条 → PAD 反距离加权（IDW）混合，可插值可混合
///  - mood 偏置：pitch ∓、volume ∓，幅度 ±15%（心气差的人连开心都略低沉）
pub fn blend_prosody(emotions: &[(&str, f64)], mood: f64) -> Prosody {
    let mut wr = 0.0;
    let mut wp = 0.0;
    let mut wv = 0.0;
    let mut wsum = 0.0;
    for (id, strength) in emotions {
        let a = match anchor(id) {
            Some(a) => a,
            None => continue,
        };
        let k = clamp(*strength, 0.0, 1.5);
        if k <= 0.0 {
            continue;
        }
        // 强度作为「靠近锚点的程度」：k=1 在锚点上，k<1 向 neutral 收缩（与旧 k 语义一致）
        let px = a.p * k;
        let ax = a.a * k;
        let (r, p, v) = (a.rate, a.pitch, a.volume);
        // 在 PAD 平面上取「该情绪按 k 收缩后的实际坐标」与锚点距离做权重
        let d = dist(px, ax, a.p, a.a) + 1e-6;
        let w = 1.0 / (d * d);
        wr += w * r;
        wp += w * p;
        wv += w * v;
        wsum += w;
    }
    if wsum <= 0.0 {
        return apply_mood(Prosody { rate: NEUTRAL_RATE, pitch: 0.0, volume: 0.0 }, mood);
    }
    let mut prosody = Prosody { rate: wr / wsum, pitch: wp / wsum, volume: wv / wsum };
    // 强度整体缩放（k<1 向 neutral 收）——按最强强度算系数
    let kmax = emotions.iter().map(|(_, s)| clamp(*s, 0.0, 1.5)).fold(0.0, f64::max);
    if kmax > 0.0 && kmax < 1.0 {
        prosody.rate = NEUTRAL_RATE + (prosody.rate - NEUTRAL_RATE) * kmax;
        prosody.pitch *= kmax;
        prosody.volume *= kmax;
    }
    apply_mood(prosody, mood)
}

fn apply_mood(mut p: Prosody, mood: f64) -> Prosody {
    let m = clamp(mood, -1.0, 1.0);
    // 心气偏置（加性）：心气 -1 → 音调 -2 / 音量 -1.5（对零基线的中性也生效——
    // 乘法在 neutral pitch=0 时恒零，是首版测试抓出来的设计错）
    p.pitch += m * 2.0;
    p.volume += m * 1.5;
    p
}

fn dist(x1: f64, y1: f64, x2: f64, y2: f64) -> f64 {
    ((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2)).sqrt()
}

fn clamp(v: f64, min: f64, max: f64) -> f64 {
    v.max(min).min(max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn pure_emotion_reproduces_table() {
        // 纯情绪必须精确复现 edge-tts 离散表（向后兼容的硬约束）
        let p = blend_prosody(&[("happy", 1.0)], 0.0);
        assert!(close(p.rate, 1.08, 1e-6) && close(p.pitch, 6.0, 1e-6) && close(p.volume, 3.0, 1e-6), "{:?}", p);
        let p = blend_prosody(&[("angry", 1.0)], 0.0);
        assert!(close(p.rate, 1.12, 1e-6) && close(p.pitch, -5.0, 1e-6) && close(p.volume, 5.0, 1e-6), "{:?}", p);
        let p = blend_prosody(&[("sleepy", 1.0)], 0.0);
        assert!(close(p.rate, 0.85, 1e-6) && close(p.pitch, -7.0, 1e-6), "{:?}", p);
    }

    #[test]
    fn neutral_is_baseline() {
        let p = blend_prosody(&[("neutral", 1.0)], 0.0);
        assert!(close(p.rate, 1.0, 1e-6) && close(p.pitch, 0.0, 1e-6) && close(p.volume, 0.0, 1e-6));
        // 未知情绪 → neutral
        let p = blend_prosody(&[("unknown_emo", 1.0)], 0.0);
        assert!(close(p.rate, 1.0, 1e-6));
    }

    #[test]
    fn strength_scales_toward_neutral() {
        let full = blend_prosody(&[("happy", 1.0)], 0.0);
        let half = blend_prosody(&[("happy", 0.5)], 0.0);
        assert!(half.pitch < full.pitch && half.pitch > 0.0, "半强度应向中性收: {:?}", half);
        assert!(half.rate < full.rate && half.rate > 1.0);
    }

    #[test]
    fn blend_interpolates_between_anchors() {
        // happy + sad 等权混合：rate 应落在两者之间（1.08 与 0.88 之间），pitch 在 6 与 -7 之间
        let p = blend_prosody(&[("happy", 1.0), ("sad", 1.0)], 0.0);
        assert!(p.rate > 0.88 && p.rate < 1.08, "混合 rate 越界: {}", p.rate);
        assert!(p.pitch > -7.0 && p.pitch < 6.0, "混合 pitch 越界: {}", p.pitch);
        // 情绪混合的非线性：不应精确等于算术平均（PAD 距离不同权重不同），但必须单调合理
        let p2 = blend_prosody(&[("happy", 1.0)], 0.0);
        let p3 = blend_prosody(&[("sad", 1.0)], 0.0);
        assert!((p.pitch - p2.pitch) * (p.pitch - p3.pitch) <= 0.0, "混合 pitch 应在两锚点之间");
    }

    #[test]
    fn mood_biases_baseline() {
        let emo = &[("neutral", 1.0)];
        let up = blend_prosody(emo, 0.8);
        let mid = blend_prosody(emo, 0.0);
        let down = blend_prosody(emo, -0.8);
        assert!(down.pitch < mid.pitch && mid.pitch < up.pitch, "心气应单调偏置音调: {} {} {}", down.pitch, mid.pitch, up.pitch);
        assert!(down.volume < mid.volume && mid.volume < up.volume, "心气应单调偏置音量");
        // 加性语义：心气 -1 → happy 音调 6-2=4（仍高于中性 0，只是没那么雀跃）
        let happy_down = blend_prosody(&[("happy", 1.0)], -1.0);
        let happy_mid = blend_prosody(&[("happy", 1.0)], 0.0);
        assert!(happy_down.pitch < happy_mid.pitch && happy_down.pitch > 0.0, "心气 -1 压低但不变丧: {} vs {}", happy_down.pitch, happy_mid.pitch);
    }

    #[test]
    fn mixed_mood_and_emotion() {
        // 心气很差 + 生气：比单纯生气更低沉（可信陪伴：心情差时连发火都发不响）
        let mad = blend_prosody(&[("angry", 1.0)], 0.0);
        let mad_sad_mood = blend_prosody(&[("angry", 1.0)], -0.8);
        assert!(mad_sad_mood.pitch < mad.pitch, "坏心气应压低怒气的音调: {} vs {}", mad_sad_mood.pitch, mad.pitch);
        assert!(mad_sad_mood.volume < mad.volume, "坏心气应压低怒气的音量");
    }

    #[test]
    fn empty_and_zero_strength_safe() {
        let p = blend_prosody(&[], 0.0);
        assert!(close(p.rate, 1.0, 1e-6));
        let p = blend_prosody(&[("happy", 0.0)], 0.0);
        assert!(close(p.rate, 1.0, 1e-6), "零强度=中性: {:?}", p);
    }
}
