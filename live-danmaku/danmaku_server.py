#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
直播弹幕服务（直播对接模块 v1 · 竞品调研 Top1 的落点）。

两个来源：
  mock    —— 内置假弹幕流（E2E 与开发用，不需要 B 站账号）
  blivedm —— 真 B 站直播间（open-live 不用申请；需要 pip install blivedm，
             未安装时 /config 会明确报错而不是静默假数据）

对外接口（127.0.0.1:8030）：
  GET  /poll?since=<seq>   → {seq, items:[{seq, user, text, type, ts}]}
  POST /config             → {room_id, source}（source: mock|blivedm）
  GET  /health             → {ok, source, room_id, total}

运行：python danmaku_server.py [--port 8030]
"""
import argparse
import json
import random
import threading
import time

from aiohttp import web

# blivedm 的 handler 基类（没装时留个空基类，让模块能正常加载；
# 真用 blivedm 时会走 blivedm_loop 里的 ImportError 分支明确报错）
try:
    from blivedm.handlers import BaseHandler
except ImportError:
    class BaseHandler:  # type: ignore[no-redef]
        pass

STATE = {
    'source': 'mock',
    'room_id': '',
    'seq': 0,
    'items': [],           # 最近 500 条弹幕（内存环形）
    'lock': threading.Lock(),
}

MOCK_POOL = [
    ('观众小明', '主播这波操作太秀了'),
    ('弹幕侠', '哈哈哈笑死我了'),
    ('路人甲', '主播玩的是什么游戏'),
    ('夜猫子', '今天几点下播呀'),
    ('小美', '声音好好听！'),
    ('刺猬', '再来一首歌呗'),
    ('摸鱼选手', '主播喝水，注意身体'),
    ('老观众', '来了来了，每天准时蹲'),
    ('新人报到', '第一次看，主播好可爱'),
    ('键盘侠', '上把那个操作拉胯了'),
]


def push(user, text, dtype='danmu', extra=None):
    with STATE['lock']:
        STATE['seq'] += 1
        item = {
            'seq': STATE['seq'], 'user': user, 'text': text,
            'type': dtype, 'ts': int(time.time()),
        }
        # 附加字段（礼物数量/价格、舰长等级等）——不影响老消费方，多余字段被忽略
        if extra and isinstance(extra, dict):
            item.update(extra)
        STATE['items'].append(item)
        del STATE['items'][:-500]


def mock_loop():
    """假弹幕流：8~25 秒一条，E2E/开发用。"""
    while True:
        if STATE['source'] == 'mock':
            user, text = random.choice(MOCK_POOL)
            push(user, text)
        time.sleep(random.uniform(8, 25))


def blivedm_loop(room_id):
    """真 B 站弹幕：blivedm 未安装时明确报错（不静默假数据）。"""
    try:
        import blivedm  # noqa: F401
    except ImportError:
        push('system', 'blivedm 未安装：pip install blivedm 后重启本服务', 'error')
        return
    try:
        import asyncio
        import blivedm as bdm

        async def run():
            client = bdm.BLiveClient(room_id)
            handler = _Handler()
            client.add_handler(handler)
            # ⚠ 2026-11-09 实测修正（两次踩坑，记死）：
            #   ① 新版 blivedm **没有** connect()（旧写法 `await client.connect()` 直接 AttributeError）
            #   ② start() 是**同步**的（不是 async！加 await 会得到 "NoneType can't be used in await"）
            #   ③ join() / stop_and_close() 才是 async
            # 正确顺序：start() 同步启动 → await join() 等结束 → await stop_and_close() 收尾
            client.start()
            try:
                await client.join()
            finally:
                await client.stop_and_close()

        asyncio.run(run())
    except Exception as exc:  # noqa: BLE001
        push('system', 'blivedm 运行异常: ' + str(exc), 'error')


# ⚠ 2026-11-09 关键修复：必须继承 BaseHandler，否则 blivedm 的 _CMD_CALLBACK_DICT
# 不会把 _on_danmaku 挂到消息分发链上——裸类永远收不到回调（实测踩到，只在日志看到 error）。
class _Handler(BaseHandler):
    async def _on_danmaku(self, client, message):
        push(message.uname, message.msg)

    async def _on_gift(self, client, message):
        # 礼物带数量和价格——主播最想知道「谁送了啥」，让她能准确感谢
        num = getattr(message, 'num', 1) or 1
        price = getattr(message, 'price', 0) or 0
        coin = getattr(message, 'coin_type', '')
        detail = '送了 ' + str(message.gift_name)
        if num > 1:
            detail += ' ×' + str(num)
        push(message.uname, detail, 'gift', extra={'num': num, 'price': price, 'coin': coin})

    async def _on_super_chat(self, client, message):
        # SC 是付费留言，值得单独标出来（她回应优先级更高）
        price = getattr(message, 'price', 0) or 0
        push(message.uname, message.message, 'superchat', extra={'price': price})

    async def _on_buy_guard(self, client, message):
        # 上舰（大航海）——这是最重要的付费事件
        lvl = getattr(message, 'guard_level', 0) or 0
        name = {1: '总督', 2: '提督', 3: '舰长'}.get(lvl, '大航海')
        push(message.uname, '开通了' + name, 'gift', extra={'guard_level': lvl})

    async def handle(self, client, command):
        """原始命令入口：接 BaseHandler 不覆盖的事件（进场/关注）。
        2026-11-09：B 站 INTERACT_WORD 是「进房/关注/分享」的统一事件，
        msg_type: 1=进场 2=关注 3=分享。这三类对主播价值很高（欢迎新观众）。"""
        try:
            cmd = str(command.get('cmd', '')).split(':')[0]
            if cmd == 'INTERACT_WORD':
                data = (command.get('data') or {})
                uname = str(data.get('uname') or '')
                mtype = int(data.get('msg_type') or 0)
                if uname:
                    if mtype == 1:
                        push(uname, '进入了直播间', 'enter')
                    elif mtype == 2:
                        push(uname, '关注了主播', 'follow')
            elif cmd == 'WATCHED_CHANGE':
                # 看过人数变化（可选，噪声较大，先不推）
                pass
        except Exception:
            pass
        # 交回基类继续分发（弹幕/礼物/SC 照常）
        return await super().handle(client, command)


async def poll(request):
    try:
        since = int(request.query.get('since', '0'))
    except ValueError:
        since = 0
    with STATE['lock']:
        items = [i for i in STATE['items'] if i['seq'] > since]
        return web.json_response({'seq': STATE['seq'], 'items': items})


async def config(request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    source = str(body.get('source') or '').strip().lower()
    room = str(body.get('room_id') or '').strip()
    if source not in ('mock', 'blivedm', 'off'):
        return web.json_response({'error': 'source 必须是 mock|blivedm|off'}, status=400)
    if source == 'blivedm' and not room.isdigit():
        return web.json_response({'error': 'blivedm 需要数字 room_id'}, status=400)
    STATE['source'] = source
    STATE['room_id'] = room
    if source == 'blivedm':
        threading.Thread(target=blivedm_loop, args=(room,), daemon=True).start()
    return web.json_response({'ok': True, 'source': source, 'room_id': room})


async def health(request):
    with STATE['lock']:
        return web.json_response({
            'ok': True, 'source': STATE['source'], 'room_id': STATE['room_id'],
            'total': STATE['seq'],
        })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8030)
    args = parser.parse_args()

    threading.Thread(target=mock_loop, daemon=True).start()
    app = web.Application()
    app.router.add_get('/poll', poll)
    app.router.add_post('/config', config)
    app.router.add_get('/health', health)
    print(f'danmaku service on http://127.0.0.1:{args.port} (source=mock)', flush=True)
    web.run_app(app, host='127.0.0.1', port=args.port, print=None)


if __name__ == '__main__':
    main()
