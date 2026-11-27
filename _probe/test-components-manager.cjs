#!/usr/bin/env node
/**
 * _probe/test-components-manager.cjs —— 组件管理器（下载/校验/解压/写配置/幂等/换源）
 *
 * 全离线：临时 install root + 本地 HTTP 服务 + bsdtar 现做的小 zip。
 * 判定：0 = 全过；非 0 = 有失败。不碰真实安装目录与 data。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const manager = require(path.join(LIVE, 'js', 'components', 'manager.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-components-'));
    const root = path.join(tmp, 'install');
    fs.mkdirSync(path.join(root, 'resources', 'app'), { recursive: true });
    fs.writeFileSync(path.join(root, 'resources', 'app', 'config.json'), JSON.stringify({
        llm: { provider_id: 'cloud' }, asr: { enabled: false }, memos: { enabled: false },
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(root, 'components'), { recursive: true });

    // 造一个小 zip：demo/index.txt + demo/run.txt
    const src = path.join(tmp, 'zipsrc');
    fs.mkdirSync(path.join(src, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(src, 'demo', 'index.txt'), 'demo component\n', 'utf8');
    fs.writeFileSync(path.join(src, 'demo', 'run.txt'), 'ok\n', 'utf8');
    const zip = path.join(tmp, 'demo.zip');
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'),
        ['-a', '-c', '-f', zip, '-C', src, 'demo'], { windowsHide: true });
    const zipSha = sha(zip);
    const zipSize = fs.statSync(zip).size;

    // 本地 HTTP：/demo.zip 正常；/bad.zip 故意返回坏内容（哈希不匹配）
    let hits = { demo: 0, bad: 0 };
    const server = http.createServer((req, res) => {
        if (req.url.startsWith('/demo.zip')) { hits.demo += 1; const b = fs.readFileSync(zip); res.writeHead(200, { 'Content-Length': b.length }); return res.end(b); }
        if (req.url.startsWith('/bad.zip')) { hits.bad += 1; res.writeHead(200); return res.end('not a zip'); }
        res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;

    const manifest = {
        schema: 1,
        components: [
            {
                id: 'demo', name: '演示组件', version: '1.0.0', extractTo: 'demo',
                files: [{ name: 'demo.zip', dest: 'demo.zip', sha256: zipSha, sizeBytes: zipSize, extractTo: 'demo', sources: [{ url: base + '/demo.zip', priority: 1 }] }],
                config: { 'asr.enabled': true, 'components.demo': 'yes' },
                services: [{ id: 'demo-svc', port: 0, cmd: ['{python}', '{dir}/demo/index.txt'], cwd: '{dir}', env: { PYTHONPATH: '{site}' }, health: null }],
            },
            {
                id: 'badhash', name: '坏哈希换源', version: '1.0.0', extractTo: 'badhash',
                files: [{ name: 'demo.zip', dest: 'badhash.zip', sha256: zipSha, sizeBytes: zipSize, extractTo: 'badhash', sources: [
                    { url: base + '/bad.zip', priority: 1 },
                    { url: base + '/demo.zip', priority: 2 },
                ] }],
                config: {},
                services: [],
            },
        ],
    };
    fs.writeFileSync(path.join(root, 'components', 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // ── install ────────────────────────────────────────────────────────
    const status1 = await manager.install(root, ['demo', 'badhash'], { onStatus: () => {}, onProgress: () => {} });
    ok('安装返回成功', status1.ok, status1.ok ? '' : status1.error);
    ok('demo 解压出文件', fs.existsSync(path.join(root, 'components', 'demo', 'demo', 'index.txt')));
    ok('归档下载后已删除', !fs.existsSync(path.join(root, 'components', 'demo.zip')));
    ok('坏源 hash 不匹配后自动换源成功', hits.bad === 1 && hits.demo >= 2, `bad=${hits.bad} demo=${hits.demo}`);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'app', 'config.json'), 'utf8'));
    ok('配置补丁已写入 asr.enabled', cfg.asr && cfg.asr.enabled === true);
    ok('配置补丁已写入 components.demo', cfg.components && cfg.components.demo === 'yes');
    ok('生成了 config 备份', fs.readdirSync(path.join(root, 'resources', 'app')).some((f) => f.startsWith('config.json.bak-components-')));
    const svc = JSON.parse(fs.readFileSync(path.join(root, 'components', 'services.json'), 'utf8'));
    ok('services.json 已物化', svc.services.length === 1 && svc.services[0].id === 'demo-svc');
    ok('服务占位符已替换', svc.services[0].cmd[0].endsWith('python.exe') && svc.services[0].cmd[1].includes('demo'), svc.services[0].cmd.join(' '));
    const state = JSON.parse(fs.readFileSync(path.join(root, 'components', 'state.json'), 'utf8'));
    ok('state 记录已装组件', !!(state.installed.demo && state.installed.badhash));

    // ── 幂等：再装一次不应重新下载 ──────────────────────────────────────
    const demoHits = hits.demo;
    const status2 = await manager.install(root, ['demo'], { onStatus: () => {}, onProgress: () => {} });
    ok('二次安装成功', status2.ok, status2.ok ? '' : status2.error);
    ok('二次安装没有重新下载', hits.demo === demoHits, `demo hits ${demoHits} → ${hits.demo}`);

    // ── 端口占用跳过（可选：services 层由另一个测试覆盖） ────────────────
    // ── remove ─────────────────────────────────────────────────────────
    const rm = await manager.remove(root, ['demo']);
    ok('remove 返回成功', rm.ok);
    const state2 = JSON.parse(fs.readFileSync(path.join(root, 'components', 'state.json'), 'utf8'));
    ok('remove 后 state 不再有 demo', !state2.installed.demo);
    ok('remove 后目录已删', !fs.existsSync(path.join(root, 'components', 'demo')));
    const svc2 = JSON.parse(fs.readFileSync(path.join(root, 'components', 'services.json'), 'utf8'));
    ok('remove 后 services 不再含 demo', !svc2.services.some((s) => s.id === 'demo-svc'));

    // ── 清单缺失 ────────────────────────────────────────────────────────
    fs.unlinkSync(path.join(root, 'components', 'manifest.json'));
    const miss = manager.status(root);
    ok('缺清单时 status 返回失败', miss.ok === false && /manifest/i.test(miss.error || ''));

    server.close();
    rmrf(tmp);
    console.log(`\n${fail === 0 ? '✓ PASS' : '✗ FAIL'}：${pass} 过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('测试自身异常：', e && e.stack || e); process.exit(1); });
