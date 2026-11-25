#!/usr/bin/env node
/**
 * _probe/test-turn-outcome.cjs —— turn.end 必须按真实结果落 outcome（2026-11-25）
 *
 * 旧缺陷：runTurn 内部把异常/空回复/工具链失败都 catch 成正常 return，
 * 外层 runTurnWithTurn 一律 `endTurn('ok')` —— turn.end 里成功和失败长得一样。
 *
 * 现在：
 *   · 成功 → outcome='ok'；
 *   · 异常 → outcome='error'，errorKind ∈ network|quota|tool|parse|empty|...；
 *   · 用户打断 → outcome='interrupted'，errorKind='interrupted'；
 *   · 配额/限流 → outcome='blocked'，errorKind='quota'。
 *
 * 全程临时遥测目录，不碰真实 .runtime/telemetry.jsonl。
 * 用法：node _probe/test-turn-outcome.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-turn-outcome-'));
process.env.PET_TELEMETRY_DIR = TMP;
process.env.PET_DATA_ROOT = TMP;

const turnCtx = require(path.join(LIVE, 'js', 'core', 'turn-context.js'));
const { classifyTurnFailure } = require(path.join(LIVE, 'js', 'ai', 'llm-handler.js'));

const TELEMETRY = path.join(TMP, 'telemetry.jsonl');
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function rows() {
    if (!fs.existsSync(TELEMETRY)) return [];
    return fs.readFileSync(TELEMETRY, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
const lastEnd = () => rows().filter((r) => r.type === 'turn.end').pop() || {};

// ── 分类纯函数 ────────────────────────────────────────────────────────────
const cases = [
    ['USER_INTERRUPTED → interrupted', (() => { const e = new Error('USER_INTERRUPTED'); return e; })(), 'interrupted', 'interrupted'],
    ['请求过于频繁 → blocked/quota', new Error('请求过于频繁，请稍后再试'), 'blocked', 'quota'],
    ['429 → blocked/quota', new Error('429 Too Many Requests'), 'blocked', 'quota'],
    ['未获取到有效回复 → error/empty', new Error('未获取到有效的AI回复'), 'error', 'empty'],
    ['工具调用失败 → error/tool', new Error('工具调用失败，无法完成功能扩展'), 'error', 'tool'],
    ['SyntaxError → error/parse', new SyntaxError('Unexpected token'), 'error', 'parse'],
    ['fetch failed → error/network', new TypeError('fetch failed'), 'error', 'network'],
    ['ETIMEDOUT → error/network', new Error('connect ETIMEDOUT 1.2.3.4:443'), 'error', 'network'],
    ['未知异常 → error/unknown（保底不冒充 ok）', new Error('something odd'), 'error', 'unknown'],
];
for (const [name, err, wantOutcome, wantKind] of cases) {
    const got = classifyTurnFailure(err);
    ok(name, got.outcome === wantOutcome && got.errorKind === wantKind,
        'got=' + got.outcome + '/' + got.errorKind);
}

// ── turn.end 集成：成功 / 异常 / 打断 / 配额 ─────────────────────────────
turnCtx.beginTurn('chat');
turnCtx.markPhase('llm');
const okTurn = turnCtx.endTurn('ok');
let row = lastEnd();
ok('成功: outcome=ok', row.outcome === 'ok', row.outcome);
ok('成功: 不出现 errorKind', row.errorKind === undefined);
ok('成功: 旧字段齐全（cat/type/span/source/turn_id）',
    row.cat === 'turn' && row.type === 'turn.end' && row.span === 'turn'
    && row.source === 'chat' && row.turn_id === okTurn.id);
ok('成功: metrics.total_ms 是数字', typeof row.metrics.total_ms === 'number');

turnCtx.beginTurn('chat');
turnCtx.markPhase('llm');
turnCtx.endTurn('error', { errorKind: 'network' });
row = lastEnd();
ok('异常: outcome=error', row.outcome === 'error', row.outcome);
ok('异常: errorKind=network 落进遥测', row.errorKind === 'network', row.errorKind);
ok('异常: metrics 仍保留', typeof row.metrics.total_ms === 'number');

turnCtx.beginTurn('chat');
turnCtx.endTurn('interrupted', { errorKind: 'interrupted' });
row = lastEnd();
ok('打断: outcome=interrupted', row.outcome === 'interrupted', row.outcome);
ok('打断: errorKind=interrupted', row.errorKind === 'interrupted', row.errorKind);

turnCtx.beginTurn('chat');
turnCtx.endTurn('blocked', { errorKind: 'quota' });
row = lastEnd();
ok('配额: outcome=blocked', row.outcome === 'blocked', row.outcome);
ok('配额: errorKind=quota', row.errorKind === 'quota', row.errorKind);
ok('stats().last 带 outcome/errorKind', (() => {
    const s = turnCtx.stats().last;
    return s && s.outcome === 'blocked' && s.errorKind === 'quota';
})());

// 兼容旧调用：只有 outcome、无 extra
turnCtx.beginTurn('tool');
turnCtx.endTurn('tool-batch');
row = lastEnd();
ok('兼容旧调用 endTurn(outcome)', row.outcome === 'tool-batch' && row.errorKind === undefined);

// 没有活动轮次时收轮是 no-op
turnCtx.endTurn('ok');
ok('无活动轮次 endTurn 返回 null', turnCtx.endTurn('ok') === null);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
