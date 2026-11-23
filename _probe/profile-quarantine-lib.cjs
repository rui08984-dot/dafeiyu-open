#!/usr/bin/env node
/**
 * _probe/profile-quarantine-lib.cjs — 用户画像隔离区共享纯函数（2026-11-21）
 *
 * 判据只有一套：直接 require('./profile-audit.cjs') 的 matchReasons/classify/FIELDS，
 * 隔离脚本与审计脚本不会各写一份规则。
 *
 * 隔离语义（可逆、不删数据）：
 *   · 只迁「强候选」：one_off（一次性事件）与 meta（测试/助手元行为）；
 *   · weak（弱提示）保留在活跃列表，只在报告里列出；
 *   · 迁出的条目写进顶层 quarantined: [{text, from, reason, at, index}]；
 *     index 是原数组下标，restore 时按它插回原位，保证 quarantine→restore 逐字节等价；
 *   · 活跃列表（facts/habits/traits/relationships/preferences.*）是唯一注入源，
 *     quarantined 天然不参与 onLLMRequest 注入。
 *
 * 本文件不写磁盘；读写由 CLI（profile-quarantine.cjs / profile-restore.cjs）负责。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { matchReasons, classify, FIELDS } = require('./profile-audit.cjs');

const QUARANTINE_KEY = 'quarantined';
const BACKUP_SUFFIX = '.bak-quarantine-20261121';
const STRONG_KINDS = new Set(['one_off', 'meta']);

function getFieldList(profile, field) {
    if (!profile || typeof profile !== 'object') return [];
    const parts = field.split('.');
    let node = profile;
    for (const part of parts) {
        if (!node || typeof node !== 'object') return [];
        node = node[part];
    }
    return Array.isArray(node) ? node : [];
}

function setFieldList(profile, field, list) {
    if (!profile || typeof profile !== 'object') return false;
    const parts = field.split('.');
    const last = parts.pop();
    let node = profile;
    for (const part of parts) {
        if (!node[part] || typeof node[part] !== 'object') node[part] = {};
        node = node[part];
    }
    node[last] = list;
    return true;
}

function reasonText(reasons) {
    return reasons.map((r) => r.label + '(' + r.id + ')').join('；');
}

/**
 * 扫描画像（只读）。返回强候选、弱提示与各字段条数。
 * 与 profile-audit.cjs 的 audit() 使用同一 matchReasons/classify。
 */
function scanProfile(profile) {
    const strong = [];
    const weak = [];
    const fields = {};

    for (const field of FIELDS) {
        const list = getFieldList(profile, field);
        fields[field] = list.length;
        for (let index = 0; index < list.length; index += 1) {
            const text = String(list[index] == null ? '' : list[index]).trim();
            if (!text) continue;
            const reasons = matchReasons(text);
            const kind = classify(reasons);
            if (kind === 'none') continue;
            const row = { field, index, text, kind, reasons, reason: reasonText(reasons) };
            if (STRONG_KINDS.has(kind)) strong.push(row);
            else if (kind === 'weak') weak.push(row);
        }
    }

    return {
        fields,
        strong,
        weak,
        counts: {
            one_off: strong.filter((r) => r.kind === 'one_off').length,
            meta: strong.filter((r) => r.kind === 'meta').length,
            weak: weak.length,
        },
    };
}

function sameQuarantineEntry(a, b) {
    return String(a && a.text) === String(b && b.text) && String(a && a.from) === String(b && b.from);
}

/**
 * 把强候选从活跃列表迁到 quarantined（返回新对象，不修改入参）。
 * 不触碰 updated_at / _meta，保证 restore 能逐字节还原。
 */
function applyQuarantine(profile, options = {}) {
    const at = options.at || new Date().toISOString();
    const scan = scanProfile(profile);
    const next = JSON.parse(JSON.stringify(profile || {}));

    const existing = Array.isArray(next[QUARANTINE_KEY])
        ? next[QUARANTINE_KEY].filter((x) => x && typeof x === 'object' && x.text)
        : [];

    for (const field of FIELDS) {
        const list = getFieldList(next, field);
        if (!list.length) continue;
        const drop = new Set(
            scan.strong.filter((r) => r.field === field).map((r) => r.index)
        );
        if (!drop.size) continue;
        setFieldList(next, field, list.filter((_, i) => !drop.has(i)));
    }

    const quarantine = existing.slice();
    let moved = 0;
    for (const row of scan.strong) {
        const record = {
            text: row.text,
            from: row.field,
            reason: row.kind + '：' + row.reason,
            at,
            index: row.index,
        };
        if (quarantine.some((x) => sameQuarantineEntry(x, record))) continue;
        quarantine.push(record);
        moved += 1;
    }

    if (quarantine.length) next[QUARANTINE_KEY] = quarantine;
    else if (existing.length) next[QUARANTINE_KEY] = existing;

    return { profile: next, moved, scan };
}

/**
 * 把 quarantined 全部插回原位置（返回新对象，不修改入参）。
 * 若某条已在活跃列表里（人工重新加回），跳过，不制造重复。
 */
function restoreAll(profile) {
    const source = profile || {};
    const next = JSON.parse(JSON.stringify(source));
    const quarantine = Array.isArray(next[QUARANTINE_KEY]) ? next[QUARANTINE_KEY] : [];

    const byField = new Map();
    const remaining = [];
    for (const record of quarantine) {
        if (!record || typeof record !== 'object' || !record.text) {
            remaining.push(record);
            continue;
        }
        const field = String(record.from || '');
        // 未知字段/缺失字段：不猜、不丢，留在隔离区等人工处理
        if (!FIELDS.includes(field)) {
            remaining.push(record);
            continue;
        }
        if (!byField.has(field)) byField.set(field, []);
        byField.get(field).push(record);
    }

    let restored = 0;
    for (const [field, records] of byField) {
        const list = getFieldList(next, field).slice();
        // 按原始下标升序插回：先插前面的，后面记录的 index 仍是原数组坐标
        const ordered = records.slice().sort((a, b) => {
            const ai = Number.isFinite(Number(a.index)) ? Number(a.index) : Number.MAX_SAFE_INTEGER;
            const bi = Number.isFinite(Number(b.index)) ? Number(b.index) : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
        for (const record of ordered) {
            const text = String(record.text);
            if (list.some((item) => String(item) === text)) continue;
            const index = Number.isFinite(Number(record.index))
                ? Math.max(0, Math.min(list.length, Number(record.index)))
                : list.length;
            list.splice(index, 0, text);
            restored += 1;
        }
        setFieldList(next, field, list);
    }

    // 只有全部记录都处理掉才删除键；未知字段继续留档，绝不静默丢数据
    if (remaining.length) next[QUARANTINE_KEY] = remaining;
    else delete next[QUARANTINE_KEY];

    return { profile: next, restored, remaining };
}

function backupPathFor(file) {
    return file + BACKUP_SUFFIX;
}

function readProfileFile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('画像文件不是 JSON 对象');
    }
    return { raw, data };
}

/** 与 user-profile 插件的 _writeJson 同格式（2 空格）；保留原文件末尾换行习惯。 */
function serializeProfile(profile, rawForNewline = '') {
    const text = JSON.stringify(profile, null, 2);
    return /\n$/.test(rawForNewline) ? text + '\n' : text;
}

/** 先备份（默认不覆盖已有备份），再原子写回。 */
function writeProfileFile(file, profile, rawForNewline = '', options = {}) {
    const backup = options.backup || backupPathFor(file);
    let backupWritten = false;
    if (options.backup !== false && !fs.existsSync(backup)) {
        fs.copyFileSync(file, backup);
        backupWritten = true;
    } else if (options.forceBackup && fs.existsSync(backup)) {
        fs.copyFileSync(file, backup);
        backupWritten = true;
    }

    const text = serializeProfile(profile, rawForNewline);
    const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.tmp-' + process.pid);
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { backup, backupWritten, text };
}

module.exports = {
    QUARANTINE_KEY,
    BACKUP_SUFFIX,
    STRONG_KINDS,
    scanProfile,
    applyQuarantine,
    restoreAll,
    backupPathFor,
    readProfileFile,
    serializeProfile,
    writeProfileFile,
    getFieldList,
    setFieldList,
};
