# -*- coding: utf-8 -*-
"""Pixel-verify the petbody frame skin AFTER screenshots (no guessing from computed styles)."""
from PIL import Image

BASE = r"<project-root>/_probe/shots-petbody-ui"


def px(img, x, y):
    return img.convert("RGBA").getpixel((x, y))


def scan_row(img, y, x0, x1, step=1):
    im = img.convert("RGBA")
    return [im.getpixel((x, y)) for x in range(x0, x1, step)]


def warm(c):
    r, g, b, a = c
    return a > 20 and r >= b  # 暖色判据（棕/铜都满足 r>b）


def report(name, path, checks):
    img = Image.open(path)
    print(f"\n== {name}  {img.size} ==")
    ok = True
    for label, (x, y), expect in checks:
        c = px(img, x, y)
        print(f"  {label:<26} ({x},{y}) rgba={c}  {'暖' if warm(c) else '冷!'}  expect={expect}")
        if expect == "warm" and not warm(c):
            ok = False
        if expect == "brass":
            r, g, b, a = c
            # 铜：r 明显高于 b，且 r/g 不低
            good = a > 100 and r > b + 15 and r > 90
            if not good:
                ok = False
    return ok


allok = True

# 1) 输入条：顶边黄铜线 + 内部暖色
allok &= report("输入条 (idle)", BASE + "/probe-ui-00-idle.png", [
    ("顶边黄铜线", (120, 688), "brass"),
    ("底边黄铜线", (120, 739), "brass"),
    ("内部底色", (120, 715), "warm"),
    ("内部底色2", (300, 715), "warm"),
])

# 2) 四态光环徽章边框（顶部中心，逐态扫一行取最亮像素）
for state, expect_name in [("listening", "黄铜亮"), ("thinking", "琥珀"), ("speaking", "象牙"), ("acting", "火漆红")]:
    img = Image.open(BASE + f"/probe-ui-10-aura-{state}.png").convert("RGBA")
    row = scan_row(img, 28, 140, 290)
    brightest = max(row, key=lambda c: c[0] + c[1] + c[2] if c[3] > 100 else -1)
    r, g, b, a = brightest
    # 火漆红判据：r 高、g/b 明显低；其它：r 高且 g 高
    if state == "acting":
        good = a > 100 and r > 120 and g < r * 0.75 and b < r * 0.7
    elif state == "thinking":
        good = a > 100 and r > 150 and 0.6 * r < g < 0.9 * r and b < g
    else:
        good = a > 100 and r > 150 and g > 120 and b < g
    print(f"\n== 光环 {state} 最亮描边 rgba={brightest}  expect={expect_name} -> {'OK' if good else 'FAIL'}")
    allok &= good

# 3) 对话气泡：边框（扫行找铜线，位置随气泡漂移）+ 内部
img = Image.open(BASE + "/probe-ui-30-bubble.png").convert("RGBA")
row = [img.getpixel((x, 100)) for x in range(0, 80)]
brass = next((c for c in row if c[3] > 100 and c[0] > c[2] + 15 and c[0] > 90), None)
print(f"\n== 对话气泡 左边框扫描 x0..80 y=100 首个铜色={brass} -> {'OK' if brass else 'FAIL'}")
allok &= bool(brass)
allok &= report("对话气泡-内部", BASE + "/probe-ui-30-bubble.png", [
    ("内部底色", (150, 110), "warm"),
])

print("\n" + ("ALL PIXEL CHECKS PASS" if allok else "PIXEL CHECK FAILED"))
raise SystemExit(0 if allok else 1)
