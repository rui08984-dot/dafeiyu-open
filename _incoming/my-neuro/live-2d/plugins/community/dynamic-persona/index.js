const fs = require('fs');
const path = require('path');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { recordFile } = require('../../../js/core/records-path.js');

/**
 * 动态人格（2026-11-15 五十八轮重写）
 *
 * 原实现有四个真问题（agent 盘点 + 本地复现）：
 *   ① 第 16 行 `if (msgCount % freq !== 0 && this.persona) return;` —— 只在**更新那一轮**
 *      注入，其余轮次根本不让模型看到状态（实测 3 次请求：r1 有、r2 无、r3 有）。
 *   ②「更新」和「注入」耦合在同一段：不更新就不注入，语义本来就该分开。
 *   ③ 状态只在内存，重启即失忆；也没有时间戳，看不出「这是几小时前的状态」。
 *   ④ prompt 里写的是「肥牛」，而人设是「大肥鱼」—— 生成的状态描述会把名字带歪。
 *
 * 现在的分工：
 *   · **每轮都注入**（有状态就注入，带「几小时前」的新鲜度）
 *   · 每 N 轮**后台**换一次状态（不 await：不让一次 LLM 调用把回复延迟顶上去；
 *     新状态下一轮生效，这在对话节奏上完全够）
 *   · 落盘 `data/人格状态.json`，重启后读回；超过 stale_hours 视为过期不注入
 */

const STATE_FILE = '人格状态.json';

class DynamicPersonaPlugin extends Plugin {

    async onInit() {
        this.persona = '';
        this.personaAt = 0;
        this.msgCount = 0;
        this._updating = false;
        const cfg = this.context.getPluginConfig() || {};
        this.updateFreq = Number(cfg.update_frequency) > 0 ? Number(cfg.update_frequency) : 3;
        // 状态是「此刻的心情」——放了一整夜就不该再当此刻。默认 6 小时过期。
        this.staleHours = Number(cfg.stale_hours) > 0 ? Number(cfg.stale_hours) : 6;
        this._load();
    }

    _file() {
        try { return recordFile(STATE_FILE); } catch (e) { return path.join(__dirname, STATE_FILE); }
    }

    _load() {
        try {
            const raw = fs.readFileSync(this._file(), 'utf8');
            const j = JSON.parse(raw);
            if (j && typeof j.persona === 'string' && j.persona.trim()) {
                this.persona = j.persona.trim().slice(0, 40);
                this.personaAt = Number(j.updated_at) || 0;
                this.context.log('info', '动态人格已读回：' + this.persona + '（' + this._ageText() + '）');
            }
        } catch (e) {
            // 没有历史状态是正常的第一次启动，不用当错误；但文件存在却坏了必须留痕
            if (e && e.code !== 'ENOENT') {
                try { this.context.log('warn', '动态人格状态读取失败（按空状态继续）: ' + (e.message || e)); } catch (e2) {}
            }
        }
    }

    _save() {
        try {
            const p = this._file();
            const tmp = p + '.tmp';
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(tmp, JSON.stringify({ persona: this.persona, updated_at: this.personaAt }, null, 2), 'utf8');
            fs.renameSync(tmp, p);
        } catch (e) {
            try { this.context.log('warn', '动态人格状态落盘失败: ' + (e.message || e)); } catch (e2) {}
        }
    }

    _ageMs() {
        return this.personaAt ? Math.max(0, Date.now() - this.personaAt) : Infinity;
    }

    _ageText() {
        const ms = this._ageMs();
        if (!Number.isFinite(ms)) return '无时间戳';
        const min = Math.round(ms / 60000);
        if (min < 1) return '刚刚';
        if (min < 60) return min + ' 分钟前';
        const h = Math.round(min / 60);
        return h + ' 小时前';
    }

    _fresh() {
        return !!this.persona && this._ageMs() <= this.staleHours * 3600000;
    }

    async onLLMRequest(request) {
        // ① 注入：每轮都注入（这是原实现最大的 bug —— 只在更新轮注入）
        //    2026-11-16：这段带「N 分钟前」时间戳、每轮都变，**不能再拼进 system** ——
        //    system 是消息数组第一条，它变一个字节 = 后面的整段历史缓存作废。
        //    改走 request.addVolatile：由 llm-handler 拼到最后一条 user 消息末尾。
        if (this._fresh()) {
            const line = `（你现在的状态：${this.persona}；${this._ageText()}）`;
            if (typeof request.addVolatile === 'function') {
                request.addVolatile(line);
            } else {
                // 兼容没有 addVolatile 的旧调用方（python 桥/单测）：退回旧的 system 追加
                const sysMsg = request.messages.find((m) => m.role === 'system');
                if (sysMsg) sysMsg.content += '\n\n' + line;
            }
        }

        // ② 更新：每 N 轮后台刷一次，**不 await**（不把一次 LLM 调用加到回复延迟上）
        const userMsg = [...request.messages].reverse().find((m) => m.role === 'user');
        const userText = typeof userMsg?.content === 'string'
            ? userMsg.content
            : userMsg?.content?.[0]?.text || '';
        // P1-14（2026-11-22 审计）：主动开口的脚手架（「你正和用户一起看屏幕…」/「[自动触发]」）
        // 不是「用户此刻的状态」。拿它生成 persona 会把状态写成「正在陪用户看剧」，
        // 也不该推进「每 N 轮」的计数。真实用户轮才计数/更新。
        try {
            if (!userText || require('../../../js/core/memory-scaffold.js').isScaffolding(userText, 'user')) return;
        } catch (e) { /* 过滤器不可用就按原行为（不放行会让她永远不更新） */ }
        this.msgCount += 1;
        if (this.msgCount % this.updateFreq !== 0 || this._updating) return;

        const hour = new Date().getHours();
        const timeStr = hour < 6 ? '深夜' : hour < 12 ? '上午' : hour < 18 ? '下午' : hour < 22 ? '晚上' : '深夜';

        this._updating = true;
        Promise.resolve()
            .then(() => this.context.callLLM(
                `现在是${timeStr}，用户说："${String(userText).slice(0, 200)}"。\n` +
                `请用10字以内描述大肥鱼此刻的状态/心情，影响她这次回复的语气。` +
                `只输出状态本身，不要解释，例如："有点犯困但还在撑" 或 "突然对这个话题来了兴趣"`,
                { temperature: 1.2 },
            ))
            .then((text) => {
                const clean = String(text || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 40);
                if (!clean) {
                    // 空结果不要覆盖旧状态：宁可状态旧一点，也不要「此刻状态：空」
                    try { this.context.log('warn', '动态人格更新返回空，保留旧状态'); } catch (e) {}
                    return;
                }
                this.persona = clean;
                this.personaAt = Date.now();
                this._save();
                this.context.log('info', `动态人格更新: ${clean}`);
            })
            .catch((e) => {
                try { this.context.log('warn', '动态人格更新失败（保留旧状态）: ' + (e && e.message || e)); } catch (e2) {}
            })
            .finally(() => { this._updating = false; });
    }
}

module.exports = DynamicPersonaPlugin;
