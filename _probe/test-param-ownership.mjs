#!/usr/bin/env node
/**
 * _probe/test-param-ownership.mjs — 参数所有权护栏回归（2026-11-18 §69 B3）
 *
 * 守的是什么：
 *   ① 同帧里同一参数被两层写（值差 > 0.02）必须被**判成冲突并带上 owner 归属** ——
 *      这是「人为制造一次双写能被抓到」那条判据；
 *   ② 同一个 (参数, owner 组合) 只告警一次，不刷屏；不同组合是不同问题，不能被合并掩盖；
 *   ③ 阈值内的微调不算抢写（否则物理/口型的每帧微调会把日志刷爆）；
 *   ④ EXTERNALLY_OWNED 从数据变断言：perf 输出里出现口型/眼球/头身/呼吸就要报。
 *
 * 纯函数测试，不需要 WebGL/Electron。
 * 用法：node _probe/test-param-ownership.mjs
 */
'use strict';

import {
  LAYER,
  CONFLICT_MIN_DELTA,
  evaluateFrameConflicts,
  classifyConflict,
  createConflictLedger,
  findExternalOwnershipViolations,
} from '../pet-runtime/desktop/param-ownership-probe.mjs';
import { EXTERNALLY_OWNED_PARAMS } from '../pet-runtime/desktop/perf/index.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// 造一份「一帧内两层写了同一参数」的记账（形状与 cubism-renderer.set() 一致）
function writeMap(entries) {
  const m = new Map();
  for (const [param, vals, owners] of entries) m.set(param, { vals, owners });
  return m;
}

console.log('\n参数所有权护栏（§69 B3）：');

// ── ① 双写必须被抓到，且带 owner ─────────────────────────────────────────
{
  const fw = writeMap([
    ['ParamMouthForm', [0.2, 0.9], [LAYER.EMOTION_BLEND, LAYER.EXPRESSION]],
  ]);
  const { conflicts } = evaluateFrameConflicts(fw);
  ok('人为双写 → 抓到 1 条冲突', conflicts.length === 1, JSON.stringify(conflicts));
  ok('冲突带 owner 归属（保序：先写的在前）',
    conflicts[0] && conflicts[0].owners.join('→') === 'emotion-blend→expression-preset',
    conflicts[0] && conflicts[0].owners.join('→'));
  ok('冲突带 Δ（0.7 写到 3 位）', conflicts[0] && conflicts[0].delta === 0.7, String(conflicts[0] && conflicts[0].delta));
  ok('冲突带写入次数', conflicts[0] && conflicts[0].writes === 2);
  ok('两个基础层互抢 = fight（会被判红）', conflicts[0] && conflicts[0].kind === 'fight');
}

// ── ①b 合法的分层合成不算 fight；choreo（v2）不再是合成层 ──────────────────
// 2026-11-25 P0 契约变更（ADR-015 §3.0 / 审计 §4.1「所有权黑洞」）：
//   choreo 绕过 mixer 直接写 Cubism 参数，把 blink/lip/proc-motion 压掉是**真实抢写**。
//   原断言把 choreo 判 compose，正是「冲突永远为 0 = 假绿」的来源 —— 随契约一起改：
//   choreo 参与 → fight；perf-override（表演的最终覆盖层）/ action 仍算 compose。
{
  const cases = [
    ['ParamAngleX', [LAYER.CHOREO, LAYER.PROC_MOTION], 'fight'],      // v2 加法偏置抢待机摆动
    ['ParamEyeLOpen', [LAYER.BLINK, LAYER.PERF_OVERRIDE], 'compose'], // 覆盖层是表演的最终裁决
    ['ParamMouthOpenY', [LAYER.LIP, LAYER.PERF_OVERRIDE], 'compose'],
    ['ParamAngleZ', [LAYER.ACTION, LAYER.PROC_MOTION], 'compose'],
  ];
  const fw = writeMap(cases.map(([p, owners]) => [p, [0.1, 0.9], owners]));
  const r = evaluateFrameConflicts(fw);
  const byParam = new Map(r.conflicts.map((c) => [c.param, c.kind]));
  ok('choreo 参与 = fight（不再假绿）', byParam.get('ParamAngleX') === 'fight', JSON.stringify([...byParam]));
  ok('perf-override / action 参与仍判 compose',
    cases.filter(([, , kind]) => kind === 'compose').every(([p]) => byParam.get(p) === 'compose'),
    JSON.stringify([...byParam]));
  ok('计数分开：compose=3 / fights=1', r.compose === 3 && r.fights === 1, `compose=${r.compose} fights=${r.fights}`);
}

// ── ② 阈值内微调 / 单次写 / 单 owner 多次写 不算冲突 ────────────────────
{
  const fw = writeMap([
    ['ParamBreath', [0.500, 0.510], [LAYER.PROC_MOTION, LAYER.PROC_MOTION]],   // 同层微调
    ['ParamAngleX', [3.2], [LAYER.PROC_MOTION]],                               // 只写一次
    ['ParamAngleZ', [0.10, 0.115], [LAYER.PROC_MOTION, LAYER.ACTION]],          // 差 0.015 < 阈值
  ]);
  const { conflicts } = evaluateFrameConflicts(fw);
  ok('微调/单写/同层重复写都不算冲突', conflicts.length === 0, JSON.stringify(conflicts));
  ok('阈值常量仍是 0.02', CONFLICT_MIN_DELTA === 0.02, String(CONFLICT_MIN_DELTA));
}

// ── ③ 告警去重：同一组合只喊一次，不同组合各喊一次 ──────────────────────
{
  const warned = [];
  const ledger = createConflictLedger({ maxWarn: 10, onNew: (e) => warned.push(e.key) });
  const c1 = { param: 'ParamMouthForm', owners: [LAYER.EMOTION_BLEND, LAYER.EXPRESSION], delta: 0.7, writes: 2 };
  const a = ledger.note(c1);
  const b = ledger.note(c1);                       // 第二帧同一问题
  ok('第一次是新冲突', a.isNew === true);
  ok('第二次同组合不再告警（只喊一次）', b.isNew === false && warned.length === 1, JSON.stringify(warned));
  const c = ledger.note({ param: 'ParamMouthForm', owners: [LAYER.LIP, LAYER.EXPRESSION], delta: 0.5, writes: 2 });
  ok('同一参数、不同 owner 组合 → 算新问题，会再喊一次', c.isNew === true && warned.length === 2);
  ok('账本统计：unique=2 / warnings=2 / dropped=0',
    ledger.stats().unique === 2 && ledger.stats().warnings === 2 && ledger.stats().dropped === 0,
    JSON.stringify(ledger.stats()));
}

// ── ④ 超上限不是「没事」：dropped 要记账（不静默） ───────────────────────
{
  const warned = [];
  const ledger = createConflictLedger({ maxWarn: 1, onNew: (e) => warned.push(e.key) });
  ledger.note({ param: 'P1', owners: ['a', 'b'], delta: 1, writes: 2 });
  ledger.note({ param: 'P2', owners: ['a', 'b'], delta: 1, writes: 2 });
  const st = ledger.stats();
  ok('超出告警上限 → dropped 计数（不静默丢弃）',
    st.unique === 2 && st.warnings === 1 && st.dropped === 1, JSON.stringify(st));
}

// ── ⑤ EXTERNALLY_OWNED 从数据变断言 ─────────────────────────────────────
{
  const owned = EXTERNALLY_OWNED_PARAMS;
  ok('参数级所有权表非空', Object.keys(owned).length >= 10, `${Object.keys(owned).length} 个参数`);
  ok('口型/眼球/头部都在「归别人」清单里',
    Boolean(owned.ParamMouthOpenY) && Boolean(owned.ParamEyeBallX) && Boolean(owned.ParamAngleX));
  ok('ParamEyeLOpen 刻意不在清单里（与眨眼有意共享，列进去就是狼来了）',
    !owned.ParamEyeLOpen && !owned.ParamEyeROpen);

  const bad = findExternalOwnershipViolations(['ParamMouthOpenY', 'ParamEyeBallX', 'EyeSmile'], owned);
  ok('perf 越权写口型/眼球 → 两条违规',
    bad.length === 2 && bad.some((v) => v.param === 'ParamMouthOpenY') && bad.some((v) => v.param === 'ParamEyeBallX'),
    JSON.stringify(bad));
  ok('违规带「该参数归谁」', bad.every((v) => typeof v.owner === 'string' && v.owner.length > 0), JSON.stringify(bad.map((v) => v.owner)));
  const clean = findExternalOwnershipViolations(['EyeSmile', 'ParamBrowRY', 'MouthSmile_L', 'ParamEyeLOpen'], owned);
  ok('只写画像声明的参数（含共享的 ParamEyeLOpen）→ 零违规', clean.length === 0, JSON.stringify(clean));
  ok('Set / 对象键两种入参都支持',
    findExternalOwnershipViolations(new Set(['ParamBreath']), owned).length === 1
    && findExternalOwnershipViolations({ ParamBreath: 0.3 }, owned).length === 1);
  ok('空入参不炸', findExternalOwnershipViolations([], owned).length === 0
    && findExternalOwnershipViolations(null, owned).length === 0);
  ok('普通对象表也能查（不只 Map）',
    findExternalOwnershipViolations(['ParamAngleX'], { ParamAngleX: 'interaction-motion' }).length === 1);
}

// ── ⑥ 记账形状兼容：老式「纯数字数组」不至于把整帧丢掉 ────────────────────
{
  const fw = new Map([
    ['ParamAngleY', [1, 9]],          // 老形状：数组里只有值，没有 owner
  ]);
  const { conflicts } = evaluateFrameConflicts(fw);
  ok('老形状（无 owner 列）仍能判出冲突，owner 记为 unknown',
    conflicts.length === 1 && conflicts[0].owners.includes('unknown'), JSON.stringify(conflicts));
}

console.log('');
console.log(`  参数所有权护栏：PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
