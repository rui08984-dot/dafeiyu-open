// perf-scheduler.mjs —— 事件化演出调度器（P2a，ADR-015 §3.1）
//
// 与 arbiter 的分工（重要，别混）：
//   · performance-arbiter = **单点 claim**：同一帧只有一个 owner，返回 busy/preempted。
//     它回答「现在谁在写」。
//   · perf-scheduler     = **换人的时机**：排队 / relax 点抢占 / 收势（retraction）/ 优先级。
//     它回答「什么时候换、换的时候旧的那层怎么收」。
//   claim 逻辑**不复制**：真正开始/结束时调 arbiter.begin/end；arbiter 不在（纯单测、
//   热重载空窗）时降级为直通，行为与旧路径一致（不抛错）。
//
// 为什么需要它（审计 §1.5 / §2.4）：
//   现状是「抢占一帧硬切」：v2 被顶掉时 choreo/choreoOverride 下一帧变 null，骨头/表情
//   直接跳回基线，原生手势 motion 还能播到 2.5s 超时；片段/长戏同帧只能二选一，没有排队，
//   也没有「说完这句再停」。演员被打断得像关电视，这就是「不像人」的一半。
//
// 规则（照 ADR-015 §3.1，逐条可测）：
//   1. 优先级 program(4) > clip(3) > v2(2) > micro/ambient(1)；manual/scenes(5) 最高。
//   2. manual/scenes 可**立即**抢占，但旧层先收势（眼/头 150ms、身体 400ms，按 channels），
//      收势期间新 owner 是 pending，不是 started。
//   3. 其它 owner 只在当前行为的 **relax 点**抢（relax 点来自离线标注 perf-sync.json）；
//      没有 relax 点（或优先级不高于当前）就排队，等当前结束。
//   4. atomic（3–4s 短场景 / <1.5s 片段）**不可被自动层打断**；manual/scenes 仍可。
//   5. 队列按「优先级 + 到达序」，最多 4 条超出直接 rejected；ttlMs 过期丢弃。
//   6. maxMs 到点**不由本模块强制结束**（它不知道画面停没停），只提供 shouldEnd(now)
//      给调用方（P2b 的 entry）在 tick 里判断。
//
// 纯模块：不 require fs / electron / DOM；now / arbiter / 日志 / 事件回调全部注入。

import { PERFORMANCE_OWNER_PRIORITY } from './performance-arbiter.mjs';

/** owner 优先级（在 arbiter 的表上补 program/ambient；arbiter 的表不动，避免影响旧路径） */
export const SCHEDULER_OWNER_PRIORITY = Object.freeze(Object.assign({}, PERFORMANCE_OWNER_PRIORITY, {
  ambient: 1,
  program: 4,
}));

/** manual/scenes 的门槛：达到它才能「立即」抢占（其它人只能等 relax 点） */
export const MANUAL_PRIORITY = 5;
/** 队列上限（ADR：最多 4 条） */
export const DEFAULT_QUEUE_LIMIT = 4;
/** 收势时长：眼/头/视线 150ms，身体 400ms（ADR §3.1） */
export const RETRACT_MS = Object.freeze({ default: 150, body: 400 });

/** 按 owner 的默认写入通道（也是收势时长的依据） */
export const DEFAULT_CHANNELS = Object.freeze({
  micro: ['face'],
  ambient: ['face'],
  clip: ['face'],
  v2: ['face', 'head', 'body'],
  program: ['face', 'head', 'body'],
  scenes: ['face', 'head', 'body', 'gaze'],
  manual: ['face', 'head', 'body', 'gaze'],
});

const BODY_CHANNELS = new Set(['body', 'pose', 'arm', 'arms', 'hand', 'hands', 'gesture']);

export function schedulerPriorityOf(owner) {
  const value = SCHEDULER_OWNER_PRIORITY[String(owner || '')];
  return Number.isFinite(value) ? value : 0;
}

export function normalizeChannels(owner, channels) {
  const list = Array.isArray(channels) ? channels : null;
  if (list && list.length) {
    const out = [];
    for (const c of list) {
      const s = String(c || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
    if (out.length) return out;
  }
  return (DEFAULT_CHANNELS[String(owner || '')] || ['face']).slice();
}

/** 收势时长：任意一个身体通道 → 400ms，否则 150ms */
export function retractMsForChannels(channels) {
  const list = Array.isArray(channels) ? channels : [];
  let ms = 0;
  for (const c of list) {
    if (BODY_CHANNELS.has(String(c).toLowerCase())) ms = Math.max(ms, RETRACT_MS.body);
    else ms = Math.max(ms, RETRACT_MS.default);
  }
  return ms || RETRACT_MS.default;
}

/**
 * 把 perf-sync.json 的一项（或外部传入的 sync）规整成调度器内部形状（**毫秒**）。
 * 兼容两种写法：`relaxMs[]`（毫秒，本仓产物）与 `relax[]` + `units:'s'`（ADR 里的秒）。
 *
 * P2a2：`relaxMs` 是「静止点」全集，其中 `inserted` 只是为满足 5s 可打断性等距插的填充点，
 * 不是真静止点。`relaxPreempt[]` 是真正允许抢占的集合：
 *   · 有 authored/derived 的点 → 只用它们（在假静止点切戏会很突兀）；
 *   · 全是 inserted（或没有 relaxMeta 的旧格式）→ 退回全集，保证长段不会完全无法打断。
 */
export function normalizeSync(sync) {
  const src = sync && typeof sync === 'object' ? sync : {};
  const useSeconds = src.units === 's' || src.unit === 's';
  const fromRelaxMs = Array.isArray(src.relaxMs);
  const source = fromRelaxMs ? src.relaxMs : (Array.isArray(src.relax) ? src.relax : []);
  const scale = fromRelaxMs ? 1 : (useSeconds ? 1000 : 1);
  const relaxMs = [];
  for (const raw of source) {
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const ms = v * scale;
    if (ms < 0) continue;
    relaxMs.push(Math.round(ms * 10) / 10);
  }
  relaxMs.sort((a, b) => a - b);
  const uniq = [];
  for (const v of relaxMs) {
    if (!uniq.length || v - uniq[uniq.length - 1] > 0.05) uniq.push(v);
  }
  // 质量表：t(ms) → q；缺项/坏项一律当作可用（旧产物没有 q，不能因此把点全封掉）
  const metaQ = new Map();
  if (Array.isArray(src.relaxMeta)) {
    for (const m of src.relaxMeta) {
      if (!m || typeof m !== 'object') continue;
      const v = Number(m.t);
      if (!Number.isFinite(v)) continue;
      metaQ.set(Math.round(v * scale * 10) / 10, String(m.q || 'derived'));
    }
  }
  const strong = metaQ.size ? uniq.filter((v) => metaQ.get(v) !== 'inserted') : uniq.slice();
  let relaxPreempt = strong.length ? strong : uniq.slice();
  // 幂等：已经 normalize 过的对象再进一次（makeRequest 会再调）不能把过滤结果丢掉
  if (!metaQ.size && Array.isArray(src.relaxPreempt)) {
    const wanted = new Set(src.relaxPreempt.map((v) => Math.round(Number(v) * 10) / 10));
    const kept = uniq.filter((v) => wanted.has(v));
    if (kept.length) relaxPreempt = kept;
  }
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const endMs = num(src.endMs) > 0 ? num(src.endMs) : num(src.end) * scale;
  const prepMs = num(src.prepMs) > 0 ? num(src.prepMs) : 0;
  const strokeMs = num(src.strokeMs) > 0 ? num(src.strokeMs) : 0;
  return {
    prepMs,
    strokeMs,
    relaxMs: uniq,
    relaxPreempt,
    endMs: Math.max(0, endMs),
    atomic: src.atomic === true,
  };
}

/**
 * 读取 `perf-sync.json`（纯模块：readFile 由调用方注入，典型是 `fs.readFileSync`）。
 * **任何问题都返回 null，不抛** —— 缺文件时调度器退化为「整段 atomic」，不是崩溃。
 *
 * @param {{file?:string, readFile?:(file:string)=>string}} [input]
 */
export function loadSync(input = {}) {
  try {
    const opts = input && typeof input === 'object' ? input : { file: input };
    const file = opts.file ? String(opts.file) : '';
    const read = typeof opts.readFile === 'function' ? opts.readFile : null;
    if (!file || !read) return null;
    const raw = read(file);
    // readFileSync 不传 encoding 会给 Buffer —— 两种都吃
    const text = typeof raw === 'string' ? raw : (raw && typeof raw.toString === 'function' ? raw.toString('utf8') : '');
    if (!text || !text.trim()) return null;
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || !doc.items || typeof doc.items !== 'object') return null;
    return doc;
  } catch (e) {
    return null;
  }
}

/** 从 sync 文档里取某项；没有 → null（调用方据此走「整段 atomic」） */
export function syncFor(doc, key) {
  try {
    if (!doc || !doc.items || typeof doc.items !== 'object') return null;
    const item = doc.items[String(key)];
    if (!item || typeof item !== 'object') return null;
    return normalizeSync(item);
  } catch (e) {
    return null;
  }
}

/**
 * @param {{now?:()=>number, arbiter?:object|null, log?:(line:string)=>void,
 *          onChange?:(event:object)=>void, queueLimit?:number}} [opts]
 */
export function createScheduler(opts = {}) {
  const now = typeof opts.now === 'function'
    ? opts.now
    : () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
  const log = typeof opts.log === 'function' ? opts.log : null;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  const queueLimit = Number.isFinite(opts.queueLimit) && opts.queueLimit > 0
    ? Math.floor(opts.queueLimit)
    : DEFAULT_QUEUE_LIMIT;
  const arbiter = opts.arbiter && typeof opts.arbiter.begin === 'function' ? opts.arbiter : null;

  let current = null;
  const queue = [];
  // 2026-11-25 对抗审计 P0-1：tick 用「上一帧 → 本帧」的区间判 relax，
  // 不能要求帧钟恰好等于 relax 时刻（16.7ms 步进永远踩不中）。
  let lastTickAt = null;
  let seq = 0;
  let logBudget = 12;

  const stats = {
    requests: 0,
    started: 0,
    pending: 0,
    rejected: 0,
    preempts: 0,
    retractions: 0,
    finished: 0,
    natural: 0,
    interrupts: 0,
    expired: 0,
    cancelled: 0,
  };
  const yields = {};

  function note(line) {
    if (!log || logBudget <= 0) return;
    logBudget -= 1;
    try { log('[perf-sched] ' + line); } catch (e) { /* 日志失败不影响调度 */ }
  }

  function emit(type, payload) {
    if (!onChange) return;
    try { onChange(Object.assign({ type, at: now() }, payload || {})); } catch (e) { /* 事件失败不影响调度 */ }
  }

  function recordYield(owner, reason) {
    const name = String(owner || 'unknown');
    yields[name] = (yields[name] || 0) + 1;
    return yields[name];
  }

  const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

  function makeRequest(req) {
    const owner = String(req.owner || '');
    if (!owner) return null;
    const priority = Number.isFinite(Number(req.priority)) ? Number(req.priority) : schedulerPriorityOf(owner);
    const sync = normalizeSync(req.sync);
    const kind = req.kind === 'atomic' || sync.atomic ? 'atomic' : 'segmented';
    const channels = normalizeChannels(owner, req.channels);
    const maxMs = Number.isFinite(Number(req.maxMs)) && Number(req.maxMs) > 0
      ? Number(req.maxMs)
      : (sync.endMs > 0 ? sync.endMs : 0);
    const ttlMs = Number.isFinite(Number(req.ttlMs)) && Number(req.ttlMs) > 0 ? Number(req.ttlMs) : 0;
    const t = now();
    seq += 1;
    return {
      token: 's' + seq,
      owner,
      key: req.key == null ? '' : String(req.key),
      title: req.title == null ? '' : String(req.title),
      priority,
      kind,
      sync,
      channels,
      maxMs,
      ttlMs,
      preempt: req.preempt === true,
      legacy: req.legacy === true,
      requestedAt: t,
      seq,
      expiresAt: ttlMs > 0 ? t + ttlMs : 0,
      waitReason: '',
      waitRelaxAt: 0,
    };
  }

  // ── arbiter 桥（不复制 claim 逻辑）────────────────────────────────────
  // arbiter 不在、或调用时抛错 → 直通（行为与没有 claim 的旧路径一致），
  // 并在 status().degraded 里如实标出来，而不是把整段表演拦死。
  let arbiterBroken = false;

  function arbiterBegin(item) {
    if (!arbiter || arbiterBroken) {
      // 降级直通：没有 arbiter 时自己发的 token 就是唯一凭据
      return { ok: true, token: item.token, reason: 'passthrough' };
    }
    try {
      const admitted = arbiter.begin(item.owner, {
        key: item.key,
        title: item.title,
        durationMs: item.maxMs,
        ttlMs: item.ttlMs > 0 ? item.ttlMs : undefined,
        token: item.token,
        preempt: item.preempt === true,
      });
      return admitted && typeof admitted === 'object' ? admitted : { ok: false, reason: 'arbiter-no-result' };
    } catch (e) {
      arbiterBroken = true;
      note('arbiter.begin 抛错 → 降级直通');
      return { ok: true, token: item.token, reason: 'passthrough-error' };
    }
  }

  function arbiterEnd(owner, token) {
    if (!arbiter || arbiterBroken || typeof arbiter.end !== 'function') return false;
    try { return arbiter.end(owner, token); } catch (e) { return false; }
  }

  function arbiterAvailableFor(owner) {
    if (!arbiter || arbiterBroken || typeof arbiter.availableFor !== 'function') return true;
    try { return arbiter.availableFor(owner) !== false; } catch (e) { return true; }
  }

  // ── 队列 ────────────────────────────────────────────────────────────
  function pruneQueue(t) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const item = queue[i];
      if (item.expiresAt > 0 && t >= item.expiresAt) {
        queue.splice(i, 1);
        stats.expired += 1;
        recordYield(item.owner, 'ttl');
        emit('expired', { owner: item.owner, key: item.key, token: item.token, reason: item.waitReason || 'ttl' });
      }
    }
  }

  function removeQueued(token) {
    if (!token) return null;
    const idx = queue.findIndex((item) => item.token === String(token));
    if (idx < 0) return null;
    return queue.splice(idx, 1)[0];
  }

  function enqueue(item) {
    if (queue.length >= queueLimit) {
      stats.rejected += 1;
      recordYield(item.owner, 'queue-full');
      note('reject ' + item.owner + ' queue-full (' + queue.length + ')');
      return false;
    }
    queue.push(item);
    stats.pending += 1;
    emit('pending', {
      owner: item.owner, key: item.key, token: item.token,
      reason: item.waitReason || 'wait', waitRelaxAt: item.waitRelaxAt || 0,
    });
    return true;
  }

  function sortQueue() {
    queue.sort((a, b) => (b.priority - a.priority) || (a.requestedAt - b.requestedAt) || (a.seq - b.seq));
  }

  /**
   * 给显式手动（优先级 5）用：队列满时挤掉最低优先级的一条，而不是拒绝用户的操作。
   * 同优先级时仍按队列上限拒绝（不破坏「最多 4 条」）。
   */
  function enqueuePriority(item) {
    if (queue.length >= queueLimit) {
      sortQueue();
      const victim = queue[queue.length - 1];
      if (!victim || victim.priority >= item.priority) return enqueue(item);
      queue.pop();
      recordYield(victim.owner, 'evicted');
      emit('expired', { owner: victim.owner, key: victim.key, token: victim.token, reason: 'evicted' });
    }
    return enqueue(item);
  }

  /** 取队列里最该演的一条（priority desc → 到达序），返回并移除 */
  function pickQueued() {
    if (!queue.length) return null;
    sortQueue();
    return queue.shift();
  }

  // ── 生命周期 ────────────────────────────────────────────────────────
  function start(item, preAdmitted = null) {
    const t = now();
    const admitted = preAdmitted || arbiterBegin(item);
    if (!admitted.ok) {
      stats.rejected += 1;
      recordYield(item.owner, admitted.reason || 'busy');
      note('reject ' + item.owner + ' ' + (admitted.reason || 'busy'));
      return {
        ok: false, status: 'rejected', reason: admitted.reason || 'busy',
        holder: admitted.holder || (arbiter && arbiter.owner) || '', token: null,
      };
    }
    const ttl = item.ttlMs > 0 ? item.ttlMs : (item.maxMs > 0 ? item.maxMs + 600 : 0);
    current = {
      owner: item.owner,
      key: item.key,
      title: item.title,
      token: String(admitted.token || item.token),
      priority: item.priority,
      kind: item.kind,
      sync: item.sync,
      channels: item.channels,
      maxMs: item.maxMs,
      ttlMs: ttl,
      startedAt: t,
      requestedAt: item.requestedAt,
      expiresAt: ttl > 0 ? t + ttl : 0,
      retract: null,
    };
    stats.started += 1;
    note('start ' + current.owner + ' ' + current.key + ' ' + current.kind + ' ' + current.maxMs + 'ms');
    emit('start', {
      owner: current.owner, key: current.key, token: current.token,
      kind: current.kind, priority: current.priority, plannedMs: current.maxMs,
    });
    return {
      ok: true, status: 'started', reason: 'started', token: current.token,
      owner: current.owner, key: current.key, priority: current.priority,
      since: current.startedAt, durationMs: current.maxMs, expiresAt: current.expiresAt,
      session: arbiter && arbiter.session && typeof arbiter.session.status === 'function'
        ? arbiter.session.status() : null,
    };
  }

  function releaseCurrent(endedBy, extra = {}) {
    if (!current) return null;
    const cur = current;
    current = null;
    arbiterEnd(cur.owner, cur.token);
    const actualMs = round1(now() - cur.startedAt);
    stats.finished += 1;
    if (endedBy === 'natural') stats.natural += 1;
    else if (endedBy === 'interrupt') stats.interrupts += 1;
    else if (endedBy === 'expired') stats.expired += 1;
    else if (endedBy === 'cancelled') stats.cancelled += 1;
    emit('end', {
      owner: cur.owner, key: cur.key, token: cur.token, endedBy,
      plannedMs: cur.maxMs, actualMs, atRelax: extra.atRelax === true,
      retractMs: extra.retractMs || 0,
    });
    note('end ' + cur.owner + ' ' + cur.key + ' endedBy=' + endedBy + ' ' + actualMs + 'ms');
    return cur;
  }

  /**
   * 只记账/发事件，不动 arbiter：用于「arbiter 已经原子完成转移」的替换路径。
   * （同 owner 的 refresh、旧 API 的 preempt 都在 arbiter 里一步完成，不能先 end 再 begin，
   *   否则失败时会留下「旧层还在写但 claim 没了」的静默双写窗口。）
   */
  function noteReplaced(prev, endedBy) {
    if (!prev) return;
    stats.finished += 1;
    if (endedBy === 'interrupt') stats.interrupts += 1;
    const actualMs = round1(now() - prev.startedAt);
    emit('end', {
      owner: prev.owner, key: prev.key, token: prev.token, endedBy,
      plannedMs: prev.maxMs, actualMs, atRelax: false, retractMs: 0,
    });
    note('replace ' + prev.owner + ' ' + prev.key + ' → ' + endedBy + ' ' + actualMs + 'ms');
  }

  /**
   * 开收势：旧层还在写（按通道 150/400ms 淡出），新层进入 pending。
   * 收势结束后由 tick() 完成「end 旧 → start 新」，中途不经过 stop/start 的空档。
   */
  function beginRetraction(item, reason, atRelax) {
    const ms = retractMsForChannels(current.channels);
    current.retract = {
      until: now() + ms,
      ms,
      reason,
      atRelax: atRelax === true,
      nextToken: item.token,
    };
    if (!queue.some((q) => q.token === item.token) && !enqueuePriority(item)) {
      // 队列连挤位都失败（同优先级塞满）：不要启动一个「收势完却没人接班」的空档
      current.retract = null;
      return false;
    }
    stats.preempts += 1;
    stats.retractions += 1;
    emit('retract', {
      from: current.owner, to: item.owner, ms, reason,
      atRelax: atRelax === true, fromToken: current.token, toToken: item.token,
    });
    note('retract ' + current.owner + ' → ' + item.owner + ' ' + ms + 'ms (' + reason + ')');
    return true;
  }

  /** 收势结束：换人（先 end 旧，再 start 新；arbiter 在这两点之间是空的） */
  function handoff() {
    if (!current || !current.retract) return null;
    const nextToken = current.retract.nextToken;
    const retractMs = current.retract.ms;
    const atRelax = current.retract.atRelax === true;
    releaseCurrent('interrupt', { atRelax, retractMs });
    const next = removeQueued(nextToken) || pickQueued();
    if (!next) return null;
    const result = start(next);
    if (!result.ok) return startNext();
    return result;
  }

  function startNext() {
    let item = pickQueued();
    while (item) {
      const result = start(item);
      if (result.ok) return result;
      item = pickQueued();
    }
    return null;
  }

  /**
   * 当前行为的「下一个可抢占 relax 点」（绝对时间）；没有 → null。
   * 用 `relaxPreempt`（真静止点）而不是 `relaxMs` 全集：inserted 只是 5s 可打断性的填充点。
   */
  function nextRelaxAt(cur, t) {
    if (!cur || !cur.sync) return null;
    const list = Array.isArray(cur.sync.relaxPreempt) ? cur.sync.relaxPreempt : cur.sync.relaxMs;
    if (!Array.isArray(list) || !list.length) return null;
    const elapsed = t - cur.startedAt;
    for (const rel of list) {
      // 用 >= 而不是 >：tick 恰好落在 relax 时刻的那一帧必须能抢（否则会跳过一个点）
      if (rel >= elapsed - 1e-6) return { at: cur.startedAt + rel, relaxMs: rel };
    }
    return null;
  }

  /**
   * 2026-11-25 P0-1：本帧区间 (from, to] 是否跨过 relax 点。
   * `from === -Infinity` 表示首次 tick：允许用「已经到点的最早 relax」（收势可以补做）。
   * 返回最早被跨过的点，避免一帧跨多个点时跳到最后。
   */
  function relaxCrossed(cur, from, to) {
    if (!cur || !cur.sync) return null;
    const list = Array.isArray(cur.sync.relaxPreempt) ? cur.sync.relaxPreempt : cur.sync.relaxMs;
    if (!Array.isArray(list) || !list.length) return null;
    const eFrom = from - cur.startedAt;
    const eTo = to - cur.startedAt;
    let best = null;
    for (const rel of list) {
      if (rel > eFrom + 1e-6 && rel <= eTo + 1e-6) {
        if (!best || rel < best.relaxMs) best = { at: cur.startedAt + rel, relaxMs: rel };
      }
    }
    return best;
  }

  function effectiveEndAt(cur) {
    const maxMs = cur.maxMs > 0 ? cur.maxMs : 0;
    const syncEnd = cur.sync.endMs > 0 ? cur.sync.endMs : 0;
    const values = [maxMs, syncEnd].filter((v) => v > 0);
    if (!values.length) return 0;
    return cur.startedAt + Math.min.apply(null, values);
  }

  /** 状态自愈：ttl 过期、收势到点。不改优先级，不做抢占判断（那是 tick 的活）。 */
  function settle(t) {
    pruneQueue(t);
    if (current && current.expiresAt > 0 && t >= current.expiresAt) {
      releaseCurrent('expired');
      startNext();
    }
    if (current && current.retract && t >= current.retract.until) handoff();
  }

  // ── 对外 API ────────────────────────────────────────────────────────
  /**
   * @param {{owner:string, key?:string, priority?:number, kind?:'atomic'|'segmented',
   *          sync?:object, channels?:string[], maxMs?:number, ttlMs?:number, preempt?:boolean,
   *          legacy?:boolean}} req
   */
  function request(req = {}) {
    const item = makeRequest(req || {});
    if (!item) {
      return { ok: false, status: 'rejected', reason: 'owner', token: null };
    }
    stats.requests += 1;
    const t = now();
    settle(t);

    // 同 owner 同 key 已在队列：后来的请求顶掉前一条（同一个表演不重复排队）；
    // 不同 key 是两次不同的演出，都留在队列里（队列上限负责兜底）
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      if (queue[i].owner === item.owner && queue[i].key === item.key && queue[i].token !== item.token) {
        const dropped = queue.splice(i, 1)[0];
        // P2（对抗审计）：替换排队项也要发 expired，否则 entry 的 schedPending 留幽灵
        emit('expired', { owner: dropped.owner, key: dropped.key, token: dropped.token, reason: 'replaced' });
        recordYield(dropped.owner, 'superseded');
        emit('expired', { owner: dropped.owner, key: dropped.key, token: dropped.token, reason: 'superseded' });
      }
    }

    if (current && current.owner === item.owner) {
      // 同 owner 重入：替换（旧 arbiter 的 refresh 语义；claim 在 arbiter 里一步刷新，
      // 不先 end 再 begin —— 中间任何失败都会留下「演着但没有 claim」的窗口）
      const prev = current;
      const result = start(item);
      if (!result.ok) return result;
      noteReplaced(prev, 'replace');
      return Object.assign({}, result, { reason: 'refresh' });
    }

    if (!current) {
      return start(item);
    }

    // ── 旧调用点（begin/end）：逐位旧行为，不排队、不收势 ──
    if (item.legacy) {
      const canPreempt = item.preempt === true && item.priority >= current.priority;
      if (!canPreempt) {
        stats.rejected += 1;
        recordYield(item.owner, 'busy');
        return {
          ok: false, status: 'rejected', reason: 'busy', token: null,
          holder: current.owner, heldKey: current.key,
        };
      }
      const prev = current;
      const prevOwner = current.owner;
      const prevKey = current.key;
      const prevToken = current.token;
      // 先让 arbiter 原子转移（preempt=true），成功后再改本地状态：
      // 失败时旧的 claim 原封不动，不会出现「旧层还在写但没人记账」
      const admitted = arbiterBegin(item);
      if (!admitted.ok) {
        stats.rejected += 1;
        recordYield(item.owner, admitted.reason || 'busy');
        return {
          ok: false, status: 'rejected', reason: admitted.reason || 'busy', token: null,
          holder: admitted.holder || prevOwner, heldKey: prevKey,
        };
      }
      const result = start(item, admitted);
      noteReplaced(prev, 'interrupt');
      return Object.assign({}, result, {
        preempted: prevOwner,
        preemptedKey: prevKey,
        preemptedToken: prevToken,
      });
    }

    // ── 优先级 5（manual/scenes）：立即抢占，但先收势 ──
    if (item.priority >= MANUAL_PRIORITY) {
      if (current.retract) {
        // 已经在收势：新请求接替「下一个」的位置，避免两轮收势叠在一起
        removeQueued(current.retract.nextToken);
        current.retract.nextToken = item.token;
        current.retract.reason = 'manual';
        item.waitReason = 'manual-next';
        if (!enqueuePriority(item)) {
          return { ok: false, status: 'rejected', reason: 'queue-full', token: null };
        }
        return {
          ok: true, status: 'preempting', reason: 'manual-next', token: item.token,
          owner: item.owner, key: item.key, pendingOwner: item.owner,
        };
      }
      item.waitReason = 'manual';
      if (!beginRetraction(item, 'manual', false)) {
        return { ok: false, status: 'rejected', reason: 'queue-full', token: null };
      }
      return {
        ok: true, status: 'preempting', reason: 'manual', token: item.token,
        owner: item.owner, key: item.key, retractMs: current.retract.ms,
        from: current.owner, fromToken: current.token,
      };
    }

    // ── 自动层：只在 relax 点抢；否则排队等 end ──
    const canOutrank = item.priority > current.priority;
    if (canOutrank && current.kind === 'segmented') {
      const relax = nextRelaxAt(current, t);
      if (relax) {
        item.waitReason = 'relax';
        item.waitRelaxAt = relax.at;
        if (!enqueue(item)) {
          return { ok: false, status: 'rejected', reason: 'queue-full', token: null };
        }
        return {
          ok: true, status: 'pending', reason: 'relax', token: item.token,
          owner: item.owner, key: item.key, relaxAt: relax.at,
          waitMs: Math.max(0, Math.round(relax.at - t)), from: current.owner,
        };
      }
    }

    item.waitReason = current.kind === 'atomic' ? 'atomic' : 'end';
    if (!enqueue(item)) {
      return { ok: false, status: 'rejected', reason: 'queue-full', token: null };
    }
    return {
      ok: true, status: 'pending', reason: item.waitReason, token: item.token,
      owner: item.owner, key: item.key, from: current.owner,
    };
  }

  /**
   * 2026-11-25 P1-5：节目单跨 beat 换段时更新当前 claim 的 sync（relax 表按新段算）。
   * token 不匹配/未在演 → false。
   */
  function updateSync(token, sync) {
    if (!current || String(current.token) !== String(token)) return false;
    current.sync = normalizeSync(sync || {});
    return true;
  }

  /**
   * 每帧/每 50ms 调一次：收势结束 → 换人；到 relax → 开始收势；空闲 → 启动队列。
   * 幂等：同一时刻重复调用不会重复开收势/重复启动。
   */
  function tick(at) {
    const t = Number.isFinite(Number(at)) ? Number(at) : now();
    const from = lastTickAt == null ? -Infinity : lastTickAt;
    lastTickAt = t;
    settle(t);
    if (!current) {
      if (queue.length) startNext();
      return status();
    }
    if (current.retract) return status();

    // 收势之后到点的 maxMs/endMs 不在这里强杀（调用方 finish）；这里只处理抢占时机
    let candidate = null;
    let atRelax = false;
    sortQueue();
    for (const item of queue) {
      if (item.priority > current.priority) {
        if (current.kind === 'segmented') {
          const relax = relaxCrossed(current, from, t);
          if (relax) {
            candidate = item;
            atRelax = true;
            break;
          }
        } else if (item.priority >= MANUAL_PRIORITY) {
          candidate = item;
          break;
        }
      } else if (item.priority >= MANUAL_PRIORITY) {
        // manual/scenes 理论上在 request 时就抢了；留在队列里只可能是收势期间排队
        candidate = item;
        break;
      }
    }
    if (candidate) {
      // 不先从队列移除：收势期间它必须留在队列里（status().pending 查的就是这条），
      // 收势完成时 handoff() 再 removeQueued(nextToken) 取走。
      beginRetraction(candidate, atRelax ? 'relax' : 'manual', atRelax);
    }
    return status();
  }

  /**
   * 自然结束 / 放弃 / 提前收场。`tokenOrOwner` 是 token（'s3'）或 owner 名（'clip'）。
   * 命中当前 → 释放并立刻启动队列里的下一条；命中队列 → 只移除。
   * @param {string} tokenOrOwner
   * @param {{endedBy?:string}} [options]
   */
  function finish(tokenOrOwner, options = {}) {
    const id = String(tokenOrOwner == null ? '' : tokenOrOwner);
    if (!id) return false;
    const t = now();
    pruneQueue(t);
    const endedBy = options && options.endedBy ? String(options.endedBy) : 'natural';
    if (current && (current.token === id || current.owner === id)) {
      const wasPending = current.retract ? current.retract.nextToken : '';
      current.retract = null;
      releaseCurrent(endedBy);
      let started = null;
      if (wasPending) {
        // 收势期间被 finish：收势随之中止，排在「下一个」的请求可以立刻上
        const next = removeQueued(wasPending);
        if (next) started = start(next);
      }
      if (!started || !started.ok) startNext();
      return true;
    }
    if (removeQueued(id)) {
      stats.cancelled += 1;
      emit('expired', { token: id, reason: 'cancelled' });
      return true;
    }
    return false;
  }

  /** 取消：当前 → 结束（endedBy=cancelled）；队列里 → 移除 */
  function cancel(token) {
    return finish(token, { endedBy: 'cancelled' });
  }

  function shouldEnd(at) {
    if (!current) return false;
    const t = Number.isFinite(Number(at)) ? Number(at) : now();
    const elapsed = t - current.startedAt;
    if (current.maxMs > 0 && elapsed >= current.maxMs) return true;
    if (current.sync.endMs > 0 && elapsed >= current.sync.endMs) return true;
    return false;
  }

  function status() {
    const t = now();
    const nextToken = current && current.retract ? current.retract.nextToken : '';
    const pending = nextToken ? queue.find((item) => item.token === nextToken) : null;
    const currentEnd = current ? effectiveEndAt(current) : 0;
    const relax = current ? nextRelaxAt(current, t) : null;
    return {
      current: current ? {
        owner: current.owner,
        key: current.key,
        title: current.title,
        token: current.token,
        priority: current.priority,
        kind: current.kind,
        channels: current.channels.slice(),
        startedAt: current.startedAt,
        elapsedMs: round1(t - current.startedAt),
        maxMs: current.maxMs,
        endMs: current.sync.endMs,
        remainMs: currentEnd > 0 ? Math.max(0, round1(currentEnd - t)) : 0,
        expiresInMs: current.expiresAt > 0 ? Math.max(0, round1(current.expiresAt - t)) : 0,
        nextRelaxMs: relax ? round1(relax.relaxMs) : 0,
        nextRelaxInMs: relax ? Math.max(0, round1(relax.at - t)) : 0,
        retracting: Boolean(current.retract),
        retractRemainMs: current.retract ? Math.max(0, round1(current.retract.until - t)) : 0,
        retractReason: current.retract ? current.retract.reason : '',
        shouldEnd: shouldEnd(t),
      } : null,
      pending: pending ? {
        owner: pending.owner, key: pending.key, token: pending.token,
        priority: pending.priority, kind: pending.kind, reason: pending.waitReason || 'manual',
      } : null,
      queue: queue.map((item) => ({
        owner: item.owner, key: item.key, token: item.token, priority: item.priority,
        kind: item.kind, reason: item.waitReason || 'end',
        waitRelaxAt: item.waitRelaxAt || 0,
        requestedAt: item.requestedAt,
        expiresInMs: item.expiresAt > 0 ? Math.max(0, round1(item.expiresAt - t)) : 0,
      })),
      yields: Object.assign({}, yields),
      stats: Object.assign({}, stats),
      degraded: !arbiter || arbiterBroken,
      queueLimit,
    };
  }

  // ── 兼容层（旧调用点：begin / end / availableFor）─────────────────────
  /**
   * 旧 API：语义与 createPerformanceArbiter().begin 一致（不排队、不收势）。
   * 返回形状保持旧字段（ok/reason/token/preempted/preemptedToken/holder/...）。
   */
  function begin(owner, meta = {}) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const result = request({
      owner,
      key: m.key,
      title: m.title,
      priority: m.priority,
      kind: m.kind,
      sync: m.sync,
      channels: m.channels,
      maxMs: Number(m.durationMs) > 0 ? Number(m.durationMs) : m.maxMs,
      ttlMs: m.ttlMs,
      preempt: m.preempt === true,
      legacy: true,
    });
    if (result.ok && result.status === 'started') {
      return {
        ok: true,
        reason: result.reason === 'refresh' ? 'refresh' : (result.preempted ? 'preempted' : 'acquired'),
        owner: result.owner,
        token: result.token,
        key: result.key,
        since: result.since,
        expiresAt: result.expiresAt,
        durationMs: result.durationMs,
        priority: result.priority,
        refreshed: result.reason === 'refresh' ? true : undefined,
        preempted: result.preempted,
        preemptedKey: result.preemptedKey,
        preemptedToken: result.preemptedToken,
        session: result.session,
      };
    }
    return {
      ok: false,
      reason: result.reason || 'busy',
      owner: String(owner || ''),
      holder: result.holder || '',
      heldKey: result.heldKey || '',
      token: null,
      session: null,
    };
  }

  /** 旧 API：end(owner, token)；只有 token 更精确（owner 特指当前持有者） */
  function end(owner, token) {
    const id = token ? String(token) : String(owner || '');
    return finish(id, { endedBy: 'released' });
  }

  function availableFor(owner) {
    const name = String(owner || '');
    if (!current) return arbiterAvailableFor(name);
    if (current.owner === name) return true;
    if (current.expiresAt > 0 && now() >= current.expiresAt) return true;
    return false;
  }

  function snapshot() {
    return {
      scheduler: status(),
      claim: arbiter && arbiter.claim && typeof arbiter.claim.snapshot === 'function'
        ? arbiter.claim.snapshot() : null,
      session: arbiter && arbiter.session && typeof arbiter.session.status === 'function'
        ? arbiter.session.status() : null,
    };
  }

  function reset() {
    // 先给 current/queue 发事件：entry 的 schedPending 靠它清理，否则热关会留幽灵登记
    if (current) {
      const cur = current;
      current = null;
      arbiterEnd(cur.owner, cur.token);
      emit('end', { owner: cur.owner, key: cur.key, token: cur.token, endedBy: 'cancelled', plannedMs: cur.maxMs, actualMs: round1(now() - cur.startedAt) });
    }
    for (const item of queue) emit('expired', { owner: item.owner, key: item.key, token: item.token, reason: 'reset' });
    current = null;
    queue.length = 0;
    lastTickAt = null;
    seq = 0;
    logBudget = 12;
    for (const k of Object.keys(stats)) stats[k] = 0;
    for (const k of Object.keys(yields)) delete yields[k];
  }

  return {
    request,
    tick,
    finish,
    cancel,
    shouldEnd,
    status,
    begin,
    end,
    availableFor,
    recordYield,
    snapshot,
    reset,
    updateSync,
    // 旧代码读得到的东西也尽量给（P2b 接线时不用改 entry 的只读路径）
    get claim() { return arbiter && arbiter.claim ? arbiter.claim : null; },
    get session() { return arbiter && arbiter.session ? arbiter.session : null; },
    get active() { return Boolean(current); },
    get owner() { return current ? current.owner : ''; },
    get key() { return current ? current.key : ''; },
    get token() { return current ? current.token : ''; },
    get retracting() { return Boolean(current && current.retract); },
    stats: () => Object.assign({}, stats),
  };
}
