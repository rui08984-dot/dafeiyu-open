/**
 * event-projection.js —— 事件溯源投影（E6，2026-11-22）
 *
 * 提案原文：memory-events / world-timeline 只追加 + `rebuild --dry-run`。
 * 验收：能从事件重建出当前投影，且 dry-run 不写盘。
 *
 * 现状（先 grep 过）：
 *   · 仓库里**没有** memory-events.js / world-timeline.js 这两个模块（提案是目标态）。
 *   · 现有的 append-only 事件流有三条：
 *       ① 屏幕时间线   data/屏幕时间线-YYYYMMDD.jsonl（C2，screen-timeline.js）
 *       ② 记忆片段卡   data/episodes.jsonl（episode-store.js）
 *       ③ 回合日志     live-2d/.runtime/turn-journal.jsonl（B2，turn-journal.js）
 *   · 本模块为这三条流各写一个「重放 → 当前状态」适配器；`memory-events` 是
 *     episodes.jsonl 的**事实现值投影**（把每张卡的 facts 去重、取最近一次），
 *     作为提案里 memory-events 的最近等价物。
 *
 * 纪律：
 *   · **dryRun 默认 true，绝不写盘**（连 mkdir 都不做）；只有 dryRun === false 才把
 *     投影原子写到 data/投影-<source>.json（tmp + rename）。
 *   · 只读 append-only 源；**永不修改/截断源文件**（rebuild 不 rewrite 事件流）。
 *   · 坏行跳过不崩：read 阶段逐行 try/catch，计入 events.bad。
 *   · 投影与「在线状态」不一致时输出**逐字段差异**（diff.fields），不静默。
 *
 * CLI：
 *   node js/core/event-projection.js --dry-run [--source screen-timeline]
 *   node js/core/event-projection.js --dry-run --source all --json
 *   node js/core/event-projection.js --write  --source episodes
 * 退出码：0=同步；2=有差异；3=错误。
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── 通用 JSONL 读取（纯读）──────────────────────────────────────────────

/**
 * 逐行读一个 jsonl 文件。空白行忽略；坏行计入 bad 并跳过。
 * @param {string} file
 * @param {(line:string, obj:any) => any} parse 返回归一化事件或 null（null 计 bad）
 * @returns {{file:string, events:Array, total:number, bad:number, error?:string}}
 */
function readJsonlFile(file, parse) {
    let raw = '';
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return { file, events: [], total: 0, bad: 0, error: String((e && e.message) || e) };
    }
    const events = [];
    let total = 0;
    let bad = 0;
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        total += 1;
        let obj = null;
        try { obj = JSON.parse(line); } catch (e) { bad += 1; continue; }
        let ev = null;
        try { ev = parse(line, obj); } catch (e) { ev = null; }
        if (ev === null || ev === undefined) { bad += 1; continue; }
        events.push(ev);
    }
    return { file, events, total, bad };
}

/** 多文件顺序读取并汇总。 */
function readJsonlFiles(files, parse) {
    const events = [];
    let total = 0;
    let bad = 0;
    const perFile = [];
    for (const file of (Array.isArray(files) ? files : [])) {
        const r = readJsonlFile(file, parse);
        total += r.total;
        bad += r.bad;
        if (r.error) perFile.push({ file, error: r.error });
        else perFile.push({ file, total: r.total, bad: r.bad, valid: r.events.length });
        for (const ev of r.events) events.push(ev);
    }
    return { events, total, bad, perFile };
}

/** 逐字段比较两个 canonical 对象。fields 为要比较的键名数组。 */
function diffCanonical(projected, online, fields) {
    const out = [];
    for (const f of (Array.isArray(fields) ? fields : [])) {
        const a = projected ? projected[f] : undefined;
        const b = online ? online[f] : undefined;
        if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: f, projected: a, online: b });
    }
    return { inSync: out.length === 0, fields: out };
}

/** 数字/字符串归一（用于 canonical 字段，不改变语义）。 */
function str(v) { return String(v == null ? '' : v); }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
/** 与 screen-timeline 的 numOf 同口径：非法值回落默认，再夹到 [min,max]。 */
function clampNum(value, fallback, min, max) {
    const n = Number(value);
    const v = Number.isFinite(n) ? n : fallback;
    return Math.max(min, Math.min(max, v));
}

// ── 屏幕时间线适配器 ─────────────────────────────────────────────────────

function timelineCanonical(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const last = list[0] || null;
    const first = list[list.length - 1] || null;
    // 「最近 activity 序列」：按时间正序把连续相同 activity 压成一段（rows 是倒序）
    const seq = [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const r = list[i];
        const key = str(r.activity) + '\u0001' + str(r.app) + '\u0001' + str(r.title);
        if (seq.length && seq[seq.length - 1].key === key) continue;
        seq.push({ key, activity: str(r.activity), app: str(r.app), title: str(r.title), t: numOrNull(r.t) });
    }
    const distinct = Array.from(new Set(list.map((r) => str(r.activity)).filter(Boolean))).sort();
    return {
        count: list.length,
        firstT: first ? numOrNull(first.t) : null,
        lastT: last ? numOrNull(last.t) : null,
        lastActivity: last ? str(last.activity) : '',
        lastApp: last ? str(last.app) : '',
        lastTitle: last ? str(last.title) : '',
        lastText: last ? str(last.text) : '',
        activitySeq: seq.map((x) => x.activity + '|' + x.app + '|' + x.title),
        distinctActivities: distinct,
    };
}

const screenTimelineSource = {
    name: 'screen-timeline',
    label: '屏幕时间线',
    compareFields: ['count', 'firstT', 'lastT', 'lastActivity', 'lastApp', 'lastTitle', 'lastText', 'activitySeq', 'distinctActivities'],
    /** 数据文件：data/屏幕时间线-YYYYMMDD.jsonl（按日期名排序） */
    files(options) {
        const o = options || {};
        if (Array.isArray(o.files)) return o.files.slice();
        const { RECORDS_DIR } = require('./records-path.js');
        let names = [];
        try { names = fs.readdirSync(RECORDS_DIR); } catch (e) { return []; }
        return names
            .filter((n) => /^屏幕时间线-\d{8}\.jsonl$/.test(n))
            .sort()
            .map((n) => path.join(RECORDS_DIR, n));
    },
    parse(line) {
        const T = require('./screen-timeline.js');
        return T.parseLine(line);   // 唯一事件解码器（t>0 + text 非空；坏行 null）
    },
    project(events, options) {
        const o = options || {};
        const now = Number.isFinite(Number(o.now)) ? Number(o.now) : Date.now();
        // 与 screen-timeline.recent 的参数夹取完全一致，否则极端 --minutes/--limit 会假 DRIFT
        const minutes = clampNum(o.minutes, 60, 1, 8 * 24 * 60);
        const limit = Math.floor(clampNum(o.limit, 20, 1, 200));
        const cutoff = now - minutes * 60000;
        const rows = events
            .filter((e) => e && Number(e.t) >= cutoff)
            .sort((a, b) => Number(b.t) - Number(a.t))
            .slice(0, limit);
        return timelineCanonical(rows);
    },
    online(options) {
        const o = options || {};
        const T = require('./screen-timeline.js');
        return timelineCanonical(T.recent({
            minutes: o.minutes, limit: o.limit, now: o.now,
        }));
    },
};

// ── 记忆片段卡适配器（episodes）──────────────────────────────────────────

function episodesCanonical(list) {
    const rows = Array.isArray(list) ? list : [];
    const last = rows.length ? rows[rows.length - 1] : null;
    let factsTotal = 0;
    const distinct = new Set();
    for (const r of rows) {
        const facts = Array.isArray(r && r.facts) ? r.facts : [];
        for (const f of facts) {
            const t = str(f).trim();
            if (!t) continue;
            factsTotal += 1;
            distinct.add(t);
        }
    }
    return {
        count: rows.length,
        lastAt: last ? numOrNull(last.at) : null,
        lastTitle: last ? str(last.title) : '',
        lastSummary: last ? str(last.summary) : '',
        factsTotal,
        distinctFacts: Array.from(distinct).sort(),
    };
}

const episodesSource = {
    name: 'episodes',
    label: '记忆片段卡',
    compareFields: ['count', 'lastAt', 'lastTitle', 'lastSummary', 'factsTotal', 'distinctFacts'],
    files(options) {
        const o = options || {};
        if (Array.isArray(o.files)) return o.files.slice();
        const { recordFile } = require('./records-path.js');
        return [recordFile('episodes.jsonl')];
    },
    parse(line, obj) {
        // 与 episode-store.loadEpisodes 同一口径：有 summary 的才算卡片
        return (obj && typeof obj === 'object' && obj.summary) ? obj : null;
    },
    project(events) {
        return episodesCanonical(events);
    },
    online() {
        const ES = require('./episode-store.js');
        return episodesCanonical(ES.loadEpisodes());
    },
};

// ── memory-events：episodes 的「事实现值」投影 ───────────────────────────

function memoryFactsCanonical(episodes) {
    const map = new Map();   // fact text → { text, firstAt, lastAt, count, lastTitle }
    let total = 0;
    for (const ep of (Array.isArray(episodes) ? episodes : [])) {
        const at = numOrNull(ep && ep.at);
        const title = str(ep && ep.title);
        const facts = Array.isArray(ep && ep.facts) ? ep.facts : [];
        for (const f of facts) {
            const text = str(f).trim();
            if (!text) continue;
            total += 1;
            const cur = map.get(text);
            if (!cur) {
                map.set(text, { text, firstAt: at, lastAt: at, count: 1, lastTitle: title });
            } else {
                cur.count += 1;
                if (at !== null && (cur.lastAt === null || at >= cur.lastAt)) { cur.lastAt = at; cur.lastTitle = title; }
                if (cur.firstAt === null && at !== null) cur.firstAt = at;
            }
        }
    }
    const facts = Array.from(map.values()).sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
    const latest = facts.slice().sort((a, b) => (numOrNull(b.lastAt) || 0) - (numOrNull(a.lastAt) || 0))[0] || null;
    return {
        episodeCount: Array.isArray(episodes) ? episodes.length : 0,
        factCount: facts.length,
        factTotal: total,
        lastFact: latest ? latest.text : '',
        lastFactAt: latest ? latest.lastAt : null,
        facts: facts.map((x) => x.text),
    };
}

const memoryEventsSource = {
    name: 'memory-events',
    label: '记忆事实现值（episodes.jsonl 投影）',
    compareFields: ['episodeCount', 'factCount', 'factTotal', 'lastFact', 'lastFactAt', 'facts'],
    files(options) {
        return episodesSource.files(options);
    },
    parse(line, obj) {
        return episodesSource.parse(line, obj);
    },
    project(events) {
        return memoryFactsCanonical(events);
    },
    online() {
        const ES = require('./episode-store.js');
        return memoryFactsCanonical(ES.loadEpisodes());
    },
};

// ── 回合日志适配器（turn-journal）────────────────────────────────────────

function turnJournalCanonical(lines) {
    const rows = Array.isArray(lines) ? lines : [];
    // 与 turn-journal.stats() 同口径：id 原样比较（不把数字 1 和字符串 '1' 混为一谈）
    const done = new Set(rows.filter((l) => l && l.kind === 'result').map((l) => l.id));
    const marked = new Set(rows.filter((l) => l && l.kind === 'interrupted').map((l) => l.id));
    const open = rows.filter((l) => l && l.kind === 'intent' && !done.has(l.id) && !marked.has(l.id));
    const last = rows.length ? rows[rows.length - 1] : null;
    return {
        total: rows.length,
        intents: rows.filter((l) => l && l.kind === 'intent').length,
        results: rows.filter((l) => l && l.kind === 'result').length,
        interrupted: rows.filter((l) => l && l.kind === 'interrupted').length,
        open: open.length,
        lastKind: last ? str(last.kind) : '',
        lastAt: last ? numOrNull(last.at) : null,
        openIds: open.map((l) => str(l.id)).sort(),
    };
}

const turnJournalSource = {
    name: 'turn-journal',
    label: '回合日志',
    compareFields: ['total', 'intents', 'results', 'interrupted', 'open', 'lastKind', 'lastAt'],
    files(options) {
        const o = options || {};
        if (Array.isArray(o.files)) return o.files.slice();
        const TJ = require('./turn-journal.js');
        // 与 turn-journal.readAll() 同口径：轮转文件（更旧）在前 + 当前文件。
        // 少读 .1 会让 project 漏掉轮转那代里的未闭合 intent，而 online(stats) 能读到 → 假 DRIFT。
        const out = [];
        try { if (fs.existsSync(TJ.ROTATED_FILE)) out.push(TJ.ROTATED_FILE); } catch (e) { /* 读不到就当没有 */ }
        out.push(TJ.FILE);
        return out;
    },
    parse(line, obj) {
        // 与 turn-journal.readAll 同口径：任何能解析成对象的行都进流
        return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : null;
    },
    project(events) {
        return turnJournalCanonical(events);
    },
    online() {
        const TJ = require('./turn-journal.js');
        const s = TJ.stats();
        return {
            total: s.total,
            intents: s.intents,
            results: s.results,
            interrupted: s.interrupted,
            open: s.open,
            lastKind: s.last ? str(s.last.kind) : '',
            lastAt: s.last ? numOrNull(s.last.at) : null,
        };
    },
};

// ── 注册表 / 重建 ────────────────────────────────────────────────────────

const SOURCES = {
    'screen-timeline': screenTimelineSource,
    'episodes': episodesSource,
    'memory-events': memoryEventsSource,
    'turn-journal': turnJournalSource,
};

/** 源名归一（别名 → 注册名）。 */
function resolveSource(name) {
    const key = str(name || 'screen-timeline').trim();
    if (Object.prototype.hasOwnProperty.call(SOURCES, key)) return SOURCES[key];
    return null;
}

/**
 * 重建一个事件的「当前投影」，并与现有在线状态比对。
 *
 * @param {object} [opts]
 * @param {string} [opts.source='screen-timeline'] 源名（见 SOURCES）
 * @param {boolean} [opts.dryRun=true] true=只读（绝不写盘）；false=把投影原子写盘
 * @param {object} [opts.options] 传给适配器的参数：{files, minutes, limit, now, online}
 *   · options.online：注入在线状态（测试/诊断用），跳过 adapter.online()
 * @returns {object} 结果对象（ok/source/events/projection/online/diff/wrote/...）
 */
function rebuild(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const requested = str(o.source || 'screen-timeline');
    const adapter = resolveSource(requested);
    if (!adapter) {
        return {
            ok: false, error: 'unknown_source', source: requested,
            sources: Object.keys(SOURCES), dryRun: o.dryRun !== false,
        };
    }
    const dryRun = o.dryRun !== false;
    // 同一轮 rebuild 内固定 now：否则 project 与 online 各取一次 Date.now()，
    // 正好落在窗口边界的事件会导致假 DRIFT。
    const options = Object.assign({}, (o.options && typeof o.options === 'object') ? o.options : {});
    if (!Number.isFinite(Number(options.now))) options.now = Date.now();
    let files = [];
    try {
        files = adapter.files(options) || [];
    } catch (e) {
        return { ok: false, error: 'list_files_failed', detail: String((e && e.message) || e), source: adapter.name, dryRun };
    }

    const read = readJsonlFiles(files, adapter.parse);
    const projection = adapter.project(read.events, options);
    let online;
    if (options.online !== undefined) {
        online = options.online;
    } else {
        try {
            online = adapter.online(options);
        } catch (e) {
            return {
                ok: false, error: 'online_failed', detail: String((e && e.message) || e),
                source: adapter.name, dryRun, files, events: { total: read.total, valid: read.events.length, bad: read.bad },
            };
        }
    }
    const diff = diffCanonical(projection, online, adapter.compareFields);

    const out = {
        ok: true,
        source: requested,
        canonicalSource: adapter.name,
        dryRun,
        files,
        events: {
            total: read.total,
            valid: read.events.length,
            bad: read.bad,
            perFile: read.perFile,
        },
        projection,
        online,
        diff,
        wrote: false,
        materialized: null,
    };

    if (!dryRun) {
        try {
            const { recordFile } = require('./records-path.js');
            const file = recordFile('投影-' + adapter.name + '.json');
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const payload = {
                source: adapter.name,
                generatedAt: new Date().toISOString(),
                events: { total: read.total, valid: read.events.length, bad: read.bad },
                projection,
                diff,
            };
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
            fs.renameSync(tmp, file);
            out.wrote = true;
            out.materialized = file;
        } catch (e) {
            out.ok = false;
            out.error = 'write_failed';
            out.detail = String((e && e.message) || e);
        }
    }
    return out;
}

/** 对所有注册源各跑一次 rebuild（别名源也各算一次）。 */
function rebuildAll(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const out = [];
    for (const name of Object.keys(SOURCES)) {
        out.push(rebuild(Object.assign({}, o, { source: name })));
    }
    return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const out = { dryRun: true, source: 'screen-timeline', json: false, all: false, help: false, options: {} };
    const args = Array.isArray(argv) ? argv : [];
    for (let i = 0; i < args.length; i += 1) {
        const a = String(args[i]);
        if (a === '--dry-run') out.dryRun = true;
        else if (a === '--write') out.dryRun = false;
        else if (a === '--json') out.json = true;
        else if (a === '--all') out.all = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--source') { out.source = String(args[i + 1] || ''); i += 1; }
        else if (a.startsWith('--source=')) out.source = a.slice('--source='.length);
        else if (a === '--minutes') { out.options.minutes = Number(args[i + 1]); i += 1; }
        else if (a.startsWith('--minutes=')) out.options.minutes = Number(a.slice('--minutes='.length));
        else if (a === '--limit') { out.options.limit = Number(args[i + 1]); i += 1; }
        else if (a.startsWith('--limit=')) out.options.limit = Number(a.slice('--limit='.length));
        else if (a === '--file') { out.options.files = [String(args[i + 1] || '')]; i += 1; }
    }
    return out;
}

function humanReport(r) {
    if (!r.ok) {
        return '[' + str(r.source) + '] ERROR ' + str(r.error) + (r.detail ? '：' + r.detail : '') +
            (Array.isArray(r.sources) ? '（可用源：' + r.sources.join(' / ') + '）' : '');
    }
    const head = '[' + r.canonicalSource + '] events=' + r.events.valid + '/' + r.events.total +
        ' bad=' + r.events.bad + ' · ' + (r.dryRun ? 'dry-run' : 'write') +
        (r.wrote ? ' → ' + r.materialized : '');
    if (r.diff.inSync) return head + '\n  投影与在线状态：IN SYNC';
    const lines = r.diff.fields.map((f) =>
        '  · ' + f.field + '：projected=' + JSON.stringify(f.projected) + ' online=' + JSON.stringify(f.online));
    return head + '\n  投影与在线状态：DRIFT（' + r.diff.fields.length + ' 个字段）\n' + lines.join('\n');
}

function runCli(argv) {
    const a = parseArgs(argv);
    if (a.help) {
        console.log([
            '用法：node js/core/event-projection.js [--dry-run|--write] [--source <name>|--all] [--json]',
            '',
            '源：' + Object.keys(SOURCES).join(' / '),
            '--dry-run  只读重建 + 比对（默认；绝不写盘）',
            '--write    把投影写到 data/投影-<source>.json',
            '--json     机器可读输出',
            '--file     覆盖数据文件（诊断用，可重复给一个）',
            '--minutes/--limit  screen-timeline 窗口（默认 60 分钟 / 20 条）',
            '',
            '退出码：0=全部同步；2=有差异；3=错误。',
        ].join('\n'));
        return 0;
    }
    const all = a.all || str(a.source).toLowerCase() === 'all';
    const results = all
        ? rebuildAll({ dryRun: a.dryRun, options: a.options })
        : [rebuild({ source: a.source, dryRun: a.dryRun, options: a.options })];
    if (a.json) {
        console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    } else {
        for (const r of results) console.log(humanReport(r));
    }
    if (results.some((r) => !r.ok)) return 3;
    if (results.some((r) => !r.diff.inSync)) return 2;
    return 0;
}

module.exports = {
    rebuild,
    rebuildAll,
    diffCanonical,
    readJsonlFile,
    readJsonlFiles,
    resolveSource,
    SOURCES,
    timelineCanonical,
    episodesCanonical,
    memoryFactsCanonical,
    turnJournalCanonical,
    parseArgs,
    runCli,
};

if (require.main === module) {
    process.exitCode = runCli(process.argv.slice(2));
}
