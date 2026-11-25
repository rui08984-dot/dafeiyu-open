const { Plugin } = require('../../../js/core/plugin-base.js');
// ADR-013 / E8：压缩不能把「刚才在聊什么」压没；token 窗口作为条数之外的触发条件
const scene = require('../../../js/core/conversation-scene.js');
const contextBudget = require('../../../js/core/context-budget.js');
const usageLedger = require('../../../js/core/usage-ledger.js');

// ADR-014 轨道 1：缓存感知压缩。
//   DeepSeek 前缀缓存 5 分钟；留 30s 安全边界 —— 超过 4.5 分钟视为「缓存已冷」，
//   这时没有缓存可保，摘要可以直接换上（不必先持有）。
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_SAFETY_MS = 30 * 1000;

class ContextCompressorPlugin extends Plugin {

    constructor(metadata, context) {
        super(metadata, context);
        this._resetState();
    }

    async onInit() {
        this._resetState();
    }

    /** 所有运行时状态集中复位（构造 + onInit 都走这里，测试/热重载不依赖生命周期顺序）。 */
    _resetState() {
        this._compressing = false;
        // P0-2：压缩失败退避 + 上次压完的 history token（回差基准）。
        this._compressionFails = 0;
        this._nextAttemptAt = 0;
        this._lastCompressedHistoryTokens = 0;
        // ADR-014：摘要先持有，到水位/超时才替换（避免每次压缩都打穿前缀缓存）
        this._pending = null;
        this._turnIndex = 0;
        this._applies = [];                    // [{at, turn}] 最近几次应用（防抖动）
        this._rapidRefillUntilTurn = 0;
        this._rapidRefill = 0;
        this._tailTooLongUntilTurn = 0;        // tail 太长时，别每轮都重生成
        this._keepRecentHint = 0;              // 上次 tail 太长 → 下次少留几条（仍然不丢消息）
    }

    async onLLMResponse(response) {
        if (this._compressing) return;

        const voiceChat = global.voiceChat;
        if (!voiceChat?.messages) return;
        this._turnIndex += 1;

        const cfg = this.context.getPluginFileConfig();
        const { budget, growthMin, applyAt, maxHold, keepRecent } = this._limits(cfg);

        // ── P0-2 + ADR-014：触发只看 **history token**，且优先用 provider 真账 ──────
        //   historyBudget（默认 8000）= 只算「对话历史」；
        //   达到预算后再要求「比上次压缩后至少增长 growthMin（默认 4000）」才压；
        //   provider 基线能对上前缀时，total/history 都以真实 prompt_tokens 为锚，
        //   只估算新增消息（误差从整段十几 k 降到几百 token）。
        let measured;
        try {
            measured = contextBudget.measureWithBaseline({ messages: voiceChat.messages });
        } catch (e) { return; }   // 测量失败就这轮不压（宁可不压，也不按错口径压）
        const historyTokens = measured.history;
        const nonSystemCount = voiceChat.messages.filter(m => m.role !== 'system').length;

        // ── 1) 已有待用摘要：先判「应用 / 失效」 ────────────────────────────────
        if (this._pending) {
            const p = this._pending;
            p.heldTurns = (p.heldTurns || 0) + 1;

            // 边界校验（防丢消息）：摘要覆盖到的最后一条必须还是**同一条**。
            // 硬裁/重启/其它插件改写了头部时，index 会指向另一条消息 ——
            // 这时 tail 里会混进「没被摘要过」的旧消息，贸然替换就是丢消息。宁可作废。
            const nonSystem = voiceChat.messages.filter(m => m.role !== 'system');
            const boundaryOk = nonSystemCount >= p.summaryUpToIndex
                && p.summaryUpToIndex > 0
                && (!p.boundaryFp || usageLedger.fingerprint(nonSystem[p.summaryUpToIndex - 1]) === p.boundaryFp);

            if (!boundaryOk) {
                // 历史被裁到摘要点之前 / 头部被改写 → pending 已经没有覆盖关系，作废即可
                this._pending = null;
                this.context.log('info', '上下文摘要已作废：历史被裁剪或改写（消息不动，下轮重新摘要）');
            } else {
                const tailTokens = this._tailTokens(voiceChat, p.summaryUpToIndex);
                if (tailTokens > budget) {
                    // tail 太长：摘要换上去也省不了，还会丢最近现场 → 丢弃，下次重新摘要
                    this._pending = null;
                    this._tailTooLongUntilTurn = this._turnIndex + 2;
                    this._keepRecentHint = Math.max(2, Math.floor((p.keepRecent || keepRecent) / 2));
                    this.context.log('info', `上下文摘要已作废：尾部 ${tailTokens} token > ${budget}（tail 太长，下次重新摘要）`);
                } else {
                    const cacheCold = this._cacheIsCold();
                    if (historyTokens >= applyAt || p.heldTurns >= maxHold || cacheCold) {
                        // trigger 只记 immediate/held（便于统计）；reason 说明是哪条水位/原因触发
                        const reason = historyTokens >= applyAt ? 'apply_at'
                            : p.heldTurns >= maxHold ? 'max_hold'
                            : 'cache_cold';
                        await this._applyPending(voiceChat, cfg, {
                            budget, applyAt, keepRecent: p.keepRecent || keepRecent,
                            trigger: 'held', reason,
                        });
                        return;   // 应用后本轮不再触发新摘要
                    }
                    return;       // 继续持有：voiceChat.messages 一个字都不改
                }
            }
        }

        // ── 2) 触发条件 ──────────────────────────────────────────────────────
        if (voiceChat.messages.length < 8) return;      // 一句话 + 一条超大粘贴不触发
        if (historyTokens < budget) return;

        const now = Date.now();
        if (this._nextAttemptAt && now < this._nextAttemptAt) return;
        if (this._turnIndex < this._rapidRefillUntilTurn) return;
        if (this._turnIndex < this._tailTooLongUntilTurn) return;

        // 回差基准：优先用本实例上次压完的实测值；热重载后从账本恢复。
        let lastAfter = Number(this._lastCompressedHistoryTokens) || 0;
        if (!lastAfter) {
            const rec = voiceChat._lastCompression;
            if (rec && Number(rec.historyTokensAfter) > 0) lastAfter = Number(rec.historyTokensAfter);
        }
        if (lastAfter > 0 && historyTokens - lastAfter < growthMin) return;

        // 缓存冷 / 已经在水位线上 → 没得持有，生成完直接换
        const cacheCold = this._cacheIsCold();
        const atHighWater = historyTokens >= applyAt;
        const immediate = cacheCold || atHighWater;
        const keep = this._keepRecentHint || keepRecent;

        this._generate(voiceChat, cfg, {
            historyTokensBefore: historyTokens,
            budget, applyAt, maxHold, keepRecent: keep,
            immediate,
            immediateReason: cacheCold ? 'cache_cold' : 'highwater',
            source: measured.source,
        }).catch(e => {
            this._compressionFails = (this._compressionFails || 0) + 1;
            const backoff = Math.min(60 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, this._compressionFails - 1));
            this._nextAttemptAt = Date.now() + backoff;
            this.context.log('warn', `上下文压缩失败（${Math.round(backoff / 60000)} 分钟内不再试）: ${e.message}`);
        });
    }

    /** 读配置：budget / 回差 / 应用水位 / 最多持有几轮 / 保留几条。 */
    _limits(cfg) {
        let rootCfg = {};
        try {
            rootCfg = (typeof this.context.getConfig === 'function' ? this.context.getConfig() : null) || {};
        } catch (e) { rootCfg = {}; }
        const ctxCfg = rootCfg.context || {};
        const budget = (() => {
            const n = Number(cfg.history_token_budget ?? ctxCfg.history_token_budget);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8000;
        })();
        const growthMin = (() => {
            const n = Number(cfg.history_growth_min ?? ctxCfg.history_growth_min);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : Math.max(1000, Math.floor(budget / 2));
        })();
        // 应用水位：到 12k（= max(1.5×budget, budget+growth)）或持有满 3 轮才替换
        const applyAt = (() => {
            const n = Number(cfg.apply_at ?? ctxCfg.apply_at);
            if (Number.isFinite(n) && n > 0) return Math.floor(n);
            return Math.max(Math.floor(budget * 1.5), budget + growthMin);
        })();
        const maxHold = (() => {
            const n = Number(cfg.max_hold_turns ?? ctxCfg.max_hold_turns);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
        })();
        const keepRecent = (() => {
            const n = Number(cfg.keep_recent);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
        })();
        return { budget, growthMin, applyAt, maxHold, keepRecent };
    }

    /** 最近一次 provider 响应是否已出缓存 TTL（没有 lastUsage = 冷）。 */
    _cacheIsCold() {
        try {
            // 只看主对话（main）：视觉/插件请求不参与前缀缓存 TTL 判断
            const lu = (contextBudget.getLastUsage && contextBudget.getLastUsage('main'))
                || (contextBudget.getLastUsage && contextBudget.getLastUsage());
            const at = lu && Number(lu.at);
            if (!Number.isFinite(at) || at <= 0) return true;
            return (Date.now() - at) > (CACHE_TTL_MS - CACHE_SAFETY_MS);
        } catch (e) { return true; }
    }

    /** 摘要点之后的尾部 token（测量失败返回 Infinity → 宁可不替换）。 */
    _tailTokens(voiceChat, fromIndex) {
        try {
            const nonSystem = voiceChat.messages.filter(m => m.role !== 'system');
            return contextBudget.measure({ messages: nonSystem.slice(fromIndex) }).history;
        } catch (e) { return Infinity; }
    }

    /**
     * 生成摘要。immediate=false 时只持有（不动 messages）；
     * immediate=true（缓存冷 / 已在水位线上 / 直接调用）时生成完立刻应用。
     * @returns {Promise<'held'|'applied'|'skipped'|'empty'|string>}
     */
    async _generate(voiceChat, cfg, meta) {
        this._compressing = true;
        const info = meta || {};
        try {
            const keepRecent = info.keepRecent || cfg.keep_recent || 4;
            const prompt = cfg.prompt || '请将以下历史对话总结为简洁的要点，保留关键信息和上下文。';
            const messages = voiceChat.messages;

            const systemMsgs = messages.filter(m => m.role === 'system');
            const nonSystem = messages.filter(m => m.role !== 'system');

            const prevSummaryMsg = systemMsgs.find(m => String(m.content || '').includes('[历史对话总结]'));

            const recent = nonSystem.slice(-keepRecent * 2);
            const old = nonSystem.slice(0, -keepRecent * 2);
            if (old.length === 0) return 'skipped';

            const convText = old.map(m =>
                m.role === 'user' ? `用户: ${this._text(m.content)}`
                : m.role === 'assistant' ? `AI: ${this._text(m.content)}`
                // P0-2：工具回执也进摘要输入（截 200 字）。否则一段几乎全是工具轮的
                // 历史会生成空摘要（map 只认 user/assistant），压了等于没压。
                : m.role === 'tool' ? `工具结果: ${this._text(m.content).slice(0, 200)}`
                : ''
            ).filter(Boolean).join('\n');

            const prevSummary = prevSummaryMsg
                ? prevSummaryMsg.content.replace('[历史对话总结] ', '')
                : null;

            // ADR-013：把「现在这场对话」交给摘要器，要求在总结里保留它。
            let sceneLine = '';
            try { sceneLine = scene.describeForPrompt(); } catch (e) { sceneLine = ''; }
            const continuity = sceneLine
                ? `\n\n【当前对话现场（总结必须保留：话题/最后说话人/她刚说的话/人名/数字/已经做过的决定）】\n${sceneLine}`
                : '\n\n【总结必须保留：人名、数字、已经做过的决定；不要只写“聊了一些事情”】';
            const compressPrompt = (prevSummary
                ? `${prompt}\n\n【之前的历史总结】：\n${prevSummary}\n\n【本次新增对话】：\n${convText}\n\n请合并生成完整总结：`
                : `${prompt}\n\n对话内容：\n${convText}\n\n总结：`) + continuity;

            const summary = await this.context.callLLM(compressPrompt, { max_tokens: 500, stream: false });
            if (!summary?.trim()) return 'empty';

            const pending = {
                summary: summary.trim(),
                at: Date.now(),
                // 覆盖到 nonSystem 的第几条（不含）；应用时保留它之后的全部消息 → 不丢消息
                summaryUpToIndex: old.length,
                // 摘要覆盖到的最后一条的指纹：应用时用来确认「头部没被裁/改写」
                boundaryFp: usageLedger.fingerprint(old[old.length - 1]),
                historyTokensAtSummary: Number(info.historyTokensBefore) || 0,
                keepRecent,
                heldTurns: 0,
                sceneKept: !!sceneLine,
                source: info.source || 'estimate',
            };
            this._pending = pending;

            if (info.immediate) {
                return await this._applyPending(voiceChat, cfg, {
                    budget: info.budget,
                    applyAt: info.applyAt,
                    keepRecent,
                    trigger: 'immediate',
                    reason: info.immediateReason || 'direct',
                });
            }

            this.context.log('info', `上下文摘要已生成，先持有：${pending.historyTokensAtSummary} token`
                + `（到 ${info.applyAt || '?'} token 或 ${info.maxHold || 3} 轮后才替换，避免打穿前缀缓存）`);
            return 'held';
        } finally {
            this._compressing = false;
        }
    }

    /** 兼容旧入口：生成并**立即**应用（缓存冷/强制压缩时用）。 */
    async _compress(voiceChat, cfg, meta) {
        const info = meta || {};
        const budget = Number(info.budget) || (Number(cfg && cfg.history_token_budget) > 0
            ? Math.floor(Number(cfg.history_token_budget)) : 8000);
        return this._generate(voiceChat, cfg, {
            ...info,
            budget,
            keepRecent: info.keepRecent || (cfg && cfg.keep_recent) || 4,
            immediate: true,
            immediateReason: 'direct',
        });
    }

    /**
     * 把持有的摘要换上：initialSystem + [历史对话总结] + 摘要点之后的全部消息。
     * 任何路径都不丢消息：被替换掉的旧消息都已进入摘要（summaryUpToIndex 之前）。
     */
    async _applyPending(voiceChat, cfg, meta) {
        const p = this._pending;
        if (!p) return 'no_pending';
        const info = meta || {};
        const budget = Number(info.budget) > 0 ? Math.floor(info.budget) : 8000;
        this._compressing = true;
        try {
            const messages = voiceChat.messages;
            const systemMsgs = messages.filter(m => m.role === 'system');
            const nonSystem = messages.filter(m => m.role !== 'system');

            if (nonSystem.length < p.summaryUpToIndex) {
                this._pending = null;
                this.context.log('info', '上下文摘要作废：历史短于摘要点（消息不动）');
                return 'invalid';
            }
            // 边界指纹：摘要覆盖的最后一条必须还是同一条，否则 tail 会混进未摘要的旧消息
            if (p.summaryUpToIndex > 0 && p.boundaryFp
                && usageLedger.fingerprint(nonSystem[p.summaryUpToIndex - 1]) !== p.boundaryFp) {
                this._pending = null;
                this.context.log('info', '上下文摘要作废：头部被裁剪/改写（消息不动，下轮重新摘要）');
                return 'invalid';
            }

            const tail = nonSystem.slice(p.summaryUpToIndex);
            let tailTokens = 0;
            try { tailTokens = contextBudget.measure({ messages: tail }).history; } catch (e) { tailTokens = Infinity; }
            if (tailTokens > budget) {
                this._pending = null;
                this._tailTooLongUntilTurn = this._turnIndex + 2;
                this._keepRecentHint = Math.max(2, Math.floor((p.keepRecent || 4) / 2));
                this.context.log('info', `上下文摘要作废：尾部 ${tailTokens} token > ${budget}（tail 太长，下次重新摘要）`);
                return 'tail_too_long';
            }

            // 旧总结（prevSummaryMsg）的内容已在生成时并入新摘要 → 这里只保留新的那一条
            const initialSystem = systemMsgs.filter(m => !String(m.content || '').includes('[历史对话总结]'));
            const next = [
                ...initialSystem,
                { role: 'system', content: `[历史对话总结] ${p.summary}` },
                ...tail,
            ];

            // ⚠ 2026-11-13：原子替换（core.setMessages），失败不清空；facade 同步引用（2026-11-16 实测 bug）
            const core = voiceChat.conversationCore;
            if (core && typeof core.setMessages === 'function') {
                core.setMessages(next);
                try { voiceChat.messages = core.getMessages(); } catch (e) { /* 拿不到就保持旧引用 */ }
            } else {
                const keep = voiceChat.messages.slice();
                try {
                    voiceChat.messages.length = 0;
                    voiceChat.messages.push(...next);
                } catch (e) {
                    voiceChat.messages.length = 0;
                    voiceChat.messages.push(...keep);
                    throw e;
                }
            }

            // 记账：真账优先（前缀刚换过，baseline 会回退估算 —— 正确行为）
            let historyTokensAfter = 0;
            try {
                const afterMsgs = (core && core.getMessages ? core.getMessages() : voiceChat.messages);
                historyTokensAfter = contextBudget.measureWithBaseline({ messages: afterMsgs }).history;
            } catch (e) { historyTokensAfter = 0; }
            this._lastCompressedHistoryTokens = historyTokensAfter;
            this._compressionFails = 0;
            this._nextAttemptAt = 0;
            this._keepRecentHint = 0;

            const trigger = info.trigger || 'held';
            const reason = info.reason || '';
            const heldMs = Math.max(0, Date.now() - (Number(p.at) || Date.now()));
            const preTokens = Number(p.historyTokensAtSummary) || Number(info.historyTokensBefore) || 0;

            // rapid-refill 闸：同一 3 轮内压了 2 次 → 记录并退避（下次允许时间推后 2 轮）。
            // 只影响「下一轮是否允许再压」，不丢数据、不改已压缩的结果。
            this._applies.push({ at: Date.now(), turn: this._turnIndex });
            if (this._applies.length > 8) this._applies.shift();
            const recentApplies = this._applies.filter(a => this._turnIndex - a.turn <= 3);
            let rapidRefill = false;
            if (recentApplies.length >= 2) {
                rapidRefill = true;
                this._rapidRefill = (this._rapidRefill || 0) + 1;
                this._rapidRefillUntilTurn = this._turnIndex + 2;
            }

            try {
                const firstKept = tail[0];
                voiceChat._lastCompression = {
                    at: Date.now(),
                    // 兼容旧字段名（历史看板/测试还在读）
                    tokensBefore: preTokens,
                    historyTokensBefore: preTokens,
                    preTokens,
                    historyTokensAfter,
                    postTokens: historyTokensAfter,
                    // ADR-014：应用后的真实 history（用来判断下一轮会不会又触发）
                    truePostTokens: historyTokensAfter,
                    willRetriggerNextTurn: historyTokensAfter >= budget,
                    mustByTokens: true,
                    trigger,                       // immediate / held
                    reason,                        // apply_at / max_hold / cache_cold / highwater / direct
                    heldMs,
                    rapidRefill,
                    rapidRefillCount: this._rapidRefill || 0,
                    source: p.source || 'estimate',
                    summarySource: 'llm',
                    messagesBefore: messages.length,
                    messagesAfter: next.length,
                    dropped: p.summaryUpToIndex,
                    kept: tail.length,
                    firstKeptMessageId: 'idx:' + p.summaryUpToIndex + ':' + String((firstKept && firstKept.content) || '').slice(0, 12),
                    sceneKept: !!p.sceneKept,
                };
            } catch (e) { /* 元数据失败不影响压缩 */ }

            const afterLen = (core && core.getMessages ? core.getMessages() : voiceChat.messages).length;
            this.context.log('info', `上下文压缩完成（${trigger}${reason ? '/' + reason : ''}）: ${messages.length}条 → ${afterLen}条`
                + `（history ${preTokens} → ${historyTokensAfter} token`
                + `${trigger === 'held' ? '，持有 ' + Math.round(heldMs / 1000) + 's' : ''}`
                + `${rapidRefill ? '，连续快速回填→退避 2 轮' : ''}`
                + `${historyTokensAfter >= budget ? '，下轮仍会触发' : ''}）`);
            this._pending = null;
            return 'applied';
        } finally {
            this._compressing = false;
        }
    }

    _text(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.filter(p => p.type === 'text').map(p => p.text).join(' ');
        return '';
    }
}

module.exports = ContextCompressorPlugin;
