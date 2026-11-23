// tts-playback-engine.js - TTS播放引擎
// 职责：音频播放、文本动画、字幕显示、嘴形控制、情绪同步的完整实现

const __silentAudit = require('../core/silent-audit.js');
const { eventBus } = require('../core/event-bus.js');
const { Events } = require('../core/events.js');
const { shouldUseLegacyEmotionLogic } = require('../avatar/motion-mode.js');
const { logToTerminal } = require('../api-utils.js');

// 流式回退/失败必须**进 runtime.log**（2026-11-21）：
// 原来这些只走 console.warn，DevTools 一关就没人知道 —— 「日志里没有回退」不等于没回退。
// 限频 3s：同一轮多段文本只记一次，避免刷屏（语言上仍是「每次异常都会发声一次」）。
let __ttsStreamIssueAt = 0;
function logStreamIssue(msg) {
    const text = '[tts] stream ' + msg;
    try { console.warn(text); } catch (_) { }
    const now = Date.now();
    if (now - __ttsStreamIssueAt < 3000) return;
    __ttsStreamIssueAt = now;
    try { logToTerminal('warn', text); } catch (_) { }
}

// ── 自听闸：她说话时让「一起看」的耳朵暂停采集（2026-11-21）────────────────
// 缺陷：audio-loop 的 POST /pause 全仓没有调用者（服务端 :1001 的 paused 事件永远
//       不被置位），她自己的声音被当成剧里对白喂回模型 → 自听/自问自答。
// 语义（先读了 audio_loop_server.py:429-435 才接线）：POST /pause {"on":true|false}
//       → service.paused.set()/clear()，_capture_loop 在 paused 时丢弃回环音频。
// 接线点：playAudio 的 onplay（真的出声才暂停）→ true；onended/onerror/stop → false。
// 容错：服务不在时 fetch 失败一律吞掉；连续 3 次失败进入 60s 熔断，日志每分钟最多一条，
//       绝不因为「一起看没开」而刷屏或影响 TTS。
const AUDIO_LOOP_PAUSE_URL = 'http://127.0.0.1:1001/pause';
const AUDIO_LOOP_RELEASE_MS = 700;          // 段间短停不来回切（正常句间 300ms 左右的空隙）
const AUDIO_LOOP_FAIL_COOLDOWN_MS = 60000;
const AUDIO_LOOP_WARN_INTERVAL_MS = 60000;

const _loopPause = {
    desired: false,
    releaseTimer: null,
    chain: Promise.resolve(),
    failStreak: 0,
    nextTryAt: 0,
    lastWarnAt: 0,
    calls: 0,
    ok: 0,
    fail: 0,
};

function _publishLoopPauseStats() {
    try {
        if (typeof globalThis !== 'undefined') {
            globalThis.__audioLoopPauseStats = {
                calls: _loopPause.calls, ok: _loopPause.ok, fail: _loopPause.fail,
                failStreak: _loopPause.failStreak, paused: _loopPause.desired,
                circuitOpen: Date.now() < _loopPause.nextTryAt,
            };
        }
    } catch (_) { /* 观测失败不影响播放 */ }
}

function _loopPauseWarnOnce(msg) {
    const now = Date.now();
    if (now - _loopPause.lastWarnAt < AUDIO_LOOP_WARN_INTERVAL_MS) return;
    _loopPause.lastWarnAt = now;
    try { logToTerminal('warn', msg); } catch (_) { }
}

function _loopPauseMarkOk(on) {
    _loopPause.ok += 1;
    if (on) { _loopPause.failStreak = 0; _loopPause.nextTryAt = 0; }
}

function _loopPauseMarkFail(on, err) {
    _loopPause.fail += 1;
    if (on) {
        _loopPause.failStreak += 1;
        if (_loopPause.failStreak === 3) {
            _loopPause.nextTryAt = Date.now() + AUDIO_LOOP_FAIL_COOLDOWN_MS;
            _loopPauseWarnOnce('[tts] audio-loop /pause 不可用（' + ((err && err.message) || err)
                + '）→ 60s 内不再尝试；她说话时「一起看」可能听到自己');
        }
    }
}

// 传输选择：Electron 渲染进程优先 Node http。
// 原因（实测约束）：页面是 file:// 来源，`fetch` 带 Content-Type: application/json 会触发
// CORS 预检 OPTIONS，而 audio-loop 只实现了 do_POST（没有 OPTIONS）→ 预检 501，请求根本
// 到不了 /pause。petbody driver.js 用 http.request 走同一路径是可靠的，这里保持一致。
function _preferNodeHttp() {
    try {
        if (typeof require !== 'function') return false;
        const p = (typeof process !== 'undefined' && process && process.versions)
            || (typeof window !== 'undefined' && window && window.process && window.process.versions);
        return !!(p && p.electron);
    } catch (_) {
        return false;
    }
}

function _loopPausePostHttp(on) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
        try {
            const http = require('http');
            const payload = JSON.stringify({ on: !!on, source: 'tts-playback' });
            const req = http.request({
                host: '127.0.0.1', port: 1001, path: '/pause', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
                timeout: 450,
            }, (res) => {
                const ok = res.statusCode >= 200 && res.statusCode < 400;
                try { res.resume(); } catch (_) { }
                if (ok) _loopPauseMarkOk(on);
                else _loopPauseMarkFail(on, new Error('HTTP ' + res.statusCode));
                finish(ok);
            });
            req.on('error', (e) => { _loopPauseMarkFail(on, e); finish(false); });
            req.on('timeout', () => {
                try { req.destroy(); } catch (_) { }
                _loopPauseMarkFail(on, new Error('timeout 450ms'));
                finish(false);
            });
            req.write(payload);
            req.end();
        } catch (e) {
            _loopPauseMarkFail(on, e);
            finish(false);
        }
    }).finally(() => _publishLoopPauseStats());
}

function _loopPausePostFetch(on) {
    if (typeof fetch !== 'function') return Promise.resolve(false);
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => { try { ac.abort(); } catch (_) { } }, 450) : null;
    let req;
    try {
        req = fetch(AUDIO_LOOP_PAUSE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ on: !!on, source: 'tts-playback' }),
            signal: ac ? ac.signal : undefined,
        });
    } catch (err) {
        if (timer) clearTimeout(timer);
        req = Promise.reject(err);
    }
    return req
        .then((r) => {
            if (!r || r.ok === false || (typeof r.status === 'number' && r.status >= 400)) {
                throw new Error('audio-loop /pause HTTP ' + (r && r.status));
            }
            _loopPauseMarkOk(on);
            return true;
        })
        .catch((err) => {
            _loopPauseMarkFail(on, err);
            return false;
        })
        .finally(() => {
            if (timer) clearTimeout(timer);
            _publishLoopPauseStats();
        });
}

function _loopPausePost(on) {
    // 熔断只拦「暂停」：恢复一定要发，否则服务重启后回环可能永远停在 paused。
    // 没有可用传输时也不报错 —— 服务不在/纯 Node 环境都不该影响播放。
    if (on && _loopPause.failStreak >= 3 && Date.now() < _loopPause.nextTryAt) {
        return Promise.resolve(false);
    }
    const useHttp = _preferNodeHttp();
    if (!useHttp && typeof fetch !== 'function') return Promise.resolve(false);
    _loopPause.calls += 1;
    return useHttp ? _loopPausePostHttp(on) : _loopPausePostFetch(on);
}

function setAudioLoopPaused(on, opts = {}) {
    const want = !!on;
    if (want) {
        // 取消尚未发出的「恢复」：下一段马上开始，别让回环在句间被重新打开
        if (_loopPause.releaseTimer) {
            try { clearTimeout(_loopPause.releaseTimer); } catch (_) { }
            _loopPause.releaseTimer = null;
        }
        if (_loopPause.desired) return;
        _loopPause.desired = true;
        _loopPause.chain = _loopPause.chain.then(() => _loopPausePost(true));
        _publishLoopPauseStats();
        return;
    }
    if (!_loopPause.desired) return;
    const release = () => {
        _loopPause.releaseTimer = null;
        if (!_loopPause.desired) return;
        _loopPause.desired = false;
        _loopPause.chain = _loopPause.chain.then(() => _loopPausePost(false));
        _publishLoopPauseStats();
    };
    if (opts.immediate) {
        if (_loopPause.releaseTimer) {
            try { clearTimeout(_loopPause.releaseTimer); } catch (_) { }
            _loopPause.releaseTimer = null;
        }
        release();
        return;
    }
    if (_loopPause.releaseTimer) {
        try { clearTimeout(_loopPause.releaseTimer); } catch (_) { }
    }
    const t = setTimeout(release, AUDIO_LOOP_RELEASE_MS);
    if (t && typeof t.unref === 'function') t.unref();
    _loopPause.releaseTimer = t;
}

// 供探针/排障读计数
function getAudioLoopPauseStats() {
    return {
        calls: _loopPause.calls, ok: _loopPause.ok, fail: _loopPause.fail,
        failStreak: _loopPause.failStreak, paused: _loopPause.desired,
        circuitOpen: Date.now() < _loopPause.nextTryAt,
    };
}

// playAudio 返回契约（2026-11-21 根因修复）：**永远** resolve 一个对象。
// 原实现有多处裸 `return` / 裸 `resolve()`，调用方（tts-processor 的 playNext）裸读
// `result.completed` → undefined.completed 抛 TypeError → 播放线程不再排下一拍
// （抢话后永久死；0 字节 200 响应也会触发）。
// status 是唯一权威；completed/error/stopped 是兼容别名（旧调用方如
// scripts/test-pmx-runtime.cjs 读 `result.error`，scripts 不改也不会变成假通过）。
function playResult(status, reason) {
    const out = {
        status,
        completed: status === 'completed',
        error: status === 'error',
        stopped: status === 'stopped',
    };
    if (reason) out.reason = String(reason);
    return out;
}

class TTSPlaybackEngine {
    constructor(config, onAudioDataCallback, onStartCallback, onEndCallback) {
        this.config = config;
        this.onAudioDataCallback = onAudioDataCallback;
        this.onStartCallback = onStartCallback;
        this.onEndCallback = onEndCallback;

        // 音频上下文
        this.audioContext = null;
        this.analyser = null;
        this.dataArray = null;

        // 当前状态
        this.currentAudio = null;
        this.currentAudioUrl = null;
        this.isPlaying = false;
        this.shouldStop = false;
        this.currentAudioResolve = null;

        // 动画和渲染
        this._textAnimInterval = null;
        this._renderFrameId = null;

        // 文本状态
        this.displayedText = '';
        this.currentSegmentText = '';
        // D4（2026-11-22）：当前段已经播到第几个字符。打断时用它算「未播尾巴」——
        //   字幕/口型共用 charDisplayIndex，这里只做只读镜像，不改变播放节奏。
        this._currentCharIndex = 0;

        // 情绪映射器和表情映射器
        this.emotionMapper = null;
        this.expressionMapper = null; 
    }

    // 设置情绪映射器
    setEmotionMapper(emotionMapper) {
        this.emotionMapper = emotionMapper;
    }

    // 设置表情映射器
    setExpressionMapper(expressionMapper) {
        this.expressionMapper = expressionMapper;
        // console.log('TTS播放引擎已设置表情映射器');
    }

    // 初始化音频上下文
    async initAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            // 口型用**时域波形 RMS**（波幅包络），不用频谱。
            // 2026-11-08 用户反馈「嘴动但不对口型」，根因：
            //   原实现 getByteFrequencyData 取前 64 段（≈0-1.7kHz）再求平均——
            //   ① 频谱能量不是瞬时音量，天然滞后；② 只覆盖低半段，齿音/辅音全丢；
            //   ③ 默认 smoothingTimeConstant=0.8 让嘴拖着走。
            // 改时间域波形（getByteTimeDomainData + RMS）：与真实音量同步、全频段都在、无拖尾。
            this.timeDataArray = new Uint8Array(this.analyser.fftSize);
            this.analyser.smoothingTimeConstant = 0;
        }
    }

    // 播放音频并同步文本
    async playAudio(audioBlob, segmentText) {
        if (!audioBlob) return playResult('skipped', 'no-audio');

        // ── 首段流式（改造 2，2026-11-20）────────────────────────────────────
        // request handler 对每轮首段返回 TTSStreamHandle（__ttsStream）。这里先等
        // 「第一块字节」再决定走 MSE 边下边播；超时/取消/不支持 → 无感回退整段 blob，
        // 行为与原实现一致（只多一条 `[tts] stream 回退: <原因>` 日志）。
        let streamHandle = null;
        if (audioBlob.__ttsStream) {
            streamHandle = audioBlob;
            this._streamHandle = streamHandle;   // 先挂上：打断时 stop() 能立即释放 reader
            try {
                await streamHandle.waitFirstChunk();
            } catch (err) {
                this._streamHandle = null;
                if (this.shouldStop || streamHandle.cancelled) {
                    return playResult('stopped', streamHandle.cancelled ? 'stream-cancelled' : 'stopped');
                }
                logStreamIssue('回退: ' + (err && err.message || err));
                let blob = null;
                try { blob = await streamHandle.toBlob(); }
                catch (e2) { logStreamIssue('回退失败: ' + (e2 && e2.message || e2)); }
                if (!blob || this.shouldStop) {
                    if (!blob && !this.shouldStop) {
                        // 0 字节 200 响应（9883 被中断后短窗口内会这样）：必须留痕，不能静默无声
                        this.lastPlayError = 'stream-fallback-empty';
                        logStreamIssue('回退失败: 空响应（0 字节），本段无音频');
                        return playResult('error', 'stream-fallback-empty');
                    }
                    return playResult('stopped', 'stopped');
                }
                audioBlob = blob;
                streamHandle = null;
            }
        }

        let streamMediaSource = null;
        if (streamHandle) {
            try {
                streamMediaSource = new MediaSource();
            } catch (err) {
                logStreamIssue('回退: MediaSource 构造失败: ' + (err && err.message || err));
                let blob = null;
                try { blob = await streamHandle.toBlob(); } catch (_) { }
                this._streamHandle = null;
                streamHandle = null;
                if (!blob || this.shouldStop) {
                    if (!blob && !this.shouldStop) return playResult('error', 'no-media-source-no-blob');
                    return playResult('stopped', 'stopped');
                }
                audioBlob = blob;
            }
        }

        await this.initAudioContext();
        // ⚠ 2026-11-21 口型同源修复：这里**不再**存原始 segmentText。
        //   原始文本可能带 <emotion:开心> 这类标签，字幕/合成用的是净化后的 processedText；
        //   口型按原始文本算字符位置 → 带标签时整体偏移。统一在净化完成后赋值（见下）。
        // ⚠ 2026-11-09 三十五轮修「假成功」：原来这里就写 lastPlayStartedAt = Date.now()，
        //   但那只是「开始尝试播放」——如果 Audio 构造失败、onerror、或被浏览器
        //   自动播放策略拦下，doctor 依然会判「她真的出过声」。
        //   现在拆两个字段：
        //     lastPlayAttemptAt —— 尝试时间（排障用）
        //     lastPlayStartedAt —— **真的开始出声**的时间（onplay 里才设，doctor 只信这个）
        this.lastPlayAttemptAt = Date.now();
        this.lastPlayError = null;
        
        return new Promise((resolve) => {
            if (this.shouldStop) {
                resolve(playResult('stopped', 'stopped'));
                return;
            }
            
            this.isPlaying = true;
            this.currentAudioResolve = resolve;
            
            // 触发开始回调
            if (this.onStartCallback) this.onStartCallback();
            eventBus.emit(Events.TTS_START);
            
            // 创建音频：流式首段挂 MediaSource，其余仍是整段 blob URL
            this.currentAudioUrl = URL.createObjectURL(streamMediaSource || audioBlob);
            this.currentAudio = new Audio(this.currentAudioUrl);
            
            // 创建音频链路
            const gainNode = this.audioContext.createGain();
            gainNode.gain.value = 1.0;
            const source = this.audioContext.createMediaElementSource(this.currentAudio);
            source.connect(gainNode);
            gainNode.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
            
            // 预处理文本（提取情绪标记和表情标记）
            let processedText = segmentText;
            let emotionMarkers = [];
            let expressionMarkers = [];
            
            if (this.emotionMapper) {
                const info = this.emotionMapper.prepareTextForTTS(segmentText);
                processedText = info.text;
                emotionMarkers = info.emotionMarkers;
            }
            
            
            // ✅ 修复：表情映射器也需要处理文本
            if (this.expressionMapper) {
                // 使用表情映射器的预处理方法
                const exprInfo = this.expressionMapper.prepareTextForTTS(segmentText);
                // 确保使用处理后的文本
                processedText = exprInfo.text; 
                expressionMarkers = exprInfo.emotionMarkers || [];
                
                console.log(`表情映射器找到 ${expressionMarkers.length} 个表情标记`);
            }
            
            // ── 口型与字幕/合成同源（2026-11-21）────────────────────────────
            // processedText 是去掉 <emotion:...>/<expression:...> 之后的文本，
            // 字幕（startTextAnimation）和 charDisplayIndex 都用它；口型必须用同一个
            // 字符串，否则带标签时 viseme 字符索引整体偏移（嘴型和声音对不上）。
            this.currentSegmentText = processedText;
            this._currentCharIndex = 0;

            eventBus.emit(Events.TTS_SEGMENT_START, {
                position: this.displayedText.length,
                text: processedText,
            });

            const segmentLength = processedText.length;
            let charDisplayIndex = 0;
            // ⚠ 2026-11-15 六十三轮：petbody 模式下 `paramDirector` 不存在（导演层不驱动脸），
            //   如果还按「导演模式 → 不用文本标记」的老口径，结果就是**说话时脸一动不动**。
            //   所以：没有 paramDirector 就由文本标记驱动；Live2D 导演模式维持原样（避免双写）。
            const useLegacyEmotionLogic = shouldUseLegacyEmotionLogic(this.config) || !global.paramDirector;
            // let textAnimInterval = null;
            
            // 🔥 文本动画函数
            const startTextAnimation = () => {
                const rawDuration = this.currentAudio ? this.currentAudio.duration : 0;
                // 流式首段起播时 duration 还是 Infinity：字幕先按每字 200ms 估节奏；
                // 嘴形走 analyser 实时包络，不受此影响。整段 blob 仍是真实时长。
                const audioDuration = (Number.isFinite(rawDuration) && rawDuration > 0)
                    ? rawDuration * 1000
                    : Math.max(1, segmentLength) * 200;
                const charInterval = Math.max(30, Math.min(200, audioDuration / segmentLength));
                let lastUpdateTime = performance.now();
                
                const animateText = (currentTime) => {
                    // 检查是否应该停止
                    if (this.shouldStop || !this.currentAudio) {
                        return;
                    }

                    // 检查是否到了更新字符的时间
                    if (currentTime - lastUpdateTime >= charInterval) {
                        if (charDisplayIndex < segmentLength) {
                            charDisplayIndex++;
                            this._currentCharIndex = charDisplayIndex;

                            // AI 编舞关键帧按字幕/TTS 字符进度触发。
                            if (global.paramDirector) {
                                try {
                                    global.paramDirector.noteSpeechProgress(
                                        this.displayedText.length + charDisplayIndex
                                    );
                                } catch (_) { try { __silentAudit.audit('tts-playback-engine.js:156', _); } catch (e2) {} }
                            }
                            eventBus.emit(Events.TTS_TEXT_PROGRESS, {
                                position: this.displayedText.length + charDisplayIndex,
                                positionInSegment: charDisplayIndex,
                                segmentLength,
                                segmentText: processedText,
                            });
                            
                            // 触发情绪动作
                            if (useLegacyEmotionLogic && this.emotionMapper && emotionMarkers.length > 0) {
                                this.emotionMapper.triggerEmotionByTextPosition(
                                    charDisplayIndex, segmentLength, emotionMarkers
                                );
                            }
                            
                            
                            // 触发表情
                            if (useLegacyEmotionLogic && this.expressionMapper) {
                                // 方法1: 直接通过情绪标签触发表情
                                if (this.expressionMapper.triggerExpressionByEmotion) {
                                    // 检查当前位置是否有情绪标记
                                    for (let i = emotionMarkers.length - 1; i >= 0; i--) {
                                        const marker = emotionMarkers[i];
                                        if (charDisplayIndex >= marker.position && 
                                            charDisplayIndex <= marker.position + 2) {
                                            this.expressionMapper.triggerExpressionByEmotion(marker.emotion);
                                            break;
                                        }
                                    }
                                }
                                
                                // 方法2: 如果有表情标记器，使用表情标记器
                                if (expressionMarkers.length > 0 && 
                                    this.expressionMapper.triggerEmotionByTextPosition) {
                                    this.expressionMapper.triggerEmotionByTextPosition(
                                        charDisplayIndex, segmentLength, expressionMarkers
                                    );
                                }
                            }
                            
                            
                            // 显示字幕
                            const currentDisplay = this.displayedText + processedText.substring(0, charDisplayIndex);
                            if (typeof showSubtitle === 'function') {
                                showSubtitle(`${this.config.subtitle_labels?.ai || '大肥鱼'}: ${currentDisplay}`);
                                const container = document.getElementById('subtitle-container');
                                if (container) container.scrollTop = container.scrollHeight;
                            }
                            
                            lastUpdateTime = currentTime;
                        }
                    }
                    
                    // 如果还没播放完，继续动画
                    if (charDisplayIndex < segmentLength && !this.shouldStop) {
                        this._textAnimInterval = requestAnimationFrame(animateText);
                    }
                };
                
                // 启动动画
                this._textAnimInterval = requestAnimationFrame(animateText);
            };
            
            // 提取表情标记
            this.extractExpressionMarkers = (originalText, processedText) => {
                const markers = [];
                const pattern = /<expression:([^>]+)>/g;
                let match;
                let offset = 0;
                
                while ((match = pattern.exec(originalText)) !== null) {
                    const expressionName = match[1];
                    const originalPosition = match.index;
                    
                    // 计算在processedText中的位置
                    const adjustedPosition = originalPosition - offset;
                    offset += match[0].length;
                    
                    markers.push({
                        position: adjustedPosition,
                        expression: expressionName,
                        fullTag: match[0]
                    });
                }
                
                return markers;
            };
            
            // 根据位置触发表情
            this.triggerExpressionByPosition = (position, textLength, expressionMarkers) => {
                if (!expressionMarkers || expressionMarkers.length === 0) return;
                
                // 检查当前位置是否匹配表情标记
                for (let i = expressionMarkers.length - 1; i >= 0; i--) {
                    const marker = expressionMarkers[i];
                    if (position >= marker.position && position <= marker.position + 2) {
                        this.expressionMapper.triggerExpression(marker.expression);
                        expressionMarkers.splice(i, 1);
                        break;
                    }
                }
                
                // 如果到达文本末尾，触发所有剩余的表情标记
                if (position >= textLength - 1 && expressionMarkers.length > 0) {
                    for (const marker of expressionMarkers) {
                        this.expressionMapper.triggerExpression(marker.expression);
                    }
                    expressionMarkers.length = 0;
                }
            };
            
            // 嘴形动画函数：真实音频包络（时域 RMS）× viseme 形状修正
            //
            // ── 为什么融合（2026-11-09 三十轮，按 docs/研究-真人级实时数字人-2026-11-09.md）──
            // 纯 RMS 的问题：音量小的时候嘴几乎不动（轻声、气声、句尾），听起来「嘴没在说」；
            //              音量大的时候所有字都一样大张嘴，元音区别（a/o/e/i/u）完全丢失 → 假。
            // 纯 viseme 的问题：不知道每个字在音频里的精确时间，容易和声音错位。
            // 融合方案：
            //   · RMS 给「这一刻有没有声音、声音多大」（时间上天然同步，永远不错位）
            //   · viseme 给「这个字该张多大」（a 大 u 小，形状对）
            //   · 两者相乘后再归一：有声音时按 viseme 比例张合，没声音时归零。
            // 这样既能跟住音量包络，又有元音形状差异——比纯 RMS 自然得多，且零额外延迟。
            const updateMouth = () => {
                if (this.shouldStop || !this.currentAudio) return;

                // 时域波形：128 个采样点的振幅，直接反映"这一刻声音多大"。
                this.analyser.getByteTimeDomainData(this.timeDataArray);
                let sumSq = 0;
                const n = this.timeDataArray.length;
                for (let i = 0; i < n; i++) {
                    const v = (this.timeDataArray[i] - 128) / 128;   // 归一到 -1..1
                    sumSq += v * v;
                }
                const rms = Math.sqrt(sumSq / n);                     // 0..1
                // 语音存在度：RMS 低于阈值视为静音/换气，直接闭嘴（避免底噪让嘴抖）
                const voiced = rms > 0.012 ? Math.min(1, (rms - 0.012) / 0.10) : 0;
                // 音量包络（保持原来的 0.55 次幂：轻声也张得开一点）
                const env = Math.min(1, Math.pow(rms * 3.2, 0.55));

                // viseme 形状：按「已播时间」估算当前读到第几个字。
                // 这是估计不是精确对齐，所以只用来**修正形状比例**（不影响音量包络的时间同步性）。
                // 字符索引用 _visemeCharAt：返回的 index 是 currentSegmentText（=净化文本）
                // 的下标，与字幕 charDisplayIndex 同源。
                let shape = 1;
                try {
                    if (voiced > 0.05 && this.currentAudio) {
                        const dur = (Number.isFinite(this.currentAudio.duration) && this.currentAudio.duration > 0)
                            ? this.currentAudio.duration : 0;
                        const hit = this._visemeCharAt(this.currentAudio.currentTime, dur);
                        if (hit && hit.ch) {
                            const { viseme } = require('./viseme.js');
                            const o = viseme && typeof viseme.shapeFor === 'function' ? viseme.shapeFor(hit.ch) : null;
                            // 开口度 0..1 → 形状倍率 0.55..1.35（窄元音 u 收一点，开元音 a 张一点）
                            if (o !== null && o !== undefined) shape = 0.55 + Number(o) * 0.8;
                        }
                    }
                } catch (e) { /* viseme 取不到就用 1（退回纯 RMS） */ }

                // 融合：音量包络 × 形状倍率，再乘语音存在度
                const mouthOpenValue = Math.max(0, Math.min(1, env * shape * voiced));

                if (this.onAudioDataCallback) this.onAudioDataCallback(mouthOpenValue);

                if (this.currentAudio && !this.shouldStop) {
                    this._renderFrameId = requestAnimationFrame(updateMouth);
                }
            };
            
            // 设置音频事件
            // 流式首段的 duration=Infinity，canplaythrough 可能永远不触发 —— 用 onplay 兜底，
            // 两条路只允许启动一次文本动画（否则字幕会双倍速）。
            let textAnimStarted = false;
            const startTextAnimationOnce = () => {
                if (textAnimStarted) return;
                textAnimStarted = true;
                startTextAnimation();
            };
            this.currentAudio.oncanplaythrough = () => startTextAnimationOnce();

            this.currentAudio.onplay = () => {
                // 这一刻才是「真的开始出声」—— doctor 判「她出过声」只信这个字段
                this.lastPlayStartedAt = Date.now();
                this.lastPlayError = null;
                // 自听闸：真的开始出声才暂停「一起看」的回环采集（缺陷 4）
                setAudioLoopPaused(true);
                startTextAnimationOnce();
                updateMouth();

                // 设置淡出（流式首段起播时 duration 可能还是 Infinity，不能排定时器）
                const fadeOutDuration = 0.15;
                const audioDuration = this.currentAudio.duration;
                if (Number.isFinite(audioDuration) && audioDuration > fadeOutDuration) {
                    const fadeOutTimer = setTimeout(() => {
                        if (!this.shouldStop && gainNode) {
                            const currentTime = this.audioContext.currentTime;
                            gainNode.gain.setValueAtTime(1.0, currentTime);
                            gainNode.gain.exponentialRampToValueAtTime(0.01, currentTime + fadeOutDuration);
                        }
                    }, (audioDuration - fadeOutDuration) * 1000);
                    this.currentAudio._fadeOutTimer = fadeOutTimer;
                }
            };
            
            this.currentAudio.onended = () => {
                // 清理定时器
                if (this.currentAudio._fadeOutTimer) {
                    clearTimeout(this.currentAudio._fadeOutTimer);
                }
                
                // 停止嘴形动画
                if (this.onAudioDataCallback) this.onAudioDataCallback(0);
                
                // 停止文本动画
                if (this._textAnimInterval) {
                    cancelAnimationFrame(this._textAnimInterval);
                    this._textAnimInterval = null;
                }
                
                // 停止渲染帧
                if (this._renderFrameId) {
                    cancelAnimationFrame(this._renderFrameId);
                    this._renderFrameId = null;
                }
                
    
                // 触发剩余情绪
                if (useLegacyEmotionLogic && this.emotionMapper && emotionMarkers.length > 0) {
                    emotionMarkers.forEach(m => {
                        this.emotionMapper.playConfiguredEmotion(m.emotion);
                        
                        // 同步触发表情
                        if (global.expressionMapper && global.expressionMapper.triggerExpressionByEmotion) {
                            setTimeout(() => {
                                global.expressionMapper.triggerExpressionByEmotion(m.emotion);
                            }, 100);
                        }
                    });
                }

                if (global.paramDirector) {
                    try {
                        global.paramDirector.noteSpeechProgress(
                            this.displayedText.length + segmentLength
                        );
                    } catch (_) { try { __silentAudit.audit('tts-playback-engine.js:354', _); } catch (e2) {} }
                }
                
                // 更新显示文本
                this.displayedText += processedText;
                if (typeof showSubtitle === 'function') {
                    showSubtitle(`${this.config.subtitle_labels?.ai || '大肥鱼'}: ${this.displayedText}`);
                }

                this.cleanup();
                this.isPlaying = false;
                // 本段播完：延迟恢复「一起看」回环（段间 700ms 内不来回切）
                setAudioLoopPaused(false);
                if (this.currentAudioResolve) {
                    this.currentAudioResolve(playResult('completed'));
                    this.currentAudioResolve = null;
                }

                // 注意：不在这里调用 onEndCallback 和发射 TTS_END
                // 这些由 tts-processor.js 的 handleAllComplete() 统一处理
                // 避免多段文本时每段结束都触发，导致提前解锁 ASR 和提前结束等待
                resolve(playResult('completed'));
            };
            
            this.currentAudio.onerror = (e) => {
                console.error('音频播放错误:', e);
                // 记下真实失败原因：doctor / 排查时能看出「她没出声是因为这个」
                this.lastPlayError = 'audio-error:' + (e && (e.type || e.message) || 'unknown');
                setAudioLoopPaused(false);   // 没有声音 → 剧集回环不该继续被暂停

                // 错误时也切换默认表情
                if (this.expressionMapper) {
                    // this.expressionMapper.triggerExpression("表情7");
                    const defaultExpr = this.expressionMapper.defaultExpression || "表情1";
                    this.expressionMapper.triggerExpression(defaultExpr);
                }

                this.cleanupOnError();
                // 注意：不在这里发射 TTS_END 和调用 onEndCallback
                // 由 tts-processor.js 的 handleAllComplete() 统一处理
                if (this.currentAudioResolve) {
                    this.currentAudioResolve(playResult('error', this.lastPlayError));
                    this.currentAudioResolve = null;
                }

                resolve(playResult('error', this.lastPlayError));
            };
            
            
            // 开始播放（blob 与流式回退共用同一段失败处理）
            const playCurrentAudio = () => {
                this.currentAudio.play().catch(error => {
                    console.error('播放失败:', error);
                    // 记下失败原因（自动播放策略拦截最常见：NotAllowedError）
                    this.lastPlayError = 'play-rejected:' + (error && (error.name || error.message) || 'unknown');

                    // 播放失败时切换默认表情
                    if (this.expressionMapper) {
                        const defaultExpr = this.expressionMapper.defaultExpression || "表情1";
                        this.expressionMapper.triggerExpression(defaultExpr);
                    }

                    this.cleanupOnError();
                    // 没出声（自动播放策略拦截/解码失败）→ 恢复回环采集
                    setAudioLoopPaused(false);
                    // 注意：不在这里发射 TTS_END 和调用 onEndCallback
                    // 由 tts-processor.js 的 handleAllComplete() 统一处理
                    resolve(playResult('error', this.lastPlayError));
                });
            };

            if (streamHandle) {
                // 首块 append 成功才 play；attach 失败说明还没出声，可无感换整段 blob。
                streamHandle.attach(streamMediaSource, this.currentAudio)
                    .then(() => {
                        if (this.shouldStop || !this.currentAudio) {
                            // 契约：任何早退都要 settle（否则 playNext 的 await 永远挂着）
                            resolve(playResult('stopped', 'stopped'));
                            return;
                        }
                        // attach 成功才说「流式在播」（原来 request-handler 在 attach 前就打「首段流式播放」，
                        // attach 失败时日志会骗人 —— 2026-11-21 核查发现）。
                        try { logToTerminal('info', '[tts] 流式首块已接管，开始播放'); } catch (_) { }
                        playCurrentAudio();
                    })
                    .catch(async (err) => {
                        if (this.shouldStop || !this.currentAudio) {
                            resolve(playResult('stopped', 'stopped'));
                            return;
                        }
                        logStreamIssue('回退: ' + (err && err.message || err));
                        let blob = null;
                        try { blob = await streamHandle.toBlob(); }
                        catch (e2) { logStreamIssue('回退失败: ' + (e2 && e2.message || e2)); }
                        if (!blob || this.shouldStop || !this.currentAudio) {
                            this.cleanupOnError();
                            const why = this.shouldStop ? 'stopped' : 'stream-attach-no-blob';
                            this.lastPlayError = this.lastPlayError || why;
                            if (this.currentAudioResolve) {
                                this.currentAudioResolve(playResult(this.shouldStop ? 'stopped' : 'error', why));
                                this.currentAudioResolve = null;
                            }
                            resolve(playResult(this.shouldStop ? 'stopped' : 'error', why));
                            return;
                        }
                        try { URL.revokeObjectURL(this.currentAudioUrl); } catch (_) { }
                        this.currentAudioUrl = URL.createObjectURL(blob);
                        this.currentAudio.src = this.currentAudioUrl;
                        playCurrentAudio();
                    });
            } else {
                playCurrentAudio();
            }
        });
    }

    /**
     * 口型字符索引（2026-11-21 同源修复）。
     * text = this.currentSegmentText（= 字幕/合成用的净化文本），返回的 index 直接是
     * 该字符串下标；字幕的 charDisplayIndex 也在同一个字符串上推进 → 索引一致。
     * 标点/空白只是从「发音字符序」里跳过，再映射回原下标，不改变下标基准。
     */
    _buildVisemePlan(text, durationSec) {
        if (this._visemeSegFor === text && this._visemeDurFor === durationSec) return this._visemePlan;
        const positions = [];
        for (let i = 0; i < text.length; i++) {
            if (!/[\s，。！？、；：""''（）()]/.test(text[i])) positions.push(i);
        }
        const msPerChar = Math.max(60, Math.min(300, (durationSec * 1000) / (positions.length || 1)));
        this._visemeSegFor = text;
        this._visemeDurFor = durationSec;
        this._visemePlan = { positions, msPerChar };
        return this._visemePlan;
    }

    _visemeCharAt(timeSec, durationSec) {
        const text = String(this.currentSegmentText || '');
        if (!text || !(durationSec > 0)) return { text, index: -1, ch: '', ordinal: -1 };
        const plan = this._buildVisemePlan(text, durationSec);
        if (!plan.positions.length) return { text, index: -1, ch: '', ordinal: -1 };
        const ordinal = Math.min(plan.positions.length - 1,
            Math.max(0, Math.floor(((Number(timeSec) || 0) * 1000) / (plan.msPerChar || 100))));
        const index = plan.positions[ordinal];
        return { text, index, ch: text[index] || '', ordinal };
    }

    // 清理资源
    cleanup() {
        // 流式首段：释放 reader / SourceBuffer / MediaSource（自然播完与打断都走这里）
        if (this._streamHandle) {
            try { this._streamHandle.cancel('cleanup'); } catch (_) { }
            this._streamHandle = null;
        }
        if (this.currentAudioUrl) {
            URL.revokeObjectURL(this.currentAudioUrl);
            this.currentAudioUrl = null;
        }
        this.currentAudio = null;
    }

    // 错误时清理
    cleanupOnError() {
        if (this.onAudioDataCallback) this.onAudioDataCallback(0);
        if (this._textAnimInterval) {
            cancelAnimationFrame(this._textAnimInterval);
            this._textAnimInterval = null;
        }
        if (this._renderFrameId) {
            cancelAnimationFrame(this._renderFrameId);
            this._renderFrameId = null;
        }
        this.cleanup();
        this.isPlaying = false;
    }

    // 停止播放
    stop() {
        this.shouldStop = true;
        // 打断/停止：立即恢复「一起看」回环（不等 700ms 段间释放），
        // 否则用户抢话后剧集声音还是进不来。
        setAudioLoopPaused(false, { immediate: true });

        if (this._textAnimInterval) {
            cancelAnimationFrame(this._textAnimInterval);
            this._textAnimInterval = null;
        }
        if (this._renderFrameId) {
            cancelAnimationFrame(this._renderFrameId);
            this._renderFrameId = null;
        }

        if (this.currentAudio) {
            this.currentAudio.onended = null;
            this.currentAudio.onplay = null;
            this.currentAudio.oncanplaythrough = null;
            this.currentAudio.onerror = null;
            this.currentAudio.pause();
            this.currentAudio.src = "";
        }

        this.cleanup();
        if (this.onAudioDataCallback) this.onAudioDataCallback(0);
        this.isPlaying = false;
        if (this.currentAudioResolve) {
            this.currentAudioResolve(playResult('stopped', 'stopped'));
            this.currentAudioResolve = null;
        }
    }

    // 重置状态
    reset() {
        this.stop();
        this.shouldStop = false;
        this.displayedText = '';
        this.currentSegmentText = '';
        this._currentCharIndex = 0;
    }

    /**
     * D4：当前正在播的段还有多少没播（供 tts-processor.interrupt 保存「接着说」的剩余）。
     * 只读，不改播放状态。字幕 charDisplayIndex 与实际音频大致同步，够用作续讲起点。
     * @returns {null|{text:string, playedChars:number, totalChars:number, remainder:string}}
     */
    getUnplayedCurrentText() {
        const text = String(this.currentSegmentText || '');
        if (!text) return null;
        const total = text.length;
        const played = Math.max(0, Math.min(total, Math.floor(Number(this._currentCharIndex) || 0)));
        return { text, playedChars: played, totalChars: total, remainder: text.slice(played) };
    }

    // 获取状态
    getPlayingState() {
        return this.isPlaying;
    }
}

module.exports = { TTSPlaybackEngine, setAudioLoopPaused, getAudioLoopPauseStats };
