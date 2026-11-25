#!/usr/bin/env node
/**
 * _probe/test-perf-ambient-apply.cjs —— 待机层偏置「真正落到参数」（2026-11-25 P1.5）
 *
 * 钉住的是换算契约，不是观感：
 *   ① amb 为空/全 0 → 9 个输出逐值 `===` base（不是「差不多」）；
 *   ② 每个系数的方向与满量程：headX/headY ±3.0°、headZ ±1.5°、breath ±0.12、
 *      bodyZ ±2.0°、gaze ±0.15、posX ±0.02；
 *   ③ 归一化：bias/满量程（biasAt 在 amp=1 的常量），过冲钳到 [-1,1]；
 *   ④ 钳位：ParamAngle* ±30、ParamBreath [0,1]、ParamBodyAngleZ ±10、ParamEyeBall ±1；
 *   ⑤ speaking 时 head/gaze 系数减半，breath/bodyZ/pos 不变；
 *   ⑥ 真实 bias（amp=0.3）归一化后幅度非 0（证明「接了线真的会动」，不是 0.018°）；
 *   ⑦ 接线：渲染器在 PROC_MOTION 单写里用 applyAmbientOffsets，entry 推 setAmbientOffset，
 *      perf 的 idle 层不再写外部通道。
 *
 * 用法：node _probe/test-perf-ambient-apply.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail !== undefined ? ' —— ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) { pass += 1; return; }
  fail += 1;
  console.error('  ✗ ' + name + ' —— got ' + a + ' want ' + b);
}
function near(name, got, want, eps) {
  ok(name, Number.isFinite(got) && Math.abs(got - want) <= eps, `${got} vs ${want} ±${eps}`);
}

const DESKTOP = path.join(__dirname, '..', 'pet-runtime', 'desktop');
const file = (p) => pathToFileURL(path.join(DESKTOP, p)).href;
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');

const BASE = Object.freeze({
  breath: 0.5,
  bodyZ: 1.1,
  headX: 2.4,
  headY: -1.3,
  headZ: -2.2,
  gazeX: 0.2,
  gazeY: -0.1,
  posX: 0.45,
  posZ: 0,
});

(async () => {
  const M = await import(file('perf/ambient-apply.mjs'));
  const { applyAmbientOffsets, ambientOffsets, normalizeAmbientBias, AMBIENT_APPLY_DEFAULTS, AMBIENT_BIAS_FULL_SCALE } = M;

  // ── ① 零偏置逐值 === base ────────────────────────────────────────────
  for (const [label, amb] of [
    ['null', null],
    ['undefined', undefined],
    ['{}', {}],
    ['全 0 字段', { headYaw: 0, headPitch: 0, breath: 0, gazeX: 0, gazeY: 0, posture: 0 }],
  ]) {
    const out = applyAmbientOffsets(BASE, amb);
    let same = true;
    for (const key of Object.keys(BASE)) if (out[key] !== BASE[key]) same = false;
    ok('零偏置（' + label + '）9 个输出逐值 === base', same, JSON.stringify(out));
  }
  {
    // 贴边/越界的 base 也不该被「顺手钳一下」——零偏置的契约是原样
    const edge = Object.assign({}, BASE, { headX: 31, breath: 1.4 });
    const out = applyAmbientOffsets(edge, { headYaw: 0, breath: 0 });
    ok('零偏置不钳越界 base（headX 31 原样返回）', out.headX === 31, String(out.headX));
    ok('零偏置不钳越界 base（breath 1.4 原样返回）', out.breath === 1.4, String(out.breath));
  }

  // ── ② 系数方向与满量程 ───────────────────────────────────────────────
  eq('默认系数（° / 无量纲）', {
    headYawDeg: AMBIENT_APPLY_DEFAULTS.headYawDeg,
    headPitchDeg: AMBIENT_APPLY_DEFAULTS.headPitchDeg,
    headRollDeg: AMBIENT_APPLY_DEFAULTS.headRollDeg,
    breath: AMBIENT_APPLY_DEFAULTS.breath,
    bodyZDeg: AMBIENT_APPLY_DEFAULTS.bodyZDeg,
    gaze: AMBIENT_APPLY_DEFAULTS.gaze,
    pos: AMBIENT_APPLY_DEFAULTS.pos,
  }, { headYawDeg: 3, headPitchDeg: 3, headRollDeg: 1.5, breath: 0.12, bodyZDeg: 2, gaze: 0.15, pos: 0.02 });
  {
    const d = ambientOffsets({ headYaw: 1, headPitch: -1, breath: 1, gazeX: 1, gazeY: -1, posture: 1 });
    eq('ambientOffsets 键集合（9 通道）', Object.keys(d).sort(), ['bodyZ', 'breath', 'gazeX', 'gazeY', 'headX', 'headY', 'headZ', 'posX', 'posZ']);
    near('headYaw=1 → headX +3.0°', d.headX, 3.0, 1e-9);
    near('headPitch=-1 → headY -3.0°', d.headY, -3.0, 1e-9);
    near('posture=1 → headZ roll +1.5°', d.headZ, 1.5, 1e-9);
    near('breath=1 → +0.12', d.breath, 0.12, 1e-9);
    near('posture=1 → bodyZ +2.0°', d.bodyZ, 2.0, 1e-9);
    near('gazeX=1 → +0.15', d.gazeX, 0.15, 1e-9);
    near('gazeY=-1 → -0.15', d.gazeY, -0.15, 1e-9);
    near('posture=1 → posX +0.02', d.posX, 0.02, 1e-9);
    eq('posZ 暂无源（恒 0，占位契约）', d.posZ, 0);
  }
  {
    const out = applyAmbientOffsets(BASE, { headYaw: 1, headPitch: 1, posture: 1, breath: 1, gazeX: 1, gazeY: 1 });
    near('headX = base + 3.0', out.headX, BASE.headX + 3.0, 1e-9);
    near('headY = base + 3.0', out.headY, BASE.headY + 3.0, 1e-9);
    near('headZ = base + 1.5', out.headZ, BASE.headZ + 1.5, 1e-9);
    near('breath = base + 0.12', out.breath, BASE.breath + 0.12, 1e-9);
    near('bodyZ = base + 2.0', out.bodyZ, BASE.bodyZ + 2.0, 1e-9);
    near('posX = base + 0.02', out.posX, BASE.posX + 0.02, 1e-9);
    near('gazeX = base + 0.15', out.gazeX, BASE.gazeX + 0.15, 1e-9);
    near('gazeY = base + 0.15', out.gazeY, BASE.gazeY + 0.15, 1e-9);
  }

  // ── ③ 归一化（bias → [-1,1]）─────────────────────────────────────────
  {
    const n = normalizeAmbientBias({ headYaw: AMBIENT_BIAS_FULL_SCALE.headYaw, headPitch: AMBIENT_BIAS_FULL_SCALE.headPitch / 2 });
    near('满量程 headYaw → 1', n.headYaw, 1, 1e-9);
    near('半量程 headPitch → 0.5', n.headPitch, 0.5, 1e-9);
    eq('缺字段按 0', [n.breath, n.gazeX, n.gazeY, n.posture], [0, 0, 0, 0]);
    eq('过冲钳到 1', normalizeAmbientBias({ headYaw: 10 }).headYaw, 1);
    eq('反向过冲钳到 -1', normalizeAmbientBias({ gazeY: -10 }).gazeY, -1);
    eq('null → 全 0', normalizeAmbientBias(null), { headYaw: 0, headPitch: 0, breath: 0, gazeX: 0, gazeY: 0, posture: 0 });
    near('breath 满量程 = 0.04π', AMBIENT_BIAS_FULL_SCALE.breath, 0.04 * Math.PI, 1e-12);
  }
  {
    // 真实链路：ambient.biasAt(amp=0.3) → 归一化 → 偏置幅度非 0 且 ≤ 满量程
    const A = await import(file('perf/ambient.mjs'));
    let maxYaw = 0;
    let maxBreath = 0;
    let maxPosture = 0;
    let ampViolations = 0;
    for (let t = 0; t < 20000; t += 137) {
      const b = A.biasAt('quiet', t, 0.3);
      const n = normalizeAmbientBias(b);
      const d = ambientOffsets(n);
      maxYaw = Math.max(maxYaw, Math.abs(d.headX));
      maxBreath = Math.max(maxBreath, Math.abs(d.breath));
      maxPosture = Math.max(maxPosture, Math.abs(d.bodyZ));
      if (Math.abs(n.headYaw) > 0.3 + 1e-9) ampViolations += 1;
    }
    eq('归一化幅度从不超过 amp（0.3）', ampViolations, 0);
    ok('amp=0.3 时头偏置可见（>0.1°，不是 0.018°）', maxYaw > 0.1, String(maxYaw));
    ok('amp=0.3 时头偏置不超 3.0°×0.3', maxYaw <= 0.9 + 1e-6, String(maxYaw));
    ok('amp=0.3 时呼吸偏置非 0', maxBreath > 0.005, String(maxBreath));
    ok('amp=0.3 时姿态偏置非 0', maxPosture > 0.05, String(maxPosture));
  }

  // ── ④ 钳位 ───────────────────────────────────────────────────────────
  {
    const hi = applyAmbientOffsets(Object.assign({}, BASE, { headX: 29.5, headY: 29.5, headZ: 29.5, breath: 0.95, bodyZ: 9.5, gazeX: 0.95, gazeY: 0.95 }),
      { headYaw: 1, headPitch: 1, posture: 1, breath: 1, gazeX: 1, gazeY: 1 });
    eq('ParamAngle* 上钳 30', [hi.headX, hi.headY, hi.headZ], [30, 30, 30]);
    eq('ParamBreath 上钳 1', hi.breath, 1);
    eq('ParamBodyAngleZ 上钳 10', hi.bodyZ, 10);
    eq('ParamEyeBall 上钳 1', [hi.gazeX, hi.gazeY], [1, 1]);
    const lo = applyAmbientOffsets(Object.assign({}, BASE, { headX: -29.5, headY: -29.5, headZ: -29.5, breath: 0.05, bodyZ: -9.5, gazeX: -0.95, gazeY: -0.95 }),
      { headYaw: -1, headPitch: -1, posture: -1, breath: -1, gazeX: -1, gazeY: -1 });
    eq('ParamAngle* 下钳 -30', [lo.headX, lo.headY, lo.headZ], [-30, -30, -30]);
    eq('ParamBreath 下钳 0', lo.breath, 0);
    eq('ParamBodyAngleZ 下钳 -10', lo.bodyZ, -10);
    eq('ParamEyeBall 下钳 -1', [lo.gazeX, lo.gazeY], [-1, -1]);
    const pos = applyAmbientOffsets(Object.assign({}, BASE, { posX: 5 }), { posture: 1 });
    near('Position 不钳（posX 5 + 0.02）', pos.posX, 5.02, 1e-9);
  }

  // ── ⑤ speaking：head/gaze 减半，breath/bodyZ/pos 不变 ────────────────
  {
    const amb = { headYaw: 1, headPitch: 1, posture: 1, breath: 1, gazeX: 1, gazeY: 1 };
    const idle = applyAmbientOffsets(BASE, amb, { speaking: false });
    const talk = applyAmbientOffsets(BASE, amb, { speaking: true });
    near('speaking headX 减半', talk.headX - BASE.headX, (idle.headX - BASE.headX) / 2, 1e-9);
    near('speaking headY 减半', talk.headY - BASE.headY, (idle.headY - BASE.headY) / 2, 1e-9);
    near('speaking headZ 减半', talk.headZ - BASE.headZ, (idle.headZ - BASE.headZ) / 2, 1e-9);
    near('speaking gazeX 减半', talk.gazeX - BASE.gazeX, (idle.gazeX - BASE.gazeX) / 2, 1e-9);
    near('speaking gazeY 减半', talk.gazeY - BASE.gazeY, (idle.gazeY - BASE.gazeY) / 2, 1e-9);
    eq('speaking 时 breath 不变', talk.breath, idle.breath);
    eq('speaking 时 bodyZ 不变', talk.bodyZ, idle.bodyZ);
    eq('speaking 时 posX 不变', talk.posX, idle.posX);
    const zeroTalk = applyAmbientOffsets(BASE, null, { speaking: true });
    ok('speaking + 零偏置仍逐值 === base', Object.keys(BASE).every((k) => zeroTalk[k] === BASE[k]));
  }
  {
    // 系数可配置
    const custom = applyAmbientOffsets(BASE, { headYaw: 1, breath: 1 }, { coeffs: { headYawDeg: 10, breath: 0.02 } });
    near('coeffs 覆盖 headYawDeg', custom.headX, BASE.headX + 10, 1e-9);
    near('coeffs 覆盖 breath', custom.breath, BASE.breath + 0.02, 1e-9);
    eq('未覆盖的系数保持默认（posture→bodyZ）', applyAmbientOffsets(BASE, { posture: 1 }, { coeffs: { headYawDeg: 10 } }).bodyZ, BASE.bodyZ + 2);
  }

  // ── ⑥ 接线（源码级）：同一次写、不新增写者 ───────────────────────────
  {
    const renderer = read('cubism-renderer.mjs');
    const entry = read('petbody-entry.mjs');
    const perfIndex = read('perf/index.mjs');
    ok('渲染器导入 applyAmbientOffsets/ambientOffsets/normalizeAmbientBias',
      /import \{ applyAmbientOffsets, ambientOffsets, normalizeAmbientBias \} from '\.\/perf\/ambient-apply\.mjs'/.test(renderer));
    ok('渲染器有 setAmbientOffset（默认 null）', /this\._ambientOffset = null/.test(renderer) && /setAmbientOffset\(amb\) \{/.test(renderer));
    ok('偏置在 PROC_MOTION 写入前统一计算（ambBase）', /const ambBase = \{[\s\S]{0,600}applyAmbientOffsets\(ambBase/.test(renderer));
    eq('ParamBreath 每帧只 set 一次（无新增写者）', (renderer.match(/set\('ParamBreath'/g) || []).length, 1);
    eq('ParamAngleX 每帧只 set 一次', (renderer.match(/set\('ParamAngleX'/g) || []).length, 1);
    eq('ParamEyeBallX 每帧只 set 一次', (renderer.match(/set\('ParamEyeBallX'/g) || []).length, 1);
    ok('ParamAngleX 写的是 ambOut.headX', /set\('ParamAngleX', ambOut\.headX\)/.test(renderer));
    ok('ParamBreath 写的是 ambOut.breath', /set\('ParamBreath', ambOut\.breath\)/.test(renderer));
    ok('position 写的是 ambOut.posX/posZ', /set\('PositionX', ambOut\.posX\)/.test(renderer) && /set\('PositionZ', ambOut\.posZ\)/.test(renderer));
    ok('entry 调 renderer.setAmbientOffset({...bias, amp})', /renderer\.setAmbientOffset\(ambientApply \? Object\.assign\(\{\}, amb\.bias, \{ amp: amb\.amp \}\) : null\)/.test(entry));
    ok('performanceDebug 暴露 applied/offsets', /applied: Boolean\(applied\)/.test(entry) && /offsets: applied \? applied\.offsets : null/.test(entry));
    ok('perf idle 层不再写外部通道（headX/bodyZ/breath 无 addition）',
      !/out\.headX = /.test(perfIndex) && !/out\.bodyZ = /.test(perfIndex) && !/out\.breath = /.test(perfIndex));
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' Ambient 偏置落地：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
