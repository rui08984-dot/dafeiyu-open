// js/core/voice-intent.js —— 语音话语四态分类 + response-intent 门（B5，2026-11-23）
//
// 要解决的问题（真机听感反馈）：
//   她在说话时，用户只回一句「嗯 / 对 / 好」，会被当成「抢话」——
//   既截断她，又把这声「嗯」当成新指令跑一轮 LLM，她再回一句。
//
// 判定分四态：
//   backchannel —— 短确认（≤4 个汉字，且整句只由确认字组成，且不是疑问句）。
//                    TTS 在播：不打断、不回应（只是附和，不是指令）；
//                    TTS 没在播：不打断（没东西可打断），但正常回应（她说完你应一声）。
//   noise       —— 空文本 / 全标点 / 重复叹词 / 近静音 / 置信度低于阈值。永不打断、永不回应。
//   barge_in    —— 「等等 / 停 / 别…/ 不对 / 错了」这类明确要求停下。TTS 在播就打断。
//   turn_take   —— 其余完整话语。TTS 在播正常抢话。
//
// response-intent 门（本模块的核心）：
//   `ttsQuestioning`（她上一句在问问题）时，短确认要**升级为 turn_take**——
//   用户那声「嗯/对」是在回答，不是附和，不能被吞掉。
//
// 设计纪律：
//   · 纯函数：不 require Electron/DOM，不读配置，不写全局，不抛异常。
//   · 保守优先：**宁可让用户打断，也不要吞掉真话**。任何不确定 → 偏 turn_take。
//   · 阈值可配：置信度阈值由调用方传入（config.voice.duplex.noise_confidence_threshold）。
//   · 只看文本与几个可选信号，不做 AI 判定。
'use strict';

// 置信度低于此值视为 noise。可由调用方用 { noiseConfidenceThreshold } 覆盖。
const DEFAULT_NOISE_CONFIDENCE = 0.35;
// backchannel 的汉字上限（超过就必须当完整话）。
const MAX_BACKCHANNEL_HAN = 4;
// 近静音 RMS：与 asr-processor 的「麦克风没声音」判据（0.0005）保持一致。
const SILENCE_RMS = 0.0005;
// 一句话拖到 3s 以上，就不再算「随口应一声」（防止拖长的「嗯——」把真话吞掉）。
const LONG_UTTERANCE_MS = 3000;

// 整句只由这些字组成且 ≤4 字，才可能是 backchannel（「好的」「行吧」「是啊」）。
const CONFIRM_CHARS = new Set(Array.from('嗯哦喔對对好行是恩啊诶哎的吧呀嘛呢'));
// 必须至少含一个「核心确认字」——「吧吧」「的的」这种不算确认。
const CORE_CONFIRM_CHARS = new Set(Array.from('嗯哦喔對对好行是恩啊'));
// 拉丁/整词形态的短确认（ASR 偶尔会给英文）。
const EXACT_BACKCHANNEL = new Set(['ok', 'okay', 'okey', 'yes', 'yeah', '收到', '好嘞', '嗯哼', '嗯呐', '對啊', '对啊', '好喔']);

// 明确「停下/别说了」的起手式。
const BARGE_PREFIXES = [
    '等等', '等一等', '等一下', '等下', '停', '打住', '打断',
    '别说了', '别说', '先别说', '不对', '错了', '我打断',
];
// 出现在句中任意位置的「别说了」类短语。
const BARGE_CONTAINS = ['停一下', '停一停', '别说了', '先别说', '打断一下', '等一下', '等等'];

// 纯叹词（单独重复时是噪音，不是话语）。
const FILLER_RE = /^[啊呃额唉哎唔]{3,}$/u;
// 同一个字重复 ≥4 次（「啊啊啊啊」「对对对对」）→ 退化重复，不是话语。
const SAME_CHAR_REPEAT_RE = /^(.)\1{3,}$/u;

// 疑问句线索（她问、用户答的场景必须判成不是附和）。
const QUESTION_WORD_RE = /(什么|为什么|怎么|怎样|哪[个里儿边]?|谁|多少|几点|几个|多久|是不是|有没有|要不要|行不行|好不好|对不对|可以吗|能不能|会不会|要不要)/;

/**
 * 去掉空白与标点/符号，只留“话本身”。用于长度与组成判断。
 * @param {*} text
 * @returns {string}
 */
function normalizeText(text) {
    return String(text == null ? '' : text)
        .replace(/[\s\u3000]+/gu, '')
        .replace(/[\p{P}\p{S}]+/gu, '');
}

/**
 * 汉字个数（只数 CJK 统一表意文字基本区 + 扩展 A）。
 * @param {string} s
 * @returns {number}
 */
function countHan(s) {
    const m = String(s || '').match(/[\u3400-\u4dbf\u4e00-\u9fff]/gu);
    return m ? m.length : 0;
}

/**
 * 这句是不是疑问句（用于两处：①短确认不能被当成附和；②她上一句是不是在问）。
 * 只看句尾 80 字，避免长段落里的问号误伤。
 * @param {*} text
 * @returns {boolean}
 */
function looksLikeQuestioning(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return false;
    const tail = s.slice(-80);
    if (/[?？]\s*$/u.test(tail)) return true;
    if (/[吗]\s*[?？]?\s*$/u.test(tail)) return true;
    if (QUESTION_WORD_RE.test(tail)) return true;
    return false;
}

/**
 * 是否明确要求停下（等等 / 停 / 别说了 / 不对 …）。
 * @param {string} norm normalizeText 之后的文本
 * @returns {string} '' = 不是；否则返回命中的规则名
 */
function matchBargeIn(norm) {
    if (!norm) return '';
    // 「停」单字太容易误伤（停车场/停了很久）→ 只认「停/停下/停一下/停停/停住/停了/停吧」。
    if (norm === '停' || /^停(一?下|一?停|停|住|了|吧|啊)/u.test(norm)) return 'barge-in-prefix:停';
    if (/^等(等|一等|一下|下)/u.test(norm)) return 'barge-in-prefix:等等';
    for (const p of BARGE_PREFIXES) {
        if (p === '停' || p === '等等' || p === '等一等' || p === '等一下' || p === '等下') continue; // 上面已判
        if (norm.startsWith(p)) return 'barge-in-prefix:' + p;
    }
    // 句中出现的「你等一下 / 先别说 / 停一下」——加「你/您/先」前缀约束，
    // 避免「我们等一下吧」这类正常句子被误判成打断。
    for (const c of BARGE_CONTAINS) {
        if ((c === '等一下' || c === '等等') && !new RegExp('(^|[你您先])' + c, 'u').test(norm)) continue;
        if (norm.includes(c)) return 'barge-in-contains:' + c;
    }
    return '';
}

/**
 * 是否短确认（整句只由确认字组成，≤4 汉字，且至少一个核心确认字）。
 * @param {string} norm
 * @returns {boolean}
 */
function isBackchannelText(norm) {
    if (!norm) return false;
    if (EXACT_BACKCHANNEL.has(norm.toLowerCase())) return true;
    const han = countHan(norm);
    if (han === 0 || han > MAX_BACKCHANNEL_HAN) return false;
    if (norm.length !== han) return false;            // 混了拉丁/数字 → 不是纯确认
    let hasCore = false;
    for (const ch of norm) {
        if (!CONFIRM_CHARS.has(ch)) return false;
        if (CORE_CONFIRM_CHARS.has(ch)) hasCore = true;
    }
    return hasCore;
}

/**
 * 语音话语四态分类（纯函数，绝不抛）。
 *
 * @param {{
 *   text?: string,             // ASR 文本（final 优先）
 *   isFinal?: boolean,         // 缺省 true；显式 false = 中间结果 → 不打断也不回应
 *   confidence?: number,       // ASR 置信度（0..1）；缺失不当噪音
 *   ttsPlaying?: boolean,      // 判定时她是否在播
 *   ttsQuestioning?: boolean,  // 她上一句是否在问（response-intent 门）
 *   energyRms?: number,        // 这段录音的 RMS；<0.0005 视为近静音
 *   durationMs?: number        // 这段语音时长；>3000ms 的「短确认」升级为完整话
 * }} input
 * @param {{noiseConfidenceThreshold?: number}} [options]
 * @returns {{kind:'backchannel'|'noise'|'barge_in'|'turn_take', reason:string,
 *            shouldInterrupt:boolean, shouldRespond:boolean}}
 */
function classifyVoiceUtterance(input, options) {
    const o = (input && typeof input === 'object') ? input : null;
    if (!o) {
        // 输入整个缺失：保守 —— 当完整话，交给上层决定（上层此刻无文本可送，实际等同放行）。
        return { kind: 'turn_take', reason: 'invalid-input', shouldInterrupt: false, shouldRespond: true };
    }
    try {
        const opt = (options && typeof options === 'object') ? options : {};
        const thRaw = Number(opt.noiseConfidenceThreshold);
        const threshold = Number.isFinite(thRaw) && thRaw > 0 && thRaw < 1 ? thRaw : DEFAULT_NOISE_CONFIDENCE;

        const raw = String(o.text == null ? '' : o.text);
        const norm = normalizeText(raw);
        const playing = o.ttsPlaying === true;
        const questioning = o.ttsQuestioning === true;

        let kind = 'turn_take';
        let reason = 'default';

        // ① 明确要求停下 —— 优先级最高（哪怕置信度低，说了「停」就该停）。
        const barge = matchBargeIn(norm);
        if (barge) {
            kind = 'barge_in';
            reason = barge;
        } else if (!norm) {
            // ② 空文本 / 全标点（先于疑问判断：「？？」不是反问）。
            kind = 'noise';
            reason = String(raw).trim() ? 'punct-only' : 'empty';
        } else if (looksLikeQuestioning(raw)) {
            // ③ 疑问句：短也不能当附和（「嗯？」= 反问）。
            kind = 'turn_take';
            reason = 'question';
        } else {
            const rms = Number(o.energyRms);
            const conf = Number(o.confidence);
            if (Number.isFinite(rms) && rms >= 0 && rms < SILENCE_RMS) {
                kind = 'noise';
                reason = 'low-energy';
            } else if (Number.isFinite(conf) && conf >= 0 && conf < threshold) {
                kind = 'noise';
                reason = 'low-confidence';
            } else if (SAME_CHAR_REPEAT_RE.test(norm)) {
                kind = 'noise';
                reason = 'repeated-char';
            } else if (FILLER_RE.test(norm)) {
                kind = 'noise';
                reason = 'filler-repeat';
            } else if (isBackchannelText(norm)) {
                const dur = Number(o.durationMs);
                if (questioning) {
                    // response-intent 门：她在问，用户「嗯/对」是在回答 → 不能吞。
                    kind = 'turn_take';
                    reason = 'backchannel-answer';
                } else if (Number.isFinite(dur) && dur > LONG_UTTERANCE_MS) {
                    // 拖了 3s 以上的「嗯——」不是随口应一声 → 保守当完整话。
                    kind = 'turn_take';
                    reason = 'backchannel-too-long';
                } else {
                    kind = 'backchannel';
                    reason = 'backchannel';
                }
            }
        }

        let shouldInterrupt = false;
        let shouldRespond = false;
        if (kind === 'barge_in' || kind === 'turn_take') {
            shouldInterrupt = playing;     // 没在播就没有可打断的东西
            shouldRespond = true;
        } else if (kind === 'backchannel') {
            shouldInterrupt = false;
            shouldRespond = !playing;      // 她在说话时「嗯」只是附和，不额外回一句
        } // noise：两个都 false

        // 中间结果（显式 isFinal:false）绝不据此打断，也不据它开一轮。
        if (o.isFinal === false) {
            shouldInterrupt = false;
            shouldRespond = false;
            reason = reason + '+interim';
        }

        return { kind, reason, shouldInterrupt, shouldRespond };
    } catch (e) {
        // 绝不抛：任何异常都按「完整话」放行（宁可让她被抢，也不能吞真话）。
        const playing = !!(o && o.ttsPlaying === true);
        return { kind: 'turn_take', reason: 'error-conservative', shouldInterrupt: playing, shouldRespond: true };
    }
}

module.exports = {
    classifyVoiceUtterance,
    looksLikeQuestioning,
    // 以下导出只为单测/诊断，不属于公共契约
    normalizeText,
    countHan,
    isBackchannelText,
    DEFAULT_NOISE_CONFIDENCE,
    MAX_BACKCHANNEL_HAN,
    SILENCE_RMS,
    LONG_UTTERANCE_MS,
};
