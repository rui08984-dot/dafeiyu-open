#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
som_annotate.py — Set-of-Mark 元素标注（2026-11-09 C档）

用途：把 UIA 扫到的可交互元素画框+编号到截图上传给视觉模型，
      让模型「按编号选」而不是「猜像素坐标」——等效专用 grounding 模型的精度，
      但零 GPU、零新模型（复用现有云端视觉能力）。

为什么需要：
  · 现有操控（UIA 控件树）读不到游戏/自绘界面/Canvas 里的按钮
  · 视觉模型直接报坐标不稳（研究结论：8B VLM 逐像素报坐标不可靠）
  · SoM 折中：坐标由系统 API 给（准），语义由视觉模型给（懂画面）

用法：
  python som_annotate.py --window "记事本" [--max 40] [--out out.jpg]
  python som_annotate.py --fullscreen [--max 40]

输出 JSON（UTF-8）：
  {"ok":true,"image":"<base64 jpeg>","marks":[{"id":1,"type":"button","name":"保存","x":123,"y":456}],"count":12}
  失败：{"ok":false,"error":"..."}

依赖：PIL（本机已有）、PrintWindow（同 ocr_find.py 的手法）
"""
import argparse
import base64
import ctypes
import io
import json
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print(json.dumps({"ok": False, "error": "PIL 未安装"}, ensure_ascii=False))
    sys.exit(1)

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

# ⚠ DPI 一致性（2026-11-09 实测关键 bug）：UIA 报的是**物理像素**（如 1836,1432），
# 而非 DPI-aware 进程里 GetWindowRect 报的是**逻辑像素**（1578×969）——
# 两者混用会让大部分标注框画到窗口外面（实测 ZCode 窗口 10 个元素只画出 3 个）。
# 必须在任何窗口/GDI 调用之前声明 DPI 感知，之后所有坐标统一为物理像素。
try:
    # 2 = PROCESS_PER_MONITOR_DPI_AWARE（Win8.1+）
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        user32.SetProcessDPIAware()          # Vista+ 兜底
    except Exception:
        pass


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
        ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
        ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
        ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
        ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
        ("biClrImportant", ctypes.c_uint32),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", ctypes.c_uint32 * 3)]


GWL_EXSTYLE = -20
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_LAYERED = 0x00080000

# 已知的 overlay / 幽灵窗口类名（它们全屏透明、点击穿透，截图出来是黑的）
_OVERLAY_CLASS_RE = __import__('re').compile(
    r'(Overlay|GhostCursor|Ghost\s*Cursor|TaskListThumbnail|Shell_TrayWnd$|Progman$|WorkerW$)', __import__('re').I)


def find_window(title_sub):
    """按标题子串找**真实**可见窗口，返回 (hwnd, title)。

    ⚠ 2026-11-14 实测 bug 修复：原来只取第一个命中，结果 `--window ZCode`
    命中了 ZCode 的 **Ghost Cursor overlay**（class=`ZcodeGhostCursorOverlay`，
    WS_EX_TRANSPARENT 全屏透明窗）→ 截图全黑、标注 0 个元素。
    现在三级优先（精确 > 前缀 > 包含）+ 跳过点击穿透的 overlay。
    """
    sub = title_sub.strip().lower()
    exact, prefix, contains = [], [], []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        title = buf.value
        low = title.lower()
        if sub not in low:
            return True
        # ① 点击穿透的窗口不是真窗口（overlay/指示器），跳过
        try:
            ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            if ex & WS_EX_TRANSPARENT:
                return True
        except Exception:
            pass
        # ② 已知 overlay 类名，跳过
        try:
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            if _OVERLAY_CLASS_RE.search(cls.value or ''):
                return True
        except Exception:
            pass
        if low == sub:
            exact.append((hwnd, title))
        elif low.startswith(sub):
            prefix.append((hwnd, title))
        else:
            contains.append((hwnd, title))
        return True

    user32.EnumWindows(cb, 0)
    for bucket in (exact, prefix, contains):
        if bucket:
            return bucket[0]
    return (None, None)


def _find_pet_core():
    """沿目录树向上找 pet-core 可执行文件（不数层级 —— 数层级踩过两次坑）。"""
    import os
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(10):
        for sub in (('pet-core', 'target', 'release', 'pet-core.exe'),
                    ('pet-core', 'target', 'release', 'pet-core')):
            cand = os.path.join(d, *sub)
            if os.path.exists(cand):
                return cand
        up = os.path.dirname(d)
        if up == d:
            break
        d = up
    return ''


def capture_window_wgc(hwnd):
    """用 pet-core 的 WGC（CreateForWindow）抓窗口。

    为什么优先于 PrintWindow（2026-11-14 调研结论 + 实测）：
      · PrintWindow(PW_RENDERFULLCONTENT) 对 **GPU 合成内容**（Electron/Chromium/
        DirectX）经常返回全黑，对透明/layered 窗口更是黑底；
      · WGC 读的是 DWM 合成表面：**被遮挡也能抓**、透明/圆角保留、DPI 用物理像素
        （item.Size()）；
      · 而且**只含目标窗口** —— 别的进程的 overlay（ZCode 的 Ghost Cursor、
        我们自己的操控指示层）天然不会进画面，不需要 WDA 那种全局副作用。

    返回 (img, left, top, w, h, err)。
    """
    import json as _json
    import os
    import subprocess
    import tempfile
    bin_path = _find_pet_core()
    if not bin_path:
        return None, 0, 0, 0, 0, 'pet-core 不存在'
    out_bmp = os.path.join(tempfile.gettempdir(), 'som-wgc-%d.bmp' % hwnd)
    try:
        req = {'cmd': 'wgc_shot', 'target': str(hwnd), 'path': out_bmp, 'maxWaitMs': 2500}
        r = subprocess.run([bin_path], input=_json.dumps(req), capture_output=True,
                           text=True, timeout=15, encoding='utf-8', errors='replace')
        d = _json.loads((r.stdout or '').strip() or '{}')
        if not d.get('ok'):
            return None, 0, 0, 0, 0, str(d.get('error') or 'wgc_shot 失败')
        img = Image.open(out_bmp).convert('RGB')
        import ctypes.wintypes as _wt
        rect = _wt.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return img, rect.left, rect.top, img.size[0], img.size[1], ''
    except Exception as e:
        return None, 0, 0, 0, 0, '%s: %s' % (type(e).__name__, e)
    finally:
        try:
            if os.path.exists(out_bmp):
                os.remove(out_bmp)
        except Exception:
            pass


def capture_window(hwnd):
    """PrintWindow(PW_RENDERFULLCONTENT) 单窗取像（WGC 不可用时的兜底）。

    返回 (PIL.Image, left, top, w, h)。对 Electron/Chromium/DirectX 可能全黑 ——
    所以主路径是 capture_window_wgc，这个只在 WGC 拿不到时用。
    """
    rect = ctypes.wintypes.RECT() if hasattr(ctypes, 'wintypes') else None
    if rect is None:
        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                        ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
        rect = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    left, top = rect.left, rect.top
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return None, 0, 0, 0, 0

    hdc = user32.GetWindowDC(hwnd)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    gdi32.SelectObject(mem, bmp)
    ok = user32.PrintWindow(hwnd, mem, 2)   # PW_RENDERFULLCONTENT
    if not ok:
        gdi32.DeleteObject(bmp); gdi32.DeleteDC(mem); user32.ReleaseDC(hwnd, hdc)
        return None, 0, 0, 0, 0

    bi = BITMAPINFO()
    bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h          # 负=自上而下
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = 0
    buf_len = w * h * 4
    buf = ctypes.create_string_buffer(buf_len)
    gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(bi), 0)
    gdi32.DeleteObject(bmp); gdi32.DeleteDC(mem); user32.ReleaseDC(hwnd, hdc)

    img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1).convert('RGB')
    return img, left, top, w, h


def get_uia_elements(title_sub, max_n=40):
    """调 PowerShell UIA 扫可交互元素，返回 [{type,name,x,y,w,h}]（屏幕坐标）。"""
    import subprocess
    ps = r'''
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$title = '%s'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $title)
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) {
  $cw = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cw)
  foreach ($w in $wins) { if ($w.Current.Name -like "*$title*") { $win = $w; break } }
}
if (-not $win) { '[]'; exit }
$hits = New-Object System.Collections.ArrayList
$stack = New-Object System.Collections.Stack
$stack.Push(@($win, 0))
$interactive = '[ControlType::Button,Edit,Hyperlink,ListItem,MenuItem,CheckBox,RadioButton,ComboBox,TabItem,TreeItem,SplitButton,Slider,Spinner], [ControlType::Text]'.Length
while ($stack.Count -gt 0 -and $hits.Count -lt %d) {
  $item = $stack.Pop(); $el = $item[0]; $depth = $item[1]
  try {
    $ct = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.',''
    $name = $el.Current.Name
    if ($name -and $ct -match '^(Button|Edit|Hyperlink|ListItem|MenuItem|CheckBox|RadioButton|ComboBox|TabItem|TreeItem|SplitButton|Slider|Spinner)$') {
      $r = $el.Current.BoundingRectangle
      if ($r.Width -gt 2 -and $r.Height -gt 2 -and -not $el.Current.IsOffscreen) {
        [void]$hits.Add(@{ type = $ct.ToLower(); name = $name; x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height; cx = [int]($r.X + $r.Width/2); cy = [int]($r.Y + $r.Height/2) })
      }
    }
    if ($depth -lt 6) {
      $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
      foreach ($k in $kids) { $stack.Push(@($k, $depth + 1)) }
    }
  } catch { }
}
if ($hits.Count -gt 0) { $hits | ConvertTo-Json -Compress } else { '[]' }
''' % (title_sub.replace("'", "''"), max_n)
    try:
        r = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive', '-Command', ps],
                           capture_output=True, text=True, timeout=6, encoding='utf-8', errors='replace')
        out = (r.stdout or '').strip()
        if not out:
            return []
        data = json.loads(out)
        return data if isinstance(data, list) else [data]
    except Exception:
        return []


def get_ocr_elements(title_sub, max_n=40):
    """OCR 兜底：UIA 失明（UWP/微信/游戏/自绘画布）时用文字块当可点目标。
    返回 [{type:'text', name, x, y, w, h}]（屏幕坐标）。"""
    import subprocess
    here = __import__('os').path.dirname(__import__('os').path.abspath(__file__))
    script = __import__('os').path.join(here, 'ocr_find.py')
    cmd = [sys.executable, script, '--all']
    if title_sub:
        cmd += ['--window', title_sub]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60,
                           encoding='utf-8', errors='replace')
        d = json.loads((r.stdout or '').strip() or '{}')
        hits = d.get('hits') or []
        out = []
        for h in hits[:max_n]:
            out.append({
                'type': 'text',
                'name': str(h.get('text', ''))[:40],
                'x': int(h.get('x', 0)), 'y': int(h.get('y', 0)),
                'w': int(h.get('w', 0)), 'h': int(h.get('h', 0)),
                'cx': int(h.get('x', 0)), 'cy': int(h.get('y', 0)),
            })
        return out
    except Exception:
        return []


def annotate(img, elements, win_left, win_top, max_n=40):
    """在图上画框+编号。返回 (标注后图, marks 列表)。"""
    draw = ImageDraw.Draw(img)
    # 字体：优先系统中文字体，失败退回默认
    font = None
    for fp in (r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\arialbd.ttf'):
        try:
            font = ImageFont.truetype(fp, 18)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()

    marks = []
    for i, el in enumerate(elements[:max_n], start=1):
        # 屏幕坐标 → 窗口内坐标
        x = int(el.get('x', 0)) - win_left
        y = int(el.get('y', 0)) - win_top
        w = int(el.get('w', 0))
        h = int(el.get('h', 0))
        if w <= 1 or h <= 1:
            continue
        # 框（半透明描边 + 编号徽标）
        try:
            draw.rectangle([x, y, x + w, y + h], outline=(255, 64, 32), width=2)
            label = str(i)
            tb = draw.textbbox((0, 0), label, font=font)
            tw, th = tb[2] - tb[0], tb[3] - tb[1]
            bx, by = x, max(0, y - th - 6)
            draw.rectangle([bx, by, bx + tw + 8, by + th + 4], fill=(255, 64, 32))
            draw.text((bx + 4, by), label, fill=(255, 255, 255), font=font)
        except Exception:
            continue
        marks.append({
            "id": i,
            "type": el.get('type', ''),
            "name": str(el.get('name', ''))[:60],
            "x": int(el.get('cx', x)),
            "y": int(el.get('cy', y)),
        })
    return img, marks


def _pick_font(size=18):
    font = None
    for fp in (r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\arialbd.ttf'):
        try:
            font = ImageFont.truetype(fp, size)
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    return font


def draw_window_frame(img, title):
    """给整张图描一圈粗边 + 左上角标题条（2026-11-14 四十八轮续）。

    为什么：用户明确提过「截图的时候框的是哪个窗口，要有加粗的标志」。
    单窗口截图里画面就是窗口本身，所以框画在图像边缘（4px 内缩），
    左上角压一条标签写窗口标题 —— 模型一眼知道「这是谁的画面」，
    用户事后看标注图也能确认她看的是对的窗口。
    """
    draw = ImageDraw.Draw(img, 'RGBA')
    W, H = img.size
    color = (56, 189, 248)      # 和项目 UI 的青色一致
    for i in range(4):          # 4 圈 1px = 4px 粗边（board 兼容性最好的写法）
        draw.rectangle([i, i, W - 1 - i, H - 1 - i], outline=color)
    font = _pick_font(20)
    label = (title or '')[:40]
    if label:
        try:
            tb = draw.textbbox((0, 0), label, font=font)
            tw, th = tb[2] - tb[0], tb[3] - tb[1]
            pad = 6
            draw.rectangle([4, 4, 4 + tw + pad * 2, 4 + th + pad * 2], fill=(56, 189, 248, 230))
            draw.text((4 + pad, 4 + pad - 2), label, fill=(255, 255, 255), font=font)
        except Exception:
            pass
    return img


def draw_ruler(img, win_left, win_top, scale_x=1.0, scale_y=1.0, step=200):
    """在图上画【屏幕坐标】刻度尺（2026-11-10 三十八轮，抄 #13 dsh-pilot）。

    为什么：视觉模型看到的图一定被缩过（本工具自己压长边 1600，上游附件系统
    可能再压一层）。模型按「图上像素」估坐标 → 系统性偏小/偏大，点空。
    dsh-pilot 的解法是图上每 200px 一条刻度、**标签写屏幕坐标**——模型只要读
    最近的刻度就能反推真实位置，不依赖图没被压缩这个假设。

    刻度画在图的顶部/左侧边缘（只占 10px + 标签字高），不压中部内容。
    """
    draw = ImageDraw.Draw(img)
    font = _pick_font(13)
    color = (255, 220, 0)
    W, H = img.size

    # 对齐到屏幕坐标 step 的整数倍，标签才是「真·屏幕坐标」而不是窗口相对值
    sx = (int(win_left) // step) * step
    while True:
        px = (sx - win_left) * scale_x
        if px > W:
            break
        if px >= 0:
            draw.line([(px, 0), (px, 10)], fill=color, width=2)
            if px + 36 < W:
                draw.text((px + 2, 11), str(sx), fill=color, font=font)
        sx += step

    sy = (int(win_top) // step) * step
    while True:
        py = (sy - win_top) * scale_y
        if py > H:
            break
        if py >= 0:
            draw.line([(0, py), (10, py)], fill=color, width=2)
            if py + 15 < H:
                draw.text((12, py), str(sy), fill=color, font=font)
        sy += step
    return img


def foreground_window():
    """真实前台窗口 (hwnd, title)。

    ⚠ 2026-11-21 根因修（P1）：原实现在 --window 缺省时把 hwnd 配一个**占位文案**
    `(前台窗口)` 一起返回，Node 侧把它当窗口身份存进 SOM_STATE，som_click 的
    strict 前台断言按这个假标题解析必然失败 → 每次 notSent。
    现在回填真实标题；即使窗口没标题也回填真实 hwnd（唯一无歧义的身份）。
    """
    try:
        # HWND 是 64 位指针：ctypes 默认 restype=c_int 会截断高位 → 必须显式声明
        user32.GetForegroundWindow.restype = ctypes.c_void_p
        hwnd = int(user32.GetForegroundWindow() or 0)
    except Exception:
        return 0, ''
    if not hwnd:
        return 0, ''
    title = ''
    try:
        n = int(user32.GetWindowTextLengthW(hwnd) or 0)
        if n > 0:
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            title = (buf.value or '').strip()
    except Exception:
        title = ''
    return hwnd, title


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--window', default='', help='窗口标题子串（留空=前台窗口）')
    # base64 版窗口名：Node spawn 传中文会被 GBK 转坏（实测「微信」→「΢」），
    # 用 base64 绕开所有编码层
    ap.add_argument('--window-b64', default='', help='窗口标题子串（UTF-8 base64 编码）')
    ap.add_argument('--max', type=int, default=40, help='最多标注元素数')
    ap.add_argument('--out', default='', help='可选：同时保存标注图到该路径')
    ap.add_argument('--quality', type=int, default=72)
    ap.add_argument('--max-side', type=int, default=1600, help='长边上限（省 token）')
    ap.add_argument('--no-ruler', action='store_true', help='不画屏幕坐标刻度尺（默认画）')
    ap.add_argument('--no-frame', action='store_true', help='不给目标窗口描粗边（默认描）')
    args = ap.parse_args()

    if args.window_b64:
        try:
            args.window = base64.b64decode(args.window_b64).decode('utf-8')
        except Exception as e:
            print(json.dumps({"ok": False, "error": "窗口名解码失败: %s" % e}, ensure_ascii=False))
            return

    if args.window:
        hwnd, title = find_window(args.window)
    else:
        # 空目标 = 前台窗口：回填**真实** hwnd/title，不用占位文案
        hwnd, title = foreground_window()
    if not hwnd:
        err = ('没找到窗口：%s' % args.window) if args.window else '读不到当前前台窗口（GetForegroundWindow 返回 0）'
        print(json.dumps({"ok": False, "error": err}, ensure_ascii=False))
        return

    # 抓画面：WGC 优先（Electron/Chromium/DirectX 只有它可靠），PrintWindow 兜底
    wgc_err = ''
    img, left, top, w, h, wgc_err = capture_window_wgc(hwnd)
    capture_via = 'wgc'
    if img is None:
        img, left, top, w, h = capture_window(hwnd)
        capture_via = 'printwindow'
        if img is None:
            print(json.dumps({"ok": False, "error": "截图为空（WGC: %s；PrintWindow 也失败）" % (wgc_err or '未知')}, ensure_ascii=False))
            return

    elements = get_uia_elements(title, args.max) if args.window else []
    source = 'uia'
    if not elements:
        # UIA 失明兜底（实测：微信/记事本/UWP 设置 扫不到元素，ZCode 能扫到）
        # → 用 OCR 文字块当可点目标，仍是「系统给坐标、模型给语义」的 SoM 思路
        elements = get_ocr_elements(args.window, args.max)
        source = 'ocr'
    img2, marks = annotate(img, elements, left, top, args.max)

    # 缩放（长边压到 max_side，省视觉模型 token）
    captured_w, captured_h = img2.size
    if max(img2.size) > args.max_side:
        ratio = args.max_side / max(img2.size)
        img2 = img2.resize((int(img2.width * ratio), int(img2.height * ratio)), Image.LANCZOS)

    # ── #13 坐标刻度尺 + delivered_scale 乘数契约（2026-11-10 三十八轮）──
    # 在**缩放后**的图上画刻度（标签位置才和图对齐），标签值始终是屏幕坐标。
    scale_x = img2.width / float(captured_w) if captured_w else 1.0
    scale_y = img2.height / float(captured_h) if captured_h else 1.0
    # 目标窗口粗边 + 标题（2026-11-14）：先画框，再画刻度（刻度压在最上层不被盖）
    if not args.no_frame:
        try:
            img2 = draw_window_frame(img2, title)
        except Exception:
            pass   # 描边是辅助，失败不影响主链
    if not args.no_ruler:
        try:
            img2 = draw_ruler(img2, left, top, scale_x, scale_y, 200)
        except Exception:
            pass   # 刻度尺是辅助，画失败不影响主链

    buf = io.BytesIO()
    img2.save(buf, format='JPEG', quality=args.quality)
    b64 = base64.b64encode(buf.getvalue()).decode('ascii')

    if args.out:
        img2.save(args.out, format='JPEG', quality=90)

    # delivered_scale 条件式承诺：只有交付尺寸 == 采集尺寸时图上像素才等于屏幕像素
    same_size = abs(scale_x - 1.0) < 1e-6 and abs(scale_y - 1.0) < 1e-6
    note = "AI 应按编号选元素；编号坐标已换算成屏幕坐标。"
    if not same_size:
        note += ("本图已被压缩到 %.0f%%（scale=%.3f/%.3f），图上 1px ≠ 屏幕 1px"
                 "——要按像素点，读边缘黄色刻度标签里的屏幕坐标，别按图上像素估。" %
                 (scale_x * 100, scale_x, scale_y))
    elif not args.no_ruler:
        note += "图边缘黄色刻度标签是屏幕坐标，可用于校正点击位置。"

    print(json.dumps({
        "ok": True, "title": title, "hwnd": hwnd, "image": b64,
        "win": {"x": left, "y": top, "w": w, "h": h},
        "marks": marks, "count": len(marks), "source": source,
        "capture": capture_via,   # wgc / printwindow —— 画面不对时先看这个字段
        "captured": {"w": captured_w, "h": captured_h},
        "delivered": {"w": img2.width, "h": img2.height},
        "scale": {"x": round(scale_x, 4), "y": round(scale_y, 4)},
        "ruler": (None if args.no_ruler else {"step": 200, "unit": "screen_px"}),
        "note": note,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
