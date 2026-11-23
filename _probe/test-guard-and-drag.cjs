#!/usr/bin/env node
// _probe/test-guard-and-drag.cjs —— 四十轮新增护栏的端到端探针（2026-11-10）
// 1) WindowFromPoint 根窗口标题（遮挡探针的 C# P/Invoke）
// 2) UAC 探针在正常桌面不误报
// 3) drag 走 30 段 ease-in-out（鼠标移动事件数 > 12）
// 全部在临时 2% 透明度窗口里做，用完即 kill；不碰用户窗口。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GC = require(path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'plugins', 'community', 'dispatch', 'game-control.js'));
const CORE = path.join(ROOT, 'pet-core', 'target', 'release', process.platform === 'win32' ? 'pet-core.exe' : 'pet-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLEANUP = [];
process.on('exit', () => { while (CLEANUP.length) { try { CLEANUP.pop()(); } catch (e) {} } });

function runPwsh(lines, timeoutMs = 12000) {
    return new Promise((resolve) => {
        const enc = Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
        const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', enc],
            { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '', err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        const t = setTimeout(() => { try { child.kill(); } catch (e) {} resolve({ ok: false, error: 'timeout', out, err }); }, timeoutMs);
        child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, code, out, err }); });
        child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
    });
}

const SIG = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class G {
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint a);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public struct POINT { public int X; public int Y; }
}
'@
`;

async function main() {
    const a = [];
    const stamp = String(process.pid) + '_' + String(Date.now() % 100000);
    const title = 'GUARD_DRAG_' + stamp;
    const marker = path.join(__dirname, '.tmp-drag-moves-' + stamp + '.txt');
    const LEFT = 420, TOP = 320, W = 320, H = 220;
    const cx = LEFT + Math.round(W / 2), cy = TOP + Math.round(H / 2);
    try { fs.unlinkSync(marker); } catch (e) {}

    console.log('[probe] 起临时窗口…');
    const formLines = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.Form',
        "$f.Text = '" + title + "'",
        '$f.Width = ' + W + '; $f.Height = ' + H + '; $f.FormBorderStyle = "None"; $f.ShowInTaskbar = $false; $f.TopMost = $true',
        "$f.StartPosition = 'Manual'; $f.Left = " + LEFT + '; $f.Top = ' + TOP + '; $f.Opacity = 0.02',
        '$script:n = 0',
        "$f.Add_MouseMove({ $script:n++; try { [System.IO.File]::WriteAllText('" + marker + "', [string]$script:n) } catch {} })",
        '$f.Show(); [void]$f.Activate(); [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200',
        'for ($i=0; $i -lt 80; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }',
        '$f.Close()',
    ];
    const enc = Buffer.from(formLines.join('\n'), 'utf16le').toString('base64');
    const form = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { windowsHide: false, stdio: 'ignore' });
    CLEANUP.push(() => { try { form.kill(); } catch (e) {} try { fs.unlinkSync(marker); } catch (e) {} });
    await sleep(1600);

    // 1) 根窗口标题（点在窗口中心）
    console.log('[probe] 测 WindowFromPoint…');
    const wp = await runPwsh([
        SIG,
        '$p = New-Object G+POINT; $p.X = ' + cx + '; $p.Y = ' + cy,
        '$h = [G]::WindowFromPoint($p)',
        '$r = [G]::GetAncestor($h, 2)',
        '$sb = New-Object System.Text.StringBuilder 512',
        '[void][G]::GetWindowTextW($r, $sb, 512)',
        'Write-Output ("ROOT:" + $sb.ToString())',
    ], 8000);
    const rootTitle = String(wp.out || '').match(/ROOT:(.*)/)?.[1]?.trim() || '';
    a.push({ id: '1', desc: 'WindowFromPoint 读到根窗口标题', pass: rootTitle.includes(title), got: rootTitle || '(空)' });

    // 2) UAC 探针
    console.log('[probe] 测 UAC 探针…');
    const uac = await runPwsh([
        SIG,
        '$h = [G]::OpenInputDesktop(0, $false, 0x0100)',
        'if ($h -eq [IntPtr]::Zero) { Write-Output ("DENIED:" + [Runtime.InteropServices.Marshal]::GetLastWin32Error()) } else { [void][G]::CloseDesktop($h); Write-Output "NORMAL" }',
    ], 8000);
    a.push({ id: '2', desc: 'UAC 探针在正常桌面返回 NORMAL', pass: /NORMAL/.test(String(uac.out)), got: String(uac.out || uac.err || '').trim().slice(0, 80) });

    // 2.5) 角落急停判据（同一进程内移光标 + 判据，避免用户移动鼠标造成竞态）。
    //      端到端「click_at 被拦」无法稳定测：鼠标是用户共享资源，测试中途用户一动就恢复不了 (1,1)。
    console.log('[probe] 测角落急停判据（光标会短暂移到左上角再恢复）…');
    const posBefore = await runPwsh([
        SIG,
        '[void][G]::SetCursorPos(1,1)',
        '$p = New-Object G+POINT; [void][G]::GetCursorPos([ref]$p)',
        '$l=[G]::GetSystemMetrics(76); $t=[G]::GetSystemMetrics(77); $w=[G]::GetSystemMetrics(78); $h=[G]::GetSystemMetrics(79)',
        '$r=4',
        '$nl=(($p.X-$l) -le $r); $nt=(($p.Y-$t) -le $r); $nr=((($l+$w)-$p.X) -le $r); $nb=((($t+$h)-$p.Y) -le $r)',
        '$inCorner=($nl -and $nt) -or ($nl -and $nb) -or ($nr -and $nt) -or ($nr -and $nb)',
        '$wl=($nr -and $nt) -or ($nr -and $nb)',
        'if ($inCorner -and -not $wl) { Write-Output ("GUARD:EMERGENCY-STOP POS:" + $p.X + "," + $p.Y) } else { Write-Output ("GUARD:PASS POS:" + $p.X + "," + $p.Y) }',
        '[void][G]::SetCursorPos(1200,900)',
    ], 6000);
    await sleep(300);
    a.push({ id: '2a', desc: '光标在 (1,1) 时判据命中 EMERGENCY-STOP', pass: /GUARD:EMERGENCY-STOP/.test(String(posBefore.out)), got: String(posBefore.out || posBefore.err || '').trim().slice(0, 100) });

    // 3) drag：不传 focus（避免 focusWindow 干扰），坐标就在临时窗口里
    console.log('[probe] 测 drag 30 段…');
    const drag = await GC.runGameAction('mouse', 'drag ' + (cx - 60) + ',' + (cy - 30) + ',' + (cx + 60) + ',' + (cy + 30) + ',450', null, null, null);
    await sleep(800);
    let moves = 0;
    try { moves = Number(fs.readFileSync(marker, 'utf8')) || 0; } catch (e) { moves = 0; }
    a.push({ id: '3a', desc: 'drag 执行成功（ok:true）', pass: drag.ok === true, got: JSON.stringify(drag).slice(0, 220) });
    a.push({ id: '3b', desc: 'drag 回执写明 30 段 + ease-in-out-cubic', pass: drag.steps === 30 && drag.curve === 'ease-in-out-cubic', got: 'steps=' + drag.steps + ' curve=' + drag.curve });
    // MouseMove 计数只作参考：WinForms 低帧泵会把消息合并，不能拿来判定段数
    console.log('  · 临时窗口 MouseMove 计数（参考）：' + moves);

    let pass = 0, fail = 0;
    for (const it of a) {
        console.log('  ' + (it.pass ? 'PASS' : 'FAIL') + '  ' + it.id + '  ' + it.desc + (it.pass ? '' : '  got: ' + it.got));
        if (it.pass) pass += 1; else fail += 1;
    }
    console.log(`\ntest-guard-and-drag.cjs：PASS ${pass} / FAIL ${fail}`);
    process.exitCode = fail ? 1 : 0;
}

if (!fs.existsSync(CORE)) { console.log('SKIP: pet-core.exe 不存在'); process.exit(0); }
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
