//! WGC（Windows.Graphics.Capture）采集 → dHash / 存图（2026-11-09 三十五轮，
//! 三十六轮加 `wgc_shot`：把合成表面存成 BMP，让她能真的「看到」窗口内容）
//!
//! 为什么需要第二种采集后端：
//!   当前 GDI BitBlt 方案有两个硬限制：
//!   ① **截不到被遮挡的部分** —— BitBlt 从屏幕 DC 读，被别的窗口盖住就拿到别人的像素
//!   ② 全屏读 14.7MB 像素（2560×1440），40ms 里约 30ms 是这部分
//!
//!   WGC 按 **HWND** 采集（DWM 直接从窗口的合成表面读），所以：
//!   · **能抓到被遮挡窗口的内容**
//!   · GPU 侧取像素，不需要读整屏
//!
//! 硬限制（Windows 的，不是我们的）：
//!   · **最小化窗口抓不到**（DWM 不合成）—— 这一点和 BitBlt 一样没办法
//!   · 需要 Windows 10 1903+（本机 22631，没问题）
//!
//! 实现路径：
//!   D3D11CreateDevice → ID3D11Device
//!     → IDXGIDevice → CreateDirect3D11DeviceFromDXGIDevice → IDirect3DDevice
//!   IGraphicsCaptureItemInterop::CreateForWindow(hwnd) → GraphicsCaptureItem
//!   Direct3D11CaptureFramePool::CreateFreeThreaded(B8G8R8A8, 2 buffers, size)
//!     → StartCapture() → TryGetNextFrame() 循环等一帧
//!   frame.Surface() → IDirect3DDxgiInterfaceAccess → ID3D11Texture2D
//!     → 建 staging texture（CPU_READ）→ CopyResource → Map
//!   → 逐行拷成紧排 BGRA（stride = width*4）→ 算 dHash / 写 BMP
//!
//! 为什么不订阅 `FrameArrived` 事件：
//!   ⚠ 这里原来的注释是**错的**（2026-11-14 调研纠正）：「FrameArrived 需要消息泵」
//!   只对 `Create()` 成立；我们用的是 **`CreateFreeThreaded()`** —— 它是 agile 对象，
//!   回调跑在线程池线程上，**不需要消息泵**。所以理论上可以改成纯事件驱动。
//!   现在仍用 `TryGetNextFrame()` 轮询的原因：串行 CLI 的请求-响应模型更简单，
//!   且实测空转一次 <0.2ms（间隔 2ms）。真要榨最后几毫秒再上事件 + channel。
//!
//! 为什么 `wgc_shot` 存 BMP 而不是 PNG：
//!   WGC 拿到的就是 **BGRA 32bpp**，而 Windows BMP 的 `BI_RGB` + 32bpp 正好就是
//!   BGRA 的存储顺序（小端 0xAARRGGBB → 字节 B,G,R,A）→ **零转换、零依赖**。
//!   Cargo.toml 里没有 image/png/flate2，加依赖要联网下载（有失败风险），
//!   而 BMP 是 PIL、Windows 看图器、浏览器都能直接打开的无损位图。
//!   ⚠ BMP 32bpp 的第 4 字节（alpha）多数看图器会忽略，但 PIL 读出来是 RGBA
//!     （alpha 恒为 0，因为 DWM 合成表面不带 alpha）—— 这是预期行为，按 RGB 看即可。

#![cfg(target_os = "windows")]

use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use windows::core::{factory, Interface};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::System::WinRT::Direct3D11::IDirect3DDxgiInterfaceAccess;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, GetWindowRect};

use crate::native;

#[derive(Debug, Clone, Serialize)]
pub struct WgcHashResult {
    pub ok: bool,
    pub hash: String,
    pub width: i32,
    pub height: i32,
    /// 等了几个空帧才拿到（0 = 第一次就拿到）
    pub frames_waited: u32,
    pub us_total: u64,
    pub us_wait: u64,
    pub us_readback: u64,
    /// 9×8 灰度矩阵（诊断用：能直接看出「抓到的是什么画面」）
    pub gray: Vec<u8>,
    pub error: Option<String>,
}

/// `wgc_shot` 的结果：WGC 抓一帧 → 存 BMP → 返回路径/尺寸/字节数/dHash。
#[derive(Debug, Clone, Serialize)]
pub struct WgcShotResult {
    pub ok: bool,
    /// 落盘路径（`out_path` 为空时自动生成到 %TEMP%\pet-wgc\）
    pub path: String,
    pub width: i32,
    pub height: i32,
    /// BMP 文件总字节数（54 字节头 + w*h*4 像素）
    pub bytes: u64,
    /// 顺手复用 dHash —— 方便和 `wgc_hash` 交叉验收「存的图和哈希是同一画面」
    pub hash: String,
    pub frames_waited: u32,
    pub us_total: u64,
    pub error: Option<String>,
}

/// 一次 WGC 采集拿到的像素：**紧排 BGRA，行距 = width*4，自上而下**。
///
/// 为什么要在 `capture_bgra` 里就拷成紧排：
///   · staging texture 的 `RowPitch` 可能 > width*4（D3D11 的对齐要求），
///     而 BMP 像素数据要求行距**正好** width*4 —— 必须逐行拷，不能整体 memcpy；
///   · `Map` 出来的指针在 `Unmap` / 对象释放后就失效，不能带出函数。
pub struct CapturedFrame {
    pub pixels: Vec<u8>,
    pub width: i32,
    pub height: i32,
    pub frames_waited: u32,
    pub us_wait: u64,
    /// GPU→CPU 回读（Surface → Map → 逐行拷）耗时
    pub us_readback: u64,
}

/// 用 WGC 抓一个窗口并算 dHash。
///
/// `target`：窗口标题子串或 hwnd 数字。
/// `capture_client_only`：true = 只抓客户区（不含标题栏）。
pub fn wgc_dhash(target: &str, capture_client_only: bool, max_wait_ms: u32) -> WgcHashResult {
    let t0 = std::time::Instant::now();
    let mut res = WgcHashResult {
        ok: false, hash: String::new(), width: 0, height: 0,
        frames_waited: 0, us_total: 0, us_wait: 0, us_readback: 0,
        gray: Vec::new(), error: None,
    };

    let hwnd = match resolve_and_check(target) {
        Ok(h) => h,
        Err(e) => {
            res.error = Some(e);
            res.us_total = t0.elapsed().as_micros() as u64;
            return res;
        }
    };

    let _com = match init_com() {
        Ok(g) => g,
        Err(e) => {
            res.error = Some(e);
            res.us_total = t0.elapsed().as_micros() as u64;
            return res;
        }
    };

    match capture_bgra(hwnd, capture_client_only, max_wait_ms) {
        Ok(f) => {
            res.width = f.width;
            res.height = f.height;
            res.frames_waited = f.frames_waited;
            res.us_wait = f.us_wait;
            res.us_readback = f.us_readback;
            let w = f.width as usize;
            let h = f.height as usize;
            let stride = w * 4; // 紧排
            // 算 dHash（复用 native 的块平均算法）
            res.hash = native::dhash_from_rows(&f.pixels, w, h, stride);
            // 同时给出 9×8 灰度矩阵（诊断：直接看「抓到的是什么画面」）
            res.gray = native::gray_matrix_from_rows(&f.pixels, w, h, stride);
            res.ok = true;
        }
        Err(e) => res.error = Some(e),
    }

    res.us_total = t0.elapsed().as_micros() as u64;
    res
}

/// 用 WGC 抓一个窗口，把合成表面存成 BMP 文件。
///
/// `out_path` 为空 → 自动生成 `%TEMP%\pet-wgc\shot-<timestamp>.bmp`。
/// 返回的 `bytes` 是**文件总字节数**（可用 `fs::metadata(path).len()` 交叉核对）。
pub fn wgc_shot(
    target: &str,
    out_path: &str,
    capture_client_only: bool,
    max_wait_ms: u32,
) -> WgcShotResult {
    let t0 = std::time::Instant::now();
    let mut res = WgcShotResult {
        ok: false, path: String::new(), width: 0, height: 0, bytes: 0,
        hash: String::new(), frames_waited: 0, us_total: 0, error: None,
    };

    let hwnd = match resolve_and_check(target) {
        Ok(h) => h,
        Err(e) => {
            res.error = Some(e);
            res.us_total = t0.elapsed().as_micros() as u64;
            return res;
        }
    };

    let _com = match init_com() {
        Ok(g) => g,
        Err(e) => {
            res.error = Some(e);
            res.us_total = t0.elapsed().as_micros() as u64;
            return res;
        }
    };

    let frame = match capture_bgra(hwnd, capture_client_only, max_wait_ms) {
        Ok(f) => f,
        Err(e) => {
            res.error = Some(e);
            res.us_total = t0.elapsed().as_micros() as u64;
            return res;
        }
    };

    res.width = frame.width;
    res.height = frame.height;
    res.frames_waited = frame.frames_waited;
    let w = frame.width as usize;
    let h = frame.height as usize;
    let stride = w * 4;
    res.hash = native::dhash_from_rows(&frame.pixels, w, h, stride);

    let auto_path = out_path.trim().is_empty();
    let path = if auto_path {
        default_shot_path()
    } else {
        PathBuf::from(out_path.trim())
    };

    // 目录不存在就建（用户给了 D:/tmp/xx.bmp 这种多级路径时也能直接写）
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                res.error = Some(format!("创建目录失败（{}）：{e}", parent.display()));
                res.us_total = t0.elapsed().as_micros() as u64;
                return res;
            }
        }
    }

    match write_bmp(&path, &frame.pixels, frame.width, frame.height) {
        Ok(bytes) => {
            res.bytes = bytes;
            res.path = path.to_string_lossy().into_owned();
            res.ok = true;
            // 自动落盘后回收旧截图（只动 shot-*.bmp，保留最新 24 个，含刚写的这张）。
            if auto_path {
                if let Some(dir) = path.parent() { prune_old_shots(dir, 24); }
            }
        }
        Err(e) => res.error = Some(e),
    }

    res.us_total = t0.elapsed().as_micros() as u64;
    res
}

// ── 共享步骤 ──────────────────────────────────────────────────────────────

/// 找窗口 + 最小化前置检查。
///
/// `target` 是纯数字时当 hwnd 用，否则按标题子串枚举（优先非最小化的那个）。
/// 最小化窗口 DWM 不合成，WGC 拿不到 —— 直接拒绝，和 BitBlt 行为一致。
fn resolve_and_check(target: &str) -> Result<HWND, String> {
    let hwnd = if let Ok(h) = target.trim().parse::<i64>() {
        HWND(h as *mut _)
    } else {
        let wins = native::list_windows(target, 8);
        let pick = wins.iter().find(|w| !w.iconic).or_else(|| wins.first());
        match pick {
            Some(w) => HWND(w.hwnd as *mut _),
            None => return Err(format!("没找到窗口：{target}")),
        }
    };

    // SAFETY: IsIconic 对无效 hwnd 返回 false。
    unsafe {
        if windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd).as_bool() {
            return Err("窗口最小化了 —— WGC 抓不到最小化窗口（DWM 不合成），先 focus_window 恢复".into());
        }
    }
    Ok(hwnd)
}

/// COM 初始化（MTA —— 不需要消息泵），返回的 guard 在 drop 时 CoUninitialize。
fn init_com() -> Result<ComGuard, String> {
    // SAFETY: CoInitializeEx / CoUninitialize 成对（ComGuard）。
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!("CoInitializeEx 失败：{hr:?}"));
        }
    }
    Ok(ComGuard)
}

/// WGC 抓一帧并回读成紧排 BGRA。
///
/// 调用方必须先 `init_com()`（本函数内部的 WinRT 调用依赖 COM 已初始化）。
fn capture_bgra(
    hwnd: HWND,
    client_only: bool,
    max_wait_ms: u32,
) -> Result<CapturedFrame, String> {
    // SAFETY: 调用方已初始化 COM；所有 COM 对象在函数结束时释放。
    unsafe {
        // ── D3D11 设备 ────────────────────────────────────────────────
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        let hr = D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            Default::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        );
        if hr.is_err() {
            return Err(format!("D3D11CreateDevice 失败：{hr:?}"));
        }
        let device = device.ok_or("D3D11CreateDevice 没返回设备")?;
        let context = context.ok_or("D3D11CreateDevice 没返回上下文")?;

        // ID3D11Device → IDXGIDevice → IDirect3DDevice（WinRT）
        let dxgi_dev: IDXGIDevice = device.cast().map_err(|e| format!("cast IDXGIDevice 失败：{e}"))?;
        let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_dev)
            .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice 失败：{e}"))?;
        let winrt_device: IDirect3DDevice = inspectable
            .cast()
            .map_err(|e| format!("cast IDirect3DDevice 失败：{e}"))?;

        // ── 抓取项（按 HWND）─────────────────────────────────────────
        let interop: IGraphicsCaptureItemInterop =
            factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                .map_err(|e| format!("拿 IGraphicsCaptureItemInterop 失败：{e}"))?;
        let item: GraphicsCaptureItem = interop
            .CreateForWindow(hwnd)
            .map_err(|e| format!("CreateForWindow 失败：{e}"))?;

        // ── 尺寸 ──────────────────────────────────────────────────────
        let (w, h) = if client_only {
            let mut r = windows::Win32::Foundation::RECT::default();
            if GetClientRect(hwnd, &mut r).is_err() {
                return Err("GetClientRect 失败".into());
            }
            (r.right - r.left, r.bottom - r.top)
        } else {
            let mut r = windows::Win32::Foundation::RECT::default();
            if GetWindowRect(hwnd, &mut r).is_err() {
                return Err("GetWindowRect 失败".into());
            }
            (r.right - r.left, r.bottom - r.top)
        };
        if w <= 0 || h <= 0 {
            return Err(format!("窗口尺寸非法：{w}×{h}"));
        }

        // ── FramePool（FreeThreaded 版本：不要求 UI 线程 + 消息泵）────
        let size = SizeInt32 { Width: w, Height: h };
        // 2 个缓冲足够单帧读取；3 个更稳但多吃一份显存
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )
        .map_err(|e| format!("CreateFreeThreaded 失败：{e}"))?;

        let session = pool
            .CreateCaptureSession(&item)
            .map_err(|e| format!("CreateCaptureSession 失败：{e}"))?;

        // 不抓光标（dHash 不要光标 —— 光标闪动会造成噪音位；存图同理，光标不属于窗口内容）
        let _ = session.SetIsCursorCaptureEnabled(false);

        session
            .StartCapture()
            .map_err(|e| format!("StartCapture 失败：{e}"))?;

        // ── 等一帧（TryGetNextFrame 是同步的，轮询即可）─────────────
        let t_wait = std::time::Instant::now();
        let mut frame = None;
        let mut waited = 0u32;
        while (t_wait.elapsed().as_millis() as u32) < max_wait_ms {
            match pool.TryGetNextFrame() {
                Ok(f) => {
                    frame = Some(f);
                    break;
                }
                Err(_) => {
                    waited += 1;
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            }
        }
        let us_wait = t_wait.elapsed().as_micros() as u64;

        let Some(frame) = frame else {
            let _ = session.Close();
            let _ = pool.Close();
            return Err(format!("等了 {max_wait_ms}ms 没拿到帧（可能窗口被完全遮挡且未重新合成，或 DWM 未启用）"));
        };

        // ── 从 Surface 读像素 ────────────────────────────────────────
        let t_read = std::time::Instant::now();
        let surface = frame
            .Surface()
            .map_err(|e| format!("frame.Surface 失败：{e}"))?;
        let access: IDirect3DDxgiInterfaceAccess = surface
            .cast()
            .map_err(|e| format!("cast IDirect3DDxgiInterfaceAccess 失败：{e}"))?;
        let texture: ID3D11Texture2D = access
            .GetInterface()
            .map_err(|e| format!("GetInterface(ID3D11Texture2D) 失败：{e}"))?;

        // 源纹理描述（拿真实尺寸 —— 抓取帧可能和请求尺寸不同）
        let mut src_desc = D3D11_TEXTURE2D_DESC::default();
        texture.GetDesc(&mut src_desc);
        let tw = src_desc.Width as i32;
        let th = src_desc.Height as i32;
        if tw <= 0 || th <= 0 {
            let _ = frame.Close();
            let _ = session.Close();
            let _ = pool.Close();
            return Err(format!("抓取帧尺寸非法：{tw}×{th}"));
        }

        // staging texture（CPU 可读）
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: src_desc.Width,
            Height: src_desc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging: Option<ID3D11Texture2D> = None;
        device
            .CreateTexture2D(&staging_desc, None, Some(&mut staging))
            .map_err(|e| format!("CreateTexture2D(staging) 失败：{e}"))?;
        let staging = staging.ok_or("CreateTexture2D 没返回纹理")?;

        context.CopyResource(&staging, &texture);

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .map_err(|e| format!("Map 失败：{e}"))?;

        // ⚠ 必须逐行拷：RowPitch 可能 > width*4（D3D11 行对齐），
        //   整体 memcpy 会把 padding 混进像素，图会斜/花。
        let src = std::slice::from_raw_parts(
            mapped.pData as *const u8,
            (mapped.RowPitch as usize) * (th as usize),
        );
        let row_bytes = (tw as usize) * 4;
        let mut pixels = vec![0u8; row_bytes * (th as usize)];
        for y in 0..(th as usize) {
            let s = y * (mapped.RowPitch as usize);
            let d = y * row_bytes;
            pixels[d..d + row_bytes].copy_from_slice(&src[s..s + row_bytes]);
        }
        context.Unmap(&staging, 0);
        let us_readback = t_read.elapsed().as_micros() as u64;

        let _ = frame.Close();
        let _ = session.Close();
        let _ = pool.Close();

        Ok(CapturedFrame {
            pixels,
            width: tw,
            height: th,
            frames_waited: waited,
            us_wait,
            us_readback,
        })
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 常驻抓帧器（2026-11-14 四十九轮续）—— 纯视觉游戏操作的 L1 基座
//
// 问题：`capture_bgra` 每次调用都重建 D3D11 设备 + WinRT 设备 + CaptureItem +
//   FramePool + Session，然后等首帧。实测 `wgc_shot` 一次 **348–490ms**，
//   其中绝大部分是初始化 —— 而游戏反应要 10–30ms/帧。
//
// 做法：这些句柄**留在内存里**。开一次，之后每次只做
//   TryGetNextFrame → CopyResource → Map（预期 5–20ms）。
//
// 线程约束：D3D/WinRT 对象不是 Send，所以用 thread_local —— pet-core serve
//   是单线程串行处理请求，正好匹配。换线程会重新 open（代价可接受）。
// ═══════════════════════════════════════════════════════════════════════════

/// 常驻的 WGC 抓帧器：设备 / pool / session 全部留活。
pub struct GameCapture {
    pub hwnd: HWND,
    pub width: i32,
    pub height: i32,
    pub grabs: u64,
    pub opened_us: u64,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    staging: Option<ID3D11Texture2D>,
    staging_key: (u32, u32),
    /// COM 生命周期跟着抓帧器走：抓帧器死了才 CoUninitialize
    _com: ComGuard,
}

impl GameCapture {
    pub fn open(target: &str, client_only: bool) -> Result<Self, String> {
        let hwnd = resolve_and_check(target)?;
        Self::open_hwnd(hwnd, client_only)
    }

    pub fn open_hwnd(hwnd: HWND, client_only: bool) -> Result<Self, String> {
        let t0 = std::time::Instant::now();
        let com = init_com()?;
        // SAFETY: 下面全部是 COM/WinRT 调用，_com 保证本线程已初始化。
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut context: Option<ID3D11DeviceContext> = None;
            let hr = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            if hr.is_err() {
                return Err(format!("D3D11CreateDevice 失败：{hr:?}"));
            }
            let device = device.ok_or("D3D11CreateDevice 没返回设备")?;
            let context = context.ok_or("D3D11CreateDevice 没返回上下文")?;

            let dxgi_dev: IDXGIDevice = device.cast().map_err(|e| format!("cast IDXGIDevice 失败：{e}"))?;
            let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_dev)
                .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice 失败：{e}"))?;
            let winrt_device: IDirect3DDevice = inspectable
                .cast()
                .map_err(|e| format!("cast IDirect3DDevice 失败：{e}"))?;

            let interop: IGraphicsCaptureItemInterop =
                factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
                    .map_err(|e| format!("拿 IGraphicsCaptureItemInterop 失败：{e}"))?;
            let item: GraphicsCaptureItem = interop
                .CreateForWindow(hwnd)
                .map_err(|e| format!("CreateForWindow 失败：{e}"))?;

            let (w, h) = if client_only {
                let mut r = windows::Win32::Foundation::RECT::default();
                if GetClientRect(hwnd, &mut r).is_err() {
                    return Err("GetClientRect 失败".into());
                }
                (r.right - r.left, r.bottom - r.top)
            } else {
                let mut r = windows::Win32::Foundation::RECT::default();
                if GetWindowRect(hwnd, &mut r).is_err() {
                    return Err("GetWindowRect 失败".into());
                }
                (r.right - r.left, r.bottom - r.top)
            };
            if w <= 0 || h <= 0 {
                return Err(format!("窗口尺寸非法：{w}×{h}"));
            }

            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
                &winrt_device,
                DirectXPixelFormat::B8G8R8A8UIntNormalized,
                2,
                SizeInt32 { Width: w, Height: h },
            )
            .map_err(|e| format!("CreateFreeThreaded 失败：{e}"))?;
            let session = pool
                .CreateCaptureSession(&item)
                .map_err(|e| format!("CreateCaptureSession 失败：{e}"))?;
            // 光标不属于窗口内容，不要（否则每帧都可能变 → 检测噪音）
            let _ = session.SetIsCursorCaptureEnabled(false);
            // ⚠ 黄色捕获边框（2026-11-14 调研）：Win11 22H2+ 抓窗口时系统会画一圈黄框，
            //   用户能看见。常驻抓帧每开一次就闪一次 —— 必须关掉。
            //   老系统上这个接口不存在，`let _ =` 让它在 E_NOINTERFACE 时静默跳过
            //   （边框显示与否不影响抓到的像素）。
            let _ = session.SetIsBorderRequired(false);
            session
                .StartCapture()
                .map_err(|e| format!("StartCapture 失败：{e}"))?;

            Ok(GameCapture {
                hwnd, width: w, height: h, grabs: 0,
                opened_us: t0.elapsed().as_micros() as u64,
                device, context, pool, session,
                staging: None, staging_key: (0, 0),
                _com: com,
            })
        }
    }

    /// 抓一帧：只做 TryGetNextFrame + CopyResource + Map（不做任何初始化）。
    pub fn grab(&mut self, max_wait_ms: u32) -> Result<(Vec<u8>, i32, i32), String> {
        // SAFETY: 句柄由本结构持有，_com 保证线程已初始化。
        unsafe {
            let t_wait = std::time::Instant::now();
            let mut frame = None;
            while (t_wait.elapsed().as_millis() as u32) < max_wait_ms {
                if let Ok(f) = self.pool.TryGetNextFrame() {
                    frame = Some(f);
                    break;
                }
                // 2ms（不是 5ms）：TryGetNextFrame 本身是非阻塞的（空转 <0.2ms），
                // 但 sleep 太粗会让「帧在 16.7ms 边界到达」这个事实被量化掉 ——
                // 实测 5ms 平均多等 2.5ms、最坏 5ms，还会连续空转两次。
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            let frame = frame.ok_or_else(|| {
                format!("等了 {max_wait_ms}ms 没拿到帧（窗口可能最小化或停止合成）")
            })?;

            let surface = frame.Surface().map_err(|e| format!("frame.Surface 失败：{e}"))?;
            let access: IDirect3DDxgiInterfaceAccess = surface
                .cast()
                .map_err(|e| format!("cast IDirect3DDxgiInterfaceAccess 失败：{e}"))?;
            let texture: ID3D11Texture2D = access
                .GetInterface()
                .map_err(|e| format!("GetInterface(ID3D11Texture2D) 失败：{e}"))?;

            let mut src_desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut src_desc);
            let tw = src_desc.Width;
            let th = src_desc.Height;
            if tw == 0 || th == 0 {
                return Err("抓取帧尺寸非法".into());
            }

            // staging 纹理按尺寸缓存：窗口不变就不用每帧新建
            if self.staging.is_none() || self.staging_key != (tw, th) {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: tw,
                    Height: th,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                    Usage: D3D11_USAGE_STAGING,
                    BindFlags: 0,
                    CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                    MiscFlags: 0,
                };
                let mut st: Option<ID3D11Texture2D> = None;
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut st))
                    .map_err(|e| format!("CreateTexture2D(staging) 失败：{e}"))?;
                self.staging = Some(st.ok_or("CreateTexture2D 没返回纹理")?);
                self.staging_key = (tw, th);
            }
            let staging = self.staging.as_ref().ok_or("staging 缺失")?;

            self.context.CopyResource(staging, &texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(|e| format!("Map 失败：{e}"))?;

            // ⚠ 必须逐行拷：RowPitch 可能 > width*4（D3D11 行对齐）
            let row_bytes = (tw as usize) * 4;
            let mut pixels = vec![0u8; row_bytes * (th as usize)];
            let src_ptr = mapped.pData as *const u8;
            for y in 0..(th as usize) {
                let s = y * (mapped.RowPitch as usize);
                std::ptr::copy_nonoverlapping(
                    src_ptr.add(s),
                    pixels.as_mut_ptr().add(y * row_bytes),
                    row_bytes,
                );
            }
            self.context.Unmap(staging, 0);
            let _ = frame.Close();

            self.grabs += 1;
            Ok((pixels, tw as i32, th as i32))
        }
    }

    pub fn close(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

thread_local! {
    static GAME_CAP: std::cell::RefCell<Option<GameCapture>> = const { std::cell::RefCell::new(None) };
}

/// 抓一帧（复用常驻抓帧器）。返回 `(BGRA 紧排像素, w, h, 累计抓帧数, 本次耗时μs)`。
///
/// 第一次调 open（200–500ms，建设备/session）；之后每次 5–20ms。
/// 目标窗口变了会自动重开。
pub fn game_grab(target: &str, max_wait_ms: u32) -> Result<(Vec<u8>, i32, i32, u64, u64, i64), String> {
    let hwnd = resolve_and_check(target)?;
    GAME_CAP.with(|cell| {
        let mut slot = cell.borrow_mut();
        let reuse = matches!(slot.as_ref(), Some(g) if g.hwnd == hwnd);
        if !reuse {
            if let Some(mut old) = slot.take() {
                old.close();
            }
            *slot = Some(GameCapture::open_hwnd(hwnd, false)?);
        }
        let g = slot.as_mut().ok_or("抓帧器未就绪")?;
        let t0 = std::time::Instant::now();
        let (px, w, h) = g.grab(max_wait_ms)?;
        Ok((px, w, h, g.grabs, t0.elapsed().as_micros() as u64, g.hwnd.0 as i64))
    })
}

struct ComGuard;
impl Drop for ComGuard {
    fn drop(&mut self) {
        // SAFETY: 与 CoInitializeEx 成对。
        unsafe { CoUninitialize() };
    }
}

// ── BMP 编码（零依赖）───────────────────────────────────────────────────────

/// 自动落盘时顺手清理旧截图（2026-11-22）：`%TEMP%\pet-wgc` 实测涨到 563MB/91 文件，
/// 每张 5.4MB 且从不回收。只动本目录的 `shot-*.bmp`，保留最新 `keep` 个；
/// 1 分钟内刚写的不动（可能还有消费方在读）。返回删除个数。
fn prune_old_shots(dir: &Path, keep: usize) -> usize {
    let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return 0 };
    let mut shots: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for ent in entries.flatten() {
        let name = ent.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("shot-") && name.ends_with(".bmp")) { continue; }
        let path = ent.path();
        if !path.is_file() { continue; }
        let mtime = ent.metadata().ok().and_then(|m| m.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH);
        shots.push((mtime, path));
    }
    if shots.len() <= keep { return 0; }
    shots.sort_by(|a, b| b.0.cmp(&a.0));   // 最新的在前
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for (mtime, path) in shots.into_iter().skip(keep) {
        // 刚写出来的文件可能正被别的进程读取，至少放过 60 秒。
        if now.duration_since(mtime).map(|d| d.as_secs() < 60).unwrap_or(false) { continue; }
        if std::fs::remove_file(&path).is_ok() { removed += 1; }
    }
    removed
}

/// 自动落盘路径：`%TEMP%\pet-wgc\shot-<unix ms>.bmp`（目录由调用方 create_dir_all）。
fn default_shot_path() -> PathBuf {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    std::env::temp_dir()
        .join("pet-wgc")
        .join(format!("shot-{ms}.bmp"))
}

/// 写一个 32bpp BI_RGB 的 BMP。返回文件总字节数。
///
/// 布局（小端）：
///   BITMAPFILEHEADER 14B：'BM' + 文件总大小(u32) + 保留(u32=0) + 像素偏移(u32=54)
///   BITMAPINFOHEADER 40B：40 + width(i32) + **height(i32，负数 = top-down)**
///                          + planes(u16=1) + 32bpp + BI_RGB(0)
///                          + imageSize(u32=w*h*4) + 2835 dpi + 0 + 0
///   像素：**紧排 BGRA，自上而下**（正好是 GDI/WGC 的存储顺序，零转换）
///
/// ⚠ 2026-11-13 实测（重要，别改成 bottom-up）：
///   Electron 的 `nativeImage.createFromPath()` **不认负高度 BMP**（实测返回 0×0 空图），
///   但 `nativeImage.createFromBitmap(pixels, {width,height})` **认**（实测 2560×1440 成功）。
///   所以消费方必须读文件 → 跳过 54 字节头 → createFromBitmap，而不是 createFromPath。
///   保持 top-down 才能省掉那次全图行翻转（14MB 拷贝）。
pub fn write_bmp(path: &Path, pixels: &[u8], w: i32, h: i32) -> Result<u64, String> {
    if w <= 0 || h <= 0 {
        return Err(format!("BMP 尺寸非法：{w}×{h}"));
    }
    let row_bytes = (w as usize) * 4;
    let need = row_bytes * (h as usize);
    if pixels.len() < need {
        return Err(format!("像素缓冲不够：有 {} 字节，需要 {need}", pixels.len()));
    }

    let image_size = need as u64;
    let file_size = 54 + image_size;
    if file_size > u32::MAX as u64 {
        return Err(format!("图太大，BMP 头装不下（{file_size} 字节）"));
    }

    let mut head = Vec::with_capacity(54);
    head.extend_from_slice(b"BM");
    head.extend_from_slice(&(file_size as u32).to_le_bytes()); // bfSize
    head.extend_from_slice(&0u32.to_le_bytes());               // bfReserved1+2
    head.extend_from_slice(&54u32.to_le_bytes());              // bfOffBits
    head.extend_from_slice(&40u32.to_le_bytes());              // biSize
    head.extend_from_slice(&w.to_le_bytes());                  // biWidth
    head.extend_from_slice(&(-h).to_le_bytes());               // biHeight（负数=top-down）
    head.extend_from_slice(&1u16.to_le_bytes());               // biPlanes
    head.extend_from_slice(&32u16.to_le_bytes());              // biBitCount
    head.extend_from_slice(&0u32.to_le_bytes());               // biCompression = BI_RGB
    head.extend_from_slice(&(image_size as u32).to_le_bytes()); // biSizeImage
    head.extend_from_slice(&2835u32.to_le_bytes());            // biXPelsPerMeter ≈72dpi
    head.extend_from_slice(&2835u32.to_le_bytes());            // biYPelsPerMeter
    head.extend_from_slice(&0u32.to_le_bytes());               // biClrUsed
    head.extend_from_slice(&0u32.to_le_bytes());               // biClrImportant
    debug_assert_eq!(head.len(), 54, "BMP 头必须正好 54 字节");

    let mut f = std::fs::File::create(path)
        .map_err(|e| format!("创建 BMP 失败（{}）：{e}", path.display()))?;
    f.write_all(&head)
        .map_err(|e| format!("写 BMP 头失败（{}）：{e}", path.display()))?;
    f.write_all(&pixels[..need])
        .map_err(|e| format!("写 BMP 像素失败（{}）：{e}", path.display()))?;
    f.flush()
        .map_err(|e| format!("flush BMP 失败（{}）：{e}", path.display()))?;
    drop(f);

    // 落盘后回读一次大小 —— 「写完了」不能只靠 write_all 没报错（磁盘满/杀软拦截都可能）
    let on_disk = std::fs::metadata(path)
        .map_err(|e| format!("stat BMP 失败（{}）：{e}", path.display()))?
        .len();
    if on_disk != file_size {
        return Err(format!(
            "BMP 落盘大小不符（{}）：期望 {file_size} 字节，实际 {on_disk} 字节",
            path.display()
        ));
    }
    Ok(file_size)
}

#[cfg(test)]
mod tests {
    // WGC 依赖真实窗口和 GPU，不能在单测里跑。
    // 这里只测 BMP 编码这种纯计算部分。
    use super::write_bmp;

    #[test]
    fn bmp_header_and_size() {
        // 3×2 的 BGRA：第一行全蓝，第二行全红（top-down 顺序）
        let mut px = vec![0u8; 3 * 2 * 4];
        for i in 0..3 {
            px[i * 4] = 255; // B
        }
        for i in 3..6 {
            px[i * 4 + 2] = 255; // R
        }
        let p = std::env::temp_dir().join("pet-wgc-test.bmp");
        let n = write_bmp(&p, &px, 3, 2).expect("写 BMP");
        assert_eq!(n, 54 + 3 * 2 * 4);
        let data = std::fs::read(&p).expect("读回");
        assert_eq!(&data[0..2], b"BM");
        assert_eq!(u32::from_le_bytes([data[10], data[11], data[12], data[13]]), 54);
        // width=3, height=-2（top-down）
        assert_eq!(i32::from_le_bytes([data[18], data[19], data[20], data[21]]), 3);
        assert_eq!(i32::from_le_bytes([data[22], data[23], data[24], data[25]]), -2);
        assert_eq!(u16::from_le_bytes([data[28], data[29]]), 32);
        assert_eq!(data.len() as u64, n);
        // 像素：第 0 行蓝、第 1 行红（top-down 不翻转）
        assert_eq!(data[54 + 0], 255);
        assert_eq!(data[54 + 3 * 4 + 2], 255);
        let _ = std::fs::remove_file(&p);
    }
}
