#!/usr/bin/env node
/**
 * _probe/test-perf-ui.cjs —— 「演出」页契约 + 总览去重（2026-11-25 P3b，ADR-015 §4.5）
 *
 * 两类断言：
 *   A. 源码契约（不启 Electron）：页面结构、入口唯一性、开关走白名单、读哪个后端字段；
 *   B. 纯函数行为：按 __PERF_UI_PURE_START__/END__ 标记提取后直接执行
 *      （12 段就画 12 个按钮 / 缺进度不写 0 / 「为什么没演」读哪个 reason）。
 *
 * 用法：node _probe/test-perf-ui.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const HTML = path.join(LIVE, 'control-v2.html');
const RENDERER = path.join(LIVE, 'control-v2-renderer.js');
const MAIN = path.join(LIVE, 'main.js');

const html = fs.readFileSync(HTML, 'utf8');
const source = fs.readFileSync(RENDERER, 'utf8');
const mainSrc = fs.readFileSync(MAIN, 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
  else { fail += 1; failures.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// 按页面切片（<section class="page ...）——避免全局 includes 把别的页误判成本页
function pageSlice(id) {
  const m = new RegExp(`<section class="page[^"]*" id="${id}"`).exec(html);
  if (!m) return '';
  const start = m.index;
  const next = html.indexOf('<section class="page', start + 10);
  return html.slice(start, next < 0 ? html.length : next);
}

// 纯函数块
const pureMatch = source.match(/\/\/ __PERF_UI_PURE_START__([\s\S]*?)\/\/ __PERF_UI_PURE_END__/);
if (!pureMatch) {
  console.error('找不到 __PERF_UI_PURE_START__/END__ 纯函数块');
  process.exit(1);
}
const pure = new Function(`${pureMatch[1]}
return { perfEscape, buildSceneButtons, buildPerformanceOptions, perfNumber, perfFirstNumber,
  formatRemainingSeconds, summarizePerformanceDebug, readProgramBudgetLeft, normalizeProgramRows, buildProgramRows };`)();

const overview = pageSlice('overview');
const perform = pageSlice('perform');

console.log('演出页契约 + 总览去重');
console.log('');

// ═══ A. 页面结构 ═══════════════════════════════════════════════════════
console.log('[页面结构]');
check('导航有 data-page="perform"', /class="nav" data-page="perform"/.test(html));
check('导航项文案是「演出」', /data-page="perform"[\s\S]{0,1500}<span class="nav-text">演出<\/span>/.test(html));
check('存在 <section class="page" id="perform">', /<section class="page[^"]*" id="perform"/.test(html));
check('总览页切片取到了（不误判为整页）', overview.length > 0 && overview.length < html.length, 'len=' + overview.length);
check('总览页不再有 perf-pick', !/id="perf-pick"/.test(overview) && !/id="perf-pick"/.test(html));
check('总览页不再有 perf-play / perf-stop',
  !/id="perf-play"/.test(overview) && !/id="perf-stop"/.test(overview));
check('总览页保留「自动演长戏」开关', /id="perf-auto-switch"/.test(overview));
check('总览页保留一行状态（perf-state）', /id="perf-state"/.test(overview));
check('总览页有去演出页的入口', /data-go="perform"/.test(overview));

check('演出页有场景容器 #perform-scenes（复用 scene-grid）', /id="perform-scenes"/.test(perform) && /class="scene-grid" id="perform-scenes"/.test(perform));
check('演出页有长戏下拉 #perform-pick', /id="perform-pick"/.test(perform));
check('演出页有长戏「演 / 停」按钮', /id="perform-play"/.test(perform) && /id="perform-stop"/.test(perform));
check('演出页有节目单容器 #perform-programs', /id="perform-programs"/.test(perform));
check('演出页有当日预算余额 #perform-budget', /id="perform-budget"/.test(perform));
check('演出页有三个开关（情绪微动作 / 自动演长戏 / 节目单自动）',
  /id="perform-choreo-switch"/.test(perform) && /id="perform-auto-switch"/.test(perform) && /id="perform-program-switch"/.test(perform));
check('演出页有实时状态三件（在演 / 剩余秒数 / 为什么没演）',
  /id="perform-state"/.test(perform) && /id="perform-remaining"/.test(perform) && /id="perform-skip"/.test(perform));
check('演出页开关用现有 .switch 组件（不引新框架）',
  (perform.match(/class="switch"/g) || []).length >= 3);
check('长戏控件在演出页有且只有一份（总览已无）',
  (html.match(/id="perform-pick"/g) || []).length === 1 && (html.match(/id="perf-pick"/g) || []).length === 0);

// ═══ B. 渲染层接线 ═════════════════════════════════════════════════════
console.log('');
console.log('[渲染层接线]');
check('场景列表来自 petBody.listScenes()', /listScenes/.test(source));
check('长戏列表来自 __petPerformance.list()', /__petPerformance \? window\.__petPerformance\.list\(\)/.test(source));
check('节目单读 listPrograms', /listPrograms/.test(source));
check('节目单未接线时明确写「节目单未接线」', /节目单未接线/.test(source));
check('「为什么没演」读 performanceDebug()', /performanceDebug/.test(source));
check('预算余额读 performanceDebug().program.budgetLeft', /readProgramBudgetLeft[\s\S]{0,400}p\.budgetLeft/.test(source));
check('演出页初始化入口 loadPerformPage 存在并被 switchPage 调用',
  /async function loadPerformPage\(\)/.test(source) && /if \(pageId === 'perform'\) loadPerformPage\(\)/.test(source));
check('3 秒心跳只在总览 / 演出页可见时跑', /function tickPerfState\(\)[\s\S]{0,300}page\.id === 'overview'[\s\S]{0,200}page\.id === 'perform'/.test(source));
check('场景点击走 8103 /perform', /postPerform[\s\S]{0,400}8103\/perform/.test(source) || /127\.0\.0\.1:8103\/perform/.test(source));
check('场景点击 toast「已抢占当前表演」', /已抢占当前表演/.test(source));
check('皮套页场景按钮复用同一段 performScene（单一代码路径）',
  /scene-box'\)\.addEventListener\('click'[\s\S]{0,260}performScene\(/.test(source));
check('渲染层不再有旧的总览试演控件引用', !/perf-pick|perf-play|perf-stop/.test(source));

// ═══ C. 开关必须走白名单（control:set-config-value）════════════════════
console.log('');
console.log('[开关白名单]');
check('togglePerformanceCapability 走 api.setConfigValue（能力页同一 IPC）',
  /async function togglePerformanceCapability[\s\S]{0,400}api\.setConfigValue\(key, on\)/.test(source));
check('三个键都在 PERF_SWITCH_BOXES（两页同名开关一起拨）',
  ['ui.petbody_choreo', 'ui.petbody_perf_auto', 'performance.program.enabled']
    .every((k) => source.includes(`'${k}':`) && new RegExp(`'${k.replace(/\./g, '\\.')}': \\[`).test(source)));
check('节目单开关绑到 performance.program.enabled',
  /bindPerfSwitch\('perform-program-switch', 'performance\.program\.enabled'/.test(source));
check('开关状态读能力注册表（api.capabilities → valueOf）',
  /async function refreshPerfSwitchState\(\)[\s\S]{0,700}api\.capabilities\(\)/.test(source));
check('不直接手写 config 副本当开关真源（只在对齐时 set(config, path, on)）',
  !/config\.ui\.petbody_(choreo|perf_auto)\s*=[^=]/.test(source));

// ═══ D. 纯函数行为 ═════════════════════════════════════════════════════
console.log('');
console.log('[纯函数]');
const scenes12 = ['打招呼', '撒娇', '生气', '难过', '得意', '伸懒腰', '鼓掌', '想事情', '点头', '晚安', '鞠躬', '指一指'];
const sceneHtml = pure.buildSceneButtons(scenes12);
check('12 段场景 → 12 个按钮', (sceneHtml.match(/data-scene="/g) || []).length === 12);
check('场景按钮带现有 btn 类', /class="btn"/.test(sceneHtml));
check('场景名转义（不把 < > 拼进 DOM）',
  pure.buildSceneButtons(['<b>x</b>']).includes('&lt;b&gt;x&lt;/b&gt;'));
check('空数组 / null 不抛错且返回空串',
  pure.buildSceneButtons([]) === '' && pure.buildSceneButtons(null) === '');

const perf15 = Array.from({ length: 15 }, (_, i) => ({ key: `0${i + 1}-x`, title: `第${i + 1}段`, duration: 20 + i }));
const options = pure.buildPerformanceOptions(perf15);
check('15 段长戏 → 15 个 option', (options.match(/<option /g) || []).length === 15);
check('option 文案 = title · 秒数', /第1段 · 20s/.test(options));
check('秒数缺失不写 0s', pure.buildPerformanceOptions([{ key: 'k', title: 't' }]) === '<option value="k">t</option>',
  pure.buildPerformanceOptions([{ key: 'k', title: 't' }]));

check('未在演时剩余秒数是 —', pure.formatRemainingSeconds({ active: false }) === '—');
check('在演 + 进度齐全 → 剩余秒数', pure.formatRemainingSeconds({ active: true, t: 15, duration: 20.2 }) === '5 秒',
  pure.formatRemainingSeconds({ active: true, t: 15, duration: 20.2 }));
check('缺进度字段 → —（不四舍五入成 0 秒）', pure.formatRemainingSeconds({ active: true, key: 'x' }) === '—');

const dbDir = { director: { mode: 'enforce', lastDecision: { reason: 'cooldown' } }, program: { budgetLeft: 7 } };
const sum1 = pure.summarizePerformanceDebug(dbDir);
check('「为什么没演」取 director.lastDecision.reason', sum1.reason === 'cooldown' && /cooldown/.test(sum1.line), sum1.line);
check('导演关闭时明说不会自动演',
  /不会自动演/.test(pure.summarizePerformanceDebug({ director: { mode: 'off' } }).line));
check('没有决策时给中性文案（不编造理由）',
  pure.summarizePerformanceDebug({ director: { mode: 'enforce' } }).reason === '');
check('lastDecision 缺失时退到 scheduler.lastEvent',
  pure.summarizePerformanceDebug({ scheduler: { lastEvent: { reason: 'busy' } } }).reason === 'busy');

check('预算余额读 program.budgetLeft', pure.readProgramBudgetLeft(dbDir) === 7);
check('没有 program 字段 → null（显示「未接线」）', pure.readProgramBudgetLeft({ director: {} }) === null);
check('兼容嵌套 budget.left.plays', pure.readProgramBudgetLeft({ program: { budget: { left: { plays: 3 } } } }) === 3);
check('预算为 0 是合法值（不是缺失）', pure.readProgramBudgetLeft({ program: { budgetLeft: 0 } }) === 0);

const rows = pure.normalizeProgramRows([
  { id: 'p1', title: '晨间', durationSec: 42 },
  { key: 'p2', name: '黄昏', durationMs: 65000 },
  { title: '没有 id 的行要丢掉' },
]);
check('节目单行宽容解析（id/key，durationSec/durationMs）',
  rows.length === 2 && rows[0].seconds === 42 && rows[1].seconds === 65, JSON.stringify(rows));
const p3aRows = pure.normalizeProgramRows({ items: [{ id: 'draft-01', title: '晨间连戏', beats: [{ maxMs: 30000 }, { maxMs: 25500 }] }] });
check('P3a 的 {items:[...]} 形状可解析', p3aRows.length === 1 && p3aRows[0].id === 'draft-01');
check('节目单时长按 beats.maxMs 求和', p3aRows[0].seconds === 56, String(p3aRows[0].seconds));
check('节目单未接线文案', /未接线/.test(pure.buildProgramRows([], false)));
check('节目单空列表文案', /空的/.test(pure.buildProgramRows([], true)));
check('节目单每行有「试演」按钮与 data-program',
  pure.buildProgramRows(rows, true).includes('data-program="p1"') && pure.buildProgramRows(rows, true).includes('试演'));
check('节目单试演走 8004 playProgram（8103 /perform 还没扩 kind=program）',
  /async function performProgram[\s\S]{0,400}petBody\.playProgram/.test(source));
check('节目单三种拒绝理由有中文解释（disabled / scheduler-off / budget）',
  /PROGRAM_REASON_TEXT[\s\S]{0,400}'scheduler-off'[\s\S]{0,200}budget/.test(source));

// ═══ E. 托盘段名单一真源 ═══════════════════════════════════════════════
console.log('');
console.log('[托盘段名]');
check('托盘从渲染层取 listPerformances', /listPerformances/.test(mainSrc));
check('取不到时 log「[tray] 段名回退硬编码」', mainSrc.includes("[tray] 段名回退硬编码"));
check('菜单表可变（let PERFORMANCE_MENU）+ 硬编码只作兜底',
  /let PERFORMANCE_MENU = PERFORMANCE_MENU_FALLBACK\.slice\(\)/.test(mainSrc));
check('取到后重建托盘（rebuild）', /loadPerformanceMenuFromRenderer[\s\S]{0,1200}rebuild\(\)/.test(mainSrc));
check('托盘菜单用 PERFORMANCE_MENU 渲染子菜单', /PERFORMANCE_MENU\.map\(\(\[key, label\]\)/.test(mainSrc));

console.log('');
console.log(`PASS ${pass} / FAIL ${fail}`);
if (failures.length) console.log('失败项：' + failures.join(', '));
if (pass === 0) { console.error('PASS=0：没有任何断言真正执行，视为失败'); process.exitCode = 1; }
else process.exitCode = fail === 0 ? 0 : 1;
