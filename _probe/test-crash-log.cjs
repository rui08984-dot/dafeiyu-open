#!/usr/bin/env node
/**
 * _probe/test-crash-log.cjs —— 主进程崩溃现场留证（2026-11-22）
 *
 * 背景：重启偶发 ERR_UNKNOWN_FILE_EXTENSION（重试一次就成功），但进程死时没留证据，
 * 下次只能再猜。main.js 第一行现在装 crash-log，把 code/url/堆栈同步落盘。
 *
 * 钉住五件事（都真跑子进程，不模拟）：
 *   ① uncaughtException 会写盘，且文件里有 code / url / 完整堆栈（这就是要抓的 import 链）
 *   ② **不改变崩溃语义**：处理器只记录、不退出（2026-11-22 实测：Electron 主进程
 *      对 reject 只警告、对 throw 有时继续有时弹模态框卡住 —— 两种都不能靠退出码判断，
 *      更不能用 exit 去"统一"它们；exit 会把能活的情形变成重启失败）
 *   ③ unhandledRejection 同样留证、同样不退出
 *   ④ 日志目录不可写时不二次崩
 *   ⑤ main.js 的接线点在第一行业务 require 之前（否则模块加载期崩溃抓不到）
 *
 * 数据隔离：全部走 mkdtemp，不碰真实 crash-main.log。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MOD = path.join(APP, 'js', 'core', 'crash-log.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-crashlog-'));

function runChild(script, args) {
    const file = path.join(tmp, 'child-' + Math.random().toString(36).slice(2) + '.cjs');
    fs.writeFileSync(file, script, 'utf8');
    try {
        const out = execFileSync(process.execPath, [file].concat(args || []), {
            encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, out: String(out) };
    } catch (e) {
        return { code: (e && typeof e.status === 'number') ? e.status : -1, out: String((e && (e.stdout || '')) || '') + String((e && (e.stderr || '')) || '') };
    }
}

// ① ② uncaughtException：写 code/url/堆栈；且**处理器不让进程死**（Electron 语义）
{
    const logFile = path.join(tmp, 'crash-a.log');
    const script = [
        "'use strict';",
        'const m = require(' + JSON.stringify(MOD) + ');',
        'm.install({ file: ' + JSON.stringify(logFile) + ' });',
        'const err = new Error("unknown file extension .py for C:/x/y.py");',
        'err.code = "ERR_UNKNOWN_FILE_EXTENSION";',
        'err.url = "file:///C:/x/y.py";',
        'setTimeout(() => { throw err; }, 30);',
        'setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 400);',
    ].join('\n');
    const r = runChild(script);
    ok('uncaughtException 后进程仍活着（Electron 语义：留证不改行为）',
        r.code === 0 && r.out.includes('SURVIVED'), 'exit=' + r.code + ' out=' + r.out.trim().slice(0, 60));
    let body = '';
    try { body = fs.readFileSync(logFile, 'utf8'); } catch (e) { body = ''; }
    ok('崩溃条目已落盘', body.length > 0, body.slice(0, 40) || '(空)');
    ok('条目含 code', body.includes('code=ERR_UNKNOWN_FILE_EXTENSION'), '');
    ok('条目含 url（这是复现时要抓的 import 链线索）', body.includes('url=file:///C:/x/y.py'), '');
    ok('条目含完整堆栈（有 at 帧）', /\n\s+at\s/.test(body), '');
    ok('条目含 kind=uncaughtException', body.includes('uncaughtException'), '');
}

// ③ unhandledRejection：同样留证、同样不退出
{
    const logFile = path.join(tmp, 'crash-b.log');
    const script = [
        "'use strict';",
        'const m = require(' + JSON.stringify(MOD) + ');',
        'm.install({ file: ' + JSON.stringify(logFile) + ' });',
        'Promise.reject(Object.assign(new Error("boom rejection"), { code: "ERR_UNKNOWN_FILE_EXTENSION" }));',
        'setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 400);',
    ].join('\n');
    const r = runChild(script);
    let body = '';
    try { body = fs.readFileSync(logFile, 'utf8'); } catch (e) { body = ''; }
    ok('unhandledRejection 留证（kind + code）',
        body.includes('unhandledRejection') && body.includes('ERR_UNKNOWN_FILE_EXTENSION'), body.split('\n')[0] || '(空)');
    ok('unhandledRejection 后进程仍活着（不把警告升级成崩溃）',
        r.code === 0 && r.out.includes('SURVIVED'), 'exit=' + r.code);
}

// ④ 目录不可写：处理器自己不能二次崩
{
    // 指向一个「把父路径设成文件」的非法路径，确保 append 必失败
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'x', 'utf8');
    const badFile = path.join(blocker, 'sub', 'crash.log');
    const script = [
        "'use strict';",
        'const m = require(' + JSON.stringify(MOD) + ');',
        'const h = m.install({ file: ' + JSON.stringify(badFile) + ' });',
        'const line = h.note("manual", new Error("should not crash"));',
        'console.log("SURVIVED " + (line.indexOf("manual") >= 0 ? "1" : "0"));',
        'process.exit(0);',
    ].join('\n');
    const r = runChild(script);
    ok('日志写不了时 note() 仍返回摘要、进程不二次崩',
        r.code === 0 && r.out.includes('SURVIVED 1'), 'exit=' + r.code + ' out=' + r.out.trim().slice(0, 60));
}

// ⑤ main.js 接线：crash-log 必须在 silent-audit 之前（模块加载期崩溃也抓得到）
{
    const src = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
    const iCrash = src.indexOf("crash-log.js");
    const iAudit = src.indexOf("require('./js/core/silent-audit.js')");
    ok('main.js 第一行装 crash-log（在业务 require 之前）',
        iCrash > 0 && iAudit > 0 && iCrash < iAudit,
        'crash@' + iCrash + ' audit@' + iAudit);
    ok('main.js 写入的是 crash-main.log', src.includes("crash-main.log"), '');
}

// ⑥ 前提事实（不进断言、只留文档）：Electron 主进程的异常语义**不是**「一定活」也不是「一定退」——
//    2026-11-22 实测：`unhandledRejection` 稳定是警告级（进程继续）；`uncaughtException` 有时继续、
//    有时弹出模态错误框把进程**卡住**（不退出、也不响应），只能人工杀。
//    两种都不是能用退出码/JSDialog 可靠断言的东西，所以本项**故意不设 Electron 子断言** ——
//    它只在替一个决定服务：crash-log 处理器**只记录、绝不 exit**（exit 会把这三种情形都变成同一种死法）。
//    真正要防的回归由上面 ①–⑤ 的「处理器不退出」断言兜住（纯 Node 里跑，稳定）。

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
