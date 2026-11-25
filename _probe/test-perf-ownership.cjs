#!/usr/bin/env node
/**
 * _probe/test-perf-ownership.cjs —— 参数所有权护栏（2026-11-25 P0.1）
 *
 * 钉住审计 §4.1 的四条硬伤（「假绿」）：
 *   ① v2 的 view.choreo/choreoOverride 写入集必须能进 checkWriteSet 对账；
 *   ② COMPOSING_LAYERS 移除 choreo —— 它和 blink/lip/proc 双写必须计入 fight；
 *   ③ ParamMouthForm / LeanInput / ParamMouthOpenY 必须在 EXTERNALLY_OWNED_PARAMS；
 *   ④ exp3 锁（脸红 key7 / 流泪 key2 / 流冷汗 key13）必须受资产 pin 约束。
 *
 * 用法：node _probe/test-perf-ownership.cjs
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

(async () => {
  const {
    LAYER, classifyConflict, evaluateFrameConflicts, findExternalOwnershipViolations,
  } = await import(file('param-ownership-probe.mjs'));
  const {
    v2WriteSet, declaredChoreoParams, checkChoreoWriteSet, checkWriteSet,
    filterPinnedParams, filterPinnedExpressions, EXPRESSION_PARAM_LOCKS,
    declaredParamsFor,
  } = await import(file('perf/param-ownership.mjs'));
  const { EXTERNALLY_OWNED_PARAMS, PERF_SHARED_OWNED_PARAMS, PROFILE_SPECS, buildProfile } =
    await import(file('perf/profile.mjs'));

  // ── ① choreo 不再是「合成层」：双写必须计入 conflict ─────────────────
  eq('choreo+blink 归类为 fight', classifyConflict([LAYER.CHOREO, LAYER.BLINK]), 'fight');
  eq('choreo+proc-motion 归类为 fight', classifyConflict(['choreo', 'proc-motion']), 'fight');
  eq('perf-override+blink 仍是 compose（覆盖层是最终裁决）', classifyConflict(['perf-override', 'blink']), 'compose');
  {
    const fw = new Map([
      ['ParamAngleX', { vals: [0.12, -0.35], owners: ['choreo', 'proc-motion'] }],
    ]);
    const r = evaluateFrameConflicts(fw);
    eq('choreo 双写计入 fight 帧', r.fights, 1);
    eq('choreo 双写计入 conflictFrames（不是 compose）', r.compose, 0);
    eq('冲突条目保留 owner 顺序', r.conflicts[0] && r.conflicts[0].owners, ['choreo', 'proc-motion']);
    eq('冲突条目带 kind', r.conflicts[0] && r.conflicts[0].kind, 'fight');
  }
  {
    // 无冲突：单次写入 / 两次写入差小于阈值 / 同一 owner
    const fw = new Map([
      ['ParamBreath', { vals: [0.5], owners: ['proc-motion'] }],
      ['ParamAngleZ', { vals: [0.2, 0.205], owners: ['choreo', 'proc-motion'] }],
    ]);
    const r = evaluateFrameConflicts(fw);
    eq('无冲突时 fights=0', r.fights, 0);
    eq('无冲突时 compose=0', r.compose, 0);
    eq('无冲突时 conflicts 为空', r.conflicts, []);
  }

  // ── ② v2 写入集（choreo / choreoOverride）─────────────────────────────
  eq('null view 返回空集', v2WriteSet(null).size, 0);
  {
    const set = v2WriteSet({ choreo: { AngleX: 4, PositionZ: -2, ParamEyeBallX: 0.02 }, choreoOverride: { ParamMouthForm: 0.4 } });
    ok('v2 写入集含 AngleX（物理输入）', set.has('AngleX'));
    ok('v2 写入集含 ParamAngleX（骨头双写）', set.has('ParamAngleX'));
    ok('v2 写入集含 override 参数', set.has('ParamMouthForm'));
    ok('v2 写入集含位移', set.has('PositionZ'));
    eq('近似 0 的偏置不算写入', v2WriteSet({ choreo: { AngleY: 1e-9 } }).size, 0);
  }
  {
    const declared = declaredChoreoParams(['AngleX', 'ParamEyeBallX']);
    ok('声明自动补骨头参数', declared.has('ParamAngleX') && declared.has('AngleX'));
    const good = checkChoreoWriteSet({ choreo: { AngleX: 3, ParamEyeBallX: -0.01 } }, ['AngleX', 'ParamEyeBallX']);
    eq('v2 写入 ⊆ 编译数据声明 → ok', good.ok, true);
    const bad = checkChoreoWriteSet({ choreo: { PositionX: 9 } }, ['AngleX']);
    eq('v2 凭空多写参数 → 断言失败', bad.ok, false);
    eq('未声明参数被列出', bad.undeclared, ['PositionX']);
  }

  // ── ③ 外部所有权表（ParamMouthForm / LeanInput / ParamMouthOpenY）────
  ok('表里有 ParamMouthOpenY', Object.prototype.hasOwnProperty.call(EXTERNALLY_OWNED_PARAMS, 'ParamMouthOpenY'));
  ok('表里有 ParamMouthForm', Object.prototype.hasOwnProperty.call(EXTERNALLY_OWNED_PARAMS, 'ParamMouthForm'));
  ok('表里有 LeanInput', Object.prototype.hasOwnProperty.call(EXTERNALLY_OWNED_PARAMS, 'LeanInput'));
  ok('表里含 18 个以上参数', Object.keys(EXTERNALLY_OWNED_PARAMS).length >= 18, 'n=' + Object.keys(EXTERNALLY_OWNED_PARAMS).length);
  ok('表里每个参数都有 owner 文案', Object.values(EXTERNALLY_OWNED_PARAMS).every((v) => typeof v === 'string' && v.length > 0));
  ok('ParamMouthForm 对 perf 是共享参数', PERF_SHARED_OWNED_PARAMS.has('ParamMouthForm'));
  {
    // v2 写外部所有参数 → 逐条能报出（这是「所有权黑洞」的反面）
    const v2Ids = ['ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthForm', 'ParamMouthOpenY', 'LeanInput', 'ParamAngleX', 'PositionX', 'HipAngleX', 'ParamBreath'];
    const violations = findExternalOwnershipViolations(v2Ids, EXTERNALLY_OWNED_PARAMS);
    eq('v2 写外部所有参数全部报出', violations.length, v2Ids.length);
    eq('报出项带 param/owner', violations.every((v) => v.param && v.owner), true);
    ok('ParamMouthForm 的越权能被报出（v2 不豁免）', violations.some((v) => v.param === 'ParamMouthForm'));
  }
  {
    // perf 自己写 ParamMouthForm 不算越权（否则每次启动一条狼来了）
    const perfIds = ['ParamMouthForm', 'BrowInnerUp'];
    const raw = findExternalOwnershipViolations(perfIds, EXTERNALLY_OWNED_PARAMS);
    const filtered = raw.filter((v) => !PERF_SHARED_OWNED_PARAMS.has(v.param));
    eq('perf 写 ParamMouthForm 被豁免', filtered.length, 0);
    eq('豁免只影响 Declared 之外的判断（原始表仍能报）', raw.length, 1);
  }
  {
    // buildProfile 不能因为 ParamMouthForm 进了外部表就把嘴形通道摘掉
    const runtime = { paramIds: new Set(['ParamMouthForm', 'BrowInnerUp']), expressions: new Set(), ranges: new Map() };
    const profile = buildProfile(PROFILE_SPECS.jellyfish, runtime);
    ok('画像 mouthSmile 通道仍在（外部表按参数 id 生效，不误伤通道）', Boolean(profile.channels.mouthSmile));
    ok('画像 usedParams 含 ParamMouthForm', profile.usedParams.includes('ParamMouthForm'));
  }

  // ── ④ exp3 锁受资产 pin 约束（脸红 key7 / 流泪 key2 / 流冷汗 key13）──
  eq('中英文表情锁映射用中文名', Object.keys(EXPRESSION_PARAM_LOCKS), ['脸红', '流泪', '流冷汗']);
  eq('脸红 → key7', EXPRESSION_PARAM_LOCKS['脸红'], ['key7']);
  eq('流泪 → key2', EXPRESSION_PARAM_LOCKS['流泪'], ['key2']);
  eq('流冷汗 → key13', EXPRESSION_PARAM_LOCKS['流冷汗'], ['key13']);
  {
    // 用户手动 pin「脸红」后，v2 的 expression 锁不能再写 key7
    const pinned = new Set(['key7']);
    const r = filterPinnedExpressions(['脸红', '＞＜', '屑屑眼'], pinned);
    eq('pin key7 后脸红被摘掉', r.accepted, ['＞＜', '屑屑眼']);
    eq('摘掉的项带具体参数', r.skippedPinned, [{ name: '脸红', params: ['key7'] }]);
    const writesKey7 = r.accepted.some((n) => (EXPRESSION_PARAM_LOCKS[n] || []).includes('key7'));
    eq('剩余表情没有任何一个写 key7', writesKey7, false);
  }
  {
    const r = filterPinnedExpressions(['脸红', '流泪', '流冷汗'], new Set(['key2', 'key13']));
    eq('pin key2/key13 → 只剩脸红', r.accepted, ['脸红']);
    eq('跳过两项', r.skippedPinned.length, 2);
  }
  eq('没有 pin 时全部放行', filterPinnedExpressions(['脸红'], new Set()).accepted, ['脸红']);
  eq('无 pin 参数传入 null 也不崩', filterPinnedExpressions(['流泪'], null).accepted, ['流泪']);
  eq('未知表情不受影响', filterPinnedExpressions(['＞＜'], new Set(['key7'])).accepted, ['＞＜']);

  // ── ⑤ 旧能力没丢：param 级 pin 过滤仍按参数 id 生效 ─────────────────
  {
    const r = filterPinnedParams({ key7: 0.9, ParamMouthForm: 0.4 }, new Set(['key7']));
    eq('filterPinnedParams 仍跳过 key7', r.skippedPinned, ['key7']);
    eq('filterPinnedParams 仍写别的参数', r.accepted, { ParamMouthForm: 0.4 });
  }
  {
    const ds = declaredParamsFor('choreo', { params: ['AngleX'] });
    eq('choreo 声明来自显式 params', Array.from(ds), ['AngleX']);
    const audit = checkWriteSet('choreo', ['AngleX'], { params: ds });
    eq('checkWriteSet 对 choreo 可用', audit.ok, true);
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 参数所有权护栏：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
