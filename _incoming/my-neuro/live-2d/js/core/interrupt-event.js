// js/core/interrupt-event.js —— 「她被打断」这件事的唯一判定与传递（2026-11-22 根因修复）
//
// 背景（真机日志实证）：旧实现里 `tts-processor.interrupt()` **无条件**写下
// `__petInterruptedAt`，而 PTT（按住 V 说话）**无论 TTS 是否在播**都会调 interrupt()。
// 于是「按 V 提一个普通问题」也被当成「她话没说完被截断」；30 秒内下一轮
// inner-state 就会注入「开头用不超过 6 个字确认一下，比如"行，你说"」——
// 模型照抄，用户听到的就是「她已经正常回复了，却突然来一句 行，你说」。
// 实测：14 分钟里 18 次 PTT = 18 次「TTS被中断」，其中多次距上一次播放完成已数分钟。
//
// 修法（不在下游加过滤）：
//   · **记录口径上移**：只有 `wasPlaying === true` 才算「被打断」；
//   · 事件带 source（ptt/hotkey/barge-in/turn-cancel），便于事后归因；
//   · 消费是**一次性**的（take 后清空），且 30 秒过期 —— 不会连续两轮都注入确认语。
//
// 这个模块只做纯数据操作，不碰 TTS/播放器，方便单测。
'use strict';

const STORE_KEY = '__petInterrupt';
const DEFAULT_TTL_MS = 30000;

/**
 * 记录一次打断事件。**只有真的在播时才记**（这是本次修复的核心）。
 * @param {object} store globalThis
 * @param {{now?: number, text?: string, source?: string, wasPlaying?: boolean}} input
 * @returns {{at:number,text:string,source:string,wasPlaying:boolean}|null} 实际写入的事件；未记录返回 null
 */
function record(store, input) {
    const o = input || {};
    if (!store || typeof store !== 'object') return null;
    if (o.wasPlaying !== true) return null;          // ← 不在播：不是打断，绝不打点
    const ev = {
        at: Number(o.now) || Date.now(),
        text: String(o.text == null ? '' : o.text).slice(-60),
        source: String(o.source || 'unknown').slice(0, 24),
        wasPlaying: true,
    };
    try { store[STORE_KEY] = ev; } catch (e) { return null; }
    return ev;
}

/**
 * 取走「刚刚真的被打断」的事件（一次性消费）。
 * 过期（默认 30s）、缺 wasPlaying、结构不合法 → 返回 null，并清掉残留。
 * @param {object} store globalThis
 * @param {number} [now]
 * @param {number} [ttlMs]
 * @returns {{at:number,text:string,source:string,wasPlaying:boolean}|null}
 */
function take(store, now, ttlMs) {
    if (!store || typeof store !== 'object') return null;
    let raw = null;
    try { raw = store[STORE_KEY] || null; } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') return null;
    // 一次性：无论是否过期/合法，取过就清（避免同一事件被两轮消费）
    try { store[STORE_KEY] = null; } catch (e) { /* 清不掉也不影响本次判定 */ }
    const at = Number(raw.at) || 0;
    if (!at) return null;
    if (raw.wasPlaying !== true) return null;        // 兼容旧写入者：没明确在播就不算
    const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : DEFAULT_TTL_MS;
    const t = Number(now) || Date.now();
    if (t - at >= ttl) return null;
    return {
        at,
        text: String(raw.text == null ? '' : raw.text).slice(-60),
        source: String(raw.source || 'unknown').slice(0, 24),
        wasPlaying: true,
    };
}

module.exports = { record, take, STORE_KEY, DEFAULT_TTL_MS };
