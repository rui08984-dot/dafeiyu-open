#!/usr/bin/env node
// gate-smoke-budget.mjs —— 冒烟档预算验收（A1，2026-11-21）
//
// 为什么要有：`--smoke` 的价值全在「30 秒内给结论」。哪天有人往冒烟档里塞了一条
// 30 秒的真机验收，单跑一次看不出来（仍然 PASS），只有连跑多次取 p95 才能发现
// 「这一档已经不再快了」。这个脚本就是那条判据的自动化。
//
// 用法：
//   node _probe/gate-smoke-budget.mjs            # 连跑 20 次（约 6 分钟）
//   node _probe/gate-smoke-budget.mjs --runs 5   # 快速抽查
//
// 判据（任一不满足即 exit 1）：
//   ① p95 ≤ 30s（与 docs/研讨-框架优化方向-2026-11-21.md 的 A1 验收一致）
//   ② 0 次失败（flake=0；--smoke 里全是纯逻辑，不该有任何随机失败）
//
// 注意：它自己**不进**任何门禁档——跑一次 6 分钟，属于「改分档逻辑后的验收工具」。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_ALL = path.join(ROOT, '_probe', 'check-all.mjs');
const BUDGET_MS = 30000;

const argIdx = process.argv.indexOf('--runs');
const runs = Math.max(1, Number(argIdx >= 0 ? process.argv[argIdx + 1] : 20) || 20);

const samples = [];
const failures = [];
for (let i = 1; i <= runs; i += 1) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CHECK_ALL, '--smoke'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
  const ms = Date.now() - t0;
  const out = String(r.stdout || '') + String(r.stderr || '');
  samples.push(ms);
  const ok = r.status === 0 && /✅ 全部通过/.test(out);
  process.stdout.write(`  ${String(i).padStart(2)}/${runs}  ${(ms / 1000).toFixed(1)}s  ${ok ? 'PASS' : 'FAIL'}\n`);
  if (!ok) failures.push({ i, ms, tail: out.split(/\r?\n/).slice(-12).join('\n') });
}

const sorted = samples.slice().sort((a, b) => a - b);
const pct = (p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
const p50 = pct(50);
const p90 = pct(90);
const p95 = pct(95);
const max = sorted[sorted.length - 1];

console.log('');
console.log(`冒烟预算验收：${runs} 次`);
console.log(`p50=${(p50 / 1000).toFixed(1)}s  p90=${(p90 / 1000).toFixed(1)}s  p95=${(p95 / 1000).toFixed(1)}s  max=${(max / 1000).toFixed(1)}s`);
console.log(`flake=${failures.length}  （失败 ${failures.length} 次）`);

let ok = true;
if (p95 > BUDGET_MS) { ok = false; console.log(`❌ p95 ${(p95 / 1000).toFixed(1)}s 超过预算 ${BUDGET_MS / 1000}s：有重活混进了冒烟档`); }
if (failures.length) {
  ok = false;
  for (const f of failures) {
    console.log(`\n--- 第 ${f.i} 次失败（${(f.ms / 1000).toFixed(1)}s）尾部 ---\n${f.tail}`);
  }
}
console.log(ok ? `✅ 通过（p95 ${(p95 / 1000).toFixed(1)}s ≤ ${BUDGET_MS / 1000}s，flake=0）` : '❌ 未通过冒烟预算验收');
process.exit(ok ? 0 : 1);
