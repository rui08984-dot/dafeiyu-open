// tts-request-handler.js - TTS请求处理器
// 职责：文本翻译、TTS API调用、文本分段

const __silentAudit = require('../core/silent-audit.js');
const { logToTerminal } = require('../api-utils.js');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const { readVolcengineConfig, volcengineHeaders } = require('./volcengine-config');
const { buildTTSRequest } = require('./tts-backends');
// 语义语气（默认关闭）：14 类语义 voice → ≤±10% 的 TTS 乘法增益。见 js/core/voice-style.js
const voiceStyle = require('../core/voice-style.js');

// ── 首段真流式播放（改造 2，2026-11-20）──────────────────────────────────────
// 改造前：`await response.blob()` 要等整句合成完才开始播放（实测 9883 首块
// 0.95–1.32s、整段 1.22–1.72s，白等 0.27–0.40s）。改造后：首段读到第一块字节
// 就交给 MediaSource + SourceBuffer，边下边播；后续段仍走整段 blob（回归面最小）。
//
// 兼容性红线：MediaSource 不支持 audio/mpeg / 首块超时 / body 不可读 → 无感回退
// 整段 blob，播放行为与改造前完全一致，并打一条 `[tts] stream 回退: <原因>`。
const TTS_STREAM_MIME = 'audio/mpeg';
const TTS_STREAM_FIRST_CHUNK_TIMEOUT_MS = 6000;
const TTS_STREAM_SOURCE_OPEN_TIMEOUT_MS = 3000;

function mediaSourceCtor() {
    try {
        if (typeof MediaSource !== 'undefined') return MediaSource;
        if (typeof globalThis !== 'undefined' && globalThis.MediaSource) return globalThis.MediaSource;
    } catch (_) { /* 取不到就是没有 */ }
    return null;
}

function streamMimeOf(response) {
    try {
        const raw = String((response && response.headers && response.headers.get('content-type')) || '')
            .trim().toLowerCase();
        const mime = raw.split(';')[0].trim();
        if (mime === 'audio/mp3') return TTS_STREAM_MIME;
        if (mime === TTS_STREAM_MIME) return mime;
        return '';
    } catch (_) { return ''; }
}

// 首段响应句柄：只负责「按序读字节」与「按序喂 SourceBuffer」，不懂播放器。
// playback engine 的用法：await waitFirstChunk() → attach(mediaSource) → <首块已 append，
// 可以 audio.play()>；期间任何失败都可 toBlob() 全身而退（已收块 + 剩余块 = 完整 MP3）。
class TTSStreamHandle {
    constructor(response, opts = {}) {
        this.__ttsStream = true;
        this.response = response;
        this.mimeType = opts.mimeType || TTS_STREAM_MIME;
        this.firstChunkTimeoutMs = Number(opts.firstChunkTimeoutMs) || TTS_STREAM_FIRST_CHUNK_TIMEOUT_MS;
        this.log = typeof opts.log === 'function' ? opts.log : ((m) => console.warn(m));
        this.onSettled = typeof opts.onSettled === 'function' ? opts.onSettled : null;
        this._settled = false;
        this.chunks = [];
        this.reader = null;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.audioEl = null;
        this.cancelled = false;
        this.finished = false;
        this.started = false;
        this._pumpPromise = null;
        this._onSbError = null;
        this._pendingRead = null;   // 首块超时后仍挂着的 read，toBlob() 必须先接住它
    }

    // 能力探测与播放器分离：Node 单测里注入 global.MediaSource 即可。
    static isSupported(mimeType) {
        const MS = mediaSourceCtor();
        try {
            return !!(MS && typeof MS.isTypeSupported === 'function'
                && MS.isTypeSupported(mimeType || TTS_STREAM_MIME));
        } catch (_) { return false; }
    }

    _settle() {
        if (this._settled) return;
        this._settled = true;
        try { if (this.onSettled) this.onSettled(); } catch (_) { }
    }

    _ensureReader() {
        if (this.reader) return this.reader;
        const body = this.response && this.response.body;
        if (!body || typeof body.getReader !== 'function') {
            throw new Error('response.body 不是可读流');
        }
        this.reader = body.getReader();
        return this.reader;
    }

    _withTimeout(promise, ms, message) {
        let timer = null;
        const timeout = new Promise((_, reject) => {
            // 不 unref：Node 单测里没有别的句柄时，unref 的定时器会让进程提前退出（假 0 通过）。
            timer = setTimeout(() => reject(new Error(message)), ms);
        });
        return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
    }

    // 等到第一块字节（不建 MediaSource）。超时/中止/空流都会 throw。
    async waitFirstChunk() {
        if (this.chunks.length) return this.chunks[0];
        if (this.cancelled) throw new Error('stream 已取消');
        const reader = this._ensureReader();
        const timeoutMs = this.firstChunkTimeoutMs;
        let result;
        let timer = null;
        const readPromise = reader.read();
        this._pendingRead = readPromise;
        const timeoutPromise = new Promise((resolve) => {
            // 不 unref（同 _withTimeout）：否则 Node 里等首块时会因事件循环空转提前退出。
            timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
        });
        try {
            result = await Promise.race([readPromise, timeoutPromise]);
        } catch (err) {
            // 真正的读错误：reader 已不可用，直接释放
            this._pendingRead = null;
            this._releaseReader(err && err.message || 'first-chunk-failed');
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
        }
        if (result && result.__timeout) {
            // 超时**不取消** reader：回退 toBlob() 会先接住这次 read 再续读，
            // 保证「已收块 + 剩余块」顺序完整（否则回退会丢块/得到空 Blob）。
            const err = new Error(`首块超时(${timeoutMs}ms)`);
            err.isTimeout = true;
            throw err;
        }
        this._pendingRead = null;
        if (!result || result.done || !result.value || !result.value.byteLength) {
            this.finished = true;
            this._releaseReader('empty');
            throw new Error('流为空（0 字节）');
        }
        this.chunks.push(result.value);
        return result.value;
    }

    _waitSourceOpen(mediaSource) {
        if (mediaSource.readyState === 'open') return Promise.resolve();
        let onOpen = null;
        const opened = new Promise((resolve) => {
            onOpen = resolve;
            mediaSource.addEventListener('sourceopen', onOpen, { once: true });
        });
        return this._withTimeout(opened, TTS_STREAM_SOURCE_OPEN_TIMEOUT_MS,
            `sourceopen 超时(${TTS_STREAM_SOURCE_OPEN_TIMEOUT_MS}ms)`)
            .finally(() => {
                try { if (onOpen) mediaSource.removeEventListener('sourceopen', onOpen); } catch (_) { }
            });
    }

    _waitUpdate() {
        const sb = this.sourceBuffer;
        return new Promise((resolve, reject) => {
            if (!sb || !sb.updating) return resolve();
            const onEnd = () => { cleanup(); resolve(); };
            const onErr = () => { cleanup(); reject(new Error('SourceBuffer 更新失败')); };
            const onAbort = () => { cleanup(); reject(new Error('SourceBuffer 已中止')); };
            const cleanup = () => {
                try { sb.removeEventListener('updateend', onEnd); } catch (_) { }
                try { sb.removeEventListener('error', onErr); } catch (_) { }
                try { sb.removeEventListener('abort', onAbort); } catch (_) { }
            };
            sb.addEventListener('updateend', onEnd);
            sb.addEventListener('error', onErr);
            sb.addEventListener('abort', onAbort);
        });
    }

    async _appendChunk(chunk) {
        if (this.cancelled) throw new Error('stream 已取消');
        const sb = this.sourceBuffer;
        if (!sb) throw new Error('SourceBuffer 未就绪');
        await this._waitUpdate();
        if (this.cancelled) throw new Error('stream 已取消');
        sb.appendBuffer(chunk);
        await this._waitUpdate();
    }

    // 后台泵：首块之后的字节继续按序 append；结束/中断都要 endOfStream，播放器才能收尾。
    async _pump() {
        try {
            while (!this.cancelled) {
                const reader = this._ensureReader();
                const { done, value } = await reader.read();
                if (done) { this.finished = true; break; }
                if (!value || !value.byteLength) continue;
                this.chunks.push(value);
                await this._appendChunk(value);
            }
            if (!this.cancelled && this.mediaSource && this.mediaSource.readyState === 'open') {
                try { this.mediaSource.endOfStream(); } catch (_) { }
            }
        } catch (err) {
            if (this.cancelled) return;
            // 首块已经播出去了：不重启（重复播更糟），干净收尾并在日志里说清楚
            this.log(`[tts] stream 中断: ${err && err.message || err}`);
            try {
                if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
            } catch (_) { }
        } finally {
            this._settle();
        }
    }

    // 把已缓存的块 + 剩余流全部拼成 Blob（回退路径）。任何读错误都只影响剩余部分。
    async toBlob() {
        const parts = this.chunks.slice();
        // 首块超时留下的 read 仍挂在流上：先按原序接住它，再续读，避免丢块/乱序。
        if (this._pendingRead) {
            const pending = this._pendingRead;
            this._pendingRead = null;
            try {
                const r = await pending;
                if (r && !r.done && r.value && r.value.byteLength) {
                    parts.push(r.value);
                    this.chunks.push(r.value);
                }
            } catch (_) { /* 读失败就只能用已收块 */ }
        }
        const reader = this.reader || (this.response && this.response.body
            && typeof this.response.body.getReader === 'function' ? this.response.body.getReader() : null);
        if (reader) {
            this.reader = reader;
            try {
                while (!this.finished && !this.cancelled) {
                    const { done, value } = await reader.read();
                    if (done) { this.finished = true; break; }
                    if (value && value.byteLength) parts.push(value);
                }
            } catch (err) {
                if (!(err && (err.name === 'AbortError' || this.cancelled))) throw err;
            }
        }
        this._releaseReader('toBlob');
        this._releaseSourceBuffer();
        this._settle();
        if (!parts.length) return null;
        return new Blob(parts, { type: this.mimeType });
    }

    _releaseReader(reason) {
        const reader = this.reader;
        this.reader = null;
        this._pendingRead = null;
        if (!reader) return;
        try { reader.cancel(reason); } catch (_) { }
        try { if (typeof reader.releaseLock === 'function') reader.releaseLock(); } catch (_) { }
    }

    _releaseSourceBuffer() {
        const sb = this.sourceBuffer;
        this.sourceBuffer = null;
        if (!sb) return;
        try { if (this._onSbError) sb.removeEventListener('error', this._onSbError); } catch (_) { }
        try { if (sb.updating && typeof sb.abort === 'function') sb.abort(); } catch (_) { }
        try {
            if (this.mediaSource && this.mediaSource.readyState === 'open'
                && typeof this.mediaSource.removeSourceBuffer === 'function') {
                this.mediaSource.removeSourceBuffer(sb);
            }
        } catch (_) { }
    }

    // 接到 MediaSource：先 append 首块并返回（此时就能 play），剩余块后台续流。
    async attach(mediaSource, audioEl) {
        if (this.cancelled) throw new Error('stream 已取消');
        if (!this.chunks.length) await this.waitFirstChunk();
        this.mediaSource = mediaSource;
        this.audioEl = audioEl || null;
        await this._waitSourceOpen(mediaSource);
        if (this.cancelled) throw new Error('stream 已取消');
        const sb = mediaSource.addSourceBuffer(this.mimeType);
        this.sourceBuffer = sb;
        this._onSbError = () => this.log('[tts] stream 中断: SourceBuffer error 事件');
        try { sb.addEventListener('error', this._onSbError); } catch (_) { }
        // 首块先 append —— 这是「首块到达即开始播放」的关键，不等整段。
        const first = this.chunks[0];
        await this._appendChunk(first);
        this.started = true;
        this._pumpPromise = this._pump();
        if (this._pumpPromise && typeof this._pumpPromise.catch === 'function') {
            this._pumpPromise.catch(() => { });
        }
        return true;
    }

    // 打断/停止：释放 reader 与 SourceBuffer，后台泵看到 cancelled 会立即退出。
    cancel(reason = 'cancelled') {
        if (this.cancelled) return;
        this.cancelled = true;
        this._releaseReader(reason);
        this._releaseSourceBuffer();
        try {
            if (this.mediaSource && this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
        } catch (_) { }
        this._settle();
    }

    // 单测/排障读口
    waitForPump() {
        return this._pumpPromise || Promise.resolve();
    }
}

class TTSRequestHandler {
    useVolcengineVoice(config) {
        const settings = readVolcengineConfig(config);
        this.config = config;
        this.useGateway = false;
        this.aliyunTtsEnabled = false;
        this.cloudTtsEnabled = false;
        this.volcTtsEnabled = true;
        this.volcApiKey = settings.apiKey;
        this.volcVoiceType = settings.voiceType;
        this.volcEndpoint = settings.endpoint;
        this.volcResourceId = settings.resourceId;
    }

    useAliyunVoice(config) {
        const voice = config.cloud?.aliyun_tts || {};
        this.config = config;
        this.useGateway = false;
        this.volcTtsEnabled = false;
        this.cloudTtsEnabled = false;
        this.aliyunTtsEnabled = true;
        this.aliyunApiKey = voice.api_key || '';
        this.aliyunModel = voice.model || 'cosyvoice-v3-flash';
        this.aliyunVoice = voice.voice || '';
        this.aliyunSampleRate = voice.sample_rate || 48000;
        this.aliyunVolume = voice.volume ?? 50;
        this.aliyunRate = voice.rate ?? 1;
        this.aliyunPitch = voice.pitch ?? 1;
    }

    constructor(config, ttsUrl) {
        this.config = config;
        this.language = config.tts?.language || "zh";
        this.speedFactor = Number(config.tts?.speed_factor) > 0 ? Number(config.tts.speed_factor) : 1;

        // 首段流式开关（改造 2）：默认 true；config.tts.stream_first_segment=false 即
        // 完全回到「整段 blob」老路径。只作用于**每轮第一段**，且只在边缘 edge 本地 9883。
        this.streamFirstSegment = config.tts?.stream_first_segment !== false;
        this._streamFirstUsed = false;          // 每轮 reset() 复位
        this._streamFallbackLogged = false;     // 兼容性回退只喊一次，避免每轮刷屏

        // 统一网关模式配置
        const gatewayConfig = config.api_gateway || {};
        if (gatewayConfig.use_gateway) {
            this.ttsUrl = `${gatewayConfig.base_url}/tts/synthesize`;
            this.apiKey = gatewayConfig.api_key || "";
            this.useGateway = true;
        } else {
            this.ttsUrl = ttsUrl;
            this.apiKey = null;
            this.useGateway = false;
        }

        // 字节跳动TTS配置
        const volcTts = config.cloud?.volcengine_tts || {};
        this.volcTtsEnabled = volcTts.enabled || false;
        const volcSettings = readVolcengineConfig(config);
        this.volcApiKey = volcSettings.apiKey;
        this.volcVoiceType = volcSettings.voiceType;
        this.volcEndpoint = volcSettings.endpoint;
        this.volcResourceId = volcSettings.resourceId;

        // 阿里云TTS配置
        const aliyunTts = config.cloud?.aliyun_tts || {};
        this.aliyunTtsEnabled = aliyunTts.enabled || false;
        this.aliyunApiKey = aliyunTts.api_key || "";
        this.aliyunModel = aliyunTts.model || "cosyvoice-v3-flash";
        this.aliyunVoice = aliyunTts.voice || "";
        this.aliyunSampleRate = aliyunTts.sample_rate || 48000;
        this.aliyunVolume = aliyunTts.volume ?? 50;
        this.aliyunRate = aliyunTts.rate ?? 1;
        this.aliyunPitch = aliyunTts.pitch ?? 1;

        // 云服务商配置（SiliconFlow等，保留兼容）
        this.cloudTtsEnabled = config.cloud?.tts?.enabled || false;
        this.cloudTtsUrl = config.cloud?.tts?.url || "";
        this.cloudApiKey = config.cloud?.api_key || "";
        this.cloudTtsModel = config.cloud?.tts?.model || "";
        this.cloudTtsVoice = config.cloud?.tts?.voice || "";
        this.cloudTtsFormat = config.cloud?.tts?.response_format || "mp3";
        this.cloudTtsSpeed = config.cloud?.tts?.speed || 1.0;

        // 翻译配置
        this.translationEnabled = config.translation?.enabled || false;
        this.translationApiKey = config.translation?.api_key || "";
        this.translationApiUrl = config.translation?.api_url || "";
        this.translationModel = config.translation?.model || "";
        this.translationSystemPrompt = config.translation?.system_prompt || "";

        // 分句标点（2026-11-08 修复「说话一顿顿」）：
        // 原来把**逗号也当分句符**——她每说一个逗号就切一段、单独发一次 Edge TTS 请求，
        // 而每次请求含 300-800ms 握手+合成启动 → 句与句之间必然出现明显 gap，
        // 听感就是「一顿一顿的」。逗号处的停顿本该只有 150-300ms，交给合成器内部处理即可。
        // 现在只在**句末**切分（。？！；换行），一句内多个逗号由 TTS 一次合成、自然连读。
        this.punctuations = ['。', '？', '!', '！', '；', ';', '\n'];
        // 逗号仍用于「超长句兜底」：一句超过 maxSegmentChars 时在最近逗号处强制切，
        // 避免长句合成延迟过大（首字出不来）。这是延迟保险，不是常规路径。
        this.softPunctuations = ['，', ','];
        this.maxSegmentChars = 80;
        // 首段上限（2026-11-15 六十三轮）：实测首音 3.17–6.59s，其中 1.9–2.7s 花在
        // 「等 LLM 流到第一个句号」。第一版放到 24 字，实测她的短句风格根本碰不到 →
        // 再降到 14 字（无标点 21 字硬切）。只影响**本轮第一段**，后续段仍 80 字保连读。
        this.firstSegmentChars = 14;
        this.pendingSegment = '';

        // 请求管理
        this.activeRequests = new Set();
        this.requestIdCounter = 0;

        // 字节TTS长连接（连接复用）
        this.volcWs = null;
        this.volcWsReady = null;
    }

    // 翻译文本
    async translateText(text) {
        if (!this.translationEnabled || !text.trim()) return text;

        try {
            const response = await fetch(`${this.translationApiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.translationApiKey}`
                },
                body: JSON.stringify({
                    model: this.translationModel,
                    messages: [
                        { role: 'system', content: this.translationSystemPrompt },
                        { role: 'user', content: text }
                    ],
                    stream: false
                })
            });

            if (!response.ok) throw new Error(`翻译API错误: ${response.status}`);

            const data = await response.json();
            return data.choices[0].message.content.trim();
        } catch (error) {
            console.error('翻译失败:', error);
            return text;
        }
    }

    // ── 语义语气（2026-11-17，默认关闭）───────────────────────────────────
    // 分段器是「一句话诞生」的地方：在这里异步预取语义 voice，等它排到队首时
    // （edge 单句合成约 1.2s）结果早回来了——合成链上一毫秒都不等。
    // 本轮第一段通常赶不上（入队即合成），这是**有意**的：宁可第一句没有风格，
    // 也不为风格让首音多等 8~900ms。
    _voicePrefetch(text) {
        try {
            const cfg = this.config && this.config.voice_style;
            if (!cfg || cfg.enabled !== true) return;
            // 先同步开关：ingest 也受 enabled 门控，不先 configure 会把首次预取丢掉。
            voiceStyle.configure(cfg);
            const t = String(text || '').trim();
            if (t.length < 2) return;
            const { classify } = require('../core/lumen-semantic.js');
            classify({ intent: t, timeoutMs: 900 })
                .then((r) => voiceStyle.ingestSemantic(r, { text: t }))
                .catch(() => { /* 服务挂了就当没有这个能力 */ });
        } catch (e) { /* 风格是锦上添花：任何失败都不许影响合成 */ }
    }

    _pushSegment(queue, segment) {
        queue.push(segment);
        this._voicePrefetch(segment);
    }

    // 把本句的语义增益挂到请求体。base 用中性 1/1/1——真正的基准韵律在
    // tts_server.py（情绪表算出的 p_rate/p_pitch/p_vol），这里只给 ≤±10% 的乘数，
    // 由服务端乘上去，所以不会和情绪链路「各算一遍」。
    _attachVoiceGain(body, text) {
        const g = voiceStyle.applyToProsody({ rate: 1, pitch: 1, energy: 1 }, Date.now(), text);
        if (g.rate !== 1 || g.pitch !== 1 || g.energy !== 1) {
            body.prosody_gain = { rate: g.rate, pitch: g.pitch, energy: g.energy };
            // §81 试听期怎么观测：只认 voice-style.stats() 的 counts（ingested/applied/expired/
            // textMismatch）—— 不在调用方再记第二份，两份记账迟早打架。读法：
            //   8004 /eval → require('./js/core/voice-style.js').stats()
        }
    }

    // 将文本转换为语音
    async convertTextToSpeech(text) {
        const requestId = ++this.requestIdCounter;
        const controller = new AbortController();
        const requestInfo = { id: requestId, controller };
        this.activeRequests.add(requestInfo);

        // 合成总超时（2026-11-21 根因修复）：原来 fetch 只有 interrupt 才 abort，
        // Edge 卡住时段已 shift、isProcessing=true、两个队列全空 → 看门狗判「没活」→
        // 整轮静音且不结束。这里给**整个网络阶段**（含 response.blob()）加总超时，
        // 超时按「本段失败」返回 null（调用方继续下一段），并写 runtime.log。
        // 配置：tts.synth_timeout_ms（默认 20s）。
        const synthTimeoutMs = Number(this.config && this.config.tts && this.config.tts.synth_timeout_ms) > 0
            ? Number(this.config.tts.synth_timeout_ms)
            : 20000;
        let synthTimedOut = false;
        const synthTimer = setTimeout(() => {
            synthTimedOut = true;
            try { controller.abort(); } catch (_) { }
        }, synthTimeoutMs);

        try {
            // 清理文本
            const textForTTS = text
                .replace(/<[^>]+>/g, '')
                .replace(/（.*?）|\(.*?\)/g, '')
                .replace(/\*.*?\*/g, '');

            // 清理后无实际文字内容则跳过（纯标点、空白等）
            const hasContent = textForTTS.replace(/[,，。？?!！；;：:、…—\-\s]/g, '').trim();
            if (!hasContent) return null;

            // 插件 onTTSText 钩子（仅影响TTS音频，字幕保持原文）
            const finalTextForTTS = global.pluginManager
                ? await global.pluginManager.runTTSTextHooks(textForTTS)
                : await this.translateText(textForTTS);

            // 开关每次请求读一次：控制中心热改 config 后不用重建处理器。
            // 关闭时这里还会清掉可能残留的上一句结果（关就是关）。
            voiceStyle.configure(this.config && this.config.voice_style);

            // 调用TTS API
            if (this.volcTtsEnabled) {
                // 字节跳动TTS
                const audioBuffer = await this.volcengineSynthesize(finalTextForTTS, controller.signal);
                if (!audioBuffer) return null;
                return new Blob([audioBuffer], { type: 'audio/wav' });
            } else if (this.aliyunTtsEnabled) {
                // 阿里云TTS（WebSocket模式）
                const audioBuffer = await this.aliyunSynthesize(finalTextForTTS, controller.signal);
                if (!audioBuffer) return null;
                return new Blob([audioBuffer], { type: 'audio/wav' });
            } else if (this.cloudTtsEnabled) {
                // 云服务商模式（SiliconFlow等）
                const response = await fetch(this.cloudTtsUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.cloudApiKey}`
                    },
                    body: JSON.stringify({
                        model: this.cloudTtsModel,
                        voice: this.cloudTtsVoice,
                        input: finalTextForTTS,
                        response_format: this.cloudTtsFormat,
                        speed: this.cloudTtsSpeed
                    }),
                    signal: controller.signal
                });

                if (!response.ok) {
                    await this.handleTTSError(response, '云端TTS');
                }
                return await response.blob();
            } else {
                // 本地模式或统一网关模式
                const headers = { 'Content-Type': 'application/json' };

                // 如果使用统一网关，添加 X-API-Key
                if (this.useGateway && this.apiKey) {
                    headers['X-API-Key'] = this.apiKey;
                }

                // 引擎适配层（tts-backends.js）：config.tts.backend 决定请求形状——
                // edge/sovits/openai/custom 各自的 body 与鉴权都在注册表里，换引擎不改这里。
                let requestBody;
                let requestUrl = this.ttsUrl;
                let requestHeaders = headers;
                try {
                    const req = buildTTSRequest(this.config?.tts?.backend || 'edge', {
                        text: finalTextForTTS,
                        text_language: this.language,
                        speed_factor: this.speedFactor,
                    }, this.config);
                    requestBody = req.body;
                    requestUrl = this.useGateway ? this.ttsUrl : req.url;
                    requestHeaders = this.useGateway ? headers : req.headers;
                    // 只有本地 edge 后端（9883）认这个字段；网关/其它后端保持请求体逐字节不变。
                    if (req.backend === 'edge' && !this.useGateway) this._attachVoiceGain(requestBody, text);
                    if (req.backend !== 'edge' && !this._backendLogged) {
                        this._backendLogged = true;
                        logToTerminal('info', `🎙 TTS 引擎: ${req.backend} → ${requestUrl}`);
                    }
                } catch (backendError) {
                    // 适配层挂了（如 backend_params JSON 写坏）→ 回退 edge 形状并写明原因，不静默
                    if (!this._backendErrLogged) {
                        this._backendErrLogged = true;
                        logToTerminal('warn', `TTS 引擎参数构建失败（回落 edge 形状）: ${backendError.message}`);
                    }
                    requestBody = { text: finalTextForTTS, text_language: this.language };
                }

                const response = await fetch(requestUrl, {
                    method: 'POST',
                    headers: requestHeaders,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });

                if (!response.ok) {
                    await this.handleTTSError(response, this.useGateway ? '云端肥牛网关TTS' : '本地TTS');
                }
                // 每轮首段：能流就流；不满足条件时 _streamFirstSegment 内部已写明原因并返回 null。
                const streamHandle = this._streamFirstSegment(response, requestInfo);
                if (streamHandle) {
                    // 流式句柄的生命周期延续到「播完/取消」，不归本函数的合成总超时管
                    //（首块有自己的 6s 超时 + 播放侧回退）。
                    clearTimeout(synthTimer);
                    return streamHandle;
                }
                return await response.blob();
            }
        } catch (error) {
            // 注意：不同 fetch 实现对 abort 的报错形状不一（AbortError / TypeError: terminated），
            // 所以「本次是否超时」以 synthTimedOut 为准，不靠 error.name 识别。
            if (error.name === 'AbortError' || synthTimedOut) {
                if (synthTimedOut) {
                    // 超时不是用户打断：必须留痕（否则 runtime.log 里只有「静音」没有原因）
                    this._synthTimeoutCount = (this._synthTimeoutCount || 0) + 1;
                    try {
                        logToTerminal('warn', `[TTS] 合成超时（${synthTimeoutMs}ms），本段放弃并继续下一段（累计 ${this._synthTimeoutCount} 次）`);
                    } catch (_) { }
                }
                return null;
            }
            console.error('TTS转换错误:', error);
            return null;
        } finally {
            clearTimeout(synthTimer);
            // 流式首段的请求生命周期到「播完/取消」为止（不是 headers 返回为止）：
            // 否则排队中被打断时 abortAllRequests 找不到它，reader 会一直下载。
            if (!requestInfo.stream) this.activeRequests.delete(requestInfo);
        }
    }

    // 首段流式判定（改造 2）。返回 TTSStreamHandle 或 null；null 时调用方走 response.blob()。
    _streamFirstSegment(response, requestInfo) {
        // 每次请求读一次开关：config 被热改（同一对象）成 false 时立刻回退，不用重建处理器。
        const cfgFlag = this.config?.tts?.stream_first_segment;
        if (cfgFlag === false || !this.streamFirstSegment || this._streamFirstUsed) return null;
        // 网关/其它后端不改协议：只有本地 edge 9883 的 audio/mpeg 走这条新路径。
        if (this.useGateway) return null;
        if ((this.config?.tts?.backend || 'edge') !== 'edge') return null;
        if (!response || !response.body || typeof response.body.getReader !== 'function') {
            this._logStreamFallback('响应不是可读流');
            return null;
        }
        const mime = streamMimeOf(response);
        if (!mime) {
            this._logStreamFallback('Content-Type 不是 audio/mpeg');
            return null;
        }
        if (!TTSStreamHandle.isSupported(mime)) {
            this._logStreamFallback(`MediaSource 不支持 ${mime}`);
            return null;
        }
        this._streamFirstUsed = true;
        // 措辞修正（2026-11-21）：这里只是**选定**流式（handle 已建、attach 还没发生）。
        // 说「播放中」会在 attach 失败时误导排查；真正开播的日志在 playback-engine。
        try { logToTerminal('info', `🎧 首段流式已选定（${mime} / MediaSource）`); } catch (_) { }
        const handle = new TTSStreamHandle(response, {
            mimeType: mime,
            log: (m) => { try { logToTerminal('warn', m); } catch (_) { console.warn(m); } },
            onSettled: () => {
                if (requestInfo) this.activeRequests.delete(requestInfo);
            },
        });
        if (requestInfo) requestInfo.stream = handle;
        return handle;
    }

    _logStreamFallback(reason) {
        if (this._streamFallbackLogged) return;
        this._streamFallbackLogged = true;
        try { logToTerminal('warn', `[tts] stream 回退: ${reason}`); } catch (_) { console.warn(`[tts] stream 回退: ${reason}`); }
    }

    // 流式文本分段
    segmentStreamingText(text, queue) {
        this.pendingSegment += text;

        let processedSegment = '';
        for (let i = 0; i < this.pendingSegment.length; i++) {
            const char = this.pendingSegment[i];
            processedSegment += char;

            // 句末：正常切分
            if (this.punctuations.includes(char) && processedSegment.trim()) {
                this._pushSegment(queue, processedSegment);
                processedSegment = '';
                continue;
            }
            // 超长句兜底：一句超过 maxSegmentChars 还没遇到句末 → 在最近逗号处切，
            // 保证首字能尽早出来（长句一次合成会拖到 2-3s 才开始出声）。
            // 首段更激进（2026-11-15 实测）：edge-tts 单次合成约 1.2s，而服务端还会按逗号
            // 再拆句**串行合成** —— 首段里带一个逗号 = 2×1.2s。所以第一段只要攒到 4 个字
            // 就在第一个逗号处切：让「嗯，」先出声，后半句在播放时并行合成。
            const isFirstSegment = queue.length === 0;
            if (isFirstSegment && this.softPunctuations.includes(char) && processedSegment.length >= 4) {
                this._pushSegment(queue, processedSegment);
                processedSegment = '';
                continue;
            }
            const softCap = isFirstSegment ? this.firstSegmentChars : this.maxSegmentChars;
            if (processedSegment.length >= softCap
                && this.softPunctuations.includes(char)) {
                this._pushSegment(queue, processedSegment);
                processedSegment = '';
                continue;
            }
            // 首段完全没逗号可切：到 1.5 倍上限就硬切，别无限等
            if (isFirstSegment && processedSegment.length >= Math.round(this.firstSegmentChars * 1.5)) {
                this._pushSegment(queue, processedSegment);
                processedSegment = '';
            }
        }

        // 兜底：剩余片段已经很长且没有逗号可切（用户说话很快/模型不标点）→ 硬切
        if (processedSegment.length >= this.maxSegmentChars * 1.5) {
            this._pushSegment(queue, processedSegment);
            processedSegment = '';
        }

        this.pendingSegment = processedSegment;
    }

    // 完成流式分段
    finalizeSegmentation(queue) {
        if (this.pendingSegment.trim()) {
            this._pushSegment(queue, this.pendingSegment);
            this.pendingSegment = '';
        }
    }

    // 完整文本分段
    segmentFullText(text, queue) {
        let currentSegment = '';
        for (let char of text) {
            currentSegment += char;
            // 句末正常切分（逗号不再切，见 punctuations 注释）
            if (this.punctuations.includes(char) && currentSegment.trim()) {
                this._pushSegment(queue, currentSegment);
                currentSegment = '';
                continue;
            }
            // 超长句兜底：与流式分段同规则
            if (currentSegment.length >= this.maxSegmentChars
                && this.softPunctuations.includes(char)) {
                this._pushSegment(queue, currentSegment);
                currentSegment = '';
            }
        }
        if (currentSegment.length >= this.maxSegmentChars * 1.5) {
            this._pushSegment(queue, currentSegment);
            currentSegment = '';
        }

        if (currentSegment.trim()) {
            this._pushSegment(queue, currentSegment);
        }
    }

    // 确保字节TTS长连接可用
    async _ensureVolcConnection() {
        const { EventType, MsgType, startConnection, waitForEvent } = require('./volcengine-protocols.js');

        // 连接已就绪
        if (this.volcWs && this.volcWs.readyState === WebSocket.OPEN && this.volcWsReady && this.volcConnectedApiKey === this.volcApiKey) {
            await this.volcWsReady;
            return;
        }

        this._closeVolcConnection();
        const apiKey = this.volcApiKey;
        const headers = volcengineHeaders(apiKey);
        this.volcWsReady = new Promise((resolve, reject) => {
            const ws = new WebSocket(this.volcEndpoint, {
                headers,
                skipUTF8Validation: true,
            });

            ws.on('error', (err) => reject(err));

            ws.on('close', () => {
                if (this.volcWs === ws) {
                    this.volcWs = null;
                    this.volcWsReady = null;
                }
            });

            ws.on('open', async () => {
                try {
                    await startConnection(ws);
                    await waitForEvent(ws, MsgType.FullServerResponse, EventType.ConnectionStarted);
                    this.volcWs = ws;
                    this.volcConnectedApiKey = apiKey;
                    resolve();
                } catch (err) {
                    ws.close();
                    reject(err);
                }
            });
        });

        await this.volcWsReady;
    }

    // 关闭字节TTS长连接
    _closeVolcConnection() {
        if (this.volcWs) {
            try { this.volcWs.close(); } catch (_) { try { __silentAudit.audit('tts-request-handler.js:340', _); } catch (e2) {} }
            this.volcWs = null;
            this.volcWsReady = null;
        }
    }

    // 字节跳动TTS WebSocket合成（连接复用，每段开新 session）
    async volcengineSynthesize(text, abortSignal) {
        const {
            EventType, MsgType,
            receiveMessage, waitForEvent,
            startSession, finishSession, taskRequest,
        } = require('./volcengine-protocols.js');

        if (abortSignal?.aborted) return null;

        try {
            await this._ensureVolcConnection();
        } catch (err) {
            logToTerminal('error', `字节TTS连接失败: ${err.message}`);
            return null;
        }

        if (abortSignal?.aborted) return null;

        const ws = this.volcWs;

        // 打断时关闭连接，解除所有 await receiveMessage 的阻塞
        const onAbort = () => this._closeVolcConnection();
        abortSignal?.addEventListener('abort', onAbort, { once: true });

        try {
            const sessionId = randomUUID();
            const baseReq = {
                user: { uid: randomUUID() },
                namespace: 'BidirectionalTTS',
                req_params: {
                    speaker: this.volcVoiceType,
                    audio_params: { format: 'wav', sample_rate: 24000 },
                },
            };

            await startSession(
                ws,
                Buffer.from(JSON.stringify({ ...baseReq, event: EventType.StartSession })),
                sessionId,
            );
            await waitForEvent(ws, MsgType.FullServerResponse, EventType.SessionStarted);

            // 逐字发送文本
            for (const char of text) {
                if (abortSignal?.aborted) return null;
                await taskRequest(
                    ws,
                    Buffer.from(JSON.stringify({
                        ...baseReq,
                        event: EventType.TaskRequest,
                        req_params: { ...baseReq.req_params, text: char },
                    })),
                    sessionId,
                );
            }
            await finishSession(ws, sessionId);

            // 收集所有音频块
            const chunks = [];
            while (true) {
                const msg = await receiveMessage(ws);
                if (msg.type === MsgType.AudioOnlyServer) {
                    chunks.push(msg.payload);
                } else if (msg.type === MsgType.FullServerResponse && msg.event === EventType.SessionFinished) {
                    break;
                }
            }

            // 连接继续保留，供下一个句子复用
            return chunks.length > 0 ? Buffer.concat(chunks) : null;

        } catch (err) {
            if (!abortSignal?.aborted) {
                logToTerminal('error', `字节TTS合成失败: ${err.message}`);
            }
            // 连接可能已损坏，清除让下次重连
            this._closeVolcConnection();
            return null;
        } finally {
            abortSignal?.removeEventListener('abort', onAbort);
        }
    }

    // 阿里云TTS WebSocket合成
    aliyunSynthesize(text, abortSignal) {
        return new Promise((resolve, reject) => {
            const taskId = randomUUID();
            const audioChunks = [];
            let settled = false;

            const ws = new WebSocket('wss://dashscope.aliyuncs.com/api-ws/v1/inference/', {
                headers: { 'Authorization': `bearer ${this.aliyunApiKey}` }
            });

            // 支持 AbortController 取消
            const onAbort = () => {
                if (!settled) {
                    settled = true;
                    ws.close();
                    resolve(null);
                }
            };
            if (abortSignal) {
                if (abortSignal.aborted) { resolve(null); return; }
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }

            const cleanup = () => {
                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
            };

            ws.on('open', () => {
                ws.send(JSON.stringify({
                    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
                    payload: {
                        task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
                        model: this.aliyunModel,
                        parameters: {
                            text_type: 'PlainText',
                            voice: this.aliyunVoice,
                            format: 'wav',
                            sample_rate: this.aliyunSampleRate,
                            volume: this.aliyunVolume,
                            rate: this.aliyunRate,
                            pitch: this.aliyunPitch
                        },
                        input: {}
                    }
                }));
            });

            ws.on('message', (data, isBinary) => {
                if (settled) return;

                if (isBinary) {
                    audioChunks.push(data);
                    return;
                }

                const msg = JSON.parse(data.toString());
                const event = msg?.header?.event;

                if (event === 'task-started') {
                    ws.send(JSON.stringify({
                        header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
                        payload: { input: { text } }
                    }));
                    ws.send(JSON.stringify({
                        header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
                        payload: { input: {} }
                    }));
                } else if (event === 'task-finished') {
                    settled = true;
                    cleanup();
                    ws.close();
                    resolve(Buffer.concat(audioChunks));
                } else if (event === 'task-failed') {
                    settled = true;
                    cleanup();
                    ws.close();
                    const errMsg = `阿里云TTS失败: ${JSON.stringify(msg)}`;
                    logToTerminal('error', errMsg);
                    reject(new Error(errMsg));
                }
            });

            ws.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    cleanup();
                    logToTerminal('error', `阿里云TTS WebSocket错误: ${err.message}`);
                    reject(err);
                }
            });
        });
    }

    // 中止所有请求
    abortAllRequests() {
        this.activeRequests.forEach(req => {
            // 先取消流句柄（释放 reader/SourceBuffer），再 abort fetch 控制器
            try { if (req.stream) req.stream.cancel('request-aborted'); } catch (_) { }
            req.controller.abort();
        });
        this.activeRequests.clear();
        this._closeVolcConnection();
    }

    // 重置状态
    reset() {
        this.pendingSegment = '';
        this._streamFirstUsed = false;   // 新一轮又可以流式播首段
        this.abortAllRequests();
        // 换轮/打断：语义语气只能活在「当前这一轮」，不清会粘到下一句（硬约束）。
        voiceStyle.reset();
    }

    // 获取待处理片段
    getPendingSegment() {
        return this.pendingSegment;
    }

    // 统一的TTS错误处理
    async handleTTSError(response, serviceName) {
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
        // 2026-11-21：edge-tts 全分句失败现在返回 502 + X-Tts-Failed: all（原来伪装成 200+0 字节）。
        // 这里把「全失败」单独说出来，别让用户只看到笼统的「服务器错误」。
        let ttsFailedAll = '';
        try { ttsFailedAll = String(response.headers?.get?.('x-tts-failed') || '').toLowerCase(); } catch (e) { /* 头读不到就按普通错误处理 */ }
        switch (response.status) {
            case 401:
                errorMessage = `【${serviceName}】API密钥验证失败，请检查你的API密钥是否正确`;
                break;
            case 403:
                errorMessage = `【${serviceName}】API访问被禁止，你的账号可能被限制或额度已用完`;
                break;
            case 429:
                errorMessage = `【${serviceName}】请求过于频繁，超出API限制或额度已用完`;
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                errorMessage = ttsFailedAll === 'all'
                    ? `【${serviceName}】全部分句合成失败（X-Tts-Failed: all）——本段无音频，检查 TTS 服务/网络`
                    : `【${serviceName}】服务器错误，AI服务当前不可用`;
                break;
            default:
                errorMessage = `【${serviceName}】API错误: ${response.status} ${response.statusText}`;
        }

        const fullError = `${errorMessage}\n详细信息: ${errorDetail}`;
        logToTerminal('error', fullError);
        throw new Error(errorMessage);
    }
}

module.exports = { TTSRequestHandler, TTSStreamHandle };
