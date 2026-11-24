#!/usr/bin/env node
/**
 * _probe/test-drag-passthrough-guard.cjs —— 拖动期间禁止穿透（2026-11-24 根因回归）
 *
 * 真机事故：拖动只能拖一小段就停，框不动了。
 *
 * 根因（自指死锁的第三次同族事故）：
 *   拖动靠渲染层持续收 pointermove/mousemove 才能跟手；
 *   而悬停判定一旦认为光标在「透明处」就置上 WS_EX_TRANSPARENT，
 *   置上后窗口**收不到任何鼠标事件** → 立即失去后续 pointermove → 拖动中断。
 *   （前两次同族：① 托盘开穿透后收不到事件 ② 划出后不恢复）
 *
 * 修复约束：**拖动期间绝不允许进入穿透态**。
 *   渲染层：ui-controller.updateMouseIgnore 开头判 window.__pbDragging（3s 新鲜度）→ 强制可见
 *   主进程：passthrough 轮询判 global.__petDragging → 强制可见并跳过进出判定
 *   清理：pet-drag-end 与 5s 看门狗都要清全局标志（否则永远不穿透）
 *
 * 本测试为源码结构断言（不启动 Electron / 不移动光标）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'main.js'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'ui', 'ui-controller.js'), 'utf8');
const PB = fs.readFileSync(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'avatar', 'petbody', 'ui.js'), 'utf8');

let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① 拖动标志存在且有新鲜度（防止 pointerup 落在窗外时永久锁死）
{
  ok('petbody 拖起时置 __pbDragging', /window\.__pbDragging = true/.test(PB));
  ok('petbody 拖动中续 __pbDraggingAt', /__pbDraggingAt = Date\.now\(\)/.test(PB));
  ok('petbody 拖停时清 __pbDragging', /window\.__pbDragging = false/.test(PB));
}

// ② 渲染层：拖动期间强制可见，且必须在悬停判定之前
{
  const fnStart = UI.indexOf('const updateMouseIgnore = (e) => {');
  // 容器要覆盖到第一次 decideHoverPassthrough 调用（实现里中间还有 UI/命中测试等约 2k 字符）
  const fnEnd = UI.indexOf('decideHoverPassthrough', fnStart);
  const fnBody = UI.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000);
  ok('updateMouseIgnore 读 __pbDragging', /__pbDragging/.test(fnBody));
  ok('有 3s 新鲜度兜底', /3000/.test(fnBody));
  ok('拖动中强制可见（_applyIgnoreMouse(false)）', /if \(dragging\)[\s\S]{0,200}_applyIgnoreMouse\(false\)/.test(fnBody));
  ok('拖动判断在悬停判定之前（先 return）', fnEnd > 0 && fnBody.indexOf('if (dragging)') >= 0);
}

// ③ 主进程：轮询里判拖动并强制可见
{
  const watcher = MAIN.slice(MAIN.indexOf('function startPassthroughWatcher'), MAIN.indexOf('function stopPassthroughWatcher'));
  ok('轮询读 global.__petDragging', /__petDragging/.test(watcher));
  ok('拖动中强制可见', /if \(dragging\)[\s\S]{0,200}__ptApply\(win, false/.test(watcher));
  ok('拖动中跳过进出判定（return）', /if \(dragging\)[\s\S]{0,300}return;/.test(watcher));
}

// ④ 标志生命周期：pet-drag-to 置真、pet-drag-end 清、看门狗兜底清
{
  ok('pet-drag-to 置全局拖动标志', /global\.__petDragging = true/.test(MAIN));
  ok('pet-drag-end 清全局拖动标志', /global\.__petDragging = false/.test(MAIN));
  const watchdog = MAIN.slice(MAIN.indexOf('尺寸看门狗（全局唯一）'), MAIN.indexOf('ipcMain.on(\'pet-drag-end\''));
  ok('5s 看门狗也清全局标志（drag-end 丢失时不锁死）', /global\.__petDragging = false/.test(watchdog));
}

// ⑤ 不得回归成「拖动期间走悬停穿透」
{
  ok('拖动保护在 _passGate 刷新之前（不受手动开关影响）',
    UI.indexOf('if (dragging)') < UI.indexOf('this._passGate.refreshIfStale()', UI.indexOf('const updateMouseIgnore')));
}

console.log('\n拖动穿透守卫：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
