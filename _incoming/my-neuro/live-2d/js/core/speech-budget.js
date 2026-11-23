/**
 * speech-budget.js —— 主动说话的预算与结果反馈（2026-11-15 五十九轮）
 *
 * 为什么要有：现在的闸只有「最小间隔 + 静默 + 优先级」——它能防「连说三段」，
 * 但防不了「一天下来太吵」，更不知道**她开口之后你是理了还是烦了**。
 * 调研（Ask Less, Ask Better, 2610.24411）实测：给打断加预算，成本降 36–73%，
 * 而收益保留 86–94%；再把「用户答过的」记住还能再降 13%。
 *
 * 机制：
 *   · **成本**而不是条数：普通 1、游戏里 +2、深夜 +1、上一次被忽略 +1（最高 3）
 *     —— 深夜/游戏中/刚被冷落时开口更「贵」，自然更克制
 *   · **日预算**（默认 20 个单位，本地日切分；2026-11-22 用户拍板从 8 上调），
 *     超了直接拒并说明原因
 *   · **结果反馈**：每次开口开一个 90 秒窗口，窗口内用户说话了 = accepted；
 *     窗口过了没说话 = ignored；用户说的是「别说了/烦」这类 = negative
 *   · 按来源统计接受率（只记录，不自动调价 —— 先有数据再谈自适应）
 *
 * 数据落在 data/主动日志.json（可被 doctor/看板读）。
 * 开关：data/主动预算.json 里 {"enabled": false} 可整体关掉；
 *      {"daily_limit": 12} 调整额度。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');

const LOG_FILE = '主动日志.json';
const CFG_FILE = '主动预算.json';
const WINDOW_MS = 90000;          // 开口后多久内算「他在回应」
const NEGATIVE_RE = /(别说了|闭嘴|安静|烦(?!恼)|不要说话|少说|停一下|不用你说|别吵)/;
// watching：在看视频时开口要更贵一点（但没游戏那么贵）—— 2026-11-17 六十五轮，接世界感知
const COST = { base: 1, game: 2, watching: 1, night: 1, ignoredLast: 1, max: 3 };
// 2026-11-22 拍板：默认日预算 8 → 20。理由：静默总闸改成「缺省不静默」后，
// 主动开口的主要护栏不再是「默认闭嘴」，而是这张预算表 + 活动窗 + 最小间隔。
const DEFAULT_DAILY_LIMIT = 20;

function dayKey(now) {
    const d = new Date(now);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

class SpeechBudget {
    constructor(opts) {
        const o = opts || {};
        this._logFile = o.logFile || recordFile(LOG_FILE);
        this._cfgFile = o.cfgFile || recordFile(CFG_FILE);
        this._now = o.now || (() => Date.now());
        this._enabled = true;
        this._dailyLimit = DEFAULT_DAILY_LIMIT;
        this._adaptive = o.adaptive !== false;
        this._loadCfg();
        this._state = this._load();
        this._timer = setInterval(() => { this.tick(); }, 15000);
        if (this._timer.unref) this._timer.unref();
    }

    _loadCfg() {
        try {
            const j = JSON.parse(fs.readFileSync(this._cfgFile, 'utf8'));
            if (j && j.enabled === false) this._enabled = false;
            const n = Number(j && j.daily_limit);
            if (Number.isFinite(n) && n > 0) this._dailyLimit = Math.min(50, Math.round(n));
        } catch (e) { /* 没有配置文件就用默认 */ }
    }

    /**
     * 重新读配置（D1 每日成绩单的「可撤销调整」需要热生效）。
     * 原来 _loadCfg 只在构造时跑一次：成绩单把 daily_limit 从 8 改成 6 后，
     * 运行中的预算还按 8 算，调整等于没生效。这里先回默认再读，避免
     * 「配置删掉 enabled:false 后仍然关着」的粘滞。
     * @returns {{enabled:boolean, daily_limit:number}}
     */
    reloadConfig() {
        this._enabled = true;
        this._dailyLimit = DEFAULT_DAILY_LIMIT;
        this._loadCfg();
        return { enabled: this._enabled, daily_limit: this._dailyLimit };
    }

    _load() {
        try {
            const j = JSON.parse(fs.readFileSync(this._logFile, 'utf8'));
            return {
                day: j.day || dayKey(this._now()),
                used: Number(j.used) || 0,
                attempts: Array.isArray(j.attempts) ? j.attempts.slice(-200) : [],
                bySource: (j.bySource && typeof j.bySource === 'object') ? j.bySource : {},
            };
        } catch (e) {
            return { day: dayKey(this._now()), used: 0, attempts: [], bySource: {} };
        }
    }

    _save() {
        try {
            fs.mkdirSync(path.dirname(this._logFile), { recursive: true });
            const tmp = this._logFile + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(Object.assign({ updated_at: this._now() }, this._state), null, 2), 'utf8');
            fs.renameSync(tmp, this._logFile);
        } catch (e) { /* 记账失败不该阻塞说话 */ }
    }

    _rollDay() {
        const k = dayKey(this._now());
        if (this._state.day !== k) {
            this._state.day = k;
            this._state.used = 0;
        }
    }

    /** 今天到现在为止「最近一次开口」的结果（用于加价） */
    _lastOutcome() {
        const a = this._state.attempts || [];
        for (let i = a.length - 1; i >= 0; i -= 1) if (a[i].outcome) return a[i].outcome;
        return null;
    }

    /**
     * 按来源的最近接受率给成本加权（2026-11-15 六十轮，调研的「自适应」部分）。
     * 三条护栏，全都为了「别拿两三条数据就改行为」：
     *   · 样本 <20 条 → 不动（宁可不调，也不能凭运气调）
     *   · 只加价不减价（接受率低 → +1；高也只是回到基础价，不给折扣 ——
     *     否则一个话多的来源会越说越便宜，正是「烦人」的来源）
     *   · 结果夹在 1..3（和基础成本同一上限）
     * 开关：构造参数 adaptive:false 可整体关掉。
     */
    _sourceBias(pluginId) {
        if (this._adaptive === false) return 0;
        const src = (this._state.bySource || {})[String(pluginId || '?')];
        if (!src) return 0;
        const n = (Number(src.accepted) || 0) + (Number(src.ignored) || 0) + (Number(src.negative) || 0);
        if (n < 20) return 0;                                  // 样本不足 → 不动
        const good = (Number(src.accepted) || 0) + (Number(src.negative) || 0) * 0;   // 负面不算接受
        const rate = good / n;
        if (rate < 0.3) return 1;                               // 大多数被忽略 → 更贵
        return 0;
    }

    /** 计算这次开口的成本 */
    costOf(offering) {
        const o = offering || {};
        let c = COST.base;
        // 状态从哪来：调用方优先；没给就问 watch-screen 的当前状态（只读一个字段，
        // 不引入依赖 —— 拿不到就当没有，不阻断开
        let st = o.state;
        if (!st) {
            try {
                const pm = global.pluginManager;
                const e = pm && pm._plugins && pm._plugins.get('community/watch-screen');
                // ⚠ 2026-11-17 六十五轮：原来读 `plugin._state`，而 watch-screen 的字段
                //   叫 `_screenState`（{state, what, via, since}）→「游戏 +2」在生产链路
                //   从来没生效过（只有单测里显式传 state 才过）。
                //   这里**只读 `_screenState`**：`_state` 在该插件里根本不存在（grep 确认），
                //   留 fallback 只会在将来掩盖同类错误。
                const s = e && e.plugin && e.plugin._screenState;
                st = (s && (s.kind || s.state)) || '';
            } catch (e) { st = ''; }
        }
        // 世界感知（§62）给的活动状态是更权威的当前情境。它和 watch-screen 可能同时命中，
        // **取更贵的那个、不叠加**（否则「在玩游戏」会被算两次，直接顶到上限）。
        // P0-4：stale 的活动是冻结值（world-sense 暂停/隐私后不再更新）——不能当当前情境，
        // 否则她会永远按「你还在打游戏」加价。ok=false 同样视为无状态。
        let worldActivity = '';
        try {
            const w = typeof globalThis.__worldSenseState === 'function' ? globalThis.__worldSenseState() : null;
            const act = w && w.activity;
            const stale = !w
                || w.ok === false
                || (act && typeof act === 'object' && act.stale === true);
            if (!stale) {
                worldActivity = (act && typeof act === 'object')
                    ? (act.state || act.kind || '')
                    : (act || '');
            }
        } catch (e) { worldActivity = ''; }

        const gameCost = (String(st).indexOf('game') === 0 || worldActivity === 'gaming') ? COST.game : 0;
        const watchCost = (!gameCost && worldActivity === 'watching') ? COST.watching : 0;
        c += Math.max(gameCost, watchCost);
        const h = new Date(this._now()).getHours();
        if (h >= 23 || h < 7) c += COST.night;
        if (this._lastOutcome() === 'ignored') c += COST.ignoredLast;
        c += this._sourceBias(o.pluginId);
        return Math.min(COST.max, c);
    }

    /**
     * 申请一次主动开口。
     * @returns {{allowed:boolean, attemptId:string|null, cost:number, used:number, limit:number, reason:string}}
     */
    request(pluginId, offering) {
        this._rollDay();
        if (!this._enabled) return { allowed: true, attemptId: null, cost: 0, used: this._state.used, limit: this._dailyLimit, reason: '预算已关闭' };
        const cost = this.costOf(Object.assign({}, offering || {}, { pluginId }));
        const used = this._state.used;
        if (used + cost > this._dailyLimit) {
            return {
                allowed: false, attemptId: null, cost, used, limit: this._dailyLimit,
                reason: '今日主动预算已用 ' + used + '/' + this._dailyLimit + '（这次要 ' + cost + '）',
            };
        }
        const attemptId = 'a' + this._now().toString(36) + Math.random().toString(36).slice(2, 5);
        this._state.used = used + cost;
        this._state.attempts.push({
            id: attemptId, at: this._now(), plugin: String(pluginId || '?'),
            state: (offering && offering.state) || '', cost, outcome: null, outcomeAt: null,
            // 2026-11-22：申请≠说出口。noteSpoken 之后才是 true（见方法注释）。
            spoke: false, spokeAt: null,
        });
        if (this._state.attempts.length > 200) this._state.attempts = this._state.attempts.slice(-200);
        this._save();
        return { allowed: true, attemptId, at: this._now(), cost, used: this._state.used, limit: this._dailyLimit, reason: '预算允许' };
    }

    /**
     * 记「这次真的说出口了」（2026-11-22）。
     *
     * 为什么需要：request() 只代表「申请到了额度」，生成失败/空回复/被中断时
     * 这条 attempt 仍然躺在日志里。用户排查「她到底主动说过没有」时，
     * 只看 attempts 会把「申请过」误读成「说过」。发起者在确认回复非空后再调这里。
     *
     * @param {string} pluginId 来源
     * @param {string|null} attemptId request() 返回的 id；没有就退化为该来源最近一条未标
     * @param {number} [textLen] 说了多少字（只存长度，不存内容）
     */
    noteSpoken(pluginId, attemptId, textLen) {
        const list = this._state.attempts || [];
        let a = attemptId ? list.find((x) => x.id === attemptId) : null;
        if (!a) {
            // 只认「最近一条同来源 attempt」，且必须在 5 分钟内、还没标过。
            // 不往回翻旧记录：markSpoken 现在会在中央补记一次（watch-screen 自己也会显式记），
            // 如果允许回溯，第二次调用会把更早的失败 attempt 误标成「说出口了」。
            const last = list[list.length - 1];
            const samePlugin = last && last.plugin === String(pluginId || '?');
            if (samePlugin && last.spoke !== true && this._now() - Number(last.at || 0) <= 5 * 60 * 1000) {
                a = last;
            }
        }
        if (!a || a.spoke === true) return false;
        a.spoke = true;
        a.spokeAt = this._now();
        if (Number.isFinite(Number(textLen)) && Number(textLen) > 0) a.said_len = Math.round(Number(textLen));
        this._save();
        return true;
    }

    /** 记一次结果（accepted / ignored / negative） */
    record(attemptId, outcome) {
        const a = (this._state.attempts || []).find((x) => x.id === attemptId);
        if (!a || a.outcome) return false;
        a.outcome = outcome;
        a.outcomeAt = this._now();
        const key = a.plugin || '?';
        const s = (this._state.bySource[key] = this._state.bySource[key] || { allowed: 0, accepted: 0, ignored: 0, negative: 0 });
        s.allowed += 1;
        if (outcome === 'accepted') s.accepted += 1;
        else if (outcome === 'negative') s.negative += 1;
        else s.ignored += 1;
        this._save();
        return true;
    }

    /**
     * 到期结算（每 15s 一次）：90 秒窗口过了还没开口机会的，判 ignored；
     * 窗口内用户说过话 = accepted；说的话是「烦/别说了」= negative。
     * 依赖 InputRouter 维护的全局时间戳（没有就当 ignored）。
     */
    tick() {
        this._rollDay();
        const now = this._now();
        const lastUserAt = Number(global.__lastUserInputAt) || 0;
        const lastUserText = String(global.__lastUserText || '');
        for (const a of (this._state.attempts || [])) {
            if (a.outcome) continue;
            if (now - a.at < WINDOW_MS) continue;
            if (lastUserAt > a.at && lastUserAt <= a.at + WINDOW_MS) {
                this.record(a.id, NEGATIVE_RE.test(lastUserText) ? 'negative' : 'accepted');
            } else {
                this.record(a.id, 'ignored');
            }
        }
    }

    stats() {
        this._rollDay();
        const attempts = this._state.attempts || [];
        const today = attempts.filter((a) => a.at >= new Date(this._state.day + 'T00:00:00').getTime());
        const judged = today.filter((a) => a.outcome);
        const acc = judged.filter((a) => a.outcome === 'accepted').length;
        const neg = judged.filter((a) => a.outcome === 'negative').length;
        const ign = judged.filter((a) => a.outcome === 'ignored').length;
        return {
            enabled: this._enabled,
            day: this._state.day,
            used: this._state.used,
            limit: this._dailyLimit,
            today_attempts: today.length,
            spoken_today: today.filter((a) => a.spoke === true).length,
            accepted: acc, ignored: ign, negative: neg,
            accept_rate: judged.length ? +(acc / judged.length).toFixed(2) : null,
            // 烦人指数（调研给的公式）：忽略率×条数 + 负面率×3
            annoy_index: judged.length ? +(((ign / judged.length) * today.length) + (neg / judged.length) * 3).toFixed(2) : null,
            bySource: this._state.bySource,
        };
    }
}

let _singleton = null;
function singleton(opts) {
    if (!_singleton) _singleton = new SpeechBudget(opts);
    return _singleton;
}

/**
 * 重载已存在的单例配置；没有单例时返回 null（不凭空创建一个带定时器的实例）。
 * 每日成绩单应用/撤销调整后调它，让 daily_limit 立刻生效。
 */
function reloadSingleton() {
    if (!_singleton) return null;
    return _singleton.reloadConfig();
}

/**
 * 只读运行中的单例；没有单例时返回 null（不凭空创建带定时器的实例）。
 * 每日成绩单用它读「当前额度」——盘上的 daily_limit 可能还没热重载，运行值才是真的。
 */
function peekSingleton() {
    return _singleton;
}

module.exports = {
    SpeechBudget, singleton, reloadSingleton, peekSingleton,
    dayKey, NEGATIVE_RE, WINDOW_MS, DEFAULT_DAILY_LIMIT,
};
