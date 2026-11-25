#!/usr/bin/env node
/**
 * scripts/cleanup-memory-placeholders.mjs —— 清理「记忆库.txt」里的空交互占位（2026-11-24）
 *
 * 背景（审计 §9.3-⑧）：记忆库 2623 行里有 975 个「交互N：」头，其中 864 个下面
 * 一个字都没有 —— 因为宿主每次启动都先写占位（MessageInitializer 已改成惰性写头）。
 * 本脚本只清历史遗留，**不动**任何有内容的交互。
 *
 * 规则：
 *   · 只删「交互N：」后到下一个非空行之前没有任何内容的块（含其后的空行）；
 *   · 保留所有有内容的交互、日期头（[YYYY年MM月DD日]）、分隔线（----…）、其余空行结构；
 *   · 保留最新 K=20 个交互头（即使空），避免编号回退/最近几轮看起来断档；
 *   · 默认 dry-run（只打印统计）；--apply 才写，写前自动备份同目录
 *     `记忆库.清理备份-<YYYYMMDD-HHmmss>.txt`；
 *   · --file <path> 用于测试夹具 / 别的记录室。
 *
 * 用法：
 *   node scripts/cleanup-memory-placeholders.mjs                    # 干跑
 *   node scripts/cleanup-memory-placeholders.mjs --apply            # 真删（先备份）
 *   node scripts/cleanup-memory-placeholders.mjs --file x.txt --keep 5 --apply
 *   node scripts/cleanup-memory-placeholders.mjs --json             # 机器可读
 *
 * ⚠ 对真实 data/记忆库.txt 执行 --apply 前请先停宿主（避免并发 append 丢内容）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_KEEP = 20;
const INTERACTION_RE = /^交互\d+：\s*$/;
const INTERACTION_ANY_RE = /^交互\d+：/;
const DATE_RE = /^\[\d{4}年\d{1,2}月\d{1,2}日\]\s*$/;
const SEP_RE = /^-{10,}\s*$/;

function defaultFile() {
  try {
    const require = createRequire(import.meta.url);
    const { recordFile } = require('../js/core/records-path.js');
    return recordFile('记忆库.txt');
  } catch (e) {
    // records-path 不可用时退回「live-2d 往上两层 = my-neuro/data」
    return path.join(__dirname, '..', '..', 'data', '记忆库.txt');
  }
}

function isStructural(line) {
  return INTERACTION_ANY_RE.test(line) || DATE_RE.test(line) || SEP_RE.test(line);
}

/**
 * 分析行数组，返回要删除的行下标与统计。纯函数（不碰磁盘），便于单测。
 * @param {string[]} lines
 * @param {{keep?:number}} [options]
 */
export function analyze(lines, options = {}) {
  const keep = Number.isFinite(Number(options.keep)) ? Math.max(0, Math.floor(Number(options.keep))) : DEFAULT_KEEP;
  const headers = [];
  lines.forEach((line, i) => { if (INTERACTION_RE.test(line)) headers.push(i); });
  const keepSet = new Set(headers.slice(Math.max(0, headers.length - keep)));

  const deleteIdx = new Set();
  const stats = {
    totalLines: lines.length,
    interactions: headers.length,
    withContent: 0,
    empty: 0,
    keptEmpty: 0,
    deletedBlocks: 0,
    deletedLines: 0,
    contentLines: 0,
    dateHeaders: 0,
    separators: 0,
    kept: keep,
  };

  for (const idx of headers) {
    // 块的正文 = 头之后，直到下一个结构行（另一个交互头/日期头/分隔线）或文件末尾
    let j = idx + 1;
    let hasContent = false;
    while (j < lines.length) {
      const line = lines[j];
      if (isStructural(line)) break;
      if (line.trim()) { hasContent = true; break; }
      j += 1;
    }

    if (hasContent) {
      stats.withContent += 1;
      continue;
    }
    stats.empty += 1;
    if (keepSet.has(idx)) {
      stats.keptEmpty += 1;
      continue;
    }
    for (let k = idx; k < j; k += 1) deleteIdx.add(k);
    stats.deletedBlocks += 1;
    stats.deletedLines += (j - idx);
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (deleteIdx.has(i)) continue;
    if (DATE_RE.test(line)) stats.dateHeaders += 1;
    else if (SEP_RE.test(line)) stats.separators += 1;
    else if (line.trim() && !INTERACTION_ANY_RE.test(line)) stats.contentLines += 1;
  }

  const keptLines = lines.filter((_, i) => !deleteIdx.has(i));
  return { stats, keptLines, deleteIdx };
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseArgs(argv) {
  const args = { apply: false, json: false, file: '', keep: DEFAULT_KEEP };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--file') { args.file = argv[++i] || ''; }
    else if (a.startsWith('--file=')) args.file = a.slice('--file='.length);
    else if (a === '--keep') { args.keep = Number(argv[++i]); }
    else if (a.startsWith('--keep=')) args.keep = Number(a.slice('--keep='.length));
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error('未知参数：' + a);
  }
  return args;
}

function usage() {
  console.log([
    '用法: node scripts/cleanup-memory-placeholders.mjs [--file <path>] [--keep 20] [--apply] [--json]',
    '  默认 dry-run：只打印将删除多少空占位、保留多少内容行。',
    '  --apply：写盘前备份为同目录 记忆库.清理备份-<YYYYMMDD-HHmmss>.txt。',
  ].join('\n'));
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(String(e.message || e));
    usage();
    process.exit(2);
  }
  if (args.help) { usage(); return; }

  const file = args.file ? path.resolve(args.file) : defaultFile();
  if (!fs.existsSync(file)) {
    console.error('找不到文件：' + file);
    process.exit(2);
  }

  const original = fs.readFileSync(file, 'utf8');
  const lines = original.split('\n');           // 保留末尾空串 → join 后字节结构不变
  const { stats, keptLines } = analyze(lines, { keep: args.keep });
  const output = keptLines.join('\n');

  const result = {
    file,
    mode: args.apply ? 'apply' : 'dry-run',
    ...stats,
    remainingLines: keptLines.length,
    bytesBefore: Buffer.byteLength(original, 'utf8'),
    bytesAfter: Buffer.byteLength(output, 'utf8'),
    backup: '',
  };

  if (!args.apply) {
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('[dry-run] ' + file);
      console.log('  交互头 ' + stats.interactions + ' 个：有内容 ' + stats.withContent
        + ' / 空占位 ' + stats.empty + '（保留最新 ' + stats.keptEmpty + ' 个）');
      console.log('  将删除空占位块：' + stats.deletedBlocks + ' 个（' + stats.deletedLines + ' 行）');
      console.log('  将保留内容行：' + stats.contentLines + ' 行；日期头 ' + stats.dateHeaders
        + ' / 分隔线 ' + stats.separators);
      console.log('  行数 ' + stats.totalLines + ' → ' + keptLines.length
        + '；体积 ' + result.bytesBefore + ' → ' + result.bytesAfter + ' 字节');
      console.log('  这是干跑，未改文件。加 --apply 才写（会先备份）。');
    }
    return;
  }

  if (!stats.deletedBlocks) {
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log('没有可删的空占位块，文件未改动：' + file);
    return;
  }

  const backup = path.join(path.dirname(file),
    path.basename(file, path.extname(file)) + '.清理备份-' + stamp() + path.extname(file));
  fs.copyFileSync(file, backup);
  result.backup = backup;

  // 原子写：同目录 tmp → rename（中途被杀不会留半截文件）
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  try {
    fs.writeFileSync(tmp, output, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    throw e;
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('[apply] ' + file);
    console.log('  已备份：' + backup);
    console.log('  删除空占位块 ' + stats.deletedBlocks + ' 个（' + stats.deletedLines + ' 行）；'
      + '保留有内容交互 ' + stats.withContent + ' 个 / 内容行 ' + stats.contentLines + ' 行');
    console.log('  行数 ' + stats.totalLines + ' → ' + keptLines.length
      + '；体积 ' + result.bytesBefore + ' → ' + result.bytesAfter + ' 字节');
  }
}

// 只在直接执行时跑 main（被 import 时只提供 analyze）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  try { main(); } catch (e) {
    console.error('清理失败：' + (e && e.stack || e));
    process.exit(1);
  }
}

export { DEFAULT_KEEP };
