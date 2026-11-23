#!/usr/bin/env node
/**
 * _probe/test-persona-corruption.cjs —— 人格内核损坏时「绝不拿出厂内核覆盖」（2026-11-22 P0）
 *
 * 现场：persona-layers.load() 解析失败静默返回 defaultKernel()，而 memory-evolve
 * 每 5 分钟 applySlow → save() 把人写的 core 永久覆盖。用户只会发现「我改的人格没了」。
 *
 * 钉住三件事：
 *   ① 文件损坏（半截 JSON）→ 隔离成 .corrupt-*，**原路径不重新生成**，写回被锁死
 *   ② 能解析但形状不合法（缺 core/slow）→ 同样隔离 + 锁死
 *   ③ 锁死后 applySlow / save 都明确失败（有 reason，不静默成功）
 *
 * 每个场景用独立子进程跑：_blocked 是进程内不可逆状态，混在一起会互相污染。
 * 数据隔离：PET_PERSONA_FILE + mkdtemp，不碰真实 人格内核.json。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PL_MOD = path.join(APP, 'js', 'core', 'persona-layers.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-persona-corrupt-'));

function runCase(mode, content) {
    const dir = path.join(tmp, mode);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '人格三层.json');
    fs.writeFileSync(file, content, 'utf8');
    const script = path.join(dir, 'case.cjs');
    fs.writeFileSync(script, [
        "'use strict';",
        'process.env.PET_PERSONA_FILE = ' + JSON.stringify(file) + ';',
        'const PL = require(' + JSON.stringify(PL_MOD) + ');',
        "const out = { file: process.env.PET_PERSONA_FILE };",
        'out.loadedName = PL.load().core.name;',
        'out.blocked = PL.isBlocked();',
        'out.reason = PL.blockedReason();',
        'out.apply = PL.applySlow({ cls: "关系", text: "测试写入", evidence: [], days: [] });',
        'out.saveDefault = PL.save(PL.defaultKernel());',
        'out.statsBlocked = PL.stats().blocked === true;',
        'out.fileExists = require("fs").existsSync(process.env.PET_PERSONA_FILE);',
        'out.corruptFiles = require("fs").readdirSync(require("path").dirname(process.env.PET_PERSONA_FILE))',
        '  .filter((n) => n.includes(".corrupt-"));',
        'process.stdout.write(JSON.stringify(out));',
    ].join('\n'), 'utf8');
    const raw = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000 });
    return JSON.parse(raw.trim());
}

// ① 半截 JSON
{
    const r = runCase('broken-json', '{ "core": { "name": "用户手写的内核"');
    ok('损坏文件：load 能返回可用内核（不炸）', r.loadedName === '大肥鱼', r.loadedName);
    ok('损坏文件：isBlocked() = true（本进程锁死写回）', r.blocked === true, String(r.blocked));
    ok('损坏文件：原因可读', /损坏|隔离|不合法/.test(String(r.reason)), r.reason);
    ok('损坏文件：坏文件被隔离成 .corrupt-*（可人工抢救）', Array.isArray(r.corruptFiles) && r.corruptFiles.length === 1, JSON.stringify(r.corruptFiles));
    ok('损坏文件：原路径没有被出厂内核重新生成', r.fileExists === false, 'exists=' + r.fileExists);
    ok('损坏文件：applySlow 明确失败（不当成功）', r.apply && r.apply.ok === false && /不可写/.test(String(r.apply.reason)), JSON.stringify(r.apply));
    ok('损坏文件：save 返回 false', r.saveDefault === false, String(r.saveDefault));
    ok('损坏文件：stats 暴露 blocked', r.statsBlocked === true, '');
}

// ② 能解析但形状不合法
{
    const r = runCase('bad-shape', JSON.stringify({ version: 1, slow: { 关系: [] } }));
    ok('形状不合法：isBlocked() = true', r.blocked === true, String(r.blocked));
    ok('形状不合法：坏文件被隔离', Array.isArray(r.corruptFiles) && r.corruptFiles.length === 1, JSON.stringify(r.corruptFiles));
    ok('形状不合法：原路径没有被重新生成', r.fileExists === false, 'exists=' + r.fileExists);
    ok('形状不合法：applySlow 明确失败', r.apply && r.apply.ok === false, JSON.stringify(r.apply));
}

// ③ 正常文件不受影响（不能因为改坏而把正常路径也锁死）
{
    const r = runCase('healthy', JSON.stringify({
        version: 1,
        core: { name: '用户的她', identity: 'x', values: [], boundaries: [] },
        slow: { 关系: [], 习惯: [], 承诺: [], 在意: [] },
        updated_at: 0, history: [],
    }));
    ok('正常文件：读到的是用户的 core（不被出厂内核替换）', r.loadedName === '用户的她', r.loadedName);
    ok('正常文件：不锁写回', r.blocked === false, String(r.blocked));
    ok('正常文件：applySlow 正常成功', r.apply && r.apply.ok === true, JSON.stringify(r.apply));
    ok('正常文件：文件仍在原路径', r.fileExists === true, '');
}

// ④ 接线断言：必须走 json-store（隔离能力来自它）
{
    const src = fs.readFileSync(PL_MOD, 'utf8');
    ok('persona-layers 走 json-store 读（损坏可隔离）', /require\('\.\/json-store\.js'\)/.test(src) && /jsonStore\.readJson/.test(src), '');
    ok('persona-layers 不再裸 fs.readFileSync 解析人格文件', !/JSON\.parse\(fs\.readFileSync\(file\(\)/.test(src), '');
    ok('persona-layers 暴露 isBlocked/blockedReason', /isBlocked,\s*blockedReason/.test(src), '');
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
