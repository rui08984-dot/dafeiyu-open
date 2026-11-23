#!/usr/bin/env node
/**
 * _probe/check-plugins.mjs —— 插件清单与工具名一致性（2026-11-16 插件收敛）
 *
 * 三类检查：
 *   ① enabled_plugins.json：每个条目在 plugins/ 下有目录、metadata.json 可解析、且没有重复条目
 *   ② 残留扫描：built-in / community 下存在、但未启用的目录只提示（不算失败）；
 *      「故意保留」白名单：music、translation、dynamic-persona
 *   ③ tool-picker.js：DOMAINS 与 GENERIC_FILL 里只允许出现当前真实工具名
 *      （CURRENT_TOOLS 硬编码 28 个；旧插件工具名一律判 FAIL）
 *
 * 用法：node _probe/check-plugins.mjs
 * 退出码：0 = PASS，1 = FAIL
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PLUGINS_DIR = path.join(APP, 'plugins');
const ENABLED_FILE = path.join(PLUGINS_DIR, 'enabled_plugins.json');
const TOOL_PICKER = path.join(APP, 'js', 'ai', 'tool-picker.js');

// 当前真实工具面（2026-11-21：30 个；C1/C2 新增 world / timeline）
const CURRENT_TOOLS = [
  'diary', 'code', 'memory', 'image', 'import', 'tool_usage', 'note', 'schedule',
  'play_sound_effect', 'web_search', 'dawn_dusk', 'recall', 'profile', 'pet_care',
  'appearance', 'see', 'act', 'app', 'file', 'clipboard', 'game', 'batch',
  'knowledge', 'skill', 'dispatch_to_dsh', 'check_dispatch', 'hand_action', 'cowatch',
  'world', 'timeline',
];

// 目录存在但故意不启用的插件（只提示，不判失败）
const KEEP_DISABLED = new Set([
  'built-in/music',
  'built-in/translation',
  'community/dynamic-persona',
]);

const failures = [];
const notes = [];
function fail(msg) { failures.push(msg); console.error('  ✗ ' + msg); }
function pass(msg) { console.log('  ✓ ' + msg); }
function info(msg) { notes.push(msg); console.log('  · ' + msg); }

console.log('[1/3] enabled_plugins.json');
let enabled = [];
try {
  const raw = fs.readFileSync(ENABLED_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.plugins)) {
    fail('enabled_plugins.json 缺少 plugins 数组');
  } else {
    enabled = parsed.plugins;
  }
} catch (e) {
  fail('enabled_plugins.json 读取/解析失败：' + String(e.message).slice(0, 120));
}

const seen = new Set();
for (const entry of enabled) {
  if (typeof entry !== 'string' || !/^(built-in|community)\/[A-Za-z0-9_-]+$/.test(entry)) {
    fail('非法插件条目：' + JSON.stringify(entry));
    continue;
  }
  if (seen.has(entry)) fail('重复条目：' + entry);
  seen.add(entry);

  const dir = path.join(PLUGINS_DIR, entry);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    fail('目录不存在：plugins/' + entry);
    continue;
  }
  const metaFile = path.join(dir, 'metadata.json');
  if (!fs.existsSync(metaFile)) {
    fail('缺少 metadata.json：plugins/' + entry);
    continue;
  }
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      fail('metadata.json 不是对象：plugins/' + entry);
    }
  } catch (e) {
    fail('metadata.json 解析失败：plugins/' + entry + ' — ' + String(e.message).slice(0, 80));
  }
}
if (enabled.length && !failures.length) pass(`${enabled.length} 个启用条目：目录与 metadata 全部可解析，无重复`);

// ①b 入口可实例化（2026-11-21 审计 P0）：只查 metadata 不够 —— memory-recall 的
// module.exports 是类，但类上挂了静态属性，宿主旧加载器取 Object.keys(mod)[0] 拿到
// 静态属性 → new 非构造函数 → 该插件从 19:34 起一直没加载，而 check-all 全绿。
// 这里按宿主的解析规则验证「能拿到构造函数」；require 因环境（electron 等）失败的
// 只提示不判红，避免把纯 Node 环境的差异变成假红。
{
    const requireApp = createRequire(path.join(APP, 'probe-entry.js'));
    let checked = 0;
    let skipped = 0;
    for (const entry of enabled) {
        const dir = path.join(PLUGINS_DIR, entry);
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8')); } catch (e) { continue; }
        if (meta && meta.lang === 'python') continue;
        const main = path.join(dir, (meta && meta.main) || 'index.js');
        if (!fs.existsSync(main)) continue;
        let mod = null;
        try { mod = requireApp(main); } catch (e) {
            skipped += 1;
            info(`入口 require 跳过（纯 Node 环境）：${entry} — ${String(e.message).split('\n')[0].slice(0, 80)}`);
            continue;
        }
        const named = (mod && typeof mod === 'object')
            ? Object.keys(mod).map((k) => mod[k]).find((v) => typeof v === 'function')
            : null;
        const cls = (typeof mod === 'function') ? mod : (mod && mod.default) || named || mod;
        checked += 1;
        if (typeof cls !== 'function') {
            fail(`插件入口不是构造函数：${entry}（拿到 ${typeof cls}；module.exports 必须是类）`);
        }
    }
    if (checked && !failures.length) pass(`${checked} 个 JS 插件入口都能解析出构造函数${skipped ? `（${skipped} 个因环境跳过）` : ''}`);
}

console.log('[2/3] 未启用目录残留扫描');
for (const kind of ['built-in', 'community']) {
  const base = path.join(PLUGINS_DIR, kind);
  if (!fs.existsSync(base)) continue;
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch (e) {
    fail(`无法读取 plugins/${kind}：` + String(e.message).slice(0, 80));
    continue;
  }
  for (const name of dirs) {
    const key = `${kind}/${name}`;
    if (seen.has(key) || KEEP_DISABLED.has(key)) continue;
    info(`残留（未启用、未在白名单）：plugins/${key}`);
  }
}
pass('残留扫描完成（残留只提示，不判失败）');

console.log('[3/3] tool-picker.js 工具名');
try {
  const src = fs.readFileSync(TOOL_PICKER, 'utf8');

  const domainsBlock = src.match(/const DOMAINS\s*=\s*\[([\s\S]*?)\n\];/);
  if (!domainsBlock) fail('无法解析 DOMAINS 数组（格式变了？）');

  const names = [];
  if (domainsBlock) {
    for (const arr of domainsBlock[1].matchAll(/tools\s*:\s*\[([\s\S]*?)\]/g)) {
      for (const q of arr[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) names.push(q[1].toLowerCase());
    }
  }

  const genericBlock = src.match(/const GENERIC_FILL\s*=\s*\[([\s\S]*?)\n\];/);
  if (!genericBlock) fail('无法解析 GENERIC_FILL 数组（格式变了？）');
  if (genericBlock) {
    for (const q of genericBlock[1].matchAll(/['"]([A-Za-z0-9_]+)['"]/g)) names.push(q[1].toLowerCase());
  }

  if (!names.length) {
    fail('没有从 tool-picker.js 抽到任何工具名');
  } else {
    const known = new Set(CURRENT_TOOLS);
    const unknown = [...new Set(names)].filter((n) => !known.has(n)).sort();
    if (unknown.length) {
      fail('tool-picker 出现不存在的工具名：' + unknown.join(', '));
    } else {
      pass(`tool-picker 工具名全部命中真实工具面（${new Set(names).size} 个名字 / 白名单 ${CURRENT_TOOLS.length} 个）`);
    }
  }
} catch (e) {
  fail('tool-picker.js 读取失败：' + String(e.message).slice(0, 120));
}

console.log('');
if (failures.length) {
  console.log(`FAIL 插件清单与工具名：${failures.length} 项未过`);
  process.exit(1);
}
console.log(`PASS 插件清单与工具名：${enabled.length} 个启用条目、无重复、工具名全部有效${notes.length ? `（残留提示 ${notes.length} 条）` : ''}`);
process.exit(0);
