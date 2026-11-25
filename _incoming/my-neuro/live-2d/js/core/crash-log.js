// js/core/crash-log.js —— 主进程崩溃现场留证（2026-11-22）
//
// 为什么要有它：重启偶发 `ERR_UNKNOWN_FILE_EXTENSION`（重试一次就好），但进程死时
// 什么都没留下 —— Electron 主进程默认只往控制台打，控制台随进程消失，下次只能再猜一遍。
// 这里把 code / url / 完整堆栈 / argv 同步写盘（appendFileSync，进程立刻死也不丢），
// 下次复现就能直接看到「谁 import 了什么扩展名」的调用链，而不是只看到一个错误码。
//
// 三条纪律：
//   · **不改变崩溃语义**：只记录，不 exit。2026-11-22 实测（Electron 28 / Node 18）：
//     uncaughtException 和 unhandledRejection 在主进程里都只是**警告级**——进程继续活着，
//     控制台一行都没留（同机 Node 24 默认是 throw→退出，所以这两个运行时语义不同！）。
//     因此这里绝不能 exit：那会把「Electron 本来能活」的异常变成重启失败，属于行为回归。
//   · **绝不自伤**：日志目录不可写/轮转失败/二次抛错都吞掉，处理器自己不能再崩；
//   · **有界**：单文件 1MB 轮转一份 `.1`，不会无限涨。
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;

function stamp(d) {
    const p2 = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
        + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}

/** 首行摘要：一眼能看出「哪个扩展名/哪个模块」 */
function headLine(kind, err) {
    const e = err || {};
    const code = e.code || '-';
    const url = e.url || e.path || '-';
    const msg = String((e && e.message) || e || '').replace(/\s+/g, ' ').slice(0, 200);
    return '[' + stamp(new Date()) + '] ' + kind + ' | code=' + code + ' | url=' + url
        + ' | pid=' + process.pid + ' | argv=' + JSON.stringify(process.argv.slice(0, 6))
        + (msg ? ' | ' + msg : '');
}

/**
 * 安装两个「只留证、不退出」的处理器（uncaughtException / unhandledRejection）。
 * @param {{file?: string}} [opts]
 * @returns {{file: string, note: (kind: string, err: any) => string}}
 */
function install(opts) {
    const file = (opts && opts.file) ? String(opts.file) : path.join(process.cwd(), 'crash.log');

    function note(kind, err) {
        const head = headLine(kind, err);
        const stack = String((err && err.stack) || (err && err.message) || err || '(no stack)');
        try {
            if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
                try { fs.renameSync(file, file + '.1'); } catch (e) { /* 轮转失败不阻断留证 */ }
            }
            fs.appendFileSync(file, head + '\n' + stack + '\n\n', 'utf8');
        } catch (e) { /* 写不了日志也绝不能二次抛 */ }
        // EPIPE 自激防护（2026-11-25）：宿主被强杀/父进程先退出时 stdout 管道已关，
        // console.* 的写入**异步**触发 stream 'error'（try/catch 抓不到）→ 又进
        // uncaughtException → note() 再写 → 无限级联（实测一次关停写了 834 条）。
        // 控制台只是方便，日志文件已独立落盘：只在明确可写时打，并吞掉管道错误。
        try {
            if (process.stdout && process.stdout.writable !== false) console.error(head);
        } catch (e) { /* 控制台也坏了就算了 */ }
        return head;
    }

    // 只注册一次：把 stdout/stderr 的管道错误（EPIPE 等）吞掉，别让它们变成新的崩溃事件。
    try {
        for (const s of [process.stdout, process.stderr]) {
            if (s && typeof s.on === 'function' && typeof s.listenerCount === 'function' && s.listenerCount('error') === 0) {
                s.on('error', () => { /* 管道已关：日志已落盘，静默放弃控制台镜像 */ });
            }
        }
    } catch (e) { /* 极端环境拿不到 stream：忽略 */ }

    process.on('uncaughtException', (err) => { note('uncaughtException', err); });
    process.on('unhandledRejection', (reason) => { note('unhandledRejection', reason); });

    return { file, note };
}

module.exports = { install, headLine };
