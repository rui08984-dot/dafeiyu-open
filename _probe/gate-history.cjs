#!/usr/bin/env node
/**
 * _probe/gate-history.cjs — 门禁「上次通过时间」台账（2026-11-18 §73，对应 §68 B4）
 *
 * 要解决的问题：门禁里有 7 项**必须真机**（8004/3003/3004/8103/控制中心），
 * 机器不在或服务没起时它们只能 SKIP。§71 已经让 SKIP 可见了，但**没人盯「多久没跑过」**——
 * 一项真机验收 40 天没跑过、门禁照旧全绿，这跟没写这条验收没区别。
 *
 * 做法（刻意很笨）：
 *   · check-all 每跑完一次，把每项的 {lastPassAt, lastSkipAt, lastFailAt, runs} 写进
 *     `pet-runtime/.state/gate-history.json`（原子写，失败只警告不阻断门禁）；
 *   · doctor 读它，对「真机项」算距今多少天，>7 天就降级提示。
 *
 * 为什么不做成数据库/服务：这张表只有「几十个键 + 三个时间戳」，一个 JSON 就够，
 * 多了就是给未来的自己加维护面。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 哪些项目算「必须真机」。用标签特征匹配，不写死清单（新增真机项自动纳入）。 */
const REAL_MACHINE_HINT = /真机|8004|3003|3004|8771|控制中心|皮套窗/;

function isRealMachine(label) {
  return REAL_MACHINE_HINT.test(String(label || ''));
}

function defaultPath(root) {
  return path.join(root, 'pet-runtime', '.state', 'gate-history.json');
}

function readHistory(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && doc.items && typeof doc.items === 'object'
      ? doc
      : { version: 1, updatedAt: 0, items: {} };
  } catch (e) {
    return { version: 1, updatedAt: 0, items: {} };
  }
}

/**
 * 把一次门禁结果并入台账。
 * @param {string} file
 * @param {Array<{label:string, ok:boolean, skip?:boolean}>} rows
 * @param {number} [now]
 * @returns {{ok:boolean, updated:number, error?:string}}
 */
function recordRun(file, rows, now) {
  const at = Number.isFinite(now) ? now : Date.now();
  const doc = readHistory(file);
  let updated = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = String((row && row.label) || '').trim();
    if (!label) continue;
    const item = doc.items[label] || { runs: 0 };
    item.runs = (Number(item.runs) || 0) + 1;
    if (row.ok && row.skip) item.lastSkipAt = at;
    else if (row.ok) { item.lastPassAt = at; item.lastStatus = 'pass'; }
    else { item.lastFailAt = at; item.lastStatus = 'fail'; }
    // 耗时样本（A1）：只留最近 20 次，够算 p50/p90 又不让台账膨胀。
    const ms = Number(row && row.ms);
    if (Number.isFinite(ms) && ms >= 0) {
      item.lastMs = Math.round(ms);
      item.msSamples = (Array.isArray(item.msSamples) ? item.msSamples : []).concat(Math.round(ms)).slice(-20);
    }
    // 失败尾 30 行（A1）：失败时把子进程输出尾部留在台账里，
    // 否则「过了一周再看为什么红」只能靠重跑（真机项重跑成本高、还可能不复现）。
    if (!row.ok && row.tail) item.lastFailTail = String(row.tail).slice(-6000);
    doc.items[label] = item;
    updated += 1;
  }
  doc.version = 1;
  doc.updatedAt = at;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, updated };
  } catch (error) {
    // 台账写不进去不能阻断门禁（它就是一份统计），但必须说出来
    try { fs.unlinkSync(file + '.tmp'); } catch (e) { /* 清不掉也无所谓 */ }
    return { ok: false, updated, error: String((error && error.message) || error) };
  }
}

/**
 * 陈旧度报告：真机项按「上次通过」距今排序，超期/从未通过的单独标出来。
 * @param {string} file
 * @param {{now?:number, staleDays?:number}} [opts]
 * @returns {{items:Array<{label:string, daysAgo:number|null, stale:boolean, lastStatus:string, runs:number}>, staleCount:number, neverRan:number}}
 */
function staleness(file, opts) {
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const staleDays = Number.isFinite(o.staleDays) ? o.staleDays : 7;
  const doc = readHistory(file);
  const items = [];
  for (const [label, item] of Object.entries(doc.items)) {
    if (!isRealMachine(label)) continue;
    const lastPass = Number(item && item.lastPassAt) || 0;
    const daysAgo = lastPass ? Math.floor((now - lastPass) / 86400000) : null;
    items.push({
      label,
      daysAgo,
      stale: lastPass ? daysAgo > staleDays : true,
      lastStatus: String((item && item.lastStatus) || (lastPass ? 'pass' : 'never')),
      runs: Number(item && item.runs) || 0,
    });
  }
  items.sort((a, b) => (b.daysAgo === null ? 9999 : b.daysAgo) - (a.daysAgo === null ? 9999 : a.daysAgo));
  return {
    items,
    staleCount: items.filter((i) => i.stale).length,
    neverRan: items.filter((i) => i.daysAgo === null).length,
  };
}

/**
 * 耗时分位数（A1）：从台账的 msSamples 算 p50/p90，供 doctor 与「冒烟档是否还够快」判据用。
 * 样本不足（<3）时 p50/p90 返回 null —— 宁可说「不知道」，也不要拿 1 个样本冒充分布。
 * @param {string} file
 * @returns {Record<string,{n:number, lastMs:number|null, p50:number|null, p90:number|null, failed:boolean}>}
 */
function latency(file) {
  const doc = readHistory(file);
  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    // nearest-rank：p90 取第 ceil(0.9n) 个（n=10 → 第 9 个，别让最大值把 p90 撑爆）
    const i = Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1));
    return s[i];
  };
  const out = {};
  for (const [label, item] of Object.entries(doc.items)) {
    const samples = (Array.isArray(item && item.msSamples) ? item.msSamples : []).filter((n) => Number.isFinite(n));
    out[label] = {
      n: samples.length,
      lastMs: Number.isFinite(Number(item && item.lastMs)) ? Number(item.lastMs) : null,
      p50: samples.length >= 3 ? pct(samples, 50) : null,
      p90: samples.length >= 3 ? pct(samples, 90) : null,
      failed: String((item && item.lastStatus) || '') === 'fail',
    };
  }
  return out;
}

module.exports = { isRealMachine, readHistory, recordRun, staleness, latency, defaultPath, REAL_MACHINE_HINT };
