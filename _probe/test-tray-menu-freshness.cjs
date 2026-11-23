#!/usr/bin/env node
/**
 * _probe/test-tray-menu-freshness.cjs — 托盘菜单文案不得滞后于窗口可见性（2026-11-23）
 *
 * 用户现场：皮套右键「先藏起来」→ 窗口消失；打开系统托盘还写着「隐藏桌宠」；
 * 点它反而把桌宠显示出来（处理函数按实时 isVisible 执行 show）。
 * 根因：hide-pet 只 win.hide()，没有重建托盘菜单；而托盘菜单是静态 setContextMenu。
 *
 * 本探针盯：
 *   ① main.js 订阅窗口 show/hide 并重建托盘（覆盖所有藏/显路径）
 *   ② 菜单文案是「可见 ? 隐藏桌宠 : 显示桌宠」，且由 isVisible 实时判定
 *   ③ 重建时把文案写进 global.__petTrayMenuLabels 供真机自检
 *   ④ 托盘自检包含「隐藏后首项=显示桌宠 / 显示后首项=隐藏桌宠」两条断言
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
    if (cond) { pass += 1; console.log('  ✓ ' + name); }
    else { fail += 1; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
};

console.log('test-tray-menu-freshness');
ok(/win\.on\('show',\s*refreshTray\)/.test(src), '窗口 show 事件重建托盘');
ok(/win\.on\('hide',\s*refreshTray\)/.test(src), '窗口 hide 事件重建托盘');
ok(/const visible = !!\(petWinRef[^\n]*isVisible\(\)/.test(src), '文案由实时 isVisible 判定');
ok(/visible \? '隐藏桌宠' : '显示桌宠'/.test(src), '文案映射正确（可见→隐藏，隐藏→显示）');
ok(/global\.__petTrayMenuLabels\s*=/.test(src), '重建时记录菜单文案供自检');
ok(/托盘文案·隐藏后/.test(src) && /labelsHidden\[0\] === '显示桌宠'/.test(src), '自检：隐藏后首项=显示桌宠');
ok(/托盘文案·显示后/.test(src) && /labelsShown\[0\] === '隐藏桌宠'/.test(src), '自检：显示后首项=隐藏桌宠');
// hide-pet 必须显式 rebuild：窗口事件是异步的，且「已隐藏时再 hide()」不发事件 → 只靠事件有竞态窗口
ok(/ipcMain\.on\('hide-pet'[\s\S]{0,600}?win\.hide\(\)[\s\S]{0,600}?petTrayRebuild/.test(src), 'hide-pet 隐藏后显式重建托盘（兜底异步事件）');
// 托盘右键弹出前必须重建（原生 Menu 不会自己更新勾选/文案）
ok(/petTray\.on\('right-click'[\s\S]{0,300}?rebuild\(\)[\s\S]{0,200}?popUpContextMenu/.test(src), '右键弹出前先重建菜单');

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exitCode = fail === 0 ? 0 : 1;
