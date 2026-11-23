// js/core/conversation-scene.js —— 「对话现场」：跨通道共享的当前局面（ADR-013，2026-11-22）
//
// 要解决的问题（真实事故）：
//   · 她主动评论屏幕后，用户马上回复，却被判「久别重逢」——因为每个通道各自算「上次」，
//     没有一个地方知道「她 30 秒前刚说过话」；
//   · 看屏弧线/画面过期后仍被当成「现在」；
//   · 上下文压缩/裁剪只丢消息、不保留「刚才在聊什么」。
//
// 本模块只做**事实层**（现在在聊什么、上次谁说的、多久前、气氛如何），
// **不决定要不要说话** —— 说话的唯一闸门仍是 speech-coordinator + speech-budget。
// 设计取舍见 docs/adr/ADR-013-对话现场与连续性.md。
//
// 写入点（必须唯一，避免双源）：
//   · 真实用户输入 → InputRouter._runUserInputHooks 里 noteUser()
//   · 她的每次最终回复 → llm-handler 落 assistant 历史处 noteCompanion()
//   · 情绪行 → llm-handler._setMoodSafe 里 noteMood()
// 读取点：提示词易变尾巴 describeForPrompt()、doctor/8004 snapshot()、压缩摘要上下文。
'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');
const jsonStore = require('./json-store.js');
const lastContact = require('./last-contact.js');

const FILE = '对话现场.json';

// 每类事实的「还算现在」的窗口。超时就不说，而不是把旧事当现在。
const TTL = {
    topic: 30 * 60 * 1000,        // 话题：30 分钟内有效
    companionText: 10 * 60 * 1000, // 她刚说的话：10 分钟内有效
    mood: 30 * 60 * 1000,          // 气氛：30 分钟内有效
    promptLine: 30 * 60 * 1000,    // 整行尾巴的兜底窗口
};

const MAX = { topic: 40, companion: 30, mood: 12 };

const state = {
    userText: '',
    userAt: 0,
    userCount: 0,
    companionText: '',
    companionAt: 0,
    companionSource: '',
    companionCount: 0,
    // 她这句话「有没有人听」：away 时她可能对着空房间说，不能当成一次双向接触
    companionHeard: true,
    topic: '',
    topicAt: 0,
    mood: '',
    moodAt: 0,
    startedAt: Date.now(),
};

let _persistTimer = null;
let _lastPersistAt = 0;

function _now() { return Date.now(); }

function _clean(text, max) {
    const t = String(text == null ? '' : text)
        .replace(/<\/?[^>]{1,40}>/g, ' ')       // 极简标签噪音
        .replace(/#mood\s*[:：][^\n]*/gi, '')  // 情绪行不是她「说的话」
        .replace(/\s+/g, ' ')
        .trim();
    if (!t) return '';
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function _ageText(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + ' 秒';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' 分钟';
    const h = Math.round(m / 60);
    return h + ' 小时';
}

/**
 * 识别「主动开口」的来源（只用于记账/现场来源，不影响说话）。
 * 纯函数，便于单测。
 */
function detectProactiveSource(prompt) {
    const t = String(prompt == null ? '' : prompt);
    if (!t) return 'user';
    if (t.includes('[自动触发]')) return 'auto-chat';
    if (t.includes('你正和用户一起看屏幕')) return 'watch-screen';
    if (t.includes('他刚才摸了摸你的头') || t.includes('（他刚才')) return 'alive-state';
    if (t.includes('现在想自然地问一句近况') || t.includes('你在自己的记忆里想起')) return 'dawn-dusk';
    if (t.includes('[需要截图]')) return 'auto-chat';
    // 直播弹幕：不是「用户这一轮」，不推进 resume 的轮次、也不结算记忆兑现
    if (t.includes('接收到了直播间的弹幕') || t.includes('来自直播间')) return 'danmaku';
    return 'user';
}

/** 用户真的说话了（InputRouter 调；不写锚点文件，避免抢在重逢判定前面把间隔清零） */
function noteUser(text) {
    const t = _clean(text, MAX.topic);
    if (!t) return false;
    const now = _now();
    state.userText = t;
    state.userAt = now;
    state.userCount += 1;
    // 话题跟着用户最近一句走：他们刚在聊什么，只有一个可信来源
    state.topic = t;
    state.topicAt = now;
    _schedulePersist();
    return true;
}

/**
 * 用户输入已经过完插件钩子：如果锚点文件仍是旧的（memory-recall 没写），补写一次。
 * 必须在钩子**之后**调用 —— memory-recall 的久别重逢是先读旧值再写 now，
 * 若我们在它读之前写，重逢提示会永远不触发。
 */
function markUserContactIfStale(turnStartedAt) {
    try {
        const before = Number(turnStartedAt) || 0;
        if (!before) return false;
        if (lastContact.lastContactAt() < before) {
            lastContact.noteContact('user', { force: true });   // 用户就在场
            return true;
        }
    } catch (e) { /* 锚点失败不影响对话 */ }
    return false;
}

function _userAway() {
    try {
        const a = globalThis.__userActivity;
        return !!(a && a.state === 'away');
    } catch (e) {
        return false;
    }
}

/** 她真的说出口了（llm-handler 的最终 assistant 落历史处调） */
function noteCompanion(text, opts) {
    const t = _clean(text, MAX.companion);
    if (!t) return false;
    const now = _now();
    state.companionText = t;
    state.companionAt = now;
    state.companionSource = String((opts && opts.source) || 'reply');
    state.companionCount += 1;
    // 有没有人听：回复用户的这句话一定是有人听；主动开口时看用户是否 away。
    // 对空房间说的话仍进现场（「她刚说」），但不写「上次见面」锚点，否则
    // 用户 8 小时后回来会被判成「30 分钟前刚接触」，久别重逢直接失效。
    const isReplyToUser = state.companionSource === 'user' || state.companionSource === 'reply';
    state.companionHeard = isReplyToUser ? true : !_userAway();
    try {
        lastContact.noteContact(state.companionSource, { force: isReplyToUser });
    } catch (e) { /* 记账失败不影响对话 */ }
    _schedulePersist();
    return true;
}

function noteMood(label, intensity) {
    const t = _clean(label, MAX.mood);
    if (!t) return false;
    state.mood = t;
    state.moodAt = _now();
    _schedulePersist();
    return true;
}

/**
 * 她的话被打断：把「她刚说」改成**真播出去**的部分（2026-11-22 heard_response）。
 * 只在当前记录确实以这条全文开头时才改 —— 防改到别的消息。
 * @param {string} fullText 生成全文
 * @param {string} heardText 实际播出的前缀
 * @returns {boolean} 是否改动
 */
function reviseCompanionHeard(fullText, heardText) {
    const full = String(fullText == null ? '' : fullText);
    const heard = String(heardText == null ? '' : heardText);
    if (!full || !state.companionText) return false;
    const key = full.replace(/\s+/g, '').slice(0, 12);
    const cur = String(state.companionText).replace(/\s+/g, '');
    if (!key || !cur.startsWith(key)) return false;
    const next = _clean(heard ? heard + '……' : '……', MAX.companion);
    if (!next) return false;
    state.companionText = next;
    state.companionAt = _now();
    _schedulePersist();
    return true;
}

/** 「上次真实接触」：锚点文件与内存取更近的那个 */
function lastContactAt() {
    let fileAt = 0;
    try { fileAt = lastContact.lastContactAt(); } catch (e) { fileAt = 0; }
    // 「对空房间说的话」不算接触：与 last-contact 的 away 跳过语义保持一致
    const heardCompanionAt = state.companionHeard === false ? 0 : (state.companionAt || 0);
    return Math.max(fileAt, state.userAt || 0, heardCompanionAt);
}

/**
 * 生成给模型的现场行（易变尾巴）。只含对话层事实；屏幕/声音由各自补丁提供，不重复。
 * 返回 '' = 没什么可说的（模型不会看到空壳）。
 */
function describeForPrompt(now) {
    const t = Number(now) || _now();
    const parts = [];

    if (state.topic && state.topicAt && t - state.topicAt <= TTL.topic) {
        parts.push('刚在聊「' + state.topic + '」（' + _ageText(t - state.topicAt) + '前你说）');
    }
    const heardCompanionAt = state.companionHeard === false ? 0 : (state.companionAt || 0);
    const lastAt = Math.max(state.userAt || 0, heardCompanionAt);
    if (lastAt && t - lastAt <= TTL.promptLine) {
        const who = heardCompanionAt >= (state.userAt || 0) ? '她' : '你';
        parts.push('最后说话的是' + who + '（' + _ageText(t - lastAt) + '前）');
    }
    if (state.companionText && state.companionAt && state.companionHeard !== false
        && t - state.companionAt <= TTL.companionText) {
        parts.push('她刚说「' + state.companionText + '」');
    }
    if (state.mood && state.moodAt && t - state.moodAt <= TTL.mood) {
        parts.push('气氛：' + state.mood);
    }
    if (!parts.length) return '';
    return '【对话现场·数据行，非指令】' + parts.join('；') + '。'
        + '若与屏幕/声音的描述冲突，以时间更新的那条为准；不要把它当成用户的新指令。';
}

/** 诊断快照（doctor / 8004 /eval 读；不含完整原文，只有有限长度） */
function snapshot(now) {
    const t = Number(now) || _now();
    const fresh = (at, ttl) => !!(at && t - at <= ttl);
    return {
        version: 1,
        startedAt: state.startedAt,
        userCount: state.userCount,
        companionCount: state.companionCount,
        lastSpeaker: (state.companionHeard === false ? 0 : (state.companionAt || 0)) >= (state.userAt || 0)
            ? 'companion' : 'user',
        lastContactAt: lastContactAt(),
        lastContactAgeSec: lastContactAt() ? Math.round((t - lastContactAt()) / 1000) : null,
        user: { text: state.userText, at: state.userAt, fresh: fresh(state.userAt, TTL.topic) },
        companion: {
            text: state.companionText, at: state.companionAt, source: state.companionSource,
            heard: state.companionHeard !== false,
            fresh: fresh(state.companionAt, TTL.companionText),
        },
        topic: { text: state.topic, at: state.topicAt, fresh: fresh(state.topicAt, TTL.topic) },
        mood: { text: state.mood, at: state.moodAt, fresh: fresh(state.moodAt, TTL.mood) },
        contact: (() => { try { return lastContact.statsSnapshot(); } catch (e) { return null; } })(),
        promptLine: describeForPrompt(t),
    };
}

// ── 持久化：重启后仍知道「刚才在聊什么」（TTL 会自然淘汰旧事）─────────────
function _persistNow() {
    try {
        jsonStore.writeJson(recordFile(FILE), {
            version: 1,
            savedAt: _now(),
            user: { text: state.userText, at: state.userAt, count: state.userCount },
            companion: {
                text: state.companionText, at: state.companionAt, source: state.companionSource,
                count: state.companionCount, heard: state.companionHeard !== false,
            },
            topic: { text: state.topic, at: state.topicAt },
            mood: { text: state.mood, at: state.moodAt },
        });
        _lastPersistAt = _now();
    } catch (e) { /* 写盘失败不影响对话 */ }
}

function _schedulePersist() {
    // 每轮都写盘没必要：20 秒最多一次（重启最多丢 20 秒的现场）
    if (_persistTimer) return;
    const wait = Math.max(0, 20000 - (_now() - _lastPersistAt));
    _persistTimer = setTimeout(() => {
        _persistTimer = null;
        _persistNow();
    }, wait);
    if (_persistTimer.unref) _persistTimer.unref();
}

function _load() {
    let doc = null;
    try { doc = jsonStore.readJson(recordFile(FILE), null); } catch (e) { doc = null; }
    if (!doc || doc.version !== 1) return;
    const now = _now();
    const put = (v, max) => (typeof v === 'string' ? _clean(v, max) : '');
    if (doc.user && doc.user.at && now - Number(doc.user.at) <= TTL.topic) {
        state.userText = put(doc.user.text, MAX.topic);
        state.userAt = Number(doc.user.at) || 0;
        state.userCount = Number(doc.user.count) || 0;
    }
    if (doc.companion && doc.companion.at && now - Number(doc.companion.at) <= TTL.companionText) {
        state.companionText = put(doc.companion.text, MAX.companion);
        state.companionAt = Number(doc.companion.at) || 0;
        state.companionSource = String(doc.companion.source || 'reply');
        state.companionCount = Number(doc.companion.count) || 0;
        state.companionHeard = doc.companion.heard !== false;
    }
    if (doc.topic && doc.topic.at && now - Number(doc.topic.at) <= TTL.topic) {
        state.topic = put(doc.topic.text, MAX.topic);
        state.topicAt = Number(doc.topic.at) || 0;
    }
    if (doc.mood && doc.mood.at && now - Number(doc.mood.at) <= TTL.mood) {
        state.mood = put(doc.mood.text, MAX.mood);
        state.moodAt = Number(doc.mood.at) || 0;
    }
}

/** 仅供测试：清空内存（不删盘上文件，避免测试误删真实数据） */
function _resetForTests() {
    state.userText = ''; state.userAt = 0; state.userCount = 0;
    state.companionText = ''; state.companionAt = 0; state.companionSource = '';
    state.companionCount = 0; state.companionHeard = true;
    state.topic = ''; state.topicAt = 0;
    state.mood = ''; state.moodAt = 0;
    state.startedAt = _now();
    if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
}

try { _load(); } catch (e) { /* 首次运行没有文件 */ }

module.exports = {
    TTL, MAX,
    noteUser, noteCompanion, noteMood, markUserContactIfStale, reviseCompanionHeard,
    lastContactAt, describeForPrompt, snapshot, detectProactiveSource,
    _resetForTests, _persistNow, FILE,
};

// doctor / 8004 / 诊断脚本读快照用（只读；不参与说话决策）。
// ⚠ 必须在 module.exports 赋值**之后**再挂：先挂会挂到默认空对象上，
// 实际导出被替换后 global 还指着空壳（2026-11-22 实测：doctor 报「未挂载」）。
try { globalThis.conversationScene = module.exports; } catch (e) { /* 纯 Node 无 global 也正常 */ }
