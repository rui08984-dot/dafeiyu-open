#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""出站 URL 安全校验（SSRF 收口）。

根因：模型列表拉取与插件源地址允许客户端提交任意 URL，服务端照单全收，
于是可以借 WebUI 探测/访问回环与内网地址（并可能把 API Key 一起带过去）。

本模块只放「校验」这一件事，供 config_manager / marketplace / market_settings 共用：

* 只允许 https；
* 拒绝 userinfo（``https://a:b@host/``）；
* 拒绝 localhost 及常见内网后缀；
* 解析 DNS 后逐个 IP 检查，必须是公网地址（拒绝回环/私网/链路本地/保留/组播）；
* 提供一个拒绝跨主机重定向的 urllib opener。
"""

import ipaddress
import socket
import urllib.error
import urllib.request
from urllib.parse import urlsplit

MAX_URL_LENGTH = 2048

_BLOCKED_HOSTNAMES = {
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
}
_BLOCKED_SUFFIXES = (
    '.localhost',
    '.local',
    '.internal',
    '.intranet',
    '.lan',
    '.home',
    '.corp',
    '.localdomain',
)


def _is_public_ip(ip):
    return bool(
        ip.is_global
        and not ip.is_private
        and not ip.is_loopback
        and not ip.is_link_local
        and not ip.is_reserved
        and not ip.is_multicast
        and not ip.is_unspecified
    )


def _resolve_ips(hostname):
    infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    addresses = set()
    for info in infos:
        try:
            addresses.add(ipaddress.ip_address(info[4][0]))
        except ValueError:
            continue
    return addresses


def validate_public_https_url(url):
    """校验一个出站 URL；返回 ``(ok, error_message)``。

    校验失败时 ``error_message`` 是面向用户的中文说明；
    成功时返回 ``(True, '')``。
    """
    text = str(url or '').strip()
    if not text:
        return False, 'URL 不能为空'
    if len(text) > MAX_URL_LENGTH:
        return False, 'URL 过长'
    if any(ch.isspace() for ch in text):
        return False, 'URL 不能包含空白字符'

    try:
        parsed = urlsplit(text)
    except ValueError:
        return False, 'URL 格式不正确'

    if parsed.scheme.lower() != 'https':
        return False, '只允许 https:// 地址'
    if parsed.username or parsed.password:
        return False, 'URL 不能包含用户名或密码'
    hostname = (parsed.hostname or '').strip().lower().rstrip('.')
    if not hostname:
        return False, 'URL 缺少主机名'
    try:
        port = parsed.port
    except ValueError:
        return False, 'URL 端口不合法'
    if port is not None and not (1 <= port <= 65535):
        return False, 'URL 端口不合法'

    if hostname in _BLOCKED_HOSTNAMES or hostname.endswith(_BLOCKED_SUFFIXES):
        return False, '不允许访问本机或内网地址'

    try:
        literal_ip = ipaddress.ip_address(hostname)
    except ValueError:
        literal_ip = None

    if literal_ip is not None:
        if not _is_public_ip(literal_ip):
            return False, '不允许访问本机或内网地址'
        return True, ''

    try:
        addresses = _resolve_ips(hostname)
    except OSError as exc:
        return False, f'域名无法解析：{exc}'
    if not addresses:
        return False, '域名无法解析'
    if any(not _is_public_ip(item) for item in addresses):
        return False, '不允许访问本机或内网地址'
    return True, ''


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """只跟随「同主机 + 仍为公网 https」的重定向。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        ok, error = validate_public_https_url(newurl)
        if not ok:
            raise urllib.error.HTTPError(
                newurl, code, f'拒绝重定向：{error}', headers, fp
            )
        old_host = (urlsplit(req.full_url).hostname or '').lower()
        new_host = (urlsplit(newurl).hostname or '').lower()
        if old_host and new_host and old_host != new_host:
            raise urllib.error.HTTPError(
                newurl, code, '拒绝重定向：目标主机与原始主机不一致', headers, fp
            )
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_safe_https_opener():
    """构造一个不跟随跨主机重定向、校验目标为公网 https 的 opener。"""
    return urllib.request.build_opener(SafeRedirectHandler)
