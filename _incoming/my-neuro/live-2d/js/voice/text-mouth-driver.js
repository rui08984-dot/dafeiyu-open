// Visual speech for text-only replies. It never creates an audio context or a TTS request.
//
// 口型两档（viseme 落地，拍板 pypinyin 路线）：
//   ① 音节驱动：prefetch 过的字从 viseme 缓存拿开口度，按 90ms/字 顺序消费——嘴形跟音节走；
//   ② 正弦兜底：缓存没预热好（冷启动 300ms 内）或文本无汉字时，退回原来的正弦振荡。
// 两档共用同一条时长估计（90ms/字 + 180ms 收尾），互相无缝切换。
const __silentAudit = require('../core/silent-audit.js');
const viseme = require('./viseme.js');

const MS_PER_CHAR = 90;

class TextMouthDriver {
    constructor(setMouth) {
        this.setMouth = setMouth;
        this.timer = null;
        this.until = 0;
        this.startedAt = 0;
        this._shapes = [];   // viseme 开口度队列（按字，随 push 追加）
    }

    push(text) {
        const s = String(text || '');
        const letters = s.match(/[\p{L}\p{N}]/gu);
        if (!letters?.length) return;
        const now = Date.now();
        this.until = Math.max(this.until, now + Math.min(3000, letters.length * MS_PER_CHAR + 180));
        // viseme 预热（异步；整段文本一次 python 调用，之后逐字命中缓存）
        try { viseme.prefetch(s); } catch (e) { try { __silentAudit.audit('text-mouth-driver.js:27', e); } catch (e2) {} }
        const shapes = [];
        for (const ch of s) {
            const o = viseme.shapeFor(ch);
            if (o !== null) shapes.push(o);
        }
        if (shapes.length) this._shapes.push(...shapes);
        if (this.timer !== null) return;
        this.startedAt = now;
        this.tick();
    }

    tick() {
        if (Date.now() >= this.until) { this.stop(); return; }
        const elapsed = Date.now() - this.startedAt;
        if (this._shapes.length) {
            // ① 音节驱动：按 90ms/字 消费形状队列（超出队列长度就停在最后一字）
            const idx = Math.min(this._shapes.length - 1, Math.floor(elapsed / MS_PER_CHAR));
            this.setMouth(0.15 + 0.75 * this._shapes[idx]);   // 0.15 底噪：闭嘴不完全闭合
        } else {
            // ② 正弦兜底（原实现）
            const phase = elapsed / 1000;
            this.setMouth(0.12 + 0.5 * Math.abs(Math.sin(phase * Math.PI * 7)));
        }
        this.timer = setTimeout(() => this.tick(), 50);
    }

    stop() {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.until = 0;
        this._shapes = [];
        this.setMouth(0);
    }
}

module.exports = { TextMouthDriver };
