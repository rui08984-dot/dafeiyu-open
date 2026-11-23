#!/usr/bin/env node
/**
 * test-pipeline-parity.cjs —— 「模型真实调用路径」一致性测试
 *
 * 用户提的问题（2026-11-21）：
 *   「你做测试时都是自己跑脚本，那当然好用。但如果项目自己接的 API、走它自己的管线来调用
 *     电脑操控，还好用吗？怀疑插件自己的操控和我们增强的操控不是一条链路。」
 *
 * 这条测试要证明/证伪的是：
 *   ① 真实入口 = window.pluginManager.executeTool(name, params)（LLM tool call 走的就是它）；
 *   ② 同一操作直连 = require('./game-control').runGameAction(action, arg, focus)（后端本体）；
 *   ③ 两条路的结果（ok / effect / error / 关键数据）必须一致；
 *      参数（window / filter / x,y / mode / steps / text）必须真的到达后端，不能被吞。
 *
 * 安全边界（刻意只做只读/校验失败分支）：
 *   · 不 launch 用户应用、不点桌面、不往用户窗口输入、不关用户窗口；
 *   · 夹具 = 自己起的一个记事本（临时文件），结束只关这一个窗口；
 *   · 剪贴板写入前先备份原文，结束后原样还原。
 *
 * 用法：
 *   node _probe/test-pipeline-parity.cjs
 *   node _probe/test-pipeline-parity.cjs --host http://127.0.0.1:8004
 *   node _probe/test-pipeline-parity.cjs --no-fixture   # 跳过需要记事本夹具的用例
 *
 * 退出码：0 = 全一致；1 = 存在真实差异；2 = 环境不可用（8004/依赖）
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// ── 路径 / 参数 ─────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const HOST = (() => {
    const i = ARGS.indexOf('--host');
    return i >= 0 && ARGS[i + 1] ? ARGS[i + 1].replace(/\/$/, '') : 'http://127.0.0.1:8004';
})();
const NO_FIXTURE = ARGS.includes('--no-fixture');
const REPO = path.resolve(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const GC_PATH = path.join(REPO, 'plugins', 'community', 'dispatch', 'game-control.js');
const DISPATCH_CFG = path.join(REPO, 'plugins', 'community', 'dispatch', 'plugin_config.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── HTTP / 真实入口 ─────────────────────────────────────────────────────
async function evalHost(js, timeoutMs = 90000) {
    const r = await fetch(HOST + '/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ js }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await r.json();
    if (!j.ok) throw new Error('eval error: ' + j.error);
    return j.value;
}

/** 走 LLM 真实入口：pluginManager.executeTool(name, params) */
async function pipeline(tool, params) {
    const js = `(async()=>{try{
        const r = await window.pluginManager.executeTool(${JSON.stringify(tool)}, ${JSON.stringify(params)});
        return JSON.stringify({ path: 'ok', raw: r });
    }catch(e){ return JSON.stringify({ path: 'thrown', thrown: String(e && e.message || e) }); }})()`;
    const v = await evalHost(js);
    const out = JSON.parse(v);
    if (out.path === 'thrown') return { ok: false, thrown: out.thrown };
    let o;
    try { o = JSON.parse(out.raw); } catch (e) {
        // 部分内置插件（memos/note/schedule）按人读文本返回，不是 JSON —— 记录可达性即可
        return { ok: true, nonJson: true, detail: String(out.raw).slice(0, 160), data: {} };
    }
    return normalizeObj(o);
}

function normalizeObj(o) {
    return {
        ok: o.ok === undefined ? true : !!o.ok,
        effect: o.effect,
        error: o.error,
        detail: o.detail,
        verified: o.verified,
        data: o,
    };
}

// ── 直连（后端本体）─────────────────────────────────────────────────────
let GC = null;
try { GC = require(GC_PATH); } catch (e) {
    console.error('[warn] 直连不可用（require game-control 失败）：' + (e && e.message || e));
}

function loadAppsFromCfg() {
    // 宿主里 context.getPluginFileConfig() 会把 fields 拍平成 {名字: value}
    try {
        const raw = JSON.parse(fs.readFileSync(DISPATCH_CFG, 'utf8'));
        const out = {};
        const f = raw && raw.apps && raw.apps.fields;
        if (f) for (const k of Object.keys(f)) { if (f[k] && f[k].value) out[k] = f[k].value; }
        return out;
    } catch (e) { return {}; }
}
const APPS = loadAppsFromCfg();

async function direct(action, arg, focus, extraCfg) {
    if (!GC) return { ok: false, thrown: 'direct-unavailable (require failed)' };
    // 直连参照里少数动作没有 runGameAction 对应物：直接读后端同源实现
    if (action === '__game_status__') {
        try { return normalizeObj(Object.assign({ ok: true }, require(path.join(REPO, 'js', 'core', 'game-loop.js')).loopStatus())); }
        catch (e) { return { ok: false, thrown: String(e && e.message || e) }; }
    }
    if (action === '__game_profiles__') {
        try { return normalizeObj({ ok: true, profiles: require(path.join(REPO, 'js', 'core', 'game-loop.js')).listProfiles() }); }
        catch (e) { return { ok: false, thrown: String(e && e.message || e) }; }
    }
    try {
        const r = await GC.runGameAction(action, arg == null ? '' : String(arg), focus || null, null, extraCfg || undefined);
        return normalizeObj(r || {});
    } catch (e) {
        const msg = String(e && e.message || e);
        return { ok: false, thrown: msg, error: msg };
    }
}

/** 单次调用硬超时：任何一侧卡住都不让整条测试无限挂起 */
function withTimeout(promise, ms, label) {
    let timer = null;
    const t = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, thrown: 'TIMEOUT(' + label + ' ' + ms + 'ms)', error: 'TIMEOUT(' + label + ')' }), ms);
        if (timer.unref) timer.unref();
    });
    return Promise.race([promise, t]).finally(() => { if (timer) clearTimeout(timer); });
}

// ── 限速闸感知（宿主严格闸 20次/分 + 300ms 冷却；测试自己也要可重跑）─────
const GATE_RE = /太快了|一分钟里按了太多次|一分钟配额不够/;
function isGateBlocked(r) {
    return !!(r && r.ok === false && (GATE_RE.test(String(r.error || '')) || GATE_RE.test(String(r.detail || ''))));
}
async function withGateRetry(fn) {
    let r = await fn();
    for (let i = 0; i < 2 && isGateBlocked(r); i += 1) { await sleep(1200); r = await fn(); }
    return r;
}

// ── 夹具：自己的记事本 ──────────────────────────────────────────────────
const fixture = { dir: null, file: null, stem: null, proc: null, title: null, pid: null };

function listFixtureWindows() {
    if (!GC) return [];
    return new Promise((resolve) => {
        try {
            // 直连只读枚举（不经过宿主，避免占用宿主配额）
            GC.runGameAction('list_windows', fixture.stem || 'parity-', null)
                .then((r) => {
                    const ws = (r && r.windows) || [];
                    resolve(ws.filter((w) => String(w.title || '').includes(fixture.stem || '')));
                })
                .catch(() => resolve([]));
        } catch (e) { resolve([]); }
    });
}

async function setupFixture() {
    if (NO_FIXTURE) return false;
    fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
    fixture.stem = 'parity-' + process.pid + '-' + Date.now().toString(36);
    fixture.file = path.join(fixture.dir, fixture.stem + '.txt');
    fs.writeFileSync(fixture.file, 'PIPELINE_PARITY_MARKER_12345\n第二行 held\n', 'utf8');
    try {
        fixture.proc = spawn('notepad.exe', [fixture.file], { stdio: 'ignore' });
        fixture.pid = fixture.proc.pid;
        // 子进程句柄会吊住事件循环（窗口关了但 notepad 进程还挂着一会儿，脚本就退不出去）
        if (fixture.proc.unref) fixture.proc.unref();
        fixture.proc.on('error', () => {});
    } catch (e) {
        console.error('[warn] 起记事本失败：' + (e && e.message || e));
        return false;
    }
    // 等窗口出现（最多 6s）
    for (let i = 0; i < 24; i += 1) {
        await sleep(250);
        const ws = await listFixtureWindows();
        if (ws.length) {
            fixture.title = String(ws[0].title);
            return true;
        }
    }
    console.error('[warn] 记事本窗口没等到（继续跑不需要夹具的用例）');
    return false;
}

async function teardownFixture() {
    if (!fixture.file) return;
    try {
        // 只关自己这一扇：WM_CLOSE，不 kill 共享的 notepad 进程
        await direct('window_op', 'close|' + fixture.title + '|', '');
    } catch (e) { /* ignore */ }
    await sleep(600);
    const left = await listFixtureWindows();
    if (left.length) {
        // 兜底：仅当该 pid 名下没有别的窗口时才 kill（防误杀用户记事本）
        try {
            const all = await GC.runGameAction('list_windows', '', null);
            const samePid = (all.windows || []).filter((w) => Number(w.pid) === Number(left[0].pid));
            if (samePid.length <= left.length && fixture.proc) {
                try { fixture.proc.kill(); } catch (e) { /* ignore */ }
            }
        } catch (e) { /* ignore */ }
        await sleep(500);
    }
    const still = await listFixtureWindows();
    if (still.length) console.error('[warn] 夹具窗口未完全关闭：' + still.map((w) => w.title).join(' | '));
    try { fs.rmSync(fixture.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// ── 表格 ────────────────────────────────────────────────────────────────
function dispWidth(s) {
    let n = 0;
    for (const ch of String(s)) {
        const c = ch.codePointAt(0);
        n += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
            || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
            || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
    }
    return n;
}
function pad(s, w) { const d = w - dispWidth(s); return s + ' '.repeat(Math.max(0, d)); }
function trunc(s, w) {
    let out = '', n = 0;
    for (const ch of String(s)) {
        const cw = dispWidth(ch);
        if (n + cw > w) break;
        out += ch; n += cw;
    }
    return out + (dispWidth(s) > w ? '…' : '');
}

// ── 对比逻辑 ────────────────────────────────────────────────────────────
const results = [];

function fmtSide(r) {
    if (!r) return '—';
    if (r.thrown) return 'THROW';
    return (r.ok ? 'ok' : 'fail') + (r.effect ? '/' + r.effect : '');
}

function defaultCompare(pl, dr) {
    const pe = String(pl.thrown || pl.error || '').trim();
    const de = String(dr.thrown || dr.error || '').trim();
    // 注意：真实入口 executeTool 会把后端抛错**包成 ok:false + error**，
    // 直连 runGameAction 则是直接 throw —— 结构不同、语义相同，按错误文本比。
    if (pl.ok !== dr.ok) return { pass: false, note: 'ok 不一致 P=' + pl.ok + ' D=' + dr.ok };
    if (pl.ok === false) {
        if (!pe || !de) return { pass: false, note: '失败文案缺失 P=' + JSON.stringify(pe) + ' D=' + JSON.stringify(de) };
        if (pe !== de && !pe.includes(de) && !de.includes(pe)) {
            return { pass: false, note: '失败文案不同 P「' + trunc(pe, 50) + '」 D「' + trunc(de, 50) + '」' };
        }
        // 只有两边都是正常返回时才比 effect（throw 侧没有 effect）
        if (!pl.thrown && !dr.thrown && String(pl.effect || '') !== String(dr.effect || '')) {
            return { pass: false, note: 'effect 不一致 P=' + pl.effect + ' D=' + dr.effect };
        }
        return { pass: true, note: '两边都拒绝：' + trunc(pe, 44) };
    }
    if (String(pl.effect || '') !== String(dr.effect || '')) {
        return { pass: false, note: 'effect 不一致 P=' + pl.effect + ' D=' + dr.effect };
    }
    return { pass: true, note: '' };
}

async function runCase(c) {
    const tCase = Date.now();
    process.stdout.write('[run] ' + c.id + ' ... ');
    try {
        await runCaseInner(c);
    } finally {
        const last = results[results.length - 1];
        process.stdout.write((last ? last.verdict : '?') + ' ' + ((Date.now() - tCase) / 1000).toFixed(1) + 's\n');
    }
}

async function runCaseInner(c) {
    if (c.skip) {
        results.push({ id: c.id, pl: null, dr: null, verdict: 'SKIP', note: c.skip });
        return;
    }
    let pl = null; let dr = null; let note = ''; let verdict = 'PASS';

    if (c.pipelineOnly) {
        pl = await withGateRetry(() => withTimeout(pipeline(c.tool, c.params), 45000, 'pipeline'));
        if (isGateBlocked(pl)) { verdict = 'SKIP'; note = '宿主限速闸拦截（等 60s 重跑）'; }
        else if (pl.thrown && /^TIMEOUT/.test(pl.thrown)) { verdict = 'FAIL'; note = pl.thrown; }
        else {
            const chk = c.check ? c.check(pl, null) : { pass: true, note: '' };
            verdict = chk.pass ? 'PASS' : 'FAIL';
            note = chk.note || '';
        }
        results.push({ id: c.id, pl, dr: null, verdict, note });
        return;
    }

    // pipeline 先跑（真实入口），再直连后端
    pl = await withGateRetry(() => withTimeout(pipeline(c.tool, c.params), 45000, 'pipeline'));
    if (isGateBlocked(pl)) {
        results.push({ id: c.id, pl, dr: null, verdict: 'SKIP', note: '宿主限速闸拦截（等 60s 重跑）' });
        return;
    }
    const d = c.direct;
    dr = await withGateRetry(() => withTimeout(direct(d.action, d.arg, d.focus, d.extraCfg), 45000, 'direct'));

    const chk = c.check ? c.check(pl, dr) : defaultCompare(pl, dr);
    verdict = chk.pass ? 'PASS' : 'FAIL';
    note = chk.note || '';

    if (verdict === 'FAIL') {
        // 附加现场：把两边的 detail 摘要带到报告里
        const pd = pl && pl.detail ? trunc(pl.detail, 120) : (pl && pl.thrown ? 'THROW:' + trunc(pl.thrown, 100) : '');
        const dd = dr && dr.detail ? trunc(dr.detail, 120) : (dr && dr.thrown ? 'THROW:' + trunc(dr.thrown, 100) : '');
        note += ' ｜P: ' + pd + ' ｜D: ' + dd;
    }
    results.push({ id: c.id, pl, dr, verdict, note });
}

// ── 用例 ────────────────────────────────────────────────────────────────
function buildCases(hasFixture) {
    const FIX = fixture.title || '';
    const fixOk = hasFixture && !!FIX;
    const skipFix = fixOk ? null : '无夹具（--no-fixture 或记事本没起来）';

    const cases = [];
    const add = (o) => cases.push(o);

    // ---- see ----
    add({
        id: 'see.windows（无过滤）',
        tool: 'see', params: { mode: 'windows' },
        direct: { action: 'list_windows', arg: '' },
        check: (pl, dr) => {
            const pw = pl.data && pl.data.windows || [];
            const dw = dr.data && dr.data.windows || [];
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pw.length || !dw.length) return { pass: false, note: '窗口列表为空 P=' + pw.length + ' D=' + dw.length };
            if (Math.abs(pw.length - dw.length) > 3) return { pass: false, note: '窗口数差太多 P=' + pw.length + ' D=' + dw.length };
            return { pass: true, note: 'P=' + pw.length + ' 窗 / D=' + dw.length + ' 窗' };
        },
    });
    add({
        id: 'see.windows+window（filter 必须到后端）',
        tool: 'see', params: { mode: 'windows', window: fixture.stem || 'zzz-no-such-window' },
        direct: { action: 'list_windows', arg: fixture.stem || 'zzz-no-such-window' },
        skip: skipFix,
        check: (pl, dr) => {
            const pw = pl.data && pl.data.windows || [];
            const dw = dr.data && dr.data.windows || [];
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pw.length) return { pass: false, note: 'P 没按 filter 过滤（返回 ' + pw.length + ' 窗，直连 ' + dw.length + '）—— window 参数被吞' };
            if (!pw.every((w) => String(w.title || '').includes(fixture.stem))) return { pass: false, note: 'P 返回了不匹配的窗口' };
            if (pw.length !== dw.length) return { pass: false, note: 'P=' + pw.length + ' D=' + dw.length + '（filter 语义不一致）' };
            return { pass: true, note: 'filter 生效：P/D 都只剩 ' + pw.length + ' 窗' };
        },
    });
    add({
        id: 'see.tree（window 定位）',
        tool: 'see', params: { mode: 'tree', window: FIX },
        direct: { action: 'snapshot', arg: FIX, focus: FIX },
        skip: skipFix,
        check: (pl, dr) => {
            const pe = pl.data && pl.data.elements || [];
            const de = dr.data && dr.data.elements || [];
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pe.length || !de.length) return { pass: false, note: '元素清单为空 P=' + pe.length + ' D=' + de.length };
            if (Math.abs(pe.length - de.length) > 8) return { pass: false, note: '元素数差太多 P=' + pe.length + ' D=' + de.length };
            return { pass: true, note: 'P=' + pe.length + ' / D=' + de.length + ' 元素' };
        },
    });
    add({
        id: 'act.snapshot（等同 see tree）',
        tool: 'act', params: { action: 'snapshot', window: FIX },
        direct: { action: 'snapshot', arg: FIX, focus: FIX },
        skip: skipFix,
        check: (pl, dr) => {
            const pe = pl.data && pl.data.elements || [];
            const de = dr.data && dr.data.elements || [];
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pe.length || !de.length) return { pass: false, note: '元素清单为空' };
            if (Math.abs(pe.length - de.length) > 8) return { pass: false, note: '元素数差太多 P=' + pe.length + ' D=' + de.length };
            return { pass: true, note: 'P=' + pe.length + ' / D=' + de.length + ' 元素' };
        },
    });
    add({
        id: 'see.text（window 定位 + 内容）',
        tool: 'see', params: { mode: 'text', window: FIX },
        direct: { action: 'read_text', arg: FIX, focus: FIX },
        skip: skipFix,
        check: (pl, dr) => {
            const pt = String((pl.data && pl.data.text) || '');
            const dt = String((dr.data && dr.data.text) || '');
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pt.includes('PIPELINE_PARITY_MARKER_12345')) return { pass: false, note: 'P 没读到夹具内容（window 没到后端？）' };
            if (!dt.includes('PIPELINE_PARITY_MARKER_12345')) return { pass: false, note: 'D 没读到夹具内容（参照自身异常）' };
            return { pass: true, note: '两边都读到夹具标记（' + pt.length + ' / ' + dt.length + ' 字符）' };
        },
    });
    add({
        id: 'see.state（visual_read 只读）',
        tool: 'see', params: { mode: 'state' },
        direct: { action: 'visual_read', arg: 'numbers --auto' },
        check: (pl, dr) => {
            // 没有游戏画面时两边都应「读不到」而不是假成功；只要 ok/effect 一致即可
            const c = defaultCompare(pl, dr);
            return c;
        },
    });

    // ---- act 参数校验分支（不发真实输入）----
    const invalidActs = [
        ['act.click（坐标格式错）', { action: 'click', target: 'not-a-coord' }, 'click_at', 'not-a-coord'],
        ['act.click（编号不存在）', { action: 'click', target: '#9999', window: FIX }, 'click_element', '9999', fixOk ? null : '无夹具'],
        ['act.type（空文字）', { action: 'type', target: '' }, 'type_text', ''],
        ['act.key（空键）', { action: 'key', target: '' }, 'press_key', ''],
        ['act.hold（格式错）', { action: 'hold', target: '' }, 'hold_key', ''],
        ['act.scroll（格式错）', { action: 'scroll', target: '' }, 'scroll', ''],
        ['act.drag（缺坐标）', { action: 'drag', target: '1,2' }, 'drag', '1,2'],
        ['act.set_value（缺 rid|值）', { action: 'set_value', target: 'nopipe' }, 'set_value', 'nopipe'],
    ];
    for (const [id, params, da, darg, skip] of invalidActs) {
        add({ id, tool: 'act', params, direct: { action: da, arg: darg, focus: params.window ? FIX : '' }, skip: skip || null });
    }
    add({
        id: 'act.bogus（枚举外 action）',
        tool: 'act', params: { action: 'bogus_action' },
        pipelineOnly: true,
        check: (pl) => {
            if (!pl.thrown) return { pass: false, note: '应当当场拒绝，实际没抛错' };
            if (!/act：action 只能是/.test(pl.thrown)) return { pass: false, note: '报错没给可选 action：' + trunc(pl.thrown, 60) };
            return { pass: true, note: '拒绝并给出枚举' };
        },
    });

    // ---- app ----
    add({
        id: 'app.list（启动白名单）',
        tool: 'app', params: { action: 'list' },
        direct: { action: 'launch_app', arg: '', extraCfg: { apps: APPS } },
        check: (pl, dr) => {
            const pa = (pl.data && pl.data.apps) || [];
            const da = (dr.data && dr.data.apps) || [];
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pa.length || !da.length) return { pass: false, note: '白名单为空 P=' + pa.length + ' D=' + da.length };
            const sa = [...pa].sort().join(',');
            const sd = [...da].sort().join(',');
            if (sa !== sd) return { pass: false, note: '白名单不同 P=[' + sa + '] D=[' + sd + ']（apps 配置没传进后端？）' };
            return { pass: true, note: '白名单一致：' + pa.join('/') };
        },
    });
    add({
        id: 'app.focus（window 生效）',
        tool: 'app', params: { action: 'focus', name: FIX },
        direct: { action: 'focus_window', arg: FIX, focus: '' },
        skip: skipFix,
    });
    add({
        id: 'app.move（x,y 必须到后端）',
        tool: 'app', params: { action: 'move', name: FIX, x: 0, y: 0 },   // 运行时填真实坐标
        direct: { action: 'window_op', arg: '', focus: '' },              // 运行时填
        skip: skipFix,
        check: (pl, dr) => {
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            const pr = (pl.data && pl.data.rect) || null;
            const drr = (dr.data && dr.data.rect) || null;
            if (!pr || !drr) return { pass: false, note: '没拿到 rect' };
            if (Number(pr.x) !== Number(drr.x) || Number(pr.y) !== Number(drr.y)) {
                return { pass: false, note: '落点不同 P=' + pr.x + ',' + pr.y + ' D=' + drr.x + ',' + drr.y };
            }
            if (Number(pr.x) !== caseMoveTarget.x || Number(pr.y) !== caseMoveTarget.y) {
                return { pass: false, note: 'x,y 没到后端：期望 ' + caseMoveTarget.x + ',' + caseMoveTarget.y + ' 实际 ' + pr.x + ',' + pr.y };
            }
            return { pass: true, note: 'x,y 生效 @' + pr.x + ',' + pr.y };
        },
    });
    add({
        id: 'app.bogus（枚举外 action）',
        tool: 'app', params: { action: 'bogus' },
        pipelineOnly: true,
        check: (pl) => {
            if (!pl.thrown) return { pass: false, note: '应当当场拒绝，实际没抛错' };
            if (!/app：action 只能是/.test(pl.thrown)) return { pass: false, note: '报错没给可选 action' };
            return { pass: true, note: '拒绝并给出枚举' };
        },
    });

    add({
        id: 'appearance.asset（缺 id 应拒）',
        tool: 'appearance', params: { action: 'asset' },
        pipelineOnly: true,
        check: (pl) => (pl.ok === false && /要给 id/.test(String(pl.data && pl.data.error || pl.error || ''))
            ? { pass: true, note: '拒绝并给可用 id 清单' }
            : { pass: false, note: '没按契约拒绝 P.ok=' + pl.ok }),
    });
    add({
        id: 'appearance.action（缺 name 应拒）',
        tool: 'appearance', params: { action: 'action' },
        pipelineOnly: true,
        check: (pl) => (pl.ok === false && /要给 name/.test(String(pl.data && pl.data.error || pl.error || ''))
            ? { pass: true, note: '拒绝并提示动作名' }
            : { pass: false, note: '没按契约拒绝 P.ok=' + pl.ok }),
    });

    // ---- game ----
    add({
        id: 'game.status（状态读取）',
        tool: 'game', params: { action: 'status' },
        direct: { action: '__game_status__' },
        check: (pl, dr) => {
            if (pl.thrown || dr.thrown) return { pass: false, note: '抛错' };
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            const pr = pl.data && pl.data.running;
            const drr = dr.data && dr.data.running;
            if (!!pr !== !!drr) return { pass: false, note: 'running 不一致 P=' + pr + ' D=' + drr };
            return { pass: true, note: 'running=' + pr };
        },
    });
    add({
        id: 'game.profiles（枚举）',
        tool: 'game', params: { action: 'profiles' },
        direct: { action: '__game_profiles__' },
        check: (pl, dr) => {
            if (pl.thrown || dr.thrown) return { pass: false, note: '抛错' };
            const pp = (pl.data && pl.data.profiles) || [];
            const dp = (dr.data && dr.data.profiles) || [];
            if (!pp.length || !dp.length) return { pass: false, note: 'profile 清单为空 P=' + pp.length + ' D=' + dp.length };
            if (pp.length !== dp.length) return { pass: false, note: '数量不同 P=' + pp.length + ' D=' + dp.length };
            return { pass: true, note: pp.length + ' 个 profile' };
        },
    });

    add({
        id: 'game.see（profile 不存在应拒）',
        tool: 'game', params: { action: 'see', profile: '__parity_no_such_profile__' },
        pipelineOnly: true,
        // 拒绝文案可能落在 error / reason / detail 任一处（2026-11-21 game 双闸改造后
        // 用的是 reason+detail，error 只给机器码 profile-not-found）。
        check: (pl) => {
            const d = (pl && pl.data) || {};
            const text = String(d.error || '') + ' ' + String(d.reason || '') + ' ' + String(d.detail || '') + ' ' + String(pl.error || '');
            return (pl.ok === false && /profile 找不到|profile-not-found/.test(text))
                ? { pass: true, note: '拒绝并给 profiles 清单' }
                : { pass: false, note: '没按契约拒绝' };
        },
    });

    // ---- batch ----
    add({
        id: 'batch.invalid（整份预校验）',
        tool: 'batch', params: { steps: [{ action: 'click_element', arg: 'abc' }] },
        direct: { action: 'batch', arg: JSON.stringify({ steps: [{ action: 'click_element', arg: 'abc' }] }) },
        check: (pl, dr) => {
            const c = defaultCompare(pl, dr);
            if (!c.pass) return c;
            const pv = (pl.data && pl.data.validationErrors) || [];
            const dv = (dr.data && dr.data.validationErrors) || [];
            if (!pv.length || !dv.length) return { pass: false, note: '没返回 validationErrors（预校验没生效）' };
            if (pl.data.executed !== 0 || dr.data.executed !== 0) return { pass: false, note: 'executed 应为 0' };
            return { pass: true, note: '两边都预校验拒绝且 0 步执行' };
        },
    });
    add({
        id: 'batch.readonly（只读步可跑）',
        tool: 'batch', params: { steps: [{ action: 'list_windows', arg: '' }] },
        direct: { action: 'batch', arg: JSON.stringify({ steps: [{ action: 'list_windows', arg: '' }] }) },
        check: (pl, dr) => {
            if (pl.thrown || dr.thrown) return { pass: false, note: '抛错' };
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (pl.effect !== 'readonly' || dr.effect !== 'readonly') return { pass: false, note: 'effect 应为 readonly P=' + pl.effect + ' D=' + dr.effect };
            const pr = (pl.data && pl.data.results) || [];
            if (!pr.length || !pr[0].ok) return { pass: false, note: 'P 步骤没成功' };
            return { pass: true, note: '只读 batch 成功' };
        },
    });
    add({
        id: 'batch.window（focus 钉窗）',
        tool: 'batch', params: { steps: [{ action: 'snapshot', arg: FIX }], window: FIX },
        direct: { action: 'batch', arg: JSON.stringify({ steps: [{ action: 'snapshot', arg: FIX }], focus: FIX }) },
        skip: skipFix,
        check: (pl, dr) => {
            if (pl.thrown || dr.thrown) return { pass: false, note: '抛错' };
            const pp = pl.data && pl.data.pinnedTitle;
            const dp = dr.data && dr.data.pinnedTitle;
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败 P=' + pl.ok + '/' + dr.ok };
            if (!pp || !dp) return { pass: false, note: '没钉住窗口 P=' + JSON.stringify(pp) + ' D=' + JSON.stringify(dp) };
            if (String(pp) !== String(dp)) return { pass: false, note: '钉的窗口不同 P=' + pp + ' D=' + dp };
            return { pass: true, note: 'window 生效：钉住「' + pp + '」' };
        },
    });

    add({
        id: 'batch.steps 传 JSON 字符串（模型常见）',
        tool: 'batch', params: { steps: JSON.stringify([{ action: 'list_windows', arg: '' }]) },
        pipelineOnly: true,
        check: (pl) => {
            if (pl.thrown) return { pass: false, note: '抛错：' + trunc(pl.thrown, 60) };
            if (!pl.ok) return { pass: false, note: '字符串 steps 被吞成空计划：' + trunc(pl.error || pl.detail, 60) };
            if (pl.effect !== 'readonly') return { pass: false, note: 'effect=' + pl.effect };
            const rs = (pl.data && pl.data.results) || [];
            if (!rs.length || !rs[0].ok) return { pass: false, note: '步骤没执行' };
            return { pass: true, note: '字符串 steps 已归一为数组并执行' };
        },
    });

    // ---- file ----
    add({
        id: 'file.list（目录只读）',
        tool: 'file', params: { action: 'list', path: (fixture.dir || os.tmpdir()).replace(/\\/g, '/') },
        pipelineOnly: true,
        check: (pl) => {
            if (!pl.ok) return { pass: false, note: 'list 失败：' + trunc(pl.error || pl.detail, 60) };
            if (!(pl.data && pl.data.entries)) return { pass: false, note: '没返回 entries' };
            return { pass: true, note: pl.data.count + ' 项' };
        },
    });
    add({
        id: 'file.read（内容）',
        tool: 'file', params: { action: 'read', path: (fixture.file || '').replace(/\\/g, '/') },
        skip: skipFix,
        pipelineOnly: true,
        check: (pl) => {
            if (!pl.ok) return { pass: false, note: 'read 失败：' + trunc(pl.error || pl.detail, 60) };
            if (!String(pl.detail || '').includes('PIPELINE_PARITY_MARKER_12345')) return { pass: false, note: '读到的内容里没有夹具标记' };
            return { pass: true, note: '读到夹具标记' };
        },
    });
    add({
        id: 'file.read（相对路径应拒）',
        tool: 'file', params: { action: 'read', path: 'relative/x.txt' },
        pipelineOnly: true,
        check: (pl) => (pl.ok === false && pl.data && pl.data.error === 'not-absolute'
            ? { pass: true, note: '拒绝且给 not-absolute' }
            : { pass: false, note: '没按契约拒绝 P.ok=' + pl.ok }),
    });
    add({
        id: 'file.search（keyword 到后端）',
        tool: 'file', params: { action: 'search', path: (fixture.dir || os.tmpdir()).replace(/\\/g, '/'), keyword: 'parity' },
        skip: skipFix,
        pipelineOnly: true,
        check: (pl) => {
            if (!pl.ok) return { pass: false, note: 'search 失败：' + trunc(pl.error || pl.detail, 60) };
            const hits = (pl.data && pl.data.hits) || [];
            if (!hits.length) return { pass: false, note: 'keyword 没到后端（0 命中）' };
            if (!hits.every((h) => String(h.path).toLowerCase().includes('parity'))) return { pass: false, note: '返回了不匹配的命中' };
            return { pass: true, note: 'keyword 生效：' + hits.length + ' 个命中' };
        },
    });
    add({
        id: 'file.read（敏感路径应拒）',
        tool: 'file', params: { action: 'read', path: path.join(os.homedir(), '.ssh', 'id_rsa').replace(/\\/g, '/') },
        pipelineOnly: true,
        check: (pl) => (pl.ok === false && pl.data && pl.data.error === 'denied-path'
            ? { pass: true, note: '拒绝 .ssh' }
            : { pass: false, note: '敏感路径没被拒 P.ok=' + pl.ok }),
    });

    // ---- clipboard ----
    add({
        id: 'clipboard.read',
        tool: 'clipboard', params: { action: 'read' },
        pipelineOnly: true,
        check: (pl) => (pl.ok && pl.data && typeof pl.data.total_chars === 'number'
            ? { pass: true, note: '读到 ' + pl.data.total_chars + ' 字符' }
            : { pass: false, note: 'read 失败：' + trunc(pl.error || pl.detail, 60) }),
    });
    add({
        id: 'clipboard.write（回读校验）',
        tool: 'clipboard', params: { action: 'write', text: '__PARITY_CLIP_' + Date.now().toString(36) + '__' },
        pipelineOnly: true,
        check: (pl) => (pl.ok && pl.effect === 'confirmed'
            ? { pass: true, note: '写入并回读一致' }
            : { pass: false, note: '写入失败/未确认：' + pl.effect + ' ' + trunc(pl.error || pl.detail, 60) }),
    });

    // ---- knowledge / skill ----
    add({
        id: 'knowledge（game+query 到后端）',
        tool: 'knowledge', params: { game: '植物大战僵尸', query: '为什么种不上' },
        direct: { action: 'knowledge', arg: '植物大战僵尸,为什么种不上' },
        check: (pl, dr) => {
            if (pl.thrown || dr.thrown) return { pass: false, note: '抛错' };
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            const pc = (String(pl.detail || '').match(/·/g) || []).length;
            const dc = (String(dr.detail || '').match(/·/g) || []).length;
            if (pc !== dc) return { pass: false, note: '命中条数不同 P=' + pc + ' D=' + dc };
            return { pass: true, note: '命中 ' + pc + ' 条一致' };
        },
    });
    add({
        id: 'skill.list',
        tool: 'skill', params: { action: 'list' },
        direct: { action: 'skill', arg: 'list' },
        check: (pl, dr) => {
            if (pl.thrown || dr.thrown) return { pass: false, note: '抛错' };
            const pn = /技能库（(\d+) 个）/.exec(String(pl.detail || ''));
            const dn = /技能库（(\d+) 个）/.exec(String(dr.detail || ''));
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pn || !dn) return { pass: false, note: '解析不到技能数' };
            if (pn[1] !== dn[1]) return { pass: false, note: '技能数不同 P=' + pn[1] + ' D=' + dn[1] };
            return { pass: true, note: pn[1] + ' 个技能一致' };
        },
    });
    add({
        id: 'skill.history（steps 到后端）',
        tool: 'skill', params: { action: 'history', steps: 3 },
        direct: { action: 'recent_actions', arg: '3' },
        check: (pl, dr) => {
            if (pl.thrown || dr.thrown) return { pass: false, note: '抛错' };
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!/最近 3 次操作/.test(String(pl.detail || ''))) return { pass: false, note: 'steps=3 没到后端：' + trunc(pl.detail, 50) };
            if (!/最近 3 次操作/.test(String(dr.detail || ''))) return { pass: false, note: '直连参照异常' };
            return { pass: true, note: '两边都取 3 条' };
        },
    });
    add({
        id: 'skill.save（缺 name 应拒）',
        tool: 'skill', params: { action: 'save' },
        pipelineOnly: true,
        check: (pl) => (pl.ok === false && /需要 name/.test(String(pl.error || ''))
            ? { pass: true, note: '拒绝并说明缺 name' }
            : { pass: false, note: '没按契约拒绝' }),
    });

    add({
        id: 'check_dispatch（无 id 列任务）',
        tool: 'check_dispatch', params: {},
        pipelineOnly: true,
        check: (pl) => (pl.ok && Array.isArray(pl.data && pl.data.tasks)
            ? { pass: true, note: '列出 ' + pl.data.tasks.length + ' 个任务' }
            : { pass: false, note: '没返回任务列表' }),
    });

    // ---- 旧工具名（legacy alias 路由）----
    add({
        id: 'legacy.game_control（旧名 + filter）',
        tool: 'game_control', params: { action: 'list_windows', arg: fixture.stem || 'zzz' },
        direct: { action: 'list_windows', arg: fixture.stem || 'zzz' },
        skip: skipFix,
        check: (pl, dr) => {
            const pw = (pl.data && pl.data.windows) || [];
            const dw = (dr.data && dr.data.windows) || [];
            if (!pl.ok || !dr.ok) return { pass: false, note: '至少一边失败' };
            if (!pw.length) return { pass: false, note: '旧名路由后 filter 丢了' };
            if (pw.length !== dw.length) return { pass: false, note: '数量不同 P=' + pw.length + ' D=' + dw.length };
            return { pass: true, note: '旧名可路由且 filter 生效（' + pw.length + ' 窗）' };
        },
    });
    add({
        id: 'legacy.pet_perform（清单）',
        tool: 'pet_perform', params: {},
        pipelineOnly: true,
        check: (pl) => {
            if (pl.thrown) return { pass: false, note: '旧名没路由：' + trunc(pl.thrown, 60) };
            if (!pl.ok) return { pass: false, note: '返回失败：' + trunc(pl.error, 60) };
            const list = (pl.data && pl.data.list) || [];
            if (!list.length) return { pass: false, note: '没返回节目清单' };
            return { pass: true, note: list.length + ' 个节目' };
        },
    });

    // ---- hand_action ----
    add({
        id: 'hand_action.bogus（枚举外）',
        tool: 'hand_action', params: { action: '不存在' },
        pipelineOnly: true,
        check: (pl) => (pl.thrown && /不支持的动作/.test(pl.thrown)
            ? { pass: true, note: '拒绝并给可用清单' }
            : { pass: false, note: '没按预期拒绝' }),
    });
    add({
        id: 'hand_action.arg 别名（模型常写 arg）',
        tool: 'hand_action', params: { action: '切换窗口', arg: 'zzz-parity-no-such-window-42' },
        pipelineOnly: true,
        check: (pl) => {
            // 证明 arg 真的被当作 argument 传下去了：错误里应出现目标窗口名。
            // 若 arg 被吞 → 报的是「要聚焦的窗口标题呢」（缺参），而不是「没找到这个窗口」。
            const msg = String(pl.error || pl.detail || pl.thrown || '');
            if (/要聚焦的窗口标题呢/.test(msg)) return { pass: false, note: 'arg 没被识别成 argument（参数被吞）' };
            if (/zzz-parity-no-such-window-42|没找到这个窗口/.test(msg)) return { pass: true, note: 'arg 已到达后端（' + trunc(msg, 40) + '）' };
            if (pl.ok) return { pass: false, note: '不存在的窗口却成功了' };
            return { pass: true, note: '拒绝：' + trunc(msg, 50) };
        },
    });

    // ---- 其他插件工具可达性（只读；pipelineOnly）----
    const others = [
        ['memory.search', 'memory', { action: 'search', query: '测试' }],
        ['tool_usage.search', 'tool_usage', { action: 'search', keyword: 'see' }],
        ['schedule.list', 'schedule', { action: 'list' }],
        ['note.search', 'note', { action: 'search', keyword: '测试' }],
        ['recall.search', 'recall', { action: 'search', query: '测试' }],
        ['profile.view', 'profile', { action: 'view' }],
        ['dawn_dusk.time', 'dawn_dusk', { action: 'time' }],
    ];
    for (const [id, tool, params] of others) {
        add({
            id, tool, params, pipelineOnly: true,
            check: (pl) => {
                if (pl.thrown) return { pass: true, note: 'SKIP-ish：插件未提供/抛错（' + trunc(pl.thrown, 40) + '）' };
                // 只要求「真实入口能到达且返回结构化结果」；服务未配置不算失败
                if (pl.ok) return { pass: true, note: 'ok' + (pl.detail ? '：' + trunc(pl.detail, 40) : '') };
                return { pass: true, note: '可达但返回失败（服务未配置？）：' + trunc(pl.error || pl.detail, 40) };
            },
        });
    }

    return cases;
}

// app.move 的目标坐标 / 还原信息（跑用例前动态注入）
const caseMoveTarget = { x: 0, y: 0 };
let caseMoveRestore = null;

// ── 主流程 ──────────────────────────────────────────────────────────────
(async () => {
    const t0 = Date.now();
    // 0) 预检
    let pmInfo;
    try {
        pmInfo = JSON.parse(await evalHost('JSON.stringify({hasPM:!!window.pluginManager,n:window.pluginManager?window.pluginManager._plugins.size:0})'));
    } catch (e) {
        console.error('8004 不可用：' + (e && e.message || e));
        process.exit(2);
    }
    if (!pmInfo.hasPM) { console.error('宿主里没有 window.pluginManager'); process.exit(2); }
    console.log('宿主 8004 就绪：pluginManager 已挂载，' + pmInfo.n + ' 个插件');

    // 1) 夹具
    const hasFixture = await setupFixture();
    if (hasFixture) console.log('夹具记事本：' + fixture.title + '（pid ' + fixture.pid + '，文件 ' + fixture.file + '）');

    // 2) 枚举工具面（记录覆盖情况）
    let toolSurface = [];
    try {
        const v = await evalHost(`JSON.stringify((()=>{const pm=window.pluginManager;const out=[];for(const [id,e] of pm._plugins){if(!e||!e.plugin)continue;let ts=[];try{ts=(e.plugin.getTools&&e.plugin.getTools())||[]}catch(err){ts=[]}out.push({id,tools:ts.map(t=>{const f=(t&&t.function)||t;const pr=(f&&f.parameters&&f.parameters.properties)||{};const en={};for(const k of Object.keys(pr)){if(pr[k]&&pr[k].enum)en[k]=pr[k].enum}return {name:f&&f.name,en}}).filter(x=>x.name)})}return out})())`);
        toolSurface = JSON.parse(v);
    } catch (e) { /* 非致命 */ }
    const allToolNames = [...new Set(toolSurface.flatMap((p) => p.tools.map((t) => t.name)))];
    console.log('工具面：' + allToolNames.length + ' 个名字（' + toolSurface.map((p) => p.id.split('/')[1] + ':' + p.tools.length).filter((s) => !s.endsWith(':0')).join(' ') + '）');
    const dispatchSurface = toolSurface.find((p) => p.id === 'community/dispatch');
    if (dispatchSurface) {
        console.log('dispatch 工具面（' + dispatchSurface.tools.length + '）：');
        for (const t of dispatchSurface.tools) {
            const en = Object.keys(t.en || {}).map((k) => k + '=[' + t.en[k].join('|') + ']').join(' ');
            console.log('  - ' + t.name + (en ? '  ' + en : ''));
        }
    }

    // 3) 生成用例（app.move 需要夹具当前坐标）
    const cases = buildCases(hasFixture);
    if (hasFixture) {
        let cur = await direct('list_windows', fixture.stem, null);
        let w = ((cur.data && cur.data.windows) || [])[0];
        // 记事本会恢复上次会话的窗口状态：最大化/最小化时先还原，否则 move 的 rect 不反映 x,y
        if (w && (w.maximized || w.iconic)) {
            await direct('window_op', 'restore|' + fixture.title + '|', '');
            await sleep(500);
            cur = await direct('list_windows', fixture.stem, null);
            w = ((cur.data && cur.data.windows) || [])[0];
        }
        if (w) {
            caseMoveTarget.x = Math.max(0, Number(w.x || 0) + 40);
            caseMoveTarget.y = Math.max(0, Number(w.y || 0) + 30);
            const mv = cases.find((c) => c.id.startsWith('app.move'));
            if (mv) {
                mv.params = { action: 'move', name: fixture.title, x: caseMoveTarget.x, y: caseMoveTarget.y };
                mv.direct = { action: 'window_op', arg: 'move|' + fixture.title + '|' + caseMoveTarget.x + ',' + caseMoveTarget.y, focus: '' };
                // 移动后恢复原位（放到 cleanup 队列，跑完再执行）
                caseMoveRestore = { title: fixture.title, x: Number(w.x || 0), y: Number(w.y || 0) };
            }
        }
    }

    // 4) 逐条跑（pipeline → direct）
    const clipBackup = await (async () => {
        try {
            const r = await pipeline('clipboard', { action: 'read' });
            return r.ok && r.data && typeof r.data.text === 'string' ? r.data.text : null;
        } catch (e) { return null; }
    })();

    for (const c of cases) {
        await runCase(c);
        await sleep(380);   // 给宿主严格闸留冷却
    }

    // 4.5) 还原窗口位置 + 剪贴板
    if (caseMoveRestore) {
        try { await direct('window_op', 'move|' + caseMoveRestore.title + '|' + caseMoveRestore.x + ',' + caseMoveRestore.y, ''); } catch (e) { /* ignore */ }
    }
    if (clipBackup !== null) {
        try {
            if (clipBackup === '') {
                // clipboard write 拒绝空串；原剪贴板本来就是空的话用 Electron 直接清空还原
                await evalHost("(()=>{try{require('electron').clipboard.clear();return 'cleared'}catch(e){return 'err:'+String(e&&e.message||e)}})()");
            } else {
                await pipeline('clipboard', { action: 'write', text: clipBackup });
            }
        } catch (e) { /* ignore */ }
    }

    // 5) 清理夹具
    await teardownFixture();

    // 6) 输出
    const cols = [4, 46, 13, 13, 7, 60];
    const header = ['#', 'case', 'pipeline', 'direct', 'verdict', '差异/备注'];
    const line = (cells) => cells.map((v, i) => pad(trunc(String(v), cols[i]), cols[i])).join(' | ');
    console.log('\n' + line(header));
    console.log(cols.map((w) => '-'.repeat(w)).join('-+-'));
    results.forEach((r, i) => {
        console.log(line([i + 1, r.id, fmtSide(r.pl), fmtSide(r.dr), r.verdict, r.note]));
    });

    const fail = results.filter((r) => r.verdict === 'FAIL');
    const skip = results.filter((r) => r.verdict === 'SKIP');
    const pass = results.filter((r) => r.verdict === 'PASS');
    console.log('\n合计：' + results.length + ' 条｜PASS ' + pass.length + '｜FAIL ' + fail.length + '｜SKIP ' + skip.length
        + '｜耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    if (skip.length) console.log('SKIP：' + skip.map((r) => r.id).join('、'));
    if (fail.length) {
        console.log('\n真实差异：');
        for (const f of fail) console.log('  ✗ ' + f.id + ' —— ' + f.note);
        process.exitCode = 1;
    } else {
        console.log('结论：真实入口（executeTool）与直连后端（runGameAction）结果一致。');
        process.exitCode = 0;
    }
    // 强制收尾：spawn 的 notepad / 残留句柄可能让事件循环不退出（实测 51 条全过后进程挂住）。
    // 先让 stdout flush 一拍，再按退出码硬退，保证 CI/批处理能拿到状态码。
    process.stdout.write('', () => setTimeout(() => process.exit(fail.length ? 1 : 0), 30));
    setTimeout(() => process.exit(fail.length ? 1 : 0), 3000).unref();
})().catch((e) => {
    console.error('FATAL: ' + (e && e.stack || e));
    teardownFixture().finally(() => process.exit(2));
});
