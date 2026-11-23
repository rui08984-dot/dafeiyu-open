#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""screen-hash.py —— 屏幕感知哈希（2026-11-09）

用途：判断「动作前后画面是否真的变了」。给闭环判断用。
为什么不用 VLM：VLM 要 1800ms 且花钱；dHash 只要 ~50ms 且免费。
只有在「变了但不知道变成什么」时才值得调 VLM。

算法：dHash（difference hash）
  1. 截全屏 → 缩到 9x8 灰度
  2. 相邻像素比较（左 > 右 记 1）→ 64 bit
  3. 输出 16 位十六进制字符串

输出：单行 16 位 hex（如 a3f2c1d4e5b60789），失败输出空。
"""

import sys

try:
    from PIL import ImageGrab
except ImportError:
    sys.exit(0)


def dhash(img, size=8):
    """返回 64-bit dHash 的十六进制字符串。"""
    # 缩到 (size+1) x size 灰度（9x8 = 8*8=64 次比较）
    small = img.convert('L').resize((size + 1, size), resample=1)  # 1 = BILINEAR，快
    px = list(small.getdata())
    bits = 0
    idx = 0
    w = size + 1
    for row in range(size):
        for col in range(size):
            left = px[row * w + col]
            right = px[row * w + col + 1]
            if left > right:
                bits |= (1 << idx)
            idx += 1
    return format(bits, '016x')


def main():
    try:
        # 只截主屏（全屏 grab 在多屏下会拼图，慢且没必要）
        img = ImageGrab.grab(all_screens=False)
        sys.stdout.write(dhash(img))
    except Exception:
        # 失败不输出任何东西（调用方按 null 处理）
        pass


if __name__ == '__main__':
    main()
