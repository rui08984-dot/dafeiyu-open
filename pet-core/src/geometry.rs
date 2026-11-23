//! 窗口几何模型（物理像素）。
//!
//! 移植自 AkaneCompanionLab：`desktop_pet_next/src-tauri/src/pet_windows/models.rs` 的 WindowGeometry。
//! 原实现用 tauri 的 LogicalSize/PhysicalSize；这里只保留纯数据 + 计算，
//! 这样宿主（Electron）和测试都能用同一套。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }

    pub fn right(&self) -> i32 {
        self.x.saturating_add(self.width as i32)
    }

    pub fn bottom(&self) -> i32 {
        self.y.saturating_add(self.height as i32)
    }

    /// 右上角作为锚点（缩放窗口时保持视觉位置不飘）
    pub fn anchored_bottom_right(self, new_width: u32, new_height: u32) -> Rect {
        let dx = self.width as i32 - new_width as i32;
        let dy = self.height as i32 - new_height as i32;
        Rect::new(
            self.x.saturating_add(dx),
            self.y.saturating_add(dy),
            new_width,
            new_height,
        )
    }
}