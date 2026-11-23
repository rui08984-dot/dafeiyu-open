'use strict';
/**
 * vision-tier.js —— 看屏摘要「按空闲显存分档」（2026-11-22）
 *
 * 要解决的问题：
 *   8B 视觉模型（qwen3-vl:8b，6.1GB）在 8GB 显存上占得太满：
 *   开游戏/看视频时显存不够，只能把视觉整个关掉 —— 功能直接降级成「只有时间戳」。
 *
 * 分档（阈值都可配）：
 *   freeVram ≥ highMinFreeVramMb（默认 4500）→ high  8B   完整摘要
 *   freeVram ≥ midMinFreeVramMb （默认 2500）→ mid   4B   摘要（略粗）
 *   其余                                      → low   2B   只一句话（粗摘要）
 *   读不到空闲显存 / tiers.enabled=false       → high（保持旧行为，不让档位判断本身成为风险）
 *
 * 失败回退链（不静默）：
 *   选中档模型失败 → 8B（high）→ 全失败 → 返回 { ok:false, disabled:true, reason }
 *   由调用方决定是回退云端模型还是暂时关闭视觉（两者都会记日志）。
 *
 * 这个模块不依赖 Electron / DOM，所有外部能力都可注入，方便 node 单测：
 *   readFreeVramMb({ execFileImpl, now, ttlMs, noCache })
 *   summarize({ messages, cfg, freeVramMb, call, log, now })
 *   pickTier / modelForTier / parseFreeVram / applyLowHint / callOllama 都是纯函数或可注入。
 */

const DEFAULT_HIGH_MODEL = 'qwen3-vl:8b';

const DEFAULTS = {
    // tiers.enabled 缺省 false：未显式开启时 pickTier 恒返回 high，行为和「只有 8B」一致
    enabled: false,
    high: DEFAULT_HIGH_MODEL,
    mid: '',
    low: '',
    highMinFreeVramMb: 4500,
    midMinFreeVramMb: 2500,
    // Ollama 的 OpenAI 兼容端点：POST {base}/v1/chat/completions
    ollamaUrl: 'http://127.0.0.1:11434',
    // 单次摘要上限（含模型冷载）。实测：4B/2B-instruct 冷载 11–18s、热态 2s；
    // 8B 在 8GB 显存上会部分落 CPU，冷载可到 60s+。45s 会把冷载误判成失败。
    requestTimeoutMs: 90000,
    // qwen3-vl 基础 tag 是 thinking 版：思考段会吃掉 token 预算，给太小会只思考不回答。
    // 900 够「思考 + 一句摘要」；instruct 版会自然早停，不受影响。
    maxTokens: 900,
    probeTimeoutMs: 5000,      // nvidia-smi 超时，失败只返回 null，不抛
    vramTtlMs: 30000,          // 空闲显存缓存 30s：2fps 采样下不能每帧都开子进程
    lowPromptHint: true,       // 低档追加一句「只回一句话」（由配置控制）
    lowPromptHintText: '这是低配视觉档：只回一句话，不要展开。',
};

function _num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function _str(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/** 归一化配置：任何缺省/脏值都不抛错，回落到默认档位。 */
function normalizeCfg(raw) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const highMin = _num(src.highMinFreeVramMb, DEFAULTS.highMinFreeVramMb);
    let midMin = _num(src.midMinFreeVramMb, DEFAULTS.midMinFreeVramMb);
    // 中档阈值不能高于高档，否则 mid 永远不可达
    if (midMin > highMin) midMin = highMin;
    return {
        enabled: src.enabled === true,
        high: _str(src.high) || DEFAULTS.high,
        mid: _str(src.mid),
        low: _str(src.low),
        highMinFreeVramMb: highMin,
        midMinFreeVramMb: midMin,
        ollamaUrl: _str(src.ollamaUrl) || DEFAULTS.ollamaUrl,
        requestTimeoutMs: _num(src.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
        maxTokens: _num(src.maxTokens, DEFAULTS.maxTokens),
        probeTimeoutMs: _num(src.probeTimeoutMs, DEFAULTS.probeTimeoutMs),
        vramTtlMs: _num(src.vramTtlMs, DEFAULTS.vramTtlMs),
        lowPromptHint: src.lowPromptHint !== false,
        lowPromptHintText: _str(src.lowPromptHintText) || DEFAULTS.lowPromptHintText,
    };
}

/**
 * 选档。
 * @param {{freeVramMb?: number|null, cfg?: object}} args
 * @returns {'high'|'mid'|'low'}
 */
function pickTier({ freeVramMb, cfg } = {}) {
    const c = normalizeCfg(cfg);
    if (!c.enabled) return 'high';
    // null/undefined/NaN 一律按 high：读不到显存时不冒险降档
    if (freeVramMb === null || freeVramMb === undefined || freeVramMb === '') return 'high';
    const mb = Number(freeVramMb);
    if (!Number.isFinite(mb)) return 'high';
    if (mb >= c.highMinFreeVramMb) return 'high';
    if (mb >= c.midMinFreeVramMb) return 'mid';
    return 'low';
}

/**
 * 档位 → 模型名。mid/low 没配时逐级回落到更高的档（永远不会因为缺配置而没有模型）。
 * @returns {string|null}
 */
function modelForTier(tier, cfg) {
    const c = normalizeCfg(cfg);
    if (tier === 'mid') return c.mid || c.high || null;
    if (tier === 'low') return c.low || c.mid || c.high || null;
    return c.high || null;
}

/** nvidia-smi 输出 → 空闲显存 MB（第一块 GPU）；解析失败 null。 */
function parseFreeVram(stdout) {
    const lines = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
        const m = line.match(/-?\d+(?:\.\d+)?/);
        if (!m) continue;
        const n = Number(m[0]);
        if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
    return null;
}

// 进程内缓存（30s）：看屏 2fps 采样，不能每帧都开 nvidia-smi 子进程
let _vramCache = { at: 0, value: null, has: false };

/**
 * 异步读空闲显存（MB）。5s 超时；失败返回 null（绝不抛、绝不阻塞渲染层）。
 * @param {{execFileImpl?: Function, now?: Function, ttlMs?: number, noCache?: boolean}} [options]
 * @returns {Promise<number|null>}
 */
async function readFreeVramMb(options = {}) {
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const ttl = _num(options.ttlMs, DEFAULTS.vramTtlMs);
    if (options.noCache !== true && _vramCache.has && (now - _vramCache.at) < ttl) {
        return _vramCache.value;
    }
    const timeout = _num(options.timeoutMs, DEFAULTS.probeTimeoutMs);
    let execFile = options.execFileImpl;
    if (typeof execFile !== 'function') {
        try { execFile = require('child_process').execFile; } catch (_) { execFile = null; }
    }
    let value = null;
    if (typeof execFile === 'function') {
        value = await new Promise((resolve) => {
            let settled = false;
            const done = (v) => { if (!settled) { settled = true; resolve(v); } };
            try {
                execFile(
                    'nvidia-smi',
                    ['--query-gpu=memory.free', '--format=csv,noheader,nounits'],
                    { timeout, windowsHide: true },
                    (err, stdout) => done(err ? null : parseFreeVram(stdout))
                );
            } catch (e) {
                done(null);
            }
        });
    }
    _vramCache = { at: now, value, has: true };
    return value;
}

/** 低档追加一句约束（prompt 其余部分保持不变）；返回新数组，不改入参。 */
function applyLowHint(messages, cfg, tier) {
    const list = Array.isArray(messages) ? messages : [];
    const c = normalizeCfg(cfg);
    if (tier !== 'low' || !c.lowPromptHint) return list;
    const hint = c.lowPromptHintText;
    const out = list.map((m) => ({ ...m }));
    const sys = out.find((m) => m && m.role === 'system');
    if (sys) {
        if (typeof sys.content === 'string') {
            sys.content = sys.content + '\n' + hint;
        } else if (Array.isArray(sys.content)) {
            sys.content = sys.content.concat([{ type: 'text', text: hint }]);
        }
        return out;
    }
    out.unshift({ role: 'system', content: hint });
    return out;
}

/** 去掉 thinking 模型的思考段：闭合的保留正文，未闭合的（被 max_tokens 截断）视为空回复。 */
function stripThink(text) {
    let t = String(text || '').trim();
    // 只认真正的思考块（" thinking" 或行首 "thinking" + 换行），避免把英文句子开头的
    // "thinking about…" 误判成思考段而整条丢掉
    if (!t.startsWith(' thinking') && !/^thinking\r?\n/.test(t)) return t;
    const close = t.indexOf('</think>');
    if (close < 0) return '';
    t = t.slice(close + '</think>'.length).trim();
    return t;
}

function _textOf(raw) {
    if (typeof raw === 'string') return stripThink(raw);
    if (raw && typeof raw.content === 'string') return stripThink(raw.content);
    if (raw && Array.isArray(raw.choices) && raw.choices[0] && raw.choices[0].message) {
        const message = raw.choices[0].message;
        const content = message.content;
        if (typeof content === 'string') return stripThink(content);
        // content 空但 reasoning 有内容：thinking 版 tag 把预算全花在思考上，明确按空回复处理
        if (typeof message.reasoning === 'string' && message.reasoning.trim()) return '';
    }
    return '';
}

/**
 * 直接调 Ollama 的 OpenAI 兼容端点（POST {base}/v1/chat/completions）。
 * 图片沿用现有格式：{ type:'image_url', image_url:{ url:'data:image/jpeg;base64,...' } }
 * @returns {Promise<string>} 模型文本；失败抛错（由 summarize 的回退链接住）
 */
async function callOllama({ model, messages, baseUrl, timeoutMs, fetchImpl, temperature, maxTokens } = {}) {
    const base = String(baseUrl || DEFAULTS.ollamaUrl).replace(/\/+$/, '');
    const doFetch = typeof fetchImpl === 'function'
        ? fetchImpl
        : (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) throw new Error('当前运行环境没有 fetch');
    const timerMs = _num(timeoutMs, DEFAULTS.requestTimeoutMs);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (_) { /* noop */ } }, timerMs) : null;
    try {
        const res = await doFetch(base + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages,
                stream: false,
                temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
                max_tokens: _num(maxTokens, DEFAULTS.maxTokens),
                // 老版本 Ollama 会忽略；instruct 版本来就不思考，thinking 版则会在 _textOf 里被剥掉
                think: false,
            }),
            signal: controller ? controller.signal : undefined,
        });
        const bodyText = await res.text();
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + String(bodyText || '').slice(0, 160));
        let data;
        try { data = JSON.parse(bodyText); } catch (_) { throw new Error('响应不是 JSON'); }
        const text = _textOf(data);
        if (!text) throw new Error('空回复');
        return text;
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * 按档位选模型并调用；失败按 chosen → high → 停用 回退。
 * @param {object} args
 * @param {Array} args.messages        OpenAI 格式消息（图片在 user.content 里）
 * @param {object} args.cfg            config.vision.tiers
 * @param {number|null} [args.freeVramMb] 不传则异步探测
 * @param {Function} [args.call]       注入 ({model, messages, tier, freeVramMb}) => string|{content}
 * @param {Function} [args.log]        (level, line) => void
 * @returns {Promise<{ok:boolean, tier:string, chosenModel:string|null, model:string|null,
 *   fallback:boolean, text?:string, attempts:Array, freeVramMb:number|null, disabled?:boolean, reason?:string}>}
 */
async function summarize({ messages, cfg, freeVramMb, call, log, now } = {}) {
    const c = normalizeCfg(cfg);
    const emit = typeof log === 'function' ? log : () => {};

    let vram = freeVramMb;
    if (vram === undefined) {
        try { vram = await readFreeVramMb({ now }); } catch (_) { vram = null; }
    }

    const tier = pickTier({ freeVramMb: vram, cfg: c });
    const chosenModel = modelForTier(tier, c);
    const attempts = [];
    if (!chosenModel) {
        const reason = '没有配置任何视觉模型名（tiers.high 为空）';
        emit('warn', '[vision-tier] ' + reason);
        return { ok: false, disabled: true, tier, chosenModel: null, model: null, fallback: false, attempts, freeVramMb: vram, reason };
    }

    const chain = [];
    for (const m of [chosenModel, modelForTier('high', c)]) {
        if (m && !chain.includes(m)) chain.push(m);
    }

    const invoke = typeof call === 'function'
        ? call
        : (args) => callOllama({
            ...args,
            baseUrl: c.ollamaUrl,
            timeoutMs: c.requestTimeoutMs,
            maxTokens: c.maxTokens,
        });
    const highModel = modelForTier('high', c);

    for (const model of chain) {
        const t0 = Date.now();
        // 回退到 high 时用 high 的 prompt（低档的「只回一句话」不应污染 8B 的完整摘要）
        const attemptTier = model === highModel ? 'high' : tier;
        try {
            const raw = await invoke({
                model,
                messages: applyLowHint(messages, c, attemptTier),
                tier: attemptTier,
                freeVramMb: vram,
            });
            const text = _textOf(raw);
            if (!text) throw new Error('空回复');
            attempts.push({ model, ok: true, ms: Date.now() - t0 });
            return {
                ok: true, tier, chosenModel, model,
                fallback: model !== chosenModel,
                text, attempts, freeVramMb: vram,
            };
        } catch (error) {
            const msg = String((error && error.message) || error);
            attempts.push({ model, ok: false, ms: Date.now() - t0, error: msg });
            emit('warn', `[vision-tier] ${model} 失败：${msg}`);
        }
    }

    const reason = '所有视觉档都失败（' + attempts.map((a) => a.model + ': ' + a.error).join('；') + '）';
    emit('warn', '[vision-tier] ' + reason);
    return { ok: false, disabled: true, tier, chosenModel, model: null, fallback: false, attempts, freeVramMb: vram, reason };
}

/** 测试用：清空显存缓存（生产不会调用）。 */
function _resetVramCache() {
    _vramCache = { at: 0, value: null, has: false };
}

module.exports = {
    DEFAULTS,
    DEFAULT_HIGH_MODEL,
    normalizeCfg,
    pickTier,
    modelForTier,
    parseFreeVram,
    readFreeVramMb,
    applyLowHint,
    stripThink,
    callOllama,
    summarize,
    _resetVramCache,
};
