// tts-processor.js - TTS处理器（主协调器）
const __silentAudit = require('../core/silent-audit.js');
const { logToTerminal } = require('../api-utils.js');
const { eventBus } = require('../core/event-bus.js');
const { Events } = require('../core/events.js');
const { TTSPlaybackEngine } = require('./tts-playback-engine.js');
const { TTSRequestHandler } = require('./tts-request-handler.js');
const { VolcengineStreamingSession } = require('./volcengine-streaming.js');
const { TextMouthDriver } = require('./text-mouth-driver');
const resumeSpeech = require('../core/resume-speech.js');

// heard-response（2026-11-22）：被打断时把「真正播出去的前缀」通过**显式回调**交给订阅方
// （llm-handler 在模块初始化时注册，用来把历史里的 assistant 消息截到用户真听到的位置）。
// 模块级单槽，不新造 global；只有 wasPlaying === true 且前缀可信（string）时才回调。
let _onInterrupted = null;
function setInterruptListener(fn) {
    _onInterrupted = typeof fn === 'function' ? fn : null;
}

function cleanDisplayText(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, '').replace(/<[^<>]*$/g, '')
        .replace(/＜[^＞]*＞/g, '').replace(/＜[^＜＞]*$/g, '')
        .trim();
}

class EnhancedTextProcessor {
    constructor(ttsUrl, onAudioDataCallback, onStartCallback, onEndCallback, config = null) {
        this.config = config || {};

        // D4（2026-11-22）：打断后「接着说」总开关。默认开 —— 只有用户显式说
        // 「接着说/继续刚才」才会重播；不自动续讲，且 TTL 只有 1 轮。
        // config.tts.resume_after_interrupt === false 时整条链 no-op。
        try {
            resumeSpeech.setEnabled(!(this.config.tts && this.config.tts.resume_after_interrupt === false));
        } catch (e) { /* 开关读失败按默认开处理，不影响 TTS */ }

        // 初始化两个大模块
        this.playbackEngine = new TTSPlaybackEngine(config, onAudioDataCallback, onStartCallback, onEndCallback);
        this.requestHandler = new TTSRequestHandler(config, ttsUrl);
        this.textMouth = new TextMouthDriver(value => {
            if (!this.playbackEngine.getPlayingState?.()) this.playbackEngine.onAudioDataCallback?.(value);
        });

        // 字节流式 session 的开始/结束回调。
        // 口型共用 playbackEngine 当前回调，由 AvatarFacade 路由到活动模型。
        this._onStartCallback = onStartCallback;
        this._onEndCallback   = onEndCallback;

        // 字节TTS流式session
        this.volcSession = null;
        this._volcChain  = Promise.resolve();  // 串行化所有 volcSession 操作

        // 队列
        this.textSegmentQueue = [];
        this.audioDataQueue = [];

        // 状态
        this.isProcessing = false;
        this.shouldStop = false;
        this.llmFullResponse = '';

        // TTS不可用标记：第一次失败后跳过后续所有TTS请求
        this.ttsUnavailable = false;
        this._ttsFailStreak = 0;        // 连续失败次数（成功一次就归零）
        this._ttsCooldownUntil = 0;     // 降级冷却到期时间

        // 中止代数：每次interrupt时递增，用于丢弃过期请求结果
        this.abortGeneration = 0;

        // 回退字幕状态
        this.fallbackDisplayText = '';
        this._fallbackTimer = null;
        this._subtitleHideTimer = null;

        // 🔥 TTS完成Promise（用于等待播放完成）
        this.completionPromise = null;
        this.completionResolve = null;

        // 启动处理线程
        this._threadsStarted = true;
        // 线程代数（2026-11-21 根因修复）：处理线程与播放线程**各用各的计数器**。
        // 原来两条线程共用一个 _threadToken，构造器/看门狗都是「先起处理线程、再起播放线程」，
        // 后起的播放线程把代数 +1 → 处理线程下一拍发现 token 过期就自退 → 合成线程从一开始就是死的，
        // 只有看门狗每 2s 重启时能挤出 1 段（句间被限速到 ~4s/句、首音 0–6s 抖动）。
        // 现在任一条线程重启只让自己的旧循环自退，绝不误伤另一条。
        this._procToken = 0;            // 处理线程代数
        this._playToken = 0;            // 播放线程代数
        this._lastProgressAt = Date.now();
        this.startProcessingThread();
        this.startPlaybackThread();
        this._startWatchdog();
    }

    // 起线程前先换代：只让**同类**旧循环在下一拍自退。
    // 构造器/watchdog/ensureThreads/interrupt 四处都会起线程；播放线程换代理数
    // 不得让处理线程自退（反之亦然）——这是 2026-11-21 合成线程「一开始就死」的根因。
    _bumpProcToken() { return (this._procToken = (this._procToken || 0) + 1); }
    _bumpPlayToken() { return (this._playToken = (this._playToken || 0) + 1); }

    /**
     * 唤醒处理链：把「最多白等 50ms」压到 0ms（2026-11-09 #9）。
     * 不动线程结构（保留轮询兜底，防漏唤醒），只在有新文本入库时把下一拍提前。
     */
    _kickProc() {
        try {
            if (this._procTimer) { clearTimeout(this._procTimer); this._procTimer = null; }
            if (typeof this._procTick === 'function') this._procTick();
        } catch (e) { try { __silentAudit.audit('tts-processor.js:_kickProc', e); } catch (e2) {} }
    }

    // 看门狗：处理/播放线程可能因为内部异常静默死掉（表现是「只有字幕没有声音」）。
    // 这里每 2 秒检查一次：有活、却连续 4 秒没有任何进展，就把两条线程重启一遍。
    _startWatchdog() {
        if (this._watchdogTimer) return;
        this._watchdogTimer = setInterval(() => {
            try {
                // 2026-11-21：pending 必须把「在途段」算进去（isProcessing=true 表示段已 shift、
                //   合成还没回来）。原来只数两个队列 → Edge 卡住时段已出队、队列空，
                //   看门狗永远判「没活」→ 整轮静音且不结束。
                const queued = (this.textSegmentQueue || []).length + (this.audioDataQueue || []).length;
                const pending = queued + (this.isProcessing ? 1 : 0);
                const stalled = Date.now() - (this._lastProgressAt || 0) > 4000;
                if (pending > 0 && stalled) {
                    const now = Date.now();
                    this._stallRestarts = (this._stallRestarts || 0) + 1;
                    // 2026-11-13：重启线程**不会复位 isProcessing**（实例字段），所以如果
                    //   卡的是这个单线程标志，重启多少次都没用 —— 日志里出现过 106 次连续
                    //   告警。现在：每次重启都先复位标志；连续 3 次还动不了，说明队列里有
                    //   永远处理不了的条目，直接清队（那些条目本来就播不出来）。
                    const hard = this._stallRestarts >= 3;
                    // 2026-11-21：改走 logToTerminal —— 原来只有 console.warn，runtime.log 里
                    //   0 条（DevTools 一关就没人知道她在卡）。可观测计数 _stallRestarts 照旧。
                    logToTerminal('warn', '[TTS] 检测到线程卡死（待处理 ' + pending + ' 条：队列 ' + queued
                        + ' + 在途 ' + (this.isProcessing ? 1 : 0) + '，无进展）'
                        + (hard ? '，连续 ' + this._stallRestarts + ' 次 → 复位标志并清空队列' : '，正在重启'));
                    this.isProcessing = false;
                    if (hard) {
                        const dropped = (this.textSegmentQueue || []).length + (this.audioDataQueue || []).length;
                        this.textSegmentQueue = [];
                        this.audioDataQueue = [];
                        this._stallRestarts = 0;
                        // 2026-11-21：清队 = 「这几句只有字幕没有声音」，用户能感知，
                        // 但原来只在控制台 warn 一句、没人读。现在留可观测计数 + 进静默审计台账。
                        this._droppedTtsCount = (this._droppedTtsCount || 0) + dropped;
                        this._lastDropAt = Date.now();
                        try { __silentAudit.audit('tts-processor.js:queue-drop', new Error('TTS 硬卡死清队 ' + dropped + ' 条（这些句子没有声音）')); } catch (e2) { }
                    }
                    this._threadsStarted = true;
                    this.startProcessingThread();
                    this.startPlaybackThread();
                    this._lastProgressAt = now;
                }
            } catch (e) { try { __silentAudit.audit('tts-processor.js:85', e); } catch (e2) {} }
        }, 2000);
        if (this._watchdogTimer.unref) this._watchdogTimer.unref();
    }

    // 外部可调用：确保线程在跑（初始化时机不确定时兜底）
    ensureThreads() {
        this._threadsStarted = true;
        this.startProcessingThread();
        this.startPlaybackThread();
        this._lastProgressAt = Date.now();
    }

    // 设置情绪映射器
    setEmotionMapper(emotionMapper) {
        this.playbackEngine.setEmotionMapper(emotionMapper);
        this._emotionMapper = emotionMapper;
    }

    // 表情映射器
    setExpressionMapper(expressionMapper) {
        this.playbackEngine.setExpressionMapper(expressionMapper);
        this._expressionMapper = expressionMapper;
    }


    // 处理线程 - 将文本转换为音频
    startProcessingThread() {
        const myToken = this._bumpProcToken();
        // 空转实测（2026-11-09）：50ms 轮询纯 CPU 成本 0.4µs/s（0.00004%），不是性能问题；
        // 真代价是 push 后最多白等 50ms 才被取走。这里加「push 即唤醒」：
        // 队列空时不用短轮询，改为等 _wakeSignal；push 侧调用 _wake() 立即唤醒。
        // 保留 50ms 短轮询兜底（不放空：只有在队列非空或刚 wake 时才走快路径），
        // 目的是「不改线程结构、不引入漏唤醒风险」——语音链是核心功能，宁可保守。
        const processNext = async () => {
            // 代数不符 = 有更新的**处理**线程已被拉起，本循环自退（不打 shouldStop，避免误伤新线程）
            if (this.shouldStop || myToken !== this._procToken) return;

            if (this.textSegmentQueue.length > 0 && !this.isProcessing) {
                this.isProcessing = true;
                // 「取到活」本身就是进展：给这一段一个完整的 4s 窗口再判卡死，
                // 避免正常的慢合成（1–3s）刚超 4s 就被看门狗重启成两条并发合成。
                this._lastProgressAt = Date.now();
                const segment = this.textSegmentQueue.shift();

                // 用户静音（托盘「静音（TTS）」）→ 只显示字幕，不合成、不出声。
                // 2026-11-15：原来静音靠 `ttsUnavailable=true`，而下面这段逻辑会在
                // 冷却时间一到（`_ttsCooldownUntil||0` = 0）**立刻把它清掉** —— 表现就是
                // 「勾了静音还是有声音」。静音是用户意图，不能被冷却逻辑复位。
                if (global.__ttsMuted) {
                    this.appendFallbackText(segment);
                    this.isProcessing = false;
                    setTimeout(processNext, 50);
                    return;
                }

                // TTS已标记不可用，直接走回退显示，不再浪费时间请求。
                // 但冷却期一过要自动恢复 —— 否则一次抖动就永久哑巴。
                if (this.ttsUnavailable) {
                    if (Date.now() >= (this._ttsCooldownUntil || 0)) {
                        this.ttsUnavailable = false;
                        this._ttsFailStreak = 0;
                        console.log('[TTS] 冷却结束，重新尝试合成');
                    } else {
                        this.appendFallbackText(segment);
                        this.isProcessing = false;
                        setTimeout(processNext, 50);
                        return;
                    }
                }

                // 清理后无实际文字内容的片段（纯情绪标签、纯标点等），直接跳过
                const cleanedSegment = segment
                    .replace(/<[^>]+>/g, '')
                    .replace(/（.*?）|\(.*?\)/g, '')
                    .replace(/\*.*?\*/g, '')
                    .replace(/[,，。？?!！；;：:、…—\-\s]/g, '')
                    .trim();
                if (!cleanedSegment) {
                    this.isProcessing = false;
                    setTimeout(processNext, 50);
                    return;
                }

                const genSnapshot = this.abortGeneration;
                try {
                    const audioData = await this.requestHandler.convertTextToSpeech(segment);

                    // 2026-11-21：合成期间可能被看门狗换代（在途段计入 pending 后，卡死会重启线程）。
                    // 本循环已被新代数接管 → 结果能用就入队，但**不再碰 isProcessing/_procTimer**
                    // （否则会把新线程的定时器清掉、或把它的在途标志清成 false → 双线程抢队列）。
                    if (myToken !== this._procToken) {
                        if (audioData && !this.shouldStop) {
                            this.audioDataQueue.push({ audio: audioData, text: segment });
                        }
                        return;
                    }

                    // 如果中止代数已变化，说明请求属于旧一轮，直接丢弃结果
                    if (genSnapshot !== this.abortGeneration) {
                        this.isProcessing = false;
                        setTimeout(processNext, 50);
                        return;
                    }

                    if (audioData) {
                        this._lastProgressAt = Date.now();
                        this._ttsFailStreak = 0;      // 成功了就清零，下次失败重新计数
                        this._stallRestarts = 0;      // 有进展就把「连续卡死」计数也清零
                        this.audioDataQueue.push({ audio: audioData, text: segment });
                        // 首音延迟：第一段音频入队 = 马上要出声（播放线程每 50ms 取一次）
                        if (!this._firstAudioLogged) {
                            this._firstAudioLogged = true;
                            const base = this._turnT0 || Date.now();
                            const firstText = this._firstSegmentAt ? (this._firstSegmentAt - base) : 0;
                            try {
                                logToTerminal('info', '⏱️ 首音 ' + ((Date.now() - base) / 1000).toFixed(2)
                                    + 's（首段文本 ' + (firstText / 1000).toFixed(2) + 's + 合成等待）');
                            } catch (e) { /* 日志失败不影响播放 */ }
                        }
                    }else if (this.shouldStop) {
                        // 被主动打断（abort），不标记为不可用
                        // ⚠ 2026-11-13：这里原来直接 return，**没有复位 isProcessing** ——
                        //   标志永久为真 → 队列从此再没人消费 → 看门狗每 2 秒判「卡死」
                        //   重启线程，但 isProcessing 是实例字段、重启不复位 → 死循环。
                        //   实测日志里这条告警出现过 106 次（约 3.5 分钟持续重启）。
                        this.isProcessing = false;
                        return;
                    } else {
                        // 单次失败不算数：网络抖一下就永久静音太脆弱了（实测这条日志出现过 24 次，
                        // 每次都会让她「只有字幕没声音」，直到下次打断才恢复）。
                        // 改成连续 3 次失败才降级，且 30 秒后自动重试。
                        this._ttsFailStreak = (this._ttsFailStreak || 0) + 1;
                        if (this._ttsFailStreak >= 3) {
                            this.ttsUnavailable = true;
                            this._ttsCooldownUntil = Date.now() + 30000;
                            console.warn('[TTS] 连续 ' + this._ttsFailStreak + ' 次失败，降级为字幕模式（30 秒后重试）');
                        } else {
                            console.warn('[TTS] 第 ' + this._ttsFailStreak + ' 次失败，仍重试');
                        }
                        this.appendFallbackText(segment);
                    }
                } catch (error) {
                    if (myToken !== this._procToken) return;   // 已换代：共享标志交给新线程
                    if (genSnapshot !== this.abortGeneration) {
                        this.isProcessing = false;
                        setTimeout(processNext, 50);
                        return;
                    }
                    console.error('TTS处理错误:', error);
                    // 单个片段失败不标记整体不可用，只回退当前片段
                    this.appendFallbackText(segment);
                }

                this.isProcessing = false;
            }

            // 已换代：不要把新线程的定时器清掉（_procTimer 是共享字段）
            if (myToken !== this._procToken) return;

            // 队列空 → 长轮询（200ms）省唤醒开销；有活 → 50ms 快速续跑。
            // 配合 _kickProc()：新文本一入库立刻把下一拍提前到 0ms（见 addStreamingText 尾部）。
            const idle = this.textSegmentQueue.length === 0 && !this.isProcessing;
            if (this._procTimer) clearTimeout(this._procTimer);
            this._procTimer = setTimeout(processNext, idle ? 200 : 50);
            if (this._procTimer.unref) this._procTimer.unref();
        };
        // 暴露给 _kickProc：新文本入库时直接踢醒，不等轮询
        this._procTick = processNext;

        processNext();
    }

    // 播放线程 - 顺序播放音频
    startPlaybackThread() {
        const myToken = this._bumpPlayToken();
        const playNext = async () => {
            if (this.shouldStop || myToken !== this._playToken) return;

            // 2026-11-21：每段结果独立兜底 —— playAudio 历史上有裸 return/裸 resolve()，
            // 裸读 result.completed 会在抢话或 0 字节 200 时抛 TypeError，playNext 整条
            // async 链 reject → 不再排下一拍 → 播放线程永久死（表现：抢话后再也不出声）。
            try {
                if (this.audioDataQueue.length > 0 && !this.playbackEngine.getPlayingState()) {
                    const audioPackage = this.audioDataQueue.shift();
                    const result = await this.playbackEngine.playAudio(audioPackage.audio, audioPackage.text);

                    // 检查是否全部完成（契约统一后 status 必为字符串；completed 仅作兼容字段）
                    if (result && result.completed === true && this.isAllComplete()) {
                        this.handleAllComplete();
                    }
                }
                else {
                    // 当"没音频（可能是TTS全失败了，或者还在处理中）"且"还有一个未完成的Promise"时，手动触发结束
                    // this.completionPromise 不为空说明当前正处于一个"未完结"的对话任务中
                    if (this.isAllComplete() && this.completionPromise) {
                        // 如果有回退文本还在打字中，等打字机跑完再结束
                        if (this._fallbackTimer) {
                            // 还在打字，不要急着结束
                        } else {
                            console.log('检测到队列为空但任务未结束（可能是TTS失败），强制结束');
                            this.handleAllComplete();
                        }
                    }
                }
            } catch (error) {
                // 失败必须发声：进 runtime.log + 静默审计台账，并继续排下一拍
                this._playThreadErrors = (this._playThreadErrors || 0) + 1;
                try { logToTerminal('warn', '[TTS] 播放段异常（已跳过，继续下一段）: ' + (error && error.message || error)); } catch (_) { }
                try { __silentAudit.audit('tts-processor.js:playNext', error); } catch (_) { }
            } finally {
                setTimeout(playNext, 50);
            }
        };

        playNext();
    }

    // 检查是否全部完成
    isAllComplete() {
        if (this.requestHandler.volcTtsEnabled) {
            // 流式路径：volcSession 存在时以它为准
            if (this.volcSession) return !this.volcSession.isPlaying();
            // 非流式路径（如 processTextToSpeech）：走普通队列判断
        }
        return this.audioDataQueue.length === 0 &&
               this.textSegmentQueue.length === 0 &&
               !this.isProcessing &&
               this.requestHandler.getPendingSegment().trim() === '';
    }

    // 回退模式：累积文本并启动打字机动画
    appendFallbackText(segmentText) {
        this.cancelSubtitleHide();
        // 2026-11-13：TTS 降级（静音/连续失败/冷却）时**表情也不会切** —— 表情推断挂在
        //   播放引擎上，没有音频就没有逐字播放，标记永远不被消费。实测：静音下发一条
        //   「哈哈笑死我」→ 对话与字幕都正常，但零表情日志。这里补一次「文本→表情」。
        //   注意只在无音频路径调用，TTS 正常时不会重复（否则一段话切两次会抖）。
        try {
            const mapper = this._emotionMapper;
            if (mapper && typeof mapper.applyTextEmotion === 'function') mapper.applyTextEmotion(segmentText);
        } catch (e) { try { __silentAudit.audit('tts-processor.js:fallbackEmotion', e); } catch (e2) {} }
        // 把新文本追加到待显示队列
        if (!this._fallbackQueue) this._fallbackQueue = [];
        this._fallbackQueue.push(...[...cleanDisplayText(segmentText)]);

        // 如果打字机已经在跑，新字符会自动被消费
        if (!this._fallbackTimer) {
            this.startFallbackTypewriter();
        }
    }

    // 打字机动画：从队列中逐字消费
    startFallbackTypewriter() {
        const label = this.config.subtitle_labels?.ai || '大肥鱼';
        const charInterval = 180; // 180ms一个字

        const typeNext = () => {
            if (this.shouldStop) {
                this.textMouth.stop();
                this._fallbackTimer = null;
                return;
            }

            if (this._fallbackQueue && this._fallbackQueue.length > 0) {
                const character = this._fallbackQueue.shift();
                this.fallbackDisplayText += character;
                this.textMouth.push(character);
                if (typeof showSubtitle === 'function') {
                    showSubtitle(`${label}: ${this.fallbackDisplayText}`);
                }
                eventBus.emit(Events.TTS_TEXT_PROGRESS, { position: this.fallbackDisplayText.length, text: this.fallbackDisplayText });
                this._fallbackTimer = setTimeout(typeNext, charInterval);
            } else {
                // 队列空了，停下来等新字符进来
                this._fallbackTimer = null;
                this.textMouth.stop();
                if (this.fallbackDisplayText && typeof showSubtitle === 'function') {
                    showSubtitle(`${label}: ${this.fallbackDisplayText}`, 3000);
                }
                eventBus.emit(Events.TTS_TEXT_COMPLETE, { text: this.fallbackDisplayText });
            }
        };

        this._fallbackTimer = setTimeout(typeNext, charInterval);
    }

    // 全部完成的处理
    cancelSubtitleHide() {
        if (this._subtitleHideTimer !== null) clearTimeout(this._subtitleHideTimer);
        this._subtitleHideTimer = null;
    }

    handleAllComplete() {
        this.textMouth.stop();
        this.cancelSubtitleHide();
        // 说完了：通知协调器（主动发起者据此择机，而不是盲等固定时长）
        try { require('../core/speech-coordinator.js').singleton.markSentenceEnd(); } catch (e) { /* 协调器不可用不影响收尾 */ }
        // 如果有回退字幕，停留3秒让用户看完
        const hideDelay = this.fallbackDisplayText ? 3000 : 1000;
        const generation = this.abortGeneration;
        this._subtitleHideTimer = setTimeout(() => {
            this._subtitleHideTimer = null;
            if (generation !== this.abortGeneration) return;

        if (typeof hideSubtitle === 'function') hideSubtitle();
            // 🔥 通过 playbackEngine 调用表情映射器
            if (this.playbackEngine.expressionMapper) {
                // this.playbackEngine.expressionMapper.triggerExpression("表情7");
                const defaultExpr = this.playbackEngine.expressionMapper.defaultExpression || "表情1";
                this.playbackEngine.expressionMapper.triggerExpression(defaultExpr);
            }
        }, hideDelay);

        if (this.playbackEngine.onEndCallback) {
            this.playbackEngine.onEndCallback();
        }

        eventBus.emit(Events.TTS_END);

        // 🔥 解决完成Promise
        if (this.completionResolve) {
            this.completionResolve();
            this.completionResolve = null;
            this.completionPromise = null;
        }
    }

    // 添加流式文本
    addStreamingText(text) {
        if (this.shouldStop) return;
        this.cancelSubtitleHide();
        if (!this._firstSegmentAt) this._firstSegmentAt = Date.now();
        this.llmFullResponse += text;

        // 静音：只走字幕打字机，不把 token 送进任何合成通道（volc/分段都一样）
        if (global.__ttsMuted) { this.appendFallbackText(text); return; }

        if (this.requestHandler.volcTtsEnabled) {
            // 字节流式路径：用 Promise 链保证 open → sendToken 严格串行
            if (!this.volcSession) {
                this.volcSession = new VolcengineStreamingSession(this.config, {
                    onMouthValue:     value => this.playbackEngine.onAudioDataCallback?.(value),
                    onStartCallback:  this._onStartCallback,
                    onEndCallback:    this._onEndCallback,
                    onComplete:       () => this.handleAllComplete(),
                    emotionMapper:    this._emotionMapper,
                    expressionMapper: this._expressionMapper,
                });
                // 链头：先建立连接
                this._volcChain = this.volcSession.open().catch((err) => {
                    console.error('字节TTS连接失败:', err);
                    this.volcSession = null;
                });
            }
            // 每个 token 都追加在链尾，保证顺序
            const session = this.volcSession;
            this._volcChain = this._volcChain.then(() => {
                if (session && !session.stopped) return session.sendToken(text);
            }).catch((err) => console.error('字节TTS sendToken失败:', err));
        } else {
            // 原有分段路径
            this.requestHandler.segmentStreamingText(text, this.textSegmentQueue);
            // ⚡ 入队即唤醒：把「最多白等 50ms」压到 0ms（#9）
            this._kickProc();
        }
    }

    // 完成流式文本
    finalizeStreamingText() {
        const chatMessages = document.getElementById('chat-messages');
        if (chatMessages) {
            const messageElement = document.createElement('div');
            const label = document.createElement('strong');
            label.textContent = '大肥鱼:';
            messageElement.append(label, document.createTextNode(` ${cleanDisplayText(this.llmFullResponse)}`));
            chatMessages.appendChild(messageElement);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        if (this.requestHandler.volcTtsEnabled) {
            const session = this.volcSession;
            this._volcChain = this._volcChain.then(() => {
                if (session && !session.stopped) return session.finalize();
            }).catch((err) => console.error('字节TTS finalize失败:', err));
        } else {
            this.requestHandler.finalizeSegmentation(this.textSegmentQueue);
        }
    }

    // 处理完整文本
    async processTextToSpeech(text) {
        if (!text.trim()) return;

        // 静音：整段走字幕，不合成（调用方拿到的 completion 直接 resolve）
        if (global.__ttsMuted) {
            this.reset();
            this.llmFullResponse = text;
            this.appendFallbackText(text);
            return;
        }

        this.reset();
        this.llmFullResponse = text;
        this.requestHandler.segmentFullText(text, this.textSegmentQueue);
        // ⚡ 入队即唤醒（#9）：整段直接合成时也别等下一拍轮询
        this._kickProc();

        // 🔥 创建完成Promise，返回给调用者等待
        this.completionPromise = new Promise(resolve => {
            this.completionResolve = resolve;
        });

        return this.completionPromise;
    }

    // 重置
    reset() {
        this.cancelSubtitleHide();
        this.textMouth.stop();
        this.llmFullResponse = '';
        this.fallbackDisplayText = '';
        this._fallbackQueue = [];
        // 首音延迟测量（2026-11-15 六十三轮）：TTS 本来就是「合成一段→播一段」并行跑的，
        // 但之前**没有任何首音耗时数据**。这里记两个点：本轮首个文本进来、首段音频入队。
        this._turnT0 = Date.now();
        this._firstSegmentAt = 0;
        this._firstAudioLogged = false;
        if (this._fallbackTimer) {
            clearTimeout(this._fallbackTimer);
            this._fallbackTimer = null;
        }
        this.textSegmentQueue = [];
        this.audioDataQueue = [];
        this.isProcessing = false;
        this.shouldStop = false;
        this.ttsUnavailable = false;
        this.abortGeneration++;

        // 字节流式session
        if (this.volcSession) {
            this.volcSession.stop();
            this.volcSession = null;
        }
        this._volcChain = Promise.resolve();

        // 🔥 取消之前的完成Promise
        if (this.completionResolve) {
            this.completionResolve();
            this.completionResolve = null;
            this.completionPromise = null;
        }

        this.playbackEngine.reset();
        this.requestHandler.reset();
    }

    // 打断
    // ⚠ 2026-11-22 根因修复：「她被打断」只在**真的在播**时记录。
    //   旧实现无条件写 __petInterruptedAt，而 PTT（按 V 说话）无论是否在播都会调本方法，
    //   于是普通提问也被当成「话没说完被截断」→ 下一轮注入「开头确认一下，比如"行，你说"」。
    //   现在交给 js/core/interrupt-event.js 统一判定（wasPlaying + 一次性消费 + 30s 过期）。
    interrupt(opts) {
        let wasPlaying = false;
        try { wasPlaying = this.isPlaying() === true; } catch (e) { wasPlaying = false; }
        // 打断耗时指标：从"被要求打断"到"真的没在播"经历了多久。
        // 这不是理论值，是每次真实打断都记一次，doctor 读最近 5 次的中位数。
        const _iT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

        this.cancelSubtitleHide();
        this.textMouth.stop();
        console.log('打断TTS播放...' + (wasPlaying ? '（当时在播：计入打断）' : '（当时没在播：只中止，不计入打断）'));

        // heard-response（2026-11-22）：**必须在这里算**——后面 resume-capture 之后紧接
        // playbackEngine.stop() / 清两个队列 / llmFullResponse = ''，任何一步之后再算
        // 都拿不到「还没播的剩余」了。只计算不改行为；null = 不知道，不截断历史。
        const fullForHeard = String(this.llmFullResponse || '');
        let heard = null;
        try {
            const cur = (this.playbackEngine && typeof this.playbackEngine.getUnplayedCurrentText === 'function')
                ? this.playbackEngine.getUnplayedCurrentText()
                : '';
            const queued = Array.isArray(this.textSegmentQueue) ? this.textSegmentQueue.slice() : [];
            // audioDataQueue 是「已合成、还没播」的段（播放顺序在 textSegmentQueue 之前）。
            // 漏掉它会让「当前段只剩一个标点」的剩余恰好成为全文后缀 → 误判几乎全播完。
            // 段对象形如 {audio, text}，computeHeardPrefix 会按 text 归一。
            const queuedAudio = Array.isArray(this.audioDataQueue) ? this.audioDataQueue.slice() : [];
            heard = require('../core/heard-text.js').computeHeardPrefix(fullForHeard, {
                unplayedCurrent: cur,
                queuedTexts: queuedAudio.concat(queued),
            });
        } catch (e) {
            heard = null;
            try { __silentAudit.audit('tts-processor.js:heard-prefix', e); } catch (e2) { /* ignore */ }
        }

        // 「她停在哪儿」只记**真播出去**的尾巴（2026-11-22）：inner-state 会拿这 16 字
        // 说「停在「…」」。用全文尾巴的话，那段恰恰大概率是没播出来的部分 —— 她会
        // 对着用户没听过的句子说「我刚说到…」。heard 未知（null）时才退回全文。
        try {
            const basis = typeof heard === 'string' ? heard : fullForHeard;
            require('../core/interrupt-event.js').record(globalThis, {
                now: Date.now(),
                text: String(basis || '').slice(-60),
                source: (opts && opts.reason) || 'unknown',
                wasPlaying,
            });
        } catch (e) { try { __silentAudit.audit('tts-processor.js:interrupt-record', e); } catch (e2) { /* ignore */ } }

        eventBus.emit(Events.TTS_INTERRUPTED);

        this.shouldStop = true;
        this.ttsUnavailable = false;
        this.abortGeneration++;

        // D4（2026-11-22）：先保存「还没播出去的剩余段」，再清队/停播 —— 顺序不能反，
        // 清完就没了。这不改打断行为：队列照旧清空、播放照旧立即停；只是把文本
        // 留给用户显式说「接着说」时重播（TTL 1 轮，绝不自动续讲）。
        try {
            const cur = (this.playbackEngine && typeof this.playbackEngine.getUnplayedCurrentText === 'function')
                ? this.playbackEngine.getUnplayedCurrentText()
                : null;
            resumeSpeech.captureFromProcessor({
                audioDataQueue: this.audioDataQueue,
                textSegmentQueue: this.textSegmentQueue,
                current: cur,
                reason: 'interrupt',
            });
        } catch (e) {
            try { __silentAudit.audit('tts-processor.js:resume-capture', e); } catch (e2) { /* ignore */ }
        }

        this.requestHandler.abortAllRequests();
        this.playbackEngine.stop();

        // 字节流式session
        if (this.volcSession) {
            this.volcSession.stop();
            this.volcSession = null;
        }

        this.textSegmentQueue = [];
        this.audioDataQueue = [];
        this._fallbackQueue = [];
        if (this._fallbackTimer) {
            clearTimeout(this._fallbackTimer);
            this._fallbackTimer = null;
        }
        this.llmFullResponse = '';
        this.isProcessing = false;

        if (typeof hideSubtitle === 'function') hideSubtitle();
        if (this.playbackEngine.onEndCallback) this.playbackEngine.onEndCallback();
        if (this.playbackEngine.expressionMapper) {
            const defaultExpr = this.playbackEngine.expressionMapper.defaultExpression || "表情1";
            this.playbackEngine.expressionMapper.triggerExpression(defaultExpr);
        }

        setTimeout(() => {
            this.shouldStop = false;
            // interrupt 后重起线程：必须换代，否则 300ms 前的旧循环（未被 shouldStop 拦住的
            // pending setTimeout 拍）会和新线程并存，抢同一队列。
            this.startProcessingThread();
            this.startPlaybackThread();
        }, 300);

        // heard-response：清完队列后把结果交给订阅方（末尾、且不影响上面任何行为）。
        // 只有「真的在播」且前缀可信才交付；监听方自己负责「heard 不短于 full 就不要改」。
        try {
            if (wasPlaying === true && typeof heard === 'string' && typeof _onInterrupted === 'function') {
                _onInterrupted({ heard, full: fullForHeard, reason: (opts && opts.reason) || 'unknown' });
            }
        } catch (e) { try { __silentAudit.audit('tts-processor.js:interrupt-listener', e); } catch (e2) { /* ignore */ } }
    }

    // 停止
    stop() {
        this.shouldStop = true;
        this.reset();
        if (typeof hideSubtitle === 'function') hideSubtitle();
        if (this.playbackEngine.onEndCallback) this.playbackEngine.onEndCallback();
    }

    // 判断是否正在播放
    isPlaying() {
        if (this.requestHandler.volcTtsEnabled) {
            if (this.volcSession) return this.volcSession.isPlaying();
            // 非流式路径走普通判断
        }
        return this.playbackEngine.getPlayingState() ||
               this.isProcessing ||
               this.textSegmentQueue.length > 0 ||
               this.audioDataQueue.length > 0;
    }
}

module.exports = { EnhancedTextProcessor, setInterruptListener };
