#!/usr/bin/env node
'use strict';
/**
 * _probe/test-route-experience.cjs —— D2 经验路由单测（2026-11-22）
 *
 * 覆盖（≥12 断言，实际 40+）：
 *   ① app 指纹归一 / via 族映射 / 未知值不记账
 *   ② 样本 <3 保持原序；≥3 才按成功率重排（且不修改入参）
 *   ③ 连续 3 次失败 → 该 app 回默认顺序 + degraded 计数（验收项）
 *   ④ 持久化（原子写、跨实例读回、损坏文件不炸）
 *   ⑤ 开关关闭 = 完全 no-op
 *   ⑥ 模拟「整体 verified 成功率上升」：同一 app，UIA 20% / OCR 90%，
 *      前 20 次 vs 后 20 次的首选通道成功率必须上升（验收项）
 *
 * 全部写 PET_DATA_ROOT 临时目录；跑完清理。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MOD = path.join(APP, 'js', 'core', 'route-experience.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    return ok(name, a === e, a === e ? '' : `实际 ${a} / 期望 ${e}`);
}

const tmpRoot = iso.setUpTempDataRoot('pet-route-exp-');
const re = require(MOD);
const recordsPath = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'records-path.js'));

try {
    console.log('\n[1] 路径隔离 / 指纹归一 / via 族映射');
    ok('默认文件落在 PET_DATA_ROOT 下', (() => {
        try { return iso.assertIsolated(re.file); } catch (e) { return false; }
    })(), re.file);
    ok('recordFile 就是 route-experience.json', re.file === recordsPath.recordFile('route-experience.json'));
    eq('进程名去路径/去 .exe/小写', re.normalizeApp('C:\\Program Files\\X\\Notepad.EXE'), 'notepad');
    eq('空白 app 归一为空', re.normalizeApp('   '), '');
    eq('uia-invoke → uia', re.viaFamily('uia-invoke'), 'uia');
    eq('uia-element → uia', re.viaFamily('uia-element'), 'uia');
    eq('uia-coord-fallback → coord', re.viaFamily('uia-coord-fallback'), 'coord');
    eq('ocr → template → ocr', re.viaFamily('ocr→template'), 'ocr');
    eq('som → coord', re.viaFamily('som'), 'coord');
    eq('visual → vision', re.viaFamily('visual'), 'vision');
    eq('未知 via 不归族', re.viaFamily('teleport'), '');

    console.log('\n[2] 样本门槛与排序（样本 <3 保持原序）');
    const f1 = path.join(tmpRoot, 'f1.json');
    const r1 = re.createRouteExperience({ file: f1 });
    eq('新实例 appCount=0', r1.stats().appCount, 0);
    eq('默认 sampleMin=3', r1.stats().sampleMin, 3);
    eq('默认 failStreakLimit=3', r1.stats().failStreakLimit, 3);
    ok('默认启用', r1.stats().enabled === true);

    r1.record({ app: 'demo', via: 'uia', ok: true, verified: true });
    r1.record({ app: 'demo', via: 'uia', ok: true, verified: true });
    eq('只有 2 个样本 → 保持原序', r1.prefer({ app: 'demo', candidates: ['uia', 'ocr'] }), ['uia', 'ocr']);
    r1.record({ app: 'demo', via: 'uia', ok: true, verified: true });
    eq('仅一条通道达样本门槛 → 仍保持原序', r1.prefer({ app: 'demo', candidates: ['uia', 'ocr'] }), ['uia', 'ocr']);

    // uia 3 次里只成功 1 次（交错，不触发连续失败），ocr 3 次全成功
    const r2 = re.createRouteExperience({ file: path.join(tmpRoot, 'f2.json') });
    r2.record({ app: 'notepad', via: 'uia-invoke', ok: true, verified: true });
    r2.record({ app: 'notepad', via: 'uia-invoke', ok: false, verified: false });
    r2.record({ app: 'notepad', via: 'uia-invoke', ok: false, verified: null });
    r2.record({ app: 'notepad', via: 'ocr', ok: true, verified: true });
    r2.record({ app: 'notepad', via: 'ocr', ok: true, verified: true });
    r2.record({ app: 'notepad', via: 'ocr', ok: true, verified: true });
    eq('两条都够样本 → 成功率高的排前', r2.prefer({ app: 'notepad', candidates: ['uia', 'ocr'] }), ['ocr', 'uia']);
    const input = ['uia', 'ocr'];
    r2.prefer({ app: 'notepad', candidates: input });
    eq('prefer 不修改入参数组', input, ['uia', 'ocr']);
    eq('未知 app 保持原序', r2.prefer({ app: 'never-seen', candidates: ['uia', 'ocr'] }), ['uia', 'ocr']);
    eq('空候选原样返回', r2.prefer({ app: 'notepad', candidates: [] }), []);

    // 三条候选：不合格项位置不动，只重排合格项
    const r3 = re.createRouteExperience({ file: path.join(tmpRoot, 'f3.json') });
    for (let i = 0; i < 3; i += 1) r3.record({ app: 'x', via: 'uia', ok: i === 0, verified: i === 0 });
    r3.record({ app: 'x', via: 'ocr', ok: true, verified: true });   // 只有 1 个样本 → 不合格
    for (let i = 0; i < 3; i += 1) r3.record({ app: 'x', via: 'coord', ok: true, verified: true });
    eq('三条候选：只交换合格项的位置', r3.prefer({ app: 'x', candidates: ['uia', 'ocr', 'coord'] }), ['coord', 'ocr', 'uia']);

    console.log('\n[3] 连续 3 次失败 → 回默认（验收项）');
    const r4 = re.createRouteExperience({ file: path.join(tmpRoot, 'f4.json') });
    // 先建立「ocr 更好」的排序：uia 交错失败（不构成 3 连），ocr 全胜
    r4.record({ app: 'chat', via: 'uia', ok: true, verified: true });
    r4.record({ app: 'chat', via: 'uia', ok: false, verified: false });
    r4.record({ app: 'chat', via: 'uia', ok: false, verified: null });
    r4.record({ app: 'chat', via: 'ocr', ok: true, verified: true });
    r4.record({ app: 'chat', via: 'ocr', ok: true, verified: true });
    r4.record({ app: 'chat', via: 'ocr', ok: true, verified: true });
    eq('降级前：ocr 已排第一', r4.prefer({ app: 'chat', candidates: ['uia', 'ocr'] }), ['ocr', 'uia']);
    const d1 = r4.record({ app: 'chat', via: 'ocr', ok: false, verified: false });
    const d2 = r4.record({ app: 'chat', via: 'ocr', ok: false, verified: false });
    eq('第 2 次失败还没降级', [d1.degraded, d2.degraded], [false, false]);
    const d3 = r4.record({ app: 'chat', via: 'ocr', ok: false, verified: false });
    ok('第 3 次连续失败触发降级', d3.degraded === true);
    eq('降级后回到默认顺序', r4.prefer({ app: 'chat', candidates: ['uia', 'ocr'] }), ['uia', 'ocr']);
    const st4 = r4.stats();
    ok('stats 记 degraded=1', st4.apps.chat.degraded === 1, String(st4.apps.chat.degraded));
    ok('stats 记 lastDegradedVia=ocr', st4.apps.chat.lastDegradedVia === 'ocr');
    ok('全局 degraded 计数=1', st4.counters.degraded === 1);
    ok('降级后通道计数清空（不再有样本）', Object.keys(st4.apps.chat.vias).length === 0);

    // 一次成功会打断连击
    const r5 = re.createRouteExperience({ file: path.join(tmpRoot, 'f5.json') });
    r5.record({ app: 'streak', via: 'uia', ok: false, verified: false });
    r5.record({ app: 'streak', via: 'uia', ok: false, verified: false });
    r5.record({ app: 'streak', via: 'uia', ok: true, verified: true });
    eq('成功后连击归零', r5.stats().apps.streak.vias.uia.failStreak, 0);
    const s1 = r5.record({ app: 'streak', via: 'uia', ok: false, verified: false });
    const s2 = r5.record({ app: 'streak', via: 'uia', ok: false, verified: false });
    ok('重新累计 2 次仍不降级', s1.degraded === false && s2.degraded === false);

    console.log('\n[4] 观测口径 / 手动 reset / 开关');
    const st2 = r2.stats();
    ok('stats 暴露 overall.verifiedRate', typeof st2.overall.verifiedRate === 'number', String(st2.overall.verifiedRate));
    ok('stats 暴露每 app 每 via 成功率', typeof st2.apps.notepad.vias.uia.sentRate === 'number');
    ok('stats preferred 指向高分通道', st2.apps.notepad.preferred === 'ocr', st2.apps.notepad.preferred);
    ok('stats 含 pending app 文件路径', typeof st2.file === 'string' && st2.file.includes('f2.json'));
    ok('手动 reset 生效', r2.reset('notepad') === true);
    ok('reset 后通道计数清空', Object.keys(r2.stats().apps.notepad.vias).length === 0);
    ok('reset 不增加 degraded', r2.stats().apps.notepad.degraded === 0);
    ok('reset 增加 resets', r2.stats().apps.notepad.resets === 1);
    r2.setEnabled(false);
    ok('关闭后 record 返回 null', r2.record({ app: 'notepad', via: 'uia', ok: true, verified: true }) === null);
    eq('关闭后 prefer 原序返回', r2.prefer({ app: 'demo', candidates: ['uia', 'ocr'] }), ['uia', 'ocr']);
    ok('关闭后 stats.enabled=false', r2.stats().enabled === false);
    r2.setEnabled(true);
    ok('重新打开后 record 恢复', !!r2.record({ app: 'notepad', via: 'uia', ok: true, verified: true }));

    const bad = re.createRouteExperience({ file: path.join(tmpRoot, 'f-bad.json') });
    ok('空 app 不记账', bad.record({ app: '', via: 'uia', ok: true }) === null);
    ok('未知 via 不记账', bad.record({ app: 'x', via: 'teleport', ok: true }) === null);
    eq('无效记录进 invalid 计数', bad.stats().counters.invalid, 2);

    console.log('\n[5] 持久化（原子写 / 跨实例 / 损坏隔离）');
    const shared = path.join(tmpRoot, 'shared.json');
    const a = re.createRouteExperience({ file: shared });
    for (let i = 0; i < 4; i += 1) a.record({ app: 'msedge', via: 'uia', ok: true, verified: true });
    ok('文件已落盘', fs.existsSync(shared));
    const rawText = fs.readFileSync(shared, 'utf8');
    let parsed = null;
    try { parsed = JSON.parse(rawText); } catch (e) { parsed = null; }
    ok('落盘内容是合法 JSON', !!parsed && parsed.apps && parsed.apps.msedge);
    const leftovers = fs.readdirSync(path.dirname(shared)).filter((n) => /\.tmp-/.test(n));
    eq('没有残留 tmp 文件', leftovers, []);
    const b = re.createRouteExperience({ file: shared });
    eq('跨实例读回 tries=4', b.stats().apps.msedge.vias.uia.tries, 4);
    eq('跨实例 preferred=uia', b.stats().apps.msedge.preferred, 'uia');

    const corrupt = path.join(tmpRoot, 'corrupt.json');
    fs.writeFileSync(corrupt, '{not json at all', 'utf8');
    let corruptOk = true;
    let corruptStats = null;
    try {
        const c = re.createRouteExperience({ file: corrupt });
        corruptStats = c.stats();
        c.record({ app: 'calc', via: 'uia', ok: true, verified: true });
    } catch (e) {
        corruptOk = false;
    }
    ok('损坏文件不抛错（隔离后从空表开始）', corruptOk);
    ok('损坏文件读成空表', corruptStats && corruptStats.appCount === 0);
    ok('损坏文件已被隔离（.corrupt-*）', fs.readdirSync(tmpRoot).some((n) => n.startsWith('corrupt.json.corrupt-')));

    console.log('\n[6] 容量上限');
    const cap = re.createRouteExperience({ file: path.join(tmpRoot, 'cap.json'), maxApps: 2 });
    cap.record({ app: 'app-one', via: 'uia', ok: true, verified: true });
    cap.record({ app: 'app-two', via: 'uia', ok: true, verified: true });
    cap.record({ app: 'app-three', via: 'uia', ok: true, verified: true });
    eq('app 表按上限保留 2 个', cap.stats().appCount, 2);
    ok('淘汰最旧、保留最新', !!cap.stats().apps['app-three'] && !cap.stats().apps['app-one']);

    console.log('\n[7] 验收：整体 verified 成功率上升（模拟同一 app 的通道表现）');
    // 确定性 LCG（不依赖 Math.random，保证每次结果一致）
    let seed = 123456789;
    const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
    };
    const sim = re.createRouteExperience({ file: path.join(tmpRoot, 'sim.json') });
    // 同一 app：uia 真实成功率 20%，ocr 真实成功率 90%。动作链逻辑：先试首选，失败再试另一条。
    const REAL = { uia: 0.2, ocr: 0.9 };
    const firstAttempt = [];
    let chainSuccess = 0;
    for (let i = 0; i < 60; i += 1) {
        const order = sim.prefer({ app: 'simapp', candidates: ['uia', 'ocr'] });
        const primary = order[0];
        const pOk = rnd() < REAL[primary];
        sim.record({ app: 'simapp', via: primary, ok: pOk, verified: pOk });
        firstAttempt.push(pOk ? 1 : 0);
        if (pOk) { chainSuccess += 1; continue; }
        const other = order[1];
        const sOk = rnd() < REAL[other];
        sim.record({ app: 'simapp', via: other, ok: sOk, verified: sOk });
        if (sOk) chainSuccess += 1;
    }
    const first20 = firstAttempt.slice(0, 20).reduce((n, v) => n + v, 0) / 20;
    const last20 = firstAttempt.slice(-20).reduce((n, v) => n + v, 0) / 20;
    ok('后 20 次首选成功率 > 前 20 次（经验路由生效）', last20 > first20 + 0.3,
        `前 ${(first20 * 100).toFixed(0)}% → 后 ${(last20 * 100).toFixed(0)}%`);
    const simStats = sim.stats();
    ok('模拟统计中 verifiedRate 可观测', simStats.overall.tries >= 40 && simStats.overall.verifiedRate > 0,
        `tries=${simStats.overall.tries} verifiedRate=${(simStats.overall.verifiedRate * 100).toFixed(0)}%`);
    ok('动作链整体成功数高于纯默认 UIA 的期望（12/60）', chainSuccess > 40, String(chainSuccess));
    // 随机的 3 连败可能触发过降级（这正是保护机制），但绝不该压倒经验学习的效果
    ok('降级次数受控（≤2）', simStats.counters.degraded <= 2, String(simStats.counters.degraded));

    console.log('\n[8] 验收复核：显式伪造 3 连败 → 顺序回默认');
    const deg = re.createRouteExperience({ file: path.join(tmpRoot, 'deg.json') });
    // uia: 成功/失败/成功 → 成功率 67%，连击 0；ocr: 3 次全成功 → 100%
    deg.record({ app: 'fakeapp', via: 'uia', ok: true, verified: true });
    deg.record({ app: 'fakeapp', via: 'uia', ok: false, verified: false });
    deg.record({ app: 'fakeapp', via: 'uia', ok: true, verified: true });
    for (let i = 0; i < 3; i += 1) deg.record({ app: 'fakeapp', via: 'ocr', ok: true, verified: true });
    eq('伪造前：ocr 首选', deg.prefer({ app: 'fakeapp', candidates: ['uia', 'ocr'] }), ['ocr', 'uia']);
    deg.record({ app: 'fakeapp', via: 'ocr', ok: false, verified: false });
    deg.record({ app: 'fakeapp', via: 'ocr', ok: false, verified: false });
    const stDeg2 = deg.stats().apps.fakeapp;
    ok('2 连败：尚未降级（failStreak=2）', stDeg2.vias.ocr && stDeg2.vias.ocr.failStreak === 2,
        JSON.stringify(stDeg2.vias.ocr));
    deg.record({ app: 'fakeapp', via: 'ocr', ok: false, verified: false });
    eq('3 连败：回默认顺序', deg.prefer({ app: 'fakeapp', candidates: ['uia', 'ocr'] }), ['uia', 'ocr']);
    ok('degraded 留痕', deg.stats().apps.fakeapp.degraded === 1);

    console.log('\n[9] 接线检查：guiRoute 真的吃经验顺序 + recordRouteOutcome 真的记账');
    const gc = require(path.join(APP, 'plugins', 'community', 'dispatch', 'game-control.js'));
    const hooks = gc.__testHooks;
    // 静态默认（没有经验时）不变
    const rMine = gc.guiRoute('Minecraft 1.20', 'GLFW30', 'javaw');
    eq('Minecraft 仍走 rcon', rMine.via, 'rcon');
    eq('Minecraft 候选只有 rcon', rMine.candidates, ['rcon']);
    const rQt0 = gc.guiRoute('微信', 'Qt5152QWindowIcon', 'wechat');
    eq('Qt 默认 ocr 首选', rQt0.via, 'ocr');
    eq('Qt 候选顺序 ocr→uia→vision', rQt0.candidates, ['ocr', 'uia', 'vision']);
    const rGen0 = gc.guiRoute('Untitled - Notepad', 'Notepad', 'notepad');
    eq('通用窗口默认 uia-probe', rGen0.via, 'uia-probe');

    // 给 qtapp 造经验：uia 67% / ocr 33% → guiRoute 应把 uia 提到首位
    re.record({ app: 'qtapp', via: 'uia', ok: true, verified: true });
    re.record({ app: 'qtapp', via: 'uia', ok: false, verified: false });
    re.record({ app: 'qtapp', via: 'uia', ok: true, verified: true });
    re.record({ app: 'qtapp', via: 'ocr', ok: false, verified: false });
    re.record({ app: 'qtapp', via: 'ocr', ok: true, verified: true });
    re.record({ app: 'qtapp', via: 'ocr', ok: false, verified: false });
    const rQt1 = gc.guiRoute('微信', 'Qt5152QWindowIcon', 'qtapp');
    eq('有经验后 Qt 路由改为 uia 首选', rQt1.via, 'uia');
    ok('路由标记 experience=true', rQt1.experience === true);
    ok('why 里写明按谁的历史调整', /历史成功率调整/.test(rQt1.why), rQt1.why);
    eq('候选数组也被重排', rQt1.candidates, ['uia', 'ocr', 'vision']);
    const qtFail = [1, 2, 3].map(() => re.record({ app: 'qtapp', via: 'uia', ok: false, verified: false }));
    ok('qtapp 第 3 次连续失败触发降级', qtFail[2].degraded === true);
    const rQt2 = gc.guiRoute('微信', 'Qt5152QWindowIcon', 'qtapp');
    eq('降级后 Qt 路由回默认 ocr', rQt2.via, 'ocr');
    ok('guiRoute 不再标记 experience', rQt2.experience !== true);

    // app 指纹缓存 + 结果记账
    hooks.expNoteApp(5150, 'Notepad.EXE', 'Untitled - Notepad');
    eq('pid→app 缓存可读', hooks.expAppFor(5150, ''), 'notepad');
    eq('标题→app 缓存可读', hooks.expAppFor(0, 'Untitled - Notepad'), 'notepad');
    const beforeRec = gc.controlStats().routeExpRecords;
    ok('recordRouteOutcome 接受有效结果', gc.recordRouteOutcome('click_text', 'Untitled - Notepad',
        { ok: true, verified: true, via: 'ocr', pid: 5150 }) === true);
    ok('记账计数 +1', gc.controlStats().routeExpRecords === beforeRec + 1);
    ok('notepad 的 ocr 样本增加', re.stats().apps.notepad.vias.ocr.tries >= 1);
    const beforeSkip = gc.controlStats().routeExpSkippedNoApp;
    ok('not_sent 不记账（不是通道选错）', gc.recordRouteOutcome('click_text', 'Untitled - Notepad',
        { ok: false, effect: 'not_sent', action_sent: false, via: 'uia', pid: 5150 }) === false);
    eq('not_sent 后记账计数不变', gc.controlStats().routeExpRecords, beforeRec + 1);
    ok('拿不到 app 时跳过并可观测', gc.recordRouteOutcome('click_text', '不存在的窗口标题zzz',
        { ok: true, verified: true, via: 'uia' }) === false);
    ok('跳过计数 +1', gc.controlStats().routeExpSkippedNoApp === beforeSkip + 1);
    ok('routeExperienceStats 可观测', (() => {
        const s = gc.routeExperienceStats();
        return s && s.file && s.file.includes('route-experience.json');
    })());
    ok('一键开关可调', gc.setRouteExperienceEnabled(false) === false &&
        gc.guiRoute('微信', 'Qt5152QWindowIcon', 'qtapp').via === 'ocr');
    gc.setRouteExperienceEnabled(true);
} catch (e) {
    fail += 1;
    console.error('  ✗ 测试异常：' + (e && e.stack || e));
} finally {
    iso.cleanup(tmpRoot);
}

console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
