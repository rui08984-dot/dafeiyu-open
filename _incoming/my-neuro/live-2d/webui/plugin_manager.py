#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WebUI 模块化重构 - 插件管理模块
负责插件的扫描、启用/禁用和配置管理
"""

import os
import json
import re
import urllib.request
import urllib.error
from collections import OrderedDict
from pathlib import Path
from flask import Blueprint, request, jsonify

from .utils import PROJECT_ROOT, logger
from .marketplace_updater import (
    check_framework_compatibility,
    check_updates_for_plugins,
)
from .state_io import atomic_write_json, resource_lock

# 创建插件管理蓝图
plugin_bp = Blueprint('plugin', __name__)

PLUGIN_FRAMEWORK_VERSION = '1.0.0'

# 插件目录名白名单（现有插件均为小写字母/数字/短横线）
PLUGIN_CATEGORIES = ('built-in', 'community')
PLUGIN_DIR_NAME_RE = re.compile(r'^[A-Za-z0-9_.\-]{1,80}$')


def resolve_plugin_dir(plugin_path):
    """把 ``category/name`` 解析成 plugins 下的真实目录。

    根因：原实现直接 ``PROJECT_ROOT / 'plugins' / category / dir_name``，
    ``dir_name`` 里的 ``..`` 可以逃出 plugins 目录（open-config 还会 os.startfile）。
    返回 ``(Path, None)`` 或 ``(None, 错误说明)``。
    """
    text = plugin_path if isinstance(plugin_path, str) else ''
    text = text.strip()
    if not text or len(text) > 200 or text.count('/') != 1:
        return None, '无效的插件路径，应为 category/name 格式'

    category, dir_name = text.split('/', 1)
    if category not in PLUGIN_CATEGORIES:
        return None, '无效的插件类别'
    if (
        not PLUGIN_DIR_NAME_RE.match(dir_name)
        or dir_name.startswith('.')
        or dir_name in ('.', '..')
        or '..' in dir_name
    ):
        return None, '无效的插件目录名'

    plugins_root = os.path.realpath(str(PROJECT_ROOT / 'plugins'))
    candidate = os.path.realpath(os.path.join(plugins_root, category, dir_name))
    try:
        inside = os.path.commonpath([plugins_root, candidate]) == plugins_root
    except ValueError:
        inside = False
    if not inside or candidate == plugins_root:
        return None, '插件路径越界'
    return Path(candidate), None


def _schema_value(node, default=None):
    """Read a plugin_config schema node without exposing nested secrets."""
    if not isinstance(node, dict):
        return default
    if 'value' in node:
        return node.get('value')
    return node.get('default', default)


def _to_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ('true', '1', 'yes', 'on'):
            return True
        if lowered in ('false', '0', 'no', 'off', ''):
            return False
    return default


# ---------- 插件配置凭据掩码（GET 只回掩码 / 保存回填原值） ----------
# 只作用于 plugin_config.json 这条链路；config.json / llm_providers.json 有各自的机制。
# 判定规则：键名以 api_key/api-key/apikey/secret/token/password/passwd/cookie/
# authorization/credential 结尾（大小写不敏感）且值是非空字符串。
# 注意 ptt_key（按键）只以 _key 结尾、不含 api，故不命中。
SECRET_KEY_RE = re.compile(
    r'(api[_-]?key|apikey|secret|token|password|passwd|cookie|authorization|credential)$',
    re.IGNORECASE,
)
SECRET_MASK_PREFIX = '***'
SECRET_MASK_MIN_LEN = 8  # ≤8 位只回 ***，否则「末 4 位」已经泄露大半

# 2026-11-21 启停单一源：插件顶层 plugin_config.enabled 已废弃（唯一入口是控制中心
# 「外观 → 能力」页）。这里选择「GET 直接不返回」而不是「返回 + deprecated:true」：
# 现有前端 renderPluginConfigForm 会渲染 config 里的每一个键，且不认识的标记不会
# 让它跳过 —— 返回带标记的字段仍会出现一个能点的开关，等于没隐藏。不返回则前端
# 自然不渲染；保存时下面的 POST 链路把磁盘原值钉住，老客户端回传也不会删/改它。
DEPRECATED_TOP_LEVEL_KEYS = ('enabled',)


def is_secret_config_key(key):
    """键名是否属于凭据类（决定要不要掩码/回填）。"""
    return isinstance(key, str) and bool(SECRET_KEY_RE.search(key))


def mask_secret_text(value):
    """把凭据变成可展示串：***+末 4 位；太短则只回 ***。"""
    text = value if isinstance(value, str) else str(value or '')
    if len(text) <= SECRET_MASK_MIN_LEN:
        return SECRET_MASK_PREFIX
    return f'{SECRET_MASK_PREFIX}{text[-4:]}'


def is_blank_or_mask(value):
    """空串 / ***xxxx / 全星号 都表示「客户端没提交新值」。"""
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text:
        return True
    if text.startswith(SECRET_MASK_PREFIX):
        return True
    return len(text) >= 3 and set(text) == {'*'}


def _is_schema_node(node):
    """plugin_config.json 的 schema 节点：{title, type, default, value}。"""
    return isinstance(node, dict) and 'value' in node and ('type' in node or 'title' in node)


def mask_secret_payload(node, key=None, path=(), masked_paths=None):
    """递归复制配置并掩码凭据，返回掩码后的新结构。

    被掩码的位置会追加到 ``masked_paths``（元组路径），供 GET 返回 ``masked_keys``。

    - schema 节点：父键名命中敏感词时掩掉 ``value``，同级补 ``hasKey: true``；
      ``default`` 与 ``value`` 同规则掩码（2026-11-21：default 里也可能写密钥），
      但不计入 masked_keys、也不据此补 hasKey（default 是随插件发布的默认值）；
    - 普通数据对象/数组：按各自键名递归掩码（不在数据里加标记，避免被写回真实配置）；
    - 非字符串（数字/布尔）一律原样保留，只递归查找里面的凭据。
    """
    if isinstance(node, dict):
        result = OrderedDict()
        for k, v in node.items():
            if k == 'fields' and isinstance(v, dict):
                result[k] = OrderedDict(
                    (fk, mask_secret_payload(fv, fk, path + (fk,), masked_paths))
                    for fk, fv in v.items()
                )
            elif k == 'value' and _is_schema_node(node):
                # value 属于同一个配置键，路径不再加一层 value
                result[k] = mask_secret_payload(v, key, path, masked_paths)
            elif k == 'default' and isinstance(node, dict) and ('type' in node or 'title' in node):
                # default 与 value 同规则：凭据键的默认值也不能明文出 GET。
                # 条件比 _is_schema_node 略宽：没有 value 的 schema 节点也要盖住 default。
                # masked_paths=None：default 不是「用户已配置」，不参与 masked_keys。
                result[k] = mask_secret_payload(v, key, path, None)
            else:
                result[k] = mask_secret_payload(v, k, path + (k,), masked_paths)
        if _is_schema_node(node) and is_secret_config_key(key):
            raw = node.get('value')
            if isinstance(raw, str):
                if raw:
                    result['value'] = mask_secret_text(raw)
                    result['hasKey'] = True
                    if masked_paths is not None:
                        masked_paths.append(path or (key,))
            elif raw not in (None, '', [], {}):
                result['hasKey'] = True
        return result
    if isinstance(node, list):
        out = []
        for index, item in enumerate(node):
            item_path = path + (index,)
            if is_secret_config_key(key) and isinstance(item, str) and item:
                out.append(mask_secret_text(item))
                if masked_paths is not None:
                    masked_paths.append(item_path)
            else:
                out.append(mask_secret_payload(item, key, item_path, masked_paths))
        return out
    if isinstance(node, str) and is_secret_config_key(key) and node:
        if masked_paths is not None:
            masked_paths.append(path or (key,))
        return mask_secret_text(node)
    return node


def restore_secret_payload(incoming, original, key=None):
    """保存时把「空串/掩码」还原成磁盘原值，只有全新真实字符串才覆盖。

    ``key`` 是 incoming 所属键名（schema 节点的 value 沿用父键名）。
    """
    if incoming is None and is_secret_config_key(key):
        return original if original is not None else ''
    if isinstance(incoming, dict):
        base = original if isinstance(original, dict) else {}
        base_fields = base.get('fields') if isinstance(base.get('fields'), dict) else {}
        result = OrderedDict()
        for k, v in incoming.items():
            if k == 'value' and _is_schema_node(incoming):
                result[k] = restore_secret_payload(v, base.get('value'), key)
            elif k == 'fields' and isinstance(v, dict):
                result[k] = OrderedDict(
                    (fk, restore_secret_payload(fv, base_fields.get(fk), fk))
                    for fk, fv in v.items()
                )
            else:
                result[k] = restore_secret_payload(v, base.get(k), k)
        # 提交里被漏掉的敏感键从原配置补回，避免一次保存静默丢 key
        for k, v in base.items():
            if k not in result and is_secret_config_key(k) and v not in (None, '', [], {}):
                result[k] = v
        return result
    if isinstance(incoming, list):
        base = original if isinstance(original, list) else []
        return [
            restore_secret_payload(item, base[index] if index < len(base) else None, key)
            for index, item in enumerate(incoming)
        ]
    if is_secret_config_key(key) and isinstance(incoming, str):
        if not is_blank_or_mask(incoming):
            return incoming
        # 掩码/空值：有原值就回填；没有原值可回填就落空串，绝不把掩码写盘
        return original if original is not None else ''
    return incoming


def _read_plugin_config(plugin_path):
    if '/' not in plugin_path:
        return None
    category, dir_name = plugin_path.split('/', 1)
    if category not in ['built-in', 'community']:
        return None
    config_path = PROJECT_ROOT / 'plugins' / category / dir_name / 'plugin_config.json'
    if not config_path.exists():
        return None
    with open(config_path, 'r', encoding='utf-8-sig') as f:
        return json.load(f)


def _probe_local_json(url, timeout=0.35):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            if resp.status != 200:
                return None
            raw = resp.read(64 * 1024).decode('utf-8', errors='replace')
            return json.loads(raw)
    except (OSError, ValueError, urllib.error.URLError):
        return None


def load_enabled_plugins():
    """从 enabled_plugins.json 加载已启用的插件列表"""
    enabled_path = PROJECT_ROOT / 'plugins' / 'enabled_plugins.json'
    if not enabled_path.exists():
        return []
    try:
        with open(enabled_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data.get('plugins', [])
    except Exception as e:
        logger.error(f'加载 enabled_plugins.json 失败：{e}')
        return []


def save_enabled_plugins(enabled_list):
    """保存已启用的插件列表到 enabled_plugins.json"""
    enabled_path = PROJECT_ROOT / 'plugins' / 'enabled_plugins.json'
    try:
        with open(enabled_path, 'w', encoding='utf-8') as f:
            json.dump({'plugins': enabled_list}, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        logger.error(f'保存 enabled_plugins.json 失败：{e}')
        return False


def enable_plugin_path(plugin_path):
    """把 category/dir 写进 enabled_plugins.json，已存在则不动。返回是否发生了写入。

    供插件广场"安装即启用"调用：跨进程锁 + 原子写，Electron 侧监听到文件变化后会热加载。
    写入失败直接抛异常，由调用方决定是否只当作警告。
    """
    plugin_path = str(plugin_path).replace('\\', '/').strip()
    if '/' not in plugin_path:
        raise ValueError('插件路径应为 category/name 格式')
    category, dir_name = plugin_path.split('/', 1)
    if category not in ('built-in', 'community') or not dir_name:
        raise ValueError('无效的插件类别')

    enabled_path = PROJECT_ROOT / 'plugins' / 'enabled_plugins.json'
    with resource_lock(enabled_path):
        enabled = list(load_enabled_plugins())
        if plugin_path in enabled:
            return False
        enabled.append(plugin_path)
        atomic_write_json(enabled_path, {'plugins': enabled})
        return True


def scan_plugins_directory():
    """自动扫描插件目录（built-in 和 community）"""
    plugins = []
    plugins_base = PROJECT_ROOT / 'plugins'
    enabled_plugins = load_enabled_plugins()

    for category in ['built-in', 'community']:
        category_path = plugins_base / category
        if not category_path.exists():
            continue

        for plugin_dir in category_path.iterdir():
            if not plugin_dir.is_dir():
                continue

            metadata_path = plugin_dir / 'metadata.json'
            if not metadata_path.exists():
                continue

            try:
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)

                # 使用目录名作为插件路径（与 live-2d 保持一致）
                plugin_path = f"{category}/{plugin_dir.name}"
                plugin_enabled = plugin_path in enabled_plugins
                framework_version = metadata.get('framework_version', '')
                compatible, compatibility_message = check_framework_compatibility(
                    framework_version,
                    PLUGIN_FRAMEWORK_VERSION,
                )

                plugins.append({
                    'name': metadata.get('name', plugin_dir.name),
                    'display_name': metadata.get('displayName', metadata.get('name', plugin_dir.name)),
                    'description': metadata.get('description', '无描述'),
                    'version': metadata.get('version', '1.0.0'),
                    'author': metadata.get('author', 'unknown'),
                    'repo': metadata.get('repo', ''),
                    'framework_version': framework_version,
                    'compatible': compatible,
                    'compatibility_message': compatibility_message,
                    'category': category,
                    'enabled': plugin_enabled,
                    'plugin_path': plugin_path,
                    'plugin_dir': str(plugin_dir),
                    'has_own_config': (plugin_dir / 'plugin_config.json').exists(),
                    # 独立面板入口仅当插件目录真实存在且属于已知名单时才标真。
                    # 本仓库未内置 auto-act / companion-director，故默认全为 False。
                    'has_local_panel': plugin_path in (
                        'built-in/companion-director',
                        'built-in/auto-act',
                    ) and plugin_dir.is_dir()
                })
            except Exception as e:
                logger.error(f'读取插件元数据失败 {plugin_dir.name}: {e}')

    return plugins


@plugin_bp.route('/api/plugins/list')
def list_plugins():
    """获取插件列表（自动扫描）"""
    try:
        plugins = scan_plugins_directory()
        check_updates = request.args.get('check_updates', 'false').lower() == 'true'
        if check_updates:
            update_info = check_updates_for_plugins(plugins)
            for plugin in plugins:
                info = update_info.get(plugin.get('name'))
                if not info:
                    continue
                plugin['latest_version'] = info.get('latest_version', '')
                plugin['has_update'] = bool(info.get('has_update'))
                plugin['update_error'] = info.get('update_error', '')
        return jsonify(plugins)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@plugin_bp.route('/api/plugins/toggle', methods=['POST'])
def toggle_plugin():
    """切换插件启用状态（使用 enabled_plugins.json）
    
    使用 POST body 传递 plugin_path，避免 URL 中/的问题
    """
    enabled_plugins = load_enabled_plugins()
    
    data = request.get_json()
    if not data:
        return jsonify({'success': False, 'error': '无效的请求数据'}), 400
    
    plugin_path = data.get('plugin_path')
    if not plugin_path:
        return jsonify({'success': False, 'error': '缺少 plugin_path 参数'}), 400

    # 路径白名单 + realpath 越界校验
    plugin_dir, path_error = resolve_plugin_dir(plugin_path)
    if path_error:
        logger.warning('拒绝非法 plugin_path：%r（%s）', plugin_path, path_error)
        return jsonify({'success': False, 'error': path_error}), 400

    if not plugin_dir.exists() or not os.path.isdir(plugin_dir):
        return jsonify({'success': False, 'error': f'插件目录不存在：{plugin_path}'}), 404
    
    # 切换状态
    if plugin_path in enabled_plugins:
        enabled_plugins.remove(plugin_path)
        action = 'disabled'
    else:
        enabled_plugins.append(plugin_path)
        action = 'enabled'
    
    if save_enabled_plugins(enabled_plugins):
        return jsonify({
            'success': True,
            'action': action,
            'plugin_path': plugin_path
        })
    return jsonify({'success': False, 'error': '保存失败'}), 500


@plugin_bp.route('/api/plugins/panel-info', methods=['POST'])
def plugin_panel_info():
    """Return safe local panel metadata for plugins that expose an own WebUI."""
    data = request.get_json() or {}
    plugin_path = data.get('plugin_path', '')
    panel_defaults = {
        'built-in/companion-director': {
            'port': 22336,
            'probe_path': 'api/status',
            'kind': 'companion-director',
        },
        'built-in/auto-act': {
            'port': 22341,
            'probe_path': 'health',
            'kind': 'feiniu-house',
        },
    }
    panel = panel_defaults.get(plugin_path)
    if not panel:
        return jsonify({
            'success': False,
            'error': '该插件没有已知的独立面板'
        }), 404

    try:
        cfg = _read_plugin_config(plugin_path) or {}
        enabled = _to_bool(_schema_value(cfg.get('webui_enabled'), True), True)
        host = str(_schema_value(cfg.get('webui_host'), '127.0.0.1') or '127.0.0.1').strip()
        port = int(_schema_value(cfg.get('webui_port'), panel['port']) or panel['port'])

        # The companion panel is intentionally local-only. Even if config drifts,
        # the main WebUI should never hand out a non-loopback management URL.
        if host not in ('127.0.0.1', 'localhost', '::1'):
            host = '127.0.0.1'

        url_host = '[::1]' if host == '::1' else host
        url = f'http://{url_host}:{port}/'
        status = None
        for candidate_port in range(port, port + 21):
            candidate_url = f'http://{url_host}:{candidate_port}/'
            candidate_status = _probe_local_json(f"{candidate_url}{panel['probe_path']}")
            if candidate_status and candidate_status.get('ok'):
                url = candidate_url
                status = candidate_status
                break
        return jsonify({
            'success': True,
            'available': bool(status and status.get('ok')),
            'enabled': enabled,
            'url': url,
            'mode': status.get('mode') if isinstance(status, dict) else None,
            'panel_kind': panel['kind'],
            'reason': None if status else 'panel_not_running'
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@plugin_bp.route('/api/plugins/open-panel', methods=['POST'])
def open_plugin_panel():
    """Ask the OS browser to open a known safe local plugin panel."""
    info_resp = plugin_panel_info()
    status_code = info_resp[1] if isinstance(info_resp, tuple) else 200
    resp = info_resp[0] if isinstance(info_resp, tuple) else info_resp
    if status_code != 200:
        return info_resp

    payload = resp.get_json() or {}
    url = payload.get('url')
    if payload.get('enabled') is False:
        return jsonify({
            'success': False,
            'error': '该插件当前未启用，本地面板未运行',
            'url': url
        }), 409
    if not url or not str(url).startswith(('http://127.0.0.1:', 'http://localhost:')):
        return jsonify({'success': False, 'error': '面板 URL 不安全或不可用'}), 400

    try:
        import webbrowser
        webbrowser.open(url)
        payload['opened'] = True
        return jsonify(payload)
    except Exception as e:
        payload['opened'] = False
        payload['error'] = str(e)
        return jsonify(payload), 500


@plugin_bp.route('/api/plugins/open-config', methods=['POST'])
def open_plugin_config():
    """打开插件配置文件或目录
    
    使用 POST body 传递 plugin_path，避免 URL 中/的问题
    """
    data = request.get_json()
    if not data:
        return jsonify({'success': False, 'error': '无效的请求数据'}), 400
    
    plugin_path = data.get('plugin_path')
    if not plugin_path:
        return jsonify({'success': False, 'error': '缺少 plugin_path 参数'}), 400

    # 只允许打开 plugins/{built-in,community}/<白名单目录名>，杜绝 os.startfile 任意路径
    plugin_dir, path_error = resolve_plugin_dir(plugin_path)
    if path_error:
        logger.warning('拒绝非法 open-config plugin_path：%r（%s）', plugin_path, path_error)
        return jsonify({'success': False, 'error': path_error}), 400

    plugin_config_key = os.path.basename(str(plugin_dir)).replace('-', '_')

    if not plugin_dir.exists() or not os.path.isdir(plugin_dir):
        return jsonify({
            'success': False,
            'error': f'插件目录不存在：{plugin_path}'
        }), 404
    
    # 检查插件是否有自己的配置文件
    plugin_config = plugin_dir / 'index.js'
    plugins_root = os.path.realpath(str(PROJECT_ROOT / 'plugins'))
    if plugin_config.exists():
        # 只打开 plugins 目录内真实存在的 index.js（防 symlink 指向外部）
        real_config = os.path.realpath(str(plugin_config))
        try:
            inside_plugins = os.path.commonpath([plugins_root, real_config]) == plugins_root
        except ValueError:
            inside_plugins = False
        if not inside_plugins:
            return jsonify({'success': False, 'error': '插件文件越界'}), 400
        # 打开插件的 index.js 文件
        try:
            os.startfile(real_config)
            return jsonify({
                'success': True,
                'config_path': str(plugin_config),
                'message': f'已打开插件主文件：{plugin_config}\n请在 config.json 中配置该插件（plugins.{plugin_config_key}）'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'打开文件失败：{str(e)}',
                'config_path': str(plugin_config)
            })
    else:
        # 打开插件目录
        try:
            os.startfile(str(plugin_dir))
            return jsonify({
                'success': True,
                'config_path': str(plugin_dir),
                'message': f'已打开插件目录：{plugin_dir}\n请在 config.json 中配置该插件（plugins.{plugin_config_key}）'
            })
        except Exception as e:
            return jsonify({
                'success': False,
                'error': f'打开目录失败：{str(e)}',
                'config_path': str(plugin_dir)
            })


@plugin_bp.route('/api/plugins/<plugin_name>/config', methods=['GET'])
def get_plugin_config(plugin_name):
    """获取插件的配置数据 - 使用 display_name 识别插件"""
    try:
        # 安全检查：防止路径遍历攻击
        if '..' in plugin_name or '/' in plugin_name or '\\' in plugin_name:
            return jsonify({'error': '无效的插件名称'}), 400
        
        # 使用 display_name 查找插件目录
        plugins_base = PROJECT_ROOT / 'plugins'
        config_file = None
        
        # 在 built-in 和 community 目录中查找插件配置文件
        for category in ['built-in', 'community']:
            category_path = plugins_base / category
            if not category_path.exists():
                continue
            
            for plugin_dir in category_path.iterdir():
                if not plugin_dir.is_dir():
                    continue
                
                metadata_path = plugin_dir / 'metadata.json'
                if not metadata_path.exists():
                    continue
                
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                display_name = metadata.get('displayName', metadata.get('name', plugin_dir.name))
                
                # 使用 display_name 匹配（替换空格和特殊字符）
                if display_name == plugin_name or display_name.replace(' ', '-').lower() == plugin_name.lower():
                    config_path = plugin_dir / 'plugin_config.json'
                    if config_path.exists():
                        config_file = config_path
                        break
            
            if config_file:
                break
        
        if not config_file:
            return jsonify({'error': f'插件 {plugin_name} 没有配置文件'}), 404
        
        # 读取配置文件（保持顺序）
        with open(config_file, 'r', encoding='utf-8') as f:
            config_data = json.load(f, object_pairs_hook=OrderedDict)
        
        # 获取键顺序（顶层 enabled 已废弃 → 不返回，前端也就不会渲染这个开关）
        config_keys = [k for k in config_data.keys() if k not in DEPRECATED_TOP_LEVEL_KEYS]

        # 凭据类字段只回掩码 + hasKey（递归覆盖嵌套对象/数组），绝不回明文
        masked_paths = []
        visible_config = OrderedDict(
            (k, v) for k, v in config_data.items() if k not in DEPRECATED_TOP_LEVEL_KEYS
        )
        masked_config = mask_secret_payload(visible_config, None, (), masked_paths)
        
        return jsonify({
            'success': True,
            'config': dict(masked_config),
            'config_keys': config_keys,
            'config_file': str(config_file),
            # 已废弃字段只声明键名，不回值（老前端可据此显示提示，不认识也安全）
            'deprecated_keys': [k for k in config_data.keys() if k in DEPRECATED_TOP_LEVEL_KEYS],
            # 被掩码的配置路径（扁平/嵌套都覆盖，供前端提示「已配置」）
            'masked_keys': list(OrderedDict.fromkeys(
                '.'.join(str(part) for part in path) for path in masked_paths
            )),
        })
    
    except json.JSONDecodeError as e:
        return jsonify({'error': f'配置文件格式错误：{str(e)}'}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@plugin_bp.route('/api/plugins/readme-exists', methods=['POST'])
def check_readme_exists_route():
    """检查插件是否有 README.md 文件 - 使用 display_name 识别插件"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'exists': False, 'error': '无效的请求数据'})
        
        display_name = data.get('display_name')
        if not display_name:
            return jsonify({'exists': False, 'error': '缺少 display_name 参数'})
        
        # 使用 display_name 查找插件目录
        plugins_base = PROJECT_ROOT / 'plugins'
        plugin_dir = None
        
        # 在 built-in 和 community 目录中查找插件
        for category in ['built-in', 'community']:
            category_path = plugins_base / category
            if not category_path.exists():
                continue
            
            for test_dir in category_path.iterdir():
                if not test_dir.is_dir():
                    continue
                
                metadata_path = test_dir / 'metadata.json'
                if not metadata_path.exists():
                    continue
                
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                plugin_display_name = metadata.get('displayName', metadata.get('name', test_dir.name))
                
                # 使用 display_name 匹配
                if plugin_display_name == display_name:
                    plugin_dir = test_dir
                    break
            
            if plugin_dir:
                break
        
        if not plugin_dir:
            return jsonify({'exists': False, 'error': f'插件 {display_name} 目录不存在'})
        
        # 查找 README.md 文件（支持多种命名）
        readme_exists = False
        for readme_name in ['README.md', 'readme.md', 'Readme.md', 'README.MD']:
            if (plugin_dir / readme_name).exists():
                readme_exists = True
                break
        
        return jsonify({'exists': readme_exists})
    
    except Exception as e:
        logger.error(f'检查 README 存在性失败：{e}')
        return jsonify({'exists': False, 'error': str(e)})


@plugin_bp.route('/api/plugins/<plugin_name>/config', methods=['POST'])
def save_plugin_config(plugin_name):
    """保存插件的配置数据 - 使用 display_name 识别插件，保持原始 JSON 顺序和元数据"""
    try:
        # 安全检查：防止路径遍历攻击
        if '..' in plugin_name or '/' in plugin_name or '\\' in plugin_name:
            return jsonify({'error': '无效的插件名称'}), 400
        
        # 获取请求数据
        config_data = request.get_json()
        if not config_data:
            return jsonify({'error': '没有配置数据'}), 400
        
        # 使用 display_name 查找插件目录
        plugins_base = PROJECT_ROOT / 'plugins'
        config_file = None
        
        # 在 built-in 和 community 目录中查找插件配置文件
        for category in ['built-in', 'community']:
            category_path = plugins_base / category
            if not category_path.exists():
                continue
            
            for plugin_dir in category_path.iterdir():
                if not plugin_dir.is_dir():
                    continue
                
                metadata_path = plugin_dir / 'metadata.json'
                if not metadata_path.exists():
                    continue
                
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                display_name = metadata.get('displayName', metadata.get('name', plugin_dir.name))
                
                # 使用 display_name 匹配
                if display_name == plugin_name or display_name.replace(' ', '-').lower() == plugin_name.lower():
                    config_path = plugin_dir / 'plugin_config.json'
                    if config_path.exists():
                        config_file = config_path
                        break
            
            if config_file:
                break
        
        if not config_file:
            return jsonify({'error': f'插件 {plugin_name} 没有配置文件'}), 404
        
        # 读取原始配置文件以保持顺序和元数据
        with open(config_file, 'r', encoding='utf-8') as f:
            original_config = json.load(f, object_pairs_hook=OrderedDict)
        
        # 按照原始配置文件的键顺序重新排列新配置
        ordered_config = OrderedDict()
        for key in original_config.keys():
            original_item = original_config[key]

            # 已废弃的顶层 enabled：GET 不返回；即使老客户端把它回传，也一律保留磁盘原值，
            # 不因一次保存被删掉或改掉（启停只认控制中心能力页）。
            if key in DEPRECATED_TOP_LEVEL_KEYS:
                ordered_config[key] = original_item
                continue

            # 检查是否是带元数据的配置项（有 title, type 等字段）
            if isinstance(original_item, dict) and 'type' in original_item:
                # 这是带元数据的配置项，只更新 value 字段
                ordered_config[key] = OrderedDict(original_item)
                if key in config_data:
                    submitted = config_data[key]
                    submitted_node = submitted if isinstance(submitted, dict) else None
                    # 兼容把 GET 回来的整个 schema 节点原样回传的客户端：只取 value
                    if (
                        _is_schema_node(submitted)
                        and 'value' in original_item
                        and not isinstance(original_item.get('value'), dict)
                    ):
                        submitted = submitted.get('value')
                    # 掩码/空值回填磁盘原值，只有全新真实字符串才覆盖
                    ordered_config[key]['value'] = restore_secret_payload(
                        submitted, original_item.get('value'), key
                    )
                    # default 与 value 同规则（2026-11-21）：GET 现在会把凭据键的
                    # default 也掩码，客户端整节点回传时不能把 *** 写盘。
                    # 掩码/空 → 保留磁盘原 default；真正的新字符串才覆盖。
                    if (
                        submitted_node is not None
                        and 'default' in submitted_node
                        and is_secret_config_key(key)
                    ):
                        restored_default = restore_secret_payload(
                            submitted_node.get('default'), original_item.get('default'), key
                        )
                        # 原节点没有 default 且提交的是掩码/空：不凭空造字段
                        if 'default' in original_item or not is_blank_or_mask(restored_default):
                            ordered_config[key]['default'] = restored_default
            else:
                # 这是简单值配置，直接更新
                if key in config_data:
                    ordered_config[key] = restore_secret_payload(
                        config_data[key], original_item, key
                    )
                else:
                    ordered_config[key] = original_item
        
        # 添加新配置中新增的键（如果有）
        for key in config_data.keys():
            if key in ordered_config:
                continue
            # 废弃字段不允许由客户端新增（例如老前端把默认 true 传回来）
            if key in DEPRECATED_TOP_LEVEL_KEYS:
                continue
            new_value = restore_secret_payload(config_data[key], None, key)
            # 没有原值可回填的掩码/空值不写盘（尤其不能把 *** 存进配置文件）
            if is_secret_config_key(key) and isinstance(new_value, str) and not new_value:
                continue
            ordered_config[key] = new_value
        
        # 保存新配置（保持原始顺序和 2 空格缩进）
        with open(config_file, 'w', encoding='utf-8') as f:
            json.dump(ordered_config, f, ensure_ascii=False, indent=2)
        
        return jsonify({
            'success': True,
            'message': '配置保存成功'
        })
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@plugin_bp.route('/api/plugins/<plugin_name>/readme-exists', methods=['GET'])
def check_readme_exists_api(plugin_name):
    """检查插件是否有 README.md 文件 - 使用 display_name 识别插件，返回 JSON 结果"""
    try:
        # 安全检查：防止路径遍历攻击
        if '..' in plugin_name or '/' in plugin_name or '\\' in plugin_name:
            return jsonify({'exists': False, 'error': '无效的插件名称'})
        
        # 使用 display_name 查找插件目录
        plugins_base = PROJECT_ROOT / 'plugins'
        plugin_dir = None
        
        # 在 built-in 和 community 目录中查找插件
        for category in ['built-in', 'community']:
            category_path = plugins_base / category
            if not category_path.exists():
                continue
            
            for test_dir in category_path.iterdir():
                if not test_dir.is_dir():
                    continue
                
                metadata_path = test_dir / 'metadata.json'
                if not metadata_path.exists():
                    continue
                
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                display_name = metadata.get('displayName', metadata.get('name', test_dir.name))
                
                # 使用 display_name 匹配
                if display_name == plugin_name or display_name.replace(' ', '-').lower() == plugin_name.lower():
                    plugin_dir = test_dir
                    break
            
            if plugin_dir:
                break
        
        if not plugin_dir:
            return jsonify({'exists': False, 'error': f'插件 {plugin_name} 目录不存在'})
        
        # 查找 README.md 文件（支持多种命名）
        readme_exists = False
        for readme_name in ['README.md', 'readme.md', 'Readme.md', 'README.MD']:
            if (plugin_dir / readme_name).exists():
                readme_exists = True
                break
        
        return jsonify({'exists': readme_exists})
    
    except Exception as e:
        return jsonify({'exists': False, 'error': str(e)})


@plugin_bp.route('/api/plugins/<plugin_name>/readme', methods=['POST'])
def open_plugin_readme(plugin_name):
    """打开插件目录下的 README.md 文件 - 使用 display_name 识别插件"""
    try:
        # 安全检查：防止路径遍历攻击
        if '..' in plugin_name or '/' in plugin_name or '\\' in plugin_name:
            return jsonify({'error': '无效的插件名称'}), 400
        
        # 使用 display_name 查找插件目录
        plugins_base = PROJECT_ROOT / 'plugins'
        plugin_dir = None
        
        # 在 built-in 和 community 目录中查找插件
        for category in ['built-in', 'community']:
            category_path = plugins_base / category
            if not category_path.exists():
                continue
            
            for test_dir in category_path.iterdir():
                if not test_dir.is_dir():
                    continue
                
                metadata_path = test_dir / 'metadata.json'
                if not metadata_path.exists():
                    continue
                
                with open(metadata_path, 'r', encoding='utf-8') as f:
                    metadata = json.load(f)
                
                display_name = metadata.get('displayName', metadata.get('name', test_dir.name))
                
                # 使用 display_name 匹配
                if display_name == plugin_name or display_name.replace(' ', '-').lower() == plugin_name.lower():
                    plugin_dir = test_dir
                    break
            
            if plugin_dir:
                break
        
        if not plugin_dir:
            return jsonify({'error': f'插件 {plugin_name} 目录不存在'}), 404
        
        # 查找 README.md 文件（支持多种命名）
        readme_file = None
        for readme_name in ['README.md', 'readme.md', 'Readme.md', 'README.MD']:
            test_readme = plugin_dir / readme_name
            if test_readme.exists():
                readme_file = test_readme
                break
        
        if not readme_file:
            return jsonify({
                'success': False,
                'error': '该插件没有 README.md 文件'
            }), 404
        
        # 打开 README.md 文件
        os.startfile(str(readme_file))
        return jsonify({
            'success': True,
            'message': f'已打开 README 文件：{readme_file}'
        })
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500
