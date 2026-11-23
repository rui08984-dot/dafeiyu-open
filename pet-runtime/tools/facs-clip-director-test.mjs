// facs-clip-director-test.mjs —— 规则导演单测（2026-11-17 六十三轮）
//
// 钉住：① 六条「不演」的理由各自生效 ② 候选筛选（能量门/重复门/情绪映射）
//      ③ 选择顺序可复现 ④ 真索引下每种情绪都能选出强片段
//
// 用法：node pet-runtime/tools/facs-clip-director-test.mjs
// 退出码：0 全过 / 1 有失败

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClipDirector, normalizeEmotion, EMOTION_TO_LABELS, DIRECTOR_DEFAULTS,
} from '../desktop/perf/facs-clip-director.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLIPS = path.join(ROOT, 'pet-runtime', 'data', 'facs-clips');

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

// ── ① 情绪归一 ────────────────────────────────────────────────────────
{
  eq('中文情绪归一（害羞）', normalizeEmotion('害羞'), 'shy');
  eq('英文情绪直通（happy）', normalizeEmotion('happy'), 'happy');
  eq('大小写不敏感（Angry）', normalizeEmotion('Angry'), 'angry');
  eq('未知情绪兜底 neutral', normalizeEmotion('量子叠加态'), 'neutral');
  // perf/旧引擎的原型名必须认识（踩过：不认识 → 全归 neutral → 演「自然放松」）
  eq('原型名 soft-calm → neutral', normalizeEmotion('soft-calm'), 'neutral');
  eq('原型名 soft-low → sad', normalizeEmotion('soft-low'), 'sad');
  eq('原型名 soft-uneasy → sad', normalizeEmotion('soft-uneasy'), 'sad');
  eq('原型名 warm → happy', normalizeEmotion('warm'), 'happy');
  eq('原型名 curious → neutral', normalizeEmotion('curious'), 'neutral');
  eq('原型名 anxiety → sad', normalizeEmotion('anxiety'), 'sad');
  eq('中文 得意 → smug', normalizeEmotion('得意'), 'smug');
  ok('smug 有可用 label', (EMOTION_TO_LABELS.smug || []).length > 0);
  eq('空值兜底 neutral', normalizeEmotion(''), 'neutral');
  ok('六类情绪都有 label 映射', ['happy', 'playful', 'surprised', 'angry', 'sad', 'shy'].every((k) => (EMOTION_TO_LABELS[k] || []).length > 0));
}

// ── ② 合成索引：六条「不演」理由 ──────────────────────────────────────
{
  const mkIndex = () => ({
    clips: [
      { id: 'a', label: '微笑', energy: 300, durationMs: 3000 },
      { id: 'b', label: '微笑', energy: 200, durationMs: 3000 },
      { id: 'c', label: '微笑', energy: 60, durationMs: 3000 },   // 弱段
    ],
  });
  const d = createClipDirector(mkIndex(), { seed: 7 });
  const t0 = 1_000_000;

  eq('① 说话时不演', d.decide({ emotion: 'happy', intensity: 0.9, speaking: true, nowMs: t0 }).reason, 'speaking');
  eq('①b 全身长表演进行中不演（双写入者让位）', d.decide({ emotion: 'happy', intensity: 0.9, busy: true, nowMs: t0 }).reason, 'busy');
  eq('② 人不在不演', d.decide({ emotion: 'happy', intensity: 0.9, activity: 'away', nowMs: t0 }).reason, 'away');
  eq('③ 情绪太弱不演', d.decide({ emotion: 'happy', intensity: 0.1, nowMs: t0 }).reason, 'weak-emotion');

  const first = d.decide({ emotion: 'happy', intensity: 0.9, nowMs: t0 });
  eq('正常情况选出最强段', first.clipId, 'a');
  eq('reason 是 ok', first.reason, 'ok');
  ok('detail 带能量与时长', first.detail && first.detail.energy === 300 && first.detail.durationMs === 3000, JSON.stringify(first.detail));

  // ④ 冷却：同一个时刻再问 → cooldown
  d.notePlayed(first.clipId, t0);
  eq('④ 全局冷却内不演', d.decide({ emotion: 'happy', intensity: 0.9, nowMs: t0 + 1000 }).reason, 'cooldown');

  // 冷却过后：同段还没解除，应挑 b
  const second = d.decide({ emotion: 'happy', intensity: 0.9, nowMs: t0 + DIRECTOR_DEFAULTS.gapMs + 1 });
  eq('冷却后避开刚播过的段（a→b）', second.clipId, 'b');
  d.notePlayed(second.clipId, t0 + DIRECTOR_DEFAULTS.gapMs + 1);

  // 只剩弱段可用 → no-candidate（能量门把它挡了）
  const third = d.decide({ emotion: 'happy', intensity: 0.9, nowMs: t0 + DIRECTOR_DEFAULTS.gapMs * 2 + 2 });
  eq('⑤ 两个强段都在同段冷却里 → 无候选（弱段不许凑数）', third.reason, 'no-candidate');
  ok('no-candidate 里带情绪与候选 label', third.detail && third.detail.emotion === 'happy', JSON.stringify(third.detail));
}

// ── ③ 10 分钟上限 ─────────────────────────────────────────────────────
{
  const clips = Array.from({ length: 8 }, (_, i) => ({ id: 'c' + i, label: '微笑', energy: 300, durationMs: 2000 }));
  const d = createClipDirector({ clips }, { seed: 1 });
  let now = 5_000_000;
  let played = 0;
  for (let i = 0; i < 8; i += 1) {
    const r = d.decide({ emotion: 'happy', intensity: 0.9, nowMs: now });
    if (r.clipId) { d.notePlayed(r.clipId, now); played += 1; }
    else if (r.reason === 'max-per-10min') break;
    now += DIRECTOR_DEFAULTS.gapMs + 10;
  }
  eq('⑥ 10 分钟内最多演 maxPer10Min 次', played, DIRECTOR_DEFAULTS.maxPer10Min);
}

// ── ④ 可复现性 ────────────────────────────────────────────────────────
{
  const mk = () => createClipDirector({ clips: [
    { id: 'x1', label: '微笑', energy: 300, durationMs: 1000 },
    { id: 'x2', label: '微笑', energy: 300, durationMs: 1000 },
  ] }, { seed: 42 });
  const a = mk().decide({ emotion: 'happy', intensity: 0.9, nowMs: 1 }).clipId;
  const b = mk().decide({ emotion: 'happy', intensity: 0.9, nowMs: 1 }).clipId;
  eq('同 seed 同输入 → 同选择', a, b);
}

// ── ⑤ 真索引：每种情绪都能选出强片段 ──────────────────────────────────
{
  const indexPath = path.join(CLIPS, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.log('  ⚠ 缺 ' + indexPath + '，跳过真索引断言（先跑 import-lumenact.mjs）');
  } else {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const emotion of ['happy', 'playful', 'surprised', 'angry', 'sad', 'shy', 'neutral']) {
      const d = createClipDirector(index, { seed: 3 });
      const r = d.decide({ emotion, intensity: 0.8, nowMs: 1_700_000_000_000 });
      ok('真索引：' + emotion + ' 能选出片段', Boolean(r.clipId), r.reason + ' ' + JSON.stringify(r.detail));
      if (r.clipId) {
        const clip = index.clips.find((c) => c.id === r.clipId);
        ok('真索引：' + emotion + ' 选中的段 energy ≥ ' + DIRECTOR_DEFAULTS.minEnergy,
          (clip.energy || 0) >= DIRECTOR_DEFAULTS.minEnergy, 'energy=' + clip.energy);
        ok('真索引：' + emotion + ' 选中的段 label 在该情绪的候选里',
          (EMOTION_TO_LABELS[emotion] || []).includes(clip.label), clip.label);
      }
    }
    // 弱段永不被选（clip 0 的 energy 只有 26）
    const weak = index.clips.filter((c) => (c.energy || 0) < DIRECTOR_DEFAULTS.minEnergy);
    const d = createClipDirector(index, { seed: 5 });
    let pickedWeak = 0;
    for (const emotion of ['happy', 'playful', 'surprised', 'angry', 'sad', 'shy', 'neutral']) {
      const r = d.decide({ emotion, intensity: 0.9, nowMs: 1 });
      if (r.clipId && weak.some((w) => w.id === r.clipId)) pickedWeak += 1;
    }
    eq('弱段（energy < 阈值）一次都不会被选中', pickedWeak, 0);
    ok('真索引里确实存在弱段（否则这条断言没意义）', weak.length > 0, 'weak=' + weak.length);
  }
}

// ── ⑥ 候选诊断接口 ────────────────────────────────────────────────────
{
  const d = createClipDirector({ clips: [{ id: 'z', label: '害羞', energy: 400, durationMs: 1000 }] });
  const cands = d.candidates('shy');
  ok('candidates 返回该情绪的 label 组', Array.isArray(cands) && cands.length > 0 && cands[0].label === '害羞', JSON.stringify(cands));
  ok('candidates 带每段的 energy', cands[0].clips[0].energy === 400);
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 片段导演：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
