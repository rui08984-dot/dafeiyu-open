#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""visual_enhance.py —— 通用视觉增强四件套（不依赖游戏 Mod / 不依赖模板）

为什么要有这个（用户拍板）：模板匹配只能找"见过的按钮"，遇到新游戏/新界面就瞎。
这四个工具从画面里**推出结构**，事先什么都不用准备：
  numbers  —— 数字区读取（阳光/血量/金币/波次）：rec-only OCR，8ms 级
  bars     —— 血条/进度条/蓄力条：固定颜色 + 细长色块，任何游戏通用
  grid     —— 网格差分（哪个格子有东西）：存空场基准，之后逐格比对
  buttons  —— 通用"像按钮的区域"：轮廓检测，新游戏没模板时的兜底

坐标系约定（与 visual_locate.py / click_at 完全一致）：
  · --region/--grid 的坐标都是**窗口内相对坐标**（窗口左上角 = 0,0），单位 = 物理像素
  · 输出的 x/y 是**屏幕物理坐标**（= 窗口偏移 + 图内坐标），可直接喂 click_at
  · 截图优先 WGC（穿透遮挡），失败回落 PrintWindow（带 DPI 感知 + 可信度自检）

依赖：cv2 5.0、numpy、rapidocr_onnxruntime 1.2.3（仅 numbers 用）、pet-core。
不依赖 torch / PIL。
"""

import argparse
import ctypes
import json
import os
import re
import sys
import time

import numpy as np
import cv2

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import visual_locate as vl  # noqa: E402  复用 resolve_window / capture_window / emit / DPI

vl.enable_dpi_awareness()

# ── RapidOCR（懒加载：只有 numbers 子命令才付 import 成本 ~800ms）─────────────
_OCR_REC = None
_OCR_FULL = None


def _ocr_rec():
    """rec-only 引擎：不建检测器（小区域里的 UI 文字不会有 180° 倒置）。"""
    global _OCR_REC
    if _OCR_REC is None:
        from rapidocr_onnxruntime import RapidOCR
        _OCR_REC = RapidOCR(use_text_det=False, use_angle_cls=False)
    return _OCR_REC


def _ocr_full():
    """带检测的全窗引擎（auto 找数字区时用一次）。"""
    global _OCR_FULL
    if _OCR_FULL is None:
        from rapidocr_onnxruntime import RapidOCR
        _OCR_FULL = RapidOCR()
    return _OCR_FULL


_NUM_RE = re.compile(r'^[\s]*[+\-]?\d[\d,，.\s]*[%％个万千百十]{0,2}[\s]*$')


def _as_number(text):
    """'1,234' / '97%' / '12万' → 数值 or None。纯启发式，认不出就 None，不硬凑。"""
    t = str(text or '').strip()
    if not t:
        return None
    m = re.match(r'^[+\-]?([\d,，]+(?:\.\d+)?)(万|千)?\s*[%％]?$', t.replace(' ', ''))
    if not m:
        return None
    try:
        v = float(m.group(1).replace(',', '').replace('，', ''))
        unit = m.group(2)
        if unit == '万':
            v *= 10000
        elif unit == '千':
            v *= 1000
        return v
    except ValueError:
        return None


# ── ① numbers：数字区读取 ────────────────────────────────────────────────────
def cmd_numbers(win, region, auto_scan, min_score):
    cap = vl.capture_window(win)
    img = cap['img']
    H, W = img.shape[:2]
    out = {
        'mode': 'numbers', 'via': cap['via'], 'img_size': [W, H],
        'origin': [cap['origin_x'], cap['origin_y']],
        'capture_ms': cap['capture_ms'], 'found': False, 'values': [], 'error': None,
    }
    t0 = time.perf_counter()

    if region:
        rx, ry, rw, rh = region
        if rw < 8 or rh < 8 or rx < 0 or ry < 0 or rx + rw > W or ry + rh > H:
            raise ValueError('--region 非法：%r（图 %dx%d）—— 坐标是窗口内相对物理像素' % (region, W, H))
        crop = img[ry:ry + rh, rx:rx + rw]
        res, _ = _ocr_rec()(crop)
        items = []
        if res:
            for box, text, score in res:
                s = float(score)
                if s < min_score:
                    continue
                v = _as_number(text)
                item = {'text': str(text), 'score': round(s, 3),
                        'region': [rx, ry, rw, rh], 'number': v}
                if v is not None:
                    out['found'] = True
                items.append(item)
        out['values'] = items
    elif auto_scan:
        # 全窗 det+rec，筛"纯数字"块（慢：整窗 OCR 2-7s，但不用知道数字在哪）
        res, _ = _ocr_full()(img)
        items = []
        if res:
            for box, text, score in res:
                s = float(score)
                if s < min_score:
                    continue
                v = _as_number(text)
                if v is None:
                    continue
                xs = [p[0] for p in box]
                ys = [p[1] for p in box]
                bx, by = int(min(xs)), int(min(ys))
                bw, bh = int(max(xs)) - bx, int(max(ys)) - by
                items.append({'text': str(text), 'score': round(s, 3), 'number': v,
                              'region': [bx, by, bw, bh],
                              'screen': [cap['origin_x'] + bx, cap['origin_y'] + by]})
        out['values'] = items
        out['found'] = bool(items)
    else:
        raise ValueError('numbers 需要 --region 或 --auto（二选一）')

    out['ms'] = int((time.perf_counter() - t0) * 1000)
    return out


# ── ② bars：血条 / 进度条 / 蓄力条 ───────────────────────────────────────────
# 血条的物理特征：细长（宽 ≥ 1.5×高）、颜色饱和且内部一致、有明确边界。
# HSV 范围按 OpenCV 惯例（H 0-179）。
_BAR_COLORS = {
    # ⚠ 2026-11-10 修手误：red 第一段原来是 (0,120,90,179,255,255) —— H 写成了 0-179，
    # 等于"所有饱和色"，实测把绿条/红条/蓝按钮全部判成 red。真红是 H 0-10（+品红 170-179）。
    'red':   [(0, 120, 90, 10, 255, 255), (170, 120, 90, 179, 255, 255)],
    'green': [(35, 80, 80, 90, 255, 255)],
    'blue':  [(95, 80, 80, 135, 255, 255)],
    'yellow': [(18, 90, 90, 34, 255, 255)],
    'purple': [(135, 60, 60, 165, 255, 255)],
}


def cmd_bars(win, color, min_len, min_thick):
    cap = vl.capture_window(win)
    img = cap['img']
    H, W = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    t0 = time.perf_counter()

    keys = [color] if color != 'auto' else list(_BAR_COLORS.keys())
    bars = []
    for key in keys:
        mask = None
        for (h1, s1, v1, h2, s2, v2) in _BAR_COLORS[key]:
            m = cv2.inRange(hsv, np.array([h1, s1, v1]), np.array([h2, s2, v2]))
            mask = m if mask is None else (mask | m)
        if mask is None or not mask.any():
            continue
        # 开运算去噪点，闭运算补断条
        kern = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 3))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kern)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kern)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        for i in range(1, n):
            x, y, w, h, area = (int(stats[i, k]) for k in range(5))
            if w < min_len or h < min_thick or h * 3 > W:   # 排除整屏色块
                continue
            if w < 1.2 * h:                                  # 血条是横条；竖条另算（未来可加）
                continue
            sub = (labels[y:y + h, x:x + w] == i)
            # fill：血条"剩多少"必须相对**槽的满宽**，而不是色块自己的包围盒
            # （连通域的包围盒就是填充色块本身，直接算永远 ≈1.0 —— 第一版实测就这么错的）。
            # 槽 = 色块两侧的暗色背景：从色块左右边界向外逐像素扫 V 通道，
            # 亮度 > 90 就算出了槽（槽背景 V 低，槽外是正常画面）。
            sat_all = hsv[:, :, 1]
            val_all = hsv[:, :, 2]
            mid_y = y + h // 2

            def _slot_edge(x_start, step):
                limit = 3 * w + 20
                px = x_start
                for _ in range(limit):
                    px += step
                    if px < 0 or px >= W:
                        break
                    v_px = int(val_all[mid_y, px])
                    if v_px > 90:   # 槽外有亮内容 → 到头了
                        break
                return px

            left_slot = _slot_edge(x, -1)
            right_slot = _slot_edge(x + w - 1, +1)
            slot_w = max(w, right_slot - left_slot - 1)
            rows = []
            for r in range(h):
                row = sub[r]
                if not row.any():
                    continue
                idx = np.where(row)[0]
                rows.append(idx[-1] - idx[0] + 1)
            fill = float(np.median(rows)) / slot_w if rows and slot_w > 0 else 0.0
            mean_sat = float(hsv[y:y + h, x:x + w, 1][sub].mean()) if sub.any() else 0.0
            bars.append({
                'color': key, 'region': [x, y, w, h],
                'screen': [cap['origin_x'] + x, cap['origin_y'] + y],
                'fill_ratio': round(min(1.0, fill), 3),
                'slot_w': slot_w, 'bar_w': w,
                'mean_sat': round(mean_sat, 1),
                'area': area,
            })
    bars.sort(key=lambda b: -b['area'])
    return {
        'mode': 'bars', 'via': cap['via'], 'img_size': [W, H],
        'origin': [cap['origin_x'], cap['origin_y']],
        'capture_ms': cap['capture_ms'], 'found': bool(bars), 'bars': bars[:24],
        'ms': int((time.perf_counter() - t0) * 1000), 'error': None,
    }


# ── ③ grid：网格差分（哪格有东西）───────────────────────────────────────────
def _grid_baseline_path(win, rows, cols):
    safe = re.sub(r'[\\/:*?"<>| ]', '_', str(win.get('title', 'win')))[:40]
    d = os.path.join(_HERE, '..', 'knowledge', 'grid-baseline')
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, '%s_%dx%d.json' % (safe, rows, cols))


def _cell_features(img, x, y, w, h):
    cell = img[y:y + h, x:x + w]
    gray = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 60, 160)
    return {
        'mean': float(gray.mean()),
        'std': float(gray.std()),
        'edge': float(edges.mean()),
    }


def cmd_grid(win, rows, cols, action, thresh, inset):
    cap = vl.capture_window(win)
    img = cap['img']
    H, W = img.shape[:2]
    if rows < 1 or cols < 1 or rows > 30 or cols > 30:
        raise ValueError('--grid 行,列 要在 1..30：收到 %d,%d' % (rows, cols))
    t0 = time.perf_counter()
    # 网格区域：默认居中估算只对"正好铺满"的游戏成立。
    # 实测教训（tkinter 5×9）：估算 inset 和真实网格差 1.4 倍 → 列偏 1-2 格。
    # 所以 --inset 必须可标定：x%,y%,w%,h%（窗口内的比例），PVZ 草坪用 4.5,13.5,90.5,72。
    if inset:
        ix, iy, iw, ih = (float(v) for v in inset)
        if not (0 <= ix < 100 and 0 <= iy < 100 and iw > 0 and ih > 0 and ix + iw <= 100 and iy + ih <= 100):
            raise ValueError('--inset 要 x,y,w,h 四个百分比（0-100），收到 %r' % (inset,))
    else:
        ix, iy, iw, ih = 11.0, 19.0, 78.0, 62.0
    gx0, gy0 = int(W * ix / 100), int(H * iy / 100)
    gw, gh = int(W * iw / 100), int(H * ih / 100)
    cw, ch = gw / cols, gh / rows
    cells = []
    for r in range(rows):
        for c in range(cols):
            x = int(gx0 + c * cw)
            y = int(gy0 + r * ch)
            f = _cell_features(img, x, y, int(cw), int(ch))
            cells.append({'row': r + 1, 'col': c + 1,
                          'region': [x, y, int(cw), int(ch)],
                          'screen': [cap['origin_x'] + x, cap['origin_y'] + y], **f})
    if action == 'save':
        path = _grid_baseline_path(win, rows, cols)
        payload = {'window': str(win.get('title')), 'rows': rows, 'cols': cols,
                   'saved_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                   'img_size': [W, H], 'cells': cells}
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        return {'mode': 'grid', 'action': 'save', 'path': os.path.abspath(path),
                'cells': rows * cols, 'img_size': [W, H],
                'ms': int((time.perf_counter() - t0) * 1000), 'error': None}
    # diff
    path = _grid_baseline_path(win, rows, cols)
    if not os.path.exists(path):
        raise ValueError('还没有基准：先跑 --baseline save（路径 %s）' % path)
    with open(path, 'r', encoding='utf-8') as f:
        base = json.load(f)
    if base.get('img_size') != [W, H]:
        raise ValueError('窗口尺寸变了（基准 %r vs 现在 %r）—— 重新 save 一次'
                         % (base.get('img_size'), [W, H]))
    occupied = 0
    for i, c in enumerate(cells):
        b = base['cells'][i]
        d_std = abs(c['std'] - b['std'])
        d_mean = abs(c['mean'] - b['mean'])
        d_edge = abs(c['edge'] - b['edge'])
        c['delta'] = round(max(d_std, d_mean * 0.8, d_edge * 1.5), 1)
        c['occupied'] = bool(c['delta'] > thresh)
        occupied += 1 if c['occupied'] else 0
    hot = sorted([c for c in cells if c['occupied']], key=lambda c: -c['delta'])
    return {
        'mode': 'grid', 'action': 'diff', 'rows': rows, 'cols': cols,
        'img_size': [W, H], 'origin': [cap['origin_x'], cap['origin_y']],
        'occupied_count': occupied, 'cells': cells,
        'top': hot[:12],
        'ms': int((time.perf_counter() - t0) * 1000), 'error': None,
    }


# ── ④ buttons：通用"像按钮的区域" ────────────────────────────────────────────
def cmd_buttons(win, max_results):
    cap = vl.capture_window(win)
    img = cap['img']
    H, W = img.shape[:2]
    t0 = time.perf_counter()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    win_area = float(W * H)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
    cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cands = []
    for cnt in cnts:
        x, y, w, h = cv2.boundingRect(cnt)
        area = w * h
        ratio = area / win_area
        if w < 40 or h < 22 or w > W * 0.9 or h > H * 0.9:
            continue
        if ratio < 0.002 or ratio > 0.25:
            continue
        ar = w / float(h)
        if ar < 1.0 or ar > 10.0:
            continue
        # 轮廓接近矩形的程度
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)
        rectness = 1.0 if 4 <= len(approx) <= 8 else max(0.0, 1.0 - abs(len(approx) - 6) / 12.0)
        # 内部颜色一致性（按钮内部通常比背景均匀）
        sub = gray[y + 2:y + h - 2, x + 2:x + w - 2]
        if sub.size == 0:
            continue
        uniformity = max(0.0, 1.0 - float(sub.std()) / 90.0)
        score = rectness * 0.45 + uniformity * 0.4 + min(1.0, ratio * 30) * 0.15
        cands.append({
            'region': [x, y, w, h],
            'screen': [cap['origin_x'] + x, cap['origin_y'] + y],
            'area_ratio': round(ratio, 4), 'aspect': round(ar, 2),
            'rectness': round(rectness, 2), 'uniformity': round(uniformity, 2),
            'score': round(score, 3),
        })
    cands.sort(key=lambda c: -c['score'])
    return {
        'mode': 'buttons', 'via': cap['via'], 'img_size': [W, H],
        'origin': [cap['origin_x'], cap['origin_y']],
        'capture_ms': cap['capture_ms'], 'found': bool(cands),
        'candidates': cands[:max_results],
        'ms': int((time.perf_counter() - t0) * 1000), 'error': None,
    }


# ── CLI ──────────────────────────────────────────────────────────────────────
def parse_region(s):
    parts = [p.strip() for p in str(s).split(',')]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError('--region 要 4 个整数 x,y,w,h')
    try:
        v = [int(p) for p in parts]
    except ValueError:
        raise argparse.ArgumentTypeError('--region 要整数')
    return v


def build_parser():
    p = argparse.ArgumentParser(description='通用视觉增强四件套')
    sub = p.add_subparsers(dest='cmdname', required=True)

    q = sub.add_parser('numbers', help='数字区读取')
    q.add_argument('--window', required=True)
    q.add_argument('--region', type=parse_region, default=None, help='x,y,w,h（窗口内物理像素）')
    q.add_argument('--auto', action='store_true', help='全窗扫"纯数字"块（慢，2-7s）')
    q.add_argument('--min-score', type=float, default=0.6)

    b = sub.add_parser('bars', help='血条/进度条')
    b.add_argument('--window', required=True)
    b.add_argument('--color', default='auto', choices=['auto'] + list(_BAR_COLORS.keys()))
    b.add_argument('--min-len', type=int, default=36)
    b.add_argument('--min-thick', type=int, default=6)

    g = sub.add_parser('grid', help='网格差分')
    g.add_argument('--window', required=True)
    g.add_argument('--grid', default='5,9')
    g.add_argument('--baseline', choices=['save', 'diff'], required=True)
    g.add_argument('--thresh', type=float, default=18.0)
    g.add_argument('--inset', default=None, help='网格区域 x,y,w,h（窗口内百分比），如 PVZ: 4.5,13.5,90.5,72')

    u = sub.add_parser('buttons', help='通用按钮候选')
    u.add_argument('--window', required=True)
    u.add_argument('--max', type=int, default=20)
    return p


def main():
    args = build_parser().parse_args()
    try:
        win = vl.resolve_window(args.window)
        if args.cmdname == 'numbers':
            out = cmd_numbers(win, args.region, args.auto, args.min_score)
        elif args.cmdname == 'bars':
            out = cmd_bars(win, args.color, args.min_len, args.min_thick)
        elif args.cmdname == 'grid':
            rows, cols = (int(x) for x in str(args.grid).replace('，', ',').split(','))
            out = cmd_grid(win, rows, cols, args.baseline, args.thresh,
                           [float(v) for v in str(args.inset).split(',')] if args.inset else None)
        else:
            out = cmd_buttons(win, args.max)
        vl.emit(out)
    except ValueError as e:
        vl.emit({'ok': False, 'error': str(e)}, code=1)
    except Exception as e:   # noqa: BLE001 —— CLI 边界，错误必须进 JSON 而不是 traceback
        vl.emit({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, code=1)


if __name__ == '__main__':
    main()
