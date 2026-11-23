#!/usr/bin/env node
/**
 * _probe/test-gate-history.cjs — 门禁台账与「真机项陈旧度」回归（2026-11-18 §73 / §68 B4）
 *
 * 为什么这条要进门槛：这张台账是**唯一**能回答「这条真机验收多久没真跑过」的东西。
 * 它最坏的失败方式不是报错，是**静默地一直说没事**（写失败被吞、时间算错、非真机项混进来）。
 * 所以这里专盯：
 *   ① 通过/跳过/失败三种状态分开记，不互相覆盖；
 *   ② 只有真机项参与陈旧度（普通单测不该出现在报告里）；
 *   ③ 「从未通过」必须是红的信号（stale），不能当成「今天刚跑过」；
 *   ④ 台账写不进去要返回 ok:false（调用方据此发声），且不留 .tmp 残骸。
 *
 * 用法：node _probe/test-gate-history.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gh = require('./gate-history.cjs');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const DAY = 86400000;
const NOW = new Date('2026-11-18T12:00:00+08:00').getTime();

console.log('\n门禁台账 / 真机项陈旧度（§73）：');

// ⓪ 哪些算真机项
{
  ok('8004 的项目算真机', gh.isRealMachine('验收 皮套窗组件画框语言（8004）'));
  ok('（真机）后缀算真机', gh.isRealMachine('验收 电脑操控评测（真机）'));
  ok('3003/3004 算真机', gh.isRealMachine('验收 手机遥控 3003 端到端') && gh.isRealMachine('验收 手机页面仿真（3003/3004 触摸+DPI）'));
  ok('8771/控制中心算真机', gh.isRealMachine('验收 控制中心按钮真实点击（8771）'));
  ok('普通单测不算真机', !gh.isRealMachine('单测 技能沉淀'));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-history-'));
try {
  const file = gh.defaultPath(root);

  // ① 三种状态分开记
  gh.recordRun(file, [
    { label: '验收 世界感知（真机 8103 /world）', ok: true },
    { label: '验收 控制中心按钮真实点击（8771）', ok: true, skip: true },
    { label: '单测 技能沉淀', ok: false },
  ], NOW - 2 * DAY);
  const doc = gh.readHistory(file);
  const rm = doc.items['验收 世界感知（真机 8103 /world）'];
  const sk = doc.items['验收 控制中心按钮真实点击（8771）'];
  const bad = doc.items['单测 技能沉淀'];
  ok('通过记 lastPassAt', rm && rm.lastPassAt === NOW - 2 * DAY && rm.lastStatus === 'pass');
  ok('跳过记 lastSkipAt 且不算通过', sk && sk.lastSkipAt === NOW - 2 * DAY && !sk.lastPassAt);
  ok('失败记 lastFailAt', bad && bad.lastFailAt === NOW - 2 * DAY && bad.lastStatus === 'fail');
  ok('runs 累加', rm && rm.runs === 1);

  // ② 陈旧度只统计真机项
  {
    const r = gh.staleness(file, { now: NOW });
    const labels = r.items.map((i) => i.label);
    ok('报告只含真机项（普通单测不在里面）', labels.every((l) => gh.isRealMachine(l)), labels.join(' / '));
    ok('2 天前通过的不算陈旧', r.items.find((i) => i.label.includes('世界感知')).stale === false);
    ok('只跳过没通过的算陈旧（skip 不等于验过）', r.items.find((i) => i.label.includes('8771')).stale === true);
    ok('从未出现过的真机项不会凭空进来', r.items.every((i) => doc.items[i.label] === undefined ? false : true));
  }

  // ③ 8 天后 → 陈旧
  {
    const r = gh.staleness(file, { now: NOW + 8 * DAY });
    ok('8 天后同一条变陈旧', r.items.find((i) => i.label.includes('世界感知')).stale === true);
    ok('staleCount 计数正确', r.staleCount >= 1, String(r.staleCount));
  }

  // ④ 从未通过（只有失败记录）→ daysAgo null 且 stale
  {
    const r = gh.staleness(file, { now: NOW });
    const never = r.items.find((i) => i.daysAgo === null);
    // 只有失败记录的项目如果算真机，才会出现；这里补一条真机失败
    gh.recordRun(file, [{ label: '验收 手机遥控 3003 端到端（令牌+白名单）', ok: false }], NOW);
    const r2 = gh.staleness(file, { now: NOW });
    const n2 = r2.items.find((i) => i.label.includes('3003'));
    ok('只有失败的真机项 → daysAgo=null', n2 && n2.daysAgo === null, JSON.stringify(n2));
    ok('只有失败的真机项 → stale=true', n2 && n2.stale === true);
    ok('neverRan 计数', r2.neverRan >= 1, String(r2.neverRan));
  }

  // ⑤ 写失败要返回 ok:false，且不留 .tmp
  {
    const blockedDir = path.join(root, 'blocked');
    fs.writeFileSync(blockedDir, 'x', 'utf8');           // 用文件占住「目录」位置
    const badFile = path.join(blockedDir, 'gh.json');
    const r = gh.recordRun(badFile, [{ label: '单测 技能沉淀', ok: true }], NOW);
    ok('写不进去 → ok:false 且带原因', r.ok === false && typeof r.error === 'string', r.error);
    ok('不留 .tmp 残骸', !fs.existsSync(badFile + '.tmp'));
  }

  // ⑥ 坏文件当空台账（不炸）
  {
    const corrupt = path.join(root, 'corrupt.json');
    fs.writeFileSync(corrupt, '{ not json', 'utf8');
    const r = gh.readHistory(corrupt);
    ok('台账损坏 → 返回空台账而不是抛异常', r && r.items && Object.keys(r.items).length === 0);
    const rec = gh.recordRun(corrupt, [{ label: '验收 世界感知（真机 8103 /world）', ok: true }], NOW);
    ok('损坏后仍能重建', rec.ok === true && gh.readHistory(corrupt).items['验收 世界感知（真机 8103 /world）']);
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 清不掉不影响结论 */ }
}

console.log('');
console.log(`  门禁台账 / 真机项陈旧度：PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
