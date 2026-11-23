/**
 * param-ownership-probe.mjs — 参数所有权护栏的纯逻辑部分（2026-11-18 §69 B3）
 *
 * 要解决的架构风险（§64 风险 3）：
 *   `EXTERNALLY_OWNED` 只是一张**数据表** —— 建画像时按它跳过口型/眼球/头身/呼吸，
 *   但运行期没有任何断言。情绪层、perf、编舞、长表演、动作层都是直接往
 *   `renderer.set()` 写同一个参数，谁的写生效取决于代码顺序。真实故障长这样：
 *   「说话抽搐」「莫名其妙的黑脸」「整场表演眼球恒等于鼠标偏移」—— 画面乱了，
 *   日志一片安静，事后只能读代码猜是哪一层抢的。
 *
 * 这里只放**纯函数**（不碰 DOM / WebGL / electron），三件事：
 *   ① LAYER        写参数的各层名字（告警文案直接用）
 *   ② evaluateFrameConflicts  帧内记账 → 冲突列表（带 owner 归属）
 *   ③ createConflictLedger    告警去重：同一个 (参数, owner 组合) 只喊一次
 *   ④ findExternalOwnershipViolations  把「外部所有权」从数据变成断言
 *
 * 记账本身在 cubism-renderer.set() 里（本来就有 _frameWrites，这次补上 owner 列），
 * 不另开一条并行管线 —— 两份记账迟早会打架。
 */

/** 写参数的层。新增一层就加在这里。 */
export const LAYER = Object.freeze({
  BASELINE: 'baseline',
  IDLE_MOTION: 'idle-motion',
  BLINK: 'blink',
  BLINK_RESTACK: 'blink-restack',
  EXPRESSION: 'expression-preset',
  EMOTION_BLEND: 'emotion-blend',
  PERF_FACES: 'perf-faces',
  PROC_MOTION: 'proc-motion',
  ACTION: 'action',
  LIP: 'lip',
  MOUTH_VISEME: 'mouth-viseme',
  CHOREO: 'choreo',
  PERF_OVERRIDE: 'perf-override',
  PREVIEW: 'preview',
  EXTERNAL: 'external',
});

/** 同帧同参数两次写的差值阈值：小于它视为「同一意图的微调」，不算抢写 */
export const CONFLICT_MIN_DELTA = 0.02;

/**
 * 「本来就是最后一道」的层：它们写同一个参数是**设计意图**，不是抢写。
 *
 * 真机基线（2026-11-18，宿主跑 100 秒）：不分类时有 15 条「冲突」，其中
 *   choreo+proc-motion / perf-override+blink / lip+perf-override 全是长表演的正常叠加
 * （加法偏置叠在待机摆动上、覆盖层是表演的最终裁决）；
 * 只有 emotion-blend+expression-preset 那种「两个基础层都以为自己说了算」才是真抢写。
 * 混在一起判红，健康哨兵会永久红 —— 那就是狼来了，最后没人看。
 */
const COMPOSING_LAYERS = new Set([LAYER.CHOREO, LAYER.PERF_OVERRIDE, LAYER.ACTION]);

/** @param {string[]} owners */
export function classifyConflict(owners) {
  const list = Array.isArray(owners) ? owners : [];
  return list.some((o) => COMPOSING_LAYERS.has(o)) ? 'compose' : 'fight';
}

/**
 * 帧内记账 → 冲突列表。
 *
 * @param {Map<string, {vals:number[], owners:string[]}>} frameWrites  set() 记下的本帧写入
 * @param {{minDelta?:number, maxItems?:number}} [opts]
 * @returns {{conflicts:{param:string,writes:number,delta:number,owners:string[],kind:string}[], scanned:number, compose:number, fights:number}}
 */
export function evaluateFrameConflicts(frameWrites, opts = {}) {
  const minDelta = Number.isFinite(opts.minDelta) ? opts.minDelta : CONFLICT_MIN_DELTA;
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 40;
  const conflicts = [];
  let compose = 0;
  let fights = 0;
  if (!frameWrites || typeof frameWrites.forEach !== 'function') return { conflicts, scanned: 0, compose, fights };
  let scanned = 0;
  frameWrites.forEach((entry, param) => {
    if (!entry) return;
    const vals = Array.isArray(entry.vals) ? entry.vals : (Array.isArray(entry) ? entry : null);
    if (!vals || vals.length < 2) return;
    scanned += 1;
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of vals) {
      if (!Number.isFinite(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (!Number.isFinite(mn) || !Number.isFinite(mx)) return;
    const delta = mx - mn;
    if (delta <= minDelta) return;
    // owner 去重但保序：「emotion-blend → expression-preset」比字母序可读
    const owners = [];
    if (Array.isArray(entry.owners)) {
      for (const o of entry.owners) {
        const name = String(o || 'unknown');
        if (!owners.includes(name)) owners.push(name);
      }
    }
    if (owners.length < 2) owners.push('unknown');
    const kind = classifyConflict(owners);
    if (kind === 'compose') compose += 1; else fights += 1;
    if (conflicts.length < maxItems) {
      conflicts.push({ param: String(param), writes: vals.length, delta: Math.round(delta * 1000) / 1000, owners, kind });
    }
  });
  return { conflicts, scanned, compose, fights };
}

/**
 * 告警去重账本：同一个 (参数, owner 组合) 只喊一次。
 *
 * 为什么不是「每个冲突都喊」：60fps 下同一次抢写每秒会命中 60 次，
 * 刷屏之后日志就没人看了。为什么不是「只喊一次总共」：不同组合是不同问题，
 * 合并成一条会掩盖新出现的抢写。
 *
 * 结构化上报（driver 的健康快照）仍按原节流节奏发 —— 它判红看的是
 * 「最近 30 秒有没有」，需要持续心跳，不能只发一次。见 cubism-renderer。
 *
 * @param {{maxWarn?:number, onNew?:(entry:object)=>void}} [opts]
 */
export function createConflictLedger(opts = {}) {
  const maxWarn = Number.isFinite(opts.maxWarn) ? opts.maxWarn : 50;
  const onNew = typeof opts.onNew === 'function' ? opts.onNew : null;
  const seen = new Set();
  const entries = [];
  const st = { unique: 0, warnings: 0, dropped: 0 };

  return {
    /** @returns {{isNew:boolean, key:string, entry:object|null}} */
    note(conflict) {
      if (!conflict || !conflict.param) return { isNew: false, key: '', entry: null };
      const owners = Array.isArray(conflict.owners) ? conflict.owners.slice().sort() : ['unknown'];
      const key = conflict.param + '|' + owners.join('+');
      if (seen.has(key)) return { isNew: false, key, entry: null };
      seen.add(key);
      st.unique += 1;
      const entry = { key, param: conflict.param, owners, delta: conflict.delta, writes: conflict.writes, kind: conflict.kind || 'fight' };
      entries.push(entry);
      if (entries.length > 200) entries.shift();
      if (st.warnings < maxWarn) {
        st.warnings += 1;
        if (onNew) { try { onNew(entry); } catch (e) { /* 告警失败不影响渲染 */ } }
      } else {
        st.dropped += 1;   // 超上限不是「没事」，是「没喊出来」—— 留在统计里
      }
      return { isNew: true, key, entry };
    },
    stats() {
      return { unique: st.unique, warnings: st.warnings, dropped: st.dropped, recent: entries.slice(-20) };
    },
    clear() {
      seen.clear();
      entries.length = 0;
      st.unique = 0; st.warnings = 0; st.dropped = 0;
    },
  };
}

/**
 * 本层输出的参数里，有没有写别人的参数。
 *
 * 注意表的键必须是**运行期词汇**（参数 id）。EXTERNALLY_OWNED 用的是 FACS 通道名，
 * 直接拿它查参数 id 永远查不到 —— 用 perf/profile.mjs 的 EXTERNALLY_OWNED_PARAMS。
 *
 * @param {Iterable<string>|object} paramIds  本帧写入的参数 id（数组/Set/对象键）
 * @param {Map<string,string>|Record<string,string>} ownedParams  参数 id → 所属层
 * @returns {{param:string, owner:string}[]}  越权写（空数组 = 干净）
 */
export function findExternalOwnershipViolations(paramIds, ownedParams) {
  const violations = [];
  if (!paramIds || !ownedParams) return violations;
  const get = ownedParams instanceof Map
    ? (id) => ownedParams.get(id)
    : (id) => (Object.prototype.hasOwnProperty.call(ownedParams, id) ? ownedParams[id] : undefined);
  const ids = paramIds instanceof Set ? Array.from(paramIds)
    : Array.isArray(paramIds) ? paramIds
    : Object.keys(paramIds);
  for (const id of ids) {
    const owner = get(String(id));
    if (owner) violations.push({ param: String(id), owner });
  }
  return violations;
}
