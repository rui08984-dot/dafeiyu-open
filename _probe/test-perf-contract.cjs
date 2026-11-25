#!/usr/bin/env node
/**
 * _probe/test-perf-contract.cjs —— 演出编排的前后端契约（2026-11-25 P0.5）
 *
 * 为什么要有它（审计附录 A / ADR-015 §4）：
 *   能力页写「0.45 / 4 分钟 / 15 分钟 / 6 段」，代码是 0.35/3/6/12 —— 契约漂移了半年没人发现；
 *   情绪增益滑杆读 status.options，而运行时从不返回 options —— 滑杆恒被禁用。
 *   这一组把「键存在 + 默认值一致 + note 不含魔数 + 白名单覆盖 + 滑杆两套字段兼容」钉死。
 *
 * 用法：node _probe/test-perf-contract.cjs
 * 退出码：0 全过 / 1 有失败
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE2D = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const read = (p) => fs.readFileSync(p, 'utf8');

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

(async () => {
  const { pathToFileURL } = require('node:url');
  const { PERFORMANCE_DEFAULTS, DIRECTOR_DEFAULTS } = await import(
    pathToFileURL(path.join(ROOT, 'pet-runtime', 'desktop', 'perf', 'director.mjs')).href
  );
  const config = JSON.parse(read(path.join(LIVE2D, 'config.json')));
  const { CAPABILITIES } = require(path.join(LIVE2D, 'js', 'core', 'capabilities.js'));
  const controlMain = read(path.join(LIVE2D, 'control-main.js'));
  const html = read(path.join(LIVE2D, 'control-v2.html'));
  const mainJs = read(path.join(LIVE2D, 'main.js'));
  const renderer = read(path.join(LIVE2D, 'control-v2-renderer.js'));
  const entry = read(path.join(ROOT, 'pet-runtime', 'desktop', 'petbody-entry.mjs'));
  const driver = read(path.join(LIVE2D, 'js', 'avatar', 'petbody', 'driver.js'));
  const accept = read(path.join(ROOT, '_probe', 'perf15-accept.mjs'));

  // ── ① config.json：P0 要求的键与默认值 ───────────────────────────────
  const perf = config.performance || {};
  eq('config.performance 存在', Boolean(config.performance), true);
  // P1（2026-11-25）契约变化：导演开闸（enabled=true + dry_run=false）。回滚保留键。
  eq('director.dry_run=false（P1 开闸）', perf.director && perf.director.dry_run, false);
  eq('director.enabled=true（P1 开闸）', perf.director && perf.director.enabled, true);
  eq('director.max_plays_per_day=40', perf.director && perf.director.max_plays_per_day, 40);
  eq('director.max_long_per_day=12', perf.director && perf.director.max_long_per_day, 12);
  eq('director.max_per_10min=2', perf.director && perf.director.max_per_10min, 2);
  eq('director.min_reply_rate=0.15', perf.director && perf.director.min_reply_rate, 0.15);
  eq('ambient.enabled=true', perf.ambient && perf.ambient.enabled, true);
  eq('ambient.scale=0.3', perf.ambient && perf.ambient.scale, 0.3);
  eq('program.enabled=true', perf.program && perf.program.enabled, true);
  eq('program.max_per_day=2', perf.program && perf.program.max_per_day, 2);
  eq('scheduler.enabled=true（P3 起默认开）', perf.scheduler && perf.scheduler.enabled, true);
  eq('writer.enabled=false', perf.writer && perf.writer.enabled, false);

  // ── ② 代码默认值必须与 config 一致（缺键时按代码默认）──────────────
  eq('代码默认 director.enabled 与 config 一致', DIRECTOR_DEFAULTS.enabled, perf.director.enabled);
  eq('代码默认 director.dry_run 与 config 一致', DIRECTOR_DEFAULTS.dry_run, perf.director.dry_run);
  eq('代码默认日预算与 config 一致', [
    DIRECTOR_DEFAULTS.max_plays_per_day, DIRECTOR_DEFAULTS.max_long_per_day, DIRECTOR_DEFAULTS.max_per_10min,
  ], [perf.director.max_plays_per_day, perf.director.max_long_per_day, perf.director.max_per_10min]);
  eq('代码默认 min_reply_rate 与 config 一致', DIRECTOR_DEFAULTS.min_reply_rate, perf.director.min_reply_rate);
  eq('代码默认 ambient 与 config 一致', [PERFORMANCE_DEFAULTS.ambient.enabled, PERFORMANCE_DEFAULTS.ambient.scale], [perf.ambient.enabled, perf.ambient.scale]);
  eq('代码默认 program 与 config 一致', [PERFORMANCE_DEFAULTS.program.enabled, PERFORMANCE_DEFAULTS.program.max_per_day], [perf.program.enabled, perf.program.max_per_day]);
  eq('代码默认 writer=false', PERFORMANCE_DEFAULTS.writer.enabled, false);
  eq('代码默认 scheduler=true（P3 起）', PERFORMANCE_DEFAULTS.scheduler.enabled, true);
  eq('代码默认 channel_overlay=false（P4，缺键即关）', PERFORMANCE_DEFAULTS.channel_overlay.enabled, false);

  // ── ③ 能力注册表：四项新开关 + note 去魔数 ──────────────────────────
  const byId = (id) => CAPABILITIES.find((c) => c.id === id);
  const expected = {
    'perf.scheduler': { key: 'performance.scheduler.enabled', def: true },
    'perf.director': { key: 'performance.director.enabled', def: true },
    'perf.writer': { key: 'performance.writer.enabled', def: false },
    'perf.ambient': { key: 'performance.ambient.enabled', def: true },
    'perf.program': { key: 'performance.program.enabled', def: true },
  };
  for (const [id, spec] of Object.entries(expected)) {
    const cap = byId(id);
    ok('能力项存在：' + id, Boolean(cap));
    if (!cap) continue;
    eq(id + ' key', cap.key, spec.key);
    eq(id + ' 默认值', cap.default, spec.def);
    eq(id + ' 分组', cap.group, '演出');
    eq(id + ' hot', cap.hot, true);
    eq(id + ' kind', cap.kind, 'config');
    ok(id + ' 有 note', typeof cap.note === 'string' && cap.note.length > 8);
  }
  {
    const cap = byId('perf.long_v2');
    ok('perf.long_v2 仍存在', Boolean(cap));
    const note = (cap && cap.note) || '';
    ok('perf.long_v2 note 不再写死节流数字', !/(0\.45|4\s*分钟|15\s*分钟|6\s*段|4min|15min)/.test(note), note);
    ok('perf.long_v2 note 指向 choreo-auto 默认值', /choreo-auto/.test(note), note);
    eq('perf.long_v2 默认开（与旧行为一致）', cap.default, true);
  }
  {
    const writer = byId('perf.writer');
    ok('perf.writer 能力存在', Boolean(writer));
    ok('perf.writer note 写明 P4 才接线', writer && /P4 才接线/.test(writer.note), writer && writer.note);
    ok('perf.writer 默认 false', writer && writer.default === false);
  }
  {
    const keys = CAPABILITIES.filter((c) => c.kind === 'config').map((c) => c.key);
    eq('能力注册表 config 键无重复', keys.length, new Set(keys).size);
    const declared = new Set(keys);
    const missing = Object.values(expected).map((s) => s.key).filter((k) => !declared.has(k));
    eq('四项新键都在能力注册表（白名单自动覆盖）', missing, []);
  }

  // ── ④ control:set-config-value 白名单（从 CAPABILITIES 派生）─────────
  ok('白名单仍从 CAPABILITIES 派生（kind=config + key）',
    /CAPABILITIES\.find\(\(c\) => c\.kind === 'config' && c\.key === key\)/.test(controlMain));
  ok('未声明键会抛错（不是静默吞）', /未声明的配置键/.test(controlMain));
  ok('类型校验按 cap.default 走', /const t = typeof cap\.default/.test(controlMain));
  ok('逐级建对象写 patch（不做字符串拼接）', /String\(key\)\.split\('\.'\)/.test(controlMain));

  // ── ⑤ 三处节流文案去魔数（capabilities / html / main.js）───────────
  const perfRow = (() => {
    const i = html.indexOf('perf-auto-switch');
    return i < 0 ? '' : html.slice(Math.max(0, i - 500), i + 200);
  })();
  ok('控制中心演出页找不到旧数字', !/(4\s*分钟|15\s*分钟|6\s*段)/.test(perfRow), perfRow.slice(0, 120));
  ok('托盘文案不再写死冷却数字', !/(4\s*分钟冷却|同段\s*15\s*分钟|单会话\s*6\s*段)/.test(mainJs));
  ok('托盘文案指向 choreo-auto 默认值', /choreo-auto\.mjs/.test(mainJs));

  // ── ⑥ 情绪增益滑杆：status.gain.value 与 options 双兼容 ─────────────
  const pureMatch = renderer.match(/\/\/ __CONTROL_V2_PURE_START__([\s\S]*?)\/\/ __CONTROL_V2_PURE_END__/);
  ok('control-v2-renderer 纯函数块存在', Boolean(pureMatch));
  if (pureMatch) {
    const factory = new Function(`${pureMatch[1]}\nreturn { readEmotionGainOption };`);
    const { readEmotionGainOption } = factory();
    eq('新契约：status.gain.value 可用（1.2）', readEmotionGainOption({ gain: { value: 1.2 } }), 1.2);
    eq('0 是合法值（面瘫）', readEmotionGainOption({ gain: { value: 0 } }), 0);
    eq('旧契约：options.emotionGain 仍兼容', readEmotionGainOption({ options: { emotionGain: 0.8 } }), 0.8);
    eq('gain.value 优先于 options', readEmotionGainOption({ gain: { value: 1.1 }, options: { emotionGain: 0.2 } }), 1.1);
    eq('顶层 emotionGain 仍不认（防止随手塞值）', readEmotionGainOption({ emotionGain: 1 }), null);
    eq('两者都没有 → 不可用', readEmotionGainOption({ active: true }), null);
    ok('滑杆可用性绘制仍由纯函数驱动', /paintEmotionGainAvailability[\s\S]{0,300}readEmotionGainOption/.test(renderer));
  }
  ok('entry 仍产出 status.gain', /status\.gain = \{[\s\S]{0,300}value:/.test(entry));
  ok('entry 补 status.options.emotionGain（旧 UI 不残废）', /status\.options = Object\.assign\(\{\}, status\.options \|\| \{\}, \{ emotionGain: status\.gain\.value \}\)/.test(entry));

  // ── ⑦ performanceDebug 只读快照 + 导演接线 ─────────────────────────
  ok('entry 暴露 performanceDebug()', /performanceDebug\(\) \{/.test(entry));
  for (const key of ['presence', 'director', 'poolStats', 'budget', 'syncCoverage', 'lastDecision', 'ambient']) {
    ok('performanceDebug 含 ' + key, new RegExp('\\b' + key + '\\b').test(entry.slice(entry.indexOf('performanceDebug() {'), entry.indexOf('performanceDebug() {') + 3500)));
  }
  // 契约变更（2026-11-25 P2b）：syncCoverage 不再是写死的 0 —— 有 perf-sync.json 时
  // 必须实读（loaded>0），缺文件时本该诚实为 0。两种环境都要覆盖，不能只钉一种。
  const syncFile = path.join(ROOT, 'pet-runtime', 'data', 'perf-sync.json');
  if (fs.existsSync(syncFile)) {
    ok('syncCoverage 实读 perf-sync（有文件 → loadSync，非硬编码 0）',
      /load(?:Perf)?Sync\s*\(/.test(entry) && !/syncCoverage:\s*0\b/.test(entry));
  } else {
    ok('syncCoverage 在无 perf-sync 时诚实为 0', /syncCoverage:\s*0\b/.test(entry));
  }
  ok('performanceDebug 暴露 ambient:{state,dwellMs,amp}', /ambient: \(\(\) => \{[\s\S]{0,600}state: snap\.state[\s\S]{0,200}amp:/.test(entry));
  ok('performanceDebug 预算分 spentAuto/spentManual', /spentAuto:/.test(entry) && /spentManual:/.test(entry));
  ok('v2 表情黑名单排除素材占位「加载」', /V2_FACE_BLOCKLIST/.test(entry) && /'加载'/.test(entry));
  ok('entry 暴露 setPerformanceConfig', /setPerformanceConfig\(raw\) \{/.test(entry));
  ok('driver 初始化时下发 performance 配置', /__petPerformanceConfig = perfCfg/.test(driver) && /body\.setPerformanceConfig\(perfCfg\)/.test(driver));
  eq('导演接到三个 v2 通道（T1/T2/T3）', (entry.match(/directorDecideFor\('v2'/g) || []).length, 3);
  eq('导演接到 clip 两个通道（peak/idle）', (entry.match(/directorDecideFor\('clip'/g) || []).length, 2);

  // ── ⑧ 验收脚本收尾不再污染生产冷却 ─────────────────────────────────
  ok('perf15-accept 收尾调 resetPerformanceAuto', /resetPerformanceAuto/.test(accept));
  ok('perf15-accept 头部警告「不要在用户正在使用时跑」', /不要在用户正在使用时跑/.test(accept));
  ok('entry 保留 resetPerformanceAuto 入口', /resetPerformanceAuto\(\) \{ perfAuto\.reset\(\);/.test(entry));

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 演出契约：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 测试崩溃：' + ((e && e.stack) || e));
  process.exit(1);
});
