#!/usr/bin/env node
/**
 * autostart.cjs —— 开机自启的「唯一实现」（2026-11-22 单一真相源收口）
 *
 * 为什么要一个独立 node 脚本：实测**electron.exe 本体**写不了 Startup 目录（EPERM），
 * `app.setLoginItemSettings()` 也静默失败；但它的**子 node 进程**写 HKCU Run 一切正常。
 * 所以主进程只需要 spawn 这个脚本，让普通 node 去写注册表。
 *
 * 唯一实现 = HKCU\Software\Microsoft\Windows\CurrentVersion\Run\DaFeiYu
 *   "C:\Windows\System32\cmd.exe" /c start "" /min node "<launcher>"
 *
 * 旧实现留在启动文件夹里的 .cmd 是**第二套独立启动源**（会绕过 restart 自行拉起，
 * 造成重复实例）。本脚本在 on/off 时都会清理它们，但**只认这两个本项目专属文件名**：
 *   · dafeiyu-autostart.cmd   （2026-11-15 起的 ASCII 名）
 *   · 大肥鱼桌宠.cmd          （更早的中文名）
 * 启动文件夹里的其它任何文件一律不碰。
 *
 * 用法：
 *   node autostart.cjs status       → 紧凑 JSON（兼容旧调用方，只读）
 *   node autostart.cjs --status     → 人类可读的只读状态（HKCU 值 + 旧启动项）
 *   node autostart.cjs on|install   → 写 HKCU Run（幂等）、清旧 .cmd、回读校验
 *   node autostart.cjs off|remove   → 删 HKCU Run、清旧 .cmd、回读校验
 *   node autostart.cjs --self-test  → 用临时注册表键/临时目录验证开/关/幂等，并清理干净
 *
 * 失败语义：任何写入/删除/清理失败都会返回 ok:false、写一行 stderr、并以退出码 1 结束；
 * 绝不把「没写成」报成成功。status/--status 只读，不做任何修改。
 *
 * 读值方式：`reg query` 的 stdout 跟随控制台代码页（本机是 GBK），直接按 UTF-8 解码会把
 * 中文路径读成乱码，导致「写入成功但回读不一致」的假失败。这里改用 `reg export` 写出的
 * UTF-16LE .reg 文件解析，编码无关且能拿到精确值。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const NAME = 'DaFeiYu';
const ROOT = path.resolve(__dirname, '..', '..');
const LAUNCHER = path.join(ROOT, 'pet-runtime', 'tools', 'launch-my-neuro.mjs');

// 旧实现写过的启动文件夹文件名（仅此两个，且都是本项目专属名字）。
const LEGACY_STARTUP_NAMES = ['dafeiyu-autostart.cmd', '大肥鱼桌宠.cmd'];

function desiredValue() {
    return '"C:\\Windows\\System32\\cmd.exe" /c start "" /min node "' + LAUNCHER + '"';
}

function decodeConsole(buf) {
    if (!Buffer.isBuffer(buf)) return String(buf || '');
    try {
        const utf8 = buf.toString('utf8');
        // reg.exe 在中文 Windows 上按控制台代码页输出；有替换符时用 GBK 再解一次。
        if (utf8.indexOf('\uFFFD') === -1) return utf8;
        return new TextDecoder('gbk').decode(buf);
    } catch (e) {
        return buf.toString('utf8');
    }
}

function reg(args) {
    return spawnSync('reg', args, { windowsHide: true });
}

function regErr(r) {
    const parts = [];
    if (r && r.error) parts.push(String(r.error.message || r.error));
    const err = decodeConsole(r && r.stderr).trim();
    if (err) parts.push(err);
    return (parts.join(' | ') || 'no stderr').slice(0, 400);
}

function canonKey(key) {
    return String(key)
        .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
        .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
        .toLowerCase();
}

function unescapeReg(s) {
    return s.replace(/\\([\\"])/g, '$1');
}

function parseRegExport(text, targetKey) {
    const entries = new Map();
    const target = canonKey(targetKey);
    let inTarget = false;
    let sectionCount = 0;
    for (const rawLine of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const sec = /^\[(.+)\]$/.exec(line);
        if (sec) {
            // export 会连子键一起导出；只取目标键本身这一段。
            sectionCount++;
            inTarget = canonKey(sec[1]) === target;
            continue;
        }
        if (!inTarget) continue;
        // 本项目只写 REG_SZ；REG_DWORD/hex 等其它类型不参与比较。
        const m = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line);
        if (!m) continue;
        entries.set(unescapeReg(m[1]), unescapeReg(m[2]));
    }
    return { entries, sectionCount };
}

function exportRegistry(key) {
    const tmp = path.join(
        os.tmpdir(),
        'dafeiyu-autostart-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.reg'
    );
    try {
        const r = reg(['export', key, tmp, '/y']);
        if (r.status !== 0) {
            return { ok: false, entries: new Map(), error: 'reg export 失败 (status=' + r.status + '): ' + regErr(r) };
        }
        if (!fs.existsSync(tmp)) {
            return { ok: false, entries: new Map(), sectionCount: 0, error: 'reg export 未生成文件: ' + tmp };
        }
        const text = fs.readFileSync(tmp).toString('utf16le');
        const parsed = parseRegExport(text, key);
        return { ok: true, entries: parsed.entries, sectionCount: parsed.sectionCount };
    } catch (e) {
        return { ok: false, entries: new Map(), sectionCount: 0, error: '读取注册表导出失败: ' + String(e && e.message || e) };
    } finally {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* 临时文件清理失败不影响结果 */ }
    }
}

function keyExists(key) {
    return reg(['query', key]).status === 0;
}

function queryValue(key, name) {
    const ex = exportRegistry(key);
    if (!ex.ok) {
        // 键本身不存在 = 值必然不存在（这不是错误）；键在但导不出才是环境错误。
        if (!keyExists(key)) return { ok: true, exists: false, value: null, entries: new Map() };
        return { ok: false, exists: false, value: null, entries: new Map(), error: ex.error };
    }
    const lower = String(name).toLowerCase();
    for (const [k, v] of ex.entries) {
        if (k.toLowerCase() === lower) return { ok: true, exists: true, value: v, entries: ex.entries };
    }
    return { ok: true, exists: false, value: null, entries: ex.entries };
}

function setRunValue(key, name, value) {
    const r = reg(['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
    if (r.status !== 0) {
        return { ok: false, error: 'reg add 失败 (status=' + r.status + '): ' + regErr(r) };
    }
    const q = queryValue(key, name);
    if (!q.ok) return { ok: false, error: '写入后无法回读: ' + q.error };
    if (!q.exists) return { ok: false, error: 'reg add 返回成功但回读不到值 ' + name };
    if (q.value !== value) {
        return { ok: false, error: '写入后回读不一致（期望 ' + JSON.stringify(value) + '，实际 ' + JSON.stringify(q.value) + '）' };
    }
    return { ok: true };
}

function deleteRunValue(key, name) {
    const before = queryValue(key, name);
    if (!before.ok) return { ok: false, error: '删除前无法读取状态: ' + before.error };
    if (!before.exists) return { ok: true, alreadyAbsent: true, deleted: false };
    const r = reg(['delete', key, '/v', name, '/f']);
    const after = queryValue(key, name);
    if (!after.ok) return { ok: false, error: '删除后无法回读: ' + after.error };
    if (after.exists) {
        return {
            ok: false,
            deleted: false,
            error: 'reg delete 后值仍存在 (status=' + r.status + '): ' + (r.status === 0 ? '回读仍命中' : regErr(r)),
        };
    }
    return {
        ok: true,
        deleted: true,
        // reg delete 非 0 但值确实没了（并发删除）也算成功，只是留个证据。
        warning: r.status === 0 ? '' : ('reg delete 返回 ' + r.status + ' 但回读已不存在: ' + regErr(r)),
    };
}

function getStartupDir() {
    const appdata = process.env.APPDATA;
    if (!appdata) return { ok: false, dir: null, error: 'APPDATA 未设置，无法定位启动文件夹' };
    return { ok: true, dir: path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') };
}

function scanLegacyStartup(dir) {
    return LEGACY_STARTUP_NAMES.map((name) => {
        const p = path.join(dir, name);
        let exists = false;
        let error = '';
        try { exists = fs.existsSync(p); } catch (e) { error = String(e && e.message || e); }
        return { name, path: p, exists, error };
    });
}

function removeLegacyStartup(dir) {
    const items = [];
    let ok = true;
    for (const name of LEGACY_STARTUP_NAMES) {
        const p = path.join(dir, name);
        let existed = false;
        try {
            existed = fs.existsSync(p);
        } catch (e) {
            ok = false;
            items.push({ name, path: p, existed: false, removed: false, error: String(e && e.message || e) });
            continue;
        }
        if (!existed) {
            items.push({ name, path: p, existed: false, removed: false });
            continue;
        }
        let error = '';
        try {
            fs.unlinkSync(p);
        } catch (e) {
            error = String(e && e.message || e);
        }
        let stillThere = false;
        try {
            stillThere = fs.existsSync(p);
        } catch (e) {
            stillThere = true;
            error = error || String(e && e.message || e);
        }
        if (stillThere) {
            ok = false;
            items.push({ name, path: p, existed: true, removed: false, error: error || '删除后文件仍存在' });
        } else {
            items.push({ name, path: p, existed: true, removed: true });
        }
    }
    return { ok, items };
}

function findDuplicateRunEntries(entries) {
    const needles = ['launch-my-neuro', LAUNCHER].map((s) => s.toLowerCase());
    const out = [];
    const self = NAME.toLowerCase();
    for (const [name, value] of entries) {
        if (name.toLowerCase() === self) continue;
        const v = String(value).toLowerCase();
        if (needles.some((n) => v.indexOf(n) !== -1)) out.push({ name, value });
    }
    return out;
}

function statusReport() {
    const q = queryValue(KEY, NAME);
    const startup = getStartupDir();
    const legacy = startup.ok ? scanLegacyStartup(startup.dir) : [];
    const expected = desiredValue();
    const report = {
        ok: q.ok && startup.ok,
        on: q.exists,
        valueMatches: q.exists && q.value === expected,
        hkcuRun: { key: KEY, name: NAME, exists: q.exists, value: q.value, expected },
        startupFolder: { dir: startup.dir, legacy, error: startup.error || '' },
        duplicateRunEntries: q.ok ? findDuplicateRunEntries(q.entries) : [],
        readOnly: true,
    };
    const errors = [];
    if (!q.ok && q.error) errors.push(q.error);
    if (!startup.ok && startup.error) errors.push(startup.error);
    if (errors.length) report.error = errors.join(' | ');
    return report;
}

function on() {
    const value = desiredValue();
    const out = { on: false, ok: false, action: 'on', changed: false, value, legacyStartup: [], warnings: [] };
    const before = queryValue(KEY, NAME);
    if (!before.ok) {
        out.error = '无法读取 HKCU Run 当前状态，拒绝盲写: ' + before.error;
        return out;
    }

    if (before.exists && before.value === value) {
        out.changed = false; // 幂等：已经是这个值，不再写
    } else {
        const set = setRunValue(KEY, NAME, value);
        if (!set.ok) {
            out.error = set.error;
            out.on = before.exists;
            return out;
        }
        out.changed = true;
    }

    const startup = getStartupDir();
    if (!startup.ok) {
        out.error = 'HKCU Run 已写入，但' + startup.error;
        out.on = true;
        return out;
    }
    const clean = removeLegacyStartup(startup.dir);
    out.legacyStartup = clean.items;
    if (!clean.ok) {
        out.error = 'HKCU Run 已写入，但旧启动文件夹项清理失败（可能仍有第二启动源）';
        out.on = true;
        return out;
    }

    const after = queryValue(KEY, NAME);
    out.on = !!(after.ok && after.exists && after.value === value);
    if (!out.on) {
        out.ok = false;
        out.error = '写入后复核失败' + (after.error ? ': ' + after.error : '');
        return out;
    }
    out.duplicateRunEntries = findDuplicateRunEntries(after.entries);
    if (out.duplicateRunEntries.length > 0) {
        // 保守：只报告，不删别的 Run 值（可能是用户手工建的）。
        out.warnings.push('Run 键还有其它指向本项目的值（未自动删除，请人工确认）: ' +
            out.duplicateRunEntries.map((e) => e.name).join(', '));
    }
    out.ok = true;
    return out;
}

function off() {
    const out = { on: true, ok: false, action: 'off', changed: false, legacyStartup: [], warnings: [] };
    const before = queryValue(KEY, NAME);
    if (!before.ok) {
        out.error = '无法读取 HKCU Run 当前状态，拒绝盲删: ' + before.error;
        return out;
    }

    const del = deleteRunValue(KEY, NAME);
    if (!del.ok) {
        out.error = del.error;
        out.on = true;
        return out;
    }
    out.changed = !!del.deleted;
    if (del.warning) out.warnings.push(del.warning);

    const startup = getStartupDir();
    if (!startup.ok) {
        out.on = false;
        out.error = 'HKCU Run 已删除，但' + startup.error;
        return out;
    }
    const clean = removeLegacyStartup(startup.dir);
    out.legacyStartup = clean.items;

    const after = queryValue(KEY, NAME);
    out.on = !(after.ok && !after.exists);
    if (out.on) {
        out.ok = false;
        out.error = '删除后复核失败：DaFeiYu 值仍然存在' + (after.error ? ': ' + after.error : '');
        return out;
    }
    if (!clean.ok) {
        out.ok = false;
        out.error = 'HKCU Run 已删除，但旧启动文件夹项清理失败（开机仍可能自启）';
        return out;
    }
    out.ok = true;
    return out;
}

function selfTest() {
    const checks = [];
    const out = { ok: false, mode: 'self-test', checks, realKeyUntouched: false };
    const rec = (name, pass, detail) => {
        checks.push({ name, pass: !!pass, detail: String(detail || '').slice(0, 300) });
    };

    const realBefore = queryValue(KEY, NAME);
    if (!realBefore.ok) {
        out.error = '无法读取真实 Run 键，自检中止: ' + realBefore.error;
        return out;
    }

    const stamp = process.pid + '-' + Date.now();
    const tempRoot = 'HKCU\\Software\\DaFeiYu-SelfTest';
    const tempKey = tempRoot + '\\' + stamp;
    const tempName = 'DaFeiYuSelfTest';
    const v1 = '"C:\\Windows\\System32\\cmd.exe" /c echo dafeiyu-selftest-1';
    const v2 = v1 + '-2';
    let tempDir = '';

    try {
        let r = setRunValue(tempKey, tempName, v1);
        rec('临时键写入+回读', r.ok, r.ok ? v1 : r.error);

        r = setRunValue(tempKey, tempName, v1);
        let q = queryValue(tempKey, tempName);
        rec('重复开启幂等（同名值不叠加）',
            r.ok && q.ok && q.exists && q.value === v1 && q.entries.size === 1,
            r.ok ? ('entries=' + q.entries.size) : r.error);

        r = setRunValue(tempKey, tempName, v2);
        q = queryValue(tempKey, tempName);
        rec('覆盖更新（旧值不残留）',
            r.ok && q.ok && q.exists && q.value === v2 && q.entries.size === 1,
            r.ok ? ('value=' + q.value) : r.error);

        r = deleteRunValue(tempKey, tempName);
        q = queryValue(tempKey, tempName);
        rec('删除+回读', r.ok && q.ok && !q.exists, r.ok ? 'absent' : r.error);

        r = deleteRunValue(tempKey, tempName);
        rec('重复关闭幂等（本来没有也算成功）', r.ok && !r.deleted, r.ok ? 'already absent' : r.error);

        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-autostart-selftest-'));
        const keep = path.join(tempDir, 'keep-me.cmd');
        fs.writeFileSync(keep, '@echo off\r\nrem unrelated file, must be kept\r\n', 'utf8');
        for (const name of LEGACY_STARTUP_NAMES) {
            fs.writeFileSync(path.join(tempDir, name), '@echo off\r\nrem dafeiyu selftest\r\n', 'utf8');
        }
        const c1 = removeLegacyStartup(tempDir);
        const remain = fs.readdirSync(tempDir);
        rec('清理旧启动项（只删本项目两个名字）',
            c1.ok &&
            LEGACY_STARTUP_NAMES.every((n) => remain.indexOf(n) === -1) &&
            remain.indexOf('keep-me.cmd') !== -1,
            'remaining=' + JSON.stringify(remain));

        const c2 = removeLegacyStartup(tempDir);
        rec('重复清理幂等', c2.ok && c2.items.every((i) => !i.existed), 'all absent');
    } catch (e) {
        rec('自检异常', false, e && e.message || e);
    } finally {
        const del = reg(['delete', tempKey, '/f']);
        if (keyExists(tempKey)) {
            rec('清理临时注册表键', false, 'reg delete status=' + del.status + ' ' + regErr(del));
        } else if (!keyExists(tempRoot)) {
            rec('清理临时注册表键', true, 'deleted');
        } else {
            // reg add 会自动创建父键；子键删掉后父键可能变空，也要一并清掉才算干净。
            const rootExport = exportRegistry(tempRoot);
            const rootEmpty = rootExport.ok && rootExport.entries.size === 0 && rootExport.sectionCount <= 1;
            if (!rootEmpty) {
                rec('清理临时注册表键', false, '父键非空，保留: ' + tempRoot +
                    (rootExport.ok ? '' : ' (' + rootExport.error + ')'));
            } else {
                reg(['delete', tempRoot, '/f']);
                const rootGone = !keyExists(tempRoot);
                rec('清理临时注册表键', rootGone,
                    rootGone ? 'deleted（含空父键 ' + tempRoot + '）' : '空父键删除失败: ' + tempRoot);
            }
        }

        if (tempDir) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                rec('清理临时目录', false, String(e && e.message || e));
            }
        }

        const realAfter = queryValue(KEY, NAME);
        out.realKeyUntouched = realAfter.ok &&
            realAfter.exists === realBefore.exists &&
            realAfter.value === realBefore.value;
        rec('真实 Run 键未被修改', out.realKeyUntouched,
            out.realKeyUntouched
                ? ('on=' + realBefore.exists)
                : ('before=' + JSON.stringify(realBefore.value) + ' after=' + JSON.stringify(realAfter.value)));
    }

    out.ok = checks.every((c) => c.pass);
    if (!out.ok) out.error = '自检有检查未通过: ' + checks.filter((c) => !c.pass).map((c) => c.name).join('; ');
    return out;
}

function printStatusHuman(report) {
    const lines = [];
    lines.push('[status] HKCU Run\\' + NAME + ' = ' +
        (report.hkcuRun.exists ? report.hkcuRun.value : '(不存在)'));
    lines.push('[status] 期望值 = ' + report.hkcuRun.expected);
    lines.push('[status] 判定: on=' + report.on + ' · valueMatches=' + report.valueMatches);
    lines.push('[status] 启动文件夹 = ' + (report.startupFolder.dir || '(未知)'));
    for (const item of report.startupFolder.legacy) {
        lines.push('[status]   ' + item.name + ' = ' + (item.exists ? '存在 ' + item.path : '不存在'));
    }
    if (report.startupFolder.error) lines.push('[status] 启动文件夹读取错误: ' + report.startupFolder.error);
    if (report.duplicateRunEntries && report.duplicateRunEntries.length > 0) {
        lines.push('[status] 警告: Run 键还有其它指向本项目的值（未自动处理）: ' +
            report.duplicateRunEntries.map((e) => e.name).join(', '));
    }
    if (report.error) lines.push('[status] 错误: ' + report.error);
    lines.push('[status] 只读：未修改注册表和启动文件夹');
    process.stdout.write(lines.join('\n') + '\n');
}

function fail(msg) {
    process.stderr.write('[autostart] FAILED: ' + String(msg || 'unknown error') + '\n');
}

function main() {
    const cmd = String(process.argv[2] || 'status').toLowerCase();
    let result;

    if (cmd === '--status') {
        result = statusReport();
        printStatusHuman(result);
        if (!result.ok) {
            fail(result.error || 'status 读取失败');
            process.exitCode = 1;
        }
        return;
    }

    if (cmd === 'status') {
        result = statusReport();
        process.stdout.write(JSON.stringify(result) + '\n');
        if (!result.ok) {
            fail(result.error || 'status 读取失败');
            process.exitCode = 1;
        }
        return;
    }

    if (cmd === 'on' || cmd === 'install') result = on();
    else if (cmd === 'off' || cmd === 'remove') result = off();
    else if (cmd === '--self-test' || cmd === 'self-test') result = selfTest();
    else {
        process.stderr.write('usage: node autostart.cjs status|--status|on|off|--self-test\n');
        process.exitCode = 2;
        return;
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) {
        fail(result.error || 'operation failed');
        process.exitCode = 1;
    }
}

main();
