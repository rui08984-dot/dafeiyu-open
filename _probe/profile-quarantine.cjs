#!/usr/bin/env node
/**
 * _probe/profile-quarantine.cjs — 把用户画像里的「强候选」迁进隔离区（可逆）
 *
 * 判据复用 profile-audit.cjs（同一套 matchReasons/classify），只迁：
 *   · one_off（一次性事件）
 *   · meta（测试/助手元行为）
 * weak（弱提示）保留在活跃列表，仅在报告里列出。
 *
 * 迁移前先把原文件复制成 <画像>.bak-quarantine-20261121；
 * 不删除任何内容，只把条目从活跃列表移到顶层 quarantined。
 *
 * 用法：
 *   node _probe/profile-quarantine.cjs                 # 迁移真实画像
 *   node _probe/profile-quarantine.cjs --dry-run       # 只看会迁什么
 *   node _probe/profile-quarantine.cjs --file <path>   # 指定画像（测试用）
 *   node _probe/profile-quarantine.cjs --json          # 机器可读输出
 *   node _probe/profile-quarantine.cjs --force-backup  # 覆盖已存在的备份
 *
 * 退出码：0 = 完成（含无候选）；1 = 读不到/解析/写入失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./profile-quarantine-lib.cjs');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PROFILE = path.join(ROOT, '_incoming', 'my-neuro', 'data', '用户画像.json');

function parseArgs(argv) {
    const opts = { file: DEFAULT_PROFILE, dryRun: false, json: false, forceBackup: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--force-backup') opts.forceBackup = true;
        else if (a === '--file') { opts.file = path.resolve(argv[i + 1] || ''); i += 1; }
        else if (a === '--help' || a === '-h') opts.help = true;
    }
    return opts;
}

function printReport(result) {
    const { before, after, scan, moved, backup, backupWritten, dryRun } = result;
    console.log(dryRun ? '用户画像隔离预演（--dry-run，不写文件）' : '用户画像隔离迁移（不删除内容，可 restore）');
    console.log('画像：' + result.file);
    if (backup) console.log('备份：' + backup + (backupWritten ? '（本次新写）' : '（已存在，未覆盖）'));
    console.log('');

    const beforeText = Object.entries(before.fields).map(([k, v]) => k + ' ' + v).join(' / ');
    const afterText = Object.entries(after.fields).map(([k, v]) => k + ' ' + v).join(' / ');
    console.log('迁移前活跃：' + before.total + ' 条（' + beforeText + '）');
    console.log('迁移后活跃：' + after.total + ' 条（' + afterText + '）');
    console.log('迁移后隔离：' + after.quarantined + ' 条');
    console.log('本次迁入：' + moved + ' 条（一次性 ' + before.counts.one_off
        + ' / 元行为 ' + before.counts.meta + '）');
    console.log('');

    if (scan.strong.length) {
        console.log('已迁入隔离区（' + scan.strong.length + ' 条，不再参与提示词注入）：');
        scan.strong.forEach((row, i) => {
            console.log('  ' + (i + 1) + '. [' + row.field + '#' + row.index + '] ' + row.text);
            console.log('     理由：' + row.reason);
        });
        console.log('');
    } else {
        console.log('没有需要隔离的强候选。');
        console.log('');
    }

    if (scan.weak.length) {
        console.log('保留在活跃列表的弱提示（' + scan.weak.length + ' 条，请人工抽查）：');
        scan.weak.forEach((row, i) => {
            console.log('  ' + (i + 1) + '. [' + row.field + '] ' + row.text);
            console.log('     理由：' + row.reason);
        });
        console.log('');
    }

    console.log(dryRun
        ? '未写入任何文件。'
        : '完成。还原：node _probe/profile-restore.cjs --all');
}

function countActive(profile) {
    let total = 0;
    const fields = {};
    for (const field of require('./profile-audit.cjs').FIELDS) {
        const n = lib.getFieldList(profile, field).length;
        fields[field] = n;
        total += n;
    }
    return { total, fields };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('用法：node _probe/profile-quarantine.cjs [--file <画像.json>] [--dry-run] [--json] [--force-backup]');
        return 0;
    }
    if (!fs.existsSync(opts.file)) {
        console.error('画像文件不存在：' + opts.file);
        return 1;
    }

    let loaded;
    try {
        loaded = lib.readProfileFile(opts.file);
    } catch (e) {
        console.error('读取画像失败：' + (e && e.message || e));
        return 1;
    }

    const scan = lib.scanProfile(loaded.data);
    const applied = lib.applyQuarantine(loaded.data);
    const before = countActive(loaded.data);
    const after = countActive(applied.profile);
    const quarantined = Array.isArray(applied.profile[lib.QUARANTINE_KEY])
        ? applied.profile[lib.QUARANTINE_KEY].length
        : 0;

    const result = {
        file: opts.file,
        dryRun: opts.dryRun,
        before: { ...before, counts: scan.counts },
        after: { ...after, quarantined },
        scan,
        moved: applied.moved,
        backup: lib.backupPathFor(opts.file),
        backupWritten: false,
    };

    if (!opts.dryRun && applied.moved > 0) {
        try {
            const written = lib.writeProfileFile(opts.file, applied.profile, loaded.raw, {
                forceBackup: opts.forceBackup,
            });
            result.backup = written.backup;
            result.backupWritten = written.backupWritten;
        } catch (e) {
            console.error('写入画像失败：' + (e && e.message || e));
            return 1;
        }
    }

    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
    return 0;
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { main };
