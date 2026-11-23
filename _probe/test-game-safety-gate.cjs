#!/usr/bin/env node
/**
 * _probe/test-game-safety-gate.cjs — 游戏安全闸单测（2026-11-14 五十三轮）
 *
 * 为什么单独测这个：安全闸是「会不会把按键打进用户正在用的应用」的唯一一道防线，
 * 但之前只有口头验收（真机关掉 MC 看拦不拦），没有自动化断言。
 *
 * 本轮补上的是 fail-closed 语义：
 *   · profile 没配血条检测 + 没明确放弃 → **不许自动操作**（没有 HUD 就没有闸）
 *   · 明确写 safety.requireHp=false → 放行（解谜类游戏本来就没有血条）
 *   · 配了但这一帧读不到（菜单/加载/创造/F1）→ 拦
 */
'use strict';

const G = require('../_incoming/my-neuro/live-2d/js/core/game-loop.js');
const { checkSafetyGate, evalCond, resolveHudGate } = G;

let pass = 0;
let fail = 0;
function caseOf(name, st, want) {
    const got = checkSafetyGate(st);
    const ok = (want === null) ? (got === null) : (typeof got === 'string' && got.includes(want));
    if (ok) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

const GOOD = { ok: true, fgMatch: true, hpConfigured: true, requireHp: true, hpValid: true, guiFlat: false };

caseOf('抓帧失败', { ok: false, error: 'x' }, '抓帧失败');
caseOf('空状态', null, '抓帧失败');
caseOf('目标不在前台', Object.assign({}, GOOD, { fgMatch: false }), '不在前台');
caseOf('没配 HUD 且没放弃 → fail-closed', Object.assign({}, GOOD, { hpConfigured: false, hpValid: false }), '没配 HUD 检测');
caseOf('没配 HUD 但明确放弃 → 放行', Object.assign({}, GOOD, { hpConfigured: false, requireHp: false, hpValid: true }), null);
caseOf('配了 HUD 但读不到', Object.assign({}, GOOD, { hpValid: false }), 'HUD 读不到');
caseOf('GUI 面板', Object.assign({}, GOOD, { guiFlat: true }), 'GUI 面板');
caseOf('全绿 → 放行', GOOD, null);
// 老字段形状（没有 hpConfigured）不能误拦：只有 hpValid===false 才拦
caseOf('旧形状 hpValid=true 放行', { ok: true, fgMatch: true, hpValid: true }, null);
caseOf('旧形状 hpValid=false 拦', { ok: true, fgMatch: true, hpValid: false }, 'HUD 读不到');

// ── 场景闸（2026-11-14 五十三轮 P0）──
caseOf('场景 blocking → 拦', Object.assign({}, GOOD, { scene: 'inventory', sceneBlocking: true }), '场景不对（inventory');
caseOf('场景 normal → 放行', Object.assign({}, GOOD, { scene: 'game', sceneBlocking: false }), null);
caseOf('panel-unknown → 拦', Object.assign({}, GOOD, { scene: 'panel-unknown', sceneBlocking: true }), '场景不对（panel-unknown');
// 场景闸要**优先于** HUD 闸（背包打开时血条也读不到，但原因应该报场景，模型才知道她在背包里）
{
  const st = Object.assign({}, GOOD, { scene: 'inventory', sceneBlocking: true, hpValid: false });
  const got = checkSafetyGate(st);
  if (got && got.includes('场景不对')) { pass += 1; } else {
    fail += 1;
    console.error('  ✗ 场景闸应优先于 HUD 闸 —— got ' + JSON.stringify(got));
  }
}

// ── HUD 闸：精确来源优先（2026-11-14 五十三轮 · 多通道）──
{
  const g = (o) => resolveHudGate(o);
  const MOD = { source: 'mod', value: 0.62, stale: false };
  const API = { source: 'api', value: 0.62, stale: false };
  const OLD_MOD = { source: 'mod', value: 0.62, stale: true };
  const c = (name, opts, wantValid, wantSrc) => {
    const r = g(opts);
    if (r.hpValid === wantValid && r.hpSource === wantSrc) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + JSON.stringify(r) + ' want ' + wantValid + '/' + wantSrc);
  };
  c('mod 新鲜 → 放行（视觉读不到也无所谓）', { hpConfigured: true, hpValidFinal: false, modHp: MOD }, true, 'mod');
  c('api 新鲜 → 同样放行', { hpConfigured: true, hpValidFinal: false, modHp: API }, true, 'api');
  c('mod 过期 → 回视觉（读不到就拦）', { hpConfigured: true, hpValidFinal: false, modHp: OLD_MOD }, false, 'vision');
  c('mod 新鲜但 profile 没配 HUD → 仍放行', { hpConfigured: false, requireHp: true, modHp: MOD }, true, 'mod');
  c('没 mod 没 HUD 没放弃 → fail-closed', { hpConfigured: false, requireHp: true }, false, 'none');
  c('没 mod 没 HUD 但明确放弃 → 放行', { hpConfigured: false, requireHp: false }, true, 'none');
  c('视觉正常 → 放行', { hpConfigured: true, hpValidFinal: true }, true, 'vision');
}

// ── 规则条件：&& / ||（2026-11-14 五十三轮）──
{
  const st = {
    bars: { hp: { value: 0.3, valid: true } },
    motion: { enemy: { area: 0.01, cx: 0.4, cy: 0.5, frames: 3, persistent: true } },
    colors: {}, gray: {},
  };
  const c = (cond, want) => {
    const got = evalCond(cond, st);
    if (got === want) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ evalCond "' + cond + '" —— got ' + got + ' want ' + want);
  };
  c('hp < 0.5 && enemy.frames >= 2', true);
  c('hp < 0.5 && enemy.frames >= 5', false);
  c('hp > 0.9 || enemy.frames >= 2', true);
  c('hp > 0.9 || enemy.frames >= 9', false);
  c('always', true);
  c('不认识的东西 > 1', false);
}

// ── 规则条件：事实表回退（多通道）──
{
  const st = { bars: {}, motion: {}, colors: {}, gray: {} };
  G.facts.set('player.food', 0.2, { source: 'mod', conf: 0.99, ttlMs: 5000 });
  const c2 = (name, cond, want) => {
    const got = evalCond(cond, st);
    if (got === want) { pass += 1; return; }
    fail += 1;
    console.error('  ✗ ' + name + ' —— got ' + got + ' want ' + want);
  };
  c2('事实表里的 player.food 能被规则读到', 'player.food < 0.3 && player.food > 0.1', true);
  c2('事实表里的键也能用其它比较符', 'player.food >= 0.2', true);
  // st 里有的键优先于事实表
  G.facts.set('enemy.frames', 9, { source: 'mod', conf: 0.99, ttlMs: 5000 });
  const st2 = { bars: {}, motion: { enemy: { frames: 1 } }, colors: {}, gray: {} };
  const got2 = evalCond('enemy.frames >= 5', st2);
  if (got2 === false) { pass += 1; } else { fail += 1; console.error('  ✗ st 应优先于事实表 —— got ' + got2); }
  G.facts.reset();
}

// ── 规则接力：aim（Mod 事实）→ attack（视觉）──
{
  const prof = G.loadProfile('minecraft');
  if (!prof || !Array.isArray(prof.rules)) {
    fail += 1;
    console.error('  ✗ 读不到 MC profile');
  } else {
    const stBase = {
      ok: true, fgMatch: true, hpConfigured: true, hpValid: true, sceneBlocking: false,
      bars: { hp: { value: 1, valid: true } },
      motion: { enemy: { ready: true, area: 0.01, cx: 0.4, cy: 0.5, count: 1, frames: 3, blobs: [{ frames: 3 }] } },
      colors: {}, gray: {},
    };
    const setF = (k, v) => G.facts.set(k, v, { source: 'mod', conf: 0.99, ttlMs: 5000 });
    const kindOf = (d) => (d && d.rule && d.rule.act && d.rule.act.kind) || null;

    G.facts.reset();
    setF('enemy.nearest.dist', 3); setF('enemy.nearest.offAim', 20);
    const d1 = G.decide(prof, stBase, {});
    if (kindOf(d1) === 'aim') { pass += 1; } else { fail += 1; console.error('  ✗ 近 + 偏 → 应选 aim，实际 ' + kindOf(d1)); }

    setF('enemy.nearest.offAim', 2);          // 已经对准了
    const d2 = G.decide(prof, stBase, {});
    if (kindOf(d2) === 'attack') { pass += 1; } else { fail += 1; console.error('  ✗ 对准后应交棒给 attack，实际 ' + kindOf(d2)); }

    setF('enemy.nearest.dist', 12); setF('enemy.nearest.offAim', 40);   // 太远
    const d3 = G.decide(prof, stBase, {});
    if (kindOf(d3) === 'attack') { pass += 1; } else { fail += 1; console.error('  ✗ 远处不该 aim，实际 ' + kindOf(d3)); }

    // 没有 Mod 数据（没装 Mod）→ aim 规则永不命中
    G.facts.reset();
    const d4 = G.decide(prof, stBase, {});
    if (kindOf(d4) === 'attack') { pass += 1; } else { fail += 1; console.error('  ✗ 无 Mod 数据时应退回视觉 attack，实际 ' + kindOf(d4)); }
  }
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 游戏安全闸：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
