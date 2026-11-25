// control-verify.js —— 点击/聚焦的「验证通道」收口（2026-11-25 P0-3）
//
// 为什么单独做一层：
//   审计（docs/research/操控与闸管线-功能审计-2026-11-25.md P0-3）定性的病根是
//   「动作通道」和「验证通道」不是同一块屏幕：
//     · click_element 走 UIA Invoke（不需要前台/可见性），但验证用屏幕像素采「快照窗口矩形」；
//       窗口被遮挡 / 在副屏 / 移出屏幕时采到的是别人的像素 → 假成功或假 noop。
//     · actAndVerifySmart 是「region 一变化就先判成功」——连 UIA 树都不看。
//   这一层只做**判定**，不做 IO：UIA 回读、像素采样、窗口可见性都由调用方注入。
//   于是纯 Node 测试可以用假 UIA + 假截图把每条分支都钉死，不需要真机。
//
// 判定顺序（对应审计的修法）：
//   ① 首选 UIA：动作前后回读目标元素的可观察状态（ToggleState / Value / IsEnabled /
//      焦点 / 选中项 / 名称 / 是否还在），任一变化 → verified:true, method:'uia'；
//   ② 状态无变化（按钮这类没有状态的控件）→ 只采**目标元素矩形**的局部像素差，
//      超过阈值 → verified:true, method:'pixels'；
//   ③ 目标被遮挡 / 移出虚拟屏幕 / 最小化 → **不猜**，ok:false + verified:false + reason；
//   ④ region（整窗）变化不再是成功判据：本层根本不接收整窗样本，只收元素矩形。
'use strict';

const VC = require('./verify-contract.js');

// 验证失败/无法验证的原因码（同时是契约里的 error 字段，调用方可以按码分支）
const REASON = Object.freeze({
    OCCLUDED: 'occluded',          // 落点属于别的窗口（遮挡）
    OFFSCREEN: 'offscreen',        // 元素/窗口不在可视区（含移出虚拟屏幕）
    MINIMIZED: 'minimized',        // 窗口最小化
    NO_ELEMENT: 'no_element',      // 元素已经不在了（不是「点中了」，而是没法再回读）
    NO_CHANGE: 'no_change',        // 两条通道都采到了，但没有任何变化
    NO_CHANNEL: 'no_channel',      // 两条通道都拿不到（UIA 无树 + 像素采不到）
    ACTION_FAILED: 'action_failed',// 动作根本没发出去
});

const DEFAULT_WAITS = [350, 450];
const DEFAULT_THRESHOLDS = { cell: 8, mean: 3.5 };

function _num(v, dflt) {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
}

function _rect(r) {
    if (!r) return null;
    const x = Number(r.x);
    const y = Number(r.y);
    const w = Number(r.w !== undefined ? r.w : r.width);
    const h = Number(r.h !== undefined ? r.h : r.height);
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
}

/** 两个矩形是否相交（只看面积 > 0 的交集）。给「窗口是否还在虚拟屏幕内」用。 */
function rectsOverlap(a, b) {
    const r1 = _rect(a);
    const r2 = _rect(b);
    if (!r1 || !r2) return false;
    return r1.x < r2.x + r2.w && r2.x < r1.x + r1.w
        && r1.y < r2.y + r2.h && r2.y < r1.y + r1.h;
}

/** 窗口矩形是否和任一显示器矩形相交（false = 完全移出虚拟屏幕）。 */
function windowOnScreens(winRect, displayRects) {
    const list = Array.isArray(displayRects) ? displayRects : [];
    return list.some((d) => rectsOverlap(winRect, d));
}

// ── UIA 元素可观察状态 ─────────────────────────────────────────────────
/**
 * 把「原始元素状态」归一成可比较的形状。
 * 原始形状由 uia-service 的 /element_state 给（见 pet-runtime/tools/uia-service.ps1）。
 * 缺失的字段一律 null（= 读不到），**不**用默认值伪造（伪造会把「读不到」变成「没变化」）。
 */
function normState(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // found 与 ok 分开：ok:false + found:false = 「元素确实不在了」，
    // ok:false 但没给 found = 「这次读失败」（不能当成元素消失）。
    const found = raw.found === undefined || raw.found === null
        ? raw.ok !== false
        : raw.found !== false;
    const s = {
        ok: raw.ok !== false,
        found,
        name: raw.name === undefined || raw.name === null ? '' : String(raw.name),
        type: String(raw.ctype || raw.type || '').toLowerCase(),
        enabled: raw.enabled === undefined || raw.enabled === null ? null : raw.enabled === true,
        offscreen: raw.offscreen === undefined || raw.offscreen === null ? null : raw.offscreen === true,
        focused: raw.focused === undefined || raw.focused === null ? null : raw.focused === true,
        toggle: raw.toggleState === undefined || raw.toggleState === null
            ? null : String(raw.toggleState).toLowerCase(),
        value: raw.value === undefined || raw.value === null ? null : String(raw.value),
        selected: raw.selected === undefined || raw.selected === null ? null : raw.selected === true,
        expand: raw.expandState === undefined || raw.expandState === null
            ? null : String(raw.expandState).toLowerCase(),
        iconic: raw.iconic === true || raw.minimized === true,
        rect: _rect(raw.rects || raw.rect || raw),
    };
    return s;
}

// 参与「变化」比较的字段。为什么排除 rect：
//   滚动/动画/窗口挪动都会让矩形变，那不是「这次点击的后果」，拿它当证据就是假成功。
// 为什么 focused 只认 false→true：
//   点击期间用户可能点到别处，焦点**丢失**不能算「我的点击生效了」；获得焦点才是。
const STATE_FIELDS = ['found', 'name', 'type', 'enabled', 'toggle', 'value', 'selected', 'expand', 'offscreen'];

/**
 * 比较前后状态，返回「变了哪些字段」。
 * before 不可用（null / 读不到）→ 返回空数组（没基线就不能声称有变化）。
 */
function diffState(before, after) {
    const b = before && before.ok ? before : null;
    const a = after && after.ok ? after : null;
    if (!b || !a) return [];
    const changed = [];
    for (const k of STATE_FIELDS) {
        // 两边都读不到 → 无法比较，不算变化（宁可不判，也不假成功）
        if (b[k] === null || a[k] === null) continue;
        if (b[k] !== a[k]) changed.push(k);
    }
    if (b.focused === false && a.focused === true) changed.push('focused');
    return changed;
}

/** 状态变化的「人话证据」：toggle off→on / value "5"→"0" / 元素消失 … */
function describeStateChange(before, after, fields) {
    const list = Array.isArray(fields) ? fields : [];
    const b = before || {};
    const a = after || {};
    const parts = [];
    for (const f of list) {
        if (f === 'found') { parts.push('元素消失（窗口内容重构/按钮已不可点）'); continue; }
        if (f === 'focused') { parts.push('获得焦点'); continue; }
        parts.push(f + ' ' + JSON.stringify(b[f] === null ? '?' : b[f]) + '→' + JSON.stringify(a[f] === null ? '?' : a[f]));
    }
    return parts.join('，');
}

// ── 可见性三分类 ───────────────────────────────────────────────────────
/**
 * 输入：{minimized, offscreen, occluded}（任一可直接给），或元素状态 + 窗口/显示器信息。
 * 返回原因码或 null（= 可见，像素通道可信）。
 * 优先级：最小化 > 屏外 > 遮挡 —— 最小化的窗口一定采样不到，屏外的采样一定是旧帧。
 */
function classifyVisibility(sig) {
    const s = sig || {};
    if (s.minimized === true || s.iconic === true) return REASON.MINIMIZED;
    if (s.offscreen === true) return REASON.OFFSCREEN;
    if (s.occluded === true) return REASON.OCCLUDED;
    return null;
}

// ── 像素差 ─────────────────────────────────────────────────────────────
/** 两次局部灰度特征的差（与 game-control.regionDelta 同口径，但这里是纯函数）。 */
function pixelDelta(a, b) {
    if (!a || !b) return null;
    const ga = Array.isArray(a.gray) ? a.gray : null;
    const gb = Array.isArray(b.gray) ? b.gray : null;
    if (ga && gb) {
        if (!ga.length || ga.length !== gb.length) return null;
        let maxCell = 0;
        for (let i = 0; i < ga.length; i += 1) {
            const d = Math.abs(Number(ga[i]) - Number(gb[i]));
            if (Number.isFinite(d) && d > maxCell) maxCell = d;
        }
        return {
            maxCell,
            meanD: Math.abs(_num(a.mean, 0) - _num(b.mean, 0)),
            stdD: Math.abs(_num(a.std, 0) - _num(b.std, 0)),
        };
    }
    // 只给了 mean/std（测试/降级采样）也能判
    if (Number.isFinite(Number(a.mean)) && Number.isFinite(Number(b.mean))) {
        return { maxCell: Math.abs(Number(a.mean) - Number(b.mean)), meanD: Math.abs(Number(a.mean) - Number(b.mean)), stdD: 0 };
    }
    return null;
}

function pixelChanged(delta, thr) {
    if (!delta) return false;
    const t = thr || DEFAULT_THRESHOLDS;
    return delta.maxCell > t.cell || delta.meanD > t.mean;
}

// ── 主判定：点一次，验一次 ──────────────────────────────────────────────
/**
 * @param {object} opts
 *   action      {Function} 必填；**只会被调用一次**（调两次 = 做两遍）
 *   before      {object}  动作前的元素状态（normState 的输入；null = 没基线）
 *   readState   {Function} 重新回读元素状态（返回 /element_state 的原始形状）
 *   sampleRect  {Function} (rect) => 局部灰度特征（region_gray 的形状）
 *   visibility  {Function} () => {minimized, offscreen, occluded}
 *   rect        {object}   目标元素矩形（像素通道只采这块，不采整窗）
 *   waits       {number[]} 观测等待点（默认 [350, 450]）
 *   sleep       {Function} 注入的等待（测试用零延迟）
 *   thresholds  {object}   {cell, mean}
 *   now         {Function} 注入的时钟
 * @returns {Promise<object>} {ok, verified, method, reason, actionSent, actionResult,
 *                             changedFields, stateBefore, stateAfter, pixel, evidence, elapsedMs}
 */
async function verifyClick(opts) {
    const o = opts || {};
    const waits = Array.isArray(o.waits) && o.waits.length ? o.waits.map((w) => _num(w, 0)) : DEFAULT_WAITS.slice();
    const sleep = typeof o.sleep === 'function' ? o.sleep : ((ms) => new Promise((r) => setTimeout(r, ms)));
    const now = typeof o.now === 'function' ? o.now : Date.now;
    const thr = Object.assign({}, DEFAULT_THRESHOLDS, o.thresholds || {});
    const beforeState = normState(o.before);
    const rect = _rect(o.rect);
    const canPixel = typeof o.sampleRect === 'function' && !!rect;
    const t0 = now();

    // ① 基线（像素）先取：动作发出之后就再也取不到「之前」了
    let beforePix = null;
    if (canPixel) {
        try { beforePix = await o.sampleRect(rect); } catch (e) { beforePix = null; }
    }

    // ② 动作只执行一次
    let actionResult = null;
    let threw = null;
    try {
        actionResult = await o.action();
    } catch (e) {
        threw = e;
    }

    const base = {
        actionSent: false,
        actionResult: actionResult || null,
        stateBefore: beforeState,
        stateAfter: null,
        changedFields: [],
        pixel: null,
        elapsedMs: 0,
    };
    if (threw) {
        // 安全守卫的拒绝必须原样抛出去（上层要回「被守卫拦下」而不是「元素点不到」）
        if (threw && threw.guardBlocked) throw threw;
        return Object.assign({}, base, {
            ok: false, verified: false, method: 'none', reason: REASON.ACTION_FAILED,
            evidence: '动作抛错：' + String(threw && threw.message || threw).slice(0, 120),
            elapsedMs: now() - t0,
        });
    }
    if (actionResult && actionResult.ok === false) {
        return Object.assign({}, base, {
            ok: false, verified: false, method: 'none', reason: REASON.ACTION_FAILED,
            evidence: '底层动作返回 ok:false' + (actionResult.error ? '：' + String(actionResult.error).slice(0, 120) : ''),
            elapsedMs: now() - t0,
        });
    }
    base.actionSent = true;

    // ③ 可见性：像素通道可不可信只取决于这一步；UIA 通道不受影响（后台 Invoke 本来就不用前台）
    let vis = null;
    try { vis = o.visibility ? await o.visibility() : null; } catch (e) { vis = null; }
    const blocked = classifyVisibility(vis);

    let uiaRead = false;
    let pixelRead = false;
    let lastState = beforeState;
    let lastPixel = null;

    // ④ 观测：每个等待点先看 UIA，再看像素（像素只在可见时采）
    for (const w of waits) {
        await sleep(w);
        if (typeof o.readState === 'function') {
            let raw = null;
            try { raw = await o.readState(); } catch (e) { raw = null; }
            const st = normState(raw);
            if (st && st.ok) {
                uiaRead = true;
                const fields = diffState(beforeState, st);
                if (fields.length) {
                    return Object.assign({}, base, {
                        ok: true, verified: true, method: 'uia', reason: null,
                        stateAfter: st, changedFields: fields,
                        evidence: 'UIA 状态变化：' + describeStateChange(beforeState, st, fields),
                        elapsedMs: now() - t0,
                    });
                }
                lastState = st;
            } else if (st && st.found === false && beforeState && beforeState.found === true) {
                // 元素明确不在了（且不是「本来就不在」）→ 树结构确实变了，这是可观测后果
                uiaRead = true;
                return Object.assign({}, base, {
                    ok: true, verified: true, method: 'uia', reason: null,
                    stateAfter: st, changedFields: ['found'],
                    evidence: 'UIA 状态变化：元素消失（窗口内容重构/按钮已不可点）',
                    elapsedMs: now() - t0,
                });
            }
        }
        if (canPixel && beforePix && !blocked) {
            let afterPix = null;
            try { afterPix = await o.sampleRect(rect); } catch (e) { afterPix = null; }
            if (afterPix) {
                pixelRead = true;
                const d = pixelDelta(beforePix, afterPix);
                if (d) {
                    lastPixel = d;
                    if (pixelChanged(d, thr)) {
                        return Object.assign({}, base, {
                            ok: true, verified: true, method: 'pixels', reason: null,
                            stateAfter: lastState, pixel: d,
                            evidence: '目标元素区域像素差 ' + d.maxCell + '（阈值 ' + thr.cell + '）',
                            elapsedMs: now() - t0,
                        });
                    }
                }
            }
        }
    }

    // ⑤ 没验出：先如实说「为什么不能验」，再说「都验了但没变化」
    const tail = { stateAfter: lastState, pixel: lastPixel, elapsedMs: now() - t0 };
    if (blocked) {
        return Object.assign({}, base, tail, {
            ok: false, verified: false, method: 'none', reason: blocked,
            evidence: {
                occluded: '目标窗口被遮挡（落点属于别的窗口）——屏幕像素不是目标的像素，不猜',
                offscreen: '目标窗口/元素不在可视区（移出虚拟屏幕或已滚出）——采样一定是旧帧，不猜',
                minimized: '目标窗口最小化了——采样一定是旧帧，不猜',
            }[blocked] || ('不可验证：' + blocked),
        });
    }
    if (!uiaRead && !pixelRead) {
        return Object.assign({}, base, tail, {
            ok: false, verified: false, method: 'none', reason: REASON.NO_CHANNEL,
            evidence: 'UIA 回读与像素采样都拿不到（窗口无 UIA 树 / pet-core 不可用）',
        });
    }
    return Object.assign({}, base, tail, {
        ok: false, verified: false, method: uiaRead ? 'uia' : 'pixels', reason: REASON.NO_CHANGE,
        evidence: uiaRead
            ? 'UIA 状态前后一致' + (lastPixel ? '，目标元素区域像素差 ' + lastPixel.maxCell + '（阈值 ' + thr.cell + '）' : '')
            : '目标元素区域像素差 ' + (lastPixel ? lastPixel.maxCell : '?') + '（阈值 ' + thr.cell + '）',
    });
}

// ── 契约层：把验证结论翻成 VC 形状 ─────────────────────────────────────
const REASON_TEXT = {
    occluded: '目标窗口被遮挡（被别的窗口压着）',
    offscreen: '目标窗口/元素不在可视区（屏外或移出虚拟屏幕）',
    minimized: '目标窗口最小化了',
    no_element: '元素已经不在了（窗口内容刚变过）',
    no_change: '界面没有任何可观察变化（UIA 状态与元素像素都没变）',
    no_channel: '拿不到验证通道（UIA 回读和像素采样都不可用）',
    action_failed: '动作没发出去',
};

/**
 * 点击结果 → 统一契约。三条文案必须能区分：
 *   「点不了」（not_sent）／「点了没验证到」（ok:false + verified:false）／「验证通过」（confirmed）。
 */
function buildClickVerdict(cv, meta) {
    const m = meta || {};
    const r = cv || {};
    const name = String(m.name || '').slice(0, 24);
    const how = String(m.howLabel || '');
    const method = r.method === 'uia' || r.method === 'pixels' ? r.method : 'none';
    const base = {
        method,
        verifyMethod: method,
        verifyReason: r.reason || null,
        changedFields: Array.isArray(r.changedFields) ? r.changedFields : [],
        actionResult: r.actionResult || undefined,
    };

    if (r.reason === REASON.ACTION_FAILED || r.actionSent === false) {
        return VC.notSent('元素点不到（' + (r.evidence || '动作没发出去') + '）', Object.assign(base, { tier: 'L2' }));
    }
    if (r.verified === true && method === 'uia') {
        return VC.confirmed(
            '已点「' + name + '」' + (how ? '（' + how + '）' : '') + '——验证通过：' + (r.evidence || 'UIA 状态变化'),
            Object.assign(base, { tier: 'L2' }),
        );
    }
    if (r.verified === true && method === 'pixels') {
        return VC.confirmed(
            '已点「' + name + '」' + (how ? '（' + how + '）' : '') + '——验证通过：' + (r.evidence || '目标区域像素变化'),
            Object.assign(base, { tier: 'L1' }),
        );
    }
    if (r.reason === REASON.NO_CHANGE) {
        // 我们确实做了前后对比，结论是「没变化」——这是确定的失败，不是「不知道」
        const out = VC.failed(
            '点了「' + name + '」' + (how ? '（' + how + '）' : '') + '，但' + (REASON_TEXT.no_change) + '（' + (r.evidence || '') + '）',
            Object.assign(base, { tier: method === 'uia' ? 'L2' : 'L1' }),
        );
        out.nextIfFailed = '界面没反应：① 控件可能不是真按钮（自绘/纯展示）② 被弹窗盖住 ③ 点击确实没生效。'
            + '先 snapshot / som_snapshot 看现场，别原地重复点';
        return out;
    }
    // 遮挡 / 屏外 / 最小化 / 无通道 → 只能当失败（绝不能当成功）
    const reason = r.reason || REASON.NO_CHANNEL;
    const why = REASON_TEXT[reason] || ('不可验证：' + reason);
    return VC.result({
        ok: false, verified: false, effect: 'unverifiable', action_sent: true,
        tier: 'L3',
        // 动作已经发出去了：原样重试 = 同一个副作用做两遍。让模型先去只读确认现场。
        retrySafe: false,
        detail: '点了「' + name + '」' + (how ? '（' + how + '）' : '') + '，但没法验证：' + why + '——当失败处理',
        error: reason,
        reason,
        evidence: r.evidence || why,
        method,
        verifyMethod: method,
        verifyReason: reason,
        changedFields: base.changedFields,
        actionResult: base.actionResult,
        nextIfFailed: reason === REASON.OCCLUDED
            ? '把目标窗口调到最前（focus_window）或换 UIA 方式后重看现场；遮挡时屏幕像素不能作证据'
            : (reason === REASON.MINIMIZED
                ? '窗口最小化了：先 focus_window 恢复，再重新 snapshot 拿编号'
                : '先 snapshot / som_snapshot 确认目标还在、位置没变；确认后再点一次'),
    });
}

// ── 聚焦：只看 GetForegroundWindow 回读 ─────────────────────────────────
/**
 * 纯判定：动作返回的「我切了」不算，回读的前台才算。
 * @param {object} fw focusWindow 的返回（含 hwnd / title / ok）
 * @param {object} fg getForegroundInfo 的回读（含 hwnd / title）
 */
function judgeFocusReadback(fw, fg) {
    const wantHwnd = _num(fw && fw.hwnd, 0);
    const wantTitle = String((fw && fw.title) || '').trim();
    const actualHwnd = _num(fg && fg.hwnd, 0);
    const actualTitle = String((fg && fg.title) || '');
    if (!fg) {
        return { ok: false, verified: false, reason: 'no_readback', actual: '', wantHwnd, actualHwnd };
    }
    if (wantHwnd > 0 && actualHwnd > 0) {
        const same = wantHwnd === actualHwnd;
        return {
            ok: same, verified: same,
            reason: same ? null : 'not_foreground',
            actual: actualTitle, wantHwnd, actualHwnd,
        };
    }
    if (wantTitle && actualTitle) {
        const a = actualTitle.toLowerCase();
        const w = wantTitle.toLowerCase();
        const same = a === w || a.includes(w) || w.includes(a);
        return {
            ok: same, verified: same,
            reason: same ? null : 'not_foreground',
            actual: actualTitle, wantHwnd, actualHwnd,
        };
    }
    return { ok: false, verified: false, reason: 'no_readback', actual: actualTitle, wantHwnd, actualHwnd };
}

/**
 * focus_window 的判决（纯函数）：confirmed **只在回读前台==目标**时产生。
 * 其余三档：解析不到 / 激活失败 / 激活了但前台不是它（not_foreground）。
 */
function buildFocusVerdict(fw, fg, focusTarget) {
    const target = String(focusTarget || '').trim();
    const r = fw || {};
    const j = judgeFocusReadback(r, fg);
    const common = {
        tier: 'L2', via: r.via || 'rust', hwnd: r.hwnd || 0,
        multiHit: r.multiHit === true, resolution: r.resolveDetail || '',
        verifyMethod: j.verified ? 'uia' : 'none',
        actual: j.actual || '',
    };
    if (r.ok && j.verified) {
        return VC.confirmed('已把「' + target + '」调到前台' + (r.forced ? '（强制切换）' : ''), Object.assign(common, {
            evidence: '回读 GetForegroundWindow = 「' + (j.actual || target) + '」'
                + (r.hwnd ? '（hwnd=' + r.hwnd + '）' : ''),
            forced: r.forced === true,
        }));
    }
    if (r.ok && !j.verified) {
        // 请求被接受 ≠ 前台真的换了（Windows 前台锁下 SetForegroundWindow 返回 true 但没切）
        return VC.result(Object.assign(common, {
            ok: false, verified: false, effect: 'unverifiable', action_sent: true,
            error: j.reason || 'not_foreground',
            reason: j.reason || 'not_foreground',
            actual: j.actual || '',
            detail: '激活了「' + (r.title || target) + '」但回读发现前台还是「' + (j.actual || '读不到') + '」——没切过去',
            evidence: '回读 GetForegroundWindow = 「' + (j.actual || '读不到') + '」（hwnd=' + (j.actualHwnd || 0) + '）'
                + '，目标 hwnd=' + (j.wantHwnd || 0),
            nextIfFailed: '常见原因：① 被 alwaysOnTop 窗口盖住 ② 前台是全屏游戏（Windows 前台锁）'
                + ' ③ 目标刚启动还没成形。先 list_windows 核对 hwnd；对全屏游戏改用 snapshot+click_element（UIA Invoke 不需要前台）',
        }));
    }
    if (r.unresolved) {
        return VC.notSent('没找到这个窗口：' + target, {
            error: r.error,
            resolution: r.resolveDetail || '',
            nextIfFailed: '标题写一部分，或用 list_windows 看到的 hwnd/pid 数字',
        });
    }
    return VC.failed('激活了「' + (r.title || target) + '」但复核发现前台还是「' + (j.actual || '读不到') + '」', Object.assign(common, {
        evidence: '已解析 hwnd=' + (r.hwnd || 0) + ' 并尝试激活（含 AttachThreadInput），但 GetForegroundWindow 不匹配',
        nextIfFailed: '常见原因：① 被 alwaysOnTop 窗口盖住 ② 前台是全屏游戏（实测 VALORANT 连 SwitchToThisWindow 都切不动，'
            + '而且最小化也不改变前台状态）。对全屏游戏：先最小化它（或让它自己退出全屏），'
            + '或者干脆用 snapshot + click_element 直接操作（UIA Invoke 不需要前台）',
        error: r.error || '',
    }));
}

module.exports = {
    REASON, REASON_TEXT, DEFAULT_WAITS, DEFAULT_THRESHOLDS,
    normState, diffState, describeStateChange, classifyVisibility,
    pixelDelta, pixelChanged, rectsOverlap, windowOnScreens,
    verifyClick, buildClickVerdict, judgeFocusReadback, buildFocusVerdict,
};
