// performance-log.mjs —— 表演决策日志（2026-11-17 六十六轮）
//
// 为什么要有它（ADR-003 的最后一块）：
//   想训「学习型导演」（上下文 → 选哪段/多强/什么时候），第一步不是模型，是**数据**。
//   现在每次决策都过导演，但决策完就散了：我们说不出「上次她演那段时，用户有没有接着说话」
//   「哪种情绪下她其实一直没演」。这份日志把那两件事变成可分析的 JSONL。
//
// 记什么（够了，不多记）：
//   1) 每次决策：来源（peak 情绪峰值 / idle 空闲 / manual 手动）、情绪与强度、
//      导演结论（clipId/label/reason/energy）、当时是否 busy、在不在说话；
//   2) **用户有没有接话**：播完 90 秒内用户发来输入 → 记一条 user_input_after（毫秒数）。
//      这是最便宜的「她这段表演有没有被注意到」的代理信号（不是满意度，别当满意度用）。
//
// 不记什么：不记用户原文（隐私）、不记参数帧（太大）。
//
// 纯模块：append/now 都注入，node 里可单测。

/** 用户接话的观察窗口（与 speech-budget 的「回应窗口」同量级） */
export const FOLLOW_WINDOW_MS = 90 * 1000;

/**
 * @param {{append?: (line:string)=>void, now?: ()=>number, keep?: number}} opts
 *   append 由调用方接到 fs；测试里注入数组收集器。
 */
export function createPerformanceLog(opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const append = typeof opts.append === 'function' ? opts.append : () => {};
  const keep = Math.max(10, Number(opts.keep) || 200);

  const state = {
    recent: [],          // 内存里保留最近 N 条（诊断用）
    lastPlay: null,      // {at, clipId, label, emotion}
    lastUserAfterAt: 0,
    stats: { plays: 0, skips: 0, userAfter: 0, bySource: {}, byReason: {} },
  };

  function write(rec) {
    const line = { ts: now(), ...rec };
    state.recent.push(line);
    if (state.recent.length > keep) state.recent.shift();
    if (line.kind === 'play') {
      state.stats.plays += 1;
      state.stats.bySource[line.source || '?'] = (state.stats.bySource[line.source || '?'] || 0) + 1;
      state.lastPlay = { at: line.ts, clipId: line.clipId, label: line.label, emotion: line.emotion };
    } else if (line.kind === 'skip') {
      state.stats.skips += 1;
      state.stats.byReason[line.reason || '?'] = (state.stats.byReason[line.reason || '?'] || 0) + 1;
    } else if (line.kind === 'user_input_after') {
      state.stats.userAfter += 1;
    }
    try { append(JSON.stringify(line) + '\n'); } catch (e) { /* 写日志失败绝不影响表演 */ }
    return line;
  }

  /**
   * 记一次导演决策。
   * @param {object} p
   * @param {'peak'|'idle'|'manual'} p.source
   * @param {string} p.emotion      决策时的情绪（未经归一）
   * @param {number} p.intensity
   * @param {object} p.decision     导演返回（clipId?/label?/reason/detail）
   * @param {boolean} p.played      是否真的播了
   * @param {boolean} [p.busy]      当时全身表演是否在跑
   * @param {boolean} [p.speaking]
   * @param {string} [p.activity]   世界活动态
   */
  function noteDecision(p = {}) {
    const d = p.decision || {};
    const base = {
      emotion: String(p.emotion == null ? '' : p.emotion),
      intensity: Number.isFinite(Number(p.intensity)) ? +Number(p.intensity).toFixed(2) : null,
      source: p.source || 'unknown',
      busy: p.busy === true,
      speaking: p.speaking === true,
      activity: p.activity || '',
      reason: d.reason || null,
    };
    if (p.played === true && d.clipId) {
      return write({
        kind: 'play', ...base,
        clipId: d.clipId,
        label: d.label || null,
        energy: d.detail && Number.isFinite(Number(d.detail.energy)) ? Number(d.detail.energy) : null,
        durationMs: d.detail && Number.isFinite(Number(d.detail.durationMs)) ? Number(d.detail.durationMs) : null,
      });
    }
    return write({ kind: 'skip', ...base });
  }

  /** 用户发来一句话（在 feedText 里调）：若刚播过且没配过对，补一条 user_input_after */
  function noteUserInput() {
    const lp = state.lastPlay;
    if (!lp) return null;
    const dt = now() - lp.at;
    if (dt < 0 || dt > FOLLOW_WINDOW_MS) return null;
    if (state.lastUserAfterAt === lp.at) return null;   // 同一次表演只配对一次
    state.lastUserAfterAt = lp.at;
    return write({
      kind: 'user_input_after',
      clipId: lp.clipId,
      label: lp.label,
      ms: Math.round(dt),
      emotion: lp.emotion || '',
    });
  }

  return {
    noteDecision,
    noteUserInput,
    get stats() { return state.stats; },
    recent: (n) => state.recent.slice(-(Number(n) || 20)),
    get lastPlay() { return state.lastPlay; },
  };
}
