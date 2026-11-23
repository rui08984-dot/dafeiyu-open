#!/usr/bin/env node
/**
 * _probe/test-semantic-describe.mjs — B6 改写链的纯函数回归（2026-11-18 §69）
 *
 * 护三件事，都是「改了没人发现就会悄悄变差」的地方：
 *   ① 提示词里必须留着三条硬约束（情绪描述 / ≤20 字 / 不要复述内容）——
 *      换个措辞就可能把模型带回「解释这句话什么意思」的路子，实测那样可用率会掉。
 *   ② sanitizeDescription：去引号换行、去前导标点、截 40 字、空结果必须是空串
 *      （空串是「失败」信号，调用方据此退回原句；返回一句废话就等于喂错）。
 *   ③ 语料本身：18 条、期望情绪都在允许集合里、每句都有 oracle 描述。
 *
 * 端到端（真 LLM 改写 + 8120）见 _probe/semantic-rewrite-llm-eval.mjs ——
 * 它要花真 token，所以不进每次门禁；oracle 上限实验见 semantic-rewrite-eval.mjs。
 *
 * 用法：node _probe/test-semantic-describe.mjs
 */
'use strict';

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CASES, emotionOfCategory } from './semantic-corpus.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { DESCRIBE_SYSTEM_PROMPT, sanitizeDescription } = require(path.join(APP, 'js', 'core', 'semantic-describe.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

console.log('\n语义兜底改写链（§69 B6）：');

// ① 提示词硬约束
{
  const p = DESCRIBE_SYSTEM_PROMPT;
  ok('提示词要求「情绪描述」', /情绪描述/.test(p));
  ok('提示词限长（≤20 字）', /20\s*字/.test(p));
  ok('提示词禁止复述/解释原句', /禁止/.test(p) && /复述/.test(p) && /解释/.test(p));
  ok('提示词禁止引号（避免把引号喂给分类器）', /引号/.test(p));
}

// ② 清洗
{
  ok('去引号', sanitizeDescription('“有点委屈”') === '有点委屈');
  ok('去换行与多余空白', sanitizeDescription('有点失望\n\n 不想解释') === '有点失望 不想解释');
  ok('去前导标点', sanitizeDescription('：、有点烦') === '有点烦');
  ok('截断到 40 字', sanitizeDescription('很'.repeat(80)).length === 40);
  ok('空输入 → 空串（失败信号，不能编一句废话）',
    sanitizeDescription('') === '' && sanitizeDescription(null) === '' && sanitizeDescription(undefined) === '');
  ok('纯标点 → 空串', sanitizeDescription('“”‘’ \n ') === '');
  ok('正常短句原样保留', sanitizeDescription('有点失望和委屈，不想再解释') === '有点失望和委屈，不想再解释');
}

// ③ 语料
{
  const ALLOWED = new Set(['happy', 'sad', 'angry', 'surprised', 'shy', 'smug', 'playful', 'neutral']);
  ok('语料 18 条', CASES.length === 18, String(CASES.length));
  ok('每条都是 [原句, 期望, 描述] 三件套',
    CASES.every((c) => Array.isArray(c) && c.length === 3 && c[0] && c[2]));
  ok('期望情绪都在允许集合内', CASES.every((c) => ALLOWED.has(c[1])),
    CASES.filter((c) => !ALLOWED.has(c[1])).map((c) => c[1]).join(',') || '全部合法');
  ok('category→emotion 映射认得 LumenAct 的 27 类里的代表值',
    emotionOfCategory('难过流泪') === 'sad' && emotionOfCategory('惊讶震惊') === 'surprised'
    && emotionOfCategory('生气愤怒') === 'angry' && emotionOfCategory('害羞') === 'shy'
    && emotionOfCategory('自然放松') === 'neutral' && emotionOfCategory('不存在') === 'neutral');
}

console.log('');
console.log(`  语义兜底改写链：PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
