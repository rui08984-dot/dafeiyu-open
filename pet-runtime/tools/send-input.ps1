# send-input.ps1 —— 常驻按键助手（2026-11-09 三十轮）
#
# 为什么需要它：
#   · 现有 game-control.js 每次按键都 spawn 一个 pwsh（200-400ms 开销），
#     陪玩连招根本跟不上（一秒要按好几次）。
#   · 旧实现用 keybd_event —— 它已被微软标记为「替代 SendInput」，
#     且部分游戏/反作弊对它的注入标记处理更严。
#   · 调研结论（docs/研究-游戏陪玩技术方案-2026-11-09.md）：
#     Raw Input / DirectInput 游戏只认 SendInput 这条系统输入流；
#     PostMessage 无效（DirectInput8 另起线程读 WM_INPUT，RIDEV_NOLEGACY 下不生成 WM_KEYDOWN）。
#
# 用法：
#   常驻：powershell -File send-input.ps1 -Serve -Port 8104
#   然后 POST http://127.0.0.1:8104/key ，body 传 keys 字段（例如 ctrl+s，或 w 加 hold 秒数）
#   或直接一次性：powershell -File send-input.ps1 -Keys w -Hold 0
#
# 安全：只监听 127.0.0.1；不接受任意脚本，只接受「键名组合」白名单解析结果。

param(
    [switch]$Serve,
    [string]$Keys = '',
    [double]$Hold = 0,
    [int]$Port = 8104,
    # 只打印从 key-policy.json 加载到的策略表（测试用；不注入任何按键）
    [switch]$PrintPolicy,
    # 只解析按键组合并输出 VK 列表（测试用；不注入任何按键）
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# ── 按键策略：唯一策略源（2026-11-21 审计 P2）────────────────────────────
# 病根：这份组合表原来内联在 Resolve-Spec 里，与 game-control.js / Rust 各一份，
#   三份各挡各的（JS 挡 3 类、Rust 全放、这里挡 6 类）。
# 修法：从 pet-runtime/tools/key-policy.json 读取；JS 读同一份，Rust 仍内联，
#   由 _probe/test-control-consistency.cjs 做 JSON/JS/Rust/PS 四份集合相等比较。
# 失败策略：文件缺失/损坏时**拒绝启动**（没有策略就不注入，fail-closed）。
$PolicyFile = Join-Path $PSScriptRoot 'key-policy.json'
if (-not (Test-Path -LiteralPath $PolicyFile)) {
    throw "key policy file missing: $PolicyFile"
}
try {
    $Policy = Get-Content -LiteralPath $PolicyFile -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw "key policy file invalid: $PolicyFile — $($_.Exception.Message)"
}
if (-not $Policy -or -not $Policy.rules -or @($Policy.rules).Count -eq 0) {
    throw "key policy file has no rules: $PolicyFile"
}
$KeyAlias = @{}
if ($Policy.aliases) {
    foreach ($pp in $Policy.aliases.PSObject.Properties) {
        $KeyAlias[$pp.Name.ToLower()] = [string]$pp.Value
    }
}
function Convert-KeyName([string]$k) {
    $s = $k.Trim().ToLower()
    if ($KeyAlias.ContainsKey($s)) { return [string]$KeyAlias[$s] }
    return $s
}

if ($PrintPolicy) {
    $rulesOut = @()
    foreach ($rule in @($Policy.rules)) {
        $rulesOut += [pscustomobject]@{ require = @($rule.require); any = @($rule.any) }
    }
    Write-Output (($rulesOut | ConvertTo-Json -Depth 5 -Compress))
    exit 0
}

# ── SendInput P/Invoke（含扫描码，游戏才认）────────────────────────────
$sig = @'
using System;
using System.Runtime.InteropServices;

public class PetSendInput {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public InputUnion u;
    }
    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData;
        public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT {
        public uint uMsg; public ushort wParamL; public ushort wParamH;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll")]
    public static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_SCANCODE = 0x0008;
    const uint KEYEVENTF_EXTENDEDKEY = 0x0001;

    static bool IsExtended(ushort vk) {
        // 方向键/Ins/Del/Home/End/PgUp/PgDn/右 Ctrl/右 Alt/NumLock 等
        return vk >= 0x21 && vk <= 0x2E || vk == 0x90 || vk == 0xA3 || vk == 0xA5
            || vk == 0x5B || vk == 0x5C || vk == 0x5D;
    }

    static INPUT Key(ushort vk, bool up) {
        var m = MapVirtualKey(vk, 0);
        var i = new INPUT();
        i.type = INPUT_KEYBOARD;
        i.u.ki.wVk = 0;
        i.u.ki.wScan = (ushort)m;
        uint f = KEYEVENTF_SCANCODE;
        if (up) f |= KEYEVENTF_KEYUP;
        if (IsExtended(vk)) f |= KEYEVENTF_EXTENDEDKEY;
        i.u.ki.dwFlags = f;
        i.u.ki.time = 0;
        i.u.ki.dwExtraInfo = IntPtr.Zero;
        return i;
    }

    public static bool KeyDown(ushort vk) {
        var arr = new INPUT[] { Key(vk, false) };
        return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 1;
    }
    public static bool KeyUp(ushort vk) {
        var arr = new INPUT[] { Key(vk, true) };
        return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT))) == 1;
    }
    public static int Tap(ushort vk, int holdMs) {
        if (!KeyDown(vk)) return 0;
        if (holdMs > 0) System.Threading.Thread.Sleep(holdMs);
        if (!KeyUp(vk)) return 1;
        return 2;
    }
    public static bool Click(int x, int y) {
        if (!SetCursorPos(x, y)) return false;
        System.Threading.Thread.Sleep(40);
        mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(20);
        mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
        return true;
    }
}
'@
Add-Type -TypeDefinition $sig

# ── 键名 → VK 码（白名单，不接受任意代码）──────────────────────────────
$VK = @{
    'a'=0x41;'b'=0x42;'c'=0x43;'d'=0x44;'e'=0x45;'f'=0x46;'g'=0x47;'h'=0x48;
    'i'=0x49;'j'=0x4A;'k'=0x4B;'l'=0x4C;'m'=0x4D;'n'=0x4E;'o'=0x4F;'p'=0x50;
    'q'=0x51;'r'=0x52;'s'=0x53;'t'=0x54;'u'=0x55;'v'=0x56;'w'=0x57;'x'=0x58;
    'y'=0x59;'z'=0x5A;
    '0'=0x30;'1'=0x31;'2'=0x32;'3'=0x33;'4'=0x34;'5'=0x35;'6'=0x36;'7'=0x37;'8'=0x38;'9'=0x39;
    'space'=0x20;'enter'=0x0D;'esc'=0x1B;'escape'=0x1B;'tab'=0x09;'backspace'=0x08;
    'shift'=0x10;'ctrl'=0x11;'control'=0x11;'alt'=0x12;'win'=0x5B;
    'up'=0x26;'down'=0x28;'left'=0x25;'right'=0x27;
    'insert'=0x2D;'delete'=0x2E;'del'=0x2E;'home'=0x24;'end'=0x23;'pageup'=0x21;'pagedown'=0x22;
    'f1'=0x70;'f2'=0x71;'f3'=0x72;'f4'=0x73;'f5'=0x74;'f6'=0x75;
    'f7'=0x76;'f8'=0x77;'f9'=0x78;'f10'=0x79;'f11'=0x7A;'f12'=0x7B;
    'capslock'=0x14;'numlock'=0x90;'scrolllock'=0x91;
    '`'=0xC0;'-'=0xBD;'='=0xBB;'['=0xDB;']'=0xDD;';'=0xBA;','=0xBC;'.'=0xBE;'/'=0xBF;
}

function Resolve-Spec([string]$spec) {
    # 例：ctrl+shift+t 解析为三个 VK 码依次按下
    #
    # ⚠ 2026-11-10 红队 S9（执行层可绕过）：黑名单原来只在 game-control.js（上层 JS）。
    #   本服务监听 127.0.0.1:8104，**本机任何进程**（她的脚本 / 浏览器扩展 / 别的 MCP）
    #   直接 POST /key {"keys":"alt+f4"} 就能关窗口，{"keys":"win+r"} 就能起任意程序。
    #   语义层挡不住执行层 —— 这里按归一化后的按键集合判（顺序/空白/大小写/别名都归一）。
    # 2026-11-21：判定不再内联，改成通用循环读 $Policy.rules（唯一源 key-policy.json，
    #   与 JS 同源；Rust 仍内联，由门禁测试做集合比较）。
    $p = @()
    foreach ($part0 in ($spec -split '\+')) {
        $k0 = Convert-KeyName $part0
        if ($k0 -ne '') { $p += $k0 }
    }
    if ($p.Count -eq 0) { throw 'empty key spec' }

    foreach ($rule in @($Policy.rules)) {
        $need = @($rule.require)
        $miss = $false
        foreach ($rk in $need) {
            if (-not ($p -contains [string]$rk)) { $miss = $true; break }
        }
        if ($miss) { continue }
        $any = @($rule.any)
        if ($any.Count -eq 0) { throw "blocked combo: $spec" }
        foreach ($ak in $any) {
            if ($p -contains [string]$ak) { throw "blocked combo: $spec" }
        }
    }

    $out = @()
    foreach ($k in $p) {
        if ($VK.ContainsKey($k)) { $out += $VK[$k] }
        else { throw "unknown key: $k" }
    }
    return $out
}

function Invoke-Combo([string]$spec, [int]$holdMs) {
    $vks = Resolve-Spec $spec
    if ($vks.Count -eq 0) { throw 'empty key spec' }
    # 依次按下 → 逆序松开（标准组合键顺序）
    foreach ($vk in $vks) { if (-not [PetSendInput]::KeyDown([uint16]$vk)) { throw "keydown failed: $vk" } }
    if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs }
    for ($i = $vks.Count - 1; $i -ge 0; $i--) { [void][PetSendInput]::KeyUp([uint16]$vks[$i]) }
    return 'ok'
}

# ── 一次性模式 ────────────────────────────────────────────────────────
if (-not $Serve) {
    # 测试用：只解析策略/VK，不注入任何按键（-DryRun）
    if ($DryRun) {
        if (-not $Keys) { Write-Output '{"ok":false,"error":"no keys"}'; exit 1 }
        try {
            $vks = @(Resolve-Spec $Keys)
            $list = ($vks | ForEach-Object { [string]$_ }) -join ','
            Write-Output ('{"ok":true,"dry_run":true,"vks":[' + $list + ']}')
        } catch {
            $msg = $_.Exception.Message.Replace('\', '\\').Replace('"', '\"')
            Write-Output ('{"ok":false,"error":"' + $msg + '"}')
        }
        exit 0
    }
    if (-not $Keys) { Write-Output '{"ok":false,"error":"no keys"}'; exit 1 }
    try {
        $r = Invoke-Combo $Keys ([int]$Hold * 1000)
        Write-Output ('{"ok":true,"result":"' + $r + '"}')
    } catch {
        Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\"') + '"}')
    }
    exit 0
}

# ── 常驻 HTTP 服务模式（TcpListener 版，2026-11-09 三十五轮换成这个）──────────
#
# ⚠ 原来是 HttpListener：端口注册到内核 http.sys → owning process 变成 PID 4 (System)
#   → kill-all-pet.ps1 按端口杀不掉 → 服务假活、端口残留。
#   换成 TcpListener：端口直接归本进程，kill 得掉、退出即释放。
. (Join-Path $PSScriptRoot 'SimpleHttp.ps1')

$srv = $null
try {
    $srv = New-SimpleHttp -Port $Port
} catch {
    Write-Output ('{"ok":false,"error":"listen failed: ' + $_.Exception.Message + '"}')
    exit 1
}
Write-Output "[send-input] listening 127.0.0.1:$Port (TcpListener)"

while ($true) {
    $ctx = Receive-SimpleRequest -Server $srv
    if (-not $ctx) { continue }
    # 2026-11-21 红队审计 P1：浏览器发起的请求一定带 Origin（fetch/表单 POST）或
    # Sec-Fetch-Site（所有子资源，含 <img>）。本服务只服务本机 Node（game-control），
    # 两者都不带 —— 见到任一即拒绝，封死「网页 CSRF 直接往当前窗口打字/按键」。
    if ($ctx.Headers['origin'] -or $ctx.Headers['sec-fetch-site']) {
        Send-SimpleResponse -Context $ctx -Body '{"ok":false,"error":"browser_forbidden"}' -StatusCode 403
        continue
    }
    $reply = '{"ok":false,"error":"unknown"}'
    $status = 200
    try {
        $obj = $null
        if ($ctx.Body) {
            try { $obj = $ctx.Body | ConvertFrom-Json } catch { $obj = $null }
        }
        if (-not $obj) { $obj = [pscustomobject]@{} }
        $path = $ctx.Path

        if ($path -eq '/health') {
            $reply = '{"ok":true,"service":"send-input","transport":"tcp"}'
        } elseif ($path -eq '/key') {
            $holdMs = 0
            if ($obj.PSObject.Properties.Name -contains 'hold' -and $obj.hold) { $holdMs = [int]([double]$obj.hold * 1000) }
            $r = Invoke-Combo ([string]$obj.keys) $holdMs
            $reply = '{"ok":true,"result":"' + $r + '"}'
        } elseif ($path -eq '/click') {
            $ok = [PetSendInput]::Click([int]$obj.x, [int]$obj.y)
            $reply = if ($ok) { '{"ok":true}' } else { '{"ok":false,"error":"click failed"}' }
        } elseif ($path -eq '/text') {
            # 文字输入：SendInput 的 KEYEVENTF_UNICODE 逐字符发送。
            # 为什么不用 SendKeys：它对中文/特殊字符支持差，且依赖键盘布局。
            # KEYEVENTF_UNICODE（0x0004）能直接发 Unicode 码点——任何应用（含中文输入框）都认。
            $text = [string]$obj.text
            if (-not $text) { $reply = '{"ok":false,"error":"empty"}'; }
            else {
                $n = 0
                foreach ($ch in $text.ToCharArray()) {
                    $code = [uint16][char]$ch
                    $down = New-Object PetSendInput+INPUT
                    $down.type = 1
                    $down.u.ki.wVk = 0
                    $down.u.ki.wScan = $code
                    $down.u.ki.dwFlags = 0x0004   # KEYEVENTF_UNICODE
                    $down.u.ki.time = 0
                    $down.u.ki.dwExtraInfo = [IntPtr]::Zero
                    $up = New-Object PetSendInput+INPUT
                    $up.type = 1
                    $up.u.ki.wVk = 0
                    $up.u.ki.wScan = $code
                    $up.u.ki.dwFlags = 0x0004 -bor 0x0002   # UNICODE | KEYUP
                    $up.u.ki.time = 0
                    $up.u.ki.dwExtraInfo = [IntPtr]::Zero
                    $arr = @($down, $up)
                    [void][PetSendInput]::SendInput(2, $arr, [System.Runtime.InteropServices.Marshal]::SizeOf([type][PetSendInput+INPUT]))
                    Start-Sleep -Milliseconds 8   # 字符间隔，太快会丢字
                    $n++
                }
                $reply = '{"ok":true,"count":' + $n + '}'
            }
        } else {
            $reply = '{"ok":false,"error":"not found"}'
            $status = 404
        }
    } catch {
        # ⚠ 2026-11-10 红队实测：`-replace '\'` 是**非法正则**（.NET 解析失败 → catch 块里再抛
        #   → 配合 $ErrorActionPreference='Stop' 整个服务退出）。一个畸形请求就能打死键盘助手。
        #   .Replace() 是字面量替换，不解析正则。
        $msg = $_.Exception.Message.Replace('\', '\\').Replace('"', '\"')
        $reply = '{"ok":false,"error":"' + $msg + '"}'
    }
    Send-SimpleResponse -Context $ctx -Body $reply -StatusCode $status
}
