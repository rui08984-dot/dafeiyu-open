// js/ai/tool-result-artifact.js —— 大工具输出的「全文落盘」通道（ADR-014 轨道 1-6，2026-11-24）
//
// 为什么要有：
//   工具回执单条上限 12,000 字符（tool-result-cap.js），但「截断」不该等于「丢内容」。
//   OpenCode / Pi 的做法是：单条超过预算就把全文写文件，模型拿到路径 + offset 续读。
//   这里只负责**落盘与清理**，不做分页（分页由各工具自己的 offset/limit 决定）。
//
// 约定：
//   · 目录 `RECORDS_DIR/tool-artifacts/`（PET_DATA_ROOT 设了就跟着走，测试天然隔离）；
//   · 文件名 `<turnId>-<tool>-<id>-<sha1前12位>.txt`：**同内容只落一份**（第四轮 P2 根因修，
//     分页读大文件不再每页写一份全文）；清理仍按数量/天数；
//   · 原子写（tmp + rename），失败一律返回 null、只 warn —— 落盘失败绝不能拖垮工具；
//   · **不写密钥/PII**：写盘前做一次保守脱敏（sk-* / api_key= / Bearer …），
//     但这只是兜底，调用方仍不该主动把凭据往工具输出里塞；
//   · 路径只交给模型（和工具回执一起返回），**不注入记忆索引**；
//     memory-scaffold.isNoise 会把 artifact 指针当噪声过滤掉。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR_NAME = 'tool-artifacts';
const DEFAULTS = Object.freeze({
    keep: 200,          // 最多保留多少个文件
    maxAgeDays: 7,      // 超过多少天的直接清
    maxBytes: 8 * 1024 * 1024,   // 单个 artifact 上限（8MB，防把磁盘写爆）
});

let _recordsDir = null;
let _seq = 0;

/** 记录室目录：优先 records-path（唯一真源），拿不到就按历史层级回落。 */
function recordsDir() {
    if (_recordsDir) return _recordsDir;
    try {
        const rp = require('../core/records-path.js');
        _recordsDir = rp && rp.RECORDS_DIR ? rp.RECORDS_DIR : null;
    } catch (e) {
        _recordsDir = null;
    }
    if (!_recordsDir) _recordsDir = path.join(__dirname, '..', '..', '..', 'data');
    return _recordsDir;
}

/** artifact 目录（不自动创建；writeArtifact 时创建）。 */
function artifactDir(dir) {
    return dir ? path.resolve(String(dir)) : path.join(recordsDir(), DIR_NAME);
}

/** 保守脱敏：宁可多打几个星号，也不要把 key 落进磁盘文本。 */
function redactSecrets(text) {
    let s = String(text == null ? '' : text);
    let changed = false;
    const rules = [
        // OpenAI/Anthropic 风格：sk-xxxx / sk-proj-xxxx
        [/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-***'],
        // Authorization: Bearer xxx
        [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer ***'],
        // api_key=xxx / token: "xxx" / secret=xxx / password=xxx
        [/\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b(\s*[:=]\s*)(["']?)[^\s"',;}]{8,}\3/gi,
            (m, k, sep) => k + sep + '***'],
        // URL query 里的 ?key=xxx / &token=xxx
        [/([?&](?:key|token|api_key|apikey)=)[^&\s"']{8,}/gi, '$1***'],
    ];
    for (const [re, rep] of rules) {
        const before = s;
        s = s.replace(re, rep);
        if (s !== before) changed = true;
    }
    return { text: s, redacted: changed };
}

function _safeSeg(v, fallback) {
    const t = String(v == null ? '' : v).trim();
    if (!t) return fallback;
    return t.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32) || fallback;
}

/** 内容哈希（sha1 前 12 位）：同名同内容 = 同一份 artifact，不重写。 */
function contentHash(text) {
    return crypto.createHash('sha1').update(String(text == null ? '' : text), 'utf8').digest('hex').slice(0, 12);
}

/**
 * 在目录里找「已经落过同一份内容」的文件（文件名以 `-<hash>.txt` 结尾）。
 * 2026-11-24 第四轮 P2 根因修：分页读大文件时每页都会触发一次全文 artifact，
 * 旧实现每次都新写一份 → 磁盘被同一份内容塞满（还挤掉别的 artifact）。
 */
function _findByHash(dir, hash) {
    const suffix = '-' + hash + '.txt';
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return ''; }
    for (const n of names) {
        if (n.length > suffix.length && n.endsWith(suffix)) {
            const full = path.join(dir, n);
            try { if (fs.statSync(full).size > 0) return full; } catch (e) { /* 并发删掉就继续找 */ }
        }
    }
    return '';
}

function _turnId() {
    try {
        const tc = require('../core/turn-context.js');
        const id = typeof tc.currentTurnId === 'function' ? tc.currentTurnId() : '';
        if (id) return id;
    } catch (e) { /* 纯 Node 单测没有 turn-context 也正常 */ }
    return 't' + Date.now().toString(36);
}

/** 把一段文本原子写成 artifact。失败返回 null（只 console.warn，绝不抛）。 */
function writeArtifact(tool, text, meta) {
    let tmpPath = '';
    try {
        const m = meta || {};
        const raw = String(text == null ? '' : text);
        if (!raw) return null;
        const maxBytes = Number(m.maxBytes) > 0 ? Math.floor(Number(m.maxBytes)) : DEFAULTS.maxBytes;
        let payload = raw;
        if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
            // 超 8MB：按字符粗裁（多字节可能仍略超，但已在同一数量级，且写盘失败也会被兜住）
            payload = payload.slice(0, maxBytes) + '\n…[artifact 自身超过 ' + maxBytes + ' 字节，已截断]';
        }
        const red = redactSecrets(payload);
        // 内容哈希去重（第四轮 P2 根因修）：先按哈希找旧文件，找到就直接复用 ——
        // 同一份全文（典型：分页读同一个大文件）磁盘上只有一份。
        const hash = contentHash(red.text);
        const dir = artifactDir(m.dir);
        const existing = _findByHash(dir, hash);
        if (existing) {
            let bytes = 0;
            try {
                bytes = fs.statSync(existing).size;
                // 复用即算「最近被用到」：否则清理按 mtime 会把当前轮还在引用的旧文件删掉
                const now = new Date();
                fs.utimesSync(existing, now, now);
            } catch (e) { /* 时间戳更新失败不影响复用 */ }
            return {
                path: existing,
                bytes,
                chars: red.text.length,
                redacted: red.redacted,
                deduped: true,
                hash,
            };
        }
        fs.mkdirSync(dir, { recursive: true });
        _seq = (_seq + 1) % 100000;
        const id = Date.now().toString(36) + '-' + _seq.toString(36);
        // 文件名带内容哈希（sha1 前 12 位）：既当去重索引，也让磁盘上的文件可辨认
        const name = _safeSeg(m.turnId || _turnId(), 't') + '-'
            + _safeSeg(tool, 'tool') + '-' + id + '-' + hash + '.txt';
        const target = path.join(dir, name);
        tmpPath = target + '.tmp-' + process.pid;
        fs.writeFileSync(tmpPath, red.text, 'utf8');
        fs.renameSync(tmpPath, target);   // 原子：要么旧文件（不存在），要么完整新文件
        tmpPath = '';
        return {
            path: target,
            bytes: Buffer.byteLength(red.text, 'utf8'),
            chars: red.text.length,
            redacted: red.redacted,
            deduped: false,
            hash,
        };
    } catch (e) {
        try { console.warn('[tool-artifact] 落盘失败（不影响工具返回）：' + ((e && e.message) || e)); } catch (e2) { /* ignore */ }
        try { if (tmpPath) fs.unlinkSync(tmpPath); } catch (e3) { /* ignore */ }
        return null;
    }
}

/** 列出 artifact（mtime 新→旧）。测试/排障用。 */
function listArtifacts(opts) {
    const dir = artifactDir(opts && opts.dir);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return []; }
    const rows = [];
    for (const n of names) {
        if (!/\.txt$/i.test(n)) continue;
        const full = path.join(dir, n);
        try {
            const st = fs.statSync(full);
            rows.push({ path: full, name: n, bytes: st.size, mtimeMs: st.mtimeMs });
        } catch (e) { /* 单个文件被并发删掉：跳过 */ }
    }
    return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 清理：保留最近 `keep` 个，且删除超过 `maxAgeDays` 天的。
 * 失败只 warn（收集到 errors / failed 计数），永远不抛。
 * @returns {{dir:string, scanned:number, removed:number, failed:number}}
 */
function cleanupArtifacts(opts) {
    const o = opts || {};
    const keep = Number.isFinite(Number(o.keep)) && Number(o.keep) >= 0 ? Math.floor(Number(o.keep)) : DEFAULTS.keep;
    const maxAgeDays = Number.isFinite(Number(o.maxAgeDays)) && Number(o.maxAgeDays) >= 0
        ? Number(o.maxAgeDays) : DEFAULTS.maxAgeDays;
    const dir = artifactDir(o.dir);
    const out = { dir, scanned: 0, removed: 0, failed: 0 };
    const rows = listArtifacts({ dir });
    out.scanned = rows.length;
    const cutoff = maxAgeDays > 0 ? Date.now() - maxAgeDays * 86400000 : 0;
    rows.forEach((row, idx) => {
        // 排行在 keep 之内的保留；但超过 maxAgeDays 的无论排名都清。
        const tooOld = cutoff > 0 && row.mtimeMs < cutoff;
        const overflow = idx >= keep;
        if (!tooOld && !overflow) return;
        try {
            fs.unlinkSync(row.path);
            out.removed += 1;
        } catch (e) {
            out.failed += 1;
            try { console.warn('[tool-artifact] 清理失败（忽略）：' + row.name + ' — ' + ((e && e.message) || e)); } catch (e2) { /* ignore */ }
        }
    });
    return out;
}

module.exports = {
    DEFAULTS,
    DIR_NAME,
    artifactDir,
    contentHash,
    redactSecrets,
    writeArtifact,
    listArtifacts,
    cleanupArtifacts,
};
