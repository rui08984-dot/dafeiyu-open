#!/usr/bin/env node
/**
 * _probe/test-passthrough-policy.cjs —— B7「穿透假守卫」修复的证伪测试
 *
 * 背景：ui-controller 原守卫读渲染进程 global.__petIgnoreMouse，但主进程只写
 * 自己的 global → 条件恒假，托盘开关会被任意一次 mousemove 抵消。
 *
 * 覆盖：
 *   A. decideHoverPassthrough 分支表（字幕调整 / 手动开关 / 皮套 / Live2D）
 *   B. createManualPassthroughGate（TTL 节流 / 刷新 / 自愈 / 读失败保留 / 并发合并）
 *   C. ui-controller 接线（不再读 global.__petIgnoreMouse；用策略模块；
 *      手动穿透自愈走 pet:set-ignore-mouse 专用通道）
 *
 * 真机验收（留给人）：托盘切「鼠标穿透」→ 鼠标划进/划出皮套窗，窗口应保持
 * 点得穿且不被悬停逻辑改回；悬停她身上仍应恢复可交互。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const POLICY = path.join(LIVE, 'js', 'core', 'passthrough-policy.js');
const UI_CONTROLLER = path.join(LIVE, 'js', 'ui', 'ui-controller.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, actual, expected) {
    return ok(name, actual === expected, '期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
}

const P = require(POLICY);

console.log('\n[A] decideHoverPassthrough 分支表');
{
    let r = P.decideHoverPassthrough({ isAdjustingSubtitle: true });
    eq('字幕调整中：不参与', r.apply, false);
    eq('字幕调整中：原因', r.reason, 'subtitle-adjusting');

    r = P.decideHoverPassthrough({ manualPassthrough: true, petBodyActive: true, overHer: true });
    eq('手动穿透开：即使鼠标在她身上也不动（开关优先）', r.apply, false);
    eq('手动穿透开：原因', r.reason, 'manual-passthrough');

    r = P.decideHoverPassthrough({ petBodyActive: true, overHer: true });
    eq('皮套·她身上：不穿透', r.ignore, false);
    r = P.decideHoverPassthrough({ petBodyActive: true, overHer: false, overUI: false });
    eq('皮套·透明处：穿透', r.ignore, true);
    r = P.decideHoverPassthrough({ petBodyActive: true, overHer: false, overUI: true });
    eq('皮套·可交互 UI 上：不穿透', r.ignore, false);

    r = P.decideHoverPassthrough({ petBodyActive: false, hasModel: false });
    eq('无模型（非皮套）：跳过，不发 IPC', r.apply, false);
    eq('无模型：原因', r.reason, 'no-model');

    r = P.decideHoverPassthrough({ petBodyActive: false, hasModel: true, overModel: true });
    eq('Live2D/VRM·模型上：不穿透', r.ignore, false);
    r = P.decideHoverPassthrough({ petBodyActive: false, hasModel: true, overModel: false });
    eq('Live2D/VRM·模型外：穿透', r.ignore, true);
    r = P.decideHoverPassthrough({ petBodyActive: false, hasModel: true, overUI: true });
    eq('Live2D/VRM·UI 上：不穿透', r.ignore, false);
}

console.log('\n[B] createManualPassthroughGate');
(async () => {
    let clock = 0;
    let reads = 0;
    let readValue = true;
    const applied = [];
    const gate = P.createManualPassthroughGate({
        initial: false,
        ttlMs: 1000,
        now: () => clock,
        read: async () => { reads += 1; return readValue; },
        apply: (on) => applied.push(on),
    });
    eq('初始状态来自构造参数', gate.isOn(), false);
    ok('首次必刷（checkedAt=0）', gate.isStale() === true);

    let result = await gate.refreshIfStale();
    eq('刷新读到开：状态=开', gate.isOn(), true);
    eq('刷新：changed=true', result.changed, true);
    eq('刷新：healed=true', result.healed, true);
    eq('刷新：自愈下发一次 apply(true)', applied.length, 1);
    eq('自愈下发值', applied[0], true);
    eq('只读一次', reads, 1);
    eq('刷新后 checkedAt 记录当前时间', gate.stats().checkedAt, 0);

    result = await gate.refreshIfStale();
    eq('TTL 内：跳过刷新', result.skipped, true);
    eq('TTL 内：不再读', reads, 1);

    clock = 1000;
    result = await gate.refreshIfStale();
    eq('TTL 到期：再读', reads, 2);
    eq('值没变：changed=false', result.changed, false);
    eq('手动开：每轮刷新都幂等重发 apply(true)', applied.length, 2);
    eq('值没变：healed 仍为 true（表示手动开在维持）', result.healed, true);

    clock = 2000;
    readValue = false;
    result = await gate.refreshIfStale();
    eq('读到关：状态=关', gate.isOn(), false);
    eq('读到关：changed=true', result.changed, true);
    eq('读到关：不 apply', applied.length, 2);

    // 读失败保留上次状态（不把「开」误降成「关」）
    clock = 3000;
    const failing = P.createManualPassthroughGate({
        initial: true,
        ttlMs: 1000,
        now: () => clock,
        read: async () => { throw new Error('ipc down'); },
        apply: () => {},
    });
    result = await failing.refreshIfStale();
    eq('读失败：保留开', failing.isOn(), true);
    eq('读失败：changed=false', result.changed, false);
    ok('读失败：错误有记录', /ipc down/.test(result.error || ''));

    // 并发刷新合并成一个 read
    clock = 10000;
    let pendingResolve = null;
    let slowReads = 0;
    const slow = P.createManualPassthroughGate({
        initial: false,
        ttlMs: 1000,
        now: () => clock,
        read: () => { slowReads += 1; return new Promise((resolve) => { pendingResolve = resolve; }); },
        apply: () => {},
    });
    const p1 = slow.refreshIfStale();
    const p2 = slow.refreshIfStale();
    ok('并发刷新返回同一 in-flight Promise', p1 === p2);
    await new Promise((resolve) => setImmediate(resolve));   // 让 read 真正开始
    ok('read 已开始', typeof pendingResolve === 'function');
    pendingResolve(true);
    await p1;
    eq('并发刷新只读一次', slowReads, 1);
    eq('并发刷新最终状态=开', slow.isOn(), true);

    // 统计可诊断
    const stats = gate.stats();
    eq('stats.reads', stats.reads, 3);
    eq('stats.applies（每轮读到开都重发）', stats.applies, 2);
    eq('stats.errors', stats.errors, 0);

    console.log('\n[C] ui-controller 接线（静态）');
    const src = fs.readFileSync(UI_CONTROLLER, 'utf8');
    ok('不再读渲染进程 global.__petIgnoreMouse（假守卫已删）', !src.includes('global.__petIgnoreMouse'));
    ok('引入 passthrough-policy', /require\(['"]\.\.\/core\/passthrough-policy\.js['"]\)/.test(src));
    ok('悬停走 decideHoverPassthrough', src.includes('passthroughPolicy.decideHoverPassthrough'));
    ok('悬停里节流刷新手动开关', /refreshIfStale\(\)[\s\S]{0,2000}decideHoverPassthrough/.test(src));
    ok('手动穿透自愈走专用通道 pet:set-ignore-mouse', src.includes("ipcRenderer.send('pet:set-ignore-mouse'"));
    ok('_applyIgnoreMouse 仍按值去重', /_lastIgnoreMouse === want/.test(src));
    ok('手动重发绕过悬停去重', /options\.manual !== true && this\._lastIgnoreMouse === want/.test(src));
    ok('手动状态来自 get-config（不是猜的）', src.includes("ipcRenderer.invoke('get-config')"));

    console.log('\n================ 结果 ================');
    console.log('通过 ' + pass + ' / 失败 ' + fail);
    process.exit(fail ? 1 : 0);
})().catch((error) => {
    console.error('测试崩溃:', error);
    process.exit(2);
});
