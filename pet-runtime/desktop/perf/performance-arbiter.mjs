// performance-arbiter.mjs —— 表演占用仲裁 + 播放进度（2026-11-21 P1/P2）
//
// 要解决的两个真机问题：
//   [P1] 片段导演与 v2 长表演**同帧抢跑**。petbody-entry 里 maybeTriggerFacsClip
//        先算 busy = performer.active（那时 v2 还没启动），v2 自动启动在同帧稍后；
//        两者的触发条件同源（trig.peak w≥0.5 / perfEmo.pending weight≥0.5）→
//        同一帧两套表演同时写脸，facs-clip-director 的 busy 门被绕开。
//   [P2] 控制面板 performanceStatus() 只返回 active/key/title/auto/faces，
//        渲染层读 st.t / st.duration 永远是 0/0；「情绪增益」只写 options.emotionGain，
//        perf 路径不消费。
//
// 这里把「谁在占用表演」变成**单一仲裁点**：
//   · 所有自动层（clip / v2 / idle）启动前先 begin(owner)，占用则让位并记 yield；
//   · 显式手动（playPerformance / perform 场景）用 preempt=true，优先级最高；
//   · 同帧只能有一个 owner —— 后来的层拿到 {ok:false, reason:'busy'}，不会两套同时写脸。
//
// 优先级（用户 2026-11-21 拍板：显式手动 > 片段 > 长表演 > 微动作）：
//   scenes/manual(5) > clip(3) > v2(2) > micro(1)
// 理由：
//   · 手动是用户当场点出来的，必须立刻有反应，可以顶掉任何自动表演；
//   · 片段是短表演（几秒）且有导演自己的 90s/6min/10min4次三门，错过这次通常
//     还有下一次；长表演 19–38 秒、冷却 3 分钟，被片段挡掉更可惜 —— 但同帧时
//     片段先评估（entry 里 maybeTriggerFacsClip 在 v2 之前），所以「同帧先到先得」
//     天然等于「片段 > 长表演」；
//   · 微动作是加法偏置，本来就不占脸，列进来只是把优先级写全。
//
// 冷却与现有门（导演的 gapMs/sameClipMs/maxPer10Min、perfAuto 的 consider 冷却）
// **保持不变**：仲裁发生在决策之后/启动之前，不改变「该不该演」的判断。
//
// 纯模块：不 require fs / electron / DOM；时间源可注入（node 单测用假时钟）。

export const PERFORMANCE_OWNER_PRIORITY = Object.freeze({
  micro: 1,
  v2: 2,
  clip: 3,
  manual: 5,
  scenes: 5,
});

export function priorityOf(owner) {
  const value = PERFORMANCE_OWNER_PRIORITY[String(owner || '')];
  return Number.isFinite(value) ? value : 0;
}

function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function nowFn(opts) {
  if (opts && typeof opts.now === 'function') return opts.now;
  return () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now());
}

/**
 * 表演占用 claim（单一仲裁点）。
 *
 * @param {{now?:()=>number, log?:(line:string)=>void, yieldLogLimit?:number}} [opts]
 */
export function createPerformanceClaim(opts = {}) {
  const now = nowFn(opts);
  const log = typeof opts.log === 'function' ? opts.log : null;
  const yieldLogLimit = Number.isFinite(opts.yieldLogLimit) ? Math.max(0, opts.yieldLogLimit) : 8;
  const holder = { owner: null, key: '', token: '', since: 0, expiresAt: 0, durationMs: 0 };
  let seq = 0;
  const stats = {
    claims: 0,
    conflicts: 0,
    preempts: 0,
    releases: 0,
    expired: 0,
    logs: 0,
    yields: { micro: 0, v2: 0, clip: 0, manual: 0, scenes: 0 },
    yieldBy: {},
  };

  function clearHolder() {
    holder.owner = null;
    holder.key = '';
    holder.token = '';
    holder.since = 0;
    holder.expiresAt = 0;
    holder.durationMs = 0;
  }

  function expireIfNeeded() {
    if (holder.owner && holder.expiresAt > 0 && now() >= holder.expiresAt) {
      const expired = holder.owner;
      stats.expired += 1;
      clearHolder();
      return expired;
    }
    return null;
  }

  function recordYield(owner, meta = {}) {
    const name = String(owner || 'unknown');
    if (!Number.isFinite(stats.yields[name])) stats.yields[name] = 0;
    stats.yields[name] += 1;
    const heldBy = String(meta.heldBy || holder.owner || 'unknown');
    const key = name + '<' + heldBy + (meta.reason ? ':' + meta.reason : '');
    stats.yieldBy[key] = (stats.yieldBy[key] || 0) + 1;
    if (log && stats.yieldBy[key] === 1 && stats.logs < yieldLogLimit) {
      stats.logs += 1;
      log('yield ' + key + ' (key=' + String(meta.key || '') + ')');
    }
    return stats.yields[name];
  }

  function currentOwner() {
    expireIfNeeded();
    return holder.owner;
  }

  /**
   * 申请占用。
   *
   * 默认**不抢占**：任何别的 owner 先占了就返回 busy（自动层必须让位）。
   * 显式手动传 preempt:true：优先级 ≥ 当前持有者时抢占（同级也允许，= 用户换了一段）。
   *
   * @param {string} owner 'clip'|'v2'|'manual'|'scenes'|'micro'
   * @param {{key?:string,title?:string,durationMs?:number,ttlMs?:number,token?:string,preempt?:boolean}} [meta]
   */
  function claim(owner, meta = {}) {
    const time = now();
    expireIfNeeded();
    const name = String(owner || '');
    const priority = priorityOf(name);
    // 2026-11-21 压力测试：`Number(Infinity) || 0` 仍是 Infinity → expiresAt=Infinity，
    // 该层永不过期、低优先级层永久让位。必须用 isFinite 兜底。
    const durationMs = Number.isFinite(Number(meta.durationMs)) ? Math.max(0, Number(meta.durationMs)) : 0;
    // 过期兜底：正常由 end() 释放；duration 加一点宽限，避免「表演还在收尾
    // （performer 多采 0.4s / 片段 tick 最多晚 50ms）但 claim 已过期」的窄窗口里
    // 另一层抢先启动。
    const ttlMs = Number.isFinite(Number(meta.ttlMs)) && Number(meta.ttlMs) > 0
      ? Number(meta.ttlMs)
      : (durationMs > 0 ? durationMs + 600 : 0);
    const expiresAt = ttlMs > 0 ? time + ttlMs : 0;
    const token = String(meta.token || ('c' + (seq += 1)));

    const apply = (reason, extra = {}) => {
      holder.owner = name;
      holder.key = meta.key == null ? '' : String(meta.key);
      holder.token = token;
      holder.since = time;
      holder.expiresAt = expiresAt;
      holder.durationMs = durationMs;
      return Object.assign({
        ok: true, reason, owner: name, token, key: holder.key, since: time,
        expiresAt, durationMs, priority,
      }, extra);
    };

    if (holder.owner && holder.owner !== name) {
      const heldPriority = priorityOf(holder.owner);
      const canPreempt = meta.preempt === true && priority >= heldPriority;
      if (!canPreempt) {
        stats.conflicts += 1;
        recordYield(name, { heldBy: holder.owner, reason: 'held', key: meta.key });
        return {
          ok: false,
          reason: 'busy',
          owner: name,
          holder: holder.owner,
          heldKey: holder.key,
          heldPriority,
          priority,
          since: holder.since,
          durationMs,
        };
      }
      const preempted = holder.owner;
      const preemptedKey = holder.key;
      const preemptedToken = holder.token;
      stats.preempts += 1;
      stats.claims += 1;
      return apply('preempted', { preempted, preemptedKey, preemptedToken });
    }

    if (holder.owner === name) {
      // 同 owner：刷新/替换（新的手动演出顶掉旧的、新片段顶掉旧片段）。
      return apply('refresh', { refreshed: true });
    }

    stats.claims += 1;
    return apply('acquired');
  }

  function availableFor(owner) {
    const holderOwner = currentOwner();
    return !holderOwner || holderOwner === String(owner || '');
  }

  /** 释放占用。token 不匹配时不动（防止定时器误杀后来的占用）。 */
  function release(owner, token) {
    expireIfNeeded();
    if (!holder.owner || holder.owner !== String(owner || '')) return false;
    if (token && holder.token && String(token) !== holder.token) return false;
    clearHolder();
    stats.releases += 1;
    return true;
  }

  function snapshot() {
    expireIfNeeded();
    const time = now();
    return {
      owner: holder.owner,
      key: holder.key,
      token: holder.token,
      since: holder.since,
      forMs: holder.owner ? Math.max(0, Math.round(time - holder.since)) : 0,
      durationMs: holder.durationMs,
      expiresInMs: holder.owner && holder.expiresAt > 0 ? Math.max(0, Math.round(holder.expiresAt - time)) : 0,
      priority: holder.owner ? priorityOf(holder.owner) : 0,
      stats: {
        claims: stats.claims,
        conflicts: stats.conflicts,
        preempts: stats.preempts,
        releases: stats.releases,
        expired: stats.expired,
        yields: Object.assign({}, stats.yields),
        yieldBy: Object.assign({}, stats.yieldBy),
      },
    };
  }

  function reset() {
    clearHolder();
    seq = 0;
    stats.claims = 0;
    stats.conflicts = 0;
    stats.preempts = 0;
    stats.releases = 0;
    stats.expired = 0;
    stats.logs = 0;
    stats.yields = { micro: 0, v2: 0, clip: 0, manual: 0, scenes: 0 };
    stats.yieldBy = {};
  }

  return {
    claim,
    release,
    availableFor,
    recordYield,
    snapshot,
    reset,
    get owner() { return currentOwner(); },
    get key() { expireIfNeeded(); return holder.key; },
    get token() { expireIfNeeded(); return holder.token; },
    get active() { return Boolean(currentOwner()); },
    stats: () => snapshot().stats,
  };
}

/**
 * 播放进度（控制面板数据侧）。
 * 只记「这一段从什么时候开始、总长多少」——画面采样仍由 performer/clip 自己负责。
 *
 * @param {{now?:()=>number}} [opts]
 */
export function createPerformanceSession(opts = {}) {
  const now = nowFn(opts);
  let cur = null;

  function begin(meta = {}) {
    cur = {
      key: meta.key == null ? '' : String(meta.key),
      title: meta.title == null ? '' : String(meta.title),
      owner: meta.owner == null ? '' : String(meta.owner),
      token: meta.token == null ? '' : String(meta.token),
      startedAt: now(),
      durationMs: Math.max(0, Number(meta.durationMs) || 0),
    };
    return status();
  }

  function end(owner, token) {
    if (!cur) return false;
    if (owner && cur.owner !== String(owner)) return false;
    if (token && cur.token && String(token) !== cur.token) return false;
    cur = null;
    return true;
  }

  function status() {
    if (!cur) {
      return {
        active: false, key: '', title: '', owner: '',
        t: 0, duration: 0, tMs: 0, durationMs: 0, elapsedMs: 0,
      };
    }
    const elapsed = Math.max(0, now() - cur.startedAt);
    return {
      active: true,
      key: cur.key,
      title: cur.title,
      owner: cur.owner,
      t: round3(elapsed / 1000),
      duration: round3(cur.durationMs / 1000),
      tMs: Math.round(elapsed),
      durationMs: Math.round(cur.durationMs),
      elapsedMs: Math.round(elapsed),
    };
  }

  return { begin, end, status, get active() { return Boolean(cur); }, get owner() { return cur ? cur.owner : ''; } };
}

/**
 * 仲裁器 = claim + session。entry 只跟它打交道。
 *
 * begin(owner, meta)：
 *   · 自动层（clip/v2）不抢占，占用中返回 {ok:false, reason:'busy', holder}
 *   · 手动层传 preempt:true，可顶掉低优先级；返回 preempted 让调用方停掉旧层
 * end(owner, token)：释放 claim + 结束进度
 */
export function createPerformanceArbiter(opts = {}) {
  const now = nowFn(opts);
  const claim = createPerformanceClaim({ now, log: opts.log, yieldLogLimit: opts.yieldLogLimit });
  const session = createPerformanceSession({ now });
  let seq = 0;

  function begin(owner, meta = {}) {
    const token = String(meta.token || ('a' + (seq += 1)));
    const admitted = claim.claim(owner, Object.assign({}, meta, { token }));
    if (!admitted.ok) return Object.assign({}, admitted, { token: null, session: null });
    const sessionStatus = session.begin({
      key: meta.key,
      title: meta.title,
      durationMs: meta.durationMs,
      owner,
      token,
    });
    return Object.assign({}, admitted, { token, session: sessionStatus });
  }

  function end(owner, token) {
    const released = claim.release(owner, token);
    if (released) session.end(owner, token);
    return released;
  }

  function recordYield(owner, meta) {
    return claim.recordYield(owner, meta);
  }

  return {
    begin,
    end,
    recordYield,
    claim,
    session,
    availableFor: claim.availableFor,
    snapshot() {
      return { claim: claim.snapshot(), session: session.status() };
    },
    reset() {
      claim.reset();
      session.end();
      seq = 0;
    },
    get owner() { return claim.owner; },
    get token() { return claim.token; },
    get active() { return claim.active; },
  };
}

/**
 * 控制面板的数据侧汇总：把「仲裁占用 + 播放会话 + 片段状态 + v2 performer」
 * 合成一份 **t / duration 非零** 的状态。
 *
 * 旧 performanceStatus() 只返回 active/key/title/auto/faces，渲染层读 st.t / st.duration
 * 永远是 undefined → 进度条 0/0。这里统一产出：
 *   t       已演秒数（session 优先；只有片段在播且 session 缺失时用片段的 elapsedMs）
 *   duration 该段总时长（秒）
 *
 * @param {{
 *   session?: object, clip?: object|null, performerActive?: boolean,
 *   key?: string, title?: string, faces?: Iterable<string>, auto?: object|null,
 *   claim?: object|null
 * }} [input]
 */
export function buildPerformanceStatus(input = {}) {
  const session = input.session && typeof input.session === 'object' ? input.session : null;
  const clip = input.clip && typeof input.clip === 'object' ? input.clip : null;
  const claim = input.claim && typeof input.claim === 'object' ? input.claim : null;
  const clipPlaying = Boolean(clip && clip.playing === true);
  const sessionActive = Boolean(session && session.active === true);

  let owner = '';
  let key = '';
  let title = '';
  let t = 0;
  let durationMs = 0;

  if (sessionActive) {
    owner = String(session.owner || '');
    key = String(session.key || '');
    title = String(session.title || '');
    t = Number(session.t) || 0;
    durationMs = Number(session.durationMs) || 0;
  }
  // 片段状态是更细的实时源（它每 50ms tick）：session 与片段同时存在时以片段为准，
  // 但 owner 仍是 session 的（clip），不会把 v2 的进度写串。
  if (clipPlaying) {
    if (!sessionActive) owner = 'clip';
    if (!key) key = String(clip.clipId || '');
    if (!title) title = String(clip.label || '');
    t = (Number(clip.elapsedMs) || 0) / 1000;
    durationMs = Number(clip.durationMs) || 0;
  }

  const active = Boolean(sessionActive || clipPlaying || input.performerActive === true);
  if (!active) {
    owner = '';
    key = '';
    title = '';
    t = 0;
    durationMs = 0;
  } else if (!owner && claim && claim.owner) {
    owner = String(claim.owner);
  }

  const faces = [];
  if (input.faces) {
    try { for (const f of input.faces) faces.push(String(f)); } catch (e) { /* ignore */ }
  }

  return {
    active,
    owner,
    key,
    title,
    auto: input.auto || null,
    faces,
    t: round3(t),
    duration: round3(durationMs / 1000),
    tMs: Math.round(t * 1000),
    durationMs: Math.round(durationMs),
    claim: claim || null,
    clip: clip ? {
      playing: clipPlaying,
      clipId: String(clip.clipId || ''),
      label: String(clip.label || ''),
      elapsedMs: Number(clip.elapsedMs) || 0,
      durationMs: Number(clip.durationMs) || 0,
    } : null,
  };
}
