#!/usr/bin/env node
/**
 * _probe/test-file-tool.cjs — 文件原语回归（2026-11-15 五十九轮）
 *
 * 为什么需要：`file` 是新增的只读原语（list/read/search），它的价值全在**边界**上 ——
 * 能不能拒二进制、能不能拒相对路径、能不能拒敏感目录、大了会不会硬读。
 * 这些都是「模型很可能会真的传入」的输入，不能靠人肉试。
 *
 * 用临时目录造夹具，不碰用户的真实文件；跑完删干净。
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

(async () => {
    const p = new P();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-file-'));
    const sub = path.join(dir, 'probe-sub');
    try {
        fs.writeFileSync(path.join(dir, 'hello-中文.txt'), '第一行\n第二行 abc\n', 'utf8');
        fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x41, 0x00, 0x42, 0x00]));
        fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(3 * 1024 * 1024));
        fs.mkdirSync(sub);
        fs.writeFileSync(path.join(sub, 'probe-inner.txt'), 'inner', 'utf8');

        const call = async (args) => JSON.parse(await p._fileTool(args));
        const j = (s) => String(s).split(path.sep).join('/');

        const list = await call({ action: 'list', path: j(dir) });
        ok('list 能列目录', list.ok === true && list.count >= 4, 'count=' + list.count);
        ok('list 把目录排在文件前（[D] 在第一行）', /\[D\]\s*probe-sub/.test(String(list.detail || '')));

        const read = await call({ action: 'read', path: j(path.join(dir, 'hello-中文.txt')) });
        ok('read 能读 UTF-8 中文', read.ok === true && /第二行 abc/.test(String(read.detail || '')), 'total=' + read.total_chars);
        ok('read 报出真实总字符数', Number(read.total_chars) === 12, 'total=' + read.total_chars);

        const search = await call({ action: 'search', path: j(dir), keyword: 'probe' });
        ok('search 能递归找到子目录里的文件', search.ok === true && (search.hits || []).length >= 1, 'hits=' + (search.hits || []).length);

        const bin = await call({ action: 'read', path: j(path.join(dir, 'blob.bin')) });
        ok('二进制文件被明确拒绝（EBINARY）', bin.ok === false && bin.error === 'EBINARY', bin.error);

        const big = await call({ action: 'read', path: j(path.join(dir, 'big.txt')) });
        ok('超大文件不硬读（EFBIG）', big.ok === false && big.error === 'EFBIG', big.error);

        const noSuch = await call({ action: 'read', path: j(path.join(dir, 'nope.txt')) });
        ok('不存在的路径报 ENOENT', noSuch.ok === false && noSuch.error === 'ENOENT', noSuch.error);

        const rel = await call({ action: 'read', path: 'relative/x.txt' });
        ok('相对路径被拒（not-absolute）', rel.ok === false && rel.error === 'not-absolute', rel.error);

        const deny = await call({ action: 'read', path: j(path.join(os.homedir(), '.ssh', 'id_rsa')) });
        ok('敏感目录被拒（denied-path）', deny.ok === false && deny.error === 'denied-path', deny.error);

        const badAct = await call({ action: 'rm', path: j(dir) });
        ok('未知 action 被拒（只读卡口）', badAct.ok === false, badAct.error);
    } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { console.error('  ⚠ 临时目录清理失败: ' + dir); }
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    process.exit(1);
});
