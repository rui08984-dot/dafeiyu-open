/**
 * screen-timeline.js —— 屏幕时间线：跨小时的「文字记忆」（C2，2026-11-21）
 *
 * 为什么要有它：vision-organ 的环形缓冲只有 120 秒，用户问「我这一小时在干嘛」
 * 或「这个报错第三次了吧」，看屏链路里根本没有证据。这里把每次新摘要
 * **只以文字**追加到按天切分的 jsonl，跨天/跨小时都能回查。
 *
 * 三条纪律：
 *   · **绝不存图**：只落 {t, activity, app, title, text} 五个字段，不存 base64/截图路径。
 *   · **有界**：text 硬截 120 字；同指纹（activity+app+title+text 前 40 字）60 秒内
 *     重复不追加 —— 看屏是 2fps 采样，不挡会把文件打爆。保留 7 天。
 *   · **不抛**：磁盘满/权限/目录被占都只返回 {ok:false, detail}，看屏链路不能因此断。
 *
 * 路径唯一真源是 records-path.js 的 recordFile()（PET_DATA_ROOT 自动生效，测试隔离必需）。
 * 文件：data/屏幕时间线-YYYYMMDD.jsonl（一行一条，本地时区切天）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { recordFile } = require('./records-path.js');

const FILE_PREFIX = '屏幕时间线-';
const FILE_RE = /^屏幕时间线-(\d{8})\.jsonl$/;
const TEXT_MAX = 120;                 // 摘要硬上限（用户诉求：一句话能读、文件不膨胀）
const FP_TEXT_MAX = 40;               // 指纹只取前 40 字：句尾细节变化不该算「新内容」
const DEDUPE_WINDOW_MS = 60000;       // 同指纹 60 秒内只留一条
const DEFAULT_KEEP_DAYS = 7;          // 保留 7 天（够回答「这周」）
const MAX_SCAN_DAYS = 8;              // recent/search 最多往前翻 8 个日历日（防配置写爆）
const TAIL_BYTES = 8192;              // 读文件尾用于去重，不读整份整天文件

const pad2 = (n) => String(n).padStart(2, '0');

/** epochMs → 'YYYYMMDD'（本地时区：用户说的「今天」是墙上的今天） */
function dayStamp(ms) {
    const d = new Date(Number(ms));
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
}

/** 某天的时间线文件绝对路径（必须走 recordFile，PET_DATA_ROOT 才会生效） */
function fileForDay(ms) {
    return recordFile(FILE_PREFIX + dayStamp(ms) + '.jsonl');
}

/** 单行文本化：换行压成空格（jsonl 一行一条的前提），非字符串一律空串 */
function oneLine(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/** 解析一行；坏行/缺字段返回 null（读侧永远跳过，不因一行脏数据炸整条链路） */
function parseLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return null;
    let o;
    try { o = JSON.parse(raw); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    const t = Number(o.t);
    if (!Number.isFinite(t) || t <= 0) return null;
    const text = oneLine(o.text);
    if (!text) return null;
    return {
        t,
        activity: oneLine(o.activity),
        app: oneLine(o.app),
        title: oneLine(o.title),
        text: text.slice(0, TEXT_MAX),
    };
}

/** 去重指纹：activity + app + title + text 前 40 字 */
function fingerprint(rec) {
    const text = oneLine(rec && rec.text).slice(0, FP_TEXT_MAX);
    return [oneLine(rec && rec.activity), oneLine(rec && rec.app), oneLine(rec && rec.title), text].join('\u0001');
}

/**
 * 读文件尾部最后一个合法条目（去重基准）。
 * 只读尾部 8KB：整天文件可能上千行，append 每次都全读会 O(n²)。
 * 尾部截断可能切坏第一行（UTF-8 半个字符），那一行 JSON.parse 会失败并被跳过，
 * 最后一行永远完整 —— 这正是我们要的。
 */
function readLastEntry(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        if (!size) return null;
        const len = Math.min(size, TAIL_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const rec = parseLine(lines[i]);
            if (rec) return rec;
        }
        return null;
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* 关闭失败无所谓 */ } }
    }
}

/**
 * 追加一条屏幕记录。
 * @param {{t?:number, activity?:string, app?:string, title?:string, text?:string}} entry
 * @returns {{ok:boolean, deduped?:boolean, dropped?:boolean, file?:string, detail?:string}}
 */
function append(entry) {
    const src = entry && typeof entry === 'object' ? entry : {};
    const text = oneLine(src.text).slice(0, TEXT_MAX);
    if (!text) return { ok: false, detail: 'text 为空，未写入' };

    const tNum = Number(src.t);
    const at = Number.isFinite(tNum) && tNum > 0 ? tNum : Date.now();
    // 只挑这五个字段落盘：调用方多传的 image/base64 等一律丢弃（「绝不存图」由结构保证）
    const rec = {
        t: at,
        activity: oneLine(src.activity).slice(0, 120),
        app: oneLine(src.app).slice(0, 120),
        title: oneLine(src.title).slice(0, 200),
        text,
    };

    try {
        const file = fileForDay(at);
        // 去重基准：当天文件的最后一条；当天文件还没有（刚过零点）时看昨天最后一条。
        const last = readLastEntry(file) || readLastEntry(fileForDay(at - 86400000));
        if (last && fingerprint(last) === fingerprint(rec) && Math.abs(at - last.t) < DEDUPE_WINDOW_MS) {
            return { ok: true, deduped: true, dropped: true };
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
        return { ok: true, deduped: false, file: path.basename(file) };
    } catch (error) {
        return { ok: false, detail: String((error && error.message) || error) };
    }
}

/** 读一天的文件，返回合法条目数组（坏行跳过） */
function readDay(dayMs) {
    let raw = '';
    try { raw = fs.readFileSync(fileForDay(dayMs), 'utf8'); }
    catch (e) { return []; }
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
        const rec = parseLine(line);
        if (rec) out.push(rec);
    }
    return out;
}

/**
 * 收集 [cutoff, now] 窗口内的条目，按时间倒序。
 * 从今天往回翻日历日，直到该日整段都在窗口外（跨天自动读昨天，更长窗口也自然覆盖）。
 */
function collectWindow(now, cutoff) {
    const out = [];
    const base = new Date(Number(now));
    base.setHours(0, 0, 0, 0);
    // 为什么要多扫一天（i <= MAX_SCAN_DAYS）：窗口最长 MAX_SCAN_DAYS 天，但**任意时刻**
    // 起算的 N 天会跨 N+1 个日历日（例如 03:00 往回 8 天 → 含 9 个日历日）。只扫 N 天时，
    // 最旧那天的记录会被静默漏掉（recent/search 少返回，event-projection 报假 DRIFT）。
    // 早退条件保证正常窗口不会多读：整日都在窗口之前就 break。
    for (let i = 0; i <= MAX_SCAN_DAYS; i += 1) {
        const dayStart = new Date(base);
        dayStart.setDate(dayStart.getDate() - i);
        const nextStart = new Date(dayStart);
        nextStart.setDate(nextStart.getDate() + 1);
        if (nextStart.getTime() <= cutoff) break;   // 这一天整个在窗口之前 → 更早的也不用看
        for (const rec of readDay(dayStart.getTime())) {
            if (rec.t >= cutoff) out.push(rec);
        }
    }
    out.sort((a, b) => b.t - a.t);
    return out;
}

function numOf(value, fallback, min, max) {
    const n = Number(value);
    const v = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, v));
}

/**
 * 最近一段时间的记录（按时间倒序）。
 * @param {{minutes?:number, limit?:number, now?:number}} [opts]
 * @returns {Array<{t:number, activity:string, app:string, title:string, text:string}>}
 */
function recent(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const minutes = numOf(o.minutes, 60, 1, MAX_SCAN_DAYS * 24 * 60);
    const limit = Math.floor(numOf(o.limit, 20, 1, 200));
    const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    return collectWindow(now, now - minutes * 60000).slice(0, limit);
}

/**
 * 在时间窗口内做简单子串检索（中文不分词，大小写不敏感只影响英文）。
 * count = 窗口内**总命中数**（不受 limit 影响），hits = 最近 limit 条。
 * 这是「这个报错第三次了」的证据来源：次数看 count，时间点看 hits。
 * @param {{text?:string, minutes?:number, limit?:number, now?:number}} [opts]
 * @returns {{ok:boolean, count:number, hits:Array, scanned:number, detail?:string}}
 */
function search(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const needle = oneLine(o.text).toLowerCase();
    if (!needle) return { ok: false, count: 0, hits: [], scanned: 0, detail: '需要 text' };
    const minutes = numOf(o.minutes, 24 * 60, 1, MAX_SCAN_DAYS * 24 * 60);
    const limit = Math.floor(numOf(o.limit, 20, 1, 200));
    const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
    const rows = collectWindow(now, now - minutes * 60000);
    const matched = rows.filter((r) => r.text.toLowerCase().includes(needle));
    return { ok: true, count: matched.length, hits: matched.slice(0, limit), scanned: rows.length };
}

/**
 * 删掉 days 天前的文件（保留含今天在内的 days 个日历日）。
 * 只认自己的文件名格式，绝不误删记录室里的其它东西。
 * @returns {{ok:boolean, removed:number, kept:number, removedFiles:string[], detail?:string}}
 */
function prune(days) {
    const keep = Math.floor(numOf(days, DEFAULT_KEEP_DAYS, 1, 3650));
    // 保留今天 + 往前 keep-1 天；早于这个日期的整份删掉
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (keep - 1));
    const cutoffStamp = dayStamp(cutoff.getTime());

    const removedFiles = [];
    let kept = 0;
    try {
        const dir = path.dirname(recordFile(FILE_PREFIX + '20000101.jsonl'));
        const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        for (const name of names) {
            const m = FILE_RE.exec(name);
            if (!m) continue;
            if (m[1] >= cutoffStamp) { kept += 1; continue; }   // YYYYMMDD 定长，字符串比较即日期比较
            try {
                fs.unlinkSync(path.join(dir, name));
                removedFiles.push(name);
            } catch (e) { /* 单个删不掉（被占用）不影响其它文件 */ }
        }
        return { ok: true, removed: removedFiles.length, kept, removedFiles };
    } catch (error) {
        return { ok: false, removed: removedFiles.length, kept, removedFiles, detail: String((error && error.message) || error) };
    }
}

/** 概览：有几天、多少条、占多少字节（不做全量内容解析以外的开销） */
function stats() {
    const out = { days: 0, entries: 0, bytes: 0 };
    try {
        const dir = path.dirname(recordFile(FILE_PREFIX + '20000101.jsonl'));
        if (!fs.existsSync(dir)) return out;
        for (const name of fs.readdirSync(dir)) {
            if (!FILE_RE.test(name)) continue;
            const file = path.join(dir, name);
            let size = 0;
            try { size = fs.statSync(file).size; } catch (e) { continue; }
            out.days += 1;
            out.bytes += size;
            let raw = '';
            try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
            for (const line of raw.split(/\r?\n/)) {
                if (parseLine(line)) out.entries += 1;
            }
        }
    } catch (e) { /* 目录读不了就当空统计 */ }
    return out;
}

module.exports = {
    append, recent, search, prune, stats,
    // 测试/诊断用
    dayStamp, fileForDay, fingerprint, parseLine,
    FILE_PREFIX, TEXT_MAX, FP_TEXT_MAX, DEDUPE_WINDOW_MS, DEFAULT_KEEP_DAYS,
};
