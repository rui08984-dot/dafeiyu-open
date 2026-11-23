// InputRouter.js - 输入路由
const fs = require('fs');
const path = require('path');
const { eventBus } = require('../../core/event-bus.js');
const { Events } = require('../../core/events.js');
const { MessageEvent } = require('../../core/message-event.js');
// A4 轮次归因（2026-11-21）：输入侧先开轮（source=text/voice），llm-handler 的
// ensureTurn 会复用这个 id。插件拦截（_defaultPrevented）时由这里收轮。
const turnCtx = require('../../core/turn-context.js');
// ADR-013：真实用户输入写「对话现场」（她主动说完后的重逢误判就是缺这一层）
const scene = require('../../core/conversation-scene.js');

// 8103 写令牌（2026-11-21 红队 P1）：皮套窗 nodeIntegration=true，主进程通过
// webPreferences.additionalArguments 注入 --pet-control-token；本页是 file:// 源，
// POST /dsh/reply 属「浏览器来源写请求」，不带令牌会被 8103 回 403。
function petControlToken() {
    try {
        const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
        const hit = argv.find((a) => typeof a === 'string' && a.startsWith('--pet-control-token='));
        return hit ? hit.slice('--pet-control-token='.length) : '';
    } catch (e) { return ''; }
}

/**
 * 负责路由不同来源的输入（语音/文本/弹幕）
 */
class InputRouter {
    constructor(conversationCore, _unused1, contextCompressor, memosClient, config) {
        this.conversationCore = conversationCore;
        this.contextCompressor = contextCompressor;
        this.memosClient = memosClient;  // 🔥 新增：MemOS 客户端
        this.config = config;

        // UI回调（稍后设置）
        this.showSubtitle = null;
        this.hideSubtitle = null;

        // LLM处理器（稍后设置）
        this.llmHandler = null;

        // BarrageManager引用（用于打断）
        this.barrageManager = null;

        // VoiceChatFacade 引用（用于记忆注入）
        this.voiceChatFacade = null;
    }

    /**
     * 设置 VoiceChatFacade 引用
     */
    setVoiceChatFacade(facade) {
        this.voiceChatFacade = facade;
    }

    /**
     * 设置BarrageManager引用
     */
    setBarrageManager(barrageManager) {
        this.barrageManager = barrageManager;
    }

    /**
     * 设置UI回调
     */
    setUICallbacks(showSubtitle, hideSubtitle) {
        this.showSubtitle = showSubtitle;
        this.hideSubtitle = hideSubtitle;
    }

    /**
     * 设置LLM处理器
     */
    setLLMHandler(handler) {
        this.llmHandler = handler;
    }

    /**
     * 运行插件的 onUserInput 钩子，返回处理后的 MessageEvent
     * @param {string} text
     * @param {string} source
     * @returns {Promise<MessageEvent>}
     */
    async _runUserInputHooks(text, source) {
        // ADR-013：真实用户输入 = 一次接触。这里只写内存现场，**不写锚点文件** ——
        // memory-recall 的久别重逢是「先读旧值、再写 now」，我们必须让它先读。
        const turnStartedAt = Date.now();
        // 主动性预算用它判断「她开口后你有没有反应」（2026-11-15）：
        // 90 秒窗口内出现用户输入 = accepted；说「别说了/烦」= negative。
        try { global.__lastUserInputAt = Date.now(); global.__lastUserText = String(text || ''); } catch (e) { /* 全局变量写失败不影响对话 */ }
        const event = new MessageEvent(text, source);
        if (global.pluginManager) {
            await global.pluginManager.runUserInputHooks(event);
        }
        try {
            // 用插件处理后的文本：记忆命令（「记住 X」）可能被钩子改写，现场应记最终语义
            scene.noteUser(event.text || text);
            // 钩子跑完再补锚点：memory-recall 正常会写；它没写（被禁用/异常）时这里兜底，
            // 否则「她说完→用户回复」的重逢判定会一直拿更早的时间当上次见面。
            scene.markUserContactIfStale(turnStartedAt);
        } catch (e) { /* 现场失败不影响对话 */ }
        return event;
    }

    /**
     * 把用户这条消息回传给 8103 的 DSH 人工应答通道（2026-11-20 六十六轮）。
     * 只有 DSH 正在等答案时宿主才会消费（返回 consumed:true）；平时回 consumed:false，
     * 对正常对话零影响。全程 fire-and-forget + 1.5s 上限 + 吞异常 ——
     * 这条旁路绝不允许拖慢或打断对话主链。
     */
    _relayDshReply(text, source) {
        try {
            const t = String(text || '').trim();
            if (!t || typeof fetch !== 'function') return;
            const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) { /* 已结束 */ } }, 1500) : null;
            const token = petControlToken();
            const headers = { 'Content-Type': 'application/json' };
            if (token) headers['X-Pet-Token'] = token;
            fetch('http://127.0.0.1:8103/dsh/reply', {
                method: 'POST',
                headers,
                body: JSON.stringify({ text: t, source: source || 'unknown' }),
                signal: ctrl ? ctrl.signal : undefined,
            }).then((r) => {
                if (r && r.ok) return r.json();
                // 不能静默失败：令牌缺失/不匹配必须是可见的 403 + 日志（否则 DSH 审批答不上）
                if (r && r.status === 403) {
                    console.warn('[dsh/ask] /dsh/reply 被 403 拒绝（缺 X-Pet-Token 或令牌不匹配）：', r.status);
                }
                return null;
            }).then((d) => {
                if (d && d.consumed) console.log('[dsh/ask] 用户回答已回传 DSH:', t.slice(0, 80));
            }).catch(() => { /* 8103 不在/被拦：不影响对话 */ })
              .finally(() => { if (timer) clearTimeout(timer); });
        } catch (e) { /* 任何异常都不许冒泡到对话路径 */ }
    }

    /**
     * 处理语音输入
     */
    async handleVoiceInput(text) {
        // A4：输入侧开轮（source 比 llm-handler 的兜底 'chat' 更准）
        turnCtx.beginTurn('voice');
        turnCtx.markPhase('input');
        // DSH 若正在等人工答案，这句话同时作为回答回传（不改变下面正常流程）
        this._relayDshReply(text, 'voice');

        // 🔥 用户语音输入时：打断弹幕处理 + 清空弹幕队列
        if (this.barrageManager) {
            this.barrageManager.setInterrupt();
            this.barrageManager.clearNormalQueue();
        }

        // 运行插件 onUserInput 钩子
        // memos 插件：injectRelevantMemories 均在此处通过钩子触发，无需在下方重复调用
        const event = await this._runUserInputHooks(text, 'voice');
        if (event._defaultPrevented) { turnCtx.endTurn('prevented'); return; } // 插件自行处理，跳过 LLM

        const finalText = event.text;

        // 处理插件追加的上下文
        const contextAdditions = event.getContextAdditions();
        const promptWithContext = contextAdditions.length > 0
            ? finalText + '\n\n' + contextAdditions.join('\n')
            : finalText;

        // 发送到LLM
        try {
            await this.llmHandler(promptWithContext);
        } catch (e) {
            turnCtx.endTurn('error');
            throw e;
        }

        // 保存到记忆库
        this.saveToMemoryLog();
    }

    /**
     * 处理文本输入（来自聊天框）
     */
    async handleTextInput(text) {
        // A4：输入侧开轮（source=text）
        turnCtx.beginTurn('text');
        turnCtx.markPhase('input');
        // DSH 若正在等人工答案，这句话同时作为回答回传（不改变下面正常流程）
        this._relayDshReply(text, 'text');

        // 🔥 用户文本输入时：打断弹幕处理 + 清空弹幕队列
        if (this.barrageManager) {
            this.barrageManager.setInterrupt();
            this.barrageManager.clearNormalQueue();
        }

        // 显示用户消息
        this.addChatMessage('user', text);

        // 运行插件 onUserInput 钩子（memos 插件在此注入记忆）
        const event = await this._runUserInputHooks(text, 'text');
        if (event._defaultPrevented) { turnCtx.endTurn('prevented'); return; }

        const finalText = event.text;

        // 处理插件追加的上下文
        const contextAdditions = event.getContextAdditions();
        const promptWithContext = contextAdditions.length > 0
            ? finalText + '\n\n' + contextAdditions.join('\n')
            : finalText;

        // 发送到LLM
        try {
            await this.llmHandler(promptWithContext);
        } catch (e) {
            turnCtx.endTurn('error');
            throw e;
        }

        // 保存到记忆库
        this.saveToMemoryLog();

        // 触发用户消息已接收事件（用于心情系统）
        // 2026-11-10：带上原文 —— 心情伤口要记「因为哪句话」，之前只发空事件导致 note 全空
        eventBus.emit(Events.USER_MESSAGE_RECEIVED, { text: finalText });
    }

    /**
     * 处理弹幕输入
     */
    async handleBarrageInput(nickname, text) {
        // 弹幕处理逻辑通过BarrageManager完成
        // 这里只是一个占位方法，实际使用中通过handleBarrageMessage调用
    }

    /**
     * 添加聊天消息到界面
     */
    addChatMessage(role, content) {
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            const messageElement = document.createElement('div');
            // 2026-11-21 红队审计 P1：原来是 innerHTML + 原样插 `${content}` —— 聊天框里
            // 粘贴/输入 `<img onerror=...>` 会执行；本窗口 nodeIntegration=true、
            // contextIsolation=false，DOM XSS 直接等于本机 RCE。改成纯文本节点。
            const strong = document.createElement('strong');
            strong.textContent = role === 'user' ? '你' : '大肥鱼';
            messageElement.appendChild(strong);
            messageElement.appendChild(document.createTextNode(': ' + content));
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    /**
     * 保存到记忆库
     */
    saveToMemoryLog() {
        const messages = this.conversationCore.getMessages();
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const lastAIMsg = messages.filter(m => m.role === 'assistant').pop();

        if (lastUserMsg && lastAIMsg) {
            const newContent = `【用户】: ${lastUserMsg.content}\n【大肥鱼】: ${lastAIMsg.content}\n`;

            try {
                fs.appendFileSync(
                    path.join(__dirname, '..', '..', '..', '..', 'data', '记忆库.txt'),
                    newContent,
                    'utf8'
                );
            } catch (error) {
                console.error('保存记忆库失败:', error);
            }
        }
    }
}

module.exports = { InputRouter };
