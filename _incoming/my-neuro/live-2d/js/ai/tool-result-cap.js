// js/ai/tool-result-cap.js —— 工具结果的体积上限（P0-2，2026-11-24；2026-11-25 风暴压测加固）
//
// 为什么需要：
//   telemetry 峰值 78,293 token / 30 条消息，其中 history 68,043 —— 不是聊久了攒的，
//   是**单轮工具循环**里一次会话塞进十几个工具回执涨出来的（日志载荷 274,207 字符 / 26 条）。
//   压缩插件只在 onLLMResponse（回复定稿后）跑，那一轮的 4 个请求早就发完了。
//
// 做法（两条闸，都在**写进 voiceChat.messages 之后、发下一个请求之前**执行）：
//   ① 单条上限 12,000 字符：超出留头 70% + 尾 30%，中间换成「已截断 N 字」标记。
//      单条截断是**确定性**的：同一条消息每次计算结果一样 → 前缀缓存不会因为截断本身漂移。
//   ② 单轮累计上限 32,000 字符：超了从**最旧**的工具回执开始换成省略标记，
//      永远不动最新一条（模型刚用完它做决策）。
//
// 2026-11-24 ADR-014 调整（8k/24k → 12k/32k）：
//   上限放宽不是回到「无脑塞历史」，而是配套**可续读** —— 大输出工具
//   （file / code / see / app / web_search）把全文落到 `data/tool-artifacts/`
//   并给 `artifactPath` + `next`，模型需要细节时按 offset 再取一页。
//
// 2026-11-25 风暴压测的两处根因修：
//   P1-2「stub 二次省略」：省略标记原来把「此条 N 字符已省略」写进文案，且累计闸遍历时
//     不跳过已经 stub 的消息 —— 于是每多一轮请求，最旧那条 stub 的数字就被重写成当前长度
//     （13000 → 70 → 70），既改了**已发出过的字节**（前缀缓存断裂），又把「stubbed」重复计数。
//     现在：标记是**固定文案**（不含动态数字）+ 遍历跳过 stub（幂等恢复）。
//   P1-3「截断空话」：标记原来写「完整结果见 tool-artifacts/」，可对不走分页的工具
//     （code-executor / 第三方插件 / MCP）根本没有 artifact 被写出来 —— 模型按标记续读是空。
//     现在：真截掉内容且原文没有续读指针时，**先落 artifact 再把真实路径写进标记**；
//     对 `{detail: "..."}` 这种 JSON 信封只截 detail 字段，其它字段（next/artifactPath/路径）
//     一个不动 —— 盲切 JSON 会让模型拿到无法解析的字符串，还会把续读指针切没。
//
// 纪律：
//   · 只动 role==='tool' 的 content（字符串）；截图在 user 消息的 image_url 里，不碰。
//   · 不删除消息、不改 tool_call_id/name —— 只换内容，保证 assistant.tool_calls 与 tool 成对。
//   · 幂等：已经截断/省略过的内容再跑一遍不会再变；同内容重复截断复用同一份 artifact。
'use strict';

const DEFAULTS = Object.freeze({
    perResultChars: 12000,
    perTurnChars: 32000,
});

// 省略标记：**固定文案**（不含动态数字）—— 保证「已 stub 的消息再被扫到」时字节不变。
const STUB_PREFIX = '[本轮工具输出累计超过上限，此条已省略';
const STUB_MARKER = STUB_PREFIX + '；需要细节请重新调用工具（用 offset/limit 分页）或读 artifact]';

// artifact 通道（可选依赖：加载失败只退化成「不落盘」，不影响截断本身）
let _artifact = null;
try { _artifact = require('./tool-result-artifact.js'); } catch (e) { _artifact = null; }

// 回执里已经自带续读指针的，不要再落一份重复全文（dispatch/file 已经写过一份）
const CONTINUATION_RE = /artifactPath|tool-artifacts|完整(?:结果|内容|原文)已落盘/;

function _positiveInt(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 合并调用方配置（缺省/非法值一律回默认）。 */
function resolveLimits(opts) {
    const o = opts || {};
    return {
        perResultChars: _positiveInt(o.perResultChars, DEFAULTS.perResultChars),
        perTurnChars: _positiveInt(o.perTurnChars, DEFAULTS.perTurnChars),
    };
}

function _textOf(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    if (Array.isArray(content)) return '';   // 多模态数组：不动（截图不在这条路径）
    try { return JSON.stringify(content); } catch (e) { return String(content); }
}

function _isStub(text) {
    return String(text == null ? '' : text).startsWith(STUB_PREFIX);
}

// ── 代理对安全（2026-11-25）：截断点落在 emoji 中间会留下半个字（lone surrogate）──
const _isHigh = (c) => c >= 0xD800 && c <= 0xDBFF;
const _isLow = (c) => c >= 0xDC00 && c <= 0xDFFF;

/** 取前 n 个 UTF-16 单元，但不切开代理对（必要时少取 1）。 */
function _headCut(text, n) {
    const k = Math.max(0, Math.min(text.length, Math.floor(n)));
    if (k <= 0) return '';
    if (k >= text.length) return text;
    if (_isHigh(text.charCodeAt(k - 1)) && _isLow(text.charCodeAt(k))) return text.slice(0, k - 1);
    return text.slice(0, k);
}

/** 取最后 n 个 UTF-16 单元，但不切开代理对（必要时少取 1）。 */
function _tailCut(text, n) {
    const k = Math.max(0, Math.min(text.length, Math.floor(n)));
    if (k <= 0) return '';
    if (k >= text.length) return text;
    let start = text.length - k;
    if (_isLow(text.charCodeAt(start)) && _isHigh(text.charCodeAt(start - 1))) start += 1;
    return text.slice(start);
}

/** 截断标记（可带真实 artifact 路径）。 */
function _truncMarker(dropped, limit, artifactPath) {
    return '\n…[工具输出过长，已截断 ' + dropped + ' 字符（上限 ' + limit + '）；完整结果见 runtime.log'
        + (artifactPath ? '' : ' 或工具 artifact（tool-artifacts/）')
        + '，可用 offset/limit 或 next 续读'
        + (artifactPath ? '；完整原文已落盘：' + artifactPath + '（用 file read + offset 分段读）' : '')
        + ']…\n';
}

/** 极限小上限（房间放不下完整标记）时的最简标记。 */
function _miniMarker(dropped) {
    return '\n…[已截断 ' + dropped + ' 字]…\n';
}

/**
 * 单条截断（纯函数：不写盘；artifact 路径由调用方先落好再传进来）。
 * 对 `{... "detail": "很长" ...}` 这种 JSON 信封：只截 detail 字段，其余字段一字不动。
 * @returns {{text:string, capped:boolean, dropped:number, envelope?:boolean}}
 */
function capText(content, limit, opts) {
    const text = _textOf(content);
    const max = _positiveInt(limit, DEFAULTS.perResultChars);
    const artifactPath = String((opts && opts.artifactPath) || '');
    if (!text || text.length <= max) return { text, capped: false, dropped: 0 };
    if (_isStub(text)) return { text, capped: false, dropped: 0 };

    // ① JSON 信封：只截 detail，保住 next/artifactPath/其它字段
    const env = _capJsonEnvelope(text, max, artifactPath);
    if (env) return env;

    // ② 纯文本：头 70% + 标记 + 尾 30%，总长压到 <=max（下一轮不再触发，保证幂等）
    const rough = _truncMarker(Math.max(0, text.length - max), max, artifactPath);
    let room = max - rough.length;
    if (room < 100) {
        const mini = _miniMarker(Math.max(0, text.length - max));
        room = max - mini.length;
        if (room < 8) return { text: text.slice(0, max), capped: true, dropped: text.length - max };
        const droppedMini = text.length - room;
        const markerMini = _miniMarker(droppedMini);
        room = max - markerMini.length;
        const headM = Math.ceil(room * 0.7);
        const tailM = room - headM;
        let outM = _headCut(text, headM) + markerMini + _tailCut(text, tailM);
        if (outM.length > max) outM = outM.slice(0, max);
        return { text: outM, capped: true, dropped: droppedMini };
    }
    const head = Math.floor(room * 0.7);
    const tail = room - head;
    const dropped = text.length - room;
    const marker = _truncMarker(dropped, max, artifactPath);
    let out = _headCut(text, head) + marker + _tailCut(text, tail);
    if (out.length > max) out = _headCut(out, max);   // 保险：绝不超过上限（且不切半个字）
    return { text: out, capped: true, dropped };
}

/**
 * JSON 信封内的 detail-only 截断。
 * 只对「对象 + detail 是超长字符串」生效；其它形态返回 null（走纯文本路径）。
 * 目标：结果仍可 JSON.parse、next/artifactPath 等字段完整、总长 <= max 且确定性。
 */
function _capJsonEnvelope(text, max, artifactPath) {
    const s = text.trim();
    if (s[0] !== '{') return null;
    let obj = null;
    try { obj = JSON.parse(s); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (typeof obj.detail !== 'string' || obj.detail.length < 200) return null;
    const baseLen = JSON.stringify(obj).length - obj.detail.length;
    // 给 detail 的预算：总预算 - 非 detail 部分 - 标记长度（留 64 字余量防转义膨胀）
    const roughMarker = _truncMarker(Math.max(1, obj.detail.length), max, artifactPath);
    let budget = max - baseLen - roughMarker.length - 64;
    if (budget < 256) return null;   // 信封本身就快撑满上限：交给纯文本路径
    const dropped = obj.detail.length - budget;
    if (dropped <= 0) return null;
    const marker = _truncMarker(dropped, max, artifactPath);
    const room = Math.max(64, max - baseLen - marker.length);
    const head = Math.floor(room * 0.7);
    const tail = room - head;
    obj.detail = _headCut(obj.detail, head) + marker + _tailCut(obj.detail, tail);
    let out = JSON.stringify(obj);
    // 转义会让实际长度略超：按超出量再收一次 detail（迭代 3 次内必然收敛）
    for (let i = 0; i < 3 && out.length > max; i += 1) {
        const over = out.length - max;
        obj.detail = obj.detail.slice(0, Math.max(64, obj.detail.length - over - 16));
        // 收敛前要保留标记：重新拼一次（标记 = 头尾之间的那句）
        const mid = obj.detail.indexOf('\n…[工具输出过长');
        if (mid > 0) {
            const headPart = obj.detail.slice(0, mid);
            const tailPart = obj.detail.slice(obj.detail.lastIndexOf(']…\n') + 3);
            obj.detail = headPart.slice(0, Math.max(32, headPart.length - over - 16)) + marker + tailPart;
        }
        out = JSON.stringify(obj);
    }
    if (out.length > max) return null;   // 实在塞不下：退回纯文本截断（仍然可读，只是不再是合法 JSON）
    return { text: out, capped: true, dropped, envelope: true };
}

/**
 * 对一组消息执行两条闸（会原地修改 messages 里的 tool 消息内容）。
 *
 * @param {Array} messages voiceChat.messages（同一份宿主数组；调用方在发请求前执行）
 * @param {number} turnStartIndex 本轮第一条 user 消息在数组里的下标；非法/未知时跳过累计闸
 * @param {{perResultChars?:number, perTurnChars?:number}} [opts]
 * @returns {{capped:number, stubbed:number, droppedChars:number, turnChars:number, artifacts:number}}
 */
function enforceToolBudget(messages, turnStartIndex, opts) {
    const limits = resolveLimits(opts);
    const out = { capped: 0, stubbed: 0, droppedChars: 0, turnChars: 0, artifacts: 0 };
    if (!Array.isArray(messages) || !messages.length) return out;

    // ① 单条上限：对所有 tool 消息（含历史加载进来的旧回执）。
    //    历史消息只做这一次确定性截断；之后内容不变，缓存前缀稳定。
    for (const m of messages) {
        if (!m || m.role !== 'tool') continue;
        const orig = _textOf(m.content);
        if (!orig || _isStub(orig)) continue;             // 已省略的不再动（P1-2 幂等恢复）
        let r = capText(orig, limits.perResultChars);
        if (!r.capped) continue;
        // P1-3：真丢内容且原文没有续读指针 → 先把全文落 artifact，再把**真实路径**写进标记
        let artPath = '';
        if (!CONTINUATION_RE.test(orig) && _artifact && typeof _artifact.writeArtifact === 'function') {
            try {
                const art = _artifact.writeArtifact(String(m.name || 'tool'), orig, {});
                if (art && art.path) { artPath = art.path; out.artifacts += 1; }
            } catch (e) { /* 落盘失败只影响「能不能续读」，不影响截断 */ }
        }
        if (artPath) r = capText(orig, limits.perResultChars, { artifactPath: artPath });
        m.content = r.text;
        out.capped += 1;
        out.droppedChars += r.dropped;
    }

    // ② 单轮累计上限：只统计本轮（turnStartIndex 之后）的工具回执。
    const start = Number.isInteger(turnStartIndex) && turnStartIndex >= 0 && turnStartIndex < messages.length
        ? turnStartIndex : -1;
    if (start < 0) return out;

    const idxs = [];          // 可省略候选（已经 stub 的不算）
    let total = 0;
    for (let i = start; i < messages.length; i += 1) {
        const m = messages[i];
        if (!m || m.role !== 'tool') continue;
        const text = _textOf(m.content);
        if (!text) continue;
        total += text.length;
        if (!_isStub(text)) idxs.push(i);
    }
    out.turnChars = total;
    if (total <= limits.perTurnChars || idxs.length <= 1) return out;

    // 从最旧开始省略；保留最新一条（模型刚用它做决策）。
    for (let k = 0; k < idxs.length - 1 && total > limits.perTurnChars; k += 1) {
        const i = idxs[k];
        const len = _textOf(messages[i].content).length;
        if (len <= 0) continue;
        messages[i].content = STUB_MARKER;
        total -= len;
        total += STUB_MARKER.length;
        out.stubbed += 1;
        out.droppedChars += len;
    }
    out.turnChars = total;
    return out;
}

module.exports = {
    DEFAULTS,
    STUB_MARKER,
    resolveLimits,
    capText,
    enforceToolBudget,
    _isStub,
};
