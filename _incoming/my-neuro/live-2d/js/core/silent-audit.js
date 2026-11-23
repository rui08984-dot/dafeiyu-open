// silent-audit.js —— 静默失败审计钩子（2026-11-08，359 处空 catch 治理的收口方案）
//
// 为什么不是"给每处都加 console.warn"：
//   仓里 330 处 `catch (e) { try { __silentAudit.audit('silent-audit.js:4', e); } catch (e2) {} }` 分布在 UI 解绑、护栏探测、可选能力降级里，
//   多数属正常路径（比如"解绑一个已移除的监听"）。逐处打日志会制造新的刷屏，
//   比静默还糟——真错误会被埋掉。正确做法是**集中记账**：
//   · 每次静默失败记一条（文件/行/错误摘要），在内存里聚合去重
//   · 同一位置同一错误只记一次（不刷屏）
//   · 暴露 window.__silentAudit 供 doctor / 控制台查询
//   · 只有"新增的唯一失败点"才真正打一行 warn（有信息量，不重复）
//
// 用法（改造已有 catch）：
//   const { audit } = require('../core/silent-audit.js');   // 路径按需
//   try { ... } catch (e) { audit('模块/位置', e); }
//
// 也可以只做统计不输出：audit(loc, e, { quiet: true })

const seen = new Map();       // key -> { count, firstAt, lastAt, sample }
const MAX_KEYS = 300;         // 上限，防内存膨胀
let total = 0;

function summarize(err) {
    if (!err) return 'unknown';
    if (typeof err === 'string') return err.slice(0, 120);
    const msg = String(err.message || err).replace(/\s+/g, ' ').trim();
    return msg.slice(0, 120) || String(err).slice(0, 120);
}

/**
 * 记录一次静默失败。
 * @param {string} loc  位置标识（模块/函数名，或 '文件名:行号'）
 * @param {*} err       捕获到的错误
 * @param {{quiet?: boolean}} [opts] quiet=true 时只记账不输出
 */
function audit(loc, err, opts = {}) {
    try {
        total += 1;
        const where = String(loc || 'unknown');
        const msg = summarize(err);
        const key = where + '｜' + msg;
        const now = Date.now();
        const hit = seen.get(key);
        if (hit) {
            hit.count += 1;
            hit.lastAt = now;
            return hit;
        }
        const rec = { where, msg, count: 1, firstAt: now, lastAt: now };
        if (seen.size >= MAX_KEYS) {
            // 淘汰最旧的（Map 保持插入顺序）
            const firstKey = seen.keys().next().value;
            if (firstKey !== undefined) seen.delete(firstKey);
        }
        seen.set(key, rec);
        // 首次出现的失败点才输出——重复的不刷屏
        if (!opts.quiet) {
            try { console.warn('[静默失败] ' + where + '：' + msg); } catch (e2) {}
        }
        return rec;
    } catch (e) {
        return null;   // 审计自身绝不能再抛
    }
}

/** 当前审计快照（doctor 用）。 */
function snapshot() {
    const list = [...seen.values()].sort((a, b) => b.lastAt - a.lastAt);
    return {
        total,
        unique: list.length,
        top: list.slice(0, 20),
    };
}

function reset() { seen.clear(); total = 0; }

// 暴露到 window，doctor / 控制台可直接查
try {
    if (typeof window !== 'undefined') {
        window.__silentAudit = { snapshot, reset, audit };
    }
} catch (e) { try { __silentAudit.audit('silent-audit.js:82', e); } catch (e2) {} }

module.exports = { audit, snapshot, reset };
