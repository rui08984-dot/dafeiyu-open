#!/usr/bin/env node
/**
 * _probe/test-core-field-contract.cjs — JS ↔ pet-core 字段名契约测试
 *
 * 为什么需要（2026-11-14 五十三轮，两个真 bug 都出在这里）：
 *   · JS 发 `holdMs`，Rust 只认 `hold_ms` 且没有 alias → **按住时长恒为 0**，
 *     游戏里「后退拉开距离」退化成 20ms 轻点（而且不报错）。
 *   · 同类的还有 arg/argument、id 类型 string vs number —— 三次都是「字段名/类型对不上」
 *     这种编译器能抓、但跨语言边界抓不到的错。
 *
 * 做法：从 pet-core/src/main.rs 的 `struct Req` 里抽出**接受的所有键名**
 * （snake_case 字段名 + `#[serde(alias = "...")]`），然后断言下面这份
 * JS 侧真实发送的 payload 清单里每个键都被接受。
 *
 * 加了新字段就把它加进 PAYLOADS —— 忘了加不会漏报，但加了就一定拦得住「发了没人认」。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RS = fs.readFileSync(path.join(ROOT, 'pet-core', 'src', 'main.rs'), 'utf8');

// ── 1. 解析 Req 接受哪些键 ──
const structBody = (() => {
  const m = RS.match(/struct Req \{([\s\S]*?)\n\}/);
  return m ? m[1] : '';
})();
if (!structBody) {
  console.error('  ✗ 解析不到 struct Req（main.rs 结构变了？）');
  process.exit(1);
}
const accepted = new Set(['cmd']);   // cmd 是必填，serde 一定有
const lines = structBody.split('\n');
let pendingAliases = [];
for (const line of lines) {
  const alias = line.match(/alias\s*=\s*"([^"]+)"/);
  if (alias) { pendingAliases.push(alias[1]); continue; }
  const field = line.match(/^\s{4}([a-z_][a-z0-9_]*)\s*:\s*Option</);
  if (field) {
    accepted.add(field[1]);
    for (const a of pendingAliases) accepted.add(a);
    pendingAliases = [];
    continue;
  }
  // 注释/空行不清 pendingAliases（alias 写在字段上一行，中间可能夹注释）
}

// ── 2. JS 侧真实发送的 payload（每个 cmd 一份）──
const PAYLOADS = {
  mouse: ['kind', 'x', 'y', 'x2', 'y2', 'durationMs', 'notches', 'expectTitle', 'modifiers', 'axis', 'restoreCursor', 'target'],
  keys: ['target', 'keys', 'holdMs', 'dryRun'],
  text: ['text', 'target', 'dryRun'],
  game_frame: ['target', 'maxWaitMs', 'slot'],
  wgc_shot: ['target', 'path', 'clientOnly', 'maxWaitMs'],
  uia_action: ['target', 'rid', 'action', 'value'],
  uia_elements: ['target', 'max', 'maxDepth', 'budgetMs', 'maxNodes'],
  windows: ['filter', 'max'],
  cursor_pos: [],
  post_mouse: ['target', 'kind', 'x', 'y'],
  region_gray: ['x', 'y', 'w', 'h'],
  window_from_point: ['x', 'y'],
  screen_shot: ['path'],
};

// dryRun / dry_run：JS 用 dryRun，Rust 是 dry_run —— serde 默认不认驼峰，除非有 alias。
// 同理 clientOnly / maxWaitMs / maxDepth / budgetMs / maxNodes / restoreCursor / holdMs / expectTitle / durationMs。
let pass = 0;
let fail = 0;
for (const [cmd, keys] of Object.entries(PAYLOADS)) {
  for (const k of keys) {
    const okKey = accepted.has(k);
    // Rust 侧若用 snake_case 且没有 alias，camelCase 会被静默忽略 —— 这正是要抓的
    if (okKey) { pass += 1; continue; }
    fail += 1;
    console.error('  ✗ ' + cmd + ' 的字段「' + k + '」不是 pet-core 接受的键名（会被 serde 静默忽略）');
  }
}

// 反向抽查：ensure 关键字段确实在（防止解析失效导致的假绿）
for (const must of ['kind', 'hold_ms', 'slot', 'restore_cursor', 'cmd']) {
  if (!accepted.has(must)) {
    fail += 1;
    console.error('  ✗ 解析结果里缺少必有的字段：' + must);
  } else {
    pass += 1;
  }
}

console.log('  ' + (fail === 0 ? '✅' : '❌') + ' JS↔pet-core 字段契约：PASS ' + pass + ' / FAIL ' + fail
  + '（接受键 ' + accepted.size + ' 个）');
process.exit(fail === 0 ? 0 : 1);
