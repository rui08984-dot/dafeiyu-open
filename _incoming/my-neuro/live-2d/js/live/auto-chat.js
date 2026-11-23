// 自动对话模块 - 重构版本，复用sendToLLM逻辑
const { appState } = require('../core/app-state.js');
const { eventBus } = require('../core/event-bus.js');
const { Events } = require('../core/events.js');
const { audit: __silentAudit } = require('../core/silent-audit.js');
const intentQueue = require('../core/intent-queue.js');

// ── 活动窗判据（2026-11-22 P0，导出纯函数便于单测）────────────────────────
// 语义（来自 2026-11-09 三十轮的设计）：
//   idle（30s–5min 无键鼠输入）→ 可以轻声说一句
//   active（30s 内有输入）     → 在忙，别说
//   away（>5min 无输入）       → 没人听，别说（说给空房间听只是白烧 API）
//   未知/没有传感器            → 放行（感知缺失不该把她变成哑巴）
//
// 2026-11-22 修的第二个「从不搭话」根因：原来 active 跳过之后按**完整间隔**（4 分钟）
// 重排，而用户几乎总是 active → 每 4 分钟才采样一次「是不是刚好空了 30 秒」，
// 撞进空窗的概率很低。现在 active 时用 60 秒短间隔复采，采样率提高 4 倍，
// 仍然只在真正 idle 的窗口开口（不放松判据，只提高发现空窗的机会）。
const ACTIVITY_RETRY_MS = 60000;
function decideActivityGate(act) {
    if (!act || !act.state || act.state === 'unknown' || act.state === 'idle') {
        return { ok: true, reason: (act && act.state) || 'no-sensor', retryMs: 0 };
    }
    if (act.state === 'active') return { ok: false, reason: 'active', retryMs: ACTIVITY_RETRY_MS };
    if (act.state === 'away') return { ok: false, reason: 'away', retryMs: 0 };
    return { ok: true, reason: 'state:' + act.state, retryMs: 0 };
}

class AutoChatModule {
   constructor(pluginConfig, mainConfig, ttsProcessor) {
       // 注意：ttsProcessor参数保留但不再直接使用，因为sendToLLM已经处理TTS
       this.pluginConfig = pluginConfig;
       this.timeoutId = null;
       this.isRunning = false;
       // 默认 60 秒（2026-11-16 从 15 秒上调）：用户反馈「说一句她就自己接着说，每句话都说很烦」。
       // 15 秒在她说完、用户还在想的时候就会开口，听感像抢话；60 秒才像「安静陪着你」。
       // 想更频繁可在插件配置里写 idle_time（秒）。
       this.idleTimeThreshold = (pluginConfig.idle_time || 60) * 1000; // 转换为毫秒
       this.lastInteractionTime = Date.now();
       this.isProcessing = false;

       // 自动截图相关配置
       this.autoScreenshot = mainConfig.vision?.auto_screenshot || false;
       this.screenshotEnabled = mainConfig.vision?.enabled || false;

       // ── 静音时段 ──────────────────────────────────────────────
       // 深夜（默认 1:00-7:00）不该每 4 分钟搭一次话，把人吵醒比不说话更糟。
       // 静音时段里间隔放大到 4 倍，等于「几乎不主动，但如果醒着躺了很久会轻轻说一句」。
       const quiet = (pluginConfig.quiet_hours && typeof pluginConfig.quiet_hours === 'object') ? pluginConfig.quiet_hours : {};
       this.quietStart = Number.isFinite(quiet.start) ? Number(quiet.start) : 1;
       this.quietEnd = Number.isFinite(quiet.end) ? Number(quiet.end) : 7;
       this.quietMultiplier = Number.isFinite(quiet.multiplier) ? Number(quiet.multiplier) : 4;

       // ── 话术轮换：同一句话天天重复就不像人了 ────────────────────
       this._openers = [
         '接你刚才看到的东西说一句（屏幕上的画面 / 声音里的对白），要具体，别泛泛而谈。',
         '自言自语一小句：你最近在想什么、你现在想干什么。',
         '吐槽一句现在的状态（时间、天气、用户在不务正业之类），带点刺。',
         '提一个和刚才内容有关的小问题，问完就停，别追问。',
         '换个姿势/动作，配一句很短的感慨。',
       ];
       this._lastOpener = -1;
       // 保存引用：eventBus.off(eventName) 不传 callback 是 no-op（indexOf(undefined) = -1），
       // 原来 stop() 那句 off 从来没生效过 —— 监听器永远留着，重启/热重载后越叠越多。
       this._onInteractionUpdated = () => { this.updateLastInteractionTime(); };

       // 可观测计数（2026-11-22 P0）：以前「她为什么不说话」只能靠猜 ——
       // 现在每次 tick 的去向都有账，stats() 通过 8004/doctor 直接读。
       this._stats = {
         ticks: 0, spoke: 0, emptyReply: 0, errors: 0,
         skippedQuiet: 0, skippedActive: 0, skippedAway: 0, skippedBusy: 0,
         denied: {}, lastDeniedReason: '', lastSpokeAt: 0, startedAt: 0,
       };
       this._skipLogAt = {};
   }

   _stat(key) {
       try { this._stats[key] = (this._stats[key] || 0) + 1; } catch (e) { /* 计数失败不影响说话 */ }
   }

   /** 同一原因 10 分钟只打一行，避免把 runtime.log 刷满 */
   _logSkip(key, msg) {
       const now = Date.now();
       if (now - (this._skipLogAt[key] || 0) < 10 * 60 * 1000) return;
       this._skipLogAt[key] = now;
       try { console.log(msg); } catch (e) { /* ignore */ }
       try { if (typeof logToTerminal === 'function') logToTerminal('info', msg); } catch (e) { /* ignore */ }
   }

   /** 诊断快照（doctor / 8004 /eval 读；不含用户内容） */
   stats() {
       const s = this._stats;
       return {
         running: this.isRunning,
         intervalSec: Math.round(this.idleTimeThreshold / 1000),
         nextInMs: this.timeoutId ? Math.max(0, (this._nextAt || 0) - Date.now()) : null,
         ticks: s.ticks, spoke: s.spoke, emptyReply: s.emptyReply, errors: s.errors,
         skippedQuiet: s.skippedQuiet, skippedActive: s.skippedActive,
         skippedAway: s.skippedAway, skippedBusy: s.skippedBusy,
         denied: { ...s.denied }, lastDeniedReason: s.lastDeniedReason,
         lastSpokeAt: s.lastSpokeAt,
         lastInteractionAgeSec: this.lastInteractionTime ? Math.round((Date.now() - this.lastInteractionTime) / 1000) : null,
       };
   }

   // 半夜静音：返回 true 表示现在不该主动开口
   _isQuietHour() {
       const h = new Date().getHours();
       if (this.quietStart === this.quietEnd) return false;
       return this.quietStart < this.quietEnd
           ? (h >= this.quietStart && h < this.quietEnd)
           : (h >= this.quietStart || h < this.quietEnd);
   }

   _nextOpener() {
       // 轮换而不是随机：保证不会连续两次同一个角度
       let idx;
       do { idx = Math.floor(Math.random() * this._openers.length); }
       while (this._openers.length > 1 && idx === this._lastOpener);
       this._lastOpener = idx;
       return this._openers[idx];
   }

   start() {
       if (this.isRunning) return;

       console.log(`自动对话启动，间隔：${this.idleTimeThreshold}ms`);
       this.isRunning = true;
       this.lastInteractionTime = Date.now();
       try { this._stats.startedAt = this.lastInteractionTime; } catch (e) { /* ignore */ }

       // 监听交互更新事件
       eventBus.on(Events.INTERACTION_UPDATED, this._onInteractionUpdated);

       this.scheduleNext();
   }

   stop() {
       if (this.timeoutId) {
           clearTimeout(this.timeoutId);
           this.timeoutId = null;
       }
       this.isRunning = false;
       this.isProcessing = false;

       // 移除事件监听（必须带 callback；见构造器注释）
       eventBus.off(Events.INTERACTION_UPDATED, this._onInteractionUpdated);
   }

   scheduleNext(delayOverride) {
       if (!this.isRunning) return;

       // 深夜把间隔放大，避免吵到人；delayOverride 用于「活动窗没过」时的短间隔复采
       const base = Number.isFinite(delayOverride) && delayOverride > 0
           ? delayOverride
           : (this._isQuietHour() ? this.idleTimeThreshold * this.quietMultiplier : this.idleTimeThreshold);
       const delay = Math.round(base);
       this._nextAt = Date.now() + delay;
       const nextTime = new Date(this._nextAt).toLocaleTimeString();
       // 静默期只在首次排程打一行（原来每次重排都打，静默时每 4 分钟一条纯噪声）
       if (!global.__petQuiet || !this._loggedNextOnce) {
           console.log(`⏰ 下次主动对话预定在: ${nextTime} (${delay}ms后)`);
           this._loggedNextOnce = true;
       }

       this.timeoutId = setTimeout(() => {
           this.executeChat();
       }, delay);
   }

   // 注意：takeScreenshotBase64方法已移除，现在由sendToLLM统一处理截图

   async executeChat() {
       if (!this.isRunning || this.isProcessing) return;
       this._stat('ticks');

       // 省钱模式：静默期不主动找人说话（每次主动开口 = 一次 LLM 调用）。
       // 提前到函数最前面——原来放在后面，导致每 4 分钟刷三行「开始自动对话/sendToLLM/静默跳过」噪声日志。
       //
       // ⚠ 2026-11-10 回归审计抓到（**功能已死但看起来正常**）：这两个早退在
       //   `try { … } finally { this.scheduleNext(); }` **之前** —— 早退不经过 finally，
       //   定时链断一次就永久停摆（探针实测 scheduleNext 调用 0 次）。之后就算关掉静默，
       //   她也再不会主动开口，只能重启。**每个早退都必须自己补一次重排**。
       if (global.__petQuiet) {
           this._stat('skippedQuiet');
           this._logSkip('quiet', '[auto-chat] 静默模式开启，跳过主动搭话（10 分钟内只提示一次）');
           this.scheduleNext();
           return;
       }

       // 🖐 用户专注期不打扰（2026-11-09 三十轮）：她主动开口最尴尬的是「你在干活/开会时插嘴」。
       // 依据 main.js 每 8 秒更新的 global.__userActivity（Win32 GetLastInputInfo，只读）。
       // 判据抽到 decideActivityGate（导出的纯函数，单测覆盖 5 种状态）：
       //   active → 每 60s 复采（2026-11-22 P0：原来按 4 分钟整间隔重排，采样太稀）
       //   away   → 按正常间隔再等（没人听，不说）
       //   idle / 未知 / 没传感器 → 放行
       // 只影响「主动说话」，用户主动找她说话完全不受影响。
       try {
           const act = global.__userActivity;
           const gate = decideActivityGate(act);
           if (!gate.ok) {
               this._stat(gate.reason === 'active' ? 'skippedActive' : 'skippedAway');
               this._logSkip('activity:' + gate.reason, '[auto-chat] 用户当前'
                   + (gate.reason === 'active' ? '在忙（30 秒内有键鼠输入）' : '不在（超过 5 分钟无输入）')
                   + '，这次不说' + (gate.retryMs ? '，' + Math.round(gate.retryMs / 1000) + ' 秒后复采' : ''));
               this.scheduleNext(gate.retryMs || undefined);   // 早退必须自己补重排
               return;
           }
       } catch (e) { try { __silentAudit.audit('auto-chat.js:activity', e); } catch (e2) {} }

       // 🔧 调试：打印所有状态
       const playingTTS = appState.isPlayingTTS();
       const processingBarrage = appState.isProcessingBarrage();
       const processingUserInput = appState.isProcessingUserInput();

       // 检查其他活动（她自己正在说话/弹幕/用户输入）：5 秒后重试，属于短窗口
       if (playingTTS || processingBarrage || processingUserInput) {
           this._stat('skippedBusy');
           this._logSkip('busy', `⏸️ 主动对话延迟 - TTS播放:${playingTTS}, 弹幕处理:${processingBarrage}, 用户输入:${processingUserInput}`);
           if (typeof logToTerminal === 'function') {
               logToTerminal('warning', `⏸️ 主动对话延迟 - TTS:${playingTTS}, 弹幕:${processingBarrage}, 输入:${processingUserInput}`);
           }
           this.timeoutId = setTimeout(() => this.executeChat(), 5000);
           return;
       }

       this.isProcessing = true;

       // 统一闸门（2026-11-15 六十三轮，主动性四路巩固）：
       // auto-chat 以前只查自己的静默/忙碌，**不走 speech-coordinator** ——
       // 于是绕过预算与优先级，还能在用户这轮没说完时插嘴。
       // 现在四路走同一张闸门表（userActive / 预算 / 最小间隔）。
       // ⚠ 2026-11-22 修：这里原来写 `../../core/...`（从 js/live 解析到 live-2d/core，
       //   目录不存在），require 抛错被下面的 catch 吞掉 —— 这道闸从上线起就没生效过。
       //   改成 `../core/...` 后 auto-chat 才真的受预算/静默/用户回合约束。
       let gateOk = false;
       let gateAttemptId = null;
       try {
           const gate = require('../core/speech-coordinator.js').singleton.request('auto-chat', { priority: 'proactive' });
           if (!gate.allowed) {
               this._stats.denied[gate.reason] = (this._stats.denied[gate.reason] || 0) + 1;
               this._stats.lastDeniedReason = gate.reason;
               this._logSkip('denied:' + gate.reason, '[auto-chat] 让路：' + gate.reason);
               // D3（2026-11-22）：拒绝不等于丢掉——把这次「想主动说一句」排队，
               // 等空闲且情境还对得上时补说（≤1 条）。不改原有拒绝行为，只多记一条。
               // 用固定文本（不带随机 opener）让重复拒绝去重，不白占 5 个槽位。
               try {
                   if (intentQueue.isEnabled()) {
                       intentQueue.defer({
                           text: `[自动触发] ${this.pluginConfig.prompt || ''}\n（刚才没轮到你说话，现在补一句。）`,
                           intent: 'auto-chat',
                           context: intentQueue.currentContext(),
                       });
                   }
               } catch (e) { try { __silentAudit.audit('auto-chat.js:intent-defer', e); } catch (e2) {} }
               this.isProcessing = false;
               this.scheduleNext();
               return;
           }
           gateOk = true;
           gateAttemptId = gate.attemptId || null;
       } catch (e) { /* 协调器不可用：保持原行为，不能因此永远不说话 */ }

       // D3：空闲通道补说——闸门放行后先看队列里有没有情境匹配的旧意图，
       // 有就优先说它（一次只取 1 条）；没有才走原来的「新生成一句」。
       let queuedIntent = null;
       if (gateOk) {
           try { queuedIntent = intentQueue.take(); } catch (e) { try { __silentAudit.audit('auto-chat.js:intent-take', e); } catch (e2) {} }
       }
       // 没发出去时放回队列：保留原始 at，TTL 仍从第一次被拒算起（不会无限重试）
       const requeueQueued = (item) => {
           if (!item) return;
           try { intentQueue.defer({ text: item.text, intent: item.intent, context: item.fp, at: item.at }); }
           catch (e) { try { __silentAudit.audit('auto-chat.js:intent-requeue', e); } catch (e2) {} }
       };

       console.log('✅ 开始自动对话');
       if (typeof logToTerminal === 'function') {
           logToTerminal('info', '🔧 开始自动对话执行');
       }

       try {
           const voiceChat = global.voiceChat;
           if (!voiceChat) {
               console.error('voiceChat不存在');
               // 拿了令牌/取了队列项但没发出去：还回发言窗口，并把队列项放回去
               requeueQueued(queuedIntent);
               try { require('../core/speech-coordinator.js').singleton.release('auto-chat', 'voiceChat 不存在'); } catch (e) { /* ignore */ }
               return;
           }

           // 每次换一个角度，避免她永远用同一种方式搭话；
           // 有排队意图时用它自己的文本（保留当时的指令/情境）。
           let prompt;
           if (queuedIntent && queuedIntent.text) {
               prompt = queuedIntent.text;
               console.log('[auto-chat] 补说排队意图（' + (queuedIntent.intent || '?') + '，等了 ' + Math.round((queuedIntent.age_ms || 0) / 1000) + 's）');
           } else {
               prompt = `[自动触发] ${this.pluginConfig.prompt || ''}\n本次角度：${this._nextOpener()}`;
           }

           // 🚀 关键简化：直接使用已有的sendToLLM方法！
           console.log('调用统一的sendToLLM方法...');
           // 省钱模式：静默时不主动找人说话（每次主动开口 = 一次 LLM 调用）
           if (global.__petQuiet) {
               this._stat('skippedQuiet');
               console.log("[auto-chat] 静默模式，跳过");
               // 闸门已放行才走到这里：静默是竞态，别白烧一次预算；队列项也放回去。
               requeueQueued(queuedIntent);
               try { require('../core/speech-coordinator.js').singleton.release('auto-chat', '静默模式竞态'); } catch (e) { /* ignore */ }
               return;
           }

           // 🎯 核心简化：检查是否需要截图，如果需要则修改prompt让sendToLLM处理
           if (this.screenshotEnabled && this.autoScreenshot) {
               console.log('自动截图模式已开启，主动对话将包含截图');
               // 添加特殊标记，让sendToLLM知道需要截图
               prompt = `${prompt} [需要截图]`;

               // 临时设置标志，让sendToLLM知道要截图
               voiceChat._autoScreenshotFlag = true;
           }

           const reply = await voiceChat.sendToLLM(prompt);
           const said = reply !== undefined && reply !== null && String(reply).trim().length >= 1;
           if (said) {
               // 真说完了才记一次发言（budget/最小间隔靠它记账）
               this._stat('spoke');
               this._stats.lastSpokeAt = Date.now();
               try { require('../core/speech-coordinator.js').singleton.markSpoken('auto-chat'); } catch (e) { /* 记账失败不影响说话 */ }
               // 她说话了 = 一次真实接触（防久别重逢误判，见 js/core/last-contact.js 头部）
               try { require('../core/last-contact.js').noteContact('auto-chat'); } catch (e) { /* 记账失败不影响说话 */ }
               // 主动日志诚实记「真说出口」（2026-11-22）：request 只代表申请过，
               // 生成失败/空回复时也算一次的话，看日志会误以为她说了。
               try {
                   const sb = require('../core/speech-budget.js').singleton();
                   if (sb && typeof sb.noteSpoken === 'function') sb.noteSpoken('auto-chat', gateAttemptId, String(reply).length);
               } catch (e) { /* 记账失败不影响说话 */ }
               console.log('[auto-chat] 说出口了（' + String(reply).length + ' 字）');
           } else {
               this._stat('emptyReply');
               this._logSkip('empty', '[auto-chat] 模型返回空/过短，这次不算说过（窗口已还）');
               try { require('../core/speech-coordinator.js').singleton.release('auto-chat', '空回复'); } catch (e) { /* ignore */ }
               requeueQueued(queuedIntent);
           }

           // 清除截图标志
           if (voiceChat._autoScreenshotFlag) {
               delete voiceChat._autoScreenshotFlag;
           }

       } catch (error) {
           console.error('自动对话错误:', error);
           // 拿了令牌但没说出来：把窗口还回去（否则下一次主动搭话被自己的假记录拦住）
           this._stat('errors');
           try { require('../core/speech-coordinator.js').singleton.release('auto-chat', '生成失败'); } catch (e) { /* ignore */ }
           // 队列项没发出去，放回队列（保留原始 at，TTL 会兜底，不会无限重试）
           requeueQueued(queuedIntent);
           // 发送失败时截图标志不能留给下一次（否则下一次无故截图）
           try { if (global.voiceChat && global.voiceChat._autoScreenshotFlag) delete global.voiceChat._autoScreenshotFlag; } catch (e) { /* ignore */ }
           if (typeof logToTerminal === 'function') {
               logToTerminal('error', `❌ 自动对话执行失败: ${error.message}`);
           }
       } finally {
           this.isProcessing = false;
           // 对话完成后，安排下一次
           this.scheduleNext();
       }
   }

   // 注意：waitForTTS方法已移除，因为sendToLLM已经处理了TTS播放

   updateLastInteractionTime() {
       this.lastInteractionTime = Date.now();
       if (this.timeoutId) {
           clearTimeout(this.timeoutId);
           this.scheduleNext();
       }
   }
}

module.exports = { AutoChatModule, decideActivityGate, ACTIVITY_RETRY_MS };