#!/usr/bin/env node
/**
 * _probe/test-click-guard.cjs — 点击守卫 / snapshot 空目标 / SoM 窗口身份 回归
 * （2026-11-21 根因修复：P0 破坏性按钮守卫只挂在 click_element 一条路径）
 *
 * 纯 Node，不实际点击：
 *   · 在 require game-control 之前把 child_process 的 spawn/execFile/execFileSync 换成
 *     计数器桩（任何后端调用都会 throw）—— 守卫若真的在「执行前」拦住，计数必须是 0。
 *   · 用 game-control 暴露的 __testHooks 注入 UIA_SNAPSHOT_STATE / SOM_STATE，
 *     不需要真机快照。
 *
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const path = require('path');
const cp = require('child_process');

const GC = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js');
const SOM_PY = path.join(__dirname, '..', 'pet-runtime', 'tools', 'som_annotate.py');

// ── 后端桩：必须在 require game-control 之前替换（顶层 `const { spawn } = ...`）──
const realCp = { spawn: cp.spawn, execFile: cp.execFile, execFileSync: cp.execFileSync };
const calls = { spawn: 0, execFile: 0, execFileSync: 0 };
function fakeExecFile(...args) {
    calls.execFile += 1;
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
        process.nextTick(() => cb(Object.assign(new Error('BACKEND-EXECFILE-BLOCKED'), { code: 'BLOCKED' }), '', ''));
    }
    return { stdin: { end() {} }, stdout: { on() {} }, stderr: { on() {} }, on() {}, kill() {} };
}
cp.spawn = function () { calls.spawn += 1; throw new Error('BACKEND-SPAWN-BLOCKED'); };
cp.execFile = fakeExecFile;
cp.execFileSync = function () { calls.execFileSync += 1; throw new Error('BACKEND-EXECFILESYNC-BLOCKED'); };

let g = null;
let loadErr = null;
try { g = require(GC); } catch (e) { loadErr = e; }

const fs = require('fs');
const gcSrc = fs.readFileSync(GC, 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const snapshotCounts = () => ({ ...calls });
const backendUnchanged = (before) => calls.spawn === before.spawn && calls.execFile === before.execFile && calls.execFileSync === before.execFileSync;
const countsText = () => 'spawn=' + calls.spawn + ' execFile=' + calls.execFile + ' execFileSync=' + calls.execFileSync;

/** 取源码里某个 case 块（到下一个同级 case 为止），做结构性断言用。 */
function caseBlock(src, name) {
    const start = src.indexOf("case '" + name + "':");
    if (start < 0) return '';
    const next = src.indexOf("\n        case '", start + 10);
    return next < 0 ? src.slice(start) : src.slice(start, next);
}

(async () => {
    console.log('== test-click-guard（纯 Node，后端已桩死）==');
    ok('game-control 可加载', !!g && !loadErr, loadErr ? String(loadErr.message) : 'ok');
    if (!g) { console.error('\n' + pass + '/' + (pass + fail) + ' 全过'); process.exit(1); }

    const H = g.__testHooks;
    ok('暴露 __testHooks 测试注入口', !!H, H ? Object.keys(H).join(',') : 'missing');
    if (!H) {
        // 修复前：没有测试口，直接给出结构性失败证据（不实际点击）
        ok('click_element 走统一守卫', /case 'click_element':[\s\S]*?guardClickTarget/.test(gcSrc), '未找到 guardClickTarget');
        ok('click_text 走统一守卫', /case 'click_text':[\s\S]*?guardClickTarget/.test(gcSrc), '未找到 guardClickTarget');
        ok('som_click 走统一守卫', /case 'som_click':[\s\S]*?guardClickTarget/.test(gcSrc), '未找到 guardClickTarget');
        ok('snapshot 空目标解析前台 hwnd', /case 'snapshot':[\s\S]*?getForegroundInfo\(/.test(gcSrc), '未找到 getForegroundInfo');
        console.error('\n' + pass + '/' + (pass + fail) + ' 全过');
        process.exit(1);
    }

    // ── 1. 统一守卫：三类破坏性文案 × 三条来源，原因必须一致 ──────────────
    for (const name of ['不保存', '否', '放弃', "Don't Save"]) {
        const rs = [];
        for (const source of ['click_element', 'click_text', 'som_click']) {
            // eslint-disable-next-line no-await-in-loop
            rs.push(await H.guardClickTarget({ name, source }));
        }
        ok('「' + name + '」三条路径都拒绝', rs.every((r) => r && r.blocked === 'destructive-button'), rs.map((r) => r && r.blocked).join(','));
        ok('「' + name + '」三条路径原因一致', rs.every((r) => r && r.reason === rs[0].reason), (rs[0] && rs[0].reason) || '(无)');
    }
    ok('「保存」不误拦', (await H.guardClickTarget({ name: '保存', source: 'click_text' })) === null);
    ok('「删除」只标注不拦', (await H.guardClickTarget({ name: '删除', source: 'click_element' })) === null);
    ok('confirm_destructive 放行', (await H.guardClickTarget({ name: '不保存', source: 'click_text', confirmDestructive: true })) === null);

    // 自身窗口：坐标落在桌宠/字幕窗里 → 坐标点击原语拒绝
    H.setOwnWindows([{ id: 'subtitle', title: '字幕窗', rect: { x: 0, y: 0, w: 100, h: 100 } }]);
    {
        const before = snapshotCounts();
        let err = null;
        try { await H.clickAt(50, 50, 200, '', '', { name: '确定', source: 'som_click' }); } catch (e) { err = e; }
        ok('自身窗口落点被坐标原语拒绝', !!(err && err.guardBlocked === 'own-window'), err ? String(err.message).slice(0, 80) : '未拦截');
        ok('自身窗口拒绝时后端 0 调用', backendUnchanged(before), countsText());
    }
    H.setOwnWindows([]);

    // ── 2. 三条动作路径：执行前拒绝，后端调用次数 0 ──────────────────────
    H.reset();
    H.setUiaSnapshotState({
        title: 'Notepad', hwnd: 0, pid: 0,
        items: [{ rid: '1-2', name: '不保存', x: 10, y: 10, idx: 1 }],
        rect: { x: 0, y: 0, w: 100, h: 100 },
    });
    for (const [action, arg] of [['click_element', '1'], ['click_text', '不保存']]) {
        const before = snapshotCounts();
        let err = null;
        try { await g.runGameAction(action, arg, null, null, null); } catch (e) { err = e; }
        ok(action + ' 被守卫拒绝', !!(err && err.guardBlocked === 'destructive-button'), err ? String(err.message) : '没有抛错（可能真的执行了）');
        ok(action + ' 拒绝时后端 0 调用', backendUnchanged(before), countsText());
    }

    H.reset();
    H.setSomState({ title: 'Notepad', rect: null, seq: 0, marks: [{ id: 1, name: '不保存', x: 10, y: 10, type: 'button' }] });
    {
        const before = snapshotCounts();
        let err = null;
        try { await g.runGameAction('som_click', '1', null, null, null); } catch (e) { err = e; }
        ok('som_click 被守卫拒绝', !!(err && err.guardBlocked === 'destructive-button'), err ? String(err.message) : '没有抛错（可能真的执行了）');
        ok('som_click 拒绝时后端 0 调用', backendUnchanged(before), countsText());
    }

    // 底层原语（Invoke / 坐标）自身也必须拦：即使上层漏了调用点
    {
        const before = snapshotCounts();
        let err = null;
        try { await H.uiaElementAction('Notepad', '1-2', 200, 0, { name: '不保存', source: 'click_text' }); } catch (e) { err = e; }
        ok('uiaElementAction 原语先守卫', !!(err && err.guardBlocked), err ? String(err.message) : '未拦截');
        let err2 = null;
        try { await H.clickAt(10, 10, 200, '', '', { name: '不保存', source: 'som_click' }); } catch (e) { err2 = e; }
        ok('clickAt 原语先守卫', !!(err2 && err2.guardBlocked), err2 ? String(err2.message) : '未拦截');
        ok('原语守卫期间后端 0 调用', backendUnchanged(before), countsText());
    }

    // ── 3. snapshot 空目标 → 先解析前台 hwnd（纯函数 + 静态接线）────────────
    const p1 = H.pickSnapshotTarget('', '', { hwnd: 4242, title: 'Notepad', pid: 99 });
    ok('空 title 解析成前台窗口', p1 && p1.ok === true && p1.target === 'Notepad' && p1.hwnd === 4242 && p1.fromForeground === true, JSON.stringify(p1));
    const p2 = H.pickSnapshotTarget('显式标题', '', { hwnd: 4242, title: 'Notepad', pid: 99 });
    ok('显式 title 不覆盖', p2 && p2.ok === true && p2.target === '显式标题' && p2.hwnd === 0, JSON.stringify(p2));
    const p3 = H.pickSnapshotTarget('', '', null);
    ok('取不到前台时明确失败', p3 && p3.ok === false, JSON.stringify(p3));
    const snapBlock = caseBlock(gcSrc, 'snapshot');
    ok('snapshot 调用 getForegroundInfo 解析空目标', /getForegroundInfo\s*\(/.test(snapBlock) && /pickSnapshotTarget\s*\(/.test(snapBlock));
    ok('snapshot 把 hwnd 交给 UIA 服务', /_uiaPost\('\/elements',\s*\{ title: snapTarget[^}]*hwnd: snapWin \? snapWin\.hwnd : 0/.test(snapBlock));

    // ── 4. SoM 占位文案不再当窗口身份 ──────────────────────────────────────
    const pySrc = fs.existsSync(SOM_PY) ? fs.readFileSync(SOM_PY, 'utf8') : '';
    ok('som_annotate 不再用「(前台窗口)」当 title', pySrc.length > 0 && !/GetForegroundWindow\(\),\s*'\(前台窗口\)'/.test(pySrc), pySrc ? '' : '文件不存在');
    ok('som_annotate 回填真实前台标题/hwnd', /GetForegroundWindow\(\)/.test(pySrc) && /GetWindowText/.test(pySrc) && /"hwnd"\s*:\s*hwnd\s*,/.test(pySrc));
    ok('SOM_STATE 记录 hwnd', /SOM_STATE\.hwnd\s*=/.test(gcSrc) && /d\.hwnd/.test(gcSrc));
    ok('som_click 断言用 hwnd 优先', /assertTargetFocused\(SOM_STATE\.hwnd \|\| SOM_STATE\.title/.test(gcSrc));

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('探针异常：' + (e && e.stack || e));
    process.exit(1);
}).finally(() => {
    cp.spawn = realCp.spawn;
    cp.execFile = realCp.execFile;
    cp.execFileSync = realCp.execFileSync;
});
