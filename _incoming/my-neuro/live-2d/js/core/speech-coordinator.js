// speech-coordinator.js —— 说话协调器（插件统一协调的收口点，竞品调研 Top3「何时说话的集中决策器」）。
//
// 第一性原理：一个嘴巴（TTS 队列串行）+ N 个发起者（dawn-dusk/watch-screen/live-dock/…）
// + 用户最高优先 + 静默全局闸 + 同一张判据表。之前 9 套自制冷却互不知情，
// 同时触发时她会连说三段像机器 —— 这里收口成一张闸门表。
//
// 用法（发起者在「真要开口」前调一次）：
//   const c = require('../core/speech-coordinator');
//   const gate = c.request('watch-screen', { priority: 'proactive' });
//   if (!gate.allowed) return;            // gate.reason 说明为什么让路
//   ...正常说话（sendMessage / TTS）...
//   c.markSpoken('watch-screen');
//
// 优先级（低数字=高优先）：user 永远放行（不是从这里走的）；critical 关怀 1；
// game 事件 2；danmaku 3；proactive 评论 4；showcase 节目 5；greeting 6。
// 忙碌时高优先**等**低优先播完（不中断，TTS 队列自然排），低优先直接拒。
'use strict';
const __silentAudit = require('./silent-audit.js');

const PRIORITY = { critical: 1, game: 2, danmaku: 3, proactive: 4, showcase: 5, greeting: 6 };
const MIN_GLOBAL_GAP_MS = 20000;   // 全局最小间隔：两次自主发言之间至少 20s（用户发言不计）

class SpeechCoordinator {
    constructor(options = {}) {
        this.minGapMs = options.minGapMs ?? MIN_GLOBAL_GAP_MS;
        this.isBusy = options.isBusy || (() => false);          // TTS 是否在播/队列非空
        this.isQuiet = options.isQuiet || (() => false);
        this._lastSpokenAt = 0;
        this._lastSpokenBy = '';
        this._lastUserTurnAt = 0;                               // 用户这轮开始的时间（userActive 判据）
        this._stats = {};                                       // pluginId -> {allowed, denied, lastAt}
    }

    /** 发起者请求发言权。返回 { allowed, reason, waitMs }。 */
    request(pluginId, opts = {}) {
        const priority = PRIORITY[opts.priority] || PRIORITY.proactive;
        const now = Date.now();
        const st = (this._stats[pluginId] = this._stats[pluginId] || { allowed: 0, denied: 0, lastAt: 0 });

        if (this.isQuiet()) { st.denied += 1; return { allowed: false, reason: '静默模式' }; }

        // 用户这轮还没结束（在处理输入 / 她还在播这句回复 / 刚说完 12 秒内）→ 主动发起者让路。
        // critical（自伤/绝望关怀）不受这条限制：那种话不能等。
        if (priority > 1 && this.userActive()) {
            st.denied += 1;
            return { allowed: false, reason: '用户这轮还没结束（等这句说完）' };
        }

        const since = now - this._lastSpokenAt;
        const busy = this.isBusy();

        if (busy) {
            // 高优先等低优先播完（不中断）；同优先或低优先直接拒
            const lastP = PRIORITY[this._lastPriority] || 9;
            if (priority < lastP) return { allowed: false, reason: '忙碌（有更高优先在说），排队等播完', waitMs: 3000 };
            st.denied += 1;
            return { allowed: false, reason: '忙碌（正在说话）' };
        }

        // 全局最小间隔：用户发言（markUser）不计入；critical 关怀响应不受冷却限制
        //（自伤/绝望的话不能等「再等等」——忙检仍生效，播完立刻说）。
        const gapMs = this.minGapMs * (priority <= 2 ? 0.4 : 1);
        if (since < gapMs && this._lastSpokenAt > 0 && priority > 1) {
            st.denied += 1;
            return { allowed: false, reason: '距上次自主发言仅 ' + Math.round(since / 1000) + 's（最小间隔 ' + Math.round(gapMs / 1000) + 's）', waitMs: gapMs - since };
        }

        // 预算闸（2026-11-15）：最小间隔只能防「连说三段」，防不了「一天下来太吵」。
        // 成本随时段/状态浮动：深夜 +1、游戏里 +2、上次被忽略 +1（最高 3）。
        let budget = null;
        try {
            const { singleton } = require('./speech-budget.js');
            budget = singleton().request(pluginId, { state: opts.state, priority: opts.priority });
            if (!budget.allowed) {
                st.denied += 1;
                return { allowed: false, reason: budget.reason, budget };
            }
        } catch (e) { try { __silentAudit.audit('speech-coordinator.js:budget', e); } catch (e2) {} }

        st.allowed += 1;
        return { allowed: true, reason: 'ok', attemptId: budget ? budget.attemptId : null, budget };
    }

    /** 真开口后由发起者回报（用于间隔与统计）。 */
    markSpoken(pluginId) {
        this._lastSpokenAt = Date.now();
        this._lastSpokenBy = pluginId;
        const st = (this._stats[pluginId] = this._stats[pluginId] || { allowed: 0, denied: 0, lastAt: 0 });
        st.lastAt = this._lastSpokenAt;
        // 2026-11-22 审计 P1-7：主动日志的「真说出口」以前只有 auto-chat 在记 ——
        // watch-screen/alive-state/dawn-dusk 说了也显示 spoke:false。markSpoken 是所有
        // 发起者「确认非空回复后」的唯一共同出口，在这里补记一次就全覆盖。
        // 显式传入 attemptId/长度的调用方（auto-chat/watch-screen）会先记，重复无害。
        try {
            const sb = require('./speech-budget.js').singleton();
            if (sb && typeof sb.noteSpoken === 'function') sb.noteSpoken(pluginId, null, null);
        } catch (e) { /* 记账失败不影响说话 */ }
    }

    /**
     * 拿了令牌但**最终没说**（模型报错 / 返回空 / 被中断）→ 把窗口还回去。
     *
     * 为什么要这个方法（2026-11-09 三十五轮）：
     *   原来 live-dock 是「request 通过 → 立刻 markSpoken → 再去生成」。
     *   生成失败时发言窗口已经被占掉了，接下来一个 minGap 内的弹幕全被让路，
     *   观众看到的就是「她完全不回」。这不是她不想回，是记账记错了。
     *
     * release 的语义：不改变「上次真说话时间」，只回滚这次 request 的 allowed 计数，
     * 让调用方知道「这次没成，不算一次发言」。
     */
    release(pluginId, reason) {
        const st = this._stats[pluginId];
        if (st && st.allowed > 0) st.allowed -= 1;
        // 如果这次就是这个插件占的窗口，清掉它（下次 request 不会被自己的假记录拦住）
        if (this._lastSpokenBy === pluginId) {
            this._lastSpokenAt = 0;
            this._lastSpokenBy = null;
        }
        try {
            this._lastRelease = { pluginId, reason: String(reason || ''), at: Date.now() };
        } catch (e) { /* ignore */ }
        return { ok: true };
    }

    /** 用户说话了：重置间隔（她回完用户后，自主发言的窗口重新打开）。 */
    markUser() {
        this._lastSpokenAt = 0;
        this._lastUserTurnAt = Date.now();
    }

    /**
     * 用户这轮还在进行中（或刚说完不久）：主动发起者应让路。
     * 2026-11-15 六十三轮：原来这里是**恒 false 的占位实现**（`return … && false`），
     * 等于「用户正在说话」这道闸从来没生效过 —— 主动搭话会插进她回复用户的过程中。
     * 现在按三个真实信号判断：正在处理用户输入 / 正在播她这句的回复 / 刚结束的余温窗口。
     */
    userActive(withinMs = 12000) {
        try { if (global.isProcessingUserInput) return true; } catch (e) { /* 拿不到就往下看 */ }
        try {
            const a = global.appState;
            if (a && typeof a.isPlayingTTS === 'function' && a.isPlayingTTS()) return true;
        } catch (e) { /* 同上 */ }
        if (this._lastUserTurnAt && Date.now() - this._lastUserTurnAt < withinMs) return true;
        return false;
    }

    /** 一句/一段说完（TTS 播放结束）：主动发起者可以据此择机，而不是盲等固定时长。 */
    markSentenceEnd() { this._lastSentenceEndAt = Date.now(); }

    /** 上一次说结束的时间（0 = 还没说过）。 */
    lastSentenceEndAt() { return this._lastSentenceEndAt || 0; }

    stats() {
        return { lastSpokenBy: this._lastSpokenBy, lastSpokenAt: this._lastSpokenAt, perPlugin: this._stats };
    }

    /**
     * 人格导演仲裁接口（dawn-dusk-line 的消费端约定：externalSourcePolicy/submitExternal）。
     * 这个约定之前只有消费端没有本体——global.proactiveArbiter 恒 undefined，
     * 节目实际无仲裁直发。现在由协调器单例补上本体：时间协调即仲裁决策。
     * 返回的对象直接挂 global.proactiveArbiter（见 plugin-context.js 尾部）。
     */
    arbiterGlobal() {
        const self = this;
        const PRIORITY_BY_SOURCE = { 'dawn-dusk-line': 'showcase', 'watch-screen': 'proactive', 'live-dock': 'danmaku' };
        return {
            /** 'pass'=放行直发；'block'=现在不许说；'collect'=递交（由消费端走 submitExternal） */
            externalSourcePolicy(sourceId) {
                const priority = PRIORITY_BY_SOURCE[sourceId] || 'proactive';
                const g = self.request(sourceId, { priority });
                if (g.allowed) return 'pass';
                // 忙碌中的高优先来源 → 建议递交（聊天队列会排序），其余一律 block
                if (/更高优先/.test(g.reason) && PRIORITY[priority] <= 2) return 'collect';
                return 'block';
            },
            /** collect 递交：直接进对话队列（人格导演审定过的内容不再二次拦截） */
            async submitExternal(sourceId, text, meta) {
                try {
                    const vc = global.voiceChat;
                    if (vc && typeof vc.handleExternal === 'function') return vc.handleExternal(text, meta);
                    if (global.pluginManager && typeof global.pluginManager.sendMessage === 'function') {
                        return global.pluginManager.sendMessage(text);
                    }
                } catch (e) { try { __silentAudit.audit('speech-coordinator.js:114', e); } catch (e2) {} }
                return null;
            },
        };
    }
}

// 单例（所有插件共享同一张闸门表）
const singleton = new SpeechCoordinator();
singleton.arbiterGlobal = singleton.arbiterGlobal.bind(singleton);
module.exports = { SpeechCoordinator, PRIORITY, MIN_GLOBAL_GAP_MS, singleton,
                   /** 便捷：拿单例并注入 busy/quiet 判据 */
                   get: (opts) => Object.assign(singleton, opts || {}) };
