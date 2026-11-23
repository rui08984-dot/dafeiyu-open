// emotion-engine-test.mjs —— 情绪引擎单测（≥20 用例，node 直接跑）
// 用法：cd pet-runtime && node tools/emotion-engine-test.mjs
import { createEmotionEngine, blendParam, EMOTIONS, WORD_LIST, TUNING } from '../desktop/emotion-engine.mjs';

const ok = [], fail = [];
const check = (name, cond, extra = '') => (cond ? ok : fail).push(name + (extra ? '  ' + extra : ''));
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));

function makeEngine(overrides = {}) {
  const actions = [], bubbles = [], works = [];
  let clock = 0;
  const engine = createEmotionEngine(Object.assign({
    now: () => clock,
    onAction: (a) => actions.push(a),
    onBubble: (b) => bubbles.push(b),
    onWorkState: (w) => works.push(w),
  }, overrides));
  return { engine, actions, bubbles, works, setClock: (v) => { clock = v; }, getClock: () => clock };
}

// ── 1. 空输入 / 未知词 ────────────────────────────────────────────────────
{
  const { engine } = makeEngine();
  check('空输入不抛错', engine.feed({}) === false);
  check('空文本不产生情绪', engine.tick(0).emotion === 'neutral');
  check('未知词不命中', engine.feed({ text: '今天天气不错', kind: 'llm', now: 100 }) === false);
  check('未知事件不命中', engine.feed({ kind: 'event', name: 'nope', now: 200 }) === false);
  check('词表 ≥40 条', WORD_LIST.length >= 40, 'words=' + WORD_LIST.length);
  check('情绪表覆盖 12 种', Object.keys(EMOTIONS).length >= 12, 'emotions=' + Object.keys(EMOTIONS).length);
}

// ── 2. L1 关键词 ─────────────────────────────────────────────────────────
{
  const t = makeEngine();
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 0 });
  eq('L1 哈哈 → happy', t.engine.tick(10).emotion, 'happy');
  const out = t.engine.tick(10);
  check('happy 带 EyeSmile 目标值', out.targets.EyeSmile === 1, JSON.stringify(out.targets));
  check('happy 权重=强度(0.9)', Math.abs(out.weight - 0.9) < 0.001, 'w=' + out.weight);
}
{
  const t = makeEngine();
  t.engine.feed({ text: '唉，算了，好累', kind: 'llm', now: 0 });
  eq('L1 唉/算了/累 → sad', t.engine.tick(10).emotion, 'sad');
}
{
  const t = makeEngine();
  t.engine.feed({ text: '气死我了', kind: 'llm', now: 0 });
  eq('L1 气死 → angry', t.engine.tick(10).emotion, 'angry');
}
{
  const t = makeEngine();
  t.engine.feed({ text: '好困啊', kind: 'llm', now: 0 });
  eq('L1 好困 → sleepy', t.engine.tick(10).emotion, 'sleepy');
}
{
  const t = makeEngine();
  t.engine.feed({ text: '我厉害吧', kind: 'llm', now: 0 });
  eq('L1 我厉害吧 → smug（长词优先于「厉害」）', t.engine.tick(10).emotion, 'smug');
}
{
  const t = makeEngine();
  t.engine.feed({ text: '害羞…', kind: 'llm', now: 0 });
  eq('L1 害羞 → shy', t.engine.tick(10).emotion, 'shy');
  check('shy 目标含 PupilX', t.engine.tick(10).targets.PupilX === -0.6);
}
{
  const t = makeEngine();
  t.engine.feed({ text: '就这？', kind: 'llm', now: 0 });
  eq('L1 就这 → tease', t.engine.tick(10).emotion, 'tease');
}

// ── 3. L2 标点/句式（只出动作）──────────────────────────────────────────
{
  const t = makeEngine();
  t.engine.feed({ text: '真的吗？', kind: 'llm', now: 0 });
  check('L2 问号 → 侧头动作', t.actions.includes('tilt head right'), JSON.stringify(t.actions));
}
{
  const t = makeEngine();
  t.engine.feed({ text: '好啊！', kind: 'llm', now: 0 });
  check('L2 感叹号 → 点头', t.actions.includes('nod head'), JSON.stringify(t.actions));
}
{
  const t = makeEngine();
  t.engine.feed({ text: '真的！！', kind: 'llm', now: 0 });
  check('L2 双感叹号 → 耸肩', t.actions.includes('shrug'), JSON.stringify(t.actions));
}
{
  const t = makeEngine();
  t.engine.feed({ text: '算了……', kind: 'llm', now: 0 });
  check('L2 省略号 → 前倾', t.actions.includes('lean forward'), JSON.stringify(t.actions));
}
{
  const t = makeEngine();
  t.engine.feed({ text: '嗯。好。行。', kind: 'llm', now: 0 });
  check('L2 连续短句 → 快速点头', t.actions.filter((a) => a === 'nod head').length === 1, JSON.stringify(t.actions));
}

// ── 4. 优先级仲裁 ───────────────────────────────────────────────────────
{
  const t = makeEngine();
  t.engine.feed({ text: '哈哈！', kind: 'llm', now: 0 });
  check('L1 命中时 L2 动作排后面', t.engine.tick(10).layerName === 'L1', t.engine.tick(10).layerName);
}
{
  const t = makeEngine();
  t.engine.feed({ text: '<表情:得意>哈哈', kind: 'llm', now: 0 });
  const out = t.engine.tick(10);
  eq('L4 <表情:得意> 压过 L1 哈哈', out.emotion, 'smug');
  check('L4 层级=40', out.layer === 40, 'layer=' + out.layer);
}
{
  const t = makeEngine();
  t.engine.feed({ text: '<动作:wave>你好呀', kind: 'llm', now: 0 });
  check('L4 动作标签 → 直接播动作', t.actions.includes('wave'), JSON.stringify(t.actions));
}
{
  const t = makeEngine();
  t.engine.feed({ text: '前面说了一堆<开心>', kind: 'llm', now: 0 });
  eq('L4 <开心> 别名 → happy', t.engine.tick(10).emotion, 'happy');
}
{
  const t = makeEngine();
  t.engine.feed({ text: '嘿嘿', kind: 'llm', now: 0 });        // happy 0.72
  t.setClock(200);
  t.engine.feed({ text: '笑死我了', kind: 'llm', now: 200 });   // happy 0.95 同层更强
  check('同层更强可覆盖', t.engine.tick(210).weight >= 0.9, 'w=' + t.engine.tick(210).weight);
}
{
  const t = makeEngine();
  t.engine.feed({ text: '笑死我了', kind: 'llm', now: 0 });     // happy 0.95
  t.setClock(200);
  t.engine.feed({ text: '嘿嘿', kind: 'llm', now: 200 });       // happy 0.72 更弱
  check('同层更弱不覆盖（保持高权重）', t.engine.tick(210).weight >= 0.9, 'w=' + t.engine.tick(210).weight);
}
{
  const t = makeEngine();
  t.engine.feed({ text: '<动作:wave>', kind: 'llm', now: 0 });  // L4 动作（动作通道）
  t.setClock(200);
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 200 });       // L1 情绪（情绪通道）
  const out = t.engine.tick(210);
  check('L4 动作与 L1 情绪分属两个通道，可并存', out.emotion === 'happy' && t.actions.includes('wave'), JSON.stringify({ e: out.emotion, a: t.actions }));
}

// ── 5. TTL / 冷却 ───────────────────────────────────────────────────────
{
  const t = makeEngine();
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 0 });
  eq('TTL 内保持 happy', t.engine.tick(2000).emotion, 'happy');
  const expired = t.engine.tick(4500);
  // 状态机在 TTL 到期时立即报告 neutral（不再卡在情绪里）；
  // 但参数权重会按 releaseMs 平滑收势 —— 这是「余味」，不是 bug。
  check('TTL 到期回落 neutral（状态层）', expired.emotion === 'neutral', JSON.stringify(expired));
  check('TTL 到期后权重开始收势', expired.weight > 0 && expired.weight < 0.9, 'w=' + expired.weight);
  // 再等够 releaseMs，权重必须真的落到 0（余味散尽，不留残余参数）
  const settled = t.engine.tick(4500 + 1200);
  check('余味散尽后权重归零', settled.weight === 0, 'w=' + settled.weight + ' targets=' + JSON.stringify(settled.targets));
}
{
  const t = makeEngine();
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 0 });
  t.engine.tick(10);
  t.setClock(4600);
  t.engine.tick(4600);                                        // 过期
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 4700 });      // 冷却中（happy 冷却到 8000）
  eq('同情绪冷却期内不重触发', t.engine.tick(4800).emotion, 'neutral');
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 8100 });      // 冷却结束
  eq('冷却结束可再触发', t.engine.tick(8200).emotion, 'happy');
}
{
  const t = makeEngine();
  t.engine.feed({ text: '<表情:开心>', kind: 'llm', now: 0 });
  t.engine.tick(10);
  t.setClock(100);
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 100 });
  eq('L4 不受冷却限制（同句覆盖）', t.engine.tick(120).emotion, 'happy');
}

// ── 6. L3 事件 ──────────────────────────────────────────────────────────
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'dblclick', now: 0 });
  const out = t.engine.tick(10);
  eq('dblclick → happy', out.emotion, 'happy');
  check('dblclick 播 laugh', t.actions.includes('laugh'), JSON.stringify(t.actions));
  check('dblclick 有气泡', t.bubbles.length === 1, JSON.stringify(t.bubbles));
}
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'drag', now: 0 });
  eq('drag → surprise（晕）', t.engine.tick(10).emotion, 'surprise');
  check('drag 播 shake head', t.actions.includes('shake head'));
}
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'hover', now: 0 });
  eq('hover → shy', t.engine.tick(10).emotion, 'shy');
}
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'drop', now: 0 });
  check('drop 有气泡「放我下来」', t.bubbles.includes('放我下来'), JSON.stringify(t.bubbles));
}
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'speak_start', now: 0 });
  t.setClock(6 * 60 * 1000);
  t.engine.feed({ kind: 'event', name: 'speak_start', now: 6 * 60 * 1000 });
  const out = t.engine.tick(6 * 60 * 1000);
  check('说话时不触发闲置事件', out.emotion === 'neutral', JSON.stringify({ e: out.emotion }));
}
{
  const t = makeEngine();
  t.engine.feed({ kind: 'work', meta: { state: 'done' }, now: 0 });
  check('work 事件转给 onWorkState', t.works.includes('done'), JSON.stringify(t.works));
  eq('work done → smug', t.engine.tick(10).emotion, 'smug');
}

// ── 7. 闲置 ─────────────────────────────────────────────────────────────
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'interaction', now: 0 });
  const out = t.engine.tick(TUNING.idleHuffMs + 1000);
  eq('5 分钟没人理 → sleepy', out.emotion, 'sleepy');
  check('5 分钟触发打哈欠动作', t.actions.includes('stretch'), JSON.stringify(t.actions));
}
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'interaction', now: 0 });
  const out = t.engine.tick(TUNING.idleSleepyMs + 1000);
  check('15 分钟 → 犯困（更强）', out.emotion === 'sleepy' && out.weight >= 0.9, JSON.stringify({ e: out.emotion, w: out.weight }));
}

// ── 8. 气泡节流 + 工具函数 ───────────────────────────────────────────────
{
  const t = makeEngine();
  t.engine.feed({ kind: 'event', name: 'dblclick', now: 0 });
  t.engine.tick(10);
  t.setClock(100);
  t.engine.feed({ kind: 'event', name: 'dblclick', now: 100 });   // 1.5s 内不重复
  check('气泡 1.5s 内不重复', t.bubbles.length === 1, JSON.stringify(t.bubbles));
}
{
  eq('blendParam 基线=1 目标=1.3 → 1.3', blendParam(1, 1.3, 1, 0, 1.5), 1.3);
  eq('blendParam 半强度', blendParam(0, -0.5, 0.5, -1, 1), -0.25);
  eq('blendParam 超界被 clamp', blendParam(1, 1.6, 1, 0, 1.5), 1.5);
}
{
  const t = makeEngine();
  t.engine.feed({ text: '哈哈', kind: 'llm', now: 0 });
  const snap = t.engine.snapshot();
  check('snapshot 字段齐全', ['emotion', 'layer', 'remainingMs', 'cooldowns', 'counters', 'lastHit'].every((k) => k in snap), JSON.stringify(Object.keys(snap)));
  t.engine.reset();
  eq('reset 后回到 neutral', t.engine.snapshot().emotion, 'neutral');
}

{
  const t = makeEngine();
  check('kind=emotion 直接指定情绪', t.engine.feed({ kind: 'emotion', emotion: 'shy', strength: 0.9, now: 0 }) === true);
  eq('显式情绪生效', t.engine.tick(10).emotion, 'shy');
  check('未知情绪被拒', t.engine.feed({ kind: 'emotion', emotion: 'unknown', now: 20 }) === false);
}

console.log('PASS ' + ok.length + ' / FAIL ' + fail.length);
if (fail.length) { console.log('失败：'); for (const f of fail) console.log('  ✗ ' + f); }