// performance-log.mjs —— 表演决策日志（2026-11-17 六十六轮；2026-11-25 P0 语义拆分）
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
// ── 2026-11-25 P0（ADR-015 §3.0 组件 0.2 / 审计 §3.5）──
// 旧实现有两个语义混在一起（`lp.at` 是**开始**时间）：
//   · 用户在 30 秒长戏的第 5 秒打字「打断」—— 记成「被接」；
//   · 演完 60 秒后才说话 —— 也记成「被接」。
// 现在拆开（旧字段全部保留，只增不减）：
//   · phase='during'   播放中的输入 = 打断（导演用「打断率」）；
//   · phase='afterEnd' 演完后 90 秒内的输入 = 被吸引（「被接率」只统计这一档）；
//   · `perf.end` 记 endedBy（natural/interrupt/budget/error）与实际时长。
// 没有 perf.end 的旧日志（phase 缺失）在分析里按「未分档」处理，不与新样本混算。
//
// 不记什么：不记用户原文（隐私）、不记参数帧（太大）。
//
// 纯模块：append/now 都注入，node 里可单测。

/** 用户接话的观察窗口（与 speech-budget 的「回应窗口」同量级） */
export const FOLLOW_WINDOW_MS = 90 * 1000;

/** 与 ADR-015 / 审计同口径：>10 秒算「长段」（片段库 87/97 段都落在这边） */
export const LONG_PERF_MS = 10 * 1000;

/** endedBy 的合法值（导演/调度器按它分账） */
export const ENDED_BY = Object.freeze(['natural', 'interrupt', 'budget', 'error']);

/**
 * 哪些 source 算「自动演出」（吃导演日预算/长段预算）。
 * manual/scenes 是用户点名或场景脚本，不是她主动演 —— 不计（2026-11-25 P1 真机实测修正）。
 */
export const AUTO_SOURCES = Object.freeze(['auto', 'peak', 'idle']);

/** 一条 play 是否自动来源（未知来源按自动算：宁可保守，不让预算被绕过） */
export function isAutoSource(source) {
  return String(source || '').trim() !== 'manual';
}

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
    lastPlay: null,      // {id,at,endedAt,endedBy,actualMs,clipId,label,emotion,perfKind,durationMs}
    playSeq: 0,
    lastUserAfterId: 0,  // 同一次表演只配对一次（按 play id，不用时间戳）
    outcomes: [],        // 最近 10 次播放的结果（导演被接率闭环用，O(1) 读；phase 区分 during/afterEnd）
    day: { key: '', plays: 0, long: 0, autoPlays: 0, autoLong: 0, manualPlays: 0, manualLong: 0, requests: 0, blocked: 0 },
    stats: {
      plays: 0, skips: 0, userAfter: 0, during: 0, afterEnd: 0,
      ends: 0, requests: 0, starts: 0, interrupts: 0, programs: 0,
      bySource: {}, byReason: {}, byEndedBy: {}, byRequestReason: {},
    },
  };

  function dayKeyOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  function rollDay(ts) {
    const key = dayKeyOf(ts);
    if (state.day.key !== key) {
      state.day = { key, plays: 0, long: 0, autoPlays: 0, autoLong: 0, manualPlays: 0, manualLong: 0, requests: 0, blocked: 0 };
    }
    return state.day;
  }

  function write(rec) {
    const ts = now();
    const line = { ts, ...rec };
    state.recent.push(line);
    if (state.recent.length > keep) state.recent.shift();
    const day = rollDay(ts);
    if (line.kind === 'play') {
      state.stats.plays += 1;
      state.stats.bySource[line.source || '?'] = (state.stats.bySource[line.source || '?'] || 0) + 1;
      state.playSeq += 1;
      const long = Number(line.durationMs) > LONG_PERF_MS;
      state.lastPlay = {
        id: state.playSeq,
        at: ts,
        endedAt: null,
        endedBy: null,
        actualMs: null,
        clipId: line.clipId,
        label: line.label,
        emotion: line.emotion,
        perfKind: line.perfKind || null,
        durationMs: Number.isFinite(Number(line.durationMs)) ? Number(line.durationMs) : null,
      };
      state.outcomes.push({ id: state.playSeq, at: ts, endedAt: null, replied: false, phase: null, long, auto: isAutoSource(line.source) });
      if (state.outcomes.length > 10) state.outcomes.shift();
      day.plays += 1;
      if (long) day.long += 1;
      if (isAutoSource(line.source)) {
        day.autoPlays += 1;
        if (long) day.autoLong += 1;
      } else {
        day.manualPlays += 1;
        if (long) day.manualLong += 1;
      }
    } else if (line.kind === 'skip') {
      state.stats.skips += 1;
      state.stats.byReason[line.reason || '?'] = (state.stats.byReason[line.reason || '?'] || 0) + 1;
    } else if (line.kind === 'user_input_after') {
      state.stats.userAfter += 1;
      if (line.phase === 'during') state.stats.during += 1;
      else if (line.phase === 'afterEnd') state.stats.afterEnd += 1;
    } else if (line.kind === 'perf.end') {
      state.stats.ends += 1;
      state.stats.byEndedBy[line.endedBy || '?'] = (state.stats.byEndedBy[line.endedBy || '?'] || 0) + 1;
    } else if (line.kind === 'perf.start') {
      state.stats.starts += 1;
    } else if (line.kind === 'perf.interrupt') {
      state.stats.interrupts += 1;
    } else if (line.kind === 'perf.program') {
      state.stats.programs += 1;
    } else if (line.kind === 'perf.request') {
      state.stats.requests += 1;
      state.stats.byRequestReason[line.reason || '?'] = (state.stats.byRequestReason[line.reason || '?'] || 0) + 1;
      day.requests += 1;
      if (line.allowed === false) day.blocked += 1;
    }
    try { append(JSON.stringify(line) + '\n'); } catch (e) { /* 写日志失败绝不影响表演 */ }
    return line;
  }

  /**
   * 记一次导演决策。
   * @param {object} p
   * @param {'peak'|'idle'|'manual'|'auto'} p.source
   * @param {string} p.emotion      决策时的情绪（未经归一）
   * @param {number} p.intensity
   * @param {object} p.decision     导演返回（clipId?/label?/reason/detail）
   * @param {boolean} p.played      是否真的播了
   * @param {'clip'|'v2'|'scenes'|'program'} [p.perfKind] 播放器类型（日预算/长段统计用）
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
    if (p.perfKind) base.perfKind = String(p.perfKind);
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

  /**
   * 一次演出结束（自然演完 / 被打断 / 预算砍掉 / 出错）。
   * 不传任何参数时按「自然结束」记，actualMs 用开始到现在。
   * 传 clipId 时只有「当前 lastPlay 就是它」才记 —— 防止片段 stop 把 v2 的账结掉。
   * @param {{endedBy?:'natural'|'interrupt'|'budget'|'error', actualMs?:number, plannedMs?:number, clipId?:string}} [p]
   */
  function noteEnd(p = {}) {
    const lp = state.lastPlay;
    if (!lp || lp.endedAt != null) return null;
    if (p.clipId != null && String(p.clipId) !== String(lp.clipId)) return null;
    const at = now();
    const endedBy = ENDED_BY.includes(String(p.endedBy)) ? String(p.endedBy) : 'natural';
    const actualMs = Number.isFinite(Number(p.actualMs))
      ? Math.max(0, Number(p.actualMs))
      : Math.max(0, at - lp.at);
    lp.endedAt = at;
    lp.endedBy = endedBy;
    lp.actualMs = actualMs;
    for (let i = state.outcomes.length - 1; i >= 0; i -= 1) {
      if (state.outcomes[i].id === lp.id) { state.outcomes[i].endedAt = at; break; }
    }
    return write({
      kind: 'perf.end',
      clipId: lp.clipId,
      label: lp.label,
      perfKind: lp.perfKind,
      plannedMs: Number.isFinite(Number(p.plannedMs)) ? Number(p.plannedMs) : lp.durationMs,
      actualMs: Math.round(actualMs),
      endedBy,
    });
  }

  /**
   * 用户发来一句话（在 feedText 里调）。
   * 播放中 → during（打断）；演完后 90s 内 → afterEnd（被吸引）。同一次表演只配对一次。
   */
  function noteUserInput() {
    const lp = state.lastPlay;
    if (!lp) return null;
    const t = now();
    const base = {
      clipId: lp.clipId,
      label: lp.label,
      emotion: lp.emotion || '',
      perfKind: lp.perfKind || null,
    };
    if (lp.endedAt != null) {
      const sinceEnd = t - lp.endedAt;
      if (sinceEnd < 0 || sinceEnd > FOLLOW_WINDOW_MS) return null;
      if (state.lastUserAfterId === lp.id) return null;
      state.lastUserAfterId = lp.id;
      for (let i = state.outcomes.length - 1; i >= 0; i -= 1) {
        if (state.outcomes[i].id === lp.id) { state.outcomes[i].replied = true; state.outcomes[i].phase = 'afterEnd'; break; }
      }
      return write({
        kind: 'user_input_after',
        phase: 'afterEnd',
        ...base,
        ms: Math.round(Math.max(0, t - lp.at)),
        sinceEndMs: Math.round(sinceEnd),
      });
    }
    const dt = t - lp.at;
    if (dt < 0 || dt > FOLLOW_WINDOW_MS) return null;
    if (state.lastUserAfterId === lp.id) return null;
    state.lastUserAfterId = lp.id;
    for (let i = state.outcomes.length - 1; i >= 0; i -= 1) {
      if (state.outcomes[i].id === lp.id) { state.outcomes[i].replied = true; state.outcomes[i].phase = 'during'; break; }
    }
    return write({
      kind: 'user_input_after',
      phase: 'during',
      ...base,
      ms: Math.round(dt),
      sinceEndMs: null,
    });
  }

  /**
   * 一次演出**真正开始**（调度器 'start' 事件；ADR-015 §4.4）。
   * 与 'play' 的区别：play 是决策（可能还在排队/收势），start 是画面真的换到它了。
   * @param {{key?:string, owner?:string, plannedMs?:number}} [p]
   */
  function noteStart(p = {}) {
    return write({
      kind: 'perf.start',
      key: p.key == null ? null : String(p.key),
      owner: p.owner == null ? '' : String(p.owner),
      plannedMs: Number.isFinite(Number(p.plannedMs)) ? Math.round(Number(p.plannedMs)) : null,
    });
  }

  /**
   * 一次**抢占**（旧层收势、新层 pending；ADR-015 §4.4）。
   * atRelax=false 表示显式手动立即抢（没有等 relax 点），true 表示等到静止点才切。
   * @param {{from?:string, to?:string, atRelax?:boolean, retractMs?:number}} [p]
   */
  function noteInterrupt(p = {}) {
    return write({
      kind: 'perf.interrupt',
      from: p.from == null ? '' : String(p.from),
      to: p.to == null ? '' : String(p.to),
      atRelax: p.atRelax === true,
      retractMs: Number.isFinite(Number(p.retractMs)) ? Math.round(Number(p.retractMs)) : 0,
    });
  }

  /**
   * 节目单的一步（P3a，ADR-015 §3.5 遥测）：`perf.program`
   * `{scope, programId, beatIdx, beatKey, lineLen, actualMs, endedBy}`。
   * 与 'play'/'perf.end' 分开记：节目单是「一次事件里的多段」，按 beat 才能回答
   * 「第二段是不是每次都演不完」。旧 kind/旧分析脚本完全不受影响（只增一个新 kind）。
   * @param {{scope?:'program'|'beat', phase?:string, programId?:string, title?:string,
   *          beatIdx?:number, beatKey?:string, lineLen?:number, actualMs?:number,
   *          plannedMs?:number, endedBy?:string, beats?:number}} [p]
   */
  function noteProgram(p = {}) {
    const lineLen = Number(p.lineLen);
    const actualMs = Number(p.actualMs);
    return write({
      kind: 'perf.program',
      scope: p.scope === 'program' ? 'program' : 'beat',
      phase: p.phase == null ? '' : String(p.phase),
      programId: p.programId == null ? '' : String(p.programId),
      title: p.title == null ? '' : String(p.title),
      beatIdx: Number.isFinite(Number(p.beatIdx)) ? Math.round(Number(p.beatIdx)) : -1,
      beatKey: p.beatKey == null ? '' : String(p.beatKey),
      lineLen: Number.isFinite(lineLen) ? lineLen : 0,
      actualMs: Number.isFinite(actualMs) ? Math.round(actualMs) : 0,
      plannedMs: Number.isFinite(Number(p.plannedMs)) ? Math.round(Number(p.plannedMs)) : null,
      endedBy: p.endedBy == null ? '' : String(p.endedBy),
      beats: Number.isFinite(Number(p.beats)) ? Math.round(Number(p.beats)) : null,
    });
  }

  /**
   * 导演每次「问一句」都记一条（P0 dry-run 的主产物）。
   * @param {{owner?:string, key?:string, perfKind?:string, priority?:number,
   *          presence?:string, intensity?:number, maxMs?:number, allowed?:boolean,
   *          reason?:string, mode?:string, budgetLeft?:object}} p
   */
  function noteRequest(p = {}) {
    return write({
      kind: 'perf.request',
      owner: p.owner || 'unknown',
      key: p.key || null,
      perfKind: p.perfKind || null,
      presence: p.presence || '',
      intensity: Number.isFinite(Number(p.intensity)) ? +Number(p.intensity).toFixed(2) : null,
      maxMs: Number.isFinite(Number(p.maxMs)) ? Math.round(Number(p.maxMs)) : null,
      allowed: p.allowed === true,
      reason: p.reason || null,
      mode: p.mode || '',
      budgetLeft: p.budgetLeft || null,
    });
  }

  /** 导演/performanceDebug 用的 O(1) 快照（只读内存，不读文件） */
  function summary(atMs) {
    const t = Number.isFinite(Number(atMs)) ? Number(atMs) : now();
    const win = 10 * 60 * 1000;
    let plays10 = 0;
    let long10 = 0;
    let autoPlays10 = 0;
    for (const line of state.recent) {
      if (line.kind !== 'play') continue;
      if (!(t - Number(line.ts) <= win)) continue;
      plays10 += 1;
      if (Number(line.durationMs) > LONG_PERF_MS) long10 += 1;
      if (isAutoSource(line.source)) autoPlays10 += 1;
    }
    const day = rollDay(t);
    let ended = 0;
    let replied = 0;
    // 最近 10 次（内存 ring）按阶段分开：during = 打断，afterEnd = 被吸引（导演只看后者）
    let duringSamples = 0;
    let duringReplies = 0;
    let afterEndSamples = 0;
    let afterEndReplies = 0;
    for (const o of state.outcomes) {
      if (o.endedAt == null) continue;
      ended += 1;
      if (o.replied) replied += 1;
      const phase = o.phase;
      if (phase === 'during') { duringSamples += 1; if (o.replied) duringReplies += 1; }
      else if (phase === 'afterEnd') { afterEndSamples += 1; if (o.replied) afterEndReplies += 1; }
    }
    return {
      plays: state.stats.plays,
      skips: state.stats.skips,
      userAfter: state.stats.userAfter,
      during: state.stats.during,
      afterEnd: state.stats.afterEnd,
      plays10,
      long10,
      autoPlays10,
      playsToday: day.plays,
      longToday: day.long,
      autoPlaysToday: day.autoPlays,
      autoLongToday: day.autoLong,
      manualPlaysToday: day.manualPlays,
      manualLongToday: day.manualLong,
      requestsToday: day.requests,
      blockedToday: day.blocked,
      // 旧口径（全部 ended）保留，避免既有分析脚本/断言漂移
      replyRate: ended > 0 ? +(replied / ended).toFixed(3) : null,
      replySamples: ended,
      // 新口径（ADR-015 §3.0 / 审计 §3.5）：导演只认 afterEnd
      replyRateAfterEnd: afterEndSamples > 0 ? +(afterEndReplies / afterEndSamples).toFixed(3) : null,
      replySamplesAfterEnd: afterEndSamples,
      interruptRate: duringSamples > 0 ? +(duringReplies / duringSamples).toFixed(3) : null,
      interruptSamples: duringSamples,
      lastPlay: state.lastPlay ? { ...state.lastPlay } : null,
    };
  }

  return {
    noteDecision,
    noteEnd,
    noteStart,
    noteInterrupt,
    noteUserInput,
    noteRequest,
    noteProgram,
    summary,
    get stats() { return state.stats; },
    recent: (n) => state.recent.slice(-(Number(n) || 20)),
    get lastPlay() { return state.lastPlay; },
  };
}
