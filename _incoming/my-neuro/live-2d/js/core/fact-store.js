/**
 * fact-store.js — 状态事实表 + 多源仲裁（2026-11-14 五十三轮 · 多通道框架的地基）
 *
 * 为什么要有这个：状态从来不是「一份」，而是「同一条事实有好几个来源，各自有年龄和可信度」。
 *   例：`player.hp` 可能同时有
 *        { value: 0.62, source: 'mod',    at: t,        conf: 0.99 }
 *        { value: 0.60, source: 'vision', at: t - 180,  conf: 0.70 }
 *   「混合路由」的说法容易误导 —— 真正该做的是**每一帧对每条事实做一次仲裁**：
 *   按「置信度 × 新鲜度 × 来源优先级」挑一个，两源偏差过大就标 conflict 让上层降级。
 *
 * 四条设计原则（第一性原理推出来的）：
 *   ① 视觉不是「没 API 时的兜底」，它是**唯一能验证动作生效**的通道 → 与 Mod 并行存在，不互斥
 *   ② 任何单一通道都会挂 → 降级必须是常态路径，不是异常路径（stale 标记 + 上层更保守）
 *   ③ 状态有年龄（游戏在跑）→ 每条事实声明 ttlMs，过期就是过期，不假装新鲜
 *   ④ 老 profile 必须零改动 → 没配 facts 时行为与现在完全一致（本模块只做加法）
 */
'use strict';

/** 默认政策：来源优先级（数值越大越优先）、允许列表（空 = 全允许）、偏差阈值 */
const DEFAULT_POLICY = {
  // 越靠前越可信：mod（进程内）> api > vision（像素）> replay（离线日志）
  sourceRank: { mod: 100, api: 80, memory: 60, vision: 50, replay: 20 },
  // 空数组 = 全部允许；填了就只允许列表内的来源（风险档：memory 默认不允许）
  allowSources: null,
  // 冲突阈值：数值事实看相对偏差，其它类型看是否相等
  conflictTol: 0.12,
  // 超过 ttl 多少倍就当「这个来源死了」，从候选里剔除（留一点余量给抖动）
  dropAfterTtlRatio: 4,
};

/** 数值 or 其它：冲突判定 */
function isConflict(a, b, tol) {
  const na = typeof a === 'number';
  const nb = typeof b === 'number';
  if (na && nb) {
    const scale = Math.max(Math.abs(a), Math.abs(b), 1e-6);
    return Math.abs(a - b) / scale > tol;
  }
  return String(a) !== String(b);
}

/**
 * 建一个事实表。
 * @param {object} [opts]
 * @param {object} [opts.policy] 见 DEFAULT_POLICY
 * @param {function} [opts.now]  注入时钟（单测用）
 */
function createFactStore(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const policy = Object.assign({}, DEFAULT_POLICY, o.policy || {});
  if (o.policy && o.policy.sourceRank) policy.sourceRank = Object.assign({}, DEFAULT_POLICY.sourceRank, o.policy.sourceRank);
  if (o.policy && Array.isArray(o.policy.allowSources)) policy.allowSources = o.policy.allowSources.slice();

  /** fact → Map(source → {value, at, conf, ttlMs, risk}) */
  const store = new Map();
  /** fact → 额外政策（ttl、tol 覆盖） */
  const factCfg = new Map();

  const allowed = (src) => !Array.isArray(policy.allowSources) || policy.allowSources.includes(src);
  /**
   * 来源↔事实绑定（2026-11-14 审计）：`allowSources` 是全局单列表，挡不住「任意本机进程
   * （包括被投毒的 mod）写 player.hp」，更挡不住它写 `scene` 把安全闸打开。
   * 所以 profile 可以给**每条事实**限定允许的写入来源：
   *   factSources: { scene: ['vision'], 'player.hp': ['mod','api','vision'] }
   * 没配的事实不限制（向后兼容）。
   */
  const factAllowed = (fact, src) => {
    const cfg = factCfg.get(fact) || policy.factSources && policy.factSources[fact];
    if (!cfg || !Array.isArray(cfg.sources)) return true;
    return cfg.sources.includes(src);
  };
  const rank = (src) => {
    // 显式 policy.sourceRank 优先，其次默认表，最后 40（未知来源也能用，但排后面）
    const r = (policy.sourceRank && policy.sourceRank[src]);
    return typeof r === 'number' ? r : 40;
  };

  function configure(facts) {
    for (const [name, cfg] of Object.entries(facts || {})) {
      factCfg.set(name, Object.assign({}, factCfg.get(name) || {}, cfg || {}));
    }
  }

  function set(fact, value, meta) {
    const m = meta || {};
    const src = String(m.source || 'unknown');
    if (!allowed(src)) return false;            // 风险档里被禁的来源直接丢弃（不静默：返回 false）
    if (value === undefined) return false;
    // 数值事实必须是有限数（NaN/Infinity 会绕过所有比较，`typeof NaN === 'number'` 是个陷阱）
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    if (!factAllowed(fact, src)) return false;
    let bySource = store.get(fact);
    if (!bySource) { bySource = new Map(); store.set(fact, bySource); }
    const cfg = factCfg.get(fact) || {};
    // ⚠ 2026-11-14 审计（代理 B）：ttl 的裁决权必须在**消费方**（profile），不在生产者。
    //   原来的写法 `m.ttlMs 优先` → 一个源写 5000 就永不 stale，等于自己给自己发免死金牌。
    //   现在：fact 配了 ttl 就用 profile 的；没配才退回生产者给的值（再没有就 1000ms）。
    const ttl = Number.isFinite(cfg.ttlMs) ? cfg.ttlMs
      : (Number.isFinite(m.ttlMs) ? m.ttlMs : 1000);
    bySource.set(src, {
      value,
      at: Number.isFinite(m.at) ? Math.min(m.at, now() + 1000) : now(),   // 不许未来时间戳（age 恒 0 = 永不 stale）
      conf: Number.isFinite(m.conf) ? Math.max(0, Math.min(1, m.conf)) : 0.5,
      ttlMs: ttl,
      risk: String(m.risk || 'none'),
    });
    return true;
  }

  /**
   * 仲裁一条事实。
   * @returns {{value:*, source:string, age:number, conf:number, stale:boolean, conflict:boolean, candidates:Array}}
   */
  function get(fact) {
    const bySource = store.get(fact);
    const cfg = factCfg.get(fact) || {};
    const tol = Number.isFinite(cfg.conflictTol) ? cfg.conflictTol : policy.conflictTol;
    if (!bySource || bySource.size === 0) {
      return { value: undefined, source: null, age: Infinity, conf: 0, stale: true, conflict: false, candidates: [] };
    }
    const t = now();
    const cands = [];
    for (const [src, rec] of bySource) {
      const age = Math.max(0, t - rec.at);
      const deadline = rec.ttlMs * policy.dropAfterTtlRatio;
      if (age > deadline) continue;             // 这个来源太久没更新 = 死了
      // ⚠ 新鲜度是**惩罚因子**不是加分项：过期的来源必须输给新鲜的弱来源。
      //   实测踩到：把 freshness 当成 0.4 权重的加分项时，一个 500ms 没更新的
      //   mod 读数（conf 0.99）依然压过刚读到的 vision（conf 0.7）—— 那就等于没有降级。
      // 新鲜期线性衰减 → 过期后按 0.15^(超出倍数) 连续衰减（过期 1ms 和 3.9×ttl 不该同分）
      const ratio = age / Math.max(1, rec.ttlMs);
      const freshness = ratio <= 1
        ? Math.max(0, 1 - 0.4 * ratio)
        : 0.15 * Math.pow(0.15, Math.min(8, ratio - 1));
      cands.push(Object.assign({ source: src, age, freshness }, rec, {
        // 打分 = 置信度 × 新鲜度（主项，0..1） + 来源优先级（少量加分，只用来压同分）
        // 之前是**乘性** rank/100：rank 差 2 倍直接压过 conf 差 1.4 倍，conf 形同虚设。
        score: rec.conf * freshness + (rank(src) / 100) * 0.1,
      }));
    }
    if (!cands.length) {
      return { value: undefined, source: null, age: Infinity, conf: 0, stale: true, conflict: false, candidates: [] };
    }
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    // 冲突：与分数最高的**另一个来源**比；只和**新鲜**的源比（过期源本来就不该参与裁决）
    let conflict = false;
    for (let i = 1; i < cands.length; i += 1) {
      if (cands[i].source === best.source) continue;
      if (cands[i].age <= cands[i].ttlMs && isConflict(best.value, cands[i].value, tol)) conflict = true;
      break;
    }
    return {
      value: best.value,
      source: best.source,
      age: best.age,
      conf: best.conf,
      stale: best.age > best.ttlMs,
      conflict,
      candidates: cands.map((c) => ({ source: c.source, value: c.value, age: c.age, conf: c.conf, score: Math.round(c.score * 1000) / 1000, stale: c.age > c.ttlMs })),
    };
  }

  /** 扁平快照（给老代码/日志看：每条事实取仲裁后的值） */
  function snapshot() {
    const out = {};
    for (const fact of store.keys()) {
      const r = get(fact);
      out[fact] = r.value;
    }
    return out;
  }

  /** 全量诊断（每帧记日志用） */
  function dump() {
    const out = {};
    for (const fact of store.keys()) out[fact] = get(fact);
    return out;
  }

  function reset() { store.clear(); }

  return { set, get, snapshot, dump, configure, reset, policy, _store: store };
}

module.exports = { createFactStore, DEFAULT_POLICY, isConflict };
