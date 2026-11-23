#!/usr/bin/env node
/**
 * _probe/test-control-v2-display.cjs — 控制面板「静默空转」显示逻辑回归（2026-11-21）
 *
 * 只测渲染层纯函数（不启动 Electron）：
 *   ① 演出进度字段缺失 → 显示「—」，不再出现 0/0；数据到达后正常显示；
 *   ② 字段名兼容 t/duration 与 elapsed/total；
 *   ③ 情绪增益只在 status.options.emotionGain 存在时算「可用」，
 *      refreshPerformanceState 也确实把可用性画到控件上。
 *
 * 纯函数块由 control-v2-renderer.js 里的 __CONTROL_V2_PURE_START__/END__ 标记界定，
 * 本测试按标记提取后执行，避免把整个 IIFE 拉进 Node。
 *
 * 用法：node _probe/test-control-v2-display.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'control-v2-renderer.js');
const source = fs.readFileSync(RENDERER, 'utf8');

const match = source.match(/\/\/ __CONTROL_V2_PURE_START__([\s\S]*?)\/\/ __CONTROL_V2_PURE_END__/);
if (!match) {
    console.error('找不到 __CONTROL_V2_PURE_START__/END__ 纯函数块');
    process.exit(1);
}

const factory = new Function(`${match[1]}\nreturn { firstFiniteNumber, formatPerformanceProgress, readEmotionGainOption, isDeprecatedPluginConfigKey };`);
const pure = factory();

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) {
        pass += 1;
        console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
    } else {
        fail += 1;
        failures.push(name);
        console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    }
}

const activeLine = (st) => `正在演：${st.title || st.key}（到 ${pure.formatPerformanceProgress(st)}）`;

console.log('控制面板显示逻辑回归');
console.log('');

// ① 缺失字段不再变 0/0
const missing = { active: true, key: 'idle', title: '发呆' };
const missingLine = activeLine(missing);
check('字段全缺失 → —/— 秒', pure.formatPerformanceProgress(missing) === '—/— 秒',
    pure.formatPerformanceProgress(missing));
check('字段全缺失时整行不出现 0/0', !missingLine.includes('0/0'), missingLine);
check('非对象状态返回空串', pure.formatPerformanceProgress(null) === '' && pure.formatPerformanceProgress(undefined) === '');

// ② 两种字段命名 + 单边缺失
check('t/duration → 3/10 秒', pure.formatPerformanceProgress({ t: 3, duration: 10 }) === '3/10 秒',
    pure.formatPerformanceProgress({ t: 3, duration: 10 }));
check('elapsed/total → 2/8 秒', pure.formatPerformanceProgress({ elapsed: 2.4, total: 8 }) === '2/8 秒',
    pure.formatPerformanceProgress({ elapsed: 2.4, total: 8 }));
check('只有 t → 3/— 秒', pure.formatPerformanceProgress({ t: 3 }) === '3/— 秒',
    pure.formatPerformanceProgress({ t: 3 }));
check('只有 duration → —/10 秒', pure.formatPerformanceProgress({ duration: 10 }) === '—/10 秒',
    pure.formatPerformanceProgress({ duration: 10 }));
check('真实 0 值仍显示 0/0（区分「真 0」与「缺失」）',
    pure.formatPerformanceProgress({ t: 0, duration: 0 }) === '0/0 秒',
    pure.formatPerformanceProgress({ t: 0, duration: 0 }));
check('t 优先于 elapsed（同名并存）',
    pure.formatPerformanceProgress({ t: 1, elapsed: 9, duration: 10, total: 99 }) === '1/10 秒',
    pure.formatPerformanceProgress({ t: 1, elapsed: 9, duration: 10, total: 99 }));
check('数字字符串可解析', pure.formatPerformanceProgress({ t: '2', duration: '5' }) === '2/5 秒');

// ③ 情绪增益可用性
check('options.emotionGain=0 算可用（0 是合法值）',
    pure.readEmotionGainOption({ options: { emotionGain: 0 } }) === 0,
    String(pure.readEmotionGainOption({ options: { emotionGain: 0 } })));
check('options.emotionGain=1.2 算可用',
    pure.readEmotionGainOption({ options: { emotionGain: 1.2 } }) === 1.2);
check('没有 options → 不可用', pure.readEmotionGainOption({ active: false }) === null);
check('options 为空 → 不可用', pure.readEmotionGainOption({ options: {} }) === null);
check('options.emotionGain 非数字 → 不可用',
    pure.readEmotionGainOption({ options: { emotionGain: 'abc' } }) === null);
check('顶层 emotionGain 不算（只认 options.emotionGain）',
    pure.readEmotionGainOption({ emotionGain: 1 }) === null);

// 渲染层接线检查：refreshPerformanceState 必须用纯函数，且确实调用可用性绘制
const refreshBlock = source.slice(source.indexOf('async function refreshPerformanceState'),
    source.indexOf('// 情绪增益滑杆的可用性'));
check('refreshPerformanceState 使用 formatPerformanceProgress',
    refreshBlock.includes('formatPerformanceProgress(st)'));
check('refreshPerformanceState 不再 Number(st.t) || 0',
    !refreshBlock.includes('Number(st.t) || 0') && !refreshBlock.includes('Number(st.duration) || 0'));
check('refreshPerformanceState 调用 paintEmotionGainAvailability',
    refreshBlock.includes('paintEmotionGainAvailability(st)'));
check('情绪增益 change 只在 emotionGainLive 时下发',
    /addEventListener\('change'[\s\S]{0,260}if \(!emotionGainLive\) return;/.test(source));

// ── ④ 统一管辖（2026-11-21）：入口唯一性 + 总览/托盘读实时状态 ─────────────
// 这一组是源码级契约检查：删行最危险的后果是「功能丢了入口」和「UI 停留在旧语义」，
// 两者都能在源码里钉死。真点击/真写盘由 ui-button-accept / capabilities-ui-accept 覆盖。
const HTML = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'control-v2.html');
const MAIN = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'main.js');
const html = fs.readFileSync(HTML, 'utf8');
const mainSrc = fs.readFileSync(MAIN, 'utf8');

// ④a 插件页不再渲染启停开关；能力页插件开关必须还在
check('插件行不再渲染 data-plugin-enabled',
    !/data-plugin-enabled/.test(source));
check('能力页插件开关仍渲染（data-cap-plugin）',
    /it\.kind === 'plugin'[\s\S]{0,160}data-cap-plugin/.test(source));
check('插件页不再有启用/停用的 change 监听',
    !/setPluginEnabled\(input\.dataset\.pluginEnabled/.test(source));

// ④b 15 个重复布尔开关的 id 在 HTML 里一个都不能剩
const removedIds = [
    'quiet-mode-enabled', 'text-input-enabled', 'ptt-enabled', 'barge-enabled',
    'auto-vision', 'history-enabled', 'context-limit', 'temperature-enabled',
    'vision-enabled', 'subtitle-enabled', 'hide-model', 'auto-close-services',
    'latency-filler-enabled', 'petbody-framing-full', 'petbody-click-through',
];
const htmlLeftovers = removedIds.filter((id) => new RegExp(`id="${id}"`).test(html));
check('HTML 里被删的 15 个重复开关都不存在', htmlLeftovers.length === 0, JSON.stringify(htmlLeftovers));
// 值型参数必须保留（删开关不能顺手把参数删了）
const keptIds = ['max-messages', 'temperature', 'latency-filler-delay', 'tts-speed', 'petbody-width', 'petbody-mouth-gain'];
const keptMissing = keptIds.filter((id) => !new RegExp(`id="${id}"`).test(html));
check('数值型参数行保留（只删布尔开关）', keptMissing.length === 0, JSON.stringify(keptMissing));
// 分组容器还在（不能因为删行把布局/分组拆掉）
check('外观页仍保留 字幕与名称 / 皮套 / 对话行为 / 能力 四组',
    ['字幕与名称', '皮套', '对话行为', '能力（自动生成）'].every((t) => html.includes(t)));

// ④c 总览演出开关读能力注册表（与能力页同源），不再只读本地 config 副本
check('总览演出开关有 refreshPerfSwitchState（读 api.capabilities）',
    /async function refreshPerfSwitchState\(\)[\s\S]{0,600}api\.capabilities\(\)/.test(source));
check('切到总览时重读演出开关状态',
    /if \(pageId === 'overview'\) \{[\s\S]{0,400}refreshPerfSwitchState\(\)/.test(source));
check('总览演出开关写回走 control:set-config-value（同一 IPC）',
    /togglePerformanceCapability[\s\S]{0,500}api\.setConfigValue\(key, on\)/.test(source));
check('保存前按能力页权威值对齐本地副本（防面板缓存盖回）',
    /syncCapabilityOwnedValues\(\)[\s\S]{0,900}it\.configured !== true/.test(source));

// ④d 托盘：静默项读实时状态 + 写 8103；每次弹出前重建（原生 Menu 不能缓存）
check('托盘静默项读 global.__petQuiet（8103 /state 同一变量）',
    /readQuietLive[\s\S]{0,240}global\.__petQuiet/.test(mainSrc));
check('托盘静默项写 8103 /quiet（与面板同一入口）',
    /setQuietViaControl[\s\S]{0,700}path: '\/quiet'/.test(mainSrc));
check('托盘菜单 label 带当前态（开/关文字）',
    /静默模式：(开|关)/.test(mainSrc));
check('right-click 弹前先 rebuild（不展示旧勾选）',
    /petTray\.on\('right-click'[\s\S]{0,260}rebuild\(\)[\s\S]{0,260}popUpContextMenu\(\)/.test(mainSrc));
check('tray-popup IPC 也走重建钩子',
    /ipcMain\.on\('tray-popup'[\s\S]{0,400}petTrayRebuild[\s\S]{0,160}popUpContextMenu\(\)/.test(mainSrc));

// ④e 静默只剩总览一个开关（真源仍是 8103）
check('renderer 不再引用 quiet-mode-enabled', !/quiet-mode-enabled/.test(source));
check('总览静默文案仍来自 overview.quiet（8103 /state）',
    /typeof data\.quiet === 'boolean'[\s\S]{0,240}quiet-desc/.test(source));

// —— ⑤ 迁移引导（2026-11-21）：四个旧页面各一条，且都能跳到能力区 ——
// 按页面 section 切片，避免「总览也有一条」这种全局误判（嵌套 section 不含 class="page"）。
function pageSlice(id) {
    const start = html.indexOf(`id="${id}"`);
    if (start < 0) return '';
    const next = html.indexOf('<section class="page', start + 10);
    return html.slice(start, next < 0 ? html.length : next);
}
const migratePages = ['model', 'chat', 'petbody', 'settings'];
const migrateCounts = {};
for (const id of migratePages) {
    const slice = pageSlice(id);
    const count = slice.split(`data-migrate-hint="${id}"`).length - 1;
    migrateCounts[id] = count;
    check(`${id} 页有且只有一条迁移提示`, count === 1, `count=${count}`);
    check(`${id} 页的提示带「去能力页/区」按钮`, (slice.match(/data-cap-link/g) || []).length === 1);
    check(`${id} 页的提示文案提到能力页/区`, /能力/.test(slice));
}
check('迁移提示总数 = 4（每页一条，不重复）',
    (html.match(/data-migrate-hint=/g) || []).length === 4, JSON.stringify(migrateCounts));
check('能力区锚点 capability-rows 仍在（跳转目标存在）', /id="capability-rows"/.test(html));
check('去能力页按钮复用 switchPage + 滚动到能力区',
    /\[data-cap-link\][\s\S]{0,300}switchPage\('settings'\)[\s\S]{0,400}scrollIntoView/.test(source));

// —— ⑥ 插件配置编辑器：顶层 enabled 不渲染，但保存不删磁盘原值 ——
check('纯函数只屏蔽顶层 enabled', pure.isDeprecatedPluginConfigKey('enabled') === true);
check('嵌套 enabled 是插件子开关，必须保留',
    pure.isDeprecatedPluginConfigKey('backend_llm_fallback.fields.enabled') === false
    && pure.isDeprecatedPluginConfigKey('nested.enabled') === false);
check('相似键名不误伤',
    pure.isDeprecatedPluginConfigKey('enabled_line') === false
    && pure.isDeprecatedPluginConfigKey('state_trigger_enabled') === false
    && pure.isDeprecatedPluginConfigKey('') === false);
check('configFields 渲染时跳过废弃键', /if \(isDeprecatedPluginConfigKey\(path\)\) continue;/.test(source));
check('插件配置编辑器有小字「插件启停请到…能力」', /插件启停请到[^<]*能力/.test(source));
check('savePluginConfig 基于磁盘配置克隆（未渲染的 enabled 原样保留）',
    /async function savePluginConfig\(\)[\s\S]{0,260}structuredClone\(editingPlugin\.config\)/.test(source));
check('保存链路不主动删除 enabled', !/delete\s+updated\.enabled/.test(source) && !/delete\s+updated\['enabled'\]/.test(source));

console.log('');
console.log(`PASS ${pass} / FAIL ${fail}`);
if (failures.length) console.log('失败项：' + failures.join(', '));
if (pass === 0) { console.error('PASS=0：没有任何断言真正执行，视为失败'); process.exitCode = 1; }
else process.exitCode = fail === 0 ? 0 : 1;
