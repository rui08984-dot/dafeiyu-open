# uia-service.ps1 —— 常驻 UI Automation 服务（2026-11-09）
#
# 为什么需要：
#   实测拆解 snapshot/som_snapshot 的耗时（详见 docs/研究-GUI操控加速-2026-11-09.md）：
#     · pwsh 启动        294ms  ← 纯浪费，每次调用都要付
#     · 加载 UIAutomation  70ms  ← 同样每次都付
#     · 实际扫窗口         333ms  ← 真正有用的部分
#   合计 697ms，其中 364ms（52%）是「启动开销」。
#   做成常驻服务后，这 364ms 直接消失，只剩 333ms 的实际扫描。
#
# 设计：
#   · 常驻进程（pwsh -File uia-service.ps1 -Serve -Port 8106）
#   · HTTP 接口，只绑 127.0.0.1
#   · UIAutomationClient 在进程启动时加载一次，之后所有请求复用
#   · 支持：find（按标题找窗口）/ elements（扫可交互元素）/ click（Invoke 直调）/ focus
#
# 安全：只绑本机；只接受白名单动作；不执行任意脚本。

param(
    [switch]$Serve,
    [int]$Port = 8106,
    [string]$Action = '',
    [string]$Title = '',
    [string]$Rid = '',
    [int]$Max = 60
)

$ErrorActionPreference = 'SilentlyContinue'

# 2026-11-09：输出编码固定 UTF-8。原来没设时，含中文的错误信息（如「没找到窗口：xxx」）
# 经 pwsh 管道到 Node 会变乱码（实测 {"error":"没找到窗口：���Բ����ڵĴ���xyz"}）。
# 这是 AGENTS.md 里记的坑之一：pwsh 管道 GBK vs Node UTF-8。
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# ── 进程启动时一次性加载 UIA（这是常驻的核心收益）─────────────────────
# ── Win32 枚举（拿 hwnd 比 UIA 搜索快得多）─────────────────────────────
# C# 代码用数组拼（不用 here-string：here-string 在文件多次改写后缩进易变，
# 导致 Add-Type 静默失败——实测踩到「找不到类型 [WinEnum]」）
# C# 代码放在外置 .cs 文件里 —— 用 Add-Type -Path 加载。
# 为什么不用 here-string / 数组拼：PowerShell 里 "}" 会被当成 @{} 的闭合，
# 反复踩坑（实测：报「行68: ',' 后缺少表达式」，实际是字符串里的 } 干扰解析）。
$csPath = Join-Path $PSScriptRoot "WinEnum.cs"
$win32Ok = $false
try {
    Add-Type -Path $csPath -ReferencedAssemblies @("System.Core","System.Runtime","System.Collections","mscorlib") -ErrorAction Stop
    $win32Ok = $true
} catch {
    Write-Output ('[uia-service] WinEnum 编译失败: ' + $_.Exception.Message)
}
if (-not $win32Ok) { exit 1 }

# 2026-11-09 修：这里原来有一行 `Add-Type -TypeDefinition $win32Sig`，
# $win32Sig 从未定义过（C# 内联改外置 WinEnum.cs 时的残骸）。
# 它靠 $ErrorActionPreference='SilentlyContinue' 被静默吞掉——不报错、也没作用。
# 已删除。教训：SilentlyContinue 会掩盖这类残骸。

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$INTERACTIVE_TYPES = '|Button|MenuItem|Edit|CheckBox|RadioButton|ComboBox|ListItem|Hyperlink|TabItem|Slider|ToggleButton|SplitButton|TreeItem|DataItem|Text|Image|Custom|'
# Chromium 系窗口的 UIA 树在渲染进程里，跨进程遍历会挂住——排除
# 2026-11-09 修正：原来把 Chrome_WidgetWin_1 整个排除 —— 但这个 class 涵盖
# 所有 Electron/Chromium 应用（ZCode/QQ/微信都是），实测 ZCode 明明能扫到 30 个元素。
# 一刀切排除等于把 SoM 最该补的盲区全挡了。现在只排除真正会挂住的 UWP 外壳，
# 遍历安全靠 depth 上限(6) + maxN 上限，不靠 class 排除。
$EXCLUDE_CLASSES = 'ApplicationFrameWindow|Windows.UI.Core.CoreWindow'

function Write-Json($obj) {
    # 手工拼 JSON —— 彻底避开 ConvertTo-Json 对 ArrayList 的怪行为
    # （实测：hashtable 里放 ArrayList，ConvertTo-Json 输出 [{}, {...}]，elements 变 null）
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('{')
    $first = $true
    foreach ($k in $obj.Keys) {
        if (-not $first) { [void]$sb.Append(',') }
        $first = $false
        $v = $obj[$k]
        $jk = '"' + $k + '":'
        if ($null -eq $v) {
            [void]$sb.Append($jk + 'null')
        } elseif ($v -is [bool]) {
            [void]$sb.Append($jk + $(if ($v) { 'true' } else { 'false' }))
        } elseif ($v -is [int] -or $v -is [long] -or $v -is [double]) {
            [void]$sb.Append($jk + ([string]$v))
        } elseif ($v -is [string]) {
            [void]$sb.Append($jk + (ConvertTo-Json -InputObject $v -Compress))
        } elseif ($v -is [System.Collections.ArrayList]) {
            [void]$sb.Append($jk + '[')
            $f2 = $true
            foreach ($item in $v) {
                if (-not $f2) { [void]$sb.Append(',') }
                $f2 = $false
                [void]$sb.Append((Write-Json $item))
            }
            [void]$sb.Append(']')
        } elseif ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]) {
            [void]$sb.Append($jk + '[')
            $f2 = $true
            foreach ($item in $v) {
                if (-not $f2) { [void]$sb.Append(',') }
                $f2 = $false
                [void]$sb.Append((Write-Json $item))
            }
            [void]$sb.Append(']')
        } elseif ($v -is [hashtable]) {
            [void]$sb.Append($jk + (Write-Json $v))
        } else {
            [void]$sb.Append($jk + (ConvertTo-Json -InputObject $v -Compress -Depth 5))
        }
    }
    [void]$sb.Append('}')
    return $sb.ToString()
}

function Find-Window([string]$titleSub) {
    if (-not $titleSub) { return $null }
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    $lower = $titleSub.ToLower()
    foreach ($w in $children) {
        try {
            if ("$($w.Current.ClassName)" -match "^($EXCLUDE_CLASSES)$") { continue }
            $name = "$($w.Current.Name)"
            if ($name.ToLower().Contains($lower)) { return $w }
        } catch { }
    }
    return $null
}

# ── Chromium/Electron UIA 预热（2026-11-09 三十五轮，调研结论里「不做就会炸」那条）──
#
# 问题（实测复现）：同一个 Electron 应用，刚启动时 accessibility_tree 只有 7 个节点
# （Window → RootView → NonClientView → WinFrameView → ClientView，全是空壳）。
# 我们实测到 WorkBuddy scanned=2、返回 1 个 pane —— 就是这种空壳。
#
# 为什么：Chromium 只有在**有 UIA 客户端主动读了 page root 的属性**之后，
# 才会真正构建页面无障碍树。而 control view 会跳过那个空 root，
# 所以光走 FindAll(Descendants) 永远停在窗口框架层。
#
# 修法（照 Yu-tao-Li/dsh-computer-use-win 的 Test-ChromiumPage，issue #50 实测 7→100+）：
#   ① 找到窗口里的 Chrome_RenderWidgetHostHWND 子窗口（渲染进程宿主）
#   ② AutomationElement.FromHandle(那个 renderer)
#   ③ **主动读一次 .Current.ControlType** ← 这一步才是唤醒，缺了就白做
#   ④ 再取子节点，就有了
#
# 已知边界（报告明确写的，别浪费时间）：
#   · 真 Chrome（非 Electron）即使 attach 也报 0 子节点，需要 --force-renderer-accessibility
#   · 透明/点击穿透的 Electron 窗口（如桌宠覆盖层）不会桥接进父窗口树
function Initialize-ChromiumPage([long]$hwnd) {
    try {
        # ⚠ 关键：必须用 **Win32 EnumChildWindows** 找 renderer，不能用 UIA 找。
        #   空壳状态下 UIA 树里根本看不到 renderer（那正是「空」的含义）——
        #   实测：UIA FindAll(Descendants, ClassName='Chrome_RenderWidgetHostHWND')
        #   对 WorkBuddy 空壳返回 0。用 UIA 找 UIA 还没建的东西是逻辑死循环。
        #   WinEnum.ChromiumRenderers 走 EnumChildWindows，看的是真实窗口层级，与无障碍树无关。
        $renderers = [WinEnum]::ChromiumRenderers($hwnd, 8)
        if (-not $renderers -or $renderers.Count -eq 0) { return $false }
        $woke = $false
        for ($i = 0; $i -lt $renderers.Count; $i += 1) {
            try {
                $hRenderer = [IntPtr]([long]$renderers[$i].hwnd)
                $r = [System.Windows.Automation.AutomationElement]::FromHandle($hRenderer)
                if (-not $r) { continue }
                $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
                $pageRoot = $walker.GetFirstChild($r)
                if ($null -eq $pageRoot) { continue }
                # ⚠ 这一行是整段的关键：读一次属性，唤醒 Chromium 构建无障碍树。
                #   不读这一下，后面永远是空的（这是 issue #50 实测出来的机制）。
                $null = $pageRoot.Current.ControlType
                $null = $pageRoot.Current.Name
                if ($null -ne $walker.GetFirstChild($pageRoot)) { $woke = $true }
            } catch { }
        }
        return $woke
    } catch {
        return $false
    }
}

function Get-Elements([string]$titleSub, [int]$maxN, [long]$hwndArg = 0) {
    # v2（2026-11-09 调研实测）：v1 的三个硬伤
    #   ① 用 RootElement 搜索 -> Electron 内容在渲染进程，浅遍历看不到（ZCode 返回 0）
    #   ② 逐层 FindAll(Children) 递归 339-446ms
    #   ③ 逐元素 GetRuntimeId() 每元素一次跨进程调用 -> 7584ms
    # 修法：Win32 拿 hwnd -> FromHandle -> 一次 FindAll(Descendants) -> CacheRequest 含 RuntimeId
    # 2026-11-21 审计（P1）：调用方可以直接给 hwnd。同名双窗口（UWP 壳 CoreWindow +
    # ApplicationFrameWindow 真窗）时，按标题挑会挑中空壳；hwnd 是唯一无歧义的身份。
    $win = $null
    if ($hwndArg -gt 0) {
        $h = [IntPtr]$hwndArg
        $sb = New-Object System.Text.StringBuilder 512
        [void][WinEnum]::GetWindowTextW($h, $sb, 512)
        $r = New-Object WinEnum+RECT
        [void][WinEnum]::GetWindowRect($h, [ref]$r)
        $csb = New-Object System.Text.StringBuilder 256
        [void][WinEnum]::GetClassNameW($h, $csb, 256)
        $win = [pscustomobject]@{
            hwnd = $hwndArg; title = $sb.ToString(); cls = $csb.ToString()
            x = [int]$r.L; y = [int]$r.T; w = [int]($r.R - $r.L); h = [int]($r.B - $r.T)
            iconic = [bool][WinEnum]::IsIconic($h)
        }
        if (-not $win.title) { return @{ ok = $false; error = "hwnd $hwndArg 不是有效窗口（已关闭？）"; stale = $true; elements = @() } }
    } else {
        $wins = [WinEnum]::FindAll($titleSub)
        if (-not $wins -or $wins.Count -eq 0) {
            return @{ ok = $false; error = "没找到窗口：$titleSub"; elements = @() }
        }
        $win = [WinEnum]::PickBest($wins)
    }
    if ($win.iconic) {
        return @{ ok = $false; error = "「$($win.title)」最小化了（$($win.x),$($win.y)）——先 focus"; elements = @(); iconic = $true }
    }
    if ($win.x -lt -20000 -or $win.y -lt -20000) {
        return @{ ok = $false; error = "「$($win.title)」在屏外（$($win.x),$($win.y)）"; elements = @(); offscreen = $true }
    }
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$win.hwnd)
        if (-not $root) { return @{ ok = $false; error = 'FromHandle 返回空'; elements = @() } }
        $cache = New-Object System.Windows.Automation.CacheRequest
        $cache.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
        $cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::ProcessIdProperty)
        $cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::IsControlElementProperty, $true)
        $found = $null
        # ⚠ 2026-11-09 实测根因（这是 /elements 对正常窗口返回全 null 的真凶）：
        #   `$cache.Activate()` **会往输出流吐一个 CacheRequestActivation 对象**。
        #   于是 Get-Elements 的返回变成「对象 + 激活信号」的数组，Write-Json 拿到数组后
        #   用 $obj[$k] 索引 → 全是 null → 前端看到 {"ok":null,"elements":null,...}。
        #   最小化的窗口在 Activate 之前就 return 了，所以那条路径反而是正常的。
        #   修法：Activate 和 Pop 的返回值都必须用 [void] 吞掉。
        [void]$cache.Activate()
        try { $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) }
        finally { [void]$cache.Pop() }

        # ⚠ Chromium/Electron 空壳检测与预热（2026-11-09 三十五轮）
        #   实测：WorkBuddy（Electron）第一次扫只有 2 个节点，返回 1 个 pane —— 全是框架。
        #   判据：节点数很少（<10）且没扫到任何 button/edit 之类的真控件。
        #   动作：调 Initialize-ChromiumPage 唤醒，然后**重扫一次**。
        #   代价：只在空壳时付（正常窗口 0 开销）。
        $wokeChromium = $false
        if ($found -and $found.Count -lt 10) {
            $wokeChromium = Initialize-ChromiumPage ([long]$win.hwnd)
            if ($wokeChromium) {
                $cache2 = New-Object System.Windows.Automation.CacheRequest
                $cache2.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
                $cache2.Add([System.Windows.Automation.AutomationElement]::NameProperty)
                $cache2.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
                $cache2.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
                $cache2.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
                $cache2.Add([System.Windows.Automation.AutomationElement]::ProcessIdProperty)
                $cache2.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
                [void]$cache2.Activate()
                try { $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond) }
                finally { [void]$cache2.Pop() }
            }
        }

        $hits = New-Object System.Collections.ArrayList
        $scanned = 0
        if ($found) {
            $scanned = $found.Count
            foreach ($el in $found) {
                if ($hits.Count -ge $maxN) { break }
                try {
                    $name = $el.Cached.Name
                    if (-not $name) { continue }
                    if ($el.Cached.IsOffscreen) { continue }
                    $rect = $el.Cached.BoundingRectangle
                    if ($rect.Width -le 2 -or $rect.Height -le 2) { continue }
                    $ct = $el.Cached.ControlType.ProgrammaticName -replace 'ControlType\.', ''
                    # ⚠ 2026-11-09 修：CacheRequest **不能缓存 RuntimeId**
                    #   （实测 Cached.RuntimeId 返回 null；它能缓存 Name/ControlType/矩形/进程号，但
                    #    RuntimeId 属于「运行时标识」，UIA 缓存机制不支持）。
                    #   原实现写 $el.Cached.RuntimeId → rid 恒为空字符串 →
                    #   click_element / click_text 的 Invoke 直调路径**一直没工作过**，
                    #   全都在末尾静默退化成坐标点击（而坐标点击没做验证 = 假成功另一种形态）。
                    #   修法：只对**已通过筛选、即将入选**的元素调 GetRuntimeId()。
                    #   实测代价：入选 60 个元素取 RuntimeId 只花 8ms（未筛选的 799 个才 7.5 秒）。
                    $ridArr = $el.GetRuntimeId()
                    [void]$hits.Add(@{
                        type = $ct.ToLower(); name = "$name"
                        x = [int]$rect.X; y = [int]$rect.Y
                        w = [int]$rect.Width; h = [int]$rect.Height
                        cx = [int]($rect.X + $rect.Width / 2); cy = [int]($rect.Y + $rect.Height / 2)
                        rid = ($ridArr -join '-'); pid = [int]$el.Cached.ProcessId
                        enabled = [bool]$el.Cached.IsEnabled
                    })
                } catch { }
            }
        }
        # ⚠ 空壳判定（2026-11-09 三十五轮）：扫到节点极少（<3）且没有任何真控件，
        #   说明这个应用**没启用无障碍**（WorkBuddy 实测就是这种：Electron 但启动参数
        #   里没有 --force-renderer-accessibility，renderer 的 Name 是 "Chrome Legacy Window"）。
        #   这是我们救不了的（属于应用侧），所以必须**明确告诉调用方换路子**，
        #   而不是让它对着 1 个 pane 干瞪眼、以为「这窗口没东西」。
        $shellOnly = ($scanned -lt 3 -and $hits.Count -le 1)
        return @{
            ok = $true; title = $win.title; hwnd = $win.hwnd
            elements = @($hits); scanned = $scanned; chromiumWoke = $wokeChromium
            shellOnly = $shellOnly
            hint = $(if ($shellOnly) { '这个窗口的 UIA 树是空壳（应用没启用无障碍，如未加 --force-renderer-accessibility 的 Electron）。改用 som_snapshot 走画面，或 click_text 走 OCR' } else { '' })
        }
    } catch {
        return @{ ok = $false; error = "$($_.Exception.Message)"; elements = @() }
    }
}

function Invoke-Element([string]$titleSub, [string]$ridStr) {
    # ⚠ 2026-11-09 三十五轮重写。原实现有四个问题，全部实测踩到：
    #   ① 用 Find-Window（RootElement.FindAll(Children) 浅遍历）→ Electron/Chromium 的
    #      渲染内容在子进程里，浅遍历看不到（这就是 v1「ZCode 0 元素」那个坑；
    #      Get-Elements 修了但这里漏了）。改成 WinEnum.FindAll + FromHandle。
    #   ② 只搜 depth<6 —— ZCode 的树有 799 个节点，按钮在深处，6 层不够。
    #      改成 FindAll(Descendants) 一次拿全。
    #   ③ InvokePattern 不支持就 SetFocus 然后返回 ok:true —— **假成功**：
    #      SetFocus 只是把焦点移过去，根本没「点」下去。现在分开报告。
    #   ④ 不支持 Invoke 就没了，导致自绘控件永远点不到。

    $wins = [WinEnum]::FindAll($titleSub)
    if (-not $wins -or $wins.Count -eq 0) { return @{ ok = $false; error = "没找到窗口：$titleSub" } }
    $win = [WinEnum]::PickBest($wins)
    if ($win.iconic) { return @{ ok = $false; error = "「$($win.title)」最小化了——先聚焦"; iconic = $true } }

    $root = $null
    try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$win.hwnd) } catch { }
    if (-not $root) { return @{ ok = $false; error = 'FromHandle 返回空（窗口可能刚关闭）' } }

    $target = $null
    try {
        $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($el in $all) {
            try {
                $rid = [int[]]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
                if (($rid -join '-') -eq $ridStr) { $target = $el; break }
            } catch { }
        }
    } catch {
        return @{ ok = $false; error = "遍历元素树失败：$($_.Exception.Message)" }
    }
    if (-not $target) {
        return @{ ok = $false; error = '元素不存在（窗口内容变了，重新 snapshot 拿新编号）'; stale = $true }
    }

    # 先读元素信息（返回给调用方，让 AI 知道点的是什么）
    $ename = ''
    $ectype = ''
    $erect = $null
    try {
        $ename = "$($target.Current.Name)"
        $ectype = "$($target.Current.ControlType.ProgrammaticName)" -replace 'ControlType\.', ''
        $erect = $target.Current.BoundingRectangle
    } catch { }

    # ① InvokePattern（最理想：后台直调，不占鼠标不抢焦点）
    try {
        $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        return @{ ok = $true; how = 'invoke'; name = $ename; ctype = $ectype; detail = 'Invoke 直调成功（不动鼠标、不抢焦点）' }
    } catch { }

    # ② TogglePattern（复选框/开关类）
    try {
        $pattern = $target.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $pattern.Toggle()
        return @{ ok = $true; how = 'toggle'; name = $ename; ctype = $ectype; detail = 'Toggle 切换成功' }
    } catch { }

    # ③ SelectionItemPattern（列表项/标签页）
    try {
        $pattern = $target.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        $pattern.Select()
        return @{ ok = $true; how = 'select'; name = $ename; ctype = $ectype; detail = 'SelectionItem.Select 成功' }
    } catch { }

    # ④ ExpandCollapsePattern（树节点/下拉）
    try {
        $pattern = $target.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $pattern.Expand()
        return @{ ok = $true; how = 'expand'; name = $ename; ctype = $ectype; detail = 'Expand 展开成功' }
    } catch { }

    # ⑤ LegacyIAccessiblePattern.DoDefaultAction（老控件）
    try {
        $pattern = $target.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $pattern.DoDefaultAction()
        return @{ ok = $true; how = 'legacy'; name = $ename; ctype = $ectype; detail = 'LegacyIAccessible 默认动作成功' }
    } catch { }

    # ⑥ 都失败 → 报告「不支持」，并给出坐标让调用方走真实点击
    #   ⚠ 关键：这里绝不能返回 ok:true。SetFocus 只移焦点，不是点击。
    #   原实现返回 ok:true 是「假成功」——前端以为点到了，实际什么都没发生。
    $cx = 0; $cy = 0; $hasRect = $false
    if ($erect -and $erect.Width -gt 2 -and $erect.Height -gt 2) {
        $cx = [int]($erect.X + $erect.Width / 2)
        $cy = [int]($erect.Y + $erect.Height / 2)
        $hasRect = $true
    }
    return @{
        ok = $false
        how = 'none'
        name = $ename
        ctype = $ectype
        noPattern = $true
        hasRect = $hasRect
        x = $cx; y = $cy
        error = '这个元素不支持任何可直接调用的 UIA Pattern（自绘/纯展示控件）'
    }
}

# ── 元素可观察状态回读（2026-11-25 P0-3）────────────────────────────────
#
# 为什么需要：click_element 走 UIA Invoke 时**不需要前台/可见性**，所以「点完看屏幕像素」
# 验证的是另一块屏幕（遮挡/副屏/屏外时完全是别人的像素）。审计 P0-3 的修法是
# 「首选回读 UIA：比较 ToggleState / Value / IsEnabled / 焦点 / 选中项 / 名称」。
#
# 身份：优先 RuntimeId（同一棵树内唯一）；没有 rid 时按 Name（+ ControlType）找 ——
# som_annotate 的 marks 只带 name/type，没有 rid。
#
# 返回：{ok, found, name, ctype, enabled, offscreen, focused, toggleState, value,
#        selected, expandState, iconic, x, y, w, h, pid, error}
# 读不到的字段一律 $null（**不造假默认值**：造了会把「读不到」变成「没变化」）。
function Get-ElementState([long]$hwndArg, [string]$ridStr, [string]$titleSub, [string]$nameQuery, [string]$ctypeQuery) {
    $win = $null
    if ($hwndArg -gt 0) {
        $h = [IntPtr]$hwndArg
        $sb = New-Object System.Text.StringBuilder 512
        [void][WinEnum]::GetWindowTextW($h, $sb, 512)
        $r = New-Object WinEnum+RECT
        [void][WinEnum]::GetWindowRect($h, [ref]$r)
        if (-not $sb.ToString() -and (($r.R - $r.L) -le 0) -and (($r.B - $r.T) -le 0)) {
            return @{ ok = $false; found = $false; error = "hwnd $hwndArg 不是有效窗口（已关闭？）" }
        }
        $win = [pscustomobject]@{
            hwnd = $hwndArg; title = $sb.ToString()
            x = [int]$r.L; y = [int]$r.T; w = [int]($r.R - $r.L); h = [int]($r.B - $r.T)
            iconic = [bool][WinEnum]::IsIconic($h)
        }
    } else {
        if (-not $titleSub) { return @{ ok = $false; found = $false; error = '缺少 hwnd / title' } }
        $wins = [WinEnum]::FindAll($titleSub)
        if (-not $wins -or $wins.Count -eq 0) { return @{ ok = $false; found = $false; error = "没找到窗口：$titleSub" } }
        $win = [WinEnum]::PickBest($wins)
    }
    if ($win.iconic) {
        return @{ ok = $false; found = $true; iconic = $true; error = "「$($win.title)」最小化了——先聚焦" }
    }
    try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$win.hwnd)
        if (-not $root) { return @{ ok = $false; found = $false; error = 'FromHandle 返回空（窗口可能刚关闭）'; iconic = $false } }
        $target = $null
        # ① RuntimeId（同树唯一）
        if ($ridStr) {
            $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($el in $all) {
                try {
                    $rid = [int[]]$el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::RuntimeIdProperty)
                    if (($rid -join '-') -eq $ridStr) { $target = $el; break }
                } catch { }
            }
        }
        # ② Name（+ ControlType）：som_annotate 的 marks 没有 rid
        if (-not $target -and $nameQuery) {
            $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::NameProperty, $nameQuery)
            $hit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
            if ($hit) { $target = $hit }
            if (-not $target -and $nameQuery.Length -ge 16) {
                # som_annotate 把名称截到 60 字；拼接/后缀场景用前缀兜底（只在长串时，降低误配）
                $all2 = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                    [System.Windows.Automation.Condition]::TrueCondition)
                foreach ($el in $all2) {
                    try {
                        $n = "$($el.Current.Name)"
                        if ($n -and $n.StartsWith($nameQuery)) { $target = $el; break }
                    } catch { }
                }
            }
        }
        if (-not $target) {
            return @{
                ok = $false; found = $false; iconic = $false
                error = '元素不存在（窗口内容变了，重新 snapshot 拿新编号）'; stale = $true
            }
        }
        if ($ctypeQuery) {
            $ct0 = "$($target.Current.ControlType.ProgrammaticName)" -replace 'ControlType\.', ''
            if ($ct0.ToLower() -ne $ctypeQuery.ToLower()) {
                # 类型对不上 = 同名但不同控件；宁可不判，也别把别的控件状态当证据
                return @{ ok = $false; found = $false; error = "同名元素类型不符（期望 $ctypeQuery，实际 $ct0）"; stale = $true }
            }
        }
        $res = @{
            ok = $true; found = $true; iconic = $false
            name = "$($target.Current.Name)"
            ctype = ("$($target.Current.ControlType.ProgrammaticName)" -replace 'ControlType\.', '').ToLower()
            enabled = ($target.Current.IsEnabled -eq $true)
            offscreen = ($target.Current.IsOffscreen -eq $true)
            focused = ($target.Current.HasKeyboardFocus -eq $true)
            toggleState = $null; value = $null; selected = $null; expandState = $null
            pid = [int]$target.Current.ProcessId
            x = 0; y = 0; w = 0; h = 0
        }
        try {
            $rc = $target.Current.BoundingRectangle
            $res.x = [int]$rc.X; $res.y = [int]$rc.Y; $res.w = [int]$rc.Width; $res.h = [int]$rc.Height
        } catch { }
        try {
            $p = $null
            if ($target.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
                $res.toggleState = "$($p.Current.ToggleState)"
            }
        } catch { }
        try {
            $p = $null
            if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
                $v = "$($p.Current.Value)"
                if ($v.Length -gt 200) { $v = $v.Substring(0, 200) }
                $res.value = $v
            }
        } catch { }
        try {
            $p = $null
            if ($target.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
                $res.selected = ($p.Current.IsSelected -eq $true)
            }
        } catch { }
        try {
            $p = $null
            if ($target.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
                $res.expandState = "$($p.Current.ExpandCollapseState)"
            }
        } catch { }
        return $res
    } catch {
        return @{ ok = $false; found = $false; error = "$($_.Exception.Message)" }
    }
}

# ── 一次性模式 ─────────────────────────────────────────────────────
if (-not $Serve) {
    switch ($Action) {
        'elements' { Write-Json (Get-Elements $Title $Max) }
        'click' { Write-Json (Invoke-Element $Title $Rid) }
        'element_state' { Write-Json (Get-ElementState 0 $Rid $Title '' '') }
        'list' {
            $root = [System.Windows.Automation.AutomationElement]::RootElement
            $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
            $out = @()
            foreach ($w in $children) {
                try {
                    $n = "$($w.Current.Name)"
                    if ($n) { $out += @{ name = $n; cls = "$($w.Current.ClassName)"; pid = [int]$w.Current.ProcessId } }
                } catch { }
            }
            Write-Json @{ ok = $true; windows = $out }
        }
        default { Write-Json @{ ok = $false; error = "未知 action: $Action" } }
    }
    exit 0
}

# ── 常驻 HTTP 服务（TcpListener 版，2026-11-09 三十五轮换成这个）───────────
#
# ⚠ 之前用的是 HttpListener，有两个真实后果（都实测踩到）：
#   ① 端口 owning process 是 PID 4 (System)，因为 HttpListener 注册到内核 http.sys。
#      于是 kill-all-pet.ps1 按端口找进程只能找到 PID 4 → 杀不掉 → 服务假活、
#      端口残留、新服务起不来。用户「重启后行为没变」的根因之一。
#   ② 进程死了 http.sys 的 URL 注册还挂着，端口不立刻释放。
# 换成 TcpListener：端口直接归本进程，kill 得掉、退出即释放。
. (Join-Path $PSScriptRoot 'SimpleHttp.ps1')

$srv = $null
try {
    $srv = New-SimpleHttp -Port $Port
} catch {
    Write-Output ('{"ok":false,"error":"listen failed: ' + $_.Exception.Message + '"}')
    exit 1
}
Write-Output "[uia-service] listening 127.0.0.1:$Port (UI Automation 已加载, TcpListener)"

while ($true) {
    $ctx = Receive-SimpleRequest -Server $srv
    if (-not $ctx) { continue }   # 这条连接坏了，继续等下一条
    # 2026-11-21 红队审计 P1：浏览器请求一定带 Origin（fetch/表单）或 Sec-Fetch-Site
    # （所有子资源，含 <img>）。本服务只服务本机 Node（game-control），两者都不带 ——
    # 见到任一即拒绝，封死「网页跨站表单 POST /focus、/elements」这类 CSRF。
    if ($ctx.Headers['origin'] -or $ctx.Headers['sec-fetch-site']) {
        Send-SimpleResponse -Context $ctx -Body '{"ok":false,"error":"browser_forbidden"}' -StatusCode 403
        continue
    }
    $out = '{"ok":false,"error":"not found"}'
    try {
        $p = @{}
        if ($ctx.Body) {
            try {
                $obj = $ctx.Body | ConvertFrom-Json
                foreach ($k in $obj.PSObject.Properties.Name) { $p[$k] = $obj.$k }
            } catch {
                # body 不是合法 JSON：不是致命错误（有些 GET 没 body），继续用空参数
            }
        }
        $path = $ctx.Path
        if ($path -eq '/health') {
            $out = '{"ok":true,"service":"uia","uiaLoaded":true,"transport":"tcp"}'
        } elseif ($path -eq '/elements') {
            $out = Write-Json (Get-Elements ([string]$p.title) ([int]($p.max + 0)) ([long]($p.hwnd + 0)))
        } elseif ($path -eq '/click') {
            $out = Write-Json (Invoke-Element ([string]$p.title) ([string]$p.rid))
        } elseif ($path -eq '/element_state') {
            # 元素可观察状态（2026-11-25 P0-3）：点击验证的「首选通道」。
            # rid 优先；som_click 只有 name/type（marks 无 rid）→ 按 Name 找。
            $out = Write-Json (Get-ElementState ([long]($p.hwnd + 0)) ([string]$p.rid) ([string]$p.title) ([string]$p.name) ([string]$p.ctype))
        } elseif ($path -eq '/focus') {
            # 2026-11-09 三十五轮新增：把聚焦做成毫秒级常驻操作。
            # 原来 game-control 的 focusWindow() 每次 spawn pwsh（300ms+ 启动开销），
            # 而这里本来就是常驻进程、WinEnum 也已经在内存里。
            # 返回真实复核结果（不是「调用成功」）：ok 只有焦点真的在目标上才为 true。
            $fr = [WinEnum]::Focus([string]$p.title)
            $out = Write-Json @{
                ok = [bool]$fr.ok
                hwnd = [long]$fr.hwnd
                title = $fr.title
                wasIconic = [bool]$fr.wasIconic
                fgTitle = $fr.fgTitle
                fgHwnd = [long]$fr.fgHwnd
            }
            if ($fr.error) { $out = Write-Json @{ ok = $false; error = [string]$fr.error } }
        } elseif ($path -eq '/fg') {
            # 当前前台窗口（给 assertTargetFocused 用，替代每次 spawn pwsh 查前台）
            $fr = [WinEnum]::Foreground()
            $out = Write-Json @{ ok = [bool]$fr.ok; title = $fr.title; hwnd = [long]$fr.hwnd }
        } elseif ($path -eq '/rect') {
            # 窗口真实矩形（给 windowRealRect 用：判断最小化/屏外/撞名）
            # 为什么要走服务：原实现 spawn pwsh 用 EnumWindows + 标题 Contains，
            # 实测「ZCode」会命中不可见的 `Zcode Ghost Cursor` overlay 窗口 →
            # 误报「ZCode 当前不可见」。WinEnum.FindAll 有 IsWindowVisible 过滤，
            # 且优先挑非最小化的那个，不会撞错。
            $ts = [string]$p.title
            $wins = [WinEnum]::FindAll($ts)
            if (-not $wins -or $wins.Count -eq 0) {
                $out = Write-Json @{ ok = $false; notFound = $true; error = "没找到窗口：$ts" }
            } else {
                $pick = [WinEnum]::PickBest($wins)
                $out = Write-Json @{
                    ok = $true
                    title = [string]$pick.title
                    hwnd = [long]$pick.hwnd
                    x = [int]$pick.x; y = [int]$pick.y
                    w = [int]$pick.w; h = [int]$pick.h
                    visible = $true
                    iconic = [bool]$pick.iconic
                    matched = [int]$wins.Count
                }
            }
        } elseif ($path -eq '/list') {
            $root = [System.Windows.Automation.AutomationElement]::RootElement
            $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
            $arr = @()
            foreach ($w in $children) {
                try {
                    $n = "$($w.Current.Name)"
                    if ($n) { $arr += @{ name = $n; cls = "$($w.Current.ClassName)"; pid = [int]$w.Current.ProcessId } }
                } catch { }
            }
            $out = Write-Json @{ ok = $true; windows = $arr }
        }
    } catch {
        # 2026-11-10 红队实测同款：`-replace '\'` 是非法正则，改用字面量 .Replace()
        $msg = $_.Exception.Message.Replace('\', '\\').Replace('"', '\"')
        $out = '{"ok":false,"error":"' + $msg + '"}'
    }
    Send-SimpleResponse -Context $ctx -Body $out
}
