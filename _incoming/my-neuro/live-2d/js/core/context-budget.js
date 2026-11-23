'use strict';
// context-budget.js —— 上下文预算账本（C3，2026-11-21）
//
// 要解决的问题：现在上下文按**消息条数**裁剪（15 条），没人知道「谁在吃上下文」——
// 是人格 system、工具 schema、召回记忆，还是世界行/情绪这类易变尾巴？
// 用户问「她为什么变慢了/为什么忘了前面」，只能猜。
//
// 做法（只测量，不改行为）：
//   · 每轮请求前把 messages + tools 按 section 分类估算 token；
//   · 写一条 telemetry（cat=context, type=context.budget），metrics 全是数字；
//   · doctor 读最近 20 轮算各 section p50/p90 + 增长最快的前两项。
//
// 为什么先测量再压缩：按条数裁剪对「一条长记忆」和「一条短问候」一视同仁，
// 盲目压缩会把关键记忆先砍掉。有了 section 账本，压缩才有靶子（研讨 C3 的顺序）。
//
// token 估算与 world-store 同口径（CJK 1 字≈1 token，ASCII 4 字符≈1 token）：
// 不引分词器 —— 这是趋势观测，不是计费；误差不影响「谁在涨」的判断。

// 与 prompt-layout.VOLATILE_HEADER **同一个串**：那边改了这里必须跟着改，
// 否则 section 分类会把易变尾巴算进 history（账本就失真了）。单测会钉住这个常量。
const VOLATILE_HEADER = '（系统补充，不必回应）';

let _emitTelemetry = null;
try { _emitTelemetry = require('./telemetry.js').emitTelemetry; } catch (e) { _emitTelemetry = null; }

function estimateTokens(text) {
    const s = String(text == null ? '' : text);
    let cjk = 0;
    let other = 0;
    for (const ch of s) {
        const code = ch.codePointAt(0);
        if (code >= 0x2e80) cjk += 1;
        else other += 1;
    }
    return cjk + Math.ceil(other / 4);
}

/** message → section。只按角色与「是不是易变尾巴」分，不做内容猜测。 */
function classifyMessage(msg) {
    const role = String((msg && msg.role) || '');
    if (role === 'system') return 'system';
    const content = typeof (msg && msg.content) === 'string'
        ? msg.content
        : (Array.isArray(msg && msg.content) ? msg.content.map((p) => (p && (p.text || '')) || '').join(' ') : '');
    if (content.includes(VOLATILE_HEADER)) return 'volatile';
    if (role === 'tool') return 'history';
    return 'history';
}

/**
 * 测量一轮请求。
 * @param {{messages?:Array, tools?:Array}} input
 * @returns {{system:number, tools:number, history:number, volatile:number, total:number, msgCount:number, toolCount:number}}
 */
function measure(input) {
    const o = input || {};
    const messages = Array.isArray(o.messages) ? o.messages : [];
    const tools = Array.isArray(o.tools) ? o.tools : [];
    const out = { system: 0, tools: 0, history: 0, volatile: 0, total: 0, msgCount: messages.length, toolCount: tools.length };
    for (const m of messages) {
        const section = classifyMessage(m);
        const content = typeof (m && m.content) === 'string'
            ? m.content
            : (Array.isArray(m && m.content) ? m.content.map((p) => (p && (p.text || '')) || '').join(' ') : '');
        // 工具调用/图片这类结构化内容按 JSON 估（上限 20k 字符，防单条撑爆循环）
        const text = content || (m && m.tool_calls ? JSON.stringify(m.tool_calls).slice(0, 20000) : '');
        out[section] += estimateTokens(text);
    }
    if (tools.length) out.tools = estimateTokens(JSON.stringify(tools).slice(0, 200000));
    out.total = out.system + out.tools + out.history + out.volatile;
    return out;
}

/** 测量 + 落一条 telemetry（失败吞掉，绝不影响请求）。 */
function record(input) {
    let m;
    try { m = measure(input); } catch (e) { return null; }
    try {
        if (_emitTelemetry) {
            _emitTelemetry({
                cat: 'context',
                type: 'context.budget',
                title: '上下文预算',
                metrics: {
                    system_tokens: m.system,
                    tools_tokens: m.tools,
                    history_tokens: m.history,
                    volatile_tokens: m.volatile,
                    total_tokens: m.total,
                    msg_count: m.msgCount,
                    tool_count: m.toolCount,
                },
                source: 'main',
            });
        }
    } catch (e) { /* 遥测失败不影响对话 */ }
    return m;
}

/** 从 telemetry 读最近 N 轮的 section 峰值与 p50/p90（doctor 用）。 */
function recent(n) {
    const fs = require('fs');
    const path = require('path');
    const dir = process.env.PET_TELEMETRY_DIR
        ? path.resolve(process.env.PET_TELEMETRY_DIR)
        : path.join(__dirname, '..', '..', '.runtime');
    const file = path.join(dir, 'telemetry.jsonl');
    let lines = [];
    try {
        lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-4000)
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
    } catch (e) { return { n: 0, sections: {}, topGrowth: [] }; }
    const rows = lines.filter((l) => l.cat === 'context' && l.type === 'context.budget' && l.metrics).slice(-Math.max(1, Number(n) || 20));
    const pct = (arr, p) => {
        if (!arr.length) return null;
        const s = arr.slice().sort((a, b) => a - b);
        return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))];
    };
    const KEYS = ['system_tokens', 'tools_tokens', 'history_tokens', 'volatile_tokens', 'total_tokens'];
    const sections = {};
    for (const k of KEYS) {
        const arr = rows.map((r) => Number(r.metrics[k])).filter((x) => Number.isFinite(x));
        sections[k] = { p50: pct(arr, 50), p90: pct(arr, 90), max: arr.length ? Math.max(...arr) : null };
    }
    // 增长源：后半段均值 - 前半段均值（样本 ≥6 才有意义）
    const topGrowth = [];
    if (rows.length >= 6) {
        const half = Math.floor(rows.length / 2);
        for (const k of KEYS.slice(0, 4)) {
            const a = rows.slice(0, half).map((r) => Number(r.metrics[k])).filter(Number.isFinite);
            const b = rows.slice(half).map((r) => Number(r.metrics[k])).filter(Number.isFinite);
            if (!a.length || !b.length) continue;
            const avg = (arr) => arr.reduce((x, y) => x + y, 0) / arr.length;
            topGrowth.push({ key: k, delta: Math.round(avg(b) - avg(a)) });
        }
        topGrowth.sort((x, y) => y.delta - x.delta);
    }
    return { n: rows.length, sections, topGrowth: topGrowth.slice(0, 2) };
}

module.exports = { measure, record, recent, classifyMessage, estimateTokens, VOLATILE_HEADER };
