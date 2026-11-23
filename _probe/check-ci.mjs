#!/usr/bin/env node
// _probe/check-ci.mjs —— 只跑「不需要她的仓库」的检查（GitHub Actions 用）
//
// 为什么单独一个（2026-11-14）：`check-all.mjs` 的语法扫描和 3 个单测都依赖
// `_incoming/my-neuro/live-2d`（她在**另一个私有仓库**里）。CI 里拿不到 →
// 4 项必红。与其让 CI 永远红着（然后没人看），不如跑「主仓库自己能验的部分」：
//   · pet-runtime 下所有 .mjs/.cjs 的语法
//   · 5 个不依赖她的单测（皮套 perf / 编译器 / 情绪契约 / 抖动 / 两段提交）
// Rust 与 Python 的检查留给本机的 check-all（CI 的 runner 装 Rust/Python 太重）。
//
// 本机仍然用：node _probe/check-all.mjs（那个更全）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
const add = (ok, name, note) => rows.push({ ok, name, note });

// ── ① 语法：pet-runtime 下所有 .mjs / .cjs（跳过依赖与产物）────────────
const SKIP = new Set(['node_modules', '.git', 'target', '.state', 'build', 'assets', 'dist']);
const files = [];
(function walk(dir, depth) {
  if (depth > 5) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.(mjs|cjs)$/.test(e.name)) files.push(p);
  }
})(path.join(ROOT, 'pet-runtime'), 0);

let syntaxBad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) {
    syntaxBad += 1;
    add(false, '语法 ' + path.relative(ROOT, f), String(r.stderr || '').split('\n')[1] || '');
  }
}
add(syntaxBad === 0, '语法（pet-runtime）', files.length + ' 个文件 / 失败 ' + syntaxBad);

// ── ② 不依赖她的单测 ─────────────────────────────────────────────────
const UNITS = [
  ['perf 引擎', 'pet-runtime/tools/perf-engine-test.mjs'],
  ['轨道编译器', 'pet-runtime/tools/perf-compiler-test.mjs'],
  ['情绪状态契约', 'pet-runtime/tools/emotion-state-test.mjs'],
  ['皮套不抖', 'pet-runtime/tools/perf-jitter-test.mjs'],
  ['两段提交', 'pet-runtime/tools/param-commit-test.mjs'],
];
for (const [label, rel] of UNITS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { add(false, label, '缺文件 ' + rel); continue; }
  const r = spawnSync(process.execPath, [abs], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const m = out.match(/PASS (\d+) \/ FAIL (\d+)/);
  add(r.status === 0, label, m ? `PASS ${m[1]} / FAIL ${m[2]}` : '退出码 ' + r.status);
}

// ── 汇总 ────────────────────────────────────────────────────────────
const bad = rows.filter((r) => !r.ok);
console.log('\n[check-ci] 主仓库自检（不需要她的仓库）\n');
for (const r of rows) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  —  ${r.note}`);
console.log(bad.length ? `\n${bad.length} 项未过\n` : '\n全部通过\n');
process.exit(bad.length ? 1 : 0);
