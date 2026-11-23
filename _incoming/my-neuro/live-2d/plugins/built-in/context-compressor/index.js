const { Plugin } = require('../../../js/core/plugin-base.js');
// ADR-013 / E8：压缩不能把「刚才在聊什么」压没；token 窗口作为条数之外的触发条件
const scene = require('../../../js/core/conversation-scene.js');
const contextBudget = require('../../../js/core/context-budget.js');

class ContextCompressorPlugin extends Plugin {

    async onInit() {
        this._compressing = false;
    }

    async onLLMResponse(response) {
        const cfg = this.context.getPluginFileConfig();
        if (this._compressing) return;

        const voiceChat = global.voiceChat;
        if (!voiceChat?.messages) return;

        const threshold = cfg.trigger_threshold || 16;
        const keepRecent = cfg.keep_recent || 4;

        // ── 回差（hysteresis）：压缩后的条数必须**明显低于**触发线 ──────────────
        // 2026-11-16 六十二轮实测的真 bug：配置 24 条触发 / 保留 8 轮，
        // 但压完是 27 条（1 base + 10 段历史压缩 + 1 总结 + 16 近期）> 24，
        // 于是**每一轮都压一次**（日志连续 "35条 → 27条"）：
        //   · 每轮白烧一次摘要 LLM 调用；
        //   · prompt 前缀每轮从头改写 → 上游 prefix cache 永远只剩「system+tools」那段
        //     （实测 cached 死死卡在 8192 / prompt 9.1k ≈ 90%，再也上不去）。
        // 这里让触发线 = max(配置阈值, 压完条数 × 4)，
        // 压完至少再攒「三倍压完规模」才允许下次压 → 压缩从「每轮」变成「隔几十轮」。
        // （×4 是 2026-11-15 用户拍板「再拉长一倍」：压完 28 条 → 触发 112 条。）
        const sysNow = voiceChat.messages.filter((m) => m.role === 'system').length;
        const afterCompress = sysNow + 1 + keepRecent * 2;   // 压完的条数（会新增 1 条总结）
        const trigger = Math.max(threshold, afterCompress * 4);

        // E8（2026-11-22）：条数不是唯一信号 —— 一条长记忆能顶十条短问候。
        // 达到 token 预算的 70%（且消息 ≥15）也触发；预算缺省 12000，可写
        // config.context.token_budget 调整。没有这一步，压缩会被条数回差拖到
        // ContextManager 的紧急裁剪（96 条）之后，现场就丢了。
        let tokensBefore = 0;
        let mustByTokens = false;
        try {
            const rootCfg = (typeof this.context.getConfig === 'function' ? this.context.getConfig() : null) || {};
            const budget = Number((rootCfg.context && rootCfg.context.token_budget) || cfg.token_budget || 12000) || 12000;
            tokensBefore = contextBudget.measure({ messages: voiceChat.messages }).total;
            mustByTokens = voiceChat.messages.length >= 15 && tokensBefore >= budget * 0.7;
        } catch (e) { /* 测量失败就只按条数 */ }

        if (voiceChat.messages.length < trigger && !mustByTokens) return;

        this._compress(voiceChat, cfg, { tokensBefore, mustByTokens }).catch(e => {
            this.context.log('warn', `上下文压缩失败: ${e.message}`);
        });
    }

    async _compress(voiceChat, cfg, meta) {
        this._compressing = true;
        const info = meta || {};
        try {
            const keepRecent = cfg.keep_recent || 4;
            const prompt = cfg.prompt || '请将以下历史对话总结为简洁的要点，保留关键信息和上下文。';
            const messages = voiceChat.messages;
            const total = messages.length;

            const systemMsgs = messages.filter(m => m.role === 'system');
            const nonSystem = messages.filter(m => m.role !== 'system');

            const initialSystem = systemMsgs.filter(m => !m.content.includes('[历史对话总结]'));
            const prevSummaryMsg = systemMsgs.find(m => m.content.includes('[历史对话总结]'));

            const recent = nonSystem.slice(-keepRecent * 2);
            const old = nonSystem.slice(0, -keepRecent * 2);
            if (old.length === 0) return;

            const convText = old.map(m =>
                m.role === 'user' ? `用户: ${this._text(m.content)}`
                : m.role === 'assistant' ? `AI: ${this._text(m.content)}`
                : ''
            ).filter(Boolean).join('\n');

            const prevSummary = prevSummaryMsg
                ? prevSummaryMsg.content.replace('[历史对话总结] ', '')
                : null;

            // ADR-013：把「现在这场对话」交给摘要器，要求在总结里保留它。
            // 否则压完之后她只记得「很久以前聊过什么」，接不上当前话题。
            let sceneLine = '';
            try { sceneLine = scene.describeForPrompt(); } catch (e) { sceneLine = ''; }
            const continuity = sceneLine
                ? `\n\n【当前对话现场（总结必须保留：话题/最后说话人/她刚说的话）】\n${sceneLine}`
                : '';
            const compressPrompt = (prevSummary
                ? `${prompt}\n\n【之前的历史总结】：\n${prevSummary}\n\n【本次新增对话】：\n${convText}\n\n请合并生成完整总结：`
                : `${prompt}\n\n对话内容：\n${convText}\n\n总结：`) + continuity;

            const summary = await this.context.callLLM(compressPrompt, { max_tokens: 500, stream: false });
            if (!summary?.trim()) return;

            // ⚠ 2026-11-13：原来直接 `voiceChat.messages.length = 0` 再 push —— 中途
            //   抛错（某条超大/结构异常）就**把整段对话清空了**，而且和宿主并发读写同
            //   一个数组。宿主早就提供了原子替换 `ConversationCore.setMessages()`
            //   （注释写着「保持本对象为唯一的消息来源」），一直没人用。
            const next = [
                ...initialSystem,
                { role: 'system', content: `[历史对话总结] ${summary.trim()}` },
                ...recent,
            ];
            const core = voiceChat.conversationCore;
            if (core && typeof core.setMessages === 'function') {
                core.setMessages(next);
                // ⚠ 2026-11-16 六十二轮实测的真 bug：ConversationCore.setMessages 是
                // `this.messages = messages`（换数组引用），而 facade 的 voiceChat.messages
                // 是**构造时缓存下来的旧引用**。只写 core 不写 facade →
                // 下一轮插件看到的还是没压缩的旧数组（实测 facade 76 条 / core 27 条），
                // 于是「每轮都压一次」，而真正发请求用的还是没压缩的历史。
                try { voiceChat.messages = core.getMessages(); } catch (e) { /* 拿不到就保持旧引用 */ }
            } else {
                // 老路径兜底：先备份，改坏了回滚（不允许「清空了却没 push 成功」）
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

            // E8：把「压之前多大 / 第一条保留的是哪条」留成可追溯的数字（doctor/门禁可读）
            try {
                const firstKept = recent[0];
                voiceChat._lastCompression = {
                    at: Date.now(),
                    tokensBefore: Number(info.tokensBefore) || 0,
                    mustByTokens: info.mustByTokens === true,
                    messagesBefore: total,
                    messagesAfter: (core && core.getMessages ? core.getMessages() : voiceChat.messages).length,
                    dropped: old.length,
                    kept: recent.length,
                    // 消息没有稳定 id：用「在原数组里的序号 + 内容前缀」当可回查的标识
                    firstKeptMessageId: 'idx:' + old.length + ':' + String((firstKept && firstKept.content) || '').slice(0, 12),
                    sceneKept: !!sceneLine,
                };
            } catch (e) { /* 元数据失败不影响压缩 */ }
            this.context.log('info', `上下文压缩完成: ${total}条 → ${(core && core.getMessages ? core.getMessages() : voiceChat.messages).length}条`
                + (info.mustByTokens ? '（token 窗口触发）' : '（条数触发）'));
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
