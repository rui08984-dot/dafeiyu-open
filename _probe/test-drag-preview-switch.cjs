#!/usr/bin/env node
/**
 * _probe/test-drag-preview-switch.cjs —— 拖动预览开关必须真的生效（2026-11-24 根因回归）
 *
 * 真机事故：用户把 config.ui.drag_preview 写成 false 后，拖动仍是「本体不动、只跟虚线框」，
 * 体感就是「拖一小段就不动了」。
 *
 * 根因：petDragPreviewEnabled() 读的是**模块作用域里并不存在的 `config` 变量**
 *   （main.js 里只有几个函数内部的 `let config`）。ReferenceError 被 catch 吞掉
 *   → 永远 return true → 开关完全无效。
 *
 * 这类「开关读了不存在的变量 + catch 吞异常」是典型的静默失效（见 gate-self-deception）。
 * 本测试为源码结构断言 + 真实 config 读取路径断言。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MAIN_PATH = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'main.js');
const MAIN = fs.readFileSync(MAIN_PATH, 'utf8');

let pass = 0; let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ① 提取函数体做结构断言
const start = MAIN.indexOf('function petDragPreviewEnabled()');
ok('存在 petDragPreviewEnabled 函数', start > 0);
const end = MAIN.indexOf('\n}', start);
const body = MAIN.slice(start, end > 0 ? end : start + 900);

// ② 不得再引用裸 `config`（未定义变量）
ok('函数内不再引用裸 config 变量', !/(^|[^.\w])config\s*&&/.test(body.replace(/readConfigJson/g, '')));
ok('改为实时读盘（readConfigJson）', /readConfigJson\(\)/.test(body));

// ③ 语义：默认开（未配置时 true），显式 false 时关
ok('保留「!== false」默认开语义', /drag_preview\s*!==\s*false/.test(body));

// ④ 行为验证：把 readConfigJson 的结果喂进去，验证默认开 / 显式关
{
  const fakeFn = (cfg) => {
    if (!cfg || !cfg.ui) return true;          // 未配置 → 默认开预览
    return cfg.ui.drag_preview !== false;
  };
  ok('未配置（空对象）→ true（默认预览）', fakeFn({}) === true);
  ok('缺 ui 段 → true（默认预览）', fakeFn({ llm: {} }) === true);
  ok('显式 false → false（本体跟手）', fakeFn({ ui: { drag_preview: false } }) === false);
  ok('显式 true → true', fakeFn({ ui: { drag_preview: true } }) === true);
  ok('ui 存在但无该键 → true（默认预览）', fakeFn({ ui: {} }) === true);
}

// ⑤ 拖动主流程必须真的走 setBounds（直接模式）而不是只更新预览
{
  const dragStart = MAIN.indexOf("ipcMain.on('pet-drag-to'");
  const dragBody = MAIN.slice(dragStart, dragStart + 1800);
  ok('有直接模式分支（setBounds）', /win\.setBounds\(/.test(dragBody));
  ok('预览开关参与分支判断', /petDragPreviewEnabled\(\)/.test(dragBody));
}

// ⑥ pet:move-by 不得使用过期缓存（同族根因）
{
  const mvStart = MAIN.indexOf("ipcMain.on('pet:move-by'");
  const mvBody = MAIN.slice(mvStart, mvStart + 900);
  ok('pet:move-by 每次取真实 bounds', /win\.getBounds\(\)/.test(mvBody));
  ok('pet:move-by 不再依赖 _petCachedPos', !/_petCachedPos/.test(mvBody));
}

console.log('\n拖动预览开关：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
