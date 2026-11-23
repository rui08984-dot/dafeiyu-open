//! 大肥鱼内核（Rust）
//!
//! 这里放的是**从成熟实现移植过来的纯逻辑**，不是新发明：
//! - `geometry` / `placement`：窗口布局，移植自 AkaneCompanionLab
//!   （desktop_pet_next/src-tauri/src/pet_windows/{geometry,placement}.rs）
//! - `mood`：心情衰减数学（36h/18h 半衰 + tanh 软饱和），移植自自家 driver.js
//!   moodStore 的纯计算部分（参数是 2026-10-31 拍板保护项，上锁于此）
//! - `knowledge`：知识库混合检索（BM25 + 向量余弦 + RRF 融合，2026-11-09 新增）
//!
//! 之所以用 Rust 重写：这些是每帧/每次召回都会跑的纯计算，
//! 放在 JS/Python 里既慢又各处重复一份；集中成一个可测试的内核更稳。

pub mod geometry;
pub mod knowledge;
#[cfg(target_os = "windows")]
pub mod native;
#[cfg(target_os = "windows")]
pub mod uia;
#[cfg(target_os = "windows")]
pub mod wgc;
pub mod pad;
pub mod gaze;
pub mod mood;
pub mod placement;
