/**
 * persona-layers.js —— 人格三层：core / slow / fast（2026-11-15 六十轮）
 *
 * 为什么要有这一层（调研缺口）：现在只有「静态 system prompt（core，但不可控）」
 * + 「10 字状态（fast，6 小时过期）」。中间那层缺了 ——
 * **关系、习惯、承诺、最近在意的事**这些几周才变一次的东西无处安放，
 * 于是她要么永远不知道，要么被当成一次性闲聊丢掉。
 *
 * 三层职责：
 *   · core  身份/价值观/边界 —— **只能人改**（本模块没有写 core 的入口）
 *   · slow  关系/习惯/承诺/最近在意的事 —— 必须有**≥2 个不同日期**的证据才升级；
 *           每周最多 5 条；与 core 冲突直接拒
 *   · fast  此刻状态 —— 已有 dynamic-persona 管，本层不碰
 *
 * 为什么证据要「不同日期」：同一天说三遍「我最近很累」不等于长期变化，
 * 那只是今天累。跨天才是趋势（这条是调研里「叙事 ≠ 事实」的直接落地）。
 *
 * 文件：data/人格内核.json（core + slow 一起存，便于人肉审阅）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');
const jsonStore = require('./json-store.js');

const FILE = '人格内核.json';
const WEEK_MS = 7 * 24 * 3600 * 1000;
const MAX_SLOW_PER_WEEK = 5;
const SLOW_CLASSES = ['关系', '习惯', '承诺', '在意'];

// 2026-11-22 P0（审计）：人格内核原来 `load()` 解析失败**静默返回出厂内核**，
// 而 memory-evolve 每 5 分钟会 applySlow → save() 把出厂内核**整份写回**，
// 用户手写的 core 永久丢失。现在：
//   · 读走 json-store（坏文件改名 .corrupt-* 隔离，原始数据可抢救）；
//   · 一旦发现文件损坏/形状不合法 → 本进程**锁死写回**（_blocked），
//     周期任务只会拿到 {ok:false, reason}，绝不会覆盖。
let _blocked = false;
let _blockReason = '';

function isBlocked() { return _blocked; }
function blockedReason() { return _blockReason; }
function _block(reason) {
    _blocked = true;
    _blockReason = String(reason || '人格内核不可写');
    try { console.error('[persona-layers] ' + _blockReason + '：本进程拒绝写回（保护手写 core）'); } catch (e) { /* ignore */ }
}

// 2026-11-21：允许测试用 PET_PERSONA_FILE 把数据文件指到临时目录。
// 为什么：门禁里的 test-persona-layers 原来直接删/写**真实**人格三层文件再恢复，
// 一旦宿主的 persona 插件同时读写，就会偶发 EPERM/内容被覆盖（门禁里实测红过）。
// 生产不设该变量，行为完全不变。
function file() {
    const override = process.env.PET_PERSONA_FILE;
    return override && String(override).trim() ? String(override) : recordFile(FILE);
}
function dayOf(ts) {
    const d = new Date(Number(ts) || Date.now());
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function defaultKernel() {
    return {
        version: 1,
        core: {
            name: '大肥鱼',
            identity: '住在 Windows 桌面右下角小窗里的猫耳女仆；不是助手，是住在这个桌面上的人',
            values: ['嘴硬心软：会吐槽但不会攻击人这个人', '难过时收起吐槽，认真接住'],
            boundaries: ['不自称助手/语言模型', '不说自己住在云端', '不列条目说话', '一条不超过 70 字'],
        },
        slow: { 关系: [], 习惯: [], 承诺: [], 在意: [] },
        updated_at: 0,
        history: [],
    };
}

function load() {
    const p = file();
    const j = jsonStore.readJson(p, null);
    if (j && typeof j === 'object' && j.core && j.slow) {
        for (const k of SLOW_CLASSES) if (!Array.isArray(j.slow[k])) j.slow[k] = [];
        if (!Array.isArray(j.history)) j.history = [];
        return j;
    }
    if (j === null) {
        // 文件不存在 = 首次运行（正常）；已被 json-store 隔离 = 损坏 → 锁死写回
        if (jsonStore.isQuarantined(p)) _block('人格内核.json 损坏已隔离（见 .corrupt-*，可手工修复）');
        return defaultKernel();
    }
    // 能解析但形状不对（缺 core/slow）同样是坏文件：隔离 + 锁死，绝不拿出厂内核覆盖
    _block('人格内核.json 形状不合法（缺 core/slow）');
    try { jsonStore.quarantineFile(p, '人格内核形状不合法'); } catch (e) { /* 隔离失败也已锁死 */ }
    return defaultKernel();
}

function save(k) {
    if (_blocked) {
        try { console.warn('[persona-layers] 拒绝写回：' + _blockReason); } catch (e) { /* ignore */ }
        return false;
    }
    try {
        jsonStore.writeJson(file(), k);   // 返回 undefined；写失败/已隔离会 throw
        return true;
    } catch (e) {
        if (jsonStore.isQuarantined(file())) _block('人格内核.json 已隔离，无法写回');
        try { console.error('[persona-layers] 保存失败：' + ((e && e.message) || e)); } catch (e2) { /* ignore */ }
        return false;
    }
}

function initIfMissing() {
    if (!fs.existsSync(file())) { save(defaultKernel()); return true; }
    return false;
}

/** 与 core 是否冲突（粗暴但有效：边界/价值观里的关键词出现在 slow 文本里就拒） */
function conflictsWithCore(kernel, text) {
    const t = String(text || '');
    if (!t) return true;
    const coreTexts = [kernel.core.identity].concat(kernel.core.values || [], kernel.core.boundaries || []);
    // 只查「明确的红线词」：自称助手/住云端这种，出现在 slow 里就是把它写反了
    const RED = /(我是(?:一个)?(?:AI|助手|语言模型)|住在(?:云端|服务器)|有什么可以帮[你您])/;
    if (RED.test(t)) return true;
    // 与 core 完全重复 → 不必再写（不是冲突，但拒绝重复）
    return coreTexts.some((c) => String(c).includes(t) && t.length > 4);
}

/**
 * 从「用户事实」里提出 slow 候选：同一个话题在**至少 2 个不同日期**被提到。
 * 只提议，不写盘 —— 写盘走 applySlow（带周配额和 core 冲突检查）。
 * @param {Array} facts user-facts.load() 的形状
 * @param {Array} slowClasses 可选，默认四类
 */
function proposeFromFacts(facts, slowClasses) {
    const classes = Array.isArray(slowClasses) && slowClasses.length ? slowClasses : SLOW_CLASSES;
    const byTopic = new Map();
    for (const f of (facts || [])) {
        if (!f || !f.fact) continue;
        if (f.valid_to) continue;                       // 已失效的事实不参与
        const key = String(f.fact).replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '').slice(0, 10);
        if (!key) continue;
        const day = dayOf(f.valid_from || f.at);
        const cur = byTopic.get(key) || { key, text: String(f.fact), days: new Set(), ids: [] };
        cur.days.add(day);
        cur.ids.push(f.id);
        byTopic.set(key, cur);
    }
    const out = [];
    for (const v of byTopic.values()) {
        if (v.days.size < 2) continue;                  // 必须跨天
        out.push({ cls: classes[0], text: v.text.slice(0, 40), evidence: v.ids, days: [...v.days] });
    }
    return out;
}

/**
 * 写入一条 slow（带三重闸）。返回 {ok, reason, item}
 *   · 与 core 冲突/重复 → 拒
 *   · 本周已写满 5 条 → 拒
 *   · 已有高度相似的条目 → 视为重复（ok=false, reason=duplicate）
 */
function applySlow(candidate, now) {
    if (_blocked) return { ok: false, reason: '人格内核不可写：' + _blockReason };
    const k = load();
    const t = String((candidate && candidate.text) || '').trim();
    const cls = String((candidate && candidate.cls) || '');
    if (!t) return { ok: false, reason: '空条目' };
    if (!SLOW_CLASSES.includes(cls)) return { ok: false, reason: '不在四类里（关系/习惯/承诺/在意）' };
    const at = Number(now) || Date.now();
    if (conflictsWithCore(k, t)) return { ok: false, reason: '与内核冲突或重复' };

    const weekAgo = at - WEEK_MS;
    const recent = (k.history || []).filter((h) => Number(h.at) >= weekAgo && h.layer === 'slow');
    if (recent.length >= MAX_SLOW_PER_WEEK) return { ok: false, reason: '本周已达上限 ' + MAX_SLOW_PER_WEEK };

    const dup = k.slow[cls].some((x) => String(x.text).replace(/\s/g, '') === t.replace(/\s/g, ''));
    if (dup) return { ok: false, reason: 'duplicate' };

    const item = { text: t, at, evidence: (candidate && candidate.evidence) || [], days: (candidate && candidate.days) || [] };
    k.slow[cls].push(item);
    // 每类最多留 8 条，旧的挤掉（slow 是「最近的稳定状态」，不是档案）
    if (k.slow[cls].length > 8) k.slow[cls] = k.slow[cls].slice(-8);
    k.history = (k.history || []).concat([{ layer: 'slow', cls, text: t, at }]).slice(-50);
    k.updated_at = at;
    if (!save(k)) return { ok: false, reason: '落盘失败' };
    return { ok: true, item, cls };
}

/**
 * 给 system prompt 用的紧凑注入文本。
 * 只输出「有内容的层」；总长控制在 400 字以内 —— 人格注入不能把上下文吃光。
 */
function injectionText(kernel) {
    const k = kernel || load();
    const lines = [];
    const slow = k.slow || {};
    for (const cls of SLOW_CLASSES) {
        const arr = Array.isArray(slow[cls]) ? slow[cls].filter((x) => x && x.text) : [];
        if (!arr.length) continue;
        lines.push(cls + '：' + arr.slice(-3).map((x) => x.text).join('；'));
    }
    if (!lines.length) return '';
    return '（你已经知道的事，不用他再讲：\n' + lines.join('\n') + '\n这些是你自己记住的，不是他刚说的。）';
}

function stats() {
    const k = load();
    const counts = {};
    for (const cls of SLOW_CLASSES) counts[cls] = (k.slow[cls] || []).length;
    return {
        core: { name: k.core.name, values: (k.core.values || []).length, boundaries: (k.core.boundaries || []).length },
        slow: counts, updated_at: k.updated_at, history: (k.history || []).length,
        blocked: _blocked, blockedReason: _blockReason,
    };
}

module.exports = {
    file, load, save, initIfMissing, defaultKernel,
    conflictsWithCore, proposeFromFacts, applySlow, injectionText, stats,
    isBlocked, blockedReason,
    SLOW_CLASSES, MAX_SLOW_PER_WEEK,
};
