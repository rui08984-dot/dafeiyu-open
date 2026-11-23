#!/usr/bin/env node
/**
 * _probe/test-daily-report.cjs —— 每日成绩单（D1，2026-11-22）
 *
 * 要防的回归：
 *   ① 成绩单偷偷调 LLM / 写提示词（无数据必须是 0 token）
 *   ② 数字没有来源（“今天开口 5 次”点不开看是哪 5 条）
 *   ③ 调整不可撤销（改完 daily_limit 没法还原，用户不喜欢只能手改文件）
 *   ④ 关闭开关不生效 / 无数据还输出一堆 0
 *   ⑤ 成绩单改动源文件（只读报告不能成为第二个写者）
 *
 * 数据隔离：PET_DATA_ROOT + mkdtemp；pet-runtime 两个文件显式指向临时目录。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iso = require('./lib/test-isolation.cjs');

// 顺序很重要：先设 PET_DATA_ROOT，再 require records-path / 业务模块
const tmpRoot = iso.setUpTempDataRoot('pet-daily-');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { recordFile, RECORDS_DIR } = require(path.join(APP, 'js', 'core', 'records-path.js'));
const DR = require(path.join(APP, 'js', 'core', 'daily-report.js'));
const SB = require(path.join(APP, 'js', 'core', 'speech-budget.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function writeJsonl(file, rows) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}
function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function listFiles(dir) {
    const out = [];
    (function walk(d) {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of ents) {
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) walk(p);
            else out.push(p);
        }
    })(dir);
    out.sort();
    return out.join('\n');
}

// 固定本地时间：2026-11-22 15:00（避免跨午夜导致今天/昨天边界抖动）
const NOW = new Date(2026, 10, 22, 15, 0, 0).getTime();
const START = new Date(2026, 10, 22, 0, 0, 0).getTime();
const runtimeRoot = path.join(tmpRoot, 'pet-runtime');
const runtimeDir = path.join(runtimeRoot, 'data');
const perfFile = path.join(runtimeDir, 'performance-log.jsonl');
const histFile = path.join(runtimeDir, 'dispatch-history.jsonl');
fs.mkdirSync(RECORDS_DIR, { recursive: true });
fs.mkdirSync(runtimeDir, { recursive: true });

try {
    // ── 隔离证明 ──────────────────────────────────────────────────────
    ok('记录室落在临时目录', iso.assertIsolated(recordFile('主动日志.json')) === true, RECORDS_DIR);
    ok('pet-runtime 数据也在临时目录', perfFile.startsWith(tmpRoot) && histFile.startsWith(tmpRoot), path.dirname(perfFile));

    // ── 伪造三源 + 记忆源 ─────────────────────────────────────────────
    const outcomes = ['accepted', 'ignored', 'ignored', 'negative', 'accepted'];
    const attempts = outcomes.map((o, i) => ({
        id: 'a' + i, at: START + 3600000 * (i + 1), plugin: 'watch-screen', cost: 1, outcome: o,
    }));
    attempts.push({ id: 'yesterday', at: START - 3600000, plugin: 'old', cost: 1, outcome: 'accepted' });
    writeJson(recordFile('主动日志.json'), { day: '2026-11-22', used: 6, attempts });
    writeJson(recordFile('主动预算.json'), { daily_limit: 8, note: 'keep-me' });

    const dispatchRows = [];
    for (let i = 0; i < 10; i += 1) {
        dispatchRows.push({
            ts: START + 1000 * (i + 1),
            action: 'click_at',
            arg: '',
            ok: i < 8,
            verified: i < 6,
            effect: i < 4 ? 'confirmed' : (i < 8 ? 'readonly' : 'not_sent'),
        });
    }
    dispatchRows.push({ ts: START - 1000, action: 'old', ok: true, verified: true, effect: 'confirmed' });
    writeJsonl(histFile, dispatchRows);

    const perfRows = [];
    for (let i = 0; i < 4; i += 1) perfRows.push({ ts: START + 2000 * (i + 1), kind: 'play', clipId: 'c' + i });
    for (let i = 0; i < 3; i += 1) perfRows.push({ ts: START + 3000 * (i + 1), kind: 'skip', reason: 'cooldown' });
    perfRows.push({ ts: START + 5000, kind: 'user_input_after', clipId: 'c0', ms: 1000 });
    perfRows.push({ ts: START - 2000, kind: 'play', clipId: 'old' });
    writeJsonl(perfFile, perfRows);

    writeJsonl(recordFile('episodes.jsonl'), [
        { at: START + 10000, title: 'A', summary: '今天第一张卡', facts: ['f1', 'f2'] },
        { at: START + 20000, title: 'B', summary: '今天第二张卡', facts: ['f3'] },
        { at: START - 10000, title: 'old', summary: '昨天的卡', facts: ['f0', 'f0b', 'f0c', 'f0d'] },
    ]);
    writeJsonl(recordFile('记忆待写队列.jsonl'), [{ x: 1 }, { x: 2 }]);
    const digestDir = path.join(RECORDS_DIR, '记忆整理');
    fs.mkdirSync(digestDir, { recursive: true });
    for (const d of ['2026-11-20.md', '2026-11-21.md', '2026-11-22.md']) fs.writeFileSync(path.join(digestDir, d), '# 记忆整理\n', 'utf8');

    const speechFile = recordFile('主动日志.json');
    const speechHashBefore = sha256(speechFile);

    // ── 正常成绩单 ────────────────────────────────────────────────────
    const r = DR.build({ now: NOW, performanceLogFile: perfFile, dispatchHistoryFile: histFile });
    ok('build 成功且非空', r.ok === true && r.empty === false && r.disabled === false, JSON.stringify({ ok: r.ok, empty: r.empty }));
    ok('文本 ≤120 字', Array.from(r.text).length <= 120, Array.from(r.text).length + ' 字：' + r.text);
    ok('开口数字正确（昨日不计，预算可见）', /开口 5 次（接受 2，预算 6\/8）/.test(r.text), r.text);
    ok('操控数字正确（昨日不计，失败可见）', /操控 10 步（验证 6，失败 2）/.test(r.text), r.text);
    ok('表演数字正确（昨日不计）', /表演 4 段（被接 1）/.test(r.text), r.text);
    ok('记忆数字正确（整理天数/待写可见）', /记忆 2 张卡（整理 3 天，待写 2）/.test(r.text), r.text);
    ok('日期正确', r.day === '2026-11-22', r.day);

    // 每个出现在文本里的整数都必须能在 sources 里找到同值来源
    const nums = (r.text.match(/\d+/g) || []).map(Number);
    const sourceValues = new Set(Object.values(r.sources).map((s) => Number(s.value)));
    const missing = nums.filter((n) => !sourceValues.has(n));
    ok('文本中每个数字都能下钻到 source', missing.length === 0, '缺来源：' + missing.join(','));

    // 每个数字指向的文件/字段都要具体
    ok('开口次数可下钻到 主动日志.json.attempts',
        r.sources.speech_attempts.value === 5
        && /主动日志\.json$/.test(r.sources.speech_attempts.file)
        && /attempts/.test(r.sources.speech_attempts.field),
        JSON.stringify(r.sources.speech_attempts));
    ok('验证数可下钻到 dispatch-history.jsonl.verified',
        r.sources.dispatch_verified.value === 6
        && r.sources.dispatch_verified.file === histFile
        && /verified/.test(r.sources.dispatch_verified.field),
        JSON.stringify(r.sources.dispatch_verified));
    ok('失败数可下钻到 dispatch-history.jsonl.ok',
        r.sources.dispatch_failed.value === 2
        && r.sources.dispatch_failed.file === histFile
        && /ok/.test(r.sources.dispatch_failed.field),
        JSON.stringify(r.sources.dispatch_failed));
    ok('表演场次可下钻到 performance-log.jsonl.kind',
        r.sources.perf_plays.value === 4
        && r.sources.perf_plays.file === perfFile
        && /play/.test(r.sources.perf_plays.field),
        JSON.stringify(r.sources.perf_plays));
    ok('今日记忆卡可下钻到 episodes.jsonl.at',
        r.sources.memory_episodes_today.value === 2
        && /episodes\.jsonl$/.test(r.sources.memory_episodes_today.file)
        && /at/.test(r.sources.memory_episodes_today.field),
        JSON.stringify(r.sources.memory_episodes_today));
    ok('整理天数可下钻到 记忆整理/*.md',
        r.sources.memory_digest_days.value === 3
        && /记忆整理$/.test(r.sources.memory_digest_days.file)
        && /md/.test(r.sources.memory_digest_days.field),
        JSON.stringify(r.sources.memory_digest_days));
    ok('预算额度可下钻到 主动预算.json.daily_limit',
        r.sources.speech_limit.value === 8
        && /主动预算\.json$/.test(r.sources.speech_limit.file)
        && r.sources.speech_limit.field === 'daily_limit',
        JSON.stringify(r.sources.speech_limit));
    ok('预算用量可下钻到 主动日志.json.used',
        r.sources.speech_used.value === 6
        && /主动日志\.json$/.test(r.sources.speech_used.file)
        && /used/.test(r.sources.speech_used.field),
        JSON.stringify(r.sources.speech_used));

    const allSources = Object.values(r.sources);
    ok('source 路径全是绝对路径且只在临时目录',
        allSources.every((s) => !s.file || (path.isAbsolute(s.file) && s.file.startsWith(tmpRoot))),
        allSources.filter((s) => s.file && !s.file.startsWith(tmpRoot)).map((s) => s.file).join(',') || 'ok');

    // 只读证明：build 前后源文件字节不变
    ok('build 只读（主动日志未变）', sha256(speechFile) === speechHashBefore);

    // ── 一条可撤销调整 ────────────────────────────────────────────────
    ok('给出一条调整', r.adjustments.length === 1, JSON.stringify(r.adjustments));
    const adj = r.adjustments[0] || {};
    ok('调整键/原值/目标值正确',
        adj.key === 'speech.daily_limit' && adj.from === 8 && adj.to === 6 && !!adj.why,
        JSON.stringify(adj));

    // 先造一个运行中的预算单例，证明 apply 是热生效而不是只改文件
    const budget = SB.singleton({
        logFile: recordFile('主动日志.json'),
        cfgFile: recordFile('主动预算.json'),
        now: () => NOW,
    });
    ok('预算单例初始额度 = 8', budget.stats().limit === 8, String(budget.stats().limit));

    const applied = DR.applyAdjustment(adj);
    ok('apply 成功并热重载', applied.ok === true && applied.reloaded === true && budget.stats().limit === 6,
        JSON.stringify({ ok: applied.ok, reloaded: applied.reloaded, limit: budget.stats().limit }));
    const cfgAfterApply = JSON.parse(fs.readFileSync(recordFile('主动预算.json'), 'utf8'));
    ok('apply 保留配置里的其他键', cfgAfterApply.daily_limit === 6 && cfgAfterApply.note === 'keep-me', JSON.stringify(cfgAfterApply));

    const reverted = DR.revertAdjustment(applied.receipt);
    const cfgAfterRevert = JSON.parse(fs.readFileSync(recordFile('主动预算.json'), 'utf8'));
    ok('revert 用回执原值还原（含热重载）',
        reverted.ok === true && reverted.restored === 8 && budget.stats().limit === 8 && cfgAfterRevert.daily_limit === 8,
        JSON.stringify({ ok: reverted.ok, restored: reverted.restored, limit: budget.stats().limit }));

    // 防覆盖：文件被别处改过后再 apply 应拒绝
    writeJson(recordFile('主动预算.json'), { daily_limit: 5, note: 'changed-elsewhere' });
    const conflict = DR.applyAdjustment(adj);
    ok('配置被改过时拒绝覆盖', conflict.ok === false && /已被改过/.test(conflict.error), conflict.error);
    writeJson(recordFile('主动预算.json'), { daily_limit: 8, note: 'keep-me' });

    // ── 无数据：0 token / 0 写入 / 不加载 LLM ─────────────────────────
    for (const f of ['主动日志.json', '主动预算.json', 'episodes.jsonl', '记忆待写队列.jsonl']) {
        try { fs.unlinkSync(recordFile(f)); } catch (e) { /* 已删 */ }
    }
    fs.rmSync(digestDir, { recursive: true, force: true });

    const beforeFiles = listFiles(tmpRoot);
    const origFetch = global.fetch;
    let empty;
    try {
        global.fetch = () => { throw new Error('network forbidden in daily-report'); };
        empty = DR.build({
            now: NOW,
            performanceLogFile: path.join(tmpRoot, 'no-perf.jsonl'),
            dispatchHistoryFile: path.join(tmpRoot, 'no-history.jsonl'),
        });
    } finally {
        global.fetch = origFetch;
    }
    ok('无数据 → text 空、无调整、empty=true',
        empty.ok === true && empty.empty === true && empty.text === '' && empty.adjustments.length === 0,
        JSON.stringify({ ok: empty.ok, empty: empty.empty, text: empty.text }));
    ok('无数据 → 不新建/不修改任何文件', listFiles(tmpRoot) === beforeFiles);
    ok('无数据 → 不加载 LLM 模块',
        !Object.keys(require.cache).some((p) => /llm-(client|handler|provider)/.test(p)),
        Object.keys(require.cache).filter((p) => /llm-/.test(p)).join(',') || 'none');

    // ── 一键关闭 ──────────────────────────────────────────────────────
    writeJson(recordFile('成绩单设置.json'), { enabled: false });
    const off = DR.build({ now: NOW, performanceLogFile: perfFile, dispatchHistoryFile: histFile });
    ok('关闭开关后不统计、不输出',
        off.ok === true && off.disabled === true && off.empty === true && off.text === '' && Object.keys(off.sources).length === 0,
        JSON.stringify({ disabled: off.disabled, text: off.text }));
    try { fs.unlinkSync(recordFile('成绩单设置.json')); } catch (e) { /* ignore */ }

    // ── 坏文件不静默 ──────────────────────────────────────────────────
    fs.writeFileSync(recordFile('主动日志.json'), '{ this is not json', 'utf8');
    writeJson(recordFile('主动预算.json'), { daily_limit: 8 });
    const bad = DR.build({ now: NOW, performanceLogFile: perfFile, dispatchHistoryFile: histFile });
    ok('坏源文件不炸、进 warnings',
        bad.ok === true && bad.warnings.some((w) => w.includes('[speech]')) && bad.sources.speech_attempts.value === 0,
        JSON.stringify(bad.warnings));
    ok('坏源文件在 source 上也带 error（不只 warnings）',
        /JSON/.test(String(bad.sources.speech_attempts.error || '')),
        String(bad.sources.speech_attempts.error || ''));

    // ── 调整的另一半：被接得多 + 额度用满 → 放宽；样本不足 → 不动 ──
    {
        const upAttempts = [];
        for (let i = 0; i < 6; i += 1) {
            upAttempts.push({ id: 'u' + i, at: START + 1000 * (i + 1), outcome: i < 5 ? 'accepted' : 'ignored' });
        }
        writeJson(recordFile('主动日志.json'), { day: '2026-11-22', used: 8, attempts: upAttempts });
        writeJson(recordFile('主动预算.json'), { daily_limit: 8 });
        const up = DR.build({ now: NOW, performanceLogFile: perfFile, dispatchHistoryFile: histFile });
        ok('被接得多且额度用满 → 放宽一档',
            up.adjustments.length === 1 && up.adjustments[0].to === 10 && /放宽/.test(up.adjustments[0].why),
            JSON.stringify(up.adjustments));

        // 只有 3 条判定样本：宁可不动，也不凭运气调（与 speech-budget 的 <20 同一条纪律）
        writeJson(recordFile('主动日志.json'), {
            day: '2026-11-22',
            used: 8,
            attempts: [0, 1, 2].map((i) => ({ id: 'few' + i, at: START + 1000 * (i + 1), outcome: 'accepted' })),
        });
        const few = DR.build({ now: NOW, performanceLogFile: perfFile, dispatchHistoryFile: histFile });
        ok('样本不足时不给调整', few.adjustments.length === 0, JSON.stringify(few.adjustments));
    }

    // ── 截断工具本身 ──────────────────────────────────────────────────
    const clamped = DR.clampChars('今天：' + '开口 '.repeat(100), 500);
    ok('clampChars 把长度夹在 ≤120', Array.from(clamped).length <= 120, Array.from(clamped).length + ' 字');

    // ── 日终产出（2026-11-22 审计 U6：模块原先零调用点）────────────────
    // 只在这个临时 PET_DATA_ROOT 下跑：不碰真实 data。
    if (typeof DR.runDaily === 'function') {
        const r1 = DR.runDaily();
        ok('runDaily 能产出成绩单文件', r1.ok === true && !!r1.file, JSON.stringify({ ok: r1.ok, empty: r1.empty, file: r1.file }).slice(0, 120));
        ok('runDaily 落在临时记录室', r1.file ? iso.assertIsolated(r1.file) : false, r1.file || '');
        const r2 = DR.runDaily();
        ok('runDaily 幂等（当天不重写）', r2.ok === true && r2.alreadyDone === true);
        if (r1.file) {
            const body = fs.readFileSync(r1.file, 'utf8');
            ok('成绩单内容带日期与正文', body.startsWith('#' + DR.dayKey()) && body.length > 10, body.split('\n')[0]);
        }
    } else {
        ok('模块导出 runDaily（U6 接线）', false, 'runDaily 不存在');
    }
} finally {
    iso.cleanup(tmpRoot);
}

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
