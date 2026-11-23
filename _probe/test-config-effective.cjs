#!/usr/bin/env node
/**
 * _probe/test-config-effective.cjs —— 有效配置值 / 设置页回写 / intent_router 收敛（2026-11-21）
 *
 * 背景（治理盘点的三处「显示假值 / 保存静默改值 / 死开关」）：
 *   ① 能力页以前读 config.json 原始值。llm.reasoning / llm.temperature 的真实值存在
 *      llm_providers.json 的当前模型上（control-main.js saveControlConfig 会把 config.json
 *      里的同名键删掉）→ 能力页永远显示 default false。
 *   ② 设置页缺键按 false 渲染，而运行时缺键按 true（llm-handler.js applySampling）→
 *      打开设置点保存就把 temperature_enabled 静默写成 false。
 *   ③ llm.intent_router 是死开关：只有 classifyIntent 读它（仅单测调用），主链走
 *      classifyIntentLocal。方案 A：保留代码，注册表标 deprecated，两处 UI 不再渲染。
 *
 * 这个测试只碰纯函数 / 临时对象：不读真实 config.json，不启动 Electron，不写任何文件。
 * 渲染层那两个纯函数从 control-v2-renderer.js 顶层导出（浏览器里不生效）。
 *
 * 用法：node _probe/test-config-effective.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  return false;
}

const caps = require(path.join(APP, 'js', 'core', 'capabilities.js'));
const { CAPABILITIES, resolveCapabilityValue } = caps;

// ── ① 有效值解析：llm.reasoning / llm.temperature 来自 llm_providers.json ─────
console.log('[1/4] 有效值：config.json 缺键时从 llm_providers.json 的当前模型取');
const reasoningCap = CAPABILITIES.find((c) => c.id === 'llm.reasoning');
const tempCap = CAPABILITIES.find((c) => c.id === 'llm.temperature');
ok('注册表有 llm.reasoning / llm.temperature', !!reasoningCap && !!tempCap);
ok('resolveCapabilityValue 已导出', typeof resolveCapabilityValue === 'function');

const mkProviders = (modelParams) => ([{
  id: 'main', name: '主模型', enabled: true,
  models: [{ model_id: 'm1', name: 'm1', enabled: true, ...modelParams }],
}]);
const env = (modelParams, config = {}) => ({
  config,
  providers: mkProviders(modelParams),
  providerId: 'main',
  modelId: 'm1',
});

// 组合 A：模型说「开思考、关温度」
const a = env({ reasoning_enabled: true, reasoning_effort: 'high', temperature_enabled: false });
const aRea = resolveCapabilityValue(reasoningCap, a);
const aTemp = resolveCapabilityValue(tempCap, a);
ok('组合 A：reasoning 有效值 = true（来自模型）', aRea.value === true, JSON.stringify(aRea));
ok('组合 A：reasoning 来源标记为 model', aRea.source === 'model', aRea.source);
ok('组合 A：temperature 有效值 = false（来自模型）', aTemp.value === false, JSON.stringify(aTemp));

// 组合 B：模型说「关思考、开温度」—— 与 default 相反，证明不是拿 default 顶的
const b = env({ reasoning_enabled: false, reasoning_effort: 'low', temperature_enabled: true });
const bRea = resolveCapabilityValue(reasoningCap, b);
const bTemp = resolveCapabilityValue(tempCap, b);
ok('组合 B：reasoning 有效值 = false（模型显式关）', bRea.value === false, JSON.stringify(bRea));
ok('组合 B：temperature 有效值 = true（模型显式开）', bTemp.value === true, JSON.stringify(bTemp));
ok('组合 A/B 取值确实来自模型而非 default',
  aRea.value !== bRea.value && aTemp.value !== bTemp.value,
  `A=${aRea.value}/${aTemp.value} B=${bRea.value}/${bTemp.value}`);

// config.json 与模型同时有值时：逐键按运行时的真实读法决定优先级
const withCfg = env({ reasoning_enabled: true, temperature_enabled: true },
  { llm: { reasoning_enabled: false, temperature_enabled: false } });
const cfgRea = resolveCapabilityValue(reasoningCap, withCfg);
const cfgTemp = resolveCapabilityValue(tempCap, withCfg);
ok('reasoning 模型优先（LLMClient 只从 resolved 读）→ true/model',
  cfgRea.value === true && cfgRea.source === 'model', JSON.stringify(cfgRea));
ok('temperature config.json 优先（applySampling 先读 config.llm）→ false/config',
  cfgTemp.value === false && cfgTemp.source === 'config', JSON.stringify(cfgTemp));

// 模型没写 reasoning 时，config.json 的旧键仍生效（无通讯录的回退构造路径）
const cfgOnlyRea = resolveCapabilityValue(reasoningCap,
  env({}, { llm: { reasoning_enabled: true } }));
ok('模型缺 reasoning 键 → config.json 回退生效（true/config）',
  cfgOnlyRea.value === true && cfgOnlyRea.source === 'config', JSON.stringify(cfgOnlyRea));

// 两边都没写 → 运行时代码默认值
const none = env({});
const noneRea = resolveCapabilityValue(reasoningCap, none);
const noneTemp = resolveCapabilityValue(tempCap, none);
ok('都没写：reasoning = default false / source=default',
  noneRea.value === false && noneRea.source === 'default', JSON.stringify(noneRea));
ok('都没写：temperature = default true / source=default（不能是 false）',
  noneTemp.value === true && noneTemp.source === 'default', JSON.stringify(noneTemp));

// ── ② 设置页渲染：缺键按运行时默认（temperature = true）────────────────────
console.log('[2/4] 设置页渲染：缺键默认值与运行时一致');
let renderer = null;
let rendererError = null;
try {
  renderer = require(path.join(APP, 'control-v2-renderer.js'));
} catch (e) {
  rendererError = e;
}
ok('渲染层纯函数可从 Node 加载', !!renderer, rendererError ? String(rendererError.message).slice(0, 120) : '已导出');

if (renderer) {
  const { fieldInitialValue, planFieldWrites } = renderer;
  ok('fieldInitialValue / planFieldWrites 已导出',
    typeof fieldInitialValue === 'function' && typeof planFieldWrites === 'function');
  ok('temperature-enabled 缺键渲染为 true',
    fieldInitialValue('temperature-enabled', 'checked', undefined) === true);
  ok('其它 checked 字段缺键仍按 false（不误伤）',
    fieldInitialValue('vision-enabled', 'checked', undefined) === false);
  ok('显式 false 不被默认值覆盖',
    fieldInitialValue('temperature-enabled', 'checked', false) === false);

  // ── ③ 保存只回写改过的字段：缺键不会被渲染默认值实体化 ────────────────
  console.log('[3/4] 保存：未改动字段不写盘（缺键保持缺键）');
  const specs = {
    'temperature-enabled': { path: 'llm.temperature_enabled', type: 'checked' },
    'tts-speed': { path: 'tts.speed_factor', type: 'number' },
    'llm-prompt': { path: 'llm.system_prompt', type: 'value' },
  };
  // 场景：模型/配置都没有 temperature_enabled → 渲染 true；用户只改了语速，然后保存
  const baseline = { 'temperature-enabled': true, 'tts-speed': '1', 'llm-prompt': 'hi' };
  const current = { 'temperature-enabled': true, 'tts-speed': '1.2', 'llm-prompt': 'hi' };
  const plan = planFieldWrites(specs, current, baseline);
  ok('保存计划只包含真正改过的语速', plan.writes.length === 1 && plan.writes[0].path === 'tts.speed_factor',
    JSON.stringify(plan.writes));
  ok('temperature_enabled 不在写回清单（不会被静默改 false）',
    !plan.writes.some((w) => w.path === 'llm.temperature_enabled'));
  ok('未改动字段计数可见（用于日志）', plan.unchanged === 2, String(plan.unchanged));

  // 用户显式关掉温度 → 必须写 false（用户意图不能丢）
  const explicitOff = planFieldWrites(specs,
    { 'temperature-enabled': false, 'tts-speed': '1', 'llm-prompt': 'hi' }, baseline);
  ok('用户显式关温度 → 写 false（用户意图保留）',
    explicitOff.writes.some((w) => w.path === 'llm.temperature_enabled' && w.value === false),
    JSON.stringify(explicitOff.writes));

  // 空数字输入不写 0/NaN（旧行为保持）
  const emptyNum = planFieldWrites(specs,
    { 'temperature-enabled': true, 'tts-speed': '', 'llm-prompt': 'hi' }, baseline);
  ok('空数字输入不写 0', !emptyNum.writes.some((w) => w.path === 'tts.speed_factor'));

  // 接线证明：渲染/保存真的走这两个纯函数（而不是测试自己实现了一遍）
  const src = fs.readFileSync(path.join(APP, 'control-v2-renderer.js'), 'utf8');
  ok('renderFields 用 fieldInitialValue 决定缺键默认',
    /fieldInitialValue\(id, type, get\(config, path, undefined\)\)/.test(src));
  ok('renderFields 在渲染后记录 baselineFieldState',
    /baselineFieldState = readFieldState\(\)/.test(src));
  ok('saveConfig 用 planFieldWrites(baseline) 过滤未改动字段',
    /planFieldWrites\(specs, readFieldState\(\), baselineFieldState\)/.test(src));
  ok('旧的「无条件回写全部字段」循环已移除',
    !/if \(type === 'checked'\) \{ set\(config, path, el\.checked\); sentFields\.push/.test(src));
}

// ── ④ intent_router 方案 A：保留代码，注册表标 deprecated，UI 不再渲染 ──────
console.log('[4/4] intent_router：方案 A（保留代码 + 标废弃 + 移除两处 UI）');
const intentCap = CAPABILITIES.find((c) => c.id === 'llm.intent_router');
ok('注册表仍有 llm.intent_router（代码保留）', !!intentCap);
ok('注册表标了 deprecated', !!(intentCap && intentCap.deprecated),
  intentCap ? String(intentCap.deprecated).slice(0, 80) : 'missing');

const html = fs.readFileSync(path.join(APP, 'control-v2.html'), 'utf8');
const rendererSrc = fs.readFileSync(path.join(APP, 'control-v2-renderer.js'), 'utf8');
ok('设置页不再渲染意图路由开关（无 intent-router-enabled 元素）',
  !/intent-router-enabled/.test(html));
ok('设置页字段表不再登记 llm.intent_router.enabled',
  !/'intent-router-enabled'\s*:\s*\[/.test(rendererSrc));
ok('能力页跳过 deprecated 条目（不渲染开关）',
  /it\.deprecated/.test(rendererSrc));
ok('死开关实现代码仍在（classifyIntent 未删）',
  /function classifyIntent\s*\(/.test(fs.readFileSync(path.join(APP, 'js', 'ai', 'intent-router.js'), 'utf8')));

console.log('');
console.log(`  有效配置：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
