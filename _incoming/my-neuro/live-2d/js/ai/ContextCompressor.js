// ContextCompressor.js - 异步上下文压缩模块
const __silentAudit = require('../core/silent-audit.js');
const { logToTerminal } = require('../api-utils.js');

class ContextCompressor {
    constructor(voiceChatInterface, config) {
        this.voiceChat = voiceChatInterface;
        this.config = config;

        // LLM 连接参数：优先通讯录解析，回退旧三格（压缩链路不应只依赖 config.llm.api_key）
        let resolved = null;
        try {
            const { llmProviderManager } = require('../core/llm-provider.js');
            resolved = llmProviderManager.resolveProviderOrFallback(
                (config.llm && config.llm.provider_id) || null,
                (config.llm && config.llm.model_id) || null
            );
        } catch (e) { try { __silentAudit.audit('ContextCompressor.js:17', e); } catch (e2) {} }
        this._llmApiUrl = (resolved && resolved.api_url) || config.llm.api_url;
        this._llmApiKey = (resolved && resolved.api_key) || config.llm.api_key;
        this._llmModel = (resolved && resolved.model) || config.llm.model;

        // 压缩配置
        this.compressionConfig = config.context?.compression || {};
        this.enabled = this.compressionConfig.enabled || false;
        this.triggerThreshold = this.compressionConfig.trigger_threshold || 15;
        this.keepRecent = this.compressionConfig.keep_recent || 4;
        this.compressionPrompt = this.compressionConfig.prompt || '请将以下历史对话总结为简洁的要点，保留关键信息和上下文。';

        // ⚡ rolling summary（滚动摘要，竞品 kimjammer 同款）：每滚 interval_pairs 对就把
        // 「已老化出近期窗口」的对话摘要进一条永不被 trimMessages 裁掉的 [历史对话总结]
        // system 消息，然后把这些消息从数组里移除——trim 是破坏性丢弃，rolling 是「先存档再扔」。
        // 成本：每 10 对消息一次 ≤400 token 的摘要调用（静默版也花得起）。
        // 配置读不到用默认，不写进 config.json（避免又触发丢键排查）。
        const rollingCfg = config.context?.rolling_summary || {};
        this.rollingEnabled = rollingCfg.enabled !== false;          // 默认开
        this.rollingIntervalMsgs = Math.max(4, (Number(rollingCfg.interval_pairs) || 10) * 2);
        this.rollingKeepRecent = Math.max(2, Number(rollingCfg.keep_recent) || 4);
        this.rollingMaxTokens = Math.max(200, Number(rollingCfg.max_tokens) || 400);
        // 单轮滚动批量上限：历史一次能攒几百条（实测 731 条），全塞进一次摘要调用=几万 token，
        // 必须分批消化——每轮滚动最多 batch_max 条，几轮后追平。
        this.rollingBatchMax = Math.max(10, Number(rollingCfg.batch_max) || 40);
        this.rollingDigestTag = '[历史对话总结]';
        this.rollingBusy = false;                                    // 防并发滚动
        this.rollingPrompt = rollingCfg.prompt ||
            '请把对话合并进持续摘要：保留用户的偏好与习惯、答应过的事、没聊完的话题、重要事件与时间点；寒暄和重复内容压缩掉，总长控制在 500 字以内。';

        // 压缩状态
        this.isCompressing = false; // 防止并发压缩

        if (this.enabled) {
            console.log('✅ 上下文压缩已启用');
            logToTerminal('info', `✅ 上下文压缩已启用 - 触发阈值: ${this.triggerThreshold}条消息, 压缩至: ${this.compressTo}条`);
        }
        if (this.rollingEnabled) {
            logToTerminal('info', `✅ rolling summary 已启用 - 每 ${Math.round(this.rollingIntervalMsgs / 2)} 对消息滚动摘要一次，近期保留 ${this.rollingKeepRecent} 轮`);
        }
    }

    // ============================================================
    // ⚡ rolling summary（滚动摘要）
    // ============================================================

    /**
     * 滚动摘要检查（每轮对话末/开各调一次，fire-and-forget 安全）：
     * 同步规划候选（超窗消息快照）→ 异步摘要 → 完成后更新摘要 system 消息并按身份移除。
     * 快照先行 = 无竞态：即使摘要在途时 trimMessages 已把候选裁掉，内容也已进快照不丢。
     */
    checkAndRollAsync() {
        // 🔇 静默期保险闸（2026-11-09）：当前两个触发点（llm-handler 用户开口主链）静默期
        // 本就不触发，此闸是兜底——未来若有人加周期触发点，静默模式也不许偷打 API。
        // 跳过无损失：消息还在数组里，下轮开口时 _planRoll 会重新规划。
        if (global.__petQuiet) return Promise.resolve();
        if (!this.rollingEnabled || this.rollingBusy || !this.voiceChat?.messages) return Promise.resolve();
        const plan = this._planRoll();
        if (!plan) return Promise.resolve();

        this.rollingBusy = true;
        return this._applyRoll(plan).catch((error) => {
            // 滚动失败只打日志不重试：下轮对话会重新规划，消息还在数组里不会丢
            console.warn('⚠️ rolling summary 失败（本轮跳过，消息仍在上下文里）:', error.message);
            logToTerminal('warn', `⚠️ rolling summary 失败: ${error.message}`);
        }).finally(() => { this.rollingBusy = false; });
    }

    /**
     * 规划一次滚动：找出「老化出近期窗口」且凑满间隔的消息快照。
     * 窗口边界做工具链保护（绝不把 assistant+tool_calls 与其 tool 响应拆到两侧）。
     * 返回 null = 不滚动；否则 { candidates, previousDigest }。
     */
    _planRoll() {
        const messages = this.voiceChat.messages;
        const nonSystem = messages.filter((msg) => msg.role !== 'system');

        // 近期窗口：rollingKeepRecent 轮（用户+AI 各一条为 1 轮的下限估计）。
        // 从后往前数「用户消息」确定轮次边界，比纯条数更贴近「轮」的语义。
        let boundaryFromEnd = 0, turns = 0;
        for (let i = nonSystem.length - 1; i >= 0 && turns < this.rollingKeepRecent; i--) {
            if (nonSystem[i].role === 'user') turns += 1;
            boundaryFromEnd = nonSystem.length - i;
        }
        // 没凑够保留窗口（对话还很短）：不滚
        if (turns < this.rollingKeepRecent) return null;

        const agedCount = nonSystem.length - boundaryFromEnd;
        if (agedCount < this.rollingIntervalMsgs) return null;   // 未满滚动间隔

        // 候选区右边界（含）：把 tool 消息划进候选侧，保证工具链不被拦腰截断
        let cut = nonSystem.length - boundaryFromEnd;
        while (cut < nonSystem.length && nonSystem[cut].role === 'tool') cut += 1;

        // 批量上限：只滚最老的一批（时间序摘要，剩下的留给后续几轮追平）。
        // 批量起点也要工具链安全：起点落在 tool 消息上时把它让给保留区
        //（它的 assistant 在保留区，拆开=孤儿 assistant+tool_calls，严格模式 API 400）。
        const batchStart0 = Math.max(0, cut - this.rollingBatchMax);
        let batchStart = batchStart0;
        while (batchStart < cut && nonSystem[batchStart].role === 'tool') batchStart += 1;
        const candidates = nonSystem.slice(batchStart, cut);
        if (!candidates.length) return null;

        // 已有滚动摘要（作为累积基底）
        const digestMsg = messages.find((msg) => msg.role === 'system' &&
            String(msg.content || '').startsWith(this.rollingDigestTag));
        const previousDigest = digestMsg
            ? String(digestMsg.content).slice(this.rollingDigestTag.length).trim()
            : null;

        return { candidates, previousDigest };
    }

    /** 执行滚动：摘要 → 写摘要 system 消息 → 按身份移除候选 → 净化工具链 → 回写 core。 */
    async _applyRoll({ candidates, previousDigest }) {
        const startTime = Date.now();
        const summary = await this.compressMessages(candidates, previousDigest, this.rollingMaxTokens, this.rollingPrompt);
        if (!summary || !summary.trim()) throw new Error('摘要返回空');

        const messages = this.voiceChat.messages;
        // 1) 更新/插入 [历史对话总结] system 消息（紧随初始 system 之后）
        const digestContent = `${this.rollingDigestTag} ${summary.trim()}`;
        const digestMsg = messages.find((msg) => msg.role === 'system' &&
            String(msg.content || '').startsWith(this.rollingDigestTag));
        if (digestMsg) {
            digestMsg.content = digestContent;
        } else {
            const lastSystemIdx = messages.reduce((acc, msg, i) => (msg.role === 'system' ? i : acc), -1);
            messages.splice(lastSystemIdx + 1, 0, { role: 'system', content: digestContent });
        }

        // 2) 按身份移除候选（同一对象引用在 trim 后依然存活，indexOf 可靠；
        //    摘要在途时已被 trim 掉的候选 indexOf=-1 自然跳过）
        const candidateSet = new Set(candidates);
        for (let i = messages.length - 1; i >= 0; i--) {
            if (candidateSet.has(messages[i])) messages.splice(i, 1);
        }

        // 3) 净化工具链（防孤儿 tool 消息 → 严格模式 API 400）
        const { sanitizeToolMessageSequence } = require('./tool-message-utils.js');
        const clean = sanitizeToolMessageSequence(messages);
        messages.length = 0;
        messages.push(...clean);

        // 4) 回写 conversationCore（与 VoiceChatFacade.trimMessages 同款同步）
        try { this.voiceChat.conversationCore?.setMessages?.(messages); } catch (e) { try { __silentAudit.audit('ContextCompressor.js:158', e); } catch (e2) {} }

        const ms = Date.now() - startTime;
        console.log(`✅ rolling summary 完成 - 摘要 ${candidates.length} 条 → ${summary.trim().length} 字 (${ms}ms)，上下文 ${messages.length} 条`);
        logToTerminal('info', `✅ rolling summary - ${candidates.length} 条消息已滚入持续摘要（上下文现存 ${messages.length} 条）`);
    }

    /**
     * 检查并异步压缩上下文（不阻塞对话）
     * 这个方法在每次对话后调用，但不await它
     */
    async checkAndCompressAsync() {
        // 如果未启用压缩，直接返回
        if (!this.enabled) {
            return;
        }

        // 如果正在压缩中，跳过
        if (this.isCompressing) {
            console.log('⏳ 上下文压缩正在进行中，跳过本次检查');
            return;
        }

        // 获取当前消息数量
        const messageCount = this.voiceChat.messages.length;

        // 检查是否达到触发阈值
        if (messageCount < this.triggerThreshold) {
            console.log(`📊 当前消息数: ${messageCount}, 未达到压缩阈值: ${this.triggerThreshold}`);
            return;
        }

        console.log(`🔔 触发上下文压缩 - 当前消息数: ${messageCount}, 阈值: ${this.triggerThreshold}`);
        logToTerminal('info', `🔔 触发上下文压缩 - 当前 ${messageCount} 条消息`);

        // 异步执行压缩，使用 .catch() 防止未捕获异常
        this.performCompressionAsync().catch(error => {
            console.error('❌ 异步上下文压缩失败:', error);
            logToTerminal('error', `❌ 异步上下文压缩失败: ${error.message}`);
        });
    }

    /**
     * 执行实际的压缩操作（异步，不阻塞）
     */
    async performCompressionAsync() {
        this.isCompressing = true;

        try {
            const startTime = Date.now();
            console.log('🚀 开始异步压缩上下文...');

            // 1. 分离消息：保留 system 消息 + 保留最近的对话 + 压缩旧对话
            const messages = this.voiceChat.messages;
            const totalMessages = messages.length;

            // 🔧 修复：分离 system 消息和非 system 消息
            const systemMessages = messages.filter(msg => msg.role === 'system');
            const nonSystemMessages = messages.filter(msg => msg.role !== 'system');

            console.log(`📦 消息分类 - 总数: ${totalMessages}, system消息: ${systemMessages.length}, 对话消息: ${nonSystemMessages.length}`);

            // 🔧 修复：区分初始 system 和历史总结 system
            // 初始 system: 不包含 "[历史对话总结]" 标记的
            const initialSystemMessages = systemMessages.filter(msg =>
                !msg.content.includes('[历史对话总结]')
            );

            // 历史总结 system: 包含 "[历史对话总结]" 标记的
            const historySummaryMessages = systemMessages.filter(msg =>
                msg.content.includes('[历史对话总结]')
            );

            console.log(`📦 初始system消息: ${initialSystemMessages.length}条, 历史总结: ${historySummaryMessages.length}条`);

            // 保留最近的 keepRecent 轮对话（每轮包含用户+AI）
            const recentCount = this.keepRecent * 2;
            const recentMessages = nonSystemMessages.slice(-recentCount);

            // 需要压缩的旧消息（只包含非 system 消息）
            const oldMessages = nonSystemMessages.slice(0, -recentCount);

            if (oldMessages.length === 0) {
                console.log('⚠️ 没有需要压缩的旧对话');
                return;
            }

            console.log(`📦 对话分离 - 旧对话: ${oldMessages.length}条, 保留最近: ${recentMessages.length}条`);

            // 2. 调用LLM压缩旧消息（如果存在历史总结，一并传入做累积总结）
            const previousSummary = historySummaryMessages.length > 0
                ? historySummaryMessages[0].content.replace('[历史对话总结] ', '')
                : null;

            const compressedSummary = await this.compressMessages(oldMessages, previousSummary);

            if (!compressedSummary || !compressedSummary.trim()) {
                console.log('⚠️ LLM压缩返回空结果，取消压缩');
                return;
            }

            // 3. 构建新的消息数组
            // 🔧 修复：只保留初始 system + 新的压缩总结 system（替换旧总结）
            const newMessages = [
                ...initialSystemMessages,  // 只保留初始 system 消息
                {
                    role: 'system',
                    content: `[历史对话总结] ${compressedSummary.trim()}`
                },
                ...recentMessages
            ];

            // 4. 替换 voiceChat.messages
            this.voiceChat.messages.length = 0; // 清空数组
            this.voiceChat.messages.push(...newMessages);

            const endTime = Date.now();
            const duration = endTime - startTime;

            console.log(`✅ 上下文压缩完成 - 用时: ${duration}ms`);
            console.log(`📊 压缩前: ${totalMessages}条 → 压缩后: ${this.voiceChat.messages.length}条`);
            logToTerminal('info', `✅ 上下文压缩完成 - ${totalMessages}条 → ${this.voiceChat.messages.length}条 (${duration}ms)`);

        } catch (error) {
            console.error('❌ 压缩执行失败:', error);
            logToTerminal('error', `❌ 压缩执行失败: ${error.message}`);
            throw error;
        } finally {
            this.isCompressing = false;
        }
    }

    /**
     * 调用LLM压缩多条消息
     * @param {Array} messages - 需要压缩的对话消息
     * @param {String|null} previousSummary - 上一次的历史总结（如果有）
     * @param {Number} maxTokens - 总结长度上限（旧路径默认 500，rolling 传更小值）
     * @param {String|null} promptOverride - 覆盖默认压缩提示词（rolling 用滚动专用提示词）
     */
    async compressMessages(messages, previousSummary = null, maxTokens = 500, promptOverride = null) {
        try {
            const basePrompt = promptOverride || this.compressionPrompt;
            // 构建对话文本
            const conversationText = messages.map(msg => {
                if (msg.role === 'user') {
                    return `用户: ${this.extractTextContent(msg.content)}`;
                } else if (msg.role === 'assistant') {
                    return `AI: ${this.extractTextContent(msg.content)}`;
                } else if (msg.role === 'system') {
                    return `系统: ${this.extractTextContent(msg.content)}`;
                }
                return '';
            }).filter(text => text).join('\n');

            // 🔧 修复：如果有历史总结，加入到压缩提示中做累积总结
            let compressPrompt;
            if (previousSummary) {
                compressPrompt = `${basePrompt}

【之前的历史总结】：
${previousSummary}

【本次新增的对话内容】：
${conversationText}

请将之前的历史总结与本次新对话合并，生成一个完整的累积总结：`;
            } else {
                compressPrompt = `${basePrompt}

对话内容：
${conversationText}

总结：`;
            }

            console.log('🤖 调用LLM进行上下文压缩...');

            // 调用LLM API
            const response = await fetch(`${this._llmApiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this._llmApiKey}`
                },
                body: JSON.stringify({
                    model: this._llmModel,
                    messages: [{
                        role: 'user',
                        content: compressPrompt
                    }],
                    stream: false,
                    max_tokens: maxTokens // 限制总结长度
                })
            });

            if (!response.ok) {
                throw new Error(`LLM API请求失败: ${response.status}`);
            }

            const data = await response.json();
            const summary = data.choices[0].message.content;

            console.log('✅ LLM压缩完成，总结长度:', summary.length);
            return summary;

        } catch (error) {
            console.error('❌ LLM压缩调用失败:', error);
            throw error;
        }
    }

    /**
     * 提取消息的文本内容（处理多模态消息）
     */
    extractTextContent(content) {
        if (typeof content === 'string') {
            return content;
        }

        // 如果是数组（多模态消息，如图片+文本）
        if (Array.isArray(content)) {
            const textParts = content
                .filter(part => part.type === 'text')
                .map(part => part.text);
            return textParts.join(' ');
        }

        return '';
    }

    /**
     * 手动触发压缩（用于测试或特殊情况）
     */
    async manualCompress() {
        console.log('🔧 手动触发上下文压缩');
        logToTerminal('info', '🔧 手动触发上下文压缩');

        await this.performCompressionAsync();
    }

    /**
     * 获取压缩器状态
     */
    getStatus() {
        return {
            enabled: this.enabled,
            isCompressing: this.isCompressing,
            currentMessages: this.voiceChat.messages.length,
            triggerThreshold: this.triggerThreshold
        };
    }
}

module.exports = { ContextCompressor };
