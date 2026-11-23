#!/usr/bin/env node
/**
 * _probe/test-turn-context.cjs — 轮次上下文与 turn_id 归因（A4，2026-11-21）
 *
 * 要防的回归：
 *   ① 轮次没有可 join 的 ID（telemetry 只能靠时间戳猜）
 *   ② 工具事件在「没有活动轮」时丢归因（孤儿）—— ensureTurn 必须兜底造轮
 *   ③ endTurn 不写收尾事件 / 阶段偏移不是数字（doctor 算不了 p50/p90）
 *
 * 数据隔离：PET_DATA_ROOT + PET_TELEMETRY_DIR 都指到临时目录（A2），
 * 不写真实 .runtime/telemetry.jsonl。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-turn-');
process.env.PET_TELEMETRY_DIR = path.join(tmpRoot, 'runtime');

const turnCtx = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'turn-context.js'));
const TELEMETRY_FILE = path.join(tmpRoot, 'runtime', 'telemetry.jsonl');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function readLines() {
    try { return fs.readFileSync(TELEMETRY_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch (e) { return []; }
}

try {
    ok('遥测目录已隔离到临时目录', iso.assertIsolated(TELEMETRY_FILE), tmpRoot);

    // ① 开轮 → id 可读 → 收轮 → 无当前轮
    const id1 = turnCtx.beginTurn('text');
    ok('beginTurn 返回 turn id', /^t[a-z0-9]+-[a-z0-9]+$/.test(id1), id1);
    ok('currentTurnId 与 beginTurn 一致', turnCtx.currentTurnId() === id1);
    turnCtx.markPhase('input');
    turnCtx.markPhase('input');            // 重复打点只留一条
    turnCtx.markPhase('llm');
    const rec = turnCtx.endTurn('ok');
    ok('endTurn 返回本轮记录且 totalMs 是数字', !!rec && Number.isFinite(rec.totalMs), rec && rec.totalMs + 'ms');
    ok('endTurn 后没有当前轮', turnCtx.currentTurnId() === '');
    ok('阶段去重（同名只记第一次）', rec.phases.filter((p) => p.name === 'input').length === 1,
        rec.phases.map((p) => p.name).join(','));

    // ② 收尾事件：有 turn_id、span、数字 metrics
    const lines = readLines();
    const beginEv = lines.find((l) => l.type === 'turn.begin' && l.turn_id === id1);
    const endEv = lines.find((l) => l.type === 'turn.end' && l.turn_id === id1);
    ok('telemetry 有 turn.begin（带 turn_id）', !!beginEv && beginEv.cat === 'turn');
    ok('telemetry 有 turn.end（带 turn_id）', !!endEv && endEv.cat === 'turn');
    ok('turn.end 的 total_ms 是数字', !!endEv && typeof endEv.metrics.total_ms === 'number');
    ok('阶段偏移写成数字 metrics（phase_*_ms）',
        !!endEv && typeof endEv.metrics.phase_input_ms === 'number' && typeof endEv.metrics.phase_llm_ms === 'number',
        endEv && Object.keys(endEv.metrics).join(','));

    // ③ 无活动轮时 ensureTurn 兜底造轮（孤儿 tool 事件=0 的结构保证）
    const before = turnCtx.currentTurnId();
    const idTool = turnCtx.ensureTurn('tool');
    ok('没有活动轮时 ensureTurn 新建一轮', before === '' && idTool !== id1, idTool);
    ok('ensureTurn 后 currentTurnId 就是新 id', turnCtx.currentTurnId() === idTool);
    const idReuse = turnCtx.ensureTurn('tool');
    ok('有当前轮时 ensureTurn 复用同一 id', idReuse === idTool);
    turnCtx.endTurn('ok');

    // ④ 收轮后 lastTurnId 保留（跨轮收尾事件可查）
    ok('lastTurnId 指向最近结束的轮', turnCtx.lastTurnId() === idTool, turnCtx.lastTurnId());

    // ⑤ stats 可排障
    const st = turnCtx.stats();
    ok('stats 暴露 last 轮摘要', !!st.last && st.last.id === idTool && Number.isFinite(st.last.totalMs));
} finally {
    iso.cleanup(tmpRoot);
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
