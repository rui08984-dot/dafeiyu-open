#!/usr/bin/env node
/**
 * _probe/test-perf-director.cjs —— presence + 导演 dry-run（2026-11-25 P0.3）
 *
 * 钉住：
 *   ① presence 统一入口：world-sense 六态优先、stale/过旧回退 __userActivity、都没有就 unknown；
 *   ② 导演规则：away 全禁 / gaming·watching·meeting 禁 v2 / 低强度只许短段 / 预算与间隔门；
 *   ③ 被接率闭环：最近 10 次 <15% 降强度、>40% 提高 10 分钟上限；
 *   ④ dry-run 不改行为：gate() 永远 proceed（对拍旧行为），enforce 才拦。
 *
 * 用法：node _probe/test-perf-director.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

const path = require('path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}

const DESKTOP = path.join(__dirname, '..', 'pet-runtime', 'desktop');
const file = (p) => pathToFileURL(path.join(DESKTOP, p)).href;

const NOW = 1_800_000_000_000;

(async () => {
  const {
    readPresence, normalizePresenceState, allowsLongPerformance, PRESENCE_FRESH_MS, LONG_BLOCKED_STATES,
  } = await import(file('perf/presence.mjs'));
  const {
    decide, gate, resolvePerformanceConfig, maxMsForIntensity, sessionIntensity,
    DIRECTOR_DEFAULTS, PERFORMANCE_DEFAULTS, budgetsFromSummary,
  } = await import(file('perf/director.mjs'));
  const { createPerformanceLog, isAutoSource } = await import(file('perf/performance-log.mjs'));

  // ── ① presence：world-sense 优先 ─────────────────────────────────────
  const worldScope = (state, patch = {}) => ({
    __worldSenseState: () => ({
      activity: Object.assign({ state, conf: 0.8, why: 'test', at: NOW - 1000, stale: false }, patch.activity || {}),
      world: Object.assign({ idleSec: 12 }, patch.world || {}),
    }),
  });
  {
    const p = readPresence(worldScope('working'), NOW);
    eq('world-sense working → source', p.source, 'world-sense');
    eq('working inFront=true', p.inFront, true);
    eq('idleSec 透传', p.idleSec, 12);
    eq('conf 透传', p.conf, 0.8);
    eq('新鲜数据 fresh=true', p.fresh, true);
    eq('gaming 归一', readPresence(worldScope('gaming'), NOW).state, 'gaming');
    eq('watching 归一', readPresence(worldScope('watching'), NOW).state, 'watching');
    eq('meeting 归一', readPresence(worldScope('meeting'), NOW).state, 'meeting');
    eq('away inFront=false', readPresence(worldScope('away'), NOW).inFront, false);
  }
  {
    // stale → 回退 __userActivity
    const scope = {
      __worldSenseState: () => ({ activity: { state: 'away', at: NOW, stale: true } }),
      __userActivity: { state: 'active', idleMs: 2000, at: NOW - 500 },
    };
    const p = readPresence(scope, NOW);
    eq('world stale → 回退 user-activity', p.source, 'user-activity');
    eq('回退后 state=working', p.state, 'working');
    eq('回退后 inFront=true', p.inFront, true);
  }
  {
    // world 数据太旧（>30s）→ 回退
    const scope = {
      __worldSenseState: () => ({ activity: { state: 'gaming', at: NOW - PRESENCE_FRESH_MS - 1, stale: false } }),
      __userActivity: { state: 'idle', idleMs: 40000, at: NOW - 1000 },
    };
    const p = readPresence(scope, NOW);
    eq('world 过旧 → 回退', p.source, 'user-activity');
    eq('回退 state=idle', p.state, 'idle');
    eq('回退 idleSec 从 idleMs 换算', p.idleSec, 40);
  }
  {
    // userActivity 本身过旧 → 仍返回状态但 fresh=false（交给上层决定，不假装新鲜）
    const scope = { __userActivity: { state: 'away', idleMs: 350000, at: NOW - PRESENCE_FRESH_MS - 5000 } };
    const p = readPresence(scope, NOW);
    eq('userActivity 过旧 fresh=false', p.fresh, false);
    eq('userActivity 过旧仍给出 state', p.state, 'away');
    eq('没有任何来源 → unknown/none', readPresence({}, NOW).state, 'unknown');
    eq('没有来源 fresh=false', readPresence({}, NOW).fresh, false);
    eq('没有来源 source=none', readPresence({}, NOW).source, 'none');
  }
  eq('别名 active → working', normalizePresenceState('active'), 'working');
  eq('未知字符串 → unknown', normalizePresenceState('量子态'), 'unknown');
  eq('allowsLongPerformance：away=false', allowsLongPerformance({ state: 'away' }), false);
  eq('allowsLongPerformance：gaming=false', allowsLongPerformance({ state: 'gaming' }), false);
  eq('allowsLongPerformance：watching=false', allowsLongPerformance({ state: 'watching' }), false);
  eq('allowsLongPerformance：working=true', allowsLongPerformance({ state: 'working' }), true);
  eq('allowsLongPerformance：unknown=true（不制造「她不演了」）', allowsLongPerformance({ state: 'unknown' }), true);
  eq('长段禁止态清单完整', LONG_BLOCKED_STATES.slice().sort(), ['away', 'gaming', 'meeting', 'watching']);

  // ── ② 导演：模式与默认值 ─────────────────────────────────────────────
  const base = { now: NOW, presence: { state: 'working' }, session: { turns: 0 }, lastPerfAt: 0 };
  const DRYRUN = { config: { director: { enabled: false, dry_run: true } } };
  {
    // P1（2026-11-25）契约变化：默认已开闸（enabled=true + dry_run=false → enforce）。
    // 需要旧 dry-run 行为的断言显式传 DRYRUN（下同），不再依赖默认值。
    eq('默认配置 → enforce（P1 开闸）', decide(base).mode, 'enforce');
    const d = decide(Object.assign({}, base, DRYRUN));
    eq('dry_run=true（enabled=false）→ dryrun', d.mode, 'dryrun');
    eq('默认会话强度 0.3', d.intensity, 0.3);
    eq('低强度时长上限 8000', d.maxMs, 8000);
    eq('低强度不给 v2', d.allowedKinds.includes('v2'), false);
    ok('低强度仍允许 clip', d.allowedKinds.includes('clip'));
    const off = decide(Object.assign({}, base, { config: { director: { enabled: false, dry_run: false } } }));
    eq('两个开关都关 → off', off.mode, 'off');
    eq('off 时 allow=false', off.allow, false);
    eq('off 时 reason=disabled', off.reason, 'disabled');
  }
  eq('maxMsForIntensity(0.2)=8000', maxMsForIntensity(0.2), 8000);
  eq('maxMsForIntensity(0.5)=12000', maxMsForIntensity(0.5), 12000);
  eq('maxMsForIntensity(0.7)=20000', maxMsForIntensity(0.7), 20000);
  eq('maxMsForIntensity(0.95)=45000', maxMsForIntensity(0.95), 45000);
  eq('sessionIntensity 3 轮 = 0.6', sessionIntensity({ turns: 3 }, NOW), 0.6);
  eq('sessionIntensity 8 轮 = 1', sessionIntensity({ turns: 8 }, NOW), 1);
  eq('sessionIntensity 刚点过她 = 0.8', sessionIntensity({ turns: 0, userActionAt: NOW - 1000 }, NOW), 0.8);

  // ── ③ 在场门：away 全禁；gaming/watching 禁 v2 ──────────────────────
  const high = Object.assign({}, base, { session: { turns: 8 } });
  {
    const d = decide(Object.assign({}, high, { presence: { state: 'away' } }));
    eq('away → allow=false', d.allow, false);
    eq('away → reason', d.reason, 'presence:away');
    eq('away → allowedKinds 空', d.allowedKinds, []);
    const g = decide(Object.assign({}, high, { presence: { state: 'gaming' } }));
    eq('gaming 高强度也不给 v2', g.allowedKinds.includes('v2'), false);
    eq('gaming reason 带 presence', g.reason, 'presence:gaming');
    ok('gaming 时长压到 ≤8s', g.maxMs <= 8000, String(g.maxMs));
    const w = decide(Object.assign({}, high, { presence: { state: 'watching' } }));
    eq('watching 高强度也不给 v2', w.allowedKinds.includes('v2'), false);
    ok('watching 时长压到 ≤8s', w.maxMs <= 8000, String(w.maxMs));
    const okd = decide(high);
    ok('working 高强度给 v2', okd.allowedKinds.includes('v2'));
    eq('working 高强度时长上限 45000', okd.maxMs, 45000);
  }

  // ── ④ 预算 / 间隔门 ─────────────────────────────────────────────────
  {
    const d = decide(Object.assign({}, high, { budgets: { playsToday: 40 } }));
    eq('日预算用尽 → allow=false', d.allow, false);
    eq('日预算用尽 reason', d.reason, 'budget:plays');
    const m = decide(Object.assign({}, high, { budgets: { playsLast10Min: 2 } }));
    eq('10 分钟上限 → allow=false', m.allow, false);
    eq('10 分钟上限 reason', m.reason, 'budget:10min');
    const l = decide(Object.assign({}, high, { budgets: { longToday: 12 } }));
    eq('长段预算用尽仍允许短段', l.allow, true);
    eq('长段预算用尽 → 无 v2', l.allowedKinds.includes('v2'), false);
    eq('长段预算用尽 reason', l.reason, 'budget:long');
    ok('长段预算用尽时长压到 ≤8s', l.maxMs <= 8000, String(l.maxMs));
    const gap = decide(Object.assign({}, high, { lastPerfAt: NOW - 1000 }));
    eq('间隔不足 → allow=false', gap.allow, false);
    eq('间隔不足 reason', gap.reason, 'gap');
  }

  // ── ⑤ 被接率闭环 ───────────────────────────────────────────────────
  {
    const low = decide(Object.assign({}, base, { session: { turns: 8, replyRate: 0.05, replySamples: 12 } }));
    eq('被接率 5% → 强度打 0.7', low.intensity, 0.7);
    eq('被接率低 → 10 分钟上限 -1', low.maxPer10Min, 1);
    const quiet = decide(Object.assign({}, base, { session: { turns: 8 } }));
    eq('样本不足时不改强度', quiet.intensity, 1);
    eq('样本不足时不改上限', quiet.maxPer10Min, 2);
    const hot = decide(Object.assign({}, base, { session: { turns: 8, replyRate: 0.5, replySamples: 12 } }));
    eq('被接率 50% → 10 分钟上限 +1', hot.maxPer10Min, 3);
  }

  // ── ⑥ dry-run 不改行为（gate 对拍）──────────────────────────────────
  {
    const awayDry = Object.assign({}, high, { presence: { state: 'away' } }, DRYRUN);
    const d = decide(awayDry);
    eq('dryrun 决策本身是 allowed=false', d.allow, false);
    eq('dryrun gate(v2) 仍放行', gate(d, 'v2').proceed, true);
    eq('dryrun gate(clip) 仍放行', gate(d, 'clip').proceed, true);
    eq('dryrun gate 原因= dry-run', gate(d, 'v2').reason, 'dry-run');
    const enforce = decide(Object.assign({}, high, { presence: { state: 'away' }, config: { director: { enabled: true, dry_run: true } } }));
    eq('enabled=true → enforce 优先', enforce.mode, 'enforce');
    eq('enforce 下 away 被拦', gate(enforce, 'clip').proceed, false);
    const lowKind = decide(Object.assign({}, base, { config: { director: { enabled: true, dry_run: false } } }));
    eq('enforce 低强度不放 v2', gate(lowKind, 'v2').proceed, false);
    eq('enforce 低强度放 clip', gate(lowKind, 'clip').proceed, true);
    eq('off 模式 gate 永远放行', gate(decide(Object.assign({}, base, { config: { director: { enabled: false, dry_run: false } } })), 'v2').proceed, true);
  }

  // ── ⑦ 配置默认值（缺键必须按契约；P1 已开闸）────────────────────────
  {
    const cfg = resolvePerformanceConfig(null);
    eq('director.enabled 默认 true（P1 开闸）', cfg.director.enabled, true);
    eq('director.dry_run 默认 false（P1 开闸）', cfg.director.dry_run, false);
    eq('director.max_plays_per_day 默认 40', cfg.director.max_plays_per_day, 40);
    eq('director.max_long_per_day 默认 12', cfg.director.max_long_per_day, 12);
    eq('director.max_per_10min 默认 2', cfg.director.max_per_10min, 2);
    eq('director.min_reply_rate 默认 0.15', cfg.director.min_reply_rate, 0.15);
    eq('ambient 默认 enabled/scale', [cfg.ambient.enabled, cfg.ambient.scale], [true, 0.3]);
    eq('program 默认 enabled/max_per_day', [cfg.program.enabled, cfg.program.max_per_day], [true, 2]);
    eq('writer 默认 false', cfg.writer.enabled, false);
    eq('scheduler 默认 true（P3 起）', cfg.scheduler.enabled, true);
    const over = resolvePerformanceConfig({ director: { max_per_10min: 3, dry_run: false } });
    eq('显式配置覆盖默认（max_per_10min）', over.director.max_per_10min, 3);
    eq('覆盖后未给字段仍走默认（dry_run=false）', over.director.dry_run, false);
    eq('覆盖后未给字段仍走默认（max_plays）', over.director.max_plays_per_day, 40);
    eq('脏值不崩（字符串配置）', resolvePerformanceConfig('nonsense').director.max_per_10min, DIRECTOR_DEFAULTS.max_per_10min);
    eq('PERFORMANCE_DEFAULTS 与 director 默认同源', PERFORMANCE_DEFAULTS.director.max_per_10min, DIRECTOR_DEFAULTS.max_per_10min);
  }

  // ── ⑧ 手点不吃自动日预算（2026-11-25 P1 真机实测）────────────────────
  {
    eq('AUTO_SOURCES 语义：peak/idle/auto 自动、manual 手点', [
      isAutoSource('peak'), isAutoSource('idle'), isAutoSource('auto'), isAutoSource('manual'),
    ], [true, true, true, false]);
    const log = createPerformanceLog({ now: () => NOW, append: () => {} });
    const enforceCfg = { director: { enabled: true, dry_run: false } };
    const decideNow = () => decide({
      now: NOW,
      presence: { state: 'working' },
      session: { turns: 8 },
      lastPerfAt: 0,
      budgets: budgetsFromSummary(log.summary(NOW)),
      config: enforceCfg,
    });
    eq('初始 budgetLeft.plays=40', decideNow().budgetLeft.plays, 40);
    eq('初始 budgetLeft.long=12', decideNow().budgetLeft.long, 12);

    // 手点一段 20 秒（manual）：日预算与长段预算都不该动
    log.noteDecision({
      source: 'manual', emotion: 'smug', intensity: 1, played: true, perfKind: 'v2',
      decision: { clipId: '03-pride', reason: 'manual', detail: { durationMs: 20000 } },
    });
    eq('manual 播放后 budgetLeft.plays 不变', decideNow().budgetLeft.plays, 40);
    eq('manual 长段不吃长段预算', decideNow().budgetLeft.long, 12);

    // 自动播放（peak）：各减 1
    log.noteDecision({
      source: 'peak', emotion: 'happy', intensity: 1, played: true, perfKind: 'clip',
      decision: { clipId: 'c-short', reason: 'ok', detail: { durationMs: 3000 } },
    });
    eq('auto 播放后 budgetLeft.plays -1', decideNow().budgetLeft.plays, 39);
    eq('短段不消耗长段预算', decideNow().budgetLeft.long, 12);

    log.noteDecision({
      source: 'idle', emotion: 'neutral', intensity: 0.6, played: true, perfKind: 'clip',
      decision: { clipId: 'c-long', reason: 'ok', detail: { durationMs: 20000 } },
    });
    eq('auto 长段后 budgetLeft.long -1', decideNow().budgetLeft.long, 11);

    const sum = log.summary(NOW);
    eq('summary 分来源：auto=2 / manual=1', [sum.autoPlaysToday, sum.manualPlaysToday], [2, 1]);
    eq('summary 长段分来源：auto=1 / manual=1', [sum.autoLongToday, sum.manualLongToday], [1, 1]);
    eq('budgetsFromSummary 只取 auto', budgetsFromSummary(sum), { playsToday: 2, longToday: 1, playsLast10Min: 2 });
    // 旧 summary（没有分来源字段）→ 回落总量，不假装「没花」
    eq('budgetsFromSummary 旧字段回落', budgetsFromSummary({ playsToday: 5, longToday: 2, plays10: 3 }),
      { playsToday: 5, longToday: 2, playsLast10Min: 3 });
  }

  // ── ⑨ enforce 下 allow=false 不调用 consider（不白吃冷却）────────────
  {
    let considerCalls = 0;
    let claimTouches = 0;
    const fakeClaim = {
      availableFor() { claimTouches += 1; return true; },
      recordYield() { claimTouches += 1; },
    };
    // 复刻 entry 的执行顺序：gate → (proceed) → claim 可用 → consider
    function attempt(dec, kind) {
      const g = gate(dec, kind);
      if (!g.proceed) return 'blocked';
      if (!fakeClaim.availableFor(kind)) { fakeClaim.recordYield(); return 'busy'; }
      considerCalls += 1;
      return 'considered';
    }
    const enforceAway = decide(Object.assign({}, high, {
      presence: { state: 'away' }, config: { director: { enabled: true, dry_run: false } },
    }));
    eq('enforce away → 不调用 consider', attempt(enforceAway, 'v2'), 'blocked');
    eq('enforce away 后 consider 计数仍 0', considerCalls, 0);
    eq('allow=false 时连 claim 都不碰（不白吃 yield）', claimTouches, 0);

    const enforceBudget = decide(Object.assign({}, high, {
      budgets: { playsToday: 40 }, config: { director: { enabled: true, dry_run: false } },
    }));
    eq('预算耗尽 → 不调用 consider', attempt(enforceBudget, 'v2'), 'blocked');
    eq('预算耗尽后 consider 计数仍 0', considerCalls, 0);

    const enforceOk = decide(Object.assign({}, high, { config: { director: { enabled: true, dry_run: false } } }));
    eq('allow=true → consider 被调用', attempt(enforceOk, 'v2'), 'considered');
    eq('allow=true 后 consider=1', considerCalls, 1);

    const dryAway = decide(Object.assign({}, high, { presence: { state: 'away' } }, DRYRUN));
    eq('dry-run 即使 allowed=false 仍走 consider（不改变行为）', attempt(dryAway, 'v2'), 'considered');
    eq('dry-run 后 consider=2', considerCalls, 2);
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' presence + 导演：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
