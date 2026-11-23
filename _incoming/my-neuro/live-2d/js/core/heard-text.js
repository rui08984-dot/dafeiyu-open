// js/core/heard-text.js —— 被打断时「到底播出去了多少」（2026-11-22）
//
// 问题：`tts-processor.llmFullResponse` 是**生成**的全文。被打断后历史里仍写全文，
// 于是她「记得」自己说过用户根本没听到的内容，下一轮还可能引用它。
// 参考 Open-LLM-VTuber 的 heard_response：历史只保留真正播出去的前缀。
//
// 本模块只做纯计算：不碰 TTS、不碰历史、不读全局。判定原则是
// **宁可不知道（返回 null），也不能猜错**——对不上就返回 null，调用方保持原样：
//   · 未播剩余（当前段剩余 + 队列里还没播的段）必须逐字是生成全文的后缀；
//   · 顺序错、文本被改写、分段时空白被吞，都会对不上 → null；
//   · null ≠ 没播：null 表示「不知道播到哪」，一个字没播才是 ''。
'use strict';

/**
 * 把「未播剩余」的一段归一成字符串；无法理解的对象返回 null（= 不知道，调用方必须放弃截断）。
 * 兼容 tts-playback-engine.getUnplayedCurrentText() 的形状：{ text, playedChars, totalChars, remainder }。
 * @param {*} value
 * @returns {string|null}
 */
function unplayedToText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if (typeof value.remainder === 'string') return value.remainder;   // 播放器已经算好的剩余
        if (typeof value.text === 'string') {                              // 只给了整段：按 playedChars 截
            const played = Math.max(0, Math.min(value.text.length, Math.floor(Number(value.playedChars) || 0)));
            return value.text.slice(played);
        }
        return null;                                                       // 看不懂的对象：不知道
    }
    return String(value);
}

/**
 * 计算「真正播出去的前缀」。
 *
 * @param {string} fullText 本轮生成的全文（tts-processor.llmFullResponse）
 * @param {{unplayedCurrent?: *, queuedTexts?: Array<*>}} [opts]
 *        unplayedCurrent —— 当前段还没播的剩余（字符串或播放器的 {remainder} 对象）
 *        queuedTexts     —— 其后还没播的段（顺序与实际播放顺序一致）
 * @returns {string|null} 可信前缀（可能为 ''）；null = 不知道，调用方不得截断
 */
function computeHeardPrefix(fullText, opts) {
    const full = fullText == null ? '' : String(fullText);
    if (!full) return null;                        // 空全文：未知，不是「全播完」

    const o = opts || {};

    const current = unplayedToText(o.unplayedCurrent);
    if (current === null) return null;             // 当前段读不懂 → 不知道

    let pending = current;
    const queued = o.queuedTexts == null ? [] : (Array.isArray(o.queuedTexts) ? o.queuedTexts : [o.queuedTexts]);
    for (let i = 0; i < queued.length; i += 1) {
        const t = unplayedToText(queued[i]);
        if (t === null) return null;               // 有一段读不懂 → 不知道
        pending += t;
    }

    // 没有未播剩余：视为整段都播过（包括「本来就没排队」的情况）
    if (!pending) return full;

    // 唯一可信的判据：剩余必须逐字是全文的后缀。
    // 不是后缀（顺序错/被改写/空白被吞）→ 不知道。
    if (!full.endsWith(pending)) return null;

    const prefix = full.slice(0, full.length - pending.length).replace(/\s+$/, '');
    return prefix;                                 // 全被截掉时是 ''（一个字都没播）
}

/**
 * 给调用方统一的「被打断文本」形状。只标状态，不加省略号（怎么展示由调用方决定）。
 * @param {string} text
 * @returns {{text: string, interrupted: true}}
 */
function markInterrupted(text) {
    return { text: String(text == null ? '' : text), interrupted: true };
}

module.exports = { computeHeardPrefix, markInterrupted };
