'use strict';
/**
 * doctor-judge.cjs —— 体检判据的纯函数（2026-11-24）
 *
 * 为什么单独一个文件：`pet-runtime/tools/doctor.mjs` 是顶层直接执行的 ESM（一 import 就联网、
 * 打日志、写 health.json），判据写在里面没法离线单测；复制一份到 _probe 又会和实现漂移
 * （旧门禁里出现过「测试改绿了、doctor 还是假绿」）。所以判据只留这一份：
 * doctor 读文件/发请求 → 调这里的纯函数 → 打印；`_probe/test-doctor-judge.cjs` 喂同样的
 * 合成数据。这里**不读文件、不发请求、不打印**。
 *
 * 设计口径（对应 HANDOFF-2026-11-24 §8.5「doctor 盲区」）：
 *   · 缓存命中：样本 <5 条 = 未验证（skip），别拿 1 条 0% 判红/判绿；
 *     样本只取主链（label/source = main 或空），插件/本地样本单列排除；
 *   · 用量账本：近 24h「每轮有没有账」——turn.end 的 turn_id 与 llm.usage 的
 *     turn_id 求交，覆盖 <80% 才是有轮没记账；单请求闲聊不算漏账（旧口径
 *     「usage/turn ≥50%」在 4.7 请求/轮下永远绿，改按请求数又会在单请求轮误报）；
 *     usage 行大多没有 turn_id 时回退「avg<2 且有工具轮」；<10 轮只算未验证；
 *   · 用量预算：80% 只算**非 estimated 的云端真账**；估算行（上游没给 usage 时
 *     本地估算）单列计数，不能把周配额提前打满；
 *   · 本地记忆：端口通 ≠ 模型对，必须校验 /v1/models 的 id 含 MemOperator；
 *   · 易变稳定：同一 turn 内 system_tokens / volatile_tokens 变化 = 前缀在轮内被打穿。
 */

const HOUR_MS = 3600 * 1000;

// ── 前缀缓存命中 ─────────────────────────────────────────────────────────
const CACHE_MIN_SAMPLES = 5;      // <5 条不判（样本不足，判绿判红都是假结论）
const CACHE_WARN_WEIGHTED = 40;   // 加权命中 <40% 才值得警告

/**
 * @param {Array<{prompt?:number,cached?:number,hitRate?:number,hasField?:boolean}>} samples
 * @returns {{status:'skip'|'ok'|'warn', detail:string, fix:string}}
 */
function judgeCacheHit(samples) {
    const all = Array.isArray(samples) ? samples : [];
    const rows = all.filter((s) => s && s.hasField);
    if (!rows.length) {
        return {
            status: 'skip',
            detail: '上游 usage 没有 cached 字段（命中率不可测）',
            fix: '',
        };
    }
    let sumP = 0;
    let sumC = 0;
    let zeros = 0;
    const rates = [];
    for (const r of rows) {
        const p = Number(r.prompt);
        const c = Number(r.cached);
        if (Number.isFinite(p) && p > 0) sumP += p;
        if (Number.isFinite(c) && c >= 0) sumC += c;
        const rate = Number(r.hitRate) || 0;
        rates.push(rate);
        if (rate === 0) zeros += 1;
    }
    if (sumP <= 0) {
        return {
            status: 'skip',
            detail: '有缓存字段但 prompt_tokens 全是 0/缺失（命中率不可测）',
            fix: '',
        };
    }
    const weighted = Math.round((sumC / sumP) * 1000) / 10;
    const sorted = rates.slice().sort((a, b) => a - b);
    const p50 = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 : 0;
    const detail = '近 ' + rows.length + ' 次加权 ' + weighted + '% · p50 ' + p50 + '% · 0% 命中 '
        + zeros + '/' + rows.length;
    // 0% 且样本 ≥5 必须 warn，不能绿：整体加权 0 一定 <40，这条由下面统一覆盖；
    // 单独写出来是为了防止以后有人把阈值改成「>= 某负数」时 0% 又被判绿。
    if (rows.length < CACHE_MIN_SAMPLES) {
        return {
            status: 'skip',
            detail: detail + '（样本 ' + rows.length + ' <' + CACHE_MIN_SAMPLES + '，未验证）',
            fix: '至少攒 ' + CACHE_MIN_SAMPLES + ' 次带 cached 字段的请求再判；重启后前 1–2 次 0% 属正常',
        };
    }
    if (weighted < CACHE_WARN_WEIGHTED) {
        return {
            status: 'warn',
            detail,
            fix: '查 system 指纹是否每轮变、易变注入是否在轮内重复生成、压缩是否过频（刚重启时前 1–2 次 0% 正常）',
        };
    }
    return { status: 'ok', detail, fix: '' };
}

/**
 * 主链缓存样本筛选（2026-11-24）。
 *
 * 为什么：`llm.cache` 是一条通用遥测，只要 LLMClient 用了就落；插件/本地小请求
 * （prompt <2k）和主链轮次混在最近 40 条里，加权命中率会被拉偏。判前缀缓存是否
 * 被轮内改写打穿，必须只看**主链**样本。
 *
 * 认 label 优先（provider 子链语义），没有 label 才看 source（telemetry 目前只落 source）。
 * 其余（plugin/local/vision…）只计数，不参与判据 —— 单列出来，免得「看不见」=「没发生」。
 * @param {Array<object>} rows llm.cache 行
 * @param {number} [limit] 最多取最近几条主链样本
 * @returns {{samples:Array<object>, excluded:number}}
 */
function pickCacheSamples(rows, limit = 40) {
    const all = Array.isArray(rows) ? rows : [];
    const main = [];
    let excluded = 0;
    for (const r of all) {
        if (!r) continue;
        const tag = String(r.label || r.source || '').trim().toLowerCase();
        if (!tag || tag === 'main') main.push(r);
        else excluded += 1;
    }
    const lim = Math.max(0, Number(limit) || 0);
    return { samples: lim > 0 ? main.slice(-lim) : main, excluded };
}

// ── 用量账本覆盖率（turn_id 真覆盖，2026-11-24 第二版）─────────────────────
// 前一版按「平均请求数/轮 <2」判，会在**单请求轮**上误报：8004 直驱的简单问答
// 一轮本来就只有 1 次请求（实测 9 条 usage / 6 轮），账本一条没漏却报「有请求没记账」。
//
// 现在用 turn_id 做真覆盖（llm-client 已把 turn_id 写进 llm.usage）：
//   T = 近 24h 所有 turn.end 的 turn_id；U = llm.usage 里非空 turn_id 的集合；
//   覆盖 = |T∩U| / |T|。这是「每轮有没有账」的精确证据，与每轮请求数无关。
//   · 覆盖 <80% → warn「有 X 轮没有任何账本记录」（缺 1 轮是事实，任何轮数都算）；
//   · 覆盖 ≥80% 但 |T|<10 → skip（不拿 6 轮样本判绿）；
//   · usage 行大多没有 turn_id（老数据/本地后台行）→ 回退旧口径：
//     平均 <2 请求/轮**且**窗口内有工具轮才 warn（纯单请求闲聊不算漏账）。
const LEDGER_COVERAGE_MIN = 0.8;
const LEDGER_MIN_REQUESTS_PER_TURN = 2;   // 仅回退口径用
const LEDGER_NORMAL_PER_TURN = '4–5';
// 样本下限：健康结论要 ≥10 轮才下（别拿 5–6 轮合成样本判绿/判红）。
const LEDGER_MIN_TURNS = 10;

// 不产生（或无法保证产生）llm.usage 的轮：这些轮没账是**设计如此**，不是漏账。
// 取值来自生产者实际代码（2026-11-25 grep，不是猜）：
//   · llm-handler.js `runTurnWithTurn` → 'ok' | 'error'（异常中断也算 error）；
//   · InputRouter.js → 'prevented'（插件已处理，未进 LLM）| 'error'；
//   · tool-executor.js 孤儿工具轮 → 'tool-batch'（该轮只有工具事件，没有 LLM 请求）；
//   · 'interrupted' 目前没有生产者，保留给流式被打断的收轮（用户取消/看门狗中止），
//     与将来的 outcome 命名对齐，避免新数据一上线又假红。
// ⚠ 只排除这几类；'ok' 轮缺账仍按覆盖率判（<80% → warn），硬故障不豁免。
const LEDGER_NON_BILLABLE_OUTCOMES = new Set(['interrupted', 'error', 'prevented', 'tool-batch']);

function _rowTurnId(l) {
    return String((l && l.turn_id) || '').trim();
}

/** turn.end 的 outcome 归一（telemetry 行级字段，见 telemetry.js:117）。 */
function _rowOutcome(l) {
    return String((l && l.outcome) || '').trim().toLowerCase();
}

/**
 * 近 windowMs 内「每轮有没有账」。
 * 主判据走 turn_id 交集（精确）；没有 turn_id 的老数据回退每轮平均请求数。
 * source='probe' 的探针行不参与。
 *
 * 2026-11-25：先把「本来就不该有账」的轮排除出 T 集合（见 LEDGER_NON_BILLABLE_OUTCOMES）。
 * 流式吐字后失败 / 被用户打断的请求不会落 llm.usage，旧逻辑把这些轮算成「有轮没记账」，
 * 覆盖率被假红。排除数在 detail 里单列，口径可见；'ok' 轮缺账仍照判。
 * @param {Array<object>} rows telemetry 行
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {{status:'skip'|'ok'|'warn', detail:string, fix:string,
 *            usage:number, turns:number, turnsTotal:number, excluded:number,
 *            perTurn:number, pct:number,
 *            mode:'turn-id'|'fallback', covered:number, coverage:number|null}}
 */
function judgeLedgerCoverage(rows, now = Date.now(), windowMs = 24 * HOUR_MS) {
    const from = now - windowMs;
    const inWindow = (Array.isArray(rows) ? rows : []).filter((l) => l && Number(l.ts) >= from
        && l.source !== 'probe');
    const turnRows = inWindow.filter((l) => l.cat === 'turn' && l.type === 'turn.end');
    // 被打断/出错/插件已处理/孤儿工具轮：没有 llm.usage 是正常的，不参与覆盖率。
    const billableTurnRows = turnRows.filter((l) => !LEDGER_NON_BILLABLE_OUTCOMES.has(_rowOutcome(l)));
    const excluded = turnRows.length - billableTurnRows.length;
    const usageRows = inWindow.filter((l) => l.cat === 'llm' && l.type === 'llm.usage');
    const usage = usageRows.length;
    const turns = billableTurnRows.length;
    const perTurn = turns ? usage / turns : 0;
    const avg = Math.round(perTurn * 10) / 10;
    // pct 仅保留给旧消费方（= usage/turns 的百分比），新判据不再看它。
    const base = { usage, turns, turnsTotal: turnRows.length, excluded,
        perTurn, pct: Math.round(perTurn * 100),
        mode: 'fallback', covered: 0, coverage: null };
    const excludedNote = excluded > 0 ? '（已排除 ' + excluded + ' 轮被打断/出错）' : '';
    if (turns === 0) {
        return {
            status: 'skip',
            detail: excluded > 0
                ? '近 24h 的 ' + excluded + ' 轮全部被打断/出错，无需判账本覆盖'
                : '近 24h 没有 turn.end（重启宿主后聊一句再体检）',
            fix: '',
            ...base,
        };
    }
    // 账本彻底没写：任何轮数都是硬故障（不是「样本不足」能解释的）
    if (usage === 0) {
        return {
            status: 'warn',
            detail: '近24h 账本 0 条 / ' + turns + ' 轮，账本一条都没写' + excludedNote,
            fix: '确认主链与后台摘要都走 llm-client / local-llm（会写 llm.usage）；旁路裸 fetch 是漏账根因',
            ...base,
        };
    }

    const T = new Set(billableTurnRows.map(_rowTurnId).filter(Boolean));
    const withId = usageRows.filter((l) => _rowTurnId(l));
    const idRatio = withId.length / usage;

    if (T.size && idRatio >= 0.5) {
        const U = new Set(withId.map(_rowTurnId));
        let covered = 0;
        for (const id of T) if (U.has(id)) covered += 1;
        const cov = covered / T.size;
        const covPct = Math.round(cov * 100);
        const detail = '近24h 轮 ' + T.size + ' · 有账 ' + covered + ' 轮（覆盖 ' + covPct
            + '%，平均 ' + avg + ' 请求/轮）' + excludedNote;
        const out = { ...base, mode: 'turn-id', covered, coverage: cov };
        if (cov < LEDGER_COVERAGE_MIN) {
            return {
                status: 'warn',
                detail: detail + ' —— 有 ' + (T.size - covered) + ' 轮没有任何账本记录',
                fix: '这些轮的请求没进 llm.usage：确认主链与后台摘要都走 llm-client（会写 llm.usage）；旁路裸 fetch 是漏账根因',
                ...out,
            };
        }
        if (T.size < LEDGER_MIN_TURNS) {
            return {
                status: 'skip',
                detail: detail + '（轮数 < ' + LEDGER_MIN_TURNS + '，未验证）',
                fix: '',
                ...out,
            };
        }
        return { status: 'ok', detail, fix: '', ...out };
    }

    // 回退：老数据 / 本地后台行没有 turn_id，只能看每轮平均请求数。
    // 纯单请求闲聊（无工具轮）本来 avg 就低，不算漏账；有工具轮还 <2 才是异常。
    const hasTool = inWindow.some((l) => l.cat === 'turn' && l.type === 'tool.end');
    const detail = '近24h 账本 ' + usage + ' 条 / ' + turns + ' 轮（平均 ' + avg
        + ' 请求/轮，多数无 turn_id，走旧口径）' + excludedNote;
    if (perTurn < LEDGER_MIN_REQUESTS_PER_TURN && hasTool) {
        return {
            status: 'warn',
            detail: detail + '，明显低于常态 ' + LEDGER_NORMAL_PER_TURN + '（有请求没记账）',
            fix: '确认主链、工具循环与后台摘要都走 llm-client（会写 llm.usage）；旁路裸 fetch（旧 ContextCompressor 等）是漏账根因',
            ...base,
        };
    }
    if (turns < LEDGER_MIN_TURNS) {
        return {
            status: 'skip',
            detail: detail + '（轮数 < ' + LEDGER_MIN_TURNS + '，未验证）',
            fix: '',
            ...base,
        };
    }
    return {
        status: 'ok',
        detail: detail + (perTurn < LEDGER_MIN_REQUESTS_PER_TURN ? '，纯单请求轮不算漏账' : ''),
        fix: '',
        ...base,
    };
}

// ── 用量预算（真账 / 估算分离）───────────────────────────────────────────
// 2026-11-24：上游没给 usage 的请求会由本地估算（metrics.estimated=1）兜底。
// 估算行是「大概花了多少」，不能和 provider 真账混成一个数，否则：
//   · 80% 周预算被估算行提前打满 → 误报；
//   · p50/p90 口径说不清。
// 所以预算只吃**非 estimated 的云端行**，估算行单列计数与 token。
const WEEK_MS = 7 * 24 * HOUR_MS;

/** 估算行判定：metrics.estimated 优先，兼容行级 estimated（字段名以生产者为高，当前是 metrics）。 */
function isEstimatedRow(row) {
    if (!row) return false;
    const m = row.metrics || {};
    const v = m.estimated != null ? m.estimated : row.estimated;
    return v === 1 || v === '1' || v === true;
}

/** 本地行判定：与 usage-ledger.aggregateUsage 同口径（只看 source='local'）。 */
function _isLocalSource(row) {
    return String((row && row.source) || '').toLowerCase() === 'local';
}

function _tokens(row) {
    const m = (row && row.metrics) || {};
    const p = Number(m.prompt_tokens);
    const c = Number(m.completion_tokens);
    return {
        prompt: Number.isFinite(p) ? p : 0,
        completion: Number.isFinite(c) ? c : 0,
    };
}

function _blankUsageBucket() {
    return {
        requests: 0,          // 全部行
        estimated: 0,         // 估算行数（含本地）
        cloud: 0,             // 云端行（真账 + 估算）
        cloudEstimated: 0,    // 云端估算行数
        cloudRealPrompt: 0,   // 云端真账 prompt（预算分母）
        cloudRealCompletion: 0,
        cloudEstimatedPrompt: 0,   // 云端估算 token（只做展示）
        cloudEstimatedCompletion: 0,
        local: 0,             // 本地行（不算云端配额）
        localEstimated: 0,
    };
}

/**
 * 今日 / 近 7 天的真账-估算、云-本地拆分。纯函数，不读文件。
 * @param {Array<object>} rows telemetry 行
 * @param {number} [now]
 * @param {number} [weekMs]
 * @returns {{today:object, week:object}}
 */
function summarizeUsage(rows, now = Date.now(), weekMs = WEEK_MS) {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = now - weekMs;
    const today = _blankUsageBucket();
    const week = _blankUsageBucket();
    for (const r of (Array.isArray(rows) ? rows : [])) {
        if (!r || r.cat !== 'llm' || r.type !== 'llm.usage') continue;
        const ts = Number(r.ts);
        if (!Number.isFinite(ts)) continue;
        const est = isEstimatedRow(r);
        const local = _isLocalSource(r);
        const t = _tokens(r);
        const apply = (b) => {
            b.requests += 1;
            if (est) b.estimated += 1;
            if (local) {
                b.local += 1;
                if (est) b.localEstimated += 1;
                return;      // 本地不消耗云端周配额
            }
            b.cloud += 1;
            if (est) {
                b.cloudEstimated += 1;
                b.cloudEstimatedPrompt += t.prompt;
                b.cloudEstimatedCompletion += t.completion;
            } else {
                b.cloudRealPrompt += t.prompt;
                b.cloudRealCompletion += t.completion;
            }
        };
        if (ts >= todayStart.getTime()) apply(today);
        if (ts >= weekStart) apply(week);
    }
    return { today, week };
}

function _fmtTokens(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? (Math.round(v / 100) / 10) + 'k' : String(Math.round(v));
}

/**
 * 周预算判级（只告警不拦截）。**分母只含云端非 estimated 的真账**。
 * @param {Array<object>} rows telemetry 行
 * @param {{now?:number, weekMs?:number, budget?:number}} [opts]
 * @returns {{status:'stats'|'ok'|'warn', pct:number|null, detail:string, fix:string,
 *            weekRealTokens:number, today:object, week:object}}
 */
function judgeUsageBudget(rows, opts) {
    const o = opts || {};
    const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    const weekMs = Number.isFinite(Number(o.weekMs)) && Number(o.weekMs) > 0 ? Number(o.weekMs) : WEEK_MS;
    const sum = summarizeUsage(rows, now, weekMs);
    const t = sum.today;
    const w = sum.week;
    const realPrompt = w.cloudRealPrompt;
    const realCompletion = w.cloudRealCompletion;
    const realTokens = realPrompt + realCompletion;
    let detail = '今日 ' + t.requests + ' 次（真账 ' + (t.requests - t.estimated) + ' / 估算 ' + t.estimated + '）'
        + ' · 近7天 云真账 ' + (w.cloud - w.cloudEstimated) + ' 次 prompt ' + _fmtTokens(realPrompt)
        + ' / 出 ' + _fmtTokens(realCompletion);
    if (w.cloudEstimated > 0) {
        detail += ' · 估算 ' + w.cloudEstimated + ' 条另计 prompt ' + _fmtTokens(w.cloudEstimatedPrompt)
            + ' / 出 ' + _fmtTokens(w.cloudEstimatedCompletion) + '（不计入周预算）';
    }
    detail += ' · 本地 ' + w.local + ' 次' + (w.localEstimated ? '（估算 ' + w.localEstimated + '）' : '');

    const budget = Number(o.budget);
    const out = { weekRealTokens: realTokens, today: t, week: w, detail, fix: '' };
    if (!Number.isFinite(budget) || budget <= 0) {
        return { ...out, status: 'stats', pct: null };
    }
    const pct = Math.round((realTokens / budget) * 1000) / 10;
    if (pct >= 80) {
        return {
            ...out,
            status: 'warn',
            pct,
            fix: '周配额告急：先降后台摘要/看屏频率，或等重置（只告警，不拦截）',
        };
    }
    return { ...out, status: 'ok', pct };
}


// ── 本地记忆模型 ─────────────────────────────────────────────────────────
const LOCAL_MEMORY_MODEL_RE = /memoperator/i;

/**
 * @param {{enabled?:boolean, healthError?:string|false, models?:string[], port?:number,
 *          nCtx?:number, kvCache?:string}} input
 *   enabled=false 是用户显式关；healthError 非空 = 端口没起（可选服务，skip）；
 *   models = /v1/models 的 id 列表；nCtx = /props 的实际上下文（只用于展示）。
 * @returns {{status:'skip'|'ok'|'warn', detail:string, fix:string}}
 */
function judgeLocalMemory(input) {
    const o = input || {};
    const port = Number(o.port) || 11435;
    if (o.enabled === false) {
        return { status: 'skip', detail: 'config.cost.local_memory=false（手动关闭）', fix: '' };
    }
    if (o.healthError) {
        return {
            status: 'skip',
            detail: port + ' 未启动（可选：后台摘要/抽取会跳过，不烧云端）',
            fix: '需要本地摘要时再起：powershell -File scripts/start-local-memory-llm.ps1',
        };
    }
    const models = (Array.isArray(o.models) ? o.models : []).map((m) => String(m || '')).filter(Boolean);
    if (!models.length) {
        return {
            status: 'warn',
            detail: port + ' 在线，但 /v1/models 没有模型（端口活着但模型没加载）',
            fix: 'llama-server 启动参数缺 -m/--model，或模型路径不对；重看 start-local-memory-llm.ps1 日志',
        };
    }
    const hit = models.find((id) => LOCAL_MEMORY_MODEL_RE.test(id));
    if (!hit) {
        return {
            status: 'warn',
            detail: port + ' 在线，但模型不对：' + models.join(', ') + '（期望 MemOperator*）',
            fix: '11435 被别的模型占了：确认 llama-server 加载的是 MemOperator-4B，而不是通用 chat 模型',
        };
    }
    return { status: 'ok', detail: localMemoryOnlineDetail(hit, o.nCtx, o.kvCache), fix: '' };
}

/**
 * 在线标签（展示层，不参与判定）：不写死「32K/KV q8」——实测 Daily 档
 * /props 的 n_ctx=28672，写死会误导。n_ctx 探不到就只写「在线」。
 * KV 量化目前没有可靠探测口，探不到就不写（不臆造）。
 * @param {string} model /v1/models 命中的 id
 * @param {number|string} [nCtx] llama-server /props 的 n_ctx
 * @param {string} [kvCache] 可选的 KV 类型（有才写）
 */
function localMemoryOnlineDetail(model, nCtx, kvCache) {
    const ctx = Number(nCtx);
    const parts = ['本地记忆模型', String(model)];
    if (Number.isFinite(ctx) && ctx > 0) parts.push('ctx=' + Math.round(ctx));
    const kv = String(kvCache == null ? '' : kvCache).trim();
    if (kv) parts.push('KV=' + kv);
    parts.push('在线');
    return parts.join(' · ');
}

// ── 前缀冻结复用 / 轮内易变稳定性（本轮 P0 的验收观测）─────────────────────
// telemetry 契约以**生产者实际代码**为准（2026-11-24 核对 js/ai/llm-handler.js）：
//   · 每个有请求的轮末落一条 `cat=llm, type=llm.freeze`，带 turn_id，
//     metrics = { reuse, rebuild, rewrite, requests, prefix_msgs, prefix_chars }；
//   · 宿主改写已发出过的前缀时，额外落 `llm.freeze.break`，metrics={rewrite:1, at_msg}。
// ⚠ llm.freeze 的 rewrite 已经包含 break 的那次（见 llm-handler freezeStats.rewrite += 1），
//   所以**只能读 llm.freeze 的 rewrite，不能再把 break 的 rewrite 加上去**，否则双计。
// 判据（用户拍板）：近 24h 聚合，requests<10 → skip（样本不足）；rewrite/requests>0.2
// 或 reuse/requests<0.5 → warn（工具循环内前缀复用率过低）。
const FREEZE_MIN_REQUESTS = 10;
const FREEZE_MAX_REWRITE_RATE = 0.2;
const FREEZE_MIN_REUSE_RATE = 0.5;

/**
 * @param {Array<object>} rows telemetry 行
 * @param {number} [now]
 * @param {number} [windowMs]
 * @returns {{status:'skip'|'ok'|'warn', detail:string, fix:string,
 *            requests:number, reuse:number, rebuild:number, rewrite:number,
 *            reuseRate:number, rewriteRate:number}}
 */
function judgeFreezeReuse(rows, now = Date.now(), windowMs = 24 * HOUR_MS) {
    const from = now - windowMs;
    const inWindow = (Array.isArray(rows) ? rows : []).filter((l) => l && Number(l.ts) >= from
        && l.source !== 'probe');
    const freezeRows = inWindow.filter((l) => l.cat === 'llm' && l.type === 'llm.freeze' && l.metrics);
    const sum = { requests: 0, reuse: 0, rebuild: 0, rewrite: 0 };
    for (const r of freezeRows) {
        for (const k of Object.keys(sum)) sum[k] += Number(r.metrics[k]) || 0;
    }
    const base = { ...sum, reuseRate: 0, rewriteRate: 0 };
    if (!freezeRows.length) {
        return {
            status: 'skip',
            detail: '近24h 没有 llm.freeze 记录（重启宿主后聊一轮，工具循环才会产生复用数据）',
            fix: '',
            ...base,
        };
    }
    if (sum.requests < FREEZE_MIN_REQUESTS) {
        return {
            status: 'skip',
            detail: '近24h 冻结请求 ' + sum.requests + ' 次（<' + FREEZE_MIN_REQUESTS + '，样本不足未验证）',
            fix: '',
            ...base,
        };
    }
    const reuseRate = sum.reuse / sum.requests;
    const rewriteRate = sum.rewrite / sum.requests;
    const pct = (x) => Math.round(x * 1000) / 10;
    const detail = '近24h 冻结请求 ' + sum.requests + ' 次 · 复用 ' + sum.reuse + '（' + pct(reuseRate)
        + '%）· 重冻 ' + sum.rebuild + ' · 改写 ' + sum.rewrite + '（' + pct(rewriteRate) + '%）';
    const out = { ...base, reuseRate, rewriteRate };
    if (rewriteRate > FREEZE_MAX_REWRITE_RATE || reuseRate < FREEZE_MIN_REUSE_RATE) {
        return {
            status: 'warn',
            detail: detail + ' —— 工具循环内前缀复用率过低',
            fix: '查宿主是否在轮内改写已发出的前缀（工具回执限流/裁剪）、易变注入是否每轮重复生成、system 补丁是否轮内更新',
            ...out,
        };
    }
    return { status: 'ok', detail, fix: '', ...out };
}

// ── provider 端点分级（主 / 可选本地 / 可选云）───────────────────────────
/**
 * provider 没有 required/role 字段（2026-11-24 核对 llm_providers.json），所以按语义识别：
 *   · 主 provider = config.llm.provider_id（缺省时取启用列表第一个）；
 *   · 可选本地 = api_url 是回环地址（127.0.0.0/8、::1、localhost，端口不限），或 id/role 明确标 local；
 *   · 其余 = 可选云。
 * ⚠ 回环判定与 plugin-context.isLoopbackUrl 同口径：本机 wb 在 127.0.0.1:20128，
 *   只认 11435 会把它算成云端。
 * 连不上时：主 → 红（对话必挂）；可选本地 → skip（按需启动）；可选云 → warn。
 * @param {{id:string, api_url?:string, role?:string, local?:boolean}} provider
 * @param {{mainProviderId?:string, firstEnabledId?:string, failure?:'empty-url'|'connect'}} ctx
 * @returns {{tier:'main'|'optional-local'|'optional-cloud'}}
 */
function isLoopbackHost(host) {
    const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return false;
    if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

function classifyProvider(provider, ctx) {
    const p = provider || {};
    const c = ctx || {};
    const mainId = String(c.mainProviderId || '').trim() || String(c.firstEnabledId || '').trim();
    if (mainId && String(p.id) === mainId) return { tier: 'main' };
    const raw = String(p.api_url || '').trim();
    let loopback = false;
    try {
        loopback = isLoopbackHost(new URL(raw).hostname);
    } catch (e) { loopback = false; }
    if (p.local === true || /^local/i.test(String(p.id || '')) || String(p.role || '') === 'local' || loopback) {
        return { tier: 'optional-local' };
    }
    return { tier: 'optional-cloud' };
}

/** 端点不可用时该判什么（红/skip/warn）。 */
function judgeProviderEndpoint(tier) {
    if (tier === 'main') return 'fail';
    if (tier === 'optional-local') return 'skip';
    return 'warn';
}

module.exports = {
    HOUR_MS,
    WEEK_MS,
    CACHE_MIN_SAMPLES,
    CACHE_WARN_WEIGHTED,
    LEDGER_COVERAGE_MIN,
    LEDGER_MIN_REQUESTS_PER_TURN,
    LEDGER_NORMAL_PER_TURN,
    LEDGER_MIN_TURNS,
    LEDGER_NON_BILLABLE_OUTCOMES,
    LOCAL_MEMORY_MODEL_RE,
    FREEZE_MIN_REQUESTS,
    FREEZE_MAX_REWRITE_RATE,
    FREEZE_MIN_REUSE_RATE,
    judgeCacheHit,
    pickCacheSamples,
    judgeLedgerCoverage,
    judgeUsageBudget,
    summarizeUsage,
    isEstimatedRow,
    judgeLocalMemory,
    judgeFreezeReuse,
    isLoopbackHost,
    classifyProvider,
    judgeProviderEndpoint,
};
