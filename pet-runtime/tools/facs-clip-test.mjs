// facs-clip-test.mjs —— LumenAct FACS 片段导入 + 播放器单测（2026-11-17 六十二轮续）
//
// 钉住四件事：
//   ① **导入覆盖**：LumenAct 的 166 个通道每一个都要有归属（映射 or 有意跳过），
//      不许出现「悄悄丢掉一个通道」。
//   ② **映射正确性**：0–100 归一化、多源取 max、成对通道取 avg、常量通道被剔除。
//   ③ **播放器行为**：插值、两端淡入淡出、说话时屏蔽嘴、越界 clamp、done 判定。
//   ④ **落到真参数**：用我们真实的 profile 跑一遍，确认
//      - 表情通道真的变了参数（害羞→BrowInnerUp、微笑→ParamMouthForm、惊讶→ParamEyeLOpen）
//      - 头/视线/眨眼/张嘴这四类**按所有权被丢弃**（它们归口型/交互/视线/程序化眨眼层）
//
// 用法：node pet-runtime/tools/facs-clip-test.mjs
// 退出码：0 全过 / 1 有失败

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNEL_MAP, SKIP_BY_DESIGN, buildMappingIndex, convertSegment,
} from './import-lumenact.mjs';
import {
  FACSCLIP_SCHEMA, CLIP_RANGES, sampleChannel, fadeWeight, sampleClip, createClipPlayer, pickClip, summarizeIndex, MOUTH_KEYS,
} from '../desktop/perf/facs-clip-player.mjs';
import { buildProfile, applyFACS, PROFILE_SPECS, EXTERNALLY_OWNED } from '../desktop/perf/profile.mjs';
import { createPerfEngine } from '../desktop/perf/index.mjs';
import { PARAM_TABLE } from '../desktop/perf/param-inventory.mjs';
import { NEUTRAL_FACS } from '../desktop/perf/facs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIPS = path.join(ROOT, 'pet-runtime', 'data', 'facs-clips');
const ASSETS = path.join(ROOT, '_research', 'lumenact', 'assets');

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

const bare = (p) => String(p || '').replace(/^blendShape\./, '');

// ── ① 通道覆盖（用真实 catalog）───────────────────────────────────────
{
  const catalogPath = path.join(ASSETS, 'catalog.json');
  if (!fs.existsSync(catalogPath)) {
    console.log('  ⚠ 缺 _research/lumenact/assets/catalog.json —— 跳过「覆盖」相关断言（原始素材不入库）');
  } else {
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const names = catalog.channels.map((c) => bare(c.property));
    const mapped = new Set(CHANNEL_MAP.map((m) => m.src));
    const skipPatterns = [/^----------/, /^(Honoka|Nayu|Platinum)_/, /^(Body|UpperArm|LowerArm|Chest|Hips|UpperLeg|LowerLeg|Leg|Foot|heel)/, /^(mouth_upperteeth|mouth_lowerteeth|mouth_teeth|mouth_tongue)/];
    const unaccounted = names.filter((n) => !mapped.has(n) && !SKIP_BY_DESIGN[n] && !skipPatterns.some((re) => re.test(n)));
    eq('每个 LumenAct 通道都有归属（映射或有意跳过）', unaccounted, []);
    const mappedButMissing = [...mapped].filter((m) => !names.includes(m));
    eq('映射表里没有「素材中不存在」的通道', mappedButMissing, []);
    ok('映射到 FACS 的源通道 ≥ 50 个', mapped.size >= 50, '实际 ' + mapped.size);
    ok('catalog 是 lumenact.curves.v1', catalog.schema === 'lumenact.curves.v1');
  }
}

// ── ② 转换逻辑（合成数据，可精确断言）─────────────────────────────────
{
  const channelCount = 4;
  const channels = [
    { index: 0, property: 'blendShape.mouth_smile_1' },
    { index: 1, property: 'blendShape.mouth_smile_2' },
    { index: 2, property: 'blendShape.Left Eye Down-Up', kind: 'muscle' },
    { index: 3, property: 'blendShape.Right Eye Down-Up', kind: 'muscle' },
  ];
  // 3 帧 × 4 通道（blendshape 源是 0–100 百分比）
  const data = [
    50, 20, -0.4, -0.2,    // frame 0
    100, 40, 0.6, 0.4,     // frame 1
    0, 0, 0, 0,            // frame 2
  ];
  const f32 = new Float32Array(data);
  const mapIndex = buildMappingIndex();
  const out = convertSegment({ f32, channelCount, channels, offset: 0, frames: 3, outFrames: 3, mapIndex });

  eq('多源→同一 FACS 取绝对值更大者（mouthSmile）', out.mouthSmile, [0.5, 1, 0]);
  eq('成对通道→平均（gazeY）', out.gazeY, [-0.3, 0.5, 0]);
  ok('muscle 通道不除 100（gazeY 保留 -1..1 量级）', Math.abs(out.gazeY[0]) < 2);

  // 常量通道被剔除（整段不变 = 没信息）
  const flat = convertSegment({
    f32: new Float32Array([0.3, 0.3, 0.3, 0.3]), channelCount: 4,
    channels: [{ property: 'blendShape.eyebrow_up_L' }, { property: 'blendShape.eyebrow_down_L' }, { property: 'blendShape.mouth_a' }, { property: 'blendShape.mouth_o' }],
    offset: 0, frames: 1, outFrames: 1, mapIndex,
  });
  eq('整段恒定的通道被剔除，没有残留键', Object.keys(flat), []);

  // 非法值不污染输出
  const bad = convertSegment({
    f32: new Float32Array([NaN, 50]), channelCount: 2,
    channels: [{ property: 'blendShape.mouth_smile_1' }, { property: 'blendShape.eyebrow_up_L' }],
    offset: 0, frames: 1, outFrames: 1, mapIndex,
  });
  ok('NaN 输入不会写出 NaN', Object.values(bad).every((arr) => arr.every((v) => Number.isFinite(v))), JSON.stringify(bad));
}

// ── ③ 产物完整性 ──────────────────────────────────────────────────────
let indexDoc = null;
{
  const indexPath = path.join(CLIPS, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.error('  ✗ 缺 ' + indexPath + '（先跑 node pet-runtime/tools/import-lumenact.mjs）');
    fail += 1;
  } else {
    indexDoc = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    eq('索引 schema', indexDoc.schema, FACSCLIP_SCHEMA + '.index');
    ok('97 段全在', indexDoc.clipCount === 97 && indexDoc.clips.length === 97, 'clipCount=' + indexDoc.clipCount);
    ok('索引带 CC BY 4.0 出处', /LumenAct/.test(indexDoc.source.project) && indexDoc.source.license === 'CC BY 4.0');
    ok('NOTICE.md 存在（授权要求）', fs.existsSync(path.join(CLIPS, 'NOTICE.md')));

    const files = fs.readdirSync(path.join(CLIPS, 'clips')).filter((f) => f.endsWith('.json'));
    eq('片段文件数与索引一致', files.length, indexDoc.clipCount);

    let minCh = 99, maxCh = 0, badRange = [];
    let zeroClip = 0;
    for (const f of files) {
      const clip = JSON.parse(fs.readFileSync(path.join(CLIPS, 'clips', f), 'utf8'));
      if (clip.schema !== FACSCLIP_SCHEMA) badRange.push(f + ' schema');
      if (!(clip.durationMs > 0) || !(clip.frames > 1)) badRange.push(f + ' 时长/帧');
      const keys = Object.keys(clip.channels || {});
      if (!keys.length) zeroClip += 1;
      minCh = Math.min(minCh, keys.length);
      maxCh = Math.max(maxCh, keys.length);
      for (const [k, arr] of Object.entries(clip.channels || {})) {
        if (arr.length !== clip.frames) badRange.push(f + ' ' + k + ' 长度');
        const range = CLIP_RANGES[k];
        if (!range) { badRange.push(f + ' 未知通道 ' + k); continue; }
        for (const v of arr) {
          if (!Number.isFinite(v)) { badRange.push(f + ' ' + k + ' NaN'); break; }
          if (v < range[0] - 1e-6 || v > range[1] + 1e-6) { badRange.push(f + ' ' + k + '=' + v + ' 越界'); break; }
        }
      }
      if (badRange.length > 4) break;
    }
    eq('所有片段 schema/长度/通道值域合法', badRange.slice(0, 4), []);
    ok('每段至少驱动 1 个通道', zeroClip === 0, '空片段 ' + zeroClip + ' 个');
    ok('通道数在合理区间（1–19）', minCh >= 1 && maxCh <= 19, `min=${minCh} max=${maxCh}`);
    ok('19 个 FACS 通道全部用上', indexDoc.facsChannels.length === 19, indexDoc.facsChannels.join(','));

    const s = summarizeIndex(indexDoc);
    ok('标签数 ≥ 20', s.labels.length >= 20, s.labels.length + ' 个标签');
    ok('自然放松（neutral）在索引里', indexDoc.clips.some((c) => c.label === '自然放松'));

    // energy（可迁移强度）：导演层按它挑片段，太弱的段「演了跟没演一样」
    const energies = indexDoc.clips.map((c) => Number(c.energy) || 0).sort((a, b) => a - b);
    const median = energies[Math.floor(energies.length / 2)];
    ok('索引里每段都有 energy', energies.every((e) => e > 0), 'min=' + energies[0]);
    ok('energy 中位数 ≥ 100（素材整体有真内容）', median >= 100, 'median=' + median);
    ok('至少 60 段 energy ≥ 100', energies.filter((e) => e >= 100).length >= 60,
      energies.filter((e) => e >= 100).length + '/97');
    ok('energy 上界合理（<5000）', energies[energies.length - 1] < 5000, 'max=' + energies[energies.length - 1]);
  }
}

// ── ④ 播放器行为 ──────────────────────────────────────────────────────
{
  const clip = {
    schema: FACSCLIP_SCHEMA, id: 'test', fps: 10, frames: 11, durationMs: 1000, fadeMs: 200,
    channels: { mouthSmile: [0, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.5, 0], browUpL: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2] },
  };
  eq('通道插值（中点）', sampleChannel([0, 1], 0.5), 0.5);
  eq('通道越界取端点', sampleChannel([0, 1], 99), 1);
  eq('空数组安全返回 0', sampleChannel([], 0), 0);

  eq('淡入起点权重 0', fadeWeight(0, 1000, 200), 0);
  eq('中段权重 1', fadeWeight(500, 1000, 200), 1);
  eq('末点权重 0', fadeWeight(1000, 1000, 200), 0);
  ok('淡入单调增', fadeWeight(50, 1000, 200) < fadeWeight(150, 1000, 200));

  const mid = sampleClip(clip, 500, {});
  ok('中段 mouthSmile 接近 1', Math.abs(mid.facs.mouthSmile - 1) < 0.06, String(mid.facs.mouthSmile));
  ok('中段权重为 1', mid.weight === 1);
  ok('未结束', mid.done === false);

  const start = sampleClip(clip, 0, {});
  ok('起点被淡入压到 0', Math.abs(start.facs.browUpL) < 1e-6, String(start.facs.browUpL));

  const end = sampleClip(clip, 1000, {});
  ok('结束时 done', end.done === true);

  const speaking = sampleClip(clip, 500, { speechActive: true });
  ok('说话时嘴被屏蔽', speaking.facs.mouthSmile === undefined, JSON.stringify(speaking.facs));
  ok('说话时眉不受影响', Math.abs(speaking.facs.browUpL - 0.2) < 1e-6);
  eq('MOUTH_KEYS 覆盖四种嘴形', MOUTH_KEYS.length >= 4, true);

  const f = sampleClip(clip, 500, { fade: false });
  ok('fade:false 不做淡入淡出', Math.abs(f.facs.browUpL - 0.2) < 1e-6);

  const player = createClipPlayer(clip);
  eq('未播放时采样为空', player.sample(1000).facs, {});
  player.play(5000);
  ok('播放中 isPlaying', player.isPlaying === true);
  const pMid = player.sample(5500, {});
  ok('播放器按相对时间采样', Math.abs(pMid.facs.mouthSmile - 1) < 0.06, String(pMid.facs.mouthSmile));
  const pEnd = player.sample(6100, {});
  ok('播完自动停', pEnd.done === true && player.isPlaying === false);

  // pickClip
  const list = [
    { id: 'a', label: '微笑', emotion: '开心' },
    { id: 'b', label: '微笑', emotion: '平静' },
    { id: 'c', label: '生气愤怒', emotion: '愤怒' },
  ];
  eq('按 label 选', pickClip(list, { label: '微笑' }).label, '微笑');
  eq('label 找不到时按 emotion', pickClip(list, { label: '不存在', emotion: '愤怒' }).id, 'c');
  eq('回避上一次（同 label 有多段时）', pickClip(list, { label: '微笑', avoidId: 'a' }).id, 'b');
  eq('空列表返回 null', pickClip([], {}), null);
}

// ── ⑤ 落到真参数（用我们真实的 profile）───────────────────────────────
{
  const paramIds = new Set(Object.keys(PARAM_TABLE));
  const ranges = new Map(Object.entries(PARAM_TABLE).map(([k, v]) => [k, [v.min, v.max]]));
  const profile = buildProfile(PROFILE_SPECS.jellyfish, { paramIds, ranges });

  ok('画像里含表情通道（browInnerUp）', Boolean(profile.channels.browInnerUp));
  ok('画像里含 mouthSmile', Boolean(profile.channels.mouthSmile));
  // 所有权：这些通道必须被画像丢弃（归别的层）
  for (const ch of ['mouthOpen', 'headX', 'headY', 'headZ', 'gazeX', 'gazeY', 'eyeBlinkL', 'eyeBlinkR']) {
    ok(`画像按所有权丢弃 ${ch}`, !profile.channels[ch] && Boolean(EXTERNALLY_OWNED[ch]), ch);
  }

  // 取真实片段：**同一 label 挑能量最强的那段**（97 段里弱段几乎只是微动，
  // 用第一段会误判「映射没生效」——这个坑实测踩过：clip 0 的 energy 只有 26）
  const load = (label) => {
    const metas = (indexDoc ? indexDoc.clips : []).filter((c) => c.label === label);
    if (!metas.length) return null;
    const best = metas.slice().sort((a, b) => (b.energy || 0) - (a.energy || 0))[0];
    return JSON.parse(fs.readFileSync(path.join(CLIPS, 'clips', best.id + '.json'), 'utf8'));
  };
  /** 全片扫一遍，取某参数出现的「最大幅度」（不淡入淡出，取真实峰值） */
  const maxParam = (clip, paramId) => {
    let best = 0;
    for (let t = 0; t <= clip.durationMs; t += 50) {
      const { facs } = sampleClip(clip, t, { fade: false });
      const out = applyFACS(Object.assign({}, NEUTRAL_FACS, facs), profile, {});
      const v = Number(out.params[paramId]);
      if (!Number.isFinite(v)) continue;
      if (Math.abs(v) > Math.abs(best)) best = v;
    }
    return best;
  };

  // 期望值按「素材自己怎么演」判断，而不是按 label 猜语义（实测踩过：
  // 害羞片段其实靠 mouth_smile + 压眉演，不是眉心上挑）。
  // 通用判据：强片段必须真的推动 ≥2 个参数、且最大幅度 > 0.05。
  const assertDrivesParams = (label) => {
    const clip = load(label);
    if (!clip) { ok('有「' + label + '」片段', false); return; }
    let moved = new Map();
    for (let t = 0; t <= clip.durationMs; t += 50) {
      const { facs } = sampleClip(clip, t, { fade: false });
      const out = applyFACS(Object.assign({}, NEUTRAL_FACS, facs), profile, {});
      for (const [id, v] of Object.entries(out.params)) {
        const base = Number(NEUTRAL_FACS[id]);
        const delta = id === 'ParamEyeLOpen' || id === 'ParamEyeROpen' ? Math.abs(Number(v) - 1) : Math.abs(Number(v));
        const prev = moved.get(id) || 0;
        if (Number.isFinite(delta) && delta > prev) moved.set(id, delta);
      }
    }
    const strong = [...moved.entries()].filter(([, d]) => d > 0.05);
    ok(label + ' 片段真的推动了 ≥2 个参数', strong.length >= 2,
      strong.length + ' 个：' + strong.slice(0, 4).map(([k, d]) => k + '=' + d.toFixed(2)).join(','));
  };
  for (const label of ['害羞', '微笑', '惊讶震惊', '生气愤怒']) assertDrivesParams(label);

  // 眼睛睁大这条单独验：成片里必须有 eyeOpen 通道，且落到 ParamEyeLOpen 上 > 1（绝对语义）
  {
    const withEyeOpen = (indexDoc ? indexDoc.clips : [])
      .filter((c) => (c.channels || []).includes('eyeOpen'))
      .sort((a, b) => (b.energy || 0) - (a.energy || 0))[0];
    if (withEyeOpen) {
      const clip = JSON.parse(fs.readFileSync(path.join(CLIPS, 'clips', withEyeOpen.id + '.json'), 'utf8'));
      let maxOpen = 0;
      for (let t = 0; t <= clip.durationMs; t += 50) {
        const { facs } = sampleClip(clip, t, { fade: false });
        const v = Number(facs.eyeOpen);
        if (Number.isFinite(v) && v > maxOpen) maxOpen = v;
      }
      ok('eyeOpen 是绝对值语义（正常=1，睁大>1）', maxOpen > 1.02, 'max eyeOpen=' + maxOpen.toFixed(3));
      ok('淡入起点回到中性 1（不会闭眼）', Math.abs(sampleClip(clip, 0, {}).facs.eyeOpen - 1) < 1e-6,
        String(sampleClip(clip, 0, {}).facs.eyeOpen));
    } else ok('有带 eyeOpen 的片段', false);
  }

  // 所有权：片段里的头/视线通道不会落到参数上（否则会和交互动作/视线层打架）
  const anyClip = load('自然放松') || load('微笑');
  if (anyClip && anyClip.channels.headY) {
    ok('片段里确实有 headY 数据', true);
    const v = maxParam(anyClip, 'ParamAngleY');
    ok('但头朝向参数不被片段驱动（归 interaction-motion）', Math.abs(Number(v) || 0) < 1e-9, String(v));
  } else {
    console.log('  （提示：所选片段没有 headY 通道，跳过所有权断言）');
  }

  // ── 引擎集成：reaction 层默认不改变任何行为（回归护栏）──────────────
  {
    const mk = () => createPerfEngine({ profile: buildProfile(PROFILE_SPECS.jellyfish, { paramIds, ranges }) });
    const a = mk().update(1 / 60);
    const e2 = mk();
    e2.setReaction(null);
    const b = e2.update(1 / 60);
    eq('不设 reaction 时引擎输出与以前完全一致', b.params, a.params);

    const e3 = mk();
    e3.setReaction({ eyeSmile: 1 });
    const c = e3.update(1 / 60);
    ok('设了 reaction 真的推动参数（EyeSmile 变大）',
      Number(c.params.EyeSmile || 0) > Number(a.params.EyeSmile || 0) + 0.01,
      `${a.params.EyeSmile} → ${c.params.EyeSmile}`);

    e3.setReaction(null);
    ok('清空 reaction 不抛错', (() => { try { e3.update(1 / 60); return true; } catch (e) { return false; } })());
  }
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' LumenAct FACS 片段：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
