#!/usr/bin/env node
/**
 * analyze-performance-log.mjs —— 表演决策日志分析（2026-11-18 六十七轮）
 *
 * 为什么要有它（ADR-003 的「先规则、后学习」里，这步是学习的前置）：
 *   日志已经记了「每次决策 + 播完 90 秒内用户有没有接话」。但一堆 JSONL 本身不是结论。
 *   要谈「学习型导演」，先得能回答：
 *     · 哪些情绪她其实**一直没演**（no-candidate / weak-emotion 占了多大比例）
 *     · 同一情绪下她反复演的是哪几段（多样性够不够）
 *     · 演完之后用户接话的比例（按 label / 按来源分开看）
 *   这三个数决定「该补素材、该改阈值、还是该学选择器」。
 *
 * 用法：
 *   node pet-runtime/tools/analyze-performance-log.mjs                 # 默认读 performance-log.jsonl
 *   node pet-runtime/tools/analyze-performance-log.mjs --file x.jsonl --json
 *   node pet-runtime/tools/analyze-performance-log.mjs --since 24h
 *
 * 纯函数：`analyzeRecords(records)` 可直接单测；CLI 只做读文件与打印。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.join(HERE, '..', 'data', 'performance-log.jsonl');

/** 把 JSONL 文本解析成记录数组（坏行直接跳过并计数，不中断） */
export function parseLines(text) {
  const out = [];
  let bad = 0;
  for (const line of String(text || '').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const rec = JSON.parse(s);
      if (rec && typeof rec === 'object' && rec.kind) out.push(rec);
      else bad += 1;
    } catch (e) { bad += 1; }
  }
  return { records: out, bad };
}

/** 解析 --since：24h / 7d / 90m → 毫秒窗口 */
export function parseSince(s) {
  const m = /^(\d+)\s*([mhd])$/i.exec(String(s || '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 'm' ? 60 * 1000 : unit === 'h' ? 3600 * 1000 : 24 * 3600 * 1000;
  return n * mult;
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/**
 * 分析记录。
 * @param {Array<object>} records  已解析的日志记录
 * @param {{sinceMs?: number|null, now?: number}} [opts]
 */
export function analyzeRecords(records, opts = {}) {
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const since = Number(opts.sinceMs) || null;
  const rows = (Array.isArray(records) ? records : []).filter((r) => {
    if (!r || typeof r !== 'object') return false;      // 脏元素（null/数字）直接丢，别让分析脚本崩
    if (!since) return true;
    const ts = Number(r.ts);
    return Number.isFinite(ts) && now - ts <= since;
  });

  const out = {
    window: { from: null, to: null, count: rows.length, sinceMs: since },
    totals: { plays: 0, skips: 0, userAfter: 0 },
    bySource: {},
    skipReasons: {},
    playsByEmotion: {},
    playsByLabel: {},
    labelStats: {},          // label → {plays, userAfter, rate}
    clips: {},               // clipId → {plays, label, lastAt}
    latency: { medianMs: null, p90Ms: null, samples: 0 },
    distinct: { labels: 0, clips: 0 },
    // 2026-11-25 P0：打断 vs 被吸引分账（totals 保持旧形状，旧消费方不受影响）
    phases: { during: 0, afterEnd: 0, unphased: 0 },
    rates: { interruptRate: null, engagedRate: null, plays: 0 },
    durations: { avgActualMs: null, medianActualMs: null, samples: 0 },
    endedBy: {},
    byPerfKind: {},
  };

  const latencies = [];
  const labelUserAfter = {};
  const seenTs = [];
  const actualDurations = [];

  for (const r of rows) {
    const ts = Number(r.ts);
    if (Number.isFinite(ts)) seenTs.push(ts);
    if (r.kind === 'play') {
      out.totals.plays += 1;
      const src = r.source || 'unknown';
      out.bySource[src] = (out.bySource[src] || 0) + 1;
      const emo = r.emotion || '';
      out.playsByEmotion[emo] = (out.playsByEmotion[emo] || 0) + 1;
      const label = r.label || '(未知)';
      out.playsByLabel[label] = (out.playsByLabel[label] || 0) + 1;
      if (r.clipId) {
        const c = out.clips[r.clipId] || { plays: 0, label, lastAt: 0 };
        c.plays += 1;
        if (Number.isFinite(ts) && ts > c.lastAt) c.lastAt = ts;
        out.clips[r.clipId] = c;
      }
      if (!out.labelStats[label]) out.labelStats[label] = { plays: 0, userAfter: 0, rate: null };
      out.labelStats[label].plays += 1;
      const pk = r.perfKind || 'clip';
      out.byPerfKind[pk] = (out.byPerfKind[pk] || 0) + 1;
    } else if (r.kind === 'skip') {
      out.totals.skips += 1;
      const reason = r.reason || '(空)';
      out.skipReasons[reason] = (out.skipReasons[reason] || 0) + 1;
    } else if (r.kind === 'user_input_after') {
      out.totals.userAfter += 1;
      const ms = Number(r.ms);
      if (Number.isFinite(ms)) latencies.push(ms);
      const label = r.label || '(未知)';
      labelUserAfter[label] = (labelUserAfter[label] || 0) + 1;
      if (r.phase === 'during') out.phases.during += 1;
      else if (r.phase === 'afterEnd') out.phases.afterEnd += 1;
      else out.phases.unphased += 1;
    } else if (r.kind === 'perf.end') {
      const endedBy = r.endedBy || '(未标)';
      out.endedBy[endedBy] = (out.endedBy[endedBy] || 0) + 1;
      const actual = Number(r.actualMs);
      if (Number.isFinite(actual)) actualDurations.push(actual);
    }
  }

  // 「接话率」按 label：分母是该 label 的播放次数（不是日志行数）
  for (const [label, st] of Object.entries(out.labelStats)) {
    st.userAfter = labelUserAfter[label] || 0;
    st.rate = st.plays > 0 ? +(st.userAfter / st.plays * 100).toFixed(1) : null;
  }

  if (latencies.length) {
    const sorted = latencies.slice().sort((a, b) => a - b);
    out.latency.medianMs = median(latencies);
    out.latency.p90Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    out.latency.samples = latencies.length;
  }
  out.distinct.labels = Object.keys(out.playsByLabel).length;
  out.distinct.clips = Object.keys(out.clips).length;

  // 打断率 vs 被吸引率：分母都是「播放次数」，分子只算**分过档**的记录。
  // 旧日志（phase 缺失）进 unphased，不混进两个比率 —— 否则新窗口会被历史数据污染。
  out.rates.plays = out.totals.plays;
  if (out.totals.plays > 0) {
    out.rates.interruptRate = +(out.phases.during / out.totals.plays * 100).toFixed(1);
    out.rates.engagedRate = +(out.phases.afterEnd / out.totals.plays * 100).toFixed(1);
  }
  if (actualDurations.length) {
    const sum = actualDurations.reduce((a, b) => a + b, 0);
    out.durations.avgActualMs = Math.round(sum / actualDurations.length);
    out.durations.medianActualMs = median(actualDurations);
    out.durations.samples = actualDurations.length;
  }

  if (seenTs.length) {
    out.window.from = Math.min(...seenTs);
    out.window.to = Math.max(...seenTs);
  }
  return out;
}

/** 人读格式：把结论先摆出来，再给表 */
export function formatReport(a) {
  const lines = [];
  const t = a.totals;
  const totalDecisions = t.plays + t.skips;
  const playRate = totalDecisions ? (t.plays / totalDecisions * 100).toFixed(1) : '0.0';
  lines.push('== 表演决策日志 ==');
  lines.push(`记录 ${a.window.count} 条 · 播放 ${t.plays} · 跳过 ${t.skips}（播放率 ${playRate}%）· 接话 ${t.userAfter}`);
  if (a.latency.medianMs != null) {
    lines.push(`接话延迟：中位 ${a.latency.medianMs}ms · p90 ${a.latency.p90Ms}ms（样本 ${a.latency.samples}）`);
  }
  lines.push(`多样性：${a.distinct.labels} 个 label / ${a.distinct.clips} 段`);
  if (a.rates && a.rates.plays > 0) {
    lines.push(`打断率 ${a.rates.interruptRate}% · 被吸引率 ${a.rates.engagedRate}%`
      + `（分母 ${a.rates.plays} 次播放；旧日志未分档 ${(a.phases && a.phases.unphased) || 0} 条）`);
  }
  if (a.durations && a.durations.samples) {
    lines.push(`实际时长：平均 ${a.durations.avgActualMs}ms · 中位 ${a.durations.medianActualMs}ms（样本 ${a.durations.samples}）`);
  }
  if (a.endedBy && Object.keys(a.endedBy).length) {
    lines.push('结束方式：' + Object.entries(a.endedBy).sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}=${v}`).join('  '));
  }

  const fmtMap = (obj, n = 8) => Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, n)
    .map(([k, v]) => `${k}=${v}`).join('  ') || '（无）';

  lines.push('');
  lines.push('按来源：  ' + fmtMap(a.bySource));
  lines.push('按情绪：  ' + fmtMap(a.playsByEmotion));
  lines.push('跳过理由：' + fmtMap(a.skipReasons));

  const labels = Object.entries(a.labelStats).sort((x, y) => y[1].plays - x[1].plays);
  if (labels.length) {
    lines.push('');
    lines.push('label'.padEnd(14) + '播放  接话  接话率');
    for (const [label, st] of labels.slice(0, 12)) {
      lines.push(String(label).padEnd(14) + String(st.plays).padStart(3) + '  '
        + String(st.userAfter).padStart(3) + '  ' + (st.rate == null ? '-' : st.rate + '%'));
    }
  }

  // 直接给「该做什么」的判断（这是分析脚本存在的意义）
  lines.push('');
  lines.push('== 结论 ==');
  const topSkip = Object.entries(a.skipReasons).sort((x, y) => y[1] - x[1])[0];
  if (topSkip && topSkip[0] === 'weak-emotion' && topSkip[1] > t.plays) {
    lines.push('· 跳过主因是 weak-emotion：情绪强度门可能偏高，或她的情绪本来就淡 → 先看阈值，别急着训模型');
  } else if (topSkip && topSkip[0] === 'no-candidate' && topSkip[1] > 0) {
    lines.push('· 出现 no-candidate：该情绪的候选段不够/energy 门槛挡掉了 → 优先补素材或按情绪调门槛');
  } else if (topSkip && topSkip[0] === 'cooldown' && topSkip[1] > t.plays) {
    lines.push('· 跳过主因是 cooldown：她演得比 90s 门槛想演的更频繁 → 若观感不吵可放宽 gapMs');
  }
  if (t.plays >= 5 && a.distinct.clips <= 3) {
    lines.push('· 多样性偏低（≤3 段）：导演在少数几段上打转 → 检查 label→clip 池，或加同段冷却');
  }
  if (t.userAfter === 0 && t.plays >= 5) {
    lines.push('· 播了 ≥5 次但一次都没接话：要么时机不对，要么表演太轻 → 这是最该看的一格');
  } else if (t.plays > 0) {
    lines.push('· 接话率 ' + (t.userAfter / t.plays * 100).toFixed(1) + '%（注意：接话≠满意，只是「被注意到」的代理）');
  }
  // P0：把「打断」与「被吸引」分开说 —— 合成一个数字会让人把「用户嫌吵」当成「用户喜欢」。
  // 旧日志没有 phase（unphased），不能拿它算 0% 然后给建议；至少要有 1 条分档样本。
  const phased = a.phases ? (a.phases.during + a.phases.afterEnd) : 0;
  if (a.rates && a.rates.plays >= 5 && phased > 0) {
    if (a.rates.engagedRate < 15) {
      lines.push('· 被吸引率 ' + a.rates.engagedRate + '% < 15%：演完基本没人接 → 先压密度/改时机（导演 min_reply_rate 立刻会降强度）');
    }
    if (a.rates.interruptRate >= 30) {
      lines.push('· 打断率 ' + a.rates.interruptRate + '% 偏高：播放中途用户频繁输入 → 长段太多或时机太密');
    }
  }
  if (!lines[lines.length - 1].startsWith('·')) lines.push('· 样本还太少，先攒日志再下结论');
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const get = (k, d) => {
    const i = argv.indexOf('--' + k);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const file = get('file', DEFAULT_FILE);
  const sinceMs = parseSince(get('since', ''));
  const asJson = argv.includes('--json');

  if (!fs.existsSync(file)) {
    console.error('没有日志文件：' + file + '（她还没播过，或路径不对）');
    process.exit(2);
  }
  const { records, bad } = parseLines(fs.readFileSync(file, 'utf8'));
  const stats = analyzeRecords(records, { sinceMs });
  if (asJson) {
    console.log(JSON.stringify(Object.assign({ badLines: bad }, stats), null, 1));
  } else {
    console.log(formatReport(stats));
    if (bad) console.log(`（跳过 ${bad} 条无法解析的行）`);
  }
}

export { DEFAULT_FILE };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
