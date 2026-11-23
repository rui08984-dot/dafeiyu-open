#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""visual_locate.py —— 不靠 OCR 的视觉定位兜底（她"看得见但点不到"的第二双眼睛）。

为什么需要它（实测背景）：
  RapidOCR 只认标准印刷体。游戏里的艺术字（PVZ 主菜单「点击开始」木牌上的白字）
  实测完全识别不到，而弹窗上的标准黑体「检测到更新」能认出来。此时 click_text 必然失败。
  这里换一条路：**模板匹配** —— 直接拿"那个按钮长什么样"去画面里找。

四个模式：
  ① 匹配单个模板：  visual_locate.py --window "植物大战僵尸杂交版" --template "点击开始"
  ② 存模板：        visual_locate.py --window "植物大战僵尸杂交版" --save-region 600,800,500,80 --name "点击开始"
  ③ 匹配整个目录：  visual_locate.py --window "X" --template-dir pet-runtime/knowledge/templates/
  ④ 统一 JSON 单行输出（见文件末尾 emit 字段表）

坐标系（和 ocr_find.py / pet-core / click_at 完全一致）：
  · 所有 --save-region / 返回的 x,y 都是**屏幕物理像素**（返回）和**窗口内相对物理像素**（入参）。
  · 窗口原点 = pet-core `windows` 命令返回的 x/y（GetWindowRect 外框左上角，物理像素）。
  · 截图来源优先 pet-core `wgc_shot`（WGC 按 HWND 从 DWM 合成表面取，**窗口被遮挡也能截**，
    且图尺寸 == 窗框尺寸，图片 (0,0) 就是窗口 (0,0)）。WGC 失败才回落 PrintWindow。
  · DPI：本机 2560×1600@150%。pet-core 自己开 DPI 感知，返回的是物理像素；
    本脚本也声明 DPI 感知，避免自己的 GDI 回落路径算出逻辑像素（偏 1.5 倍）。

尺寸归一化（窗口大小会变）：
  存模板时记下当时的**窗口尺寸**写进同名 .json；匹配时按当前窗口尺寸把模板等比缩放到
  "它在这个窗口里应占的大小"，再在 0.8/0.9/1.0/1.1/1.2 五个尺度上细搜。
  这样窗口从 1280×720 拖到 1920×1080，模板仍然对得上，而不是只会 100% 匹配。

依赖：cv2（本机 5.0.0）、numpy（2.3.5）、pet-core 二进制（WGC）。
不依赖 torch / onnxruntime / PIL。
"""

import argparse
import ctypes
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime

# ── 路径与常量 ────────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
PET_RUNTIME = os.path.dirname(HERE)                       # …/pet-runtime
PROJECT_ROOT = os.path.dirname(PET_RUNTIME)               # 项目根
TEMPLATE_DIR = os.path.join(PET_RUNTIME, 'knowledge', 'templates')

SCALES = (0.8, 0.9, 1.0, 1.1, 1.2)   # 多尺度细搜（在归一化基准之上再乘）
DEFAULT_MIN_SCORE = 0.80
CREATE_NO_WINDOW = 0x08000000

DPI_MODE = 'unknown'
DPI = 0

# 全局错误上下文：main 每推进一段就更新，顶层 catch 用它把「统一字段」补齐
# （早期失败也要有 mode / window / img_size 等字段，而不是只有一句 error）
ERR_CTX = {}
T_START = time.perf_counter()


def _force_utf8_stdio():
    """Windows 控制台/重定向默认可能是 cp936，中文 JSON 会炸或乱码。统一 UTF-8。"""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass


def emit(obj, code=0):
    """单行 JSON 输出（Node 侧 JSON.parse 直接吃）。失败也必须有 error 字段。"""
    print(json.dumps(obj, ensure_ascii=False))
    if code:
        sys.exit(code)


def enable_dpi_awareness():
    """声明进程 DPI 感知（PrintWindow 回落路径需要；WGC 由 pet-core 负责）。

    不声明的话 GetWindowRect / ClientToScreen 会返回**逻辑像素**，
    和 click_at 的物理像素差 1.5 倍（本机 150%）。失败不静默：写进输出 dpi/dpi_mode。
    """
    global DPI_MODE, DPI
    user32 = ctypes.windll.user32
    tried = []
    mode = None
    try:
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):   # PER_MONITOR_AWARE_V2
            mode = 'per-monitor-v2'
    except Exception as e:
        tried.append('SetProcessDpiAwarenessContext(%s)' % type(e).__name__)
    if mode is None:
        try:
            if int(ctypes.windll.shcore.SetProcessDpiAwareness(2)) == 0:
                mode = 'per-monitor'
            else:
                tried.append('SetProcessDpiAwareness(nonzero)')
        except Exception as e:
            tried.append('SetProcessDpiAwareness(%s)' % type(e).__name__)
    if mode is None:
        try:
            if user32.SetProcessDPIAware():
                mode = 'system'
            else:
                tried.append('SetProcessDPIAware(0)')
        except Exception as e:
            tried.append('SetProcessDPIAware(%s)' % type(e).__name__)
    DPI_MODE = mode or ('failed(' + '; '.join(tried or ['?']) + ')')
    try:
        DPI = int(user32.GetDpiForSystem())
    except Exception:
        DPI = 0
    return DPI_MODE


# ── 图像读写（中文路径必须走 imdecode/imencode —— cv2.imread 在 Windows 对非 ASCII 路径会失败）──
def imread_u(path, flags=None):
    import cv2
    import numpy as np
    flags = cv2.IMREAD_COLOR if flags is None else flags
    data = np.fromfile(path, dtype=np.uint8)
    if data.size == 0:
        raise ValueError('空文件：%s' % path)
    img = cv2.imdecode(data, flags)
    if img is None:
        raise ValueError('不是可解码的图片（或格式不支持）：%s' % path)
    return img


def imwrite_u(path, img):
    import cv2
    ext = os.path.splitext(path)[1] or '.png'
    ok, buf = cv2.imencode(ext, img)
    if not ok:
        raise ValueError('图片编码失败：%s' % path)
    buf.tofile(path)


# ── pet-core 调用 ─────────────────────────────────────────────────────────────
def core_bin():
    """定位 pet-core 二进制。可用环境变量 PET_CORE_BIN 覆盖（测试/换机器用）。"""
    cands = []
    env = os.environ.get('PET_CORE_BIN')
    if env:
        cands.append(env)
    cands.append(os.path.join(PROJECT_ROOT, 'pet-core', 'target', 'release',
                              'pet-core.exe' if os.name == 'nt' else 'pet-core'))
    cands.append(os.path.join(PROJECT_ROOT, 'pet-core', 'target', 'release', 'pet-core'))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return ''


def pet_core(req, timeout=25):
    """跑一次 pet-core（stdin JSON → stdout JSON）。失败返回 {'ok':False,'error':...}，不抛。"""
    binp = core_bin()
    if not binp:
        return {'ok': False, 'error': 'pet-core 二进制不存在（找过 %s/pet-core/target/release/；可用 PET_CORE_BIN 指定）' % PROJECT_ROOT}
    try:
        p = subprocess.run([binp], input=json.dumps(req, ensure_ascii=False),
                           capture_output=True, text=True, encoding='utf-8', errors='replace',
                           timeout=timeout, creationflags=CREATE_NO_WINDOW if os.name == 'nt' else 0)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': 'pet-core %s 超时（%ss）' % (req.get('cmd'), timeout)}
    except Exception as e:
        return {'ok': False, 'error': 'pet-core 起不来：%s: %s' % (type(e).__name__, e)}
    out = (p.stdout or '').strip()
    if not out:
        return {'ok': False, 'error': 'pet-core 无输出（stderr=%s）' % ((p.stderr or '')[-200:])}
    try:
        return json.loads(out)
    except Exception as e:
        return {'ok': False, 'error': 'pet-core 输出不是 JSON：%s；前 200 字=%r' % (e, out[:200])}


def resolve_window(target):
    """按标题子串 / hwnd 找窗口，返回 pet-core windows 命令的窗口记录（物理像素窗框）。

    找不到 / 最小化都抛 ValueError（错误必须进 JSON，不静默）。
    """
    target = (target or '').strip()
    if not target:
        fg = pet_core({'cmd': 'fg'})
        if not fg.get('ok') or not fg.get('title'):
            raise ValueError('没给 --window，也拿不到前台窗口（pet-core fg 失败：%s）' % fg.get('error', '无标题'))
        target = str(fg['title'])
    if target.isdigit():
        r = pet_core({'cmd': 'windows', 'filter': '', 'max': 500})
        wins = r.get('windows') or []
        hit = next((w for w in wins if int(w.get('hwnd', 0)) == int(target)), None)
        if not hit:
            raise ValueError('没找到 hwnd=%s 的可见窗口' % target)
    else:
        r = pet_core({'cmd': 'windows', 'filter': target, 'max': 50})
        if not r.get('ok'):
            raise ValueError('枚举窗口失败：%s' % r.get('error'))
        wins = r.get('windows') or []
        if not wins:
            raise ValueError('没找到标题含「%s」的可见窗口（窗口最小化时也可能看不到；先 focus_window 恢复）' % target)
        exact = [w for w in wins if str(w.get('title', '')).lower() == target.lower()]
        pool = exact or wins
        # 优先非最小化；同状态取标题最长（避免命中「设置」这种泛标题）
        pool.sort(key=lambda w: (bool(w.get('iconic')), -len(str(w.get('title', '')))))
        hit = pool[0]
    if hit.get('iconic'):
        raise ValueError('窗口「%s」是最小化状态（hwnd=%s）—— WGC 抓不到最小化窗口（DWM 不合成），先 focus_window 恢复'
                         % (hit.get('title'), hit.get('hwnd')))
    w, h = int(hit.get('w', 0)), int(hit.get('h', 0))
    if w <= 1 or h <= 1:
        raise ValueError('窗口「%s」尺寸非法（%dx%d）' % (hit.get('title'), w, h))
    if int(hit.get('x', 0)) < -20000 or int(hit.get('y', 0)) < -20000:
        raise ValueError('窗口「%s」在屏外（位置 %s,%s）—— 先 focus_window 恢复'
                         % (hit.get('title'), hit.get('x'), hit.get('y')))
    return hit


# ── 截窗（WGC 优先，PrintWindow 兜底）────────────────────────────────────────
def _capture_wgc(win, client_only=False):
    """WGC 按 HWND 抓图（穿透遮挡）。返回 (img, path) 或抛 ValueError。"""
    tmpdir = os.path.join(tempfile.gettempdir(), 'visual-locate')
    os.makedirs(tmpdir, exist_ok=True)
    path = os.path.join(tmpdir, 'shot-%d-%d.bmp' % (os.getpid(), int(time.time() * 1000)))
    r = pet_core({
        'cmd': 'wgc_shot',
        'target': str(win['hwnd']),
        'path': path,
        'clientOnly': bool(client_only),
        'maxWaitMs': 3000,
    }, timeout=30)
    try:
        if not r.get('ok'):
            raise ValueError('WGC 抓图失败：%s' % (r.get('error') or '未知'))
        img = imread_u(path, None)
        return img
    finally:
        try:
            os.remove(path)
        except Exception:
            pass


def _client_origin(win):
    """客户区左上角的屏幕物理坐标（--client 时图片 (0,0) 对应它）。"""
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    user32.ClientToScreen.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.POINT)]
    user32.ClientToScreen.restype = ctypes.c_int
    pt = wintypes.POINT(0, 0)
    if not user32.ClientToScreen(ctypes.c_void_p(int(win['hwnd'])), ctypes.byref(pt)):
        raise ValueError('ClientToScreen 失败（hwnd=%s）' % win.get('hwnd'))
    return int(pt.x), int(pt.y)


def client_size(win):
    """客户区物理尺寸 (w,h)。游戏/应用的 UI 内容是随**客户区**缩放的，
    用客户区比例做模板归一化比用窗框（含固定宽度的标题栏/边框）更准。"""
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    user32.GetClientRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.RECT)]
    user32.GetClientRect.restype = ctypes.c_int
    r = wintypes.RECT()
    if not user32.GetClientRect(ctypes.c_void_p(int(win['hwnd'])), ctypes.byref(r)):
        return None
    w, h = int(r.right - r.left), int(r.bottom - r.top)
    return (w, h) if w > 0 and h > 0 else None


def _capture_printwindow(win, client_only=False):
    """PrintWindow(PW_RENDERFULLCONTENT) 兜底：GDI 路径，能截"被部分遮挡"的普通窗口。

    按**窗框尺寸**建位图 → 图片 (0,0) = 窗框左上角，和 WGC 整窗同一坐标系。
    （PrintWindow 的 DWM 合成内容对 Chromium/大部分 GDI 程序有效；游戏全屏可能黑屏。）
    """
    import numpy as np

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [('biSize', ctypes.c_uint32), ('biWidth', ctypes.c_int32), ('biHeight', ctypes.c_int32),
                    ('biPlanes', ctypes.c_uint16), ('biBitCount', ctypes.c_uint16), ('biCompression', ctypes.c_uint32),
                    ('biSizeImage', ctypes.c_uint32), ('biXPelsPerMeter', ctypes.c_int32),
                    ('biYPelsPerMeter', ctypes.c_int32), ('biClrUsed', ctypes.c_uint32),
                    ('biClrImportant', ctypes.c_uint32)]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', ctypes.c_uint32 * 3)]

    # 显式声明 64 位句柄类型：ctypes 默认 restype=c_int 会把 HDC/HBITMAP 截断成 32 位
    user32.GetWindowDC.restype = ctypes.c_void_p
    user32.GetWindowDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateCompatibleBitmap.restype = ctypes.c_void_p
    gdi32.CreateCompatibleBitmap.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
    gdi32.SelectObject.restype = ctypes.c_void_p
    gdi32.SelectObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    user32.PrintWindow.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
    user32.ReleaseDC.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
    gdi32.GetDIBits.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_uint,
                                ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]
    gdi32.GetDIBits.restype = ctypes.c_int

    hwnd = ctypes.c_void_p(int(win['hwnd']))
    w, h = int(win['w']), int(win['h'])
    if client_only:
        r = ctypes.wintypes.RECT()
        user32.GetClientRect.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.wintypes.RECT)]
        user32.GetClientRect.restype = ctypes.c_int
        if not user32.GetClientRect(hwnd, ctypes.byref(r)):
            raise ValueError('PrintWindow 失败：GetClientRect 拿不到')
        w, h = int(r.right - r.left), int(r.bottom - r.top)
        if w <= 0 or h <= 0:
            raise ValueError('PrintWindow 失败：客户区尺寸非法 %dx%d' % (w, h))
    hdc_window = user32.GetWindowDC(hwnd)
    if not hdc_window:
        raise ValueError('PrintWindow 失败：GetWindowDC 拿不到')
    hdc_mem = gdi32.CreateCompatibleDC(hdc_window)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_window, w, h)
    gdi32.SelectObject(hdc_mem, hbmp)
    ok = user32.PrintWindow(hwnd, hdc_mem, 2)   # PW_RENDERFULLCONTENT
    img = None
    try:
        if ok:
            bmi = BITMAPINFO()
            bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            bmi.bmiHeader.biWidth = w
            bmi.bmiHeader.biHeight = -h          # top-down
            bmi.bmiHeader.biPlanes = 1
            bmi.bmiHeader.biBitCount = 32
            bmi.bmiHeader.biCompression = 0
            buf = ctypes.create_string_buffer(w * h * 4)
            gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bmi), 0)
            arr = np.frombuffer(buf.raw, dtype=np.uint8).reshape(h, w, 4)
            img = arr[:, :, :3].copy()           # BGRA → BGR
    finally:
        gdi32.DeleteObject(hbmp)
        gdi32.DeleteDC(hdc_mem)
        user32.ReleaseDC(hwnd, hdc_window)
    if img is None:
        raise ValueError('PrintWindow 返回失败（窗口可能不支持 PW_RENDERFULLCONTENT，或已最小化）')
    # ── 可信度自检（必须做，否则会交出**错的坐标**）─────────────────────────
    # 实测：DPI-unaware 的窗口（Tk 等）在 150% 缩放下，PrintWindow 会按**逻辑尺寸**
    # 把窗口画进位图左上角、其余留黑（1524×809 的窗只画出 ~1020×550）。
    # 图不是黑的，但缩放和原点是错的 —— 拿它算坐标会整体偏 1/1.5。
    # 判据：非黑内容必须覆盖画面 90% 以上。不满足就明确拒绝，让调用方走 WGC。
    nz = np.argwhere(np.any(img > 8, axis=2))
    if nz.size == 0:
        raise ValueError('PrintWindow 拿到全黑图（窗口被完全遮挡，或自绘内容不响应 WM_PRINT）')
    x0, y0 = int(nz[:, 1].min()), int(nz[:, 0].min())
    x1, y1 = int(nz[:, 1].max()), int(nz[:, 0].max())
    cw, ch = x1 - x0 + 1, y1 - y0 + 1
    if cw < w * 0.9 or ch < h * 0.9:
        raise ValueError('PrintWindow 抓到的内容只占画面 %dx%d / %dx%d（疑似 DPI 虚拟化：应用按逻辑尺寸渲染，'
                         '坐标会整体偏 %.2f 倍）—— 这条通道不可信，改用 WGC'
                         % (cw, ch, w, h, (w / cw if cw else 0)))
    return img


def capture_window(win, client_only=False, force_printwindow=False):
    """截窗口 → {img, origin_x, origin_y, via, img_size, capture_ms, fallback_note}。

    返回的 origin_* 是**图片 (0,0) 对应的屏幕物理坐标**。
    当前两条通道都是整窗（窗框）→ origin == win.x/y，窗口内坐标 == 图片坐标。
    """
    t0 = time.perf_counter()
    if client_only:
        ox, oy = _client_origin(win)
    else:
        ox, oy = int(win['x']), int(win['y'])
    err1 = '（--no-wgc：主动跳过 WGC）' if force_printwindow else ''
    if not force_printwindow:
        try:
            img = _capture_wgc(win, client_only=client_only)
            return {
                'img': img, 'origin_x': ox, 'origin_y': oy,
                'via': 'wgc', 'capture_ms': int((time.perf_counter() - t0) * 1000),
                'fallback_note': '', 'coord_origin': 'client' if client_only else 'frame',
            }
        except Exception as e:
            err1 = str(e) or type(e).__name__
    # WGC 失败（最小化已提前拦；这里可能是窗口不支持 WGC / DWM 异常 / 驱动问题）
    try:
        img = _capture_printwindow(win, client_only=client_only)
        return {
            'img': img, 'origin_x': ox, 'origin_y': oy,
            'via': 'printwindow', 'capture_ms': int((time.perf_counter() - t0) * 1000),
            'fallback_note': 'WGC 不可用，已回落 PrintWindow：%s' % err1,
            'coord_origin': 'client' if client_only else 'frame',
        }
    except Exception as e:
        raise ValueError('截窗失败：① WGC：%s ② PrintWindow 兜底：%s' % (err1, str(e) or type(e).__name__))


# ── 模板加载 / 预处理 ─────────────────────────────────────────────────────────
# ⚠ 2026-11-10 红队 S10（路径穿越 / 任意文件读）：原来 `template_path_for` 允许
#   「直接给路径」—— `--template D:/任意/x.png`、`../../secret.png`、`CON` 都放行；
#   而模板名来自 LLM 参数（visual_click 的 arg），等于把文件系统读开了个口子。
#   现在只接受**裸模板名**：字母/数字/下划线/连字符/中文，1-64 字符，禁止分隔符/盘符/
#   通配符/Windows 保留设备名。所有模板只能落在 knowledge/templates/ 下。
_TEMPLATE_NAME_RE = re.compile(r'^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,64}$')
_WIN_RESERVED_NAMES = frozenset(
    ['CON', 'PRN', 'AUX', 'NUL']
    + ['COM%d' % i for i in range(1, 10)]
    + ['LPT%d' % i for i in range(1, 10)]
)


def template_path_for(name):
    """模板名 → 路径。只接受裸模板名（安全白名单），不接受任何路径形态。"""
    n = (name or '').strip()
    if not n:
        raise ValueError('模板名不能为空')
    if n.lower().endswith('.png'):
        n = n[:-4]
    if not _TEMPLATE_NAME_RE.match(n):
        raise ValueError('模板名不合法：只允许字母/数字/下划线/连字符/中文（1-64 字符），'
                         '不许带路径分隔符、盘符、..、通配符或保留名（收到：%s）' % n[:80])
    if n.upper() in _WIN_RESERVED_NAMES:
        raise ValueError('模板名是 Windows 保留设备名：%s' % n)
    return os.path.join(TEMPLATE_DIR, n + '.png')


def load_template(path):
    """读模板 → (bgr, alpha_mask|None, meta|None)。alpha 全 255 时不当 mask（没意义）。"""
    import numpy as np
    if not os.path.isfile(path):
        raise ValueError('模板文件不存在：%s' % path)
    raw = imread_u(path, None)   # IMREAD_UNCHANGED，保留 alpha
    if raw is None or getattr(raw, 'size', 0) == 0:
        raise ValueError('模板读不出像素：%s' % path)
    mask = None
    if raw.ndim == 3 and raw.shape[2] == 4:
        alpha = raw[:, :, 3]
        if int(alpha.min()) < 250:
            mask = alpha
        img = raw[:, :, :3].copy()
    elif raw.ndim == 2:
        import cv2
        img = cv2.cvtColor(raw, cv2.COLOR_GRAY2BGR)
    else:
        img = raw
    meta = None
    mp = os.path.splitext(path)[0] + '.json'
    if os.path.isfile(mp):
        try:
            with open(mp, 'r', encoding='utf-8') as f:
                meta = json.load(f)
        except Exception:
            meta = None
    return img, mask, meta


def _clahe(gray):
    """轻度局部直方图均衡（CLAHE）。失败退回 equalizeHist；再失败原图。"""
    import cv2
    try:
        cl = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        return cl.apply(gray)
    except Exception:
        try:
            return cv2.equalizeHist(gray)
        except Exception:
            return gray


def _prep_gray(img):
    import cv2
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return _clahe(gray)


# ── 匹配核心 ──────────────────────────────────────────────────────────────────
def match_template_in_image(cap, tpl_img, tpl_mask, meta, min_score=DEFAULT_MIN_SCORE,
                            normalize=True, scales=SCALES, cur_client_size=None):
    """在 cap['img'] 里找模板（多尺度 + 尺寸归一化）。

    返回 dict：score / scale / scale_xy / norm / x / y / rect / tw / th / method / tried / errors
    score 达不到 min_score 也返回（由调用方决定 found），但 errors 里会写清为什么没成。
    """
    import cv2
    import numpy as np

    img = cap['img']
    ih, iw = img.shape[:2]
    tpl_h, tpl_w = tpl_img.shape[:2]

    # ── 尺寸归一化：模板存的时候记了源窗口尺寸，就按当前窗口等比缩放 ──
    # 优先用**客户区**比例（UI 内容按客户区缩放；窗框含固定宽度标题栏，比例会有微小偏差）
    norm_used = False
    base_sx = base_sy = 1.0
    src_size = None
    norm_basis = None
    if normalize and isinstance(meta, dict):
        try:
            cur = cur_client_size if (cur_client_size and cur_client_size[0] > 1) else None
            ss = meta.get('source_client_size')
            if cur and isinstance(ss, (list, tuple)) and len(ss) == 2 and float(ss[0]) > 1 and float(ss[1]) > 1:
                base_sx = cur[0] / float(ss[0])
                base_sy = cur[1] / float(ss[1])
                norm_used = True
                src_size = [int(ss[0]), int(ss[1])]
                norm_basis = 'client'
            else:
                ss = meta.get('source_window_size')
                if isinstance(ss, (list, tuple)) and len(ss) == 2:
                    sw, sh = float(ss[0]), float(ss[1])
                    if sw > 1 and sh > 1:
                        base_sx = iw / sw
                        base_sy = ih / sh
                        norm_used = True
                        src_size = [int(sw), int(sh)]
                        norm_basis = 'frame'
        except (TypeError, ValueError):
            norm_used = False
            base_sx = base_sy = 1.0

    gray_img = _prep_gray(img) if normalize else (img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))

    method_name = 'TM_CCOEFF_NORMED'
    method = cv2.TM_CCOEFF_NORMED
    if tpl_mask is not None:
        # ⚠ OpenCV 的 mask 只支持 TM_SQDIFF / TM_CCORR_NORMED；TM_CCOEFF_NORMED 传 mask 会被忽略。
        method_name = 'TM_CCORR_NORMED(mask)'
        method = cv2.TM_CCORR_NORMED

    # 候选尺度：spec 的 5 档 × 归一化基准
    cands = [(m, base_sx * m, base_sy * m) for m in scales]
    # 兜底：归一化会假定「UI 随窗口缩放」。有些应用（固定尺寸画布/固定分辨率游戏）
    # 窗口变了内容不缩放 —— 此时绝对 1.0 才是对的。多试一档，成本 ~25ms，能救回这一类。
    if norm_used and abs(base_sx - 1.0) > 0.02:
        cands.append((1.0, 1.0, 1.0))
    seen = set()
    cands_dedup = []
    for m, sx, sy in cands:
        key = (round(sx, 3), round(sy, 3))
        if key in seen:
            continue
        seen.add(key)
        cands_dedup.append((m, sx, sy))
    cands = cands_dedup

    best = {'score': -1.0, 'scale': None, 'scale_xy': None, 'loc': None, 'tw': 0, 'th': 0}
    tried, skipped = [], []
    for mult, sx, sy in cands:
        tw = max(8, int(round(tpl_w * sx)))
        th = max(8, int(round(tpl_h * sy)))
        if tw > iw or th > ih:
            skipped.append({'mult': mult, 'tw': tw, 'th': th, 'why': '模板缩放后比窗口截图大'})
            continue
        tw = min(tw, iw)
        th = min(th, ih)
        try:
            tpl_s = cv2.resize(tpl_img, (tw, th), interpolation=cv2.INTER_AREA)
            tpl_g = _prep_gray(tpl_s) if normalize else (tpl_s if tpl_s.ndim == 2 else cv2.cvtColor(tpl_s, cv2.COLOR_BGR2GRAY))
            mask_s = None
            if tpl_mask is not None:
                mask_s = cv2.resize(tpl_mask, (tw, th), interpolation=cv2.INTER_NEAREST)
            if mask_s is not None:
                res = cv2.matchTemplate(gray_img, tpl_g, method, mask=mask_s)
            else:
                res = cv2.matchTemplate(gray_img, tpl_g, method)
            res = np.nan_to_num(res, nan=-1.0, posinf=-1.0, neginf=-1.0)
            _minv, maxv, _minl, maxl = cv2.minMaxLoc(res)
        except Exception as e:
            skipped.append({'mult': mult, 'tw': tw, 'th': th, 'why': '%s: %s' % (type(e).__name__, e)})
            continue
        tried.append({'mult': mult, 'tw': tw, 'th': th, 'score': round(float(maxv), 4)})
        if maxv > best['score']:
            best = {
                'score': float(maxv), 'scale': round(sx, 4),
                'scale_xy': [round(sx, 4), round(sy, 4)],
                'loc': (int(maxl[0]), int(maxl[1])), 'tw': tw, 'th': th, 'mult': mult,
            }

    out = {
        'score': best['score'] if best['loc'] else -1.0,
        'scale': best.get('scale'),
        'scale_xy': best.get('scale_xy'),
        'norm': norm_used,
        'norm_basis': norm_basis,
        'source_window_size': src_size,
        'base_scale': [round(base_sx, 4), round(base_sy, 4)],
        'method': method_name,
        'tried': tried,
        'skipped': skipped,
        'tpl_size': [tpl_w, tpl_h],
        'img_size': [iw, ih],
    }
    if not best['loc']:
        out['x'] = out['y'] = None
        out['rect'] = None
        out['error'] = '所有尺度都放不下模板（模板 %dx%d，窗口截图 %dx%d）' % (tpl_w, tpl_h, iw, ih)
        return out

    mx, my = best['loc']
    tw, th = best['tw'], best['th']
    out['x'] = int(cap['origin_x'] + mx + tw / 2.0)
    out['y'] = int(cap['origin_y'] + my + th / 2.0)
    out['rect'] = [int(cap['origin_x'] + mx), int(cap['origin_y'] + my), int(tw), int(th)]
    out['img_rect'] = [int(mx), int(my), int(tw), int(th)]
    out['found'] = out['score'] >= min_score
    return out


# ── 参数 ─────────────────────────────────────────────────────────────────────
class JsonArgParser(argparse.ArgumentParser):
    """argparse 默认把用法打到 stderr 然后 exit 2；这里改成抛，统一进 JSON error。"""

    def error(self, message):
        raise ValueError('参数错误：%s' % message)


def parse_region(s):
    """'x,y,w,h'（也吃中文逗号）→ 四个整数（窗口内相对物理像素）。"""
    parts = [p.strip() for p in str(s).replace('，', ',').split(',')]
    if len(parts) != 4:
        raise ValueError('--save-region 需要 4 个整数：x,y,w,h；收到 %r' % s)
    try:
        x, y, w, h = [int(round(float(p))) for p in parts]
    except ValueError:
        raise ValueError('--save-region 里有非数字：%r' % s)
    if w <= 0 or h <= 0:
        raise ValueError('--save-region 宽高必须 > 0；收到 %r' % s)
    return x, y, w, h


def build_parser():
    p = JsonArgParser(
        prog='visual_locate.py',
        description='视觉定位兜底：模板匹配找按钮（不依赖 OCR）；也可从窗口截图裁存模板。',
        add_help=True,
    )
    p.add_argument('--window', default='', help='窗口标题子串或 hwnd；留空用前台窗口')
    p.add_argument('--template', default='', help='模板名（knowledge/templates/<名>.png）或直接给图片路径')
    p.add_argument('--template-dir', default='', help='匹配整个目录下的所有 .png 模板')
    p.add_argument('--save-region', default='', help='存模板：窗口内相对坐标 x,y,w,h（窗框左上角=0,0）')
    p.add_argument('--name', default='', help='存模板的名字（不带 .png）')
    p.add_argument('--min-score', type=float, default=DEFAULT_MIN_SCORE, help='匹配阈值，默认 0.80')
    p.add_argument('--max-hits', type=int, default=10, help='目录模式最多返回几个命中，默认 10')
    p.add_argument('--no-normalize', action='store_true', help='关闭灰度 CLAHE 归一化（诊断用）')
    p.add_argument('--no-wgc', action='store_true', help='不走 WGC，强制 PrintWindow 截窗（诊断/兼容用）')
    p.add_argument('--client', action='store_true', help='只截客户区（默认整窗；坐标原点随之变成客户区左上角）')
    return p


# ── 主流程 ────────────────────────────────────────────────────────────────────
def main():
    t_start = time.perf_counter()
    _force_utf8_stdio()
    enable_dpi_awareness()

    if len(sys.argv) == 1:
        raise ValueError('至少要给 --template / --template-dir / --save-region 之一（--help 看用法）')
    args = build_parser().parse_args(sys.argv[1:])

    modes = [bool(args.template), bool(args.template_dir), bool(args.save_region)]
    if sum(modes) != 1:
        raise ValueError('--template / --template-dir / --save-region 三选一，不能同时给')
    ERR_CTX['mode'] = 'save' if args.save_region else ('dir' if args.template_dir else 'template')
    if args.template:
        _tp = template_path_for(args.template)
        ERR_CTX['template_path'] = os.path.abspath(_tp)
        # 先验模板存在，再截窗：截一次 WGC ~800ms，模板都没有没必要截
        if not os.path.isfile(_tp):
            raise ValueError('模板文件不存在：%s' % _tp)
    if args.template_dir:
        ERR_CTX['template_dir'] = args.template_dir
        if not os.path.isdir(args.template_dir):
            raise ValueError('--template-dir 不是目录：%s' % args.template_dir)
        if not [f for f in os.listdir(args.template_dir) if f.lower().endswith('.png')]:
            raise ValueError('目录里没有 .png 模板：%s' % args.template_dir)

    normalize = not args.no_normalize
    win = resolve_window(args.window)
    ERR_CTX.update({'window': str(win.get('title', '')), 'hwnd': int(win.get('hwnd', 0)),
                    'window_rect': [int(win.get('x', 0)), int(win.get('y', 0)), int(win.get('w', 0)), int(win.get('h', 0))]})
    cs = client_size(win)
    cap = capture_window(win, client_only=args.client, force_printwindow=args.no_wgc)
    img = cap['img']
    ih, iw = img.shape[:2]
    ERR_CTX.update({'img_size': [iw, ih], 'client_size': list(cs) if cs else None,
                    'capture': cap['via'], 'origin': [cap['origin_x'], cap['origin_y']]})

    common = {
        'window': str(win.get('title', '')),
        'hwnd': int(win.get('hwnd', 0)),
        'window_rect': [int(win.get('x', 0)), int(win.get('y', 0)), int(win.get('w', 0)), int(win.get('h', 0))],
        'client_size': list(cs) if cs else None,
        'img_size': [iw, ih],
        'capture': cap['via'],
        'capture_ms': cap['capture_ms'],
        'coord_origin': cap.get('coord_origin', 'frame'),
        'dpi': DPI,
        'dpi_mode': DPI_MODE,
        'origin': [cap['origin_x'], cap['origin_y']],
        'normalize': normalize,
    }
    if cap.get('fallback_note'):
        common['capture_note'] = cap['fallback_note']

    # ── ② 存模板 ──
    if args.save_region:
        if not args.name.strip():
            raise ValueError('--save-region 需要配合 --name（模板名）')
        x, y, w, h = parse_region(args.save_region)
        origin_desc = '客户区左上角=0,0（--client）' if args.client else '窗框左上角=0,0，标题栏也算在窗口里'
        if x < 0 or y < 0 or x + w > iw or y + h > ih:
            raise ValueError('--save-region %d,%d,%d,%d 超出窗口截图范围 %dx%d（坐标是窗口内相对物理像素，%s）'
                             % (x, y, w, h, iw, ih, origin_desc))
        crop = img[y:y + h, x:x + w]
        os.makedirs(TEMPLATE_DIR, exist_ok=True)
        path = template_path_for(args.name)
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        notice = '将保存 %dx%d 的模板到 %s' % (w, h, path)
        print(notice, file=sys.stderr)   # 人看的提示走 stderr，stdout 保持单行 JSON
        overwrote = os.path.isfile(path)
        imwrite_u(path, crop)
        meta = {
            'name': args.name.strip(),
            'template_path': os.path.abspath(path),
            'pixel_size': [w, h],
            'source_window_size': [int(win.get('w', 0)), int(win.get('h', 0))],
            'source_window_size_note': '存模板时的窗框物理尺寸（GetWindowRect）。匹配时按当前窗口/此值等比缩放模板。',
            'source_client_size': list(cs) if cs else None,
            'source_client_size_note': '存模板时的客户区物理尺寸；匹配优先用它算缩放比例（UI 内容随客户区缩放）。',
            'region_window_relative': [x, y, w, h],
            'region_note': '窗口内相对物理像素，窗框左上角=0,0',
            'window_title': str(win.get('title', '')),
            'captured_at': datetime.now().isoformat(timespec='seconds'),
            'capture_via': cap['via'],
            'client_only': bool(args.client),
            'screen_rect': [cap['origin_x'] + x, cap['origin_y'] + y, w, h],
            'description': '由 visual_locate.py --save-region 生成；改窗口大小后仍可匹配（按 source_window_size 归一化）',
        }
        mp = os.path.splitext(path)[0] + '.json'
        with open(mp, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        emit({
            'found': True, 'mode': 'save', 'saved': os.path.abspath(path),
            # 统一字段：save 模式没有匹配结果，但字段齐全，调用方不用分支解析
            'hits': [], 'x': None, 'y': None, 'score': None, 'scale': None,
            'meta_saved': os.path.abspath(mp), 'template_path': os.path.abspath(path),
            'region': [x, y, w, h], 'pixel_size': [w, h], 'overwrote': overwrote,
            'notice': notice, **common,
            'ms': int((time.perf_counter() - t_start) * 1000),
        })
        return

    # ── ③ 目录批量匹配 ──
    if args.template_dir:
        d = args.template_dir
        if not os.path.isdir(d):
            raise ValueError('--template-dir 不是目录：%s' % d)
        files = sorted(f for f in os.listdir(d) if f.lower().endswith('.png') and not f.startswith('.'))
        if not files:
            raise ValueError('目录里没有 .png 模板：%s' % d)
        hits, misses = [], []
        mt0 = time.perf_counter()
        for fn in files:
            fp = os.path.join(d, fn)
            try:
                tpl_img, tpl_mask, meta = load_template(fp)
                mr = match_template_in_image(cap, tpl_img, tpl_mask, meta,
                                            min_score=args.min_score, normalize=normalize,
                                            cur_client_size=cs)
            except Exception as e:
                misses.append({'template': fn, 'error': '%s: %s' % (type(e).__name__, e)})
                continue
            if mr.get('found'):
                hits.append({
                    'template': os.path.splitext(fn)[0], 'template_path': os.path.abspath(fp),
                    'x': mr['x'], 'y': mr['y'], 'score': round(mr['score'], 4),
                    'scale': mr['scale'], 'scale_xy': mr['scale_xy'], 'norm': mr['norm'],
                    'rect': mr['rect'], 'method': mr['method'], 'tpl_size': mr['tpl_size'],
                })
            else:
                misses.append({
                    'template': os.path.splitext(fn)[0],
                    'score': round(mr.get('score', -1.0), 4),
                    'best_norm': mr.get('norm'),
                    'why': mr.get('error') or ('分数 %.3f < 阈值 %.2f' % (mr.get('score', -1.0), args.min_score)),
                })
        hits.sort(key=lambda h: -h['score'])
        hits = hits[:max(1, args.max_hits)]
        match_ms = int((time.perf_counter() - mt0) * 1000)
        emit({
            'found': bool(hits), 'mode': 'dir', 'hits': hits,
            'x': hits[0]['x'] if hits else None, 'y': hits[0]['y'] if hits else None,
            'score': hits[0]['score'] if hits else None, 'scale': hits[0]['scale'] if hits else None,
            'template_path': hits[0]['template_path'] if hits else None,
            'template': hits[0]['template'] if hits else None,
            'misses': misses, 'templates_scanned': len(files), 'match_ms': match_ms,
            **common,
            **({} if hits else {'error': '目录里 %d 个模板全部没命中（阈值 %.2f）；明细见 misses'
                                         % (len(files), args.min_score)}),
            'ms': int((time.perf_counter() - t_start) * 1000),
        })
        return

    # ── ① 单模板匹配 ──
    path = template_path_for(args.template)
    tpl_img, tpl_mask, meta = load_template(path)
    mt0 = time.perf_counter()
    mr = match_template_in_image(cap, tpl_img, tpl_mask, meta,
                                min_score=args.min_score, normalize=normalize,
                                cur_client_size=cs)
    match_ms = int((time.perf_counter() - mt0) * 1000)

    base = {
        'mode': 'template',
        'template_path': os.path.abspath(path),
        'template': os.path.splitext(os.path.basename(path))[0],
        'min_score': args.min_score,
        **common,
        'match_ms': match_ms,
    }
    if mr.get('error') and mr.get('x') is None:
        emit({'found': False, 'x': None, 'y': None, 'score': mr.get('score'), 'scale': None,
              'hits': [], 'error': mr['error'], **base,
              'ms': int((time.perf_counter() - t_start) * 1000)})
        return
    if not mr.get('found'):
        emit({'found': False, 'x': None, 'y': None,
              'score': round(mr['score'], 4), 'scale': mr['scale'],
              'best_rect': mr.get('rect'), 'hits': [],
              'error': '匹配分数 %.3f 低于阈值 %.2f（模板「%s」可能：① 不在当前画面 ② 窗口大小/DPI 与存模板时差异过大 '
                       '③ 游戏画面换了皮肤/语言 ④ 模板本身截得不好）'
                       % (mr['score'], args.min_score, os.path.basename(path)),
              'tried': mr.get('tried'), 'skipped': mr.get('skipped'), **base,
              'ms': int((time.perf_counter() - t_start) * 1000)})
        return
    hit = {
        'template': os.path.splitext(os.path.basename(path))[0],
        'template_path': os.path.abspath(path),
        'x': mr['x'], 'y': mr['y'], 'score': round(mr['score'], 4),
        'scale': mr['scale'], 'scale_xy': mr['scale_xy'],
        'norm': mr['norm'], 'rect': mr['rect'], 'method': mr['method'],
        'tpl_size': mr['tpl_size'],
    }
    emit({
        'found': True,
        'x': mr['x'], 'y': mr['y'], 'score': round(mr['score'], 4),
        'scale': mr['scale'], 'scale_xy': mr['scale_xy'],
        'hits': [hit], 'rect': mr['rect'], 'method': mr['method'],
        'norm': mr['norm'], 'source_window_size': mr.get('source_window_size'),
        'base_scale': mr.get('base_scale'), 'tried': mr.get('tried'),
        **base,
        'ms': int((time.perf_counter() - t_start) * 1000),
    })


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        # 任何异常都必须变成 found:false + error（不许静默 catch 吞掉原因）
        # 统一字段补齐：即使窗口都没找到，调用方也能按同一套字段解析。
        out = {
            'found': False, 'hits': [],
            'x': None, 'y': None, 'score': None, 'scale': None,
            'mode': ERR_CTX.get('mode'),
            'template_path': ERR_CTX.get('template_path'),
            'window': ERR_CTX.get('window'),
            'img_size': ERR_CTX.get('img_size'),
            'error': '%s: %s' % (type(e).__name__, e),
            'ms': int((time.perf_counter() - T_START) * 1000),
            'trace': traceback.format_exc()[-1200:],
        }
        for k, v in ERR_CTX.items():
            if out.get(k) is None and v is not None:
                out[k] = v
        emit(out, 1)
