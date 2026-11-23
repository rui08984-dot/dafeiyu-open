//! UIA（UI Automation）元素读取 —— Rust 版（2026-11-09 三十五轮）
//!
//! 目标：先只做 `/elements` 一个能力（`FromHandle` + `FindAll(Descendants)` + `CacheRequest`），
//! 和现有 PowerShell 版的 `uia-service.ps1` 对比耗时和节点数。
//!
//! 为什么值得搬：
//!   · PowerShell 版每次要 `Add-Type -AssemblyName UIAutomationClient`（~70ms）
//!     + 通过 PowerShell 的 COM 互操作层访问，每次属性读取都有额外开销
//!   · PowerShell 常驻脆弱（`$ErrorActionPreference='SilentlyContinue'` 会掩盖残骸，
//!     本轮就因此漏了一行死代码）
//!   · Rust 直接 vtable 调用，没有解释器层
//!
//! 关键技术点（都是踩过的）：
//!   1. **`CacheRequest` 必须包含所有要读的属性** —— 否则每个 `GetCachedPropertyValue`
//!      退回跨进程调用（实测：不用 cache 时 799 个元素要 7.5 秒）
//!   2. **`CacheRequest` 不支持缓存 RuntimeId**（`Cached.RuntimeId` 返回 null）——
//!      所以 rid 只能对**已筛选出的元素**逐个 `GetRuntimeId()`（实测 60 个 8ms）
//!   3. **COM 要在同线程初始化**（MTA），CLI 每次是新进程，所以每次都要
//!   4. `FindAllBuildCache` 有附带 cache 的版本，比 `FindAll` + 后处理快

#![cfg(target_os = "windows")]

use serde::Serialize;
use windows::core::{Interface, BSTR};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Ole::{
    SafeArrayAccessData, SafeArrayGetLBound, SafeArrayGetUBound,
    SafeArrayUnaccessData,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement,
    IUIAutomationInvokePattern, IUIAutomationLegacyIAccessiblePattern, IUIAutomationTextPattern,
    IUIAutomationValuePattern,
    TreeScope_Children, TreeScope_Descendants,
    UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId, UIA_ExpandCollapsePatternId,
    UIA_InvokePatternId, UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId,
    UIA_LegacyIAccessiblePatternId, UIA_NamePropertyId, UIA_ProcessIdPropertyId,
    UIA_SelectionItemPatternId, UIA_TextPatternId,
    UIA_TogglePatternId, UIA_ValuePatternId,
};

use crate::native;

#[derive(Debug, Clone, Serialize)]
pub struct UiaElement {
    pub name: String,
    pub ctype: String,
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub cx: i32,
    pub cy: i32,
    pub rid: String,
    pub pid: u32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiaElementsResult {
    pub ok: bool,
    pub title: String,
    pub hwnd: i64,
    pub elements: Vec<UiaElement>,
    /// 扫到的总节点数（筛选前）
    pub scanned: usize,
    /// 耗时（微秒）：分阶段
    pub us_com: u64,
    pub us_find: u64,
    pub us_extract: u64,
    pub us_total: u64,
    pub error: Option<String>,
    /// 三重预算被触发时的原因（"time" / "nodes"）—— null 表示完整返回
    ///
    /// 2026-11-10 三十八轮（抄 #5 的教训：CacheRequest 之前 UIA 能把 CEF 应用拖到
    /// `Responding: False`）。即使有了 CacheRequest，超大窗口一次 FindAll 仍可能
    /// 让**目标应用**卡几秒——所以提取阶段必须有时间/节点上限，超了就返回已拿到的
    /// 部分并如实标注 truncated，让调用方知道「这份清单不完整」。
    pub truncated: Option<String>,
    /// 实际生效的深度（1=仅直接子级，2=全深度）
    pub depth: u32,
}

/// UIA 控制类型 ID → 名字（只列我们筛选会用到的 + 常见的，其余用数字）
fn control_type_name(id: i32) -> String {
    match id {
        50000 => "button".into(),
        50001 => "calendar".into(),
        50002 => "checkbox".into(),
        50003 => "combobox".into(),
        50004 => "edit".into(),
        50005 => "hyperlink".into(),
        50006 => "image".into(),
        50007 => "listitem".into(),
        50008 => "list".into(),
        50009 => "menu".into(),
        50010 => "menubar".into(),
        50011 => "menuitem".into(),
        50012 => "pane".into(),
        50013 => "progressbar".into(),
        50014 => "radiobutton".into(),
        50015 => "scrollbar".into(),
        50016 => "slider".into(),
        50017 => "spinner".into(),
        50018 => "statusbar".into(),
        50019 => "tab".into(),
        50020 => "text".into(),
        50021 => "toolbar".into(),
        50022 => "tooltip".into(),
        50023 => "tree".into(),
        50024 => "treeitem".into(),
        50025 => "custom".into(),
        50026 => "group".into(),
        50027 => "thumb".into(),
        50028 => "datagrid".into(),
        50029 => "dataitem".into(),
        50030 => "document".into(),
        50031 => "splitbutton".into(),
        50032 => "window".into(),
        50033 => "titlebar".into(),
        50034 => "header".into(),
        50035 => "headeritem".into(),
        50036 => "table".into(),
        50037 => "tabitem".into(),
        _ => format!("ct{id}"),
    }
}

/// 从 VARIANT 里取 BSTR 字符串（失败返回空）
fn variant_str(v: &VARIANT) -> String {
    // SAFETY: 只在 VARIANT 的 vt == VT_BSTR 时读 bstrVal。为了安全我们先检查 vt。
    unsafe {
        if v.Anonymous.Anonymous.vt == windows::Win32::System::Variant::VT_BSTR {
            let b: &BSTR = &v.Anonymous.Anonymous.Anonymous.bstrVal;
            return b.to_string();
        }
        // VT_I4 / VT_R8 / VT_BOOL 这些转字符串
        if v.Anonymous.Anonymous.vt == windows::Win32::System::Variant::VT_I4 {
            return v.Anonymous.Anonymous.Anonymous.lVal.to_string();
        }
    }
    String::new()
}

/// 取 int 值（UIA_ControlTypePropertyId / ProcessId 返回 VT_I4）
fn variant_i32(v: &VARIANT) -> i32 {
    // SAFETY: 只读 vt 判定后的联合成员。
    unsafe {
        if v.Anonymous.Anonymous.vt == windows::Win32::System::Variant::VT_I4 {
            v.Anonymous.Anonymous.Anonymous.lVal
        } else {
            0
        }
    }
}

fn variant_bool(v: &VARIANT) -> bool {
    // SAFETY: 只读 vt 判定后的联合成员。
    unsafe {
        if v.Anonymous.Anonymous.vt == windows::Win32::System::Variant::VT_BOOL {
            v.Anonymous.Anonymous.Anonymous.boolVal.0 != 0
        } else {
            false
        }
    }
}

/// 取矩形：UIA_BoundingRectanglePropertyId 返回 VT_R8 | VT_ARRAY（4 个 double）
fn variant_rect(v: &VARIANT) -> Option<(f64, f64, f64, f64)> {
    // SAFETY: 用 VariantToDoubleArray 之外的手工方式读 SAFEARRAY。
    // 这里走 windows crate 的 VariantToRect 辅助（如果存在）；否则手工读。
    // 为了不引额外依赖，手工读 VT_ARRAY | VT_R8。
    unsafe {
        use windows::Win32::System::Variant::{VT_ARRAY, VT_R8};
        let vt = v.Anonymous.Anonymous.vt;
        if vt != (VT_ARRAY | VT_R8) {
            return None;
        }
        let parray = v.Anonymous.Anonymous.Anonymous.parray;
        if parray.is_null() {
            return None;
        }
        // SafeArrayAccessData 拿裸指针
        let mut data: *mut core::ffi::c_void = core::ptr::null_mut();
        if SafeArrayAccessData(parray, &mut data).is_err() {
            return None;
        }
        let lb = SafeArrayGetLBound(parray, 1).unwrap_or(0);
        let ub = SafeArrayGetUBound(parray, 1).unwrap_or(-1);
        let n = (ub - lb + 1).max(0) as usize;
        let mut out = None;
        if n >= 4 {
            let arr = data as *const f64;
            out = Some((
                *arr.add(lb as usize),
                *arr.add(lb as usize + 1),
                *arr.add(lb as usize + 2),
                *arr.add(lb as usize + 3),
            ));
        }
        let _ = SafeArrayUnaccessData(parray);
        out
    }
}

/// 读一个窗口的 UIA 元素（对应 PowerShell 版 `/elements`）。
///
/// `target`：窗口标题子串，或纯数字 hwnd。
/// `max`：最多返回多少个元素（筛选后）。
///
/// 筛选规则和 PowerShell 版对齐：有名字 + 非离屏 + 尺寸 > 2px。
pub fn uia_elements(target: &str, max: usize) -> UiaElementsResult {
    // 默认预算（2026-11-10 三十八轮）：全深度 / 提取 2000ms / 4000 节点
    uia_elements_budgeted(target, max, 2, 2000, 4000)
}

/// 带三重预算的 UIA 扫描（2026-11-10 三十八轮，抄 #5 的教训）。
///
/// - `max_depth`：1 = 只看直接子级（极快，适合「先看看这窗口里有什么」）；
///                2 或更大 = 全深度 Descendants（默认，和旧行为一致）。
/// - `budget_ms`：**提取阶段**的时间上限（0 = 不限）。超了返回已拿到的部分。
/// - `max_nodes`：原始节点序号上限（0 = 不限）。含被筛掉的节点，按扫描成本算。
///
/// 为什么不是「FindAll 时就能中断」：`FindAllBuildCache` 是一次 COM 调用，
/// UIA 侧不提供取消。但真正让目标应用卡住的是**逐元素跨进程取属性**——
/// CacheRequest 已经把 6 个属性合并成一次，提取循环里再设时间/节点闸门，
/// 就把最坏情况的「拖垮目标应用」压到了可控范围（实测 ZCode 979 元素 97–1300ms）。
pub fn uia_elements_budgeted(
    target: &str,
    max: usize,
    max_depth: u32,
    budget_ms: u64,
    max_nodes: usize,
) -> UiaElementsResult {
    let t_start = std::time::Instant::now();
    let depth = if max_depth == 1 { 1u32 } else { 2u32 };
    let mut res = UiaElementsResult {
        ok: false, title: String::new(), hwnd: 0, elements: Vec::new(),
        scanned: 0, us_com: 0, us_find: 0, us_extract: 0, us_total: 0,
        error: None, truncated: None, depth,
    };

    // ① 找窗口（复用 native 的解析逻辑）
    let (hwnd, title) = {
        if let Ok(h) = target.trim().parse::<i64>() {
            let hw = HWND(h as *mut _);
            let mut buf = [0u16; 512];
            // SAFETY: GetWindowTextW 对无效 hwnd 返回 0。
            let n = unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowTextW(hw, &mut buf) };
            (hw, String::from_utf16_lossy(&buf[..n.max(0) as usize]))
        } else {
            let wins = native::list_windows(target, 8);
            let pick = wins.iter().find(|w| !w.iconic).or_else(|| wins.first());
            match pick {
                Some(w) => (HWND(w.hwnd as *mut _), w.title.clone()),
                None => {
                    res.error = Some(format!("没找到窗口：{target}"));
                    res.us_total = t_start.elapsed().as_micros() as u64;
                    return res;
                }
            }
        }
    };
    res.hwnd = hwnd.0 as i64;
    res.title = title;

    // ①b 最小化/屏外检查（2026-11-09 实测发现的重要边界）
    //
    //   ⚠ **UIA 对最小化窗口仍能读出完整的元素树**（实测 Clash Verge 最小化后
    //      Rust 版扫到 240 个节点，而 PowerShell 版直接拒绝）。
    //   但读到的 **BoundingRectangle 是旧值** —— 窗口恢复前记录的那份。
    //   拿这些坐标去点击会点到桌面空白（本项目 §12.2 踩过完全一样的坑）。
    //
    //   所以这里必须和 PowerShell 版行为一致：最小化就拒绝，明确要求先 focus。
    //   「能读」不等于「该用」。
    // SAFETY: IsIconic / GetWindowRect 对无效 hwnd 返回错误码。
    unsafe {
        if windows::Win32::UI::WindowsAndMessaging::IsIconic(hwnd).as_bool() {
            let mut r = windows::Win32::Foundation::RECT::default();
            let _ = windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut r);
            res.error = Some(format!(
                "「{}」最小化了（{},{}）—— UIA 树虽然能读，但坐标是旧值，点了会点到桌面。先 focus_window 恢复",
                res.title, r.left, r.top
            ));
            res.us_total = t_start.elapsed().as_micros() as u64;
            return res;
        }
    }

    // ② COM 初始化（MTA，CLI 单线程足够）
    // SAFETY: CoInitializeEx / CoUninitialize 成对；失败（已初始化）不致命。
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            res.error = Some(format!("CoInitializeEx 失败：{hr:?}"));
            res.us_total = t_start.elapsed().as_micros() as u64;
            return res;
        }
    }
    let _com_guard = ComGuard;   // Drop 时 CoUninitialize
    res.us_com = t_start.elapsed().as_micros() as u64;

    let t_find = std::time::Instant::now();

    // SAFETY: 下面全部是 COM 调用，作用域内有 _com_guard 保证已初始化。
    unsafe {
        let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            Ok(a) => a,
            Err(e) => {
                res.error = Some(format!("CoCreateInstance(CUIAutomation) 失败：{e}"));
                res.us_total = t_start.elapsed().as_micros() as u64;
                return res;
            }
        };

        let root: IUIAutomationElement = match automation.ElementFromHandle(hwnd) {
            Ok(e) => e,
            Err(e) => {
                res.error = Some(format!("ElementFromHandle 失败：{e}"));
                res.us_total = t_start.elapsed().as_micros() as u64;
                return res;
            }
        };

        // ③ CacheRequest：把所有要读的属性都加进去
        //    ⚠ RuntimeId 加不进去（UIA 的缓存机制不支持），只能后面逐个取
        let cache: IUIAutomationCacheRequest = match automation.CreateCacheRequest() {
            Ok(c) => c,
            Err(e) => {
                res.error = Some(format!("CreateCacheRequest 失败：{e}"));
                res.us_total = t_start.elapsed().as_micros() as u64;
                return res;
            }
        };
        if let Ok(cond) = automation.ControlViewCondition() {
            let _ = cache.SetTreeFilter(&cond);
        }
        for pid in [
            UIA_NamePropertyId,
            UIA_ControlTypePropertyId,
            UIA_BoundingRectanglePropertyId,
            UIA_IsOffscreenPropertyId,
            UIA_ProcessIdPropertyId,
            UIA_IsEnabledPropertyId,
        ] {
            let _ = cache.AddProperty(pid);
        }

        // ④ 一次 FindAllBuildCache（带缓存，避免逐元素跨进程）
        // ⚠ 2026-11-09 实测：用 `CreateTrueCondition` 会遍历**所有**后代节点（含非控制元素），
        //   每个都要跨进程读属性 —— ZCode 1019 个节点要 1300ms。
        //   改成 `IsControlElement = true` 的条件（和 PowerShell 版对齐），
        //   只遍历「控制元素」，理论上能少一批。
        //   另外把 TreeFilter 设成 ControlViewCondition（已经设了），双重限制。
        let cond = {
            use windows::Win32::UI::Accessibility::UIA_IsControlElementPropertyId;
            // CreatePropertyCondition 返回 IUIAutomationCondition，我们用它的具体类型再转
            match automation.CreatePropertyCondition(
                UIA_IsControlElementPropertyId,
                &windows::Win32::System::Variant::VARIANT::from(true),
            ) {
                Ok(c) => c,
                Err(_) => match automation.CreateTrueCondition() {
                    Ok(c) => c,
                    Err(e) => {
                        res.error = Some(format!("CreateCondition 失败：{e}"));
                        res.us_total = t_start.elapsed().as_micros() as u64;
                        return res;
                    }
                },
            }
        };
        let scope = if depth == 1 { TreeScope_Children } else { TreeScope_Descendants };
        let found = match root.FindAllBuildCache(scope, &cond, &cache) {
            Ok(a) => a,
            Err(e) => {
                res.error = Some(format!("FindAllBuildCache 失败：{e}"));
                res.us_total = t_start.elapsed().as_micros() as u64;
                return res;
            }
        };

        let scanned = found.Length().unwrap_or(0).max(0) as usize;
        res.scanned = scanned;
        res.us_find = t_find.elapsed().as_micros() as u64;

        let t_extract = std::time::Instant::now();

        // ⑤ 遍历 + 筛选 + 只为入选元素取 RuntimeId
        for i in 0..scanned {
            if res.elements.len() >= max {
                break;
            }
            // 三重预算的节点/时间闸门（2026-11-10 三十八轮）：宁可少给几个，
            // 也不能让目标应用（CEF/Qt 自绘）因为我们连续跨进程读属性而假死。
            if max_nodes > 0 && i >= max_nodes {
                res.truncated = Some("nodes".to_string());
                break;
            }
            if budget_ms > 0 && t_extract.elapsed().as_millis() as u64 >= budget_ms {
                res.truncated = Some("time".to_string());
                break;
            }
            let el = match found.GetElement(i as i32) {
                Ok(e) => e,
                Err(_) => continue,
            };

            // 名字
            let name = match el.GetCachedPropertyValue(UIA_NamePropertyId) {
                Ok(v) => variant_str(&v),
                Err(_) => String::new(),
            };
            if name.is_empty() {
                continue;
            }
            // 离屏
            let offscreen = match el.GetCachedPropertyValue(UIA_IsOffscreenPropertyId) {
                Ok(v) => variant_bool(&v),
                Err(_) => false,
            };
            if offscreen {
                continue;
            }
            // 矩形
            let rect = match el.GetCachedPropertyValue(UIA_BoundingRectanglePropertyId) {
                Ok(v) => variant_rect(&v),
                Err(_) => None,
            };
            let Some((x, y, w, h)) = rect else { continue };
            if w <= 2.0 || h <= 2.0 {
                continue;
            }
            // 控制类型
            let ctype_id = match el.GetCachedPropertyValue(UIA_ControlTypePropertyId) {
                Ok(v) => variant_i32(&v),
                Err(_) => 0,
            };
            // 进程号
            let pid = match el.GetCachedPropertyValue(UIA_ProcessIdPropertyId) {
                Ok(v) => variant_i32(&v) as u32,
                Err(_) => 0,
            };
            let enabled = match el.GetCachedPropertyValue(UIA_IsEnabledPropertyId) {
                Ok(v) => variant_bool(&v),
                Err(_) => true,
            };

            // RuntimeId：只为入选元素取（CacheRequest 不支持缓存它）
            // SAFETY: GetRuntimeId 返回 *mut SAFEARRAY，用 SafeArrayAccessData 读 int 数组。
            // 读不到就留空（rid 只是给 click_element 用的，不是必须）。
            let rid = {
                let mut out = String::new();
                if let Ok(parr) = el.GetRuntimeId() {
                    if !parr.is_null() {
                        let mut data: *mut core::ffi::c_void = core::ptr::null_mut();
                        if SafeArrayAccessData(parr, &mut data).is_ok() {
                            let lb = SafeArrayGetLBound(parr, 1).unwrap_or(0);
                            let ub = SafeArrayGetUBound(parr, 1).unwrap_or(-1);
                            let n = (ub - lb + 1).max(0) as usize;
                            if n > 0 && !data.is_null() {
                                let arr = data as *const i32;
                                let mut parts = Vec::with_capacity(n);
                                for k in 0..n {
                                    parts.push((*arr.add(lb as usize + k)).to_string());
                                }
                                out = parts.join("-");
                            }
                            let _ = SafeArrayUnaccessData(parr);
                        }
                        let _ = windows::Win32::System::Ole::SafeArrayDestroy(parr);
                    }
                }
                out
            };

            res.elements.push(UiaElement {
                name: name.clone(),
                ctype: control_type_name(ctype_id),
                x: x as i32, y: y as i32,
                w: w as i32, h: h as i32,
                cx: (x + w / 2.0) as i32,
                cy: (y + h / 2.0) as i32,
                rid,
                pid,
                enabled,
            });
        }

        res.us_extract = t_extract.elapsed().as_micros() as u64;
    }

    res.ok = true;
    res.us_total = t_start.elapsed().as_micros() as u64;
    res
}

// ═══════════════════════════════════════════════════════════════════════════
// UIA 语义动作（2026-11-14 四十八轮续）
//
// 为什么需要这一层（对照 ZCode CUA 的「accessibility first」原则）：
//   · 坐标点击要抢前台、会被悬浮窗吃掉、遮挡了就点错
//   · 语义动作（Invoke / SetValue / DoDefaultAction）**后台窗口也能操作**，
//     不抢用户焦点，失败会明确报错（而不是靠画面对比猜）
//   · 我们原来 30 个动作里能碰控件的只有坐标点击 + WM_SETTEXT —— 这一层是空白的
//
// rid 的格式与 uia_elements 一致：RuntimeId 的 int 数组用 `-` 连接。
// ⚠ rid 会随窗口重建失效 —— 找不到时必须 fail-closed 并提示重新 snapshot，
//   绝不能退化成「按坐标猜一个」。
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
pub struct UiaActionResult {
    pub ok: bool,
    pub action: String,
    pub rid: String,
    pub name: String,
    pub ctype: String,
    /// get_value 读到的当前值（"value" 动作专用）
    pub value: Option<String>,
    /// 这个元素**支持**哪些语义动作（让模型先看再选，别瞎试）
    pub actions: Vec<String>,
    pub detail: Option<String>,
    pub us: u64,
}

/// 列出一个元素支持的语义动作。顺序即推荐优先级。
fn list_patterns(el: &IUIAutomationElement) -> Vec<String> {
    let mut out = Vec::new();
    let mut has = |id, name: &str| {
        // SAFETY: GetCurrentPattern 只读属性；失败仅表示不支持该 pattern。
        if unsafe { el.GetCurrentPattern(id) }.is_ok() {
            out.push(name.to_string());
        }
    };
    has(UIA_InvokePatternId, "invoke");
    has(UIA_ValuePatternId, "set_value");
    has(UIA_SelectionItemPatternId, "select");
    has(UIA_TogglePatternId, "toggle");
    has(UIA_ExpandCollapsePatternId, "expand_collapse");
    has(UIA_TextPatternId, "select_text");
    has(UIA_LegacyIAccessiblePatternId, "default_action");
    out
}

fn runtime_id_string(el: &IUIAutomationElement) -> String {
    let mut out = String::new();
    // SAFETY: GetRuntimeId 返回 SAFEARRAY；下面成对 Access/Unaccess/Destroy。
    unsafe {
        if let Ok(parr) = el.GetRuntimeId() {
            if !parr.is_null() {
                let mut data: *mut core::ffi::c_void = core::ptr::null_mut();
                if SafeArrayAccessData(parr, &mut data).is_ok() {
                    let lb = SafeArrayGetLBound(parr, 1).unwrap_or(0);
                    let ub = SafeArrayGetUBound(parr, 1).unwrap_or(-1);
                    let n = (ub - lb + 1).max(0) as usize;
                    if n > 0 && !data.is_null() {
                        let arr = data as *const i32;
                        let mut parts = Vec::with_capacity(n);
                        for k in 0..n {
                            parts.push((*arr.add(lb as usize + k)).to_string());
                        }
                        out = parts.join("-");
                    }
                    let _ = SafeArrayUnaccessData(parr);
                }
                let _ = windows::Win32::System::Ole::SafeArrayDestroy(parr);
            }
        }
    }
    out
}

/// 在目标窗口里按 rid 找元素并执行语义动作。
///
/// action ∈ invoke / set_value / get_value / focus / perform_action / actions
pub fn uia_action(
    target: &str,
    rid: &str,
    action: &str,
    value: Option<&str>,
) -> UiaActionResult {
    let t0 = std::time::Instant::now();
    let mut res = UiaActionResult {
        ok: false, action: action.to_string(), rid: rid.to_string(),
        name: String::new(), ctype: String::new(), value: None,
        actions: Vec::new(), detail: None, us: 0,
    };
    if rid.trim().is_empty() {
        res.detail = Some("rid 为空：先 uia_elements 拿元素的 rid".into());
        res.us = t0.elapsed().as_micros() as u64;
        return res;
    }

    // ① 找窗口（和 uia_elements 同一套解析：标题子串或纯数字 hwnd）
    let hwnd = {
        if let Ok(h) = target.trim().parse::<i64>() {
            HWND(h as *mut _)
        } else {
            let wins = native::list_windows(target, 8);
            match wins.iter().find(|w| !w.iconic).or_else(|| wins.first()) {
                Some(w) => HWND(w.hwnd as *mut _),
                None => {
                    res.detail = Some(format!("没找到窗口：{target}"));
                    res.us = t0.elapsed().as_micros() as u64;
                    return res;
                }
            }
        }
    };

    // SAFETY: 整个块在 ComGuard 作用域内，COM 已初始化。
    unsafe {
        if CoInitializeEx(None, COINIT_MULTITHREADED).is_err() {
            res.detail = Some("CoInitializeEx 失败".into());
            res.us = t0.elapsed().as_micros() as u64;
            return res;
        }
        let _com_guard = ComGuard;

        let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            Ok(a) => a,
            Err(e) => { res.detail = Some(format!("CUIAutomation 创建失败：{e}")); res.us = t0.elapsed().as_micros() as u64; return res; }
        };
        let root: IUIAutomationElement = match automation.ElementFromHandle(hwnd) {
            Ok(e) => e,
            Err(e) => { res.detail = Some(format!("ElementFromHandle 失败：{e}")); res.us = t0.elapsed().as_micros() as u64; return res; }
        };
        // ⚠ 这里故意**不用** IsControlElement 条件：图标按钮常常 name 为空/不是控制元素，
        //   而它们恰恰是最需要语义动作的（工具栏）。用 TrueCondition 全遍历 + 命中即 break。
        let cond = match automation.CreateTrueCondition() {
            Ok(c) => c,
            Err(e) => { res.detail = Some(format!("CreateTrueCondition 失败：{e}")); res.us = t0.elapsed().as_micros() as u64; return res; }
        };
        let found = match root.FindAll(TreeScope_Descendants, &cond) {
            Ok(a) => a,
            Err(e) => { res.detail = Some(format!("FindAll 失败：{e}")); res.us = t0.elapsed().as_micros() as u64; return res; }
        };
        let n = found.Length().unwrap_or(0).max(0);
        let mut goal: Option<IUIAutomationElement> = None;
        for i in 0..n {
            let el = match found.GetElement(i) {
                Ok(e) => e,
                Err(_) => continue,
            };
            if runtime_id_string(&el) == rid {
                goal = Some(el);
                break;
            }
        }
        let el = match goal {
            Some(e) => e,
            None => {
                res.detail = Some(format!("元素已失效（扫了 {n} 个节点没找到 rid={rid}）—— 窗口内容变过了，重新 snapshot 拿新 rid"));
                res.us = t0.elapsed().as_micros() as u64;
                return res;
            }
        };

        // ② 元素身份（诊断用：模型可能传错 rid，先把真实目标报回去）
        res.name = match el.GetCurrentPropertyValue(UIA_NamePropertyId) {
            Ok(v) => variant_str(&v),
            Err(_) => String::new(),
        };
        let ctype_id = match el.GetCurrentPropertyValue(UIA_ControlTypePropertyId) {
            Ok(v) => variant_i32(&v),
            Err(_) => 0,
        };
        res.ctype = control_type_name(ctype_id);
        res.actions = list_patterns(&el);

        // ③ 分派
        let outcome: Result<(), String> = (|| match action {
            "actions" | "list" => Ok(()),
            "invoke" => {
                let p: IUIAutomationInvokePattern = el
                    .GetCurrentPatternAs(UIA_InvokePatternId)
                    .map_err(|e| format!("这个元素不支持 invoke（{e}）。支持的：{}", res.actions.join("/")))?;
                p.Invoke().map_err(|e| format!("Invoke 调用失败：{e}"))
            }
            "set_value" => {
                let v = value.ok_or_else(|| "set_value 需要 value".to_string())?;
                let p: IUIAutomationValuePattern = el
                    .GetCurrentPatternAs(UIA_ValuePatternId)
                    .map_err(|e| format!("这个元素不支持 set_value（{e}）。支持的：{}", res.actions.join("/")))?;
                let ro = p.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false);
                if ro {
                    return Err("这个控件是只读的（IsReadOnly=true），set_value 会被静默忽略 —— 改用 type_text/click 后输入".to_string());
                }
                p.SetValue(&BSTR::from(v)).map_err(|e| format!("SetValue 失败：{e}"))
            }
            "get_value" => {
                let p: IUIAutomationValuePattern = el
                    .GetCurrentPatternAs(UIA_ValuePatternId)
                    .map_err(|e| format!("这个元素不支持 get_value（{e}）"))?;
                match p.CurrentValue() {
                    Ok(s) => { res.value = Some(s.to_string()); Ok(()) }
                    Err(e) => Err(format!("CurrentValue 失败：{e}")),
                }
            }
            "focus" => el.SetFocus().map_err(|e| format!("SetFocus 失败：{e}")),
            "select_text" => {
                // 在文本控件里选中指定文字（2026-11-14，对照 Codex 的 select_text）。
                // 用途：把输入框里某一段选中后改掉，而不是全选重打。
                // 比 Codex 少的是 prefix/suffix 消歧（那需要在树里做多次 FindText + 上下文比对），
                // 先做基础版：找第一个匹配、读回选中的内容、如实返回。
                let needle = value.ok_or_else(|| "select_text 需要 value（要选中的文字）".to_string())?;
                let tp: IUIAutomationTextPattern = el
                    .GetCurrentPatternAs(UIA_TextPatternId)
                    .map_err(|e| format!("这个元素不支持 select_text（{e}）。只有文本类控件（Edit/Document）有 TextPattern；不支持的改用 focus + press_key ctrl+a 全选"))?;
                let doc = tp.DocumentRange().map_err(|e| format!("DocumentRange 失败：{e}"))?;
                let range = doc
                    .FindText(&BSTR::from(needle), false, true)
                    .map_err(|e| format!("在控件里没找到「{needle}」（确认文字完全一致，含空格和标点）：{e}"))?;
                // 读回选中内容：FindText 可能命中近似位置，让模型看到实际选中了什么
                let got = range.GetText(256).map(|s| s.to_string()).unwrap_or_default();
                if got.trim().is_empty() {
                    return Err(format!("找到了「{needle}」但读回是空的 —— 元素可能已失效，重新 snapshot 拿新 rid"));
                }
                range.Select().map_err(|e| format!("选中失败：{e}"))?;
                res.value = Some(got);
                Ok(())
            }
            "perform_action" | "default_action" => {
                let p: IUIAutomationLegacyIAccessiblePattern = el
                    .GetCurrentPatternAs(UIA_LegacyIAccessiblePatternId)
                    .map_err(|e| format!("这个元素不支持 default_action（{e}）。支持的：{}", res.actions.join("/")))?;
                p.DoDefaultAction().map_err(|e| format!("DoDefaultAction 失败：{e}"))
            }
            other => Err(format!("不认识的 action：{other}（可用 invoke/set_value/get_value/focus/perform_action/actions）")),
        })();

        match outcome {
            Ok(()) => res.ok = true,
            Err(e) => res.detail = Some(e),
        }
    }

    res.us = t0.elapsed().as_micros() as u64;
    res
}

/// COM 生命周期的 RAII 守卫
struct ComGuard;
impl Drop for ComGuard {
    fn drop(&mut self) {
        // SAFETY: 与 CoInitializeEx 成对的 CoUninitialize。
        unsafe { CoUninitialize() };
    }
}

/// 抑制未使用 import 警告（BSTR/Interface 在部分 feature 组合下用不到）
#[allow(dead_code)]
fn _unused() {
    let _: Option<BSTR> = None;
    let _ = <IUIAutomationElement as Interface>::IID;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_type_names() {
        assert_eq!(control_type_name(50000), "button");
        assert_eq!(control_type_name(50004), "edit");
        assert_eq!(control_type_name(50020), "text");
        assert_eq!(control_type_name(50012), "pane");
        assert_eq!(control_type_name(99999), "ct99999");
    }
}

// ── UIA 全文读取（2026-11-15 六十轮）──────────────────────────────────────
//
// 为什么补：`see mode=text` 现在走 OCR（全窗实测 4.87s，还会把「l」认成「1」）。
// 而原生文本控件（记事本/浏览器文档/各种 Edit）本来就通过 UIA TextPattern **直接给出文字**，
// 零识别误差、毫秒级。OCR 应该只作兜底。
//
// 取舍：
// · 先试窗口根元素的 TextPattern（记事本、浏览器 document 都直接有）
// · 没有再在后代里找（最多扫 400 个控制元素，避免 CEF 自绘应用把 UIA 拖死）
// · 只读，不发任何输入；读不到就给明确原因，不假装成功

#[derive(Debug, Clone, Serialize)]
pub struct UiaTextResult {
    pub ok: bool,
    pub hwnd: i64,
    pub title: String,
    pub chars: usize,
    pub text: String,
    pub detail: Option<String>,
    pub us: u64,
}

fn read_text_from(el: &IUIAutomationElement, max_chars: usize) -> Option<String> {
    use windows::Win32::UI::Accessibility::UIA_TextPatternId;
    // SAFETY: 全部是 UIA 只读查询；对不支持 TextPattern 的元素返回 Err，不崩。
    // （这个 windows crate 版本把 GetText/DocumentRange 标成了 unsafe fn）
    unsafe {
        let tp: IUIAutomationTextPattern = el.GetCurrentPatternAs(UIA_TextPatternId).ok()?;
        let range = tp.DocumentRange().ok()?;
        let cap = if max_chars > 0 { max_chars as i32 } else { 8000 };
        let b: BSTR = range.GetText(cap).ok()?;
        let s = b.to_string();
        if s.trim().is_empty() { None } else { Some(s) }
    }
}

/// 读一个窗口里的文本（UIA TextPattern）。读不到返回 detail 说明原因。
pub fn uia_text(target: &str, max_chars: usize) -> UiaTextResult {
    let t0 = std::time::Instant::now();
    let mut res = UiaTextResult {
        ok: false, hwnd: 0, title: String::new(), chars: 0,
        text: String::new(), detail: None, us: 0,
    };
    let target = String::from(target).trim().to_string();
    if target.is_empty() {
        res.detail = Some("缺少 target（窗口标题子串或 hwnd）".to_string());
        res.us = t0.elapsed().as_micros() as u64;
        return res;
    }
    let hwnd = if let Ok(h) = target.parse::<i64>() {
        HWND(h as *mut _)
    } else {
        let wins = native::list_windows(&target, 8);
        match wins.iter().find(|w| !w.iconic).or_else(|| wins.first()) {
            Some(w) => HWND(w.hwnd as *mut _),
            None => {
                res.detail = Some(format!("没找到窗口：{target}"));
                res.us = t0.elapsed().as_micros() as u64;
                return res;
            }
        }
    };
    res.hwnd = hwnd.0 as i64;

    // SAFETY: CoInitializeEx/CoUninitialize 成对；都失败也不致命（可能已初始化）。
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            res.detail = Some(format!("CoInitializeEx 失败：{hr:?}"));
            res.us = t0.elapsed().as_micros() as u64;
            return res;
        }
        let automation: IUIAutomation = match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
            Ok(a) => a,
            Err(e) => {
                CoUninitialize();
                res.detail = Some(format!("CoCreateInstance(CUIAutomation) 失败：{e}"));
                res.us = t0.elapsed().as_micros() as u64;
                return res;
            }
        };
        let root: IUIAutomationElement = match automation.ElementFromHandle(hwnd) {
            Ok(r) => r,
            Err(e) => {
                CoUninitialize();
                res.detail = Some(format!("ElementFromHandle 失败：{e}"));
                res.us = t0.elapsed().as_micros() as u64;
                return res;
            }
        };
        if let Ok(n) = root.CurrentName() { res.title = n.to_string(); }

        // 先试根元素（记事本/浏览器 document 直接就有全文），**再拼后代**——
        // 只取第一段会让 Chromium 只读到输入框占位符（实测：她自己的窗只回了「输入消息，回车发送」）。
        // 拼接去重后按 max_chars 截断，浏览器/富文本控件的整页文字才拿得全。
        let mut parts: Vec<String> = Vec::new();
        let mut used = 0usize;
        if let Some(t) = read_text_from(&root, max_chars) {
            used += t.chars().count();
            parts.push(t);
        }
        if used < max_chars {
            let cond = automation.ControlViewCondition().unwrap_or_else(|_| automation.CreateTrueCondition().unwrap());
            if let Ok(found) = root.FindAll(TreeScope_Descendants, &cond) {
                let n = found.Length().unwrap_or(0).max(0);
                for i in 0..n.min(400) {
                    if used >= max_chars { break; }
                    if let Ok(el) = found.GetElement(i) {
                        if let Some(t) = read_text_from(&el, max_chars) {
                            let trimmed = t.trim().to_string();
                            if trimmed.is_empty() { continue; }
                            // 避免父子元素重复（UIA 里 document 和它的 edit 常常文本一样）
                            if parts.iter().any(|p| p.contains(&trimmed) || trimmed.contains(p.as_str())) { continue; }
                            used += trimmed.chars().count();
                            parts.push(trimmed);
                        }
                    }
                }
            }
        }
        let text = if parts.is_empty() { None } else { Some(parts.join("\n")) };
        CoUninitialize();

        match text {
            Some(t) => {
                res.chars = t.chars().count();
                res.text = t;
                res.ok = true;
            }
            None => {
                res.detail = Some("这个窗口没有 UIA TextPattern（自绘界面/游戏常见）→ 请用 OCR 兜底（see mode=text 会自动回落）".to_string());
            }
        }
    }

    res.us = t0.elapsed().as_micros() as u64;
    res
}
