//! 心情数学：把 driver.js 的 moodStore 纯逻辑部分原样钉进 Rust。
//!
//! 为什么：情绪是「这一秒的脸」，心情是「这几天的心气」。衰减参数
//! （负面 36h / 正面 18h 半衰、负面权重 1.0 vs 正面 0.5、tanh 软饱和）
//! 是 2026-10-31 拍板的保护项（交接件 §2-4），沉进带单测的内核等于给它上锁。
//!
//! IO（读心情.json / 写盘节流）留在 JS 侧；这里只收纯计算：
//! now 一律由调用方传入（毫秒时间戳），保证可测。

/// 情绪 → 心情增量。只用心明确的几种，别硬凑（与 driver.js delta 表一致）。
pub fn delta_of(emotion: &str) -> Option<f64> {
    match emotion {
        "happy" => Some(0.22),
        "smug" => Some(0.16),
        "tease" => Some(0.10),
        "shy" => Some(0.08),
        "surprise" => Some(0.02),
        "neutral" => Some(0.0),
        "bored" => Some(-0.06),
        "sleepy" => Some(-0.10),
        "sad" => Some(-0.22),
        "aggrieved" => Some(-0.18),
        "angry" => Some(-0.26),
        "guilty" => Some(-0.08),
        _ => None,
    }
}

/// 一条情绪事件（对应 JS 的 wounds[] 项）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Wound {
    pub at: i64,
    pub emo: String,
    pub sign: i32,
    pub s: f64,
    #[serde(default)]
    pub note: String,
}

/// 同一种情绪 3 分钟内只记一次（情绪是 1.5 秒上报一次的，不节流会写爆盘）。
const NOTE_DUP_MS: i64 = 3 * 60 * 1000;
/// 太轻的不值得记，不然全是噪声。
const NOTE_MIN_STRENGTH: f64 = 0.5;
/// 记忆上限（与 JS slice(-40) 一致）。
const WOUNDS_CAP: usize = 40;
/// 七天前的旧账不再翻。
const WOUND_TTL_H: f64 = 24.0 * 7.0;
/// 负面半衰 36h / 正面 18h；权重 1.0 / 0.5（拍板保护参数，勿改）。
pub const TAU_NEG_H: f64 = 36.0;
pub const TAU_POS_H: f64 = 18.0;
pub const WEIGHT_NEG: f64 = 1.0;
pub const WEIGHT_POS: f64 = 0.5;
/// tanh 软饱和系数：一笔明显的委屈是「有点烦」，好几笔才到「心情很差」。
pub const RESIDUE_GAIN: f64 = 0.55;

pub fn sign_of(emotion: &str) -> i32 {
    match emotion {
        "sad" | "aggrieved" | "angry" | "guilty" | "bored" => -1,
        "happy" | "smug" | "shy" => 1,
        _ => 0,
    }
}

fn clamp1(v: f64) -> f64 {
    v.max(-1.0).min(1.0)
}

/// 载入时的心气回中：越久没见面，心气越回中位（半衰 18h，不会记仇记一周）。
pub fn decay_since(score: f64, updated_at_ms: i64, now_ms: i64) -> f64 {
    let hours = (now_ms - updated_at_ms) as f64 / 3_600_000.0;
    if hours <= 0.0 {
        return clamp1(score);
    }
    clamp1(score * (-hours / 18.0).exp())
}

#[derive(Debug, Default)]
pub struct MoodStore {
    pub score: f64,
    pub wounds: Vec<Wound>,
}

impl MoodStore {
    /// 收到情绪上报时累积（EMA，避免被一句话带跑）。
    pub fn feed(&mut self, emotion: &str) -> bool {
        let d = match delta_of(emotion) {
            Some(d) => d,
            None => return false,
        };
        // 中性只是长尾，慢慢回中位；不要用狠度大的衰减，
        // 否则人还没走开，心情就被中位吸回去了。
        if emotion == "neutral" {
            self.score *= 0.997;
            return true;
        }
        self.score = clamp1(self.score * 0.94 + d);
        true
    }

    /// 记一笔情绪事件。note 是当时的用户原话，用来解释「为什么」。
    /// 返回 Some(记录) 表示新记或更新了已有记录。
    pub fn note(&mut self, emotion: &str, strength: f64, note: &str, now_ms: i64) -> Option<Wound> {
        let sign = sign_of(emotion);
        if sign == 0 {
            return None;
        }
        let s = strength.max(0.0).min(1.0);
        if s < NOTE_MIN_STRENGTH {
            return None;
        }
        // 顺带把强度抬到最高值（与 JS Math.max(dup.s, s) 一致）。
        if let Some(dup) = self
            .wounds
            .iter_mut()
            .find(|x| x.emo == emotion && now_ms - x.at < NOTE_DUP_MS)
        {
            dup.s = dup.s.max((s * 100.0).round() / 100.0);
            dup.at = now_ms;
            if !note.is_empty() && dup.note.is_empty() {
                dup.note = note.chars().take(40).collect();
            }
            return Some(dup.clone());
        }
        let rec = Wound {
            at: now_ms,
            emo: emotion.to_string(),
            sign,
            s: (s * 100.0).round() / 100.0,
            note: note.chars().take(40).collect(),
        };
        self.wounds.push(rec.clone());
        if self.wounds.len() > WOUNDS_CAP {
            let drop = self.wounds.len() - WOUNDS_CAP;
            self.wounds.drain(0..drop);
        }
        Some(rec)
    }

    /// 还没散掉的余味（-1..1）。
    pub fn residue(&self, now_ms: i64) -> f64 {
        let mut sum = 0.0;
        for x in &self.wounds {
            let h = (now_ms - x.at) as f64 / 3_600_000.0;
            if h > WOUND_TTL_H {
                continue;
            }
            let (tau, weight) = if x.sign < 0 {
                (TAU_NEG_H, WEIGHT_NEG)
            } else {
                (TAU_POS_H, WEIGHT_POS)
            };
            sum += x.sign as f64 * x.s * weight * (-h / tau).exp();
        }
        (sum * RESIDUE_GAIN).tanh()
    }

    fn wound_weight(x: &Wound, now_ms: i64) -> f64 {
        let h = (now_ms - x.at) as f64 / 3_600_000.0;
        let tau = if x.sign < 0 { TAU_NEG_H } else { TAU_POS_H };
        x.sign as f64 * x.s * (-h / tau).exp()
    }

    /// 最近一条还有分量的记忆。want_sign 给定时只找同向的，避免自相矛盾。
    /// 先找「说得清为什么」的那条，找不到再退回任意一条。
    pub fn last_wound(&self, want_sign: i32, now_ms: i64) -> Option<(Wound, f64)> {
        let eligible = |x: &Wound, need_note: bool| -> bool {
            if want_sign != 0 && x.sign.signum() != want_sign.signum() {
                return false;
            }
            if need_note && x.note.is_empty() {
                return false;
            }
            if (now_ms - x.at) as f64 / 3_600_000.0 > WOUND_TTL_H {
                return false;
            }
            Self::wound_weight(x, now_ms).abs() >= 0.25
        };
        for need_note in [true, false] {
            for x in self.wounds.iter().rev() {
                if !eligible(x, need_note) {
                    continue;
                }
                let hours = ((now_ms - x.at) as f64 / 3_600_000.0 * 10.0).round() / 10.0;
                return Some((x.clone(), hours));
            }
        }
        None
    }

    /// 把心情翻译成开场的心气：当下心情 70% + 还没散的余味 30%。
    pub fn describe(&self, now_ms: i64) -> Describe {
        let res = self.residue(now_ms);
        let total = clamp1(self.score * 0.7 + res);
        let mut line = if total > 0.45 {
            "心情不错"
        } else if total > 0.10 {
            "还行"
        } else if total < -0.45 {
            "心情很差"
        } else if total < -0.10 {
            "有点烦"
        } else {
            "平平的"
        }
        .to_string();
        let mood = if total > 0.45 {
            "cheerful"
        } else if total > 0.1 {
            "ok"
        } else if total < -0.45 {
            "low"
        } else if total < -0.1 {
            "meh"
        } else {
            "flat"
        };
        let emo = if total > 0.45 {
            "happy"
        } else if total > 0.1 {
            "smug"
        } else if total < -0.45 {
            "sad"
        } else if total < -0.1 {
            "bored"
        } else {
            "neutral"
        };
        // 有余味就说明白「为什么」——这才像个人，而不是每次重置的 NPC
        if let Some((w, hours)) = self.last_wound(total.signum() as i32, now_ms) {
            if total.abs() > 0.08 && Self::wound_weight(&w, now_ms).abs() >= 0.25 {
                let when = if hours < 1.0 {
                    "刚才".to_string()
                } else if hours < 24.0 {
                    format!("{} 小时前", hours.round() as i64)
                } else {
                    format!("{} 天前", (hours / 24.0).round() as i64)
                };
                if w.sign < 0 {
                    line += &format!("，还记着{}", when);
                    if !w.note.is_empty() {
                        line += &format!("因为「{}」", w.note);
                    }
                } else {
                    line += &format!("，{}那事还挺开心", when);
                }
            }
        }
        Describe {
            mood: mood.to_string(),
            emo: emo.to_string(),
            line,
            score: (total * 100.0).round() / 100.0,
            residue: (res * 100.0).round() / 100.0,
        }
    }
}

#[derive(Debug, serde::Serialize)]
pub struct Describe {
    pub mood: String,
    pub emo: String,
    pub line: String,
    pub score: f64,
    pub residue: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000; // 任意固定「现在」
    const H: i64 = 3_600_000;

    fn wound(emo: &str, sign: i32, s: f64, hours_ago: f64, note: &str) -> Wound {
        Wound {
            at: NOW - (hours_ago * H as f64) as i64,
            emo: emo.to_string(),
            sign,
            s,
            note: note.to_string(),
        }
    }

    #[test]
    fn feed_ema_matches_js() {
        let mut m = MoodStore::default();
        assert!(m.feed("happy"));
        assert!((m.score - 0.22).abs() < 1e-9);
        assert!(m.feed("angry"));
        assert!((m.score - (0.22 * 0.94 - 0.26)).abs() < 1e-9, "{}", m.score);
        // 未知情绪不改动
        assert!(!m.feed("unknown"));
        assert!((m.score - (0.22 * 0.94 - 0.26)).abs() < 1e-9);
    }

    #[test]
    fn feed_neutral_decays_slowly() {
        let mut m = MoodStore { score: 0.5, wounds: vec![] };
        m.feed("neutral");
        assert!((m.score - 0.5 * 0.997).abs() < 1e-9);
    }

    #[test]
    fn note_rejects_weak_and_neutral() {
        let mut m = MoodStore::default();
        assert!(m.note("angry", 0.4, "", NOW).is_none(), "强度 <0.5 不记");
        assert!(m.note("neutral", 0.9, "", NOW).is_none(), "无向情绪不记");
    }

    #[test]
    fn note_dedups_within_3min_and_keeps_max_strength() {
        let mut m = MoodStore::default();
        let _a = m.note("angry", 0.6, "凶我", NOW).unwrap();
        let b = m.note("angry", 0.8, "", NOW + 60_000).unwrap();
        assert_eq!(b.at, NOW + 60_000, "同一条被更新（at 刷新）而不是新增");
        assert_eq!(m.wounds.len(), 1);
        assert!((b.s - 0.8).abs() < 1e-9, "强度抬到最高值");
        assert_eq!(b.note, "凶我", "原话保留");
        // 3 分钟后可以再记一条
        m.note("angry", 0.7, "", NOW + 4 * 60_000).unwrap();
        assert_eq!(m.wounds.len(), 2);
    }

    #[test]
    fn wounds_capped_at_40() {
        let mut m = MoodStore::default();
        for i in 0..50 {
            m.note("sad", 0.9, "", NOW + i as i64 * 4 * 60_000);
        }
        assert_eq!(m.wounds.len(), 40);
    }

    #[test]
    fn residue_asymmetric_negative_lingers() {
        // 一条 s=1.0 的负面：|sum|=0.55 → |tanh|≈0.5002（余味方向为负）
        let m = MoodStore { score: 0.0, wounds: vec![wound("angry", -1, 1.0, 0.0, "")] };
        let neg = m.residue(NOW);
        assert!((neg.abs() - 0.55f64.tanh()).abs() < 1e-9);
        assert!(neg < 0.0, "负面伤口的余味方向是负");

        // 同强度正面：权重 0.5 → tanh(0.275)，明显更轻
        let m2 = MoodStore { score: 0.0, wounds: vec![wound("happy", 1, 1.0, 0.0, "")] };
        let pos = m2.residue(NOW);
        assert!(pos > 0.0);
        assert!(pos < neg.abs() * 0.6, "一句好话不该把委屈立刻清空 neg={} pos={}", neg, pos);
    }

    #[test]
    fn residue_half_lives_36h_vs_18h() {
        // exp(-h/τ) 是时间常数衰减：h=τ 时剩 e⁻¹≈0.368（JS 注释里的「半衰」是松称，公式为准）
        let e1 = (-1.0f64).exp();
        let neg = MoodStore { score: 0.0, wounds: vec![wound("angry", -1, 1.0, 36.0, "")] };
        let pos = MoodStore { score: 0.0, wounds: vec![wound("happy", 1, 1.0, 18.0, "")] };
        assert!((neg.residue(NOW).abs() - (e1 * 0.55f64).tanh()).abs() < 1e-9);
        assert!((pos.residue(NOW) - (0.5 * e1 * 0.55f64).tanh()).abs() < 1e-9);
    }

    #[test]
    fn residue_ignores_week_old_wounds() {
        let m = MoodStore { score: 0.0, wounds: vec![wound("angry", -1, 1.0, 24.0 * 7.0 + 1.0, "")] };
        assert!(m.residue(NOW).abs() < 1e-12);
    }

    #[test]
    fn residue_tanh_soft_saturation() {
        // 线性累加会在四五条后钉死 -1；tanh 保证还有呼吸空间。
        // 注意 note 有 3 分钟去重，5 条要隔开 4 分钟才会真正落 5 条。
        let mut m = MoodStore::default();
        for i in 0..5 {
            m.note("sad", 0.6, "", NOW + i as i64 * 4 * 60_000);
        }
        assert_eq!(m.wounds.len(), 5);
        let r = m.residue(NOW + 4 * 60_000 + 4);
        assert!(r < 0.0, "sad 是负向情绪");
        assert!(r.abs() < 1.0, "软饱和不许钉死: {}", r);
        assert!(r.abs() > (0.6 * RESIDUE_GAIN).tanh(), "多条确实比一条重: {}", r);
    }

    #[test]
    fn load_decay_18h() {
        // 交接实测口径：score 0.8 放 18h → ×e^-1 ≈ 0.294
        let d = decay_since(0.8, NOW - 18 * H, NOW);
        assert!((d - 0.8 * (-1.0f64).exp()).abs() < 1e-9);
        // 未来时间不放大
        assert!((decay_since(0.8, NOW + 18 * H, NOW) - 0.8).abs() < 1e-9);
    }

    #[test]
    fn last_wound_prefers_noted_then_latest() {
        let m = MoodStore {
            score: 0.0,
            wounds: vec![
                wound("sad", -1, 0.9, 1.0, ""),      // 最新但没原话
                wound("angry", -1, 0.9, 2.0, "被凶了"), // 稍旧但有原话
            ],
        };
        let (w, hours) = m.last_wound(0, NOW).unwrap();
        assert_eq!(w.emo, "angry", "先找说得清为什么的");
        assert!((hours - 2.0).abs() < 0.05);
    }

    #[test]
    fn last_wound_respects_sign_filter() {
        let m = MoodStore {
            score: 0.0,
            wounds: vec![wound("angry", -1, 0.9, 1.0, "凶"), wound("happy", 1, 0.9, 0.5, "夸")],
        };
        let (w, _) = m.last_wound(1, NOW).unwrap();
        assert_eq!(w.sign, 1);
        let (w2, _) = m.last_wound(-1, NOW).unwrap();
        assert_eq!(w2.sign, -1);
    }

    #[test]
    fn describe_explains_why_with_note() {
        let m = MoodStore {
            score: -0.3,
            wounds: vec![wound("angry", -1, 1.0, 2.0, "骂我")],
        };
        let d = m.describe(NOW);
        assert!(d.line.contains("还记着"), "{}", d.line);
        assert!(d.line.contains("骂我"), "{}", d.line);
        assert_eq!(d.mood, "low", "total=-0.3*0.7+余味≈-0.69 → 心情很差: {}", d.line);
    }

    #[test]
    fn describe_thresholds_match_js() {
        // total = score*0.7 + 余味（无 wounds 时余味=0），所以给 score 除以 0.7 的量级
        let mk = |score: f64| MoodStore { score, wounds: vec![] }.describe(NOW);
        assert_eq!(mk(0.8).mood, "cheerful");  // 0.56
        assert_eq!(mk(0.2).mood, "ok");        // 0.14
        assert_eq!(mk(0.0).mood, "flat");
        assert_eq!(mk(-0.3).mood, "meh");      // -0.21
        assert_eq!(mk(-0.8).mood, "low");      // -0.56
        assert_eq!(mk(0.2).emo, "smug");
        assert_eq!(mk(-0.3).emo, "bored");
        assert_eq!(mk(0.0).line, "平平的");
    }
}
