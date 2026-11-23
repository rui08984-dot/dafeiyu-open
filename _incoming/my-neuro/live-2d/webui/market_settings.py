#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""插件广场的下载与依赖设置。

设置保存在 ``live-2d/.runtime/plugin_market_settings.json``（用户本地文件，已被 .gitignore 忽略）。
读取永远不会抛错：文件不存在或损坏时返回默认值；写入只接受校验通过的内容。
"""

import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from .state_io import atomic_write_json, resource_lock
from .utils import PROJECT_ROOT, logger

SETTINGS_PATH = PROJECT_ROOT / '.runtime' / 'plugin_market_settings.json'

# 2026-09-18 实测这三个前缀对 github.com archive zip 与 raw.githubusercontent.com 都可用。
BUILTIN_GITHUB_MIRRORS = (
    'https://ghfast.top',
    'https://gh-proxy.com',
    'https://ghproxy.net',
)
MIRROR_MODES = ('auto', 'direct', 'fixed')

DEFAULTS = {
    'github_mirror_mode': 'auto',
    'github_mirror': '',
    'pip_index_url': '',
    'npm_registry': 'https://registry.npmmirror.com/',
    'hub_url': '',
}

# 镜像前缀只允许 https 主机名（可带端口），不允许路径，避免拼出奇怪的 URL。
_MIRROR_RE = re.compile(r'^https://[A-Za-z0-9.-]+(?::\d{1,5})?$')
# pip / npm 源地址会作为命令行参数传给外部程序，只放行安全字符。
_REGISTRY_RE = re.compile(r'^https://[A-Za-z0-9.-]+(?::\d{1,5})?(?:/[A-Za-z0-9._~%/-]*)?$')
_HUB_URL_RE = re.compile(r'^https://\S+$')

_BLOCKED_HUB_HOSTS = {'localhost', 'localhost.localdomain'}
_BLOCKED_HUB_SUFFIXES = ('.localhost', '.local', '.internal', '.lan', '.home', '.corp')


def _hub_url_problem(value):
    """hub_url 的词法校验：https、无 userinfo、非本机/私网字面量。

    真正的 DNS 解析与 IP 段校验在 marketplace._fetch_hub_catalog 里做
    （保存设置时不联网，避免离线环境卡住）。
    """
    if not _HUB_URL_RE.match(value):
        return '插件源地址必须是 https:// 开头且不含空白字符'
    try:
        parsed = urlsplit(value)
    except ValueError:
        return '插件源地址格式不正确'
    if parsed.scheme.lower() != 'https':
        return '插件源地址必须是 https://'
    if parsed.username or parsed.password:
        return '插件源地址不能包含用户名或密码'
    hostname = (parsed.hostname or '').strip().lower().rstrip('.')
    if not hostname:
        return '插件源地址缺少主机名'
    if hostname in _BLOCKED_HUB_HOSTS or hostname.endswith(_BLOCKED_HUB_SUFFIXES):
        return '插件源地址不能指向本机或内网'
    try:
        literal_ip = ipaddress.ip_address(hostname)
    except ValueError:
        literal_ip = None
    if literal_ip is not None and not literal_ip.is_global:
        return '插件源地址不能指向本机或内网'
    return ''


def _clean_text(value):
    return value.strip() if isinstance(value, str) else ''


def normalize_settings(raw):
    """把任意输入合并到默认值上，去掉未知字段并整理字符串。"""
    merged = dict(DEFAULTS)
    if isinstance(raw, dict):
        for key in DEFAULTS:
            if key in raw:
                merged[key] = _clean_text(raw[key])
    merged['github_mirror_mode'] = merged['github_mirror_mode'].lower() or DEFAULTS['github_mirror_mode']
    merged['github_mirror'] = merged['github_mirror'].rstrip('/')
    return merged


def validate_settings(settings):
    """返回 (是否合法, 错误说明)。说明里指出具体是哪个字段。"""
    if not isinstance(settings, dict):
        return False, '设置必须是对象'

    mode = settings.get('github_mirror_mode', '')
    if mode not in MIRROR_MODES:
        return False, f'github_mirror_mode 只能是 {"/".join(MIRROR_MODES)}'

    mirror = settings.get('github_mirror', '')
    if mirror and not _MIRROR_RE.match(mirror):
        return False, 'github_mirror 必须是 https:// 开头的主机名，不能带路径'
    if mode == 'fixed' and not mirror:
        return False, '固定镜像模式需要填写 github_mirror'

    for key, label in (('pip_index_url', 'pip 镜像地址'), ('npm_registry', 'npm registry 地址')):
        value = settings.get(key, '')
        if value and not _REGISTRY_RE.match(value):
            return False, f'{label} 必须是 https:// 开头且只包含常规 URL 字符'

    hub_url = settings.get('hub_url', '')
    if hub_url:
        problem = _hub_url_problem(hub_url)
        if problem:
            return False, problem

    return True, ''


def load_settings(path=None):
    """读取设置；任何问题都回退默认值，不抛错。"""
    settings_path = Path(path) if path else SETTINGS_PATH
    try:
        with settings_path.open('r', encoding='utf-8-sig') as stream:
            raw = json.load(stream)
    except FileNotFoundError:
        return dict(DEFAULTS)
    except (OSError, ValueError) as exc:
        logger.warning('插件广场设置文件无法读取，使用默认值: %s', exc)
        return dict(DEFAULTS)

    settings = normalize_settings(raw)
    ok, message = validate_settings(settings)
    if not ok:
        logger.warning('插件广场设置文件内容不合法（%s），使用默认值', message)
        return dict(DEFAULTS)
    return settings


def save_settings(partial, path=None):
    """把部分字段合并到现有设置并落盘；校验失败抛 ValueError，不写文件。"""
    settings_path = Path(path) if path else SETTINGS_PATH
    with resource_lock(settings_path):
        current = load_settings(settings_path)
        if isinstance(partial, dict):
            current.update({key: partial[key] for key in DEFAULTS if key in partial})
        merged = normalize_settings(current)
        ok, message = validate_settings(merged)
        if not ok:
            raise ValueError(message)
        atomic_write_json(settings_path, merged)
    return merged
