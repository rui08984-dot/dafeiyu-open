// ContextManager.js - 上下文管理模块
const fs = require('fs');
const path = require('path');
const {
    sanitizeToolMessageSequence,
    trimMessagesPreservingToolRounds
} = require('./tool-message-utils.js');
// E8（ADR-013）：裁剪是「紧急背压」，不是常规手段；记录兜底账，压缩失败时才走到这里
const contextBudget = require('../core/context-budget.js');
// P0（2026-11-22 审计）：落盘目录只认 records-path（单一真源），
// 旧实现自己拼 `__dirname/../../../data` —— 测试隔离（PET_DATA_ROOT）对它失效。
const { RECORDS_DIR } = require('../core/records-path.js');

class ContextManager {
    constructor(voiceChatInterface) {
        this.voiceChat = voiceChatInterface;
        this.enableContextLimit = voiceChatInterface.enableContextLimit;
        this.maxContextMessages = voiceChatInterface.maxContextMessages;
        // P0（2026-11-22 审计）：旧实现用「历史上任何一条内容相同」判断是否已保存 ——
        // 第二天再说一次「好」，这条真实输入会被静默丢掉（召回/接续都看不到）。
        // 消息对象在内存里是同一引用：用 WeakSet 记「已落盘过哪些对象」，
        // 启动时 voiceChat.messages 本来就是盘上历史加载的 → 全部标记为已保存。
        // 新对象（哪怕内容一模一样）一定会被追加；压缩保留下来的旧对象不会重复写。
        this._savedRefs = new WeakSet();
        try {
            for (const m of (voiceChatInterface.messages || [])) this._savedRefs.add(m);
        } catch (e) { /* 没有 messages 就空集 */ }
    }

    /**
     * 启动时（历史加载完成后）由 facade 调用：把当前 messages 全部标记为「已落盘」。
     * ContextManager 在 initializeAsync 之前就被构造，那时 messages 还不存在 ——
     * 不补这一步，第一轮保存会把整段历史重新追加一遍。
     */
    markLoadedHistorySaved() {
        try {
            for (const m of (this.voiceChat.messages || [])) this._savedRefs.add(m);
            this._savedRefsReady = true;
        } catch (e) { /* 标记失败最多多写一遍历史，不阻塞对话 */ }
    }

    // 设置上下文限制
    setContextLimit(enable) {
        this.enableContextLimit = enable;
        this.voiceChat.enableContextLimit = enable;
        if (enable) {
            this.trimMessages();
        }
    }

    // 设置最大上下文消息数
    setMaxContextMessages(count) {
        if (count < 1) throw new Error('最大消息数不能小于1');
        this.maxContextMessages = count;
        this.voiceChat.maxContextMessages = count;
        if (this.enableContextLimit) {
            this.trimMessages();
        }
    }

    // 裁剪消息
    // 以「assistant+tool_calls 及其 tool 响应」为不可分割单元从后向前保留，
    // 保证裁剪永远不会切断工具调用链（避免严格模式 API 报 400）
    trimMessages() {
        // P1-4（2026-11-24 对抗审查）：`enable_limit` 只控制**条数**闸（max_messages）。
        // 「按 token 硬上限」是独立的**紧急背压** —— 关掉条数限制后历史仍可能被单轮工具循环
        // 顶到几十 k；没有上限就会一路涨到上游 400 / 费用失控。所以 token 闸不看这个开关。
        const countGateEnabled = !!this.enableContextLimit;

        // ── 回差：不要**每轮**都裁（2026-11-16 六十二轮实测）────────────────
        // 滑动窗口每轮丢掉最老的一条 → 后面所有消息整体前移 →
        // 上游按字节前缀复用的缓存，每轮从「历史第一条」就作废。
        // 实测症状：prompt 9.1k token，cached 死死卡在 8192（≈ 只有 system+tools 那段命中）。
        // 现在攒到 4 倍上限再一次性裁回上限：裁剪从「每轮」变成「隔很多轮」，
        // 中间那些轮次 history 只增不改 → 命中率能爬到 98%+。
        // ⚠ 2026-11-22（E8）：阈值必须**高于压缩插件的触发线**，否则裁剪会先把 context 砍掉、
        //   压缩永远轮不到。压缩插件现在按 history token 触发（8k 起、增长 4k 再压）。
        //   条数闸按 history 大小分两档（见下），保证短对话不会被提前裁。
        // ⚠ 2026-11-24（P0-2）：条数闸从 96 降到 48，但**只在 history 已经不小的时候**生效：
        //   · history > 8k（与压缩插件同口径）→ 48 条就可能硬裁，作为压缩失败/被禁用后的背压；
        //   · history ≤ 8k → 仍用 96 条（一串短问候 48 条才一两千 token，提前裁只会白丢现场、
        //     还会把前缀缓存打穿 —— 11-16 的教训）。
        //   再加一条 **history token 兜底**（默认 24k）：单轮工具循环能在 30 条内把 history
        //   顶到 68k，条数闸根本到不了；超了就从最旧开始裁，并按 token 继续减半到 4 条下限。
        const cfgCtx = (this.voiceChat && this.voiceChat.config && this.voiceChat.config.context) || {};
        const softFloor = (() => {
            const n = Number(cfgCtx.history_token_budget);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : 8000;
        })();
        const hardTokenLimit = (() => {
            const n = Number(cfgCtx.hard_trim_tokens);
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24000;
        })();
        let tokensBefore = 0;
        let historyTokensBefore = 0;
        let historySource = 'estimate';
        try {
            // ADR-014 轨道 1：优先用 provider 真账做基线（前缀没变 → 只估新增消息），
            // 对不上（压缩插过 summary / 裁剪过）自动回退全量估算。
            const m = contextBudget.measureWithBaseline({ messages: this.voiceChat.messages });
            tokensBefore = m.total;
            historyTokensBefore = m.history;
            historySource = m.source;
        } catch (e) { tokensBefore = 0; historyTokensBefore = 0; }

        const hardTrigger = historyTokensBefore > softFloor
            ? Math.max(this.maxContextMessages + 8, 48)
            : Math.max(this.maxContextMessages + 8, this.maxContextMessages * 4, 96);
        const overCount = countGateEnabled
            && !!(this.voiceChat.messages && this.voiceChat.messages.length > hardTrigger);
        const overTokens = historyTokensBefore > hardTokenLimit;
        if (!overCount && !overTokens) {
            if (!countGateEnabled) {
                console.log('上下文条数限制已禁用，且 history 未超 token 硬上限，不裁剪消息');
            }
            return;
        }
        if (!countGateEnabled) {
            // 日志必须写明「开关关了也生效」：否则用户以为 enable_limit=false 就完全没有裁剪
            console.log('⚠️ 紧急背压（enable_limit=false 也生效）：history ' + historyTokensBefore
                + ' token > 硬上限 ' + hardTokenLimit + '，只按 token 裁、不按条数');
        }

        const systemMessages = this.voiceChat.messages.filter(msg => msg.role === 'system');
        const nonSystemMessages = this.voiceChat.messages.filter(msg => msg.role !== 'system');

        console.log(`裁剪前: 系统消息 ${systemMessages.length} 条, 非系统消息 ${nonSystemMessages.length} 条`
            + `（history ${historyTokensBefore} token，触发=${overTokens ? 'token' : '条数'}）`);

        // 先按条数裁回上限；若 token 仍超，继续减半（工具轮不可分割，可能停在 >keep 条）。
        // enable_limit=false 时没有条数目标：从全量开始减半，只满足 token 硬上限（下限 4 条）。
        let keep = countGateEnabled ? this.maxContextMessages : Math.max(1, nonSystemMessages.length);
        let recentMessages = trimMessagesPreservingToolRounds(nonSystemMessages, keep);
        let historyTokensAfter = 0;
        try {
            historyTokensAfter = contextBudget.measure({ messages: [...systemMessages, ...recentMessages] }).history;
        } catch (e) { historyTokensAfter = 0; }
        while (historyTokensAfter > hardTokenLimit && keep > 4) {
            keep = Math.max(4, Math.floor(keep / 2));
            recentMessages = trimMessagesPreservingToolRounds(nonSystemMessages, keep);
            try {
                historyTokensAfter = contextBudget.measure({ messages: [...systemMessages, ...recentMessages] }).history;
            } catch (e) { historyTokensAfter = 0; }
        }
        this.voiceChat.messages = [...systemMessages, ...recentMessages];

        // E8：丢了多少、第一条保留的是哪条，必须留账（否则「她忘了前面」只能靠猜）
        try {
            const firstKept = recentMessages[0];
            this.voiceChat._lastTrim = {
                at: Date.now(),
                tokensBefore,
                historyTokensBefore,
                historyTokensAfter,
                historySource,
                hardTokenLimit,
                reason: overTokens ? 'tokens' : 'count',
                // enable_limit=false 时仍可能因 token 背压裁：账里标出来，别让人以为是条数闸干的
                countGateEnabled,
                messagesBefore: systemMessages.length + nonSystemMessages.length,
                messagesAfter: this.voiceChat.messages.length,
                dropped: nonSystemMessages.length - recentMessages.length,
                firstKeptMessageId: 'idx:' + recentMessages.length + ':' + String((firstKept && firstKept.content) || '').slice(0, 12),
            };
        } catch (e) { /* 记账失败不影响裁剪 */ }

        console.log(`裁剪后: 消息总数 ${this.voiceChat.messages.length} 条, 非系统消息 ${recentMessages.length} 条`);
    }

    // 保存对话历史 - 改用追加模式（JSONL格式）
    saveConversationHistory() {
        try {
            const recordsDir = RECORDS_DIR;   // 单一真源（测试用 PET_DATA_ROOT 隔离）
            const conversationHistoryPath = path.join(recordsDir, '对话历史.jsonl');

            // 确保data文件夹存在
            if (!fs.existsSync(recordsDir)) {
                fs.mkdirSync(recordsDir, { recursive: true });
            }

            // 保留 tool 消息和 tool_calls 完整结构（工具调用信息不丢失），
            // 写入前先做序列清理，保证落盘的历史永远是 API 合法序列，
            // 下次启动加载后不会再出现 "tool_calls must be followed by tool messages"
            const currentSessionMessages = sanitizeToolMessageSequence(
                this.voiceChat.messages.filter(msg =>
                    msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
                )
            );

            // 找出本次真正新增的消息：只认「这个对象还没落盘过」，不按内容去重。
            // 旧实现（2026-11-22 审计 P0-3）两处同内容消息会被当成同一条丢掉：
            //   隔天再说「好 / 嗯 / 我回来了」→ 这条真实输入永远进不了历史，
            //   召回、片段卡、跨会话接续全都看不到它。
            const newMessages = currentSessionMessages.filter((msg) => !this._savedRefs.has(msg));

            // 如果没有新消息，直接返回
            if (newMessages.length === 0) {
                console.log('没有新消息需要保存');
                return;
            }

            // 📝 逐行追加新消息到 JSONL 文件
            for (const msg of newMessages) {
                const line = JSON.stringify(msg) + '\n';
                fs.appendFileSync(conversationHistoryPath, line, 'utf8');
                // 落盘成功才标记；写失败下一次还会重试，不会静默丢
                this._savedRefs.add(msg);
            }

            // 更新完整历史记录供下次使用
            this.voiceChat.fullConversationHistory.push(...newMessages);

            console.log(`对话历史已追加，新增 ${newMessages.length} 条消息，总计 ${this.voiceChat.fullConversationHistory.length} 条`);

            // 🗜️ 落盘压缩自动触发（2026-11-10 三十七轮）：>500 行异步唤起 memory-compact --apply
            //    （Letta「驱逐 70%+摘要」纯本地版：保留最近 200 行+关键行，幂等有备份）。
            //    拟真实测：手动压一次 884→228 行 / 229KB→63KB；不自动触发会一路滚回 400+。
            //    ⚠ 只压**落盘文件**，内存 voiceChat.messages 不动（压缩后下次启动加载短历史）。
            try {
                const lineCount = fs.readFileSync(conversationHistoryPath, 'utf8').split('\n').filter((l) => l.trim()).length;
                if (lineCount > 500) {
                    const compactScript = path.join(__dirname, '..', '..', '..', 'pet-runtime', 'tools', 'memory-compact.cjs');
                    // ⚠ 2026-11-10 修复（并发压盘）：memory-compact --apply 自己用
                    //   `openSync(lock, 'wx')` 拿了独占锁；这里先探测锁文件，已有实例在跑就不必再 spawn
                    //   （否则会起第二个进程，白占资源/白写备份）。
                    const compactLock = conversationHistoryPath + '.lock';
                    if (fs.existsSync(compactScript) && fs.existsSync(compactLock)) {
                        console.log(`🗜️ 对话历史压缩已在运行（锁文件存在），跳过本次触发`);
                    } else if (fs.existsSync(compactScript)) {
                        require('child_process').spawn(process.execPath, [compactScript, '--apply'], {
                            windowsHide: true, detached: true, stdio: 'ignore',
                        }).unref();
                        console.log(`🗜️ 对话历史 ${lineCount} 行 > 500，已异步触发落盘压缩（memory-compact --apply）`);
                    }
                }
            } catch (e) {
                console.error('压缩触发失败（不影响主链）:', e.message);
            }
        } catch (error) {
            console.error('保存对话历史失败:', error);
        }
    }
}

module.exports = { ContextManager };
