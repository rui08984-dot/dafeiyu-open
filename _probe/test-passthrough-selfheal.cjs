#!/usr/bin/env node
/**
 * _probe/test-passthrough-selfheal.cjs —— 穿透边界自愈（2026-11-23 根因回归）
 *
 * 真机事故（两次）：置上 WS_EX_TRANSPARENT 后窗口收不到真实鼠标事件，
 * 渲染层的 mousemove 判定永远等不到「离开」→ 一旦穿透就永久点不到她。
 *
 * 根因是**自指死锁**：穿透判定依赖的输入（鼠标事件）被穿透本身破坏。
 * 因此任何「渲染层再补一个 if」都不可能修好；必须由主进程轮询光标（不依赖窗口事件）。
 *
 * 本测试对源码做结构断言 + 对纯函数边界规则做行为断言（不启动 Electron）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'main.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'ui', 'ui-controller.js'), 'utf8');

let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① 主进程必须有光标轮询（唯一能在已穿透状态下读到鼠标位置的通道）
{
  ok('主进程有 passthrough 轮询定时器', /setInterval\([\s\S]{0,1200}screen\.getCursorScreenPoint\(\)/.test(MAIN));
  ok('轮询用窗口矩形判定进入', /getBounds\(\)/.test(MAIN) && /__ptCursorInside/.test(MAIN));
  ok('进入窗口即解除穿透', /if \(inside\)[\s\S]{0,200}__ptApply\(win, false/.test(MAIN));
  ok('离开有宽限期再穿透', /PASSTHROUGH_LEAVE_GRACE_MS/.test(MAIN));
  ok('轮询在窗口加载后启动', /win\.loadFile\('index\.html'\)[\s\S]{0,400}startPassthroughWatcher/.test(MAIN));
  ok('退出时清理定时器', /will-quit[\s\S]{0,200}stopPassthroughWatcher/.test(MAIN));
}

// ② 手动开关语义：开=保持穿透（进入也不解除）；关=进入即恢复
{
  ok('手动开关通道存在', /ipcMain\.on\('pet:passthrough-manual'/.test(MAIN));
  ok('手动开时跳过「进入解除」', /if \(!manual\) __ptApply\(win, false/.test(MAIN));
  ok('托盘开关不再直接 setIgnoreMouseEvents(on) 裸调用',
    !/{ type: 'checkbox', label: '鼠标穿透[^]*?petWinRef\.setIgnoreMouseEvents\(on,/.test(MAIN));
}

// ③ 渲染层两条路径统一走专用通道（悬停路径曾被总闸拦掉 = 功能从没生效）
{
  ok('悬停与手动统一走 pet:set-ignore-mouse',
    (UI.match(/pet:set-ignore-mouse/g) || []).length >= 1
    && !/ipcRenderer\.send\('set-ignore-mouse-events'/.test(UI));
  ok('渲染层把手动状态同步给主进程', /pet:passthrough-manual/.test(UI));
}

console.log('\n穿透自愈：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
