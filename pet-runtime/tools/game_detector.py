#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""game_detector.py — 常驻视觉检测器（2026-11-14 四十九轮续）

纯视觉游戏操作的 L1 感知层：读一帧 raw BGRA + 一组 ROI 规则，输出结构化 GameState。

## 为什么常驻
`import cv2` 一次 ~750ms，每次新进程 = 每秒最多 1 次检测。
常驻后单帧检测 5–20ms（ROI 限定 + 只在需要时降采样）。
配合 pet-core 的常驻抓帧（1.8ms/帧），端到端能到 **10–30ms**。

## 协议（和 `pet-core serve` 同款：一行一个 JSON）
请求：
```
{"path":"<user-home>/pet-game/frame.bgra", "w":1311, "h":877,
 "bars":  {"hp":   {"roi":[0.02,0.88,0.18,0.03], "color":"red"}},
 "gray":  {"skill2":{"roi":[0.60,0.93,0.04,0.04], "min":0.35}},
 "colors":{"enemy":{"roi":[0.2,0.1,0.6,0.7], "color":"red", "min_area":0.001}}}
```
响应：
```
{"ok":true, "bars":{"hp":0.72}, "gray":{"skill2":1},
 "colors":{"enemy":{"area":0.013,"cx":0.52,"cy":0.41,"count":1}},
 "ms":6}
```

## 设计取舍
- ROI 一律用**比例**（0–1），换分辨率不用改 profile
- 血条用「从左数连续命中列」而不是连通域 —— 血条都是从左往右掉的，
  这个算法 O(w) 且不需要连通域（省 5–10ms）
- `colors` 用命中像素的比例 + 质心（找敌人大致方位），不做精确框选
  （要精确框就去上 YOLO，那是 P2）
"""
import json
import sys
import time
import os

import numpy as np

# ── 颜色表（HSV，OpenCV 惯例 H 0-179）────────────────────────────────────────
# 和 visual_enhance.py 的 _BAR_COLORS 保持一致（同一条经验：红是 H 0-10 + 170-179）
COLORS = {
    'red':    [(0, 120, 90, 10, 255, 255), (170, 120, 90, 179, 255, 255)],
    'green':  [(35, 80, 80, 90, 255, 255)],
    'blue':   [(95, 80, 80, 135, 255, 255)],
    'yellow': [(18, 90, 90, 34, 255, 255)],
    'purple': [(135, 60, 60, 165, 255, 255)],
    'white':  [(0, 0, 200, 179, 40, 255)],
    # 2026-11-14 五十三轮（P2 遗留）：MC 心形的**五种状态色**。
    # 实测（从 1.21.1.jar 的 hud/heart/*.png 量的 HSV）：
    #   红(hardcore/普通)  S229 V241 / 中毒(olive) S216 V137 / 吸收(金) S200 V212 /
    #   冰冻(青) S145 V234 —— 全都在 S>120 & V>90 这一带；
    #   凋灵黑 S72 V51 明显在带外（→ 读不到 → valid=false → 暂停，而不是当成「血空了」）。
    # 原来只认红：中毒/吸收/冰冻一开，红检测归零 → 假死亡。
    'heart': [
        (0, 120, 90, 10, 255, 255), (170, 120, 90, 179, 255, 255),   # 红
        (11, 120, 90, 45, 255, 255),                                  # 橙/金/中毒
        (85, 120, 90, 105, 255, 255),                                 # 青/冰冻
    ],
}

_cv2 = None
# 运动检测的上一帧（按 ROI 的 key 缓存）。常驻进程才有意义 —— 每帧新进程时它是空的。
_prev_gray = {}
_prev_blobs = {}   # key → 上一帧的连通域列表（多帧持久性判定用）
_prev_mask = {}    # key → 累积运动掩码（带衰减，解决「慢速目标帧差只有边缘」）


def cv2():
    """懒加载 cv2（非 serve 模式下不调就不付出 import 成本）。"""
    global _cv2
    if _cv2 is None:
        import cv2 as _m
        _cv2 = _m
    return _cv2


def _roi_px(roi, W, H):
    """比例 ROI → 像素 (x0, y0, w, h)，并夹到画面内。"""
    x, y, w, h = (float(v) for v in roi)
    x0 = max(0, min(W - 1, int(W * x)))
    y0 = max(0, min(H - 1, int(H * y)))
    x1 = max(x0 + 1, min(W, int(W * (x + w))))
    y1 = max(y0 + 1, min(H, int(H * (y + h))))
    return x0, y0, x1 - x0, y1 - y0


def _mask_hsv(bgr, color):
    """color 可以是名字（'red'/'heart'…）或名字列表（并集）。"""
    c = cv2()
    hsv = c.cvtColor(bgr, c.COLOR_BGR2HSV)
    names = color if isinstance(color, (list, tuple)) else [color]
    mask = None
    for name in names:
        for (h1, s1, v1, h2, s2, v2) in COLORS.get(name, []):
            m = c.inRange(hsv, np.array([h1, s1, v1]), np.array([h2, s2, v2]))
            mask = m if mask is None else (mask | m)
    return mask


def detect_bar(bgr, roi_frac, color, thr=0.5):
    """血条/进度条比例。

    算法（2026-11-14 自检抓到的两个坑都修了）：
      ① 每列命中数用**相对阈值**（相对该 ROI 里命中最多的列），
         不能用「ROI 高度 × 常数」—— 血条只是 ROI 里的一条细带，
         它每列只占 20px 而 ROI 高 100px，用 100×0.3 会把所有列判成空。
      ② 起点是**第一个命中列**，不是「ROI 最左边」。ROI 通常比血条宽一点，
         从 0 开始数会在第一个空格就停 → 恒返回 0。

    约定：**ROI 要套在血条上，且血条满头时铺满 ROI**（profile 的责任）。
    分母用「从血条起点到 ROI 右边」的宽度，所以满血 = 1.0。
    """
    H, W = bgr.shape[:2]
    x0, y0, w, h = _roi_px(roi_frac, W, H)
    crop = bgr[y0:y0 + h, x0:x0 + w]
    if crop.size == 0:
        return {'value': 0.0, 'valid': False, 'reason': 'empty-roi'}
    mask = _mask_hsv(crop, color)
    if mask is None:
        return {'value': 0.0, 'valid': False, 'reason': 'bad-color'}
    col = (mask > 0).sum(axis=0)          # 每列命中像素数
    if col.size == 0:
        return {'value': 0.0, 'valid': False, 'reason': 'empty-cols'}
    mx = int(col.max())
    if mx <= 0:
        # ⚠ 2026-11-14 审计：这里返回 0.0 让「检测不到红心」（F1 隐藏 HUD / 加载中 /
        # 创造模式 / 抓帧黑屏 / 状态效果换心色）和「血真的空了」无法区分 ——
        # 上层会把它们全当成死亡，然后一直按后退。
        # 现在返回 dict：valid=False 表示「这次读数不可信」，调用方必须当未知处理。
        return {'value': 0.0, 'valid': False, 'reason': 'no-%s-pixels' % (color,)}
    # 阈值放宽到 15%：MC 的心形上下窄，边缘列只有 2-3 个红像素，
    # 用 50% 会把它们判成「没颜色」→ 血条被切碎。
    hit = col >= max(1, int(mx * min(0.5, float(thr) * 0.3 if thr else 0.15)))
    if not hit.any():
        return 0.0
    # ⚠ 2026-11-14 真机实测抓到的算法缺陷：
    #   原来数「从第一列开始的**连续**命中」—— 这在「连成一整条的进度条」上成立，
    #   但 **MC 的血条是 10 颗分离的心形**（每颗之间 1px 间隙），数到第 1 颗就停，
    #   满血被报成 0.089（正好 1/10 颗心）。合成图测不出来（那是实心矩形）。
    #   现在用**命中列总数 / ROI 全宽**：连续条和离散图标两种都成立。
    #   前提：ROI 要正好套住血条（自标定得到的 bbox 就是），否则分母偏大、比例偏低。
    n = int(hit.sum())
    ratio = round(n / float(max(1, len(hit))), 4)
    # 命中列太少（<3 列）说明整条血条根本没找到，只有零星噪声红像素
    if n < 3:
        return {'value': ratio, 'valid': False, 'reason': 'too-few-columns', 'raw': n}
    return {'value': ratio, 'valid': True, 'raw': n}


def detect_gray(bgr, roi_frac, min_v=0.35):
    """灰度亮度：技能图标可用（亮）/ 冷却中（暗）。返回 0/1 + 均值。"""
    H, W = bgr.shape[:2]
    x0, y0, w, h = _roi_px(roi_frac, W, H)
    crop = bgr[y0:y0 + h, x0:x0 + w]
    if crop.size == 0:
        return 0, 0.0
    g = cv2().cvtColor(crop, cv2().COLOR_BGR2GRAY)
    mean = float(g.mean()) / 255.0
    return (1 if mean >= min_v else 0), round(mean, 4)


def detect_color_area(bgr, roi_frac, color, min_area=0.001):
    """颜色区域：命中像素占比 + 质心 + **包围盒**（找目标 / 自标定 ROI）。

    为什么给 bbox：这是「零配置」的关键 —— 只告诉框架「血条是红色的」，
    它自己扫一遍底部找到红色连通区域的包围盒，把 ROI 写回 profile。
    以后换分辨率/换 GUI 缩放会自动重算，不需要人工标定。
    """
    H, W = bgr.shape[:2]
    x0, y0, w, h = _roi_px(roi_frac, W, H)
    crop = bgr[y0:y0 + h, x0:x0 + w]
    if crop.size == 0:
        return {'area': 0.0, 'cx': 0.0, 'cy': 0.0}
    mask = _mask_hsv(crop, color)
    if mask is None:
        return {'area': 0.0, 'cx': 0.0, 'cy': 0.0}
    total = float(w * h)
    area = float((mask > 0).sum()) / total
    if area < min_area:
        return {'area': round(area, 4), 'cx': 0.0, 'cy': 0.0}
    ys, xs = np.nonzero(mask)
    xmin, xmax = int(xs.min()), int(xs.max())
    ymin, ymax = int(ys.min()), int(ys.max())
    return {
        'area': round(area, 4),
        # 质心换回**整帧比例坐标**（调用方要据此点鼠标）
        'cx': round((x0 + float(xs.mean())) / W, 4),
        'cy': round((y0 + float(ys.mean())) / H, 4),
        'count': int(len(xs)),
        # 包围盒（整帧比例）—— 拿来当 ROI 用
        'bbox': [
            round((x0 + xmin) / W, 4),
            round((y0 + ymin) / H, 4),
            round((xmax - xmin + 1) / W, 4),
            round((ymax - ymin + 1) / H, 4),
        ],
        # 包围盒像素尺寸（诊断用：太扁/太方说明颜色命中错了东西）
        'bbox_px': [xmax - xmin + 1, ymax - ymin + 1],
    }


def detect_motion(bgr, roi_frac, key, threshold=12, min_area=0.0005):
    """帧差找**移动物体**（2026-11-14）：MC 这类游戏没有敌人血条，
    「在动的东西」就是最可靠的敌人信号（地形不动、怪物会动）。

    需要常驻进程（要缓存上一帧）。第一帧返回 ready=False，从第二帧起有值。

    ⚠ 会误报的东西：玩家自己的手/武器（在画面右下）、飘落的粒子、草叶摆动。
    → ROI 应该排除中心+右下的手部区域，或调高 threshold。
    """
    H, W = bgr.shape[:2]
    x0, y0, w, h = _roi_px(roi_frac, W, H)
    crop = bgr[y0:y0 + h, x0:x0 + w]
    if crop.size == 0:
        return {'ready': False}
    g = cv2().cvtColor(crop, cv2().COLOR_BGR2GRAY)
    # 降采样再帧差（2026-11-14 实测）：motion 的 ROI 通常很大（整块画面），
    # 全尺寸 absdiff 要 20ms；缩到 1/4 后 1-3ms，而「怪物在动」这种信号完全够。
    # 用 INTER_NEAREST（不是 LINEAR）：帧差要保留锐利边界，插值会糊掉小目标。
    gw, gh = max(2, w // 4), max(2, h // 4)
    g = cv2().resize(g, (gw, gh), interpolation=cv2().INTER_NEAREST)
    prev = _prev_gray.get(key)
    _prev_gray[key] = g
    if prev is None or prev.shape != g.shape:
        return {'ready': False, 'note': '第一帧（无基线）'}
    diff = cv2().absdiff(g, prev)
    _, mask = cv2().threshold(diff, threshold, 255, cv2().THRESH_BINARY)
    # 开运算去噪（粒子/抗锯齿边缘）
    mask = cv2().morphologyEx(mask, cv2().MORPH_OPEN, np.ones((3, 3), np.uint8))
    total = float(gw * gh)
    area = float((mask > 0).sum()) / total
    # 降采样比例：gx → crop 像素 → 整帧像素
    sx = float(w) / float(gw)
    sy = float(h) / float(gh)
    # ── 累积运动掩码（2026-11-14 五十三轮 P2 续）────────────────────────
    # 纯帧差有个先天问题：**慢速目标只留一条边缘**（一只慢慢逼近的僵尸每帧只移动几个像素，
    # 差分出来是两条细边），连通域会碎成几块、质心乱跳。
    # 用带衰减的累积掩码（新帧权重 0.35）→ 「最近几帧动过的区域」，形状接近物体本身。
    prev_acc = _prev_mask.get(key)
    if prev_acc is not None and prev_acc.shape == mask.shape:
        acc_gray = cv2().addWeighted(prev_acc, 0.65, mask, 0.35, 0)
    else:
        acc_gray = mask.copy()
    # ⚠ 必须存**灰度**累积值：如果在存之前就二值化成 0/255，下一帧 0.65×255 又回到 166，
    #   永远掉不到阈值以下 —— 实测「静止 6 帧还留着 2 个幽灵目标」。
    _prev_mask[key] = acc_gray
    acc = cv2().threshold(acc_gray, 40, 255, cv2().THRESH_BINARY)[1]

    # 早退判据改成**累积掩码**（2026-11-14）：慢速目标这一帧只动几像素，
    # 瞬时 area 可能低于阈值，但它仍然是「在动的东西」—— 用累积掩码判才不会漏。
    if float((acc > 0).sum()) / total < min_area:
        _prev_blobs[key] = []
        return {'ready': True, 'area': round(area, 5), 'cx': 0.0, 'cy': 0.0, 'count': 0, 'blobs': []}


    # ── 连通域（2026-11-14 五十三轮 P2）─────────────────────────────────
    # 原来取**整块 mask 的平均质心**：画面里有两只怪时，质心落在两只之间的空气里，
    # 「转向并攻击」就朝着空地打。现在按连通域拆开，主目标 = 最大（且持续存在）的那块。
    # 先膨胀一次：同一只怪的头/手/脚在帧差里是几块，膨胀后连成一块。
    kernel = np.ones((3, 3), np.uint8)
    merged = cv2().dilate(acc, kernel, iterations=1)
    n_lbl, _labels, stats, cents = cv2().connectedComponentsWithStats(merged, connectivity=8)
    min_px = max(4, int(min_area * total))
    blobs = []
    for i in range(1, int(n_lbl)):
        bx, by, bw, bh, barea = (int(stats[i][0]), int(stats[i][1]), int(stats[i][2]),
                                 int(stats[i][3]), int(stats[i][4]))
        if barea < min_px:
            continue
        blobs.append({
            'cx': round((x0 + float(cents[i][0]) * sx) / W, 4),
            'cy': round((y0 + float(cents[i][1]) * sy) / H, 4),
            'area': round(barea / total, 5), 'px': barea,
            'bbox': [round((x0 + bx * sx) / W, 4), round((y0 + by * sy) / H, 4),
                     round(bw * sx / W, 4), round(bh * sy / H, 4)],
            'frames': 1, 'persistent': False,
        })
    blobs.sort(key=lambda b: -b['px'])
    blobs = blobs[:5]

    # 多帧持久性：和上一帧的某个块中心距离 < 0.10（归一化）就算同一个目标。
    # 雨滴/粒子/草叶只闪一帧 → frames=1 → persistent=False，可以据此过滤。
    prev_list = _prev_blobs.get(key, [])
    for b in blobs:
        best = None
        for p in prev_list:
            d = ((b['cx'] - p['cx']) ** 2 + (b['cy'] - p['cy']) ** 2) ** 0.5
            if d < 0.10 and (best is None or d < best[0]):
                best = (d, p)
        if best:
            b['frames'] = int(best[1].get('frames', 1)) + 1
            b['persistent'] = b['frames'] >= 2
    _prev_blobs[key] = blobs

    main = next((b for b in blobs if b['persistent']), blobs[0] if blobs else None)
    if main is None:
        return {'ready': True, 'area': round(area, 5), 'cx': 0.0, 'cy': 0.0, 'count': 0, 'blobs': []}
    return {
        'ready': True,
        'area': round(area, 5),
        'cx': main['cx'],
        'cy': main['cy'],
        'count': len(blobs),          # 有几个动的东西（原来这里是像素数，语义改了：更该知道「几只」）
        'px': int((mask > 0).sum()),
        'bbox': main['bbox'],
        'blobs': blobs,
    }


_tpl_cache = {}   # 模板绝对路径 → 灰度图（mtime 变了会重载）


def _load_template(path):
    """读模板（灰度，带缓存）。模板改了（mtime 变）自动重载。"""
    try:
        st = os.stat(path)
    except Exception:
        return None
    key = (path, int(st.st_mtime), int(st.st_size))
    got = _tpl_cache.get(key)
    if got is not None:
        return got
    # ⚠ 不能用 cv2.imread：**中文路径下它静默返回 None**（本项目踩过两次的记录）。
    #   np.fromfile + imdecode 才认 CJK 路径。
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        img = cv2().imdecode(buf, cv2().IMREAD_GRAYSCALE) if buf.size else None
    except Exception:
        img = None
    if img is None:
        return None
    # 只留最近 32 个（防止用户反复换模板把内存撑大）
    if len(_tpl_cache) > 32:
        _tpl_cache.clear()
    _tpl_cache[key] = img
    return img


def detect_scene(bgr, scenes, base_dir, flat_info=None):
    """场景分类（2026-11-14 五十三轮 P0）。

    **只列「应该拦住她」的场景**（death / inventory / chest / chat / pause / loading / title），
    一个都不匹配 → scene='game'。为什么这么设计：
      · 给「游戏进行中」做模板是不可能的（每帧都不一样）；
      · 安全闸要的是「现在能不能发输入」，不是完整的世界状态。

    每个场景的 spec：
      templates: ["scenes/inventory.png", ...]   相对 profile 目录
      roi:       [x,y,w,h] 归一化（默认整帧）—— 只对模板所在区域做匹配，快且抗 UI 缩放
      match:     0.0-1.0 阈值（默认 0.78）

    模板会 resize 到 ROI 的尺寸再比（换分辨率不用重拍，只要构图一致）。
    """
    H, W = bgr.shape[:2]
    gray = cv2().cvtColor(bgr, cv2().COLOR_BGR2GRAY)
    best_name = None
    best_score = 0.0
    best_detail = None
    missing = []   # 读不出来的模板（路径/格式问题）—— 不能静默当「没匹配」
    for name, spec in (scenes or {}).items():
        if not isinstance(spec, dict):
            continue
        tpls = spec.get('templates') or []
        if not tpls:
            continue
        roi = spec.get('roi') or [0, 0, 1, 1]
        x0, y0, w, h = _roi_px(roi, W, H)
        if w < 8 or h < 8:
            continue
        crop = gray[y0:y0 + h, x0:x0 + w]
        thr = float(spec.get('match', 0.78))
        for rel in tpls:
            tpl = _load_template(os.path.join(base_dir, rel))
            if tpl is None:
                missing.append(rel)
                continue
            if tpl.shape != crop.shape:
                tpl = cv2().resize(tpl, (crop.shape[1], crop.shape[0]))
            try:
                res = cv2().matchTemplate(crop, tpl, cv2().TM_CCOEFF_NORMED)
                score = float(res.max())
            except Exception:
                continue
            if score > best_score:
                best_name, best_score, best_detail = name, score, {'tpl': rel, 'thr': thr}
    matched = best_name if (best_name is not None and best_score >= float((scenes.get(best_name) or {}).get('match', 0.78))) else None
    # 兜底：没匹配上模板，但画面中心是平的（GUI 面板）→ 也当「不许动」处理
    blocking_flat = bool(flat_info and flat_info.get('flat'))
    extra = {'missing': missing} if missing else {}
    if matched:
        return dict({'scene': matched, 'matched': matched, 'score': round(best_score, 3),
                     'detail': best_detail, 'blocking': True}, **extra)
    if blocking_flat:
        return dict({'scene': 'panel-unknown', 'matched': None, 'score': round(best_score, 3),
                     'detail': best_detail, 'blocking': True,
                     'note': '画面是平的但没有模板匹配上（背包/菜单/加载之一）—— 没配这个场景的模板'}, **extra)
    return dict({'scene': 'game', 'matched': None, 'score': round(best_score, 3),
                 'detail': best_detail, 'blocking': False}, **extra)


def detect_flat(bgr, roi_frac, max_std=14.0):
    """GUI 面板检测（2026-11-14 审计驱动）。

    为什么：背包/箱子/菜单/加载画面打开后，画面中心是一块**平的 GUI 面板**，
    而游戏世界是复杂地形纹理。用亮度标准差区分：平的 → std 小。

    ⚠ 这是**第一版粗闸**，不是精确的场景分类器：
      · 对着天空/雪原/一面墙时 3D 画面也会很平 → 会误判成 GUI（宁可不打，不能乱按）
      · 真正的场景分类（death/inventory/chat/pause）要模板/OCR，留待下一版
    """
    H, W = bgr.shape[:2]
    x0, y0, w, h = _roi_px(roi_frac, W, H)
    crop = bgr[y0:y0 + h, x0:x0 + w]
    if crop.size == 0:
        return {'std': 0.0, 'flat': True, 'reason': 'empty-roi'}
    g = cv2().cvtColor(crop, cv2().COLOR_BGR2GRAY)
    std = float(g.std())
    return {'std': round(std, 1), 'flat': std < max_std, 'max_std': max_std}


def handle(req):
    """处理一个请求（一行 JSON 的 dict），返回响应 dict。"""
    t0 = time.perf_counter()
    path = req.get('path') or ''
    W = int(req.get('w') or 0)
    H = int(req.get('h') or 0)
    if not path or W <= 0 or H <= 0:
        return {'ok': False, 'error': '需要 path + w + h'}
    try:
        raw = np.fromfile(path, dtype=np.uint8)
    except Exception as e:
        return {'ok': False, 'error': '读帧失败：%s' % e}
    need = W * H * 4
    if raw.size < need:
        return {'ok': False, 'error': '帧数据不完整：%d/%d 字节' % (raw.size, need)}
    # BGRA → BGR（视图，不拷贝；检测只读）
    frame = raw[:need].reshape((H, W, 4))[:, :, :3]

    out = {'ok': True}
    try:
        bars = {}
        for name, spec in (req.get('bars') or {}).items():
            bars[name] = detect_bar(frame, spec['roi'], spec.get('color', 'red'), spec.get('thr', 0.3))
        if bars:
            out['bars'] = bars

        grays = {}
        for name, spec in (req.get('gray') or {}).items():
            on, mean = detect_gray(frame, spec['roi'], spec.get('min', 0.35))
            grays[name] = {'on': on, 'mean': mean}
        if grays:
            out['gray'] = grays

        colors = {}
        for name, spec in (req.get('colors') or {}).items():
            colors[name] = detect_color_area(frame, spec['roi'], spec.get('color', 'red'), spec.get('min_area', 0.001))
        if colors:
            out['colors'] = colors

        gui = req.get('gui')
        if gui:
            out['gui'] = detect_flat(frame, gui.get('roi') or [0.25, 0.2, 0.5, 0.6], gui.get('max_std', 14.0))

        # 场景分类（2026-11-14 五十三轮 P0）：只认「该拦住的场景」，没匹配 → game
        scenes = req.get('scenes')
        if scenes:
            out['scene'] = detect_scene(frame, scenes, str(req.get('sceneBase') or ''), out.get('gui'))

        motions = {}
        for name, spec in (req.get('motion') or {}).items():
            motions[name] = detect_motion(
                frame, spec['roi'], name,
                spec.get('threshold', 12), spec.get('min_area', 0.0005),
            )
        if motions:
            out['motion'] = motions
    except Exception as e:
        return {'ok': False, 'error': '检测异常：%s: %s' % (type(e).__name__, e), 'ms': int((time.perf_counter() - t0) * 1000)}

    out['ms'] = int((time.perf_counter() - t0) * 1000)
    return out


def serve_loop():
    """常驻：stdin 一行一个请求，stdout 一行一个响应。

    ⚠ 2026-11-14 实测坑：**不能用 `for line in sys.stdin`** —— Python 3 的文件
    迭代器会做预读缓冲（read-ahead），调用方写一行后它可能还在等更多数据，
    表现为「请求发出去、永远没响应」。必须用 `readline()`（有 \\n 就返回）。
    另外 spawn 时还要带 `-u`（否则 stdout 也是块缓冲，响应压着不发）。
    """
    cv2()   # 预热：进了 serve 就不可能不用
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        if line == '__quit__':
            break
        try:
            req = json.loads(line)
        except Exception as e:
            print(json.dumps({'ok': False, 'error': '请求不是 JSON：%s' % e}, ensure_ascii=False), flush=True)
            continue
        resp = handle(req)
        print(json.dumps(resp, ensure_ascii=False), flush=True)


def main(argv):
    if '--selftest' in argv:
        # 自检：两个用例 —— 满血（铺满 ROI）和半血（红条只占 ROI 左半）
        import tempfile
        import os
        W, H = 200, 100
        fails = []

        def run(bar_w_px, label, expect):
            img = np.zeros((H, W, 4), dtype=np.uint8)   # BGRA
            img[:, :, 3] = 255
            # 红条放在 ROI 里：ROI = [10,40]-[110,60]（宽 100，高 20）
            img[40:60, 10:10 + bar_w_px] = [0, 0, 255, 255]
            p = os.path.join(tempfile.gettempdir(), 'game-det-selftest.bgra')
            img.tofile(p)
            r = handle({'path': p, 'w': W, 'h': H,
                        'bars': {'hp': {'roi': [10 / W, 40 / H, 100 / W, 20 / H], 'color': 'red'}},
                        'gray': {'skill': {'roi': [0.6, 0.4, 0.2, 0.2], 'min': 0.3}},
                        'colors': {'red_thing': {'roi': [0, 0, 1, 1], 'color': 'red'}}})
            try:
                os.remove(p)
            except Exception:
                pass
            hp = (r.get('bars') or {}).get('hp')
            hpv = hp.get('value') if isinstance(hp, dict) else hp
            hvalid = hp.get('valid', True) if isinstance(hp, dict) else True
            ok = r.get('ok') and hpv is not None and hvalid and abs(hpv - expect) < 0.05
            if not ok:
                fails.append(label)
            print('%-8s hp=%r（期望 %.2f）%s  ms=%s' % (label, hpv, expect, 'PASS' if ok else 'FAIL', r.get('ms')))

        run(100, '满血', 1.0)
        run(50, '半血', 0.5)
        run(10, '残血', 0.1)

        # ── motion 连通域 + 持久性（2026-11-14 五十三轮 P2）──
        # 坑：旧实现取整块 mask 的**平均质心** —— 两只怪时质心落在两只之间的空气里。
        MW, MH = 200, 100
        mpath = os.path.join(tempfile.gettempdir(), 'game-det-motion.bgra')

        def mframe(squares, label):
            img = np.zeros((MH, MW, 4), dtype=np.uint8)
            img[:, :, 3] = 255
            for (sx, sy, sw, sh) in squares:
                img[sy:sy + sh, sx:sx + sw] = [255, 255, 255, 255]
            img.tofile(mpath)
            return handle({'path': mpath, 'w': MW, 'h': MH,
                           'motion': {'enemy': {'roi': [0, 0, 1, 1], 'threshold': 12, 'min_area': 0.0005}}})

        mframe([], '基线')                                   # 第一帧：无基线
        r2 = mframe([(20, 30, 40, 40), (150, 30, 20, 20)], '两只')
        e2 = (r2.get('motion') or {}).get('enemy') or {}
        blobs2 = e2.get('blobs') or []
        ok_two = (len(blobs2) >= 2 and abs(e2.get('cx', 0) - 0.20) < 0.06)
        if not ok_two:
            fails.append('两只目标主质心')
        print('%-10s blobs=%d main_cx=%.3f（期望≈0.20，旧的合并质心会≈0.33）%s'
              % ('两只目标', len(blobs2), e2.get('cx', -1), 'PASS' if ok_two else 'FAIL'))

        r3 = mframe([(24, 30, 40, 40), (150, 30, 20, 20)], '第二帧')
        e3 = (r3.get('motion') or {}).get('enemy') or {}
        b3 = (e3.get('blobs') or [{}])[0]
        ok_persist = (b3.get('persistent') is True and int(b3.get('frames') or 0) >= 2)
        if not ok_persist:
            fails.append('多帧持久性')
        print('%-10s frames=%s persistent=%s %s'
              % ('多帧', b3.get('frames'), b3.get('persistent'), 'PASS' if ok_persist else 'FAIL'))

        # ── 心形颜色（2026-11-14 五十三轮 P2 遗留）──
        # 用 MC 客户端 jar 里的**真实纹理**合成一行 10 颗心：中毒/吸收/冰冻开着时
        # 红检测会归零 → 以前直接判假死亡。现在 color='heart' 认四种颜色，
        # 凋灵黑认不出来 → valid=false（暂停），绝不当成「血空了」。
        _mc_home = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), '.minecraft')
        MC_JAR = os.environ.get('MC_JAR') or os.path.join(_mc_home, 'versions', '1.21.1', '1.21.1.jar')
        if os.path.exists(MC_JAR):
            import zipfile
            hb = 'assets/minecraft/textures/gui/sprites/hud/heart/'

            def load_heart(n):
                with zipfile.ZipFile(MC_JAR) as z:
                    raw = z.read(hb + n)
                return cv2().imdecode(np.frombuffer(raw, np.uint8), cv2().IMREAD_UNCHANGED)

            def heart_row(sprite_name, scale=3):
                C = load_heart('container.png')
                F = load_heart(sprite_name) if sprite_name else None
                hh, ww = C.shape[:2]
                canvas = np.zeros((100, 320, 3), np.uint8)
                for i in range(10):
                    spr = F if F is not None else C
                    rgb = spr[:, :, :3].astype(np.float32)
                    a = (spr[:, :, 3:4].astype(np.float32)) / 255.0
                    tile = (rgb * a).astype(np.uint8)   # 黑底上按 alpha 合成
                    tile = cv2().resize(tile, (ww * scale, hh * scale), interpolation=cv2().INTER_NEAREST)
                    canvas[42:42 + hh * scale, 10 + i * ww * scale:10 + (i + 1) * ww * scale] = tile
                return canvas

            hroi = [10 / 320, 42 / 100, (10 * 9 * 3) / 320, (9 * 3) / 100]
            for spr, label, want_valid in [('full.png', '满血红', True),
                                           ('poisoned_full.png', '中毒', True),
                                           ('absorbing_full.png', '吸收', True),
                                           ('frozen_full.png', '冰冻', True),
                                           ('withered_full.png', '凋灵黑', False),
                                           (None, '空槽', False)]:
                img = heart_row(spr)
                pth = os.path.join(tempfile.gettempdir(), 'game-det-heart.bgra')
                bgra = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
                bgra.tofile(pth)
                rr = handle({'path': pth, 'w': 320, 'h': 100,
                             'bars': {'hp': {'roi': hroi, 'color': 'heart'}}})
                hp = (rr.get('bars') or {}).get('hp') or {}
                okv = (hp.get('valid') is True and hp.get('value', 0) > 0.6) if want_valid else (hp.get('valid') is False)
                if not okv:
                    fails.append('心形-' + label)
                print('%-10s value=%s valid=%s %s' % (label, hp.get('value'), hp.get('valid'), 'PASS' if okv else 'FAIL'))
                try:
                    os.remove(pth)
                except Exception:
                    pass
        else:
            print('（跳过心形颜色测试：找不到 MC jar）')

        # 静止：同画面连续 6 帧 → 累积掩码衰减到 0，不该留下「幽灵目标」
        r4 = None
        for _ in range(6):
            r4 = mframe([(24, 30, 40, 40)], '静止')
        e4 = (r4.get('motion') or {}).get('enemy') or {}
        ok_static = len(e4.get('blobs') or []) == 0
        if not ok_static:
            fails.append('静止残留')
        print('%-10s blobs=%d（期望 0：衰减后不该有目标）%s'
              % ('静止', len(e4.get('blobs') or []), 'PASS' if ok_static else 'FAIL'))
        try:
            os.remove(mpath)
        except Exception:
            pass

        print('SELFTEST ' + ('PASS' if not fails else 'FAIL: ' + ','.join(fails)))
        return 0 if not fails else 1
    serve_loop()
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
