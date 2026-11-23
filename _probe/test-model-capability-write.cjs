#!/usr/bin/env node
/**
 * _probe/test-model-capability-write.cjs —— 能力页「模型级参数」写穿（2026-11-21）
 *
 * 病根：能力页的「思考等级 / 采样温度」开关只写 config.json，而运行时
 * LLMClient.fromProviderConfig 只从 resolveProvider 的结果读——那份结果由
 * llm-provider.js _buildResolved 从 **llm_providers.json 的当前模型条目** 平铺而来。
 * 于是拨能力页开关 = 写了一个运行时没人读的键，界面却显示「已保存」。
 *
 * 这个测试只碰临时目录里的 providers/config 两个文件：
 *   · 不读真实 config.json / llm_providers.json，不启动 Electron，不写任何仓内文件；
 *   · control-main.js 在纯 Node 下经 electron 桩加载（它正常只跑在 Electron 主进程）；
 *   · 断言直接落在磁盘字节 + resolveCapabilityValue 的有效值/来源上，不做字符串测试。
 *
 * 用法：node _probe/test-model-capability-write.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const caps = require(path.join(APP, 'js', 'core', 'capabilities.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  return false;
}

// ── 用 electron 桩把主进程模块加载进纯 Node ────────────────────────────────
function loadControlMain() {
  const fakeElectron = {
    app: {
      commandLine: { getSwitchValue: () => '', appendSwitch: () => {} },
      on: () => {},
      quit: () => {},
      whenReady: () => ({ then: () => {} }),
      requestSingleInstanceLock: () => true,
      setPath: () => {},
    },
    BrowserWindow: class { static getAllWindows() { return []; } },
    ipcMain: { handle: () => {} },
    shell: {},
    net: {},
    dialog: {},
    screen: { getAllDisplays: () => [] },
  };
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fakeElectron;
    return origLoad.apply(this, arguments);
  };
  try {
    return require(path.join(APP, 'control-main.js'));
  } finally {
    Module._load = origLoad;
  }
}

let main = null;
let loadError = null;
try { main = loadControlMain(); } catch (e) { loadError = e; }
const { applyModelParamWrite, MODEL_PARAM_KEYS } = main || {};

// ── 临时 fixtures ───────────────────────────────────────────────────────────
const BASE_PROVIDERS = () => ({
  providers: [
    {
      id: 'main', name: '主模型', api_key: 'k-main', api_url: 'https://example.invalid/v1', enabled: true,
      models: [{
        model_id: 'm1', name: 'm1', enabled: true,
        temperature: 0.85, temperature_enabled: true,
        reasoning_enabled: false, reasoning_effort: 'medium',
      }],
    },
    {
      id: 'other', name: '备用', api_key: 'k-other', api_url: 'https://other.invalid/v1', enabled: true,
      models: [{ model_id: 'm2', name: 'm2', enabled: true }],
    },
  ],
});
const BASE_CONFIG = () => ({ llm: { provider_id: 'main', model_id: 'm1' }, cost: { quiet: false }, tts: { muted: false } });

function makeFixture({ providers, config }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cap-write-'));
  const providersPath = path.join(dir, 'llm_providers.json');
  const configPath = path.join(dir, 'config.json');
  if (providers !== undefined) fs.writeFileSync(providersPath, JSON.stringify(providers, null, 2) + '\n', 'utf8');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return {
    dir, providersPath, configPath,
    providersRaw: () => (fs.existsSync(providersPath) ? fs.readFileSync(providersPath) : null),
    configRaw: () => fs.readFileSync(configPath),
    readProviders: () => JSON.parse(fs.readFileSync(providersPath, 'utf8')),
    readConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
  };
}
function modelOf(providersDoc, providerId, modelId) {
  const p = (providersDoc.providers || []).find((x) => x.id === providerId);
  return p ? (p.models || []).find((m) => m.model_id === modelId) : undefined;
}

// ── [1] 导出面 ─────────────────────────────────────────────────────────────
console.log('[1/7] 主进程导出可测纯函数');
ok('control-main.js 在 Node 下可加载（electron 桩）', !loadError,
  loadError ? String(loadError.message).slice(0, 140) : '已加载');
ok('applyModelParamWrite 已导出', typeof applyModelParamWrite === 'function');
ok('MODEL_PARAM_KEYS 已导出且是对象', !!MODEL_PARAM_KEYS && typeof MODEL_PARAM_KEYS === 'object');
if (!MODEL_PARAM_KEYS) {
  console.log('');
  console.log(`  模型参数写穿：${pass} 通过 / ${fail} 失败（缺少导出，后续项无法执行）`);
  process.exit(1);
}
for (const key of ['llm.reasoning_enabled', 'llm.reasoning_effort', 'llm.temperature_enabled']) {
  ok(`MODEL_PARAM_KEYS 含 ${key}`, Object.prototype.hasOwnProperty.call(MODEL_PARAM_KEYS, key));
}
ok('MODEL_PARAM_KEYS 不含 cost.quiet（静默有唯一真源 8103）',
  !MODEL_PARAM_KEYS['cost.quiet']);

// ── [2] reasoning_enabled 写穿到当前模型，config.json 一个字节不动 ─────────
console.log('[2/7] 写 llm.reasoning_enabled=true → 当前模型 true / config.json 不变');
{
  const fx = makeFixture({ providers: BASE_PROVIDERS(), config: BASE_CONFIG() });
  const beforeCfg = fx.configRaw();
  const beforeOther = modelOf(fx.readProviders(), 'other', 'm2');
  const r = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath },
    'llm.reasoning_enabled', true);
  ok('返回 ok:true', r && r.ok === true, JSON.stringify(r));
  ok('返回 wroteTo:model', r && r.wroteTo === 'model', r && r.wroteTo);
  ok('返回定位 {providerId:main, modelId:m1}',
    r && r.providerId === 'main' && r.modelId === 'm1', JSON.stringify({ p: r && r.providerId, m: r && r.modelId }));
  const doc = fx.readProviders();
  ok('llm_providers.json 当前模型 reasoning_enabled=true',
    modelOf(doc, 'main', 'm1').reasoning_enabled === true,
    JSON.stringify(modelOf(doc, 'main', 'm1')));
  ok('config.json 字节未变（保留为回退值，不写静态键）',
    Buffer.compare(beforeCfg, fx.configRaw()) === 0);
  ok('config.json 仍没有 llm.reasoning_enabled 键',
    !Object.prototype.hasOwnProperty.call(fx.readConfig().llm, 'reasoning_enabled'));
  ok('其它 provider 的模型不受影响',
    JSON.stringify(modelOf(doc, 'other', 'm2')) === JSON.stringify(beforeOther),
    JSON.stringify(modelOf(doc, 'other', 'm2')));
  ok('原有模型级参数不被抹掉（temperature/effort 仍在）',
    modelOf(doc, 'main', 'm1').temperature === 0.85
    && modelOf(doc, 'main', 'm1').temperature_enabled === true
    && modelOf(doc, 'main', 'm1').reasoning_effort === 'medium');

  // [3] resolveCapabilityValue 读到写穿后的值，来源必须是 model
  const reasoningCap = caps.CAPABILITIES.find((c) => c.id === 'llm.reasoning');
  const resolved = caps.resolveCapabilityValue(reasoningCap, {
    config: fx.readConfig(), providers: doc.providers, providerId: 'main', modelId: 'm1',
  });
  ok('能力页有效值 = true', resolved.value === true, JSON.stringify(resolved));
  ok('能力页来源 = model（不再是 default）', resolved.source === 'model', resolved.source);

  // 反向：写 false 也要落盘（不能只认 true）
  const off = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath },
    'llm.reasoning_enabled', false);
  ok('写 false 同样落盘', off.ok === true && fx.readProviders().providers[0].models[0].reasoning_enabled === false,
    JSON.stringify(off));
}

// ── [4] provider 不存在 → 明确失败，两个文件都不改 ─────────────────────────
console.log('[4/7] provider 不存在 → 明确失败 / 两文件不改');
{
  const cfg = BASE_CONFIG();
  cfg.llm.provider_id = 'ghost';
  const fx = makeFixture({ providers: BASE_PROVIDERS(), config: cfg });
  const beforeP = fx.providersRaw();
  const beforeC = fx.configRaw();
  const r = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath },
    'llm.reasoning_enabled', true);
  ok('ok:false', r && r.ok === false, JSON.stringify(r));
  ok('错误码 provider-missing', r && r.code === 'provider-missing', r && r.code);
  ok('错误信息点名 ghost', !!(r && /ghost/.test(r.error || '')), r && r.error);
  ok('llm_providers.json 未改', Buffer.compare(beforeP, fx.providersRaw()) === 0);
  ok('config.json 未改（不静默回退写 config）', Buffer.compare(beforeC, fx.configRaw()) === 0);
}

// 当前模型不在 provider 的 models 里 → 也不能顺手新建/改别的模型
{
  const cfg = BASE_CONFIG();
  cfg.llm.model_id = 'ghost-model';
  const fx = makeFixture({ providers: BASE_PROVIDERS(), config: cfg });
  const beforeP = fx.providersRaw();
  const r = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath },
    'llm.reasoning_enabled', true);
  ok('模型不存在 → ok:false / code=model-missing',
    r && r.ok === false && r.code === 'model-missing', JSON.stringify(r));
  ok('模型不存在 → 不新建模型、文件未改', Buffer.compare(beforeP, fx.providersRaw()) === 0);
}

// ── [5] temperature_enabled 同逻辑 ─────────────────────────────────────────
console.log('[5/7] llm.temperature_enabled 写穿同逻辑');
{
  const fx = makeFixture({ providers: BASE_PROVIDERS(), config: BASE_CONFIG() });
  const beforeCfg = fx.configRaw();
  const r = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath },
    'llm.temperature_enabled', false);
  ok('返回 ok:true / wroteTo:model', r.ok === true && r.wroteTo === 'model', JSON.stringify(r));
  ok('当前模型 temperature_enabled=false',
    modelOf(fx.readProviders(), 'main', 'm1').temperature_enabled === false);
  ok('备用模型没有被写入 temperature_enabled',
    modelOf(fx.readProviders(), 'other', 'm2').temperature_enabled === undefined);
  ok('config.json 未改', Buffer.compare(beforeCfg, fx.configRaw()) === 0);
  const tempCap = caps.CAPABILITIES.find((c) => c.id === 'llm.temperature');
  const resolved = caps.resolveCapabilityValue(tempCap, {
    config: fx.readConfig(), providers: fx.readProviders().providers, providerId: 'main', modelId: 'm1',
  });
  ok('能力页 temperature 有效值=false / 来源=model',
    resolved.value === false && resolved.source === 'model', JSON.stringify(resolved));

  // 运行时 applySampling 先读 config.llm.temperature_enabled：如果 config 里还有
  // 显式旧值且不同，只写模型不会生效 → 必须返回 config-shadowed 让调用方改走 config。
  const cfgShadow = BASE_CONFIG();
  cfgShadow.llm.temperature_enabled = true;
  const shadowFx = makeFixture({ providers: BASE_PROVIDERS(), config: cfgShadow });
  const beforeP = shadowFx.providersRaw();
  const beforeC = shadowFx.configRaw();
  const shadow = applyModelParamWrite({ providersPath: shadowFx.providersPath, configPath: shadowFx.configPath },
    'llm.temperature_enabled', false);
  ok('config 里有不同旧值 → code=config-shadowed',
    shadow.ok === false && shadow.code === 'config-shadowed', JSON.stringify(shadow));
  ok('config-shadowed 时纯函数不碰文件（由调用方走 config 回退）',
    Buffer.compare(beforeP, shadowFx.providersRaw()) === 0
    && Buffer.compare(beforeC, shadowFx.configRaw()) === 0);

  // 影子值相同 → 不拦，正常写模型
  const cfgSame = BASE_CONFIG();
  cfgSame.llm.temperature_enabled = false;
  const sameFx = makeFixture({ providers: BASE_PROVIDERS(), config: cfgSame });
  const same = applyModelParamWrite({ providersPath: sameFx.providersPath, configPath: sameFx.configPath },
    'llm.temperature_enabled', false);
  ok('config 旧值与新值相同 → 正常写模型', same.ok === true && same.wroteTo === 'model', JSON.stringify(same));
}

// ── [6] 非模型级键不走模型（仍归 config 分支）──────────────────────────────
console.log('[6/7] 非模型级键不写模型');
{
  const fx = makeFixture({ providers: BASE_PROVIDERS(), config: BASE_CONFIG() });
  const beforeP = fx.providersRaw();
  for (const key of ['cost.quiet', 'tts.muted', 'context.enable_limit']) {
    const r = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath }, key, true);
    ok(`${key} → not-model-param（不碰模型文件）`,
      r && r.ok === false && r.code === 'not-model-param', JSON.stringify(r));
  }
  ok('llm_providers.json 未改', Buffer.compare(beforeP, fx.providersRaw()) === 0);

  // 接线证明：IPC 分支先查 MODEL_PARAM_KEYS，命中才走模型；其余键保持原 saveAndApply 路径
  const src = fs.readFileSync(path.join(APP, 'control-main.js'), 'utf8');
  ok('set-config-value 命中 MODEL_PARAM_KEYS 时调用 applyModelParamWrite',
    /if\s*\(\s*MODEL_PARAM_KEYS\[key\]\s*\)/.test(src) && /applyModelParamWrite\(/.test(src));
  ok('模型分支返回 wroteTo:model', /wroteTo:\s*'model'/.test(src));
  ok('模型写成功后通知宿主重载', /notifyHostReload\(/.test(src));
}

// ── [7] reasoning_effort + 无通讯录回退 ────────────────────────────────────
console.log('[7/7] reasoning_effort 写穿 / 无通讯录回退');
{
  const fx = makeFixture({ providers: BASE_PROVIDERS(), config: BASE_CONFIG() });
  const r = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath },
    'llm.reasoning_effort', 'high');
  ok('reasoning_effort=high 落到当前模型',
    r.ok === true && modelOf(fx.readProviders(), 'main', 'm1').reasoning_effort === 'high',
    JSON.stringify(r));
  const bad = applyModelParamWrite({ providersPath: fx.providersPath, configPath: fx.configPath },
    'llm.reasoning_effort', '');
  ok('空 effort 被拒（bad-value）', bad.ok === false && bad.code === 'bad-value', JSON.stringify(bad));

  // 首次运行还没有 llm_providers.json：不能硬失败，要回退写 config 并由调用方标明
  const empty = makeFixture({ providers: { providers: [] }, config: BASE_CONFIG() });
  const beforeCfg = empty.configRaw();
  const beforeP = empty.providersRaw();
  const fb = applyModelParamWrite({ providersPath: empty.providersPath, configPath: empty.configPath },
    'llm.reasoning_enabled', true);
  ok('无通讯录 → code=no-providers / fallbackToConfig=true',
    fb.ok === false && fb.code === 'no-providers' && fb.fallbackToConfig === true, JSON.stringify(fb));
  ok('无通讯录时纯函数不碰任何文件',
    Buffer.compare(beforeCfg, empty.configRaw()) === 0
    && Buffer.compare(beforeP, empty.providersRaw()) === 0);
}

console.log('');
console.log(`  模型参数写穿：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
