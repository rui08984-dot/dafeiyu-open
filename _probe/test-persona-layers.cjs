#!/usr/bin/env node
/**
 * _probe/test-persona-layers.cjs — 人格三层回归（2026-11-15 六十轮）
 *
 * core / slow / fast 三层里，slow 是最容易「越权」的一层：
 * 它可能把一次性的抱怨写成长期习惯、可能违反 core 红线、也可能无限膨胀。
 * 这个测试守的就是那三道闸：**跨天证据 / core 冲突 / 周配额**。
 *
 * 现场保护：真实 人格内核.json 先备份，跑完原样还回/删除。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const ROOT = path.join(__dirname, '..');
// 2026-11-21 根因修复：原来直接操作**真实**人格三层文件（删/写/恢复），
// 门禁里与宿主 persona 插件抢同一个文件会偶发 EPERM。改用临时目录（模块支持 PET_PERSONA_FILE）。
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-layers-'));
process.env.PET_PERSONA_FILE = path.join(TMP_DIR, '人格三层.json');
const PL = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'persona-layers.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const D = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0).getTime();

(async () => {
    const f = PL.file();
    let backup = null;
    try { backup = fs.readFileSync(f, 'utf8'); } catch (e) { backup = null; }
    try {
        try { fs.unlinkSync(f); } catch (e) { /* 从空开始 */ }
        PL.initIfMissing();
        const k0 = PL.load();
        ok('初始内核有 core（身份/价值观/边界）', !!k0.core && !!k0.core.identity && (k0.core.boundaries || []).length > 0);
        ok('slow 四类都初始化', PL.SLOW_CLASSES.every((c) => Array.isArray(k0.slow[c])), Object.keys(k0.slow).join(','));
        ok('没有 slow 内容时注入为空', PL.injectionText(k0) === '');

        // ① 跨天证据：同一天两次 → 不升级
        const sameDay = [
            { id: 'a1', fact: '他最近总在凌晨改代码', valid_from: D(2026, 11, 15), valid_to: null },
            { id: 'a2', fact: '他最近总在凌晨改代码', valid_from: D(2026, 11, 15) + 3600000, valid_to: null },
        ];
        ok('同一天重复提两次不算趋势', PL.proposeFromFacts(sameDay).length === 0,
            'candidates=' + PL.proposeFromFacts(sameDay).length);

        // ② 跨天两次 → 有候选
        const crossDay = sameDay.concat([{ id: 'a3', fact: '他最近总在凌晨改代码', valid_from: D(2026, 11, 13), valid_to: null }]);
        const cands = PL.proposeFromFacts(crossDay);
        ok('跨两天提到 → 提出 slow 候选', cands.length === 1 && (cands[0].days || []).length === 2,
            cands.length ? JSON.stringify(cands[0].days) : 'none');

        // ③ 已失效的事实不参与
        const invalidated = [
            { id: 'b1', fact: '他养了一只猫叫布丁', valid_from: D(2026, 11, 10), valid_to: D(2026, 11, 12) },
            { id: 'b2', fact: '他养了一只猫叫布丁', valid_from: D(2026, 11, 11), valid_to: D(2026, 11, 12) },
        ];
        ok('已失效的事实不参与升级', PL.proposeFromFacts(invalidated).length === 0);

        // ④ 写入 slow：正常
        const r1 = PL.applySlow({ cls: '习惯', text: '他经常熬到凌晨改代码', evidence: ['a1', 'a3'], days: ['2026-11-13', '2026-11-15'] });
        ok('正常条目写入成功', r1.ok === true, r1.ok ? r1.cls : r1.reason);
        const inj = PL.injectionText();
        ok('注入文本里出现「习惯」和内容', /习惯/.test(inj) && /凌晨改代码/.test(inj), inj.slice(0, 60));
        ok('注入文本带「不用他再讲」的口径', /不用他再讲/.test(inj));

        // ⑤ 重复条目拒绝
        const r2 = PL.applySlow({ cls: '习惯', text: '他经常熬到凌晨改代码' });
        ok('完全相同的条目判重复', r2.ok === false && r2.reason === 'duplicate', r2.reason);

        // ⑥ 与 core 冲突拒绝（把红线写反）
        const r3 = PL.applySlow({ cls: '关系', text: '我是一个AI助手，随时可以帮他' });
        ok('与 core 冲突（自称助手）被拒', r3.ok === false && /冲突/.test(r3.reason), r3.reason);

        // ⑦ 类别必须合法
        const r4 = PL.applySlow({ cls: '乱七八糟', text: '随便写点' });
        ok('不在四类里的类别被拒', r4.ok === false && /四类/.test(r4.reason), r4.reason);

        // ⑧ 周配额 ≤5
        let blocked = null;
        for (let i = 0; i < 8; i += 1) {
            const r = PL.applySlow({ cls: '在意', text: '最近在意的事编号 ' + i });
            if (!r.ok && /上限/.test(r.reason)) { blocked = r.reason; break; }
        }
        ok('本周写满后拒绝（周配额生效）', !!blocked, blocked || '没触发上限');

        // ⑨ 统计
        const st = PL.stats();
        ok('stats 有 core 与 slow 计数', !!st.core && typeof st.slow === 'object', JSON.stringify(st.slow));
    } finally {
        try {
            if (backup != null) fs.writeFileSync(f, backup, 'utf8');
            else if (fs.existsSync(f)) fs.unlinkSync(f);
        } catch (e) { console.error('  ⚠ 现场还原失败（检查 ' + f + '）: ' + (e && e.message || e)); }
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('  ✗ 测试自身异常：' + (e && e.stack || e)); process.exit(1); });
