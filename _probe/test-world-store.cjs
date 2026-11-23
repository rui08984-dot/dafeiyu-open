#!/usr/bin/env node
/**
 * _probe/test-world-store.cjs — 世界状态库（2026-11-17 六十二轮 · 世界感知 Phase 1）
 *
 * 钉住四类容易腐坏的东西：
 *   ① 活动状态机的判据与优先级（换应用/游戏不该改代码，但判据变了必须有人知道）
 *   ② 防抖与 TTL（1s 采样不能把状态抖成筛子；适配器死了要变 stale 而不是假装新鲜）
 *   ③ 世界行的三条红线：只写变化 / 字段顺序固定 / ≤100 tokens（硬上限 120）
 *   ④ **缓存不被世界状态打穿**：两轮世界不变时，system+tools 前缀 hash 必须一模一样，
 *      且易变尾巴一个字都不加（这条是 §61.6 的验收核心）
 *
 * 纯离线：注入时钟与假适配器，不启动宿主、不碰网络。
 * 用法：node _probe/test-world-store.cjs
 */

'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

const WS = require(path.join(APP, 'js', 'core', 'world-store.js'));
const WA = require(path.join(APP, 'js', 'core', 'world-adapters.js'));
const PL = require(path.join(APP, 'js', 'core', 'prompt-layout.js'));

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

// ── ① 活动状态机 ─────────────────────────────────────────────────────
{
  const C = WS.classifyActivity;
  eq('没有人输入 5 分钟 → 人不在', C({ idleSec: 400 }).state, 'away');
  eq('人不在压过游戏提示', C({ idleSec: 400, hints: { gaming: true } }).state, 'away');
  eq('游戏提示 → 玩游戏', C({ idleSec: 3, fgApp: 'x', hints: { gaming: true } }).state, 'gaming');
  eq('全屏 + 在放媒体 → 看视频', C({ idleSec: 3, fgApp: 'x', fullscreen: true, mediaStatus: 'playing' }).state, 'watching');
  eq('媒体在放且与前台同题 → 看视频',
    C({ idleSec: 2, fgApp: 'bili', fgTitle: '某某视频 第 3 集', mediaStatus: 'playing', mediaTitle: '某某视频 第 3 集' }).state,
    'watching');
  eq('屏幕状态机 game → 玩游戏', C({ idleSec: 1, fgApp: 'x', hints: { screenState: 'game' } }).state, 'gaming');
  eq('屏幕状态机 video → 看视频', C({ idleSec: 1, fgApp: 'x', hints: { screenState: 'video' } }).state, 'watching');
  eq('静止 40 秒 → 发呆', C({ idleSec: 40, fgApp: 'x' }).state, 'idle');
  eq('有前台且在输入 → 在干活', C({ idleSec: 2, fgApp: 'code' }).state, 'working');
  eq('什么信号都没有 → unknown', C({}).state, 'unknown');
  ok('unknown 的置信度应该低', C({}).conf <= 0.3);
  ok('away 的置信度应该高', C({ idleSec: 999 }).conf >= 0.9);
  // 全屏但没在放媒体 → 不算看视频（免得把全屏办公当看片）
  eq('全屏但媒体没放 → 仍按输入判', C({ idleSec: 2, fgApp: 'x', fullscreen: true, mediaStatus: 'paused' }).state, 'working');
}

// ── ② 防抖（stabilize）────────────────────────────────────────────────
{
  const prev = { state: 'working', conf: 0.6, since: 1000 };
  eq('同状态直接保留', WS.stabilize(prev, { state: 'working', conf: 0.6 }, 2000, 4000).state, 'working');
  eq('刚进 1 秒不许切走', WS.stabilize(prev, { state: 'idle', conf: 0.7 }, 2000, 4000).state, 'working');
  eq('停留满 4 秒可以切', WS.stabilize(prev, { state: 'idle', conf: 0.7 }, 6000, 4000).state, 'idle');
  eq('away 不受防抖限制（人走是硬事实）',
    WS.stabilize(prev, { state: 'away', conf: 0.95 }, 2000, 4000).state, 'away');
  eq('首次状态（prev 为 unknown）直接接受',
    WS.stabilize({ state: 'unknown', since: 0 }, { state: 'working', conf: 0.6 }, 500, 4000).state, 'working');
}

// ── ③ 世界库：TTL / 变化历史 / stale 降级 ─────────────────────────────
{
  let T = 10000;
  const store = WS.createWorldStore({ now: () => T });

  store.apply({
    fg: { ok: true, app: 'code', title: 'world-store.js - Visual Studio Code', fullscreen: false },
    idleMs: 1200,
    media: { ok: false, status: 'none', title: '', app: '' },
    clip: { hash: 'abc123', chars: 42 },
  }, { source: 'system', us: 3800 });

  let snap = store.snapshot();
  eq('前台应用进快照', snap.app, 'code');
  eq('空闲秒数换算', snap.idleSec, 1);
  eq('无媒体时不渲染媒体段', snap.media, '');
  eq('剪贴板只留字数+指纹', snap.clip, '剪贴板=42字#abc1');
  eq('有前台且在输入 → working', snap.activity, 'working');

  // 变化历史：改了标题要记一条；重复同一值不再刷历史
  const tBefore = T;
  T += 1100;
  store.apply({ fg: { ok: true, app: 'code', title: '另一个文件.js', fullscreen: false }, idleMs: 500 }, { source: 'system' });
  T += 1100;
  store.apply({ fg: { ok: true, app: 'code', title: '另一个文件.js', fullscreen: false }, idleMs: 500 }, { source: 'system' });
  const fresh = store.recentChanges(60000).filter((h) => h.at > tBefore);
  eq('标题变化被记录一次（相同值不再刷）', fresh.filter((h) => h.field === 'env.title').length, 1);
  ok('重复采样不刷环境事实历史', fresh.filter((h) => h.field === 'env.app').length === 0,
    JSON.stringify(fresh.map((h) => h.field)));
  ok('空闲毫秒不进变化历史（否则 66 秒就把历史冲爆）',
    fresh.filter((h) => h.field === 'user.idle_ms').length === 0,
    JSON.stringify(fresh.map((h) => h.field)));

  // 空闲渲染要分档：同一档内不该让世界行每轮都变。
  // 2026-11-21 修（P2）：5 秒一档太细（两次对话间隔普遍 >5s），改成 30 秒一档。
  eq('空闲 30 秒一档（42s）', WS.humanIdle(42), '~30s');
  eq('空闲 43s 仍在同一档', WS.humanIdle(43), '~30s');
  eq('空闲分档不抖动（41/42 同档）', WS.humanIdle(42) === WS.humanIdle(41), true);
  eq('空闲 32s 与 42s 同档', WS.humanIdle(32), WS.humanIdle(42));
  eq('空闲 65s 跨到分钟档', WS.humanIdle(65), '1m');
  eq('空闲 <30s 统一「刚动过」', WS.humanIdle(12), '刚动过');

  // stale 降级：只喂一次，之后 TTL 到期
  T += 20000;   // 20s 后 env.app 的 TTL(5s) 早过期
  const dump = store.dump();
  ok('超过 TTL 的事实变成 stale', dump.snapshot.stale.app === true, JSON.stringify(dump.snapshot.stale));
}

// ── ③b 过期媒体不能继续当证据（低功耗/适配器崩溃时的诚实降级）───────────
{
  let T = 0;
  const store = WS.createWorldStore({ now: () => T });
  store.apply({
    fg: { ok: true, app: 'player', title: '某个视频', fullscreen: false },
    idleMs: 1000,
    media: { ok: true, status: 'playing', title: '某个视频', app: 'player' },
  }, { source: 'system' });
  eq('刚采到媒体时判定在看视频', store.snapshot().activity, 'watching');

  // 媒体适配器停了：后面的采样不带 media（低功耗模式就是这样）
  T += 1500;
  store.apply({ fg: { ok: true, app: 'player', title: '某个视频', fullscreen: false }, idleMs: 2500 }, { source: 'system' });
  T += 6000;   // 超过 media TTL(4s)
  store.apply({ fg: { ok: true, app: 'player', title: '某个视频', fullscreen: false }, idleMs: 8000 }, { source: 'system' });
  const s = store.snapshot();
  ok('媒体事实过期后不再说「在放」', s.mediaStatus === 'none' || s.stale.media === true, JSON.stringify({ status: s.mediaStatus, stale: s.stale }));
  ok('媒体过期后不再判定 watching', s.activity !== 'watching', s.activity + ' / ' + s.activityWhy);
}

// ── ④ 世界行：只写变化 / 顺序固定 / 条数预算 ─────────────────────────
{
  const snap1 = {
    activity: 'watching', app: '哔哩哔哩', title: 'Gemini 4 Hydrogen 实测 9 个任务',
    media: '媒体=playing《Gemini 4 Hydrogen 实测 9 个任务》', idleSec: 42, clip: '',
  };
  const r1 = WS.renderWorldLine(null, snap1, {});
  ok('第一次渲染给出完整世界行', r1.text.indexOf('[世界]') === 0 && r1.tokens > 0, r1.text);
  ok('活动排在最前', r1.fields[0] === 'activity', r1.fields.join(','));
  ok('字段顺序固定 activity→app→title→media→idle', JSON.stringify(r1.fields) === JSON.stringify(['activity', 'app', 'title', 'media', 'idle']),
    r1.fields.join(','));

  // 世界不变 → 一个字都不注入
  const prevFields = WS.worldFields(snap1);
  const r2 = WS.renderWorldLine(prevFields, snap1, {});
  eq('世界没变 → 不注入', r2.text, '');
  eq('世界没变 → token 数为 0', r2.tokens, 0);

  // 只改了一个字段 → 只写那一个
  const snap2 = Object.assign({}, snap1, { idleSec: 300 });
  const r3 = WS.renderWorldLine(prevFields, snap2, {});
  ok('只写变化的字段', r3.fields.length === 1 && r3.fields[0] === 'idle', r3.text + ' | ' + r3.fields.join(','));
  ok('变化行带上新值', r3.text.indexOf('空闲=5m') >= 0, r3.text);

  // 超长标题 → 必须砍到 ≤100 tokens 且绝不超过 120
  const huge = {
    activity: 'working', app: 'code',
    title: '很长的标题'.repeat(120),
    media: '媒体=playing《' + '歌名'.repeat(80) + '》',
    idleSec: 3,
    clip: '剪贴板=9999字#abcdef',
  };
  const r4 = WS.renderWorldLine(null, huge, {});
  ok('超长行被压到软上限内', r4.tokens <= WS.DEFAULTS.maxTokens, 'tokens=' + r4.tokens + ' text=' + r4.text.slice(0, 60));
  ok('超长行绝不超过硬上限', r4.tokens <= WS.DEFAULTS.hardMaxTokens, 'tokens=' + r4.tokens);
  ok('被截断时标记 truncated', r4.truncated === true);
  ok('activity 永远不被砍', r4.fields.indexOf('activity') >= 0, r4.fields.join(','));

  // token 估算：CJK 1 字≈1，纯 ASCII 4 字≈1
  eq('中文 token 估算', WS.estimateTokens('世界感知'), 4);
  eq('英文 token 估算', WS.estimateTokens('abcd'), 1);
  ok('空串 0 token', WS.estimateTokens('') === 0);

  // 前台标题与媒体标题同源时只写一次（B 站：窗口标题就是视频标题）
  const dupSnap = {
    activity: 'watching', app: '哔哩哔哩', title: '某个视频标题',
    mediaTitle: '某个视频标题', media: '媒体=playing《某个视频标题》', idleSec: 5, clip: '',
  };
  const dupFields = WS.worldFields(dupSnap);
  eq('标题与媒体同源 → 省略 title 字段', dupFields.title, '');
  ok('媒体段仍在', dupFields.media.indexOf('媒体=playing') === 0);
  const dupLine = WS.renderWorldLine(null, dupSnap, {});
  ok('去重后世界行不重复同一句标题',
    dupLine.text.split('某个视频标题').length === 2, dupLine.text);
}

// ── ⑤ 适配器：映射 / 低功耗 / 剪贴板只在变化时出 ────────────────────
(async () => {
  {
    const calls = [];
    const ad = WA.createWorldAdapters({
      call: async (req) => { calls.push(req); return { ok: true, fg: { ok: true, app: 'code', title: 't', fullscreen: false }, idle_ms: 5000, media: { ok: false, status: 'none' }, us: 4000 }; },
      readClipboard: () => 'hello',
    });
    const s1 = await ad.sample();
    eq('一次采样只调一次 pet-core（合并往返）', calls.length, 1);
    eq('默认带 media 标记', calls[0].media, true);
    eq('前台映射', s1.fg.app, 'code');
    eq('空闲映射', s1.idleMs, 5000);
    ok('剪贴板首次出现', s1.clip && s1.clip.chars === 5, JSON.stringify(s1.clip));
    const s2 = await ad.sample();
    ok('剪贴板没变就不再报（别每秒刷变化）', s2.clip === null, JSON.stringify(s2.clip));
  }
  {
    const calls = [];
    const ad = WA.createWorldAdapters({
      lowPower: true,
      call: async (req) => { calls.push(req); return { ok: true, fg: { ok: true, app: 'a', title: 'b' }, idle_ms: 1, media: { ok: false, status: 'skipped' }, us: 122 }; },
      readClipboard: () => 'should-not-be-read',
    });
    const s = await ad.sample();
    eq('低功耗：world 调用带 media:false', calls[0].media, false);
    eq('低功耗：不读剪贴板', s.clip, null);
    ok('低功耗：单次成本仍是微秒级（us 透传）', s.us === 122);
  }
  {
    // 适配器异常 → 不抛，记错误，返回空快照
    const ad = WA.createWorldAdapters({ call: async () => { throw new Error('boom'); }, readClipboard: () => '' });
    const s = await ad.sample();
    ok('适配器抛错不外泄', s.fg === null && s.errors.length > 0 && ad.stats.errors === 1, JSON.stringify(s.errors));
  }
  {
    // 单源开关：全关 → 一次 pet-core 都不调
    let n = 0;
    const ad = WA.createWorldAdapters({
      sources: { foreground: false, idle: false, media: false, clipboard: false },
      call: async () => { n += 1; return { ok: true }; },
      readClipboard: () => 'x',
    });
    await ad.sample();
    eq('全部源关掉 → 不调 pet-core', n, 0);
  }

  // ── ⑥ 缓存红线：两轮世界不变 → system+tools 前缀 hash 不变、尾巴不增长 ──
  {
    const store = WS.createWorldStore({ now: () => 1000 });
    store.apply({
      fg: { ok: true, app: 'code', title: 'main.js', fullscreen: false },
      idleMs: 2000,
      media: { ok: true, status: 'playing', title: 'song', app: 'spotify' },
    }, { source: 'system' });
    const snap = store.snapshot();

    const system = { role: 'system', content: 'BASE 人格提示词（不得被世界状态改写）' };
    const tools = [{ type: 'function', function: { name: 'see', description: 'x', parameters: { type: 'object' } } }];
    const prefixHash = () => PL.hashText(JSON.stringify([system.content, tools]));

    const hashBefore = prefixHash();

    // 第 1 轮：世界第一次出现 → 注入完整行
    const msgs1 = [{ role: 'system', content: system.content }, { role: 'user', content: '在吗' }];
    const r1 = WS.renderWorldLine(null, snap, {});
    const v1 = PL.appendVolatile(msgs1, [r1.text]);
    const fieldsAfterTurn1 = WS.worldFields(snap);
    ok('第 1 轮确实注入了', v1.ok === true && r1.tokens > 0, r1.text);

    // 第 2 轮：世界没变（同一快照） → 什么都不加
    const msgs2 = [{ role: 'system', content: system.content }, { role: 'user', content: '嗯' }];
    const r2 = WS.renderWorldLine(fieldsAfterTurn1, snap, {});
    const v2 = PL.appendVolatile(msgs2, r2.text ? [r2.text] : []);

    eq('世界不变时第 2 轮不注入', r2.text, '');
    eq('世界不变时 appendVolatile 不做事', v2.ok, false);
    eq('第 2 轮 user 消息原样（尾巴没变长）', msgs2[1].content, '嗯');
    eq('两轮 system+tools 前缀 hash 完全一致', prefixHash(), hashBefore);
    eq('system 内容一个字没被改', msgs2[0].content, system.content);

    // 第 3 轮：世界变了（换应用 + 停止播放） → 只注入变化
    store.apply({
      fg: { ok: true, app: 'explorer', title: '下载', fullscreen: false },
      idleMs: 2000,
      media: { ok: true, status: 'paused', title: 'song', app: 'spotify' },
    }, { source: 'system' });
    const snap3 = store.snapshot();
    const r3 = WS.renderWorldLine(WS.worldFields(snap), snap3, {});
    ok('世界变了 → 注入变化行', r3.text.length > 0 && r3.tokens <= WS.DEFAULTS.maxTokens, r3.text);
    // 换应用后 activity 仍是 working（两个应用都在"干活"），所以只该出现 app/title/media
    ok('变化行只包含变化字段（app/title/media）',
      r3.fields.indexOf('app') >= 0 && r3.fields.indexOf('media') >= 0
      && r3.fields.indexOf('idle') < 0 && r3.fields.indexOf('clip') < 0,
      r3.fields.join(','));
    eq('变化后 system+tools 前缀 hash 仍然不变', prefixHash(), hashBefore);
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 世界状态库：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试自身崩溃：' + (e && e.stack || e));
  console.log('  ❌ 世界状态库：PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
});
