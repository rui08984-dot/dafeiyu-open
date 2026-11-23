#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""定位 MemOS 的 400：用 aiohttp 复现，逐项排除 header/payload。"""
import asyncio
import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, '_incoming/my-neuro/plugins-dlc/memos/memos_system/config/memos_config.json')
cfg = json.load(io.open(CFG, encoding='utf-8'))
llm = cfg['llm']['config']
URL = llm['base_url'].rstrip('/') + '/chat/completions'
MODEL = llm['model']
KEY = llm['api_key']


async def call(label, headers_extra, payload_extra):
    import aiohttp
    headers = {'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json'}
    headers.update(headers_extra)
    payload = {'model': MODEL, 'messages': [{'role': 'user', 'content': '用 JSON 回答：{"ok":true}'}], 'max_tokens': 50}
    payload.update(payload_extra)
    try:
        async with aiohttp.ClientSession(auto_decompress=False) as s:
            async with s.post(URL, headers=headers, json=payload,
                              timeout=aiohttp.ClientTimeout(total=90)) as r:
                raw = await r.read()
                enc = r.headers.get('Content-Encoding', '(none)')
                # 手动解 br/gzip
                body = raw
                try:
                    if enc == 'br':
                        import brotli
                        body = brotli.decompress(raw)
                    elif enc == 'gzip':
                        import gzip
                        body = gzip.decompress(raw)
                except Exception as e:
                    body = ('<解压失败 %s: %s> ' % (enc, e)).encode() + raw[:200]
                print('%-28s -> %s | enc=%s | %s' % (label, r.status, enc, body.decode('utf-8', 'replace')[:260].replace('\n', ' ')))
    except Exception as e:
        print('%-28s -> EXC %s' % (label, str(e)[:160]))


async def main():
    await call('无UA/无AE', {}, {})
    await call('UA=OpenAI', {'User-Agent': 'OpenAI/Python 1.0.0'}, {})
    await call('UA+AE=gzip,deflate', {'User-Agent': 'OpenAI/Python 1.0.0', 'Accept-Encoding': 'gzip, deflate'}, {})
    await call('UA+AE+thinking', {'User-Agent': 'OpenAI/Python 1.0.0', 'Accept-Encoding': 'gzip, deflate'},
               {'thinking': {'type': 'disabled'}})
    await call('UA+AE+thinking+temp', {'User-Agent': 'OpenAI/Python 1.0.0', 'Accept-Encoding': 'gzip, deflate'},
               {'thinking': {'type': 'disabled'}, 'temperature': 0.3})
    await call('UA+AE+8k tokens', {'User-Agent': 'OpenAI/Python 1.0.0', 'Accept-Encoding': 'gzip, deflate'},
               {'max_tokens': 8000})


asyncio.run(main())
