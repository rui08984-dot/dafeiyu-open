#!/usr/bin/env node
/**
 * _probe/test-event-projection.cjs —— E6 事件溯源投影单测
 *
 * 验收口径（提案原文）：
 *   · 能从 append-only 事件流重建出「当前投影」；
 *   · 投影与现有「在线状态」可逐字段比对，不一致时指出差异字段；
 *   · `--dry-run` **绝不写盘**（前后整棵数据目录 sha256 不变）；
 *   · 坏行跳过不崩。
 *
 * 覆盖源：screen-timeline / episodes / memory-events / turn-journal。
 * 全程 PET_DATA_ROOT + PET_JOURNAL_DIR 隔离，不碰真实 data；判定：0=全过。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const iso = require('./lib/test-isolation.cjs');

// 顺序纪律：先隔离，再 require 业务模块（records-path / turn-journal 在 require 时定目录）
const tmpRoot = iso.setUpTempDataRoot('pet-projection-');
const journalDir = path.join(tmpRoot, 'journal');
process.env.PET_JOURNAL_DIR = journalDir;

const ROOT = path.join(__dirname, '..');
const CORE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'js', 'core');
const { recordFile, RECORDS_DIR } = require(path.join(CORE, 'records-path.js'));
const T = require(path.join(CORE, 'screen-timeline.js'));
const ES = require(path.join(CORE, 'episode-store.js'));
const TJ = require(path.join(CORE, 'turn-journal.js'));
const EP = require(path.join(CORE, 'event-projection.js'));
const CLI = path.join(CORE, 'event-projection.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function eq(name, got, want) {
    return ok(name, JSON.stringify(got) === JSON.stringify(want), 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ── 磁盘指纹：整棵临时数据目录（相对路径 → sha256）────────────────────────
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function walk(dir, base, out) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of names.sort()) {
        const p = path.join(dir, name);
        let st = null;
        try { st = fs.statSync(p); } catch (e) { continue; }
        if (st.isDirectory()) walk(p, base, out);
        else {
            try { out[path.relative(base, p)] = sha256(fs.readFileSync(p)); } catch (e) { out[path.relative(base, p)] = 'READ-ERROR'; }
        }
    }
}
function treeHash() {
    const out = {};
    walk(tmpRoot, tmpRoot, out);
    return out;
}
function hashEqual(a, b) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return false;
    return ka.every((k) => a[k] === b[k]);
}
function writeLine(file, objOrString) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = typeof objOrString === 'string' ? objOrString : JSON.stringify(objOrString);
    fs.appendFileSync(file, line + '\n', 'utf8');
}

const now = Date.now();
const todayFile = () => recordFile('屏幕时间线-' + T.dayStamp(now) + '.jsonl');

try {
    // ── ⓪ 隔离自证 ──────────────────────────────────────────────────────
    console.log('== ⓪ 数据隔离自证 ==');
    try {
        iso.assertIsolated(recordFile('屏幕时间线-20260101.jsonl'));
        iso.assertIsolated(TJ.FILE);
        ok('PET_DATA_ROOT / PET_JOURNAL_DIR 隔离生效', true, tmpRoot);
    } catch (e) {
        ok('PET_DATA_ROOT / PET_JOURNAL_DIR 隔离生效', false, e && e.message);
    }

    // ── ① 造事件流（含坏行）──────────────────────────────────────────────
    console.log('\n== ① 造假事件流（含坏行）==');
    writeLine(todayFile(), { t: now - 300000, activity: 'coding', app: 'Code', title: 'a.js', text: '写代码' });
    writeLine(todayFile(), { t: now - 240000, activity: 'coding', app: 'Code', title: 'a.js', text: '写代码 2' });
    writeLine(todayFile(), '{"t":');                                   // 坏行：JSON 截断
    writeLine(todayFile(), { t: now - 180000, activity: 'gaming', app: 'Steam', title: 'PVZ', text: '打游戏' });
    writeLine(todayFile(), { t: now - 120000, activity: 'coding', app: 'Code', title: 'b.js', text: '又写代码' });
    writeLine(todayFile(), { t: 0, activity: 'bad', text: 't<=0 非法' });   // 坏行：parseLine 拒绝

    writeLine(ES.episodePath(), { at: now - 600000, title: '上午', summary: '修了登录 bug', facts: ['喜欢猫', '怕冷'] });
    writeLine(ES.episodePath(), 'not-json-at-all');                    // 坏行
    writeLine(ES.episodePath(), { at: now - 300000, title: '下午', summary: '继续写代码', facts: ['喜欢猫'] });
    writeLine(ES.episodePath(), { at: now - 200000, title: '无摘要' });  // 无 summary → 非卡片

    writeLine(TJ.FILE, { kind: 'intent', id: 'i1', at: now - 500000, tool: 'click_at', turn_id: 't1' });
    writeLine(TJ.FILE, { kind: 'result', id: 'i1', at: now - 499000, ok: true });
    writeLine(TJ.FILE, { kind: 'intent', id: 'i2', at: now - 400000, tool: 'press_key', turn_id: 't2' });
    writeLine(TJ.FILE, { kind: 'interrupted', id: 'i3', at: now - 300000, tool: 'drag', note: 'interrupted_unknown' });

    ok('三份事件流已落到隔离目录', fs.existsSync(todayFile()) && fs.existsSync(ES.episodePath()) && fs.existsSync(TJ.FILE));

    // ── ② 屏幕时间线投影 + dry-run 不写盘 ─────────────────────────────────
    console.log('\n== ② screen-timeline：重放 / 差异 / dry-run ==');
    {
        const before = treeHash();
        const r = EP.rebuild({ source: 'screen-timeline', dryRun: true, options: { now, minutes: 60, limit: 20 } });
        const after = treeHash();
        ok('rebuild 成功', r.ok === true, JSON.stringify(r.error || null));
        eq('坏行计数', { total: r.events.total, valid: r.events.valid, bad: r.events.bad }, { total: 6, valid: 4, bad: 2 });
        eq('投影条数（窗口内）', r.projection.count, 4);
        eq('最近一条 = 最后写入的 coding', {
            t: r.projection.lastT, activity: r.projection.lastActivity, app: r.projection.lastApp,
            title: r.projection.lastTitle, text: r.projection.lastText,
        }, { t: now - 120000, activity: 'coding', app: 'Code', title: 'b.js', text: '又写代码' });
        eq('activity 序列（连续同 activity+app+title 压成一段）',
            r.projection.activitySeq, ['coding|Code|a.js', 'gaming|Steam|PVZ', 'coding|Code|b.js']);
        eq('不同 activity 集合', r.projection.distinctActivities, ['coding', 'gaming']);
        ok('与在线状态 IN SYNC', r.diff.inSync === true, JSON.stringify(r.diff.fields));
        ok('dryRun 标记 + 未写盘', r.dryRun === true && r.wrote === false && r.materialized === null);
        ok('dry-run 前后整棵数据目录 sha256 完全一致', hashEqual(before, after),
            'before=' + Object.keys(before).length + ' after=' + Object.keys(after).length);
        ok('dry-run 没产生「投影-*.json」', Object.keys(after).every((k) => !/投影-.*\.json$/.test(k)));

        // 注入错误的在线状态 → 必须指出差异字段
        const drift = EP.rebuild({
            source: 'screen-timeline', dryRun: true,
            options: { now, minutes: 60, limit: 20, online: Object.assign({}, r.projection, { lastActivity: 'sleeping', count: 3 }) },
        });
        ok('注入漂移：inSync=false', drift.diff.inSync === false);
        ok('漂移字段包含 lastActivity / count',
            drift.diff.fields.some((f) => f.field === 'lastActivity')
            && drift.diff.fields.some((f) => f.field === 'count'),
            JSON.stringify(drift.diff.fields.map((f) => f.field)));
        const la = drift.diff.fields.find((f) => f.field === 'lastActivity');
        ok('差异里给出 projected / online 两侧原值',
            la && la.projected === 'coding' && la.online === 'sleeping', JSON.stringify(la));

        // 默认 dryRun（不传 dryRun）也必须只读
        const def = EP.rebuild({ source: 'screen-timeline', options: { now } });
        ok('dryRun 默认 true', def.dryRun === true && def.wrote === false);
    }

    // ── ③ episodes / memory-events 投影 ──────────────────────────────────
    console.log('\n== ③ episodes / memory-events：重放 / 事实现值 ==');
    {
        const before = treeHash();
        const ep = EP.rebuild({ source: 'episodes', dryRun: true, options: { now } });
        ok('episodes 投影成功', ep.ok === true, JSON.stringify(ep.error || null));
        eq('episodes 坏行计数（1 JSON 坏 + 1 无 summary）',
            { total: ep.events.total, valid: ep.events.valid, bad: ep.events.bad }, { total: 4, valid: 2, bad: 2 });
        eq('episodes 投影字段', {
            count: ep.projection.count, lastAt: ep.projection.lastAt,
            lastTitle: ep.projection.lastTitle, lastSummary: ep.projection.lastSummary,
            factsTotal: ep.projection.factsTotal,
        }, { count: 2, lastAt: now - 300000, lastTitle: '下午', lastSummary: '继续写代码', factsTotal: 3 });
        eq('不同事实去重', ep.projection.distinctFacts, ['喜欢猫', '怕冷']);
        ok('episodes 与在线状态 IN SYNC', ep.diff.inSync === true, JSON.stringify(ep.diff.fields));

        const me = EP.rebuild({ source: 'memory-events', dryRun: true, options: { now } });
        ok('memory-events（episodes 事实现值）投影成功', me.ok === true, JSON.stringify(me.error || null));
        eq('事实现值：去重条数 / 总出现次数 / 最近事实', {
            factCount: me.projection.factCount, factTotal: me.projection.factTotal,
            lastFact: me.projection.lastFact, episodeCount: me.projection.episodeCount,
        }, { factCount: 2, factTotal: 3, lastFact: '喜欢猫', episodeCount: 2 });
        eq('事实现值列表', me.projection.facts, ['喜欢猫', '怕冷']);
        ok('memory-events 与在线状态 IN SYNC', me.diff.inSync === true, JSON.stringify(me.diff.fields));
        const after = treeHash();
        ok('episodes/memory-events dry-run 前后 sha256 不变', hashEqual(before, after));

        // 人为制造在线状态不一致（模拟「在线缓存过期」）
        const drifted = EP.rebuild({
            source: 'memory-events', dryRun: true,
            options: { now, online: Object.assign({}, me.projection, { factCount: 0, facts: [] }) },
        });
        ok('memory 漂移能指出 factCount / facts 差异',
            drifted.diff.inSync === false
            && drifted.diff.fields.some((f) => f.field === 'factCount')
            && drifted.diff.fields.some((f) => f.field === 'facts'),
            JSON.stringify(drifted.diff.fields.map((f) => f.field)));
    }

    // ── ④ turn-journal：未闭合 intent = 当前状态 ──────────────────────────
    console.log('\n== ④ turn-journal：事件重放出「未闭合 intent」==');
    {
        const r = EP.rebuild({ source: 'turn-journal', dryRun: true });
        ok('turn-journal 投影成功', r.ok === true, JSON.stringify(r.error || null));
        eq('事件计数', {
            total: r.projection.total, intents: r.projection.intents,
            results: r.projection.results, interrupted: r.projection.interrupted,
        }, { total: 4, intents: 2, results: 1, interrupted: 1 });
        eq('未闭合 intent 只剩 i2', r.projection.openIds, ['i2']);
        eq('未闭合数量', r.projection.open, 1);
        eq('最后一条是 interrupted', { kind: r.projection.lastKind, at: r.projection.lastAt }, { kind: 'interrupted', at: now - 300000 });
        ok('与 turn-journal.stats() IN SYNC', r.diff.inSync === true, JSON.stringify(r.diff.fields));
        const live = TJ.stats();
        eq('在线 stats 同口径', {
            open: live.open, total: live.total, lastKind: live.last && live.last.kind,
        }, { open: 1, total: 4, lastKind: 'interrupted' });
    }

    // ── ⑤ 全源 dry-run：整棵目录 sha256 不变 ─────────────────────────────
    console.log('\n== ⑤ 全源 dry-run：磁盘指纹不变 ==');
    {
        const before = treeHash();
        const all = EP.rebuildAll({ dryRun: true });
        const after = treeHash();
        ok('四个源都 ok', all.every((r) => r.ok === true), all.map((r) => r.canonicalSource + ':' + r.ok).join(' '));
        ok('四个源都与在线状态同步', all.every((r) => r.diff.inSync === true),
            all.filter((r) => !r.diff.inSync).map((r) => r.canonicalSource).join(',') || 'all-sync');
        ok('全源 dry-run 前后 sha256 完全一致', hashEqual(before, after),
            'files=' + Object.keys(before).length);
        ok('全源 dry-run 未产生投影文件', Object.keys(after).every((k) => !/投影-.*\.json$/.test(k)));
    }

    // ── ⑥ --write 只新增投影文件，源文件一字不动 ─────────────────────────
    console.log('\n== ⑥ --write：只落投影，不改事件流 ==');
    {
        const before = treeHash();
        const r = EP.rebuild({ source: 'episodes', dryRun: false });
        const after = treeHash();
        ok('write 成功', r.ok === true && r.wrote === true, JSON.stringify({ ok: r.ok, wrote: r.wrote, error: r.error }));
        ok('投影文件已落盘且在隔离目录', !!r.materialized && fs.existsSync(r.materialized) && iso.assertIsolated(r.materialized));
        const saved = JSON.parse(fs.readFileSync(r.materialized, 'utf8'));
        eq('落盘投影内容可回读', saved.projection, r.projection);
        const changed = Object.keys(after).filter((k) => before[k] !== after[k]);
        const added = Object.keys(after).filter((k) => !(k in before));
        const removed = Object.keys(before).filter((k) => !(k in after));
        ok('只新增一个投影文件（源文件 sha256 不变）',
            added.length === 1 && /投影-episodes\.json$/.test(added[0]) && changed.length === 1 && removed.length === 0,
            JSON.stringify({ added, removed, changed }));
    }

    // ── ⑦ CLI：--dry-run 退出码 0、--json 可解析、未知源退出码 3 ──────────
    console.log('\n== ⑦ CLI ==');
    {
        const before = treeHash();
        let out = '';
        let status = 0;
        try {
            out = cp.execFileSync(process.execPath, [CLI, '--dry-run', '--source', 'screen-timeline', '--json'], {
                env: Object.assign({}, process.env, { PET_DATA_ROOT: tmpRoot, PET_JOURNAL_DIR: journalDir }),
                encoding: 'utf8', timeout: 30000, windowsHide: true,
            });
        } catch (e) {
            status = e.status === undefined ? -1 : e.status;
            out = String((e.stdout || '') + (e.stderr || ''));
        }
        ok('CLI --dry-run 退出码 0', status === 0, 'status=' + status + ' out=' + out.slice(0, 200));
        let parsed = null;
        try { parsed = JSON.parse(out); } catch (e) { /* 下面判红 */ }
        ok('CLI --json 输出可解析', !!parsed);
        if (parsed) {
            ok('CLI 结果 dryRun/wrote/inSync 正确',
                parsed.dryRun === true && parsed.wrote === false && parsed.diff.inSync === true,
                JSON.stringify({ dryRun: parsed.dryRun, wrote: parsed.wrote, sync: parsed.diff && parsed.diff.inSync }));
            eq('CLI 重放条数', parsed.projection && parsed.projection.count, 4);
        }
        const after = treeHash();
        // 注意：上一节 --write 落的投影文件在 before 里已存在，这一步不应再变
        ok('CLI dry-run 前后 sha256 不变', hashEqual(before, after));

        let badStatus = 0;
        try {
            cp.execFileSync(process.execPath, [CLI, '--dry-run', '--source', 'no-such-source'], {
                env: Object.assign({}, process.env, { PET_DATA_ROOT: tmpRoot, PET_JOURNAL_DIR: journalDir }),
                encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: 'pipe',
            });
        } catch (e) { badStatus = e.status === undefined ? -1 : e.status; }
        ok('未知源退出码 3', badStatus === 3, 'status=' + badStatus);
    }

    // ── ⑧ 纯函数：diffCanonical / canonical 形状 ─────────────────────────
    console.log('\n== ⑧ 导出纯函数 ==');
    {
        const d = EP.diffCanonical({ a: 1, b: [1, 2], c: 'x' }, { a: 1, b: [1, 2], c: 'y' }, ['a', 'b', 'c']);
        ok('diffCanonical 只报差异字段', d.inSync === false && d.fields.length === 1 && d.fields[0].field === 'c', JSON.stringify(d));
        const same = EP.diffCanonical({ a: 1 }, { a: 1 }, ['a']);
        ok('diffCanonical 一致时 inSync', same.inSync === true && same.fields.length === 0);
        ok('readJsonlFile 坏行不崩', (() => {
            const f = path.join(tmpRoot, 'synthetic.jsonl');
            fs.writeFileSync(f, '{"ok":1}\nBROKEN\n\n{"ok":2}\n', 'utf8');
            const r = EP.readJsonlFile(f, (line, obj) => (obj && obj.ok ? obj : null));
            return r.events.length === 2 && r.bad === 1;
        })());
        ok('未知源返回 ok:false 且列出可用源', (() => {
            const r = EP.rebuild({ source: 'nope' });
            return r.ok === false && r.error === 'unknown_source' && Array.isArray(r.sources) && r.sources.includes('episodes');
        })());
    }

    console.log('\n' + (fail === 0 ? '✅ event-projection：' : '❌ event-projection：') + 'PASS ' + pass + ' / FAIL ' + fail);
} finally {
    iso.cleanup(tmpRoot);
}

process.exit(fail === 0 ? 0 : 1);
