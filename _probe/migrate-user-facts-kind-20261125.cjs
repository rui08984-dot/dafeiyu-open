#!/usr/bin/env node
/**
 * _probe/migrate-user-facts-kind-20261125.cjs —— 用户事实层补 kind / event 有效期（P0-3 迁移）
 *
 * 审计背景（docs/research/记忆链-功能审计-2026-11-25.md §3 P0-3）：
 *   `用户事实.json` 63 条全部 valid_to=null，其中 62 条是片段卡提炼的一次性事件，
 *   被 `recall action=facts` 当成「现在成立的事实」回答。
 *
 * 本脚本**只加字段、不改文本**：
 *   · 给每条补 kind（trait | preference | event，规则见 js/core/user-facts.js classifyFact）
 *   · kind=event 且 valid_to 为空 → valid_to = 事件日期 + 1 天（解析不出 → valid_from + 7 天）
 *   · 已有 kind 的条目一律不动（幂等：重跑 changed=0）
 *   · 写盘前先备份 用户事实.json.bak-20261125（已存在则不覆盖）
 *
 * 用法：
 *   node _probe/migrate-user-facts-kind-20261125.cjs          # 真跑（先备份）
 *   node _probe/migrate-user-facts-kind-20261125.cjs --dry    # 只看会改几条
 * 测试：require 本文件拿 migrateFacts()，在临时记录室上验幂等。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UF = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'user-facts.js'));

/**
 * 纯迁移：就地补 kind / event 的 valid_to。
 * 2026-11-25 P0-2：已判成 event 的**习惯/周期性**句子（每天/一般/平时/早上喝咖啡…）改回 trait，
 * 并清掉那次误判带来的 valid_to。只动 kind（原本就是 event 才改），不改文本。
 * @param {object|Array} doc {version, updated_at, facts:[…]} 或裸数组
 * @param {{now?:number}} [opts]
 * @returns {{changed:number, events:number, habits:number, facts:Array}}
 */
function migrateFacts(doc, opts) {
    const o = opts || {};
    const now = Number(o.now) || Date.now();
    const facts = Array.isArray(doc) ? doc : (doc && Array.isArray(doc.facts) ? doc.facts : []);
    let changed = 0;
    let events = 0;
    let habits = 0;
    for (const f of facts) {
        if (!f || typeof f.fact !== 'string') continue;
        if (f.kind) {
            // 幂等：已经有 kind 的条目不再改，唯一例外是「当时被误判成 event 的习惯句」。
            if (f.kind === 'event' && UF.isHabitFact(f.fact)) {
                f.kind = 'trait';
                f.valid_to = null;   // 习惯没有失效期（与 addFact 写 trait 时同形）
                changed += 1;
                habits += 1;
            }
            continue;
        }
        const kind = UF.classifyFact(f.fact, f.source);
        f.kind = kind;
        changed += 1;
        if (kind === 'event' && !f.valid_to) {
            f.valid_to = UF.eventValidTo(f.fact, Number(f.valid_from) || now);
            events += 1;
        }
    }
    return { changed, events, habits, facts };
}

function main() {
    const dry = process.argv.includes('--dry');
    const file = UF.file();
    if (!fs.existsSync(file)) {
        console.error('找不到 ' + file);
        process.exit(1);
    }
    const raw = fs.readFileSync(file, 'utf8');
    const doc = JSON.parse(raw);
    const before = JSON.stringify(doc.facts || doc);
    if (!dry) {
        // 2026-11-25 late：二轮迁移（event→trait 回改）前再留一份独立备份，不覆盖首轮备份。
        for (const suffix of ['.bak-20261125', '.bak-20261125-late']) {
            const backup = file + suffix;
            if (!fs.existsSync(backup)) {
                fs.writeFileSync(backup, raw, 'utf8');
                console.log('已备份 → ' + backup);
            } else {
                console.log('备份已存在（不覆盖）→ ' + backup);
            }
        }
    }
    const r = migrateFacts(doc, { now: Date.now() });
    if (!dry && r.changed) {
        const tmp = file + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    }
    const beforeTexts = JSON.stringify(JSON.parse(before).map((f) => f.fact));
    const afterTexts = JSON.stringify((doc.facts || doc).map((f) => f.fact));
    console.log((dry ? '[dry] ' : '') + '迁移完成：改 ' + r.changed + ' 条（其中 event ' + r.events
        + ' 条，习惯回改 trait ' + (r.habits || 0) + ' 条），文本未改=' + (beforeTexts === afterTexts));
    return r;
}

if (require.main === module) {
    try { main(); } catch (e) { console.error('迁移失败：', e && e.stack || e); process.exit(2); }
}

module.exports = { migrateFacts, main };
