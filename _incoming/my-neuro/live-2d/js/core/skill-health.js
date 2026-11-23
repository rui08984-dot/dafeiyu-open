// skill-health.js —— 技能生命周期（E7，2026-11-22）
//
// 为什么需要：
//   技能库现在只会「存/跑/删」。一个技能如果因为界面改版连续失败，她每次还是会
//   照原样重试 —— 连败 5 次和连败 1 次没有任何行为差别；60 天没用的老技能也和新
//   技能一样被优先选。这里的生命周期就是给技能加「健康档案」：
//
//     active       正常
//     dormant      连续失败 ≥3 或 60 天未用 —— **只是降权/标记，不删**
//     quarantined  连续失败 ≥5 —— 调用时拒绝并给出原因，需显式 --revive
//
// 数据来源（两层，互为补充）：
//   ① 执行档案 `<pet-runtime>/data/dispatch-history.jsonl`（skill-library 写的，
//      滚动 500 条）→ 按动作 / skill_run 聚合 {tries, ok, verifiedRate, lastUsedAt,
//      consecutiveFails}。重启后仍能算，但会被滚动窗口截断。
//   ② 本模块的账本 `skill-health.json` → 技能级累计（tries/ok/连败/复活记录），
//      不受历史窗口影响。记账发生在每次 skill run 之后。
//
// 隔离：
//   `PET_DATA_ROOT` 设了就把两个文件都指到该目录（测试用；生产不设时路径不变）。
//
// 可观测：
//   `globalThis.__skillHealthStats` / `window.__skillHealthStats`（doctor / 探针可读）。
//   只读工具动作 `skill health` 在 dispatch 的 skill 工具里（没有新增工具名）。

'use strict';
const fs = require('fs');
const path = require('path');
const jsonStore = require('./json-store.js');

const DAY_MS = 24 * 3600 * 1000;

// 阈值（提案原文：dormant 连败 ≥3 或 60 天未用；quarantined 连败 ≥5）
const DEFAULTS = Object.freeze({
    dormantAfterFails: 3,
    quarantineAfterFails: 5,
    dormantAfterDays: 60,
});

const HISTORY_MAX = 500;

function findRoot(start, marker) {
    let dir = start || __dirname;
    for (let i = 0; i < 12; i += 1) {
        const cand = path.join(dir, ...marker);
        if (fs.existsSync(cand)) return cand;
        const up = path.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

/** 数据目录：PET_DATA_ROOT 优先（测试隔离）；否则 <repo>/pet-runtime/data。 */
function dataDir() {
    if (process.env.PET_DATA_ROOT) return path.resolve(process.env.PET_DATA_ROOT);
    const rt = findRoot(__dirname, ['pet-runtime']);
    return rt ? path.join(rt, 'data') : path.join(__dirname, '..', '..', 'data');
}

function historyFile() { return path.join(dataDir(), 'dispatch-history.jsonl'); }
function healthFile() { return path.join(dataDir(), 'skill-health.json'); }

function round3(n) { return Math.round(Number(n) * 1000) / 1000; }
function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

// ── 执行档案 ─────────────────────────────────────────────────────────

/**
 * 读 dispatch-history.jsonl（按时间升序返回；坏行跳过，不因一行坏掉整份历史）。
 * @param {number} [limit=500]
 */
function readHistoryRows(limit = HISTORY_MAX) {
    const f = historyFile();
    try {
        if (!fs.existsSync(f)) return [];
        const rows = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
        const n = num(limit) || HISTORY_MAX;
        return rows.length > n ? rows.slice(-n) : rows;
    } catch (e) {
        return [];
    }
}

function _blankStats() {
    return {
        tries: 0, ok: 0,
        verifiedOk: 0, verifiedKnown: 0, verifiedRate: null,
        lastUsedAt: 0, lastOkAt: 0, lastFailAt: 0,
        consecutiveFails: 0, lastError: '',
    };
}

function _bump(map, key, row, ts) {
    if (!key) return;
    const s = map[key] || (map[key] = _blankStats());
    const ok = row.ok === true || row.effect === 'confirmed_idempotent';
    const fail = row.ok === false;
    s.tries += 1;
    if (ok) { s.ok += 1; s.consecutiveFails = 0; s.lastOkAt = ts || s.lastOkAt; }
    else if (fail) { s.consecutiveFails += 1; s.lastFailAt = ts || s.lastFailAt; }
    // neutral（ok 缺失）不重置连败，也不 +1 —— 「不知道」不能当成功
    // ⚠ verifiedRate 的口径是「被验证为成功的比例」（verified===true 且 ok），
    //   不是「有多少次跑出了结论」：契约里 failed 也是 verified:true（确认没成），
    //   用它当分母会得到「验证率 100% / 成功 0 次」这种自相矛盾的展示。
    if (row.verified === true && ok) s.verifiedOk += 1;
    if (row.verified === true || row.verified === false) s.verifiedKnown += 1;
    if (ts > s.lastUsedAt) s.lastUsedAt = ts;
    if (fail && row.detail) s.lastError = String(row.detail).slice(0, 200);
    s.verifiedRate = s.tries ? round3(s.verifiedOk / s.tries) : null;
}

/**
 * 纯函数：从历史行按「动作」和「技能」聚合健康统计。
 * 不读盘、不看阈值 —— 可直接单测。
 * @param {Array} rows 历史行（ts/action/arg/ok/verified/effect）
 * @returns {{actions:Object<string,object>, skills:Object<string,object>}}
 */
function statsFromHistory(rows) {
    const actions = {};
    const skills = {};
    const sorted = (Array.isArray(rows) ? rows.slice() : [])
        .filter((r) => r && typeof r === 'object')
        .sort((a, b) => num(a.ts) - num(b.ts));
    for (const row of sorted) {
        const action = String(row.action || '').trim();
        if (!action) continue;
        const ts = num(row.ts);
        _bump(actions, action, row, ts);
        // 技能级：skill-library.runSkill 记的 action=skill_run（旧数据可能有 action=skill）
        if (action === 'skill_run' || action === 'skill') {
            const name = String(row.arg || '').trim();
            if (name) _bump(skills, name, row, ts);
        }
    }
    return { actions, skills };
}

// ── 生命周期（纯函数）────────────────────────────────────────────────

/**
 * 按统计数据判定生命周期。**绝不删除数据**，只给状态与原因。
 * @param {{consecutiveFails?:number,lastUsedAt?:number,forcedState?:string|null}} stats
 * @param {{now?:number, thresholds?:object}} [opts]
 * @returns {{state:'active'|'dormant'|'quarantined', reason:string, consecutiveFails:number, idleDays:number|null, thresholds:object}}
 */
function lifecycleOf(stats, opts = {}) {
    const s = stats || {};
    const th = Object.assign({}, DEFAULTS, opts.thresholds || {});
    const now = num(opts.now) || Date.now();
    const fails = num(s.consecutiveFails);
    const last = num(s.lastUsedAt);
    const idleDays = last ? Math.floor(Math.max(0, now - last) / DAY_MS) : null;
    const base = { consecutiveFails: fails, idleDays, thresholds: th };

    if (s.forcedState === 'quarantined') {
        return Object.assign({ state: 'quarantined', reason: '被显式隔离' }, base);
    }
    if (fails >= th.quarantineAfterFails) {
        return Object.assign({ state: 'quarantined', reason: '连续失败 ' + fails + ' 次 ≥ ' + th.quarantineAfterFails + '（需显式复活）' }, base);
    }
    if (s.forcedState === 'dormant') {
        return Object.assign({ state: 'dormant', reason: '被显式降为休眠' }, base);
    }
    if (fails >= th.dormantAfterFails) {
        return Object.assign({ state: 'dormant', reason: '连续失败 ' + fails + ' 次 ≥ ' + th.dormantAfterFails + '（降权，不删除）' }, base);
    }
    if (idleDays !== null && idleDays >= th.dormantAfterDays) {
        return Object.assign({ state: 'dormant', reason: idleDays + ' 天未使用 ≥ ' + th.dormantAfterDays + '（降权，不删除）' }, base);
    }
    return Object.assign({ state: 'active', reason: '正常' }, base);
}

// ── 账本（技能级累计）────────────────────────────────────────────────

function _emptyLedger() { return { version: 1, entries: {} }; }

function loadLedger() {
    const f = healthFile();
    try {
        if (!fs.existsSync(f)) return _emptyLedger();
        const d = jsonStore.readJson(f, null);
        if (!d || typeof d !== 'object' || !d.entries || typeof d.entries !== 'object' || Array.isArray(d.entries)) {
            return _emptyLedger();
        }
        return d;
    } catch (e) {
        return _emptyLedger();
    }
}

function saveLedger(db) {
    jsonStore.writeJson(healthFile(), db);
    return { ok: true };
}

function keyOf(name, kind) { return (kind === 'action' ? 'action:' : 'skill:') + name; }

function _ensureEntry(db, name, kind) {
    const key = keyOf(name, kind);
    let e = db.entries[key];
    if (!e || typeof e !== 'object') {
        e = Object.assign({ key, kind: kind || 'skill', name }, _blankStats(), {
            createdAt: Date.now(), forcedState: null, state: 'active', stateAt: Date.now(),
        });
        db.entries[key] = e;
    }
    return e;
}

/**
 * 记一次执行（技能/动作）。
 * 语义：
 *   result.ok === false → 计一次失败（连败 +1）
 *   result.ok === true  → 计一次成功（连败清零）
 *   其它（缺 ok）       → 只算「试过」，连败保持（不知道 ≠ 成功）
 *
 * @param {string} name 技能名或动作名
 * @param {object} result 契约对象（ok / verified / effect / detail）
 * @param {{kind?:'skill'|'action', ts?:number}} [opts]
 * @returns {{ok:boolean, entry?:object, health?:object, error?:string}}
 */
function recordAttempt(name, result, opts = {}) {
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: '名字不能为空' };
    const kind = opts.kind === 'action' ? 'action' : 'skill';
    const ts = num(opts.ts) || Date.now();
    const db = loadLedger();
    const e = _ensureEntry(db, nm, kind);
    const r = result || {};
    const ok = r.ok === true;
    const fail = r.ok === false;

    e.tries = num(e.tries) + 1;
    if (ok) {
        e.ok = num(e.ok) + 1;
        e.consecutiveFails = 0;
        e.lastOkAt = ts;
    } else if (fail) {
        e.consecutiveFails = num(e.consecutiveFails) + 1;
        e.lastFailAt = ts;
        e.lastError = String(r.detail || r.error || '').slice(0, 200);
    }
    if (r.verified === true && ok) e.verifiedOk = num(e.verifiedOk) + 1;
    if (r.verified === true || r.verified === false) e.verifiedKnown = num(e.verifiedKnown) + 1;
    e.verifiedRate = num(e.tries) ? round3(num(e.verifiedOk) / num(e.tries)) : null;
    e.lastUsedAt = ts;
    e.updatedAt = ts;

    const lc = lifecycleOf(e, { now: ts });
    if (e.state !== lc.state) e.stateAt = ts;
    e.state = lc.state;
    e.stateReason = lc.reason;

    try {
        saveLedger(db);
    } catch (err) {
        // 写盘失败不能影响执行主链；把状态返回给调用方，让它知道「这次没记上」
        publishStats();
        return { ok: false, error: '写入失败：' + (err && err.message || err), entry: e, health: lc };
    }
    publishStats();
    return { ok: true, entry: e, health: lc };
}

/**
 * 查一个技能的生命周期（账本优先；没有账本时退回历史统计；都没有 → active）。
 * @param {string} name
 * @param {{now?:number, thresholds?:object}} [opts]
 */
function lifecycleFor(name, opts = {}) {
    const nm = String(name || '').trim();
    if (!nm) return Object.assign({ state: 'active', reason: '空名字' }, lifecycleOf({}, opts));
    const db = loadLedger();
    const e = db.entries[keyOf(nm, 'skill')];
    if (e) return lifecycleOf(e, opts);
    const hist = statsFromHistory(readHistoryRows(HISTORY_MAX)).skills[nm];
    if (hist) return lifecycleOf(hist, opts);
    return Object.assign({ state: 'active', reason: '还没有执行记录' }, lifecycleOf({}, opts));
}

/**
 * 执行前闸门：quarantined 拒绝；dormant 放行但标记降权。
 * @returns {{allowed:boolean,state:string,reason:string,dormant:boolean,nextIfFailed?:string}}
 */
function canRun(name, opts = {}) {
    const h = lifecycleFor(name, opts);
    if (h.state === 'quarantined') {
        return {
            allowed: false, state: h.state, reason: h.reason, dormant: false,
            nextIfFailed: '技能「' + name + '」已隔离（' + h.reason + '）。确认修好后显式复活：skill health --revive ' + name,
        };
    }
    return { allowed: true, state: h.state, reason: h.reason, dormant: h.state === 'dormant' };
}

/** 显式复活：连败清零、解除显式隔离/休眠。保留历史计数（不删数据）。 */
function revive(name, opts = {}) {
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: '要复活哪个技能' };
    const ts = num(opts.now) || Date.now();
    const db = loadLedger();
    const e = _ensureEntry(db, nm, 'skill');
    e.forcedState = null;
    e.consecutiveFails = 0;
    e.state = 'active';
    e.stateReason = '手动复活';
    e.revivedAt = ts;
    e.stateAt = ts;
    e.updatedAt = ts;
    try { saveLedger(db); } catch (err) { return { ok: false, error: '写入失败：' + (err && err.message || err) }; }
    publishStats();
    return { ok: true, entry: e, health: lifecycleOf(e, { now: ts }) };
}

/** 显式隔离/休眠（运维用）。state='active' 等价于 revive 但保留连败计数。 */
function forceState(name, state, opts = {}) {
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: '要设置哪个技能' };
    const st = String(state || '').toLowerCase();
    if (!['active', 'dormant', 'quarantined'].includes(st)) {
        return { ok: false, error: 'state 只能是 active / dormant / quarantined' };
    }
    const ts = num(opts.now) || Date.now();
    const db = loadLedger();
    const e = _ensureEntry(db, nm, 'skill');
    e.forcedState = st === 'active' ? null : st;
    e.state = st;
    e.stateReason = st === 'active' ? '手动恢复' : '手动标记为 ' + st;
    e.stateAt = ts;
    e.updatedAt = ts;
    try { saveLedger(db); } catch (err) { return { ok: false, error: '写入失败：' + (err && err.message || err) }; }
    publishStats();
    return { ok: true, entry: e, health: lifecycleOf(e, { now: ts }) };
}

// ── 报告 / 可观测 ───────────────────────────────────────────────────

function _statsWithState(stats, opts) {
    const base = stats || _blankStats();
    const lc = lifecycleOf(base, opts);
    return Object.assign({}, base, {
        state: lc.state, stateReason: lc.reason, idleDays: lc.idleDays,
    });
}

/**
 * 全量健康报告（`skill health` 与 window.__skillHealthStats 共用）。
 * @param {{skillNames?:string[], now?:number, historyLimit?:number}} [opts]
 */
function getHealth(opts = {}) {
    const now = num(opts.now) || Date.now();
    const hist = statsFromHistory(readHistoryRows(num(opts.historyLimit) || HISTORY_MAX));
    const db = loadLedger();
    const skills = {};

    // ① 历史里能看到的技能（skill_run 行）
    for (const [name, s] of Object.entries(hist.skills)) {
        skills[name] = Object.assign({ name, source: 'history' }, s);
    }
    // ② 账本覆盖/补齐（更持久；连败以账本为准）
    for (const [key, e] of Object.entries(db.entries || {})) {
        if (!e || e.kind !== 'skill') continue;
        const name = String(e.name || key.replace(/^skill:/, ''));
        const h = skills[name];
        const merged = Object.assign({ name, source: 'ledger' }, h || _blankStats());
        merged.tries = Math.max(num(merged.tries), num(e.tries));
        merged.ok = Math.max(num(merged.ok), num(e.ok));
        merged.verifiedOk = Math.max(num(merged.verifiedOk), num(e.verifiedOk));
        merged.verifiedKnown = Math.max(num(merged.verifiedKnown), num(e.verifiedKnown));
        merged.verifiedRate = merged.tries ? round3(num(merged.verifiedOk) / num(merged.tries)) : null;
        merged.consecutiveFails = num(e.consecutiveFails);
        merged.lastUsedAt = Math.max(num(merged.lastUsedAt), num(e.lastUsedAt));
        merged.lastError = e.lastError || merged.lastError || '';
        merged.forcedState = e.forcedState || null;
        merged.revivedAt = e.revivedAt || null;
        skills[name] = merged;
    }
    // ③ 技能库里存在但从未跑过的（由调用方传名字）
    for (const name of Array.isArray(opts.skillNames) ? opts.skillNames : []) {
        const nm = String(name || '').trim();
        if (!nm) continue;
        if (!skills[nm]) skills[nm] = Object.assign({ name: nm, source: 'library' }, _blankStats());
    }

    const skillRows = Object.values(skills).map((s) => _statsWithState(s, { now }))
        .sort((a, b) => {
            const rank = { quarantined: 0, dormant: 1, active: 2 };
            const d = (rank[a.state] ?? 3) - (rank[b.state] ?? 3);
            return d !== 0 ? d : String(a.name).localeCompare(String(b.name));
        });

    const actionRows = Object.entries(hist.actions).map(([action, s]) =>
        Object.assign({ action }, _statsWithState(s, { now })))
        .sort((a, b) => b.tries - a.tries || a.action.localeCompare(b.action));

    return {
        at: now,
        thresholds: Object.assign({}, DEFAULTS),
        skills: skillRows,
        actions: actionRows,
        counts: {
            skills: skillRows.length,
            actions: actionRows.length,
            quarantined: skillRows.filter((s) => s.state === 'quarantined').length,
            dormant: skillRows.filter((s) => s.state === 'dormant').length,
        },
        files: { history: historyFile(), ledger: healthFile() },
    };
}

/** 把最新报告挂到 globalThis/window（doctor/探针可读）。失败绝不影响主链。 */
function publishStats(opts = {}) {
    let snapshot;
    try { snapshot = getHealth(opts); } catch (e) { snapshot = { at: Date.now(), error: String(e && e.message || e) }; }
    try { if (typeof globalThis !== 'undefined') globalThis.__skillHealthStats = snapshot; } catch (e) { /* ignore */ }
    try { if (typeof window !== 'undefined') window.__skillHealthStats = snapshot; } catch (e) { /* ignore */ }
    return snapshot;
}

// 模块加载即发布一次（探针无需先触发记账就能读到）
try { publishStats(); } catch (e) { /* ignore */ }

module.exports = {
    DEFAULTS,
    dataDir, historyFile, healthFile,
    readHistoryRows, statsFromHistory,
    lifecycleOf, lifecycleFor, canRun,
    recordAttempt, revive, forceState,
    getHealth, publishStats,
};
