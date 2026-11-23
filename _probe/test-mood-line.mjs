#!/usr/bin/env node
/**
 * _probe/test-mood-line.mjs — 「主模型搭车带情绪」的解析与流式过滤回归（2026-11-18 §72）
 *
 * 这块最怕两件事，测试就盯这两件：
 *   ① **标记漏到 TTS**：`#mood: …` 被念出来（逐块流式下最容易漏，所以按字符喂一遍）；
 *   ② **正文被吞**：holdback 扣住了不该扣的尾巴，导致她说话缺字（同样按字符喂）。
 *
 * 纯函数，不需要 Electron / 网络。
 * 用法：node _probe/test-mood-line.mjs
 */
'use strict';

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'ai', 'mood-line.js'));
const RELAY = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'mood-relay.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

/** 把整段按给定步长切块喂给过滤器（模拟 streaming 分块） */
function feed(text, step) {
  const f = M.createMoodStreamFilter();
  let emit = '';
  for (let i = 0; i < text.length; i += step) {
    emit += f.push(text.slice(i, i + step)).emit;
  }
  const tail = f.flush();
  emit += tail.emit;
  return { emit, mood: f.mood || tail.mood };
}

console.log('\n主模型搭车情绪（§72）：');

// ① 基本形态
{
  const r = feed('她说了一句\n#mood: 有点累，不想解释', 999);
  ok('整段一次喂：正文保留、标记不进正文', r.emit === '她说了一句', JSON.stringify(r.emit));
  ok('整段一次喂：mood 提取正确', r.mood === '有点累，不想解释', r.mood);
}

// ② 逐字符 / 小块（流式最容易漏标记的地方）
{
  for (const step of [1, 2, 3, 7]) {
    const r = feed('今天有点烦\n#mood: 烦躁但嘴硬', step);
    ok(`按 ${step} 字符切块：正文无标记`, !/#\s*mood/i.test(r.emit), JSON.stringify(r.emit));
    ok(`按 ${step} 字符切块：正文完整`, r.emit === '今天有点烦', JSON.stringify(r.emit));
    ok(`按 ${step} 字符切块：mood 正确`, r.mood === '烦躁但嘴硬', r.mood);
  }
}

// ③ 无标记时一个字都不能丢
{
  for (const step of [1, 2, 5]) {
    const text = '就是普通的一句回复，没有任何标记。';
    const r = feed(text, step);
    ok(`无标记（步长 ${step}）→ 正文一字不差`, r.emit === text, JSON.stringify(r.emit));
    ok(`无标记（步长 ${step}）→ mood 为空`, r.mood === '', JSON.stringify(r.mood));
  }
}

// ④ flush：标记没有结尾换行
{
  const r = feed('嗯……算了\n#mood: 委屈', 4);
  ok('标记在结尾无换行：flush 也能吃到', r.mood === '委屈', r.mood);
  ok('标记在结尾无换行：正文干净', r.emit === '嗯……算了', JSON.stringify(r.emit));
}

// ⑤ 模型乱写：标记在中间 + 全角冒号
{
  const r = feed('前半句\n#mood： 无奈\n后半句', 3);
  ok('全角冒号也认', r.mood === '无奈', r.mood);
  ok('标记之后的正文不丢', /后半句/.test(r.emit), JSON.stringify(r.emit));
  ok('输出里绝不含标记', !/#\s*mood/i.test(r.emit), JSON.stringify(r.emit));
}

// ⑥ 标记在开头
{
  const r = feed('#mood: 挑衅\n你猜', 2);
  ok('标记在开头：mood 提取', r.mood === '挑衅', r.mood);
  ok('标记在开头：正文保留', r.emit.trim() === '你猜', JSON.stringify(r.emit));
}

// ⑦ 非流式 extractMoodLine 与流式口径一致
{
  const text = '好呀\n#mood: 开心\n';
  const ex = M.extractMoodLine(text);
  ok('extractMoodLine 剥标记', ex.text === '好呀' && ex.mood === '开心', JSON.stringify(ex));
  ok('extractMoodLine 无标记原样返回', (() => {
    const r = M.extractMoodLine('普通回复');
    return r.text === '普通回复' && r.mood === '';
  })());
  ok('extractMoodLine 只取第一处标记', M.extractMoodLine('a\n#mood: 一\nb\n#mood: 二').mood === '一');
}

// ⑧ 提示词硬约束（改坏了会让模型把标记念出来或写进正文中间）
{
  const p = M.MOOD_INSTRUCTION;
  ok('指令里写了 #mood:', p.includes('#mood:'));
  ok('指令限长 ≤20 字', /20\s*字/.test(p));
  ok('指令要求另起一行（不许混在正文里）', /另起一行/.test(p));
  ok('指令禁止加粗/引号（避免解析失败）', /不要加粗/.test(p) && /引号/.test(p));
}

// ⑨ relay：只保留最新一条 + 新鲜度
{
  RELAY.clear();
  ok('空 relay 取不到', RELAY.takeMood({ now: 1000 }) === null);
  RELAY.setMood('有点累', { now: 1000, from: 'test' });
  const got = RELAY.takeMood({ now: 2000 });
  ok('刚写的能取到', got && got.mood === '有点累' && got.ageMs === 1000, JSON.stringify(got));
  RELAY.setMood('更开心', { now: 3000 });
  ok('只保留最新一条', RELAY.takeMood({ now: 3100 }).mood === '更开心');
  ok('过期取不到（默认 20s）', RELAY.takeMood({ now: 3000 + 25000 }) === null);
  ok('空 mood 不写入', RELAY.setMood('   ') === false);
  RELAY.clear();
}

// ⑩ holdback 不该扣住普通字符（否则她说话会断续）
{
  const f = M.createMoodStreamFilter();
  const a = f.push('你');
  ok('普通字符立刻放出（不被 holdback 扣住）', a.emit === '你', JSON.stringify(a.emit));
  const b = f.push('\n');
  ok('单个换行会被扣住（可能是标记前缀）', b.emit === '', JSON.stringify(b.emit));
  const c = f.push('好');
  ok('确认不是标记后换行补发', c.emit === '\n好', JSON.stringify(c.emit));
}

console.log('');
console.log(`  主模型搭车情绪：PASS ${pass} / FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
