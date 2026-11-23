//! Windows 原生能力（2026-11-09 三十五轮）
//!
//! 为什么要有这个模块：把三条**热路径**从 Python/PowerShell 搬到 Rust。
//!
//! | 能力 | 原来 | 为什么搬 |
//! |---|---|---|
//! | 画面 dHash | `screen-hash.py`：Python 启动 + Pillow 导入 + 截屏 + resize，实测 **300-350ms** | 它是每个验证动作的成本，慢得让人不敢用 |
//! | 窗口枚举 | PowerShell `Get-Process \| Where MainWindowTitle`，实测 **8 秒超时** | 8 秒等于不可用 |
//! | 键鼠输入 | PowerShell 常驻（`SilentlyContinue` 会掩盖残骸） | 常驻进程本身脆弱 |
//!
//! 设计取舍：
//! - **不引图像库**。dHash 只需要 9×8 灰度，用「按块平均」直接降采样，
//!   不需要解码 PNG/JPEG，也不需要 resize 的插值算法。
//! - **不做跨平台抽象**。这是 Windows 桌宠，抽象是浪费。
//! - **所有 unsafe 集中在本文件**，且每处都注明「为什么这里可以 unsafe」。

#![cfg(target_os = "windows")]

use serde::Serialize;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM, POINT};
use windows::core::BOOL;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateCompatibleBitmap, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, SRCCOPY, CAPTUREBLT, HGDIOBJ,
    StretchBlt, SetStretchBltMode, SetBrushOrgEx,
    HALFTONE, STRETCH_BLT_MODE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextW, IsWindowVisible, IsWindow, IsIconic, IsZoomed, GetWindowRect,
    GetForegroundWindow, SetForegroundWindow, ShowWindow, BringWindowToTop, SW_RESTORE,
    GetWindowThreadProcessId, GetClassNameW, GetWindow, GW_OWNER, EnumChildWindows, SendMessageW,
    GetCursorPos, SetCursorPos, GetWindowLongW, GWL_EXSTYLE,
    // 后台鼠标点击（2026-11-14）：PostMessage + 客户区换算
    PostMessageW, GetClientRect,
    WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
    WM_KEYDOWN, WM_KEYUP, WM_CHAR,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, VkKeyScanW, MapVirtualKeyW, MAPVK_VK_TO_VSC_EX, MAPVK_VSC_TO_VK_EX,
    INPUT_MOUSE, MOUSEINPUT, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
    MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
    GetLastInputInfo, LASTINPUTINFO, MOUSE_EVENT_FLAGS,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::System::Threading::{GetCurrentThreadId, AttachThreadInput};
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
};
use windows::Win32::System::StationsAndDesktops::{
    OpenInputDesktop, CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS,
};

// ── DPI 感知 ────────────────────────────────────────────────────────────
//
// ⚠ 这是本轮之前踩过的真坑：不设 DPI 感知时，GetWindowRect 返回**逻辑像素**，
//    而 UIA / 截图返回**物理像素**，两套坐标系混用会让"看起来在窗口内"的坐标实际点偏。
//    实测：SoM 标注 10 个元素只画出 3 个，就是 DPI 混用导致。
//    PER_MONITOR_AWARE_V2 是 Win10 1703+ 的推荐值（支持运行时 DPI 变化）。
pub fn enable_dpi_awareness() -> bool {
    // SAFETY: 这个调用只是设置本进程的 DPI 感知模式，无内存安全风险。
    // 已经设过会返回 Err（重复设置是允许的失败），不影响功能。
    // 返回 Result<()>：Err 表示「已经设过」或「系统不支持」，两种情况都不致命。
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_ok() }
}

// ── 画面 dHash ──────────────────────────────────────────────────────────

/// dHash 的目标尺寸：9 列 × 8 行 → 每行 8 个比较 → 64 bit
const DW: usize = 9;
const DH: usize = 8;

#[derive(Debug, Clone, Serialize)]
pub struct ScreenHashResult {
    /// 16 位 hex（64 bit）
    pub hash: String,
    pub width: i32,
    pub height: i32,
    /// 采集 + 计算耗时（微秒）
    pub us: u64,
}

/// 抓全屏并算 dHash（64 bit 感知哈希）。
///
/// 算法：缩到 9×8 灰度 → 每行相邻像素比较 → 64 bit。
/// **降采样用「按块平均」**，不是插值 resize —— 对感知哈希足够，
/// 而且比 Pillow 的 bicubic 快一个数量级。
pub fn screen_dhash() -> Result<ScreenHashResult, String> {
    let t0 = std::time::Instant::now();

    // ⚠ 性能设计（2026-11-09 实测）：
    //   第一版做法 = BitBlt 全屏到内存位图 → GetDIBits 读 14.7MB → Rust 遍历 3.7M 像素算块平均。
    //   实测 54-66ms（2560×1440），比 Python 的 300-350ms 快 5-6 倍，但**大头是遍历**。
    //
    //   现在改成：让 GDI 自己做缩放 —— **StretchBlt 直接缩到 9×8**，
    //   然后只读 72 个像素。全屏遍历完全跳过。
    //
    //   为什么这样不会损失 dHash 质量：dHash 本来就是「9×8 的块平均」，
    //   GDI 的 HALFTONE 缩放做的就是区域平均（和我们手写的一样），
    //   而且它走的是优化的图形路径（可能用 SIMD/硬件）。
    //
    //   精度/稳定性验证见测试 dhash_* 三个用例 + 真机对比。
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return Err("拿不到屏幕尺寸".into());
        }

        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC 失败".into());
        }
        // 目标位图只要 9×8，不是全屏 —— 这就是省掉 14.7MB 读取的关键
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC 失败".into());
        }
        let bmp = CreateCompatibleBitmap(screen_dc, DW as i32, DH as i32);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleBitmap 失败".into());
        }
        let old = SelectObject(mem_dc, HGDIOBJ(bmp.0 as *mut core::ffi::c_void));

        // HALFTONE：让 GDI 做「区域平均」而不是「最近邻抽样」
        // （最近邻会让 hash 对细微变化不敏感，区域平均更接近感知）
        let old_mode = SetStretchBltMode(mem_dc, HALFTONE);
        let _ = SetBrushOrgEx(mem_dc, 0, 0, None);

        let ok = StretchBlt(
            mem_dc, 0, 0, DW as i32, DH as i32,
            Some(screen_dc), 0, 0, w, h,
            SRCCOPY | CAPTUREBLT,
        );

        let _ = SetStretchBltMode(mem_dc, STRETCH_BLT_MODE(old_mode as i32));

        if !ok.as_bool() {
            SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("StretchBlt 失败".into());
        }

        // ⚠ 关键：MSDN 明确要求「调用 GetDIBits 时 bitmap 不能还被选在 DC 里」。
        //   我第一版把 SelectObject 恢复放在 GetDIBits 之后 → 读到的是未定义内容，
        //   表现就是「同一个静止画面每次 hash 都不一样」（实测踩到，hash 每次都变）。
        //   必须先选出来。
        SelectObject(mem_dc, old);

        // 读 9×8 的 32 位 BGRA（负高度 = top-down）
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = DW as i32;
        bi.bmiHeader.biHeight = -(DH as i32);
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;

        let stride = DW * 4;
        let mut buf = vec![0u8; stride * DH];
        let lines = GetDIBits(
            mem_dc, bmp, 0, DH as u32,
            Some(buf.as_mut_ptr() as *mut _),
            &mut bi, DIB_RGB_COLORS,
        );

        let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);

        if lines == 0 {
            return Err("GetDIBits 失败".into());
        }

        let hash = dhash_from_bgra(&buf, DW, DH, stride);
        Ok(ScreenHashResult {
            hash,
            width: w,
            height: h,
            us: t0.elapsed().as_micros() as u64,
        })
    }
}

/// 从 BGRA 像素算 dHash（9×8 → 64 bit）。
///
/// 降采样：把画面切成 9 列 × 8 行的大块，每块取**平均亮度**。
/// 这比「抽取 9×8 个采样点」更抗噪（不会因为某个像素恰好是亮的就翻位）。
pub fn dhash_from_bgra(buf: &[u8], w: usize, h: usize, stride: usize) -> String {
    const CW: usize = DW;
    const CH: usize = DH;

    // 每块的累加器：sum[r][c] 和 count[r][c]
    let mut sum = [[0u64; CW]; CH];
    let mut cnt = [[0u64; CW]; CH];

    // 按行遍历，避免 cache miss（图像是行优先存的）
    for y in 0..h {
        // 当前行属于哪一块（用整数比例，避免浮点）
        let ry = y * CH / h;
        let row_base = y * stride;
        for x in 0..w {
            let rx = x * CW / w;
            let p = row_base + x * 4;
            // BGRA → 亮度（ITU-R BT.601 整数近似：0.114B + 0.587G + 0.299R）
            let b = buf[p] as u64;
            let g = buf[p + 1] as u64;
            let r = buf[p + 2] as u64;
            let lum = (b * 29 + g * 150 + r * 77) >> 8;   // ≈ 0.113B + 0.586G + 0.301R
            sum[ry][rx] += lum;
            cnt[ry][rx] += 1;
        }
    }

    // 算每块平均，然后相邻比较
    let mut avg = [[0u32; CW]; CH];
    for r in 0..CH {
        for c in 0..CW {
            avg[r][c] = if cnt[r][c] > 0 { (sum[r][c] / cnt[r][c]) as u32 } else { 0 };
        }
    }

    // 64 bit：每行 8 个比较（9 个块相邻比 → 8 位），共 8 行
    //
    // ⚠ 2026-11-09 实测记录（避免后来者重走）：
    //   标准 dHash（`a > b` 就置位）在静止画面连测 10 次，hamming 抖动中位 4 / max 9。
    //   我试过「差值容差」（|a-b| ≤ tol 不置位）想降噪 —— **结果更糟**（中位 19 / max 29），
    //   因为差值跨越容差边界时（+4 → +5）整簇位会同时翻。
    //   所以保持标准 dHash。噪声交给下游处理：
    //   actAndVerify 的阈值是 hamming > 5，实测抖动中位 4 在阈值内；
    //   真实动作（弹窗/菜单/种植）会产生 20-40 位差异，信号远大于噪声。
    //   如果以后发现误判，正确做法是**多次采样取中位**，不是调 dHash 本身。
    let mut bits: u64 = 0;
    let mut idx = 0;
    for r in 0..CH {
        for c in 0..(CW - 1) {
            if avg[r][c] > avg[r][c + 1] {
                bits |= 1u64 << idx;
            }
            idx += 1;
        }
    }
    format!("{:016x}", bits)
}

/// 从 BGRA 行缓冲算 9×8 灰度矩阵（块平均）。
///
/// 和 `dhash_from_bgra` 用的是**同一份块平均逻辑** —— 抽出来是为了诊断时
/// 能直接看到「每个块有多亮」，而不是只有一个 hash 值。
pub fn gray_matrix_from_rows(buf: &[u8], w: usize, h: usize, stride: usize) -> Vec<u8> {
    const CW: usize = 9;
    const CH: usize = 8;
    let mut sum = [[0u64; CW]; CH];
    let mut cnt = [[0u64; CW]; CH];
    for y in 0..h.min(usize::MAX) {
        let ry = y * CH / h.max(1);
        let row_base = y * stride;
        for x in 0..w {
            let rx = x * CW / w.max(1);
            let p = row_base + x * 4;
            if p + 2 >= buf.len() { continue; }
            let b = buf[p] as u64;
            let g = buf[p + 1] as u64;
            let r = buf[p + 2] as u64;
            let lum = (b * 29 + g * 150 + r * 77) >> 8;
            sum[ry][rx] += lum;
            cnt[ry][rx] += 1;
        }
    }
    let mut out = Vec::with_capacity(CW * CH);
    for r in 0..CH {
        for c in 0..CW {
            out.push(if cnt[r][c] > 0 { (sum[r][c] / cnt[r][c]) as u8 } else { 0 });
        }
    }
    out
}

/// `dhash_from_bgra` 的语义别名：从任意来源的行缓冲（BGRA，带 stride）算 dHash。
///
/// 为什么单独一个名字：`dhash_from_bgra` 说的是「像素格式」，而这个说的是「数据形状」。
/// WGC 从 staging texture 读出来的是 RowPitch 可能大于 width*4 的行缓冲，
/// 用这个名字更清楚意图。
pub fn dhash_from_rows(buf: &[u8], w: usize, h: usize, stride: usize) -> String {
    dhash_from_bgra(buf, w, h, stride)
}

// ── 窗口枚举 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WinRec {
    pub hwnd: i64,
    pub title: String,
    pub class: String,
    pub pid: u32,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub iconic: bool,
    /// 最大化态（IsZoomed）。和 iconic 分开报：最大化窗口的 rect 是负原点（-11,-11），
    /// 调用方需要知道「这是合法最大化，不是越界」。
    pub maximized: bool,
    /// 有 owner 的通常是对话框/工具窗（GetWindow(GW_OWNER) 非空）
    pub owned: bool,
}

struct EnumCtx {
    out: Vec<WinRec>,
    filter: String,     // 小写标题子串，空 = 全部
    max: usize,
    include_overlays: bool,
}

/// 枚举可见顶层窗口（可选标题过滤）。
///
/// 相比 PowerShell `Get-Process | Where MainWindowTitle`：
/// · 后者按**进程**枚举，多窗口应用只看到主窗口；这个按**窗口**枚举，能拿到全部
/// · 后者实测 8 秒超时（进程枚举 + MainWindowTitle 逐进程取属性都很慢）
pub fn list_windows(filter: &str, max: usize) -> Vec<WinRec> {
    list_windows_ex(filter, max, false)
}

/// `include_overlays = true` 时把「点击穿透+工具窗+不激活」的指示层也列出来（诊断用）。
/// 默认过滤：她自己的虚拟光标 overlay / ZCode 的 GhostCursor 不是可操作目标。
pub fn list_windows_ex(filter: &str, max: usize, include_overlays: bool) -> Vec<WinRec> {
    let mut ctx = EnumCtx {
        out: Vec::new(),
        filter: filter.to_lowercase(),
        max: max.max(1),
        include_overlays,
    };
    // SAFETY: EnumWindows 的回调签名是 extern "system" fn(HWND, LPARAM) -> BOOL，
    // 我们把 &mut EnumCtx 转成 LPARAM 指针传进去。回调期间 lparam 生命周期由调用栈保证
    // （EnumWindows 是同步阻塞的，返回前不会让 ctx 失效）。
    unsafe {
        let _ = EnumWindows(Some(enum_win_cb), LPARAM(&mut ctx as *mut EnumCtx as isize));
    }
    ctx.out
}

unsafe extern "system" fn enum_win_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 是 list_windows 里传进来的 &mut EnumCtx，同步调用期间有效。
    let ctx = &mut *(lparam.0 as *mut EnumCtx);

    if ctx.out.len() >= ctx.max {
        return BOOL(0);      // 够了，停
    }
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);      // 不可见，跳过但继续
    }
    // 跳过「非交互指示层」（2026-11-14 五十三轮）：她自己的虚拟光标 overlay 和 ZCode 的
    // GhostCursor 都是「点击穿透 + 工具窗 + 不激活」三件套 —— 它们不是可操作目标，
    // 出现在窗口清单里只会让模型选错（实测 see windows 把 overlay 列成了「combined-project」）。
    // 用三件套而不是只看 TRANSPARENT：正常窗口偶尔也会置 TRANSPARENT，但不会同时是工具窗+不激活。
    // SAFETY: GetWindowLongW 只读窗口样式位。

    // 「指示层」判定放在标题检查**之前**（2026-11-14）：overlay 的标题可能是空的，
    // 先按空标题跳过就永远看不到它，include_overlays 也白给。
    // SAFETY: GetWindowLongW 只读窗口样式位。
    let is_overlay = unsafe {
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        const EX_TRANSPARENT: u32 = 0x0000_0020;
        const EX_TOOLWINDOW: u32 = 0x0000_0080;
        const EX_NOACTIVATE: u32 = 0x0800_0000;
        (ex & EX_TRANSPARENT) != 0 && (ex & EX_TOOLWINDOW) != 0 && (ex & EX_NOACTIVATE) != 0
    };
    if is_overlay && !ctx.include_overlays {
        return BOOL(1);
    }

    let mut title_buf = [0u16; 512];
    let n = GetWindowTextW(hwnd, &mut title_buf);
    if n <= 0 && !(ctx.include_overlays && is_overlay) {
        return BOOL(1);      // 没标题（工具窗/隐藏窗），跳过
    }
    let title = String::from_utf16_lossy(&title_buf[..n.max(0) as usize]);
    if !ctx.filter.is_empty() && !title.to_lowercase().contains(&ctx.filter) {
        return BOOL(1);
    }

    let mut class_buf = [0u16; 256];
    let cn = GetClassNameW(hwnd, &mut class_buf);
    let class = String::from_utf16_lossy(&class_buf[..cn.max(0) as usize]);

    let mut rect = RECT::default();
    let _ = GetWindowRect(hwnd, &mut rect);

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));

    ctx.out.push(WinRec {
        hwnd: hwnd.0 as i64,
        title,
        class,
        pid,
        x: rect.left,
        y: rect.top,
        w: rect.right - rect.left,
        h: rect.bottom - rect.top,
        iconic: IsIconic(hwnd).as_bool(),
        maximized: IsZoomed(hwnd).as_bool(),
        owned: GetWindow(hwnd, GW_OWNER).map(|h| !h.is_invalid()).unwrap_or(false),
    });
    BOOL(1)
}

// ── 聚焦 ────────────────────────────────────────────────────────────────

// SwitchToThisWindow：**未文档化但依然可用**的强制切窗口 API。
//
// 为什么需要它（2026-11-09 实测）：
//   VALORANT（全屏 + WS_EX_TOPMOST）会持续抢前台。对它调用
//   `AttachThreadInput` + `SetForegroundWindow` 全部无效 ——
//   复核时 `GetForegroundWindow` 还是 VALORANT（focus 返回 ok=false）。
//   这不是代码 bug，是 Windows 前台锁定 + 游戏抢焦点的双重限制。
//
//   `SwitchToThisWindow` 走的是另一条内核路径（Shell 的 Alt+Tab 逻辑），
//   能绕过 SetForegroundWindow 的前台锁。代价：它是未文档化 API，
//   微软可能在任何版本移除。所以**只作为 force 模式的兜底**，默认不开。
#[link(name = "user32")]
extern "system" {
    fn SwitchToThisWindow(hwnd: HWND, f_unknown: BOOL);
}

#[derive(Debug, Clone, Serialize)]
pub struct FocusResult {
    pub ok: bool,
    pub hwnd: i64,
    pub title: String,
    pub was_iconic: bool,
    pub fg_title: String,
    pub fg_hwnd: i64,
    /// 用了 SwitchToThisWindow 强制切换（未文档化 API 兜底）
    pub forced: bool,
    pub error: Option<String>,
}

/// 聚焦一个窗口并**复核**（ok 只有 GetForegroundWindow 真的等于目标才 true）。
///
/// 三段式，缺一不可（都是 Windows 前台权限的硬约束）：
/// 1. `ShowWindow(SW_RESTORE)` —— 最小化的必须先恢复，否则后面静默失败
/// 2. `AttachThreadInput` —— Windows 只允许「前台窗口的线程」把前台转给别人，
///    我们的线程不在前台，得把自己的输入线程 attach 到目标窗口线程借权限
/// 3. `SetForegroundWindow` + `BringWindowToTop`
pub fn focus_window(target: &str) -> FocusResult {
    focus_window_ex(target, false)
}

/// 带 force 选项的版本：force=true 时常规路径失败后用 SwitchToThisWindow 兜底。
pub fn focus_window_ex(target: &str, force: bool) -> FocusResult {
    let mut _unused = ();
    let mut res = FocusResult {
        ok: false, hwnd: 0, title: String::new(), was_iconic: false,
        fg_title: String::new(), fg_hwnd: 0, forced: false, error: None,
    };

    // 目标可以是 hwnd（纯数字）、pid（纯数字）或标题子串
    //
    // ⚠ 2026-11-10 审计抓到：纯数字原来**只按 hwnd 解析** —— 但我们的工具描述写着
    //   「focus_window=…或 list_windows 看到的 pid 数字」，而 ClickElement 用的也是 pid。
    //   按说明书传 pid → `HWND(pid)` 是无效句柄 → GetWindowTextW 空 → 聚焦必失败。
    //   现在：数字先按 hwnd 验（IsWindow + 能取标题），不成立再按 pid 找该进程的可见窗口。
    let (hwnd, title, was_iconic) = if let Ok(h) = target.trim().parse::<i64>() {
        let cand = HWND(h as *mut _);
        let mut buf = [0u16; 512];
        // SAFETY: 对无效句柄只是返回 0，不崩。
        let n = unsafe { GetWindowTextW(cand, &mut buf) };
        let t = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        let is_valid_hwnd = unsafe { IsWindow(Some(cand)).as_bool() } && !t.is_empty();
        if is_valid_hwnd {
            let ic = unsafe { IsIconic(cand).as_bool() };
            (cand, t, ic)
        } else {
            // 当 pid 用：找该进程的可见窗口（非最小化优先）
            let wins = list_windows("", 400);
            let pid = h as u32;
            let pick = wins.iter()
                .filter(|w| w.pid == pid && !w.title.is_empty())
                .find(|w| !w.iconic)
                .or_else(|| wins.iter().find(|w| w.pid == pid && !w.title.is_empty()));
            match pick {
                Some(w) => (HWND(w.hwnd as *mut _), w.title.clone(), w.iconic),
                None => {
                    res.error = Some(format!(
                        "没找到窗口：{target}（既不是有效 hwnd，也没有 pid={pid} 的可见窗口）"
                    ));
                    return res;
                }
            }
        }
    } else {
        let wins = list_windows(target, 8);
        // 优先挑非最小化的（同名窗口可能有一个最小化一个正常）
        let pick = wins.iter().find(|w| !w.iconic).or_else(|| wins.first());
        match pick {
            Some(w) => (HWND(w.hwnd as *mut _), w.title.clone(), w.iconic),
            None => {
                res.error = Some(format!("没找到窗口：{target}"));
                return res;
            }
        }
    };

    res.hwnd = hwnd.0 as i64;
    res.title = title;
    res.was_iconic = was_iconic;

    // SAFETY: 全部是窗口管理 API，对无效 hwnd 返回错误码而非崩溃。
    // AttachThreadInput 必须与 detach 成对（见 finally 式的显式 detach）。
    unsafe {
        if was_iconic {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            std::thread::sleep(std::time::Duration::from_millis(80));
        }

        let fg = GetForegroundWindow();
        let mut fg_pid = 0u32;
        let mut tgt_pid = 0u32;
        let fg_thread = GetWindowThreadProcessId(fg, Some(&mut fg_pid));
        let tgt_thread = GetWindowThreadProcessId(hwnd, Some(&mut tgt_pid));
        let self_thread = GetCurrentThreadId();

        let mut attached1 = false;
        let mut attached2 = false;
        if fg_thread != 0 && fg_thread != self_thread {
            attached1 = AttachThreadInput(self_thread, fg_thread, true).as_bool();
        }
        if tgt_thread != 0 && tgt_thread != self_thread && tgt_thread != fg_thread {
            attached2 = AttachThreadInput(self_thread, tgt_thread, true).as_bool();
        }

        let _ = BringWindowToTop(hwnd);   // Result 忽略：失败也不影响后续 SetForegroundWindow
        let _ = SetForegroundWindow(hwnd);
        let _ = BringWindowToTop(hwnd);   // Result 忽略：失败也不影响后续 SetForegroundWindow

        if attached1 {
            let _ = AttachThreadInput(self_thread, fg_thread, false);
        }
        if attached2 {
            let _ = AttachThreadInput(self_thread, tgt_thread, false);
        }

        std::thread::sleep(std::time::Duration::from_millis(120));

        // 复核：只看「焦点真的到没到」，不信返回值
        let now = GetForegroundWindow();
        res.fg_hwnd = now.0 as i64;
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(now, &mut buf);
        res.fg_title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        res.ok = now == hwnd;

        // 常规路径失败 + 调用方要求 force → 用 SwitchToThisWindow 再试一次
        // （代价：未文档化 API，但对全屏置顶游戏是唯一有效的办法）
        if !res.ok && force {
            SwitchToThisWindow(hwnd, BOOL(1));
            std::thread::sleep(std::time::Duration::from_millis(200));
            let now2 = GetForegroundWindow();
            res.fg_hwnd = now2.0 as i64;
            let mut buf2 = [0u16; 512];
            let n2 = GetWindowTextW(now2, &mut buf2);
            res.fg_title = String::from_utf16_lossy(&buf2[..n2.max(0) as usize]);
            res.ok = now2 == hwnd;
            res.forced = true;
        }
    }
    res
}

/// 读当前前台窗口（给「动作前断言焦点」用）。
/// 前台窗口所属进程 pid（2026-11-10 回归审计：fg 原来不返回 pid，
/// 而工具描述/list_windows 给的是 pid → 按 pid 断言前台必失败）。
pub fn foreground_pid() -> u32 {
    // SAFETY: GetForegroundWindow 无前台时返回 null，下面判了。
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() { return 0; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        pid
    }
}

pub fn foreground() -> (bool, i64, String) {
    // SAFETY: GetForegroundWindow 可能返回 null（无前台窗口），下面都判了空。
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() {
            return (false, 0, String::new());
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(h, &mut buf);
        (true, h.0 as i64, String::from_utf16_lossy(&buf[..n.max(0) as usize]))
    }
}

// ── 读控件文本 ──────────────────────────────────────────────────────────
//
// 用途：验证「输入真的进去了」。
//   记事本 / 输入框这类标准 Win32 控件可以通过 WM_GETTEXT 直接读内容，
//   这是**比截图更硬的证据** —— 截图只能说「画面变了」，读文本能说「内容是这个」。
//
// 为什么不走 UIA：UIA 的 Name 属性对 Notepad 的 Edit 控件常常是空字符串
// （实测过），而 ValuePattern 又要额外的 COM 调用。WM_GETTEXT 是最直接的。

#[derive(Debug, Clone, Serialize)]
pub struct EditTextResult {
    pub ok: bool,
    pub text: String,
    pub hwnd: i64,
    pub class: String,
    pub error: Option<String>,
}

struct FindEditCtx {
    found: Option<(HWND, String)>,
}

/// 在一个顶层窗口下找第一个可编辑子控件（Edit / RichEdit），并读它的文本。
///
/// `target` 是窗口标题子串或 hwnd 数字。
pub fn read_edit_text(target: &str) -> EditTextResult {
    let mut res = EditTextResult { ok: false, text: String::new(), hwnd: 0, class: String::new(), error: None };

    // 先找顶层窗口（复用 list_windows / hwnd 解析逻辑）
    let top = if let Ok(h) = target.trim().parse::<i64>() {
        Some(HWND(h as *mut _))
    } else {
        list_windows(target, 8).first().map(|w| HWND(w.hwnd as *mut _))
    };
    let Some(top_hwnd) = top else {
        res.error = Some(format!("没找到窗口：{target}"));
        return res;
    };
    res.hwnd = top_hwnd.0 as i64;

    // 在子窗口里找 Edit / RichEdit
    let mut ctx = FindEditCtx { found: None };
    // SAFETY: EnumChildWindows 同步执行，&mut ctx 在其返回前有效。
    unsafe {
        let _ = EnumChildWindows(Some(top_hwnd), Some(find_edit_cb), LPARAM(&mut ctx as *mut FindEditCtx as isize));
    }

    let Some((edit_hwnd, class)) = ctx.found else {
        res.error = Some("这个窗口里没有可编辑控件（不是记事本/输入框类窗口）".into());
        return res;
    };
    res.class = class;

    // 读文本：先问长度，再分配精确大小
    const WM_GETTEXTLENGTH: u32 = 0x000E;
    const WM_GETTEXT: u32 = 0x000D;
    // SAFETY: 标准 Win32 消息，对无效句柄返回 0。
    unsafe {
        let len = SendMessageW(edit_hwnd, WM_GETTEXTLENGTH, None, None).0 as usize;
        if len == 0 {
            res.ok = true;   // 空文档也算成功（读到空字符串）
            return res;
        }
        if len > 1_000_000 {
            res.error = Some(format!("文本太长（{len} 字符），不读"));
            return res;
        }
        let mut buf = vec![0u16; len + 1];
        let got = SendMessageW(
            edit_hwnd,
            WM_GETTEXT,
            Some(WPARAM(len + 1)),
            Some(LPARAM(buf.as_mut_ptr() as isize)),
        ).0 as usize;
        let text = String::from_utf16_lossy(&buf[..got.min(len)]);
        res.text = text;
        res.ok = true;
    }
    res
}

unsafe extern "system" fn find_edit_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: lparam 是 read_edit_text 里传的 &mut FindEditCtx，同步调用期间有效。
    let ctx = &mut *(lparam.0 as *mut FindEditCtx);
    if ctx.found.is_some() {
        return BOOL(0);
    }
    let mut buf = [0u16; 256];
    let n = GetClassNameW(hwnd, &mut buf);
    let cls = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
    // 类名匹配要宽一点（2026-11-09 实测踩到）：
    //   · 经典 Notepad / 对话框输入框：`Edit`
    //   · WordPad / 富文本：`RichEdit20W` / `RichEdit50W` / `RichEditD2DPT`
    //   · **WinForms TextBox：`WindowsForms10.EDIT.app.0.xxx`** ← 这个不匹配纯 "Edit"，
    //     我第一版只判 eq_ignore_ascii_case("Edit") 就漏了它（读回 len=0、class 为空）
    //   · WPF TextBox：`Edit` 或 `TextBox`（WPF 自己绘制，WM_GETTEXT 往往也读不到）
    let low = cls.to_lowercase();
    if low == "edit"
        || low.contains(".edit")
        || low.starts_with("richedit")
        || low == "textbox"
    {
        ctx.found = Some((hwnd, cls));
        return BOOL(0);
    }
    BOOL(1)
}

// ── 键鼠输入 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct InputResult {
    pub ok: bool,
    pub sent: u32,
    pub error: Option<String>,
}

/// 把一个键名解析成 (扫描码, 是否需要扩展位)。
/// 返回 None 表示不认识这个键。
///
/// 为什么要扫描码而不是虚拟键：**游戏只认扫描码**。
/// Raw Input / DirectInput 走的是硬件扫描码路径，`KEYEVENTF_SCANCODE`
/// 才会被它们看到；只发 VK 的 `keybd_event` 大部分游戏直接忽略。
fn key_to_scancode(key: &str) -> Option<(u16, bool)> {
    let k = key.trim().to_lowercase();
    // 特殊键先查表（这些键的 VK 到扫描码映射不能靠 VkKeyScanW）
    let special: Option<(u16, bool)> = match k.as_str() {
        "enter" | "return" => Some((0x1C, false)),
        "esc" | "escape" => Some((0x01, false)),
        "tab" => Some((0x0F, false)),
        "space" => Some((0x39, false)),
        "backspace" | "bs" => Some((0x0E, false)),
        "delete" | "del" => Some((0x53, true)),        // 扩展键
        "up" => Some((0x48, true)),
        "down" => Some((0x50, true)),
        "left" => Some((0x4B, true)),
        "right" => Some((0x4D, true)),
        "home" => Some((0x47, true)),
        "end" => Some((0x4F, true)),
        "pageup" | "pgup" => Some((0x49, true)),
        "pagedown" | "pgdn" => Some((0x51, true)),
        "insert" | "ins" => Some((0x52, true)),
        // F1-F12（PS/2 Set 1 扫描码，都不是扩展键）
        "f1" => Some((0x3B, false)),
        "f2" => Some((0x3C, false)),
        "f3" => Some((0x3D, false)),
        "f4" => Some((0x3E, false)),
        "f5" => Some((0x3F, false)),
        "f6" => Some((0x40, false)),
        "f7" => Some((0x41, false)),
        "f8" => Some((0x42, false)),
        "f9" => Some((0x43, false)),
        "f10" => Some((0x44, false)),
        "f11" => Some((0x57, false)),
        "f12" => Some((0x58, false)),
        // F13-F24：物理键盘上没有，任何应用都不会绑定。
        // 用途：**零风险验证 SendInput 调用链** —— 发它到前台窗口不会有任何副作用。
        // （验证「输入真的进了控件」需要能切焦点，全屏游戏抢前台时做不到；见 _probe/verify-input-real2.py）
        "f13" => Some((0x64, false)),
        "f14" => Some((0x65, false)),
        "f15" => Some((0x66, false)),
        "f16" => Some((0x67, false)),
        "f17" => Some((0x68, false)),
        "f18" => Some((0x69, false)),
        "f19" => Some((0x6A, false)),
        "f20" => Some((0x6B, false)),
        "f21" => Some((0x6C, false)),
        "f22" => Some((0x6D, false)),
        "f23" => Some((0x6E, false)),
        "f24" => Some((0x6F, false)),
        // 其它常用
        "capslock" | "caps" => Some((0x3A, false)),
        "numlock" => Some((0x45, true)),
        "scrolllock" => Some((0x46, false)),
        "printscreen" | "prtsc" => Some((0x37, true)),
        "pause" | "break" => Some((0x45, true)),
        "apps" | "menu" => Some((0x5D, true)),
        // 小键盘（游戏里少用，但输入数字时方便）
        "num0" | "numpad0" => Some((0x52, false)),
        "num1" | "numpad1" => Some((0x4F, false)),
        "num2" | "numpad2" => Some((0x50, false)),
        "num3" | "numpad3" => Some((0x51, false)),
        "num4" | "numpad4" => Some((0x4B, false)),
        "num5" | "numpad5" => Some((0x4C, false)),
        "num6" | "numpad6" => Some((0x4D, false)),
        "num7" | "numpad7" => Some((0x47, false)),
        "num8" | "numpad8" => Some((0x48, false)),
        "num9" | "numpad9" => Some((0x49, false)),
        "numadd" | "numpad+" => Some((0x4E, false)),
        "numsub" | "numpad-" => Some((0x4A, false)),
        "nummul" | "numpad*" => Some((0x37, false)),
        "numdiv" | "numpad/" => Some((0x35, true)),
        "numdot" | "numpad." => Some((0x53, false)),
        "numenter" => Some((0x1C, true)),
        _ => None,
    };
    if let Some(s) = special {
        return Some(s);
    }
    // 单字符：用 VkKeyScanW 拿到 VK + shift 状态，再转扫描码
    let ch = k.chars().next()?;
    if k.chars().count() == 1 {
        // SAFETY: VkKeyScanW 是纯查表函数，无副作用。
        let vk = unsafe { VkKeyScanW(ch as u16) };
        if vk == -1 {
            return None;
        }
        let vk_code = (vk & 0xFF) as u16;
        // SAFETY: MapVirtualKeyW 纯查表。
        let sc = unsafe { MapVirtualKeyW(vk_code as u32, MAPVK_VK_TO_VSC_EX) } as u16;
        if sc == 0 {
            return None;
        }
        // MapVirtualKeyW 返回值高字节 0xE0 表示扩展键
        return Some((sc & 0xFF, (sc & 0xE000) != 0));
    }
    // 命名修饰键
    let m: Option<(u16, bool)> = match k.as_str() {
        "shift" => Some((0x2A, false)),
        "ctrl" | "control" => Some((0x1D, false)),
        "alt" => Some((0x38, false)),
        "lshift" => Some((0x2A, false)),
        "rshift" => Some((0x36, false)),
        "lctrl" => Some((0x1D, false)),
        "rctrl" => Some((0x1D, true)),
        "lalt" => Some((0x38, false)),
        "ralt" => Some((0x38, true)),
        "win" | "lwin" => Some((0x5B, true)),
        "rwin" => Some((0x5C, true)),
        _ => None,
    };
    m
}

fn make_key_input(sc: u16, extended: bool, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_SCANCODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if extended {
        flags |= windows::Win32::UI::Input::KeyboardAndMouse::KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            ki: KEYBDINPUT {
                wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                wScan: sc,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

// ── 输入安全策略：唯一策略表（2026-11-21 审计 P2）─────────────────────────
//
// 与 JS（live-2d/plugins/community/dispatch/game-control.js 的 KEY_POLICY_RULES）
// **内容一致**，_probe/test-control-consistency.cjs 会解析两处做集合比较。
// 病根：JS 只挡 alt+f4/ctrl+alt+del/alt+tab，pwsh send-input.ps1 挡 6 类，
//   而这里什么都不挡 —— `press_key ctrl+shift+esc` 走 JS 会被拒，
//   走 game-loop/post_keys 直连 pet-core 却会真的把任务管理器调起来。
// 语义：require = 必须同时出现的规范化键；any = 任一触发键（空数组 = require 命中即拒）。
// #region key-policy-table
const KEY_POLICY_RULES: &[(&[&str], &[&str])] = &[
    (&["alt"], &["f4", "tab", "space"]),
    (&["ctrl", "alt"], &["del", "delete"]),
    (&["ctrl"], &["esc", "escape"]),
    (&["win"], &[]),
];
const KEY_POLICY_DENY_MSG: &str = "该组合被安全策略拒绝（固定策略：alt+f4 / alt+tab / alt+space / ctrl+alt+del / ctrl+esc / ctrl+shift+esc / win+任意键 不允许注入）";
// #endregion key-policy-table

/// 键名归一（与 JS KEY_ALIAS 同义）：修饰键的左右版本折叠到基础名。
fn canonical_key_name(k: &str) -> &str {
    match k {
        "control" => "ctrl",
        "escape" => "esc",
        "delete" => "del",
        "lctrl" | "rctrl" => "ctrl",
        "lalt" | "ralt" => "alt",
        "lshift" | "rshift" => "shift",
        "lwin" | "rwin" => "win",
        other => other,
    }
}

/// 策略判定：命中返回固定错误文案。顺序/大小写/左右修饰键别名都归一后判。
fn key_policy_violation(parts: &[&str]) -> Option<&'static str> {
    let set: Vec<&str> = parts.iter().map(|p| canonical_key_name(p)).collect();
    for (require, any) in KEY_POLICY_RULES {
        if !require.iter().all(|k| set.iter().any(|x| x == k)) {
            continue;
        }
        if any.is_empty() || any.iter().any(|k| set.iter().any(|x| x == k)) {
            return Some(KEY_POLICY_DENY_MSG);
        }
    }
    None
}

/// 解析一个组合键，**不发送**。给 dry-run 和单测用。
///
/// 返回 [(键名, 扫描码, 是否扩展键)]，解析失败返回 Err。
pub fn parse_keys(combo: &str) -> Result<Vec<(String, u16, bool)>, String> {
    let parts: Vec<&str> = combo.split('+').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Err("没有键".into());
    }
    // 安全策略必须**在解析扫描码之前**：被拒的组合不应该有任何机会被发出去。
    if let Some(msg) = key_policy_violation(&parts) {
        return Err(msg.to_string());
    }
    let mut out = Vec::new();
    for p in parts {
        match key_to_scancode(p) {
            Some((sc, ext)) => out.push((p.to_string(), sc, ext)),
            None => {
                return Err(format!(
                    "不认识的键：{p}（可用：a-z 0-9 / enter esc tab space backspace delete /                      up down left right home end pageup pagedown insert / shift ctrl alt win /                      lshift rshift lctrl rctrl lalt ralt lwin rwin）"
                ));
            }
        }
    }
    Ok(out)
}

/// 按一个组合键（如 `ctrl+s`）或单键（`w`）。`hold_ms` > 0 时按住那么久。
///
/// ⚠ **已知行为**（2026-11-09 实测）：用扫描码发的字母键会受**当前物理 shift 状态**影响 ——
///   用户按着 shift 时，发 `a` 的扫描码会输出 `A`。这是 Windows 输入模型的固有行为
///   （扫描码是「物理按键」，不是「字符」），游戏里要的正是这个语义（shift 静步 + WASD 走位）。
///   需要**精确字符**时请用 `type_text`（它走 KEYEVENTF_UNICODE，不受 shift 影响）。
pub fn send_keys(combo: &str, hold_ms: u32) -> InputResult {
    let codes: Vec<(u16, bool)> = match parse_keys(combo) {
        Ok(v) => v.into_iter().map(|(_, sc, ext)| (sc, ext)).collect(),
        Err(e) => return InputResult { ok: false, sent: 0, error: Some(e) },
    };

    let mut inputs: Vec<INPUT> = Vec::new();
    // 按下顺序：修饰键先按
    for &(sc, ext) in &codes {
        inputs.push(make_key_input(sc, ext, false));
    }
    // SAFETY: SendInput 接受一个 INPUT 数组，cbSize 用 size_of 正确值。
    // 数组在调用期间有效（Vec 在栈上持有）。
    unsafe {
        let size = std::mem::size_of::<INPUT>() as i32;
        let n = SendInput(&inputs, size);
        if n == 0 {
            return InputResult { ok: false, sent: 0, error: Some("SendInput 完全没送出去（可能被 UIPI 拦截：目标进程权限更高）".into()) };
        }
    }

    if hold_ms > 0 {
        std::thread::sleep(std::time::Duration::from_millis(hold_ms as u64));
    } else {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let mut ups: Vec<INPUT> = Vec::new();
    // 抬起顺序：反过来（后按的先松）
    for &(sc, ext) in codes.iter().rev() {
        ups.push(make_key_input(sc, ext, true));
    }
    // SAFETY: 同上。
    let n2 = unsafe {
        let size = std::mem::size_of::<INPUT>() as i32;
        SendInput(&ups, size)
    };
    InputResult {
        ok: n2 > 0,
        sent: (codes.len() * 2) as u32,
        error: if n2 == 0 { Some("抬起事件没送出去".into()) } else { None },
    }
}

// ── 非阻塞输入：按下/松开分离（2026-11-14 五十三轮 P1）─────────────────
//
// 为什么必须：`send_keys(hold_ms)` 在函数里 sleep —— 按住 700ms 期间整个闭环冻住，
// 20fps 掉到 1.4Hz。砍树/挖矿/走位全靠「按住」，全卡在这一个原语上。
// 拆成 down/up 两条命令后，JS 发完 down 立刻返回，用定时器发 up，循环照跑。
//
// 风险：按下没抬起 = 角色一直走（OS 层面键是真按下的）。三处兜底：
//   ① 本模块记着当前按下的键（HELD_KEYS/HELD_MOUSE），`release_all_inputs()` 一次全松；
//   ② pet-core 退出（serve 循环 EOF / 一次性模式结束）时自动调它；
//   ③ JS 的 stopLoop / 出错路径也调 release_all。

static HELD_KEYS: std::sync::Mutex<Vec<(u16, bool)>> = std::sync::Mutex::new(Vec::new());
static HELD_MOUSE: std::sync::Mutex<Vec<MOUSE_EVENT_FLAGS>> = std::sync::Mutex::new(Vec::new());

/// 只按下 / 只松开一个组合键（不 sleep）。
pub fn key_state(combo: &str, down: bool) -> InputResult {
    let codes: Vec<(u16, bool)> = match parse_keys(combo) {
        Ok(v) => v.into_iter().map(|(_, sc, ext)| (sc, ext)).collect(),
        Err(e) => return InputResult { ok: false, sent: 0, error: Some(e) },
    };
    let inputs: Vec<INPUT> = if down {
        // 按下顺序：修饰键先按（parse_keys 已按组合顺序给）
        codes.iter().map(|&(sc, ext)| make_key_input(sc, ext, false)).collect()
    } else {
        // 抬起顺序：后按的先松
        codes.iter().rev().map(|&(sc, ext)| make_key_input(sc, ext, true)).collect()
    };
    let size = std::mem::size_of::<INPUT>() as i32;
    // SAFETY: inputs 在调用期间有效。
    let n = unsafe { SendInput(&inputs, size) };
    if n == 0 {
        return InputResult { ok: false, sent: 0, error: Some("SendInput 没送出去（可能被 UIPI 拦截）".into()) };
    }
    if let Ok(mut held) = HELD_KEYS.lock() {
        if down {
            for &(sc, ext) in &codes {
                if !held.contains(&(sc, ext)) { held.push((sc, ext)); }
            }
        } else {
            held.retain(|&(s, e)| !codes.iter().any(|&(sc, ext)| sc == s && ext == e));
        }
    }
    InputResult { ok: true, sent: codes.len() as u32, error: None }
}

/// 把所有还按着的键/鼠标键松开（返回松了几个键）。
pub fn release_all_inputs() -> u32 {
    let keys: Vec<(u16, bool)> = match HELD_KEYS.lock() {
        Ok(mut h) => std::mem::take(&mut *h),
        Err(_) => Vec::new(),
    };
    let btns: Vec<MOUSE_EVENT_FLAGS> = match HELD_MOUSE.lock() {
        Ok(mut h) => std::mem::take(&mut *h),
        Err(_) => Vec::new(),
    };
    let mut n = 0u32;
    if !keys.is_empty() {
        let ups: Vec<INPUT> = keys.iter().rev().map(|&(sc, ext)| make_key_input(sc, ext, true)).collect();
        let size = std::mem::size_of::<INPUT>() as i32;
        // SAFETY: ups 在调用期间有效。
        unsafe { SendInput(&ups, size) };
        n += keys.len() as u32;
    }
    for flag in btns {
        let _ = send_mouse(&[mouse_input(0, 0, flag, 0)]);
        n += 1;
    }
    n
}

/// 鼠标按键按下 / 抬起（left / right / middle），不移动光标。
/// 用途：长按左键砍树挖矿、长按右键吃东西/放方块 —— 这些是「按住」而不是「点击」。
pub fn mouse_button_state(button: &str, down: bool) -> Result<(), String> {
    let b = button.trim().to_ascii_lowercase();
    let (down_flag, up_flag) = match b.as_str() {
        "left" | "l" | "" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" | "r" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" | "m" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        other => return Err(format!("不认识的鼠标键：{}（left/right/middle）", other)),
    };
    let (flag, release_flag) = if down { (down_flag, up_flag) } else { (up_flag, down_flag) };
    send_mouse(&[mouse_input(0, 0, flag, 0)])?;
    if let Ok(mut held) = HELD_MOUSE.lock() {
        if down {
            // 记「抬起标志」——松开时按它发
            if !held.iter().any(|f| f.0 == release_flag.0) { held.push(release_flag); }
        } else {
            held.retain(|f| f.0 != flag.0);
        }
    }
    Ok(())
}

/// 输入一段文字（KEYEVENTF_UNICODE 逐字符，绕过 IME）。
/// 为什么不用 SendKeys：它对中文/特殊字符支持差，且依赖键盘布局。
/// 为什么不用 WM_CHAR：Chromium/自绘输入框（QQ、微信、Electron）**不响应 WM_CHAR** ——
/// 消息进了队列但控件不处理，这是「假成功」的经典来源。
pub fn type_text(text: &str) -> InputResult {
    if text.is_empty() {
        return InputResult { ok: false, sent: 0, error: Some("空文本".into()) };
    }
    let mut sent = 0u32;
    for ch in text.chars() {
        // ⚠ 2026-11-10 审计抓到：原来 `let code = ch as u16;` —— emoji / 生僻字（CJK Ext-B）
        //   是非 BMP（>U+FFFF），`as u16` 会截断成完全错误的 BMP 码点（输入出来是乱码）。
        //   KEYEVENTF_UNICODE 要求按 **UTF-16 码元**逐个发（代理对 = 两个码元），见下方发送处。
        // 换行：WM_CHAR 的 0x0A 会被编辑控件吞掉，改发真正的 VK_RETURN 扫描码
        if ch == '\n' {
            let mut down = make_key_input(0x1C, false, false);
            let mut up = make_key_input(0x1C, false, true);
            // SAFETY: SendInput 对短数组安全。
            unsafe {
                let size = std::mem::size_of::<INPUT>() as i32;
                SendInput(&[down], size);
                std::thread::sleep(std::time::Duration::from_millis(8));
                SendInput(&[up], size);
            }
            let _ = (&mut down, &mut up);
            sent += 1;
            continue;
        }
        let mk = |code: u16, up: bool| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(0),
                    wScan: code,
                    dwFlags: if up { KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } else { KEYEVENTF_UNICODE },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        // 非 BMP 字符会 encode 成两个 UTF-16 码元（代理对），必须逐个发
        let mut units = [0u16; 2];
        let encoded = ch.encode_utf16(&mut units);
        let mut all_ok = true;
        for &code in encoded.iter() {
            // SAFETY: 同上。
            let n = unsafe {
                let size = std::mem::size_of::<INPUT>() as i32;
                SendInput(&[mk(code, false), mk(code, true)], size)
            };
            if n == 0 { all_ok = false; break; }
        }
        if !all_ok {
            return InputResult { ok: false, sent, error: Some(format!("第 {} 个字符没送出去", sent + 1)) };
        }
        sent += 1;
        // ⚠ 2026-11-09 实测：8ms 间隔会丢字（WinForms TextBox 只收到前 7 个字符，
        //   10 个字符里丢了后 3 个）。这是输入队列/控件处理速度的实际限制。
        //   25ms 是平衡点：10 个字符 250ms，可接受；实测能全部送达。
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    InputResult { ok: true, sent, error: None }
}

/// 鼠标注入结果（2026-11-10 四十轮：把 click/drag 从 pwsh 搬进 Rust）。
pub struct MouseResult {
    pub kind: String,
    pub steps: u32,
    pub us: u64,
    /// 动作结束后是否把用户光标还回了原位（restore_cursor 且动作确实是绝对定位时）
    pub restored: bool,
    /// 动作瞬间用户有多久没碰键鼠（GetLastInputInfo，毫秒）。
    /// 小于 ~300ms 说明用户正在用鼠标 —— 上层可以据此提示/延后，
    /// 但**不阻断**（用户让她点的时候往往自己也在看屏幕、手在鼠标上）。
    pub user_idle_ms: u64,
}

fn mouse_input(dx: i32, dy: i32, flags: windows::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data as u32,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn send_mouse(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() { return Ok(()); }
    let size = std::mem::size_of::<INPUT>() as i32;
    // SAFETY: inputs 在调用期间有效；cbSize 是 INPUT 的真实大小。
    let n = unsafe { SendInput(inputs, size) };
    if n == 0 {
        return Err("SendInput 完全没送出去（可能被 UIPI 拦截：目标进程权限更高）".into());
    }
    Ok(())
}

/// 五级门禁 + 鼠标注入（Rust 单进程完成，实测 ~20-50ms；原来 pwsh 冷启动 200-450ms）。
///
/// kind: click / double_click / right_click / drag / scroll
/// 坐标是**物理像素**；内部按虚屏归一化到 0..65535 + VIRTUALDESK。
/// expect_title 给了就先做落点遮挡检查（WindowFromPoint 根窗口标题必须包含它）。
/// 修饰键名 → (扫描码, 是否扩展键)。只认 ctrl / shift / alt / win（鼠标组合键的常用集）。
///
/// 为什么用**扫描码**而不是 VK：游戏和 Chromium 都按扫描码分派（见 key_to_scancode 顶部注释），
/// 而 SendInput 的 wVk 传 0 时系统会按当前布局补。和 `send_keys` 保持同一条路。
fn modifier_scancodes(mods: &str) -> Vec<(u16, bool)> {
    let mut out = Vec::new();
    for m in mods.split(['+', ',', ' ']) {
        let k = m.trim().to_ascii_lowercase();
        match k.as_str() {
            "ctrl" | "control" => out.push((0x1D, false)),
            "shift" => out.push((0x2A, false)),
            "alt" | "menu" => out.push((0x38, false)),
            "win" | "super" | "meta" => out.push((0x5B, true)),
            "" => {}
            _ => {}
        }
    }
    out
}

pub fn mouse_inject(
    kind: &str,
    x: i32,
    y: i32,
    x2: i32,
    y2: i32,
    duration_ms: u32,
    notches: i32,
    expect_title: Option<&str>,
    // 组合键修饰（"ctrl" / "ctrl+shift" / "shift" / ""）。2026-11-14：
    // 列表多选（ctrl+click）和区间选择（shift+click）必须靠它 —— 原来只有裸点击，
    // 想多选只能逐个点，选第二个就把第一个取消了。
    modifiers: Option<&str>,
    // scroll 的轴："v"（默认，垂直）/ "h"（水平）
    axis: Option<&str>,
    // 是否把**用户的光标还回原位**（2026-11-14 五十三轮：「两个光标」）
    //
    // 背景：SendInput 是**全局**注入 —— 它移动的就是用户手里那只鼠标。
    // 用户要「她用自己的光标操作、我用我的」——OS 层面做不到两只鼠标，
    // 所以做成：① 主路径不碰真实光标（UIA Invoke / PostMessage）；
    //          ② 必须 SendInput 的兜底路径，动作做完立刻 SetCursorPos 还回原位。
    // 效果：用户的光标顶多闪一下（~100ms），位置不丢；屏幕上常驻的橙色虚拟光标
    // 才是「她在哪」的那只。move_rel / click_only 不受影响（游戏里光标本来就被锁定）。
    restore_cursor: bool,
    // 这次请求**有没有给坐标**（2026-11-14 五十三轮，审计抓到的回归）：
    //   `scroll down 5` 不带 @x,y 时 JS 原来垫成 (0,0) —— 而 (0,0) 正好在屏幕极角，
    //   新的「按落点判急停」守卫会把每一次默认滚动都拒掉（EMERGENCY-STOP@0x0）。
    //   所以坐标改为可选：没给就不查落点、不挪光标。
    has_pos: bool,
) -> Result<MouseResult, String> {
    let t0 = std::time::Instant::now();
    // ⚠ 空闲时长必须在**注入前**读：SendInput 自己也会刷新 GetLastInputInfo，
    //   动作后再读永远是 ~16ms，分不清「用户刚动过」和「我们刚动过」。
    let idle_before = user_idle_ms();
    // 动作前记下用户光标（restore 用）；同时供角落急停判定
    // SAFETY: POINT 是 POD，GetCursorPos 写入它。
    let orig = unsafe {
        let mut p = POINT::default();
        if GetCursorPos(&mut p).is_ok() { Some((p.x, p.y)) } else { None }
    };
    // ① UAC 安全桌面：注入会被系统丢弃，还可能误触提权框
    // SAFETY: 只查询桌面句柄；成功时立即关闭，不持有句柄。
    unsafe {
        match OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0100)) {
            Ok(h) => { let _ = CloseDesktop(h); }
            Err(e) => {
                if (e.code().0 as u32) & 0xFFFF == 5 {
                    return Err("UAC-SECURE-DESKTOP".into());
                }
            }
        }
    }
    // ② 角落急停（4px；右上关闭/右下 Peek 白名单）
    //
    // ⚠ 2026-11-14 五十三轮改语义：这个守卫本来是查「注入后光标被甩到角落」——
    //   restore_cursor 打开后，动作结束光标会**还回用户原位**，用户习惯把鼠标
    //   停在角上时会被永久误否决（死锁）。所以 restore 模式改成查**落点坐标**：
    //   真正要防的是「坐标算炸了点到屏幕极角」（比如 0,0 或 65535 溢出），
    //   而不是用户的光标停在哪。
    unsafe {
        let probe: Option<(i32, i32)> = if restore_cursor {
            // drag：起点和终点都查；其余：查目标点（click_only/move_rel 没有绝对落点，跳过）
            let mut pts: Vec<(i32, i32)> = Vec::new();
            if has_pos && matches!(kind, "click" | "double_click" | "right_click" | "middle_click" | "drag" | "scroll") {
                pts.push((x, y));
            }
            if kind == "drag" && has_pos { pts.push((x2, y2)); }
            // 取第一个落在极角的点（有明显坐标就够判）
            let l = GetSystemMetrics(SM_XVIRTUALSCREEN);
            let t = GetSystemMetrics(SM_YVIRTUALSCREEN);
            let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            let r = 4;
            pts.into_iter().find(|&(px, py)| {
                let nl = (px - l) <= r;
                let nt = (py - t) <= r;
                let nr = ((l + w) - px) <= r;
                let nb = ((t + h) - py) <= r;
                let in_corner = (nl && nt) || (nl && nb) || (nr && nt) || (nr && nb);
                let whitelist = (nr && nt) || (nr && nb);   // 右上关闭 / 右下 Peek
                in_corner && !whitelist
            })
        } else {
            let mut p = POINT::default();
            if GetCursorPos(&mut p).is_ok() {
                let l = GetSystemMetrics(SM_XVIRTUALSCREEN);
                let t = GetSystemMetrics(SM_YVIRTUALSCREEN);
                let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
                let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
                let r = 4;
                let nl = (p.x - l) <= r;
                let nt = (p.y - t) <= r;
                let nr = ((l + w) - p.x) <= r;
                let nb = ((t + h) - p.y) <= r;
                let in_corner = (nl && nt) || (nl && nb) || (nr && nt) || (nr && nb);
                let whitelist = (nr && nt) || (nr && nb);
                if in_corner && !whitelist { Some((p.x, p.y)) } else { None }
            } else {
                None
            }
        };
        if let Some((bx, by)) = probe {
            return Err(format!("EMERGENCY-STOP@{}x{}", bx, by));
        }
    }
    // ③ 落点遮挡：坐标在目标窗口矩形内 ≠ 像素没被悬浮窗压着
    if has_pos {
        if let Some(want) = expect_title.map(str::trim).filter(|s| !s.is_empty()) {
            if let Ok((_root, title, _child)) = window_from_point(x, y) {
                if !title.is_empty() && !title.to_lowercase().contains(&want.to_lowercase()) {
                    return Err(format!("OCCLUDED:{}", title));
                }
            }
        }
    }

    // ④ 虚屏归一化
    // SAFETY: GetSystemMetrics 只读系统参数。
    let (vx, vy, vw, vh) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    if vw <= 1 || vh <= 1 {
        return Err(format!("虚屏尺寸无效：{}×{}", vw, vh));
    }
    let norm = |px: i32, py: i32| -> (i32, i32) {
        let nx = (((px - vx) as i64) * 65535 / (vw as i64 - 1)) as i32;
        let ny = (((py - vy) as i64) * 65535 / (vh as i64 - 1)) as i32;
        (nx.clamp(0, 65535), ny.clamp(0, 65535))
    };
    let move_flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    let mut steps = 0u32;

    // ⑤ 修饰键按下（2026-11-14）：ctrl+click 多选 / shift+click 连选。
    //    必须在 move 之前按 —— 部分控件在 hover 阶段就检查修饰状态。
    //    ⚠ Drop 守卫是必需的：下面每个 `?` 早退（move 失败等）都会直接返回，
    //    如果只在末尾手动松键，异常路径上会把用户的 Ctrl「卡住」。
    let mod_codes = modifier_scancodes(modifiers.unwrap_or(""));
    if !mod_codes.is_empty() {
        let downs: Vec<INPUT> = mod_codes.iter().map(|&(sc, ext)| make_key_input(sc, ext, false)).collect();
        send_mouse(&downs)?;
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
    struct ModGuard<'a>(&'a [(u16, bool)]);
    impl Drop for ModGuard<'_> {
        fn drop(&mut self) {
            if self.0.is_empty() { return; }
            let ups: Vec<INPUT> = self.0.iter().rev().map(|&(sc, ext)| make_key_input(sc, ext, true)).collect();
            let _ = send_mouse(&ups);   // 松键失败没法补救，但至少不 panic
        }
    }
    let _mod_guard = ModGuard(&mod_codes);

    match kind {
        "click" | "double_click" | "right_click" | "middle_click" => {
            if !has_pos {
                return Err("click 需要坐标（x,y）。没给坐标的点击会落到光标当前位置 —— 那是随机点".into());
            }
            let (nx, ny) = norm(x, y);
            let (down, up) = match kind {
                "right_click" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                "middle_click" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            };
            // ⚠ 2026-11-10 实测：move + down + up 塞进**同一次** SendInput 时，
            //   部分 Godot/Chromium 控件来不及处理 hover，按钮点了没反应。
            //   旧 pwsh 路径有 60ms SetCursorPos→mouse_event 间隔，所以没暴露。
            //   这里先单独 move，再等 45ms，最后按下/抬起。
            send_mouse(&[mouse_input(nx, ny, move_flags, 0)])?;
            std::thread::sleep(std::time::Duration::from_millis(45));
            // Godot/Chromium 的 Control 需要 down/up 分两帧到达（同一次 SendInput 里的
            // 连发会被合并成一个“瞬时点击”，部分按钮不认）。30ms 足够跨过一帧。
            send_mouse(&[mouse_input(0, 0, down, 0)])?;
            std::thread::sleep(std::time::Duration::from_millis(30));
            send_mouse(&[mouse_input(0, 0, up, 0)])?;
            if kind == "double_click" {
                std::thread::sleep(std::time::Duration::from_millis(90));
                send_mouse(&[mouse_input(0, 0, down, 0)])?;
                std::thread::sleep(std::time::Duration::from_millis(30));
                send_mouse(&[mouse_input(0, 0, up, 0)])?;
            }
            steps = 1;
        }
        "drag" => {
            if !has_pos {
                return Err("drag 需要起点坐标（x,y）。".into());
            }
            let dur = duration_ms.max(200);
            let n = 30u32;
            let step_ms = (dur / n).max(4);
            let (sx, sy) = norm(x, y);
            send_mouse(&[mouse_input(sx, sy, move_flags, 0)])?;
            std::thread::sleep(std::time::Duration::from_millis(80));
            send_mouse(&[mouse_input(0, 0, MOUSEEVENTF_LEFTDOWN, 0)])?;
            std::thread::sleep(std::time::Duration::from_millis(80));
            for i in 1..=n {
                let p = i as f64 / n as f64;
                // ease-in-out cubic：首尾慢、中间快
                let t = if p < 0.5 { 4.0 * p * p * p } else { 1.0 - (-2.0 * p + 2.0).powi(3) / 2.0 };
                let ix = (x as f64 + (x2 - x) as f64 * t).round() as i32;
                let iy = (y as f64 + (y2 - y) as f64 * t).round() as i32;
                let (nx, ny) = norm(ix, iy);
                send_mouse(&[mouse_input(nx, ny, move_flags, 0)])?;
                std::thread::sleep(std::time::Duration::from_millis(step_ms as u64));
                steps += 1;
            }
            send_mouse(&[mouse_input(0, 0, MOUSEEVENTF_LEFTUP, 0)])?;
        }
        "scroll" => {
            if has_pos {
                let (nx, ny) = norm(x, y);
                send_mouse(&[mouse_input(nx, ny, move_flags, 0)])?;
            }
            let delta = notches.clamp(-50, 50) * 120;
            if delta != 0 {
                // 轴（2026-11-14）：宽表格/横向相册要水平滚。浏览器里 shift+滚轮也能横滚，
                // 但那依赖应用自己处理修饰键，WHEEL 直接给系统更可靠。
                let flag = if axis.unwrap_or("v").eq_ignore_ascii_case("h") {
                    MOUSEEVENTF_HWHEEL
                } else {
                    MOUSEEVENTF_WHEEL
                };
                send_mouse(&[mouse_input(0, 0, flag, delta)])?;
            }
            steps = 1;
        }
        "move_rel" => {
            // **相对移动**（2026-11-14，3D 游戏转视角必需）。
            // 不带 MOUSEEVENTF_ABSOLUTE，dx/dy 就是增量 —— 和绝对坐标是两条完全不同的路：
            //   · 绝对坐标：SetCursorPos 语义，会被指针加速曲线修正、到屏幕边界被钳死
            //   · 相对移动：raw delta，FPS/3D 游戏读的就是它，转视角才跟手
            // x/y 在这里是 dx/dy（复用同一组参数，省得加新字段）。
            let dx = x.clamp(-4000, 4000);
            let dy = y.clamp(-4000, 4000);
            if dx == 0 && dy == 0 {
                steps = 0;
            } else {
                send_mouse(&[mouse_input(dx, dy, MOUSEEVENTF_MOVE, 0)])?;
                steps = 1;
            }
        }
        "click_only" => {
            // **原地点击**（不移动光标）。游戏世界里鼠标已被锁定（准星模式），
            // 「攻击」就是按下/抬起，没有坐标概念。
            send_mouse(&[mouse_input(0, 0, MOUSEEVENTF_LEFTDOWN, 0)])?;
            std::thread::sleep(std::time::Duration::from_millis(35));
            send_mouse(&[mouse_input(0, 0, MOUSEEVENTF_LEFTUP, 0)])?;
            steps = 1;
        }
        other => return Err(format!("不认识的鼠标动作：{}", other)),
    }

    // ⑦ 把用户的光标还回去（2026-11-14 五十三轮「两个光标」）
    //   只对绝对定位动作生效：move_rel 是游戏转视角（还回去等于没转），
    //   click_only 本来就没移动。
    let mut restored = false;
    if restore_cursor {
        if let Some((ox, oy)) = orig {
            if matches!(kind, "click" | "double_click" | "right_click" | "middle_click" | "drag" | "scroll") {
                // 等一拍再还：down/up 已经发出了，给目标应用一帧处理时间，
                // 避免个别控件把「抬起后指针立刻离开」读成 hover 离开而取消点击。
                std::thread::sleep(std::time::Duration::from_millis(12));
                // SAFETY: SetCursorPos 只改指针位置，无内存副作用。
                restored = unsafe { SetCursorPos(ox, oy).is_ok() };
            }
        }
    }

    Ok(MouseResult {
        kind: kind.to_string(),
        steps,
        us: t0.elapsed().as_micros() as u64,
        restored,
        user_idle_ms: idle_before,
    })
}

/// 用户有多久没碰键鼠了（毫秒；读不到返回 0）。
/// 2026-11-14 五十三轮：SendInput 和用户抢的是同一只物理鼠标 ——
/// 上层可以据此判断「用户正在用」并选择不动真实光标的路径（UIA/PostMessage）。
pub fn user_idle_ms() -> u64 {
    unsafe {
        let mut li = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut li).as_bool() {
            let now = windows::Win32::System::SystemInformation::GetTickCount();
            (now.wrapping_sub(li.dwTime)) as u64
        } else {
            0
        }
    }
}

/// 当前用户光标位置（物理像素）。只读诊断用。
pub fn cursor_pos() -> Option<(i32, i32)> {
    // SAFETY: POINT 是 POD，GetCursorPos 只写这个结构。
    unsafe {
        let mut p = POINT::default();
        if GetCursorPos(&mut p).is_ok() { Some((p.x, p.y)) } else { None }
    }
}

/// 诊断用：抓全屏 + 输出 9×8 灰度矩阵（不给业务用，排「hash 抖动」时靠它）
pub fn screen_gray_matrix() -> Result<(Vec<u8>, i32, i32), String> {
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let bmp = CreateCompatibleBitmap(screen_dc, w, h);
        let old = SelectObject(mem_dc, HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
        let ok = BitBlt(mem_dc, 0, 0, w, h, Some(screen_dc), 0, 0, SRCCOPY);
        if ok.is_err() {
            SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("BitBlt 失败".into());
        }
        SelectObject(mem_dc, old);   // GetDIBits 前必须选出来
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;
        let stride = (w as usize) * 4;
        let mut buf = vec![0u8; stride * (h as usize)];
        let lines = GetDIBits(mem_dc, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);
        if lines == 0 { return Err("GetDIBits 失败".into()); }

        // 块平均 → 9x8 灰度
        const CW: usize = 9;
        const CH: usize = 8;
        let mut sum = [[0u64; CW]; CH];
        let mut cnt = [[0u64; CW]; CH];
        for y in 0..h as usize {
            let ry = y * CH / (h as usize);
            let row_base = y * stride;
            for x in 0..w as usize {
                let rx = x * CW / (w as usize);
                let p = row_base + x * 4;
                let b = buf[p] as u64;
                let g = buf[p + 1] as u64;
                let r = buf[p + 2] as u64;
                let lum = (b * 29 + g * 150 + r * 77) >> 8;
                sum[ry][rx] += lum;
                cnt[ry][rx] += 1;
            }
        }
        let mut out = Vec::with_capacity(CW * CH);
        for r in 0..CH {
            for c in 0..CW {
                out.push(if cnt[r][c] > 0 { (sum[r][c] / cnt[r][c]) as u8 } else { 0 });
            }
        }
        Ok((out, w, h))
    }
}

/// 全屏截图存 BMP（2026-11-10 三十七轮）：给主进程 take-screenshot 换引擎用。
///
/// 为什么：screenshot-desktop 外部包对某些显示配置输出**黑帧**（拟真实测「截图这边抓不到（黑帧）」），
/// 而 GDI BitBlt 全屏这条路（screen_gray_matrix 同源）在本机一直稳定。
/// 输出 32bpp BGRA BMP（top-down），与 wgc_shot 的 BMP 同格式，Electron nativeImage 直接吃。
pub fn screen_shot_bmp(path: &str) -> Result<(i32, i32, u64), String> {
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return Err("拿不到屏幕尺寸".into());
        }
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC 失败".into());
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC 失败".into());
        }
        let bmp = CreateCompatibleBitmap(screen_dc, w, h);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleBitmap 失败".into());
        }
        let old = SelectObject(mem_dc, HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
        let ok = BitBlt(mem_dc, 0, 0, w, h, Some(screen_dc), 0, 0, SRCCOPY | CAPTUREBLT);
        if ok.is_err() {
            SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("BitBlt 失败".into());
        }
        SelectObject(mem_dc, old);   // GetDIBits 前必须选出来（时序坑同 screen_dhash）
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;
        let stride = (w as usize) * 4;
        let mut buf = vec![0u8; stride * (h as usize)];
        let lines = GetDIBits(mem_dc, bmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);
        if lines == 0 {
            return Err("GetDIBits 失败".into());
        }
        let bytes = crate::wgc::write_bmp(std::path::Path::new(path), &buf, w, h)?;
        Ok((w, h, bytes))
    }
}

/// 落点遮挡检查（2026-11-10 三十七轮，抄 dsh-computer-use-win #9「POINT_COVERED」）。
///
/// 为什么要有：click_at 的窗口级前台校验只保证「目标窗口在前台」，**不保证落点像素上
/// 没有别的悬浮窗**（置顶小工具/桌宠自己/输入法面板都能压在目标上）。实测踩过：
/// 坐标全对、前台也对，点击却被桌宠自己吃掉。这里用 WindowFromPoint + GetAncestor(GA_ROOT)
/// 查落点真正的根窗口，与目标不符就把遮挡者标题/HWND 报给调用方。
/// 后台鼠标点击（PostMessage）—— 不抢前台、不移动用户鼠标、不受遮挡。
///
/// 坐标用**整窗相对**（和 WGC 抓到的图一致），内部减掉「客户区原点 − 窗口原点」的偏移。
/// 调用方（JS/Python）不用关心标题栏高度和 DPI。
///
/// 实测（2026-11-14，MC 1.21.1 / GLFW）：WM_LBUTTONDOWN 被正常处理；
/// 但 **WM_CHAR/WM_KEYDOWN 不行** —— GLFW 会检查窗口是否 focused，非焦点窗口的
/// 键盘消息直接丢弃。所以「点击可以后台，打字必须前台」。
pub fn post_mouse_inject(
    target: &str,
    img_x: i32,
    img_y: i32,
    kind: &str,
) -> Result<(i64, i32, i32), String> {
    // ① 找窗口（复用 list_windows：标题子串或纯数字 hwnd）
    let hwnd = if let Ok(h) = target.trim().parse::<i64>() {
        HWND(h as *mut _)
    } else {
        let wins = list_windows(target, 8);
        match wins.iter().find(|w| !w.iconic).or_else(|| wins.first()) {
            Some(w) => HWND(w.hwnd as *mut _),
            None => return Err(format!("没找到窗口：{target}")),
        }
    };

    // SAFETY: 只做 Win32 查询与投递；不持有任何跨调用句柄。
    unsafe {
        let mut wr = RECT::default();
        GetWindowRect(hwnd, &mut wr).map_err(|e| format!("GetWindowRect 失败：{e}"))?;
        let mut origin = POINT { x: 0, y: 0 };
        windows::Win32::Graphics::Gdi::ClientToScreen(hwnd, &mut origin)
            .as_bool().then_some(()).ok_or("ClientToScreen 失败")?;
        let dx = origin.x - wr.left;
        let dy = origin.y - wr.top;

        let cx = img_x - dx;
        let cy = img_y - dy;
        let mut cr = RECT::default();
        if GetClientRect(hwnd, &mut cr).is_ok() {
            let cw = cr.right - cr.left;
            let ch = cr.bottom - cr.top;
            if cx < 0 || cy < 0 || cx >= cw || cy >= ch {
                return Err(format!(
                    "整窗坐标 ({img_x},{img_y}) 换算到客户区是 ({cx},{cy})，超出客户区 {cw}×{ch} —— 坐标算错了"
                ));
            }
        }
        let lp = LPARAM((((cy as u32) & 0xFFFF) << 16 | ((cx as u32) & 0xFFFF)) as isize);

        let (down, up) = if kind == "right_click" {
            (WM_RBUTTONDOWN, WM_RBUTTONUP)
        } else {
            (WM_LBUTTONDOWN, WM_LBUTTONUP)
        };

        let _ = PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(0), lp);
        std::thread::sleep(std::time::Duration::from_millis(15));
        let r1 = PostMessageW(Some(hwnd), down, WPARAM(if kind == "right_click" { 2 } else { 1 }), lp);
        std::thread::sleep(std::time::Duration::from_millis(60));
        let r2 = PostMessageW(Some(hwnd), up, WPARAM(0), lp);
        // 双击：再来一轮（间隔 < 500ms 才算双击）
        if kind == "double_click" {
            std::thread::sleep(std::time::Duration::from_millis(60));
            let _ = PostMessageW(Some(hwnd), down, WPARAM(1), lp);
            std::thread::sleep(std::time::Duration::from_millis(40));
            let _ = PostMessageW(Some(hwnd), up, WPARAM(0), lp);
        }
        if r1.is_err() && r2.is_err() {
            return Err(format!("PostMessage 全部失败（窗口可能已关闭）：{:?}", r1.err()));
        }
        Ok((hwnd.0 as i64, cx, cy))
    }
}

/// 当前前台窗口的 hwnd（0 = 读不到）。
///
/// 2026-11-14 审计：游戏循环必须先确认「目标窗口就是前台」——
/// `SendInput` 永远发给**前台窗口**，目标不在前台时按键会打进用户正在用的应用。
pub fn fg_hwnd() -> i64 {
    // SAFETY: 只读系统状态。
    unsafe { GetForegroundWindow().0 as i64 }
}

pub fn window_from_point(x: i32, y: i32) -> Result<(i64, String, i64), String> {
    unsafe {
        let pt = windows::Win32::Foundation::POINT { x, y };
        let hwnd = windows::Win32::UI::WindowsAndMessaging::WindowFromPoint(pt);
        if hwnd.0.is_null() {
            return Err("WindowFromPoint 返回空（坐标不在任何窗口上）".into());
        }
        let root = windows::Win32::UI::WindowsAndMessaging::GetAncestor(
            hwnd,
            windows::Win32::UI::WindowsAndMessaging::GET_ANCESTOR_FLAGS(2), // GA_ROOT
        );
        let root = if root.0.is_null() { hwnd } else { root };
        // 标题（GetWindowTextW）
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextW};
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(root, &mut buf);
        let title = String::from_utf16_lossy(&buf[..len as usize]);
        Ok((root.0 as i64, title, hwnd.0 as i64))
    }
}

/// 局部区域灰度特征（2026-11-10 三十七轮）。
///
/// 为什么要有它：全屏 9×8 dHash 对游戏内局部变化（60×60 格子里种一株植物、卡片高亮）
/// 是「验证盲区」—— 实测种植成功但 hamming=0，`actAndVerify` 报 noop，是**假失败**。
/// 局部区域（点击点 ±110px）上放 12×10 网格，每格只有 ~18px，微小变化会直接体现在
/// 灰度均值/方差上。`actAndVerify` 在有坐标的动作里改用这个做前后对比。
pub struct RegionGrayResult {
    pub gray: Vec<u8>,      // 12×10 块平均灰度（行优先）
    pub mean: f32,          // 区域平均亮度
    pub std: f32,           // 区域亮度标准差
    pub width: i32,
    pub height: i32,
    pub us: u64,
}

pub fn region_gray(x: i32, y: i32, w: i32, h: i32) -> Result<RegionGrayResult, String> {
    let t0 = std::time::Instant::now();
    if w < 16 || h < 16 || w > 4096 || h > 4096 {
        return Err(format!("区域尺寸非法：{}×{}", w, h));
    }
    // clamp 到屏幕内（BitBlt 对出屏区域的处理不可靠）
    let (sw, sh) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
    let x0 = x.max(0).min(sw - 1);
    let y0 = y.max(0).min(sh - 1);
    let w0 = w.min(sw - x0).max(16);
    let h0 = h.min(sh - y0).max(16);

    const CW: usize = 12;
    const CH: usize = 10;
    unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.is_invalid() {
            return Err("GetDC 失败".into());
        }
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        if mem_dc.is_invalid() {
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC 失败".into());
        }
        let bmp = CreateCompatibleBitmap(screen_dc, w0, h0);
        if bmp.is_invalid() {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleBitmap 失败".into());
        }
        let old = SelectObject(mem_dc, HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
        let ok = BitBlt(mem_dc, 0, 0, w0, h0, Some(screen_dc), x0, y0, SRCCOPY | CAPTUREBLT);
        if ok.is_err() {
            SelectObject(mem_dc, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
            return Err("BitBlt 失败".into());
        }
        SelectObject(mem_dc, old);   // GetDIBits 前必须选出来（时序坑见 screen_dhash 注释）
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w0;
        bi.bmiHeader.biHeight = -h0;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;
        let stride = (w0 as usize) * 4;
        let mut buf = vec![0u8; stride * (h0 as usize)];
        let lines = GetDIBits(mem_dc, bmp, 0, h0 as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteObject(HGDIOBJ(bmp.0 as *mut core::ffi::c_void));
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);
        if lines == 0 {
            return Err("GetDIBits 失败".into());
        }

        // 块平均 12×10 + 全区域 mean/std
        let mut sum = [[0u64; CW]; CH];
        let mut cnt = [[0u64; CW]; CH];
        let mut total: u64 = 0;
        let mut total_sq: u128 = 0;
        let n = (w0 as usize) * (h0 as usize);
        for yy in 0..h0 as usize {
            let ry = yy * CH / (h0 as usize);
            let row_base = yy * stride;
            for xx in 0..w0 as usize {
                let rx = xx * CW / (w0 as usize);
                let p = row_base + xx * 4;
                let b = buf[p] as u64;
                let g = buf[p + 1] as u64;
                let r = buf[p + 2] as u64;
                let lum = (b * 29 + g * 150 + r * 77) >> 8;
                sum[ry][rx] += lum;
                cnt[ry][rx] += 1;
                total += lum;
                total_sq += (lum * lum) as u128;
            }
        }
        let mut gray = Vec::with_capacity(CW * CH);
        for r in 0..CH {
            for c in 0..CW {
                gray.push(if cnt[r][c] > 0 { (sum[r][c] / cnt[r][c]) as u8 } else { 0 });
            }
        }
        let mean = total as f32 / n as f32;
        let std = ((total_sq as f64 / n as f64 - (mean * mean) as f64).max(0.0)).sqrt() as f32;
        Ok(RegionGrayResult {
            gray,
            mean: (mean * 100.0).round() / 100.0,
            std: (std * 100.0).round() / 100.0,
            width: w0,
            height: h0,
            us: t0.elapsed().as_micros() as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_parse_basic() {
        assert!(key_to_scancode("w").is_some());
        assert!(key_to_scancode("enter").is_some());
        assert!(key_to_scancode("ctrl").is_some());
        assert!(key_to_scancode("up").is_some());
        assert!(key_to_scancode("?????").is_none());
    }

    #[test]
    fn key_extended_flag() {
        // 方向键必须是扩展键，否则游戏里会当成小键盘的 8/2/4/6
        assert_eq!(key_to_scancode("up"), Some((0x48, true)));
        assert_eq!(key_to_scancode("left"), Some((0x4B, true)));
        // 字母键不是扩展键
        let (_sc, ext) = key_to_scancode("w").unwrap();
        assert!(!ext);
    }

    #[test]
    fn parse_combo_multiple() {
        // ctrl+shift+f5 —— 3 个键都要解析出来，顺序保持（修饰键先按）
        let v = parse_keys("ctrl+shift+f5").unwrap();
        assert_eq!(v.len(), 3);
        assert_eq!(v[0].0, "ctrl");
        assert_eq!(v[1].0, "shift");
        assert_eq!(v[2].0, "f5");
    }

    #[test]
    fn key_policy_blocks_dangerous_combos() {
        // 与 JS KEY_POLICY_RULES 同一张表（2026-11-21 P2）：这些组合解析阶段就必须 Err，
        // 且文案明确 —— 不允许「解析成功但发不出去」的模糊状态。
        for combo in [
            "alt+f4", "alt+tab", "alt+space", "ctrl+alt+del", "ctrl+alt+delete",
            "ctrl+esc", "ctrl+shift+esc", "win", "win+r", "lwin+r",
            "lctrl+ralt+delete", "control+alt+del",
        ] {
            let r = parse_keys(combo);
            assert!(r.is_err(), "{combo} 应该被安全策略拒绝");
            assert!(
                r.unwrap_err().contains("该组合被安全策略拒绝"),
                "{combo} 的错误文案应明确说明被安全策略拒绝"
            );
        }
        // 正常组合不受影响
        for combo in ["ctrl+s", "shift+tab", "w", "ctrl+shift+f5"] {
            assert!(parse_keys(combo).is_ok(), "{combo} 不应被拒绝");
        }
    }

    #[test]
    fn parse_combo_rejects_unknown() {
        assert!(parse_keys("ctrl+不存在的键").is_err());
        assert!(parse_keys("").is_err());
    }

    #[test]
    fn parse_fkeys() {
        for i in 1..=12 {
            let k = format!("f{i}");
            assert!(key_to_scancode(&k).is_some(), "F{i} 应该认识");
            let (_, ext) = key_to_scancode(&k).unwrap();
            assert!(!ext, "F{i} 不是扩展键");
        }
        assert_eq!(key_to_scancode("f1"), Some((0x3B, false)));
        assert_eq!(key_to_scancode("f12"), Some((0x58, false)));
        // F13-F24：零风险验证用
        assert_eq!(key_to_scancode("f13"), Some((0x64, false)));
        assert_eq!(key_to_scancode("f24"), Some((0x6F, false)));
    }

    #[test]
    fn parse_symbols() {
        // 符号键走 VkKeyScanW，检查几个常用的能解析
        for k in ["-", "=", "[", "]", ";", ",", ".", "/", "\\", "`"] {
            assert!(key_to_scancode(k).is_some(), "符号 {k} 应该认识");
        }
    }

    #[test]
    fn parse_combo_extended_correct() {
        // 扩展键标记必须正确 —— 错了游戏里方向键会变成小键盘数字
        let v = parse_keys("up").unwrap();
        assert!(v[0].2, "up 应该是扩展键");
        let v = parse_keys("w").unwrap();
        assert!(!v[0].2, "字母键不是扩展键");
        let v = parse_keys("delete").unwrap();
        assert!(v[0].2, "delete 应该是扩展键");
    }

    #[test]
    fn dhash_uniform_is_zero() {
        // 纯色画面：所有块亮度相同 → 没有「左>右」→ hash 全 0
        let w = 90;
        let h = 80;
        let stride = w * 4;
        let buf = vec![128u8; stride * h];
        let hsh = dhash_from_bgra(&buf, w, h, stride);
        assert_eq!(hsh, "0000000000000000");
    }

    #[test]
    fn dhash_gradient_is_not_zero() {
        // 从左到右变亮的渐变 → 每行都是「左<右」→ 全 0？
        // 反过来：左亮右暗 → 全 1
        let w = 90;
        let h = 80;
        let stride = w * 4;
        let mut buf = vec![0u8; stride * h];
        for y in 0..h {
            for x in 0..w {
                let p = y * stride + x * 4;
                let v = (255 - (x * 255 / w)) as u8;   // 左边亮
                buf[p] = v;
                buf[p + 1] = v;
                buf[p + 2] = v;
            }
        }
        let hsh = dhash_from_bgra(&buf, w, h, stride);
        assert_eq!(hsh, "ffffffffffffffff", "左亮右暗应该全 1，实际 {hsh}");
    }

    #[test]
    fn dhash_is_stable() {
        // 同一个 buffer 两次算出来必须一样（dHash 的底线要求）
        let w = 90;
        let h = 80;
        let stride = w * 4;
        let mut buf = vec![0u8; stride * h];
        for i in 0..buf.len() {
            buf[i] = (i % 251) as u8;
        }
        let a = dhash_from_bgra(&buf, w, h, stride);
        let b = dhash_from_bgra(&buf, w, h, stride);
        assert_eq!(a, b);
        assert_eq!(a.len(), 16);
    }
}


// ── 后台键盘（PostMessage，2026-11-14 五十三轮 P0 实测推翻旧结论）────────────
//
// ⚠ 此前的认知是「GLFW 键盘只认焦点窗口（必须 SendInput）」—— **实测是反的**：
//   本机 Minecraft 1.21.1（GLFW30 窗口）在**前台且键盘焦点都在它身上**时，
//   SendInput 按 W/E/F3 **一个都不生效**（画面 3 秒内还在动，说明游戏在跑），
//   而 PostMessage(WM_KEYDOWN/WM_CHAR) 发 `/time query daytime` **立刻生效**。
//   结论：GLFW 会丢弃注入式输入（SendInput 的 LLKHF_INJECTED），但正常处理投递消息。
//
// 于是游戏输入应该走这条：**后台、不抢焦点、不动用户鼠标**。
// 这也解释了为什么之前「切食物按 2」从来没真的生效过。
pub fn resolve_target_hwnd(target: &str) -> Result<HWND, String> {
    if let Ok(h) = target.trim().parse::<i64>() {
        return Ok(HWND(h as *mut _));
    }
    let wins = list_windows(target, 8);
    match wins.iter().find(|w| !w.iconic).or_else(|| wins.first()) {
        Some(w) => Ok(HWND(w.hwnd as *mut _)),
        None => Err(format!("没找到窗口：{target}")),
    }
}

/// 只按下 / 只松开（投递方式，后台可用）。
pub fn post_key_state(target: &str, combo: &str, down: bool) -> Result<u32, String> {
    let codes = parse_keys(combo)?;
    let hwnd = resolve_target_hwnd(target)?;
    let mut n = 0u32;
    for (_name, sc, ext) in codes {
        // lParam：bit0-15 重复次数=1；bit16-23 扫描码；bit24 扩展键；
        //         WM_KEYUP 还要 bit30(上一状态=按下) + bit31(转换=松开)
        let mut vk = unsafe { MapVirtualKeyW(sc as u32, MAPVK_VSC_TO_VK_EX) } as usize;
        if vk == 0 {
            vk = unsafe { MapVirtualKeyW(sc as u32, windows::Win32::UI::Input::KeyboardAndMouse::MAPVK_VSC_TO_VK) } as usize;
        }
        if vk == 0 {
            return Err(format!("扫描码 0x{:02X} 转不出虚拟键码", sc));
        }
        let mut lp: u32 = 1 | ((sc as u32) << 16);
        if ext { lp |= 1 << 24; }
        if !down { lp |= 0xC000_0000; }
        // SAFETY: 只投递消息，不持有句柄；参数按 Win32 lParam 布局拼装。
        let r = unsafe {
            PostMessageW(Some(hwnd), if down { WM_KEYDOWN } else { WM_KEYUP }, WPARAM(vk), LPARAM(lp as isize))
        };
        if r.is_err() {
            return Err(format!("PostMessage 失败（窗口可能已关闭或权限更高）"));
        }
        n += 1;
        std::thread::sleep(std::time::Duration::from_millis(12));
    }
    Ok(n)
}

/// 后台输入文字（WM_CHAR 逐字符；换行 → WM_KEYDOWN/WM_KEYUP VK_RETURN）。
pub fn post_text(target: &str, text: &str) -> Result<u32, String> {
    let hwnd = resolve_target_hwnd(target)?;
    let mut n = 0u32;
    for ch in text.chars() {
        if ch == '\n' || ch == '\r' {
            let lp: u32 = 1 | ((0x1Cu32) << 16);
            // SAFETY: 只投递消息。
            unsafe {
                let _ = PostMessageW(Some(hwnd), WM_KEYDOWN, WPARAM(0x0D), LPARAM(lp as isize));
                std::thread::sleep(std::time::Duration::from_millis(15));
                let _ = PostMessageW(Some(hwnd), WM_KEYUP, WPARAM(0x0D), LPARAM((lp | 0xC000_0000) as isize));
            }
        } else {
            let mut buf = [0u16; 2];
            let enc = ch.encode_utf16(&mut buf);
            for &cu in enc.iter() {
                // SAFETY: 只投递消息；WM_CHAR 的 wParam 是 UTF-16 码元。
                unsafe { let _ = PostMessageW(Some(hwnd), WM_CHAR, WPARAM(cu as usize), LPARAM(1)); }
                n += 1;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(12));
    }
    Ok(n)
}

// ── 窗口生命周期（2026-11-15 五十八轮）────────────────────────────────────
//
// 为什么补这一层：工具面此前只有「聚焦」和「启动」，**没有**最小化 / 最大化 / 还原 /
// 移动 / 改尺寸 / 关闭 —— 日常最想说的「把这个窗口挪开」「最小化」「关掉」全都做不到。
// 更糟的是 JS 侧的「最小化全部」映射成 press_key win+d，又在 Win 键白名单处被直接
// REJECT（实测），那条路**从来就不可能成功**。
//
// 取舍三条：
// · close 用 PostMessageW(WM_CLOSE)，不用 TerminateProcess —— 关闭窗口应该等于用户点 X，
//   让应用自己决定（可能弹保存对话框）。强杀会丢未保存内容，那是另一个动作。
// · move/size 用 SetWindowPos + SWP_NOACTIVATE —— 她挪窗口不该把用户正在打字的窗口抢到前台。
// · 每个 op 之后重读一次真实状态（iconic/rect）再返回，别让「返回 ok」代替「真的成了」。

#[derive(Debug, Clone, Serialize)]
pub struct WindowOpResult {
    pub ok: bool,
    pub hwnd: i64,
    pub title: String,
    pub op: String,
    pub iconic: bool,
    /// 动作完成后的最大化状态（便于调用方还原「原本是最大化」的窗口）
    pub maximized: bool,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    /// all_min 时 = 最小化了几个窗口
    pub count: usize,
    pub error: Option<String>,
    /// 动作成了但有一条要人看的话（例如「目标是最小化态，几何改动可能不生效」）
    pub warning: Option<String>,
}

fn win_rect_of(hwnd: HWND) -> (i32, i32, i32, i32) {
    let mut r = RECT::default();
    // SAFETY: GetWindowRect 对无效句柄只返回失败（0），不写越界内存。
    let _ = unsafe { GetWindowRect(hwnd, &mut r) };
    (r.left, r.top, r.right - r.left, r.bottom - r.top)
}

/// 目标解析：hwnd（纯数字且真是窗口）→ pid（纯数字）→ 标题子串（与 focus 同一套规则）
fn resolve_hwnd(target: &str) -> Result<(HWND, String), String> {
    let t = target.trim();
    if t.is_empty() {
        return Err("缺少 target（窗口标题子串 / hwnd / pid）".to_string());
    }
    if let Ok(n) = t.parse::<i64>() {
        let cand = HWND(n as *mut _);
        let mut buf = [0u16; 512];
        // SAFETY: 无效句柄只返回 0 长度。
        let len = unsafe { GetWindowTextW(cand, &mut buf) };
        let title = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
        // SAFETY: IsWindow 对任意值安全。
        if unsafe { IsWindow(Some(cand)).as_bool() } && !title.is_empty() {
            return Ok((cand, title));
        }
        let pid = n as u32;
        let wins = list_windows("", 400);
        let pick = wins.iter().filter(|w| w.pid == pid && !w.title.is_empty())
            .find(|w| !w.iconic)
            .or_else(|| wins.iter().find(|w| w.pid == pid && !w.title.is_empty()));
        return match pick {
            Some(w) => Ok((HWND(w.hwnd as *mut _), w.title.clone())),
            None => Err(format!("没找到窗口：{target}（既不是有效 hwnd，也没有 pid={pid} 的可见窗口）")),
        };
    }
    let wins = list_windows(t, 8);
    let pick = wins.iter().find(|w| !w.iconic).or_else(|| wins.first());
    match pick {
        Some(w) => Ok((HWND(w.hwnd as *mut _), w.title.clone())),
        None => Err(format!("没找到窗口：{target}")),
    }
}

/// 窗口生命周期操作。op ∈ min | max | restore | close | move | size | all_min
pub fn window_op(
    target: &str,
    op: &str,
    x: Option<i32>,
    y: Option<i32>,
    w: Option<i32>,
    h: Option<i32>,
) -> WindowOpResult {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SetWindowPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
        SW_MAXIMIZE, SW_MINIMIZE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WM_CLOSE,
    };

    let mut res = WindowOpResult {
        ok: false, hwnd: 0, title: String::new(), op: op.to_string(),
        iconic: false, maximized: false, x: 0, y: 0, w: 0, h: 0, count: 0, error: None, warning: None,
    };

    // 「最小化全部」不针对单个窗口：枚举所有可见顶层窗口逐个最小化。
    // target 非空时**只最小化标题匹配的那些** —— 既能验，也不会把用户正在看的视频一起收走。
    if op == "all_min" {
        let wins = list_windows(target, 400);
        let me = std::process::id();
        let mut n = 0usize;
        for win in wins.iter() {
            if win.pid == me || win.iconic || win.title.is_empty() {
                continue;
            }
            let hw = HWND(win.hwnd as *mut _);
            // SAFETY: ShowWindow 对无效句柄只返回 false。
            unsafe { let _ = ShowWindow(hw, SW_MINIMIZE); }
            n += 1;
        }
        res.count = n;
        res.ok = n > 0;
        if n == 0 {
            res.error = Some("没有可最小化的可见窗口".to_string());
        }
        return res;
    }

    let (hwnd, title) = match resolve_hwnd(target) {
        Ok(v) => v,
        Err(e) => { res.error = Some(e); return res; },
    };
    res.hwnd = hwnd.0 as i64;
    res.title = title;

    // 最小化/最大化态下改几何：实测 Windows 会把 SetWindowPos 作用到 (-32000,-32000)
    // 伪坐标或忽略 move（最大化窗口只改 restore bounds）——「ok 但位置错了」比报错更糟。
    // 2026-11-15 先自动还原最小化；2026-11-21 审计补最大化（IsZoomed）。
    // SAFETY: IsIconic / IsZoomed 只读状态。
    let pre_iconic = unsafe { IsIconic(hwnd).as_bool() };
    let pre_max = unsafe { IsZoomed(hwnd).as_bool() };
    let mut auto_restored = false;
    if (pre_iconic || pre_max) && (op == "move" || op == "size") {
        // SAFETY: ShowWindow 对无效 hwnd 只返回 false，不崩。
        unsafe { let _ = ShowWindow(hwnd, SW_RESTORE); }
        std::thread::sleep(std::time::Duration::from_millis(80));
        auto_restored = true;
    }

    let action = (|| -> Result<(), String> {
        match op {
            // SAFETY: 以下全是窗口管理 API；对无效 hwnd 返回失败码/BOOLean，不崩。
            "min" => { unsafe { let _ = ShowWindow(hwnd, SW_MINIMIZE); } }
            "max" => { unsafe { let _ = ShowWindow(hwnd, SW_MAXIMIZE); } }
            "restore" => { unsafe { let _ = ShowWindow(hwnd, SW_RESTORE); } }
            "close" => {
                // 用 WM_CLOSE 让应用自己走关闭流程（可能弹「要保存吗」）
                unsafe { let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)); }
            }
            "move" => {
                let nx = x.ok_or_else(|| "move 需要 x".to_string())?;
                let ny = y.ok_or_else(|| "move 需要 y".to_string())?;
                // 护栏（2026-11-15 立；2026-11-21 根因修复）。
                //
                // 旧判据：标题栏抓取点 (x+40, y+10) 必须落在虚拟屏幕内。
                // 它把**最大化窗口**的合法负原点判成越界 —— 最大化窗口 GetWindowRect
                // 是 (-11,-11)（边框在屏幕外），y+10 = -1 < 0，于是 move 必然失败，
                // 测试里表现为 `rect=undefined` / 「已还原现场」永远差几个像素。
                //
                // 护栏的本意只有一条：**别把窗口挪到看不见的地方**（-32000 是最小化窗口
                // 的伪坐标，调用方拿它当「原位置」加减就会把窗口弄丢）。所以：
                //   ① 直接拒绝 -30000 以下的哨兵坐标（这才是要防的东西）；
                //   ② 其余情况按「目标矩形 ∩ 虚拟屏幕」是否留下 ≥40×10 的可抓区判断
                //      —— 负原点的最大化窗口交集巨大，自然放行；真挪到屏幕外则交集不足。
                if nx <= -30000 || ny <= -30000 {
                    return Err(format!(
                        "拒绝把窗口挪到哨兵坐标 ({nx},{ny})：-32000 是最小化窗口的伪坐标，不是真实位置"
                    ));
                }
                // SAFETY: GetWindowRect 对无效句柄只返回错误、不写越界内存；失败按 1×1 处理。
                let (cur_w, cur_h) = unsafe {
                    let mut r = RECT::default();
                    match GetWindowRect(hwnd, &mut r) {
                        Ok(()) => ((r.right - r.left).max(1), (r.bottom - r.top).max(1)),
                        Err(_) => (1, 1),
                    }
                };
                // SAFETY: GetSystemMetrics 只读系统数值。
                let (vx, vy, vw, vh) = unsafe {
                    (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN),
                     GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN))
                };
                if vw > 0 && vh > 0 {
                    let left = nx.max(vx);
                    let top = ny.max(vy);
                    let right = (nx + cur_w).min(vx + vw);
                    let bottom = (ny + cur_h).min(vy + vh);
                    let inter_w = right - left;
                    let inter_h = bottom - top;
                    // 40×10 = 能点到标题栏的最小可见面积；完全在屏幕外时交集为负/零。
                    if inter_w < 40 || inter_h < 10 {
                        return Err(format!(
                            "拒绝把窗口挪出屏幕：目标 ({nx},{ny}) 尺寸 {cur_w}×{cur_h}，与虚拟屏幕 \
                             ({vx},{vy}) {vw}×{vh} 的可抓交集只有 {inter_w}×{inter_h}（需 ≥40×10）"
                        ));
                    }
                }
                unsafe {
                    SetWindowPos(hwnd, None, nx, ny, 0, 0,
                        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
                }.map_err(|e| format!("SetWindowPos 失败：{e}"))?;
            }
            "size" => {
                let nw = w.ok_or_else(|| "size 需要 w".to_string())?;
                let nh = h.ok_or_else(|| "size 需要 h".to_string())?;
                if nw <= 0 || nh <= 0 {
                    return Err("size 的 w/h 必须 > 0".to_string());
                }
                unsafe {
                    SetWindowPos(hwnd, None, 0, 0, nw, nh,
                        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE)
                }.map_err(|e| format!("SetWindowPos 失败：{e}"))?;
            }
            other => return Err(format!("不认识的 op：{other}（min|max|restore|close|move|size|all_min）")),
        }
        Ok(())
    })();

    if let Err(e) = action {
        res.error = Some(e);
        return res;
    }

    // 复核：等窗口处理完消息再读真实状态（min/max 是异步的，立刻读会读到旧值）
    std::thread::sleep(std::time::Duration::from_millis(120));
    // SAFETY: 同上，读状态只返回数值。
    res.iconic = unsafe { IsIconic(hwnd).as_bool() };
    res.maximized = unsafe { IsZoomed(hwnd).as_bool() };
    let (rx, ry, rw, rh) = win_rect_of(hwnd);
    res.x = rx; res.y = ry; res.w = rw; res.h = rh;
    if (pre_iconic || pre_max) && (op == "move" || op == "size") {
        // 不吞：调用方要能看出「这条 ok 的含金量低」（我们替它做了 restore）
        res.warning = Some(if auto_restored {
            "目标当时是最小化/最大化状态：已先自动还原再改几何".to_string()
        } else {
            "目标当时是最小化/最大化状态：几何改动可能被 Windows 忽略，先 restore 再改更可靠".to_string()
        });
    }
    // 2026-11-21 审计（P2）：min / restore / close 必须**回读断言**，不能把
    // 「ShowWindow/PostMessage 没报错」当成「窗口真的变了」。
    // 实测旧行为：
    //   · min：已最小化或被应用拒绝时 ShowWindow 返回 false，但旧代码仍 ok=true；
    //   · restore：同理，iconic 没变也 ok；
    //   · close：WM_CLOSE 是「请求」，应用可能弹「要保存吗」——窗口还开着也报 ok。
    // close 的成功判据只能是 IsWindow=false（轮询 ≤1s，给应用走完关闭流程的时间）。
    match op {
        "min" => {
            if !res.iconic {
                res.ok = false;
                res.error = Some(
                    "min 没生效：已调用 ShowWindow(SW_MINIMIZE)，但回读 IsIconic=false \
                     （窗口可能被应用拒绝最小化，或句柄已失效）"
                        .to_string(),
                );
                return res;
            }
        }
        "restore" => {
            if res.iconic {
                res.ok = false;
                res.error = Some(
                    "restore 没生效：已调用 ShowWindow(SW_RESTORE)，但回读 IsIconic=true \
                     （窗口仍是最小化；可能被应用/系统策略挡住）"
                        .to_string(),
                );
                return res;
            }
        }
        "close" => {
            // 轮询预算固定 1000ms（从 WM_CLOSE 已投递后起算；上面的 120ms 是等消息处理）。
            let t0 = std::time::Instant::now();
            // SAFETY: IsWindow 对已销毁句柄安全返回 false。
            let mut gone = !unsafe { IsWindow(Some(hwnd)).as_bool() };
            while !gone && t0.elapsed() < std::time::Duration::from_millis(1000) {
                std::thread::sleep(std::time::Duration::from_millis(50));
                gone = !unsafe { IsWindow(Some(hwnd)).as_bool() };
            }
            if !gone {
                res.ok = false;
                res.error = Some(
                    "close 没生效：WM_CLOSE 已投递并轮询 1000ms，窗口仍然存在（IsWindow=true）。\
                     可能有未保存内容，应用弹出了保存/确认对话框；请先处理对话框再重试，\
                     或让用户自己关闭（不要强杀，强杀会丢数据）"
                        .to_string(),
                );
                return res;
            }
            // 窗口已消失：死句柄的矩形/状态没有意义，清零避免调用方当成真实位置。
            res.x = 0;
            res.y = 0;
            res.w = 0;
            res.h = 0;
            res.iconic = false;
            res.maximized = false;
        }
        _ => {}
    }
    // 2026-11-21 审计（P1）：几何改动必须回读验证，不能只看 SetWindowPos 返回 true。
    // 实测记事本被贴边/最大化时 move 返回 ok 但矩形纹丝不动（eval window_move_size 抓到）。
    // 容差 4px：DWM 边框舍入；超过就判失败并说清楚，而不是把「没动」报成成功。
    if op == "move" || op == "size" {
        let tol = 4i32;
        let mut mismatch: Option<String> = None;
        if op == "move" {
            if let (Some(wx), Some(wy)) = (x, y) {
                if (rx - wx).abs() > tol || (ry - wy).abs() > tol {
                    mismatch = Some(format!(
                        "move 没生效：要求 ({wx},{wy})，实际 ({rx},{ry})（窗口可能被贴边/最大化/应用限制）"
                    ));
                }
            }
        } else if op == "size" {
            if let (Some(ww), Some(wh)) = (w, h) {
                if (rw - ww).abs() > tol || (rh - wh).abs() > tol {
                    mismatch = Some(format!(
                        "size 没生效：要求 {ww}×{wh}，实际 {rw}×{rh}（窗口可能被贴边/最大化/应用限制）"
                    ));
                }
            }
        }
        if let Some(msg) = mismatch {
            res.ok = false;
            res.error = Some(msg);
            return res;
        }
    }
    res.ok = true;
    res
}

// ── 世界感知（2026-11-17 六十二轮 · Phase 1）─────────────────────────────
//
// 为什么集中在这里：世界感知要的四样便宜源（前台/进程名、空闲、媒体会话、
// 窗口是否全屏）全都是「每秒读一次」的 Win32/WinRT 调用。分成四个命令 =
// 四次跨进程往返；合成一个 world 快照 = 一次（常驻 serve 单次约 1ms）。
//
// **这里不认识任何具体应用**：没有应用名单、没有游戏名单。判断「在干什么」
// 是上层状态机的活（js/core/world-store.js），本文件只报告事实。
//
// 为什么进程名要单独给：窗口标题会随内容变（"main.js - Visual Studio Code"），
// 进程名稳定。上层拿进程名做「还是同一个应用」的比较，拿标题做「在这个应用里
// 干什么」的判断 —— 两件事必须分开。

/// 前台进程可执行文件名（不带路径、不带 .exe、小写；取不到返回空串）。
pub fn process_app_name(pid: u32) -> String {
    if pid == 0 { return String::new(); }
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::core::PWSTR;
    // SAFETY: OpenProcess 拿到的句柄下面一定 CloseHandle；缓冲区长度按 API 返回的 size 截。
    unsafe {
        let h = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => h,
            Err(_) => return String::new(),
        };
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
        let _ = CloseHandle(h);
        if !ok || size == 0 { return String::new(); }
        let full = String::from_utf16_lossy(&buf[..(size as usize).min(buf.len())]);
        let base = full.rsplit(['\\', '/']).next().unwrap_or("");
        let stem = match base.rsplit_once('.') { Some((a, _)) => a, None => base };
        stem.to_ascii_lowercase()
    }
}

/// 窗口是否铺满它所在显示器的全部区域（无边框全屏 / 独占全屏都是）。
/// 用途：给「在看视频」还是「在桌面干活」提供一个通用线索（不认具体应用）。
pub fn window_fullscreen(hwnd: i64) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetWindowRect;
    if hwnd == 0 { return false; }
    // SAFETY: 两个结构都是 POD；HWND 由调用方给的是本进程刚读到的前台句柄。
    unsafe {
        let h = HWND(hwnd as *mut core::ffi::c_void);
        let mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
        if mon.is_invalid() { return false; }
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut mi).as_bool() { return false; }
        let mut r = RECT::default();
        if GetWindowRect(h, &mut r).is_err() { return false; }
        // 容差 2px：部分游戏/浏览器全屏比显示器小 1-2px（DPI 取整）
        let mon_w = mi.rcMonitor.right - mi.rcMonitor.left;
        let mon_h = mi.rcMonitor.bottom - mi.rcMonitor.top;
        let win_w = r.right - r.left;
        let win_h = r.bottom - r.top;
        (win_w - mon_w).abs() <= 2 && (win_h - mon_h).abs() <= 2
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct MediaRec {
    pub ok: bool,
    /// 播放器进程（AUMID 或 exe 名，小写）
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// playing / paused / stopped / closed / changing / unknown
    pub status: String,
    pub position_ms: i64,
    pub duration_ms: i64,
    /// 失败时的原因（ok=false 时有值）；正常为空
    pub reason: String,
    /// 缓存年龄（ms）：world 采样读后台线程的缓存，不是当场 COM 往返。
    /// 2026-11-21：有活动媒体时 media_now() 要 150–200ms，而 world 每秒采样 ——
    /// 同步调用把采样预算打穿（实测 237ms/sample），改为后台刷新 + 读缓存。
    pub age_ms: u64,
}

/// 等一个 WinRT 异步操作完成（windows 0.62 的 IAsyncOperation 没有阻塞 get()）。
///
/// 为什么要自己写：`.get()` 在 windows-future 0.3 里被删了，只剩 Future 实现；
/// 而这个进程是同步的单行协议循环，没有 async runtime。用 SetCompleted + 通道等
/// 是最直接的桥。**必须带超时**：SMTC 正常 1–10ms 完成，卡住时不能让整个
/// world 命令挂死（上层每秒调一次）。
fn smtc_block<T>(op: &windows_future::IAsyncOperation<T>) -> Result<T, String>
where
    T: windows::core::RuntimeType + 'static,
{
    use windows_future::{AsyncOperationCompletedHandler, AsyncStatus};
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    op.SetCompleted(&AsyncOperationCompletedHandler::new(move |_op, _st| {
        let _ = tx.send(());
        Ok(())
    }))
    .map_err(|e| format!("SetCompleted: {e}"))?;
    let _ = rx.recv_timeout(std::time::Duration::from_millis(1500));
    let st = op.Status().map_err(|e| format!("Status: {e}"))?;
    if st != AsyncStatus::Completed {
        return Err(format!("异步未完成（{st:?}）"));
    }
    op.GetResults().map_err(|e| format!("GetResults: {e}"))
}

/// 读系统媒体会话（SMTC）：在听/在看什么、放没放。
///
/// 为什么用 SMTC 而不是解析窗口标题：标题解析要求「播放器把歌名写进标题」，
/// 浏览器播放时标题可能是任意标签页；SMTC 是系统给的**结构化**事实
/// （应用 / 标题 / 歌手 / 播放状态 / 进度），且对所有合规播放器一致。
pub fn media_now() -> MediaRec {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;

    let mut rec = MediaRec::default();

    // WinRT 的异步调用需要 COM 已初始化；MTA 可重入（已初始化时返回 S_FALSE，也算成功）。
    // SAFETY: CoInitializeEx/CoUninitialize 成对；即使别的分支已初始化过，引用计数也会正确回落。
    struct ComGuard(bool);
    impl Drop for ComGuard {
        fn drop(&mut self) { if self.0 { unsafe { windows::Win32::System::Com::CoUninitialize(); } } }
    }
    let com_ok = unsafe {
        windows::Win32::System::Com::CoInitializeEx(
            None,
            windows::Win32::System::Com::COINIT_MULTITHREADED,
        ).is_ok()
    };
    let _guard = ComGuard(com_ok);

    // SAFETY: 拿到的都是 WinRT 接口对象，Rust 侧只读属性；失败一律降级成 ok=false。
    let inner = (|| -> Result<MediaRec, String> {
        let op = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()
            .map_err(|e| format!("RequestAsync: {e}"))?;
        let mgr = smtc_block(&op).map_err(|e| format!("await manager: {e}"))?;
        let sess = mgr.GetCurrentSession().map_err(|e| format!("无媒体会话: {e}"))?;

        let mut out = MediaRec { ok: true, ..Default::default() };
        out.app = sess.SourceAppUserModelId().map(|s| s.to_string().to_ascii_lowercase()).unwrap_or_default();

        let props = sess.TryGetMediaPropertiesAsync()
            .map_err(|e| format!("TryGetMediaProperties: {e}"))
            .and_then(|op| smtc_block(&op));
        if let Ok(props) = props {
            out.title = props.Title().map(|s| s.to_string()).unwrap_or_default();
            out.artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
            out.album = props.AlbumTitle().map(|s| s.to_string()).unwrap_or_default();
        }

        if let Ok(info) = sess.GetPlaybackInfo() {
            // 注意：这个枚举的 Debug 会打出结构体名（globalsystemmediatransportcontrolssessionplaybackstatus(4)），
            // 不能直接 format!("{s:?}") —— 上层要的是稳定短标记，所以按数值映射。
            out.status = info.PlaybackStatus()
                .map(|s| match s.0 {
                    0 => "closed", 1 => "opened", 2 => "changing",
                    3 => "stopped", 4 => "playing", 5 => "paused",
                    _ => "unknown",
                }.to_string())
                .unwrap_or_else(|_| "unknown".into());
        }
        // 进度/总长只能从 Timeline 拿（PlaybackInfo 只有播放状态/速率/循环模式）
        if let Ok(tl) = sess.GetTimelineProperties() {
            if let Ok(p) = tl.Position() { if p.Duration > 0 { out.position_ms = p.Duration / 10_000; } }
            out.duration_ms = tl.EndTime().map(|t| t.Duration / 10_000).unwrap_or(0);
        }
        Ok(out)
    })();

    match inner {
        Ok(r) => r,
        Err(e) => { rec.ok = false; rec.reason = e; rec.status = "none".into(); rec }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct FgRec {
    pub ok: bool,
    pub hwnd: i64,
    pub title: String,
    pub pid: u32,
    /// 可执行文件名（小写、无 .exe）；取不到为空
    pub app: String,
    pub class: String,
    pub fullscreen: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WorldSnapshot {
    pub ok: bool,
    pub fg: FgRec,
    pub idle_ms: u64,
    pub media: MediaRec,
    /// 这一拍本身花了多少微秒（成本可观测）
    pub us: u64,
}

/// SMTC 后台缓存（2026-11-21）：采样绝不阻塞在 COM/WinRT 往返上。
static MEDIA_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<(std::time::Instant, MediaRec)>>> =
    std::sync::OnceLock::new();

fn media_cache() -> &'static std::sync::Mutex<Option<(std::time::Instant, MediaRec)>> {
    MEDIA_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

/// 起一个后台线程，每 3s 刷新 SMTC。serve 模式启动时调用一次。
pub fn media_poller_start() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::spawn(|| loop {
            let rec = media_now();
            if let Ok(mut g) = media_cache().lock() {
                *g = Some((std::time::Instant::now(), rec));
            }
            std::thread::sleep(std::time::Duration::from_millis(3000));
        });
    });
}

/// 读缓存；缓存为空时同步刷新一次（CLI 一次性调用/刚启动时）。
pub fn media_cached() -> MediaRec {
    let hit = media_cache().lock().ok().and_then(|g| g.clone());
    if let Some((at, mut rec)) = hit {
        rec.age_ms = at.elapsed().as_millis() as u64;
        return rec;
    }
    let rec = media_now();
    if let Ok(mut g) = media_cache().lock() {
        *g = Some((std::time::Instant::now(), rec.clone()));
    }
    rec
}

/// 一次拿全「世界快照」：前台（窗口+进程+全屏）、用户空闲、媒体会话。
/// 失败是逐项降级，不整包失败 —— 世界感知缺一项也要能工作。
/// `with_media=false` 跳过 SMTC（低功耗模式：连 WinRT 往返都不要）。
pub fn world_snapshot(with_media: bool) -> WorldSnapshot {
    let t0 = std::time::Instant::now();
    let mut snap = WorldSnapshot { ok: true, ..Default::default() };

    let (ok, hwnd, title) = foreground();
    let pid = foreground_pid();
    let mut fg = FgRec { ok, hwnd, title, pid, ..Default::default() };
    if ok {
        fg.app = process_app_name(pid);
        fg.fullscreen = window_fullscreen(hwnd);
        fg.class = unsafe {
            let mut buf = [0u16; 256];
            let n = GetClassNameW(HWND(hwnd as *mut core::ffi::c_void), &mut buf);
            String::from_utf16_lossy(&buf[..n.max(0) as usize])
        };
    }
    snap.fg = fg;
    snap.idle_ms = user_idle_ms();
    if with_media {
        snap.media = media_cached();
    } else {
        snap.media = MediaRec { status: "skipped".into(), ..Default::default() };
    }
    snap.us = t0.elapsed().as_micros() as u64;
    snap
}
