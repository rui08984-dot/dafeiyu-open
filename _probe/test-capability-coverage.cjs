#!/usr/bin/env node
/**
 * _probe/test-capability-coverage.cjs —— 能力注册表「声明 ↔ 实现」覆盖（2026-11-21 治理盘点）
 *
 * 背景（用户原话）：「功能是完好的，但管理不好管」——插件页、能力页、config.json、
 * plugin_config.json、托盘各管一摊。capabilities.js 要做唯一真相源，就必须证明：
 *   ① 每条能力都能解析到真实实现（config 有消费者 / 插件目录在 / 端口有宿主 / impl 文件在）
 *   ② enabled_plugins.json 里的插件都能在注册表里找到归属（否则就是黑户）
 *   ③ 每个插件工具名都能从它的 getTools()（或动态定义）里发现，且不重名
 *   ④ 把「没有 doctor 项 / 没有门禁测试 / 没有 UI 入口」的清单打印成治理台账（不判红）
 *
 * 用法：node _probe/test-capability-coverage.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PLUGINS = path.join(APP, 'plugins');
const { CAPABILITIES, getPath, flattenKeys } = require(path.join(APP, 'js', 'core', 'capabilities.js'));
const { Plugin } = require(path.join(APP, 'js', 'core', 'plugin-base.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  return false;
}
function info(msg) { console.log('  · ' + msg); }

// ── 已知未实现（冻结债务：只减不增；新增未实现能力会被 ① 判红）─────────────
// llm.intent_router：主链 2026-11 起走零延迟本地启发式 classifyIntentLocal
// （js/ai/llm-handler.js:478）；语义版 classifyIntent 只剩单测在调。
const KNOWN_UNIMPLEMENTED = {
  'llm.intent_router': '主链走 classifyIntentLocal；classifyIntent 仅单测调用（llm-handler.js:478）',
};

// 明确豁免的插件：确实不该进能力注册表的（例如第三方实验插件）。
// 目前为空 —— 29 个插件目录全部有归属；保留机制是为了将来装 DLC 时能写清理由。
const EXEMPT_PLUGINS = {
  // 'community/some-third-party': '第三方实验插件，不承诺能力面',
};

// ── 源码索引（用于「config 键有没有消费者」）────────────────────────────────
const SOURCE_ROOTS = ['js', 'control-main.js', 'main.js', 'control-preload.js', 'petbridge', 'webui', 'scripts', 'plugins'];
const sourceDocs = [];
function walk(p) {
  let st;
  try { st = fs.statSync(p); } catch (e) { return; }
  if (st.isDirectory()) {
    for (const d of fs.readdirSync(p)) walk(path.join(p, d));
    return;
  }
  if (!/\.(js|cjs|mjs|py|html)$/.test(p)) return;
  if (/[\\/]node_modules[\\/]/.test(p)) return;
  if (/\.test\.js$/.test(p)) return;
  if (/[\\/]js[\\/]core[\\/]capabilities\.js$/.test(p)) return;
  try {
    sourceDocs.push({ rel: path.relative(APP, p), text: fs.readFileSync(p, 'utf8') });
  } catch (e) { /* 读不到就跳过 */ }
}
for (const r of SOURCE_ROOTS) walk(path.join(APP, r));

const tokenRe = (tok) => new RegExp('(^|[^A-Za-z0-9_$])' + String(tok).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^A-Za-z0-9_$]|$)');
function hasToken(text, tok) { return tokenRe(tok).test(text); }
function consumersOf(key) {
  const segs = String(key).split('.');
  const leaf = segs.pop();
  const parents = segs;
  return sourceDocs.filter((d) => hasToken(d.text, leaf) && parents.every((s) => hasToken(d.text, s)))
    .map((d) => d.rel);
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

const config = readJson(path.join(APP, 'config.json'), {});
const enabled = (() => {
  const j = readJson(path.join(PLUGINS, 'enabled_plugins.json'), { plugins: [] });
  return Array.isArray(j.plugins) ? j.plugins : [];
})();
const enabledSet = new Set(enabled);

// ────────────────────────────────────────────────────────────────────────────
console.log('[1/4] 能力 → 实现可解析');
const failures1 = [];
const unimplementedSeen = [];
for (const cap of CAPABILITIES) {
  if (cap.kind === 'config') {
    if (!cap.key) { failures1.push(cap.id + '：config 类缺 key'); continue; }
    if (!cap.soft && getPath(config, cap.key) === undefined) {
      failures1.push(cap.id + '：config.json 没有 ' + cap.key + '（且未标 soft）');
    }
    if (KNOWN_UNIMPLEMENTED[cap.id]) { unimplementedSeen.push(cap.id); continue; }
    if (!consumersOf(cap.key).length) failures1.push(cap.id + '：' + cap.key + ' 在源码里没有消费者');
  } else if (cap.kind === 'plugin') {
    if (!cap.key) { failures1.push(cap.id + '：plugin 类缺 key'); continue; }
    const dir = path.join(PLUGINS, cap.key);
    if (!fs.existsSync(path.join(dir, 'metadata.json'))) {
      failures1.push(cap.id + '：插件目录/metadata 不存在（' + cap.key + '）');
      continue;
    }
    if (cap.default === true && !enabledSet.has(cap.key)) {
      failures1.push(cap.id + '：声明默认开启，但 enabled_plugins.json 没有它');
    }
  } else if (cap.kind === 'port') {
    if (!cap.port) { failures1.push(cap.id + '：port 类缺 port'); continue; }
    const implOk = cap.impl && (() => {
      const cands = [path.join(ROOT, cap.impl), path.join(APP, cap.impl)];
      return cands.some((p) => fs.existsSync(p));
    })();
    const portOk = sourceDocs.some((d) => hasToken(d.text, String(cap.port)));
    if (!implOk && !portOk) failures1.push(cap.id + '：端口 ' + cap.port + ' 既没有 impl 文件也不在源码里');
  } else {
    failures1.push(cap.id + '：未知 kind ' + cap.kind);
  }
  // impl 文件存在性（config/port 通用）
  if (cap.impl) {
    const cands = [path.join(ROOT, cap.impl), path.join(APP, cap.impl)];
    if (!cands.some((p) => fs.existsSync(p))) failures1.push(cap.id + '：impl 文件找不到（' + cap.impl + '）');
  }
  // config 类若声明了宿主插件，插件也必须真实存在（避免「配置总闸」挂空）
  if (cap.plugin) {
    if (!fs.existsSync(path.join(PLUGINS, cap.plugin, 'metadata.json'))) {
      failures1.push(cap.id + '：plugin 字段指向不存在的插件 ' + cap.plugin);
    } else if (cap.default === true && !enabledSet.has(cap.plugin)) {
      failures1.push(cap.id + '：宿主插件 ' + cap.plugin + ' 未启用');
    }
  }
}
ok('每条能力都有 id/name/group/kind', CAPABILITIES.every((c) => c.id && c.name && c.group && c.kind));
ok('id 唯一', new Set(CAPABILITIES.map((c) => c.id)).size === CAPABILITIES.length);
ok('config key 唯一（同一开关不能两行）',
  new Set(CAPABILITIES.filter((c) => c.kind === 'config').map((c) => c.key)).size
  === CAPABILITIES.filter((c) => c.kind === 'config').length);
ok(CAPABILITIES.length + ' 条能力全部可解析到实现', failures1.length === 0,
  failures1.slice(0, 8).join('；') || '全过');
if (unimplementedSeen.length) info('已知未实现（冻结债务）：' + unimplementedSeen.join(', '));

// ────────────────────────────────────────────────────────────────────────────
console.log('[2/4] enabled_plugins.json 全部有归属');
const capPluginKeys = new Set(CAPABILITIES.filter((c) => c.kind === 'plugin').map((c) => c.key));
for (const c of CAPABILITIES) if (c.plugin) capPluginKeys.add(c.plugin);
const homeless = enabled.filter((p) => !capPluginKeys.has(p) && !EXEMPT_PLUGINS[p]);
ok('启用插件全部在 capability（或明确豁免）里', homeless.length === 0, homeless.join(', ') || '全过');
const declaredButNotEnabled = [...capPluginKeys].filter((p) => !enabledSet.has(p) && !EXEMPT_PLUGINS[p]);
if (declaredButNotEnabled.length) info('声明但未启用（允许；应为默认关的能力）：' + declaredButNotEnabled.join(', '));

// ────────────────────────────────────────────────────────────────────────────
console.log('[3/4] 工具名可发现 / 不重名');
const stubContext = {
  config: {}, pluginId: '', log() {}, getPluginFileConfig() { return {}; },
  registerTool() {}, unregisterTool() {}, getService() { return null; },
};
const pluginTools = new Map();
const loadErrors = [];
for (const rel of [...capPluginKeys]) {
  const dir = path.join(PLUGINS, rel);
  const metaPath = path.join(dir, 'metadata.json');
  if (!fs.existsSync(metaPath)) continue; // 已由 [1/4] 报
  const meta = readJson(metaPath, {});
  if (meta.lang === 'python') { pluginTools.set(rel, []); continue; }
  const main = path.join(dir, meta.main || 'index.js');
  if (!fs.existsSync(main)) { loadErrors.push(rel + '：入口不存在'); continue; }
  let inst;
  try {
    const mod = require(main);
    const named = (mod && typeof mod === 'object')
      ? Object.keys(mod).map((k) => mod[k]).find((v) => typeof v === 'function') : null;
    const Cls = (typeof mod === 'function') ? mod : (mod && mod.default) || named || mod;
    if (typeof Cls !== 'function') { loadErrors.push(rel + '：入口不是构造函数'); continue; }
    inst = new Cls(meta, stubContext);
  } catch (e) {
    loadErrors.push(rel + '：require/实例化失败 — ' + String(e.message).split('\n')[0].slice(0, 90));
    continue;
  }
  // 让「默认关/条件注册」的工具也能被发现（只唤醒 getTools 的判定字段，不跑 onInit）
  inst._enabled = true;
  inst._useOrgan = true;
  let tools = [];
  try {
    const got = inst.getTools();
    tools = (Array.isArray(got) ? got : []).map((t) => (t && t.function && t.function.name) || (t && t.name)).filter(Boolean);
  } catch (e) {
    loadErrors.push(rel + '：getTools() 抛错 — ' + String(e.message).slice(0, 90));
  }
  pluginTools.set(rel, tools);
}
// memos 的工具定义在 tools.js 的 TOOL_DEFINITIONS（require electron，纯 Node 加载不了）
const memosToolsFile = path.join(PLUGINS, 'built-in', 'memos', 'tools.js');
if (fs.existsSync(memosToolsFile)) {
  const src = fs.readFileSync(memosToolsFile, 'utf8');
  const start = src.indexOf('const TOOL_DEFINITIONS');
  const end = src.indexOf('];', start);
  const block = start >= 0 && end > start ? src.slice(start, end) : '';
  const names = [...block.matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1]);
  if (names.length) pluginTools.set('built-in/memos', [...new Set([...(pluginTools.get('built-in/memos') || []), ...names])]);
}
ok('所有插件入口都能实例化并调 getTools()', loadErrors.length === 0, loadErrors.slice(0, 6).join('；') || '全过');

const owners = new Map();
for (const [rel, tools] of pluginTools) {
  for (const t of tools) {
    if (!owners.has(t)) owners.set(t, []);
    owners.get(t).push(rel);
  }
}
const dupTools = [...owners.entries()].filter(([, v]) => v.length > 1);
ok('工具名全局唯一（重名会让模型端 400）', dupTools.length === 0,
  dupTools.map(([t, v]) => t + ' ← ' + v.join('/')).join('；') || owners.size + ' 个工具名无重名');

// 与门禁白名单交叉验证（check-plugins.mjs 的 CURRENT_TOOLS）
let whitelist = [];
try {
  const src = fs.readFileSync(path.join(ROOT, '_probe', 'check-plugins.mjs'), 'utf8');
  const m = src.match(/const CURRENT_TOOLS = \[([\s\S]*?)\];/);
  if (m) whitelist = [...m[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((x) => x[1]);
} catch (e) { /* 下面会判红 */ }
ok('能从 check-plugins.mjs 解析 CURRENT_TOOLS', whitelist.length > 0);
const missingTools = whitelist.filter((t) => !owners.has(t));
ok('门禁白名单里的工具名都能在 getTools()/动态定义里发现', missingTools.length === 0,
  missingTools.join(', ') || whitelist.length + ' 个全部命中');
const extraTools = [...owners.keys()].filter((t) => !whitelist.includes(t));
if (extraTools.length) info('getTools() 有、白名单没有（默认关插件或动态工具，允许）：' + extraTools.join(', '));

// 插件类能力至少要有一个「实现面」：工具 / 钩子 / 生命周期
const HOOKS = ['onInit', 'onStart', 'onStop', 'onUserInput', 'onLLMRequest', 'onLLMResponse', 'onTTSText', 'onTTSStart', 'onTTSEnd'];
const hollowPlugins = [];
for (const cap of CAPABILITIES.filter((c) => c.kind === 'plugin')) {
  const dir = path.join(PLUGINS, cap.key);
  const metaPath = path.join(dir, 'metadata.json');
  if (!fs.existsSync(metaPath)) continue;
  const meta = readJson(metaPath, {});
  if (meta.lang === 'python') continue;
  let inst;
  try {
    const mod = require(path.join(dir, meta.main || 'index.js'));
    const named = (mod && typeof mod === 'object')
      ? Object.keys(mod).map((k) => mod[k]).find((v) => typeof v === 'function') : null;
    const Cls = (typeof mod === 'function') ? mod : (mod && mod.default) || named || mod;
    inst = new Cls(meta, stubContext);
  } catch (e) { continue; } // 已在 loadErrors 报
  const hasHook = HOOKS.some((h) => typeof inst[h] === 'function' && inst[h] !== Plugin.prototype[h]);
  const hasTools = (pluginTools.get(cap.key) || []).length > 0;
  if (!hasHook && !hasTools) hollowPlugins.push(cap.key);
}
ok('每个插件能力都有实现面（工具或钩子）', hollowPlugins.length === 0, hollowPlugins.join(', ') || '全过');

// ────────────────────────────────────────────────────────────────────────────
console.log('[4/4] 治理台账（只打印，不判红）');
// 4a 已声明但无 doctor 项
let doctorSrc = '';
try { doctorSrc = fs.readFileSync(path.join(ROOT, 'pet-runtime', 'tools', 'doctor.mjs'), 'utf8'); } catch (e) { /* 台账降级 */ }
const doctorLabels = [...doctorSrc.matchAll(/add\([^,]+,\s*'([^']+)'/g)].map((m) => m[1]);
// doctor 的检查项是「健康链」不是「开关清单」，只有一部分能力有专属项。
// 这里人工把能对上的固定下来（宽松子串匹配会把「记忆/视觉」这类通用词误算成覆盖）。
const DOCTOR_ALIASES = {
  'voice.tts': ['语音合成 TTS', '语音播放'],
  'voice.asr': ['语音识别 ASR', '情绪识别 SER'],
  'voice.cowatch': ['一起看·耳朵', '情绪弧线'],
  'voice.barge_in': ['打断延迟'],
  'proactive.quiet': ['静默模式'],
  'proactive.alive_state': ['活着感'],
  'proactive.companion_health': ['陪伴时长'],
  'proactive.persona_guard': ['人设漂移'],
  'proactive.watch_screen': ['声学理解'],
  'memory.memos': ['MemOS 记忆', 'MemOS 感知', 'MemOS 嵌入', '嵌入服务 8090', 'MemOS 8003'],
  'svc.live_dock': ['直播对接'],
  'svc.control': ['控制口 8103'],
  'svc.devtools': ['桌面窗口'],
  'ui.subtitle_window': ['字幕独立窗'],
};
function doctorCovered(cap) {
  const aliases = DOCTOR_ALIASES[cap.id];
  if (aliases && aliases.some((a) => doctorLabels.some((l) => l === a || l.includes(a)))) return true;
  const strict = [cap.key, cap.port && String(cap.port), cap.impl && path.basename(cap.impl)].filter(Boolean);
  return strict.some((t) => hasToken(doctorSrc, t));
}
const noDoctor = CAPABILITIES.filter((c) => !doctorCovered(c)).map((c) => c.id);

// 4b 已声明但门禁测试没引用（扫 _probe 下所有测试源码）
let probeText = '';
try {
  for (const f of fs.readdirSync(path.join(ROOT, '_probe'))) {
    if (!/\.(mjs|cjs|js|py)$/.test(f)) continue;
    if (f === 'test-capability-coverage.cjs') continue;
    probeText += '\n' + fs.readFileSync(path.join(ROOT, '_probe', f), 'utf8');
  }
} catch (e) { /* 台账降级 */ }
const noGate = CAPABILITIES.filter((c) => {
  const cands = [c.key, c.port && String(c.port), c.impl && path.basename(c.impl),
    c.key && String(c.key).split('/').pop()].filter(Boolean);
  return !cands.some((t) => probeText.includes(t));
}).map((c) => c.id);

// 4c config 里有、代码在读、但注册表没声明（「能改但 UI 看不到」的真正缺口）
const declaredKeys = new Set(CAPABILITIES.filter((c) => c.kind === 'config').map((c) => c.key));
const allLeaves = flattenKeys(config).filter((k) => !k.startsWith('_deprecated.'));
const SWITCHISH = /(enabled|disabled|quiet|muted|^auto|_auto|use_|show_|hide_|remember|enable_limit)/i;
const undeclaredSwitch = allLeaves.filter((k) => SWITCHISH.test(k) && !declaredKeys.has(k));
const knownDead = new Set(Object.keys(config._deprecated || {}).concat([
  'tools.enabled', 'tools.auto_reload', 'rag.enabled', 'rag.url', 'ui.auto_show_chat_on_text_mode',
]));
const undeclaredWithConsumer = undeclaredSwitch.filter((k) => !knownDead.has(k) && consumersOf(k).length > 0);
const undeclaredDead = undeclaredSwitch.filter((k) => knownDead.has(k));

// 4d plugin_config.enabled 第二道闸（同一个插件三个开关）
const doubleGate = [];
for (const rel of enabled) {
  const f = path.join(PLUGINS, rel, 'plugin_config.json');
  const cfg = readJson(f, null);
  if (!cfg || typeof cfg !== 'object') continue;
  const raw = cfg.enabled && typeof cfg.enabled === 'object' && 'value' in cfg.enabled ? cfg.enabled.value : cfg.enabled;
  if (raw !== undefined) doubleGate.push(rel + '=' + JSON.stringify(raw));
}

console.log('  · 无 doctor 项：' + noDoctor.length + ' 条' + (noDoctor.length ? '（' + noDoctor.join(', ') + '）' : ''));
console.log('  · 无门禁测试引用：' + noGate.length + ' 条' + (noGate.length ? '（' + noGate.join(', ') + '）' : ''));
console.log('  · 未声明但代码在读的开关：' + undeclaredWithConsumer.length + ' 条'
  + (undeclaredWithConsumer.length ? '（' + undeclaredWithConsumer.join(', ') + '）' : ''));
console.log('  · 已标注死键（不算缺口）：' + undeclaredDead.length + ' 条');
console.log('  · plugin_config.enabled 第二道闸：' + doubleGate.length + ' 个插件'
  + (doubleGate.length ? '（' + doubleGate.join(', ') + '）' : ''));

// ── E2（2026-11-22）：能力证据 ────────────────────────────────────────────
// 能力可以声明 `evidence: {doctor?: string, tests?: string[]}`。
// 判据：**声明的证据必须真实存在**（测试文件在盘上、doctor 项名在 doctor.mjs 里）。
// 覆盖率只打印不判红 —— 30 条能力一次性补全不现实，先把「声明了就必须真」守住。
{
  let doctorSrc = '';
  try { doctorSrc = fs.readFileSync(path.join(ROOT, 'pet-runtime', 'tools', 'doctor.mjs'), 'utf8'); } catch (e) { doctorSrc = ''; }
  const declared = CAPABILITIES.filter((c) => c.evidence && (c.evidence.tests || c.evidence.doctor));
  let missing = 0;
  for (const c of declared) {
    for (const rel of (c.evidence.tests || [])) {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) { missing += 1; console.error('  ✗ 能力证据缺失：' + c.id + ' → ' + rel); }
    }
    if (c.evidence.doctor && !doctorSrc.includes("'" + c.evidence.doctor + "'")) {
      missing += 1; console.error('  ✗ 能力证据缺失：' + c.id + ' → doctor 项「' + c.evidence.doctor + '」');
    }
  }
  ok('声明了 evidence 的能力，证据全部真实存在', missing === 0, declared.length + ' 条声明 / 缺失 ' + missing);
  console.log('  · 声明了 evidence 的能力：' + declared.length + ' / ' + CAPABILITIES.length);
}

console.log('');
console.log('  能力总数：' + CAPABILITIES.length
  + '（config ' + CAPABILITIES.filter((c) => c.kind === 'config').length
  + ' / plugin ' + CAPABILITIES.filter((c) => c.kind === 'plugin').length
  + ' / port ' + CAPABILITIES.filter((c) => c.kind === 'port').length + '）');
if (fail > 0) {
  console.log('FAIL 能力覆盖：' + fail + ' 项未过');
  process.exit(1);
}
console.log('PASS 能力覆盖：' + pass + ' 项断言全过');
process.exit(0);
