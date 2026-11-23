// js/core/last-contact.js —— 「上次真实接触」的唯一锚点（2026-11-22）
//
// 事故（用户现场反馈「前言不搭后语」）：
//   她主动评论屏幕（一起看），用户马上回一句，她却说「你这一走就是四十分钟」。
//   对话历史里证据清楚：她主动说完 → 用户下一句 → 重逢提示按「距**用户**上次说话 40 分钟」
//   判成「用户刚回来」。
//
// 根因：`上次见面.json` 只在**用户输入**时刷新（memory-recall._checkReunion 的写入点），
//   她自己的主动开口不算「接触」。重逢/跨会话接续都以这个文件为锚点，
//   于是任何一次主动搭话之后，用户的第一句回复都会被误判为「久别重逢」。
//
// 修法：任何一路主动开口**真的说出口**之后，调 noteContact(source) 刷新同一份文件。
//   语义变成「接触 = 任一方最近一次说话」；memory-recall 读的仍是这个文件，不用改它。
//
// 注意：
//   · 只由「确实发出来了」的调用方调用（sendToLLM 回来非空之后），别在申请额度时写；
//   · 用户输入那条写入点保持不变（memory-recall），两边都写同一个 {at} 字段，取最近即最大；
//   · 写盘走 json-store（原子写 + 损坏隔离），失败不抛（记账失败不该影响说话）。
'use strict';

const { recordFile } = require('./records-path.js');
const jsonStore = require('./json-store.js');

const FILE = '上次见面.json';

// 可观测计数：写成功/跳过（用户不在）/写失败。没有计数就无法回答
// 「锚点为什么没更新」——这类静默降级会让重逢与接续一起退化。
const stats = { writes: 0, skippedAway: 0, writeFails: 0, lastWriteAt: 0, lastSkipAt: 0 };

/** 用户是否明确不在（只有 state=away 才算；未知/没有传感器按「在」处理） */
function userAway() {
    try {
        const a = globalThis.__userActivity;
        return !!(a && a.state === 'away');
    } catch (e) {
        return false;
    }
}

/**
 * 记一次真实接触。
 *
 * @param {string} via 来源（user / auto-chat / watch-screen / alive-state / dawn-dusk …）
 * @param {{force?:boolean}} [opts] force=true 用于「用户就在场」的接触（用户开口、回复用户）
 * @returns {boolean} 是否写入
 *
 * 2026-11-22（子代理审计发现的下一层 bug）：她**对着空房间**主动说话时，
 * 如果也写这个锚点，用户离开 8 小时回来时会被判成「30 分钟前刚接触」——
 * 久别重逢和跨会话接续一起失效。所以用户明确 away 时**不写**，只记 skippedAway。
 */
function noteContact(via, opts) {
    const force = !!(opts && opts.force);
    if (!force && userAway()) {
        stats.skippedAway += 1;
        stats.lastSkipAt = Date.now();
        return false;
    }
    try {
        jsonStore.writeJson(recordFile(FILE), { at: Date.now(), via: String(via || 'speak') });
        stats.writes += 1;
        stats.lastWriteAt = Date.now();
        return true;
    } catch (e) {
        stats.writeFails += 1;
        return false;
    }
}

/** 最近一次接触时间（0 = 没有）。 */
function lastContactAt() {
    try {
        const j = jsonStore.readJson(recordFile(FILE), null);
        return Number(j && j.at) || 0;
    } catch (e) {
        return 0;
    }
}

function statsSnapshot() {
    return Object.assign({}, stats, { away: userAway() });
}

module.exports = { noteContact, lastContactAt, statsSnapshot, FILE };
