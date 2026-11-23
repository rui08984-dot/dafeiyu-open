/**
 * daily-report.js —— 每日成绩单（D1，2026-11-22）
 *
 * 要解决的问题：一天下来她做了不少事（主动开口/电脑操控/表演/记忆整理），
 * 但用户看不到「今天到底怎么样」，也没有任何基于事实的自我调整。
 *
 * 设计纪律（研讨会 D1 的验收 + 本项目既有风格）：
 *   · **纯本地统计，不调 LLM**：成绩单是数字汇总，不需要模型；无数据时
 *     `{ok:true, text:'', adjustments:[], empty:true}`，不加载任何 LLM 模块、
 *     不写提示词、不产生 token。
 *   · **每个数字可下钻**：`sources` 里每个值都带 `{file, field, value}`，
 *     指向真实文件与字段；`build()` 只读，绝不改动源文件。
 *   · **一条可撤销调整**：只根据「主动开口的接受/忽略」给一条建议，
 *     带 `key/from/to/why/evidence`；`applyAdjustment()` 写回配置并热重载
 *     speech-budget，`revertAdjustment(receipt)` 用回执里的原值还原。
 *   · **失败要发声**：坏文件 / 读不出来进 `warnings`，对应 source 带 `error`，
 *     不静默当 0 糊弄过去（0 与「读失败」在文本里都是 0，但警告里能看见）。
 *
 * 数据源（字段均已对照盘上真实数据确认）：
 *   主动日志.json           speech-budget 的日预算/开口结果（attempts[].at/outcome）
 *   主动预算.json           daily_limit（调整写这里）
 *   dispatch-history.jsonl  pet-runtime/data，操控动作（ts/ok/verified/effect）
 *   performance-log.jsonl   pet-runtime/data，表演决策（ts/kind=play|skip|user_input_after）
 *   episodes.jsonl          记忆片段卡（at/facts）—— 本仓没有独立的「记忆质量」文件，
 *                           用「今日卡片数 + 事实数 + 待写队列 + 整理天数」作为可下钻代理
 *   记忆待写队列.jsonl      MemOS 离线时积压的待写条数（>0 = 记忆有欠账）
 *   记忆整理/*.md           每日巩固落盘的天数
 *
 * 开关（一键关，改完即生效，不用重启）：
 *   data/成绩单设置.json  {"enabled": false}
 *   （可选 {"max_chars": 100}；上限夹在 40..120，代码不会输出超过 120 字）
 *
 * 调整的配置面：只写 主动预算.json 的 `daily_limit`；speech-budget 通过
 * `reloadSingleton()` 热重载（没有单例时返回 null，不会凭空创建）。
 * 额度常量唯一真源是 speech-budget.DEFAULT_DAILY_LIMIT（2026-11-22 用户拍板 20）；
 * 这里**不保留第二份 8/12**，否则展示与建议会与运行值漂移。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile, RECORDS_DIR } = require('./records-path.js');
// 日预算的唯一真源在 speech-budget。这里**不允许**再写一份 8/12 常量：
// 2026-11-22 用户拍板总量 20，成绩单却按旧的 8 展示、按 12 封顶，会把 20 建议砍到 10。
const { DEFAULT_DAILY_LIMIT } = require('./speech-budget.js');

const CONFIG_FILE = '成绩单设置.json';
const SPEECH_LOG = '主动日志.json';
const SPEECH_CFG = '主动预算.json';
const EPISODE_FILE = 'episodes.jsonl';
const PENDING_FILE = '记忆待写队列.jsonl';
const DIGEST_DIR = '记忆整理';
const RUNTIME_DATA = 'data';

const DEFAULT_MAX_CHARS = 120;
const MIN_TEXT_CHARS = 40;
const MAX_TEXT_CHARS = 120;
const MIN_JUDGED_FOR_ADJUST = 4;
// 0.6 的「没人接」阈值：低于它不动（避免凭两三条数据改行为，和 speech-budget 的自适应同口径）
const BAD_RATE_FOR_DOWN = 0.6;
const GOOD_RATE_FOR_UP = 0.7;
// 调整幅度的相对护栏：只允许在「当前额度的 0.5–1.5 倍」内动，且绝对值夹在 [1, 50]。
// 这样 20 的建议最低 10/最高 30，绝不会被旧上限 12 打到 10；当前值很小时也不会降到 0。
const LIMIT_FACTOR_LO = 0.5;
const LIMIT_FACTOR_HI = 1.5;
const LIMIT_ABS_LO = 1;
const LIMIT_ABS_HI = 50;

// ── 小工具 ────────────────────────────────────────────────────────────

function dayKey(now) {
    // 无参/非数字 → 用当前时间：`new Date(undefined)` 是 Invalid Date，
    // getFullYear() 会返回 NaN，最终产出 'NaN-NaN-NaN' 这种文件名（实测踩到）。
    const t = Number(now);
    const d = new Date(Number.isFinite(t) && t > 0 ? t : Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function startOfDay(now) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

/** 一行数据的时间戳：支持数字 ts/at 与 ISO 字符串；解析不出来返回 NaN（不猜） */
function timeOf(row) {
    if (!row || typeof row !== 'object') return NaN;
    const raw = row.ts != null ? row.ts : row.at;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim()) {
        const n = Date.parse(raw);
        return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
}

/** 读 JSON：只读，不隔离、不改名（成绩单没有资格动运行数据）。 */
function readJson(file) {
    if (!file) return { exists: false, ok: true, value: null };
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { exists: false, ok: true, value: null };
        return { exists: false, ok: false, value: null, error: '读不出来：' + (e && e.message || e) };
    }
    if (!text.trim()) return { exists: true, ok: true, value: null };
    try {
        return { exists: true, ok: true, value: JSON.parse(text) };
    } catch (e) {
        return { exists: true, ok: false, value: null, error: 'JSON 解析失败：' + (e && e.message || e) };
    }
}

/** 读 JSONL：坏行只跳过该行（与 json-store 的容损单位一致），返回坏行计数。 */
function readJsonl(file, cap) {
    if (!file) return { exists: false, ok: true, rows: [], bad: 0, total: 0, truncated: false };
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { exists: false, ok: true, rows: [], bad: 0, total: 0, truncated: false };
        return { exists: false, ok: false, rows: [], bad: 0, total: 0, truncated: false, error: '读不出来：' + (e && e.message || e) };
    }
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const limit = Math.max(1, Number(cap) || lines.length);
    const slice = lines.length > limit ? lines.slice(-limit) : lines;
    const rows = [];
    let bad = 0;
    for (const line of slice) {
        try {
            const o = JSON.parse(line);
            if (o && typeof o === 'object' && !Array.isArray(o)) rows.push(o);
            else bad += 1;
        } catch (e) { bad += 1; }
    }
    return { exists: true, ok: true, rows, bad, total: lines.length, truncated: lines.length > slice.length };
}

function countLines(file) {
    if (!file) return { exists: false, ok: true, count: 0 };
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code === 'ENOENT') return { exists: false, ok: true, count: 0 };
        return { exists: false, ok: false, count: 0, error: '读不出来：' + (e && e.message || e) };
    }
    return { exists: true, ok: true, count: text.split(/\r?\n/).filter((l) => l.trim()).length };
}

/** 从 __dirname 往上找 pet-runtime（与 dispatch/skill-library 的 findRoot 同一思路）。 */
function findPetRuntime(start) {
    let dir = start || __dirname;
    for (let i = 0; i < 12; i += 1) {
        const cand = path.join(dir, 'pet-runtime');
        try { if (fs.statSync(cand).isDirectory()) return cand; } catch (e) { /* 继续往上 */ }
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

/** pet-runtime 根：测试可用 PET_RUNTIME_ROOT / opts.runtimeRoot 指到临时目录。 */
function runtimeRoot(opts) {
    if (opts && opts.runtimeRoot) return path.resolve(opts.runtimeRoot);
    if (process.env.PET_RUNTIME_ROOT) return path.resolve(process.env.PET_RUNTIME_ROOT);
    return findPetRuntime(__dirname);
}

function runtimeFile(opts, name, override) {
    if (override) return path.resolve(override);
    const root = runtimeRoot(opts);
    return root ? path.join(root, RUNTIME_DATA, name) : '';
}

function existsOf(file) {
    if (!file) return false;
    try { return fs.existsSync(file); } catch (e) { return false; }
}

/** 每个数字的来源：文件 + 字段 + 值 + 是否存在 + 可选错误。 */
function mkSource(file, field, value, extra) {
    return Object.assign({ file: file || '', field, value, exists: existsOf(file) }, extra || {});
}

// ── 四个数据源 ────────────────────────────────────────────────────────

/**
 * 当前日预算额度（唯一真源链）：运行中的 speech-budget 单例 → 盘上配置 → 模块默认值。
 * 为什么先看单例：daily_limit 支持热重载，盘上文件可能还没被 reload，运行值才是「现在生效」。
 * 没有单例时**不凭空创建**（构造会带定时器），只读配置/默认。
 */
function currentDailyLimit(cfgObj) {
    try {
        const sb = require('./speech-budget.js');
        const inst = typeof sb.peekSingleton === 'function' ? sb.peekSingleton() : null;
        if (inst) {
            const st = inst.stats();
            const n = Number(st && st.limit);
            if (Number.isFinite(n) && n > 0) return n;
        }
    } catch (e) { /* 单例不可读 → 回落配置文件 */ }
    const raw = Number(cfgObj && cfgObj.daily_limit);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return DEFAULT_DAILY_LIMIT;
}

function summarizeSpeech(now) {
    const file = recordFile(SPEECH_LOG);
    const cfgFile = recordFile(SPEECH_CFG);
    const log = readJson(file);
    const cfg = readJson(cfgFile);
    const start = startOfDay(now);
    const warnings = [];

    if (!log.ok) warnings.push('[speech] ' + log.error);
    if (!cfg.ok) warnings.push('[speech] ' + cfg.error);

    const attempts = (log.value && Array.isArray(log.value.attempts)) ? log.value.attempts : [];
    const today = attempts.filter((a) => {
        const t = timeOf(a);
        return Number.isFinite(t) && t >= start && t <= now;
    });
    const judged = today.filter((a) => a && a.outcome);
    const accepted = judged.filter((a) => a.outcome === 'accepted').length;
    const ignored = judged.filter((a) => a.outcome === 'ignored').length;
    const negative = judged.filter((a) => a.outcome === 'negative').length;

    const cfgObj = (cfg.value && typeof cfg.value === 'object') ? cfg.value : {};
    // P1-8：不再读第二份 DEFAULT_DAILY_LIMIT=8。运行中的预算值优先。
    const limit = currentDailyLimit(cfgObj);
    const dayMatch = !!(log.value && log.value.day === dayKey(now));
    const used = dayMatch ? (Number(log.value.used) || 0) : 0;

    return {
        file, cfgFile, exists: log.exists, cfgExists: cfg.exists, warnings,
        error: !log.ok ? (log.error || '读取失败') : (!cfg.ok ? (cfg.error || '配置读取失败') : ''),
        attempts: today.length,
        judged: judged.length,
        accepted, ignored, negative,
        used, limit,
        enabled: cfgObj.enabled !== false,
        day: log.value ? String(log.value.day || '') : dayKey(now),
    };
}

function summarizeDispatch(now, opts) {
    const file = runtimeFile(opts, 'dispatch-history.jsonl', opts && opts.dispatchHistoryFile);
    const start = startOfDay(now);
    const hist = readJsonl(file, 5000);
    const warnings = [];
    if (!hist.ok) warnings.push('[dispatch] ' + hist.error);
    if (hist.bad > 0) warnings.push('[dispatch] 跳过 ' + hist.bad + ' 行坏数据');
    if (hist.truncated) warnings.push('[dispatch] 文件超过 5000 行，只看最近 5000 行');

    const rows = hist.rows.filter((r) => {
        const t = timeOf(r);
        return Number.isFinite(t) && t >= start && t <= now;
    });
    const ok = rows.filter((r) => r.ok === true).length;
    const verified = rows.filter((r) => r.verified === true).length;
    const readonly = rows.filter((r) => r.effect === 'readonly').length;
    const effects = {};
    for (const r of rows) {
        const k = String(r.effect || '(空)');
        effects[k] = (effects[k] || 0) + 1;
    }
    return {
        file, exists: hist.exists, warnings,
        error: hist.ok ? '' : (hist.error || '读取失败'),
        steps: rows.length,
        ok, verified, readonly,
        failed: rows.length - ok,
        effects,
    };
}

function summarizePerformance(now, opts) {
    const file = runtimeFile(opts, 'performance-log.jsonl', opts && opts.performanceLogFile);
    const start = startOfDay(now);
    const log = readJsonl(file, 10000);
    const warnings = [];
    if (!log.ok) warnings.push('[perf] ' + log.error);
    if (log.bad > 0) warnings.push('[perf] 跳过 ' + log.bad + ' 行坏数据');
    if (log.truncated) warnings.push('[perf] 文件超过 10000 行，只看最近 10000 行');

    const rows = log.rows.filter((r) => {
        const t = timeOf(r);
        return Number.isFinite(t) && t >= start && t <= now;
    });
    const plays = rows.filter((r) => r.kind === 'play').length;
    const skips = rows.filter((r) => r.kind === 'skip').length;
    const userAfter = rows.filter((r) => r.kind === 'user_input_after').length;
    return {
        file, exists: log.exists, warnings,
        error: log.ok ? '' : (log.error || '读取失败'),
        plays, skips, userAfter,
        followRate: plays > 0 ? +(userAfter / plays).toFixed(2) : null,
    };
}

function summarizeMemory(now) {
    const epFile = recordFile(EPISODE_FILE);
    const pendingFile = recordFile(PENDING_FILE);
    const digestDir = path.join(RECORDS_DIR, DIGEST_DIR);
    const start = startOfDay(now);
    const warnings = [];

    const ep = readJsonl(epFile, 100000);
    if (!ep.ok) warnings.push('[memory] ' + ep.error);
    if (ep.bad > 0) warnings.push('[memory] episodes.jsonl 跳过 ' + ep.bad + ' 行坏数据');
    if (ep.truncated) warnings.push('[memory] episodes.jsonl 超过 100000 行，只看最近 100000 行');

    const cards = ep.rows;
    const todayCards = cards.filter((c) => {
        const t = timeOf(c);
        return Number.isFinite(t) && t >= start && t <= now;
    });
    const factsOf = (c) => (Array.isArray(c.facts) ? c.facts.filter(Boolean).length : 0);
    const factsToday = todayCards.reduce((n, c) => n + factsOf(c), 0);
    const factsTotal = cards.reduce((n, c) => n + factsOf(c), 0);

    let digestDays = 0;
    let digestError = '';
    try {
        digestDays = fs.readdirSync(digestDir).filter((f) => f.endsWith('.md')).length;
    } catch (e) {
        if (!(e && e.code === 'ENOENT')) digestError = '读不出来：' + (e && e.message || e);
    }
    if (digestError) warnings.push('[memory] 记忆整理目录 ' + digestError);

    const pending = countLines(pendingFile);
    if (!pending.ok) warnings.push('[memory] ' + pending.error);

    return {
        episodeFile: epFile,
        pendingFile,
        digestDir,
        exists: ep.exists,
        warnings,
        error: ep.ok ? '' : (ep.error || '读取失败'),
        episodesToday: todayCards.length,
        episodesTotal: cards.length,
        factsToday,
        factsTotal,
        digestDays,
        pending: pending.count,
    };
}

// ── 文本与调整 ────────────────────────────────────────────────────────

/**
 * 按字符（而不是 UTF-16 码元）截断，尽量切在标点处。
 * 上限由配置夹在 40..120；需求是 ≤120，所以配置也抬不上去。
 */
function clampChars(text, max) {
    const chars = Array.from(String(text || ''));
    const cap = Math.max(MIN_TEXT_CHARS, Math.min(MAX_TEXT_CHARS, Number(max) || DEFAULT_MAX_CHARS));
    if (chars.length <= cap) return chars.join('');
    let cut = chars.slice(0, cap - 1).join('');
    const idx = Math.max(
        cut.lastIndexOf('，'),
        cut.lastIndexOf('；'),
        cut.lastIndexOf('。'),
        cut.lastIndexOf(' ')
    );
    if (idx >= Math.floor(cap * 0.5)) cut = cut.slice(0, idx);
    if (cut.endsWith('。')) return cut;
    return cut + '…';
}

/**
 * 一条可撤销调整：只在样本足够时给。
 *   · 多数没人接（ignored+negative ≥60%）→ 日额度降 2
 *   · 多数被接（accepted ≥70%）且今天已经顶到额度 → 日额度升 2
 * 上下限：当前 limit 的 0.5–1.5 倍，且绝对值夹在 [1, 50]。
 * 例：limit=20 时允许 10..30 → 建议 18，绝不会被旧上限 12 砍成 10。
 * 只调 speech-budget 的 daily_limit，不碰 enabled/其他键。
 */
function adjustmentBounds(limit) {
    const lo = Math.max(LIMIT_ABS_LO, Math.ceil(limit * LIMIT_FACTOR_LO));
    const hi = Math.min(LIMIT_ABS_HI, Math.floor(limit * LIMIT_FACTOR_HI));
    return { lo, hi: Math.max(lo, hi) };
}

function buildAdjustment(speech) {
    if (!speech || speech.enabled === false) return [];
    if (speech.judged < MIN_JUDGED_FOR_ADJUST) return [];
    const limit = Number(speech.limit) || DEFAULT_DAILY_LIMIT;
    const bounds = adjustmentBounds(limit);
    const accepted = Number(speech.accepted) || 0;
    const ignored = Number(speech.ignored) || 0;
    const negative = Number(speech.negative) || 0;
    const bad = ignored + negative;

    if (bad / speech.judged >= BAD_RATE_FOR_DOWN && limit > bounds.lo) {
        const to = Math.max(bounds.lo, limit - 2);
        return [{
            key: 'speech.daily_limit',
            file: speech.cfgFile,
            field: 'daily_limit',
            from: limit,
            to,
            why: '最近主动开口多数没人接，先降一档',
            reversible: true,
            evidence: { judged: speech.judged, accepted, ignored, negative },
        }];
    }
    if (accepted / speech.judged >= GOOD_RATE_FOR_UP && speech.used >= limit - 1 && limit < bounds.hi) {
        const to = Math.min(bounds.hi, limit + 2);
        return [{
            key: 'speech.daily_limit',
            file: speech.cfgFile,
            field: 'daily_limit',
            from: limit,
            to,
            why: '主动开口被接得多、额度用满了，放宽一档',
            reversible: true,
            evidence: { judged: speech.judged, accepted, ignored, negative, used: speech.used },
        }];
    }
    return [];
}

function readReportConfig(override) {
    if (override && typeof override === 'object') return { ok: true, value: override, file: '' };
    const file = recordFile(CONFIG_FILE);
    const r = readJson(file);
    return { ok: r.ok, value: (r.value && typeof r.value === 'object') ? r.value : {}, file, error: r.error };
}

// ── 对外 API ──────────────────────────────────────────────────────────

/**
 * 生成成绩单（纯读，不写文件、不调模型）。
 * @param {{now?:number, config?:object, performanceLogFile?:string, dispatchHistoryFile?:string, runtimeRoot?:string}} [opts]
 * @returns {{ok:boolean, empty:boolean, disabled?:boolean, text:string, adjustments:Array,
 *            sources:object, warnings:string[], generated_at:number, day?:string, error?:string}}
 */
function build(opts) {
    const o = opts || {};
    const now = Number.isFinite(o.now) ? Number(o.now) : Date.now();
    const cfg = readReportConfig(o.config);

    if (cfg.value && cfg.value.enabled === false) {
        return {
            ok: true, empty: true, disabled: true, text: '', adjustments: [],
            sources: {}, warnings: [], generated_at: now,
        };
    }

    try {
        const speech = summarizeSpeech(now);
        const dispatch = summarizeDispatch(now, o);
        const perf = summarizePerformance(now, o);
        const memory = summarizeMemory(now);

        const warnings = [].concat(speech.warnings, dispatch.warnings, perf.warnings, memory.warnings);
        if (!cfg.ok && cfg.error) warnings.push('[config] ' + cfg.error);

        const parts = [];
        if (speech.attempts > 0) {
            parts.push('开口 ' + speech.attempts + ' 次（接受 ' + speech.accepted
                + '，预算 ' + speech.used + '/' + speech.limit + '）');
        }
        if (dispatch.steps > 0) {
            parts.push('操控 ' + dispatch.steps + ' 步（验证 ' + dispatch.verified
                + (dispatch.failed > 0 ? '，失败 ' + dispatch.failed : '') + '）');
        }
        if (perf.plays > 0) parts.push('表演 ' + perf.plays + ' 段（被接 ' + perf.userAfter + '）');
        if (memory.episodesToday > 0) {
            const extras = [];
            if (memory.digestDays > 0) extras.push('整理 ' + memory.digestDays + ' 天');
            if (memory.pending > 0) extras.push('待写 ' + memory.pending);
            parts.push('记忆 ' + memory.episodesToday + ' 张卡' + (extras.length ? '（' + extras.join('，') + '）' : ''));
        } else if (memory.pending > 0) {
            parts.push('记忆待写 ' + memory.pending + ' 条');
        }

        const rawText = parts.length ? '今天：' + parts.join('，') + '。' : '';
        const maxChars = Number(cfg.value && cfg.value.max_chars);
        const text = clampChars(rawText, maxChars);
        const adjustments = buildAdjustment(speech);

        const sources = {
            speech_attempts: mkSource(speech.file, 'attempts[].at（本地今日） + outcome', speech.attempts),
            speech_judged: mkSource(speech.file, 'attempts[].outcome（非空）', speech.judged),
            speech_accepted: mkSource(speech.file, "attempts[].outcome === 'accepted'", speech.accepted),
            speech_ignored: mkSource(speech.file, "attempts[].outcome === 'ignored'", speech.ignored),
            speech_negative: mkSource(speech.file, "attempts[].outcome === 'negative'", speech.negative),
            speech_used: mkSource(speech.file, 'used（day 与今天一致时）', speech.used),
            speech_limit: mkSource(speech.cfgFile, 'daily_limit', speech.limit),
            dispatch_steps: mkSource(dispatch.file, 'lines[].ts（本地今日）', dispatch.steps),
            dispatch_ok: mkSource(dispatch.file, 'lines[].ok === true', dispatch.ok),
            dispatch_failed: mkSource(dispatch.file, 'lines[].ok === false', dispatch.failed),
            dispatch_verified: mkSource(dispatch.file, 'lines[].verified === true', dispatch.verified),
            dispatch_effect: mkSource(dispatch.file, "lines[].effect === 'confirmed'", dispatch.effects.confirmed || 0, { detail: dispatch.effects }),
            perf_plays: mkSource(perf.file, "lines[kind === 'play'].ts", perf.plays),
            perf_user_after: mkSource(perf.file, "lines[kind === 'user_input_after'].ts", perf.userAfter),
            perf_skips: mkSource(perf.file, "lines[kind === 'skip'].ts", perf.skips),
            memory_episodes_today: mkSource(memory.episodeFile, 'lines[].at（本地今日）', memory.episodesToday),
            memory_facts_today: mkSource(memory.episodeFile, 'lines[].facts.length（今日卡片）', memory.factsToday),
            memory_episodes_total: mkSource(memory.episodeFile, 'lines[].at（全部）', memory.episodesTotal),
            memory_facts_total: mkSource(memory.episodeFile, 'lines[].facts.length（全部）', memory.factsTotal),
            memory_pending: mkSource(memory.pendingFile, 'lines（非空行计数）', memory.pending),
            memory_digest_days: mkSource(memory.digestDir, '*.md（文件数）', memory.digestDays),
        };

        // 让「读失败」在 sources 上也可见，而不是只当 0
        if (speech.error) sources.speech_attempts.error = speech.error;
        if (dispatch.error) sources.dispatch_steps.error = dispatch.error;
        if (perf.error) sources.perf_plays.error = perf.error;
        if (memory.error) sources.memory_episodes_today.error = memory.error;

        return {
            ok: true,
            empty: parts.length === 0,
            disabled: false,
            text,
            adjustments,
            sources,
            warnings,
            generated_at: now,
            day: dayKey(now),
        };
    } catch (e) {
        return {
            ok: false, empty: true, disabled: false, text: '', adjustments: [],
            sources: {}, warnings: ['[build] ' + (e && e.stack || e)], generated_at: now,
            error: String(e && e.message || e),
        };
    }
}

// ── 调整的应用与撤销 ──────────────────────────────────────────────────

const ADJUST_TARGETS = {
    'speech.daily_limit': { file: () => recordFile(SPEECH_CFG), field: 'daily_limit' },
};

function reloadBudget() {
    try {
        const sb = require('./speech-budget.js');
        if (typeof sb.reloadSingleton !== 'function') return false;
        const r = sb.reloadSingleton();
        return r !== null && r !== undefined;
    } catch (e) {
        return false;
    }
}

/**
 * 应用一条调整（原子读改写，保留配置里其他键）。
 * 如果文件里的当前值与调整的 from 不一致（别处改过），默认拒绝覆盖；
 * 测试/明确要强制时传 {force:true}。
 */
function applyAdjustment(adj, opts) {
    const o = opts || {};
    if (!adj || !adj.key) return { ok: false, error: '没有调整可应用' };
    const target = ADJUST_TARGETS[adj.key];
    if (!target) return { ok: false, error: '不认识的调整键：' + adj.key };

    const file = target.file();
    const r = readJson(file);
    if (!r.ok) return { ok: false, error: r.error };
    // 合法 JSON 但形状不是对象（用户手改成数组/标量）→ 拒绝写，别把原文件替换成 {daily_limit}：
    // 「保留其他键」的前提是原文件里有键可保留。空文件/文件不存在仍按空对象处理。
    if (r.exists && r.value !== null && (typeof r.value !== 'object' || Array.isArray(r.value))) {
        return { ok: false, error: '配置文件不是对象（' + file + '），为免覆盖原内容拒绝写入' };
    }
    const data = (r.value && typeof r.value === 'object' && !Array.isArray(r.value)) ? r.value : {};
    const current = Number(data[target.field]);
    const from = Number.isFinite(current) ? current : Number(adj.from);
    const to = Number(adj.to);
    if (!Number.isFinite(to) || to <= 0) return { ok: false, error: '调整目标值不合法：' + adj.to };
    if (!o.force && Number.isFinite(adj.from) && Number.isFinite(current) && current !== adj.from) {
        return {
            ok: false,
            error: '配置已被改过（当前 ' + current + '，调整基于 ' + adj.from + '），拒绝覆盖',
            current,
        };
    }

    data[target.field] = to;
    try {
        const jsonStore = require('./json-store.js');
        jsonStore.writeJson(file, data);
    } catch (e) {
        return { ok: false, error: '写入失败：' + (e && e.message || e) };
    }

    const reloaded = reloadBudget();
    return {
        ok: true,
        key: adj.key,
        file,
        field: target.field,
        from,
        to,
        reloaded,
        // 回执就是撤销凭据：原值/文件/字段都在里面
        receipt: { key: adj.key, file, field: target.field, from, to, at: Date.now() },
    };
}

/** 撤销一条调整：用回执里的 from 写回；同样热重载。 */
function revertAdjustment(receipt) {
    if (!receipt || !receipt.key) return { ok: false, error: '没有回执可撤销' };
    const target = ADJUST_TARGETS[receipt.key];
    if (!target) return { ok: false, error: '不认识的调整键：' + receipt.key };
    const file = receipt.file || target.file();
    const field = receipt.field || target.field;
    const from = Number(receipt.from);
    if (!Number.isFinite(from) || from <= 0) return { ok: false, error: '回执里的原值不合法：' + receipt.from };

    const r = readJson(file);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.exists && r.value !== null && (typeof r.value !== 'object' || Array.isArray(r.value))) {
        return { ok: false, error: '配置文件不是对象（' + file + '），为免覆盖原内容拒绝写入' };
    }
    const data = (r.value && typeof r.value === 'object' && !Array.isArray(r.value)) ? r.value : {};
    data[field] = from;
    try {
        const jsonStore = require('./json-store.js');
        jsonStore.writeJson(file, data);
    } catch (e) {
        return { ok: false, error: '写入失败：' + (e && e.message || e) };
    }
    const reloaded = reloadBudget();
    return { ok: true, key: receipt.key, file, field, restored: from, reloaded };
}

// 短别名，调用方写起来更顺
const apply = applyAdjustment;
const revert = revertAdjustment;

module.exports = {
    build,
    runDaily,
    applyAdjustment,
    revertAdjustment,
    apply,
    revert,
    // 供 doctor / 探针直接查（调用时才统计，不占提示词）
    dayKey,
    startOfDay,
    clampChars,
    buildAdjustment,
    CONFIG_FILE,
    SPEECH_LOG,
    SPEECH_CFG,
    DEFAULT_MAX_CHARS,
    MAX_TEXT_CHARS,
};

// 可选的可观测入口：doctor/探针可以 eval `__dailyReport()`；不调用就零成本。
try {
    const g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : null);
    if (g && typeof g.__dailyReport !== 'function') g.__dailyReport = build;
} catch (e) { /* 全局挂载失败不影响模块使用 */ }

// ── 日终产出（2026-11-22 审计 U6 修复）──────────────────────────────────
// 审计发现：D1 整个模块**零生产调用点**（只有单测 require 它）——
// 「测试全绿但功能不存在」。这里补一个自带落盘的入口，app.js 只负责按天触发。
// 幂等：当天文件已存在就直接返回，不重复写；无数据（empty）不落文件。
function runDaily(now) {
    const t = Number(now) || Date.now();
    const key = dayKey(t);
    let file = '';
    try {
        const rf = require('./records-path.js').recordFile;
        file = rf('成绩单-' + key + '.txt');
    } catch (e) {
        return { ok: false, detail: '取记录室路径失败：' + String((e && e.message) || e) };
    }
    try { if (require('fs').existsSync(file)) return { ok: true, alreadyDone: true, file }; } catch (e) { /* 读不到就当没写过 */ }
    const r = build({ now: t });
    if (!r || r.empty || !r.text) return { ok: true, empty: true, file: null };
    const lines = ['#' + key, r.text];
    for (const a of (r.adjustments || [])) {
        lines.push('· 建议 ' + a.key + '：' + a.from + ' → ' + a.to + '（' + (a.why || '') + '）');
    }
    try {
        const fs = require('fs');
        const path = require('path');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    } catch (e) {
        return { ok: false, detail: '写成绩单失败：' + String((e && e.message) || e) };
    }
    return { ok: true, file, text: r.text };
}

