// passthrough-policy.js —— 鼠标穿透判定的唯一策略源（2026-11-23 B7）
//
// 背景（B7「穿透假守卫」）：ui-controller 里原来写的是
//     try { if (global.__petIgnoreMouse) return; } catch ...
// 可 __petIgnoreMouse 只在**主进程** global 上赋值（main.js 托盘/启动），渲染进程的
// global 是另一个对象 —— 条件恒假，守卫从来没拦住过。托盘打开「鼠标穿透」后，
// 任意一次 mousemove 都会把 ignore:false 发回主进程，把用户的开关立刻抵消。
//
// 这个模块把「悬停该不该动穿透」和「手动开关状态」拆成纯逻辑：
//   · decideHoverPassthrough：给定一次 mousemove 的判定输入，返回该不该发、发什么。
//   · createManualPassthroughGate：缓存手动开关，按 TTL 从真实来源（get-config）刷新；
//     刷新发现「手动穿透=开」时回调 apply(true) 自愈（即使中间被悬停误关一次）。
// 这样单测可以在 node 里跑，不需要 Electron/真机。

'use strict';

const DEFAULT_TTL_MS = 1000;

/**
 * 一次悬停判定该做什么。
 * @param {object} input
 * @param {boolean} input.isAdjustingSubtitle
 * @param {boolean} input.manualPassthrough  手动穿透开关（真实来源，不是猜的）
 * @param {boolean} input.petBodyActive
 * @param {boolean} input.hasModel
 * @param {boolean} input.overUI
 * @param {boolean} input.overHer
 * @param {boolean} input.overModel
 * @returns {{apply: boolean, ignore?: boolean, reason: string}}
 */
function decideHoverPassthrough(input = {}) {
    const {
        isAdjustingSubtitle = false,
        manualPassthrough = false,
        petBodyActive = false,
        hasModel = false,
        overUI = false,
        overHer = false,
        overModel = false,
    } = input;

    if (isAdjustingSubtitle) return { apply: false, reason: 'subtitle-adjusting' };
    // 手动开关优先：开着就完全不动 OS 级穿透状态（悬停不参与）。
    if (manualPassthrough === true) return { apply: false, reason: 'manual-passthrough' };
    if (petBodyActive) {
        // 皮套：透明处穿透、她身上/UI 上不穿透（alpha hitTest 由调用方算好）。
        return { apply: true, ignore: !(overUI || overHer), reason: 'petbody' };
    }
    if (!hasModel) return { apply: false, reason: 'no-model' };
    return { apply: true, ignore: !(overUI || overModel), reason: 'avatar' };
}

/**
 * 手动穿透开关门闩。
 *
 * 真实状态来自主进程 get-config（托盘切开会写盘）。门闩缓存它，按 ttlMs 节流刷新；
 * 刷新结果为 true 且与缓存不同时调用 apply(true) —— 这是「被误关后自愈」的唯一入口。
 * 读取失败保留上次状态（不把 true 误降成 false）。
 *
 * @param {object} options
 * @param {boolean} [options.initial=false]
 * @param {() => (boolean|Promise<boolean>)} [options.read]
 * @param {(on: true) => void} [options.apply]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs]
 */
function createManualPassthroughGate(options = {}) {
    const {
        initial = false,
        read = null,
        apply = () => {},
        now = () => Date.now(),
        ttlMs = DEFAULT_TTL_MS,
    } = options;

    let on = initial === true;
    let checkedAt = null;       // null = 从未刷新过 → 首次调用必刷（0 是合法时间戳）
    let inflight = null;
    let reads = 0;
    let applies = 0;
    let errors = 0;

    const isStale = (at = now()) => checkedAt === null || (at - checkedAt) >= Math.max(0, Number(ttlMs) || 0);

    function refreshIfStale() {
        if (!isStale()) return Promise.resolve({ on, changed: false, skipped: true });
        if (inflight) return inflight;
        if (typeof read !== 'function') {
            checkedAt = now();
            return Promise.resolve({ on, changed: false, reason: 'no-read' });
        }
        reads += 1;
        inflight = Promise.resolve()
            .then(() => read())
            .then((next) => {
                const value = next === true;
                const changed = on !== value;
                on = value;
                checkedAt = now();
                if (value) {
                    // 不只 changed 时下发：手动穿透是显式用户意图，任何别的模块把它
                    // 关掉一次都应在下一轮刷新被重新置上（幂等 IPC，代价 1 次/秒）。
                    try { apply(true); applies += 1; } catch (_) { errors += 1; }
                }
                return { on, changed, healed: value };
            })
            .catch((error) => {
                // 读失败不改缓存值：宁可维持上次，也不要把「开」误判成「关」。
                checkedAt = now();
                errors += 1;
                return { on, changed: false, error: String((error && error.message) || error) };
            })
            .then((result) => { inflight = null; return result; });
        return inflight;
    }

    return {
        isOn: () => on,
        isStale,
        refreshIfStale,
        stats: () => ({ on, checkedAt, reads, applies, errors }),
    };
}

module.exports = { decideHoverPassthrough, createManualPassthroughGate, DEFAULT_TTL_MS };
