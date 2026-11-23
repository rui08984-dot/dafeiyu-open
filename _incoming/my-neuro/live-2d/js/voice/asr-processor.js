// ASR（自动语音识别）功能模块 - 支持语音打断
const __silentAudit = require('../core/silent-audit.js');
const { eventBus } = require('../core/event-bus.js');
const { Events } = require('../core/events.js');
const { appState } = require('../core/app-state.js');
const voiceIntent = require('../core/voice-intent.js');
const { logToTerminal } = require('../api-utils.js');

class ASRProcessor {
    constructor(vadUrl, asrUrl, config = null) {
        this.config = config || {};

        // 根据网关配置选择 VAD WebSocket URL
        const gatewayConfig = this.config.api_gateway || {};
        if (gatewayConfig.use_gateway) {
            // 使用网关模式：通过查询参数传递 API Key
            const wsBaseUrl = gatewayConfig.base_url.replace('http://', 'ws://').replace('https://', 'wss://');
            const apiKey = gatewayConfig.api_key || '';
            this.vadUrl = `${wsBaseUrl}/asr/vad/ws?X-API-Key=${encodeURIComponent(apiKey)}`;
        } else {
            // 使用本地模式
            this.vadUrl = vadUrl;
        }

        // ASR 上传 URL 会在 processRecording 中根据网关配置动态选择
        this.asrUrl = asrUrl;

        // 语音打断配置
        this.voiceBargeInEnabled = this.config.asr?.voice_barge_in || false;
        console.log(`语音打断功能: ${this.voiceBargeInEnabled ? '已启用' : '已禁用'}`);

        this.isProcessingAudio = false;
        this.asrLocked = false;

        // 音频相关参数
        this.audioContext = null;
        this.mediaStream = null;
        this.ws = null;
        this.SAMPLE_RATE = 16000;
        this.WINDOW_SIZE = 512;
        this.retryCount = 0;
        this.MAX_RETRIES = 5;   // 兼容旧字段；2026-11-21 起不再作为「放弃上限」
        // ── VAD 自愈（2026-11-21）───────────────────────────────────────────
        // 原实现 5 次 × 固定 1s 后永久放弃：ASR 服务晚起/中途重启 → 永远不会再录音，
        // 而 doctor 只探 :1000/health 仍显示绿。现在改为**永不放弃**的指数退避：
        // 1s → 2s → 4s → 8s → 16s → 30s（封顶），成功一次立刻清零。
        this.VAD_BACKOFF_BASE_MS = 1000;
        this.VAD_BACKOFF_CAP_MS = 30000;
        this.VAD_ALERT_AFTER = 10;       // 连续失败 10 次 → 写 runtime.log（只写一次/断线周期）
        this.vadReconnects = 0;          // doctor 可读：成功重连次数（首次连接不计）
        this.vadReconnectAttempts = 0;   // doctor 可读：累计重连尝试
        this.vadDownSince = null;        // doctor 可读：本段断开起始时刻；在线为 null
        this._vadRetryTimer = null;
        this._vadDownLogged = false;
        this._vadStopped = false;        // 主动 stopRecording 后不再自动重连
        this._vadEverOpened = false;
        this._vadDownEvents = 0;         // 「连续失败 ≥10 次」发生的次数（可观测）

        // ── 附和一致性（2026-11-21）─────────────────────────────────────────
        // 260ms 抢话判定的结果同时决定「是否打断」与「是否算一次用户输入」：
        // 短附和 → 不置 hasInterruptedThisSession，也不提交为用户轮（suppressed:true）。
        // 判定必须在 finishRecording 提交之前完成（见 _consumeSuppressedUtterance）。
        this._bargeCandidate = false;
        this._bargeCheckActive = false;
        this._suppressUtterance = false;
        this._vadSpeechEndedAt = null;     // 本次开口的 VAD 结束时刻（null = 还在说）
        this._speechSessionId = 0;         // 每次开口自增：防止上一句的 260ms 判定误伤下一句
        this._suppressedAffirmations = 0;   // 被抑制的短附和次数（可观测）
        this._affirmationRescued = 0;       // 260ms 像附和但实际说了整句 → 仍提交的次数

        // ── B5 backchannel 四态门（2026-11-23）───────────────────────────────
        // 默认**关闭**：config.voice.duplex.backchannel_gate 必须严格 === true 才启用。
        // 开启后：她在说话时用户只回一句「嗯/对/好」→ 不打断她，也不当成新一轮输入；
        // 「等等/停/别说了」和完整话语照旧立刻抢话；她在问问题时短确认升级为回答。
        // 真机听感还没验，所以默认关；关闭时下面每个分支都走原路径（逐字不变）。
        const duplexCfg = (() => {
            try {
                const v = this.config && this.config.voice;
                const d = v && v.duplex;
                return d && typeof d === 'object' ? d : null;
            } catch (e) {
                return null;                // 读配置失败一律当关闭
            }
        })();
        this._backchannelGate = duplexCfg ? duplexCfg.backchannel_gate === true : false;
        const _noiseTh = duplexCfg ? Number(duplexCfg.noise_confidence_threshold) : NaN;
        this._noiseConfidenceThreshold = Number.isFinite(_noiseTh) && _noiseTh > 0 && _noiseTh < 1
            ? _noiseTh
            : voiceIntent.DEFAULT_NOISE_CONFIDENCE;
        const _deferMs = duplexCfg ? Number(duplexCfg.barge_defer_timeout_ms) : NaN;
        this._bargeDeferTimeoutMs = Number.isFinite(_deferMs) && _deferMs >= 200 && _deferMs <= 8000
            ? Math.round(_deferMs)
            : 1500;
        this._deferredBarge = null;         // 已判定「真打断」但等文本再定：{sessionId, at}
        this._deferredBargeTimer = null;
        this._utteranceTtsPlaying = null;   // 本句开口那一刻她是否在播（文本判定时用）
        this._pttUtterance = false;         // PTT 是明确意图，永不过门
        this._stats = {                     // 只读统计，doctor/探针可看
            backchannelSkipped: 0,          // 被判 backchannel/noise 而没送进对话链的次数
            deferredInterrupts: 0,          // 推迟打断的次数
            deferredTimeouts: 0,            // 推迟后超时兜底、仍然打断的次数
            lastGateReason: '',             // 最近一次判定 kind:reason
        };
        if (this._backchannelGate) {
            console.log(`语音 backchannel 门: 已启用（置信度阈值 ${this._noiseConfidenceThreshold}，`
                + `打断推迟兜底 ${this._bargeDeferTimeoutMs}ms）`);
        }

        // 缓冲区设置
        this.audioBuffer = [];
        this.BUFFER_DURATION = 1000;
        this.BUFFER_SIZE = Math.floor(this.SAMPLE_RATE * (this.BUFFER_DURATION / 1000));

        // 录音相关
        this.isRecording = false;
        this.continuousBuffer = [];
        this.recordingStartIndex = 0;
        this.PRE_RECORD_TIME = 1;
        this.PRE_RECORD_SAMPLES = this.SAMPLE_RATE * this.PRE_RECORD_TIME;

        // 静音检测
        // 2026-11-20 全双工改造 1：服务端 VAD 已经等 250ms 才发 EOS（is_speech:false），
        // 客户端再等 500ms 属于双重计时。默认降到 150ms，可由 config.asr.client_silence_ms
        // 覆盖；配 500 即完全回退旧行为。
        this.lastSpeechTime = 0;
        const _clientSilence = Number(this.config.asr?.client_silence_ms ?? 150);
        this.SILENCE_THRESHOLD = Number.isFinite(_clientSilence) ? Math.max(0, _clientSilence) : 150;
        console.log(`客户端静音阈值: ${this.SILENCE_THRESHOLD}ms（服务端 VAD 另含 250ms）`);
        this.silenceTimeout = null;

        // 合并窗口续接回调（由 ASRController 设置）：VAD 再次开口时取消待提交
        this.onVadSpeechStart = null;

        // 新增：TTS处理器引用，用于语音打断
        this.ttsProcessor = null;

        // 新增：防止重复触发中断的标志
        this.hasInterruptedThisSession = false;

        // PTT（按住说话）模式
        this.pttModeEnabled = this.config.asr?.ptt_enabled || false;

        // 初始化
        this.setupAudioSystem();
    }

    // 设置TTS处理器引用（用于语音打断）
    setTTSProcessor(ttsProcessor) {
        this.ttsProcessor = ttsProcessor;
        console.log('TTS处理器已设置到ASR，语音打断功能可用');
    }

    async setupAudioSystem() {
        try {
            await this.setupWebSocket();
        } catch (error) {
            console.error('音频系统设置错误:', error);
        }
    }

    // 指数退避（纯函数，单测直接断言）：1s/2s/4s/8s/16s，之后封顶 30s。
    // consecutive = 已连续失败的次数（0 = 第一次重连尝试）。
    static vadBackoffMs(consecutive, base = 1000, cap = 30000) {
        const n = Math.max(0, Math.min(30, Math.floor(Number(consecutive) || 0)));
        const raw = (Number(base) || 1000) * Math.pow(2, n);
        return Math.min(Number(cap) || 30000, raw);
    }

    _publishVadStats() {
        const stats = {
            vadReconnects: this.vadReconnects,
            vadDownSince: this.vadDownSince,
            vadReconnectAttempts: this.vadReconnectAttempts,
            vadDownEvents: this._vadDownEvents,
            vadConnected: !!(this.ws && this.ws.readyState === WebSocket.OPEN),
        };
        // doctor / DevTools 可直接读：globalThis.__vadStats（与 window.__voiceLat 同风格）
        try { if (typeof globalThis !== 'undefined') globalThis.__vadStats = stats; } catch (e) { /* 观测失败不影响主链 */ }
        try { if (typeof window !== 'undefined') window.__vadStats = stats; } catch (e) { /* 同上 */ }
        return stats;
    }

    _clearVadRetry() {
        if (this._vadRetryTimer) {
            try { clearTimeout(this._vadRetryTimer); } catch (e) { /* 已触发 */ }
            this._vadRetryTimer = null;
        }
    }

    /**
     * 确保 VAD WebSocket 处于「正在连接 / 已连接」；否则立刻重建。
     * 供 startRecording 兜底：退避定时器可能因标签页节流/定时器丢失而不存在，
     * 不能只等 next tick —— 录音开始时必须是活的连接。
     * @returns {boolean} 是否新建了连接
     */
    _ensureVadSocket() {
        const rs = this.ws ? this.ws.readyState : -1;
        if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return false;
        this._vadStopped = false;
        this._clearVadRetry();
        this.setupWebSocket();
        return true;
    }

    _onVadClose() {
        if (this._vadStopped) return;
        if (this.vadDownSince == null) this.vadDownSince = Date.now();
        const attemptIndex = this.retryCount;
        this.retryCount += 1;
        this.vadReconnectAttempts += 1;

        const delay = ASRProcessor.vadBackoffMs(attemptIndex, this.VAD_BACKOFF_BASE_MS, this.VAD_BACKOFF_CAP_MS);
        // 连续失败 10 次：写 runtime.log（每段断线只写一次，避免刷屏），并保留计数。
        if (!this._vadDownLogged && this.retryCount >= this.VAD_ALERT_AFTER) {
            this._vadDownLogged = true;
            this._vadDownEvents += 1;
            const msg = `[asr] VAD 已连续重连 ${this.retryCount} 次仍失败（${this.vadUrl}，已断 ${Math.round((Date.now() - this.vadDownSince) / 1000)}s）——ASR 服务是否启动？继续按 ${delay}ms 退避，永不清零放弃`;
            try { logToTerminal('warn', msg); } catch (e) { /* 日志失败不影响重连 */ }
            try { console.warn(msg); } catch (e) { /* 同上 */ }
        } else {
            console.log(`VAD 断开，${delay}ms 后重连（连续失败 ${this.retryCount} 次，无上限）`);
        }

        this._clearVadRetry();
        const t = setTimeout(() => {
            this._vadRetryTimer = null;
            this.setupWebSocket();
        }, delay);
        if (t && typeof t.unref === 'function') t.unref();   // 纯 Node 单测不拖住进程
        this._vadRetryTimer = t;
        this._publishVadStats();
    }

    async setupWebSocket() {
        this._vadStopped = false;
        // 不要在「正在连接/已连接」时重建（否则多个 socket 抢同一麦克风流，
        // 旧 socket 的 onclose 还会误触发重连）。真正断开时由 _onVadClose 调度。
        if (this.ws) {
            const rs = this.ws.readyState;
            if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
        }

        const ws = (() => {
            try {
                return new WebSocket(this.vadUrl);
            } catch (err) {
                // URL 非法/构造失败：不能把异常抛到调用栈（setupAudioSystem 是 fire-and-forget），
                // 记一条并走同一条退避重连，别让「连不上」变成「进程里没人知道」。
                try { logToTerminal('error', `[asr] VAD WebSocket 构造失败（${this.vadUrl}）：${err && err.message || err}`); } catch (e) { }
                this._onVadClose();
                return null;
            }
        })();
        if (!ws) return;
        this.ws = ws;

        ws.onopen = async () => {
            if (this.ws !== ws) return;   // 已被更新的连接取代（旧 socket 的迟到事件）
            console.log('VAD WebSocket已连接');
            if (this.config.cloud?.siliconflow_asr?.enabled === true) {
                logToTerminal('info', '【SiliconFlow ASR】本地 VAD 已连接，等待说话');
            }
            const wasDown = this.vadDownSince != null || this.retryCount > 0;
            this.retryCount = 0;
            this.vadDownSince = null;
            this._vadDownLogged = false;
            // 「重连」= 断线/连续失败之后重新连上（首次连接不算），doctor 看它是否在增长。
            if (wasDown) this.vadReconnects += 1;
            this._vadEverOpened = true;
            if (wasDown) {
                const msg = '[asr] VAD 重连成功（累计 ' + this.vadReconnects + ' 次），退避计数已清零';
                try { logToTerminal('info', msg); } catch (e) { /* 不影响主链 */ }
                console.log(msg);
            }
            this._publishVadStats();
        };

        ws.onmessage = (event) => {
            if (this.ws !== ws) return;
            const data = JSON.parse(event.data);

            // speech_activity 心跳（2026-11-20 全双工）：服务端在 is_speech:true 期间
            // 每 200ms 补发一次，用来刷新「最后一帧人声」。以前 lastSpeechTime 只在
            // VAD start 时更新 = 记的是开口时刻，260ms 后的 gap<200ms 判据恒不成立，
            // 语音抢话路径从未真正触发。这里收到心跳就刷新，判据才有意义。
            if (data.speech_activity) {
                this.lastSpeechTime = Date.now();
                try {
                    if (typeof window !== 'undefined' && window.__voiceLat) {
                        window.__voiceLat.speechActivity = (window.__voiceLat.speechActivity || 0) + 1;
                    }
                } catch (e) { /* 观测计数失败不影响识别 */ }
            }

            const isSpeaking = data.is_speech;

            // 修改：根据语音打断配置决定是否在TTS播放时处理VAD
            if (!this.voiceBargeInEnabled) {
                // 传统模式：TTS播放时完全忽略VAD
                if (this.isProcessingAudio || this.asrLocked) return;
            }
            // 语音打断模式：不在这里检查asrLocked，让handleSpeech自己决定

            if (isSpeaking) {
                this.handleSpeech();
            } else {
                this.handleSilence();
            }
        };

        this.ws.onclose = () => {
            if (this.ws !== ws) return;   // 旧 socket 的迟到事件，忽略
            console.log('VAD WebSocket已断开');
            this._onVadClose();
        };

        this.ws.onerror = (error) => {
            if (this.ws !== ws) return;
            console.error('WebSocket错误:', error);
            if (this.config.cloud?.siliconflow_asr?.enabled === true) {
                logToTerminal('error', `【SiliconFlow ASR】无法连接本地 VAD：${this.vadUrl}，请先启动 ASR 服务`);
            }
        };
    }

    handleSpeech() {
        // PTT模式下VAD不做任何事，打断和录音全由按键控制
        if (this.pttModeEnabled) return;

        // 续说检测（2026-11-21）：VAD 已报过 is_speech:false，但之后麦克风又重新出现人声
        // → 这是「嗯…（停）…其实我是想说」的续说，不是附和。用客户端实测能量判断，
        // 不依赖服务端心跳（心跳在 VAD 挂起窗口里仍会发，会掩盖真正的停止）。
        if (this._vadSpeechEndedAt != null && (this._lastVoicedAt || 0) > this._vadSpeechEndedAt + 50) {
            this._vadSpeechEndedAt = null;
        }

        // 新一句：先分配 session id，260ms 判定据此只对本句生效（迟到的判定不跨句）
        if (!this.isRecording && !this.pttModeEnabled) this._speechSessionId += 1;

        // 改造 1 兜底：VAD 再次开口 → 通知 ASRController 取消/续接待提交的合并窗口。
        // 只通知，不在这里改合并状态（合并窗口归 ASRController 管）。
        try {
            if (this.onVadSpeechStart) this.onVadSpeechStart();
        } catch (e) { try { __silentAudit.audit('asr-processor.js:onVadSpeechStart', e); } catch (e2) {} }

        // 修改：根据语音打断配置处理人声检测
        if (!this.voiceBargeInEnabled) {
            // 传统模式：TTS播放时不处理
            if (this.isProcessingAudio || this.asrLocked) return;
        } else {
            // 语音打断模式：优先检查语音打断逻辑
            // 只要在处理用户输入期间（包括工具调用），就允许打断
            // 🔥 关键修复：只在第一次检测到语音时触发中断，避免重复触发
            if ((appState.isPlayingTTS() || appState.isProcessingUserInput()) &&
                this.ttsProcessor &&
                !this.hasInterruptedThisSession &&
                !this._bargeCheckActive) {
                // 区分「真打断」与「附和」：
                //   用户只「嗯」一声也会走到这里，把她的长句截断 —— 体验上是误伤。
                //   所以延迟 BARGAIN_DELAY 再停：真打断的人会说下去，附和的很快就没声了。
                //   （PTT 是按住说话，本身就是明确意图，不走这条，见 pttStartRecording）
                const BARGAIN_DELAY = 260;
                const bargeSession = this._speechSessionId;
                this._bargeCandidate = true;      // 仅候选：判定前绝不置 hasInterruptedThisSession
                this._bargeCheckActive = true;    // 同一次开口只判一次（服务端心跳每 200ms 会再进 handleSpeech）
                console.log('🎤 检测到用户语音，' + BARGAIN_DELAY + 'ms 后判定是否真打断/附和');
                // 可观测计数：证明抢话判定路径真的被走到（window.__voiceLat 由探针安装）
                try {
                    if (typeof window !== 'undefined' && window.__voiceLat) {
                        window.__voiceLat.bargeChecks = (window.__voiceLat.bargeChecks || 0) + 1;
                    }
                } catch (e) { /* 观测计数失败不影响判打断 */ }
                if (this._bargeTimer) clearTimeout(this._bargeTimer);
                this._bargeTimer = setTimeout(() => {
                    this._bargeTimer = null;
                    this._bargeCheckActive = false;
                    try {
                        // 迟到的判定不能跨句生效：这一句已经结束、下一句已经开口（session 变了），
                        // 此时再置 suppressed 会把下一句话误吞掉。
                        if (!this.isRecording || bargeSession !== this._speechSessionId) {
                            this._bargeCandidate = false;
                            return;
                        }
                        // 判断依据（2026-11-21 加固）：优先看 VAD 是否已经明确结束本次语音。
                        // 心跳 heartbeat 在 VAD 挂起窗口里仍可能继续发 200ms 一次，单靠
                        // gap<200ms 会把「嗯完就停」误判成还在说；is_speech:false 才是权威结束。
                        const speechEnded = this._vadSpeechEndedAt != null
                            && (this._lastVoicedAt || 0) <= this._vadSpeechEndedAt + 50;
                        const gap = Date.now() - (this.lastSpeechTime || 0);
                        const stillSpeaking = speechEnded ? false : (gap < 200);   // 200ms 内还有人声 = 还在说
                        if (!stillSpeaking) {
                            // ── 附和一致性（2026-11-21）──────────────────────
                            // 判定结果同时决定两件事：不打断 + **不作为用户轮提交**。
                            // 原来这里只 return，但 :216 已提前置 hasInterruptedThisSession，
                            // 且那声「嗯」照样走 finishRecording → ASR → 独立一轮，
                            // llm-handler 一见 TTS 在播就 interrupt —— 一声「嗯」既打断她
                            // 又多跑一轮 LLM。现在统一由 _suppressUtterance 在提交前拦掉。
                            this._bargeCandidate = false;
                            this._suppressUtterance = true;
                            this._suppressedAffirmations += 1;
                            const msg = '[asr] 短附和已抑制 suppressed:true（人声已停 ' + gap
                                + 'ms，不打断、不提交为用户轮；累计 ' + this._suppressedAffirmations + ' 次）';
                            console.log('🤐 ' + msg);
                            try { logToTerminal('info', msg); } catch (e) { /* 留痕失败不影响抑制 */ }
                            try {
                                if (typeof window !== 'undefined' && window.__voiceLat) {
                                    window.__voiceLat.suppressedAffirmations = this._suppressedAffirmations;
                                }
                            } catch (e) { /* 观测计数失败不影响抑制 */ }
                            return;
                        }
                        if (!appState.isPlayingTTS()) { this._bargeCandidate = false; return; }   // 已经自己说完了
                        // ── B5：文本四态门开启时，把「是否真的打断」推迟到 ASR 文本到达 ──
                        // 260ms 只有一个音频信号，分不清「嗯」和「等等」。开启后先不打断，
                        // 由 _gateRecognizedText 用文本判定；_bargeDeferTimeoutMs 兜底保证
                        // ASR 不出结果时仍然能打断（宁可让用户打断，不能让她一直说下去）。
                        // 关闭时这一支不存在，下面的旧路径逐字不变。
                        if (this._backchannelGate) {
                            this._deferBargeInterrupt(bargeSession);
                            this._bargeCandidate = false;
                            return;
                        }
                        console.log('🎤 判定为真打断，执行打断');
                        this.ttsProcessor.interrupt({ reason: 'barge-in' });
                        try {
                            if (typeof window !== 'undefined' && window.__voiceLat) {
                                window.__voiceLat.interrupts = (window.__voiceLat.interrupts || 0) + 1;
                                window.__voiceLat.lastInterruptAt = Date.now();
                            }
                        } catch (e) { /* 观测计数失败不影响打断 */ }
                        // 只有真打断才置标记（原实现在判定前就置，导致附和也被当成打断会话）
                        this.hasInterruptedThisSession = true;
                        this._bargeCandidate = false;
                    } catch (e) { try { __silentAudit.audit('asr-processor.js:173', e); } catch (e2) {} }
                }, BARGAIN_DELAY);

                // 🔥 关键修复：打断时重置 ASR 锁定状态，允许新的录音开始
                // 这样用户可以在工具调用期间打断并立即开始新的输入
                if (this.asrLocked) {
                    console.log('🔓 打断时解锁 ASR，允许新的语音输入');
                    this.asrLocked = false;
                }
            }

            // 语音打断后，如果ASR被锁定（正在处理之前的识别），则不开始新的录音
            if (this.asrLocked) return;
        }

        // 用户输入开始事件将由后续的ASR识别完成后发出，这里不需要提前发送

        this.lastSpeechTime = Date.now();

        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }

        if (!this.isRecording) {
            // PTT模式下不由VAD自动触发录音
            if (this.pttModeEnabled) return;

            this.isRecording = true;
            // 新一句开始：清掉上一次可能残留的「附和抑制」与上一句的结束标记
            this._suppressUtterance = false;
            this._vadSpeechEndedAt = null;
            // B5：本句是 VAD 触发的（不是 PTT），并记下开口那一刻她是否在播。
            // 只在门开启时才取（关闭时连这个 getter 都不调，行为逐字不变）。
            this._pttUtterance = false;
            if (this._backchannelGate) {
                try { this._utteranceTtsPlaying = appState.isPlayingTTS(); } catch (e) { this._utteranceTtsPlaying = null; }
            }
            this.recordingStartIndex = this.continuousBuffer.length;

            if (this.voiceBargeInEnabled && appState.isPlayingTTS()) {
                console.log('语音打断：开始录音');
            } else {
                console.log('正常模式：开始录音');
            }
        }
    }

    handleSilence() {
        // VAD 权威结束时刻：260ms 抢话判定用它区分「嗯完就停」与「还在说」。
        // 心跳在 VAD 挂起窗口内仍会刷新 lastSpeechTime，不能单独作为结束依据。
        this._vadSpeechEndedAt = Date.now();
        if (this.pttModeEnabled) return;

        // 修改：根据语音打断配置处理静音
        if (!this.voiceBargeInEnabled) {
            // 传统模式：TTS播放时不处理
            if (this.isProcessingAudio || this.asrLocked) return;
        } else {
            // 语音打断模式：只在用户输入处理中时不处理
            if (this.asrLocked) return;
        }

        // PTT模式下不由静音自动结束录音
        if (this.isRecording && !this.pttModeEnabled) {
            // 审计 P2 #25：用「最后一帧人声（speech_activity 会刷新 lastSpeechTime）」起算，
            // 而不是「收到第一个 is_speech:false 后固定等阈值」。服务端消息语义以后变了也不会提前切句。
            const elapsed = Date.now() - (Number(this.lastSpeechTime) || 0);
            const wait = Math.max(50, this.SILENCE_THRESHOLD - elapsed);
            if (!this.silenceTimeout) {
                this.silenceTimeout = setTimeout(() => {
                    this.finishRecording();
                    this.silenceTimeout = null;
                }, wait);
            }
        }
        // 注意：状态管理已通过事件系统自动处理，无需手动设置
    }

    /** 列出候选输入设备（去掉 communications 重复项） */
    async _candidateInputs() {
        try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            return devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
                .slice(0, 6)
                .map((d) => ({ id: d.deviceId, label: d.label || '' }));
        } catch (e) { return []; }
    }

    /** 量一个流 400ms 的峰值 rms */
    async _measureStream(stream) {
        let ctx = null;
        try {
            ctx = new AudioContext();
            const src = ctx.createMediaStreamSource(stream);
            const an = ctx.createAnalyser(); an.fftSize = 512;
            src.connect(an);
            const buf = new Float32Array(an.fftSize);
            let peak = 0;
            for (let i = 0; i < 6; i++) {
                await new Promise((r) => setTimeout(r, 65));
                an.getFloatTimeDomainData(buf);
                let s = 0; for (let k = 0; k < buf.length; k++) s += buf[k] * buf[k];
                const rms = Math.sqrt(s / buf.length);
                if (rms > peak) peak = rms;
            }
            return peak;
        } catch (e) { return 0; }
        finally { try { ctx && ctx.close(); } catch (e) { try { __silentAudit.audit('asr-processor.js:269', e); } catch (e2) {} } }
    }

    /** 按 deviceId 查它的 label（用于校验拿到的流是不是我们要的设备） */
    async _labelOf(deviceId) {
        if (!deviceId) return '';
        try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            const hit = devs.find((d) => d.deviceId === deviceId);
            return hit ? String(hit.label || '') : '';
        } catch (e) { return ''; }
    }

    /**
     * 探测哪个麦克风真的能收到声音。
     * 背景：这台机器默认设备（INZONE 耳机麦）采到的是全 0，用户按 V 说话永远识别不出来。
     * 逐个试 400ms，挑 rms 最大的那个；全都没声音就返回 null（用系统默认）。
     */
    async pickAudibleInput() {
        if (this._audibleInputId !== undefined) return this._audibleInputId;
        this._audibleInputId = null;
        try {
            const devs = await navigator.mediaDevices.enumerateDevices();
            const inputs = devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
            let best = null, bestRms = 0.001;   // 阈值：低于 0.001 视作静音
            for (const d of inputs.slice(0, 5)) {
                try {
                    const st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: d.deviceId } } });
                    const ctx = new AudioContext();
                    const src = ctx.createMediaStreamSource(st);
                    const an = ctx.createAnalyser(); an.fftSize = 512;
                    src.connect(an);
                    const buf = new Float32Array(an.fftSize);
                    let peak = 0;
                    for (let i = 0; i < 6; i++) {
                        await new Promise((r) => setTimeout(r, 65));
                        an.getFloatTimeDomainData(buf);
                        let s = 0; for (let k = 0; k < buf.length; k++) s += buf[k] * buf[k];
                        const rms = Math.sqrt(s / buf.length);
                        if (rms > peak) peak = rms;
                    }
                    st.getTracks().forEach((t) => t.stop());
                    try { ctx.close(); } catch (e) { try { __silentAudit.audit('asr-processor.js:311', e); } catch (e2) {} }
                    if (peak > bestRms) { bestRms = peak; best = d.deviceId; }
                } catch (e) { try { __silentAudit.audit('asr-processor.js:313', e); } catch (e2) {} }
            }
            this._audibleInputId = best;
            if (best) console.log('[麦克风] 探测到可用设备，rms=' + bestRms.toFixed(4));
            else console.log('[麦克风] 所有设备都没声音（未接麦/被静音）');
        } catch (e) { this._audibleInputId = null; }
        return this._audibleInputId;
    }

    async startRecording() {
        // 缺陷 1 兜底（2026-11-21）：开始录音时 VAD 必须是活的。
        // 原实现只查 readyState 决定「发不发音频」，WS 死了就永远不发 → 不录音；
        // 而重连 5 次到顶后也再没人重建。这里在录音入口强制自愈，不等退避定时器。
        try { this._ensureVadSocket(); } catch (e) {
            try { logToTerminal('warn', '[asr] 录音前重建 VAD 失败（继续按退避重连）：' + ((e && e.message) || e)); } catch (_) { }
        }
        try {
            // 麦克风选择：默认设备经常是"耳机麦但耳机没接/静音"，
            // 实测这台机器默认采到的是 rms=0.00001（全静音），而内置阵列麦是 0.02。
            // 所以：① 支持配置指定设备；② 没指定时先探测，选真的能出声的那个。
            const micDeviceId = (this.config?.asr?.mic_device_id) || '';
            let audioConstraints = {
                channelCount: 1,
                sampleRate: this.SAMPLE_RATE,
                echoCancellation: true,
                noiseSuppression: true,
            };
            if (micDeviceId) {
                audioConstraints.deviceId = { exact: micDeviceId };
            } else {
                try {
                    const picked = await this.pickAudibleInput();
                    if (picked) {
                        audioConstraints.deviceId = { exact: picked };
                        console.log('[麦克风] 自动选中可出声设备:', picked.slice(0, 16));
                    }
                } catch (e) { try { __silentAudit.audit('asr-processor.js:343', e); } catch (e2) {} }
            }
            // Electron 踩坑记录（真机上验证过）：
            //   ① getUserMedia 传 {deviceId:{exact:id}} 在本环境会抛 OverconstrainedError；
            //   ② 不传 deviceId 时它挑的"默认设备"经常是虚拟麦/Oculus 麦，采到全 0；
            //   ③ 同一个 enumerateDevices() 在探测脚本和主链路里拿到的"默认"还可能不一样。
            // 所以最终策略：**按实际采音能量选设备** —— 挨个打开、量 400ms、挑最响的。
            // 这一步只在启动时做一次（结果缓存），代价约 0.5~1.5 秒。
            const candidates = await this._candidateInputs();   // [{id, label}]
            let chosen = null, chosenRms = 0;
            for (const cand of candidates) {
                try {
                    const st = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: cand.id }, channelCount: 1, echoCancellation: true, noiseSuppression: true } });
                    const rms = await this._measureStream(st);
                    if (rms > chosenRms) {
                        if (chosen) { try { this.mediaStream && this.mediaStream.getTracks().forEach((x) => x.stop()); } catch (e) { try { __silentAudit.audit('asr-processor.js:358', e); } catch (e2) {} } }
                        chosenRms = rms;
                        chosen = cand;
                        this.mediaStream = st;
                    } else {
                        try { st.getTracks().forEach((x) => x.stop()); } catch (e) { try { __silentAudit.audit('asr-processor.js:363', e); } catch (e2) {} }
                    }
                    if (chosenRms > 0.006) break;   // 够响了，不用再试
                } catch (e) { try { __silentAudit.audit('asr-processor.js:366', e); } catch (e2) {} }
            }
            if (!this.mediaStream) {
                // 所有候选都失败 → 退回系统默认（至少别完全跑不起来）
                console.warn('[麦克风] 所有候选设备都不可用，退回默认设备');
                this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
            } else {
                // chosen 可能为 null（所有候选都不可用、退回默认设备）——
                // 原实现裸读 chosen.label 会抛 TypeError，把 startRecording 后半段直接打断。
                console.log('[麦克风] 选中「' + String((chosen && chosen.label) || '默认设备').slice(0, 30) + '」 rms=' + chosenRms.toFixed(4));
            }

            this.audioContext = new AudioContext({ sampleRate: this.SAMPLE_RATE });
            const microphone = this.audioContext.createMediaStreamSource(this.mediaStream);
            const scriptNode = this.audioContext.createScriptProcessor(this.WINDOW_SIZE, 1, 1);

            microphone.connect(scriptNode);
            scriptNode.connect(this.audioContext.destination);

            let lastSendTime = 0;
            const MIN_SEND_INTERVAL = 1;

            scriptNode.onaudioprocess = (e) => {
                // 修改：根据语音打断配置决定音频处理逻辑
                if (!this.voiceBargeInEnabled) {
                    // 传统模式：TTS播放时跳过音频处理
                    if (this.isProcessingAudio || this.asrLocked) return;
                }
                // 语音打断模式：不检查asrLocked,始终处理音频发送到VAD
                // asrLocked只用于防止新的录音识别,不影响VAD检测

                const currentTime = Date.now();
                const audioData = e.inputBuffer.getChannelData(0);

                this.continuousBuffer.push(...Array.from(audioData));
                // 客户端实测「最后一帧真人声」：260ms 附和判定在 VAD 结束事件到达前
                // 也能知道麦克风是否又响了（服务端心跳可能还在挂起窗口里继续发）。
                {
                    let _pk = 0;
                    for (let i = 0; i < audioData.length; i++) {
                        const a = audioData[i] < 0 ? -audioData[i] : audioData[i];
                        if (a > _pk) _pk = a;
                    }
                    if (_pk > 0.01) this._lastVoicedAt = currentTime;
                }

                if (this.continuousBuffer.length > this.SAMPLE_RATE * 30) {
                    const excessSamples = this.continuousBuffer.length - this.SAMPLE_RATE * 30;
                    this.continuousBuffer = this.continuousBuffer.slice(excessSamples);
                    if (this.isRecording) {
                        this.recordingStartIndex = Math.max(0, this.recordingStartIndex - excessSamples);
                    }
                }

                if (this.ws && this.ws.readyState === WebSocket.OPEN &&
                    currentTime - lastSendTime >= MIN_SEND_INTERVAL) {
                    this.ws.send(audioData);
                    lastSendTime = currentTime;
                }
            };

            console.log('音频处理已启动');
        } catch (err) {
            console.error('启动音频错误:', err);
        }
    }

    stopRecording() {
        // 主动停止 = 用户/宿主不要语音了：不再自动重连（否则 stop 之后还会自己连回来）
        this._vadStopped = true;
        this._clearVadRetry();
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
        }
        if (this.ws) {
            this.ws.close();
        }
        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }
        if (this._bargeTimer) {
            clearTimeout(this._bargeTimer);
            this._bargeTimer = null;
        }
        this._bargeCheckActive = false;
        this._suppressUtterance = false;   // 停止后不把「附和抑制」带到下一次录音
        this._clearDeferredBarge();        // B5：也别把「待定打断」带到下一次
    }

    // ══ B5 backchannel 四态门（2026-11-23，默认关闭）══════════════════════════
    // 只在 config.voice.duplex.backchannel_gate === true 时生效。关闭时下列方法不产生副作用。

    /**
     * 推迟「是否打断」到文本到达。只置状态 + 兜底定时器，不动 TTS。
     * @param {number} sessionId 本句的 speech session（诊断用）
     */
    _deferBargeInterrupt(sessionId) {
        // 同一句里服务端心跳每 200ms 会再进 handleSpeech；已经待定就别重置兜底计时，
        // 否则用户一直说下去会无限推迟（也让计数虚高）。
        if (this._deferredBarge && this._deferredBarge.sessionId === sessionId) return;
        this._clearDeferredBarge();
        this._deferredBarge = { sessionId, at: Date.now() };
        this._stats.deferredInterrupts += 1;
        const msg = '[asr] backchannel 门：暂不打断，等 ASR 文本判定（'
            + this._bargeDeferTimeoutMs + 'ms 兜底）';
        console.log(msg);
        try { logToTerminal('info', msg); } catch (e) { /* 留痕失败不影响判定 */ }
        this._deferredBargeTimer = setTimeout(() => {
            this._deferredBargeTimer = null;
            if (!this._deferredBarge) return;           // 文本已先到并处理过
            this._deferredBarge = null;
            this._stats.deferredTimeouts += 1;
            // 兜底：ASR 迟迟不出结果 / 文本被判成 noise → 仍然打断（保守方向）。
            try {
                if (this.ttsProcessor && appState.isPlayingTTS()) {
                    this.ttsProcessor.interrupt({ reason: 'barge-in' });
                    this.hasInterruptedThisSession = true;
                    const m = '[asr] backchannel 门：文本未及时到达，兜底打断（累计 '
                        + this._stats.deferredTimeouts + ' 次）';
                    console.log(m);
                    try { logToTerminal('warn', m); } catch (e) { /* 留痕失败不影响打断 */ }
                }
            } catch (e) {
                try { __silentAudit.audit('asr-processor.js:deferred-barge-timeout', e); } catch (e2) { /* ignore */ }
            }
        }, this._bargeDeferTimeoutMs);
        try { if (this._deferredBargeTimer && typeof this._deferredBargeTimer.unref === 'function') this._deferredBargeTimer.unref(); } catch (e) { /* 浏览器端无 unref */ }
    }

    /** 清掉待定打断（文本已到 / 停止录音 / 新一轮开口）。 */
    _clearDeferredBarge() {
        if (this._deferredBargeTimer) {
            clearTimeout(this._deferredBargeTimer);
            this._deferredBargeTimer = null;
        }
        this._deferredBarge = null;
    }

    /** 她当前这句话是不是在问问题（只读 tts-processor 的文本，不改播放/队列）。 */
    _ttsQuestioningNow() {
        try {
            const t = this.ttsProcessor;
            if (!t) return false;
            const txt = String(t.llmFullResponse || t.fallbackDisplayText || '');
            return voiceIntent.looksLikeQuestioning(txt);
        } catch (e) {
            return false;                                // 读不到就当没在问（不升级）
        }
    }

    /**
     * 文本四态门：**送进对话链之前**决定「要不要打断 / 要不要回应」。
     * 只有开关打开才会真正判定；关闭时直接放行（逐字旧行为）。
     * @param {string} text ASR 最终文本
     * @param {number} [durationMs] 本段语音时长（可选，仅作保守护栏）
     * @returns {boolean} true = 照常提交；false = 吞掉（不打断、不提交、只计数）
     */
    _gateRecognizedText(text, durationMs) {
        if (!this._backchannelGate) return true;         // 开关关闭：零行为变化
        if (this._pttUtterance) {                        // PTT 是明确意图，永不过门
            this._clearDeferredBarge();
            return true;
        }
        const deferred = this._deferredBarge != null;
        this._clearDeferredBarge();                      // 文本到了，兜底定时器不再需要
        try {
            const playing = appState.isPlayingTTS();
            const verdict = voiceIntent.classifyVoiceUtterance({
                text,
                isFinal: true,
                ttsPlaying: playing || this._utteranceTtsPlaying === true,
                ttsQuestioning: this._ttsQuestioningNow(),
                durationMs,
            }, { noiseConfidenceThreshold: this._noiseConfidenceThreshold });
            this._stats.lastGateReason = verdict.kind + ':' + verdict.reason;

            if (verdict.shouldInterrupt && playing && this.ttsProcessor) {
                // 真抢话：这一刻才停她（延迟 = 本句 ASR 耗时，已知代价，见看板风险项）
                console.log('🎤 backchannel 门判定真打断（' + verdict.kind + '），执行打断');
                this.ttsProcessor.interrupt({ reason: 'barge-in' });
                this.hasInterruptedThisSession = true;
                try {
                    if (typeof window !== 'undefined' && window.__voiceLat) {
                        window.__voiceLat.interrupts = (window.__voiceLat.interrupts || 0) + 1;
                        window.__voiceLat.lastInterruptAt = Date.now();
                    }
                } catch (e) { /* 观测计数失败不影响打断 */ }
            }

            if (!verdict.shouldRespond) {
                this._stats.backchannelSkipped += 1;
                const msg = '[asr] backchannel 门：' + verdict.kind + '/' + verdict.reason
                    + ' → 不打断、不提交（累计 ' + this._stats.backchannelSkipped + '）：「'
                    + String(text == null ? '' : text).slice(0, 12) + '」'
                    + (deferred ? '（本次曾是待定打断）' : '');
                console.log(msg);
                try { logToTerminal('info', msg); } catch (e) { /* 留痕失败不影响抑制 */ }
                try {
                    if (typeof window !== 'undefined' && window.__voiceLat) {
                        window.__voiceLat.backchannelSkipped = this._stats.backchannelSkipped;
                    }
                } catch (e) { /* 观测计数失败不影响抑制 */ }
                return false;
            }
            return true;
        } catch (e) {
            try { __silentAudit.audit('asr-processor.js:voice-intent-gate', e); } catch (e2) { /* ignore */ }
            return true;                                 // 判定异常：放行，绝不吞用户的话
        }
    }

    /**
     * 提交前的「短附和」裁决（缺陷 2 的统一判定点）。
     * 260ms 抢话判定判为附和时置 _suppressUtterance；这里在**送 ASR 之前**消费它，
     * 并加一道时长护栏：如果实际说了 ≥ affirmation_max_ms（默认 1200ms），
     * 说明 260ms 那一刻只是换气，是完整一句 → 撤销抑制、照常提交（防吞真短句）。
     * @returns {boolean} true = 应抑制，本次不提交
     */
    _consumeSuppressedUtterance() {
        if (!this._suppressUtterance) return false;
        this._suppressUtterance = false;
        const end = (this.continuousBuffer && this.continuousBuffer.length) || 0;
        const speechSamples = Math.max(0, end - (this.recordingStartIndex || 0));
        const speechMs = (speechSamples / this.SAMPLE_RATE) * 1000;
        const configured = Number(this.config?.asr?.affirmation_max_ms);
        const limitMs = Number.isFinite(configured) && configured > 0 ? configured : 1200;
        // 续说护栏：VAD 虽报过结束，但之后麦克风又实测到人声 → 不是「嗯完就停」，照常提交。
        const resumed = this._vadSpeechEndedAt != null
            && (this._lastVoicedAt || 0) > this._vadSpeechEndedAt + 50;
        if (resumed) {
            this._affirmationRescued += 1;
            const msg = '[asr] 260ms 判定像附和，但随后又说了（实测人声）→ 按正常输入提交（累计救回 '
                + this._affirmationRescued + ' 次）';
            console.log(msg);
            try { logToTerminal('info', msg); } catch (e) { /* 留痕失败不影响提交 */ }
            return false;
        }
        if (speechMs > limitMs) {
            this._affirmationRescued += 1;
            const msg = '[asr] 260ms 判定像附和，但实际说了 ' + Math.round(speechMs)
                + 'ms（>' + limitMs + 'ms）→ 按正常输入提交（累计救回 ' + this._affirmationRescued + ' 次）';
            console.log(msg);
            try { logToTerminal('info', msg); } catch (e) { /* 留痕失败不影响提交 */ }
            return false;
        }
        try {
            logToTerminal('info', '[asr] 短附和已抑制 suppressed:true（时长 ' + Math.round(speechMs) + 'ms，不提交为用户轮）');
        } catch (e) { /* 留痕失败不影响抑制 */ }
        return true;
    }

    async finishRecording() {
        // 检查ASR是否锁定，如果锁定则不处理录音
        if (!this.isRecording || this.asrLocked) {
            // 锁定期间的录音本来就不会提交；顺手清掉附和标记，避免泄漏到下一句
            if (this.asrLocked) this._suppressUtterance = false;
            return;
        }
        this.isRecording = false;

        // ── 缺陷 2：附和在提交前拦掉（判定发生在 processRecording 之前）─────
        // 抑制的「嗯」不送 ASR、不产生用户轮，也不置 hasInterruptedThisSession。
        if (this._consumeSuppressedUtterance()) {
            this.asrLocked = false;
            this.continuousBuffer = this.continuousBuffer.slice(-this.PRE_RECORD_SAMPLES);
            console.log('ASR：短附和已抑制，不提交为用户轮（suppressed:true）');
            return;
        }

        // 在开始处理录音时立即锁定ASR，防止二次接收
        this.asrLocked = true;
        console.log('ASR锁定：开始处理录音');

        // 🔥 重置中断标志，允许下次语音检测时再次触发中断
        this.hasInterruptedThisSession = false;

        const recordingEndIndex = this.continuousBuffer.length;
        // PTT 由按键精确划定录音起点，不应混入按下 V 之前的 1 秒环境音。
        const actualStartIndex = this.pttModeEnabled
            ? this.recordingStartIndex
            : Math.max(0, this.recordingStartIndex - this.PRE_RECORD_SAMPLES);
        const recordedSamples = this.continuousBuffer.slice(actualStartIndex, recordingEndIndex);

        // 静音检测：录到全零说明麦克风没在工作（选错设备/被静音/没插）。
        // 之前的表现是"识别出韩文单个字"或"识别失败:未知错误"，
        // 用户完全不知道是麦的问题 —— 这里必须明确说出来。
        try {
            let _sum = 0, _peak = 0;
            for (let i = 0; i < recordedSamples.length; i++) { const v = recordedSamples[i]; _sum += v * v; const a = v < 0 ? -v : v; if (a > _peak) _peak = a; }
            const _rms = Math.sqrt(_sum / Math.max(1, recordedSamples.length));
            this._lastRecordRms = _rms;
            if (_rms < 0.0005) {
                console.warn('[麦克风] 这段录音几乎是静音（rms=' + _rms.toFixed(6) + '）——检查是否选错麦克风或被系统静音');
                try { global.showSubtitle && global.showSubtitle('（麦克风没声音，检查一下设备？）', 2600); } catch (e) { try { __silentAudit.audit('asr-processor.js:463', e); } catch (e2) {} }
            }
        } catch (e) { try { __silentAudit.audit('asr-processor.js:465', e); } catch (e2) {} }

        if (recordedSamples.length > this.SAMPLE_RATE * 0.5) {
            const wavBlob = this.float32ToWav(new Float32Array(recordedSamples));

            // 语音打断模式下的特殊提示
            if (this.voiceBargeInEnabled && !appState.isPlayingTTS()) {
                console.log('语音打断：录音完成，正在识别...');
            }

            await this.processRecording(wavBlob);
        } else {
            console.log("录音太短，丢弃");
            // 即使丢弃录音也解锁ASR
            this.asrLocked = false;
            // 状态管理已通过事件系统自动处理
        }

        this.continuousBuffer = this.continuousBuffer.slice(-this.PRE_RECORD_SAMPLES);
        this._pttUtterance = false;        // B5：本句已提交/丢弃，下一句重新判定归属
    }

    float32ToWav(samples) {
        const buffer = new ArrayBuffer(44 + samples.length * 2);
        const view = new DataView(buffer);

        this.writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + samples.length * 2, true);
        this.writeString(view, 8, 'WAVE');
        this.writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, this.SAMPLE_RATE, true);
        view.setUint32(28, this.SAMPLE_RATE * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        this.writeString(view, 36, 'data');
        view.setUint32(40, samples.length * 2, true);

        this.floatTo16BitPCM(view, 44, samples);

        return new Blob([buffer], { type: 'audio/wav' });
    }

    writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    floatTo16BitPCM(view, offset, input) {
        for (let i = 0; i < input.length; i++, offset += 2) {
            const s = Math.max(-1, Math.min(1, input[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
    }

    async processRecording(audioBlob) {
        const siliconflowConfig = this.config.cloud?.siliconflow_asr || {};
        if (siliconflowConfig.enabled === true) {
            return this.processSiliconFlowRecording(audioBlob);
        }

        const formData = new FormData();
        formData.append('file', audioBlob, 'recording.wav');

        // 判断使用哪种模式
        const gatewayConfig = this.config.api_gateway || {};
        const useGateway = gatewayConfig.use_gateway === true;
        let asrUrl;
        let mode = '本地';

        if (useGateway) {
            // 统一网关模式
            asrUrl = `${gatewayConfig.base_url}/asr/upload_audio`;
            mode = '网关';
        } else {
            // 本地ASR
            asrUrl = this.asrUrl;
        }

        // ASR 超时（2026-11-20 审计 P1）：服务端接受连接却迟迟不回时，原来的 fetch
        // 永不结束 → asrLocked 永久 true，所有语音被吞、flush 每 200ms 空转，只能重启。
        // 这里给显式超时（默认 8s，config.asr.timeout_ms 可调），失败/超时必定解锁并发声。
        const asrTimeoutMs = (() => {
            const n = Number(this.config?.asr?.timeout_ms);
            return Number.isFinite(n) && n >= 2000 ? Math.min(Math.round(n), 60000) : 8000;
        })();
        const ac = typeof AbortController === 'function' ? new AbortController() : null;
        const acTimer = ac ? setTimeout(() => { try { ac.abort(); } catch (e) { /* 已结束 */ } }, asrTimeoutMs) : null;
        try {
            const headers = {};

            // 统一网关模式：添加 X-API-Key
            if (useGateway && gatewayConfig.api_key) {
                headers['X-API-Key'] = gatewayConfig.api_key;
            }

            console.log(`使用${mode}ASR: ${asrUrl}`);

            const response = await fetch(asrUrl, {
                method: 'POST',
                headers: headers,
                body: formData,
                signal: ac ? ac.signal : undefined,
            });

            // 检查响应状态
            if (!response.ok) {
                await this.handleASRError(response, mode);
                this.asrLocked = false;
                return null;
            }

            const result = await response.json();

            // 兼容云端和本地API响应格式
            // SiliconFlow: {text: "识别结果"}
            // 本地: {status: "success", text: "识别结果"}
            const recognizedText = result.text || (result.status === 'success' && result.text);

            if (recognizedText) {
                console.log("用户说:", recognizedText);

                // 语音打断模式下的特殊提示
                if (this.voiceBargeInEnabled) {
                    console.log('语音打断：识别完成，发送给AI处理');
                }

                // B5：四态门（开关关闭时 _gateRecognizedText 直接返回 true）
                const _durMs = (() => {
                    try {
                        const bytes = Number(audioBlob && audioBlob.size) - 44;   // WAV 头 44 字节
                        if (!(bytes > 0)) return undefined;
                        const totalMs = (bytes / 2 / this.SAMPLE_RATE) * 1000;
                        // VAD 路径的录音含 1s 预录（finishRecording 从 recordingStartIndex-预录 起切），
                        // 减掉它才是「这句话实际说了多久」；PTT 是精确起止，不减。
                        const prerollMs = this._pttUtterance ? 0 : (this.PRE_RECORD_SAMPLES / this.SAMPLE_RATE) * 1000;
                        return Math.round(Math.max(0, totalMs - prerollMs));
                    } catch (e) { return undefined; }
                })();
                if (!this._gateRecognizedText(recognizedText, _durMs)) {
                    // 被吞的附和/噪音：不提交为用户轮，但麦克风必须解锁（否则永久静音）
                    try { this.resumeRecording(); } catch (e) { /* 解锁失败不更糟 */ }
                    return null;
                }

                // 回调函数，由外部实现
                if (this.onSpeechRecognized) {
                    this.onSpeechRecognized(recognizedText);
                }

                return recognizedText;
            } else {
                const errorMsg = result.message || result.error || '未知错误';
                logToTerminal('error', `【${mode}ASR】识别失败: ${errorMsg}`);
                console.error('ASR失败:', errorMsg);
                // 如果ASR失败，也要解锁ASR以便用户重试
                this.asrLocked = false;
                // 状态管理已通过事件系统自动处理
                return null;
            }
        } catch (error) {
            const aborted = !!(error && (error.name === 'AbortError' || /abort/i.test(String(error.message || ''))));
            if (aborted) {
                // 不许静默：超时必须留下一条能 grep 的日志，并明确「已解锁、可重试」。
                logToTerminal('error', `【${mode}ASR】fetch timeout（${asrTimeoutMs}ms）：已解锁，可重试`);
                console.error('[asr] fetch timeout', asrTimeoutMs + 'ms');
                try { global.showSubtitle && global.showSubtitle('（语音识别超时，再说一次？）', 2400); } catch (e) { /* 字幕失败不影响解锁 */ }
            } else {
                logToTerminal('error', `【${mode}ASR】处理录音失败: ${error.message}`);
                console.error('处理录音失败:', error);
            }
            // 释放录音状态 + 解锁：否则一次 ASR 假死会让语音输入永久失效。
            this.isRecording = false;
            this.asrLocked = false;
            // 状态管理已通过事件系统自动处理
            return null;
        } finally {
            if (acTimer) clearTimeout(acTimer);
        }
    }

    async processSiliconFlowRecording(audioBlob) {
        try {
            const { ipcRenderer } = require('electron');
            logToTerminal('info', '【SiliconFlow ASR】录音结束，正在提交识别');
            const audioBytes = await audioBlob.arrayBuffer();
            const result = await ipcRenderer.invoke('siliconflow-asr-transcribe', audioBytes);
            if (!result?.success) {
                throw new Error(result?.error || '识别请求失败');
            }
            const recognizedText = (result.text || '').trim();
            if (!recognizedText) {
                throw new Error('接口未返回识别文本');
            }
            console.log('用户说:', recognizedText);
            // B5：四态门（开关关闭时直接放行）
            if (!this._gateRecognizedText(recognizedText)) {
                this.asrLocked = false;
                return null;
            }
            if (this.onSpeechRecognized) this.onSpeechRecognized(recognizedText);
            return recognizedText;
        } catch (error) {
            logToTerminal('error', `【SiliconFlow ASR】识别失败: ${error.message}`);
            console.error('SiliconFlow ASR 失败:', error);
            return null;
        } finally {
            this.asrLocked = false;
        }
    }

    // 修改：暂停录音方法，根据语音打断配置调整行为
    pauseRecording() {
        if (!this.voiceBargeInEnabled) {
            // 传统模式：完全暂停音频处理
            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(track => track.enabled = false);
            }
            this.isProcessingAudio = true;
            console.log('传统模式：Recording paused');
        } else {
            // 语音打断模式：不暂停音频处理，保持VAD监听
            console.log('语音打断模式：保持VAD监听，不暂停录音');
        }
    }

    // 修改：恢复录音方法
    resumeRecording() {
        if (!this.voiceBargeInEnabled) {
            // 传统模式：恢复音频处理
            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(track => track.enabled = true);
            }
            this.isProcessingAudio = false;
            console.log('传统模式：Recording resumed');
        } else {
            // 语音打断模式：VAD一直在监听，只需要解锁ASR
            console.log('语音打断模式：ASR解锁，可以接收新的语音输入');
        }

        // 共同逻辑：解锁ASR，只有当整个对话流程完成后才解锁
        this.asrLocked = false;
        console.log('ASR已解锁');
    }

    // 设置语音识别完成的回调函数
    setOnSpeechRecognized(callback) {
        this.onSpeechRecognized = callback;
    }

    // 设置「VAD 再次开口」回调（改造 1 的合并窗口续接兜底）
    setOnVadSpeechStart(callback) {
        this.onVadSpeechStart = callback;
    }

    // 新增：获取语音打断状态
    getVoiceBargeInStatus() {
        return {
            enabled: this.voiceBargeInEnabled,
            isRecording: this.isRecording,
            asrLocked: this.asrLocked,
            isProcessingAudio: this.isProcessingAudio,
            // VAD 自愈可观测字段（doctor 直接读这些键，不用再猜日志）
            vadReconnects: this.vadReconnects,
            vadDownSince: this.vadDownSince,
            vadReconnectAttempts: this.vadReconnectAttempts,
            vadConnected: !!(this.ws && this.ws.readyState === WebSocket.OPEN),
            // 附和抑制计数
            suppressedAffirmations: this._suppressedAffirmations,
            affirmationRescued: this._affirmationRescued,
        };
    }

    // 新增：动态切换语音打断功能
    setVoiceBargeIn(enabled) {
        this.voiceBargeInEnabled = enabled;
        console.log(`语音打断功能已${enabled ? '启用' : '禁用'}`);

        if (!enabled && this.isProcessingAudio) {
            // 如果禁用语音打断且当前在TTS播放中，恢复传统的暂停逻辑
            this.pauseRecording();
        } else if (enabled && this.isProcessingAudio) {
            // 如果启用语音打断，恢复VAD监听
            this.resumeRecording();
        }
    }

    // PTT：按下触发，打断TTS并开始录音
    pttStartRecording() {
        if (this.isRecording) return;
        // 按V是唯一的打断方式，无论TTS是否在播放都中断（中止旧生成是对的）；
        // 「记不记成被打断」由 interrupt 内部按 isPlaying() 判定 —— 没在播就不记，
        // 否则普通提问会被下一轮当成「话没说完被截断」而莫名开头「行，你说」。
        if (this.ttsProcessor) {
            this.ttsProcessor.interrupt({ reason: 'ptt' });
        }
        // 解锁ASR（TTS播放期间可能已锁定）
        this.asrLocked = false;
        this.hasInterruptedThisSession = false;
        this._suppressUtterance = false;   // PTT 是明确意图，绝不吃附和抑制
        this.isRecording = true;
        this._pttUtterance = true;         // B5：PTT 是明确意图，永不过四态门
        this.recordingStartIndex = this.continuousBuffer.length;
        console.log('PTT: 开始录音');
    }

    // PTT: cancel current recording without submitting it to ASR
    pttCancelRecording(reason = 'cancelled') {
        if (!this.isRecording) return;

        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }

        this.isRecording = false;
        this.asrLocked = false;
        this.hasInterruptedThisSession = false;
        this._suppressUtterance = false;
        this._pttUtterance = false;        // B5：取消后不留 PTT 标记
        this.recordingStartIndex = this.continuousBuffer.length;
        this.continuousBuffer = this.continuousBuffer.slice(-this.PRE_RECORD_SAMPLES);

        console.log(`PTT: recording cancelled (${reason})`);
    }

    // PTT：松开触发，强制结束录音并送 ASR
    pttStopRecording() {
        if (!this.isRecording) return;
        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }
        console.log('PTT: 停止录音，开始识别');
        this.finishRecording();
    }

    // 统一的ASR错误处理
    async handleASRError(response, serviceName) {
        let errorDetail = "";
        try {
            const errorBody = await response.text();
            try {
                const errorJson = JSON.parse(errorBody);
                errorDetail = JSON.stringify(errorJson, null, 2);
            } catch (e) {
                errorDetail = errorBody;
            }
        } catch (e) {
            errorDetail = "无法读取错误详情";
        }

        let errorMessage = "";
        switch (response.status) {
            case 401:
                errorMessage = `【${serviceName}ASR】API密钥验证失败，请检查你的API密钥是否正确`;
                break;
            case 403:
                errorMessage = `【${serviceName}ASR】API访问被禁止，你的账号可能被限制或额度已用完`;
                break;
            case 429:
                errorMessage = `【${serviceName}ASR】请求过于频繁，超出API限制或额度已用完`;
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                errorMessage = `【${serviceName}ASR】服务器错误，AI服务当前不可用`;
                break;
            default:
                errorMessage = `【${serviceName}ASR】API错误: ${response.status} ${response.statusText}`;
        }

        const fullError = `${errorMessage}\n详细信息: ${errorDetail}`;
        logToTerminal('error', fullError);
        console.error(errorMessage);
    }
}

module.exports = { ASRProcessor };
