#!/usr/bin/env node
/**
 * annotate-performances.mjs —— 离线同步点标注（P2a，ADR-015 §3.2）
 *
 * 为什么离线：运行时没有 16ms 帧预算（实测 updateView 已用 10.7ms），任何「按能量找极小值」
 * 都必须发生在构建期。产物 `pet-runtime/data/perf-sync.json` 是**只读查表**：
 *   { version, generatedAt, hash, items: { '<key>': {durationMs, prepMs, strokeMs, relaxMs[], endMs, atomic} } }
 *
 * relax 的语义（P2a2 修正）是「**可以安全换段/收势的静止点**」，不是「动作起始瞬间」。
 * 三类素材的同步点来源：
 *   · v2 长表演（15 段）：**每个 step 的结束时刻** `start+duration`（动作收束）+ 手势
 *     `gestureSteps[].exitAt`（手放回去）+ 相邻 step 之间的空档中点（gap ≥ 400ms）。
 *     **不再**用 `step.start` —— 那是新动作的起点，在那里切等于切在动作起始瞬间。
 *   · 面部片段（97 段）：19 通道能量包络（逐帧差分的绝对值之和）的局部极小（窗口 ±0.4s），
 *     且必须过 **prominence 门槛**（窗口内峰谷差 ≥ 包络均值的 8%）—— 否则近平坦包络会产生
 *     密集伪极小（lumen-77 曾出现 46 个）。
 *   · 质量控制：每个点带 `q`：
 *       authored = 作者显式写下的静止点（手势 exitAt / step 结束且下一 step 起点间隔 ≥300ms）
 *       derived  = 算法推导的静止点（能量包络极小 / step 空档中点）
 *       inserted = 只为满足 5s 上限等距插入的填充点（不是真静止点，调度器只在没有前两类时退用它）
 *   · 间距：相邻 relax 至少 1200ms（密度上限，避免伪造密度）、最多 5000ms（ADR §3.2 可打断性）。
 *
 * 幂等（硬要求）：输入内容不变 → 输出逐字节一致。
 *   · 键排序、所有数值最多 1 位小数；`hash` 只由输入内容算出，不掺时间；
 *   · `generatedAt` 在 hash 未变时沿用旧文件的（CLI 负责），所以重复跑不产生 diff。
 *
 * 用法：
 *   node pet-runtime/tools/annotate-performances.mjs                # 生成/更新
 *   node pet-runtime/tools/annotate-performances.mjs --check        # 只校验 hash（0=最新 2=缺失 3=过期）
 *   node pet-runtime/tools/annotate-performances.mjs --out x.json   # 输出到别处（测试用）
 *   node pet-runtime/tools/annotate-performances.mjs --at 2026-01-01T00:00:00Z --json
 *
 * 纯逻辑部分全部 export，供 `_probe/test-perf-sync.cjs` 直接单测。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_ROOT = path.join(HERE, '..');
export const DEFAULT_OUT = path.join(RUNTIME_ROOT, 'data', 'perf-sync.json');
export const DEFAULT_CLIPS_DIR = path.join(RUNTIME_ROOT, 'data', 'facs-clips');
export const DEFAULT_DESKTOP_DIR = path.join(RUNTIME_ROOT, 'desktop');

export const SYNC_VERSION = 2;
/** relax 离段首/段尾的最近距离：太靠边没有意义（还在起势/已在收势） */
export const RELAX_EDGE_MS = 500;
/** 相邻 relax 的最大间距（ADR §3.2：每 3–5 秒至少一个） */
export const RELAX_MAX_GAP_MS = 5000;
/** 相邻 relax 的最小间距（密度上限：小于它就不算独立静止点，只留质量更高的那个） */
export const RELAX_MIN_GAP_MS = 1200;
/** 短于它的片段直接标记 atomic（不可被自动层打断） */
export const ATOMIC_MAX_MS = 1500;
/** 能量包络找局部极小的窗口半径（秒） */
export const MINIMA_WINDOW_S = 0.4;
/** 两个 relax 之间的最小间隔（局部极小可能帧帧相邻） */
export const MINIMA_MIN_GAP_MS = RELAX_MIN_GAP_MS;
/** prominence 门槛：窗口 ±0.4s 内的峰谷差必须 ≥ 包络均值 × 该比例（绝对闸） */
export const PROMINENCE_RATIO = 0.08;
/** 相对闸：峰谷差还必须 ≥ 窗口峰值 × 该比例（伪极小「v 就是峰」在这里清零） */
export const RELATIVE_PROMINENCE_RATIO = 0.5;
/** step 结束 → 下一 step 起点至少隔这么久，才算「作者写下的静止点」（authored） */
export const STEP_END_AUTHORED_GAP_MS = 300;
/** 相邻 step 之间至少空这么久，才在空档中点放一个 derived 点 */
export const STEP_GAP_MIN_MS = 400;

/** 质量等级：数值越小越优先（间距冲突时保留小的） */
export const RELAX_QUALITY_ORDER = Object.freeze(['authored', 'derived', 'inserted']);
const QUALITY_RANK = Object.freeze({ authored: 0, derived: 1, inserted: 2 });

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const floor1 = (v) => Math.floor((Number(v) || 0) * 10) / 10;

/** 稳定序列化（键排序），只用于哈希：同样的内容必须得到同样的字符串 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function dedupeSorted(list) {
  const out = [];
  for (const v of list) {
    if (!Number.isFinite(v)) continue;
    if (!out.length || v - out[out.length - 1] > 0.05) out.push(v);
    else if (v < out[out.length - 1]) out[out.length - 1] = v;
  }
  return out;
}

/**
 * 把候选 relax 补齐到「相邻间距 ≤ maxGap」，首尾也算锚点（0 / durationMs）。
 * 只返回时间点，**不碰轨道**；插入点按 floor 取 1 位小数，保证不会因为四舍五入把间距顶超。
 *
 * @param {number[]} pointsMs 候选点（ms）
 * @param {number} durationMs
 * @param {{maxGap?:number, edgeMs?:number, bounds?:boolean}} [opts]
 */
export function fillRelaxGaps(pointsMs, durationMs, opts = {}) {
  const end = Number(durationMs);
  if (!Number.isFinite(end) || end <= 0) return [];
  const maxGap = Number(opts.maxGap) > 0 ? Number(opts.maxGap) : RELAX_MAX_GAP_MS;
  const edge = Number(opts.edgeMs) >= 0 ? Number(opts.edgeMs) : RELAX_EDGE_MS;
  const useBounds = opts.bounds !== false;
  const lo = edge;
  const hi = Math.max(edge, end - edge);

  const inside = [];
  for (const p of Array.isArray(pointsMs) ? pointsMs : []) {
    const v = round1(p);
    if (!Number.isFinite(v)) continue;
    if (v < lo || v > hi) continue;
    inside.push(v);
  }
  const seeds = dedupeSorted(inside.sort((a, b) => a - b));

  // 锚点：0 → 各候选点 → durationMs。只在这些区间里插标。
  const anchors = useBounds ? [0, ...seeds, end] : seeds;
  if (!anchors.length) return [];
  const out = seeds.slice();
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const gap = b - a;
    if (gap <= maxGap + 1e-6) continue;
    const k = Math.ceil(gap / maxGap) - 1;
    const step = gap / (k + 1);
    for (let j = 1; j <= k; j += 1) {
      const p = floor1(a + step * j);
      if (p >= lo && p <= hi) out.push(p);
    }
  }
  return dedupeSorted(out.sort((a, b) => a - b));
}

/**
 * 从带质量标记的候选里挑出「互相至少隔 minGapMs」的点。
 * 冲突时保留质量更高的（authored > derived > inserted）；同质量保留更早的（`weight` 高的优先）。
 *
 * @param {Array<{t:number,q?:string,w?:number}>} points
 * @returns {Array<{t:number,q:string}>} 按时间升序
 */
export function selectRelaxPoints(points, durationMs, opts = {}) {
  const end = Number(durationMs);
  if (!Number.isFinite(end) || end <= 0) return [];
  const minGap = Number(opts.minGapMs) > 0 ? Number(opts.minGapMs) : RELAX_MIN_GAP_MS;
  const edge = Number(opts.edgeMs) >= 0 ? Number(opts.edgeMs) : RELAX_EDGE_MS;
  const lo = edge;
  const hi = Math.max(edge, end - edge);

  // 同一时刻的多来源候选只留最好的那个（同一毫秒既可能是 step 结束也可能是空档中点）
  const byTime = new Map();
  for (const p of Array.isArray(points) ? points : []) {
    const t = round1(p && p.t);
    const q = p && RELAX_QUALITY_ORDER.includes(p.q) ? String(p.q) : 'derived';
    if (!Number.isFinite(t) || t < lo || t > hi) continue;
    const key = t.toFixed(1);
    const next = { t, q, w: Number(p && p.w) || 0 };
    const prev = byTime.get(key);
    if (!prev) byTime.set(key, next);
    else if (QUALITY_RANK[q] < QUALITY_RANK[prev.q]) byTime.set(key, next);
    else if (QUALITY_RANK[q] === QUALITY_RANK[prev.q] && next.w > prev.w) byTime.set(key, next);
  }

  const ordered = [...byTime.values()].sort((a, b) => (
    QUALITY_RANK[a.q] - QUALITY_RANK[b.q] || b.w - a.w || a.t - b.t
  ));
  const kept = [];
  for (const p of ordered) {
    let free = true;
    for (const k of kept) {
      if (Math.abs(k.t - p.t) < minGap - 1e-6) { free = false; break; }
    }
    if (free) kept.push(p);
  }
  return kept.sort((a, b) => a.t - b.t);
}

/**
 * 在「相邻间距 > maxGap」的区间里等距插入 `inserted` 点（只标时间点，不改任何轨道）。
 * 首尾也按 maxGap 补齐 —— 否则长段开头十几秒没有可打断点，调度器「只在 relax 抢」就退化成
 * 「只能等演完」。
 *
 * @param {Array<{t:number,q:string}>} points 已经过 selectRelaxPoints 的点
 * @returns {Array<{t:number,q:string}>} 按时间升序（含原有点）
 */
export function insertRelaxPoints(points, durationMs, opts = {}) {
  const end = Number(durationMs);
  if (!Number.isFinite(end) || end <= 0) return [];
  const maxGap = Number(opts.maxGap) > 0 ? Number(opts.maxGap) : RELAX_MAX_GAP_MS;
  const minGap = Number(opts.minGapMs) > 0 ? Number(opts.minGapMs) : RELAX_MIN_GAP_MS;
  const edge = Number(opts.edgeMs) >= 0 ? Number(opts.edgeMs) : RELAX_EDGE_MS;
  const lo = edge;
  const hi = Math.max(edge, end - edge);

  const seeds = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.t)))
    .map((p) => ({ t: round1(p.t), q: String(p.q || 'derived') }))
    .sort((a, b) => a.t - b.t);
  const anchors = [0, ...seeds.map((p) => p.t), end];
  const out = seeds.slice();
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const gap = b - a;
    if (gap <= maxGap + 1e-6) continue;
    const k = Math.ceil(gap / maxGap) - 1;
    const step = gap / (k + 1);
    for (let j = 1; j <= k; j += 1) {
      const t = floor1(a + step * j);
      if (t < lo || t > hi) continue;
      // 插标也不能踩到已有点（等距步长通常 ≥ maxGap/2，这里的检查只是兜底）
      if (out.some((p) => Math.abs(p.t - t) < minGap - 1e-6)) continue;
      out.push({ t, q: 'inserted' });
    }
  }
  out.sort((a, b) => a.t - b.t);
  const uniq = [];
  for (const p of out) {
    if (!uniq.length || p.t - uniq[uniq.length - 1].t > 0.05) uniq.push(p);
  }
  return uniq;
}

/** 候选 → 带 q 的最终 relax 点（选点 + 5s 补齐） */
export function planRelax(candidates, durationMs, opts = {}) {
  return insertRelaxPoints(selectRelaxPoints(candidates, durationMs, opts), durationMs, opts);
}

/**
 * prominence 过滤（两道闸）：
 *   ① 绝对门槛：峰谷差 ≥ 包络均值 × prominenceRatio（默认 0.08）—— 杀掉「均值低到没有信号」
 *      片段里的相对极小；
 *   ② 相对门槛：峰谷差 ≥ 窗口峰值 × relativeRatio（默认 0.5）——「真静止」要求极小至少掉到
 *      周围活动水平的一半以下；峰谷差为 0 的伪极小（v 就是窗口峰）在这里清零。
 *
 * @returns {Array<{i:number, prominence:number}>} 保留下来的帧下标 + 各自的突出度
 */
export function prominenceOfMinima(env, fps, indices, opts = {}) {
  const values = Array.isArray(env) ? env : [];
  const rate = Number(fps) > 0 ? Number(fps) : 20;
  const windowSec = Number(opts.windowSec) > 0 ? Number(opts.windowSec) : MINIMA_WINDOW_S;
  const w = Math.max(1, Math.round(windowSec * rate));
  const ratio = Number(opts.prominenceRatio) >= 0 ? Number(opts.prominenceRatio) : PROMINENCE_RATIO;
  const relativeRatio = Number(opts.relativeProminenceRatio) >= 0
    ? Number(opts.relativeProminenceRatio)
    : RELATIVE_PROMINENCE_RATIO;

  let mean = 0;
  for (const v of values) if (Number.isFinite(v)) mean += v;
  mean = values.length ? mean / values.length : 0;
  const absThreshold = mean * ratio;

  const out = [];
  for (const i of Array.isArray(indices) ? indices : []) {
    if (!Number.isFinite(values[i])) continue;
    let peak = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(values.length - 1, i + w); j += 1) {
      const v = values[j];
      if (j !== i && Number.isFinite(v) && v > peak) peak = v;
    }
    const prominence = peak - values[i];
    // ① 均值为 0（整段零能量）时不放行：那里没有「停下来的时刻」这回事
    if (absThreshold <= 0 || prominence < absThreshold) continue;
    // ② 极小必须明显低于窗口峰值（真正的「停」而不是活动中的相对低点）
    if (peak <= 0 || prominence + 1e-9 < peak * relativeRatio) continue;
    out.push({ i, prominence: round1(prominence) });
  }
  return out;
}

/**
 * 密度上限选择（切点在真静止点上）：把「每 5s 一个点」当成硬约束 ——
 *   点数 = ceil(duration / 5s)，标称位置在 [0, duration] 上等距；
 *   每个标称位置在「不破坏 1200ms 最小间距、不破坏 5s 最大间距」的可行区间里
 *   吸附到最近的真静止点（能量极小）；附近没有就退回标称位置，标插入点。
 *
 * 为什么不按突出度取 Top-N：长段（lumen-77 52s）的极小挤在活动密集处，Top-N 选出来的点
 * 间距可达 8s，再靠 inserted 补齐就变成 14–15 个点（超过密度上限），而每 5s 一个真静止点
 * 既满足可打断性又不伪造密度。返回值里没有 inserted 时说明全部来自真静止点。
 *
 * @param {Array<{t:number, q?:string, w?:number}>} points 候选静止点（时间升序无所谓）
 * @returns {Array<{t:number,q:string}>} 按时间升序
 */
export function gridSnap(points, durationMs, opts = {}) {
  const dur = Number(durationMs);
  if (!Number.isFinite(dur) || dur <= 0) return [];
  const maxGap = Number(opts.maxGap) > 0 ? Number(opts.maxGap) : RELAX_MAX_GAP_MS;
  const minGap = Number(opts.minGapMs) > 0 ? Number(opts.minGapMs) : RELAX_MIN_GAP_MS;
  const edge = Number(opts.edgeMs) >= 0 ? Number(opts.edgeMs) : RELAX_EDGE_MS;
  const count = Math.max(1, Math.ceil(dur / maxGap));
  const width = dur / (count + 1);
  const cands = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.t)))
    .map((p) => ({ t: round1(p.t), q: String(p.q || 'derived'), w: Number(p.w) || 0 }))
    .sort((a, b) => a.t - b.t);

  const out = [];
  let prev = 0;
  let cursor = 0;
  for (let k = 0; k < count; k += 1) {
    const nominal = width * (k + 1);
    // 可行区间：不破最小/最大间距 + 剩余行程必须还能用剩余点覆盖 + 不贴边
    const lo = Math.max(prev + minGap, dur - maxGap * (count - k), edge);
    const hi = Math.min(prev + maxGap, dur - edge);
    let pick = null;
    let pickDist = Infinity;
    for (let i = cursor; i < cands.length; i += 1) {
      const c = cands[i];
      if (c.t < lo) { cursor = i; continue; }
      if (c.t > hi) break;
      const dist = Math.abs(c.t - nominal);
      if (dist < pickDist - 1e-9 || (Math.abs(dist - pickDist) <= 1e-9 && pick && c.w > pick.w)) {
        pick = c;
        pickDist = dist;
      }
    }
    const t = pick ? pick.t : floor1(Math.min(Math.max(nominal, lo), Math.max(lo, hi)));
    if (!(lo <= hi) && !pick) {
      // 可行区间被挤没了（极端短段）：宁可不放点，也不制造 1200ms 内的假密度
      continue;
    }
    out.push({ t: round1(t), q: pick ? pick.q : 'inserted' });
    prev = round1(t);
  }
  return out;
}





/** 每个通道逐帧差分的绝对值之和（缺通道按 0）；再做 3 帧滑动平均压掉单帧毛刺 */
export function clipEnvelope(clip, channelUniverse) {
  const src = clip && clip.channels && typeof clip.channels === 'object' ? clip.channels : {};
  const universe = Array.isArray(channelUniverse) && channelUniverse.length
    ? channelUniverse.slice()
    : Object.keys(src);
  let n = Number(clip && clip.frames) || 0;
  for (const name of universe) {
    const arr = src[name];
    if (Array.isArray(arr)) n = Math.max(n, arr.length);
  }
  const raw = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    let sum = 0;
    for (const name of universe) {
      const arr = src[name];
      if (!Array.isArray(arr)) continue;
      const a = Number(arr[i]);
      const b = Number(arr[i - 1]);
      if (Number.isFinite(a) && Number.isFinite(b)) sum += Math.abs(a - b);
    }
    raw[i] = sum;
  }
  const smooth = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    let acc = 0;
    for (let j = lo; j <= hi; j += 1) acc += raw[j];
    smooth[i] = acc / (hi - lo + 1);
  }
  return smooth;
}

/**
 * 能量包络的局部极小（窗口 ±windowSec）。
 * 平坦段（整段零能量）**不算极小**：那里没有「停下来的时刻」这回事，交给等距插标。
 * @returns {number[]} 帧下标
 */
export function findLocalMinima(env, fps, opts = {}) {
  const values = Array.isArray(env) ? env : [];
  const n = values.length;
  if (n < 3) return [];
  const rate = Number(fps) > 0 ? Number(fps) : 20;
  const windowSec = Number(opts.windowSec) > 0 ? Number(opts.windowSec) : MINIMA_WINDOW_S;
  const w = Math.max(1, Math.round(windowSec * rate));
  const minGapMs = Number(opts.minGapMs) > 0 ? Number(opts.minGapMs) : MINIMA_MIN_GAP_MS;
  const out = [];
  let lastMs = -Infinity;
  for (let i = 1; i < n - 1; i += 1) {
    if (i < w || i > n - 1 - w) continue;
    const v = values[i];
    let isMin = true;
    for (let j = i - w; j <= i + w; j += 1) {
      if (j === i) continue;
      if (values[j] < v - 1e-12) { isMin = false; break; }
    }
    if (!isMin) continue;
    // 平台（左邻右舍都等于自己）不算：整段静止会产生几百个「极小」
    if (values[i - 1] === v && values[i + 1] === v) continue;
    const ms = round1((i / rate) * 1000);
    if (ms - lastMs < minGapMs) continue;
    out.push(i);
    lastMs = ms;
  }
  return out;
}

function peakMs(env, fps, durationMs) {
  const values = Array.isArray(env) ? env : [];
  if (!values.length) return 0;
  let best = 0;
  let bestValue = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Number.isFinite(v) && v > bestValue + 1e-12) { bestValue = v; best = i; }
  }
  if (!(bestValue > 1e-9)) return 0;
  const rate = Number(fps) > 0 ? Number(fps) : 20;
  return round1(Math.min(Number(durationMs) || Infinity, (best / rate) * 1000));
}

/**
 * v2 长表演的 relax 候选（**静止点**，不是动作起点，P2a2）：
 *   · 每个 step 的结束时刻 start+duration（动作收束）。若下一 step 起点隔 ≥300ms，
 *     作者亲手留了空档 → authored；否则只算 derived（结构推导的间歇）。
 *   · 手势 exitAt（手放回去）→ authored，最干净的可打断点。
 *   · 相邻 step 之间的空档中点（gap ≥400ms）→ derived。
 * @returns {Array<{t:number,q:string}>}
 */
export function performanceCandidates(perf) {
  const src = perf && typeof perf === 'object' ? perf : {};
  const steps = Array.isArray(src.steps) ? src.steps : [];
  const gestures = Array.isArray(src.gestureSteps) ? src.gestureSteps : [];
  const out = [];

  const spans = [];
  for (const step of steps) {
    if (!step) continue;
    const start = Number(step.start);
    const duration = Number(step.duration);
    if (!Number.isFinite(start) || !Number.isFinite(duration)) continue;
    spans.push({ start, end: start + duration });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const starts = spans.map((s) => s.start);

  for (const span of spans) {
    const endMs = round1(span.end * 1000);
    const nextStart = starts.find((s) => s > span.end + 1e-9);
    const gapMs = Number.isFinite(nextStart) ? (nextStart - span.end) * 1000 : Infinity;
    out.push({ t: endMs, q: gapMs >= STEP_END_AUTHORED_GAP_MS ? 'authored' : 'derived' });
  }
  for (let i = 0; i < spans.length - 1; i += 1) {
    const gapMs = (spans[i + 1].start - spans[i].end) * 1000;
    if (gapMs < STEP_GAP_MIN_MS) continue;
    out.push({ t: round1(((spans[i].end + spans[i + 1].start) / 2) * 1000), q: 'derived' });
  }
  for (const g of gestures) {
    let exit = Number(g && g.exitAt);
    if (!Number.isFinite(exit)) {
      const start = Number(g && g.start);
      const duration = Number(g && g.duration);
      if (Number.isFinite(start) && Number.isFinite(duration)) exit = start + duration;
    }
    if (Number.isFinite(exit)) out.push({ t: round1(exit * 1000), q: 'authored' });
  }
  return out;
}

/**
 * 标注一段 v2 长表演。
 * strokeMs = 第一个非 look/tilt 的 step.start（看向/歪头是起势，不是动作主体）；
 * relax   = 静止点候选（step 结束 / 手势 exitAt / 空档中点）+ 5s 等距补齐。
 */
export function annotatePerformance(key, perf) {
  const src = perf && typeof perf === 'object' ? perf : {};
  const durationMs = round1(Number(src.duration) * 1000);
  const steps = Array.isArray(src.steps) ? src.steps : [];

  const relax = planRelax(performanceCandidates(src), durationMs);
  const strokeStep = steps
    .filter((s) => s && s.kind !== 'look' && s.kind !== 'tilt')
    .map((s) => Number(s.start))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)[0];
  return {
    durationMs,
    prepMs: 0,
    strokeMs: Number.isFinite(strokeStep) ? round1(strokeStep * 1000) : 0,
    relaxMs: relax.map((p) => p.t),
    relaxMeta: relax.map((p) => ({ t: p.t, q: p.q })),
    endMs: durationMs,
    atomic: durationMs > 0 && durationMs < ATOMIC_MAX_MS,
  };
}


/** 标注一段面部片段（19 通道能量包络的局部极小 → prominence 过滤 → 1200/5000ms 选点） */
export function annotateClip(clip, opts = {}) {
  const fps = Number(opts.fps) > 0 ? Number(opts.fps) : (Number(clip && clip.fps) > 0 ? Number(clip.fps) : 20);
  const frames = Number(clip && clip.frames) || 0;
  const durationMs = round1(Number(clip && clip.durationMs) > 0
    ? Number(clip.durationMs)
    : (frames / fps) * 1000);
  const env = clipEnvelope(clip, opts.channels);
  const atomic = durationMs > 0 && durationMs < ATOMIC_MAX_MS;
  const strokeMs = atomic ? 0 : peakMs(env, fps, durationMs);
  let relax = [];
  if (!atomic) {
    // minGapMs=0：先把所有极小都留着，交给 prominence + 网格吸附决定谁留
    const minima = findLocalMinima(env, fps, Object.assign({}, opts, { minGapMs: 0 }));
    const strong = prominenceOfMinima(env, fps, minima, opts);
    const snapped = gridSnap(strong.map((m) => ({
      t: round1((m.i / fps) * 1000),
      q: 'derived',
      // 同一网格位置距离相同时保留更突出的极小
      w: m.prominence,
    })), durationMs, opts);
    relax = insertRelaxPoints(snapped, durationMs, opts);
  }
  return {
    durationMs,
    prepMs: 0,
    strokeMs,
    relaxMs: relax.map((p) => p.t),
    relaxMeta: relax.map((p) => ({ t: p.t, q: p.q })),
    endMs: durationMs,
    atomic,
  };
}


/** 输入内容哈希（16 位 hex）：只由素材内容决定，可重复 */
export function hashSyncInputs(input) {
  const h = crypto.createHash('sha256');
  const performances = input && input.performances ? input.performances : {};
  const index = input && input.index ? input.index : {};
  const clips = input && input.clips instanceof Map ? input.clips : new Map();
  h.update('perf-sync/v' + SYNC_VERSION + '\n');
  h.update(stableStringify(performances));
  h.update('\n');
  h.update(stableStringify(index));
  h.update('\n');
  for (const id of [...clips.keys()].sort()) {
    h.update(id);
    h.update('\u0000');
    h.update(stableStringify(clips.get(id)));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

/** 统计一个 item 的 relax 质量分布（relaxMeta 与 relaxMs 一一对应；缺 relaxMeta 按 derived 计） */
function countQuality(item) {
  const relax = Array.isArray(item.relaxMs) ? item.relaxMs : [];
  const meta = Array.isArray(item.relaxMeta) ? item.relaxMeta : null;
  const acc = { authored: 0, derived: 0, inserted: 0 };
  for (let i = 0; i < relax.length; i += 1) {
    const q = meta && meta[i] && RELAX_QUALITY_ORDER.includes(meta[i].q) ? meta[i].q : 'derived';
    acc[q] += 1;
  }
  return acc;
}

/**
 * 组装产物文档（纯函数：同样的 input + 同样的 generatedAt → 逐字节一致的 JSON）。
 * @param {{performances:object, index:object, clips:Map<string,object>}} input
 * @param {{generatedAt?:string}} [opts]
 */
export function buildSyncDoc(input, opts = {}) {
  const performances = (input && input.performances) || {};
  const index = (input && input.index) || {};
  const clips = input && input.clips instanceof Map ? input.clips : new Map();
  const universe = Array.isArray(index.facsChannels) ? index.facsChannels : [];
  const raw = new Map();
  for (const key of Object.keys(performances)) raw.set(String(key), annotatePerformance(key, performances[key]));
  for (const id of [...clips.keys()]) raw.set(String(id), annotateClip(clips.get(id), { fps: index.fps, channels: universe }));
  const items = {};
  const quality = { authored: 0, derived: 0, inserted: 0 };
  for (const key of [...raw.keys()].sort()) {
    items[key] = raw.get(key);
    const q = countQuality(items[key]);
    quality.authored += q.authored;
    quality.derived += q.derived;
    quality.inserted += q.inserted;
  }
  return {
    version: SYNC_VERSION,
    generatedAt: String(opts.generatedAt || new Date().toISOString()),
    hash: hashSyncInputs(input),
    quality,
    items,
  };
}

/** 覆盖率/atomic/间距/质量分布（给 CLI 与 --json 用，不进产物文件） */
export function syncSummary(doc) {
  const items = doc && doc.items && typeof doc.items === 'object' ? doc.items : {};
  const keys = Object.keys(items);
  let performances = 0;
  let clips = 0;
  let atomic = 0;
  let maxGapMs = 0;
  let minGapMs = Infinity;
  let relaxTotal = 0;
  let nonAtomic = 0;
  const quality = { authored: 0, derived: 0, inserted: 0 };
  for (const key of keys) {
    const item = items[key] || {};
    if (key.startsWith('lumen-')) clips += 1; else performances += 1;
    const q = countQuality(item);
    quality.authored += q.authored;
    quality.derived += q.derived;
    quality.inserted += q.inserted;
    if (item.atomic === true) atomic += 1;
    else {
      nonAtomic += 1;
      const relax = Array.isArray(item.relaxMs) ? item.relaxMs : [];
      relaxTotal += relax.length;
      const points = [0, ...relax, Number(item.endMs) || 0];
      for (let i = 1; i < points.length; i += 1) {
        maxGapMs = Math.max(maxGapMs, round1(points[i] - points[i - 1]));
      }
      // 最小间距只算 relax 点之间（首尾锚点不算密度）
      for (let i = 1; i < relax.length; i += 1) minGapMs = Math.min(minGapMs, round1(relax[i] - relax[i - 1]));
    }
  }
  const total = quality.authored + quality.derived + quality.inserted;
  return {
    items: keys.length,
    performances,
    clips,
    atomic,
    nonAtomic,
    avgRelax: nonAtomic ? round1(relaxTotal / nonAtomic) : 0,
    maxGapMs: round1(maxGapMs),
    minRelaxGapMs: Number.isFinite(minGapMs) ? round1(minGapMs) : 0,
    quality,
    insertedRatio: total ? round1(quality.inserted / total) : 0,
    lumen77Relax: Array.isArray(items['lumen-77'] && items['lumen-77'].relaxMs) ? items['lumen-77'].relaxMs.length : 0,
    hash: doc && doc.hash ? String(doc.hash) : '',
    generatedAt: doc && doc.generatedAt ? String(doc.generatedAt) : '',
  };
}

/** 读输入：15 段 v2（模块导出）+ 97 段片段的 index 与每段文件 */
export async function loadInputs(opts = {}) {
  const desktopDir = opts.desktopDir || DEFAULT_DESKTOP_DIR;
  const clipsDir = opts.clipsDir || DEFAULT_CLIPS_DIR;
  const modulePath = path.join(desktopDir, 'choreo-performances.mjs');
  const mod = await import(pathToFileURL(modulePath).href);
  const data = (mod && mod.CHOREO_DATA) || (mod && mod.default && mod.default.CHOREO_DATA);
  if (!data || !data.performances) throw new Error('choreo-performances.mjs 里没有 CHOREO_DATA.performances');
  const indexPath = path.join(clipsDir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const clips = new Map();
  for (const entry of Array.isArray(index.clips) ? index.clips : []) {
    const id = String(entry && entry.id || '');
    if (!id) continue;
    const file = path.join(clipsDir, 'clips', id + '.json');
    if (!fs.existsSync(file)) throw new Error('缺少片段文件: ' + file);
    clips.set(id, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return { performances: data.performances, index, clips };
}

function readDoc(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || !doc.items) return null;
    return doc;
  } catch (e) {
    return null;
  }
}

function parseArgs(argv) {
  const args = { check: false, json: false, out: '', at: '', help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--check') args.check = true;
    else if (a === '--json') args.json = true;
    else if (a === '--out') { args.out = String(argv[i + 1] || ''); i += 1; }
    else if (a === '--at') { args.at = String(argv[i + 1] || ''); i += 1; }
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = [
  '用法: node pet-runtime/tools/annotate-performances.mjs [--check] [--out <file>] [--at <iso>] [--json]',
  '  --check   只校验 perf-sync.json 的 hash 是否与输入一致（0 最新 / 2 缺失 / 3 过期）',
  '  --out     输出路径（默认 pet-runtime/data/perf-sync.json）',
  '  --at      指定 generatedAt（测试用；默认沿用旧值或当前时间）',
].join('\n');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  const out = args.out || DEFAULT_OUT;
  const inputs = await loadInputs();
  const hash = hashSyncInputs(inputs);

  if (args.check) {
    const existing = readDoc(out);
    if (!existing) {
      console.error('perf-sync.json 缺失（' + out + '）→ 过期');
      process.exit(2);
    }
    if (String(existing.hash) !== hash) {
      console.error('perf-sync.json 过期：文件 hash=' + existing.hash + ' 输入 hash=' + hash);
      process.exit(3);
    }
    const summary = syncSummary(existing);
    if (args.json) console.log(JSON.stringify(Object.assign({ ok: true, file: out }, summary), null, 2));
    else console.log('perf-sync ✅ 最新 hash=' + hash + '（' + summary.performances + '+'
      + summary.clips + ' 项，atomic ' + summary.atomic + '，最大间距 ' + summary.maxGapMs + 'ms）');
    process.exit(0);
  }

  const existing = readDoc(out);
  // 幂等：hash 没变就沿用旧的 generatedAt，重复跑不产生 diff
  const generatedAt = args.at
    || (existing && String(existing.hash) === hash && existing.generatedAt ? String(existing.generatedAt) : '')
    || new Date().toISOString();
  const doc = buildSyncDoc(inputs, { generatedAt });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const summary = syncSummary(doc);
  if (args.json) console.log(JSON.stringify(Object.assign({ ok: true, file: out }, summary), null, 2));
  else {
    console.log('perf-sync → ' + out);
    console.log('  hash ' + summary.hash + '  generatedAt ' + summary.generatedAt);
    console.log('  覆盖 ' + summary.performances + '/15 表演 + ' + summary.clips + '/97 片段 = ' + summary.items + ' 项');
    console.log('  atomic ' + summary.atomic + ' 段（<1.5s 片段）；其余 segmented，平均 '
      + summary.avgRelax + ' 个 relax');
    console.log('  relax 质量 authored ' + summary.quality.authored + ' / derived ' + summary.quality.derived
      + ' / inserted ' + summary.quality.inserted + '（inserted 占 '
      + round1(summary.insertedRatio * 100) + '%）');
    console.log('  间距 ' + summary.minRelaxGapMs + '–' + summary.maxGapMs + 'ms（最小只看 relax 之间，最大含首尾锚点）');
    console.log('  lumen-77 relax ' + summary.lumen77Relax + ' 个');
  }
  process.exit(0);
}

const invokedDirectly = (() => {
  try {
    return path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url));
  } catch (e) {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((e) => {
    console.error('annotate-performances 失败：' + ((e && e.stack) || e));
    process.exit(1);
  });
}
