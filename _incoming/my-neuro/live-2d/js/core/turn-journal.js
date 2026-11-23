'use strict';
// turn-journal.js —— 回合日志（B2，2026-11-21）
//
// 要解决的问题：桌面动作不可逆。工具执行到一半进程被杀（重启/崩溃/用户强杀），
// 没人知道「上一次到底发出去没有」——重试可能做两遍，不重试可能留下半个操作。
//
// 做法（先记账再动手）：
//   · 工具执行**前** append 一条 intent（turn_id / tool / argsHash / target）；
//   · 执行**后** append 一条 result（ok / detail / ms）；
//   · 启动时 recover()：有 intent 却没有 result 的，append 一条 interrupted（=未知），
//     并在日志里喊一声。**永不自动重放** —— 重放就是「做两遍」，比不做更糟。
//
// 存储：live-2d/.runtime/turn-journal.jsonl（append-only，>4MB 轮转一次）。
//   参数不存明文，只存 sha256 前 16 位（够比对「同一动作」又不会把密码/正文写进去）。
// 测试隔离：PET_JOURNAL_DIR 指到临时目录（A2 同口径）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.PET_JOURNAL_DIR
    ? path.resolve(process.env.PET_JOURNAL_DIR)
    : path.join(__dirname, '..', '..', '.runtime');
const FILE = path.join(DIR, 'turn-journal.jsonl');
// 轮转后的一代（>4MB 时 FILE 改名到这里）。读侧必须**两代都读**：
// 只读当前文件会漏掉刚被轮转走、还没等到 result 的 intent ——
// 「上次到底发出去没有」在轮转后就没有答案了（见 readAll 注释）。
const ROTATED_FILE = FILE + '.1';
const MAX_FILE_BYTES = 4 * 1024 * 1024;

let seq = 0;
let rotateWarned = false;

function ensureDir() {
    try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* 写不进去下面会发声 */ }
}

function append(rec) {
    try {
        ensureDir();
        try {
            // ENOENT = 首次写（正常态）；其它错误（被占用/权限）只喊一次：
            // 轮转失败时日志会继续增长，但绝不能因此挡住工具执行。
            if (fs.statSync(FILE).size > MAX_FILE_BYTES) fs.renameSync(FILE, ROTATED_FILE);
        } catch (e) {
            if (e && e.code !== 'ENOENT' && !rotateWarned) {
                rotateWarned = true;
                try { console.warn('[turn-journal] 轮转失败（日志会继续增长）：' + ((e && e.message) || e)); } catch (e2) { /* ignore */ }
            }
        }
        fs.appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8');
        return true;
    } catch (e) {
        // 记账失败必须可见（但绝不能挡住工具执行）
        try { console.warn('[turn-journal] 写日志失败：' + ((e && e.message) || e)); } catch (e2) { /* ignore */ }
        return false;
    }
}

function argsHash(args) {
    try { return crypto.createHash('sha256').update(JSON.stringify(args || {})).digest('hex').slice(0, 16); }
    catch (e) { return ''; }
}

/**
 * 记一条「我要做这件事」。返回 intentId（执行后拿它记 result）。
 * @param {{turnId?:string, tool:string, args?:object, target?:string}} o
 */
function beginIntent(o) {
    seq = (seq + 1) % 1000000;
    const rec = {
        kind: 'intent',
        id: 'i' + Date.now().toString(36) + '-' + seq.toString(36),
        at: Date.now(),
        turn_id: String((o && o.turnId) || '').slice(0, 40),
        tool: String((o && o.tool) || '').slice(0, 48),
        argsHash: argsHash(o && o.args),
        target: String((o && o.target) || '').slice(0, 120),
    };
    append(rec);
    return rec.id;
}

/** 记「这件事做完了/失败了」。 */
function endResult(intentId, o) {
    const rec = {
        kind: 'result',
        id: String(intentId || ''),
        at: Date.now(),
        ok: !!(o && o.ok),
        detail: String((o && o.detail) || '').slice(0, 200),
        ms: Number.isFinite(o && o.ms) ? Math.round(o.ms) : null,
    };
    append(rec);
    return rec;
}

/**
 * 读全部记录：**轮转文件（更旧）在前，当前文件在后**。
 * 为什么必须两代一起读：轮转把「刚记下 intent、结果还没来的那条」搬进了 .1，
 * 只读当前文件时 recover() 看不到它 → 重启后无法回答「上次那个动作到底发出去没有」，
 * 重试就可能做两遍（模块头把「做两遍」定义为比不做更糟）。
 * 顺序很重要：.1 在前才能让 result/interrupted 的配对与「最后一条」判断保持时间序。
 */
function readAll() {
    const out = [];
    for (const f of [ROTATED_FILE, FILE]) {
        let raw;
        try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
        for (const line of raw.split('\n')) {
            if (!line) continue;
            try { out.push(JSON.parse(line)); } catch (e) { /* 半截写入/坏行跳过 */ }
        }
    }
    return out;
}

/**
 * 启动时调用：把「有 intent 无 result」的回合标成 interrupted_unknown。
 * **只记账，不重放**。返回被标记的 intent（供启动日志/doctor 显示）。
 */
function recover() {
    const lines = readAll();
    const done = new Set(lines.filter((l) => l.kind === 'result').map((l) => l.id));
    const marked = new Set(lines.filter((l) => l.kind === 'interrupted').map((l) => l.id));
    const open = lines.filter((l) => l.kind === 'intent' && !done.has(l.id) && !marked.has(l.id));
    const out = [];
    for (const o of open) {
        append({
            kind: 'interrupted',
            id: o.id,
            at: Date.now(),
            tool: o.tool,
            turn_id: o.turn_id,
            note: 'interrupted_unknown',
        });
        out.push(o);
    }
    return out;
}

/** 概览（doctor 用）：未闭合 / 最近一次 / 总数。 */
function stats() {
    const lines = readAll();
    const done = new Set(lines.filter((l) => l.kind === 'result').map((l) => l.id));
    const marked = new Set(lines.filter((l) => l.kind === 'interrupted').map((l) => l.id));
    const open = lines.filter((l) => l.kind === 'intent' && !done.has(l.id) && !marked.has(l.id));
    const last = lines[lines.length - 1] || null;
    return {
        total: lines.length,
        intents: lines.filter((l) => l.kind === 'intent').length,
        results: lines.filter((l) => l.kind === 'result').length,
        interrupted: lines.filter((l) => l.kind === 'interrupted').length,
        open: open.length,
        last: last ? { kind: last.kind, tool: last.tool || '', at: last.at } : null,
    };
}

module.exports = { beginIntent, endResult, recover, stats, FILE, ROTATED_FILE };
