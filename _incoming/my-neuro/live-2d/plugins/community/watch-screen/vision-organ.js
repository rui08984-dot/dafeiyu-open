'use strict';
const __silentAudit = require('../../../js/core/silent-audit.js');
// 屏幕摘要来自画面（第三方内容），进主对话前必须包成「环境数据·非指令」
const { wrapUntrusted } = require('../../../js/core/untrusted-data.js');
/**
 * vision-organ.js —— 程序器官 v1：屏幕流 → 变化检测 → 关键帧 → 语言化滚动摘要
 *
 * 设计依据：docs/实时旁观-程序器官设计.md
 *   像素只进「器官」，不进主对话上下文；LLM 永远只读语言化摘要（这是 token 能省下来的原因）。
 *
 * 数据流：
 *   采样 2fps → 缩成 32x18 灰度签名 → 帧差 + 直方图变化检测 → 只留"变了"的关键帧
 *   → 每帧压成一句中文状态 → 环形缓冲（默认最近 120 秒）→ 三个工具 / 被动注入 / 主动开口门控
 *
 * 这个文件不依赖 DOM / electron，所有外部能力都靠注入，方便在 node 里单测：
 *   capture()    -> Promise<base64 jpeg>
 *   signature(base64) -> Promise<Float32Array(W*H)>   小型灰度图签名
 *   summarize({ base64, ts, kind, mad, histDist, prevText }) -> Promise<string|null>
 *                 多模态摘要器；返回 null 或抛错 = 不可用 → 自动降级
 *   isBusy()     -> boolean      （TTS 正在说话时不做主动开口）
 *   now()        -> number       毫秒时间戳（测试可注入）
 *
 * 降级（没有多模态模型时）：不采样 2fps，改成每 fallbackIntervalMs（默认 30s）留一帧 + 时间戳，
 * 摘要就是"HH:MM:SS 画面（变化/静止）"，保证三个工具和滚动缓冲照常工作，功能不炸。
 */

const DEFAULTS = {
    sampleIntervalMs: 500,        // 2fps
    // 静默/省钱模式（global.__petQuiet）下的采样间隔。2026-11-22 实测：
    // 2fps 全屏截图让皮套内容帧率 81.6→52.1fps、p99 26→195ms、长帧 0.5%→5%；
    // 降到 0.5fps 后回到 78.2fps / p99 49ms / 长帧 1.3%，而看剧的关键帧摘要
    // 本来就是 ≥15s 一个点，0.5fps 采样完全够用。非静默模式保持 2fps 不变。
    quietSampleIntervalMs: 2000,
    gridW: 32,
    gridH: 18,
    diffThreshold: 5.5,           // 平均绝对差（0-255 灰度）
    histThreshold: 0.10,          // 8 档亮度直方图 L1/2 距离
    sceneThreshold: 16,           // 明显换场景
    sceneHistThreshold: 0.28,
    consecutiveFrames: 2,         // 连续两帧都在变才算关键帧（滤掉鼠标抖动/逐帧动画）
    // ⚠ 这两个间隔直接决定花多少钱。原来 2000/800 意味着看一集 45 分钟的剧要调
    // 1300+ 次多模态模型 —— 又慢又贵，而且剧情摘要根本不需要 2 秒粒度。
    // 「一起看」需要的是「现在演到哪了」，15 秒一个点完全够。
    keyframeMinGapMs: 15000,      // 两个关键帧最短间隔
    sceneMinGapMs: 6000,          // 场景切换可以急一点
    quietKeyframeMs: 45000,       // 画面不动也补一条"仍在看"的锚点
    visionBudgetPerHour: 220,     // 每小时最多调多少次摘要模型（超过就只留时间戳）
    ringSeconds: 120,
    maxEntries: 240,
    maxFrames: 6,                 // 缓冲里保留几张关键帧图（给 look_now / find_moment）
    // ── 联络表（contact sheet）──
    // 单帧摘要只能看到「此刻」。把最近十几帧拼成一张带时间码的图，一次调用就能看出「这段里发生了什么、
    // 有没有换内容」，比一张一张看更省、更全，也刚好治「切到别的视频她还不知道」。
    sheetCells: 12,               // 一张联络表放几格（4x3）
    sheetCellGapMs: 3000,         // 格与格之间至少隔多久（12 格 ≈ 覆盖最近 36 秒）
    fallbackIntervalMs: 30000,    // 降级：30 秒一帧
    proactiveEnabled: true,
    proactiveMinGapMs: 90000,     // 换镜头时：两次主动开口至少隔 90 秒
    proactiveChangeGapMs: 150000, // 只是画面变化时：至少隔 150 秒（否则会碎碎念）
    summaryMaxChars: 72,
    tokenCharsPerToken: 1.5,      // 中文粗估：1.5 字 ≈ 1 token
};

const pad = (n) => String(n).padStart(2, '0');
function clockOf(ms) {
    const d = new Date(ms);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

class VisionOrgan {
    constructor(options = {}) {
        const cfg = Object.assign({}, DEFAULTS, options.config || {});
        this.cfg = cfg;
        this.capture = typeof options.capture === 'function' ? options.capture : null;
        this.signature = typeof options.signature === 'function' ? options.signature : null;
        this.summarize = typeof options.summarize === 'function' ? options.summarize : null;
        this.isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;
        this.isQuiet = typeof options.isQuiet === 'function' ? options.isQuiet : () => false;
        this.onKeyframe = typeof options.onKeyframe === 'function' ? options.onKeyframe : null;
        this.onProactive = typeof options.onProactive === 'function' ? options.onProactive : null;
        this.log = typeof options.log === 'function' ? options.log : () => {};
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();

        this.entries = [];            // 环形缓冲：{ t, clock, kind, mad, histDist, text, frameId }
        this.frames = new Map();      // frameId -> base64（只留最近 maxFrames 张）
        this.sheet = [];              // [{ts, clock, base64}] 联络表的原料
        this._lastSheetAt = 0;
        this._frameSeq = 0;
        this._timer = null;
        this._lastSignature = null;
        this._lastCaptureAt = 0;
        this._lastKeyframeAt = 0;
        this._lastSummaryText = '';
        this._lastProactiveAt = 0;
        this._streak = 0;             // 连续变化帧数
        this._running = false;
        this._inFlight = false;
        this._summarizerDead = false; // 摘要器失败一次就不再试，直到 resetSummarizer()
        this._fallbackMode = false;   // 是否已经降级
        this._stats = {
            startedAt: null, samples: 0, keyframes: 0, summaries: 0, fallbackEntries: 0,
            proactiveCount: 0, summarizerErrors: 0, captureErrors: 0, dropped: 0,
            lastSampleAt: 0, lastKeyframeAt: 0, lastSummaryAt: 0,
        };
    }

    // ── 生命周期 ───────────────────────────────────────────────────────────
    start() {
        if (this._running) return false;
        this._running = true;
        this._stats.startedAt = this.now();
        this._schedule(this.cfg.sampleIntervalMs);
        this.log('[organ] started | interval=' + this.cfg.sampleIntervalMs + 'ms | fallback=' + this._fallbackMode);
        return true;
    }

    stop() {
        this._running = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.log('[organ] stopped');
    }

    get running() { return this._running; }
    get fallbackMode() { return this._fallbackMode; }

    /** 多模态摘要器恢复可用时调用（比如用户后配了视觉模型） */
    resetSummarizer() { this._summarizerDead = false; this._fallbackMode = false; }

    // 降级：没有摘要器 → 固定 30 秒节奏
    _schedule(delay) {
        if (!this._running) return;
        if (this._timer) clearTimeout(this._timer);
        const wait = Math.max(100, this._fallbackMode ? this.cfg.fallbackIntervalMs : (delay || this.cfg.sampleIntervalMs));
        this._timer = setTimeout(() => { this._tick().catch(() => {}); }, wait);
        if (this._timer.unref) this._timer.unref();
    }

    /** 当前该用的采样间隔：静默/省钱模式降频（2026-11-22 性能实测，见 DEFAULTS 注释） */
    _sampleIntervalMs() {
        try {
            if (typeof this.isQuiet === 'function' && this.isQuiet()) {
                const quiet = Number(this.cfg.quietSampleIntervalMs);
                if (Number.isFinite(quiet) && quiet > 0) return quiet;
            }
        } catch (e) { /* isQuiet 读不到就按正常模式 */ }
        return this.cfg.sampleIntervalMs;
    }

    async _tick() {
        if (!this._running) return;
        // 降级自动复活（2026-11-10 审计 #5）：曾经一次失败就永久降级，现在每 5 分钟
        // 给摘要器一次重新证明自己的机会（网络抖动/额度恢复后能自己回来）。
        if (this._summarizerDead && this.now() - (this._lastReviveAt || 0) > 300000) {
            this._lastReviveAt = this.now();
            this._summarizerFails = 0;
            this.resetSummarizer();
            this.log('[organ] 尝试复活摘要器（5 分钟一次探测）');
        }
        const baseDelay = this._sampleIntervalMs();
        if (this._inFlight) { this._stats.dropped += 1; this._schedule(baseDelay); return; }
        this._inFlight = true;
        let nextDelay = baseDelay;
        try {
            await this.sampleOnce();
        } catch (error) {
            this._stats.captureErrors += 1;
            this.log('[organ] sample failed: ' + String(error && error.message || error));
            // 连续截图失败 → 拉长间隔，别把主线程拖死
            nextDelay = Math.min(5000, (nextDelay || baseDelay) * 2);
        } finally {
            this._inFlight = false;
            this._schedule(nextDelay);
        }
    }

    // ── 采样一步（测试也直接调它）─────────────────────────────────────────
    async sampleOnce() {
        if (!this.capture) return null;
        const ts = this.now();
        const base64 = await this.capture();
        if (!base64) return null;
        this._stats.samples += 1;
        this._stats.lastSampleAt = ts;

        // 攒联络表用的帧：按间距抽，不要 2fps 全塞
        try { this._pushSheet(ts, base64); } catch (e) { try { __silentAudit.audit('vision-organ.js:158', e); } catch (e2) {} }
        let sig = null;
        if (this.signature && !this._fallbackMode) {
            try { sig = await this.signature(base64); } catch (_) { sig = null; }
        }

        // 降级模式：不看帧差，固定节奏留锚点
        if (this._fallbackMode || !sig) {
            const since = ts - this._lastKeyframeAt;
            if (since >= this.cfg.fallbackIntervalMs) {
                this._lastKeyframeAt = ts;
                return await this._record(ts, { kind: 'fallback', mad: 0, histDist: 0, base64 });
            }
            return null;
        }

        const cmp = compareSignatures(this._lastSignature, sig, this.cfg);
        this._lastSignature = sig;

        const changed = cmp.mad >= this.cfg.diffThreshold || cmp.histDist >= this.cfg.histThreshold;
        const scene = cmp.mad >= this.cfg.sceneThreshold || cmp.histDist >= this.cfg.sceneHistThreshold;
        this._streak = changed ? this._streak + 1 : 0;

        const gap = ts - this._lastKeyframeAt;
        const enoughStreak = scene || this._streak >= this.cfg.consecutiveFrames;
        const minGap = scene ? this.cfg.sceneMinGapMs : this.cfg.keyframeMinGapMs;
        if (enoughStreak && gap >= minGap) {
            this._lastKeyframeAt = ts;
            return await this._record(ts, { kind: scene ? 'scene' : 'change', mad: cmp.mad, histDist: cmp.histDist, base64 });
        }

        // 画面一直不动：补一条"还在看"的锚点，保证滚动摘要不至于空窗太久
        if (!changed && gap >= this.cfg.quietKeyframeMs) {
            this._lastKeyframeAt = ts;
            return await this._record(ts, { kind: 'quiet', mad: cmp.mad, histDist: cmp.histDist, base64 });
        }
        return null;
    }

    /** 攒一张联络表的原料：按间距抽帧，保留最近 sheetCells 张 */
    _pushSheet(ts, base64) {
        if (!base64) return;
        if (ts - this._lastSheetAt < this.cfg.sheetCellGapMs) return;
        this._lastSheetAt = ts;
        this.sheet.push({ ts, clock: clockOf(ts), base64 });
        while (this.sheet.length > this.cfg.sheetCells) this.sheet.shift();
    }

    /** 给 look_now 之类的单帧用 */
    latestFrame() {
        const last = this.sheet[this.sheet.length - 1];
        return last ? last.base64 : null;
    }

    // 把一帧变成一条语言化摘要写进环形缓冲
    async _record(ts, info) {
        // 游戏事件钩子（主播陪玩）：关键帧先交给宿主做本地 OCR（免费），再走正常记录。
        // 放在静默短路之前——OCR 零成本，静默期也攒事件；开不开口由宿主的静默闸门管。
        try {
            if (typeof this.gameHook === 'function' && info && info.base64 && info.kind !== 'fallback') {
                Promise.resolve(this.gameHook(info)).catch(() => {});
            }
        } catch (e) { try { __silentAudit.audit('vision-organ.js:220', e); } catch (e2) {} }
        // 省钱模式：静默时不调多模态模型（一次调用=一次钱），也不写摘要。
        try { if (typeof this.isQuiet === 'function' && this.isQuiet()) return null; } catch (e) { try { __silentAudit.audit('vision-organ.js:222', e); } catch (e2) {} }
        // 带上联络表：让摘要器一次看一段，而不是一帧
        const infoWithSheet = Object.assign({}, info, {
            sheet: (this.sheet || []).slice(),
            sheetKind: info.kind,
        });
        const text = await this._summarizeFrame(ts, infoWithSheet);
        if (!text) return null;
        const entry = {
            t: ts, clock: clockOf(ts), kind: info.kind,
            mad: +info.mad.toFixed(2), histDist: +info.histDist.toFixed(3),
            text: String(text).slice(0, this.cfg.summaryMaxChars * 2),
        };
        // 和上一条一模一样就不重复写（心跳锚点除外）
        if (entry.kind !== 'quiet' && entry.text === this._lastSummaryText) {
            this._stats.dropped += 1;
            return null;
        }
        this._lastSummaryText = entry.text;
        if (info.base64) {
            const frameId = 'f' + (++this._frameSeq);
            this.frames.set(frameId, info.base64);
            entry.frameId = frameId;
            while (this.frames.size > this.cfg.maxFrames) this.frames.delete(this.frames.keys().next().value);
        }
        this.entries.push(entry);
        this._stats.keyframes += 1;
        this._stats.lastKeyframeAt = ts;
        this._trim(ts);
        if (typeof this.onKeyframe === 'function') { try { this.onKeyframe(entry, this); } catch (_) { try { __silentAudit.audit('vision-organ.js:251', _); } catch (e2) {} } }
        return entry;
    }

    async _summarizeFrame(ts, info) {
        if (this.summarize && !this._summarizerDead) {
            try {
                const text = await this.summarize({
                    base64: info.base64, ts, kind: info.kind, mad: info.mad, histDist: info.histDist,
                    prevText: this._lastSummaryText, clock: clockOf(ts),
                    sheet: info.sheet || [],        // 联络表原料（[{clock, base64}]）
                    sheetKind: info.sheetKind || info.kind,
                });
                if (text && String(text).trim()) {
                    this._summarizerFails = 0;   // 成功即清零（连续失败才降级）
                    this._stats.summaries += 1;
                    this._stats.lastSummaryAt = ts;
                    return String(text).trim();
                }
                // 摘要器返回空：当成不可用，走降级
                throw new Error('empty summary');
            } catch (error) {
                this._stats.summarizerErrors += 1;
                const msg = String(error && error.message || error);
                // ⚠ 2026-11-10 审计抓到（高危）：原来**一次失败就永久降级** ——
                //   `_summarizerDead=true` 再也不复位（`resetSummarizer()` 全库无人调用），
                //   而且 `_fallbackMode=true` 让 signature 也不再算，状态机/关键帧全失真。
                //   单次网络抖动或「本小时预算用尽」就会让她整个进程生命周期只说「HH:MM:SS 画面」。
                //   现在分三档：
                //     ① 预算用完 → 只是暂停（下小时恢复），**不置 dead**
                //     ② 连续 <3 次失败 → 只记日志，继续尝试
                //     ③ 连续 ≥3 次 → 才降级（并且 setup 里有定时复活）
                if (/预算已用完|budget/i.test(msg)) {
                    this.log('[organ] 本小时摘要预算用尽，暂停摘要（下小时自动恢复，不降级）');
                    return null;
                }
                this._summarizerFails = (this._summarizerFails || 0) + 1;
                if (this._summarizerFails >= 3) {
                    this._summarizerDead = true;
                    this._fallbackMode = true;
                    this.log('[organ] 摘要器连续 ' + this._summarizerFails + ' 次失败，降级为 30 秒一帧 + 时间戳：' + msg);
                } else {
                    this.log('[organ] 摘要失败（第 ' + this._summarizerFails + ' 次，未降级）：' + msg);
                }
            }
        }
        // ⚠ 2026-11-10 回归审计抓到：这行原来在 catch 之后**无条件**执行 ——
        //   于是第 1 次网络抖动时，日志写着「未降级」，全局 `_fallbackMode` 却已经是 true；
        //   而 sampleOnce 一旦看到它为真就**不再算 signature**，_record 永远走 30 秒一帧，
        //   shouldProactivelySpeak 直接 false —— 等于一次抖动永久残废（我上一轮只修了 half）。
        //   现在：只有「根本没有摘要器」或「已连续失败 ≥3 次（_summarizerDead）」才置全局降级；
        //   单次失败只让**这一帧**用 fallbackText，下一帧照常重试。
        if (!this.summarize || this._summarizerDead) {
            this._fallbackMode = true;
        }
        this._stats.fallbackEntries += 1;
        return this._fallbackText(ts, info);
    }

    // 降级摘要：只有时间戳 + 画面状态（这是任务允许的兜底）
    _fallbackText(ts, info) {
        const state = info.kind === 'scene' ? '画面大幅变化'
            : info.kind === 'change' ? '画面有变化'
            : info.kind === 'quiet' ? '画面基本静止' : '画面';
        return clockOf(ts) + ' ' + state;
    }

    _trim(now) {
        const cutoff = now - this.cfg.ringSeconds * 1000;
        while (this.entries.length > 0 && this.entries[0].t < cutoff) this.entries.shift();
        while (this.entries.length > this.cfg.maxEntries) this.entries.shift();
        // 帧缓存只保留仍在缓冲里的
        const alive = new Set(this.entries.map(e => e.frameId).filter(Boolean));
        for (const id of [...this.frames.keys()]) if (!alive.has(id)) this.frames.delete(id);
    }

    // ── 三个工具 ───────────────────────────────────────────────────────────
    /** look_now()：当前一句 + 可选一帧 */
    lookNow() {
        // ⚠ 2026-11-10 回归审计：wake() 塞进来的内部记录（internal:true）不能当「她看到的内容」。
        //   text 取最后一条**非内部**摘要；帧取最后一条**有帧**的记录（wake 的帧也要能拿到）。
        let textEntry = null;
        for (let i = this.entries.length - 1; i >= 0; i -= 1) {
            const e = this.entries[i];
            if (e && !e.internal) { textEntry = e; break; }
        }
        let frameEntry = null;
        for (let i = this.entries.length - 1; i >= 0; i -= 1) {
            const e = this.entries[i];
            if (e && e.frameId) { frameEntry = e; break; }
        }
        const last = this.entries[this.entries.length - 1] || null;
        return {
            text: textEntry ? textEntry.text : (frameEntry ? '（刚看了一眼，还没有摘要）' : '（还没看到画面）'),
            clock: last ? last.clock : clockOf(this.now()),
            kind: textEntry ? textEntry.kind : (frameEntry ? frameEntry.kind : 'none'),
            frameId: frameEntry ? frameEntry.frameId : null,
            frame: frameEntry ? this.frames.get(frameEntry.frameId) || null : null,
            ageSeconds: frameEntry ? Math.round((this.now() - frameEntry.t) / 1000) : null,
        };
    }

    /**
     * 帧唤醒（2026-11-10 三十八轮）：静默期/省钱模式下立刻拿一帧真画面。
     *
     * 为什么需要：静默期 `_record` 为了省 API 在 `isQuiet` 处直接短路 ——
     * entries 不更新、frames 也不存。于是 `lookNow()` 在她最需要的时候
     * （用户刚说「看一眼屏幕」）返回「（还没看到画面）」，frame=null。
     * 实测日志：`[watch-screen] 静默期：进入 idle 的自动动作跳过` 之后
     * look_now 永远拿不到图——读屏链看着像坏的，实际是省钱闸门关掉了感知。
     *
     * 语义：**只采帧、只入缓存、不调摘要模型**（零 API 成本），
     * 并在环形缓冲里留一条 kind='wake' 的锚点，让 lookNow/recall_last 有迹可循。
     */
    async wake(reason = 'look_now') {
        if (!this.capture) return null;
        const ts = this.now();
        const base64 = await this.capture();
        if (!base64) return null;
        this._stats.samples += 1;
        this._stats.lastSampleAt = ts;
        try { this._pushSheet(ts, base64); } catch (e) { try { __silentAudit.audit('vision-organ.js:wake-sheet', e); } catch (e2) {} }

        const frameId = 'w' + (++this._frameSeq);
        this.frames.set(frameId, base64);
        while (this.frames.size > this.cfg.maxFrames) this.frames.delete(this.frames.keys().next().value);

        // 让下一帧重新建基线：静默期可能已经很久没比较过画面了，
        // 拿旧签名比会误判成「巨变」。
        this._lastSignature = null;
        this._lastKeyframeAt = ts;

        const entry = {
            t: ts, clock: clockOf(ts), kind: 'wake', mad: 0, histDist: 0,
            // ⚠ 2026-11-10 回归审计：原来这里放的是**内部调试文案**，而 lookNow() 优先返回
            //   最后一条 text → 用户说「看一眼屏幕」，她拿到的话术就是「[wake] …静默期强制采了一帧」。
            //   现在标记 internal，lookNow/describeWindow/recallLast 都会跳过它（帧照样进缓存）。
            text: '刚看了一眼屏幕',
            internal: true,
            frameId,
        };
        this.entries.push(entry);
        this._trim(ts);
        this.log('[organ] wake | reason=' + reason + ' | 帧已入缓存（未调摘要模型）');
        return { entry, base64 };
    }

    /** recall_last(seconds)：纯文本摘要（默认最近 60 秒） */
    recallLast(seconds = 60) {
        const span = Math.max(5, Math.min(this.cfg.ringSeconds, Number(seconds) || 60));
        const cutoff = this.now() - span * 1000;
        const rows = this.entries.filter(e => e.t >= cutoff && !e.internal);   // 内部记录（wake 等）不进摘要
        if (rows.length === 0) return { text: '（最近 ' + span + ' 秒没有新的画面摘要）', count: 0, seconds: span, tokens: 8 };
        const lines = rows.map(e => e.clock + ' ' + e.text);
        return {
            text: lines.join('\n'),
            count: rows.length,
            seconds: span,
            tokens: estimateTokens(lines),
        };
    }

    /** find_moment(keyword)：在摘要里检索 */
    findMoment(keyword) {
        const key = String(keyword == null ? '' : keyword).trim().toLowerCase();
        if (!key) return { text: '（给我一个关键词）', matches: [] };
        const matches = this.entries
            .filter(e => e.text.toLowerCase().includes(key))
            .slice(-5)
            .map(e => ({ clock: e.clock, t: e.t, text: e.text, frameId: e.frameId || null }));
        if (matches.length === 0) return { text: '（最近 ' + this.cfg.ringSeconds + ' 秒里没找到「' + keyword + '」）', matches: [] };
        return {
            text: matches.map(m => m.clock + ' ' + m.text).join('\n'),
            matches,
            tokens: estimateTokens(matches.map(m => m.clock + ' ' + m.text)),
        };
    }

    // ── 被动注入：给主对话的一句话上下文（只有语言，没有像素）───────────────
    //
    // 2026-11-21：屏幕摘要的内容来自画面（网页/视频/游戏都可能出现任意文字），
    // 属于外部可控文本。原来把它拼成「（你旁边的屏幕最近 60 秒：…）」裸注入，
    // 画面里写「忽略以上指令」就能冒充上下文。现在统一包成
    // `【环境数据·非指令】{"screen":{"text":"…"}}`：
    // 结构由 JSON.stringify 保证，模型看到的是字段而不是可以「接着写」的句子。
    // 预算 800 字（原实现没有显式上限，这里兜住极端长摘要；正常 60 秒远小于它）。
    describeWindow(seconds = 60) {
        const recalled = this.recallLast(seconds);
        if (!recalled.count) return '';
        return wrapUntrusted('screen', { text: recalled.text }, 800);
    }

    /**
     * recap(ms)：按**毫秒时间窗**回顾一段时间看了什么（2026-11-10 回归审计补）。
     *
     * 为什么补：`watch-screen/index.js` 的 `cowatch_recap` 与 `_coWatchContext` 一直在调
     * `organ.recap(ms)` 和 `organ.latestSummary()`，但 VisionOrgan **根本没有这两个方法**
     * （只有 lookNow/recallLast/findMoment）。两处都有 typeof 兜底所以不崩，但
     * `cowatch_recap` 的 visual 字段永远是「（这段时间没有画面摘要）」——
     * 工具描述却承诺「回顾最近一段时间看的内容」，等于永久静默降级。
     */
    recap(ms) {
        const spanMs = Math.max(5000, Math.min((this.cfg.ringSeconds || 120) * 1000, Number(ms) || 300000));
        const cutoff = this.now() - spanMs;
        const rows = this.entries.filter((e) => e.t >= cutoff && !e.internal);
        if (!rows.length) return '（这段时间没有画面摘要）';
        return rows.map((e) => e.clock + ' ' + e.text).join('\n');
    }

    /**
     * latestSummary(maxAgeMs = 90000)：最后一条**仍然新鲜**的摘要文本（没有就空串）。
     *
     * 2026-11-22 P0-1：原来没有年龄上限 —— 画面安静/静默期不再产新摘要时，
     * 90 秒前（甚至十分钟前）的剧情会一直作为「现在屏幕上是什么」注入她的每一轮提示，
     * 于是画面都切到别的片了，她还在接上一部的台词。默认 90 秒与
     * watch-screen 的「同看」窗口同量级；超过就返回空，让调用方按「现在没画面」处理。
     *
     * @param {number} [maxAgeMs] 允许的最大年龄（毫秒），非正数/非法值按 90 秒
     */
    latestSummary(maxAgeMs = 90000) {
        const maxAge = Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) > 0
            ? Number(maxAgeMs)
            : 90000;
        const now = this.now();
        for (let i = this.entries.length - 1; i >= 0; i -= 1) {
            const e = this.entries[i];
            if (!e || !e.text || e.internal) continue;
            const t = Number(e.t);
            if (!Number.isFinite(t) || now - t > maxAge) continue;   // 过期就当没有
            return String(e.text);
        }
        return '';
    }

    // ── 主动开口门控（对应 Vinci2 的"何时说"）──────────────────────────────
    shouldProactivelySpeak(entry = null) {
        if (!this.cfg.proactiveEnabled) return false;
        if (this._fallbackMode) return false;                 // 降级模式没有摘要可评论
        // 只对 scene 开口是个坑：看剧时大量是「人物在同一个房间里说话」这种 change，
        // 一整集可能一次换镜头都没有，于是她从头到尾不说话。
        // 所以 scene 和 change 都允许，但 change 的间隔更长（画面变化碎，别碎碎念）。
        if (!entry) return false;
        if (entry.kind !== 'scene' && entry.kind !== 'change') return false;
        const now = this.now();
        const gap = entry.kind === 'scene' ? this.cfg.proactiveMinGapMs : this.cfg.proactiveChangeGapMs;
        if (now - this._lastProactiveAt < gap) return false;
        if (this.isBusy()) return false;                      // 正在说话/播 TTS 就别插嘴
        return true;
    }

    markSpoke() { this._lastProactiveAt = this.now(); this._stats.proactiveCount += 1; }

    /** 主动开口的统一入口：门控通过才回调 */
    async maybeSpeak(entry) {
        if (!this.shouldProactivelySpeak(entry)) return false;
        this.markSpoke();
        if (typeof this.onProactive === 'function') {
            try { await this.onProactive(entry, this); } catch (error) { this.log('[organ] proactive failed: ' + String(error && error.message || error)); }
        }
        return true;
    }

    // ── 统计 ───────────────────────────────────────────────────────────────
    stats() {
        const now = this.now();
        // startedAt 可能是 0（测试时钟从 0 开始），所以用 null 判断"还没开始"
        const since = this._stats.startedAt != null ? this._stats.startedAt : now;
        const spanSeconds = Math.max(1, Math.round((now - since) / 1000));
        const recent = this.entries.filter(e => e.t >= now - 60000);
        const recentLines = recent.map(e => e.clock + ' ' + e.text);
        return {
            running: this._running,
            fallbackMode: this._fallbackMode,
            samples: this._stats.samples,
            keyframes: this._stats.keyframes,
            summaries: this._stats.summaries,
            fallbackEntries: this._stats.fallbackEntries,
            keyframeRatePerSec: +(this._stats.keyframes / spanSeconds).toFixed(3),
            spanSeconds,
            proactiveCount: this._stats.proactiveCount,
            captureErrors: this._stats.captureErrors,
            summarizerErrors: this._stats.summarizerErrors,
            dropped: this._stats.dropped,
            bufferedEntries: this.entries.length,
            bufferedSeconds: this.entries.length ? Math.round((now - this.entries[0].t) / 1000) : 0,
            tokensLast60s: estimateTokens(recentLines),
            charsLast60s: recentLines.join('\n').length,
        };
    }

    /** 测试/隐私用：清空所有画面与摘要 */
    clear() {
        this.entries = [];
        this.frames.clear();
        this._lastSummaryText = '';
        this._lastSignature = null;
    }
}

// 32x18 灰度签名对比：平均绝对差 + 8 档亮度直方图 L1/2
function compareSignatures(prev, next, cfg = DEFAULTS) {
    if (!prev || !next || prev.length !== next.length) return { mad: 255, histDist: 1, first: true };
    let sum = 0;
    for (let i = 0; i < prev.length; i += 1) sum += Math.abs(prev[i] - next[i]);
    const mad = sum / prev.length;
    const bins = 8, h1 = new Array(bins).fill(0), h2 = new Array(bins).fill(0);
    for (let i = 0; i < prev.length; i += 1) {
        h1[Math.min(bins - 1, Math.max(0, Math.floor(prev[i] / 256 * bins)))] += 1;
        h2[Math.min(bins - 1, Math.max(0, Math.floor(next[i] / 256 * bins)))] += 1;
    }
    let l1 = 0;
    for (let i = 0; i < bins; i += 1) l1 += Math.abs(h1[i] / prev.length - h2[i] / next.length);
    return { mad: +mad.toFixed(2), histDist: +(l1 / 2).toFixed(3), first: false };
}

// 中文粗估 token：字 / tokenCharsPerToken + 每行固定开销
function estimateTokens(lines, charsPerToken = DEFAULTS.tokenCharsPerToken) {
    if (!lines || lines.length === 0) return 0;
    let chars = 0;
    for (const line of lines) chars += String(line).length;
    return Math.ceil(chars / charsPerToken) + lines.length * 2;
}

module.exports = { VisionOrgan, DEFAULTS, compareSignatures, estimateTokens, clockOf };
