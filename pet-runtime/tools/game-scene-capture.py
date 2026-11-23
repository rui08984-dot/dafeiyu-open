#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
game-scene-capture.py — 抓一张游戏画面存成「场景模板」（2026-11-14 五十三轮 P0）

为什么要它：场景状态机（death/inventory/chest/chat/pause/loading/title）靠模板匹配，
而模板只能从**真实画面**里抓。这个脚本一条命令完成「抓帧 → 裁剪 → 存 PNG」，
不需要打开任何截图软件，也不受遮挡影响（走 WGC）。

用法：
  # 整帧存成 inventory 场景模板
  python pet-runtime/tools/game-scene-capture.py --window "Minecraft 1.21.1" \
      --scene inventory --out pet-runtime/data/game-profiles/minecraft-1.21.1/scenes

  # 只截一小块（推荐：匹配快 10 倍、抗 UI 缩放）
  python pet-runtime/tools/game-scene-capture.py --window "Minecraft 1.21.1" \
      --scene death --roi 0.25,0.10,0.50,0.25 --out .../scenes

  # 看一眼当前是什么场景（不存文件）
  python pet-runtime/tools/game-scene-capture.py --window "Minecraft 1.21.1" --info

⚠ 同一个 scene 重复抓会覆盖同名文件；想多张模板就自己改 --scene 名字（如 inventory2）。
"""
import argparse
import json
import os
import subprocess
import sys

try:
    import numpy as np
except Exception:
    print('需要 numpy（pip install numpy）', file=sys.stderr)
    sys.exit(2)

try:
    import cv2
except Exception:
    cv2 = None


def find_root(start):
    d = os.path.abspath(start)
    for _ in range(10):
        if os.path.isdir(os.path.join(d, 'pet-runtime')):
            return d
        up = os.path.dirname(d)
        if up == d:
            break
        d = up
    return os.getcwd()


def core_bin(root):
    for rel in ('pet-core/target/release/pet-core.exe', 'pet-core/target/debug/pet-core.exe'):
        p = os.path.join(root, rel)
        if os.path.exists(p):
            return p
    return ''


def grab(root, window, max_wait=4000):
    """抓一帧（整窗 BGRA）。返回 (np.ndarray HxWx3 BGR, w, h)"""
    exe = core_bin(root)
    if not exe:
        raise RuntimeError('pet-core 不存在（先 cd pet-core && cargo build --release）')
    req = json.dumps({'cmd': 'game_frame', 'target': window, 'maxWaitMs': max_wait, 'slot': 'tpl'})
    out = subprocess.run([exe], input=req.encode('utf-8'), stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, timeout=30, creationflags=0x08000000)  # CREATE_NO_WINDOW
    try:
        r = json.loads(out.stdout.decode('utf-8', 'replace').strip().splitlines()[-1])
    except Exception:
        raise RuntimeError('pet-core 输出异常：%r' % out.stdout[:200])
    if not r.get('ok'):
        raise RuntimeError('抓帧失败：%s' % r.get('error'))
    w, h = int(r['width']), int(r['height'])
    raw = np.fromfile(r['path'], dtype=np.uint8)
    need = w * h * 4
    if raw.size < need:
        raise RuntimeError('帧数据不完整：%d/%d' % (raw.size, need))
    bgra = raw[:need].reshape((h, w, 4))
    return bgra[:, :, :3].copy(), w, h, r


def save_png(path, img):
    """存 PNG —— 不能用 cv2.imwrite（中文路径静默失败，踩过）"""
    if cv2 is None:
        raise RuntimeError('需要 opencv-python（pip install opencv-python）')
    ok, buf = cv2.imencode('.png', img)
    if not ok:
        raise RuntimeError('PNG 编码失败')
    d = os.path.dirname(os.path.abspath(path))
    if d and not os.path.isdir(d):
        os.makedirs(d)
    with open(path, 'wb') as f:
        f.write(buf.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--window', required=True, help='窗口标题子串（如 "Minecraft 1.21.1"）')
    ap.add_argument('--scene', default='', help='场景名（death/inventory/chest/chat/pause/loading/title）')
    ap.add_argument('--out', default='', help='输出目录（默认 pet-runtime/data/game-profiles/*/scenes）')
    ap.add_argument('--roi', default='', help='裁剪比例 x,y,w,h（如 0.25,0.1,0.5,0.25）；不填=整帧')
    ap.add_argument('--info', action='store_true', help='只打印画面信息，不存文件')
    args = ap.parse_args()

    root = find_root(os.path.dirname(os.path.abspath(__file__)))
    img, w, h, meta = grab(root, args.window)
    print('窗口 %dx%d  hwnd=%s  fgMatch=%s' % (w, h, meta.get('hwnd'), meta.get('fgMatch')))

    if args.roi:
        parts = [float(x) for x in args.roi.split(',')]
        if len(parts) != 4:
            print('--roi 要 4 个数：x,y,w,h', file=sys.stderr)
            return 2
        x, y, rw, rh = parts
        x0, y0 = int(x * w), int(y * h)
        x1, y1 = int((x + rw) * w), int((y + rh) * h)
        img = img[max(0, y0):min(h, y1), max(0, x0):min(w, x1)]
        print('裁剪 -> %dx%d' % (img.shape[1], img.shape[0]))

    if args.info:
        # 给一个粗略的「平不平」判断：GUI 面板通常很平（亮度标准差小）
        g = img.mean(axis=2)
        print('center_std=%.1f  mean=%.1f  （std<14 大概是 GUI 面板）' % (float(g.std()), float(g.mean())))
        return 0

    if not args.scene:
        print('要给 --scene（或加 --info 只看信息）', file=sys.stderr)
        return 2
    out_dir = args.out
    if not out_dir:
        base = os.path.join(root, 'pet-runtime', 'data', 'game-profiles')
        # 找第一个含 scenes 或与窗口名相近的 profile
        cands = [d for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
        grep = [d for d in cands if args.window.lower().split()[0] in d.lower()]
        pick = grep[0] if grep else (cands[0] if cands else 'default')
        out_dir = os.path.join(base, pick, 'scenes')
    path = os.path.join(out_dir, args.scene + '.png')
    save_png(path, img)
    print('已保存：%s（%d 字节）' % (path, os.path.getsize(path)))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print('失败：%s' % e, file=sys.stderr)
        sys.exit(1)
