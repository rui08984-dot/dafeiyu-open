// plugins/built-in/diary/index.js
const { Plugin } = require('../../../js/core/plugin-base.js');

class DiaryPlugin extends Plugin {

    async onStart() {
        const pluginConfig = this.context.getPluginFileConfig();
        const voiceChat = global.voiceChat;
        if (!voiceChat?.diaryManager) {
            this.context.log('warn', 'diaryManager 未就绪，跳过日记插件启动');
            return;
        }

        this._diaryManager = voiceChat.diaryManager;

        // 2026-11-13：改成走 DiaryManager.configure() —— 原来直接改 aiDiary* 四个字段
        // 再自己 startTimer()，属于越界写宿主私有状态（宿主改字段名就静默失效）。
        const opts = {
            enabled: true,
            idleTime: pluginConfig.idle_time ?? 20000,
            file: pluginConfig.diary_file ?? 'data/AI日记.txt',
            prompt: pluginConfig.prompt ?? '',
        };
        global.diaryManager = this._diaryManager;
        if (typeof this._diaryManager.configure === 'function') {
            this._diaryManager.configure(opts);   // 内部按需 startTimer（幂等）
        } else {
            // 老宿主兜底：行为与改动前完全一致
            this._diaryManager.aiDiaryEnabled = true;
            this._diaryManager.aiDiaryIdleTime = opts.idleTime;
            this._diaryManager.aiDiaryFile     = opts.file;
            this._diaryManager.aiDiaryPrompt   = opts.prompt;
            this._diaryManager.startTimer();
        }
    }

    async onTTSEnd() {
        if (this._diaryManager) {
            this._diaryManager.resetTimer();
        }
    }

    async onStop() {
        if (this._diaryManager?.diaryTimer) {
            clearTimeout(this._diaryManager.diaryTimer);
            this._diaryManager.diaryTimer = null;
        }
        global.diaryManager = null;
    }
}

module.exports = DiaryPlugin;
