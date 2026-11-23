// latency-filler.js —— 快慢双轨应答的「快轨」：LLM 等待期垫场语气词（Latency-Cover 路线）。
//
// 第一性原理：用户感知的响应延迟 = TTFB（模型首字时间）。真回复没到之前先播一句
// 短语气词（「唔……让我想想哦」），把「死等」变成「她在想」——延迟感知砍半。
//
// 设计约束（防抢队是本模块存在的意义）：
//   · 垫场**直接进 TTS 分段队列**（requestHandler.segmentFullText），不走
//     processTextToSpeech——它开头 reset() 会把等待中的真回复状态炸掉；
//   · 不 reset、不插队、不碰 conversation 历史、不过 speech-coordinator
//     （垫场是「回应中」不是「自主发言」，不该吃 20s 间隔也不该记 spoken）；
//   · 真回复的流式段用 addStreamingText 追加在**同一条队列尾**——垫场播完真回复自然接上，
//     顺序天然正确；
//   · 每轮最多一次；快轨（流式首 token）已到就撤销；本轮结束 finally 必须收计时器。
//
// 用法（llm-handler 内）：
//   cancelFiller = armLatencyFiller({ config, ttsProcessor,
//       hasFirstToken: () => isStreamingToTTS, isCancelled: () => appState.isInterrupted() });
//   ... finally 里 cancelFiller();
//
// 配置（config.llm，读不到用默认，不写进 config.json——避免又触发丢键排查）：
//   filler_enabled   默认 true
//   filler_delay_ms  默认 1500（下限钳 600，太小会跟快轨抢跑）
'use strict';
const { logToTerminal } = require('../api-utils.js');

// 垫场词库：**零语义、不承诺思考、不请求等待**。
//
// 历史教训（2026-11-08 用户投诉「每次说话都先稍等、让我想想」）：
//   初版词库是「唔……让我想想哦」「等等，我想想……」「稍等一下下」——
//   在听感上等于「她不会答 / 要我重问 / 她卡了」，比沉默更糟。
//   垫场的唯一职责是**填补死寂**，不是表达"我在思考"，更不能像客服话术。
//   所以只用感叹/语气：嗯、啊、哦、这个、那个——注意力不停留，语义零负担。
const FILLER_POOL = [
    '嗯……', '啊……', '哦……', '唔……', '嗯嗯', '哎……',
];

// 默认关闭：垫场是「延迟感知」的补丁，只有首字超过 ~1.2s 才有意义。
// 实测我们的 TTFB 通常 0.6-1.2s（已接近人类对话节奏），此时插播只是噪声。
// 用户实测反馈「每次说话都先稍等」= 默认开启 + 词库带「让我想想」双重问题。
// 需要时在 config.llm.filler_enabled = true 打开（词库已换成零语义版本）。
const DEFAULT_DELAY_MS = 1200;

// 最近用过的垫场词（最多记 2 条）——连着两轮说同一句像复读机，必须轮换。
const recent = [];

function pickFiller() {
    const fresh = FILLER_POOL.filter((p) => !recent.includes(p));
    const pool = fresh.length ? fresh : FILLER_POOL;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    recent.push(chosen);
    while (recent.length > 2) recent.shift();
    return chosen;
}

/**
 * 武装一轮垫场计时器。delay 到点后逐条检查放行条件，全过才把垫场词塞进分段队列。
 * 返回 cancel()：本轮 finally 必须调用，防止计时器漏到下一轮。
 */
function armLatencyFiller({ config, ttsProcessor, hasFirstToken, isCancelled } = {}) {
    const cfg = (config && config.llm) || {};
    // 运行期覆盖（2026-11-09）：设置面板改了「垫场开关/阈值」后，global.reloadConfig
    // 会把新值写进 global.__latencyFillerCfg；这里优先读它，实现保存即生效（无需重启）。
    const rt = (typeof global !== 'undefined' && global.__latencyFillerCfg) || null;
    const enabled = rt && Object.prototype.hasOwnProperty.call(rt, 'filler_enabled')
        ? rt.filler_enabled === true
        : cfg.filler_enabled === true;
    // 默认**关闭**：垫场是延迟补丁，实测 TTFB 已接近人类节奏（0.6-1.2s），
    // 此时插播只会让用户觉得「她每次都要先想一想」（2026-11-08 用户实测投诉）。
    // 确实需要时 config.llm.filler_enabled = true 显式打开。
    if (!enabled) return () => {};
    if (!config || config.tts?.enabled === false || config.ui?.text_only_mode === true) return () => {};
    if (!ttsProcessor) return () => {};
    const n = Number(rt?.filler_delay_ms ?? cfg.filler_delay_ms);
    const delayMs = Number.isFinite(n) ? Math.max(600, n) : DEFAULT_DELAY_MS;

    const timer = setTimeout(() => {
        try {
            if (typeof isCancelled === 'function' && isCancelled()) return;      // 本轮已打断/已结束
            if (typeof hasFirstToken === 'function' && hasFirstToken()) return;  // 快轨已到，无需垫场
            const rp = ttsProcessor.requestHandler;
            if (!rp || typeof rp.segmentFullText !== 'function') return;
            if (rp.volcTtsEnabled) return;   // volc 流式音频与分段队列不串行，混播会叠音（当前部署未启用，纯护栏）
            if (ttsProcessor.isPlaying()) return;   // 已有声音在播/在合成就不插（不与工具播报抢队）
            const phrase = pickFiller();
            rp.segmentFullText(phrase, ttsProcessor.textSegmentQueue);
            logToTerminal('info', `[垫场] LLM 等待超 ${delayMs}ms 且首字未到，插播「${phrase}」（真回复段排其后）`);
        } catch (e) {
            console.warn('[垫场] 插播失败:', e && e.message);
        }
    }, delayMs);
    if (timer.unref) timer.unref();
    return () => clearTimeout(timer);
}

module.exports = { armLatencyFiller, pickFiller, FILLER_POOL };
