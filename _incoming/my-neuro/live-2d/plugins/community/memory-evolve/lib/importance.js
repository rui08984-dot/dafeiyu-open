// plugins/community/memory-evolve/lib/importance.js —— 重要性打分 + 累加触发器（纯函数）
//
// 依据（不是拍脑袋）：docs/调研-记忆v2-2026-11-20.md §2.1 / §3
//   · 每条新 event 给 1..10 分；idle / 寒暄直接 1（GA 的 "is idle" 短路，reflect.py:76-77）
//   · 分数累减，<=0 触发一次反思并重置（GA 的 importance_trigger_curr，perceive.py:178）
//   · GA 阈值 150、按 1..10 约 15–30 事件；我们的 60 是**产品校准值**，不是 GA 常量
//     （调研 §2.1 第 3 个坑：GA 没有日配额/时钟闸，别把我们的规则写成它的）
//
// 为什么纯函数、零 IO：
//   打分与触发器是反思链的地基，必须能被单测完整覆盖（见 _probe/test-memory-reflect.cjs）；
//   任何 require(json-store/records-path) 都会把「能不能测」绑到宿主目录上。
//
// 打分是启发式，不是真理：调研 §6.1 要求上线前用 50 条真实用户话做人工 1..10 标注，
// 算 Spearman ≥0.5 才算校准通过。这里只保证「idle=1、强情绪/承诺/身份/冲突明显更高」。
'use strict';

const DEFAULT_THRESHOLD = 60;   // 我们的校准值；GA 是 150（scratch.py:61），不要混用
const MIN_SCORE = 1;
const MAX_SCORE = 10;

// 只有寒暄/语气词：必须给 1 分，而不是因为「没命中规则」被当成 0 累加到触发器里。
const GREETING = /^(?:嗯|哦|啊|哈|好|行|在吗|你好|您好|晚安|早安|早上好|晚上好|谢谢|多谢|拜拜|再见|哈喽|嗨|hi|hello|ok|okay|收到|知道了)[。！？!.?~～ ]*$/i;

// GA 的 idle 事件不花 LLM；我们的世界/对话里对应「空文本」「meta.idle」「is idle」。
const IDLE_TEXT = /\bis\s+idle\b|^空闲[。！？!.?~～ ]*$/i;

// 每类规则最多贡献的分（防止一句话里同一个词刷爆分数）。
// emotion 用「命中词数」而不是「命中规则一次」：强情绪往往是一串词，不是单个标签。
const RULES = [
    {
        tag: 'emotion',
        re: /崩溃|哭|难受|开心|高兴|激动|生气|火大|委屈|害怕|焦虑|烦躁|烦死|累死|绝望|兴奋|难过|失眠|睡不着|压力大|心疼|痛苦|震惊|失望|孤独|想哭/g,
        weight: 2,
        perHit: 1.5,
        max: 7,
    },
    { tag: 'promise', re: /答应|承诺|说好|保证|一定会|一定要|发誓|约好|讲好|不会忘/g, weight: 3, perHit: 1, max: 5 },
    {
        tag: 'identity',
        re: /我叫|我是|我在[^，。？]{0,12}(?:工作|上班|读书|上学)|我住|我来自|今年[^，。？]{0,6}岁|我养了|我家[^，。？]{0,6}(?:猫|狗)/g,
        weight: 3,
        max: 4,
    },
    { tag: 'conflict', re: /吵架|吵了|冷战|闹翻|冲突|分手|绝交|骂了|翻脸|闹掰/g, weight: 3, max: 4 },
    { tag: 'new_fact', re: /第一次|新(?:工作|公司|家|房子|猫|狗|手机|电脑|室友)|换了|搬到|开始(?:学|做|用|练)|买了|刚(?:买|换|搬)/g, weight: 2, max: 3 },
    { tag: 'preference', re: /我(?:不|很|超|特别|最)?(?:喜欢|讨厌|爱吃|不吃|怕|受不了|习惯)|过敏/g, weight: 2, max: 3 },
    { tag: 'health', re: /住院|生病|发烧|吃药|体检|医院|看医生|受伤/g, weight: 2.5, max: 3 },
    { tag: 'plan', re: /我(?:打算|计划|准备|要|想|考虑)|下周|明天|后天|周末|月底|年底/g, weight: 1.5, max: 2 },
    { tag: 'relationship', re: /老婆|老公|女朋友|男朋友|妈|爸|儿子|女儿|同事|老板|室友|朋友|对象/g, weight: 1, max: 1 },
    { tag: 'timepoint', re: /生日|纪念日|截止|deadline|DDL/g, weight: 1.5, max: 2 },
    { tag: 'request', re: /记住|别忘了|你要记得|帮我记|提醒我/g, weight: 1.5, max: 2 },
];

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

function hitCount(re, text) {
    // 规则都是 g 正则；match 返回全部命中，不会受 lastIndex 残留影响（match 会重置）
    const m = String(text || '').match(re);
    return m ? m.length : 0;
}

/**
 * 给一条事件打 1..10 分。
 *
 * @param {string} text 事件文本（用户说的一句话 / 片段卡摘要）
 * @param {object} [meta] { idle?: boolean, role?: string, kind?: string }
 * @returns {{score: number, hits: string[]}} score 恒为 1..10 的整数
 */
function scoreEvent(text, meta) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const m = meta || {};

    // ① idle / 空文本：直接 1，不参与任何加权（GA reflect.py:76-77 的短路）
    if (m.idle === true || m.kind === 'idle' || !s || IDLE_TEXT.test(s)) {
        return { score: MIN_SCORE, hits: ['idle'] };
    }
    // ② 纯寒暄：1 分。寒暄也是「值得记住」的反面，但不该是 0（0 会让触发器永远不动）
    if (GREETING.test(s)) return { score: MIN_SCORE, hits: ['greeting'] };
    // ③ 太短且没有任何信息量：1 分（「好」「嗯嗯」的变体）
    if (s.length < 4) return { score: MIN_SCORE, hits: ['short'] };

    const hits = [];
    let sum = 0;
    for (const r of RULES) {
        const n = hitCount(r.re, s);
        if (!n) continue;
        hits.push(r.tag);
        // extra 受 max 封顶：单类最多贡献 r.max（emotion 例外，见 max 注释）
        const extra = r.perHit ? Math.min(r.perHit * n, Math.max(0, r.max - r.weight)) : 0;
        sum += r.weight + extra;
    }

    // ④ 多类信号叠加：一句话同时谈身份+承诺+情绪，比只命中一类更值得想。
    if (hits.length >= 3) sum += 1;

    const score = clamp(Math.round(MIN_SCORE + sum), MIN_SCORE, MAX_SCORE);
    return { score, hits };
}

/**
 * 重要性累加触发器。
 *   add(score) 累减；剩余 <=0 时返回 {fire:true} 并**立即重置**为 threshold。
 *   非法分数（NaN/Infinity/负数）按 0 处理，绝不把触发器打穿。
 *
 * @param {{threshold?: number}} [opts]
 */
function createTrigger(opts) {
    const o = opts || {};
    const raw = Number(o.threshold);
    const threshold = Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_THRESHOLD;

    let remain = threshold;

    return {
        threshold,
        /** @param {number} score @returns {{fire:boolean, remain:number, spent:number}} */
        add(score) {
            const n = Number(score);
            const v = Number.isFinite(n) ? clamp(n, 0, MAX_SCORE) : 0;
            remain -= v;
            if (remain <= 0) {
                remain = threshold;
                return { fire: true, remain, spent: v };
            }
            return { fire: false, remain, spent: v };
        },
        reset() { remain = threshold; },
        get remain() { return remain; },
    };
}

module.exports = {
    scoreEvent,
    createTrigger,
    DEFAULT_THRESHOLD,
    MIN_SCORE,
    MAX_SCORE,
    RULES,
};
