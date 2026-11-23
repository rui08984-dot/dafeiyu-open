#!/usr/bin/env node
/**
 * _probe/test-profile-quarantine.cjs — 画像隔离/还原/注入回归（2026-11-21）
 *
 * 覆盖：
 *   ① 真实画像副本上执行隔离：强候选 9(one_off)+7(meta)=16 条进 quarantined；
 *   ② 活跃列表不再包含这 16 条；弱提示（极光计划）仍留在活跃列表；
 *   ③ 原文件先备份成 .bak-quarantine-20261121，备份与迁移前逐字节一致；
 *   ④ profile-restore.cjs --all 后与迁移前逐字节一致（含数组顺序）；
 *   ⑤ 幂等：再跑一次隔离迁移 0 条；
 *   ⑥ user-profile 的注入链路（_refreshRenderedProfile / onLLMRequest）不含隔离文本，
 *      工具视图能看到隔离条数。
 *
 * 全程只操作临时副本，绝不改写真实 用户画像.json。
 * 用法：node _probe/test-profile-quarantine.cjs
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REAL_PROFILE = path.join(ROOT, '_incoming', 'my-neuro', 'data', '用户画像.json');
const lib = require('./profile-quarantine-lib.cjs');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail) {
    if (ok) {
        pass += 1;
        console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
    } else {
        fail += 1;
        failures.push(name);
        console.log('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    }
}

function activeTexts(profile) {
    const out = [];
    for (const field of require('./profile-audit.cjs').FIELDS) {
        for (const item of lib.getFieldList(profile, field)) out.push({ field, text: String(item) });
    }
    return out;
}

function main() {
    if (!fs.existsSync(REAL_PROFILE)) {
        console.error('真实画像不存在：' + REAL_PROFILE);
        process.exit(1);
    }

    // 基线优先用迁移前备份：真实画像可能已经迁移过，备份才是「迁移前」的逐字节原样。
    const baseline = fs.existsSync(lib.backupPathFor(REAL_PROFILE))
        ? lib.backupPathFor(REAL_PROFILE)
        : REAL_PROFILE;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-quarantine-'));
    const tmpProfile = path.join(tmpDir, '用户画像.json');
    fs.copyFileSync(baseline, tmpProfile);
    const originalBytes = fs.readFileSync(tmpProfile);

    console.log('画像隔离回归（临时副本：' + tmpProfile + '）');
    console.log('基线：' + baseline);
    console.log('');

    // ---------- 迁移前基线 ----------
    const before = JSON.parse(originalBytes.toString('utf8'));
    const beforeScan = lib.scanProfile(before);
    check('迁移前强候选 = 16（9 一次性 + 7 元行为）',
        beforeScan.strong.length === 16 && beforeScan.counts.one_off === 9 && beforeScan.counts.meta === 7,
        `strong=${beforeScan.strong.length} one_off=${beforeScan.counts.one_off} meta=${beforeScan.counts.meta}`);
    check('迁移前弱提示 = 1（极光计划）',
        beforeScan.weak.length === 1 && beforeScan.weak[0].text.includes('极光'),
        JSON.stringify(beforeScan.weak.map((x) => x.text)));
    const activeBefore = activeTexts(before).length;

    // ---------- 执行隔离 CLI ----------
    const out = execFileSync(process.execPath, [path.join(__dirname, 'profile-quarantine.cjs'),
        '--file', tmpProfile, '--json'], { encoding: 'utf8' });
    const quarantinedRun = JSON.parse(out);

    const afterBytes = fs.readFileSync(tmpProfile);
    const after = JSON.parse(afterBytes.toString('utf8'));
    const quarantine = Array.isArray(after.quarantined) ? after.quarantined : [];
    const activeAfter = activeTexts(after);

    check('隔离后 quarantined = 16 条', quarantine.length === 16, String(quarantine.length));
    check('隔离后活跃列表减少 16 条', activeAfter.length === activeBefore - 16,
        `${activeBefore} → ${activeAfter.length}`);
    check('CLI 统计一致（moved=16）', quarantinedRun.moved === 16, String(quarantinedRun.moved));

    const strongTexts = beforeScan.strong.map((r) => r.text);
    check('活跃列表不含任何强候选',
        !activeAfter.some((row) => strongTexts.includes(row.text)),
        activeAfter.filter((row) => strongTexts.includes(row.text)).map((x) => x.text).join(' | '));
    check('quarantined 含全部强候选',
        strongTexts.every((t) => quarantine.some((q) => q.text === t)),
        String(quarantine.length));

    check('弱提示仍留在活跃列表（不被误伤）',
        activeAfter.some((row) => row.field === 'facts' && row.text === beforeScan.weak[0].text),
        beforeScan.weak[0].text);

    const record = quarantine[0] || {};
    check('隔离记录字段完整（text/from/reason/at，另带 index）',
        typeof record.text === 'string' && typeof record.from === 'string'
        && typeof record.reason === 'string' && typeof record.at === 'string'
        && Number.isInteger(record.index),
        JSON.stringify(record).slice(0, 160));

    // 备份
    const backup = lib.backupPathFor(tmpProfile);
    check('迁移前已写 .bak-quarantine-20261121', fs.existsSync(backup));
    check('备份与原文件逐字节一致',
        fs.existsSync(backup) && Buffer.compare(fs.readFileSync(backup), originalBytes) === 0);

    // idempotent
    const second = lib.applyQuarantine(after);
    check('重复隔离幂等（第二次迁 0 条）', second.moved === 0, String(second.moved));

    // ---------- 注入链路：隔离区不进 system ----------
    let plugin = null;
    try {
        const UserProfilePlugin = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d',
            'plugins', 'community', 'user-profile', 'index.js'));
        plugin = Object.create(UserProfilePlugin.prototype);
        plugin._cfg = {};
        plugin._profile = after;
        plugin._renderedProfile = '';
        plugin._profilePath = tmpProfile;
        plugin._candidatePath = path.join(tmpDir, '候选.json');
        plugin._refreshRenderedProfile();
    } catch (e) {
        check('加载 user-profile 插件（注入链路测试）', false, e.message);
    }
    if (plugin) {
        const rendered = plugin._renderedProfile || '';
        check('注入文本不含隔离候选',
            quarantine.every((q) => !rendered.includes(q.text)),
            rendered.slice(0, 80));
        const messages = [{ role: 'system', content: 'BASE' }];
        const req = { messages };
        Promise.resolve(plugin.onLLMRequest(req)).then(() => {
            const injected = messages[0].content;
            check('onLLMRequest 注入后不含隔离候选',
                quarantine.every((q) => !injected.includes(q.text)));
            check('onLLMRequest 仍注入了活跃画像',
                injected.includes('BASE') && injected.length > 10,
                String(injected.length));
            check('工具视图列出隔离条数',
                /隔离区: 16 条/.test(plugin._renderProfileForTool()),
                plugin._renderProfileForTool().split('\n').slice(-3).join(' / '));

            // ---------- 还原 CLI ----------
            const restoreOut = execFileSync(process.execPath, [path.join(__dirname, 'profile-restore.cjs'),
                '--all', '--file', tmpProfile, '--json'], { encoding: 'utf8' });
            const restoreRun = JSON.parse(restoreOut);
            const restoredBytes = fs.readFileSync(tmpProfile);
            check('restore 还原 16 条', restoreRun.restored === 16, String(restoreRun.restored));
            check('restore 后 quarantined 键已移除',
                !Object.prototype.hasOwnProperty.call(JSON.parse(restoredBytes.toString('utf8')), 'quarantined'));
            check('restore 后与迁移前逐字节一致',
                Buffer.compare(restoredBytes, originalBytes) === 0,
                `${restoredBytes.length} vs ${originalBytes.length} bytes`);

            finish(tmpDir);
        }).catch((e) => {
            check('onLLMRequest 执行', false, e && e.message);
            finish(tmpDir);
        });
        return;
    }

    finish(tmpDir);
}

function finish(tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('');
    console.log(`PASS ${pass} / FAIL ${fail}`);
    if (failures.length) console.log('失败项：' + failures.join(', '));
    process.exitCode = fail === 0 ? 0 : 1;
}

main();
