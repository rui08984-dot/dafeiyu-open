#!/usr/bin/env node
/**
 * check-programs.mjs —— 节目单数据校验（P3a，ADR-015 §3.5 / §3.6「schema + 白名单」）
 *
 * 校验 `pet-runtime/data/programs/*.json` 每一条：
 *   ① schema：id/title/beats 必填，license（若有）必须 original；
 *   ② 白名单：beat.seg 必须存在于 CHOREO_DATA（写错段名 = 演到一半没画面）；
 *   ③ 时长/段数：总时长 ≤90s（按每段 maxMs 计）、段数 ≤3；
 *   ④ 台词：≤60 字、不含换行；sfx 只允许短 id；transitionMs 0–2000；
 *   ⑤ id 唯一、目录里至少有 1 条。
 *
 * 用法：node pet-runtime/tools/check-programs.mjs [目录]
 * 退出码：0 全过 / 1 有失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHOREO_DATA } from '../desktop/choreo-performances.mjs';
import { validateProgram, PROGRAM_LIMITS } from '../desktop/perf/program-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(HERE, '..', 'data', 'programs');
const DIR = path.resolve(process.argv[2] || DEFAULT_DIR);

const SEGMENTS = (CHOREO_DATA && CHOREO_DATA.performances) || {};
const isKnownSegment = (seg) => Object.prototype.hasOwnProperty.call(SEGMENTS, String(seg));

let files = [];
try {
  files = fs.readdirSync(DIR).filter((f) => /\.json$/i.test(f)).sort();
} catch (e) {
  console.error('✗ 读不到节目单目录：' + DIR + '（' + (e && e.message) + '）');
  process.exit(1);
}

console.log('节目单目录：' + DIR);
console.log('CHOREO_DATA 段：' + Object.keys(SEGMENTS).length + ' 条\n');

const errors = [];
const seen = new Map();
const rows = [];

if (!files.length) {
  console.error('✗ 目录里没有任何 .json 节目单');
  process.exit(1);
}

for (const name of files) {
  const file = path.join(DIR, name);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(name + '：JSON 解析失败（' + (e && e.message) + '）');
    continue;
  }
  const v = validateProgram(doc, { isKnownSegment });
  const id = v.id || name;
  if (seen.has(id)) errors.push(name + '：id 与 ' + seen.get(id) + ' 重复（' + id + '）');
  else seen.set(id, name);
  for (const err of v.errors) errors.push(name + '：' + err);
  rows.push({
    file: name,
    id: v.id || '?',
    title: String((doc && doc.title) || ''),
    beats: v.beats.length,
    totalMs: v.totalMs,
    ok: v.ok,
    segs: v.beats.map((b) => b.seg + '(' + Math.round(b.maxMs / 100) / 10 + 's)').join(' → '),
  });
}

const pad = (s, n) => {
  const t = String(s);
  return t + ' '.repeat(Math.max(0, n - [...t].length));
};
console.log(pad('文件', 26) + pad('id', 22) + pad('段', 4) + pad('总时长', 9) + '状态');
for (const r of rows) {
  console.log(pad(r.file, 26) + pad(r.id, 22) + pad(r.beats, 4)
    + pad((r.totalMs / 1000).toFixed(1) + 's', 9) + (r.ok ? '✓' : '✗'));
  if (r.segs) console.log('  ' + r.segs + '  「' + r.title + '」');
}

console.log('\n上限：段数 ≤' + PROGRAM_LIMITS.maxBeats + '，总时长 ≤' + (PROGRAM_LIMITS.totalMs / 1000)
  + 's，台词 ≤' + PROGRAM_LIMITS.lineChars + ' 字');

if (errors.length) {
  console.error('\n✗ ' + errors.length + ' 个问题：');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('\n✓ ' + rows.length + ' 条节目单全部通过');
process.exit(0);
