#!/usr/bin/env node
/**
 * _probe/test-ui-gates-audit.cjs —— 老 WebUI 三个假开关回归（2026-11-23）
 *
 * 只测「控件显示状态 = 运行时闸门」这条规则，不启动 Flask/浏览器：
 *   ① 「启用 Function Call 工具」：config.tools.enabled 无消费者
 *      （js/core/capabilities.js 登记为死键；真实总闸是 plugins/enabled_plugins.json）
 *      → 控件与 JS 引用都必须不存在，不能留假开关；
 *   ② 动作模式/动作风格：petbody 形态下 isPetBodyTakeover() 把编舞整段短路
 *      → motionModeGate() 判不生效，applyMotionModeGate() 禁用控件并就地说明；
 *      同时 config_manager 不再写 motion_director.enabled（运行时明确忽略的死键）；
 *   ③ 字幕开关：运行时只在 subtitle_labels.enabled === false 时隐藏（缺键=显示）
 *      → subtitleEnabledValue() 缺键 true，config_manager GET 缺省也改 True。
 *
 * 用法：node _probe/test-ui-gates-audit.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');
const G = require(path.join(APP, 'webui', 'static', 'js', 'ui-gates.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}

console.log('老 WebUI 三开关同源回归');
console.log('');

// ── ① tools.enabled 假开关已移除 ──────────────────────────────────────────
console.log('① Function Call 工具开关（死键 → 移除）');
const newHtml = read('webui/templates/index_new.html');
const newApp = read('webui/static/new/js/app.js');
const oldApp = read('webui/static/js/app.js');
const caps = read('js/core/capabilities.js');
ok('index_new.html 不再有 tools-enabled 控件', !/id="tools-enabled"/.test(newHtml) && !/for="tools-enabled"/.test(newHtml));
ok('新 UI 不再读/写 tools_enabled',
    !/getElementById\(['"]tools-enabled['"]\)/.test(newApp)
    && !/\btools_enabled\s*:/.test(newApp)
    && !/config\.tools_enabled/.test(newApp));
ok('老 UI 本来就没有该控件', !/tools-enabled|tools_enabled/.test(oldApp));
ok('能力登记仍把 tools.enabled 标为无消费者', caps.includes("'tools.enabled'") && caps.includes('enabled_plugins.json'));
ok('运行时插件总闸仍是 enabled_plugins.json（没被 UI 抢成 config.tools.enabled）',
    read('js/core/plugin-manager.js').includes('enabled_plugins.json'));

// ── ② 动作模式：petbody 短路 ─────────────────────────────────────────────
console.log('');
console.log('② 动作模式/动作风格（petbody 短路）');
const pet = G.motionModeGate({ avatar_model_type: 'petbody' });
ok('petbody → 不生效', pet.effective === false);
ok('petbody 原因提到 isPetBodyTakeover/短路', /isPetBodyTakeover/.test(pet.reason) && /短路/.test(pet.reason), pet.reason);
ok('petbody 原因提到语义动作走 actions-bridge', /actions-bridge/.test(pet.reason));
ok('model_type 平铺字段也认（petbody）', G.motionModeGate({ model_type: 'PetBody' }).effective === false);
ok('live2d → 生效', G.motionModeGate({ avatar_model_type: 'live2d' }).effective === true);
ok('vrm → 不生效（没有 live2d 参数导演可落）', G.motionModeGate({ avatar_model_type: 'vrm' }).effective === false,
    G.motionModeGate({ avatar_model_type: 'vrm' }).reason);
ok('缺字段 → 按 live2d 生效', G.motionModeGate({}).effective === true);

// 假 DOM：验证 applyMotionModeGate 真的禁用 + 就地写说明
function fakeEl() {
    return {
        disabled: false, hidden: false, className: '', textContent: '', parentNode: null, nextSibling: null,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = String(v); },
    };
}
const section = {
    inserted: [],
    querySelector(sel) {
        const m = /^\[data-ui-gate-hint="([^"]+)"\]$/.exec(sel);
        return m ? (this.inserted.find((n) => n.attrs['data-ui-gate-hint'] === m[1]) || null) : null;
    },
    insertBefore(node, ref) { this.inserted.push(node); node.parentNode = this; return node; },
};
const group = { parentNode: section, nextSibling: null };
const modeSel = fakeEl(); modeSel.parentNode = group;
const styleSel = fakeEl(); styleSel.parentNode = group;
const doc = { createElement: () => fakeEl() };
const applied = G.applyMotionModeGate([modeSel, styleSel], { avatar_model_type: 'petbody' }, doc);
const hint = section.inserted[0];
ok('petbody 下两个下拉框都禁用', modeSel.disabled === true && styleSel.disabled === true);
ok('闸门返回值同步', applied.effective === false);
ok('就地插入一条说明', !!hint && hint.attrs['data-ui-gate-hint'] === 'motion-mode');
ok('说明内容是皮套短路原因', !!hint && /皮套/.test(hint.textContent) && hint.hidden === false, hint && hint.textContent);
// 切回 live2d：同一批控件恢复 + 说明隐藏（不新增第二条）
G.applyMotionModeGate([modeSel, styleSel], { avatar_model_type: 'live2d' }, doc);
ok('live2d 下恢复可用', modeSel.disabled === false && styleSel.disabled === false);
ok('说明隐藏且不重复插入', section.inserted.length === 1 && section.inserted[0].hidden === true,
    'inserted=' + section.inserted.length);

const cm = read('webui/config_manager.py');
ok('config_manager 不再调用 sync_motion_director_enabled',
    !/=\s*sync_motion_director_enabled\(/.test(cm) && !/^def sync_motion_director_enabled/m.test(cm));
ok('config_manager 不再写 motion_director.enabled', !/motion_director'\]\['enabled'\]\s*=/.test(cm));
ok('config_manager 仍写 ui.avatar_motion_mode（唯一真源）', /config\['ui'\]\['avatar_motion_mode'\]\s*=\s*motion_mode/.test(cm));
ok('GET /api/settings/ui 回传 avatar_model_type', /'avatar_model_type':/.test(cm));
ok('两套 app.js 都接了 applyMotionModeGate',
    oldApp.includes('UI_GATES.applyMotionModeGate') && newApp.includes('UI_GATES.applyMotionModeGate'));
ok('两套模板都加载 ui-gates.js',
    read('webui/templates/index.html').includes('ui-gates.js') && newHtml.includes('ui-gates.js'));
ok('运行时短路函数仍存在（UI 依据没漂）', read('js/ai/motion-director.js').includes('function isPetBodyTakeover'));

// ── ③ 字幕缺省对齐 ────────────────────────────────────────────────────────
console.log('');
console.log('③ 字幕开关缺省（缺键 = 显示）');
ok('空对象 → true（运行时缺省）', G.subtitleEnabledValue({}) === true);
ok('显式 false → false', G.subtitleEnabledValue({ subtitle_enabled: false }) === false);
ok('显式 true → true', G.subtitleEnabledValue({ subtitle_enabled: true }) === true);
ok('根级 subtitle_labels.enabled=false → false', G.subtitleEnabledValue({ subtitle_labels: { enabled: false } }) === false);
ok('ui.subtitle_labels.enabled=false → false', G.subtitleEnabledValue({ ui: { subtitle_labels: { enabled: false } } }) === false);
ok('旧键 subtitle-labels-enabled=false → false', G.subtitleEnabledValue({ 'subtitle-labels-enabled': false }) === false);
ok('非布尔垃圾值不误判（仍按运行时显示）',
    G.subtitleEnabledValue({ subtitle_enabled: 'yes', subtitle_labels: { enabled: null } }) === true);
ok('config_manager GET 字幕缺省 True', /subtitle_config\.get\('enabled',\s*True\)/.test(cm));
ok('config_manager POST 缺省沿用现值/True（不会保存一次就关）',
    /config\['subtitle_labels'\]\.get\('enabled',\s*True\)/.test(cm));
ok('两套 app.js 都用 subtitleEnabledValue',
    oldApp.includes('UI_GATES.subtitleEnabledValue') && newApp.includes('UI_GATES.subtitleEnabledValue'));
ok('运行时判据仍是 enabled === false 才隐藏',
    read('js/ui/ui-controller.js').includes('subtitle_labels.enabled === false'));

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
