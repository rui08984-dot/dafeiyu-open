# pet-input-test-window.ps1 —— 输入验收用的测试窗口（2026-11-09 三十五轮）
#
# 为什么不用记事本：Windows 11 的新记事本用 RichEditD2DPT 控件，
# 内容是 Direct2D 渲染的，`WM_GETTEXT` 读回来是空字符串（实测踩到）。
# 而 WinForms 的 TextBox 是标准 Win32 EDIT 类控件，`WM_GETTEXT` 能准确读回内容 ——
# 这正是「验证输入真的进去了」需要的硬证据。
#
# 用法：
#   pwsh -File pet-input-test-window.ps1
# 然后另一个进程 focus 它、发按键、用 pet-core edit_text 读回。
#
# 窗口标题固定 `PetInputTest`，方便脚本按标题找。

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'PetInputTest'
$form.Width = 640
$form.Height = 360
$form.StartPosition = 'CenterScreen'

# 多行 TextBox：能同时验「单行文字」和「换行」
$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true
$tb.AcceptsReturn = $true
$tb.ScrollBars = 'Vertical'
$tb.Dock = 'Fill'
$tb.Font = New-Object System.Drawing.Font('Consolas', 12)
$form.Controls.Add($tb)

# 挂上去后自动聚焦编辑框，省掉调用方一次点击
$form.Add_Shown({ $tb.Focus() })

[void]$form.ShowDialog()
