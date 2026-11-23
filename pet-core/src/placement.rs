//! 窗口布局：把面板/字幕放到皮套旁边，且不会跑出屏幕。
//!
//! 移植自 AkaneCompanionLab 的 `pet_windows/placement.rs`，逻辑保持一致：
//! 1. 先试右侧（皮套右边 + 间隙）
//! 2. 右侧放不下就翻到左侧
//! 3. 两边都放不下就贴在屏幕右边缘
//! 4. 竖直方向对齐皮套顶部，并 clamp 到工作区
use crate::geometry::Rect;

/// 面板与皮套之间的间隙
pub const GAP: i32 = 6;

/// 计算面板位置。`work_area` 是去掉任务栏后的可用区域。
pub fn panel_position(pet: &Rect, panel: (u32, u32), work_area: &Rect) -> (i32, i32) {
    let (pw, ph) = (panel.0 as i32, panel.1 as i32);
    // 面板最多能贴到的位置（不越出工作区右边/下边）
    let last_x = (work_area.right() - pw).max(work_area.x);
    let last_y = (work_area.bottom() - ph).max(work_area.y);

    let right = pet.right().saturating_add(GAP);
    let x = if right >= work_area.x && right <= last_x {
        right
    } else {
        let left = pet.x.saturating_sub(pw).saturating_sub(GAP);
        left.clamp(work_area.x, last_x)
    };

    let y = pet.y.clamp(work_area.y, last_y);
    (x, y)
}

/// 字幕窗：贴在皮套下方；下方放不下就放到上方。水平居中对齐皮套。
pub fn subtitle_position(pet: &Rect, sub: (u32, u32), work_area: &Rect) -> (i32, i32) {
    let (sw, sh) = (sub.0 as i32, sub.1 as i32);
    let last_x = (work_area.right() - sw).max(work_area.x);
    let last_y = (work_area.bottom() - sh).max(work_area.y);

    // 竖直：优先下方，放不下就上方
    let below = pet.bottom().saturating_add(GAP);
    let above = pet.y.saturating_sub(sh).saturating_sub(GAP);
    let fits_below = below <= last_y;
    let fits_above = above >= work_area.y;

    if fits_below || fits_above {
        // 水平：以皮套中线对齐
        let centered = pet.x + (pet.width as i32 - sw) / 2;
        let x = centered.clamp(work_area.x, last_x);
        let y = if fits_below { below } else { above };
        return (x, y);
    }

    // 侧位：上下都放不下（工作区纵向余量不足——如 1067 高工作区上皮套 762+字幕 180+间隙
    // 只有 119px 余量，皮套偏下时两头都挤），改贴皮套左右（优先右侧，放不下换左侧），
    // 垂直以皮套中线对齐并 clamp——不再硬贴底造成与皮套重叠。
    let side_y = (pet.y + (pet.height as i32 - sh) / 2).clamp(work_area.y, last_y);
    let right_x = pet.right().saturating_add(GAP);
    let left_x = pet.x.saturating_sub(sw).saturating_sub(GAP);
    if right_x + sw <= work_area.right() {
        return (right_x, side_y);
    }
    if left_x >= work_area.x {
        return (left_x, side_y);
    }
    // 屏幕太窄连侧面都放不下：维持旧行为贴底
    let centered = pet.x + (pet.width as i32 - sw) / 2;
    (centered.clamp(work_area.x, last_x), last_y)
}

/// 侧位专用位置：用**窄版**字幕尺寸（调用方给 side 尺寸），贴她左右。
/// 返回 None = 连窄版都放不下（调用方回退整宽贴底）。
/// 2026-11-08 用户反馈：646px 宽的大条幅贴在她旁边像另一块面板，窄版才像字幕条。
pub fn subtitle_side_position(pet: &Rect, side_sub: (u32, u32), work_area: &Rect) -> Option<(i32, i32)> {
    let (sw, sh) = (side_sub.0 as i32, side_sub.1 as i32);
    let last_y = (work_area.bottom() - sh).max(work_area.y);
    let side_y = (pet.y + (pet.height as i32 - sh) / 2).clamp(work_area.y, last_y);
    let right_x = pet.right().saturating_add(GAP);
    let left_x = pet.x.saturating_sub(sw).saturating_sub(GAP);
    if right_x + sw <= work_area.right() {
        return Some((right_x, side_y));
    }
    if left_x >= work_area.x {
        return Some((left_x, side_y));
    }
    None
}

/// 皮套首次出现的位置：工作区右下角留出边距
pub fn default_pet_position(pet: (u32, u32), work_area: &Rect, margin: i32) -> (i32, i32) {
    let x = (work_area.right() - pet.0 as i32 - margin).max(work_area.x);
    let y = (work_area.bottom() - pet.1 as i32 - margin).max(work_area.y);
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Rect { Rect::new(0, 0, 2560, 1400) }

    #[test]
    fn panel_goes_right_when_there_is_room() {
        let pet = Rect::new(1000, 300, 420, 760);
        let (x, y) = panel_position(&pet, (520, 700), &area());
        assert_eq!(x, 1000 + 420 + GAP);
        assert_eq!(y, 300);
    }

    #[test]
    fn panel_flips_left_when_right_side_is_out() {
        // 皮套贴着右边缘：右边放不下 520 宽的面板
        let pet = Rect::new(2100, 300, 420, 760);
        let (x, _) = panel_position(&pet, (520, 700), &area());
        assert_eq!(x, 2100 - 520 - GAP);
    }

    #[test]
    fn panel_clamped_when_both_sides_overflow() {
        let pet = Rect::new(-300, 300, 420, 760);
        let (x, _) = panel_position(&pet, (520, 700), &area());
        assert!(x >= 0, "面板不能跑到屏幕左边外面: {x}");
    }

    #[test]
    fn panel_vertical_clamped_to_work_area() {
        let pet = Rect::new(1000, 1300, 420, 760);   // 底部超出
        let (_, y) = panel_position(&pet, (520, 700), &area());
        assert_eq!(y, 1400 - 700);
    }

    #[test]
    fn subtitle_prefers_below() {
        let pet = Rect::new(1000, 200, 420, 760);
        let (x, y) = subtitle_position(&pet, (600, 120), &area());
        assert_eq!(y, 200 + 760 + GAP);
        assert_eq!(x, 1000 + (420 - 600) / 2);
    }

    #[test]
    fn subtitle_flips_above_when_bottom_is_out() {
        let pet = Rect::new(1000, 600, 420, 760);   // 底部 1360，下面放不下了
        let (_, y) = subtitle_position(&pet, (600, 120), &area());
        assert_eq!(y, 600 - 120 - GAP);
    }

    #[test]
    fn subtitle_goes_right_side_when_both_fails() {
        // 工作区纵向只有 948px：皮套 762，上下都放不下 → 侧位（右侧），垂直居中对皮套
        let work = Rect::new(0, 0, 2560, 948);
        let pet = Rect::new(1000, 150, 420, 762);   // 下 912+6=918 > 942 放不下；上 150-186=-36 放不下
        let (x, y) = subtitle_position(&pet, (600, 180), &work);
        assert_eq!(x, 1000 + 420 + GAP, "应贴皮套右侧");
        assert_eq!(y, 150 + (762 - 180) / 2, "垂直以皮套中线对齐");
    }

    #[test]
    fn subtitle_side_falls_back_to_left() {
        // 右侧也放不下（皮套贴右缘）→ 换左侧
        let work = Rect::new(0, 0, 2560, 948);
        let pet = Rect::new(2100, 150, 420, 762);   // 右缘 2520，右侧 2526+600=3126 > 2560 放不下
        let (x, _) = subtitle_position(&pet, (600, 180), &work);
        assert_eq!(x, 2100 - 600 - GAP, "应换贴皮套左侧");
    }

    #[test]
    fn subtitle_clamps_side_y_into_work() {
        // 皮套贴屏底时侧位的垂直居中会被 clamp 回工作区
        let work = Rect::new(0, 0, 2560, 948);
        let pet = Rect::new(1000, 180, 420, 762);   // 居中 180+291=471 本没越界，验证 clamp 分支本身
        let (_, y) = subtitle_position(&pet, (600, 180), &work);
        assert!((0..=948 - 180).contains(&y), "侧位 y 必须在工作区内: {}", y);
    }
}