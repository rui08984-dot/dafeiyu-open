#!/usr/bin/env node
'use strict';
// js/components/cli.cjs —— 组件管理器命令行（安装版用 Electron-as-Node 跑）
//
// 用法（安装版）：
//   set ELECTRON_RUN_AS_NODE=1
//   DaFeiyu.exe resources\app\js\components\cli.cjs status
//   DaFeiyu.exe resources\app\js\components\cli.cjs install --all
//   DaFeiyu.exe resources\app\js\components\cli.cjs install --id=voice-asr,memory
//   DaFeiyu.exe resources\app\js\components\cli.cjs remove --id=voice-asr
// 开发树：node live-2d/js/components/cli.cjs status
//
// 输出：人读行；--json 时进度为逐行 JSON（{"event":"progress",...}），最后一行 {"event":"result",...}

const manager = require('./manager');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (name, def) => {
    const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
    if (!hit) return def;
    if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
    const i = argv.indexOf(hit);
    return argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
};
const JSON_OUT = has('--json');
const cmd = argv.find((a) => !a.startsWith('--')) || 'status';
const idsArg = String(arg('id', '') || '');
const ids = idsArg ? idsArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
const all = has('--all') || (cmd === 'install' && !ids.length);

function human(line) { if (!JSON_OUT) console.log(line); }
function json(obj) { if (JSON_OUT) console.log(JSON.stringify(obj)); }

function pct(received, total) {
    if (!total) return Math.round(received / 1048576) + 'MB';
    return Math.round(received / total * 100) + '%';
}
function mb(n) { return (n / 1048576).toFixed(1) + 'MB'; }

async function main() {
    const root = manager.installRoot();
    if (cmd === 'status' || cmd === 'list') {
        const st = manager.status(root);
        if (!st.ok) { human('✗ ' + st.error); json({ event: 'result', ok: false, error: st.error }); process.exit(1); }
        human('组件目录：' + manager.componentsDir(root));
        human('清单：' + st.manifestPath);
        human('');
        for (const c of st.components) {
            const mark = c.installed ? '✓ 已装 ' + c.installedVersion : '– 未装';
            human(`  ${c.id.padEnd(14)} ${c.name}  ${mb(c.sizeBytes)}  ${mark}`);
        }
        json({ event: 'result', ok: true, status: st });
        return;
    }
    if (cmd === 'install') {
        let wanted = ids;
        if (all) {
            const st = manager.status(root);
            if (!st.ok) { human('✗ ' + st.error); json({ event: 'result', ok: false, error: st.error }); process.exit(1); }
            wanted = st.components.map((c) => c.id);
        }
        if (!wanted.length) { human('没有指定组件（--all 或 --id=a,b）'); process.exit(2); }
        human('安装：' + wanted.join(', '));
        const r = await manager.install(root, wanted, {
            onProgress: (p) => {
                json({ event: 'progress', phase: 'download', received: p.received, total: p.total, bps: p.bps });
                if (!JSON_OUT && p.total) process.stdout.write('\r  下载 ' + pct(p.received, p.total) + '  ' + mb(p.received) + '/' + mb(p.total) + '   ');
            },
            onStatus: (s) => {
                json({ event: 'status', ...s });
                if (s.phase === 'component') human('\n==> ' + s.id + ' · ' + s.name + ' (' + s.version + ')');
                if (s.phase === 'file' && s.skipped) human('  – 已存在，跳过');
                if (s.phase === 'file' && s.done) human('\n  ✓ 下载并解压完成');
                if (s.phase === 'config') human('  ✓ 配置已写入' + (s.changed ? '' : '（无变化）'));
                if (s.phase === 'done') human('\n完成：' + s.installed.join(', ') + '；服务 ' + s.services + ' 个');
            },
        });
        if (!r.ok) { human('\n✗ ' + r.error); json({ event: 'result', ok: false, error: r.error }); process.exit(1); }
        json({ event: 'result', ok: true, installed: r.installed, services: r.services });
        return;
    }
    if (cmd === 'remove') {
        if (!ids.length) { human('用法：remove --id=voice-asr'); process.exit(2); }
        const r = await manager.remove(root, ids);
        human(JSON.stringify(r));
        json({ event: 'result', ...r });
        return;
    }
    if (cmd === 'verify') {
        const st = manager.status(root);
        human('清单可读：' + (st.ok ? '是' : '否')); 
        json({ event: 'result', ok: st.ok, status: st });
        process.exit(st.ok ? 0 : 1);
    }
    human('用法：cli.cjs status | install --all | install --id=a,b | remove --id=a | verify [--json]');
    process.exit(2);
}

main().catch((e) => {
    if (JSON_OUT) console.log(JSON.stringify({ event: 'result', ok: false, error: String(e && e.stack || e) }));
    else console.error('✗ ' + (e && e.stack || e));
    process.exit(1);
});
