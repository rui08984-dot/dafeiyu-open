// RT1-E1: 只读探针 —— 验证 game-control 的按键解析/黑名单/转义（不发送任何输入）
// 说明：只调用纯函数 toSendKeys / escapeSendKeys，不调用 runGameAction，不会碰桌面。
'use strict';
const path = require('path');
const gc = require(path.resolve('<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js'));

const cases = [
    'alt+f4', 'ALT+F4', 'alt + f4', 'alt+ f4', 'altf4', 'Alt+F4x',
    'ctrl+alt+del', 'ctrl + alt + del', 'ctrl+alt+delete',
    'alt+tab', 'win', 'win+r', 'ctrl+shift+esc', 'ctrl+esc',
    'f4', 'shift+f10', 'ctrl+w', 'alt+{f4}', '%{F4}',
    'w', 'space', 'multiply', 'enter',
];
for (const c of cases) {
    let r;
    try { r = 'ALLOW -> ' + JSON.stringify(gc.toSendKeys(c)); }
    catch (e) { r = 'BLOCK -> ' + e.message; }
    console.log(String(c).padEnd(18), r);
}
console.log('\n-- escapeSendKeys --');
for (const t of ['a+b^c%d~e(f)g{h}i[j]', 'notepad.exe', 'rm -rf /', '\\r\\n']) {
    console.log(JSON.stringify(t), '=>', gc.escapeSendKeys(t));
}
console.log('\n-- rateGate 21 连击（只测闸门计数，不动桌面）--');
let passed = 0, blocked = 0;
for (let i = 0; i < 21; i += 1) {
    if (gc.rateGate()) blocked += 1; else passed += 1;
}
console.log('passed=' + passed, 'blocked=' + blocked);
