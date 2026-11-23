#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""mc_cmd.py — 往 Minecraft 里发一条聊天/命令（后台，不抢前台）（2026-11-14）

为什么用 PostMessage 而不是 SendInput：
  SendInput 会把按键发给**当前前台窗口**。她在后台跑自动化时，用户可能正在
  看视频/打字 —— SendInput 会污染用户的输入，而 PostMessage 只投给 MC 自己的
  消息队列，MC（GLFW）照常处理 WM_CHAR / WM_KEYDOWN。

用法：
  python mc_cmd.py --window "Minecraft 1.21.1" "/damage @s 5"
  python mc_cmd.py --window "Minecraft 1.21.1" --raw "hello 世界"

流程：T 开聊天 → 逐字符 WM_CHAR → Enter 发送。
注意：MC 的聊天框开/关是状态机，所以每次都先按 Esc 清状态再按 T。
"""
import argparse
import ctypes
import ctypes.wintypes as w
import json
import sys
import time

u = ctypes.windll.user32

WM_KEYDOWN = 0x0100
WM_KEYUP = 0x0101
WM_CHAR = 0x0102
VK_ESCAPE = 0x1B
VK_RETURN = 0x0D
VK_T = 0x54


def dpi():
    try:
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        u.SetProcessDPIAware()


def find_window(sub):
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def cb(h, _):
        if not u.IsWindowVisible(h):
            return True
        n = u.GetWindowTextLengthW(h)
        if not n:
            return True
        b = ctypes.create_unicode_buffer(n + 1)
        u.GetWindowTextW(h, b, n + 1)
        if sub.lower() in b.value.lower():
            found.append((h, b.value))
        return True

    u.EnumWindows(cb, 0)
    return found[0] if found else (None, None)


# VK → scan code（2026-11-14 实测：不带扫描码时 GLFW 偶尔收不到键）
# 用 MapVirtualKeyW 动态查更稳，这里给几个常用的兜底
_SCAN = {0x1B: 0x01, 0x0D: 0x1C, 0x54: 0x14, 0x45: 0x12, 0x20: 0x39}


def key(hwnd, vk, scan=None):
    if scan is None:
        scan = _SCAN.get(vk) or u.MapVirtualKeyW(vk, 0)
    lp_down = 1 | (scan << 16)
    lp_up = 1 | (scan << 16) | 0xC0000000
    u.PostMessageW(hwnd, WM_KEYDOWN, vk, lp_down)
    time.sleep(0.05)
    u.PostMessageW(hwnd, WM_KEYUP, vk, lp_up)
    time.sleep(0.03)


def type_text(hwnd, text):
    for ch in text:
        # WM_CHAR 的 lParam 里也带扫描码 + 按下/抬起位（GLFW 用它做字符解码）
        sc = u.MapVirtualKeyW(ord(ch), 0) or 0
        u.PostMessageW(hwnd, WM_CHAR, ord(ch), 1 | (sc << 16) | 0x40000000)
        time.sleep(0.010)


def send(hwnd, text):
    # ⚠ 2026-11-14 实测坑：**不能先按 Esc**。游戏正常时 Esc = 打开菜单，
    # 于是第二次调用会把菜单打开，后面的 T/字符全被菜单吃掉（表现为「命令投递成功但没执行」）。
    # 现在假设调用前游戏处于正常状态（不带菜单/不带聊天框）。需要关菜单时用 --esc 显式说明。
    key(hwnd, VK_T)            # 开聊天
    time.sleep(0.25)
    type_text(hwnd, text)
    time.sleep(0.12)
    key(hwnd, VK_RETURN)       # 发送
    time.sleep(0.12)


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument('--window', default='Minecraft')
    ap.add_argument('--raw', action='store_true', help='原样发（不加 /）')
    ap.add_argument('--esc', action='store_true', help='发之前先按一次 Esc（只在确定菜单开着时用）')
    ap.add_argument('text')
    a = ap.parse_args(argv)

    dpi()
    hwnd, title = find_window(a.window)
    if not hwnd:
        print(json.dumps({'ok': False, 'error': '没找到窗口：' + a.window}, ensure_ascii=False))
        return 2

    if a.esc:
        key(hwnd, VK_ESCAPE)
        time.sleep(0.3)
    text = a.text if (a.raw or a.text.startswith('/')) else '/' + a.text
    send(hwnd, text)
    print(json.dumps({'ok': True, 'hwnd': hwnd, 'title': title, 'sent': text}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
