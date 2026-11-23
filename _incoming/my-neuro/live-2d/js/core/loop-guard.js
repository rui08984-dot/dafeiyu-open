// loop-guard.js —— 复读护栏（2026-11-15 六十三轮，来自 Neuro-sama 失败模式调研）
//
// 现象（有出处）：Neuro-sama 会出现「同一句反复说」「触发词污染后无限复读」。
// 换成我们的场景：她连着几轮用几乎一样的话回应，会显得像坏掉的复读机。
//
// 这里只做**判定**，不做重写（重写要再花一次 LLM 调用，且可能越改越糟）。
// 判定为复读时，由 llm-handler 在下一轮的易变尾巴里加一句「换个说法」——
// 走 volatile 通道，不碰 system，不伤前缀缓存。
'use strict';

/** 去掉标点/空白/表情符号，只留内容字符 */
function normalizeText(text) {
    return String(text == null ? '' : text)
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。！？、；：""''（）【】《》…—～·,.!?;:'"()\[\]{}<>~\-_/\\|@#$%^&*+=`]/g, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .trim();
}

/** 字符二元组集合 */
function bigrams(s) {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    if (!out.size && s.length === 1) out.add(s);
    return out;
}

/** 二元组 Jaccard 相似度（0..1）。短句也稳定，不需要分词。 */
function similarity(a, b) {
    const x = normalizeText(a);
    const y = normalizeText(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    const A = bigrams(x);
    const B = bigrams(y);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter += 1;
    return inter / (A.size + B.size - inter);
}

/**
 * 这段话算不算复读。
 * @param {string} text 本轮回复
 * @param {string[]} previous 最近几轮回复（近→远都行）
 * @param {{threshold?:number, minChars?:number}} [opts]
 *   threshold 默认 0.9；minChars 默认 8（太短的「嗯」「好」不算复读）
 * @returns {{loop:boolean, score:number, matched:string|null}}
 */
function detectLoop(text, previous, opts) {
    const o = opts || {};
    // 0.85：实测「今天真是够折腾的」vs「今天真是够折腾的呀」= 0.88，
    // 这种只加语气词的重说必须算复读；而正常换话题的句子通常 <0.3，不会误报。
    const threshold = Number(o.threshold) > 0 ? Number(o.threshold) : 0.85;
    const minChars = Number(o.minChars) > 0 ? Number(o.minChars) : 8;
    const cur = normalizeText(text);
    if (cur.length < minChars) return { loop: false, score: 0, matched: null };
    let best = 0;
    let matched = null;
    for (const prev of previous || []) {
        const score = similarity(cur, prev);
        if (score > best) { best = score; matched = String(prev || ''); }
    }
    return { loop: best >= threshold, score: +best.toFixed(2), matched };
}

module.exports = { normalizeText, similarity, detectLoop };
