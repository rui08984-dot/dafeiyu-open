#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WebUI 本机访问边界。

根因：WebUI 原来 ``app.run(host='0.0.0.0')`` 且没有任何鉴权/Origin 校验，
同一局域网的任意主机都能直接 POST 改配置、开插件、生成可执行 bat。

本模块提供三层统一收口（而不是逐个路由打补丁）：

1. 绑定与 Host 校验：默认只接受回环 Host；``PET_WEBUI_HOST`` 显式覆盖时才放宽。
2. 状态变更方法（POST/PUT/PATCH/DELETE）要求 ``X-Pet-Token`` 或同源 Origin。
3. 令牌在启动时生成一次，写入 ``webui/.token``（POSIX 下 0600）并打印一次。

GET 只读路由不要求令牌，但各路由自身不得回传凭据（见 config_manager 的掩码逻辑）。
"""

import hmac
import os
import secrets
import sys
from pathlib import Path
from urllib.parse import urlsplit

from flask import jsonify, request

from .utils import PROJECT_ROOT, logger

# 与 utils.PROJECT_ROOT 保持一致；测试可直接替换本模块变量
TOKEN_PATH = PROJECT_ROOT / 'webui' / '.token'

# 回环主机集合（Host / Origin 都按小写比较）
LOOPBACK_HOSTS = frozenset({'127.0.0.1', 'localhost', '::1', '[::1]'})

# 需要令牌或同源 Origin 的方法
STATE_CHANGING_METHODS = frozenset({'POST', 'PUT', 'PATCH', 'DELETE'})

# 允许访问的主机（由 install_security 按环境变量计算一次）
_ALLOWED_HOSTS = None
_TOKEN_CACHE = None


def _hostname_and_port(host_header):
    """把 Host/Origin 的 netloc 拆成 (hostname, port|None)。"""
    parsed = urlsplit('//' + str(host_header or ''))
    return (parsed.hostname or '').lower(), parsed.port


def _allowed_hosts():
    global _ALLOWED_HOSTS
    if _ALLOWED_HOSTS is not None:
        return _ALLOWED_HOSTS

    hosts = set(LOOPBACK_HOSTS)
    override = str(os.environ.get('PET_WEBUI_HOST') or '').strip().lower()
    if override:
        # 显式覆盖：接受用户指定的绑定地址/主机名（含 0.0.0.0、:: 这类通配地址）
        hosts.add(override)
    _ALLOWED_HOSTS = frozenset(hosts)
    return _ALLOWED_HOSTS


def reset_for_tests():
    """清空进程级缓存（仅测试使用，避免环境变量副本互相影响）。"""
    global _ALLOWED_HOSTS, _TOKEN_CACHE
    _ALLOWED_HOSTS = None
    _TOKEN_CACHE = None


def _write_token_file(path, token):
    path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_CREAT | os.O_WRONLY | os.O_TRUNC
    mode = 0o600
    try:
        fd = os.open(str(path), flags, mode)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                stream.write(token)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            pass
        # Windows 上 chmod 只是近似（ACL 仍由用户目录继承），POSIX 上生效
        try:
            os.chmod(str(path), mode)
        except OSError:
            pass
    except OSError as exc:
        logger.warning('无法写入 WebUI 令牌文件 %s：%s', path, exc)


def get_token(regenerate=False):
    """返回本机令牌。

    ``regenerate=True``（应用启动）时每次生成新令牌并落盘，只打印一次；
    其它调用复用进程内缓存，避免同一进程里前后不一致。
    """
    global _TOKEN_CACHE
    if _TOKEN_CACHE and not regenerate:
        return _TOKEN_CACHE

    if not regenerate:
        try:
            token = TOKEN_PATH.read_text(encoding='utf-8').strip()
        except FileNotFoundError:
            token = ''
        except OSError as exc:
            logger.warning('无法读取 WebUI 令牌文件 %s：%s', TOKEN_PATH, exc)
            token = ''
        if token:
            _TOKEN_CACHE = token
            return token

    token = secrets.token_urlsafe(32)
    _write_token_file(TOKEN_PATH, token)
    # 每次进程启动打印一次（令牌不再跨进程复用）
    print(f'[WebUI] 本机访问令牌：{token}')
    print(f'[WebUI] 令牌文件：{TOKEN_PATH}（请求头 X-Pet-Token）')
    sys.stdout.flush()
    _TOKEN_CACHE = token
    return token


def _host_allowed(host_header):
    hostname, _port = _hostname_and_port(host_header)
    if not hostname:
        return False
    allowed = _allowed_hosts()
    if hostname in allowed:
        return True
    # PET_WEBUI_HOST=0.0.0.0 / :: 表示用户显式要求监听所有网卡，
    # 此时不再按 Host 拦截（令牌仍然生效）。
    return any(item in ('0.0.0.0', '::', '*') for item in allowed)


def _same_origin(origin_header):
    """Origin/Referer 是否指向本机同一端口。

    浏览器对同源 POST 会带 Origin；把它作为令牌的等价凭证，现有前端无需改造。
    跨站页面无法伪造 Origin，因此这条路径不会被别的网页利用。
    """
    if not origin_header:
        return False
    try:
        parsed = urlsplit(origin_header)
    except ValueError:
        return False
    if parsed.scheme not in ('http', 'https'):
        return False
    origin_host = (parsed.hostname or '').lower()
    request_host, request_port = _hostname_and_port(request.host)
    origin_port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    request_port = request_port or (443 if request.scheme == 'https' else 80)
    if origin_port != request_port:
        return False
    if origin_host == request_host:
        return True
    # localhost 与 127.0.0.1 指向同一台机器，允许互相认作同源
    return origin_host in LOOPBACK_HOSTS and request_host in LOOPBACK_HOSTS


def _token_matches(candidate):
    token = get_token()
    if not token or not candidate:
        return False
    return hmac.compare_digest(str(candidate), token)


def _reject(message, status=403):
    return jsonify({'success': False, 'error': message}), status


def install_security(app, token=None):
    """把 Host/令牌校验挂到 Flask 应用的 before_request 上。"""
    app.config['PET_TOKEN'] = token or get_token(regenerate=True)

    @app.before_request
    def _guard():
        # 1) 只服务本机 Host，挡掉 DNS rebinding / 局域网直连
        if not _host_allowed(request.host):
            logger.warning('拒绝非本机 Host 的 WebUI 请求：%s', request.host)
            return _reject('只允许从本机访问 WebUI')

        # 2) 状态变更必须带令牌或来自同源页面
        if request.method.upper() in STATE_CHANGING_METHODS:
            header_token = request.headers.get('X-Pet-Token') or ''
            if _token_matches(header_token):
                return None
            origin = request.headers.get('Origin') or ''
            if _same_origin(origin):
                return None
            # 少数客户端只发 Referer
            referer = request.headers.get('Referer') or ''
            if _same_origin(referer):
                return None
            return _reject('缺少本机令牌或同源 Origin')
        return None

    return app
