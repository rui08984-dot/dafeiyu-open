// plugins/community/companion-health/index.js
//
// 陪伴健康提示
//
// 依据：2024《Digital loneliness》与 2025《The Rise of AI Companions》都指出
// 长期高强度使用陪伴体会影响真实社交。产品上不该装作没这回事。
//
// 做法（克制版）：
//   - 只统计「用户输入」的分钟数（她主动说话不计 —— 本插件只挂了 onUserInput，
//     接入她在场主动说话的计数成本更高，所以口径写在文案里，不假装是双向陪伴）
//   - 超过日阈值提一句，两小时内不重复
//   - **不做说教**：她不说"你该出去走走"，而是以自己的口吻提一句
const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const jsonStore = require('../../../js/core/json-store.js');
// 后台云端花费闸（2026-11-24 第三轮 P1）：这条提示会把下一轮回复往「多说一句」上推，
// 属于后台行为；静默期/预算关时不该再叠这层推力。
const backgroundLLM = require('../../../js/core/background-llm.js');
const fs = require('fs');
const path = require('path');

const PATCH_ID = 'companion-health';

class CompanionHealthPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig() || {};
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        this._enabled = resolvePluginEnabled(this.context, cfg, 'companion-health');
        this._threshold = Math.max(30, Number(cfg.daily_threshold_min ?? 180));
        this._gapMs = Math.max(10, Number(cfg.repeat_gap_min ?? 120)) * 60000;
        this._minutes = 0;              // 今日累计交互分钟
        this._lastTickAt = 0;
        this._lastPromptAt = 0;
        this._day = '';
        try {
            const { RECORDS_DIR } = require('../../../js/core/records-path.js');
            this._file = path.join(RECORDS_DIR, '陪伴时长.json');
            fs.mkdirSync(RECORDS_DIR, { recursive: true });
            this._load();
        } catch (e) { this._file = null; }
    }

    /**
     * 本地日（与 speech-budget.dayKey 同款）。**不能用 toISOString().slice(0,10)**：
     * 那是 UTC 日，UTC+8 的 00:00–08:00 会被算到昨天 → 跨天清零晚 8 小时，
     * 「今日互动」被拆成两天。可传 now（测试固定时间）；不传用当前时钟。
     */
    _today(now) {
        const n = Number(now);
        const d = new Date(Number.isFinite(n) ? n : Date.now());
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    _load() {
        // 读坏了由 json-store 改名隔离并返回 null（有 console.warn）；这里照旧从今天 0 开始计
        const raw = jsonStore.readJson(this._file, null);
        this._day = this._today();
        if (!raw || typeof raw !== 'object') return;
        if (raw.day === this._day) {
            this._minutes = Number(raw.minutes) || 0;
            this._lastPromptAt = Number(raw.lastPromptAt) || 0;
        }
    }

    /**
     * 落盘。默认一分钟最多写一次（分钟数是连续累计的，丢一秒不心疼）；
     * `force=true` 绕过节流 —— 用于 `_lastPromptAt` 这类「丢了会直接导致重复打扰」的状态。
     *
     * 2026-11-24 第四轮 P2 根因修：提示后 1 分钟内重启时，`_lastPromptAt` 还卡在节流窗口里
     * 没落盘 → 重启后读回 0 → 两小时内又提示一次。所以提示那一刻必须同步落盘。
     */
    _save(force) {
        if (!this._file) return;
        const now = Date.now();
        if (force !== true && now - (this._lastSaveAt || 0) < 60000) return;   // 一分钟最多写一次
        // 文件坏过（本进程已隔离）就别写回：否则等于用今天的计数把仅剩的残骸盖掉
        if (jsonStore.isQuarantined(this._file)) {
            if (!this._quarantineWarned) {
                this._quarantineWarned = true;
                console.warn('[陪伴健康] 时长文件已隔离，本进程不再写回：' + this._file);
            }
            return;
        }
        this._lastSaveAt = now;
        try {
            jsonStore.writeJson(this._file, {
                day: this._today(), minutes: Math.round(this._minutes), lastPromptAt: this._lastPromptAt,
            });
        } catch (e) { try { __silentAudit.audit('index.js:59', e); } catch (e2) {} }
    }

    /** 有交互就累加：两次交互间隔超过 3 分钟视为"离开过"，不连续计 */
    _tick() {
        const now = Date.now();
        const gap = now - (this._lastTickAt || 0);
        this._lastTickAt = now;
        if (gap > 3 * 60000) { this._minutes += 0.5; }        // 刚回来，算半分钟
        else if (gap > 0) { this._minutes += gap / 60000; }   // 连续交互按实际间隔算
        if (this._day !== this._today()) { this._day = this._today(); this._minutes = 0; this._lastPromptAt = 0; }
        this._save();
    }

    async onUserInput() {
        if (!this._enabled) return;
        this._tick();
        const now = Date.now();
        if (this._minutes < this._threshold) return;
        if (now - this._lastPromptAt < this._gapMs) return;
        // 后台云端闸：跳过时**不推进 lastPromptAt**、不注入补丁 —— 闸放开后还能补提示
        // （否则关一次后台预算就等于「今天这条提醒被吃掉」，用户会觉得提示时有时无）。
        const gate = backgroundLLM.ensureCanRun(this.context, { kind: 'companion-health' });
        if (!gate.ok) return;
        this._lastPromptAt = now;
        // 立即落盘（绕过节流）：提示过却没留住时间戳 = 重启后两小时内再提示一次
        this._save(true);
        try {
            // 分寸：不劝、不说教，用她自己的口吻，一句话
            // P1-9：口径写明「只算他发来的消息」——她主动说话不在这里计数，别把单向输入说成陪伴。
            // volatile（2026-11-24 第三轮 P1）：带「今天已经互动 X 小时」的临时状态，每轮都会变；
            // 写进 system 会在 add/remove 之间改两次 system，把整段历史前缀缓存打穿。
            this.context.addSystemPromptPatch(PATCH_ID,
                '（今天他已经和你互动了 ' + Math.round(this._minutes / 60 * 10) / 10 + ' 小时（只算他发来的消息）。' +
                '这轮可以顺口提一句——用你自己的语气，一句话，别劝他、别讲道理，' +
                '比如"你今天是打算在电脑前坐一天了？"。不提也行。）', { volatile: true });
            this.context.log('info', '[陪伴健康] 今日互动（用户输入） ' + Math.round(this._minutes) + ' 分钟，已提示');
        } catch (e) { try { __silentAudit.audit('index.js:88', e); } catch (e2) {} }
    }

    async onLLMResponse() {
        try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (e) { try { __silentAudit.audit('index.js:92', e); } catch (e2) {} }
    }

    stats() {
        return {
            day: this._day,
            minutes: Math.round(this._minutes),
            hours: Math.round(this._minutes / 60 * 10) / 10,
            // P1-9：统计口径显式化 —— 只累计 onUserInput，不含她主动说话
            basis: 'user_input',
            threshold_min: this._threshold,
            over: this._minutes >= this._threshold,
        };
    }

    getTools() { return []; }
}

module.exports = CompanionHealthPlugin;
