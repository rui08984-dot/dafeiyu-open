/**
 * js/core/route-experience.js —— 按 app 的历史成功率重排操控通道（D2，2026-11-22）
 *
 * 需求（研讨会 D2）：
 *   · 按 **app 指纹**（进程名小写，不是窗口标题）累计每条通道的成败；
 *   · 选路时把历史成功率高的通道排前面；样本 < 3 保持原序（不拿一两次抖动当结论）；
 *   · 同一 app 同一通道**连续 3 次失败** → 整个 app 回到默认顺序，并记 degraded；
 *   · stats() 暴露每 app 成功率与降级状态（doctor / 探针可读）。
 *
 * 为什么「只重排、不执行」：
 *   本模块不调用 UIA/OCR/坐标，也不改任何动作的成败判定。执行链照旧做它自己的
 *   校验与回落；这里只回答一个纯问题：「同样这几条候选通道，先试哪条」。
 *   这样经验路由即使判断错了，最多是多等一次回落，不会把成功改成失败。
 *
 * 指纹纪律：
 *   键 = 进程可执行名（小写、去 .exe、去路径），例如 `notepad` / `msedge` / `chrome`。
 *   **不用窗口标题**：标题随内容变（"main.js - Visual Studio Code"），拿它做键会让
 *   同一 app 的历史碎成几十份，经验永远攒不够 3 个样本。
 *
 * 持久化：
 *   records-path 的 `route-experience.json`（PET_DATA_ROOT 生效），原子写走 json-store。
 *   文件损坏 → json-store 隔离 + 从空表开始，不阻塞操控；写失败只 warn 不抛。
 *
 * 开关：
 *   `setEnabled(false)` 时 record/prefer 全部退化为 no-op（prefer 原序返回）。
 *   dispatch 插件在 onInit 里按 plugin_config.route_experience 设置；默认 **开**：
 *   它不改执行、样本门槛 3、连续失败自动回默认，风险上限只是「建议顺序不同」。
 */

'use strict';

const path = require('path');
const { recordFile } = require('./records-path');
const { readJson, writeJson } = require('./json-store');

const FILE_NAME = 'route-experience.json';
const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
    enabled: true,
    sampleMin: 3,          // 少于 3 个样本不参与重排
    failStreakLimit: 3,    // 同 app 同通道连续失败 3 次 → 回默认
    maxApps: 200,          // app 表上限（按 lastAt 淘汰最旧）
    maxViasPerApp: 8,      // 每 app 的通道记录上限
});

/** 进程名归一：小写、去路径、去 .exe、只留安全字符。取不到返回 ''。 */
function normalizeApp(app) {
    let s = String(app == null ? '' : app).trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^.*[\\/]/, '');
    s = s.replace(/\.exe$/i, '');
    s = s.replace(/[^a-z0-9._\-\u4e00-\u9fa5]/g, '');
    return s.slice(0, 64);
}

/**
 * 把具体 via 归到候选族：uia / ocr / coord / vision。
 * 例：uia-invoke→uia，uia-coord-fallback→coord，ocr→template→ocr，som→coord。
 * 认不出的 via 返回 ''（不记账 —— 宁可不学，也不把未知通道混进排序）。
 */
function viaFamily(via) {
    const v = String(via == null ? '' : via).trim().toLowerCase();
    if (!v) return '';
    if (v.startsWith('uia')) return /coord/.test(v) ? 'coord' : 'uia';
    if (v.includes('ocr')) return 'ocr';
    if (v === 'som' || v.startsWith('som') || v.includes('coord')) return 'coord';
    if (v === 'visual' || v.startsWith('vision')) return 'vision';
    return '';
}

function emptyVia() {
    return { tries: 0, ok: 0, vTrue: 0, vFalse: 0, vNull: 0, failStreak: 0, lastAt: 0, lastFailAt: 0 };
}

function emptyApp(now) {
    return { vias: {}, degraded: 0, resets: 0, lastAt: now || 0, lastResetAt: 0, lastDegradedAt: 0, lastDegradedVia: '' };
}

/** 单条通道的观测值（纯函数，stats/prefer 共用同一口径）。 */
function viaMetrics(rec) {
    const r = rec || emptyVia();
    const tries = Number(r.tries) || 0;
    const ok = Number(r.ok) || 0;
    const vTrue = Number(r.vTrue) || 0;
    const vFalse = Number(r.vFalse) || 0;
    const vNull = Number(r.vNull) || 0;
    const sentRate = tries > 0 ? ok / tries : 0;
    const verifiedSamples = vTrue + vFalse;
    // 一条 verified 样本都没有时，verifiedRate 退化为 sentRate（不能因为「没验证」就判 0 分）
    const verifiedRate = verifiedSamples > 0 ? vTrue / verifiedSamples : sentRate;
    return {
        tries, ok, vTrue, vFalse, vNull,
        sentRate,
        verifiedRate,
        // 排序分：发出去 & 真的生效各占一半。只发出去不生效的通道不该排第一。
        score: tries > 0 ? (sentRate + verifiedRate) / 2 : 0,
        failStreak: Number(r.failStreak) || 0,
        lastAt: Number(r.lastAt) || 0,
        lastFailAt: Number(r.lastFailAt) || 0,
    };
}

function clampInt(value, fallback, min, max) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

/** 把脏文件洗成合法结构（未知字段丢弃，计数非负整数）。 */
function sanitizeDoc(raw) {
    const doc = { version: SCHEMA_VERSION, apps: {}, counters: { records: 0, degraded: 0, resets: 0, invalid: 0 } };
    if (!raw || typeof raw !== 'object') return doc;
    const apps = raw.apps && typeof raw.apps === 'object' ? raw.apps : {};
    for (const [key, appRec] of Object.entries(apps)) {
        const k = normalizeApp(key);
        if (!k || !appRec || typeof appRec !== 'object') continue;
        const rec = emptyApp(Number(appRec.lastAt) || 0);
        rec.degraded = Math.max(0, Math.floor(Number(appRec.degraded) || 0));
        rec.resets = Math.max(0, Math.floor(Number(appRec.resets) || 0));
        rec.lastResetAt = Math.max(0, Number(appRec.lastResetAt) || 0);
        rec.lastDegradedAt = Math.max(0, Number(appRec.lastDegradedAt) || 0);
        rec.lastDegradedVia = String(appRec.lastDegradedVia || '').slice(0, 32);
        const vias = appRec.vias && typeof appRec.vias === 'object' ? appRec.vias : {};
        for (const [via, vRec] of Object.entries(vias)) {
            const fam = viaFamily(via) || String(via || '').toLowerCase();
            if (!fam || !vRec || typeof vRec !== 'object') continue;
            const v = emptyVia();
            for (const field of ['tries', 'ok', 'vTrue', 'vFalse', 'vNull']) {
                v[field] = Math.max(0, Math.floor(Number(vRec[field]) || 0));
            }
            // 自愈：ok/tries 与 verified 计数不能互相超出（手改/旧版本留下的矛盾值）
            if (v.ok > v.tries) v.ok = v.tries;
            if (v.vTrue + v.vFalse + v.vNull > v.tries) {
                v.vNull = Math.max(0, v.tries - v.vTrue - v.vFalse);
            }
            v.failStreak = Math.max(0, Math.floor(Number(vRec.failStreak) || 0));
            v.lastAt = Math.max(0, Number(vRec.lastAt) || 0);
            v.lastFailAt = Math.max(0, Number(vRec.lastFailAt) || 0);
            rec.vias[fam] = v;
        }
        doc.apps[k] = rec;
    }
    const c = raw.counters && typeof raw.counters === 'object' ? raw.counters : {};
    for (const field of ['records', 'degraded', 'resets', 'invalid']) {
        doc.counters[field] = Math.max(0, Math.floor(Number(c[field]) || 0));
    }
    return doc;
}

/**
 * 建一个经验路由实例。
 *
 * opts:
 *   file           存储路径（默认 recordFile('route-experience.json')；测试可覆盖）
 *   enabled        默认 true
 *   sampleMin      默认 3
 *   failStreakLimit默认 3
 *   maxApps        默认 200
 *   now            注入时钟（单测用）
 */
function createRouteExperience(opts) {
    const o = opts || {};
    const nowFn = typeof o.now === 'function' ? o.now : () => Date.now();
    const file = o.file ? path.resolve(String(o.file)) : recordFile(FILE_NAME);
    const sampleMin = clampInt(o.sampleMin, DEFAULTS.sampleMin, 1, 1000);
    const failStreakLimit = clampInt(o.failStreakLimit, DEFAULTS.failStreakLimit, 1, 1000);
    const maxApps = clampInt(o.maxApps, DEFAULTS.maxApps, 1, 5000);
    const maxViasPerApp = clampInt(o.maxViasPerApp, DEFAULTS.maxViasPerApp, 2, 64);

    let enabled = o.enabled !== false;
    let doc = null;              // 延迟加载
    let writeWarned = false;

    function ensureLoaded() {
        if (doc) return doc;
        let raw = null;
        try { raw = readJson(file, null); } catch (e) { raw = null; }
        doc = sanitizeDoc(raw);
        return doc;
    }

    function persist() {
        if (!doc) return false;
        try {
            writeJson(file, doc, { pretty: false });
            return true;
        } catch (e) {
            // 写失败不阻塞操控：内存里的经验本轮仍然可用；文件损坏时 json-store 已隔离并拒绝写回
            if (!writeWarned) {
                writeWarned = true;
                try { console.warn('[route-experience] 保存失败（本轮继续用内存经验）：' + (e && e.message || e)); } catch (e2) { /* ignore */ }
            }
            return false;
        }
    }

    /** 淘汰：app 表按 lastAt 保留最新 maxApps 个；每 app 通道保留最新 maxViasPerApp 条。 */
    function prune() {
        const apps = Object.entries(doc.apps);
        if (apps.length > maxApps) {
            apps.sort((a, b) => (Number(a[1].lastAt) || 0) - (Number(b[1].lastAt) || 0));
            const drop = apps.length - maxApps;
            for (let i = 0; i < drop; i += 1) delete doc.apps[apps[i][0]];
        }
        for (const rec of Object.values(doc.apps)) {
            const vias = Object.entries(rec.vias || {});
            if (vias.length <= maxViasPerApp) continue;
            vias.sort((a, b) => (Number(a[1].lastAt) || 0) - (Number(b[1].lastAt) || 0));
            const drop = vias.length - maxViasPerApp;
            for (let i = 0; i < drop; i += 1) delete rec.vias[vias[i][0]];
        }
    }

    function publish() {
        try { globalThis.__routeExperienceStats = stats(); } catch (e) { /* 观测失败不影响操控 */ }
    }

    /** 读 app 记录（不存在返回 null，不创建）。 */
    function appRec(app) {
        const key = normalizeApp(app);
        if (!key) return null;
        return ensureLoaded().apps[key] || null;
    }

    /**
     * 记一次通道结果。**只记账**，不参与本次动作的执行或成败判定。
     * @param {{app:string, via:string, ok?:boolean, verified?:boolean|null, at?:number}} input
     * @returns {null|{recorded:boolean, app:string, via:string, degraded:boolean, failStreak?:number}}
     */
    function record(input) {
        const src = input || {};
        if (!enabled) return null;
        const app = normalizeApp(src.app);
        const fam = viaFamily(src.via);
        if (!app || !fam) {
            ensureLoaded().counters.invalid += 1;
            return null;
        }

        const d = ensureLoaded();
        const t = Number.isFinite(Number(src.at)) && Number(src.at) > 0 ? Number(src.at) : nowFn();
        const ok = src.ok === true;
        const verified = src.verified === true ? true : (src.verified === false ? false : null);

        const rec = d.apps[app] || (d.apps[app] = emptyApp(t));
        rec.lastAt = t;
        const v = rec.vias[fam] || (rec.vias[fam] = emptyVia());
        v.lastAt = t;
        v.tries += 1;
        if (ok) v.ok += 1;
        if (verified === true) v.vTrue += 1;
        else if (verified === false) v.vFalse += 1;
        else v.vNull += 1;

        // 失败口径：没发出去（ok !== true）或发出去了但验证不通过（verified=false）。
        // verified=null（无法验证）不算失败，避免把「没加验证的动作」误判成坏通道。
        const failed = (ok !== true) || (verified === false);
        let degraded = false;
        if (failed) {
            v.failStreak += 1;
            v.lastFailAt = t;
            if (v.failStreak >= failStreakLimit) {
                // 连续失败：这个 app 的经验作废，回到默认顺序；degraded 计数留痕。
                const keepDegraded = rec.degraded + 1;
                const keepResets = rec.resets + 1;
                d.apps[app] = emptyApp(t);
                d.apps[app].degraded = keepDegraded;
                d.apps[app].resets = keepResets;
                d.apps[app].lastResetAt = t;
                d.apps[app].lastDegradedAt = t;
                d.apps[app].lastDegradedVia = fam;
                d.counters.resets += 1;
                d.counters.degraded += 1;
                degraded = true;
            }
        } else {
            v.failStreak = 0;
        }

        d.counters.records += 1;
        prune();
        persist();
        publish();
        return {
            recorded: true,
            app,
            via: fam,
            degraded,
            failStreak: degraded ? 0 : (failed ? v.failStreak : 0),
        };
    }

    /**
     * 重排候选通道。未达到样本门槛的通道**保持原位置**，只对已有 ≥sampleMin 样本的
     * 通道按 score 降序交换 —— 这就是「样本 <3 保持原序」。
     * @param {{app:string, candidates:string[]}} input
     * @returns {string[]} 新数组（入参不被修改）
     */
    function prefer(input) {
        const src = input || {};
        const list = Array.isArray(src.candidates)
            ? src.candidates.map((c) => String(c == null ? '' : c)).filter(Boolean)
            : [];
        const origin = list.slice();
        if (!list.length || !enabled) return origin;

        const rec = appRec(src.app);
        if (!rec) return origin;

        // 候选 → 族。保留原始下标（不去重：去重会让 slots 与输出下标错位，
        // 调用方若真传了重复项，按重复项各自的位置参与排序即可）。
        const pairs = list.map((name, idx) => {
            const fam = viaFamily(name) || name.toLowerCase();
            const metrics = rec.vias[fam] ? viaMetrics(rec.vias[fam]) : null;
            return { name, fam, idx, metrics, eligible: !!(metrics && metrics.tries >= sampleMin) };
        });
        const eligible = pairs.filter((p) => p.eligible);
        if (eligible.length < 2) return origin;

        const slots = [];
        pairs.forEach((p, i) => { if (p.eligible) slots.push(i); });
        const ranked = eligible.slice().sort((a, b) => (b.metrics.score - a.metrics.score) || (a.idx - b.idx));
        const out = list.slice();
        // 只把合格项填回它们原本占据的位置 → 不合格项的位置完全不动
        slots.forEach((slot, k) => { out[slot] = ranked[k].name; });
        return out;
    }

    /** 手动回默认顺序（不动 degraded 计数，区别于连续失败触发的降级）。 */
    function reset(app) {
        if (!enabled) return false;
        const key = normalizeApp(app);
        if (!key) return false;
        const d = ensureLoaded();
        const rec = d.apps[key];
        if (!rec) return false;
        d.apps[key] = emptyApp(nowFn());
        d.apps[key].degraded = rec.degraded;
        d.apps[key].resets = rec.resets + 1;
        d.apps[key].lastResetAt = nowFn();
        d.counters.resets += 1;
        persist();
        publish();
        return true;
    }

    /** 清空全部经验（保留 degraded/resets 之外的一切都归零）。 */
    function resetAll() {
        if (!enabled) return false;
        const d = ensureLoaded();
        d.apps = {};
        d.counters = { records: 0, degraded: 0, resets: 0, invalid: 0 };
        persist();
        publish();
        return true;
    }

    /** 可观测快照：每 app 每通道的成功率、失败连击、降级次数。 */
    function stats() {
        const d = ensureLoaded();
        const apps = {};
        let tries = 0, ok = 0, vTrue = 0, vFalse = 0, vNull = 0;
        for (const [app, rec] of Object.entries(d.apps)) {
            const vias = {};
            for (const [via, vRec] of Object.entries(rec.vias || {})) {
                const m = viaMetrics(vRec);
                vias[via] = m;
                tries += m.tries; ok += m.ok; vTrue += m.vTrue; vFalse += m.vFalse; vNull += m.vNull;
            }
            // 「实际会被优先的通道」：只有达到样本门槛的通道才算数，
            // 否则会显示一个 prefer() 根本不会采纳的 1/1 幸运通道。
            let preferred = '';
            let bestScore = -1;
            for (const [via, m] of Object.entries(vias)) {
                if (m.tries < sampleMin) continue;
                if (m.score > bestScore) { bestScore = m.score; preferred = via; }
            }
            apps[app] = {
                vias,
                preferred,
                degraded: Number(rec.degraded) || 0,
                resets: Number(rec.resets) || 0,
                lastAt: Number(rec.lastAt) || 0,
                lastResetAt: Number(rec.lastResetAt) || 0,
                lastDegradedAt: Number(rec.lastDegradedAt) || 0,
                lastDegradedVia: rec.lastDegradedVia || '',
            };
        }
        const sentRate = tries > 0 ? ok / tries : 0;
        const verifiedSamples = vTrue + vFalse;
        const verifiedRate = verifiedSamples > 0 ? vTrue / verifiedSamples : sentRate;
        return {
            enabled,
            sampleMin,
            failStreakLimit,
            file,
            appCount: Object.keys(apps).length,
            counters: Object.assign({}, d.counters),
            overall: {
                tries, ok, vTrue, vFalse, vNull,
                sentRate, verifiedRate,
                score: tries > 0 ? (sentRate + verifiedRate) / 2 : 0,
            },
            apps,
        };
    }

    function setEnabled(v) {
        enabled = v !== false;
        publish();
        return enabled;
    }

    function isEnabled() { return enabled; }

    /** 测试用：丢内存缓存，下次从文件重新加载（文件不动）。 */
    function __resetForTests() {
        doc = null;
        writeWarned = false;
    }

    publish();
    return {
        record,
        prefer,
        reset,
        resetAll,
        stats,
        setEnabled,
        isEnabled,
        file,
        __resetForTests,
    };
}

const singleton = createRouteExperience();

module.exports = Object.assign({
    createRouteExperience,
    normalizeApp,
    viaFamily,
    viaMetrics,
    sanitizeDoc,
    FILE_NAME,
    DEFAULTS,
}, singleton);
