#!/usr/bin/env node
/**
 * _probe/test-tool-meta.cjs — 工具注解（A3，2026-11-21）
 *
 * 为什么要有：工具的副作用等级（只读/破坏性/幂等/开放世界）原来是隐式的 ——
 * 策略门、评测、UI 提示各猜各的。现在写进各插件 metadata.json 的 `tools` 字段，
 * 这个测试负责保证「声明齐全、字段合法、不自相矛盾、名字没拼错」。
 *
 * 验收口径（对应研讨 A3）：
 *   · 15 个高风险工具必须都有注解（只增不减）；
 *   · 每条注解四个字段必须都是 boolean；
 *   · readOnly 与 destructive 不能同时为 true（只读不可能破坏）；
 *   · 注解里的工具名必须属于真机枚举的 28 个工具（防止拼错成死键）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGINS = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins');

// 真机枚举（2026-11-21 28 个；2026-11-23 P1 新增 dispatch_cancel → 29 个）。
// 工具面变化时这里会红 —— 那就更新本表并在注解里跟上。
const REAL_TOOLS = new Set([
  'diary', 'code', 'memory', 'image', 'import', 'tool_usage', 'note', 'schedule',
  'play_sound_effect', 'web_search', 'pet_care', 'dawn_dusk',
  'appearance', 'see', 'act', 'app', 'file', 'clipboard', 'game', 'batch',
  'knowledge', 'skill', 'dispatch_to_dsh', 'dispatch_cancel', 'check_dispatch', 'hand_action',
  'recall', 'profile', 'cowatch',
]);

// 16 个高风险（写/破坏/外部世界）。新增高风险工具时把名字加进来。
const MUST = [
  'act', 'game', 'app', 'file', 'clipboard', 'batch', 'dispatch_to_dsh', 'dispatch_cancel',
  'hand_action', 'code', 'note', 'memory', 'schedule', 'knowledge', 'import', 'play_sound_effect',
];

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function walkDirs(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDirs(p, out);
    else if (e.name === 'metadata.json') out.push(p);
  }
  return out;
}

const declared = Object.create(null);   // tool → { plugin, meta }
for (const file of walkDirs(PLUGINS, [])) {
  let meta;
  try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    ok('metadata 可解析：' + path.relative(PLUGINS, file), false, String(e && e.message));
    continue;
  }
  const tools = meta && meta.tools;
  if (!tools || typeof tools !== 'object') continue;
  for (const [tool, ann] of Object.entries(tools)) {
    const rel = path.relative(PLUGINS, file);
    if (declared[tool]) {
      ok(`工具注解不重复（${tool}）`, false, '同时出现在 ' + declared[tool].plugin + ' 与 ' + rel);
      continue;
    }
    declared[tool] = { plugin: rel, meta: ann };
  }
}

// ① 15 个高风险必须都有注解
for (const t of MUST) ok('高风险工具已注解：' + t, !!declared[t], declared[t] ? declared[t].plugin : '缺');
console.log('  · 注解工具总数 ' + Object.keys(declared).length + ' / 真实工具 ' + REAL_TOOLS.size);

// ② 字段合法 + ③ 不自相矛盾 + ④ 名字没拼错
const FIELDS = ['readOnly', 'destructive', 'idempotent', 'openWorld'];
for (const [tool, rec] of Object.entries(declared)) {
  const a = rec.meta || {};
  const bad = FIELDS.filter((f) => typeof a[f] !== 'boolean');
  if (bad.length) { ok('字段都是 boolean：' + tool, false, '缺/非布尔：' + bad.join(',')); continue; }
  if (a.readOnly && a.destructive) { ok('readOnly 与 destructive 互斥：' + tool, false, '同时为 true'); continue; }
  if (!REAL_TOOLS.has(tool)) { ok('工具名真实存在：' + tool, false, '真机 28 个工具里没有它（拼错？）'); continue; }
  pass += 1;   // 三关都过，不逐条刷屏
}
console.log('  · ' + Object.keys(declared).length + ' 条注解通过字段/互斥/名字校验');

// ⑤ 只读工具不该被标 destructive（抽样：see 必须 readOnly 且非破坏）
ok('see 是只读且非破坏', !!(declared.see && declared.see.meta.readOnly === true && declared.see.meta.destructive === false));
ok('act 是破坏性且非只读', !!(declared.act && declared.act.meta.destructive === true && declared.act.meta.readOnly === false));

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
