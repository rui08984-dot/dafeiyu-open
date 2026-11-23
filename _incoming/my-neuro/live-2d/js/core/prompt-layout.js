// prompt-layout.js — prompt 前缀缓存的布局纪律（2026-11-16 六十二轮）
//
// 为什么要有这个文件（实测，不是推测）：
//   上游是**按字节前缀**复用缓存的。system 是消息数组第一条 → 它里面任何
//   每轮变化的字节，都会让它**后面**的整段历史重新计费。
//   _probe/cache-probe.cjs 实测：system 不动时命中 97.4%，system 结尾追加一行 → 83.8%；
//   system 开头改一个字节 → 命中归零。
//
// 所以纪律只有一条：
//   **稳定的东西留 system（身份/规则/核心记忆/画像），每轮易变的东西
//     统一拼到最后一条 user 消息的末尾。**
//
// 谁该算易变（本文件不管判定，只负责摆放）：
//   memory-recall 的召回片段 / memos 的记忆摘要 / watch-screen 的屏幕描述 /
//   dynamic-persona 的「此刻状态；N 分钟前」/ alive-state 的身体数值 / inner-state 的当下状态。
//   稳定的反例：核心记忆、用户画像、人格 slow 层、游戏规则、直播人格设定。
//
// 语义风险：塞进 user 消息会被模型当成「用户说的话」。
//   缓解 = 统一前缀「（系统补充，不必回应）」，只做背景信息，不下指令。

'use strict';

// 放在 user 消息末尾的声明，防止模型把注入当成用户的话去回应
const VOLATILE_HEADER = '（系统补充，不必回应）';

// 一次最多拼多少字：防止某轮召回把 20 条旧事全塞进 user（历史里会永久留着）
const MAX_VOLATILE_CHARS = 4000;

/**
 * 把若干段易变文本拼到最后一条 user 消息末尾（不改动 system）。
 * @param {Array<{role:string, content:any}>} messages
 * @param {string[]} texts
 * @returns {{ok:boolean, count:number, target:number, chars:number, reason?:string}}
 */
function appendVolatile(messages, texts) {
    const list = (texts || [])
        .map((t) => String(t == null ? '' : t).trim())
        .filter(Boolean);
    if (!list.length) return { ok: false, count: 0, target: -1, chars: 0, reason: 'empty' };
    if (!Array.isArray(messages) || !messages.length) {
        return { ok: false, count: 0, target: -1, chars: 0, reason: 'no-messages' };
    }

    // 去重：同一段文本可能同时从「补丁表」和「hook addVolatile」两条路进来
    const uniq = [];
    const seen = new Set();
    for (const t of list) {
        if (seen.has(t)) continue;
        seen.add(t);
        uniq.push(t);
    }

    let body = uniq.join('\n\n');
    let truncated = false;
    if (body.length > MAX_VOLATILE_CHARS) {
        body = body.slice(0, MAX_VOLATILE_CHARS);
        truncated = true;
    }
    const block = '\n\n' + VOLATILE_HEADER + '\n' + body + (truncated ? '\n（补充内容过长，已截断）' : '');

    // 找最后一条 user；一条都没有就补一条（工具循环里可能出现全 tool 结尾）
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i] && messages[i].role === 'user') { idx = i; break; }
    }
    if (idx === -1) {
        messages.push({ role: 'user', content: block.trim() });
        return { ok: true, count: uniq.length, target: messages.length - 1, chars: block.length, reason: 'pushed' };
    }

    const m = messages[idx];
    if (Array.isArray(m.content)) {
        // 多模态：追加一个 text part。**必须追加在最后**，图片在前文字在后不影响理解，
        // 但如果把图片插到中间，某些上游会对 part 顺序挑刺。
        m.content.push({ type: 'text', text: block });
    } else {
        m.content = String(m.content == null ? '' : m.content) + block;
    }
    return { ok: true, count: uniq.length, target: idx, chars: block.length, truncated };
}

/**
 * 取 system 消息的文本（兼容 content 是数组的形态）。
 * @param {Array} messages
 * @returns {string}
 */
function systemText(messages) {
    if (!Array.isArray(messages)) return '';
    for (const m of messages) {
        if (m && m.role === 'system') {
            if (Array.isArray(m.content)) {
                return m.content.map((p) => (p && p.type === 'text' ? p.text : '')).join('');
            }
            return String(m.content == null ? '' : m.content);
        }
    }
    return '';
}

/**
 * system 指纹：用来判断「这一轮 system 字节有没有变」。
 * 变了就等于宣告「历史那段的缓存全废」——所以它必须是可观测的数字，不能靠猜。
 * FNV-1a 32 位（不需要密码学强度，只要稳定且区分度够）。
 * @param {string} text
 * @returns {string} 8 位十六进制
 */
function hashText(text) {
    let h = 0x811c9dc5;
    const s = String(text == null ? '' : text);
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
}

/**
 * 从上游 usage 里取「命中缓存」的数字。
 * 不同家字段名不一样，全都试一遍；没有就返回 null（**不要**把未知当 0）。
 * @param {object} usage
 * @returns {{prompt:number|null, cached:number|null, rate:number|null, fields:string[]}}
 */
function cacheRate(usage) {
    if (!usage || typeof usage !== 'object') return { prompt: null, cached: null, rate: null, fields: [] };
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? NaN);
    const details = usage.prompt_tokens_details || usage.input_tokens_details || {};
    const cand = [
        details.cached_tokens,
        usage.prompt_cache_hit_tokens,
        usage.cached_tokens,
        usage.cache_read_input_tokens,
    ].find((v) => v != null && Number.isFinite(Number(v)));
    const cached = cand == null ? null : Number(cand);
    const p = Number.isFinite(prompt) ? prompt : null;
    return {
        prompt: p,
        cached,
        rate: (p != null && cached != null && p > 0) ? +(cached / p * 100).toFixed(1) : null,
        fields: Object.keys(usage),
    };
}

module.exports = { VOLATILE_HEADER, MAX_VOLATILE_CHARS, appendVolatile, systemText, hashText, cacheRate };
