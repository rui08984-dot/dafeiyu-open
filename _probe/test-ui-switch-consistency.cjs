#!/usr/bin/env node
/**
 * _probe/test-ui-switch-consistency.cjs —— UI 开关一致性守卫（2026-11-23）
 *
 * 用户报的「托盘写着隐藏、点它反而出来」暴露的不是单个 bug，而是一类病：
 * **同一个状态在多个入口各写一套判据/文案/生效路径**。本探针盯住这次收口的四条契约：
 *
 *   ① 能力注册表里的「即时」必须真有运行时下发面：
 *      取景/编舞/自动演/穿透/打字框 → control-v2-renderer.js 的 applyCapabilityLive 全有映射。
 *   ② B5 语音四态门已登记：默认关、hot=false（ASRProcessor 构造时只读一次）。
 *   ③ B3 记忆体检：按钮 → preload → control-main 子进程 `--json`（**不得**自动 --fix）。
 *   ④ B9 取消/重试文案与新状态机一致（状态中文化、取消失败不误导成「重试派活」）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const read = (rel) => fs.readFileSync(path.join(LIVE, rel), 'utf8');

const caps = read('js/core/capabilities.js');
const renderer = read('control-v2-renderer.js');
const controlMain = read('control-main.js');
const preload = read('control-preload.js');
const html = read('control-v2.html');
const uiCtrl = read('js/ui/ui-controller.js');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass += 1; console.log('  ✓ ' + name); }
    else { fail += 1; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
};

console.log('test-ui-switch-consistency');

// ① 能力页「即时」的运行时下发面
const LIVE_KEYS = ['ui.petbody_choreo', 'ui.petbody_perf_auto', 'ui.petbody_framing', 'ui.click_through_default', 'ui.show_chat_box', 'tts.muted'];
for (const key of LIVE_KEYS) {
    ok(new RegExp(`else if \\(key === '${key.replace('.', '\\.')}'\\)|if \\(key === '${key.replace('.', '\\.')}'\\)`).test(renderer),
        `能力页有运行时下发：${key}`);
}
ok(/hot:\s*true[^}\n]*key:\s*'ui\.chat_box'/.test(caps) || /key:\s*'ui\.show_chat_box'[^}\n]*hot:\s*true/.test(caps), 'ui.chat_box 声明为即时（且有下发面）');
ok(/key:\s*'ui\.petbody_framing'[^}\n]*hot:\s*true/.test(caps), 'ui.framing 声明为即时');
ok(/key:\s*'ui\.click_through_default'[^}\n]*hot:\s*true/.test(caps), 'ui.click_through 声明为即时');
ok(/const live = await applyCapabilityLive\(key, value\)/.test(renderer), '保存后先真下发再报「即时/需重启」');
ok(!/toast\(`已保存：\$\{meta \? meta\.name : key\}\$\{meta && meta\.hot \? '（即时生效）'/.test(renderer),
    '不再无条件承诺「即时生效」');
// 审计更正（2026-11-23）：持有启动时配置快照的三项必须标「需重启」，不能再谎报热
ok(/key:\s*'voice_style\.enabled'[^}\n]*hot:\s*false/.test(caps), 'voice.style 更正为需重启（TTS 缓存快照）');
ok(/key:\s*'world_sense\.enabled'[^}\n]*hot:\s*false/.test(caps), 'vision.world_sense 更正为需重启（插件快照）');
ok(/key:\s*'context\.history_token_budget'[^}\n]*hot:\s*false/.test(caps), '上下文 history 压缩预算更正为需重启（插件快照）');

// ② B5 语音四态门
ok(/id: 'voice\.backchannel_gate'/.test(caps), 'B5 已登记能力项');
ok(/key:\s*'voice\.duplex\.backchannel_gate'[^}\n]*default:\s*false[^}\n]*hot:\s*false/.test(caps)
    || /key:\s*'voice\.duplex\.backchannel_gate'/.test(caps) && /id: 'voice\.backchannel_gate'[\s\S]{0,200}hot:\s*false/.test(caps),
    'B5 默认关且标需重启');
ok(/嗯\/对/.test(caps) && /不打断/.test(caps), 'B5 note 说清「回嗯/对不打断」');

// ③ B3 记忆体检
ok(/id="memory-health-btn"/.test(html), '记忆页有「开始体检」按钮');
ok(/id="memory-health-copy"/.test(html) && /memos-consistency\.mjs --fix/.test(html), '面板给出一行可复制的修复命令');
ok(/memoryConsistency:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('control:memory-consistency'\)/.test(preload), 'preload 透传 memoryConsistency');
ok(/ipcMain\.handle\('control:memory-consistency'/.test(controlMain), 'control-main 有 memory-consistency 处理器');
const ipcBlock = (controlMain.match(/ipcMain\.handle\('control:memory-consistency'[\s\S]*?\n\}\);/) || [''])[0];
ok(/MEMOS_CONSISTENCY_SCRIPT, '--json'/.test(ipcBlock), '体检跑 --json（只读）');
ok(!/--fix/.test(ipcBlock), '体检处理器不得自动 --fix');
ok(/ELECTRON_RUN_AS_NODE/.test(ipcBlock), '用 Electron 自身当 Node（不依赖 PATH）');
ok(/ok:\s*false,\s*error:/.test(ipcBlock), '失败带明确原因（脚本缺失/超时/非 JSON）');

// ④ B9 取消/重试文案
ok(/DISPATCH_STATE_ZH/.test(renderer), '派活详情状态中文化（running/done/failed/unknown/cancelled）');
ok(/（可再点一次停止）/.test(renderer) && !/取消失败[\s\S]{0,80}（再点重试）/.test(renderer), '取消失败不再误写成「重试」');
ok(/t\.state === 'failed' && t\.attempted === false/.test(renderer), '重试按钮只对 failed+attempted=false 出现');

// 右键菜单：文案由实时状态推导（不是动作名）
ok(/按键录音：' \+ \(on \? '开' : '关'\)/.test(uiCtrl), '按键录音文案显示开/关');
ok(/打字框：' \+ \(toggleChatBtn\.classList\.contains\('active'\) \? '开' : '关'\)/.test(uiCtrl), '打字框文案显示开/关');
ok(/global\.__setChatBoxVisible = applyChatBoxVisible/.test(uiCtrl), '打字框显隐只有一份实现（能力页复用）');

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exitCode = fail === 0 ? 0 : 1;
