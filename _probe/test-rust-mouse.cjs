#!/usr/bin/env node
// _probe/test-rust-mouse.cjs —— pet-core 新增 mouse 命令的端到端探针（2026-11-10 四十轮续）
// 验证：click 真点到临时窗口 / drag 走 30 段 / 遮挡检查能否决 / 全程 <100ms（不含进程启动）。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'pet-core', 'target', 'release', process.platform === 'win32' ? 'pet-core.exe' : 'pet-core');
const GC = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLEANUP = [];
process.on('exit', () => { while (CLEANUP.length) { try { CLEANUP.pop()(); } catch (e) {} } });

function core(req) {
    const out = execFileSync(CORE, [], { input: JSON.stringify(req), timeout: 15000, maxBuffer: 4 * 1024 * 1024 }).toString();
    try { return JSON.parse(out); } catch (e) { return { ok: false, error: 'bad json: ' + out.slice(0, 200) }; }
}

function setCursor(x, y) {
    const lines = [
        'Add-Type -TypeDefinition @\'',
        'using System; using System.Runtime.InteropServices;',
        'public class C { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); }',
        '\'@',
        `[void][C]::SetCursorPos(${x},${y})`,
    ];
    return new Promise((resolve) => {
        const enc = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
        const c = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { windowsHide: false, stdio: 'ignore' });
        c.on('close', resolve);
        setTimeout(() => { try { c.kill(); } catch (e) {} resolve(); }, 5000);
    });
}

function queryRect(title) {
    try {
        const out = execFileSync(CORE, [], { input: JSON.stringify({ cmd: 'windows', filter: title }), timeout: 8000, maxBuffer: 4 * 1024 * 1024 }).toString();
        const j = JSON.parse(out);
        const w = (j.windows || []).find((x) => x.title === title) || (j.windows || [])[0];
        if (!w) return null;
        return { l: w.x, t: w.y, r: w.x + w.w, b: w.y + w.h };
    } catch (e) { return null; }
}

async function main() {
    const a = [];
    const stamp = String(process.pid) + '_' + String(Date.now() % 100000);
    const title = 'RUST_MOUSE_' + stamp;
    const clickMarker = path.join(__dirname, '.tmp-rust-click-' + stamp + '.txt');
    const LEFT = 420, TOP = 320, W = 320, H = 220;
    let cx = LEFT + Math.round(W / 2), cy = TOP + Math.round(H / 2);
    try { fs.unlinkSync(clickMarker); } catch (e) {}

    const lines = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form',
        "$f.Text = '" + title + "'",
        '$f.Width = ' + W + '; $f.Height = ' + H + '; $f.FormBorderStyle = "None"; $f.ShowInTaskbar = $false; $f.TopMost = $true',
        "$f.StartPosition = 'Manual'; $f.Left = " + LEFT + '; $f.Top = ' + TOP + '; $f.Opacity = 0.02',
        "$f.Add_Click({ try { [System.IO.File]::WriteAllText('" + clickMarker + "', 'clicked') } catch {} })",
        '$f.Show(); [void]$f.Activate(); [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200',
        'for ($i=0; $i -lt 80; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }',
        '$f.Close()',
    ];
    const enc = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
    const form = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let formErr = '';
    form.stderr.on('data', (d) => { formErr += d; });
    form.on('exit', (code) => { if (code !== 0) console.log('[probe] form exit', code, String(formErr).slice(0, 300)); });
    CLEANUP.push(() => { try { form.kill(); } catch (e) {} try { fs.unlinkSync(clickMarker); } catch (e) {} });
    await sleep(1400);
    const rect = await queryRect(title);
    if (rect) {
        cx = Math.round((rect.l + rect.r) / 2);
        cy = Math.round((rect.t + rect.b) / 2);
    }
    console.log('[probe] 窗口矩形', rect, '→ 点击点', cx + ',' + cy);
    await setCursor(1200, 900);

    // 1) click 真点到临时窗口
    const click = core({ cmd: 'mouse', kind: 'click', x: cx, y: cy, expectTitle: title });
    await sleep(300);
    a.push({ id: '1a', desc: 'click 返回 ok:true', pass: click.ok === true, got: JSON.stringify(click) });
    a.push({ id: '1b', desc: '临时窗口收到点击（marker 存在）', pass: fs.existsSync(clickMarker), got: fs.existsSync(clickMarker) ? '收到' : '没收到' });
    a.push({ id: '1c', desc: 'Rust 内部耗时 <100ms（不含进程启动）', pass: Number(click.us) > 0 && Number(click.us) < 100000, got: 'us=' + click.us });

    // 2) drag 30 段
    const drag = core({ cmd: 'mouse', kind: 'drag', x: cx - 60, y: cy - 30, x2: cx + 60, y2: cy + 30, durationMs: 450, expectTitle: title });
    a.push({ id: '2a', desc: 'drag 返回 ok:true 且 steps=30', pass: drag.ok === true && drag.steps === 30, got: JSON.stringify(drag) });
    a.push({ id: '2b', desc: 'drag 内部耗时 <900ms（含 450ms 铺路 + 首尾等待）', pass: Number(drag.us) > 0 && Number(drag.us) < 900000, got: 'us=' + drag.us });

    // 3) 遮挡检查：期望标题故意写错 → OCCLUDED
    const bad = core({ cmd: 'mouse', kind: 'click', x: cx, y: cy, expectTitle: 'NOPE_' + stamp });
    a.push({ id: '3a', desc: '遮挡检查否决（ok:false + OCCLUDED）', pass: bad.ok === false && /OCCLUDED/.test(String(bad.error)), got: JSON.stringify(bad).slice(0, 220) });

    // 4) game-control 的 click_at 是否走了 Rust 快轨
    console.log('[probe] 测 game-control click_at 快轨…');
    const gcRes = await GC.runGameAction('click_at', cx + ',' + cy, null, null, null);
    a.push({ id: '4a', desc: 'click_at 返回 ok:true', pass: gcRes.ok === true, got: JSON.stringify(gcRes).slice(0, 260) });
    a.push({ id: '4b', desc: 'actionResult.via = rust（没走 pwsh）', pass: gcRes.actionResult && gcRes.actionResult.via === 'rust', got: 'via=' + (gcRes.actionResult && gcRes.actionResult.via) });

    let pass = 0, fail = 0;
    for (const it of a) {
        console.log('  ' + (it.pass ? 'PASS' : 'FAIL') + '  ' + it.id + '  ' + it.desc + (it.pass ? '' : '  got: ' + it.got));
        if (it.pass) pass += 1; else fail += 1;
    }
    console.log(`\ntest-rust-mouse.cjs：PASS ${pass} / FAIL ${fail}`);
    process.exitCode = fail ? 1 : 0;
}

if (!fs.existsSync(CORE)) { console.log('SKIP: pet-core.exe 不存在'); process.exit(0); }
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
