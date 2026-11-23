const __silentAudit = require('../../../js/core/silent-audit.js');
const axios = require('axios');
const { logToTerminal } = require('../../../js/api-utils.js');
// 发 /add 前的脚手架过滤（2026-11-22）：与 memory-recall/memory-evolve 共用同一份规则。
// 加载失败必须 fail-open：过滤器坏了可以多写一条，不能把自动保存整条停掉。
let scaffoldFilter;
try { scaffoldFilter = require('../../../js/core/memory-scaffold.js'); }
catch (e) { scaffoldFilter = null; }

class MemosClient {
    constructor(pluginConfig) {
        this.enabled = pluginConfig.enabled !== false;
        this.apiUrl = pluginConfig.api_url || 'http://127.0.0.1:8003';
        this.autoInject = pluginConfig.auto_inject !== false;
        this.injectTopK = pluginConfig.inject_top_k ?? 3;
        this.similarityThreshold = pluginConfig.similarity_threshold ?? 0.6;
        this.autoSave = pluginConfig.auto_save !== false;
        this.saveInterval = pluginConfig.save_interval ?? 5;
        this.conversationBuffer = [];
        this.roundCount = 0;
        this._saving = false;

        // ⚡ 挂起感知：MemOS 挂过两次都是人工发现的（doctor 卡 9 分钟=在等它超时）。
        // 失败连击计数：连续 3 次失联大声告警；doctor 经 healthInfo() 读数字。自愈重启需拍板，这里只感知。
        this._failStreak = 0;
        this._lastFailAt = 0;
        this._lastOkAt = 0;
    }

    _markOk() {
        if (this._failStreak > 0) {
            const msg = `🧠 MemOS 恢复（此前连续失联 ${this._failStreak} 次）`;
            console.log(msg);
            try { logToTerminal('info', msg); } catch (e) { try { __silentAudit.audit('memos-client.js:28', e); } catch (e2) {} }
        }
        this._failStreak = 0;
        this._lastOkAt = Date.now();
    }

    _markFail(where, error) {
        this._failStreak += 1;
        this._lastFailAt = Date.now();
        // 第 3 次起大声告警，之后每 10 次提醒一次（别每轮刷屏，也不能哑——挂起必须有人知道）
        if (this._failStreak === 3 || (this._failStreak > 3 && (this._failStreak - 3) % 10 === 0)) {
            const msg = `[MemOS] ⚠️ 连续 ${this._failStreak} 次失联（${where}: ${(error && error.message) || error}）——记忆后端疑似挂起。doctor 卡很久=在等它超时；先 curl 127.0.0.1:8003/health 再决定重启`;
            console.error(msg);
            try { logToTerminal('warn', msg); } catch (e) { try { __silentAudit.audit('memos-client.js:41', e); } catch (e2) {} }
        }
    }

    /** doctor/诊断读这个：失败连击与最近成功/失败时间 */
    healthInfo() {
        return {
            enabled: this.enabled,
            failStreak: this._failStreak,
            lastOkAt: this._lastOkAt,
            lastFailAt: this._lastFailAt,
            apiUrl: this.apiUrl,
        };
    }

    async search(query, topK = null) {
        if (!this.enabled) return [];
        // 熔断（2026-11-15 五十八轮）：连续 3 次失联后，60s 内不再尝试。
        // 原来每轮输入都先等最多 6 秒（MemOS 挂起时这是常态），用户只会觉得「她反应慢」。
        // 熔断不是放弃：窗口一过自动再探一次，探通了 _markOk 会把连击清零。
        if (this._failStreak >= 3 && Date.now() - (this._lastFailAt || 0) < 60000) return [];

        try {
            const response = await axios.post(`${this.apiUrl}/search`, {
                query,
                top_k: topK || this.injectTopK,
                user_id: 'feiniu_default',
                similarity_threshold: this.similarityThreshold
            }, { timeout: 6000 });

            this._markOk();
            return response.data.memories || [];
        } catch (error) {
            console.error('MemOS 搜索失败:', error.message);
            this._markFail('search', error);
            return [];
        }
    }

    async add(messages) {
        if (!this.enabled) return { status: 'disabled' };

        // 2026-11-22 记忆污染：主动开口脚手架（watch-screen/auto-chat/alive-state/…）
        // 在对话历史里也是 role=user，不能作为「主人说的话」写进 MemOS。
        // 只在本地剔除，assistant/真实用户消息原样保留；失败一律按原样发送（fail-open）。
        let payload = messages;
        let dropped = 0;
        if (scaffoldFilter && typeof scaffoldFilter.filterMemoryMessages === 'function') {
            try {
                const r = scaffoldFilter.filterMemoryMessages(messages);
                payload = r.messages;
                dropped = r.dropped.length;
                if (dropped) console.log(`[MemOS] 过滤主动脚手架 ${dropped} 条（不写入长期记忆）`);
                // 只剩 assistant（用户那句是脚手架）→ 这轮没有「用户说过的事」，不发 /add
                if (!payload.some((m) => m && m.role === 'user')) {
                    return { status: 'skipped', reason: 'scaffolding-only', dropped };
                }
            } catch (e) {
                payload = messages;
                dropped = 0;
            }
        }

        try {
            const response = await axios.post(`${this.apiUrl}/add`, {
                messages: payload,
                user_id: 'feiniu_default'
            }, { timeout: 10000 });

            this._markOk();
            return response.data;
        } catch (error) {
            console.error('MemOS 添加记忆失败:', error.message);
            this._markFail('add', error);
            return { status: 'error', message: error.message };
        }
    }

    async addWithBuffer(messages) {
        if (!this.enabled) return { status: 'disabled' };

        this.conversationBuffer.push(...messages);
        this.roundCount++;

        console.log(`[MemOS] 对话已缓存 (${this.roundCount}/${this.saveInterval} 轮)`);

        if (this.roundCount >= this.saveInterval && !this._saving) {
            this._saving = true;
            console.log(`[MemOS] 达到 ${this.saveInterval} 轮，开始保存记忆...`);
            try {
                const toSave = [...this.conversationBuffer];
                this.conversationBuffer = [];
                this.roundCount = 0;
                const result = await this.add(toSave);
                return { status: 'saved', result };
            } catch (error) {
                console.error('MemOS 批量保存失败:', error.message);
                return { status: 'error', message: error.message };
            } finally {
                this._saving = false;
            }
        }

        return { status: 'buffered', bufferedRounds: this.roundCount, remaining: this.saveInterval - this.roundCount };
    }

    async flushBuffer() {
        if (!this.enabled || this.conversationBuffer.length === 0) return { status: 'empty' };

        console.log(`[MemOS] 强制保存缓存的 ${this.roundCount} 轮对话...`);
        try {
            const result = await this.add(this.conversationBuffer);
            const savedRounds = this.roundCount;
            this.conversationBuffer = [];
            this.roundCount = 0;
            return { status: 'flushed', message: `已保存 ${savedRounds} 轮对话`, result };
        } catch (error) {
            console.error('MemOS 强制保存失败:', error.message);
            return { status: 'error', message: error.message };
        }
    }

    /** 将 ISO/时间戳格式化为中文本地日期时间，供 AI 理解「记忆发生时间」 */
    _formatMemoryTimeForPrompt(timestamp) {
        if (!timestamp) return '';
        try {
            const d = new Date(timestamp);
            if (isNaN(d.getTime())) {
                return typeof timestamp === 'string' ? timestamp : String(timestamp);
            }
            return d.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
        } catch (_) {
            return typeof timestamp === 'string' ? timestamp : String(timestamp);
        }
    }

    formatMemoriesForPrompt(memories) {
        if (!memories || memories.length === 0) return '';

        return memories.map(mem => {
            const content = typeof mem === 'string' ? mem : mem.content;
            const pl = mem && typeof mem.payload === 'object' && mem.payload ? mem.payload : null;
            const timestamp = mem.created_at || mem.timestamp || (pl && (pl.created_at || pl.timestamp));
            const updatedAt = mem.updated_at || (pl && pl.updated_at);

            const timeStr = this._formatMemoryTimeForPrompt(timestamp);
            const updateMark = (updatedAt && updatedAt !== timestamp) ? '（已更新）' : '';
            return timeStr ? `- ${content} 【${timeStr}】${updateMark}` : `- ${content}`;
        }).join('\n');
    }

    async isAvailable() {
        if (!this.enabled) return false;
        try {
            const response = await axios.get(`${this.apiUrl}/health`, { timeout: 2000 });
            return response.data.status === 'healthy';
        } catch (_) {
            return false;
        }
    }
}

module.exports = { MemosClient };
