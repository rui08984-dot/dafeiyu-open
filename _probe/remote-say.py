#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""拟真遥控发送器（2026-11-10 三十八轮）。
用法：
  echo 消息文本 | python _probe/remote-say.py
  python _probe/remote-say.py -f 消息文件.txt

⚠ 为什么必须 Python + stdin：
  · curl.exe 在 Windows 按命令行 GBK 传中文 → 她收乱码（实测踩过）
  · 命令行参数同样过 GBK → 中文会坏（#20 同一条铁律）
  · stdin/文件都是 UTF-8 字节，urllib 直接原样发出
"""
import io
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = os.path.join(ROOT, '_incoming', 'my-neuro', 'data', '遥控令牌.txt')
URL = 'http://127.0.0.1:3003/remote/say?t='


def main():
    text = ''
    if len(sys.argv) >= 3 and sys.argv[1] == '-f':
        text = io.open(sys.argv[2], encoding='utf-8').read().strip()
    else:
        text = sys.stdin.buffer.read().decode('utf-8').strip()
    if not text:
        print(json.dumps({'ok': False, 'error': '空消息'}, ensure_ascii=False))
        return 2
    token = io.open(TOKEN_FILE, encoding='utf-8').read().strip()
    body = json.dumps({'text': text}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(URL + token, data=body, method='POST',
                                 headers={'Content-Type': 'application/json; charset=utf-8'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = r.read().decode('utf-8', 'replace')
        print(json.dumps({'ok': True, 'status': 200, 'resp': resp[:300]}, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
