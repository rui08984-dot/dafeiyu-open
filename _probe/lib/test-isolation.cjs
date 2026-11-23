'use strict';
/**
 * _probe/lib/test-isolation.cjs — 测试数据隔离（A2，2026-11-21）
 *
 * 用法（顺序很重要：**必须在 require 业务模块之前**设环境变量）：
 *   const iso = require('./lib/test-isolation.cjs');
 *   const tmpRoot = iso.setUpTempDataRoot('pet-persona-');
 *   const P = require('.../dynamic-persona/index.js');       // 之后才加载业务模块
 *   const { recordFile } = require('.../js/core/records-path.js');
 *   ...
 *   iso.assertIsolated(recordFile('人格状态.json'));          // 断言真的落在临时目录
 *   ...
 *   iso.cleanup(tmpRoot);                                     // 删临时目录
 *
 * 为什么需要：测试过去对真实 data「备份-还原」，与宿主并发写同一批文件会偶发
 * EPERM / 互相覆盖。records-path 现在认 PET_DATA_ROOT，但「有没有真的隔离」必须由
 * 测试自己证明 —— 光看代码容易漏（memory-recall 就自己拼过路径，PET_DATA_ROOT
 * 对它一段时间内不生效）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 建临时数据根并设 PET_DATA_ROOT；返回目录（调用方负责 cleanup）。 */
function setUpTempDataRoot(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'pet-test-'));
  process.env.PET_DATA_ROOT = dir;
  return dir;
}

/**
 * 断言文件路径确实在 PET_DATA_ROOT 下。不在就抛错 —— 测试应判红，
 * 而不是「备份还原后假装没事」（那正是 A2 之前的老做法，会与宿主抢写）。
 * @returns {true}
 */
function assertIsolated(filePath) {
  const root = process.env.PET_DATA_ROOT;
  if (!root) throw new Error('测试未设置 PET_DATA_ROOT：会写真实数据，拒绝继续');
  const rel = path.relative(path.resolve(root), path.resolve(filePath));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('测试试图写真实数据（不在 PET_DATA_ROOT 下）：' + filePath);
  }
  return true;
}

function cleanup(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
}

module.exports = { setUpTempDataRoot, assertIsolated, cleanup };
