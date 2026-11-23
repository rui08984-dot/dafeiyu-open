#!/usr/bin/env node
// _probe/test-skill-health.cjs —— E7 技能生命周期单测（2026-11-22）
//
// 验四层：
//   ① 生命周期纯函数：连败 3 → dormant、5 → quarantined、60 天未用 → dormant；
//      dormant 只标记不删除；quarantined 拒绝执行；revive 显式复活。
//   ② 记账：recordAttempt 的 tries/ok/verifiedRate/连败/成功清零；账本落盘在
//      PET_DATA_ROOT 下（绝不打真实 pet-runtime/data）。
//   ③ 执行档案聚合：statsFromHistory 按动作/技能算，连败口径正确。
//   ④ 真接线：skill-library.runSkill 对 quarantined 技能**一步都不执行**；
//      dormant 技能仍执行但标降权；revive 后恢复执行。
//
// 全程只用 mkdtemp（PET_DATA_ROOT），退出前清理。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const D = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
// ⚠ 顺序：必须先设 PET_DATA_ROOT，再 require 业务模块（skill-library 在加载时解析技能库路径）
const tmpRoot = iso.setUpTempDataRoot('pet-skill-health-');
const SH = require(path.join(D, 'js', 'core', 'skill-health.js'));
const SK = require(path.join(D, 'plugins', 'community', 'dispatch', 'skill-library.js'));

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ✅ ' + name); };
const now = Date.now();
const DAY = 24 * 3600 * 1000;

(async () => {
  // ── ① 生命周期纯函数 ──────────────────────────────────────────────────
  const L = (fails, extra) => SH.lifecycleOf(Object.assign({ consecutiveFails: fails, lastUsedAt: now - 1000 }, extra || {}), { now });

  assert.strictEqual(L(0).state, 'active');
  assert.strictEqual(L(2).state, 'active');
  ok('连败 0/2 → active');

  assert.strictEqual(L(3).state, 'dormant');
  assert.strictEqual(L(4).state, 'dormant');
  assert.ok(/降权/.test(L(3).reason), L(3).reason);
  ok('连败 3/4 → dormant（只降权，不删除）');

  assert.strictEqual(L(5).state, 'quarantined');
  assert.strictEqual(L(9).state, 'quarantined');
  assert.ok(/需显式复活/.test(L(5).reason), L(5).reason);
  ok('连败 5/9 → quarantined（需显式复活）');

  const idle61 = SH.lifecycleOf({ consecutiveFails: 0, lastUsedAt: now - 61 * DAY }, { now });
  assert.strictEqual(idle61.state, 'dormant');
  assert.ok(idle61.idleDays >= 61);
  assert.strictEqual(SH.lifecycleOf({ consecutiveFails: 0, lastUsedAt: now - 59 * DAY }, { now }).state, 'active');
  ok('60 天未用 → dormant；59 天 → active');

  // 自定义阈值（纯函数可调，但默认值必须是 3/5/60）
  assert.strictEqual(SH.DEFAULTS.dormantAfterFails, 3);
  assert.strictEqual(SH.DEFAULTS.quarantineAfterFails, 5);
  assert.strictEqual(SH.DEFAULTS.dormantAfterDays, 60);
  ok('默认阈值 = 3 / 5 / 60');

  // ── ② 执行档案聚合（纯函数）────────────────────────────────────────────
  const rows = [
    { ts: 1000, action: 'click_at', arg: '1,2', ok: true, verified: true },
    { ts: 2000, action: 'click_at', arg: '1,2', ok: false, verified: false },
    { ts: 3000, action: 'click_at', arg: '1,2', ok: true, verified: null },
    { ts: 4000, action: 'skill_run', arg: '坏技能', ok: false, verified: false },
    { ts: 4100, action: 'skill_run', arg: '坏技能', ok: false, verified: false },
    { ts: 4200, action: 'skill_run', arg: '坏技能', ok: false, verified: false },
    { ts: 4300, action: 'skill_run', arg: '坏技能', ok: false, verified: false },
    { ts: 4400, action: 'skill_run', arg: '坏技能', ok: false, verified: false },
    { ts: 4500, action: 'skill_run', arg: '好技能', ok: true, verified: true },
    { ts: 4600, action: 'skill_run', arg: '好技能', ok: true, verified: true },
  ];
  const agg = SH.statsFromHistory(rows);
  assert.strictEqual(agg.actions.click_at.tries, 3);
  assert.strictEqual(agg.actions.click_at.ok, 2);
  assert.strictEqual(agg.actions.click_at.verifiedRate, 0.333);        // 只有 1 次「verified + ok」
  assert.strictEqual(agg.actions.click_at.consecutiveFails, 0);         // 最后一条成功
  assert.strictEqual(agg.skills['坏技能'].tries, 5);
  assert.strictEqual(agg.skills['坏技能'].consecutiveFails, 5);
  assert.strictEqual(agg.skills['好技能'].ok, 2);
  assert.strictEqual(SH.lifecycleOf(agg.skills['坏技能'], { now }).state, 'quarantined');
  ok('statsFromHistory：动作/技能聚合、verifiedRate、连败口径正确');

  // ── ③ 记账（recordAttempt）+ 落盘隔离 ─────────────────────────────────
  assert.strictEqual(iso.assertIsolated(SH.healthFile()), true);
  assert.strictEqual(iso.assertIsolated(SK.SKILL_FILE), true);
  ok('账本/技能库路径都在 PET_DATA_ROOT 下（不碰真实数据）');

  let r = SH.recordAttempt('甲技能', { ok: true, verified: true, detail: 'ok' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.entry.tries, 1);
  assert.strictEqual(r.entry.ok, 1);
  assert.strictEqual(r.entry.verifiedRate, 1);
  assert.strictEqual(r.entry.consecutiveFails, 0);
  r = SH.recordAttempt('甲技能', { ok: true, verified: true });
  assert.strictEqual(r.entry.tries, 2);
  ok('recordAttempt：成功累加 tries/ok/verifiedRate');

  for (let i = 0; i < 3; i += 1) r = SH.recordAttempt('甲技能', { ok: false, verified: true, detail: '第 ' + (i + 1) + ' 次失败' });
  assert.strictEqual(r.entry.tries, 5);
  assert.strictEqual(r.entry.consecutiveFails, 3);
  assert.strictEqual(r.health.state, 'dormant');
  ok('连败 3 次 → 账本 state=dormant（tries 仍累计到 5）');

  for (let i = 0; i < 2; i += 1) r = SH.recordAttempt('甲技能', { ok: false, verified: false });
  assert.strictEqual(r.entry.consecutiveFails, 5);
  assert.strictEqual(r.health.state, 'quarantined');
  const gate = SH.canRun('甲技能');
  assert.strictEqual(gate.allowed, false);
  assert.ok(/--revive/.test(gate.nextIfFailed || ''), gate.nextIfFailed);
  ok('连败 5 次 → quarantined；canRun 拒绝并给出 --revive 方法');

  // 账本真的落盘，且没被删
  const ledgerRaw = JSON.parse(fs.readFileSync(SH.healthFile(), 'utf8'));
  assert.strictEqual(ledgerRaw.entries['skill:甲技能'].tries, 7);
  assert.strictEqual(ledgerRaw.entries['skill:甲技能'].consecutiveFails, 5);
  ok('账本落盘：skill:甲技能 保留 7 次尝试（dormant/quarantine 不删数据）');

  // 成功一次 → 连败清零
  r = SH.recordAttempt('乙技能', { ok: true, verified: true });
  r = SH.recordAttempt('乙技能', { ok: false, verified: true });
  r = SH.recordAttempt('乙技能', { ok: false, verified: true });
  assert.strictEqual(r.health.state, 'active');                          // 才 2 连败，还没到 3
  r = SH.recordAttempt('乙技能', { ok: false, verified: true });
  assert.strictEqual(r.health.state, 'dormant');
  r = SH.recordAttempt('乙技能', { ok: true, verified: true });
  assert.strictEqual(r.entry.consecutiveFails, 0);
  assert.strictEqual(r.health.state, 'active');
  ok('成功一次 → 连败清零、状态回 active');

  // ── ④ revive / forceState ────────────────────────────────────────────
  const rv = SH.revive('甲技能');
  assert.strictEqual(rv.ok, true);
  assert.strictEqual(rv.health.state, 'active');
  assert.strictEqual(rv.entry.consecutiveFails, 0);
  assert.ok(rv.entry.revivedAt > 0);
  assert.strictEqual(rv.entry.tries, 7);                                 // 历史保留
  assert.strictEqual(SH.canRun('甲技能').allowed, true);
  ok('revive：连败清零、恢复可执行，历史尝试次数保留（不删）');

  assert.strictEqual(SH.forceState('丙技能', 'quarantined').health.state, 'quarantined');
  assert.strictEqual(SH.canRun('丙技能').allowed, false);
  assert.strictEqual(SH.forceState('丙技能', 'active').health.state, 'active');
  assert.strictEqual(SH.canRun('丙技能').allowed, true);
  ok('forceState：显式隔离/恢复都生效');

  // 报告里包含技能库中「从未跑过」的技能（state=active, tries=0）
  const rep = SH.getHealth({ skillNames: ['从未跑的技能'] });
  const zero = rep.skills.find((s) => s.name === '从未跑的技能');
  assert.ok(zero && zero.tries === 0 && zero.state === 'active');
  assert.ok(rep.counts.skills >= 1);
  ok('getHealth：技能库里的技能即使没跑过也会列出（tries=0/active）');

  // 可观测入口
  assert.ok(globalThis.__skillHealthStats && Array.isArray(globalThis.__skillHealthStats.skills));
  assert.ok(Number.isFinite(globalThis.__skillHealthStats.counts.quarantined));
  ok('globalThis.__skillHealthStats 可读（doctor/探针）');

  // ── ⑤ 真接线：runSkill 的隔离/休眠/复活 ──────────────────────────────
  const skillDir = path.join(tmpRoot, 'skills');
  fs.mkdirSync(skillDir, { recursive: true });
  const mkSkill = (name) => ({
    name, description: '测试用', steps: [{ action: 'press_key', arg: 'esc' }],
    entryHash: null, exitHash: null, scope: 'any', successCount: 0, attemptCount: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), risky: false,
  });
  fs.writeFileSync(path.join(skillDir, 'skills.json'), JSON.stringify({
    version: 1, skills: [mkSkill('孤立技能'), mkSkill('休眠技能')],
  }, null, 2), 'utf8');

  // 孤立技能：连败 5 → quarantined，runSkill 必须一步都不执行
  for (let i = 0; i < 5; i += 1) SH.recordAttempt('孤立技能', { ok: false, verified: true, detail: 'boom' });
  let called = 0;
  let rr = await SK.runSkill('孤立技能', { runGameAction: async () => { called += 1; return { ok: true }; } });
  assert.strictEqual(rr.ok, false);
  assert.strictEqual(rr.quarantined, true);
  assert.strictEqual(called, 0);
  assert.ok(/--revive/.test(rr.nextIfFailed || ''), rr.nextIfFailed);
  ok('runSkill：quarantined 技能被拒绝，执行器调用 0 次，附复活方法');

  // 休眠技能：连败 3 → dormant，仍然执行（只是降权标记）
  for (let i = 0; i < 3; i += 1) SH.recordAttempt('休眠技能', { ok: false, verified: true });
  assert.strictEqual(SK.listSkills().filter((s) => s.name === '休眠技能').length, 1);   // 只标记不删
  called = 0;
  rr = await SK.runSkill('休眠技能', {
    runGameAction: async () => { called += 1; return { ok: false, error: '故意失败', effect: 'not_sent' }; },
  });
  assert.strictEqual(called, 1);
  assert.strictEqual(rr.ok, false);
  assert.ok(rr.health && rr.health.state === 'dormant' && /--revive/.test(rr.healthHint || ''), JSON.stringify(rr.health));
  ok('runSkill：dormant 技能仍执行（调用 1 次），结果标「降权」；技能库未被删除');

  // 复活后恢复执行；wrapper 记了 skill_run 历史
  SH.revive('孤立技能');
  called = 0;
  rr = await SK.runSkill('孤立技能', {
    runGameAction: async () => { called += 1; return { ok: false, error: '故意失败', effect: 'not_sent' }; },
  });
  assert.strictEqual(called, 1);
  assert.strictEqual(rr.ok, false);
  assert.strictEqual(SH.lifecycleFor('孤立技能').state, 'active');       // 连败从 1 开始，未到 3
  assert.ok(SK.getHistory().some((h) => h.action === 'skill_run' && h.arg === '孤立技能'));
  // 历史落盘是 200ms 批量 flush：等一拍再验证磁盘
  await new Promise((res) => setTimeout(res, 350));
  const histRows = SH.readHistoryRows();
  assert.ok(histRows.some((h) => h.action === 'skill_run' && h.arg === '孤立技能'));
  ok('revive 后恢复执行（调用 1 次），并写入 skill_run 执行档案（内存 + 磁盘）');

  // ── ⑥ 损坏账本：明确报错但不崩 ────────────────────────────────────────
  fs.writeFileSync(SH.healthFile(), '{ not valid json', 'utf8');
  let crashed = false;
  let bad = null;
  try { bad = SH.recordAttempt('丁技能', { ok: true, verified: true }); } catch (e) { crashed = true; }
  assert.strictEqual(crashed, false);
  assert.ok(bad && bad.ok === false && /写入失败/.test(bad.error || ''), JSON.stringify(bad));
  const quarantined = fs.readdirSync(tmpRoot).filter((n) => /^skill-health\.json\.corrupt-/.test(n));
  assert.strictEqual(quarantined.length, 1, '损坏账本应被隔离而不是覆盖');
  ok('账本损坏 → 返回 {ok:false,error}，不抛异常，坏文件被隔离保留');

  iso.cleanup(tmpRoot);
  console.log('\ntest-skill-health.cjs：' + pass + '/' + pass + ' 全过');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ test-skill-health 失败：', e && e.stack || e);
  iso.cleanup(tmpRoot);
  process.exit(1);
});
