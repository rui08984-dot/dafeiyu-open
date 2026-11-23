# ocr_find.py —— 屏幕找字并返回坐标（game_control click_text 的眼睛）。
# 取像/识别三档：
#   整屏：python ocr_find.py <关键词>              （默认，全屏 ImageGrab(all_screens=True)，物理像素；覆盖所有显示器）
#   单窗：python ocr_find.py <关键词> --window <标题子串>
#         PrintWindow(PW_RENDERFULLCONTENT) 只截目标窗客户区——省整屏开销，且能截「被遮挡/部分在屏外」的窗口；
#         OCR 坐标加回窗口原点换算成屏幕坐标，点击侧无感。
#   单窗+区域（rec-only）：python ocr_find.py <关键词> --window <标题> --rect x,y,w,h
#         跳过检测模型（det），只把该矩形送识别模型（rec）——单行文字 1s 级 → 0.1s 级。
#         --rect 坐标系：**窗口外框**左上角为 (0,0) 的物理像素，与 pet-core
#         `{"cmd":"windows","filter":...}` 返回的 x/y/w/h、wgc_shot 的图同一坐标系；
#         没有 --window 时 --rect 按整屏**绝对物理坐标**算（all_screens 图原点可能是负的，
#         内部会先减去 virtual_screen 原点再裁）。
#         rec-only 不分行：一个矩形 = 一个文字块（hits 的 x/y 是矩形中心），矩形里有多行
#         文字会被合成一行——要按行定位就自己按行切矩形。
# DPI：进程启动即声明 per-monitor DPI 感知。不声明的话，本机 2560x1440@150% 下
#      GetClientRect/ClientToScreen/PrintWindow 全是**逻辑像素**（窗口 1194x929 报 796x619），
#      与 pet-core / UIA / WGC / SendInput 的物理像素差 1.5 倍 —— 点击会偏 150px 量级。
# 输出：{"found":bool,"mode":"full"|"rect","hits":[{"text","x","y","w","h"}],"all":"...",
#        "scope":...,"rect_img":[x,y,w,h],"dpi":144,"ocr_ms":N,"ms":N}；失败带 "error"。
# 依赖：rapidocr_onnxruntime + PIL + numpy（本机已有）。
import json
import sys
import time

DPI_MODE = 'unknown'
DPI = 0
DET_LIMIT_SIDE = 736


def virtual_screen_rect():
    """虚拟屏矩形（物理像素）：(x, y, w, h)。

    GetSystemMetrics 76..79 = SM_XVIRTUALSCREEN / Y / CX / CY。
    多显示器时原点不一定是 (0,0)：左侧副屏时 x 为负数 —— 这正是「全屏只抓主屏」
    时副屏文字永远找不到、而 grab(all_screens=True) 后坐标又差一个原点的原因。
    """
    import ctypes
    user32 = ctypes.windll.user32
    return (int(user32.GetSystemMetrics(76)), int(user32.GetSystemMetrics(77)),
            int(user32.GetSystemMetrics(78)), int(user32.GetSystemMetrics(79)))


def enable_dpi_awareness():
    """声明进程 DPI 感知（必须在任何窗口/GDI 调用之前）。

    返回模式字符串，同时写全局 DPI_MODE/DPI：失败会体现在输出的 "dpi" 字段里，不静默。
    """
    global DPI_MODE, DPI
    import ctypes
    user32 = ctypes.windll.user32
    tried = []
    mode = None
    try:
        # -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2（Win10 1703+）
        if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            mode = 'per-monitor-v2'
    except Exception as e:
        tried.append('SetProcessDpiAwarenessContext(%s)' % type(e).__name__)
    if mode is None:
        try:
            if int(ctypes.windll.shcore.SetProcessDpiAwareness(2)) == 0:   # PROCESS_PER_MONITOR_DPI_AWARE
                mode = 'per-monitor'
            else:
                tried.append('SetProcessDpiAwareness(nonzero-hr)')
        except Exception as e:
            tried.append('SetProcessDpiAwareness(%s)' % type(e).__name__)
    if mode is None:
        try:
            if user32.SetProcessDPIAware():                                 # Vista+ 兜底（system aware）
                mode = 'system'
            else:
                tried.append('SetProcessDPIAware(0)')
        except Exception as e:
            tried.append('SetProcessDPIAware(%s)' % type(e).__name__)
    DPI_MODE = mode or ('failed(' + '; '.join(tried or ['?']) + ')')
    try:
        DPI = int(user32.GetDpiForSystem())     # 96 = 仍是 unaware；144 = 150%
    except Exception:
        DPI = 0
    return DPI_MODE


def find_window(title_sub):
    """按标题子串找可见窗口（同标题多个时取标题最长的那个）。返回 (hwnd, title)。"""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    target = {'hwnd': 0, 'title': ''}
    title_sub_l = title_sub.lower()

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def on_window(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if title_sub_l in buf.value.lower() and n > len(target['title']):
            target['hwnd'] = hwnd
            target['title'] = buf.value
        return True

    user32.EnumWindows(on_window, 0)
    return target['hwnd'], target['title']


def capture_client(hwnd):
    """PrintWindow(PW_RENDERFULLCONTENT) 截客户区（物理像素）。

    返回 dict(img, client_x, client_y, w, h, frame=(left, top, w, h))；失败返回 None。
    client_* 是客户区左上角的**屏幕物理坐标**，frame 是**窗口外框**矩形（GetWindowRect）。
    """
    import ctypes
    from ctypes import wintypes

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
                    ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
                    ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
                    ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', wintypes.DWORD * 3)]

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    # 客户区尺寸（含边框会点偏——点击目标是客户区内容）
    rect = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w < 10 or h < 10:
        return None
    pt = wintypes.POINT()
    user32.ClientToScreen(hwnd, ctypes.byref(pt))
    frame_r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(frame_r))
    frame = (frame_r.left, frame_r.top, frame_r.right - frame_r.left, frame_r.bottom - frame_r.top)

    hdc_window = user32.GetWindowDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_window)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_window, w, h)
    gdi32.SelectObject(hdc_mem, hbmp)
    # PW_RENDERFULLCONTENT(2)：DWM 合成窗（含 Chromium/被遮挡窗）也能截
    ok = user32.PrintWindow(hwnd, hdc_mem, 2)
    from PIL import Image
    img = None
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
        img = Image.frombuffer('RGB', (w, h), buf.raw, 'raw', 'BGRX', 0, 1)
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_window)
    if not ok or img is None:
        return None
    return {'img': img, 'client_x': pt.x, 'client_y': pt.y, 'w': w, 'h': h, 'frame': frame}


def grab_window(title_sub):
    """兼容旧接口：返回 (PIL.Image, 客户区屏幕x, 客户区屏幕y) 或 None。"""
    hwnd, _ = find_window(title_sub)
    if not hwnd:
        return None
    cap = capture_client(hwnd)
    if cap is None:
        return None
    return cap['img'], cap['client_x'], cap['client_y']


def det_kwargs(w, h):
    """Det 限长策略（本机 RapidOCR 默认 Det.limit_side_len=736, limit_type=min）。

    min 的语义是「把短边拉到 736」：400x60 的短边会被放大 12.3 倍（面积约 150 倍）再送检测，
    小图反而更慢。但把 max 无条件打开会**缩小大图**：实测同一张 1189x740 窗口图，
    文字块 45 → 36（多行被合并），这是质量退化，不能无脑改。

    本机实测（同一张图交替跑，排除机器抖动；文字块数=检出条数）：
      · 470x64 单行条（7.3:1）：默认 2719ms / 5 块 → 原生 316ms / 5 块（文字完全一致）
      · 400x60 单行条（6.7:1）：默认 1977ms / 4 块 → 原生 281ms / 4 块（文字完全一致）
      · 500x100（5:1）原生丢过一块；370x100、510x300 原生会把多行合并（7 块 → 1~4 块）
    所以只在「横向单行条」（短边 < 736 且宽 >= 6×高）时改成原生尺寸；其余保持默认 min
    —— 正常窗口/多行区域零回归，丢块风险留给 --rect（rec-only，按行切矩形）。
    """
    if min(w, h) >= DET_LIMIT_SIDE:
        return {}
    if w < 6 * h:
        return {}
    # max + limit=长边 = 不缩放（原生像素送检测）：det_limit_type 单独传会触发 1.2.3 里
    # UpdateParameters.update_det_params 的 det_dict['model_path'] KeyError，必须带上 model_path。
    return {'det_limit_type': 'max', 'det_limit_side_len': int(max(w, h)), 'det_model_path': None}


def rect_to_image(rect, frame, client_x, client_y, img_w, img_h):
    """把 --rect（相对窗口外框左上角）换算成截图（客户区）像素，并夹到图内。

    返回 (x0, y0, x1, y1, 实际 rect)；裁不出有效区域时返回 (None, None, None, None, None)。
    截图是客户区，客户区左上角在外框内可能有偏移（标题栏/边框），必须减掉。
    """
    rx, ry, rw, rh = rect
    if frame is not None:
        rx = rx + frame[0] - client_x
        ry = ry + frame[1] - client_y
    x0, y0 = max(0, rx), max(0, ry)
    x1, y1 = min(img_w, rx + rw), min(img_h, ry + rh)
    if x1 - x0 < 8 or y1 - y0 < 8:
        return None, None, None, None, (rx, ry, rw, rh)
    return x0, y0, x1, y1, (rx, ry, rw, rh)


def parse_args(argv):
    """--window <v> / --rect x,y,w,h（支持 --k=v）/ --all 开关；其余位置参数当关键词。"""
    opts = {'window': '', 'rect': '', 'all': False, 'rest': []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == '--all':
            opts['all'] = True
        elif a in ('--window', '--rect'):
            if i + 1 >= len(argv):
                raise ValueError('%s 后面缺值' % a)
            opts[a[2:]] = argv[i + 1]
            i += 1
        elif a.startswith('--window=') or a.startswith('--rect='):
            k, v = a[2:].split('=', 1)
            opts[k] = v
        elif a in ('-h', '--help'):
            raise ValueError('用法: ocr_find.py <关键词> [--window 标题] [--rect x,y,w,h] [--all]')
        else:
            opts['rest'].append(a)
        i += 1
    return opts


def parse_rect(s):
    """'x,y,w,h'（也吃中文逗号）→ (x, y, w, h)，全部整数物理像素。"""
    parts = [p.strip() for p in str(s).replace('，', ',').split(',')]
    if len(parts) != 4:
        raise ValueError('--rect 需要 4 个整数：x,y,w,h；收到 %r' % s)
    try:
        x, y, w, h = [int(round(float(p))) for p in parts]
    except ValueError:
        raise ValueError('--rect 里有非数字：%r' % s)
    if w <= 0 or h <= 0:
        raise ValueError('--rect 的宽高必须 > 0；收到 %r' % s)
    return x, y, w, h


def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    if code:
        sys.exit(code)


def main():
    t_start = time.perf_counter()
    enable_dpi_awareness()
    try:
        opts = parse_args(sys.argv[1:])
    except ValueError as e:
        emit({'found': False, 'mode': None, 'error': str(e)}, 1)
        return
    mode = 'rect' if opts['rect'] else 'full'
    needle = opts['rest'][0] if opts['rest'] else ''
    window_title = opts['window']

    try:
        want_rect = parse_rect(opts['rect']) if opts['rect'] else None
    except ValueError as e:
        emit({'found': False, 'mode': mode, 'error': str(e)}, 1)
        return

    origin_x = origin_y = 0
    vs_rect = None
    frame = None
    if window_title:
        hwnd, _title = find_window(window_title)
        if not hwnd:
            emit({'found': False, 'mode': mode, 'error': '没找到可截的窗口（标题要写一部分；窗口最小化或 0 尺寸）',
                  'scope': window_title}, 1)
            return
        cap = capture_client(hwnd)
        if cap is None:
            emit({'found': False, 'mode': mode, 'error': '窗口截图失败（PrintWindow 返回空或尺寸为 0）',
                  'scope': window_title}, 1)
            return
        img = cap['img']
        origin_x, origin_y = cap['client_x'], cap['client_y']
        frame = cap['frame']
    else:
        # 2026-11-21 P2：全屏必须抓**虚拟屏**（所有显示器），否则副屏上的文字永远找不到。
        # all_screens=True 的图像原点 = 虚拟屏左上角 (SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN)，
        # 不一定是 (0,0)；hits 的屏幕绝对坐标必须把这个原点加回去（origin_x/origin_y）。
        from PIL import ImageGrab
        img = ImageGrab.grab(all_screens=True)
        vs_rect = virtual_screen_rect()
        origin_x, origin_y = vs_rect[0], vs_rect[1]

    img_w, img_h = img.size
    crop_box = None
    rect_img = None
    if want_rect is not None:
        # 全屏模式的 --rect 是**绝对物理坐标**，而 all_screens 截图的原点是虚拟屏左上角
        # （可能是负坐标）—— 先减去原点再裁，否则左侧/上方副屏的矩形会裁到主屏内容。
        rect_for_image = want_rect
        if not window_title:
            rect_for_image = (want_rect[0] - origin_x, want_rect[1] - origin_y, want_rect[2], want_rect[3])
        x0, y0, x1, y1, conv = rect_to_image(rect_for_image, frame, origin_x, origin_y, img_w, img_h)
        if x0 is None:
            emit({'found': False, 'mode': mode,
                  'error': '--rect 裁不出有效区域（换算到截图后 x=%d,y=%d,w=%d,h=%d，截图 %dx%d）'
                           % ((conv or (0, 0, 0, 0)) + (img_w, img_h)),
                  'rect_given': list(want_rect), 'scope': window_title or 'screen'}, 1)
            return
        crop_box = (x0, y0, x1, y1)
        rect_img = [x0, y0, x1 - x0, y1 - y0]

    import numpy as np
    arr = np.array(img)
    if crop_box is not None:
        x0, y0, x1, y1 = crop_box
        arr = arr[y0:y1, x0:x1]
    else:
        x0 = y0 = 0
    h, w = arr.shape[:2]

    from rapidocr_onnxruntime import RapidOCR
    if want_rect is not None:
        # rec-only：不建检测器、也不建方向分类器（小矩形里的 UI 文字不会有 180° 倒置）
        ocr = RapidOCR(use_text_det=False, use_angle_cls=False)
    else:
        kwargs = det_kwargs(w, h)
        ocr = RapidOCR(**kwargs) if kwargs else RapidOCR()
    t_ocr0 = time.perf_counter()
    result, _elapse = ocr(arr)
    ocr_ms = (time.perf_counter() - t_ocr0) * 1000

    hits, alltexts = [], []
    if result:
        for box, text, score in result:
            alltexts.append(str(text))
            # --all：不筛关键词，返回全部文字块（SoM 兜底：UIA 失明时靠 OCR 出编号）
            if opts['all'] or (needle and needle.lower() in str(text).lower()):
                xs = [p[0] for p in box]
                ys = [p[1] for p in box]
                cx, cy = int(sum(xs) / 4), int(sum(ys) / 4)
                hits.append({'text': str(text), 'x': cx + x0 + origin_x, 'y': cy + y0 + origin_y,
                             'w': int(max(xs) - min(xs)), 'h': int(max(ys) - min(ys))})
    limit = 60 if opts['all'] else 5
    emit({'found': bool(hits), 'mode': mode, 'hits': hits[:limit],
          'all': ' | '.join(alltexts)[:600], 'scope': window_title or 'screen',
          'rect_img': rect_img, 'rect_given': list(want_rect) if want_rect else None,
          'img': [img_w, img_h], 'dpi': DPI, 'dpi_mode': DPI_MODE,
          # 取像口径（2026-11-21 P2）：全屏 = all_screens（虚拟屏并集），原点见 virtual_screen。
          'all_screens': vs_rect is not None,
          'virtual_screen': list(vs_rect) if vs_rect else None,
          'origin': [origin_x, origin_y],
          'ocr_ms': int(ocr_ms), 'ms': int((time.perf_counter() - t_start) * 1000)})


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        import traceback
        print(json.dumps({'found': False, 'mode': None,
                          'error': '%s: %s' % (type(e).__name__, e),
                          'trace': traceback.format_exc()[-1000:]}, ensure_ascii=False))
        sys.exit(1)
