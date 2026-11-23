/**
 * memory-evidence.js —— 记忆「证据分」双时钟（2026-11-22）
 *
 * 为什么要有这一层：晋升（promote）和衰减（decay）原来各算各的，互相打架 ——
 * 一条被反复确认的旧事实可能因为「老」被压下去，而一条刚写入的谣传因为「新」
 * 被抬上来。这里把两件事合成一个**可解释**的分数：
 *
 *   score = R · 0.5^(ageR / 30) − D · 0.5^(ageD / 180)
 *
 *   · R（支持证据）半衰期 30 天 —— 支持要持续维护，久不确认就回落；
 *   · D（否认证据）半衰期 180 天 —— 否认更「记仇」，但也不是永远；
 *   · 人格卡 protected 的事实不吃衰减，直接 Infinity。
 *
 * 纯模块：不读文件、不读全局时钟、不依赖任何其它模块。
 * 所有时间戳从参数传入；分数函数内部只做单位归一，不取 now。
 *
 * 时间单位（重要）：
 *   · 时间戳既可以是 epoch 毫秒（Date.now()，与 user-facts 的 valid_from 一致），
 *     也可以是「天」为单位的相对时间（单测里 now=130 / rAt=100 这种）。
 *   · 归一规则：> 1e11 视为毫秒并除以一天；否则按天。1e11 天≈2.7 亿年、
 *     1e11 毫秒≈1973 年，两侧都不会误伤。
 *   · rAt / dAt 为 0 一律当「刚写入」（age=0），不当 1970 年的无限老数据。
 *
 * 事件语义（applyEvent，永不原地改）：
 *   confirm  → r += 1,   rAt = at
 *   deny     → d += 1,   dAt = at
 *   ignore   → r = max(0, r − 0.2), rAt = at
 *   newFact  → r += 0.5, rAt = at
 *   其它 type → 内容原样返回（仍是新对象，调用方可以安全持有）
 *
 * 分档：
 *   ≥2 promote / ≥1 confirmed / ≤−2 archive_candidate / 其它 neutral
 */
'use strict';

/** 一天的毫秒数（也导出给调用方做单位换算/断言） */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 双时钟可调参数。改这里就是改全局策略，不要在业务层散落魔数。 */
const DEFAULTS = Object.freeze({
    HALF_LIFE_R: 30,        // 支持证据半衰期（天）
    HALF_LIFE_D: 180,       // 否认证据半衰期（天）
    PROMOTE: 2,             // ≥ 此分 → promote
    CONFIRMED: 1,           // ≥ 此分 → confirmed
    ARCHIVE: -2,            // ≤ 此分 → archive_candidate
    CONFIRM_GAIN: 1,        // confirm 一次加多少支持
    NEW_FACT_GAIN: 0.5,     // 新事实写入时的初始支持
    IGNORE_PENALTY: 0.2,    // ignore 一次扣多少支持（扣到 0 为止）
    INITIAL_R: 0.5,         // 新事实的初始 r
});

/** 任何大于此值的数字按 epoch 毫秒解释，否则按「天」解释。 */
const MS_THRESHOLD = 1e11;

/** 有限数字，否则给 fallback（默认 0）。 */
function finite(x, fallback) {
    const n = Number(x);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/** 时间戳 → 天（支持毫秒/天两种单位，0 保持 0）。 */
function toDays(t) {
    const n = finite(t);
    return n > MS_THRESHOLD ? n / DAY_MS : n;
}

/**
 * 从 now 与 at 算「已经过了多少天」。
 * 0 当刚写入；非法/未来时间一律 0（不产生「负年龄放大分数」）。
 */
function ageDaysOf(now, at) {
    const a = toDays(at);
    if (!a) return 0;               // 0 = 刚写入（旧数据缺字段也走这里）
    const n = toDays(now);
    if (!n) return 0;               // now 缺失/非法 → 当刚写入，而不是无限老
    const diff = n - a;
    return diff > 0 ? diff : 0;
}

/**
 * 指数半衰：value · 0.5^(ageDays / hl)。
 * 非法 value → 0；负 age 当 0；非法/非正的 hl → 0（没有半衰期就没有可信分数）。
 */
function halfLife(value, ageDays, hl) {
    const v = finite(value);
    if (!v) return 0;
    const h = finite(hl);
    if (h <= 0) return 0;
    const age = finite(ageDays);
    const a = age > 0 ? age : 0;
    return v * Math.pow(0.5, a / h);
}

/**
 * 证据分。protected === true 的事实不吃衰减（人格卡），返回 Infinity。
 * @param {{r?:number,rAt?:number,d?:number,dAt?:number,protected?:boolean}|null} evidence
 * @param {number} now 当前时间（ms 或天，与 rAt/dAt 同单位）
 * @returns {number}
 */
function score(evidence, now) {
    const e = evidence || {};
    if (e.protected === true) return Infinity;
    return halfLife(e.r, ageDaysOf(now, e.rAt), DEFAULTS.HALF_LIFE_R)
        - halfLife(e.d, ageDaysOf(now, e.dAt), DEFAULTS.HALF_LIFE_D);
}

/**
 * 应用一个证据事件，返回**新对象**（原对象不被修改）。
 * 未知 type 返回内容相同的新对象。
 * @param {object|null} evidence
 * @param {{type:string, at:number}} event
 * @returns {object}
 */
function applyEvent(evidence, event) {
    const base = evidence && typeof evidence === 'object' ? { ...evidence } : {};
    const type = event && event.type;
    const at = finite(event && event.at);   // 非法 at → 0（= 刚写入），不写 NaN
    const r = finite(base.r);
    const d = finite(base.d);
    switch (type) {
    case 'confirm':
        return { ...base, r: r + DEFAULTS.CONFIRM_GAIN, rAt: at };
    case 'deny':
        return { ...base, d: d + DEFAULTS.CONFIRM_GAIN, dAt: at };
    case 'ignore':
        return { ...base, r: Math.max(0, r - DEFAULTS.IGNORE_PENALTY), rAt: at };
    case 'newFact':
        return { ...base, r: r + DEFAULTS.NEW_FACT_GAIN, rAt: at };
    default:
        return base;
    }
}

/**
 * 分数 → 档位。Infinity → promote；NaN → neutral。
 * @param {number} value
 * @returns {'promote'|'confirmed'|'archive_candidate'|'neutral'}
 */
function tier(value) {
    const s = Number(value);
    if (s >= DEFAULTS.PROMOTE) return 'promote';
    if (s >= DEFAULTS.CONFIRMED) return 'confirmed';
    if (s <= DEFAULTS.ARCHIVE) return 'archive_candidate';
    return 'neutral';
}

/** 新事实的初始证据对象（写入 user-facts 时用同一份定义，避免两处魔数漂移）。 */
function initialEvidence(at) {
    return {
        r: DEFAULTS.INITIAL_R,
        rAt: finite(at),
        d: 0,
        dAt: 0,
        protected: false,
    };
}

module.exports = {
    halfLife, score, applyEvent, tier, initialEvidence,
    DEFAULTS, DAY_MS, ageDaysOf,
};
