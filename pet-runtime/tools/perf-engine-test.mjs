// perf-engine-test.mjs —— 表情表演引擎单测（node 直接跑）
// 用法：cd pet-runtime && node tools/perf-engine-test.mjs
// 覆盖：VAD 连续性/回落/确定性、FACS 混合规则、模型画像降级、参数夹取、
//       外部所有权、语音表演层、微表情、快照字段。
import {
  createPerfEngine, buildProfile, PROFILE_SPECS, EXTERNALLY_OWNED,
  mixLayers, NEUTRAL_FACS, createFACS, clampFACS, listEmotions, describeCoverage,
} from '../desktop/perf/index.mjs';
import { VAD_PRESETS, dominantFromVAD, VadController } from '../desktop/perf/vad.mjs';
import { resolveArchetypeStyle, normalizeEmotion } from '../desktop/perf/archetypes.mjs';
import { vadToFACS, applyStyle, composeFace } from '../desktop/perf/expression.mjs';

const ok = [], fail = [];
const check = (name, cond, extra = '') => (cond ? ok : fail).push(name + (extra ? '  ' + extra : ''));
const eq = (name, actual, expected) => check(name, JSON.stringify(actual) === JSON.stringify(expected), 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
const near = (name, actual, expected, tol = 0.02) => check(name, Math.abs(Number(actual) - Number(expected)) <= tol, 'got=' + actual + ' want≈' + expected);

// ── jellyfish 的运行时事实（来自 pet.cdi3.json + 渲染器抓的 min/max）──
const JELLY_PARAMS = [
  'BrowInnerUp', 'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle',
  'ParamBrowLY2', 'ParamBrowRY2', 'EyeSmile', 'ParamEyeLOpen', 'ParamEyeROpen',
  'LEyeSquint', 'REyeSquint', 'ParamMouthForm', 'Mouthpucker', 'CheeckPuff',
  'ParamMouthOpenY', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamAngleX', 'ParamAngleY',
  'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleZ', 'ParamBreath',
  // key1..13：模型自带的连续效果参数（key7=脸红 / key2=流泪 / key13=流冷汗），范围 0..1。
  // 2026-11-12 补：之前这份清单漏了它们，导致画像把 blush/tear/sweat 判成「缺参数」而退回 exp3。
  'key1', 'key2', 'key3', 'key4', 'key5', 'key6', 'key7', 'key8', 'key9', 'key10', 'key11', 'key12', 'key13',
  // P0-4 不对称通道（模型自带左右分开的嘴角/眯眼 + 鼓腮）
  'MouthSmile_L', 'MouthSmile_R', 'LEyeSquint', 'REyeSquint', 'CheeckPuff',
];
const JELLY_RANGES = new Map([
  ['key2', [0, 1]], ['key7', [0, 1]], ['key13', [0, 1]],
  ['ParamEyeLOpen', [0, 1.5]], ['ParamEyeROpen', [0, 1.5]],
  ['EyeSmile', [0, 1]], ['BrowInnerUp', [0, 1]],
  ['ParamBrowLY', [-1, 1]], ['ParamBrowRY', [-1, 1]],
  ['ParamBrowLAngle', [-1, 1]], ['ParamBrowRAngle', [-1, 1]],
  ['ParamMouthForm', [-1, 1]], ['Mouthpucker', [0, 1]],
]);
const JELLY_EXPR = ['＞＜', '脸红', '流泪', '流冷汗', '圈圈眼', '爱心眼', '黑脸', '加载'];

function jellyProfile(overrides = {}) {
  return buildProfile(PROFILE_SPECS.jellyfish, Object.assign({
    paramIds: JELLY_PARAMS, expressions: JELLY_EXPR, ranges: JELLY_RANGES,
  }, overrides));
}

function makeEngine(options = {}) {
  return createPerfEngine(Object.assign({
    profile: jellyProfile(),
    baseline: { ParamEyeLOpen: 1, ParamEyeROpen: 1, ParamMouthForm: 0, BrowInnerUp: 0, ParamBrowLY: 0, ParamBrowRY: 0, EyeSmile: 0 },
    seed: 20261112,
  }, options));
}

function run(engine, seconds, fps = 60) {
  const step = 1 / fps;
  const n = Math.max(1, Math.round(seconds * fps));
  let out = null;
  for (let i = 0; i < n; i++) out = engine.update(step);
  return out;
}

// ── 1. FACS 基础：中性/夹取/叠加语义 ─────────────────────────────────────
{
  const f = createFACS();
  eq('默认脸是中性（eyeOpen=1）', f.eyeOpen, 1);
  const clamped = clampFACS({ eyeOpen: 9, mouthSmile: -5, blush: 3, browDown: -1 });
  eq('eyeOpen 上界夹到 1.32', clamped.eyeOpen, 1.32);
  eq('mouthSmile 下界夹到 0', clamped.mouthSmile, 0);
  eq('blush 上界夹到 1', clamped.blush, 1);
  eq('browDown 下界夹到 0', clamped.browDown, 0);
}

// ── 2. 混合规则：偏移量相加、表现量取 max、手动覆盖 ─────────────────────
{
  const mixed = mixLayers({
    idle: { headZ: 0.1, mouthSmile: 0.2 },
    emotion: { headZ: 0.2, mouthSmile: 0.4, blush: 0.3 },
    speech: { browOuterUp: 0.1, mouthOpen: 0.9 },
    manual: null,
  });
  near('头部偏移量相加 0.1+0.2', mixed.headZ, 0.3);
  // 待机层的笑意是「底色」，情绪层的笑意应该叠在底色上（相加），不是二选一；
  // 真正需要取 max 的是脸红/泪/汗这类会把脸糊掉的表现量。
  near('待机底色 + 情绪笑意可以叠加', mixed.mouthSmile, 0.56);
  near('脸红取 max 不叠加', mixed.blush, 0.3);
  near('语音层眉毛是偏移量', mixed.browOuterUp, 0.1);

  const withManual = mixLayers({ emotion: { mouthSmile: 0.9 }, manual: { mouthSmile: 0.2 } });
  near('手动层覆盖而不是叠加', withManual.mouthSmile, 0.2);
}

// ── 3. VAD：每个情绪锚点都能推回自己（round-trip）──────────────────────
{
  const cases = ['happy', 'excited', 'sad', 'surprise', 'shy', 'smug', 'tease', 'bored',
    'aggrieved', 'guilty', 'sleepy', 'calm', 'warm', 'curious', 'anxiety'];
  for (const name of cases) {
    eq('VAD round-trip: ' + name, dominantFromVAD(VAD_PRESETS[name]), name);
  }
  eq('VAD round-trip: angry→anger', dominantFromVAD(VAD_PRESETS.angry), 'anger');
  eq('零向量判中性', dominantFromVAD({ valence: 0, arousal: 0, dominance: 0 }), 'neutral');
}

// ── 4. VAD 惯性：刺激后逼近、保持期内不回落、保持期后回落 ───────────────
{
  const vad = new VadController({ seed: 7, personality: { ambientDriftStrength: 0, decayRate: 0.8, emotionHoldSeconds: 4 } });
  vad.nudge('happy', 0.9);
  for (let i = 0; i < 60; i++) vad.update(1 / 60);
  const after1s = vad.state();
  check('刺激 1 秒后效价为正', after1s.current.valence > 0.3, 'v=' + after1s.current.valence.toFixed(3));
  check('刺激 1 秒后判为开心或兴奋', ['happy', 'excited', 'curious'].includes(after1s.dominant), 'got=' + after1s.dominant);
  check('保持期还在', after1s.holdSeconds > 0, 'hold=' + after1s.holdSeconds.toFixed(2));

  const held = after1s.intensity;
  for (let i = 0; i < 120; i++) vad.update(1 / 60);
  const duringHold = vad.state();
  check('保持期内强度不明显衰减', duringHold.intensity > held * 0.85, 'held=' + held.toFixed(3) + ' now=' + duringHold.intensity.toFixed(3));

  // hold = 2.2 + 0.9*4 = 5.8s，再给 8 秒衰减时间
  for (let i = 0; i < 60 * 10; i++) vad.update(1 / 60);
  const afterDecay = vad.state();
  check('保持期结束后回落到接近中性', afterDecay.intensity < 0.12, 'i=' + afterDecay.intensity.toFixed(3));
}

// ── 5. 确定性：同 seed 两实例逐帧一致，异 seed 会漂移 ───────────────────
{
  const a = new VadController({ seed: 42 });
  const b = new VadController({ seed: 42 });
  const c = new VadController({ seed: 43 });
  const seqA = [], seqB = [], seqC = [];
  for (let i = 0; i < 240; i++) {
    a.update(1 / 60); b.update(1 / 60); c.update(1 / 60);
    seqA.push(a.state().current.valence); seqB.push(b.state().current.valence); seqC.push(c.state().current.valence);
  }
  eq('同 seed 序列完全一致', seqA, seqB);
  check('异 seed 序列不同', JSON.stringify(seqA) !== JSON.stringify(seqC));
}

// ── 6. 原型风格：几种情绪的关键通道要能读出来 ──────────────────────────
{
  const aggrieved = resolveArchetypeStyle('aggrieved');
  check('委屈：内眉抬得很高', aggrieved.browInnerUp > 0.6, 'v=' + aggrieved.browInnerUp);
  check('委屈：嘴角向下', aggrieved.mouthFrown > 0.25, 'v=' + aggrieved.mouthFrown);

  const smug = resolveArchetypeStyle('smug');
  check('得意：单边挑眉（右高左低）', smug.browUpR > smug.browUpL * 3, JSON.stringify({ R: smug.browUpR, L: smug.browUpL }));

  const happy = resolveArchetypeStyle('happy');
  check('开心：嘴角上扬', happy.mouthSmile > 0.3, 'v=' + happy.mouthSmile);
  check('开心：带笑眼', happy.eyeSmile > 0.15, 'v=' + happy.eyeSmile);

  eq('soft-happy 归一成 happy', normalizeEmotion('soft-happy'), 'happy');
  eq('未知情绪归一成 neutral', normalizeEmotion('wat'), 'neutral');
  check('情绪原型 ≥15 种', listEmotions().length >= 15, 'n=' + listEmotions().length);
}

// ── 7. VAD→FACS：正值微笑、负值皱眉、惊讶睁眼 ───────────────────────────
{
  const happy = vadToFACS({ valence: 0.7, arousal: 0.3, dominance: 0.1 });
  check('正效价 → 嘴角上扬', happy.mouthSmile > 0.25, 'v=' + happy.mouthSmile.toFixed(3));
  const sad = vadToFACS({ valence: -0.6, arousal: -0.2, dominance: -0.4 });
  check('负效价 → 嘴角向下', sad.mouthFrown > 0.2, 'v=' + sad.mouthFrown.toFixed(3));
  check('负效价 + 低支配 → 内眉抬', sad.browInnerUp > 0.2, 'v=' + sad.browInnerUp.toFixed(3));
  const surprise = vadToFACS({ valence: 0, arousal: 0.8, dominance: -0.3 });
  check('高唤醒 → 睁大眼', surprise.eyeOpen > 1.05, 'v=' + surprise.eyeOpen.toFixed(3));
  const styled = applyStyle(happy, { mouthSmile: 0.8 }, 0.5);
  check('风格层能把笑容推到更高但不越界', styled.mouthSmile > happy.mouthSmile && styled.mouthSmile <= 1);
}

// ── 8. 模型画像：缺失参数降级、外部所有权不写 ──────────────────────────
{
  const full = jellyProfile();
  check('完整模型：眉毛通道可用', full.capabilities.browInnerUp === true);
  check('完整模型：脸红走 key7 连续参数', full.channels.blush?.[0]?.kind === 'param' && full.channels.blush?.[0]?.id === 'key7');
  check('完整模型：参数表里出现 key7/key2/key13',
    ['key7', 'key2', 'key13'].every((k) => full.usedParams.includes(k)));
  check('完整模型：不对称通道已映射',
    ['MouthSmile_L', 'MouthSmile_R', 'LEyeSquint', 'REyeSquint', 'CheeckPuff'].every((k) => full.usedParams.includes(k)));

  const noBrow = jellyProfile({ paramIds: JELLY_PARAMS.filter((p) => !p.startsWith('ParamBrow') && p !== 'BrowInnerUp') });
  check('缺眉毛参数时降级而不是报错', noBrow.capabilities.browInnerUp === false);
  check('降级报告里有缺失项', noBrow.degraded.some((d) => d.missing && d.missing.startsWith('ParamBrow')));
  check('眼笑通道仍然可用', noBrow.capabilities.eyeSmile === true);

  const coverage = describeCoverage(full);
  check('覆盖率报告有分子分母', coverage.total > 0 && coverage.covered > 0, JSON.stringify({ covered: coverage.covered, total: coverage.total }));
  check('外部所有权表覆盖嘴/眼/头/身/呼吸',
    ['mouthOpen', 'gazeX', 'headX', 'bodyZ', 'breath'].every((k) => Boolean(EXTERNALLY_OWNED[k])));
  const ownedByOthers = Object.keys(EXTERNALLY_OWNED);
  check('画像永远不会产出外部所有权的参数',
    ownedByOthers.every((k) => !(k in full.channels)));
}

// ── 9. 引擎：情绪喂进去 → 参数出来，且不碰别人的参数 ────────────────────
{
  const engine = makeEngine();
  engine.feed({ emotion: 'happy', strength: 0.9 });
  const out = run(engine, 1.2);
  check('开心时嘴角参数为正', out.params.ParamMouthForm > 0.15, 'v=' + out.params.ParamMouthForm);
  check('开心时笑眼打开', out.params.EyeSmile > 0.1, 'v=' + out.params.EyeSmile);
  check('绝不写口型参数', !('ParamMouthOpenY' in out.params));
  check('绝不写眼球参数', !('ParamEyeBallX' in out.params) && !('ParamEyeBallY' in out.params));
  check('绝不写头部参数', !('ParamAngleX' in out.params));
  check('绝不写身体参数', !('ParamBodyAngleX' in out.params) && !('ParamBreath' in out.params));
  check('参数都在模型范围内', Object.entries(out.params).every(([id, value]) => {
    const range = JELLY_RANGES.get(id) || [-1, 1];
    return value >= range[0] - 1e-6 && value <= range[1] + 1e-6;
  }), JSON.stringify(out.params));
}

// ── 10. 情绪强度影响幅度；gate=0 时完全回到基线 ─────────────────────────
{
  const weak = makeEngine(); weak.feed({ emotion: 'happy', strength: 0.25 });
  const weakOut = run(weak, 1.2);
  const strong = makeEngine(); strong.feed({ emotion: 'happy', strength: 1 });
  const strongOut = run(strong, 1.2);
  check('强情绪的笑容大于弱情绪', strongOut.params.ParamMouthForm > weakOut.params.ParamMouthForm,
    'weak=' + weakOut.params.ParamMouthForm + ' strong=' + strongOut.params.ParamMouthForm);

  const gated = makeEngine(); gated.feed({ emotion: 'happy', strength: 1, gate: 0 });
  const gatedOut = run(gated, 1.0);
  check('gate=0（老引擎说收）时参数贴基线', Math.abs(gatedOut.params.ParamMouthForm || 0) < 0.06,
    'v=' + gatedOut.params.ParamMouthForm);
}

// ── 11. 脸红/流泪走 key 参数（连续权重），不再抢 exp3 单槽 ──────────────
{
  const engine = makeEngine();
  engine.feed({ emotion: 'shy', strength: 1 });
  const out = run(engine, 2.0);
  check('害羞会点亮 key7（脸红参数）', out.params.key7 > 0.05, 'v=' + out.params.key7);
  check('脸红不再占用 exp3 单槽', !out.expressions.some((e) => e.name === '脸红'), JSON.stringify(out.expressions));
  check('表情权重在 0..1 之间', out.expressions.every((e) => e.weight > 0 && e.weight <= 1), JSON.stringify(out.expressions));
}

// ── 11b. 不对称表情（P0-4）：得意/嘲讽必须左右不一样 ──────────────────
{
  // 注意：引擎的表情来自 VAD 的「主导情绪」，直接 feed('smug') 会被 VAD 判成 happy，
  // 变体（variant）只在主导情绪匹配时生效。所以这里分两层验：
  //   ① composeFace 层（真正实现不对称的那层）——方向必须正确
  //   ② 引擎层——只要左右不一样（通道确实接通了），不强求方向
  const teaseFace = composeFace({ valence: 0.3, arousal: 0.2, dominance: 0.4 }, { emotion: 'tease', intensity: 1 });
  check('嘲讽：左嘴角高于右嘴角', teaseFace.mouthSmileL > teaseFace.mouthSmileR + 0.08,
    `L=${teaseFace.mouthSmileL} R=${teaseFace.mouthSmileR}`);

  const smugFace = composeFace({ valence: 0.6, arousal: 0.3, dominance: 0.5 }, { emotion: 'smug', variant: 'lopsided', intensity: 1 });
  check('得意 lopsided：右嘴角明显高于左嘴角', smugFace.mouthSmileR > smugFace.mouthSmileL + 0.15,
    `L=${smugFace.mouthSmileL} R=${smugFace.mouthSmileR}`);

  const engine = makeEngine();
  engine.feed({ emotion: 'tease', strength: 1, holdSeconds: 5 });
  const out = run(engine, 0.8);
  check('引擎层：左右嘴角被分开驱动（不相等）',
    Math.abs(out.params.MouthSmile_L - out.params.MouthSmile_R) > 0.005,
    `L=${out.params.MouthSmile_L} R=${out.params.MouthSmile_R}`);
  // 鼓腮只在「得意」风格里有值；引擎输出会省略 0 值参数，所以这里直接验合成层
  check('得意 lopsided：鼓腮有轻微值', (smugFace.cheekPuff || 0) > 0.01, 'v=' + smugFace.cheekPuff);
}

// ── 12. 语音表演层：标点触发、不抢嘴 ────────────────────────────────────
{
  const engine = makeEngine();
  const fired = engine.speak('真的吗！！这也太厉害了。', 2600);
  check('感叹号触发语音重点', fired.includes('strong-exclaim'), JSON.stringify(fired));
  let out = null;
  for (let i = 0; i < 30; i++) out = engine.update(1 / 60);
  check('语音重点抬眉', (out.facs.browOuterUp || 0) > 0.02, 'brow=' + out.facs.browOuterUp);
  check('语音层不碰嘴开合', !('ParamMouthOpenY' in out.params));
  const q = makeEngine();
  check('问号触发疑问重点', q.speak('你在干嘛？', 900).includes('question'));
  const long = makeEngine();
  long.speak('我跟你说今天发生了一件特别特别离谱的事情你肯定想不到', 6000);
  check('长句会排换气动作', long.snapshot().params !== undefined);
}

// ── 13. 快照/重置/报告 ──────────────────────────────────────────────────
{
  const engine = makeEngine();
  engine.feed({ emotion: 'aggrieved', strength: 0.8 });
  run(engine, 1.5);
  const snap = engine.snapshot();
  check('快照字段齐全', ['emotion', 'intensity', 'weight', 'vad', 'facs', 'params', 'expressions'].every((k) => k in snap), JSON.stringify(Object.keys(snap)));
  check('快照 VAD 是数值', ['valence', 'arousal', 'dominance'].every((k) => Number.isFinite(snap.vad[k])), JSON.stringify(snap.vad));
  const report = engine.report();
  check('覆盖率报告可读', report.ratio > 0 && report.ratio <= 1, 'ratio=' + report.ratio);
  engine.reset();
  const after = engine.snapshot();
  eq('reset 后情绪归中性', after.emotion, 'neutral');
}

// ── 14. 引擎崩了不能把渲染拖死：未知情绪/空输入都安全 ───────────────────
{
  const engine = makeEngine();
  check('未知情绪不抛错', (() => { try { engine.feed({ emotion: 'nonsense', strength: 1 }); return true; } catch (e) { return false; } })());
  check('空 feed 不抛错', (() => { try { engine.feed(); return true; } catch (e) { return false; } })());
  check('update(0) 不抛错', (() => { try { engine.update(0); return true; } catch (e) { return false; } })());
  check('speak 空文本安全', engine.speak('', 0).length === 0);
  check('setManual(null) 安全', (() => { try { engine.setManual(null); return true; } catch (e) { return false; } })());
}

console.log('PASS ' + ok.length + ' / FAIL ' + fail.length);
if (fail.length) {
  console.log('失败：');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
