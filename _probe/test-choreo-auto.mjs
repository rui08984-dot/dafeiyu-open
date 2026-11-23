#!/usr/bin/env node
/**
 * _probe/test-choreo-auto.mjs —— 长表演自动触发决策（2026-11-16）
 *
 * 用户拍板：「聊天的时候触发才像真人」。但真人不会每句话都演 20–38 秒，
 * 所以真正的验收对象是**节流决策**，不是「有情绪就播」：
 *   情绪映射 / 排除项 / 强度门槛 / 全局冷却 / 同段冷却 / 会话上限 / 状态机记账
 *
 * 纯函数测试，不加载模型、不碰窗口。
 */
'use strict';

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOD = path.join(__dirname, '..', 'pet-runtime', 'desktop', 'choreo-auto.mjs');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const MIN = 60 * 1000;

(async () => {
  const m = await import(pathToFileURL(MOD).href);

  // ① 映射表（v3）：情绪 → 候选段列表；15 段全部可自动（叙事段走情绪，技术段走空闲）
  const candidates = Object.values(m.EMOTION_PERFORMANCES);
  const mappedKeys = new Set(candidates.flat());
  ok('情绪映射覆盖 10 个键 / 11 个叙事段', Object.keys(m.EMOTION_PERFORMANCES).length === 10 && mappedKeys.size === 11,
    `${Object.keys(m.EMOTION_PERFORMANCES).length} 键 → ${mappedKeys.size} 段`);
  ok('同一情绪可有多段候选', candidates.some((list) => list.length >= 2), candidates.map((x) => x.length).join(','));
  ok('映射到的段都在表演库里', [...mappedKeys].every((k) => /^\d\d-/.test(k)), [...mappedKeys].join(','));
  ok('空闲池覆盖 05/06/07/08/01', ['05-weight-shift', '06-finger-articulation', '07-left-articulation', '08-grass-articulation', '01-curiosity']
    .every((k) => m.IDLE_PERFORMANCES.includes(k)), m.IDLE_PERFORMANCES.join(','));
  ok('13 换装段只在稀有池', m.RARE_PERFORMANCES.includes('13-form-performance') && !m.IDLE_PERFORMANCES.includes('13-form-performance'));
  ok('15 段全部可自动（情绪∪空闲∪稀有）', new Set([...mappedKeys, ...m.IDLE_PERFORMANCES, ...m.RARE_PERFORMANCES]).size === 15,
    String(new Set([...mappedKeys, ...m.IDLE_PERFORMANCES, ...m.RARE_PERFORMANCES]).size));
  ok('生气/中性明确排除', m.NO_PERFORMANCE.has('angry') && m.NO_PERFORMANCE.has('neutral'));

  // ② 决策：正常触发
  const base = { emotion: 'happy', strength: 1.0, now: 100 * MIN };
  const d1 = m.decidePerformance(base);
  ok('开心 + 强情绪 → 演 04', d1.play === true && d1.key === '04-playful', JSON.stringify(d1));
  ok('委屈 → 02', m.decidePerformance({ ...base, emotion: 'aggrieved' }).key === '02-vulnerable');
  ok('害羞 → 14', m.decidePerformance({ ...base, emotion: 'shy' }).key === '14-flirt');
  ok('惊讶 → 12', m.decidePerformance({ ...base, emotion: 'surprise' }).key === '12-bold-performance');
  ok('心虚 → 11', m.decidePerformance({ ...base, emotion: 'guilty' }).key === '11-mischief');
  ok('无聊/困倦只在空闲通道演（idle-only）', (() => {
    const d = m.decidePerformance({ ...base, emotion: 'bored' });
    const d2 = m.decidePerformance({ ...base, emotion: 'sleepy' });
    return !d.play && d.reason === 'idle-only' && !d2.play && d2.reason === 'idle-only';
  })());

  // ③ 拒绝路径：每种都要有明确 reason（排障时靠它）
  ok('生气不演（excluded）', (() => { const d = m.decidePerformance({ ...base, emotion: 'angry' }); return !d.play && d.reason === 'excluded'; })());
  ok('中性不演（excluded）', (() => { const d = m.decidePerformance({ ...base, emotion: 'neutral' }); return !d.play && d.reason === 'excluded'; })());
  ok('未知情绪不演（no-mapping）', (() => { const d = m.decidePerformance({ ...base, emotion: 'soft-low' }); return !d.play && d.reason === 'no-mapping'; })());
  ok('淡情绪不演（weak-emotion，门槛 0.35）', (() => {
    const d = m.decidePerformance({ ...base, strength: 0.2 });
    return !d.play && d.reason === 'weak-emotion';
  })(), 'strength=0.2');
  ok('0.4 强度可以演（门槛从 0.45 降到 0.35）', m.decidePerformance({ ...base, strength: 0.4 }).play === true);
  ok('强度缺失不演（weak-emotion）', (() => { const d = m.decidePerformance({ ...base, strength: undefined }); return !d.play; })());

  // ④ 冷却
  ok('3 分钟内不重复（global-cooldown）', (() => {
    const d = m.decidePerformance({ emotion: 'sad', strength: 1, now: 100 * MIN + 30 * 1000, lastAt: 100 * MIN });
    return !d.play && d.reason === 'global-cooldown';
  })());
  ok('候选里只剩没冷却完的段（key-cooldown）', (() => {
    const d = m.decidePerformance({
      emotion: 'happy', strength: 1, now: 101 * MIN, lastAt: 100 * MIN,
      lastByKey: { '04-playful': 100 * MIN, '15-flirt-layered': 100 * MIN, '03-pride': 100 * MIN },
      options: { globalCooldownMs: 1000 },
    });
    return !d.play && d.reason === 'key-cooldown';
  })());
  ok('全局冷却过 + 换一段 → 可演', (() => {
    const d = m.decidePerformance({
      emotion: 'shy', strength: 1, now: 101 * MIN, lastAt: 100 * MIN, lastByKey: { '04-playful': 100 * MIN },
      options: { globalCooldownMs: 1000 },
    });
    return d.play && d.key === '14-flirt';
  })());
  ok('候选段挑「最久没演」的：03 比 04 更久 → 选 03', (() => {
    const d = m.decidePerformance({
      emotion: 'happy', strength: 1, now: 200 * MIN, lastAt: 190 * MIN,
      lastByKey: { '04-playful': 200 * MIN, '03-pride': 100 * MIN, '15-flirt-layered': 150 * MIN },
      options: { globalCooldownMs: 1000 },
    });
    return d.play && d.key === '03-pride';
  })());
  ok('会话上限 12 段（session-cap）', (() => {
    const d = m.decidePerformance({ ...base, sessionCount: 12 });
    return !d.play && d.reason === 'session-cap';
  })());

  // ⑤ 参数可覆盖（调参不用改代码）
  ok('minStrength 可调', (() => {
    const d = m.decidePerformance({ ...base, strength: 0.3, options: { minStrength: 0.2 } });
    return d.play === true;
  })());

  // ⑥ 状态机：自动记账 + 手动同步 + 重置
  const trigger = m.createAutoTrigger();
  const a1 = trigger.consider({ emotion: 'happy', strength: 1, now: 100 * MIN });
  ok('状态机首次触发', a1.play === true, JSON.stringify(a1));
  ok('状态机记账（sessionCount=1）', trigger.sessionCount === 1, String(trigger.sessionCount));
  const a2 = trigger.consider({ emotion: 'happy', strength: 1, now: 100 * MIN + 30 * 1000 });
  ok('状态机 30 秒内再问 → 冷却', a2.play === false && a2.reason === 'global-cooldown');
  const a3 = trigger.consider({ emotion: 'shy', strength: 1, now: 105 * MIN });
  ok('状态机 5 分钟后换情绪 → 触发', a3.play === true && a3.key === '14-flirt', JSON.stringify(a3));
  ok('状态机 sessionCount=2', trigger.sessionCount === 2, String(trigger.sessionCount));

  trigger.note('01-curiosity', 106 * MIN);
  const a4 = trigger.consider({ emotion: 'happy', strength: 1, now: 107 * MIN });
  ok('手动演过会同步记账（全局冷却生效）', a4.play === false && a4.reason === 'global-cooldown');

  const snap = trigger.snapshot();
  ok('snapshot 带冷却与上限', snap.sessionCount === 2 && snap.options.maxPerSession === 12,
    JSON.stringify({ n: snap.sessionCount, cap: snap.options.maxPerSession }));

  trigger.reset();
  ok('reset 后计数归零', trigger.sessionCount === 0);
  const a5 = trigger.consider({ emotion: 'happy', strength: 1, now: 108 * MIN });
  ok('reset 后立刻可演', a5.play === true, JSON.stringify(a5));


  // ⑥b 空闲通道（v3）：安静够久 + 概率通过才演；13 只在稀有池
  const idleBase = { now: 300 * MIN, idleMs: 3 * MIN, rand: 0, rand2: 0.5 };
  const i1 = m.decideIdle(idleBase);
  ok('空闲 3 分钟 → 可演（日常段）', i1.play === true && m.IDLE_PERFORMANCES.includes(i1.key), JSON.stringify(i1));
  ok('不够安静不演（not-idle）', (() => { const d = m.decideIdle({ ...idleBase, idleMs: 30 * 1000 }); return !d.play && d.reason === 'not-idle'; })());
  ok('空闲冷却内不演（idle-cooldown）', (() => {
    const d = m.decideIdle({ ...idleBase, lastIdleAt: 300 * MIN - 2 * MIN });
    return !d.play && d.reason === 'idle-cooldown';
  })());
  ok('概率没过不演（idle-roll）', (() => { const d = m.decideIdle({ ...idleBase, rand: 0.9 }); return !d.play && d.reason === 'idle-roll'; })());
  ok('稀有段要 rand2 命中才出（13）', (() => {
    const d = m.decideIdle({ ...idleBase, rand2: 0.01 });
    return d.play && d.key === '13-form-performance';
  })(), JSON.stringify(m.decideIdle({ ...idleBase, rand2: 0.01 })));
  const idleTrigger = m.createAutoTrigger();
  const ia = idleTrigger.considerIdle({ now: 300 * MIN, idleMs: 4 * MIN, rand: 0, rand2: 0.9 });
  ok('空闲状态机触发并记账', ia.play === true && idleTrigger.sessionCount === 1 && idleTrigger.snapshot().lastIdleAt === 300 * MIN,
    JSON.stringify(ia));
  const ib = idleTrigger.considerIdle({ now: 300 * MIN + 4 * MIN, idleMs: 5 * MIN, rand: 0, rand2: 0.9 });
  ok('状态机空闲冷却生效', ib.play === false && ib.reason === 'idle-cooldown', JSON.stringify(ib));

  // ⑦ 端到端节奏模拟：20 轮对话（每轮间隔 90 秒），看触发频率是否「像真人」
  const sim = m.createAutoTrigger();
  const emotions = ['happy', 'happy', 'neutral', 'sad', 'happy', 'shy', 'angry', 'neutral', 'smug', 'happy',
    'neutral', 'tease', 'neutral', 'neutral', 'aggrieved', 'neutral', 'neutral', 'neutral', 'guilty', 'neutral'];
  let fired = 0;
  const firedKeys = [];
  for (let i = 0; i < emotions.length; i += 1) {
    const r = sim.consider({ emotion: emotions[i], strength: 0.9, now: (100 + i * 1.5) * MIN });
    if (r.play) { fired += 1; firedKeys.push(r.key); }
  }
  console.log(`    模拟 20 轮 / 30 分钟对话 → 自动演了 ${fired} 段：${firedKeys.join(', ') || '无'}`);
  ok('20 轮对话里不会句句都演（≤8 段）', fired <= 8, fired + ' 段');
  ok('也不会一段都不演', fired >= 1, fired + ' 段');
  ok('同段不会连着出现', firedKeys.every((k, i) => i === 0 || firedKeys[i - 1] !== k), firedKeys.join(','));

  console.log('');
  console.log(`  自动触发决策：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error('测试本身出错：', e);
  process.exit(2);
});
