// plugins/community/inner-state/index.js
//
// 目的：让 LLM 知道她**此刻真实的**情绪与心气。
//
// 原来这件事由 dynamic-persona 干：每 3 条消息调一次 LLM 编一句「现在是有点犯困但还在撑」。
// 问题有两个：① 每 3 条消息多一次 LLM 调用（纯浪费）；② 那句状态是编的，
// 而我们的情绪引擎本来就有真实值（11 种情绪 + 跨天心气）。
//
// 所以这里改成：直接读真实状态，零模型调用，只在每轮对话前挂一行提示。
const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');

const PATCH_ID = 'inner-state';
const EMOTION_ZH = {
    happy: '有点开心', sad: '有点难过', angry: '在生气', surprise: '被惊到了',
    shy: '不太好意思', smug: '挺得意', tease: '在使坏', bored: '无聊',
    aggrieved: '有点委屈', guilty: '心虚', sleepy: '困了', neutral: '没什么情绪',
};

class InnerStatePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._enabled = cfg.enabled_line !== false;
        this._includeReason = cfg.include_reason !== false;
    }

    /** 读她当前的真实状态（都来自渲染层，不花钱） */
    _snapshot() {
        try {
            const body = global.petBody;
            if (!body) return null;
            const snap = typeof body.emotionSnapshot === 'function' ? body.emotionSnapshot() : null;
            const mood = global.__petMood;
            const parts = [];
            if (snap && snap.emotion && snap.emotion !== 'neutral') {
                let line = EMOTION_ZH[snap.emotion] || snap.emotion;
                if (this._includeReason && snap.lastHit && snap.lastHit.matched) line += '（刚才听到「' + String(snap.lastHit.matched).slice(0, 12) + '」）';
                parts.push(line);
            }
            if (mood && typeof mood.describe === 'function') {
                try {
                    const d = mood.describe();
                    // 有余味时把「为什么」也带上：她不是每次都重置的人设，
                    // 而是「还记得昨天那件事」的人。
                    if (d && d.line) parts.push('心气：' + d.line);
                } catch (e) { try { __silentAudit.audit('index.js:46', e); } catch (e2) {} }
            }
            return parts.length ? parts : null;
        } catch (e) { return null; }
    }

    async onUserInput() {
        if (!this._enabled) return;
        const lines = [];

        // ── 被打断时的接续语 ────────────────────────────────────────────
        // 只有**真的在播时被打断**才确认（2026-11-22 根因修复）。
        // 旧实现只看「30 秒内有没有打点」，而 PTT 无论是否在播都会打点 →
        // 用户普通提个问题，她也开口「行，你说」。判定与一次性消费统一在
        // js/core/interrupt-event.js（wasPlaying + 30s 过期 + take 后清空）。
        try {
            const ev = require('../../../js/core/interrupt-event.js').take(globalThis, Date.now());
            if (ev) {
                const cut = String(ev.text || '').slice(-16);
                lines.push('（你上一句被截断了' + (cut ? '，停在「' + cut + '」' : '') +
                    '。这一轮开头用不超过 6 个字确认一下，比如"行，你说"、"嗯？"、"你说"；不要道歉，不要解释，不要重复被截断的内容。）');
            }
        } catch (e) { try { __silentAudit.audit('index.js:interrupt-take', e); } catch (e2) {} }

        // ── 当下状态 ────────────────────────────────────────────────────
        const parts = this._snapshot();
        if (parts) lines.push('（你现在的状态：' + parts.join('；') + '。语气自然带上就行，别把这句念出来。）');

        if (!lines.length) { try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (e) { try { __silentAudit.audit('index.js:74', e); } catch (e2) {} } return; }
        try { this.context.addSystemPromptPatch(PATCH_ID, lines.join('\n'), { volatile: true }); } catch (e) { try { __silentAudit.audit('index.js:75', e); } catch (e2) {} }
    }

    async onLLMResponse() {
        try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (e) { try { __silentAudit.audit('index.js:79', e); } catch (e2) {} }
    }
}

module.exports = InnerStatePlugin;