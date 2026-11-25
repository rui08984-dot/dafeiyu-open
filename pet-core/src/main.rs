//! pet-core 命令行：把纯计算包成可被 JS/Python 调用的进程。
//!
//! 用法：
//!   echo {"cmd":"panel","pet":{...},"panel":[w,h],"work":{...}} | pet-core
//! 这样宿主（Electron）在切窗口时调一次，逻辑只有一份实现（这里）。
use pet_core::{geometry::Rect, mood, pad, placement};
use serde::Deserialize;
use serde_json::json;
use std::io::Read;

// ── 输出重定向（2026-11-14 四十八轮续）────────────────────────────────────
// 为什么要它：常驻 serve 模式（`pet-core serve`）和一次性模式必须共用**同一套**
// 命令分支 —— 否则又变成「两套实现」，而两套实现正是本项目最痛的历史包袱
// （§29 外挂补丁根治里 13 项有一半是这个病）。
//
// 做法：所有响应从 `println!` 改成 `emit!`。serve 模式下把输出收进线程局部缓冲，
// 由循环一次性写回；一次性模式下照旧打到 stdout。命令分支代码一行都不用复制。
thread_local! {
    static SINK: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

macro_rules! emit {
    ($($arg:tt)*) => {{
        let s = format!($($arg)*);
        SINK.with(|sink| {
            let mut slot = sink.borrow_mut();
            if let Some(buf) = slot.as_mut() {
                buf.push_str(&s);
            } else {
                println!("{}", s);
            }
        });
    }};
}

#[derive(Deserialize)]
struct EmotionIn {
    id: String,
    #[serde(default = "one")]
    strength: f64,
}

fn one() -> f64 {
    1.0
}

#[derive(Deserialize)]
struct Req {
    cmd: String,
    pet: Option<Rect>,
    panel: Option<(u32, u32)>,
    // ── subtitle 专用：侧位窄版尺寸（宽, 高）。给了才优先走侧位。 ──
    side_panel: Option<(u32, u32)>,
    work: Option<Rect>,
    // ── mood 命令专用 ──
    score: Option<f64>,
    // ── prosody 命令专用（统一情绪总线）──
    emotions: Option<Vec<EmotionIn>>,
    mood: Option<f64>,
    wounds: Option<Vec<mood::Wound>>,
    now: Option<i64>,
    // ── knowledge_search 命令专用（2026-11-09 三十五轮）──
    /// 语料：知识库条目的扁平数组（由 JS 侧把三层合并后传进来）
    docs: Option<Vec<pet_core::knowledge::Doc>>,
    /// 查询文本（会做 CJK bigram 切词）
    query: Option<String>,
    /// 查询向量（1024 维浮点。空则自动退化成纯 BM25 —— 嵌入服务挂了也能用）
    query_vec: Option<Vec<f32>>,
    /// 取前 K 条（默认 8）
    top_k: Option<usize>,

    // ── 原生能力命令（2026-11-09 三十五轮：从 Python/PowerShell 搬到 Rust）──
    /// windows 命令：标题子串过滤（空 = 全部）
    filter: Option<String>,
    /// windows 命令：最多返回几个（默认 40）
    max: Option<usize>,
    /// focus / keys 命令：目标窗口标题子串，或 hwnd 数字
    target: Option<String>,
    /// keys 命令：组合键（如 "ctrl+s" / "w" / "enter"）
    keys: Option<String>,
    /// keys 命令：按住多少毫秒（0 = 点按）
    /// ⚠ 2026-11-14 五十三轮：原来只有 snake_case，而 JS 侧发的是 `holdMs` ——
    ///   serde 默认忽略未知字段，于是 `hold s 700ms` 的时长**恒为 0**，
    ///   游戏里的「后退拉开距离」退化成 20ms 轻点（审计抓到的致命回归）。
    #[serde(alias = "holdMs")]
    hold_ms: Option<u32>,
    /// text 命令：要输入的文字
    text: Option<String>,
    /// keys/text 命令：true = 只解析不发送（dry-run，用于验收参数链路而不干扰当前窗口）
    #[serde(alias = "dryRun")]
    dry_run: Option<bool>,
    /// focus 命令：true = 常规失败后用 SwitchToThisWindow 强制切（未文档化 API，对全屏置顶游戏有效）
    force: Option<bool>,
    /// wgc_hash 命令：只抓客户区（不含标题栏）
    /// wgc_shot 命令：JSON 里写 `clientOnly`（驼峰）—— serde 默认只认 snake_case，
    /// 不写 alias 的话驼峰会**静默被忽略**（踩过：整窗抓成客户区，尺寸对不上）。
    #[serde(alias = "clientOnly")]
    client_only: Option<bool>,
    /// wgc_hash 命令：最多等多久拿一帧（毫秒，默认 800）
    /// wgc_shot 命令：JSON 里写 `maxWaitMs`（驼峰，默认 3000），同上需要 alias
    #[serde(alias = "maxWaitMs")]
    max_wait_ms: Option<u32>,
    /// wgc_shot 命令：图存到哪（空 = 自动 %TEMP%\pet-wgc\shot-<ts>.bmp）
    path: Option<String>,
    // ── region_gray 命令专用（2026-11-10 三十七轮）：局部区域（屏幕物理像素）──
    x: Option<i32>,
    y: Option<i32>,
    w: Option<i32>,
    h: Option<i32>,
    /// region_gray 命令专用（2026-11-25 P0-3）：目标显示器矩形（物理像素，虚拟屏坐标）。
    /// 给了就钳到这块屏；没给则钳到整个虚拟屏（`SM_XVIRTUALSCREEN` 等）。
    /// 原来只认主屏并把 x/y `max(0)` —— 副屏（负坐标）和屏外窗口的局部验证全采到主屏左上。
    dx: Option<i32>,
    dy: Option<i32>,
    dw: Option<i32>,
    dh: Option<i32>,
    // ── mouse 命令专用（2026-11-10 四十轮：把 click/drag 从 pwsh 搬进 Rust）──
    /// click / double_click / right_click / drag / scroll
    kind: Option<String>,
    /// window_op 命令专用（2026-11-15 五十八轮）：min | max | restore | close | move | size | all_min
    op: Option<String>,
    x2: Option<i32>,
    y2: Option<i32>,
    #[serde(alias = "durationMs")]
    duration_ms: Option<u32>,
    notches: Option<i32>,
    /// 落点遮挡检查：WindowFromPoint 根窗口标题必须包含它
    #[serde(alias = "expectTitle")]
    expect_title: Option<String>,
    /// 鼠标组合键修饰（2026-11-14）："ctrl" / "ctrl+shift" / "shift" / "alt" / "win"。
    /// ctrl+click 列表多选、shift+click 区间选择靠它。
    modifiers: Option<String>,
    /// scroll 的轴："v"（默认）/ "h"（水平）
    axis: Option<String>,
    /// 鼠标按键名（mouse_down / mouse_up）：left / right / middle
    button: Option<String>,
    /// windows 命令：把「点击穿透+工具窗+不激活」的指示层也列出来（默认过滤；诊断用）
    #[serde(alias = "includeOverlays")]
    include_overlays: Option<bool>,
    /// game_frame 的帧文件槽位（"loop" / "see" / …）。不同消费者各写各的文件，
    /// 避免「看一眼」和自动循环互相覆盖帧（2026-11-14 五十三轮）。
    slot: Option<String>,
    /// 动作后把用户光标还回原位（2026-11-14 五十三轮：「两个光标」——
    /// 她用虚拟光标操作，不霸占用户的真实鼠标）。只对 click/drag/scroll 这类
    /// 绝对定位动作生效。
    #[serde(alias = "restoreCursor")]
    restore_cursor: Option<bool>,
    // ── uia_action 命令专用（2026-11-14）：语义动作 ──
    /// 元素 RuntimeId（由 uia_elements 返回，格式如 "42-1234-5"）
    rid: Option<String>,
    /// 语义动作名：invoke / set_value / get_value / focus / perform_action / actions
    action: Option<String>,
    /// set_value 的写入值
    value: Option<String>,
    // ── uia_elements 三重预算（2026-11-10 三十八轮，抄 #5：防拖垮目标应用）──
    /// 深度：1 = 只看直接子级（快），2+/缺省 = 全深度
    #[serde(alias = "maxDepth")]
    max_depth: Option<u32>,
    /// 提取阶段时间预算毫秒（缺省 2000；0 = 不限）
    #[serde(alias = "budgetMs")]
    budget_ms: Option<u64>,
    /// 提取阶段节点预算（缺省 4000；0 = 不限）
    #[serde(alias = "maxNodes")]
    max_nodes: Option<usize>,
    // ── world 命令专用（2026-11-17 六十二轮：世界感知）──
    /// false = 这一拍不读媒体会话（低功耗模式：只留前台+空闲，省掉 WinRT 往返）
    media: Option<bool>,
}

/// 父进程死亡守护（2026-11-22 内存/进程采样）。
///
/// 为什么加：硬杀渲染进程（崩溃 / forcefullyCrashRenderer / taskkill /T）时，不能指望
/// stdin EOF 一定送达 —— Electron 里 stdin 管道可能还被别的进程持有；本机用 Node 硬杀
/// 父进程时 EOF 会到（未能复现孤儿），所以这是**不等 EOF 的兜底**：直接等父进程句柄，
/// 父死即退，跨 Electron 版本都成立。退出前先松开可能按着的键（复用 release_all_inputs）。
#[cfg(target_os = "windows")]
fn watch_parent_death(ppid: u32) {
    use std::io::Write;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
    std::thread::spawn(move || unsafe {
        let handle = match OpenProcess(PROCESS_SYNCHRONIZE, false, ppid) {
            Ok(h) => h,
            Err(_) => return,   // 打不开（权限/已退出）→ 回退到 stdin EOF 路径
        };
        WaitForSingleObject(handle, INFINITE);
        let _ = CloseHandle(handle);
        let released = pet_core::native::release_all_inputs();
        if released > 0 {
            let _ = writeln!(std::io::stdout(), "{}", json!({"ok": true, "released": released, "at": "parent-exit"}));
            let _ = std::io::stdout().flush();
        }
        std::process::exit(0);
    });
}

#[cfg(target_os = "windows")]
fn parent_pid_arg() -> Option<u32> {
    let args: Vec<String> = std::env::args().collect();
    let i = args.iter().position(|a| a == "--parent-pid")?;
    args.get(i + 1).and_then(|s| s.parse::<u32>().ok())
}

fn main() {
    // ── serve 模式（2026-11-14 四十八轮续）─────────────────────────────────
    // `pet-core.exe serve`：常驻，stdin 一行一个 JSON 请求，stdout 一行一个响应。
    // 为什么：每次动作 spawn 一次进程 = 15–30ms（Windows 进程创建 + DPI 初始化 +
    // Rust 运行时启动），而鼠标/键盘/UIA 这些热路径本身只要 1–40ms ——
    // 进程启动占了一半以上。ZCode CUA 的 Helper 也是常驻的（HELPER_UNAVAILABLE
    // / 冷启动 not-ready 就是证据）。
    //
    // 为什么不用命名管道：stdin/stdout 由 Node 的 child_process 天然提供，
    // 没有 ACL/权限/句柄继承问题，而且一次性模式退化路径完全一样。
    if std::env::args().any(|a| a == "serve") {
        serve_loop();
        return;
    }
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        emit!("{}", json!({"ok": false, "error": "stdin read failed"}));
        return;
    }
    handle_input(&input);
}

/// 常驻循环：逐行读请求 → 跑同一套命令分支 → 逐行写响应。
fn serve_loop() {
    use std::io::{BufRead, Write};
    SERVE_MODE.store(true, std::sync::atomic::Ordering::Relaxed);
    // 父进程（渲染进程）一旦被硬杀就退出，别做孤儿（见 watch_parent_death 注释）
    #[cfg(target_os = "windows")]
    if let Some(ppid) = parent_pid_arg() { watch_parent_death(ppid); }
    #[cfg(target_os = "windows")]
    pet_core::native::enable_dpi_awareness();   // 一次就够了（原来每次 spawn 都要做）
    // SMTC 后台刷新：有活动媒体时单次查询 150–200ms，不能塞进每秒一次的 world 采样。
    #[cfg(target_os = "windows")]
    pet_core::native::media_poller_start();
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let mut out = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,                 // EOF：父进程关了管道
            Ok(_) => {}
            Err(_) => break,
        }
        let t = line.trim();
        if t.is_empty() { continue; }
        if t == "__quit__" { break; }
        // 把这次请求的输出收进 SINK，跑完再整体写回一行
        SINK.with(|s| *s.borrow_mut() = Some(String::new()));
        handle_input(t);
        let resp = SINK.with(|s| s.borrow_mut().take().unwrap_or_default());
        // 响应必须是单行（json! 的 Display 本身紧凑，这里再兜一次底）
        let one = resp.replace(['\r', '\n'], " ");
        if writeln!(out, "{}", one).is_err() { break; }
        if out.flush().is_err() { break; }
    }
    // ⚠ 2026-11-14 五十三轮：常驻进程退出前把还按着的键/鼠标键松开 ——
    //   否则她按住 W 时客户端崩了，角色会一直走（键在 OS 层面是真按下的）。
    let n = pet_core::native::release_all_inputs();
    if n > 0 {
        let _ = writeln!(out, "{}", json!({"ok": true, "released": n, "at": "exit"}));
    }
}

/// 处理一个请求（一次性模式与 serve 模式共用，保证只有一套命令分支）。
/// 是否常驻模式（serve）。`key_down`/`mouse_down` 只允许在常驻模式里用 ——
/// 一次性进程退出后没人发 key_up，键会一直按着（角色一直走）。
static SERVE_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 目标前台断言（2026-11-14 五十三轮，审计致命项）。
///
/// 为什么必须有：`SendInput` 没有 hwnd 参数 —— 它**永远发给当前前台窗口**。
/// 所以命令里的 `target` 不是装饰，是「这次注入允许落到哪」的声明：
///   · 她在 MC 里按 W，用户 Alt-Tab 到浏览器 → W 滚进网页（原来 target 从未被读取）
///   · `hold s 700ms` 期间用户切窗口 → 抬起事件落到别人的窗口上
/// 对不上就拒绝（TARGET-NOT-FOREGROUND），让上层暂停，而不是「发了但发错了」。
fn assert_target_foreground(target: &str) -> Result<(), serde_json::Value> {
    let t = target.trim();
    if t.is_empty() { return Ok(()); }
    let want = t.to_lowercase();
    let (has_fg, fg_hwnd, fg_title) = pet_core::native::foreground();
    if !has_fg {
        return Err(json!({"ok": false, "error": "NO-FOREGROUND", "target": t,
            "detail": "读不到前台窗口（可能在锁屏/UAC 安全桌面）"}));
    }
    // 三种认法：纯数字 hwnd / 前台标题包含目标串 / 按标题找到目标窗口后比 hwnd
    let ok = if let Ok(h) = t.parse::<i64>() {
        fg_hwnd == h
    } else if fg_title.to_lowercase().contains(&want) {
        true
    } else {
        pet_core::native::list_windows(t, 8).iter().any(|w| !w.iconic && w.hwnd == fg_hwnd)
    };
    if ok { return Ok(()); }
    Err(json!({
        "ok": false,
        "error": format!("TARGET-NOT-FOREGROUND:{}", fg_title),
        "target": t, "fgHwnd": fg_hwnd, "fgTitle": fg_title,
        "detail": "目标窗口不在前台，按键会打进用户正在用的应用 —— 已拒绝",
    }))
}

fn handle_input(input: &str) {
    let req: Req = match serde_json::from_str(input) {
        Ok(v) => v,
        Err(e) => { emit!("{}", json!({"ok": false, "error": e.to_string()})); return; }
    };
    if req.cmd == "prosody" {
        // 统一情绪总线：emotions 数组 + 心气 → PAD 混合韵律（论文 Top5 之首）
        let mood = req.mood.unwrap_or(0.0);
        let emo_in = req.emotions.unwrap_or_default();
        let emos: Vec<(&str, f64)> = emo_in.iter().map(|e| (e.id.as_str(), e.strength)).collect();
        let pr = pad::blend_prosody(&emos, mood);
        emit!(
            "{}",
            json!({"ok": true, "rate": pr.rate, "pitch": pr.pitch, "volume": pr.volume})
        );
        return;
    }
    // ══ 原生能力命令（2026-11-09 三十五轮）══════════════════════════════════
    // 搬到 Rust 的理由见 src/native.rs 顶部注释。
    // 每个命令都强制 enable_dpi_awareness —— 不设的话 GetWindowRect 返回逻辑像素、
    // 截图和 UIA 返回物理像素，两套坐标系混用会点偏（本轮之前踩过的真坑）。
    #[cfg(target_os = "windows")]
    {
        if req.cmd == "screen_hash" {
            pet_core::native::enable_dpi_awareness();
            match pet_core::native::screen_dhash() {
                Ok(r) => {
                    emit!("{}", json!({
                        "ok": true, "hash": r.hash,
                        "width": r.width, "height": r.height, "us": r.us,
                    }));
                }
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "gray_matrix" {
            pet_core::native::enable_dpi_awareness();
            match pet_core::native::screen_gray_matrix() {
                Ok((m, w, h)) => {
                    emit!("{}", json!({"ok": true, "m": m, "w": w, "h": h}));
                }
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        // 全屏截图存 BMP（2026-11-10 三十七轮）：给主进程 take-screenshot 换引擎（根治黑帧）。
        // GDI BitBlt 全屏 → 32bpp BMP。40ms 级，比 screenshot-desktop 外部包稳且快。
        if req.cmd == "screen_shot" {
            pet_core::native::enable_dpi_awareness();
            let t0 = std::time::Instant::now();
            let out = req.path.clone().unwrap_or_default();
            if out.is_empty() {
                emit!("{}", json!({"ok": false, "error": "screen_shot 需要 path"}));
                return;
            }
            match pet_core::native::screen_shot_bmp(&out) {
                Ok((w, h, bytes)) => emit!("{}", json!({
                    "ok": true, "path": out, "width": w, "height": h, "bytes": bytes,
                    "us": t0.elapsed().as_micros() as u64,
                })),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        // 鼠标注入（2026-11-10 四十轮）：click / double_click / right_click / drag / scroll。
        // 一条命令里带齐 UAC 探针 → 4px 急停 → 落点遮挡 → SendInput，省掉 pwsh 冷启动。
        if req.cmd == "mouse" {
            pet_core::native::enable_dpi_awareness();
            let kind = req.kind.clone().unwrap_or_else(|| "click".to_string());
            // 目标前台断言（2026-11-14 五十三轮）：鼠标注入同样只认前台窗口。
            if let Some(t) = req.target.as_deref() {
                if let Err(e) = assert_target_foreground(t) { emit!("{}", e); return; }
            }
            // 有坐标 = 这次动作要落到具体像素（click/drag/带坐标的 scroll）。
            // 没坐标（`scroll down 5` 这种默认语法）→ 不挪光标、不查落点。
            let has_pos = req.x.is_some() && req.y.is_some();
            match pet_core::native::mouse_inject(
                &kind,
                req.x.unwrap_or(0),
                req.y.unwrap_or(0),
                req.x2.unwrap_or(0),
                req.y2.unwrap_or(0),
                req.duration_ms.unwrap_or(600),
                req.notches.unwrap_or(0),
                req.expect_title.as_deref(),
                req.modifiers.as_deref(),
                req.axis.as_deref(),
                req.restore_cursor.unwrap_or(false),
                has_pos,
            ) {
                Ok(r) => emit!("{}", json!({
                    "ok": true, "kind": r.kind, "steps": r.steps, "us": r.us,
                    "restored": r.restored, "userIdleMs": r.user_idle_ms,
                })),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        // 当前光标位置（2026-11-14 五十三轮）：虚拟光标要对齐真实光标时用。
        if req.cmd == "cursor_pos" {
            match pet_core::native::cursor_pos() {
                Some((x, y)) => emit!("{}", json!({
                    "ok": true, "x": x, "y": y, "userIdleMs": pet_core::native::user_idle_ms(),
                })),
                None => emit!("{}", json!({"ok": false, "error": "GetCursorPos 失败（可能在安全桌面）"})),
            }
            return;
        }
        // 落点遮挡检查（2026-11-10 三十七轮，抄 #9「POINT_COVERED」）：click_at/mouse 的护栏。
        // 坐标在目标窗口矩形内 ≠ 落点像素没有被悬浮窗压着（桌宠自己/小工具/输入法面板）。
        if req.cmd == "window_from_point" {
            pet_core::native::enable_dpi_awareness();
            let (x, y) = match (req.x, req.y) {
                (Some(x), Some(y)) => (x, y),
                _ => {
                    emit!("{}", json!({"ok": false, "error": "window_from_point 需要 x,y"}));
                    return;
                }
            };
            match pet_core::native::window_from_point(x, y) {
                Ok((root_hwnd, title, child_hwnd)) => emit!("{}", json!({
                    "ok": true, "rootHwnd": root_hwnd, "rootTitle": title, "childHwnd": child_hwnd,
                })),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        // 局部区域灰度特征（2026-11-10 三十七轮）：给 actAndVerify 的「游戏内局部验证」用。
        // 全屏 9×8 dHash 对种植/选卡这类局部变化是盲区（实测 hamming=0 但成功），
        // 点击点 ±110px 的 12×10 灰度矩阵 + mean/std 才能看见。GDI BitBlt，40ms 级。
        if req.cmd == "region_gray" {
            pet_core::native::enable_dpi_awareness();
            let (x, y, w, h) = match (req.x, req.y, req.w, req.h) {
                (Some(x), Some(y), Some(w), Some(h)) => (x, y, w, h),
                _ => {
                    emit!("{}", json!({"ok": false, "error": "region_gray 需要 x,y,w,h"}));
                    return;
                }
            };
            // P0-3（2026-11-25）：可选的「目标显示器矩形」（物理像素，虚拟屏坐标）。
            // 给了就只钳到这块屏；没给则钳到整个虚拟屏（原来是主屏 —— 副屏/负坐标全取错）。
            let clip = match (req.dx, req.dy, req.dw, req.dh) {
                (Some(dx), Some(dy), Some(dw), Some(dh)) if dw >= 16 && dh >= 16 => Some((dx, dy, dw, dh)),
                _ => None,
            };
            match pet_core::native::region_gray_in(x, y, w, h, clip) {
                Ok(r) => emit!("{}", json!({
                    "ok": true, "gray": r.gray, "mean": r.mean, "std": r.std,
                    "width": r.width, "height": r.height, "us": r.us,
                    "x": r.x0, "y": r.y0, "w": r.w0, "h": r.h0,
                })),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "wgc_hash" {
            pet_core::native::enable_dpi_awareness();
            let target = req.target.unwrap_or_default();
            if target.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 target（窗口标题或 hwnd）"}));
                return;
            }
            let r = pet_core::wgc::wgc_dhash(
                &target,
                req.client_only == Some(true),
                req.max_wait_ms.unwrap_or(800),
            );
            emit!("{}", json!({
                "ok": r.ok, "hash": r.hash,
                "width": r.width, "height": r.height,
                "frames_waited": r.frames_waited,
                "us_total": r.us_total, "us_wait": r.us_wait, "us_readback": r.us_readback,
                "gray": r.gray,
                "error": r.error,
            }));
            return;
        }
        if req.cmd == "wgc_shot" {
            // WGC 抓窗口合成表面 → 存 BMP（2026-11-09 三十六轮）。
            // 和 wgc_hash 的区别：那个只给 64bit dHash（看不见内容），这个把像素落盘，
            // 让「被全屏游戏挡住的窗口里是什么」变成能看的东西。
            pet_core::native::enable_dpi_awareness();
            let target = req
                .target
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "ZCode".to_string());
            let r = pet_core::wgc::wgc_shot(
                &target,
                &req.path.unwrap_or_default(),
                req.client_only == Some(true),
                req.max_wait_ms.unwrap_or(3000),
            );
            emit!("{}", json!({
                "ok": r.ok, "path": r.path,
                "width": r.width, "height": r.height, "bytes": r.bytes,
                "hash": r.hash, "frames_waited": r.frames_waited,
                "us_total": r.us_total,
                "error": r.error,
            }));
            return;
        }
        if req.cmd == "game_frame" {
            // 常驻抓帧（2026-11-14 四十九轮续）：纯视觉游戏操作的 L1 基座。
            // 第一次 ~200-500ms（建设备/session），之后每次 5-20ms。
            // 输出 raw BGRA 到临时文件（1311×877×4 ≈ 4.6MB，走不了 JSON）。
            pet_core::native::enable_dpi_awareness();
            let target = req.target.as_deref().unwrap_or("");
            if target.trim().is_empty() {
                emit!("{}", json!({"ok": false, "error": "game_frame 需要 target（窗口标题或 hwnd）"}));
                return;
            }
            let max_wait = req.max_wait_ms.unwrap_or(1500);
            let t0 = std::time::Instant::now();
            match pet_core::wgc::game_grab(target, max_wait) {
                Ok((px, w, h, grabs, grab_us, cap_hwnd)) => {
                    // 安全闸第一道（2026-11-14 审计）：SendInput 只发给前台窗口，
                    // 目标不在前台时按键会打进用户正在用的应用 → 上层必须据此暂停循环。
                    let fg = pet_core::native::fg_hwnd();
                    let dir = std::env::temp_dir().join("pet-game");
                    let _ = std::fs::create_dir_all(&dir);
                    // ⚠ 2026-11-14 五十三轮（P0）：**按消费者分槽的帧文件**。
                    //   原来固定写 frame.bgra —— `game see`（模型看一眼）和自动循环同时跑时
                    //   会互相覆盖：A 写完、B 覆盖、A 拿去检测 → 尺寸不对时 BGRA 读取静默截断
                    //   （读到半张图，血条位置全错）。现在各写各的槽（slot=loop / see / 其它），
                    //   同一消费者内部才可能覆盖，而它本来就是顺序调用的。
                    let slot: String = req.slot.as_deref().unwrap_or("default")
                        .chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                        .take(16).collect();
                    let f = dir.join(format!("frame-{}-{}.bgra", if slot.is_empty() { "default".to_string() } else { slot }, std::process::id()));
                    // 清掉旧版固定名和别的 pid 的残骸（失败不影响抓帧）
                    if let Ok(rd) = std::fs::read_dir(&dir) {
                        for e in rd.flatten() {
                            let n = e.file_name().to_string_lossy().to_string();
                            if n == "frame.bgra" || (n.starts_with("frame-") && n.ends_with(".bgra")
                                && !n.ends_with(&format!("-{}.bgra", std::process::id()))) {
                                let _ = std::fs::remove_file(e.path());
                            }
                        }
                    }
                    match std::fs::write(&f, &px) {
                        Ok(_) => emit!("{}", json!({
                            "ok": true, "path": f.to_string_lossy(),
                            "width": w, "height": h, "bytes": px.len(),
                            "grabs": grabs, "grab_us": grab_us,
                            "hwnd": cap_hwnd, "fgHwnd": fg, "fgMatch": fg == cap_hwnd,
                            "us_total": t0.elapsed().as_micros() as u64,
                        })),
                        Err(e) => emit!("{}", json!({"ok": false, "error": format!("写帧失败：{e}")})),
                    }
                }
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "post_mouse" {
            // 后台鼠标点击（2026-11-14 四十九轮续）：PostMessage 直接投给目标窗口。
            //
            // 和 `mouse` 的区别（实测验证过）：
            //   · `mouse` 走 SendInput → 发给**当前前台窗口**，会移动用户的鼠标、
            //     被任何置顶窗（PotPlayer/她自己的桌宠窗）挡住就点错。
            //   · `post_mouse` 不碰前台、不碰鼠标、不受遮挡 —— 用户在看视频/打字时
            //     她照样能打游戏。MC（GLFW）实测认 WM_LBUTTONDOWN。
            //   ⚠ 但**键盘不行**：GLFW 忽略非焦点窗口的 WM_CHAR/WM_KEYDOWN。
            //     所以打字类操作仍然要用 `keys`（需要前台）。
            //
            // 坐标：**整窗相对**（和 WGC 抓到的图一致）—— 内部减掉标题栏/边框偏移，
            // 转成客户区坐标再投递。这样调用方不用关心 DPI 和边框。
            pet_core::native::enable_dpi_awareness();
            let target = req.target.as_deref().unwrap_or("");
            let kind = req.kind.clone().unwrap_or_else(|| "click".to_string());
            let ix = req.x.unwrap_or(-1);
            let iy = req.y.unwrap_or(-1);
            if target.trim().is_empty() || ix < 0 || iy < 0 {
                emit!("{}", json!({"ok": false, "error": "post_mouse 需要 target + x + y（整窗坐标）"}));
                return;
            }
            match pet_core::native::post_mouse_inject(target, ix, iy, &kind) {
                Ok((hwnd, cx, cy)) => emit!("{}", json!({
                    "ok": true, "hwnd": hwnd, "kind": kind,
                    "clientX": cx, "clientY": cy, "via": "PostMessage",
                })),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "uia_action" {
            // UIA 语义动作（2026-11-14）：invoke / set_value / get_value / focus /
            // perform_action / actions。后台窗口也能操作、不抢焦点、失败明确报错。
            pet_core::native::enable_dpi_awareness();
            let r = pet_core::uia::uia_action(
                req.target.as_deref().unwrap_or(""),
                req.rid.as_deref().unwrap_or(""),
                req.action.as_deref().unwrap_or("actions"),
                req.value.as_deref(),
            );
            emit!("{}", json!({
                "ok": r.ok,
                "action": r.action,
                "rid": r.rid,
                "name": r.name,
                "ctype": r.ctype,
                "value": r.value,
                "actions": r.actions,
                "detail": r.detail,
                "us": r.us,
            }));
            return;
        }
        if req.cmd == "uia_elements" {
            pet_core::native::enable_dpi_awareness();
            let target = req.target.unwrap_or_default();
            let max = req.max.unwrap_or(60);
            // 三重预算（2026-11-10 三十八轮）：深度 / 时间 / 节点
            let depth = req.max_depth.unwrap_or(2);
            let budget = req.budget_ms.unwrap_or(2000);
            let nodes = req.max_nodes.unwrap_or(4000);
            let t0 = std::time::Instant::now();
            let r = pet_core::uia::uia_elements_budgeted(&target, max, depth, budget, nodes);
            emit!("{}", json!({
                "ok": r.ok,
                "title": r.title,
                "hwnd": r.hwnd,
                "elements": r.elements,
                "count": r.elements.len(),
                "scanned": r.scanned,
                "us_com": r.us_com,
                "us_find": r.us_find,
                "us_extract": r.us_extract,
                "us_total": r.us_total,
                "us_wall": t0.elapsed().as_micros() as u64,
                "error": r.error,
                "truncated": r.truncated,
                "depth": r.depth,
            }));
            return;
        }
        if req.cmd == "edit_text" {
            pet_core::native::enable_dpi_awareness();
            let target = req.target.unwrap_or_default();
            if target.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 target（窗口标题或 hwnd）"}));
                return;
            }
            let r = pet_core::native::read_edit_text(&target);
            emit!("{}", json!({
                "ok": r.ok, "text": r.text, "hwnd": r.hwnd,
                "class": r.class, "len": r.text.chars().count(),
                "error": r.error,
            }));
            return;
        }
        if req.cmd == "windows" {
            pet_core::native::enable_dpi_awareness();
            let filter = req.filter.unwrap_or_default();
            let max = req.max.unwrap_or(40);
            let t0 = std::time::Instant::now();
            let list = pet_core::native::list_windows_ex(&filter, max, req.include_overlays.unwrap_or(false));
            emit!("{}", json!({
                "ok": true, "windows": list,
                "count": list.len(), "us": t0.elapsed().as_micros() as u64,
            }));
            return;
        }
        if req.cmd == "focus" {
            pet_core::native::enable_dpi_awareness();
            let target = req.target.unwrap_or_default();
            if target.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 target（窗口标题子串或 hwnd）"}));
                return;
            }
            let t0 = std::time::Instant::now();
            let r = pet_core::native::focus_window_ex(&target, req.force == Some(true));
            emit!("{}", json!({
                "ok": r.ok, "hwnd": r.hwnd, "title": r.title,
                "wasIconic": r.was_iconic,
                "fgTitle": r.fg_title, "fgHwnd": r.fg_hwnd, "forced": r.forced,
                "error": r.error,
                "us": t0.elapsed().as_micros() as u64,
            }));
            return;
        }
        if req.cmd == "uia_text" {
            pet_core::native::enable_dpi_awareness();
            let target = req.target.unwrap_or_default();
            let max = req.max.unwrap_or(8000);
            let t0 = std::time::Instant::now();
            let r = pet_core::uia::uia_text(&target, max);
            emit!("{}", json!({
                "ok": r.ok, "hwnd": r.hwnd, "title": r.title,
                "chars": r.chars, "text": r.text, "detail": r.detail,
                "us": t0.elapsed().as_micros() as u64,
            }));
            return;
        }
        if req.cmd == "window_op" {
            pet_core::native::enable_dpi_awareness();
            let op = req.op.unwrap_or_default();
            if op.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 op（min|max|restore|close|move|size|all_min）"}));
                return;
            }
            let target = req.target.unwrap_or_default();
            let t0 = std::time::Instant::now();
            let r = pet_core::native::window_op(&target, &op, req.x, req.y, req.w, req.h);
            emit!("{}", json!({
                "ok": r.ok, "hwnd": r.hwnd, "title": r.title, "op": r.op,
                "iconic": r.iconic,
                // 2026-11-21：最大化窗口的 rect 是负原点（-11,-11）的合法值，
                // 调用方要靠这个标记区分「合法最大化」与「真的跑出屏幕」。
                "maximized": r.maximized,
                "rect": {"x": r.x, "y": r.y, "w": r.w, "h": r.h},
                "count": r.count, "error": r.error, "warning": r.warning,
                "us": t0.elapsed().as_micros() as u64,
            }));
            return;
        }
        if req.cmd == "fg" {
            pet_core::native::enable_dpi_awareness();
            let (ok, hwnd, title) = pet_core::native::foreground();
            // 2026-11-10 回归审计：补 pid。工具描述与 list_windows 给的是 pid，
            // 而这里原来只有 hwnd/title → 按 pid 断言前台永远不匹配。
            let pid = pet_core::native::foreground_pid();
            // 2026-11-17 世界感知：补进程名（标题会变，进程名稳定）——加字段不改旧字段
            let app = pet_core::native::process_app_name(pid);
            emit!("{}", json!({"ok": ok, "hwnd": hwnd, "title": title, "pid": pid, "app": app}));
            return;
        }
        // 世界快照（2026-11-17 六十二轮）：前台 + 空闲 + 媒体会话，一次往返。
        // 为什么合成一个命令：这三个源都要每秒读一次，分开问就是三次跨进程往返。
        if req.cmd == "world" {
            pet_core::native::enable_dpi_awareness();
            let with_media = req.media != Some(false);
            let snap = pet_core::native::world_snapshot(with_media);
            emit!("{}", serde_json::to_string(&snap).unwrap_or_else(|_| "{\"ok\":false}".into()));
            return;
        }
        // 只要空闲时长（低功耗模式用：连 SMTC 都不读）
        if req.cmd == "idle" {
            emit!("{}", json!({"ok": true, "idle_ms": pet_core::native::user_idle_ms()}));
            return;
        }
        if req.cmd == "keys" {
            pet_core::native::enable_dpi_awareness();
            let keys = req.keys.unwrap_or_default();
            if keys.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 keys"}));
                return;
            }
            // dry-run：只解析键名、不发送。
            // 为什么需要：验证「参数链路正确」这件事实在不需要真的敲键盘 ——
            // 尤其在用户玩游戏时，发按键会干扰（用户会看到角色乱跑）。
            // 所以把「解析正确性」和「发送有效性」拆开验：
            //   解析 = 可以随时测（dry_run）
            //   发送 = 只在安全窗口（记事本）测
            if req.dry_run == Some(true) {
                match pet_core::native::parse_keys(&keys) {
                    Ok(v) => {
                        let parsed: Vec<serde_json::Value> = v.iter().map(|(name, sc, ext)| json!({
                            "key": name, "scancode": sc, "extended": ext,
                        })).collect();
                        emit!("{}", json!({
                            "ok": true, "dryRun": true, "keys": parsed,
                            "note": "只解析未发送",
                        }));
                    }
                    Err(e) => emit!("{}", json!({"ok": false, "dryRun": true, "error": e})),
                }
                return;
            }
            let t0 = std::time::Instant::now();
            // 目标前台断言（2026-11-14 五十三轮）：target 给了就必须对得上前台，
            // 否则 SendInput 会把按键打进用户正在用的应用。
            if let Some(t) = req.target.as_deref() {
                if let Err(e) = assert_target_foreground(t) { emit!("{}", e); return; }
            }
            let r = pet_core::native::send_keys(&keys, req.hold_ms.unwrap_or(0));
            emit!("{}", json!({
                "ok": r.ok, "sent": r.sent, "error": r.error,
                "us": t0.elapsed().as_micros() as u64,
            }));
            return;
        }
        // ── 非阻塞输入：按下/松开分离（2026-11-14 五十三轮 P1）──────────────
        if req.cmd == "key_down" || req.cmd == "key_up" {
            let keys = req.keys.clone().unwrap_or_default();
            if keys.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 keys"}));
                return;
            }
            let down = req.cmd == "key_down";
            if down {
                // 一次性进程里按下就没人松开了 —— 直接拒绝，别把键卡在按下状态
                if !SERVE_MODE.load(std::sync::atomic::Ordering::Relaxed) {
                    emit!("{}", json!({"ok": false,
                        "error": "key_down 需要常驻模式（一次性进程退出后键会一直按着）—— 用 pet-core serve"}));
                    return;
                }
                if let Some(t) = req.target.as_deref() {
                    if let Err(e) = assert_target_foreground(t) { emit!("{}", e); return; }
                }
            }
            let r = pet_core::native::key_state(&keys, down);
            emit!("{}", json!({
                "ok": r.ok, "sent": r.sent, "error": r.error, "down": down,
            }));
            return;
        }
        // ── 后台键盘（PostMessage）：GLFW 丢注入式输入但认投递消息（实测结论）──
        if req.cmd == "post_key_down" || req.cmd == "post_key_up" {
            let keys = req.keys.clone().unwrap_or_default();
            if keys.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 keys"}));
                return;
            }
            let down = req.cmd == "post_key_down";
            if down && !SERVE_MODE.load(std::sync::atomic::Ordering::Relaxed) {
                emit!("{}", json!({"ok": false,
                    "error": "post_key_down 需要常驻模式（一次性进程退出后没人发 key_up，游戏会一直走）"}));
                return;
            }
            let target = req.target.as_deref().unwrap_or("");
            if target.trim().is_empty() {
                emit!("{}", json!({"ok": false, "error": "post_key_* 需要 target（窗口标题或 hwnd）"}));
                return;
            }
            match pet_core::native::post_key_state(target, &keys, down) {
                Ok(n) => emit!("{}", json!({"ok": true, "sent": n, "down": down})),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "post_keys" {
            let keys = req.keys.clone().unwrap_or_default();
            if keys.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 keys"}));
                return;
            }
            let target = req.target.as_deref().unwrap_or("");
            if target.trim().is_empty() {
                emit!("{}", json!({"ok": false, "error": "post_keys 需要 target"}));
                return;
            }
            // 点按：按住 holdMs（默认 90ms —— GLFW 按帧处理，20ms 太短会被合并成一个瞬时事件）
            let hold = req.hold_ms.unwrap_or(90).max(30);
            if let Err(e) = pet_core::native::post_key_state(target, &keys, true) {
                emit!("{}", json!({"ok": false, "error": e}));
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(hold as u64));
            match pet_core::native::post_key_state(target, &keys, false) {
                Ok(n) => emit!("{}", json!({"ok": true, "sent": n, "holdMs": hold})),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "post_text" {
            let text = req.text.clone().unwrap_or_default();
            let target = req.target.as_deref().unwrap_or("");
            if text.is_empty() || target.trim().is_empty() {
                emit!("{}", json!({"ok": false, "error": "post_text 需要 target + text"}));
                return;
            }
            match pet_core::native::post_text(target, &text) {
                Ok(n) => emit!("{}", json!({"ok": true, "sent": n})),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "release_all" {
            let n = pet_core::native::release_all_inputs();
            emit!("{}", json!({"ok": true, "released": n}));
            return;
        }
        if req.cmd == "mouse_down" || req.cmd == "mouse_up" {
            let btn = req.button.clone().unwrap_or_else(|| "left".to_string());
            let down = req.cmd == "mouse_down";
            if down {
                if !SERVE_MODE.load(std::sync::atomic::Ordering::Relaxed) {
                    emit!("{}", json!({"ok": false,
                        "error": "mouse_down 需要常驻模式（一次性进程退出后键会一直按着）"}));
                    return;
                }
                if let Some(t) = req.target.as_deref() {
                    if let Err(e) = assert_target_foreground(t) { emit!("{}", e); return; }
                }
            }
            match pet_core::native::mouse_button_state(&btn, down) {
                Ok(()) => emit!("{}", json!({"ok": true, "button": btn, "down": down})),
                Err(e) => emit!("{}", json!({"ok": false, "error": e})),
            }
            return;
        }
        if req.cmd == "text" {
            pet_core::native::enable_dpi_awareness();
            let text = req.text.unwrap_or_default();
            if text.is_empty() {
                emit!("{}", json!({"ok": false, "error": "缺少 text"}));
                return;
            }
            if req.dry_run == Some(true) {
                // 逐字符给出码点 + 类型（newline 会走 VK_RETURN 而不是 UNICODE）
                let plan: Vec<serde_json::Value> = text.chars().map(|ch| {
                    if ch == std::char::from_u32(10).unwrap() {
                        json!({"ch": "\n", "via": "VK_RETURN", "scancode": 0x1C})
                    } else {
                        json!({"ch": ch.to_string(), "via": "UNICODE", "codepoint": ch as u32})
                    }
                }).collect();
                emit!("{}", json!({
                    "ok": true, "dryRun": true, "count": text.chars().count(),
                    "plan": plan, "note": "只解析未发送",
                }));
                return;
            }
            let t0 = std::time::Instant::now();
            // 目标前台断言（2026-11-14 五十三轮）：打字同样只落到前台窗口。
            if let Some(t) = req.target.as_deref() {
                if let Err(e) = assert_target_foreground(t) { emit!("{}", e); return; }
            }
            let r = pet_core::native::type_text(&text);
            emit!("{}", json!({
                "ok": r.ok, "sent": r.sent, "error": r.error,
                "us": t0.elapsed().as_micros() as u64,
            }));
            return;
        }
    }

    if req.cmd == "knowledge_search" {
        // 知识库混合检索（BM25 + 向量 + RRF）。
        // 调用方（JS）负责把三层合并成扁平 docs 并预先算好向量 —— Rust 只做纯计算。
        let docs = req.docs.unwrap_or_default();
        let query = req.query.unwrap_or_default();
        let qv = req.query_vec.unwrap_or_default();
        let k = req.top_k.unwrap_or(8).clamp(1, 50);
        let t0 = std::time::Instant::now();
        let r = pet_core::knowledge::search(&docs, &query, &qv, k);
        let total_us = t0.elapsed().as_micros() as u64;
        emit!(
            "{}",
            json!({
                "ok": true,
                "hits": r.hits,
                "trace": r.trace,
                "total_us": total_us,
            })
        );
        return;
    }
    if req.cmd == "mood" {
        // 心情数学：score + wounds 进，describe 出。IO（读心情.json）留在 JS 侧。
        let now_ms = req.now.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0)
        });
        let store = mood::MoodStore { score: req.score.unwrap_or(0.0), wounds: req.wounds.unwrap_or_default() };
        let d = store.describe(now_ms);
        emit!("{}", json!({"ok": true, "mood": d.mood, "emo": d.emo, "line": d.line, "score": d.score, "residue": d.residue}));
        return;
    }
    let (pet, work) = match (req.pet, req.work) {
        (Some(p), Some(w)) => (p, w),
        _ => { emit!("{}", json!({"ok": false, "error": "missing pet/work"})); return; }
    };
    let size = req.panel.unwrap_or((520, 720));
    let (x, y) = match req.cmd.as_str() {
        "panel" => placement::panel_position(&pet, size, &work),
        "subtitle" => {
            // 上下都放不下时优先用窄版侧位（调用方给 side_panel），
            // 窄版也放不下才回退整宽（贴底/侧位都会被 clamp）。
            let main_pos = placement::subtitle_position(&pet, size, &work);
            let below = pet.y + pet.height as i32 + 6;
            let above = pet.y - size.1 as i32 - 6;
            let fits = below <= work.y + work.height as i32 - size.1 as i32
                || above >= work.y;
            match (fits, req.side_panel) {
                (false, Some(side)) => match placement::subtitle_side_position(&pet, side, &work) {
                    Some(p) => {
                        // 侧位用窄版尺寸，source 带 side 标记让宿主切换窗口大小
                        emit!("{}", json!({"ok": true, "x": p.0, "y": p.1, "source": "side"}));
                        return;
                    }
                    None => main_pos,
                },
                _ => main_pos,
            }
        }
        other => { emit!("{}", json!({"ok": false, "error": format!("unknown cmd {other}")})); return; }
    };
    emit!("{}", json!({"ok": true, "x": x, "y": y}));
}