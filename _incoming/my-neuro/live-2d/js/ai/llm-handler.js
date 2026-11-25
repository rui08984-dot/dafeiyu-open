// llm-handler.js - LLM处理逻辑模块
const __silentAudit = require('../core/silent-audit.js');
const { logToTerminal, logToolAction, getMergedToolsList } = require('../api-utils.js');
const { eventBus } = require('../core/event-bus.js');
const { Events } = require('../core/events.js');
const { appState } = require('../core/app-state.js');
const { LLMClient } = require('./llm-client.js');
const { toolExecutor } = require('./tool-executor.js');
const { getAvatarMotionMode } = require('../avatar/motion-mode.js');
const { motionDirector, isChoreographyConfigEnabled } = require('./motion-director.js');
const { llmProviderManager } = require('../core/llm-provider.js');
const { armLatencyFiller } = require('../voice/latency-filler.js');
const { classifyIntentLocal, shouldOmitTools } = require('./intent-router.js');
const promptLayout = require('../core/prompt-layout.js');
const { collectVolatilePromptPatches } = require('../core/plugin-context.js');
const { detectLoop } = require('../core/loop-guard.js');
const { singleton: speechCoordinator } = require('../core/speech-coordinator.js');
// D4（2026-11-22）：打断后「接着说」。唯一的 take() 入口收在 resume-speech 内部，
// 只有用户显式请求（接着说/继续刚才）才会被调用；这里只负责结算 TTL 与分派。
const resumeSpeech = require('../core/resume-speech.js');
// ADR-013：她每次最终回复写「对话现场」；现场行走易变尾巴（不破前缀缓存）
const scene = require('../core/conversation-scene.js');
// A4 轮次归因（2026-11-21）：llm-handler 是**所有**走 LLM 的入口，开轮/收轮放这里，
// 任何来源（用户/主动/弹幕/DSH）的轮次都必然有 turn_id。
const turnCtx = require('../core/turn-context.js');
// C3（2026-11-21）：上下文预算账本（只测量，不改行为）
const contextBudget = require('../core/context-budget.js');
// P0-2（2026-11-24）：工具回执体积上限。单轮工具循环能把 history 顶到 68k，
// 压缩钩子只在回复定稿后跑，救不了那一轮；这里在每次请求前封顶（见模块头注释）。
const toolResultCap = require('./tool-result-cap.js');
// P0-1（2026-11-25 审计）：`see image` 的标注图以前是 base64 文本，模型从来没见过图。
// 这里把工具回执里的 base64 剥成图片消息（纯函数，见模块头注释）。
const toolImageAttach = require('./tool-image-attach.js');
// ADR-014（2026-11-24）：artifact 清理——进程内只跑一次（保留最近 200 个 / 7 天）。
const toolArtifact = require('./tool-result-artifact.js');
let __artifactCleanupDone = false;
function _cleanupArtifactsOnce() {
    if (__artifactCleanupDone) return;
    __artifactCleanupDone = true;
    try {
        const r = toolArtifact.cleanupArtifacts();
        if (r && r.removed) logToTerminal('info', '🧹 tool-artifacts 清理：删除 ' + r.removed + ' 个（保留最近 200 个/7 天）');
    } catch (e) { /* 清理失败不影响对话 */ }
}

/**
 * 把一轮失败翻译成遥测口径（2026-11-25）。
 * 旧实现 runTurn 内部吞掉错误后正常 return → runTurnWithTurn 一律 endTurn('ok')，
 * turn.end 里「失败」和「成功」长得一样。这里只做分类，不改任何对话行为。
 * @returns {{outcome:'ok'|'error'|'interrupted'|'blocked', errorKind?:string}}
 */
function classifyTurnFailure(error) {
    const msg = String((error && (error.message || error)) || '').trim();
    const low = msg.toLowerCase();
    if (msg === 'USER_INTERRUPTED' || low.includes('user_interrupted')) {
        return { outcome: 'interrupted', errorKind: 'interrupted' };
    }
    // 配额/限流：llm-client 对 429 的 reason 就是 quota；文案里也可能只有中文
    if (/quota|rate[\s_-]?limit|too many requests|insufficient|配额|请求过于频繁|频率超限|限额|额度/.test(low)
        || /\b429\b/.test(msg)) {
        return { outcome: 'blocked', errorKind: 'quota' };
    }
    if (msg.includes('未获取到有效') || msg.includes('空回复') || msg.includes('空响应')
        || low.includes('empty response')) {
        return { outcome: 'error', errorKind: 'empty' };
    }
    if (msg.includes('工具调用失败') || msg.includes('工具链') || low.includes('tool call failed')
        || low.includes('tool_use')) {
        return { outcome: 'error', errorKind: 'tool' };
    }
    if ((error && error.name === 'SyntaxError') || low.includes('syntaxerror')
        || msg.includes('响应格式异常') || msg.includes('解析API响应') || low.includes('parse')) {
        return { outcome: 'error', errorKind: 'parse' };
    }
    if (low.includes('network') || low.includes('fetch') || low.includes('econn')
        || low.includes('etimedout') || low.includes('enotfound') || low.includes('socket')
        || low.includes('timeout') || low.includes('timed out') || low.includes('abort')
        || msg.includes('网络') || msg.includes('超时') || msg.includes('连接失败')) {
        return { outcome: 'error', errorKind: 'network' };
    }
    return { outcome: 'error', errorKind: 'unknown' };
}

// ── 会话级工具子集的会话标识（ADR-014 轨道 2-7）──────────────────────────
// voiceChat 对象在会话生命周期内是同一份引用 → WeakMap 分配稳定 sessionKey。
// 只有模式变化才重选工具；同一会话 + 同一模式 = 同一份 tools（前缀缓存不被打穿）。
const _sessionKeys = new WeakMap();
let _sessionSeq = 0;
function _sessionKeyFor(vc) {
    if (!vc || typeof vc !== 'object') return 'default';
    let k = _sessionKeys.get(vc);
    if (!k) {
        _sessionSeq += 1;
        k = 's' + _sessionSeq;
        _sessionKeys.set(vc, k);
    }
    return k;
}

/** 工具名集合的稳定指纹（只用于日志观测，不参与决策）。 */
function _toolHash(tools) {
    const names = (Array.isArray(tools) ? tools : [])
        .map((t) => String((t.function && t.function.name) || t.name || ''))
        .filter(Boolean).sort();
    let h = 5381;
    const s = names.join(',');
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
}
// D5（2026-11-22）：回复完成后结算记忆兑现率（只观测；注入侧在 memory-recall）。
const memoryUsage = require('../core/memory-usage.js');
const fs = require('fs');
const path = require('path');
// §72 搭车：主模型在回复末尾附一行 #mood:（见 mood-line.js 头注释）
const { MOOD_INSTRUCTION: _MOOD_INSTRUCTION, MOOD_TAIL_HINT, createMoodStreamFilter, extractMoodLine } = require('./mood-line.js');
const moodRelay = require('../core/mood-relay.js');
// WARN 2026-11-18 §72 实测：llm-handler 跑在**渲染进程**（app-initializer 里创建），而
//   sense-intent-describe 的 IPC 处理器在**主进程** —— 两边各有一份 mood-relay 模块实例。
//   只写本地那份，主进程读不到（实测 /chat 真跑了一轮，describe 仍返回「未启用」）。
//   所以本地记完必须再发一条 IPC 给主进程。
function _setMoodSafe(mood, meta) {
    try { logToTerminal('info', '[mood] 提取到：' + String(mood || '').slice(0, 40)); } catch (e) { /* 日志失败不影响 */ }
    try { moodRelay.setMood(mood, meta || {}); } catch (e) { /* 本地失败不影响主链 */ }
    try { scene.noteMood(mood); } catch (e) { /* 现场失败不影响主链 */ }
    try {
        const { ipcRenderer } = require('electron');
        if (ipcRenderer && typeof ipcRenderer.send === 'function') {
            ipcRenderer.send('mood-line', { mood: String(mood || ''), at: Date.now() });
        }
    } catch (e) { /* 纯 Node（探针/单测）没有 ipcRenderer */ }
}

// TTS 中间段等待（工具调用前 / 视觉分析后）：只监听 TTS_END/TTS_INTERRUPTED 而没有超时，
// 一旦 TTS 侧崩了或事件丢了，这一轮会**永久挂住**（用户看到的是「她不理我」）。
// 2026-11-22 P2：加 45 秒兜底。正常一段中间回复远小于它；超时按「播完」继续并出声，
// 宁可她少等一段，也不把整轮对话冻死。
const TTS_WAIT_TIMEOUT_MS = 45000;
let __ttsWaitTimeouts = 0;
function waitTtsDone(label) {
    return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (why) => {
            if (done) return;
            done = true;
            eventBus.off(Events.TTS_END, onEnd);
            eventBus.off(Events.TTS_INTERRUPTED, onInterrupted);
            if (timer) { clearTimeout(timer); timer = null; }
            if (why === 'timeout') {
                __ttsWaitTimeouts += 1;
                try {
                    logToTerminal('warn', '[TTS] 等待「' + label + '」播放结束超时 ' + Math.round(TTS_WAIT_TIMEOUT_MS / 1000)
                        + 's，按结束继续（TTS 可能崩溃或事件丢失，累计 ' + __ttsWaitTimeouts + ' 次）');
                } catch (e) { /* 日志失败不影响继续 */ }
            }
            resolve();
        };
        const onEnd = () => { setTimeout(() => finish('end'), 300); };   // 原行为：结束后留 300ms 余量
        const onInterrupted = () => finish('interrupted');
        eventBus.on(Events.TTS_END, onEnd);
        eventBus.on(Events.TTS_INTERRUPTED, onInterrupted);
        timer = setTimeout(() => finish('timeout'), TTS_WAIT_TIMEOUT_MS);
        if (timer.unref) timer.unref();
    });
}
function ttsWaitStats() {
    return { timeouts: __ttsWaitTimeouts, timeoutMs: TTS_WAIT_TIMEOUT_MS };
}
// 新守卫要有可观测计数：doctor/8004 直接读 global.__ttsWaitStats()
try { globalThis.__ttsWaitStats = ttsWaitStats; } catch (e) { /* 纯 Node 环境没有 global 也正常 */ }

// 两条「这一轮才需要她知道」的提示（走易变尾巴，不碰 system/历史）：
let _pendingInterruptNote = '';
let _pendingLoopNote = '';

// ADR-014 漏一（2026-11-24）：轮内前缀冻结的「复用/重建/断裂」必须可聚合 ——
// 「缓存断裂可观测」是这一轮的核心交付，不能只靠日志文本（日志一冲就没人知道）。
// 轮末落一条 llm.freeze，字段 reuse/rebuild/rewrite；doctor / 验收直接读它。
let __emitTelemetry = null;
try { __emitTelemetry = require('../core/telemetry.js').emitTelemetry; } catch (e) { __emitTelemetry = null; }

function saveScreenshotForHistory(base64Image) {
    // P0（2026-11-25 风暴压测）：目录必须走 records-path 单一真源。
    // 旧实现自己拼 __dirname/../../../data —— 忽略了 PET_DATA_ROOT，测试跑一轮就往
    // 用户真实记录室写一张截图（探针污染真实数据）。压缩/历史/画像都是同一口径，这里也统一。
    let recordsDir = path.join(__dirname, '..', '..', '..', 'data');
    try {
        const rp = require('../core/records-path.js');
        if (rp && rp.RECORDS_DIR) recordsDir = rp.RECORDS_DIR;
    } catch (e) { /* 没有 records-path 就按历史层级回落 */ }
    const screenshotDir = path.join(recordsDir, '对话截图');
    fs.mkdirSync(screenshotDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}.jpg`;
    fs.writeFileSync(path.join(screenshotDir, filename), Buffer.from(base64Image, 'base64'));
    return `对话截图/${filename}`;
}

/**
 * 轮末清理：同一来源只保留**最新一张**截图，更早的图片剥成文字（省 token）。
 *
 * 为什么是轮末（ADR-014 漏一，2026-11-24）：这段逻辑原来在截图工具分支里**当场**剥宿主旧图。
 * 轮内冻结前缀覆盖的字节被它一改，从那条消息起整段缓存失效 —— 等价于自己打穿缓存。
 * 放到「工具循环已经结束、这一轮不再发请求」之后做：下一轮前缀本来就会因为新 user 消息
 * 重置一次，代价相同，而轮内保证几十次请求逐字节命中。
 *
 * 2026-11-25 收尾：**按来源分槽**。旧实现是「全历史最新一张优先」——用户发的截图 +
 *   `see image` 工具图在同一轮时，只要工具图更新，用户那张就被剥成文字（模型下一轮
 *   问「我刚给你看的图」就答不上来）。现在：
 *     · user 槽（用户消息里的 image_url）保留 1 张；
 *     · tool 槽（工具附图，靠 `TOOL_IMAGE_TEXT` 标记识别）保留 1 张；
 *   清理时只清**同槽**旧的，两槽互不挤占。
 *
 * @param {Array} messages voiceChat.messages（原地改）
 * @returns {number} 被剥掉图片的消息条数
 */
function stripOldScreenshotImages(messages) {
    if (!Array.isArray(messages)) return 0;
    // 从后往前找每个槽的最新一张：它们要留给模型（当前正在看的就是它们）
    let keepUser = -1;
    let keepTool = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue;
        if (!m.content.some((p) => p && p.type === 'image_url')) continue;
        if (toolImageAttach.isToolImageMessage(m)) {
            if (keepTool < 0) keepTool = i;
        } else if (keepUser < 0) {
            keepUser = i;
        }
        if (keepUser >= 0 && keepTool >= 0) break;
    }
    let stripped = 0;
    messages.forEach((msg, i) => {
        if (i === keepUser || i === keepTool) return;
        if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) return;
        if (!msg.content.some((p) => p && p.type === 'image_url')) return;
        const textItems = msg.content.filter((p) => p && p.type === 'text');
        msg.content = textItems.length > 0 ? textItems.map((p) => p.text).join(' ') : '(截图已清除)';
        stripped += 1;
    });
    return stripped;
}

/**
 * 请求体里的「历史图片清理」（P1-1，2026-11-24 对抗审查）。
 *
 * 这里只改**请求副本**（messagesForAPI），宿主 voiceChat.messages 留给轮末
 * stripOldScreenshotImages 处理 —— 轮内改宿主 = 改写冻结前缀覆盖的字节。
 *
 * 为什么必须是独立函数、且在**冻结点之前**调用一次：
 *   旧实现在 vision/main 分支里（冻结之后）剥图。无新截图的那一轮，第 1 次请求发出去的
 *   是剥图后的字节，快照却带着图 → 第 2 次请求 compose 用快照 → 图片「复活」，
 *   前缀从那一条消息起分叉，而 llm.freeze 仍然报 reuse 成功（假命中）。
 *   现在顺序固定为：克隆宿主 → 附加新截图（若有）→ 剥历史图 → 拼易变尾巴 → 冻结 →
 *   发请求。快照 == 首次请求的真实字节；后续请求 compose 出来自然逐字节一致。
 *
 * 语义（与原实现一致）：
 *   · 本轮有新截图（iteration===0 且 screenshotBase64）→ 不剥，整套图都留给模型；
 *   · 没有新截图 / 已经进入工具循环 → 历史图剥成文字（省 token）。
 *
 * P0-1（2026-11-25）：`see image` 的工具附图是**这一轮的输入**（模型刚要看它），
 *   不能被当成「历史图」剥掉 —— 否则图片在进请求前就被清空，等于没修。这里永远
 *   保留**最新一条工具附图**，其余（含旧的工具图/用户旧截图）照旧剥。
 *
 * @param {Array} messages 请求副本（原地改）
 * @param {string|null} screenshotBase64 本轮用户新截图
 * @param {number} iteration 当前工具循环轮次
 * @returns {number} 被剥掉图片的消息条数
 */
function stripHistoryImagesForRequest(messages, screenshotBase64, iteration) {
    if (!Array.isArray(messages)) return 0;
    if (screenshotBase64 && !(Number(iteration) > 0)) return 0;
    // 最新一条工具附图只在**工具循环内**留给模型（see image 的回执就是它）。
    // 2026-11-25 对抗审计 P1-1：跨轮不清理 → 180KB base64 永久驻留每轮请求。
    // iteration===0 = 新一轮的第一次请求，此时历史里的工具图都已过期，全部剥掉；
    // iteration>0 = 本轮工具循环，保留最新一张。
    let keepToolImage = -1;
    if (toolImageAttach.keepToolImageForIteration(iteration)) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (toolImageAttach.isToolImageMessage(messages[i])) { keepToolImage = i; break; }
        }
    }
    let stripped = 0;
    messages.forEach((msg, i) => {
        if (i === keepToolImage) return;
        if (!msg || msg.role !== 'user' || !Array.isArray(msg.content)) return;
        if (!msg.content.some((item) => item && item.type === 'image_url')) return;
        const textItems = msg.content.filter((item) => item && item.type === 'text');
        msg.content = textItems.length > 0 ? textItems.map((item) => item.text).join(' ') : '(图片内容)';
        stripped += 1;
    });
    return stripped;
}

/**
 * 历史里是否已经有「工具附图」（see image 的回执）。
 * 用途：模型返回空响应时，判断「是不是因为这张图不支持」——旧实现只看
 * `screenshotBase64`（用户截图），工具附图导致的空响应会漏判，然后默默空转到放弃。
 */
function hasToolImageMessage(messages) {
    if (!Array.isArray(messages)) return false;
    for (const m of messages) {
        if (toolImageAttach.isToolImageMessage(m)) return true;
    }
    return false;
}

/**
 * 过滤模型思考内容，与 LLMClient._filterThinkingContent 保持一致
 * 作为 TTS/字幕前的二次安全过滤
 */
function filterThinkingContent(text) {
    if (!text) return text;
    let filtered = text;
    filtered = filtered.replace(/<think>[\s\S]*?<\/think>/gi, '');
    filtered = filtered.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    if (/^思考\s*\n/.test(filtered)) return '';
    if (/^Thinking\s*\n/i.test(filtered)) return '';
    return filtered.trim();
}

// 编舞会关闭流式 TTS 改走整段播放。动作模式选了 AI 编舞时开启；
// 仓库里曾经把 enabled 默认写成 false，WebUI 又没有独立开关，所以不能再要求 enabled === true。
function describeChoreographySkip(config = {}) {
    if (config?.tts?.enabled === false) return 'tts-disabled';
    if (config?.ui?.text_only_mode === true) return 'text-only';
    if (!isChoreographyConfigEnabled(config)) return 'legacy-or-paths-disabled';
    if (!global.paramDirector) return 'no-param-director';
    return null;
}

function shouldRunMotionChoreography(config = {}) {
    return describeChoreographySkip(config) == null;
}

// ══ 轮次串行化闸（2026-11-21）══════════════════════════════════════════════
// 缺陷：第二句在首轮未结束时进入 llm-handler，iteration===0 处 ttsProcessor.reset()
//       会清掉第一轮文本/音频队列并 abort 正在合成的段 → 第一条回复被截断、历史交错。
// 策略（为什么这样选）：
//   ① 同一时刻只跑一轮；新输入**排队**（默认最多 2 条），绝不清上一轮队列。
//   ② runTurn 返回 ≠ 上一轮结束：它只把文本塞进 TTS 队列。必须等 TTS 真正播完
//      （waitIdle）再启动下一轮，否则下一轮的 reset() 仍会截断上一轮的声音。
//   ③ 排队调用**立即返回空串**：inputRouter.handleVoiceInput 是 await 的，若排队也
//      await 整轮结束，ASR 的 asrLocked 会被锁住 10s+，第三句就录不进来。
//      代价是这句的返回值（给插件的 _finalReply）为空——它本来就还没有回复。
//   ④ 只有「用户明确打断」才中断并清队：点停止/静音（TTS_INTERRUPTED →
//      appState.isInterrupted）或说「停/别说了/闭嘴」。普通新输入只排队。
//   ⑤ 队列满丢最旧 + 计数 + warn（可观测，不静默）。
const TURN_STOP_RE = /^(停|停下|停下来|停一下|停止|别说了|不要说了|闭嘴|安静|stop|shutup)$/i;

function createTurnGate(options = {}) {
    const runTurn = typeof options.runTurn === 'function' ? options.runTurn : async () => '';
    const maxQueue = Math.max(1, Math.floor(Number(options.maxQueue) || 2));
    const log = typeof options.log === 'function' ? options.log : () => {};
    const isInterrupted = typeof options.isInterrupted === 'function' ? options.isInterrupted : () => false;
    const interrupt = typeof options.interrupt === 'function' ? options.interrupt : () => {};
    const waitIdle = typeof options.waitIdle === 'function' ? options.waitIdle : null;

    const stats = { queued: 0, dropped: 0, cleared: 0, started: 0, explicitStops: 0, lastDropAt: 0 };
    const queue = [];
    let active = false;
    let draining = false;

    const textOf = (prompt) => (Array.isArray(prompt)
        ? (prompt.find((p) => p && p.type === 'text')?.text ?? '')
        : String(prompt ?? ''));
    const isExplicitStop = (text) => TURN_STOP_RE.test(
        String(text || '').replace(/<[^>]*>/g, '').replace(/[\s，。！？!?~～、,.…—\-]/g, ''));

    function publish() {
        try {
            globalThis.__turnQueueStats = { ...stats, pending: queue.length, active, maxQueue };
        } catch (_) { /* 观测失败不影响对话 */ }
    }

    async function runOne(prompt) {
        active = true;
        stats.started += 1;
        publish();
        try {
            return await runTurn(prompt);
        } finally {
            // 关键：上一轮 TTS 没播完就不算结束（否则下一轮 reset 会截断它）
            if (waitIdle) { try { await waitIdle(); } catch (_) { /* 等不到也不能卡死对话 */ } }
            active = false;
            publish();
        }
    }

    function scheduleDrain() {
        if (draining || active || !queue.length) return;
        draining = true;
        (async () => {
            try {
                while (!active && queue.length) {
                    if (isInterrupted() && !queue[0].afterStop) {
                        // 不丢队列（2026-11-21 策略修正）：这个中断信号多半来自「用户抢话」——
                        // 他刚说的那句已经排在这里，丢掉就等于吞掉用户输入。明确「停/停止」
                        // 已在 submit 时清空队列，所以这里只消费信号并留痕，不 destructive。
                        log('info', `[turn-queue] 检测到打断信号：保留排队输入 ${queue.length} 条（可能是刚抢话的那句），继续`);
                        try {
                            if (typeof options.clearInterrupted === 'function') options.clearInterrupted();
                        } catch (_) { /* 清不掉也继续：runTurn 入口自己会清 */ }
                    }
                    const item = queue.shift();
                    try { await runOne(item.prompt); }
                    catch (e) { log('warn', '[turn-queue] 排队轮执行失败：' + ((e && e.message) || e)); }
                }
            } finally {
                draining = false;
                publish();
                // 收尾竞态兜底：入队恰好发生在 while 最后一次判空之后 → 再排一拍
                if (!active && queue.length) {
                    try { setTimeout(scheduleDrain, 0); } catch (_) { /* 排不动也不会更糟 */ }
                }
            }
        })();
    }

    function enqueue(prompt, opts = {}) {
        const text = textOf(prompt);
        if (queue.length >= maxQueue) {
            const dropped = queue.shift();
            stats.dropped += 1;
            stats.lastDropAt = Date.now();
            log('warn', `[turn-queue] 排队已满（${maxQueue}）→ 丢弃最旧：「${String(dropped.text || '').slice(0, 24)}」（累计丢弃 ${stats.dropped}）`);
        }
        const item = { prompt, text, queuedAt: Date.now(), afterStop: opts.afterStop === true };
        if (opts.front) queue.unshift(item); else queue.push(item);
        stats.queued += 1;
        log('info', `[turn-queue] 上一轮仍在进行，新输入排队（${queue.length}/${maxQueue}）：${text.slice(0, 24)}`);
        publish();
        scheduleDrain();   // 竞态兜底：入队瞬间若刚好空闲，立刻消费
        return Promise.resolve('');
    }

    function submit(prompt) {
        const text = textOf(prompt);
        if (isExplicitStop(text)) {
            const n = queue.length;
            queue.length = 0;
            stats.cleared += n;
            stats.explicitStops += 1;
            log('info', `[turn-queue] 用户明确要求停止 → 清空排队 ${n} 条并中断当前播放`);
            try { interrupt(); } catch (e) {
                log('warn', '[turn-queue] 中断调用失败：' + ((e && e.message) || e));
            }
            publish();
            // 「停」本身仍要被她回应：排到队首，等当前轮结束后执行；
            // afterStop 保证它不会被 isInterrupted 的二次清理一起丢掉。
            return enqueue(prompt, { afterStop: true, front: true });
        }
        if (active || draining) return enqueue(prompt);
        const p = runOne(prompt);
        p.then(scheduleDrain, scheduleDrain);
        return p;
    }

    return {
        submit,
        stats: () => ({ ...stats, pending: queue.length, active, maxQueue }),
        pendingTexts: () => queue.map((x) => x.text),
        isActive: () => active,
        cancelPending: (reason = 'cancelled') => {
            const n = queue.length;
            queue.length = 0;
            stats.cleared += n;
            log('info', `[turn-queue] 清空排队 ${n} 条（${reason}）`);
            publish();
            return n;
        },
    };
}

// ══ heard-response（2026-11-22）════════════════════════════════════════════
// 被打断时，历史里只保留「真正播出去」的部分（Open-LLM-VTuber 的 heard_response 思路）。
// 旧行为：tts-processor.llmFullResponse 是**生成**的全文，打断后历史照写全文 →
// 她「记得」用户根本没听到的内容，下一轮还可能引用它。
//
// 现在 tts-processor 在清队前算出可信前缀（对不上就是 null），只在 wasPlaying 时回调；
// 这里只改**最近一条内容匹配**的 assistant 消息，不新增消息、不改顺序、找不准就不动。
const heardText = require('../core/heard-text.js');
let _activeVoiceChat = null;
let _heardListenerInstalled = false;
let _heardPatches = 0;
// 极端时序兜底：如果哪天历史写入挪到了 TTS 之后，回调先到时先存这里，
// 由助手消息落库处（_flushPendingHeard）补打。10 秒内有效，单槽，绝不跨太久误伤。
let _pendingHeard = null;
const HEARD_PENDING_TTL_MS = 10000;

/** 登记当前 voiceChat（createEnhancedSendToLLM 每次创建时调用；通常只有一个）。 */
function rememberVoiceChat(voiceChat) {
    try {
        if (voiceChat && Array.isArray(voiceChat.messages)) _activeVoiceChat = voiceChat;
    } catch (e) { /* ignore */ }
}

/**
 * 历史消息的 content 是否就是这次生成的那条？
 * 只认「相等」或「一边完整包含另一边」，且短的一侧至少 8 字
 * （防止拿「好。」这类短句去误配别的消息）。
 */
function _contentMatchesFull(content, full) {
    if (typeof content !== 'string' || !content || !full) return false;
    if (content === full) return true;
    const shorter = content.length <= full.length ? content : full;
    const longer = content.length <= full.length ? full : content;
    return shorter.length >= 8 && longer.startsWith(shorter);
}

/** 打 interrupted 标记：不可枚举 —— 不随 JSON 落盘、也不会被当成未知字段发给 provider。 */
function _markInterrupted(message) {
    try {
        Object.defineProperty(message, 'interrupted', {
            value: true, enumerable: false, configurable: true, writable: true,
        });
    } catch (e) {
        try { message.interrupted = true; } catch (e2) { /* ignore */ }
    }
}

/** 在已登记的 voiceChat 里找最近一条匹配的 assistant 消息并截断。返回是否改到。 */
function _patchHeardInHistory(full, heard) {
    const vc = _activeVoiceChat;
    const msgs = vc && Array.isArray(vc.messages) ? vc.messages : null;
    if (!msgs) return false;

    for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const m = msgs[i];
        if (!m || m.role !== 'assistant' || typeof m.content !== 'string') continue;
        if (m.interrupted === true) continue;                  // 已经截过，不重复截
        if (!_contentMatchesFull(m.content, full)) continue;   // 不是这条：继续往前找，绝不动别人

        const marked = heardText.markInterrupted(heard.replace(/\s+$/, '') + '……');
        m.content = marked.text;
        _markInterrupted(m);
        _heardPatches += 1;
        try {
            logToTerminal('info', `✂️ 被打断：历史只保留真正播出的 ${heard.length}/${full.length} 字`);
        } catch (e) { /* 日志失败不影响对话 */ }
        return true;
    }
    return false;                                              // 找不到：静默失败
}

function applyHeardResponse(payload) {
    const p = payload || {};
    const full = typeof p.full === 'string' ? p.full : '';
    const heard = typeof p.heard === 'string' ? p.heard : null;
    if (heard == null || !full) return false;
    if (heard.length >= full.length) return false;             // 没截断：历史保持原样

    // 对话现场同口径（2026-11-22）：她刚说也改成真播出去的部分，
    // 否则下一轮「她刚说「…」」注入的还是用户没听过的尾巴。
    try { scene.reviseCompanionHeard(full, heard); } catch (e) { /* 现场修正失败不影响对话 */ }

    if (_patchHeardInHistory(full, heard)) return true;
    _pendingHeard = { full, heard, at: Date.now() };            // 消息可能还没写入 → 落库时补
    return false;
}

/** 助手消息落库后补打（正常时序下 _pendingHeard 为 null，本函数零成本）。 */
function _flushPendingHeard() {
    const p = _pendingHeard;
    if (!p) return false;
    if (Date.now() - p.at > HEARD_PENDING_TTL_MS) { _pendingHeard = null; return false; }
    if (!_patchHeardInHistory(p.full, p.heard)) return false;
    _pendingHeard = null;
    return true;
}

/** 注册到 tts-processor 的显式回调（模块初始化一次；幂等）。 */
function _installHeardListener() {
    if (_heardListenerInstalled) return true;
    try {
        const tts = require('../voice/tts-processor.js');
        if (!tts || typeof tts.setInterruptListener !== 'function') return false;
        tts.setInterruptListener(applyHeardResponse);
        _heardListenerInstalled = true;
        return true;
    } catch (e) {
        return false;
    }
}
_installHeardListener();

class LLMHandler {
    // 创建增强的sendToLLM方法
    static createEnhancedSendToLLM(voiceChat, ttsProcessor, asrEnabled, config) {
        // heard-response：登记这本历史 + 确保监听已装（幂等，只注册一次）。
        rememberVoiceChat(voiceChat);
        _installHeardListener();

        const retryCfg = (config.llm && config.llm.retry) || {};

        // 创建LLM客户端实例：优先走 provider 注册表（通讯录），旧式 config.llm 三格仅作回退
        const resolvedLlmProvider = llmProviderManager.resolveProviderOrFallback(
            (config.llm && config.llm.provider_id) || null,
            (config.llm && config.llm.model_id) || null
        );
        const llmClient = resolvedLlmProvider
            // P1-3：主链显式标 main。原来不传 label，任何含历史图片的请求都会被
            //   _resolveLabel 推断成 vision → lastUsage.main 不更新、真账基线永远失效。
            ? LLMClient.fromProviderConfig(resolvedLlmProvider, retryCfg, 'main')
            : new LLMClient(config);
        if (resolvedLlmProvider) {
            logToTerminal('info', `✅ 对话模型: ${resolvedLlmProvider.model}（提供商: ${resolvedLlmProvider.name || resolvedLlmProvider.id}）`);
        } else if (llmClient && !llmClient.label) {
            // 旧式 config.llm 回退路径同样是主链：显式标 main（理由同上）
            llmClient.label = 'main';
        }
        // ⚠ 采样参数补齐。温度等模型级参数现住通讯录（llm_providers.json 每模型条目），
        // _buildResolved 已把它们平铺进 resolved；config.json 里的同名旧键被设计性迁移删除，
        // 恒为 undefined —— 旧实现只读 config.llm 就会拿兜底值把 resolved 的真值踩掉
        // （面板改温度后运行时静默不生效）。优先级：config.llm 旧键（手工配置兼容）
        // > resolved 通讯录值 > 人格兜底 0.85。temperature=0 是合法值，不能当缺省。
        const SAMPLING_DEFAULTS = { temperature: 0.85, top_p: 0.95, temperature_enabled: true };
        const applySampling = (client, resolved) => {
            if (!client) return client;
            const cfg = (config && config.llm) || {};
            const src = resolved || {};
            const pickNum = (...candidates) => {
                for (const v of candidates) {
                    if (v !== undefined && v !== '') {
                        const n = Number(v);
                        if (Number.isFinite(n)) return n;
                    }
                }
                return null;
            };
            client.temperature = pickNum(cfg.temperature, src.temperature) ?? SAMPLING_DEFAULTS.temperature;
            client.temperatureEnabled = cfg.temperature_enabled !== undefined
                ? cfg.temperature_enabled === true
                : (src.temperature_enabled !== undefined ? src.temperature_enabled === true : SAMPLING_DEFAULTS.temperature_enabled);
            client.topP = pickNum(cfg.top_p, src.top_p) ?? SAMPLING_DEFAULTS.top_p;
            const mt = pickNum(cfg.max_tokens, src.max_tokens);
            if (mt !== null) client.maxTokens = mt;
            logToTerminal('info', `🎛 采样参数: temperature=${client.temperatureEnabled ? client.temperature : '关闭'} top_p=${client.topP ?? '-'}`);
            return client;
        };
        applySampling(llmClient, resolvedLlmProvider);

        // 保底模型：主模型失败/空回复时再试一次；与主模型相同则跳过
        const fallbackProviderId = retryCfg.fallback_provider_id || (retryCfg.fallback && retryCfg.fallback.provider_id) || null;
        const fallbackModelId = retryCfg.fallback_model_id || (retryCfg.fallback && retryCfg.fallback.model_id) || null;
        let fallbackClient = null;
        if (fallbackProviderId || fallbackModelId) {
            const resolvedFallbackProvider = llmProviderManager.resolveProviderOrFallback(
                fallbackProviderId || (config.llm && config.llm.provider_id) || null,
                fallbackModelId || null
            );
            const sameAsPrimary = resolvedFallbackProvider && resolvedLlmProvider &&
                resolvedFallbackProvider.api_url === resolvedLlmProvider.api_url &&
                resolvedFallbackProvider.model === resolvedLlmProvider.model;
            if (resolvedFallbackProvider && !sameAsPrimary) {
                fallbackClient = LLMClient.fromProviderConfig(resolvedFallbackProvider, retryCfg, 'main');
                applySampling(fallbackClient, resolvedFallbackProvider);
                logToTerminal('info', `✅ 保底模型: ${resolvedFallbackProvider.model}（提供商: ${resolvedFallbackProvider.name || resolvedFallbackProvider.id}）`);
            } else if (sameAsPrimary) {
                logToTerminal('warn', '⚠️ 保底模型与主模型相同，已跳过保底模型配置');
            }
        }
        // 暴露给返回的闭包使用（主模型完全失败时的最后一道兜底）
        const getFallbackClient = () => fallbackClient;

        // 创建视觉模型客户端（如果启用）
        let visionClient = null;
        if (config.vision && config.vision.use_vision_model) {
            // 优先走通讯录：vision.provider_id + vision.model_id
            const resolvedVisionProvider = config.vision.provider_id
                ? llmProviderManager.resolveProviderOrFallback(config.vision.provider_id, config.vision.model_id || null)
                : null;
            if (resolvedVisionProvider) {
                visionClient = LLMClient.fromProviderConfig(resolvedVisionProvider, retryCfg, 'vision');
                console.log('✅ 视觉模型已启用:', resolvedVisionProvider.model);
                logToTerminal('info', `✅ 视觉模型已启用: ${resolvedVisionProvider.model}（提供商: ${resolvedVisionProvider.name || resolvedVisionProvider.id}）`);
            } else if (config.vision.vision_model) {
                // 回退：旧式 vision.vision_model 三格
                const visionConfig = {
                    llm: {
                        api_key: config.vision.vision_model.api_key,
                        api_url: config.vision.vision_model.api_url,
                        model: config.vision.vision_model.model
                    }
                };
                visionClient = new LLMClient(visionConfig);
                console.log('✅ 视觉模型已启用:', config.vision.vision_model.model);
                logToTerminal('info', `✅ 视觉模型已启用: ${config.vision.vision_model.model}`);
            }
        }

        // 辅助函数：清理消息中的所有图片内容
        const removeImagesFromMessages = (messages) => {
            return messages.map(msg => {
                if (msg.role === 'user' && Array.isArray(msg.content)) {
                    // 提取所有文本内容
                    const textItems = msg.content.filter(item => item.type === 'text');
                    if (textItems.length > 0) {
                        return {
                            ...msg,
                            content: textItems.map(item => item.text).join(' ')
                        };
                    } else {
                        return {
                            ...msg,
                            content: '(图片内容)'
                        };
                    }
                }
                return msg;
            });
        };

        // 本轮真实结局的「暗号」：runTurn 内部把错误吞成正常 return，外面无从得知；
        // 在 catch 里置位，由 runTurnWithTurn 在 finally 落成 turn.end 的 outcome/errorKind。
        let _turnHint = null;
        // 保底模型救回来的一轮：字幕已经出了，不该被下面的「空 reply」守卫误判成失败
        let _turnFallbackOk = false;
        const runTurn = async function(prompt) {
            _turnHint = null;
            _turnFallbackOk = false;
            // ADR-014：artifact 清理每进程一次（失败只 warn，不影响这轮对话）
            _cleanupArtifactsOnce();
            let hasRetriedWithoutImage = false; // 标志：是否已经重试过（避免无限循环）
            let isFirstAttempt = true; // 标志：是否是第一次尝试
            // P1-2（2026-11-25 风暴压测）：用户这句话是否已经入宿主。
            //   截图不支持时 catch 会把 isFirstAttempt 重置为 true 重走整段流程（需要重新判定截图/
            //   重新拼前缀），但 **user 消息已经在第一次 attempt 时 push 过了**。旧实现只认
            //   isFirstAttempt，重试就会把同一句话再 push 一遍 —— 实测宿主里出现两条相同 user，
            //   模型看到用户「说了两遍」，历史体积也翻倍。用独立标志把「首轮流程」和「入库」解耦。
            let userMessagePushed = false;
            // P0-2：本轮第一条 user 消息在 voiceChat.messages 里的下标。
            // 工具回执的「单轮累计上限」只统计这个下标之后的消息（历史回执只做单条截断）。
            let turnStartIndex = -1;
            // 🧊 轮内前缀冻结（ADR-014 漏一，2026-11-24）：本轮**第一次请求**渲染完的字节快照。
            // 工具循环里后面的请求只许在它后面追加新消息，已发出过的字节一个都不许改；
            // 轮结束（回复/打断/异常/截图重试）在 finally 里清空，下一轮重新冻结。
            let turnFreeze = null;
            // P0（2026-11-25）：本轮截图（base64 + 落盘路径 + 目标下标）。轮内重冻时按它原位重贴，
            // 否则「截图轮被限流/外部改写触发重冻」之后模型就再也看不到屏幕（见重建分支注释）。
            let turnScreenshot = null;
            // 本轮冻结战绩（轮末落 telemetry llm.freeze）：
            //   reuse   = 复用成功发出请求的次数
            //   rebuild = 中途重建冻结的次数（宿主被改写 / 宿主变短）
            //   rewrite = 检测到「已发出过的字节被改写」的次数（host-rewritten / 宿主变短 / 快照被改）
            //   requests= 经冻结通道发出的请求总数（含截图分析那次）
            //   visionLost = 重冻时找不到本轮截图目标的次数（视觉上下文真丢了，必须可观测）
            const freezeStats = { reuse: 0, rebuild: 0, rewrite: 0, requests: 0, prefixMsgs: 0, prefixChars: 0, visionLost: 0 };
            let cancelLatencyFiller = () => {}; // ⚡ 快慢双轨：垫场计时器取消句（本轮 finally 必须收）
            // ── 延迟观测（2026-11-16）──────────────────────────────────────────
            // 用户反馈「说一句话要等好久」，但日志里**一个耗时数字都没有**，只能猜。
            // 这里记三个点：请求开始 → 流式首 token → 首段进 TTS 队列。每轮结束打一行。
            // 排查顺序：首 token 慢 = 模型/网关/上下文；首 token 快到但语音慢 = TTS 串行/分段；
            //           两者都快但你还在等 = 打断/播放队列/前端。
            let _lat = null;
            const shouldRunChoreography = shouldRunMotionChoreography(config);
            const choreographyUserMessage = Array.isArray(prompt)
                ? prompt
                    .filter(item => item && item.type === 'text')
                    .map(item => item.text || '')
                    .join(' ')
                : prompt;

            // 新一轮输入必须终止上一轮尚未完成的编舞请求和时间线。
            motionDirector.cancel('new-turn');
            try {
                global.paramDirector?.cancel?.();
            } catch (_) { try { __silentAudit.audit('llm-handler.js:187', _); } catch (e2) {} }

            // ⚡ 截图判定提前起跑（2026-11-09）：原实现 await 挡在 LLM 请求前，
            // :6007 抖动时整句卡住。现在在进主循环前就发起判定，与「TTS 打断等待/
            // 消息入库/trim」并行跑，到需要结果时大概率已就绪（内部另有 300ms 竞速上限）。
            // 快路径（截图标记/自动截图开关）是纯同步判断，零开销。
            const promptTextEarly = Array.isArray(prompt)
                ? (prompt.find(p => p.type === 'text')?.text ?? '')
                : prompt;
            const screenshotDecisionPromise = Promise.resolve(voiceChat.shouldTakeScreenshot(promptTextEarly))
                .catch(err => { console.error('截图判定异常:', err); return false; });

            // 最终回复文本（2026-11-12 根因修复）：
            // sendToLLM 原来**没有任何 return**，插件 context.sendMessage() 拿到的永远是 undefined。
            // live-dock 因此每次都判「生成结果为空」（实测 7/7 误报），并且从不 markSpoken → 说话协调器形同虚设。
            // 这里把本轮最终回复文本回传，插件侧就能拿到真实结果。
            let _finalReply = '';

            // 🔥 外层重试循环：用于处理视觉不支持错误
            while (true) {
                try {
                    // 🧊 每次尝试单独记账（截图重试会重走一遍 attempt）：轮末各自落一条 telemetry，
                    // 聚合时相加不会重复计。冻结本身也按 attempt 生命周期清空（见 finally）。
                    freezeStats.reuse = 0;
                    freezeStats.rebuild = 0;
                    freezeStats.rewrite = 0;
                    freezeStats.requests = 0;
                    freezeStats.prefixMsgs = 0;
                    freezeStats.prefixChars = 0;
                    freezeStats.visionLost = 0;
                    // 发送用户输入开始事件（仅第一次）
                    if (isFirstAttempt) {
                        eventBus.emit(Events.USER_INPUT_START);
                        // 用户这轮开始：主动发起者（主动搭话/看屏/弹幕）在她说这句之前一律让路
                        try { speechCoordinator.markUser(); } catch (e) { /* 协调器不可用不影响主链 */ }
                    }

                // 检查是否正在播放TTS，如果是则先中断（仅第一次）
                if (isFirstAttempt && appState.isPlayingTTS()) {
                    console.log('检测到TTS正在播放，执行打断操作');
                    logToTerminal('info', '检测到TTS正在播放，执行打断操作');

                    // 发送中断信号（用户显式喊停：这次确实算「打断」）
                    if (ttsProcessor) {
                        ttsProcessor.interrupt({ reason: 'explicit-stop' });
                    }

                    // 隐藏字幕
                    if (global.hideSubtitle) {
                        global.hideSubtitle();
                    }

                    // 被打断这件事要让她知道（Neuro-sama 行为调研里的失败模式：被打断却不自知，
                    // 下一轮接着把上一段讲完）。只放进**易变尾巴**，不写历史、不改 system —— 不伤缓存。
                    _pendingInterruptNote = '（你上一句还没说完就被他打断了。别接着讲完，先回应他现在说的。）';

                    // 等待中断真正完成（#15，2026-11-09）：原实现固定 sleep(100)——
                    // 打断常常 10-30ms 就完成了，白等 70-90ms 直接推迟首字；
                    // 而 GPU/音频忙时 100ms 又可能不够。
                    // 改为「轮询真实状态 + 上限 100ms」：一旦确认不在播就立刻继续。
                    const waitStart = Date.now();
                    while (Date.now() - waitStart < 100) {
                        const stillPlaying = (ttsProcessor && typeof ttsProcessor.isPlaying === 'function')
                            ? ttsProcessor.isPlaying()
                            : appState.isPlayingTTS();
                        if (!stillPlaying) break;
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }

                // global.isProcessingUserInput 已通过事件自动管理，无需手动设置

                // 只在第一次尝试时添加用户消息
                if (isFirstAttempt) {
                    // ⚠ 截图重试会回到这里（isFirstAttempt 被重置），但用户消息只许入库一次。
                    //   重复 push 会让模型以为用户把同一句话说了两遍，且历史体积无故翻倍。
                    if (!userMessagePushed) {
                        voiceChat.messages.push({ 'role': 'user', 'content': prompt });
                        userMessagePushed = true;
                        if (voiceChat.enableContextLimit) {
                            voiceChat.trimMessages();
                        }
                        // ⚠ trim 可能把数组前段裁掉、下标整体前移 —— 必须在 trim **之后**取下标。
                        // 刚 push 的 user 消息在保留窗口内（trim 保留最新 maxContextMessages 条）。
                        turnStartIndex = voiceChat.messages.length - 1;
                    } else {
                        // 重试轮：消息已在宿主里，仍要执行裁剪；但 trim/removeImages 都会换数组、
                        // 让旧下标漂移。P1-5（2026-11-25 风暴压测）：不能盲信旧下标 ——
                        // 校验它仍指向**本轮这句 user**，不是就关掉「单轮累计」闸（单条上限仍生效）
                        // 并 warn。用错位的下标去统计，会把上一轮的回执算进本轮、或漏掉本轮的。
                        if (voiceChat.enableContextLimit) {
                            voiceChat.trimMessages();
                        }
                        const _textOfContent = (c) => (Array.isArray(c)
                            ? c.filter((p0) => p0 && p0.type === 'text').map((p0) => p0.text || '').join(' ')
                            : String(c == null ? '' : c));
                        const at = turnStartIndex >= 0 ? voiceChat.messages[turnStartIndex] : null;
                        const stillMine = !!(at && at.role === 'user'
                            && _textOfContent(at.content).trim() === _textOfContent(prompt).trim());
                        if (!stillMine) {
                            if (turnStartIndex >= 0) {
                                logToTerminal('warn', '🧰 重试轮：本轮起始下标已漂移（trim/剥图改写了宿主），'
                                    + '单轮累计闸本轮关闭（单条上限仍生效）');
                            }
                            turnStartIndex = -1;
                        }
                    }
                }

                // 检查是否需要截图（只在第一次尝试且未重试过时）
                // prompt 可能是 string 或多模态数组，取文本部分用于截图判断
                const promptText = Array.isArray(prompt)
                    ? (prompt.find(p => p.type === 'text')?.text ?? '')
                    : prompt;
                let screenshotBase64 = null;
                if (isFirstAttempt && !hasRetriedWithoutImage) {
                    // ⚡ 与首包路径并行的判定（进函数时就已起跑），这里只 await 收结果
                    const needScreenshot = await screenshotDecisionPromise;

                    if (needScreenshot) {
                        try {
                            console.log("需要截图");
                            logToTerminal('info', "需要截图");
                            screenshotBase64 = await voiceChat.takeScreenshotBase64();
                            const lastUserMessage = [...voiceChat.messages].reverse().find(message => message.role === 'user');
                            if (lastUserMessage) {
                                const screenshotPath = saveScreenshotForHistory(screenshotBase64);
                                lastUserMessage.attachments = [
                                    ...(Array.isArray(lastUserMessage.attachments) ? lastUserMessage.attachments : []),
                                    { type: 'image', path: screenshotPath }
                                ];
                                // P0（2026-11-25）：截图是「这一轮的输入」，轮内重冻后要能原位重贴。
                                // 记 hostIndex 只是兜底（attachments 路径才是主判据，trim 后下标会漂）。
                                turnScreenshot = {
                                    base64: screenshotBase64,
                                    path: screenshotPath,
                                    hostIndex: voiceChat.messages.indexOf(lastUserMessage),
                                };
                            }
                        } catch (error) {
                            console.error("截图处理失败:", error);
                            logToTerminal('error', `截图处理失败: ${error.message}`);
                            throw new Error("截图功能出错，无法处理视觉内容");
                        }
                    }
                }

                // 标记不再是第一次尝试
                isFirstAttempt = false;

                // ⚡ 意图前置路由——**改成零延迟本地启发式**（2026-11-08 用户投诉「说话一顿顿」）。
                //
                // 第一性原理：路由的价值是「chat 轮省 13.5k 工具 schema」，
                // 但它的成本绝不能超过收益。原实现 `await classifyIntent()` 挡在 LLM 请求之前：
                //   · 嵌入快通道 ~30-500ms（首轮含模型加载）
                //   · 小模型慢通道 250-2500ms（GPU 被皮套占用时必超时）
                // 结果：**每轮对话凭空多等 0.3-2.5 秒**，用户听感就是「说话一顿顿」。
                //
                // 现在：主链只跑 O(1) 的关键词启发式（微秒级、零网络、零阻塞）——
                // 判定「明显是闲聊」才省工具；其余一律带全量工具（能力不折损）。
                // 语义版路由保留在 intent-router.js，需要时用 config.llm.intent_router.enabled 打开，
                // 且只作为**后台遥测**（不阻塞主链）。
                const turnIntent = classifyIntentLocal(promptText);
                if (turnIntent.intent !== 'unknown') {
                    logToTerminal('info', `[意图路由] ${turnIntent.intent}(${turnIntent.confidence}) 0ms（本地启发式）`);
                }

                // 合并本地Function Call工具和MCP工具
                let allTools = getMergedToolsList();

                // ⚡ 意图路由的收益兑现：纯 chat 轮不带工具（13.5k schema 不进请求）
                if (shouldOmitTools(turnIntent, config)) {
                    logToTerminal('info', `[意图路由] chat(${turnIntent.confidence}) → 本轮省工具 schema（-13.5k 字符）`);
                    allTools = [];
                }

                // 模型不支持图片时，过滤掉截图相关工具，避免 AI 调用后又触发多模态错误
                if (hasRetriedWithoutImage) {
                    const screenshotKeywords = ['screenshot', 'take_screenshot', '截图', 'screen_capture'];
                    const before = allTools.length;
                    allTools = allTools.filter(tool => {
                        const name = (tool.function?.name || tool.name || '').toLowerCase();
                        return !screenshotKeywords.some(kw => name.includes(kw));
                    });
                    if (allTools.length < before) {
                        logToTerminal('info', `📷 当前模型不支持图片，已从工具列表中移除截图工具`);
                    }
                }

                // 能力域筛选（2026-11-10 三十七轮；2026-11-24 ADR-014 升为**会话级**）。
                //   ⚠ **默认关闭**（config.toolFilter.enabled === true 才启用）—— 主链红线：
                //   筛掉了 AI 真想用的工具 = 静默劣化，比 schema 大更糟。所以：
                //   ① 只在 tool 轮生效（纯 chat 轮已被 shouldOmitTools 全省）
                //   ② 记忆/核心记忆/画像/see/act/app 永不裁、保底 8 个通用工具
                //   ③ 同一会话 + 同一模式只选一次（模式变了才重选）—— 前缀缓存不因筛选本身漂移
                //   ④ 筛选器抛异常只打 warn，绝不让主链失败
                if (config.toolFilter && config.toolFilter.enabled === true && allTools.length > 0 && turnIntent.intent !== 'unknown') {
                    try {
                        const { pickForSession } = require('./tool-picker.js');
                        let screenState = '';
                        try {
                            const entry = global.pluginManager && global.pluginManager._plugins && global.pluginManager._plugins.get('community/watch-screen');
                            const plug = entry && entry.plugin;
                            const st = plug && plug._screenState;
                            if (st && st.state) screenState = st.state + (st.what ? ':' + st.what : '');
                        } catch (e0) { /* 状态拿不到就当没有 */ }
                        const picked = pickForSession(allTools, {
                            sessionKey: _sessionKeyFor(voiceChat),
                            screenState,
                            lastUserText: promptText,
                        });
                        if (picked.tools.length >= 8) {
                            // 观测口径：domain / toolCount / toolHash —— 缓存命中率变化能不能归因到「工具换了」
                            logToTerminal('info', '[工具筛选] mode=' + picked.mode
                                + ' domain=' + (picked.domains.join('+') || 'core')
                                + ' toolCount=' + allTools.length + '→' + picked.tools.length
                                + ' toolHash=' + _toolHash(picked.tools)
                                + (picked.reused ? '（会话内复用）' : '（新选）')
                                + (picked.dropped > 0 ? ' 省 ' + picked.dropped + ' 个 schema' : ''));
                            allTools = picked.tools;
                        }
                    } catch (e) {
                        logToTerminal('warn', '[工具筛选] 失败（不影响主链）：' + ((e && e.message) || e));
                    }
                }

                // ===== 🔄 连续工具调用逻辑 =====
                // 支持AI连续多轮调用工具,直到完成完整任务链
                const maxIterations = 30; // 最大工具调用轮数,防止无限循环
                let iteration = 0;
                let finalResponseContent = null;
                let isStreamingToTTS = false; // 标记是否正在流式播放TTS
                let _streamBuf = '';
                // §72：本轮的 mood 过滤器 + 是否已经记过（一轮只记第一次）
                const _moodFilter = createMoodStreamFilter();
                let _moodSet = false;
                let consecutiveEmptyResponses = 0; // 连续空响应计数

                // 🔥 清除之前的中断标志，开始新的对话流程
                appState.clearInterrupted();

                // 🔍 判断第一轮是否需要使用视觉模型（用户主动截图）
                const useVisionModelForFirstRound = visionClient && screenshotBase64;

                if (useVisionModelForFirstRound) {
                    console.log('📸 检测到用户截图且启用了独立视觉模型');
                    logToTerminal('info', '📸 使用独立视觉模型处理用户截图');
                }

                // ===== ⚡ 快慢双轨应答（Latency-Cover）：武装垫场计时器 =====
                // LLM 等待期超过 filler_delay_ms（默认 1.5s）且流式首字未到 → 插一句情绪语气词垫场。
                // 垫场直接进 TTS 分段队列（不 reset 不抢队），真回复的流式段自然排其后。
                _lat = { t0: (typeof performance !== 'undefined' ? performance.now() : Date.now()), firstTokenAt: 0, firstTtsAt: 0 };
                cancelLatencyFiller = armLatencyFiller({
                    config,
                    ttsProcessor,
                    hasFirstToken: () => isStreamingToTTS,
                    isCancelled: () => appState.isInterrupted(),
                });

                while (iteration < maxIterations) {
                    // 🔥 关键检查：在每轮循环开始时检查是否被打断
                    if (appState.isInterrupted()) {
                        console.log('⏸️ 检测到用户打断，立即停止工具调用链');
                        logToolAction('warn', '⏸️ 工具调用链被用户打断');

                        // 清除中断标志，为下次对话做准备
                        appState.clearInterrupted();

                        // 抛出特殊错误，让外层 catch 处理
                        throw new Error('USER_INTERRUPTED');
                    }
                    // P0-2（2026-11-24）：工具回执体积上限 —— 必须在克隆前改**宿主消息**，
                    // 这样后续请求看到的是同一份截断结果（前缀稳定，不会每轮重写）。
                    // 单条超 8k 截中间；本轮累计超 24k 从最旧一条开始省略（保留最新）。
                    // ⚠ 已知例外（ADR-014 漏一，注明为有意为之）：累计闸在超限那一刻会改写
                    //   本轮**更早**的 tool 消息。若那条落在冻结前缀区间，`composeTurnPrefix` 的
                    //   hostSig 会判 `host-rewritten` → 当场作废冻结并按宿主重冻（主动断一次缓存）。
                    //   这比「用旧快照发出去、截断被静默绕过」正确：宁可断一次，不可让宿主与请求分叉。
                    try {
                        const capRes = toolResultCap.enforceToolBudget(voiceChat.messages, turnStartIndex, {
                            perResultChars: config && config.context && config.context.tool_result_max_chars,
                            perTurnChars: config && config.context && config.context.turn_tool_result_max_chars,
                        });
                        if (capRes.capped || capRes.stubbed || capRes.skipped) {
                            logToTerminal('info', '🧰 工具回执限流：截断 ' + capRes.capped + ' 条 / 本轮省略 '
                                + capRes.stubbed + ' 条 / 跳过含图回执 ' + (capRes.skipped || 0) + ' 条 / 共省 '
                                + capRes.droppedChars + ' 字符（本轮工具回执 ' + capRes.turnChars + ' 字符）');
                        }
                    } catch (e) { /* 限流失败不影响对话 */ }

                    // 准备发送给API的消息列表
                    // ── 🧊 轮内前缀冻结（ADR-014 漏一，2026-11-24 第三轮）──────────────
                    // 旧实现每次请求都重跑插件钩子 + 重拼易变尾巴，而钩子本身就在改写**同一段前缀**：
                    //   · watch-screen 把「最近 60 秒画面摘要」插到最后一条 user 的最前面（每请求都变）；
                    //   · dawn-dusk 把时段行插到 user 最前面；
                    //   · user-profile 把画像追到 system 末尾。
                    // 这些字节一变，从那一字节往后（含还没发出的 tool 往返）全部 miss ——
                    // 实测 11-22 单轮 18 次请求：prompt 10.6k→24.3k，cached 冻在 9,984，命中 93.7%→41%。
                    // 所以冻结点不放在「易变块」上，而是放在**本轮第一次请求渲染完的字节**上：
                    //   ① 第 1 次请求照旧跑钩子/拼尾巴，然后把字节快照进 turnFreeze；
                    //   ② 之后每次请求 = 快照原样 + 宿主本轮新追加的 assistant/tool 消息（composeTurnPrefix）；
                    //   ③ 轮结束清空，下一轮重新冻结。
                    // 语义代价（可接受）：世界行/画面摘要/mood 在本轮内保持**轮起点**快照，
                    // 下一个用户轮才刷新 —— 这正是要的（工具循环里世界变一秒，模型没必要知道）。
                    let messagesForAPI = null;
                    let frozenReuse = null;
                    if (turnFreeze) {
                        frozenReuse = promptLayout.composeTurnPrefix(turnFreeze, voiceChat.messages);
                        if (frozenReuse && frozenReuse.ok) {
                            messagesForAPI = frozenReuse.messages;
                            freezeStats.reuse += 1;
                            freezeStats.requests += 1;
                            if (!frozenReuse.snapOk) {
                                // 快照对象本身被外部改过 —— 缓存同样断，但它不是「宿主有没有被改」的判据
                                freezeStats.rewrite += 1;
                                logToTerminal('warn', '🧊 冻结快照被外部改写（snapOk=false，本轮第 '
                                    + (iteration + 1) + ' 次请求，缓存会从这里断）');
                            }
                            logToTerminal('info', '♻️ 复用冻结前缀：' + frozenReuse.prefixMsgs + ' 条 / '
                                + frozenReuse.prefixChars + ' 字 + 本轮新增 ' + frozenReuse.tailMsgs
                                + ' 条（本轮第 ' + (iteration + 1) + ' 次请求）');
                        } else if (frozenReuse && frozenReuse.reason === 'host-rewritten') {
                            // 宿主前缀被改写（典型：工具回执限流把本轮更早的 tool 消息省略掉了）。
                            // 继续用旧快照发 = 截断被静默绕过（宿主与请求分叉），所以宁可主动断一次缓存。
                            freezeStats.rebuild += 1;
                            freezeStats.rewrite += 1;
                            logToTerminal('warn', '🧊 冻结前缀被宿主改写（工具回执限流），本轮重冻：第 '
                                + frozenReuse.index + ' 条已变，第 ' + (iteration + 1) + ' 次请求');
                            try {
                                if (__emitTelemetry) {
                                    __emitTelemetry({
                                        cat: 'llm', type: 'llm.freeze.break', title: '冻结前缀被宿主改写',
                                        level: 'warn', pipeline_stage: 'llm',
                                        metrics: { rewrite: 1, at_msg: Number(frozenReuse.index) },
                                        turn_id: turnCtx.currentTurnId(),
                                    });
                                }
                            } catch (e) { /* 遥测失败不影响对话 */ }
                            frozenReuse = null;   // 本次没复用成功（下面按宿主重建 → 剥历史图 → 重冻）
                            turnFreeze = null;   // 落到下面的重建 + 重冻
                        } else {
                            // 宿主变短（trim/pop）→ 快照与宿主对不上，删了重建一次并重新冻结。
                            // P1-3（2026-11-25 风暴压测）：变短同样是**缓存断裂** —— 已发出去的前缀
                            //   里的消息被别的路径删掉了，后续请求不可能再命中。旧实现只 +rebuild，
                            //   rewrite 仍是 0、也不落 freeze.break → 这种轮次在 doctor 里看起来
                            //   「零断裂」，缓存账本在说谎。这里按断裂记账（并标出 shrank）。
                            freezeStats.rebuild += 1;
                            const reason = (frozenReuse && frozenReuse.reason) || 'unknown';
                            if (reason === 'host-shrank') {
                                freezeStats.rewrite += 1;
                                try {
                                    if (__emitTelemetry) {
                                        __emitTelemetry({
                                            cat: 'llm', type: 'llm.freeze.break', title: '冻结前缀失效（宿主变短）',
                                            level: 'warn', pipeline_stage: 'llm',
                                            metrics: { rewrite: 1, shrank: 1, at_msg: 0 },
                                            turn_id: turnCtx.currentTurnId(),
                                        });
                                    }
                                } catch (e) { /* 遥测失败不影响对话 */ }
                            }
                            logToTerminal('warn', '🧊 冻结前缀失效（' + reason
                                + '），本轮重算一次');
                            frozenReuse = null;
                            turnFreeze = null;
                        }
                    }
                    if (!messagesForAPI) {
                        messagesForAPI = JSON.parse(JSON.stringify(voiceChat.messages));
                        messagesForAPI.forEach(message => { delete message.attachments; });

                        // 🧹 历史图片清理（P1-1）：**只在这里跑一次，且在上面冻结点之前**。
                        //   旧位置在下面的 vision/main 分支里（冻结之后）→ 无新截图的轮次里，
                        //   快照带图、实际请求剥图，下一次 compose 用快照就把图片「复活」了，
                        //   前缀从那条消息起分叉，而 llm.freeze 还报 reuse 成功。
                        //   现在快照 == 首次请求真实字节；冻结复用请求也不再剥图（见下面分支注释）。
                        // ⚠ 顺序（2026-11-25 风暴压测）：先剥**历史图**、再贴**本轮截图**。
                        //   iteration>0 时这个函数会把所有 user 图都剥掉（含刚贴上的截图），
                        //   先贴后剥等于白贴 —— 那正是「轮内重冻后她看不见屏幕」的根因。
                        const _strippedImgs = stripHistoryImagesForRequest(messagesForAPI, screenshotBase64, iteration);
                        if (_strippedImgs > 0) {
                            console.log('🧹 历史图片已清理（冻结点之前）: ' + _strippedImgs + ' 条');
                        }

                        // 模型不支持图片时，在最后一条用户消息后追加一条说明，让 AI 用自己的语气告知用户
                        if (hasRetriedWithoutImage && iteration === 0) {
                            messagesForAPI.push({ role: 'user', content: '（系统提示：当前模型不支持识图，请用你自己的语气告诉用户需要换成支持多模态视觉的模型才能使用截图功能）' });
                        }

                        // 如果是第一轮且需要截图,添加截图到最后一条用户消息
                        if (iteration === 0 && screenshotBase64) {
                            // 从后往前找最后一条用户消息
                            let lastUserMsgIndex = -1;
                            for (let i = messagesForAPI.length - 1; i >= 0; i--) {
                                if (messagesForAPI[i].role === 'user') {
                                    lastUserMsgIndex = i;
                                    break;
                                }
                            }

                            if (lastUserMsgIndex !== -1) {
                                console.log(`📸 将截图附加到消息索引 ${lastUserMsgIndex}，内容: ${promptText.substring(0, 50)}...`);
                                // prompt 若已是多模态数组则直接追加图片，否则包装成数组
                                const existingContent = Array.isArray(prompt)
                                    ? prompt
                                    : [{ 'type': 'text', 'text': prompt }];
                                messagesForAPI[lastUserMsgIndex] = {
                                    'role': 'user',
                                    'content': [
                                        ...existingContent,
                                        { 'type': 'image_url', 'image_url': { 'url': `data:image/jpeg;base64,${screenshotBase64}` } }
                                    ]
                                };
                            } else {
                                console.error('⚠️ 未找到用户消息，无法附加截图');
                            }
                        } else if (iteration > 0 && turnScreenshot && !hasRetriedWithoutImage) {
                            // P0（2026-11-25 风暴压测）：**轮内重冻必须把本轮截图重新贴上**。
                            //   触发链：截图轮 → 工具回执被限流/宿主被别的路径改写 → compose 判
                            //   host-rewritten → 丢弃冻结、按宿主重建。重建时 iteration>0，旧实现
                            //   不附图、历史图又被剥 → 模型从这一条请求起再也看不到屏幕，却仍要
                            //   接着聊画面（只能编）。截图属于「这一轮的输入」，不属于「易变尾巴」，
                            //   重冻时按轮作用域记录的目标原位重贴；找不到目标 = 视觉真丢了，
                            //   计 vision_lost 并 warn（不许悄悄降级）。
                            let idx = -1;
                            if (turnScreenshot.path) {
                                idx = voiceChat.messages.findIndex((m0) => m0 && m0.role === 'user'
                                    && Array.isArray(m0.attachments)
                                    && m0.attachments.some((a0) => a0 && a0.path === turnScreenshot.path));
                            }
                            if (idx < 0 && turnScreenshot.hostIndex >= 0) {
                                const at = voiceChat.messages[turnScreenshot.hostIndex];
                                if (at && at.role === 'user') idx = turnScreenshot.hostIndex;
                            }
                            if (idx >= 0 && messagesForAPI[idx] && messagesForAPI[idx].role === 'user') {
                                const m0 = messagesForAPI[idx];
                                const textParts = Array.isArray(m0.content)
                                    ? m0.content.filter((p0) => p0 && p0.type === 'text').map((p0) => p0.text).join(' ')
                                    : String(m0.content == null ? '' : m0.content);
                                messagesForAPI[idx] = {
                                    role: 'user',
                                    content: [
                                        { type: 'text', text: textParts },
                                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${turnScreenshot.base64}` } },
                                    ],
                                };
                                logToTerminal('info', '📸 本轮重冻：已把本轮截图重新贴回第 ' + idx + ' 条 user（视觉上下文不丢）');
                            } else {
                                freezeStats.visionLost += 1;
                                logToTerminal('warn', '📷 本轮重冻：截图目标消息已不存在，视觉上下文丢失（vision_lost，本轮不会再有画面信息）');
                            }
                        }
                    }

                    // 触发插件 onLLMRequest 钩子（插件可修改 messages）
                    // ── prompt 前缀缓存布局（2026-11-16 六十二轮）────────────────
                    // 稳定的注入留 system；**每轮易变**的注入一律改道到最后一条 user 末尾。
                    // 原因：system 是消息数组第一条，它里面变一个字节，后面的整段历史缓存
                    // 就全部作废（实测 97.4% → 83.8%，见 _probe/cache-probe.cjs）。
                    //
                    // ⚠ 冻结之后**不再重跑钩子**（2026-11-24）：钩子的副作用和「注入了什么」是绑定的
                    //   （world-sense 注入后才推进差分基准、world-extras 注入后才给 RSS 记账、
                    //    mind-kernel 注入后才记 _lastTail）。重跑再丢掉文本 = 它们以为已经告诉过模型，
                    //   世界行/简报就永久丢了。所以整段钩子只在冻结点跑一次，副作用留到下一个用户轮 ——
                    //   时间粒度正好等于这些内容的语义粒度。
                    if (!turnFreeze) {
                        const volatileTexts = [];
                        const hookRequest = {
                            messages: messagesForAPI,
                            tools: allTools,
                            // 插件在 onLLMRequest 里调它声明「这段是易变的」。
                            // 别自己拼 sysMsg.content —— 那会让系统提示每轮变一次。
                            addVolatile: (t) => { if (t) volatileTexts.push(String(t)); },
                        };
                        if (global.pluginManager) {
                            const _hookT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                            await global.pluginManager.runLLMRequestHooks(hookRequest)
                                .catch((e) => logToTerminal('warn', '⚠️ onLLMRequest 钩子整体失败: ' + (e && e.message || e)));
                            if (_lat) _lat.hooksMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - _hookT0);
                        }
                        // 补丁表里标了 volatile 的（召回片段/屏幕描述/身体状态…）也一起挪
                        for (const t of collectVolatilePromptPatches()) volatileTexts.push(t);
                        if (_pendingInterruptNote) {
                            volatileTexts.push(_pendingInterruptNote);
                            _pendingInterruptNote = '';
                            try { logToTerminal('info', '✂️ 上一轮被打断：已把「别接着讲完」注入易变尾巴'); } catch (e) {}
                        }
                        if (_pendingLoopNote) {
                            volatileTexts.push(_pendingLoopNote);
                            _pendingLoopNote = '';
                            try { logToTerminal('info', '🔁 复读提醒：已注入易变尾巴'); } catch (e) {}
                        }
                        // ADR-013：对话现场（刚在聊什么/上次谁说的/她刚说什么）。
                        // 只陈述事实、不催她说话；放在 mood 指令之前，保证 mood 仍是最后一句。
                        try {
                            const sceneLine = scene.describeForPrompt();
                            if (sceneLine) volatileTexts.push(sceneLine);
                        } catch (e) { /* 现场失败不影响请求 */ }
                        // §72：mood 要求必须放在**最后一条**易变尾巴里（工具在场时系统提示词里的格式
                        // 要求会被忽略，实测）。放在所有 volatile 项之后，保证它是模型最后看到的一句。
                        volatileTexts.push(MOOD_TAIL_HINT);
                        const vres = promptLayout.appendVolatile(messagesForAPI, volatileTexts);
                        // system 指纹：变了就等于宣告历史缓存作废，必须是可观测的数字，不能靠猜
                        try {
                            const sysText = promptLayout.systemText(messagesForAPI);
                            const h = promptLayout.hashText(sysText);
                            if (global.__lastSystemHash && global.__lastSystemHash !== h) {
                                logToTerminal('info', '🧩 system 变了（历史缓存会重建）：' + global.__lastSystemHash
                                    + ' → ' + h + '，' + sysText.length + ' 字');
                            }
                            global.__lastSystemHash = h;
                        } catch (e) { try { __silentAudit.audit('llm-handler.js:system-fingerprint', e); } catch (e2) {} }
                        if (vres.ok && vres.count > 0) {
                            logToTerminal('info', '🧩 易变注入 ' + vres.count + ' 段 / ' + vres.chars
                                + ' 字 → 第 ' + vres.target + ' 条消息（不进 system）');
                        }
                        // 🧊 冻结点：这一份就是本轮所有后续请求必须逐字节命中的前缀
                        // 第二个参数是**宿主**：冻结时顺手取一份宿主前缀指纹，轮内宿主被改就靠它抓。
                        turnFreeze = promptLayout.freezeTurnPrefix(messagesForAPI, voiceChat.messages, {
                            volatileCount: vres.ok ? vres.count : 0,
                            volatileChars: vres.ok ? vres.chars : 0,
                        });
                        if (turnFreeze) {
                            freezeStats.requests += 1;
                            freezeStats.prefixMsgs = turnFreeze.messages.length;
                            freezeStats.prefixChars = turnFreeze.chars;
                            // 挂到 voiceChat 上只为排障/doctor 可读；轮结束会删掉（见 finally）
                            try {
                                voiceChat._turnFreeze = {
                                    at: turnFreeze.at,
                                    msgs: turnFreeze.messages.length,
                                    chars: turnFreeze.chars,
                                    hostSig: turnFreeze.hostSig,
                                    volatile: turnFreeze.meta,
                                    stats: freezeStats,
                                };
                            } catch (e) { /* 观测失败不影响请求 */ }
                            logToTerminal('info', '🧊 本轮前缀已冻结：' + turnFreeze.messages.length + ' 条 / '
                                + turnFreeze.chars + ' 字（hostSig ' + turnFreeze.hostSig + '；工具循环内不再重算）');
                        }
                    }

                    // 使用统一的LLM客户端
                    // 🔍 如果是第一轮且有用户截图且启用了视觉模型，使用视觉模型客户端
                    eventBus.emit(Events.LLM_REQUEST_START);
                    let result;
                    try {
                    if (iteration === 0 && useVisionModelForFirstRound) {
                        console.log('🎨 使用视觉模型进行图像理解...');
                        logToTerminal('info', '🎨 调用视觉模型API进行图像分析');
                        // 视觉模型不传工具列表，纯粹用于图像理解，走流式降低延迟
                        _streamBuf = '';
                        ttsProcessor.reset();
                        result = await visionClient.chatCompletion(messagesForAPI, null, true, (text) => {
                            isStreamingToTTS = true;
                            if (_lat && !_lat.firstTokenAt) _lat.firstTokenAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                            if (_lat && !_lat.firstTtsAt) _lat.firstTtsAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                            {
                                // §72：先过 mood 过滤器 —— 标记行绝不能流进 TTS（否则她会念出来）
                                const __mf = _moodFilter.push(text);
                                if (__mf.emit) ttsProcessor.addStreamingText(__mf.emit);
                                if (__mf.mood && !_moodSet) { _moodSet = true; _setMoodSafe(__mf.mood, { from: 'llm-stream' }); }
                            }
                        });
                    } else {
                        // 🔥 如果没有启用独立视觉模型，但有截图，说明主模型需要支持视觉。
                        // 🧹 历史图片清理已经上移到「克隆宿主之后、冻结点之前」（P1-1），
                        //    这里**不再**剥图：冻结复用的请求更不能剥 —— 把历史里的图片剥成文字
                        //    就是在改「已经发出去过的字节」→ 从那条消息起整段 miss。图片留在
                        //    冻结前缀里反而更好：第一次请求付过钱，后面按 1/10 命中价复用。
                        if (!frozenReuse && screenshotBase64 && iteration === 0) {
                            console.log('📸 主模型将处理截图（需要主模型支持视觉）');
                        }

                        // 🔥 正常使用主模型 - 使用流式响应（提升响应速度）
                        _streamBuf = '';
                        if (iteration === 0) ttsProcessor.reset();
                        if (_lat) {
                            _lat.sendAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                            // 请求体大小：直连测同一网关只要 1.4-1.9s，进程内却 7.4s，
                            // 唯一没量过的变量就是**真实载荷**（历史+画像+召回+工具全在 messages 里）。
                            try {
                                _lat.bodyChars = JSON.stringify(messagesForAPI).length;
                                _lat.toolChars = allTools ? JSON.stringify(allTools).length : 0;
                                _lat.msgCount = messagesForAPI.length;
                                _lat.toolCount = allTools ? allTools.length : 0;
                            } catch (e) { /* 序列化失败只影响观测 */ }
                        }
                        // C3（2026-11-21）：上下文预算 —— 每轮记一条 section token，
                        // 回答「谁在吃上下文」。只测量不改行为；失败绝不影响请求。
                        try { contextBudget.record({ messages: messagesForAPI, tools: allTools }); } catch (e) { /* 观测失败不影响请求 */ }
                        result = await llmClient.chatCompletion(messagesForAPI, allTools, true, (text) => {
                            if (iteration > 0) return;
                            isStreamingToTTS = true;
                            if (_lat && !_lat.firstTokenAt) {
                                _lat.firstTokenAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                                _lat.firstTtsAt = _lat.firstTokenAt;
                                // 请求前准备花了多久 = 首 token 时刻 - 网关实际等待（用发起时刻反推）
                                if (_lat.sendAt) _lat.preMs = Math.round(_lat.sendAt - _lat.t0);
                                _lat.gatewayMs = Math.round(_lat.firstTokenAt - (_lat.sendAt || _lat.t0));
                            }
                            {
                                // §72：先过 mood 过滤器 —— 标记行绝不能流进 TTS（否则她会念出来）
                                const __mf = _moodFilter.push(text);
                                if (__mf.emit) ttsProcessor.addStreamingText(__mf.emit);
                                if (__mf.mood && !_moodSet) { _moodSet = true; _setMoodSafe(__mf.mood, { from: 'llm-stream' }); }
                            }
                        });
                    }
                    } finally {
                        eventBus.emit(Events.LLM_REQUEST_END);
                    }

                    // 检查是否有工具调用
                    if (result.tool_calls && result.tool_calls.length > 0) {
                        iteration++;
                        console.log(`\n===== 🔧 第 ${iteration} 轮工具调用 =====`);

                        // 格式化工具调用信息
                        const formatToolCalls = (toolCalls) => {
                            return toolCalls.map(call => {
                                const toolName = call.function.name.split('→')[0].trim(); // 去掉描述部分
                                let args = '';
                                try {
                                    const argsObj = JSON.parse(call.function.arguments);
                                    args = Object.values(argsObj).join(', ');
                                } catch (e) {
                                    args = call.function.arguments;
                                }
                                return `AI调用了：${toolName} 工具 输入参数：${args}`;
                            }).join('\n');
                        };

                        logToolAction('info', formatToolCalls(result.tool_calls));

                        // 🎙️ 如果AI在调用工具前说了话,必须等播放完才继续
                        // 🔥 二次安全过滤：跳过模型思考内容（Gemini 等模型可能在 content 中输出思考过程）
                        const filteredIntermediateContent = filterThinkingContent(result.content);
                        if (filteredIntermediateContent && filteredIntermediateContent.trim()) {
                            console.log(`💬 AI中间过程: ${filteredIntermediateContent}`);
                            logToTerminal('info', `💬 AI中间过程: ${filteredIntermediateContent}`);

                            // 🔥 中间过程播放TTS（工具调用的中间内容）
                            if (iteration === 0) {
                                // 第一轮才reset
                                ttsProcessor.reset();
                            }
                            ttsProcessor.processTextToSpeech(filteredIntermediateContent);

                            // 等待 TTS_END / TTS_INTERRUPTED（45s 超时兜底，见 waitTtsDone）
                            await waitTtsDone('工具调用前的中间回复');
                        }

                        // 🔥 在执行工具前检查是否已被打断
                        if (appState.isInterrupted()) {
                            console.log('⏸️ 检测到打断，跳过工具执行');
                            logToolAction('warn', '⏸️ 工具调用被打断，停止执行');

                            // 🔥 关键修复：不添加带有 tool_calls 的 assistant 消息到历史
                            // 因为工具不会执行，添加了会导致下次 API 调用时缺少 tool 响应
                            console.log('⚠️ 工具调用被打断，不添加到消息历史');

                            appState.clearInterrupted();
                            throw new Error('USER_INTERRUPTED');
                        }

                        // 将AI的工具调用请求添加到消息历史
                        voiceChat.messages.push({
                            'role': 'assistant',
                            'content': result.content || null,
                            'tool_calls': result.tool_calls
                        });

                        // 使用统一的工具执行器
                        eventBus.emit(Events.TOOL_CALL_START);
                        let toolResult;
                        try {
                            // failuresAsResults：全失败时也把失败原因交回来（默认契约是 null）。
                            // 少了它，下面 `if (toolResult)` 会走到 throw，而 assistant(tool_calls)
                            // 已经进历史 → 下一轮缺 tool 响应，模型端 400。
                            toolResult = await toolExecutor.executeToolCalls(result.tool_calls, { failuresAsResults: true });
                        } finally {
                            eventBus.emit(Events.TOOL_CALL_END);
                        }

                        // 🔥 工具执行后再次检查是否被打断
                        if (appState.isInterrupted()) {
                            console.log('⏸️ 工具执行完成后检测到打断，停止后续处理');
                            logToolAction('warn', '⏸️ 停止后续工具调用');

                            // 🔥 关键修复：移除刚才添加的 assistant 消息，因为对话被打断了
                            // 保持消息历史的完整性，避免下次 API 调用时出错
                            if (voiceChat.messages.length > 0 &&
                                voiceChat.messages[voiceChat.messages.length - 1].role === 'assistant' &&
                                voiceChat.messages[voiceChat.messages.length - 1].tool_calls) {
                                console.log('🧹 移除被打断的 assistant 工具调用消息');
                                voiceChat.messages.pop();
                            }

                            appState.clearInterrupted();
                            throw new Error('USER_INTERRUPTED');
                        }

                        if (toolResult) {
                            console.log("工具调用结果:", toolResult);

                            // 🔥 特殊处理：检测是否是截图工具返回
                            if (typeof toolResult === 'object' && toolResult._hasScreenshot) {
                                console.log('🎯 检测到截图工具，开始特殊处理流程');
                                logToolAction('info', '📸 AI调用了截图工具，准备图像分析');

                                const { screenshotData, results } = toolResult;

                                // 1. 先添加tool返回消息（需要添加name字段）
                                results.forEach((singleResult, index) => {
                                    // 从原始的tool_calls中找到对应的工具名称
                                    const toolCall = result.tool_calls.find(tc => tc.id === singleResult.tool_call_id);
                                    const toolName = toolCall ? toolCall.function.name : 'take_screenshot';

                                    voiceChat.messages.push({
                                        'role': 'tool',
                                        'name': toolName,  // 🔥 添加name字段
                                        'content': singleResult.content,
                                        'tool_call_id': singleResult.tool_call_id
                                    });
                                });

                                // 🧹 旧截图的剥离挪到**轮末**（stripOldScreenshotImages）：在轮内
                                //    改宿主历史 = 改写冻结前缀覆盖的字节，自己打穿缓存。轮末做，
                                //    下一轮前缀本来就会因为新 user 消息重置一次，代价相同。

                                // 2. 再作为user发送图片给AI分析
                                voiceChat.messages.push({
                                    'role': 'user',
                                    'content': [
                                        {
                                            'type': 'text',
                                            'text': '当前电脑屏幕内容:'
                                        },
                                        {
                                            'type': 'image_url',
                                            'image_url': {
                                                'url': `data:image/jpeg;base64,${screenshotData.base64}`
                                            }
                                        }
                                    ]
                                });

                                console.log('📸 截图已添加到消息，立即调用AI分析图片');
                                logToolAction('info', '📸 立即调用AI分析截图内容');

                                // 🔥 关键：立即再次调用LLM API分析图片
                                // ⚠ 走**同一套冻结通道**（ADR-014 漏一）：裸发 voiceChat.messages 会
                                //   另起一份前缀（没有易变块、钩子改写），跟主链对不上 = 本轮多一次全 miss。
                                //   此后宿主只追加了 tool + 截图 user 消息，冻结前缀原样不变，正好命中。
                                let shotMessages = null;
                                let _shotReuse = null;
                                if (turnFreeze) {
                                    _shotReuse = promptLayout.composeTurnPrefix(turnFreeze, voiceChat.messages);
                                    if (_shotReuse && _shotReuse.ok) {
                                        shotMessages = _shotReuse.messages;
                                        freezeStats.reuse += 1;
                                        freezeStats.requests += 1;
                                        if (!_shotReuse.snapOk) freezeStats.rewrite += 1;
                                        logToTerminal('info', '♻️ 截图分析复用冻结前缀：' + _shotReuse.prefixMsgs
                                            + ' 条 / ' + _shotReuse.prefixChars + ' 字 + 新增 ' + _shotReuse.tailMsgs + ' 条');
                                    }
                                }
                                if (!shotMessages) {
                                    // 冻结不可用/被宿主改写 → 退回裸宿主深拷贝（旧行为）。
                                    // 这里也要计数：静默退回等于「截断被绕过」再演一次，必须看得见。
                                    if (_shotReuse && _shotReuse.reason === 'host-rewritten') {
                                        freezeStats.rewrite += 1;
                                        logToTerminal('warn', '🧊 截图分析：冻结前缀被宿主改写（第 '
                                            + _shotReuse.index + ' 条），本次按宿主重发');
                                    }
                                    shotMessages = JSON.parse(JSON.stringify(voiceChat.messages));
                                    shotMessages.forEach((m) => { delete m.attachments; });
                                }
                                // 🔍 AI调用截图工具时，判断是否使用独立视觉模型
                                let visionResult;
                                if (visionClient) {
                                    // 如果配置了独立视觉模型，用它来分析AI截的图
                                    console.log('🎨 AI调用截图工具：使用独立视觉模型分析');
                                    logToTerminal('info', '🎨 使用独立视觉模型分析AI截图');
                                    // 🔥 使用视觉模型，仍然传递工具列表！
                                    // 这样AI分析完图片后还能继续调用工具
                                    visionResult = await visionClient.chatCompletion(shotMessages, allTools);
                                } else {
                                    // 没有独立视觉模型，用主模型（主模型必须支持视觉！）
                                    console.log('📸 AI调用截图工具：使用主模型分析（需支持视觉）');
                                    // 使用主模型（必须支持视觉！），传递完整工具列表以支持连续调用
                                    visionResult = await llmClient.chatCompletion(shotMessages, allTools);
                                }

                                console.log('✅ AI图片分析完成:', visionResult.content);
                                logToolAction('info', `✅ AI图片分析结果: ${visionResult.content}`);

                                // 🔥 检查AI是否还想继续调用工具
                                if (visionResult.tool_calls && visionResult.tool_calls.length > 0) {
                                    // AI分析完图片后还想调用工具，继续循环
                                    iteration++;
                                    console.log(`AI分析图片后想继续调用工具，进入第 ${iteration} 轮`);

                                    // 🎙️ 如果AI在调用工具前说了话,必须等播放完才继续
                                    // 🔥 过滤思考内容
                                    const filteredVisionContent = filterThinkingContent(visionResult.content);
                                    if (filteredVisionContent && filteredVisionContent.trim()) {
                                        console.log(`💬 AI图片分析后的中间过程: ${filteredVisionContent}`);
                                        logToTerminal('info', `💬 AI图片分析后的中间过程: ${filteredVisionContent}`);

                                        // 播放TTS并等待真正的播放完成(监听TTS_END事件)
                                        ttsProcessor.reset();
                                        ttsProcessor.processTextToSpeech(filteredVisionContent);

                                        // 等待 TTS_END / TTS_INTERRUPTED（45s 超时兜底，见 waitTtsDone）
                                        await waitTtsDone('视觉分析后的中间回复');
                                    }

                                    // 🔥 在执行工具前检查是否已被打断
                                    if (appState.isInterrupted()) {
                                        console.log('⏸️ 检测到打断，跳过工具执行');
                                        logToolAction('warn', '⏸️ 工具调用被打断，停止执行');
                                        appState.clearInterrupted();
                                        throw new Error('USER_INTERRUPTED');
                                    }

                                    // 🔥 打印工具调用日志（和普通工具调用保持一致）
                                    const formatToolCalls = (toolCalls) => {
                                        return toolCalls.map(call => {
                                            const toolName = call.function.name.split('→')[0].trim();
                                            let args = '';
                                            try {
                                                const argsObj = JSON.parse(call.function.arguments);
                                                args = Object.values(argsObj).join(', ');
                                            } catch (e) {
                                                args = call.function.arguments;
                                            }
                                            return `AI调用了：${toolName} 工具 输入参数：${args}`;
                                        }).join('\n');
                                    };
                                    logToolAction('info', formatToolCalls(visionResult.tool_calls));

                                    // 将工具调用请求添加到历史（只添加一次！）
                                    voiceChat.messages.push({
                                        'role': 'assistant',
                                        'content': visionResult.content,
                                        'tool_calls': visionResult.tool_calls
                                    });

                                    // 🔥 执行新的工具调用 - 注意：这里可能又是截图工具！
                                    eventBus.emit(Events.TOOL_CALL_START);
                                    let newToolResult;
                                    try {
                                        newToolResult = await toolExecutor.executeToolCalls(visionResult.tool_calls, { failuresAsResults: true });
                                    } finally {
                                        eventBus.emit(Events.TOOL_CALL_END);
                                    }

                                    if (newToolResult) {
                                        // 🔥 检查新工具是否又是截图工具
                                        if (typeof newToolResult === 'object' && newToolResult._hasScreenshot) {
                                            console.log('⚠️ 检测到嵌套截图调用，重复截图处理流程');
                                            const { screenshotData: newScreenshotData, results: newResults } = newToolResult;

                                            // 添加tool消息
                                            newResults.forEach(singleResult => {
                                                const toolCall = visionResult.tool_calls.find(tc => tc.id === singleResult.tool_call_id);
                                                const toolName = toolCall ? toolCall.function.name : 'take_screenshot';

                                                voiceChat.messages.push({
                                                    'role': 'tool',
                                                    'name': toolName,
                                                    'content': singleResult.content,
                                                    'tool_call_id': singleResult.tool_call_id
                                                });
                                            });

                                            // 🧹 同上：旧截图剥离统一放到轮末（轮内改宿主会改冻结前缀）

                                            // 添加user图片消息
                                            voiceChat.messages.push({
                                                'role': 'user',
                                                'content': [
                                                    { 'type': 'text', 'text': '当前电脑屏幕内容:' },
                                                    { 'type': 'image_url', 'image_url': { 'url': `data:image/jpeg;base64,${newScreenshotData.base64}` } }
                                                ]
                                            });

                                            // 🔥 重要：不能直接continue！要像第一次截图那样，立即分析这个新截图
                                            // 但是为了避免代码重复和无限嵌套，这里直接continue
                                            // 让下一轮while循环自动调用API分析
                                            console.log('📸 嵌套截图已添加，下一轮循环将分析');
                                            continue;
                                        }

                                        // 处理普通工具调用结果
                                        // P0-1：嵌套轮里也可能再调 see image，同样走「tool 文本 + 图片消息」
                                        if (Array.isArray(newToolResult)) {
                                            const msgs = newToolResult.map(singleResult => {
                                                const toolCall = visionResult.tool_calls.find(tc => tc.id === singleResult.tool_call_id);
                                                return {
                                                    'role': 'tool',
                                                    'name': toolCall ? toolCall.function.name : 'unknown',
                                                    'content': singleResult.content,
                                                    'tool_call_id': singleResult.tool_call_id
                                                };
                                            });
                                            toolImageAttach.appendToolResults(voiceChat.messages, msgs, { attachImages: !hasRetriedWithoutImage });
                                        } else {
                                            toolImageAttach.appendToolResults(voiceChat.messages, [{
                                                'role': 'tool',
                                                'name': visionResult.tool_calls[0].function.name,
                                                'content': newToolResult,
                                                'tool_call_id': visionResult.tool_calls[0].id
                                            }], { attachImages: !hasRetriedWithoutImage });
                                        }
                                    } else {
                                        // 🔥 工具调用失败，必须为每个tool_call添加错误消息，保证数量匹配！
                                        console.error('❌ 图片分析后的工具调用失败');
                                        visionResult.tool_calls.forEach(toolCall => {
                                            voiceChat.messages.push({
                                                'role': 'tool',
                                                'name': toolCall.function.name,
                                                'content': `工具 ${toolCall.function.name} 执行失败`,
                                                'tool_call_id': toolCall.id
                                            });
                                        });
                                    }

                                    // 继续循环
                                    continue;
                                } else {
                                    // AI分析完图片后直接给出最终回复，跳出循环
                                    finalResponseContent = visionResult.content;
                                    break;
                                }
                            }

                            // 普通工具调用结果处理
                            logToolAction('info', `✅ 工具调用结果: ${JSON.stringify(toolResult)}`);

                            // 处理多工具调用结果
                            if (Array.isArray(toolResult)) {
                                // 多个工具调用结果
                                // P0-1：先收齐全部 tool 消息再一次性追加 —— 图片作为 user 消息
                                //   必须排在**整批** tool 响应之后，否则严格模式会判工具链不完整。
                                const toolMsgs = toolResult.map(singleResult => {
                                    const toolCall = result.tool_calls.find(tc => tc.id === singleResult.tool_call_id);
                                    return {
                                        'role': 'tool',
                                        'name': toolCall ? toolCall.function.name : 'unknown',  // 🔥 添加name字段
                                        'content': singleResult.content,
                                        'tool_call_id': singleResult.tool_call_id
                                    };
                                });
                                const img = toolImageAttach.appendToolResults(voiceChat.messages, toolMsgs, { attachImages: !hasRetriedWithoutImage });
                                if (img.attached) logToolAction('info', '🖼️ 工具截图已作为图片消息附加给模型（回执里只剩元素清单）');
                                if (img.suppressed) logToolAction('info', '🖼️ 当前模型不支持图片：工具截图已剥离，按元素清单继续');
                                if (img.imageTooLarge) logToolAction('warn', '🖼️ 工具截图超过 8MB，已省略图片，仅回元素清单');
                                if (img.invalid) logToolAction('warn', '🖼️ 工具回执里的图片数据为空/损坏，已按元素清单继续');
                            } else {
                                // 单个工具调用结果（向后兼容）
                                const img = toolImageAttach.appendToolResults(voiceChat.messages, [{
                                    'role': 'tool',
                                    'name': result.tool_calls[0].function.name,  // 🔥 添加name字段
                                    'content': toolResult,
                                    'tool_call_id': result.tool_calls[0].id
                                }], { attachImages: !hasRetriedWithoutImage });
                                if (img.attached) logToolAction('info', '🖼️ 工具截图已作为图片消息附加给模型（回执里只剩元素清单）');
                                if (img.suppressed) logToolAction('info', '🖼️ 当前模型不支持图片：工具截图已剥离，按元素清单继续');
                                if (img.imageTooLarge) logToolAction('warn', '🖼️ 工具截图超过 8MB，已省略图片，仅回元素清单');
                                if (img.invalid) logToolAction('warn', '🖼️ 工具回执里的图片数据为空/损坏，已按元素清单继续');
                            }

                            // 继续下一轮循环,AI会根据工具结果决定是否再次调用工具
                            continue;

                        } else {
                            console.error("工具调用失败");
                            logToolAction('error', "❌ 工具调用失败");
                            // 兜底：走到这里说明执行器连失败回执都没给。assistant(tool_calls) 已经
                            // 进历史，直接抛错会留下「有 tool_calls 无 tool 响应」的残缺历史，下一轮
                            // 请求会被模型端 400。先补齐每个 tool_call 的失败响应再抛。
                            result.tool_calls.forEach(toolCall => {
                                voiceChat.messages.push({
                                    'role': 'tool',
                                    'name': toolCall.function && toolCall.function.name,
                                    'content': `工具 ${toolCall.function && toolCall.function.name} 执行失败`,
                                    'tool_call_id': toolCall.id
                                });
                            });
                            throw new Error("工具调用失败，无法完成功能扩展");
                        }
                    }

                    // 没有工具调用,说明AI已经完成任务
                    if (result.content) {
                        finalResponseContent = result.content;

                        // 🔥 不在这里播放TTS，统一在最后播放（参考旧版本的设计）
                        console.log('✅ 最终回复已获取');

                        // 只有真正执行了工具调用才输出统计信息
                        if (iteration > 0) {
                        }
                        break;
                    }

                    // 既没有工具调用也没有内容，部分模型在工具调用后会返回空响应
                    consecutiveEmptyResponses++;
                    logToTerminal('warn', `⚠️ LLM返回了空响应 (连续第 ${consecutiveEmptyResponses} 次)`);

                    // 🔥 检查是否因为图片导致的空响应
                    // P0-1：工具附图（see image）也算「有图」——否则模型不支持视觉时会被判成
                    //   普通空响应，催一句后继续空转，而不是走「剥图重试」的恢复通道。
                    if (screenshotBase64 || useVisionModelForFirstRound || hasToolImageMessage(voiceChat.messages)) {
                        logToTerminal('warn', '⚠️ 检测到有截图但返回空响应，可能是模型不支持视觉');
                        throw new Error('模型不支持图片：LLM返回了空响应，可能是因为模型不支持 image_url 参数');
                    }

                    // 第一次空响应就催模型回复（只催一次，避免堆积催促消息）
                    if (consecutiveEmptyResponses === 1) {
                        logToTerminal('warn', '⚠️ 空响应，添加提示消息催促模型回复');
                        voiceChat.messages.push({
                            role: 'user',
                            content: '请根据工具执行结果，回复用户。'
                        });
                    } else {
                        // 连续多次空响应，模型无法恢复，直接退出
                        logToTerminal('error', `❌ 连续 ${consecutiveEmptyResponses} 次空响应，放弃等待`);
                        finalResponseContent = '抱歉，我好像卡住了，请重新问我吧~';
                        break;
                    }

                    iteration++;
                    continue;
                }

                // 检查是否达到最大轮数限制
                if (iteration >= maxIterations) {
                    logToTerminal('warn', `⚠️ 已达到最大工具调用次数限制 (${maxIterations} 轮)`);
                    // 🔥 尝试获取最终回复 - 使用非流式
                    // ⚠ 已知例外（不可避免）：这是第 31 次请求，用裸宿主 + 空工具面 —— 没有易变块、
                    //   没有冻结前缀，本轮必然全 miss。它只是「已经尽力了」的最后兜底，一次而已；
                    //   不为它去重渲染（那会让前面 30 次请求的缓存白算）。
                    const lastResult = await llmClient.chatCompletion(voiceChat.messages, [], false);

                    if (lastResult.content) {
                        finalResponseContent = lastResult.content;
                    } else {
                        finalResponseContent = "抱歉,任务太复杂了,我已经尽力了~";
                    }
                    // 🔥 不在这里播放TTS，统一在最后播放
                }

                // 🧹 轮末清理旧截图（此刻本轮不会再有请求了）：轮内剥离会改写冻结前缀的字节。
                // 保留最新一张（模型这轮看到的就是它），更早的图片剥成文字。
                try {
                    const _stripped = stripOldScreenshotImages(voiceChat.messages);
                    if (_stripped > 0) logToTerminal('info', '🧹 轮末清理旧截图：剥掉 ' + _stripped + ' 条（保留最新一张）');
                } catch (e) { /* 清理失败不影响对话 */ }

                // 输出最终回复
                if (finalResponseContent) {
                    voiceChat.messages.push({ 'role': 'assistant', 'content': finalResponseContent });
                    // heard-response：正常时序下这是空操作；只有「打断回调先于落库」才补截断。
                    try { _flushPendingHeard(); } catch (e) { /* 补打失败不影响对话 */ }
                    // ADR-013：她真的说出口了 = 一次接触 + 现场里的「她刚说」。
                    // source 只用于记账（auto-chat/watch-screen/…），不参与任何说话决策。
                    try {
                        scene.noteCompanion(finalResponseContent, { source: scene.detectProactiveSource(prompt) });
                    } catch (e) { /* 现场失败不影响对话 */ }

                    // 复读护栏（Neuro-sama 行为调研里的失败模式）：近 3 轮里有一句和这轮几乎一样
                    // → 下一轮在易变尾巴提醒她换个说法。只提醒，不重写（重写=再花一次调用，可能更糟）。
                    try {
                        const prev = voiceChat.messages
                            .filter((m) => m && m.role === 'assistant' && typeof m.content === 'string')
                            .slice(-5, -1)
                            .map((m) => m.content);
                        const loop = detectLoop(finalResponseContent, prev);
                        if (loop.loop) {
                            _pendingLoopNote = '（你最近几轮说过几乎一样的话了——换个说法或换个角度，别重复。）';
                            logToTerminal('warn', '🔁 复读检测：相似度 ' + loop.score + ' ← '
                                + String(loop.matched || '').slice(0, 24));
                        }
                    } catch (e) { try { __silentAudit.audit('llm-handler.js:loop-guard', e); } catch (e2) {} }

                    // ===== 清除注入的记忆 =====
                    if (voiceChat.removeInjectedMemory) {
                        voiceChat.removeInjectedMemory();
                    }

                    // ===== 保存对话历史 =====
                    voiceChat.saveConversationHistory();
                    logToTerminal('info', 'AI 已回复');
                    // MemOS 保存由 memos 插件的 onLLMResponse 钩子处理

                    // 🎙️ 播放最终回复的TTS（统一在这里播放，参考旧版本的设计）
                    console.log('✅ 最终回复已处理完成，开始播放TTS');

                    // 🔥 过滤最终回复中的思考内容
                    const filteredFinalContent = filterThinkingContent(finalResponseContent);

                    // 触发插件 onLLMResponse 钩子（插件可修改 responseObj.text，影响 TTS 内容）
                    const responseObj = { text: filteredFinalContent || finalResponseContent };
                    if (global.pluginManager) {
                        await global.pluginManager.runLLMResponseHooks(responseObj).catch(() => {});
                    }
                    _finalReply = String(responseObj.text || '');

                    // D5：回复定稿后结算「注入的记忆有没有真被用上」。
                    // 传的是最终 TTS/字幕文本（插件可能改过），不是中间产物；
                    // 判定在 memory-usage 内部（≥6 字关键片段原样命中），这里不做任何改写。
                    try {
                        // P1-13（2026-11-22 审计）：pending 是单槽。主动开口先跑完时如果也结算，
                        // 会把用户轮注入的记忆批次消费/清空 → 记忆兑现率恒 0。只让真实用户轮结算。
                        if (scene.detectProactiveSource(prompt) === 'user') {
                            memoryUsage.noteUsed({
                                ids: memoryUsage.pendingIds(),
                                text: _finalReply,
                                at: Date.now(),
                            });
                        }
                    } catch (e) { try { __silentAudit.audit('llm-handler.js:memory-usage', e); } catch (e2) {} }

                    // 触发插件 onTTSStart 钩子
                    if (global.pluginManager) {
                        await global.pluginManager.runTTSStartHooks(responseObj.text).catch(() => {});
                    }

                    if (shouldRunChoreography && responseObj.text && responseObj.text.trim()) {
                        const choreographyWork = motionDirector.choreograph(
                            responseObj.text,
                            config,
                            { userMessage: choreographyUserMessage }
                        );
                        choreographyWork.catch((error) => {
                            logToTerminal(
                                'warn',
                                `[MotionDirector] 编舞失败，继续播放 TTS: ${String(error && error.message || error).slice(0, 240)}`
                            );
                        });
                    } else if (responseObj.text && responseObj.text.trim()) {
                        const skipReason = describeChoreographySkip(config);
                        if (skipReason) {
                            logToTerminal('info', `[MotionDirector] 本轮跳过编舞: ${skipReason}`);
                        }
                    }

                    if (iteration === 0 && isStreamingToTTS) {
                        // streaming already started - finalize
                        // §72：flush 必须在 finalize 之前 —— 标记行被吃掉，普通尾巴要补发
                        try {
                            const __tail = _moodFilter.flush();
                            if (__tail.emit) ttsProcessor.addStreamingText(__tail.emit);
                            if (__tail.mood && !_moodSet) { _moodSet = true; _setMoodSafe(__tail.mood, { from: 'llm-final' }); }
                        } catch (e) { /* 过滤失败不能影响收尾 */ }
                        if (typeof ttsProcessor.finalizeStreamingText === 'function') {
                            ttsProcessor.finalizeStreamingText();
                        } else {
                            if (_streamBuf.trim()) ttsProcessor.textSegmentQueue.push(_streamBuf.trim());
                            _streamBuf = '';
                        }
                    } else {
                        ttsProcessor.reset();
                        {
                            // §72：非流式也要剥（否则整段念出来时会把 #mood 念进去）
                            const __ex = extractMoodLine(responseObj.text);
                            if (__ex.mood && !_moodSet) { _moodSet = true; _setMoodSafe(__ex.mood, { from: 'llm-once' }); }
                            ttsProcessor.processTextToSpeech(__ex.text);
                        }
                    }
                } else {
                    logToTerminal('error', '❌ 未获取到有效的AI回复');

                    // 🔥 检查是否因为图片导致的空回复（P0-1：工具附图同样算「有图」）
                    if (screenshotBase64 || useVisionModelForFirstRound || hasToolImageMessage(voiceChat.messages)) {
                        logToTerminal('warn', '⚠️ 检测到有截图但未获取到回复，可能是模型不支持视觉');
                        throw new Error('模型不支持图片：未获取到有效的AI回复，可能是因为模型不支持 image_url 参数');
                    }

                    throw new Error("未获取到有效的AI回复");
                }

                if (voiceChat.enableContextLimit) {
                    voiceChat.trimMessages();
                }
                } catch (error) {
                    // 🔥 特殊处理：用户打断不是错误，静默退出
                    if (error.message === 'USER_INTERRUPTED') {
                        _turnHint = { outcome: 'interrupted', errorKind: 'interrupted' };
                        console.log('用户打断处理完成，静默退出');
                        logToTerminal('info', '✅ 已响应用户打断');
                        motionDirector.cancel('user-interrupted');
                        try {
                            global.paramDirector?.cancel?.();
                        } catch (_) { try { __silentAudit.audit('llm-handler.js:945', _); } catch (e2) {} }

                        // 确保ASR恢复
                        if (voiceChat.asrProcessor && asrEnabled) {
                            voiceChat.asrProcessor.resumeRecording();
                        }
                        return; // 直接返回，不显示错误信息
                    }

                    // 🔥 自动重试机制：检测到视觉不支持错误时，清理图片并重试
                    const errorMsg = error.message.toLowerCase();
                    const isImageUnsupportedError = !hasRetriedWithoutImage && (
                        errorMsg.includes("do not support image") ||
                        errorMsg.includes("不支持图片") ||
                        errorMsg.includes("模型不支持图片") ||
                        errorMsg.includes("image param") ||
                        errorMsg.includes("image_url") ||
                        errorMsg.includes("multimodal") ||
                        errorMsg.includes("does not support multimodal") ||
                        (errorMsg.includes("image") && errorMsg.includes("not support")) ||
                        (errorMsg.includes("image") && errorMsg.includes("unsupported")) ||
                        (errorMsg.includes("image") && errorMsg.includes("invalid"))
                    );

                    if (isImageUnsupportedError) {

                        console.log('⚠️ 检测到模型不支持视觉，自动移除图片并重试');
                        logToTerminal('info', '📷 截图已触发，但当前模型不支持图片，已自动过滤图片内容，以纯文本模式重试');

                        // 标记已经重试过，避免无限循环
                        hasRetriedWithoutImage = true;

                        // 清理 voiceChat.messages 中的所有图片
                        voiceChat.messages = removeImagesFromMessages(voiceChat.messages);
                        console.log('✅ 已清理消息历史中的所有图片，使用纯文本重试');

                        // 🔥 重置标志，准备重试
                        isFirstAttempt = true;

                        // 继续外层循环，重新开始整个流程
                        continue;
                    }

                    logToTerminal('error', `LLM处理错误: ${error.message}`);
                    if (error.stack) {
                        logToTerminal('error', `错误堆栈: ${error.stack}`);
                    }

                    // 保底模型最后兜底：主模型彻底失败且配置了不同的保底模型时，用保底再试一次
                    const fbClient = typeof getFallbackClient === 'function' ? getFallbackClient() : null;
                    if (fbClient) {
                        try {
                            logToTerminal('info', '⚠️ 主模型失败，尝试保底模型');
                            const fbResult = await fbClient.chatCompletion(voiceChat.messages, [], false);
                            const fbText = fbResult && fbResult.content;
                            if (fbText) {
                                voiceChat.showSubtitle(fbText, 3000);
                                if (voiceChat.asrProcessor && asrEnabled) voiceChat.asrProcessor.resumeRecording();
                                setTimeout(() => voiceChat.hideSubtitle(), 3000);
                                _finalReply = String(fbText);
                                _turnFallbackOk = true;
                                break;
                            }
                        } catch (fbError) {
                            logToTerminal('error', `保底模型也失败: ${fbError.message}`);
                        }
                    }

                    // 主模型失败且保底也没救回来 → 本轮结局不是 ok（旧实现这里 break 后仍记 ok）
                    _turnHint = classifyTurnFailure(error);

                    let errorMessage = "抱歉，出现了一个错误";

                    if (error.message.includes("API拒绝生成内容") || error.message.includes("安全过滤器") || error.message.includes("内容政策")) {
                        errorMessage = "⚠️ API触发了安全过滤器，可能最近的对话包含敏感内容。建议重新开始对话或换个话题。";
                    } else if (error.message.includes("API内容过滤")) {
                        errorMessage = "⚠️ 内容被过滤，请避免敏感话题";
                    } else if (error.message.includes("API密钥验证失败")) {
                        errorMessage = "API密钥错误，请检查配置";
                    } else if (error.message.includes("API访问被禁止")) {
                        errorMessage = "API访问受限，请联系支持";
                    } else if (error.message.includes("API接口未找到")) {
                        errorMessage = "无效的API地址，请检查配置";
                    } else if (error.message.includes("请求过于频繁")) {
                        errorMessage = "请求频率超限，请稍后再试";
                    } else if (error.message.includes("服务器错误")) {
                        errorMessage = "AI服务不可用，请稍后再试";
                    } else if (error.message.includes("截图功能出错")) {
                        errorMessage = "截图失败，无法处理视觉内容";
                    } else if (error.message.includes("工具调用失败")) {
                        errorMessage = "功能扩展调用失败，请重试";
                    } else if (error.message.includes("do not support image") || error.message.includes("不支持图片") || error.message.includes("image param")) {
                        errorMessage = "⚠️ 你使用的是不支持视觉的LLM模型，刚刚触发了调用视觉功能，所以报错了！建议换成支持视觉的LLM模型或在config.json中配置独立的视觉模型！";
                        logToTerminal('warn', '💡 提示：请在config.json中设置 vision.use_vision_model: true 并配置支持视觉的模型（如gemini-2.0-flash）');
                    } else if (error.name === "TypeError" && error.message.includes("fetch")) {
                        errorMessage = "网络连接失败，请检查网络和API地址";
                    } else if (error.name === "SyntaxError") {
                        errorMessage = "解析API响应出错，请重试";
                    } else if (/^\s*4\d\d|^\s*5\d\d|BadRequest|InvalidParameter|status code/i.test(error.message)) {
                        // 模型端返回的是结构化错误（火山/OpenAI 兼容层那种 {"code":"InvalidParameter"...}）。
                        // 把这一大坨塞进字幕非常难看，而且用户也读不懂。
                        // 她应该说一句像人说的话，细节留给日志。
                        const code = (error.message.match(/\b(4\d\d|5\d\d)\b/) || [])[1] || '4xx';
                        const reason = (error.message.match(/"message"\s*:\s*"([^"]{0,80})/) || [])[1] || '';
                        errorMessage = code.startsWith('5')
                            ? '那边服务器抽风了，等会儿再说。'
                            : (reason && /unique|parameter/i.test(reason)
                                ? '我这边参数出了点毛病，正在修。'
                                : '刚才那下没接上，再说一遍？');
                        logToTerminal('error', `模型返回 ${code}${reason ? '：' + reason : ''}`);
                        logToTerminal('error', '原始错误: ' + String(error.message).slice(0, 400));
                    } else {
                        // 兜底也不能把原始 JSON 糊到脸上：只留第一行，且截短。
                        const firstLine = String(error.message || '未知错误').split(/\r?\n/)[0];
                        const clean = firstLine.replace(/[{}"\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
                        errorMessage = clean ? `出了点岔子：${clean}` : '出了点岔子，再试一次？';
                        logToTerminal('error', '原始错误: ' + String(error.message).slice(0, 400));
                    }

                    logToTerminal('error', `用户显示错误: ${errorMessage}`);

                    voiceChat.showSubtitle(errorMessage, 3000);
                    if (voiceChat.asrProcessor && asrEnabled) {
                        voiceChat.asrProcessor.resumeRecording();
                    }
                    setTimeout(() => voiceChat.hideSubtitle(), 3000);

                    // 🔥 退出外层重试循环
                    break;
                } finally {
                    // global.isProcessingUserInput 已通过事件自动管理，无需手动设置

                    // 🧊 冻结战绩落 telemetry（llm.freeze）：验收就看 reuse/rebuild/rewrite 三个数。
                    // 「缓存断裂可观测」是这一轮的核心交付 —— 只写日志等于没有。
                    if (freezeStats.requests > 0) {
                        try {
                            if (__emitTelemetry) {
                                __emitTelemetry({
                                    cat: 'llm',
                                    type: 'llm.freeze',
                                    title: '前缀冻结复用',
                                    level: freezeStats.rewrite > 0 ? 'warn' : 'info',
                                    pipeline_stage: 'llm',
                                    metrics: {
                                        reuse: freezeStats.reuse,
                                        rebuild: freezeStats.rebuild,
                                        rewrite: freezeStats.rewrite,
                                        requests: freezeStats.requests,
                                        prefix_msgs: freezeStats.prefixMsgs,
                                        prefix_chars: freezeStats.prefixChars,
                                        // 视觉丢失必须可聚合：重冻时贴不回本轮截图 = 她这轮在「盲聊」
                                        vision_lost: freezeStats.visionLost,
                                    },
                                    turn_id: turnCtx.currentTurnId(),
                                });
                            }
                        } catch (e) { /* 遥测失败不影响对话 */ }
                    }

                    // 🧊 轮结束（回复完成/打断/异常/截图重试）一律丢掉本轮冻结前缀：
                    // 下一轮的世界行/现场/画像要重新收集，否则她会一直用旧的现场说话。
                    turnFreeze = null;
                    try { delete voiceChat._turnFreeze; } catch (_) { /* 观测字段删不掉不影响对话 */ }

                    // ⚡ 本轮收口：垫场计时器必须收掉，防止漏到下一轮（重试 continue 也走这里，
                    //    下一轮循环顶部会重新武装）
                    try { cancelLatencyFiller(); } catch (_) { try { __silentAudit.audit('llm-handler.js:1074', _); } catch (e2) {} }

                    // 📏 延迟观测：一行说清「慢在哪一段」，别让下次只能靠猜
                    try {
                        if (_lat) {
                            const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
                            const ms = (t) => (t ? Math.round(t - _lat.t0) + 'ms' : '—');
                            const parts = [`首token ${ms(_lat.firstTokenAt)}`];
                            if (_lat.hooksMs !== undefined) parts.push(`钩子 ${_lat.hooksMs}ms`);
                            if (_lat.preMs !== undefined) parts.push(`本地准备 ${_lat.preMs}ms`);
                            if (_lat.gatewayMs !== undefined) parts.push(`网关 ${_lat.gatewayMs}ms`);
                            if (_lat.bodyChars !== undefined) parts.push(`载荷 ${_lat.bodyChars}字/${_lat.msgCount}条/tools ${_lat.toolCount}个(${_lat.toolChars}字)`);
                            parts.push(`首段语音 ${ms(_lat.firstTtsAt)}`);
                            parts.push(`总 ${Math.round(nowMs - _lat.t0)}ms`);
                            logToTerminal('info', `[延迟] ${parts.join(' · ')}`);
                        }
                    } catch (_) { /* 观测失败不影响对话 */ }

                    // 发送用户输入结束事件
                    eventBus.emit(Events.USER_INPUT_END);
                }

                // 🔥 退出外层 while(true) 重试循环
                break;
            }
            return _finalReply;
        };

        // A4（2026-11-21）：给每一轮 LLM 处理开/收 turn。
        // 包装在 runTurn 外面（而不是插进它体内）有两个原因：
        //   ① runTurn 的 return/异常点很多，逐个插 endTurn 必然漏；
        //   ② 排队等待（turnGate）不该算进轮内耗时 —— 这里只在真正开跑时计时。
        const runTurnWithTurn = async function(prompt) {
            let outcome = 'ok';
            let extra;
            try {
                turnCtx.ensureTurn('chat');
                turnCtx.markPhase('llm');
                const reply = await runTurn(prompt);
                // runTurn 把失败吞成正常 return（打断/空回复/工具链失败都走 catch 后 break），
                // 真实结局只能看它留下的暗号；没有暗号才是真的 ok。
                if (_turnHint) {
                    outcome = _turnHint.outcome;
                    extra = { errorKind: _turnHint.errorKind };
                } else if (!_turnFallbackOk && (reply === null || reply === undefined || String(reply).trim() === '')) {
                    // 空手而归也是失败（典型：工具循环达到 30 轮上限后静默 break）。
                    // 以前这里照样记 ok，等于把「什么都没说」算成正常完成。
                    outcome = 'error';
                    extra = { errorKind: 'empty' };
                }
                turnCtx.markPhase('reply');
                return reply;
            } catch (e) {
                const c = classifyTurnFailure(e);
                outcome = c.outcome;
                extra = { errorKind: c.errorKind };
                throw e;
            } finally {
                try { turnCtx.endTurn(outcome, extra); } catch (e) { /* 收轮失败不影响对话 */ }
            }
        };

        // 等上一轮 TTS 完全播完（含合成队列清空）再放下一轮进来。
        // 上限 30s：看门狗会清理卡死队列，这里只是最后一道保险，绝不无限等。
        const waitForTtsIdle = async () => {
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                let busy = false;
                try {
                    busy = (ttsProcessor && typeof ttsProcessor.isPlaying === 'function')
                        ? !!ttsProcessor.isPlaying()
                        : appState.isPlayingTTS();
                } catch (_) {
                    busy = appState.isPlayingTTS();
                }
                if (!busy) return;
                if (appState.isInterrupted()) return;   // 用户打断 → 不再等她的上一句
                await new Promise((r) => setTimeout(r, 50));
            }
            try { logToTerminal('warn', '[turn-queue] 等待上一轮 TTS 结束超时（30s），继续下一轮'); } catch (_) { }
        };

        const turnGate = createTurnGate({
            runTurn: runTurnWithTurn,
            maxQueue: 2,
            isInterrupted: () => appState.isInterrupted(),
            clearInterrupted: () => { try { appState.clearInterrupted(); } catch (_) { } },
            interrupt: () => {
                try { if (ttsProcessor && typeof ttsProcessor.interrupt === 'function') ttsProcessor.interrupt({ reason: 'turn-cancel' }); }
                catch (_) { /* 中断失败也要继续清队（声音可能已经没了） */ }
            },
            waitIdle: waitForTtsIdle,
            log: (level, message) => {
                try { logToTerminal(level, message); } catch (_) { /* 日志失败不影响对话 */ }
            },
        });

        // D4（2026-11-22）：打断后「接着说」。
        // 每轮输入先结算 TTL（beginTurn 只清过期，**不取内容** —— 不自动续讲）。
        // 只有用户显式请求才走 tryHandleExplicit；它是全仓唯一会 take() 的执行入口。
        // 非显式路径（普通对话/主动搭话/插件消息）永远不会消费待续剩余段。
        const extractPromptText = (prompt) => (Array.isArray(prompt)
            ? prompt.filter((p) => p && p.type === 'text').map((p) => p.text || '').join(' ')
            : String(prompt == null ? '' : prompt));

        // 兼容旧调用方：sendToLLM 仍是 async (prompt) => reply；turnGate 挂在函数上供排障。
        const submitTurn = function submitTurn(prompt) {
            // P1-10（2026-11-22 审计）：resume-speech 的「1 轮 TTL」只该按**真实用户轮**计。
            // 她自己的主动开口也算一轮的话，用户随后说「接着说」时未播内容已经被判过期。
            // 弹幕/主动开口都不推进、也不消费显式续讲。
            const isUserTurn = scene.detectProactiveSource(prompt) === 'user';
            try {
                if (isUserTurn) {
                    resumeSpeech.beginTurn();
                    const early = resumeSpeech.tryHandleExplicit(extractPromptText(prompt), ttsProcessor);
                    if (early && early.handled) {
                        // 显式续讲不是「停止」：清掉打断标志，免得下一轮还被当成 barge-in；
                        // 同时清掉「别接着讲完」的临时提示（用户刚刚就是要她接着讲）。
                        try { appState.clearInterrupted(); } catch (_) { /* ignore */ }
                        _pendingInterruptNote = '';
                        return Promise.resolve(String(early.text || ''));
                    }
                }
            } catch (e) {
                try {
                    logToTerminal('warn', '[resume-speech] 显式续讲处理失败，回退正常对话：' + (e && e.message || e));
                } catch (_) { /* 日志失败不影响对话 */ }
            }
            return turnGate.submit(prompt);
        };
        submitTurn.turnGate = turnGate;
        return submitTurn;
    }
}

module.exports = {
    LLMHandler,
    createTurnGate,
    filterThinkingContent,
    shouldRunMotionChoreography,
    describeChoreographySkip,
    // 轮末旧截图清理（ADR-014 漏一）：导出只为让 _probe 能直接断言「保留最新一张」
    stripOldScreenshotImages,
    // 请求体的历史图片清理（P1-1）：导出让 _probe 断言「剥图在冻结之前、快照==首请求字节」
    stripHistoryImagesForRequest,
    // 轮结局分类（2026-11-25）：导出让 _probe 直接断言 outcome/errorKind 映射
    classifyTurnFailure,
};
