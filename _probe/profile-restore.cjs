#!/usr/bin/env node
/**
 * _probe/profile-restore.cjs — 把用户画像隔离区（quarantined）全部还原（可逆）
 *
 * 按隔离记录里的 index 插回原数组位置，然后删掉 quarantined 键；
 * 不触碰活跃列表里的其它条目、_meta、updated_at。
 * quarantine → restore 后文件应与迁移前逐字节一致（同序列化器）。
 *
 * 用法：
 *   node _probe/profile-restore.cjs --all                 # 还原真实画像
 *   node _probe/profile-restore.cjs --all --dry-run       # 只看会还原什么
 *   node _probe/profile-restore.cjs --all --file <path>   # 指定画像（测试用）
 *
 * 退出码：0 = 完成（含无隔离）；1 = 读取/写入失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./profile-quarantine-lib.cjs');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PROFILE = path.join(ROOT, '_incoming', 'my-neuro', 'data', '用户画像.json');

function parseArgs(argv) {
    const opts = { all: false, file: DEFAULT_PROFILE, dryRun: false, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--all') opts.all = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--json') opts.json = true;
        else if (a === '--file') { opts.file = path.resolve(argv[i + 1] || ''); i += 1; }
        else if (a === '--help' || a === '-h') opts.help = true;
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('用法：node _probe/profile-restore.cjs --all [--file <画像.json>] [--dry-run] [--json]');
        return 0;
    }
    if (!opts.all) {
        console.error('目前只支持 --all（把 quarantined 全部还原）。');
        return 1;
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

    const quarantine = Array.isArray(loaded.data[lib.QUARANTINE_KEY])
        ? loaded.data[lib.QUARANTINE_KEY]
        : [];
    const restored = lib.restoreAll(loaded.data);

    const result = {
        file: opts.file,
        dryRun: opts.dryRun,
        quarantinedBefore: quarantine.length,
        restored: restored.restored,
        remaining: restored.remaining.length,
        entries: quarantine.map((x) => ({ text: x.text, from: x.from, index: x.index })),
    };

    if (!opts.dryRun && quarantine.length) {
        try {
            lib.writeProfileFile(opts.file, restored.profile, loaded.raw, { backup: false });
        } catch (e) {
            console.error('写入画像失败：' + (e && e.message || e));
            return 1;
        }
    }

    if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(opts.dryRun ? '隔离区还原预演（--dry-run，不写文件）' : '隔离区还原');
        console.log('画像：' + opts.file);
        console.log('隔离区原有：' + result.quarantinedBefore + ' 条；本次还原：' + result.restored + ' 条');
        result.entries.forEach((x, i) => {
            console.log('  ' + (i + 1) + '. [' + x.from + '#' + x.index + '] ' + x.text);
        });
        if (!quarantine.length) console.log('没有隔离条目，无需还原。');
        else if (opts.dryRun) console.log('未写入任何文件。');
        else if (result.remaining) console.log(`完成：还原 ${result.restored} 条；${result.remaining} 条因字段未知/无文本留在隔离区（未丢弃）。`);
        else console.log('完成。quarantined 键已移除。');
    }
    return 0;
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { main };
