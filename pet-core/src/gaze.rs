//! 眼神跟随：把 ui/gaze.mjs（上游实现）的数学原样钉进 Rust。
//!
//! 为什么：这组参数（瞳孔 ±0.8、头部 30%±4°、离开 1.5s 宽限、0.6s 回中）
//! 决定「她看人像不像在看人」——是调过的手感参数，沉进带单测的内核等于上锁。
//! 渲染层每帧调的是 JS 版（同帧内、零进程开销）；Rust 版用于：
//!   ① 参数与行为的唯一真源（谁改 JS 版，跑这里的知识还在）
//!   ② 未来原生化（wasm/进程内）时直接可用
//!
//! 坐标约定与 JS 版一致：pointer 为归一化 -1..1（窗口中心为原点，y 屏幕向下为正，
//! 内部取反成 Live2D 的向上为正）；null/None 表示鼠标离开窗口。

/// 瞳孔最大偏移
pub const EYE_LIMIT: f64 = 0.8;
/// 头部跟随强度
pub const HEAD_RATIO: f64 = 0.3;
/// 皮套头部角度范围 ±30°
pub const HEAD_RANGE: f64 = 30.0;
/// 头部任务上限 ±4°
pub const HEAD_LIMIT: f64 = 4.0;
/// 跟随平滑时间常数（秒）
pub const FOLLOW_TAU: f64 = 0.12;
/// 回中时间常数（秒）
pub const RECENTER_TAU: f64 = 0.6;
/// 鼠标离开后保持多久再回中（毫秒）
pub const LEAVE_GRACE_MS: f64 = 1500.0;

fn clamp(v: f64, min: f64, max: f64) -> f64 {
    v.max(min).min(max)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Offsets {
    pub eye_x: f64,
    pub eye_y: f64,
    pub head_x: f64,
    pub head_y: f64,
}

#[derive(Debug)]
pub struct GazeFollow {
    has_pointer: bool,
    raw_x: f64,
    raw_y: f64,
    x: f64,
    y: f64,
    last_at_ms: f64,
    left_at_ms: f64,
}

impl Default for GazeFollow {
    fn default() -> Self {
        Self { has_pointer: false, raw_x: 0.0, raw_y: 0.0, x: 0.0, y: 0.0, last_at_ms: 0.0, left_at_ms: 0.0 }
    }
}

impl GazeFollow {
    pub fn new() -> Self {
        Self::default()
    }

    /** 收到归一化指针；None 表示鼠标离开窗口（与 JS setPointer(null) 对齐）。 */
    pub fn set_pointer(&mut self, x: Option<f64>, y: Option<f64>, now_ms: f64) {
        match (x, y) {
            (Some(nx), Some(ny)) if nx.is_finite() && ny.is_finite() => {
                if !self.has_pointer {
                    self.has_pointer = true;
                }
                self.raw_x = clamp(nx, -1.0, 1.0);
                // JS 版：POINTER_Y_DOWN = true → 渲染层取反
                self.raw_y = clamp(-ny, -1.0, 1.0);
                self.last_at_ms = now_ms;
            }
            _ => {
                if self.has_pointer {
                    self.has_pointer = false;
                    self.left_at_ms = now_ms;
                }
            }
        }
    }

    pub fn active(&self, now_ms: f64) -> bool {
        self.has_pointer || (self.left_at_ms > 0.0 && now_ms - self.left_at_ms < LEAVE_GRACE_MS)
    }

    /** 推进平滑（dt 由 now_ms 与内部 last_at 计算，钳到 1~100ms）。 */
    pub fn sample(&mut self, now_ms: f64) {
        let dt = if self.last_at_ms <= 0.0 {
            0.016   // 首帧按一帧算（JS 版构造时初始化 lastAt，等价效果）
        } else {
            clamp((now_ms - self.last_at_ms) / 1000.0, 0.001, 0.1)
        };
        self.last_at_ms = now_ms;
        let leave_elapsed = now_ms - self.left_at_ms;
        let (tx, ty, tau) = if self.has_pointer {
            (self.raw_x, self.raw_y, FOLLOW_TAU)
        } else if leave_elapsed < LEAVE_GRACE_MS {
            (self.raw_x, self.raw_y, FOLLOW_TAU)
        } else {
            (0.0, 0.0, RECENTER_TAU)
        };
        let k = 1.0 - (-dt / tau).exp();
        self.x += (tx - self.x) * k;
        self.y += (ty - self.y) * k;
    }

    pub fn offsets(&self) -> Offsets {
        Offsets {
            eye_x: clamp(self.x * EYE_LIMIT, -EYE_LIMIT, EYE_LIMIT),
            eye_y: clamp(self.y * EYE_LIMIT, -EYE_LIMIT, EYE_LIMIT),
            head_x: clamp(self.x * HEAD_RATIO * HEAD_RANGE, -HEAD_LIMIT, HEAD_LIMIT),
            head_y: clamp(self.y * HEAD_RATIO * HEAD_RANGE, -HEAD_LIMIT, HEAD_LIMIT),
        }
    }

    /** sample + offsets 一步到位（JS 版 apply 的纯计算部分）。 */
    pub fn tick(&mut self, now_ms: f64) -> Offsets {
        self.sample(now_ms);
        self.offsets()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eye_clamped_at_limit() {
        let mut g = GazeFollow::new();
        g.set_pointer(Some(5.0), Some(0.0), 0.0);   // 远超 ±1，应被钳
        let mut t = 0.0;
        let o = loop { t += 16.0; let o = g.tick(t); if t > 1000.0 { break o; } };
        assert!((o.eye_x - EYE_LIMIT).abs() < 1e-3, "瞳孔钳在 ±0.8（指数逼近留 1e-3 余量）: {}", o.eye_x);
        assert!((o.head_x - HEAD_LIMIT).abs() < 1e-9, "头部钳在 ±4°: {}", o.head_x);
    }

    #[test]
    fn head_is_30_percent_of_eye_range() {
        let mut g = GazeFollow::new();
        g.set_pointer(Some(1.0), Some(0.0), 0.0);
        // x 平滑到位后：eye=±0.8，head=1.0*0.3*30=9 → 钳到 4
        let mut t = 0.0;
        let o = loop {
            t += 16.0;
            let o = g.tick(t);
            if t > 2000.0 { break o; }
        };
        assert!((o.eye_x - 0.8).abs() < 0.02);
        assert!((o.head_x - 4.0).abs() < 0.02, "头部 30%×30°=9° 超上限，钳 4°: {}", o.head_x);
    }

    #[test]
    fn leave_grace_holds_then_recenters() {
        let mut g = GazeFollow::new();
        g.set_pointer(Some(1.0), Some(0.0), 0.0);
        let mut t = 0.0;
        loop { t += 16.0; g.tick(t); if t > 2000.0 { break; } }
        let before = g.offsets().eye_x;
        // 离开（None）：宽限期内保持
        g.set_pointer(None, None, t);
        let mut t_hold = t;
        loop { t_hold += 16.0; g.tick(t_hold); if t_hold - t > 1000.0 { break; } }   // 1s < 1.5s 宽限
        let o = g.offsets();
        assert!((o.eye_x - before).abs() < 0.05, "宽限期内不回中: {} vs {}", o.eye_x, before);
        // 1.5s 宽限过后：0.6s 时间常数逐帧回中，2s 内应基本归位
        let mut t2 = t;
        loop {
            t2 += 16.0;
            let o = g.tick(t2);
            if t2 - t > 1500.0 + 2000.0 || o.eye_x.abs() < 0.1 { break; }
        }
        let o = g.offsets();
        assert!(o.eye_x.abs() < 0.1, "宽限过后应回中: {}（t+{}ms）", o.eye_x, t2 - t);
    }

    #[test]
    fn y_axis_inverted_like_js() {
        let mut g = GazeFollow::new();
        g.set_pointer(Some(0.0), Some(1.0), 0.0);   // 屏幕下方
        let mut t = 0.0;
        let o = loop { t += 16.0; let o = g.tick(t); if t > 2000.0 { break o; } };
        assert!(o.eye_y < 0.0, "屏幕向下 → Live2D 向上为负: {}", o.eye_y);
    }

    #[test]
    fn smooth_time_constant_matches_tau() {
        // 一阶惯性：k = 1 - e^(-dt/tau)。dt=0.06（钳位 0.1 以下）→ k = 1-e^-0.5 = 0.3935
        let mut g = GazeFollow::new();
        g.set_pointer(Some(1.0), Some(0.0), 100.0);
        let o = g.tick(100.0 + 60.0);
        let expect = EYE_LIMIT * (1.0 - (-0.06 / FOLLOW_TAU).exp());
        assert!((o.eye_x - expect).abs() < 0.01, "dt=0.06 应走 {:.4}: {}", expect, o.eye_x);
        // dt 超过 0.1s 会被钳到 0.1：k = 1-e^(-0.1/0.12) = 0.5654
        let mut g2 = GazeFollow::new();
        g2.set_pointer(Some(1.0), Some(0.0), 100.0);
        let o2 = g2.tick(100.0 + 120.0);
        let expect2 = EYE_LIMIT * (1.0 - (-0.1 / FOLLOW_TAU).exp());
        assert!((o2.eye_x - expect2).abs() < 0.01, "dt 钳位 0.1s 应走 {:.4}: {}", expect2, o2.eye_x);
    }
}
