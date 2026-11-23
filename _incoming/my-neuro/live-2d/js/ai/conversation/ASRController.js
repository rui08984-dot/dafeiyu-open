// ASRController.js - ASR控制器
const { ASRProcessor } = require('../../voice/asr-processor.js');
const { BaiduStreamingASR } = require('../../voice/baidu-streaming-asr.js');
const { eventBus } = require('../../core/event-bus.js');
const { Events } = require('../../core/events.js');

/**
 * 负责ASR处理器的创建、录音控制、语音输入回调
 */
class ASRController {
    constructor(vadUrl, asrUrl, config, inputRouter, diaryManager) {
        this.config = config;
        this.inputRouter = inputRouter;
        this.diaryManager = diaryManager;

        // 检查是否使用百度流式ASR
        this.useBaiduStreamingASR = config.cloud?.baidu_asr?.enabled === true;

        this.useSiliconFlowASR = config.cloud?.siliconflow_asr?.enabled === true;

        // 检查ASR是否可用（本地ASR或百度流式ASR任一启用即可）
        const localASREnabled = config.asr?.enabled !== false;
        this.asrEnabled = localASREnabled || this.useBaiduStreamingASR || this.useSiliconFlowASR;
        this.voiceBargeInEnabled = config.asr?.voice_barge_in || false;

        console.log(`语音打断功能: ${this.voiceBargeInEnabled ? '已可用' : '已禁用'}`);
        console.log(`百度流式ASR: ${this.useBaiduStreamingASR ? '已启用' : '已禁用'}`);
        console.log(`SiliconFlow ASR: ${this.useSiliconFlowASR ? '已启用' : '已禁用'}`);

        if (!this.asrEnabled) {
            console.log('ASR已禁用，跳过ASR处理器初始化');
            this.asrProcessor = null;
            return;
        }

        // 根据配置选择ASR处理器
        if (this.useBaiduStreamingASR) {
            // 使用百度流式ASR
            console.log('使用百度流式ASR');
            this.asrProcessor = new BaiduStreamingASR(config);
            // 设置实时字幕回调
            this.setupInterimResultCallback();
        } else {
            // 使用原有的ASR处理器
            this.asrProcessor = new ASRProcessor(vadUrl, asrUrl, config);
        }

        // 设置ASR回调
        this.setupASRCallback();
    }

    /**
     * 设置实时字幕回调（百度流式ASR专用）
     */
    setupInterimResultCallback() {
        if (this.asrProcessor.setOnInterimResult) {
            this.asrProcessor.setOnInterimResult((interimText) => {
                const showSubtitle = this.inputRouter.showSubtitle;
                // 显示临时字幕，不设置自动隐藏（会被下一次更新覆盖）
                showSubtitle(`${this.config.subtitle_labels.user}: ${interimText}`, 0);
            });
        }
    }

    /**
     * 设置ASR语音识别回调
     */
    setupASRCallback() {
        // 文本合并窗口状态
        this._pendingText = '';
        this._mergeTimer = null;
        // 2026-11-20 全双工改造 1：默认 2000 → 300ms。
        // 原来的 2s 是等「卡壳续说」，但正常一句话也被硬拖 2s；现在改成短窗 +
        // 「VAD 再次开口就续窗」兜底（见下方 onVadSpeechStart）。
        // 要完全回退旧行为：config.asr.merge_window_ms = 2000。
        const _merge = Number(this.config.asr?.merge_window_ms ?? 300);
        this._MERGE_WINDOW = Number.isFinite(_merge) ? Math.max(0, _merge) : 300;
        console.log(`语音合并窗口: ${this._MERGE_WINDOW}ms`);

        const flush = async (showSubtitle) => {
            // 如果用户还在说话或 ASR 还在处理，推迟 200ms 再检查
            if (this.asrProcessor?.isRecording || this.asrProcessor?.asrLocked) {
                this._mergeTimer = setTimeout(() => flush(showSubtitle), 200);
                return;
            }

            const finalText = this._pendingText;
            this._pendingText = '';
            this._mergeTimer = null;

            console.log(`语音合并完成，提交文本: "${finalText}"`);
            showSubtitle(`${this.config.subtitle_labels.user}: ${finalText}`, 3000);

            // 与键盘输入同源：提交瞬间喂情绪引擎（不等字幕轮询）→ 自动演出能及时触发
            try {
                if (global.petBody && typeof global.petBody.feedText === 'function') {
                    global.petBody.feedText(finalText, 'user');
                }
            } catch (e) { /* 情绪引擎不可用不影响识别 */ }

            const dm = this.diaryManager || global.diaryManager;
            if (dm) dm.resetTimer();

            try {
                await this.inputRouter.handleVoiceInput(finalText);
                eventBus.emit(Events.USER_MESSAGE_RECEIVED, { text: finalText });
            } catch (e) {
                // 审计 P2 #27：下游抛错时不能让这句语音凭空消失（原来是 unhandled rejection + 文本已清空）。
                console.error('ASR 提交失败，已把文本放回待提交（不会自动重试，避免循环）:', e);
                try {
                    this._pendingText = this._pendingText ? (finalText + ' ' + this._pendingText) : finalText;
                } catch (e2) { /* 放回失败也不影响解锁 */ }
            } finally {
                if (this.asrProcessor) {
                    setTimeout(() => {
                        this.asrProcessor.resumeRecording();
                        console.log('ASR已在对话结束后解锁');
                    }, 100);
                }
            }
        };

        // 重设合并计时器：同一时刻只保留一个待提交 timer。
        this._armMergeTimer = (showSubtitle) => {
            if (this._mergeTimer) clearTimeout(this._mergeTimer);
            // PTT 松键已经明确表示一句话结束，无需再等待卡壳续说合并窗口。
            const mergeDelay = this.asrProcessor?.pttModeEnabled ? 0 : this._MERGE_WINDOW;
            this._mergeTimer = setTimeout(() => flush(showSubtitle), mergeDelay);
        };

        this.asrProcessor.setOnSpeechRecognized(async (text) => {
            const showSubtitle = this.inputRouter.showSubtitle;

            // 拼接到待发送文本（卡壳续说场景）
            this._pendingText = this._pendingText
                ? this._pendingText + '，' + text
                : text;

            // 实时显示已累积的文本
            showSubtitle(`${this.config.subtitle_labels.user}: ${this._pendingText}`, 0);

            // 解锁 ASR，让下一段能继续录入
            if (this.asrProcessor) {
                this.asrProcessor.resumeRecording();
            }

            this._armMergeTimer(showSubtitle);
        });

        // 改造 1 兜底：合并窗口倒计时中用户又开口 → 取消这次提交，等新一段识别完再续窗。
        // 现有 flush 里「isRecording || asrLocked 就 200ms 后再查」继续兜住
        // 「正在录音 / ASR 处理中」两种情况；这里补的是短窗口下 timer 刚好到点的那一瞬。
        if (typeof this.asrProcessor.setOnVadSpeechStart === 'function') {
            this.asrProcessor.setOnVadSpeechStart(() => {
                if (!this._pendingText || !this._mergeTimer) return;
                console.log('🎤 合并窗口内再次开口，取消本次提交并续接');
                this._armMergeTimer(this.inputRouter.showSubtitle);
            });
        }
    }

    /**
     * 设置TTS处理器（用于语音打断）
     */
    setTTSProcessor(ttsProcessor) {
        if (this.asrProcessor && this.voiceBargeInEnabled && ttsProcessor) {
            this.asrProcessor.setTTSProcessor(ttsProcessor);
            console.log('TTS处理器已设置到ASR，支持语音打断');
        }
    }

    /**
     * 开始录音
     */
    async startRecording() {
        if (this.asrEnabled && this.asrProcessor) {
            await this.asrProcessor.startRecording();
            eventBus.emit(Events.ASR_START);
            console.log('ASR录音已启动');
        } else {
            console.log('ASR已禁用，无法开始录音');
        }
    }

    /**
     * 停止录音
     */
    stopRecording() {
        if (this.asrEnabled && this.asrProcessor) {
            this.asrProcessor.stopRecording();
            eventBus.emit(Events.ASR_STOP);
            console.log('ASR录音已停止');
        } else {
            console.log('ASR已禁用，无需停止录音');
        }
    }

    /**
     * 暂停录音
     */
    async pauseRecording() {
        if (this.asrEnabled && this.asrProcessor) {
            this.asrProcessor.pauseRecording();
            if (this.voiceBargeInEnabled) {
                console.log('语音打断模式：保持VAD监听');
            } else {
                console.log('传统模式：Recording paused due to TTS playback');
            }
        }
    }

    /**
     * 恢复录音
     */
    async resumeRecording() {
        if (this.asrEnabled && this.asrProcessor) {
            this.asrProcessor.resumeRecording();
            if (this.voiceBargeInEnabled) {
                console.log('语音打断模式：ASR已解锁');
            } else {
                console.log('传统模式：Recording resumed after TTS playback, ASR unlocked');
            }
        }
    }

    /**
     * 获取语音打断状态
     */
    getVoiceBargeInStatus() {
        if (!this.asrEnabled || !this.asrProcessor) {
            return { enabled: false, reason: 'ASR未可用' };
        }
        return this.asrProcessor.getVoiceBargeInStatus();
    }

    /**
     * 动态切换语音打断功能
     */
    setVoiceBargeIn(enabled, ttsProcessor) {
        this.voiceBargeInEnabled = enabled;
        if (this.asrEnabled && this.asrProcessor) {
            this.asrProcessor.setVoiceBargeIn(enabled);

            // 如果可用语音打断，确保TTS处理器引用设置正确
            if (enabled && ttsProcessor) {
                this.asrProcessor.setTTSProcessor(ttsProcessor);
                console.log('语音打断已可用，TTS处理器引用已设置');
            }
        } else {
            console.log('ASR未可用，无法切换语音打断功能');
        }
    }

    /**
     * PTT：按下，开始录音
     */
    pttStartRecording() {
        if (this.asrEnabled && this.asrProcessor?.pttStartRecording) {
            this.asrProcessor.pttStartRecording();
            eventBus.emit(Events.ASR_START);
        }
    }

    /**
     * PTT：松开，结束录音并触发识别
     */
    pttStopRecording() {
        if (this.asrEnabled && this.asrProcessor?.pttStopRecording) {
            this.asrProcessor.pttStopRecording();
            eventBus.emit(Events.ASR_STOP);
        }
    }

    pttCancelRecording(reason) {
        if (this.asrEnabled && this.asrProcessor?.pttCancelRecording) {
            this.asrProcessor.pttCancelRecording(reason);
            eventBus.emit(Events.ASR_STOP);
        }
    }

    /**
     * 检查ASR是否可用
     */
    isEnabled() {
        return this.asrEnabled;
    }
}

module.exports = { ASRController };
