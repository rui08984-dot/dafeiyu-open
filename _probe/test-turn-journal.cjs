#!/usr/bin/env node
/**
 * _probe/test-turn-journal.cjs — 回合日志（B2，2026-11-21）
 *
 * 要防的回归：
 *   ① 「有 intent 无 result」没有被标记（进程被杀后查不到做到哪一步）
 *   ② recover 不幂等（每次启动重复标同一批）
 *   ③ 参数明文落盘（密码/正文写进日志）
 *   ④ 「自动重放」——本项目明确不做，测试用「recover 不产生任何执行副作用」守着：
 *      recover 只 append interrupted 记录，绝不调用工具。
 *
 * 数据隔离：PET_JOURNAL_DIR 指到临时目录（A2）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

const tmpRoot = iso.setUpTempDataRoot('pet-journal-');
process.env.PET_JOURNAL_DIR = path.join(tmpRoot, 'runtime');

const J = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'turn-journal.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

try {
    // ① 正常一轮：intent + result
    const id1 = J.beginIntent({ turnId: 't-test-1', tool: 'see', args: { mode: 'windows' }, target: 'paint' });
    ok('beginIntent 返回 id', /^i[a-z0-9]+-[a-z0-9]+$/.test(id1), id1);
    J.endResult(id1, { ok: true, detail: '', ms: 42 });
    ok('有 result 的回合 recover 不标记', J.recover().length === 0);

    // ② 被杀的一轮：只有 intent
    const id2 = J.beginIntent({ turnId: 't-test-2', tool: 'act', args: { action: 'click', password: 'SECRET-PLAINTEXT' }, target: '#3' });
    const marked = J.recover();
    ok('未闭合 intent 被标 interrupted', marked.length === 1 && marked[0].id === id2, 'marked=' + marked.length);
    ok('recover 幂等（第二次不再重复标）', J.recover().length === 0);

    // ③ 参数不落明文
    const raw = fs.readFileSync(J.FILE, 'utf8');
    ok('日志里没有参数明文', !raw.includes('SECRET-PLAINTEXT'));
    ok('日志里有 argsHash（16 位）', /"argsHash":"[0-9a-f]{16}"/.test(raw));

    // ④ interrupted 记录带 note（可查、可解释）
    ok('interrupted 记录带 interrupted_unknown', /"kind":"interrupted"/.test(raw) && /interrupted_unknown/.test(raw));

    // ⑤ stats 概览
    const st = J.stats();
    ok('stats 计数正确（2 intent / 1 result / 1 interrupted）',
        st.intents === 2 && st.results === 1 && st.interrupted === 1,
        'intent=' + st.intents + ' result=' + st.results + ' interrupted=' + st.interrupted);
    ok('stats.open=0（都被标记或完成）', st.open === 0);
} finally {
    iso.cleanup(tmpRoot);
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
