#!/usr/bin/env node
/**
 * _probe/test-memory-usage.cjs —— D5 记忆兑现率（2026-11-22）
 *
 * 验收目标（提案原文）：
 *   · 注入后判「用上」：回复里出现该条目的关键片段（≥6 字）才算命中；
 *   · 90 天 0 命中 → decayed（只降权/标记，不删）；
 *   · 各来源命中率可查；索引总量稳定（重复注入不膨胀）；
 *   · 数据落 PET_DATA_ROOT/data/记忆兑现.json，原子写。
 *
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// ⚠ 顺序：先设 PET_DATA_ROOT，再 require 业务模块（memory-usage 默认单例在加载时定路径）。
const TMP = iso.setUpTempDataRoot('pet-memory-usage-');
const ROOT = path.join(TMP, 'data');
fs.mkdirSync(ROOT, { recursive: true });

const MU = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'memory-usage.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1); // 2026-01-01，测试用固定时钟

function makeUsage(name, extra) {
  const file = path.join(ROOT, name || '记忆兑现.json');
  iso.assertIsolated(file);
  return MU.createMemoryUsage(Object.assign({ file }, extra || {}));
}

function inject(usage, source, text, at, role) {
  return injectMany(usage, [{ source, text, at, role }]);
}

function injectMany(usage, items) {
  const entries = items.map((it) => ({
    id: MU.idFor({ source: it.source, role: it.role || 'note', text: it.text, t: 0 }),
    source: it.source,
    role: it.role || 'note',
    text: it.text,
    t: 0,
  }));
  const at = items.length ? items[0].at : Date.now();
  const res = usage.noteInjected({ entries, at });
  return { ids: entries.map((e) => e.id), res };
}

(async () => {
  // ── ① 纯函数：片段抽取保守、稳定 id ──────────────────────────────────
  const frags = MU.extractFragments('我上周在青岚湖畔捡到一只三花猫，取名叫布丁。');
  ok('关键片段 ≥6 字', frags.length > 0 && frags.every((f) => f.length >= MU.MIN_FRAGMENT_CHARS),
    frags.slice(0, 4).join(' / '));
  ok('片段数量有上限（不膨胀）', frags.length <= MU.MAX_FRAGMENTS, 'n=' + frags.length);
  const generic = MU.extractFragments('我觉得这个真的很好吃');
  ok('通用壳抽不出「我觉得这个」类片段',
    !generic.some((f) => f.includes('我觉得这个')), generic.join(' / ') || '(none)');
  const bestFriend = MU.extractFragments('他最好的朋友叫阿澈，住在城南。');
  ok('通用壳只挡整段，不误杀「最好的朋友」',
    bestFriend.some((f) => f.includes('最好的朋友')), bestFriend.join(' / ') || '(none)');
  const idA = MU.idFor({ source: '记忆库', role: 'user', text: '青岚湖畔的三花猫叫布丁', t: 1 });
  const idB = MU.idFor({ source: '记忆库', role: 'user', text: '青岚湖畔的三花猫叫布丁', t: 1 });
  const idC = MU.idFor({ source: '记忆库', role: 'user', text: '青岚湖畔的三花猫叫团子', t: 1 });
  ok('同一正文 id 稳定', idA === idB, idA);
  ok('不同正文 id 不同', idA !== idC, idA + ' vs ' + idC);

  // ── ② 初始统计：七类来源都在，全 0 ────────────────────────────────────
  const u1 = makeUsage('u1.json');
  const s0 = u1.stats({ at: T0 });
  ok('七类来源齐全', MU.SOURCES.every((s) => s0.bySource[s] && s0.bySource[s].injected === 0),
    Object.keys(s0.bySource).join('/'));
  ok('初始索引为空', s0.index.entries === 0 && s0.total.injected === 0, JSON.stringify(s0.total));

  // ── ③ 注入 → 命中 / 不命中 ───────────────────────────────────────────
  const textFact = '他养了一只三花猫叫布丁，特别怕打雷。';
  const textCore = '用户最喜欢的季节是深秋，因为风里有桂花味。';
  // 同一轮注入必须一次登记：noteInjected 的 pending 语义是「这一轮注了哪些」。
  injectMany(u1, [
    { source: '事实', text: textFact, at: T0, role: 'fact' },
    { source: '核心', text: textCore, at: T0, role: 'note' },
  ]);
  const s1 = u1.stats({ at: T0 + 2000 });
  ok('注入计数按来源分开', s1.bySource['事实'].injected === 1 && s1.bySource['核心'].injected === 1,
    `${s1.bySource['事实'].injected}/${s1.bySource['核心'].injected}`);

  const r1 = u1.noteUsed({ text: '当然记得，你家三花猫叫布丁，打雷时会躲起来。', at: T0 + 3000 });
  ok('回复含关键片段 → 命中', r1.used === 1 && r1.matched[0].source === '事实',
    JSON.stringify(r1.matched));
  const s2 = u1.stats({ at: T0 + 4000 });
  ok('命中率可查（事实 1/1，核心 0/1）',
    s2.bySource['事实'].rate === 1 && s2.bySource['核心'].rate === 0,
    JSON.stringify({ 事实: s2.bySource['事实'].rate, 核心: s2.bySource['核心'].rate }));

  // 只出现 3 个字（<6）不算；通用句也不算（用独立实例，避免污染上面的分母）
  const u1b = makeUsage('miss.json');
  inject(u1b, '事实', textFact, T0, 'fact');
  const r2 = u1b.noteUsed({ text: '三花猫。', at: T0 + 5000 });
  inject(u1b, '事实', textFact, T0 + 6000, 'fact');
  const r3 = u1b.noteUsed({ text: '我觉得这个真的很好吃。', at: T0 + 7000 });
  ok('不足 6 字的片段不算命中', r2.checked > 0 && r2.used === 0, JSON.stringify(r2));
  ok('通用短语不算命中', r3.checked > 0 && r3.used === 0, JSON.stringify(r3));

  // 迟到的回复（>10 分钟）不算上一轮注入的命中
  const u1c = makeUsage('stale.json', { now: () => T0 });
  inject(u1c, '事实', textFact, T0, 'fact');
  const stale = u1c.noteUsed({ text: '三花猫叫布丁。', at: T0 + 11 * 60 * 1000 });
  ok('超过 10 分钟的迟到回复不计命中', stale.used === 0 && stale.reason === 'stale-pending',
    JSON.stringify(stale));

  // ── ③b turnId 跨轮隔离（U5）──────────────────────────────────────────
  // 注入轮 A → 下一轮 B 的回复命中旧片段：整批丢弃，不结算，staleDropped 可查。
  {
    let turn = 'A';
    const ua = makeUsage('turn-a.json', { now: () => T0, turnIdProvider: () => turn });
    inject(ua, '事实', textFact, T0, 'fact');
    turn = 'B';
    const rB = ua.noteUsed({ ids: ua.pendingIds(), text: '当然记得，你家三花猫叫布丁，打雷会躲起来。', at: T0 + 1000 });
    ok('跨轮不结算旧注入（reason=stale-turn）', rB.used === 0 && rB.reason === 'stale-turn', JSON.stringify(rB));
    ok('跨轮丢弃计入 staleDropped=1', ua.stats({ at: T0 + 2000 }).staleDropped === 1,
      JSON.stringify(ua.stats({ at: T0 + 2000 })));
    ok('跨轮丢弃后 pending 已清空', ua.pendingIds().length === 0, String(ua.pendingIds().length));
    const again = ua.noteUsed({ text: '三花猫叫布丁，打雷会躲起来。', at: T0 + 3000 });
    ok('丢弃后不会用同一批再结算一次', again.checked === 0 && again.used === 0, JSON.stringify(again));

    // 同一轮照常结算
    const ub = makeUsage('turn-same.json', { now: () => T0, turnIdProvider: () => 'S' });
    inject(ub, '事实', textFact, T0, 'fact');
    const rs = ub.noteUsed({ ids: ub.pendingIds(), text: '三花猫叫布丁，打雷会躲起来。', at: T0 + 1000 });
    ok('同一轮照常结算（used=1）', rs.used === 1 && ub.stats({ at: T0 + 2000 }).staleDropped === 0,
      JSON.stringify(rs));

    // 老调用方：注入时没有 turnId → 不按轮次丢弃，退回 10 分钟 TTL 口径
    let legacyTurn = '';
    const uc = makeUsage('turn-legacy.json', { now: () => T0, turnIdProvider: () => legacyTurn });
    inject(uc, '事实', textFact, T0, 'fact');
    legacyTurn = 'LATER';
    const rl = uc.noteUsed({ ids: uc.pendingIds(), text: '三花猫叫布丁，打雷会躲起来。', at: T0 + 1000 });
    ok('pending 无 turnId → 不按轮次丢弃（退回 TTL 口径）',
      rl.used === 1 && uc.stats({ at: T0 + 2000 }).staleDropped === 0, JSON.stringify(rl));

    // 显式 turnId 优先于 provider（noteInjected 的新可选参数）
    const ud = makeUsage('turn-explicit.json', { now: () => T0, turnIdProvider: () => 'Q' });
    const exId = MU.idFor({ source: '事实', role: 'fact', text: textFact, t: 0 });
    ud.noteInjected({
      entries: [{ id: exId, source: '事实', role: 'fact', text: textFact, t: 0 }],
      at: T0,
      turnId: 'E',
    });
    // provider 现在是 Q，与显式 E 不同 → 丢弃
    const re = ud.noteUsed({ ids: [exId], text: '三花猫叫布丁。', at: T0 + 1000 });
    ok('noteInjected 的显式 turnId 优先于 provider', re.reason === 'stale-turn' && re.used === 0,
      JSON.stringify(re));
  }

  // ── ④ 同一批注入重复结算不重复计数 ───────────────────────────────────
  const f2 = inject(u1, '事实', textFact, T0 + 10000, 'fact');
  const first = u1.noteUsed({ text: '三花猫叫布丁呀。', at: T0 + 11000 });
  const again = u1.noteUsed({ ids: [f2.ids[0]], batchId: f2.res.batchId, text: '三花猫叫布丁呀。', at: T0 + 12000 });
  ok('同一轮重复 noteUsed 不重复计数', first.used === 1 && again.used === 0,
    `first=${first.used} again=${again.used}`);
  const s3 = u1.stats({ at: T0 + 13000 });
  ok('重复注入会进分母、命中进分子', s3.bySource['事实'].injected === 2 && s3.bySource['事实'].used === 2,
    `${s3.bySource['事实'].used}/${s3.bySource['事实'].injected}`);

  // ── ⑤ 衰减口径（2026-11-22 调研修正：锚点=最后注入 + 要求注入 ≥5 次）────
  // 旧口径会把「一直在注入、只是没被原样引用」的记忆在第 91 天判死；
  // 新口径：反复注入过（≥5 次）、从未被引用、且 90 天没再被注入，才算休眠。
  const u2 = makeUsage('decay.json', { now: () => T0 });
  const d1 = inject(u2, '日记', '那天她在海边捡到一枚很漂亮的贝壳。', T0);
  const d1Id = d1.ids[0];
  let sd = u2.stats({ at: T0 + 91 * DAY });
  ok('只注入 1 次 → 91 天也不判 decayed（机会太少）', sd.bySource['日记'].decayed === 0,
    JSON.stringify({ decayed: sd.bySource['日记'].decayed, injected: sd.bySource['日记'].injected }));
  ok('未达注入门槛也不进 unused', sd.bySource['日记'].unused === 0);

  // 同一条在 T0 反复注入 5 次（总注入 6 次）→ 仍未引用 → unused=1，但还没到 90 天没注入
  for (let i = 0; i < 4; i += 1) inject(u2, '日记', '那天她在海边捡到一枚很漂亮的贝壳。', T0 + i * 1000);
  sd = u2.stats({ at: T0 + 89 * DAY });
  ok('反复注入未引用 → unused=1（诊断，不降权）', sd.bySource['日记'].unused === 1, JSON.stringify(sd.bySource['日记']));
  ok('89 天没到 → 不判 decayed', sd.bySource['日记'].decayed === 0);
  sd = u2.stats({ at: T0 + 91 * DAY });
  ok('注入 ≥5 次 + 91 天没再注入 → decayed', sd.bySource['日记'].decayed === 1, JSON.stringify(sd.bySource['日记']));
  ok('decayed 条目不删除，仍占索引', sd.index.entries === 1 && u2.entry(d1Id) !== null, 'entries=' + sd.index.entries);
  ok('decayed 条目降权到 0.5', u2.weightOf(d1Id, { at: T0 + 91 * DAY }) === 0.5);

  // 关键回归：锚点是「最后一次注入」而不是「第一次注入」——
  // T0 注入 6 次后，第 50 天再注入一次 → 第 91 天只过了 41 天，不能判死。
  inject(u2, '日记', '那天她在海边捡到一枚很漂亮的贝壳。', T0 + 50 * DAY);
  const sdLate = u2.stats({ at: T0 + 91 * DAY });
  ok('90 天内还被注入过 → 不判 decayed（锚点=最后注入）', sdLate.bySource['日记'].decayed === 0,
    JSON.stringify({ decayed: sdLate.bySource['日记'].decayed, lastInjected: sdLate.lastInjectedAt }));

  // 用上后清除 decayed（先走到 decayed 再看恢复）
  const u2b = makeUsage('decay2.json', { now: () => T0 });
  for (let i = 0; i < 5; i += 1) inject(u2b, '日记', '那天她在海边捡到一枚很漂亮的贝壳。', T0 + i * 1000);
  const d2Id = u2b.stats({ at: T0 }).bySource['日记'].entries === 1
    ? Object.keys(u2b.snapshot ? u2b.snapshot().entries : {})[0] : null;
  ok('构造出 decayed 样本', u2b.stats({ at: T0 + 91 * DAY }).bySource['日记'].decayed === 1);
  // 先刷新 pending（pending 只有 10 分钟 TTL，隔了 92 天直接 noteUsed 会因过期拿不到 ids）
  inject(u2b, '日记', '那天她在海边捡到一枚很漂亮的贝壳。', T0 + 92 * DAY);
  u2b.noteUsed({ text: '你记得那天在海边捡到一枚很漂亮的贝壳吗？', at: T0 + 92 * DAY + 1000 });
  const sd2 = u2b.stats({ at: T0 + 93 * DAY });
  ok('再次命中后 decayed 清除', sd2.bySource['日记'].decayed === 0,
    JSON.stringify(sd2.bySource['日记']) + (d2Id ? ' id=' + d2Id : ''));

  // ── ⑥ 索引总量稳定 + 持久化 ──────────────────────────────────────────
  const u3 = makeUsage('stable.json');
  const stableText = '她答应过周末一起去看新上映的电影。';
  for (let i = 0; i < 50; i += 1) inject(u3, '对话', stableText, T0 + i * 1000);
  const sStable = u3.stats({ at: T0 + 60 * 1000 });
  ok('同一正文重复注入 50 次只有 1 个索引条目', sStable.index.entries === 1,
    'entries=' + sStable.index.entries);
  ok('注入次数累计到 50', sStable.bySource['对话'].injected === 50, String(sStable.bySource['对话'].injected));
  const u3b = MU.createMemoryUsage({ file: path.join(ROOT, 'stable.json') });
  const sReload = u3b.stats({ at: T0 + 60 * 1000 });
  ok('重启后从磁盘恢复', sReload.index.entries === 1 && sReload.bySource['对话'].injected === 50,
    JSON.stringify(sReload.bySource['对话']));
  ok('落盘文件在临时数据根内', fs.existsSync(path.join(ROOT, 'stable.json')) && iso.assertIsolated(path.join(ROOT, 'stable.json')));

  // 容量上限：超过 maxEntries 时按「未用过、最久没注入」淘汰，索引不无限长
  const u4 = makeUsage('bounded.json', { maxEntries: 3 });
  for (let i = 0; i < 6; i += 1) inject(u4, '记忆库', `第${i}条完全不同的旧事，内容编号${i}${i}${i}。`, T0 + i * 1000);
  const sBound = u4.stats({ at: T0 + 10000 });
  ok('索引条目受 maxEntries 限制', sBound.index.entries <= 3 && sBound.index.evicted >= 3,
    `entries=${sBound.index.entries} evicted=${sBound.index.evicted}`);

  // ── ⑦ 真实注入链路：memory-recall 注入 → llm-handler 结算 ────────────
  // 用临时记录室造一条独有记忆，跑插件的 onUserInput，再模拟 llm-handler 的 noteUsed。
  const recallFile = path.join(ROOT, '记忆库.txt');
  fs.writeFileSync(recallFile,
    '[2026年11月20日]\n【用户】: 我上周在青岚湖畔捡到一只三花猫，取名叫布丁，它特别怕打雷。\n', 'utf8');
  const P = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-recall', 'index.js'));
  const patches = new Map();
  const p = new P();
  p.context = {
    // 阈值压到最低：这里验的是「注入点有没有记账」，不是召回闸本身。
    getPluginFileConfig: () => ({
      auto_inject: true, hybrid_enabled: false,
      // 注入闸的均分门槛压到 0.1：单条索引里 top 分天然低，这里只验「注入点记账」。
      auto_inject_min_score: 0.1, auto_inject_min_ratio: 0.1, auto_inject_limit: 3,
    }),
    log: () => {},
    addSystemPromptPatch: (id, text) => { patches.set(id, text); },
    removeSystemPromptPatch: (id) => { patches.delete(id); },
    getMessages: () => [],
    callLLM: async () => '',
  };
  await p.onInit();
  p._recordsDir = ROOT;
  p._hybrid = false;
  p._maxDocs = 100;
  p._reinforceInjected = () => {};   // 不写真实强化表
  p._reinforceDocs = () => {};
  p._rebuild();
  p._continuityDone = true;          // 不生成跨会话接续，保持本用例只剩检索注入

  const MUdefault = MU;              // 默认单例：文件 = PET_DATA_ROOT/data/记忆兑现.json
  MUdefault.reload();
  await p.onUserInput({ text: '你还记得我在青岚湖畔捡到的那只三花猫布丁吗？' });
  const injectedIds = MUdefault.pendingIds();
  const sInject = MUdefault.stats({ at: Date.now() });
  ok('memory-recall 注入后 noteInjected 已记账',
    patches.has('memory-recall-context') && injectedIds.length > 0 && sInject.total.injected > 0,
    `ids=${injectedIds.length} injected=${sInject.total.injected}`);

  // 路径 A：插件 onTTSStart 兜底结算（热重载/其他 LLM 入口也能用）
  await p.onTTSStart('当然记得，你在青岚湖畔捡到一只三花猫，叫布丁，怕打雷。');
  const sUse = MUdefault.stats({ at: Date.now() + 2000 });
  ok('插件 onTTSStart 引用后命中率 > 0',
    sUse.total.used > 0 && sUse.bySource['记忆库'].used > 0,
    JSON.stringify({ total: sUse.total.used, 记忆库: sUse.bySource['记忆库'] }));

  // 路径 B：llm-handler 主路径（这里直接调模块，等价于 llm-handler 的 noteUsed）
  await p.onUserInput({ text: '你还记得我在青岚湖畔捡到的那只三花猫布丁吗？' });
  const beforeB = MUdefault.stats({ at: Date.now() + 3000 }).total.used;
  MUdefault.noteUsed({
    ids: MUdefault.pendingIds(),
    text: '你在青岚湖畔捡到一只三花猫布丁，它怕打雷。',
    at: Date.now() + 4000,
  });
  const afterB = MUdefault.stats({ at: Date.now() + 5000 }).total.used;
  ok('llm-handler 主路径 noteUsed 也可结算', beforeB > 0 && afterB > beforeB,
    `used ${beforeB} → ${afterB}`);

  // 接线静态校验：防止以后改注入点把观测删掉
  const recallSrc = fs.readFileSync(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'memory-recall', 'index.js'), 'utf8');
  const llmSrc = fs.readFileSync(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'ai', 'llm-handler.js'), 'utf8');
  ok('注入点接线仍在（memoryUsage.noteInjected）', recallSrc.includes('memoryUsage.noteInjected'));
  ok('回复结算接线仍在（memoryUsage.noteUsed）', llmSrc.includes('memoryUsage.noteUsed'));
  ok('插件 onTTSStart 兜底仍在', recallSrc.includes('async onTTSStart') && recallSrc.includes('memoryUsage.noteUsed'));

  // ── ⑧ 双路判定（2026-11-24）：fragment / entity / unknown ──────────────
  // 动机（§9.3-⑤）：提示词要求「不要逐条复述」，旧判定却只认 ≥6 字原样片段 →
  // 148 条记录 used 恒 0。现在原样片段仍是强信号，但内容 token 共现也算用上。
  {
    // 纯函数口径：entity 能认「换了个说法但提到同一个东西」
    const v1 = MU.judgeUsage('我对香菜过敏', '你上次说吃香菜会难受');
    ok('entity：记忆「我对香菜过敏」+ 回复提「香菜」→ used', v1.used && v1.method === 'entity',
      JSON.stringify(v1));
    const v2 = MU.judgeUsage('下周三要去面试', '面试准备得怎么样');
    ok('entity：记忆「下周三要去面试」+ 回复「面试准备」→ used', v2.used && v2.method === 'entity',
      JSON.stringify(v2));
    const v3 = MU.judgeUsage('今天天气晴', '我不太清楚');
    ok('entity：无共现实词（天气晴 vs 不清楚）→ 不是 used', v3.used === false && v3.verdict === 'not-used',
      JSON.stringify(v3));
    const v4 = MU.judgeUsage('今天天气晴', '好的我知道了谢谢你');
    ok('entity：回复全是停用词/寒暄 → 不是 used', v4.used === false, JSON.stringify(v4));
    const v5 = MU.judgeUsage('我对香菜过敏', '');
    ok('空回复 → unknown（不算 miss）', v5.verdict === 'unknown' && v5.reason === 'empty-text', JSON.stringify(v5));
    const v6 = MU.judgeUsage('我对香菜过敏', '哦');
    ok('过短回复 → unknown（不算 miss）', v6.verdict === 'unknown' && v6.reason === 'too-short', JSON.stringify(v6));
    const v7 = MU.judgeUsage('我对香菜过敏', '你上次说我对香菜过敏吧', MU.extractFragments('我对香菜过敏'));
    ok('原样 ≥6 字片段仍然是 used(fragment)', v7.used && v7.method === 'fragment' && v7.fragment === '我对香菜过敏',
      JSON.stringify(v7));
    const v8 = MU.judgeUsage('约在下周三下午三点在城西咖啡馆见', '周三下午三点那家店');
    ok('数字/时间类强实体命中即 used', v8.used && v8.method === 'entity', JSON.stringify(v8));

    // 停用词表覆盖需求点名的那批词
    const need = ['今天', '我们', '可以', '什么', '就是', '知道', '一个', '这个', '那个', '时候',
      '然后', '因为', '所以', '但是', '还是', '已经', '现在', '自己', '觉得', '应该',
      '可能', '不是', '没有', '这样', '那样', '一点', '有点', '真的', '其实', '如果', '东西', '事情'];
    ok('停用词覆盖需求清单（32 词）', need.every((w) => MU.ENTITY_STOPWORDS.has(w)),
      need.filter((w) => !MU.ENTITY_STOPWORDS.has(w)).join(',') || '全覆盖');
    const toks = MU.entityTokens('今天我们自己觉得这个真的有点东西');
    ok('停用词不会进记忆 token', toks.length === 0, toks.map((t) => t.text).join(',') || '(空)');

    // 走实例：matched 记录带 method/tokens，且 used 会真的加一
    const u9 = makeUsage('entity.json', { now: () => T0 });
    injectMany(u9, [
      { source: '事实', text: '我对香菜过敏', at: T0, role: 'fact' },
      { source: '事实', text: '下周三要去面试', at: T0, role: 'fact' },
    ]);
    const r9 = u9.noteUsed({ text: '你上次说吃香菜会难受，面试准备得怎么样？', at: T0 + 1000 });
    ok('实例结算：两条 entity 命中都记 used', r9.used === 2, JSON.stringify(r9.matched));
    ok('matched 记录带 method=entity 与 tokens',
      r9.matched.every((m) => m.method === 'entity' && Array.isArray(m.tokens) && m.tokens.length > 0),
      JSON.stringify(r9.matched));
    ok('matched 保留旧字段 source/fragment（fragment 为 null）',
      r9.matched.every((m) => typeof m.source === 'string' && m.fragment === null), JSON.stringify(r9.matched));

    // unknown 不污染分母/分子
    const u10 = makeUsage('unknown.json', { now: () => T0 });
    inject(u10, '事实', '我对香菜过敏', T0, 'fact');
    const r10 = u10.noteUsed({ text: '嗯', at: T0 + 1000 });
    const s10 = u10.stats({ at: T0 + 2000 });
    ok('unknown 不增 used、仍只记注入 1 次', r10.verdict === 'unknown' && s10.bySource['事实'].used === 0
      && s10.bySource['事实'].injected === 1, JSON.stringify({ r10, 事实: s10.bySource['事实'] }));

    // 落盘重启后 tokens 仍在：entity 判定不依赖内存里的全文
    const u11 = makeUsage('persist-entity.json', { now: () => T0 });
    inject(u11, '事实', '我对香菜过敏', T0, 'fact');
    u11.noteUsed({ text: '吃香菜会难受吗', at: T0 + 1000 });
    const u11b = MU.createMemoryUsage({ file: path.join(ROOT, 'persist-entity.json'), now: () => T0 });
    const stored = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'persist-entity.json'), 'utf8')).entries)[0];
    ok('tokens 随条目落盘（重启后仍可判）', Array.isArray(stored.tokens) && stored.tokens.includes('c:香菜'),
      JSON.stringify(stored.tokens));
    ok('落盘条目记录了 lastMethod', stored.lastMethod === 'entity' && u11b.stats({ at: T0 }).total.used === 1,
      String(stored.lastMethod));

    // 老记录兼容：没有 tokens/lastMethod 字段的条目也能读、能判（退回 preview 抽 token）
    const legacyFile = path.join(ROOT, 'legacy-usage.json');
    iso.assertIsolated(legacyFile);
    fs.writeFileSync(legacyFile, JSON.stringify({
      version: 1, createdAt: T0, updatedAt: T0,
      entries: {
        old1: {
          id: 'old1', src: '事实', role: 'fact', preview: MU.normalizeText('我对香菜过敏'),
          fragments: MU.extractFragments('我对香菜过敏'), injected: 3, used: 0,
          firstAt: T0, lastInjectedAt: T0, lastUsedAt: 0, decayed: false, batch: '', usedBatch: '',
        },
      },
    }), 'utf8');
    const u12 = MU.createMemoryUsage({ file: legacyFile, now: () => T0 });
    u12.noteInjected({ entries: [{ id: 'old1', source: '事实', role: 'fact' }], at: T0 });
    const r12 = u12.noteUsed({ text: '香菜吃多了会难受', at: T0 + 1000 });
    ok('老记录（无 tokens 字段）仍能读并能判', r12.used === 1 && r12.matched[0].method === 'entity',
      JSON.stringify(r12));
  }

  iso.cleanup(TMP);
  console.log('\n  记忆兑现率：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e && e.stack || e);
  iso.cleanup(TMP);
  process.exit(2);
});
