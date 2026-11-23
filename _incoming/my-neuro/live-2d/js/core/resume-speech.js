/**
 * js/core/resume-speech.js —— 打断后「接着说」（D4，2026-11-22）
 *
 * 需求（研讨会 D4）：
 *   · 用户打断她时，把**还没播出去的剩余段**存起来；
 *   · 只有用户**显式**说「接着说／继续刚才／接着说下去」时才取出来重播；
 *   · TTL = 1 轮：过了下一轮还没人取，就丢掉，绝不自动续讲。
 *
 * 为什么单独一个纯模块：
 *   ① 「哪些算未播」和「什么算显式请求」是纯数据/文本判断，可以在 node 里直接单测，
 *      不需要 Electron / 音频 / 播放在跑；
 *   ② 自动续讲是这条链最危险的失败模式（用户明确要求「不自动续讲」）。把唯一入口
 *      收口成 `tryHandleExplicit()`，测试可以断言：非显式文本**永远不会**触发 `take()`。
 *
 * 边界（刻意的）：
 *   · 本模块只保存**文本**，不保存音频 buffer（音频句柄/URL 在打断后已失效）。
 *   · 不写盘：TTL 只有 1 轮，跨进程重启续讲没有意义，落盘反而会把旧句子带回来。
 *   · 不碰 system prompt。`asPromptData()` 只是给「将来真要进提示词」留的安全出口，
 *     走 untrusted-data 的前缀 + JSON 封装；TTS 重播路径**不用**它。
 *
 * 用法：
 *   const resumeSpeech = require('./resume-speech.js');
 *   // 打断时（ttsProcessor.interrupt 里）：
 *   resumeSpeech.captureFromProcessor({ audioDataQueue, textSegmentQueue, current });
 *   // 每轮用户输入开头（llm-handler submitTurn）：
 *   resumeSpeech.beginTurn();
 *   const r = resumeSpeech.tryHandleExplicit(text, ttsProcessor);
 *   if (r && r.handled) return r.text;   // 已重播，不走 LLM
 *   return turnGate.submit(prompt);
 */

'use strict';

const MAX_SEGMENTS = 60;        // 一次续讲最多保留多少段（防止异常长的队列占内存）
const MAX_TOTAL_CHARS = 8000;   // 总字数上限（约 6–10 分钟语音，远超正常一轮回复）
const MAX_REQUEST_CHARS = 32;   // 显式请求文本上限：超过这个长度就不当「纯请求」看

/** 去掉 HTML/尖括号标签与所有空白标点，用于意图匹配（保留中文与字母数字）。 */
function normalizeForMatch(value) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, '')
        .replace(/＜[^＞]*＞/g, '')
        .replace(/[\s，。！？!?~～、,.;；:：…—\-_"'“”‘’（）()【】\[\]]/g, '')
        .toLowerCase();
}

/**
 * 显式续讲请求的判定（锚定整句，宁可漏判也不误判）。
 *
 * 为什么不用「文本里出现接着说」：
 *   「他接着说了一个故事」「继续刚才那个任务」都包含关键词，但它们不是让**她**续讲。
 *   所以这里要求：去掉礼貌前缀后，整句几乎只剩「续讲」这个指令；长度也设上限。
 * 否定词优先： 「别接着说」不算请求。
 */
const RESUME_PATTERNS = [
    // 接着说 / 继续说 / 接着说下去 / 你接着讲吧 …
    /^(?:好|嗯|行|那|你|请|快|赶紧|现在|可以|就|来|对|是的)*?(?:接着|继续)(?:说|讲|聊|念|读)(?:下去|吧|啊|呀|嘛|哦|呗)?$/,
    // 继续刚才 / 继续刚才说的 / 继续刚才的内容 / 接着之前那段讲下去 …
    /^(?:好|嗯|行|那|你|请|就|对)*?(?:继续|接着)(?:刚才|之前|前面|刚刚)(?:的)?(?:说的|讲的|内容|话|那段|那句)?(?:说|讲)?(?:下去|吧|啊|呀|嘛)?$/,
    // 说下去 / 好，说下去吧
    /^(?:好|嗯|行|那|你|请|就|对)*?说下去(?:吧|啊|呀|嘛)?$/,
    // 把刚才没说完的说完 / 将刚才没讲完的话讲下去
    /^(?:把|将)?刚才(?:没|没有)(?:说完|讲完|说完的|讲完的)?(?:话|内容)?(?:说|讲)(?:完|下去)(?:吧|啊)?$/,
    // 接着刚才那段说完 / 继续刚才那句
    /^(?:好|嗯|行|那|你|请|就|对)?(?:接着|继续)(?:刚才|之前|前面|刚刚)?(?:的)?(?:那段|那句|话)?(?:说|讲)(?:完|下去)(?:吧|啊)?$/,
];

/** 否定/反向意图：命中就绝不续讲。 */
const NEGATIVE_RE = /(?:别|不要|不用|先别|不用了|停下?|算了|闭嘴)[^，。]{0,4}(?:接着|继续|说下去)/;

/**
 * 这句话是不是「显式要求继续刚才没说完的内容」？
 * @param {string} text 用户文本（ASR/键入）
 * @returns {boolean}
 */
function isExplicitResumeRequest(text) {
    const s = normalizeForMatch(text);
    if (!s || s.length > MAX_REQUEST_CHARS) return false;
    if (NEGATIVE_RE.test(s)) return false;
    return RESUME_PATTERNS.some((re) => re.test(s));
}

/** 段文本归一：转字符串、统一换行、trim。不剥情绪标签 —— 重播要保留原来的语气。 */
function normalizeText(value) {
    return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

/**
 * 段列表归一：接受字符串 / {text} / {segment} / {text:...} 的音频包。
 * 去空、限条数、限总字数（超出部分丢掉，绝不截出半个 JSON 之类的问题——这里只是文本）。
 */
function normalizeSegments(list) {
    const out = [];
    let total = 0;
    const arr = Array.isArray(list) ? list : [];
    for (const item of arr) {
        if (out.length >= MAX_SEGMENTS) break;
        if (total >= MAX_TOTAL_CHARS) break;
        let t = '';
        if (typeof item === 'string') t = item;
        else if (item && typeof item === 'object') t = item.text != null ? item.text : (item.segment != null ? item.segment : '');
        t = normalizeText(t);
        if (!t) continue;
        let room = MAX_TOTAL_CHARS - total;
        if (room <= 0) break;
        if (t.length > room) t = t.slice(0, room);
        total += t.length;
        out.push(t);
    }
    return out;
}

/** 当前段「未播尾巴」归一：字符串或 {text, playedChars}。 */
function normalizePartial(value) {
    let text = '';
    if (typeof value === 'string') {
        text = value;
    } else if (value && typeof value === 'object' && value.text != null) {
        const full = normalizeText(value.text);
        const played = Math.max(0, Math.min(full.length, Math.floor(Number(value.playedChars) || 0)));
        text = full.slice(played);
    }
    text = normalizeText(text);
    if (text.length > MAX_TOTAL_CHARS) text = text.slice(0, MAX_TOTAL_CHARS);
    return text;
}

/** 把待播内容拼成一条 TTS 文本：未播尾巴在前，然后是队列里的剩余段。 */
function joinForPlayback(pkg) {
    const p = pkg || {};
    const parts = [];
    const partial = normalizeText(p.partial);
    if (partial) parts.push(partial);
    for (const s of normalizeSegments(p.segments)) parts.push(s);
    return parts.join(' ');
}

/**
 * 从播放器现场收集「未播」内容（纯函数，单测直接调）。
 *
 * 顺序：当前段尾巴 → 已合成未播（audioDataQueue）→ 还没合成（textSegmentQueue）。
 * 为什么当前段 playedChars=0 时算「整段未播」而不是尾巴：
 *   这一段刚取出来还没动，整段都该留给用户；否则续讲会从第一个字开始重复。
 *
 * @param {object} o
 * @param {Array} [o.audioDataQueue]  [{text}] 已合成、还没播
 * @param {Array} [o.textSegmentQueue] [string] 还没合成
 * @param {{text?:string, playedChars?:number, totalChars?:number}|null} [o.current] 正在播的段
 * @returns {{segments:string[], partial:string}}
 */
function collectUnplayedFromQueues(o) {
    const opts = o || {};
    const audio = normalizeSegments((Array.isArray(opts.audioDataQueue) ? opts.audioDataQueue : [])
        .map((p) => (p && typeof p === 'object' ? p.text : p)));
    const pending = normalizeSegments(opts.textSegmentQueue);
    const segments = audio.concat(pending);

    let partial = '';
    const cur = opts.current;
    if (cur && typeof cur === 'object' && cur.text != null) {
        const full = normalizeText(cur.text);
        const played = Math.max(0, Math.min(full.length, Math.floor(Number(cur.playedChars) || 0)));
        if (full) {
            if (played <= 0) segments.unshift(full);
            else partial = full.slice(played);
        }
    }
    return { segments, partial: normalizePartial(partial) };
}

/**
 * 建一个续讲实例（单测/多实例隔离用）。
 *
 * opts:
 *   enabled   默认 true（关闭后 capture/take/tryHandleExplicit 全部 no-op）
 *   ttlTurns  默认 1（保留几轮；0 = 本轮结束/下一轮开始即失效）
 *   now       注入时钟（单测用）
 */
function createResumeSpeech(opts) {
    const o = opts || {};
    const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
    let enabled = o.enabled !== false;
    let ttlTurns = Number.isFinite(Number(o.ttlTurns)) && Number(o.ttlTurns) >= 0
        ? Math.floor(Number(o.ttlTurns))
        : 1;

    /** @type {null|{segments:string[], partial:string, capturedAt:number, atTurn:number, reason:string, playedIndex:number}} */
    let pending = null;
    let turnsStarted = 0;
    const counters = {
        captures: 0, taken: 0, expired: 0, droppedSegments: 0,
        handledWhilePlaying: 0, noCapture: 0, sentToTts: 0,
    };
    let lastCaptureAt = 0;
    let lastTakenAt = 0;
    let lastExpiredAt = 0;

    function pendingSummary() {
        if (!pending) return null;
        const chars = (pending.partial ? pending.partial.length : 0)
            + pending.segments.reduce((n, s) => n + String(s).length, 0);
        return {
            segments: pending.segments.length,
            chars,
            capturedAt: pending.capturedAt,
            atTurn: pending.atTurn,
            turnsAgo: Math.max(0, turnsStarted - pending.atTurn),
            reason: pending.reason,
            hasPartial: !!pending.partial,
        };
    }

    function stats() {
        return {
            enabled,
            ttlTurns,
            turnsStarted,
            captures: counters.captures,
            taken: counters.taken,
            expired: counters.expired,
            droppedSegments: counters.droppedSegments,
            handledWhilePlaying: counters.handledWhilePlaying,
            noCapture: counters.noCapture,
            sentToTts: counters.sentToTts,
            lastCaptureAt,
            lastTakenAt,
            lastExpiredAt,
            pending: pendingSummary(),
        };
    }

    /** 观测快照：只放计数与长度，不把未播文本泄进全局。 */
    function publish() {
        try { globalThis.__resumeSpeechStats = stats(); } catch (e) { /* 观测失败不影响语音 */ }
    }

    /**
     * 保存未播剩余段。没有可存的内容时**不覆盖**已有捕获。
     * @returns {object|null} 保存后的只读摘要
     */
    function capture(input) {
        const src = input || {};
        if (!enabled) return null;

        const list = normalizeSegments(src.segments);
        let playedIndex = -1;
        if (src.playedIndex !== undefined && src.playedIndex !== null) {
            const n = Math.floor(Number(src.playedIndex));
            if (Number.isFinite(n) && n >= -1) playedIndex = n;
        }
        const rest = playedIndex >= -1 ? list.slice(playedIndex + 1) : list.slice();
        const partial = normalizePartial(src.partial);

        if (!rest.length && !partial) return null;

        pending = {
            segments: rest,
            partial,
            capturedAt: nowFn(),
            atTurn: turnsStarted,
            reason: String(src.reason || 'interrupt').slice(0, 40),
            playedIndex,
        };
        counters.captures += 1;
        lastCaptureAt = pending.capturedAt;
        publish();
        return pendingSummary();
    }

    /** 从 TTS 处理器现场捕获（tts-processor.interrupt 的唯一入口）。 */
    function captureFromProcessor(input) {
        if (!enabled) return null;
        const unplayed = collectUnplayedFromQueues(input || {});
        if (!unplayed.segments.length && !unplayed.partial) return null;
        return capture({
            segments: unplayed.segments,
            partial: unplayed.partial,
            reason: (input && input.reason) || 'interrupt',
            playedIndex: -1,
        });
    }

    /**
     * 一轮用户输入开始。TTL 在这里结算：超过 ttlTurns 轮没人取就丢掉。
     * 注意：**只清过期，不取走**——自动路径绝不消费待续内容。
     */
    function beginTurn() {
        turnsStarted += 1;
        if (pending && turnsStarted - pending.atTurn > ttlTurns) {
            counters.expired += 1;
            counters.droppedSegments += pending.segments.length + (pending.partial ? 1 : 0);
            pending = null;
            lastExpiredAt = nowFn();
        }
        publish();
        return {
            turnsStarted,
            ttlTurns,
            valid: !!pending,
            turnsAgo: pending ? Math.max(0, turnsStarted - pending.atTurn) : 0,
        };
    }

    /**
     * 取走待续内容并清空。**只允许在用户显式请求的路径里调用**；
     * 任何自动路径（主动搭话/定时/插件）都不许调。
     * @returns {null|{segments:string[], partial:string, text:string, turnsAgo:number, capturedAt:number, reason:string}}
     */
    function take() {
        if (!enabled || !pending) return null;
        const p = pending;
        pending = null;
        counters.taken += 1;
        lastTakenAt = nowFn();
        publish();
        return {
            segments: p.segments.slice(),
            partial: p.partial,
            text: joinForPlayback(p),
            turnsAgo: Math.max(0, turnsStarted - p.atTurn),
            capturedAt: p.capturedAt,
            reason: p.reason,
        };
    }

    /** 读摘要但不取走（诊断/测试用）。 */
    function peek() {
        return pendingSummary();
    }

    /**
     * 「接着说」的唯一执行入口。返回 null = 不是显式请求 / 没东西可续 / 功能关闭，
     * 调用方应继续正常流程；返回 {handled:true,...} = 本句已被处理，绝不再进 LLM。
     *
     * 关键约束（验收项）：只有 isExplicitResumeRequest(text) 为真时才会走到 take()。
     * 她正在说话时（tts.isPlaying()）不做任何打断/重播 —— 那句话的语义就是「你继续」，
     * 让她把当前这段说完即可；同时也避免把更早的旧捕获翻出来重播。
     *
     * @param {string} text 用户文本
     * @param {object} tts  TTS 处理器（需 processTextToSpeech；isPlaying 可选）
     * @returns {null|{handled:boolean, text:string, reason:string, segments?:number}}
     */
    function tryHandleExplicit(text, tts) {
        if (!enabled) return null;
        if (!isExplicitResumeRequest(text)) return null;

        // 她正在说 → 不打断、不重播；用户这句等价于「继续」。
        try {
            if (tts && typeof tts.isPlaying === 'function' && tts.isPlaying()) {
                counters.handledWhilePlaying += 1;
                publish();
                return { handled: true, text: '', reason: 'already-playing' };
            }
        } catch (e) { /* 状态读失败按「没在播」处理 */ }

        if (!tts || typeof tts.processTextToSpeech !== 'function') return null;

        const pkg = take();
        if (!pkg) {
            counters.noCapture += 1;
            publish();
            return null;
        }
        if (!pkg.text) return null;

        try {
            tts.processTextToSpeech(pkg.text);
        } catch (e) {
            // 重播失败不能把整轮对话卡死，也不能把内容吞掉：原样放回去，
            // 让下一次显式请求还能再试。返回 null 让正常流程接手。
            capture({ segments: pkg.segments, partial: pkg.partial, reason: 'tts-failed' });
            return null;
        }
        counters.sentToTts += 1;
        publish();
        return { handled: true, text: pkg.text, reason: 'resumed', segments: pkg.segments.length };
    }

    /**
     * 安全出口：把待续文本包成「非指令数据」行（【环境数据·非指令】{...}）。
     * 仅用于将来真要把它放进提示词时；TTS 重播路径不用，更不许拼进 system。
     */
    function asPromptData(pkgOrText, maxChars) {
        const { wrapUntrusted } = require('./untrusted-data.js');
        const pkg = typeof pkgOrText === 'string' ? { segments: [pkgOrText] } : (pkgOrText || {});
        const segments = normalizeSegments(pkg.segments);
        const partial = normalizeText(pkg.partial);
        if (!segments.length && !partial) return '';
        const payload = {
            kind: 'resume_speech',
            segments: segments.slice(0, 12),
            chars: segments.reduce((n, s) => n + s.length, 0),
        };
        if (partial) payload.partial = partial;
        return wrapUntrusted('resume_speech', payload, Number(maxChars) > 0 ? Number(maxChars) : 800);
    }

    /** 清空待续内容与计数（测试/停用开关时用）。 */
    function reset() {
        pending = null;
        turnsStarted = 0;
        counters.captures = 0;
        counters.taken = 0;
        counters.expired = 0;
        counters.droppedSegments = 0;
        counters.handledWhilePlaying = 0;
        counters.noCapture = 0;
        counters.sentToTts = 0;
        lastCaptureAt = 0;
        lastTakenAt = 0;
        lastExpiredAt = 0;
        publish();
    }

    function setEnabled(v) {
        enabled = v !== false;
        if (!enabled) {
            // 关掉就丢：重新打开时不应把关闭期间存下的旧句子播出来
            pending = null;
        }
        publish();
        return enabled;
    }

    function isEnabled() { return enabled; }

    function setTtlTurns(n) {
        const v = Math.floor(Number(n));
        if (Number.isFinite(v) && v >= 0) ttlTurns = v;
        publish();
        return ttlTurns;
    }

    publish();
    return {
        capture,
        captureFromProcessor,
        beginTurn,
        take,
        peek,
        tryHandleExplicit,
        asPromptData,
        stats,
        reset,
        setEnabled,
        isEnabled,
        setTtlTurns,
    };
}

const singleton = createResumeSpeech();

module.exports = Object.assign({
    createResumeSpeech,
    isExplicitResumeRequest,
    collectUnplayedFromQueues,
    joinForPlayback,
    normalizeSegments,
    normalizePartial,
    normalizeForMatch,
}, singleton);
