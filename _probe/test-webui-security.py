#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WebUI 安全回归探针（Flask test_client，不启动服务、不联网）。

运行：
    <user-home>/AppData/Local/Programs/Python/Python313/python.exe _probe/test-webui-security.py

覆盖：
1. 状态变更接口的令牌 / 同源 Origin 收口
2. GET /api/config/llm 不回传真实 api_key（只给 has_key / key_hint）
3. 保存配置时回传掩码不会清空真实 key
4. role_name 路径穿越与 bat 文本命令注入
5. plugin_path 路径穿越
6. models/fetch 与 market/settings 的 SSRF 拒绝
7. /live-2d/ 不再泄露 config.json / .token
8. 插件配置凭据掩码：value 与 schema 的 default 同规则，保存时掩码/空值回填原值
"""

import io
import json
import shutil
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
LIVE2D_ROOT = PROJECT_ROOT / '_incoming' / 'my-neuro' / 'live-2d'
if str(LIVE2D_ROOT) not in sys.path:
    sys.path.insert(0, str(LIVE2D_ROOT))

TEMP_ROOT = Path(tempfile.mkdtemp(prefix='pet-webui-sec-'))

# ---- 在导入应用前隔离所有落盘路径（绝不碰真实 config.json / token） ----
import webui.security as security  # noqa: E402

security.TOKEN_PATH = TEMP_ROOT / '.token'
security.reset_for_tests()

from webui import config_manager as config_manager  # noqa: E402
from webui import log_monitor as log_monitor  # noqa: E402

config_manager.CONFIG_PATH = TEMP_ROOT / 'config.json'
config_manager.PROVIDER_STORE_PATH = TEMP_ROOT / 'llm_providers.json'
log_monitor.PROJECT_ROOT = TEMP_ROOT

import webui.market_settings as market_settings  # noqa: E402

market_settings.SETTINGS_PATH = TEMP_ROOT / 'plugin_market_settings.json'

SECRET_KEY = 'test-SECRET-abcdefghijklmnop-1234'
VOICE_SECRET = 'test-VOICESECRET-9876'
ALIYUN_SECRET = 'ali-VOICESECRET-1234'
config_manager.CONFIG_PATH.write_text(
    json.dumps({
        'llm': {'provider_id': 'main', 'model_id': 'gpt-test', 'system_prompt': 'hi'},
        'ui': {'webui_flavor': 'new'},
        'cloud': {
            'provider': 'siliconflow',
            'api_key': VOICE_SECRET,
            'aliyun_tts': {'api_key': ALIYUN_SECRET, 'workspace_id': 'ws'},
        },
    }, ensure_ascii=False),
    encoding='utf-8',
)
config_manager.PROVIDER_STORE_PATH.write_text(
    json.dumps({'providers': [{
        'id': 'main',
        'name': 'main',
        'api_key': SECRET_KEY,
        'api_url': 'https://api.example.com/v1',
        'enabled': True,
        'models': [{'model_id': 'gpt-test', 'name': 'gpt-test', 'enabled': True}],
    }]}, ensure_ascii=False),
    encoding='utf-8',
)

from webui.main_app import create_app  # noqa: E402

APP = create_app()
APP.testing = True
CLIENT = APP.test_client()
TOKEN = security.get_token()

PASS_COUNT = 0
FAIL_COUNT = 0
FAILURES = []


def check(name, condition, extra=''):
    global PASS_COUNT, FAIL_COUNT
    if condition:
        PASS_COUNT += 1
        print(f'PASS {name}')
    else:
        FAIL_COUNT += 1
        FAILURES.append(name)
        print(f'FAIL {name}{(" :: " + str(extra)) if extra else ""}')


def auth_headers(token=True):
    return {'X-Pet-Token': TOKEN} if token else {}


def post_json(path, payload=None, token=True, extra_headers=None):
    headers = dict(extra_headers or {})
    if token:
        headers.update(auth_headers())
    headers.setdefault('Content-Type', 'application/json')
    return CLIENT.post(path, data=json.dumps(payload if payload is not None else {}), headers=headers)


def post_multipart(path, fields, token=True):
    data = {}
    for key, value in fields.items():
        if isinstance(value, tuple):
            data[key] = value
        else:
            data[key] = value
    headers = auth_headers(token)
    return CLIENT.post(path, data=data, headers=headers, content_type='multipart/form-data')


# ---------------------------------------------------------------- 1. 鉴权
resp = CLIENT.post('/api/market/settings', data=json.dumps({}), content_type='application/json')
check('无 token 的 POST 被拒绝', resp.status_code in (401, 403), resp.status_code)

resp = CLIENT.post('/api/market/settings', data=json.dumps({}), content_type='application/json',
                   headers={'Origin': 'http://evil.example'})
check('跨源 Origin 的 POST 被拒绝', resp.status_code in (401, 403), resp.status_code)

resp = CLIENT.get('/api/config/llm')
check('GET 只读接口不要求 token', resp.status_code == 200, resp.status_code)

resp = post_json('/api/market/settings', {})
check('带正确 token 的 POST 通过', resp.status_code == 200, resp.status_code)

resp = CLIENT.post('/api/market/settings', data=json.dumps({}), content_type='application/json',
                   headers={'Origin': 'http://localhost'})
check('同源 Origin 的 POST 通过', resp.status_code == 200, resp.status_code)

resp = CLIENT.get('/', headers={'Host': 'evil.example'})
check('非本机 Host 被拒绝', resp.status_code == 403, resp.status_code)

# ---------------------------------------------------------------- 2. 凭据不回传
resp = CLIENT.get('/api/config/llm')
raw_body = resp.get_data(as_text=True)
payload = resp.get_json() or {}
check('GET /api/config/llm 不含真实 key', SECRET_KEY not in raw_body)
check('GET /api/config/llm 含 has_key', payload.get('has_key') is True, payload.get('has_key'))
check('GET /api/config/llm 含 key_hint', bool(payload.get('key_hint')), payload.get('key_hint'))
providers = payload.get('providers') or []
check('provider 列表不含 api_key 原文',
      all(SECRET_KEY not in json.dumps(item, ensure_ascii=False) for item in providers))
check('provider 含 has_key/key_hint',
      bool(providers) and providers[0].get('has_key') is True and bool(providers[0].get('key_hint')))

# ---------------------------------------------------------------- 3. 掩码保存不丢 key
save_payload = {'providers': providers}
resp = post_json('/api/config/llm', save_payload)
check('带掩码的 providers 保存成功', resp.status_code == 200, resp.get_data(as_text=True)[:200])
stored = json.loads(config_manager.PROVIDER_STORE_PATH.read_text(encoding='utf-8'))
stored_key = stored['providers'][0].get('api_key', '')
check('回传掩码后真实 key 仍在', stored_key == SECRET_KEY, stored_key)

resp = post_json('/api/config/llm', {'api_key': payload.get('key_hint', ''), 'api_url': 'https://api.example.com/v1'})
stored = json.loads(config_manager.PROVIDER_STORE_PATH.read_text(encoding='utf-8'))
check('旧三格回传 hint 后真实 key 仍在',
      stored['providers'][0].get('api_key') == SECRET_KEY,
      stored['providers'][0].get('api_key'))

# ------------------------------------------------- 3b. 声音/网关接口同样不回传明文
resp = CLIENT.get('/api/settings/voice')
voice_body = resp.get_data(as_text=True)
voice_data = resp.get_json() or {}
check('GET /api/settings/voice 不含真实 key',
      VOICE_SECRET not in voice_body and ALIYUN_SECRET not in voice_body)
resp = post_json('/api/settings/voice', {
    'api_key': voice_data.get('api_key', ''),
    'aliyun_tts': {'api_key': (voice_data.get('aliyun_tts') or {}).get('api_key', '')},
})
saved_voice = json.loads(config_manager.CONFIG_PATH.read_text(encoding='utf-8'))
check('回传声音接口掩码后真实 key 仍在',
      saved_voice['cloud'].get('api_key') == VOICE_SECRET
      and saved_voice['cloud']['aliyun_tts'].get('api_key') == ALIYUN_SECRET,
      saved_voice.get('cloud'))

# ---------------------------------------------------------------- 4. 声音克隆路径/命令注入
resp = post_multipart('/api/voice-clone/generate-bat', {
    'role_name': '../../x',
    'language': 'zh',
    'text': 'hello',
    'model_file': (io.BytesIO(b'model'), 'model.pth'),
    'audio_file': (io.BytesIO(b'audio'), 'audio.wav'),
})
check('role_name 路径穿越被拒绝', resp.status_code == 400, resp.status_code)

injected = '& calc & echo pwned'
resp = post_multipart('/api/voice-clone/generate-bat', {
    'role_name': 'alice',
    'language': 'zh',
    'text': injected,
    'model_file': (io.BytesIO(b'model'), 'model.pth'),
    'audio_file': (io.BytesIO(b'audio'), 'audio.wav'),
    'gpt_model_file': (io.BytesIO(b'ckpt'), 'gpt.ckpt'),
})
check('合法 role_name 生成成功', resp.status_code == 200, resp.get_data(as_text=True)[:300])
voice_dir = TEMP_ROOT / 'Voice_Model_Factory'
bat_text = (voice_dir / 'alice.bat').read_text(encoding='utf-8') if (voice_dir / 'alice.bat').exists() else ''
ps1_text = (voice_dir / 'alice.ps1').read_text(encoding='utf-8-sig') if (voice_dir / 'alice.ps1').exists() else ''
txt_text = (voice_dir / 'alice.txt').read_text(encoding='utf-8') if (voice_dir / 'alice.txt').exists() else ''
check('bat 不含注入文本', 'calc' not in bat_text and 'pwned' not in bat_text)
check('ps1 不含注入文本', 'calc' not in ps1_text and 'pwned' not in ps1_text)
check('注入文本被写入 txt', injected in txt_text)

# ---------------------------------------------------------------- 5. 插件路径穿越
for path in ('/api/plugins/toggle', '/api/plugins/open-config'):
    resp = post_json(path, {'plugin_path': 'built-in/../../x'})
    check(f'{path} 拒绝 ../ 穿越', resp.status_code in (400, 404), resp.status_code)
    resp = post_json(path, {'plugin_path': 'built-in/..'})
    check(f'{path} 拒绝 .. 目录名', resp.status_code in (400, 404), resp.status_code)

# ---------------------------------------------------------------- 6. SSRF
for api_url in ('http://example.com', 'https://127.0.0.1', 'https://localhost:8080', 'https://[::1]:8080'):
    resp = post_json('/api/config/llm/providers/models/fetch', {'api_url': api_url, 'api_key': 'x'})
    check(f'models/fetch 拒绝 {api_url}', resp.status_code == 400, resp.status_code)

for hub_url in ('http://example.com/hub.json', 'https://127.0.0.1/hub.json', 'https://localhost/hub.json'):
    resp = post_json('/api/market/settings', {'hub_url': hub_url})
    check(f'market/settings 拒绝 {hub_url}', resp.status_code == 400, resp.status_code)

# ---------------------------------------------------------------- 7. 静态资源不泄露
resp = CLIENT.get('/live-2d/config.json')
check('/live-2d/config.json 被拒绝', resp.status_code == 404, resp.status_code)
resp = CLIENT.get('/live-2d/webui/.token')
check('/live-2d/webui/.token 被拒绝', resp.status_code == 404, resp.status_code)
resp = CLIENT.get('/live-2d/js/../config.json')
check('/live-2d 穿越白名单目录被拒绝', resp.status_code == 404, resp.status_code)

# ---------------------------------------------------------------- 8. 插件配置凭据掩码
# plugin_config.json 链路：GET 只回掩码 + hasKey，保存时掩码/空值回填磁盘原值。
import webui.plugin_manager as plugin_manager  # noqa: E402

PLUGIN_SECRET = 'tvly-REALSECRET-9f8e7d6c5b4a'
PLUGIN_NESTED_SECRET = 'NESTED-SECRET-12345678'
PLUGIN_ARRAY_SECRET = 'ARRAY-SECRET-87654321'
PLUGIN_FLAT_SECRET = 'LEGACY-TOKEN-abcdef123456'
PLUGIN_NEW_SECRET = 'tvly-NEWSECRET-0000111122223333'
PLUGIN_NEW_NESTED = 'NEW-NESTED-SECRET-77778888'
PLUGIN_DEFAULT_SECRET = 'test-DEFAULTSECRET-445566778899'
PLUGIN_NEW_DEFAULT = 'test-NEWDEFAULT-0000111122223333'

PLUGIN_ROOT = TEMP_ROOT / 'plugins'
PLUGIN_DIR = PLUGIN_ROOT / 'built-in' / 'web-search-test'
PLUGIN_DIR.mkdir(parents=True, exist_ok=True)
(PLUGIN_DIR / 'metadata.json').write_text(
    json.dumps({'displayName': 'Web Search Test'}, ensure_ascii=False),
    encoding='utf-8',
)


def plugin_config_doc():
    return {
        # 2026-11-21 已废弃：启停唯一入口是控制中心能力页。
        # GET 不应返回它（否则老前端仍会渲染一个能点的开关），保存也不许删/改磁盘值。
        'enabled': {
            'title': '启用', 'description': '已废弃，请在控制中心「外观 → 能力」页启停',
            'type': 'bool', 'default': True, 'value': True,
        },
        'tavily_api_key': {
            'title': 'Tavily API Key', 'description': '搜索服务 key',
            'type': 'string', 'default': '', 'value': PLUGIN_SECRET,
        },
        'ptt_key': {
            'title': '语音按键', 'description': '按键名，不是凭据',
            'type': 'string', 'default': 'v', 'value': 'v',
        },
        'search_base_url': {
            'title': '本地搜索地址', 'type': 'string',
            'default': 'http://127.0.0.1:18080', 'value': 'http://127.0.0.1:18080',
        },
        # 2026-11-21：default 里也可能写密钥 —— GET 必须与 value 同规则掩码
        'backup_api_key': {
            'title': '备用 API Key', 'type': 'string',
            'default': PLUGIN_DEFAULT_SECRET, 'value': '',
        },
        'nested': {
            'title': '嵌套配置', 'type': 'object',
            'fields': {
                'password': {'title': '密码', 'type': 'string', 'default': '可留空'},
                'host': {'title': '主机', 'type': 'string', 'default': '127.0.0.1'},
            },
            'value': {
                'password': PLUGIN_NESTED_SECRET,
                'host': '127.0.0.1',
                'backup_token': [PLUGIN_ARRAY_SECRET],
                'retries': 3,
                'enabled': True,
            },
        },
        # 老版本平铺格式（非 schema 节点）
        'legacy_token': PLUGIN_FLAT_SECRET,
    }


PLUGIN_CONFIG_PATH = PLUGIN_DIR / 'plugin_config.json'
PLUGIN_CONFIG_PATH.write_text(
    json.dumps(plugin_config_doc(), ensure_ascii=False, indent=2),
    encoding='utf-8',
)
ORIGINAL_PLUGIN_DOC = plugin_config_doc()
PLUGIN_URL = '/api/plugins/Web%20Search%20Test/config'

_prev_project_root = plugin_manager.PROJECT_ROOT
plugin_manager.PROJECT_ROOT = TEMP_ROOT
try:
    # ---- 8a. GET 只回掩码 ----
    resp = CLIENT.get(PLUGIN_URL)
    raw_body = resp.get_data(as_text=True)
    payload = resp.get_json() or {}
    plugin_cfg = payload.get('config') or {}
    check('插件配置 GET 成功', resp.status_code == 200 and payload.get('success') is True,
          resp.status_code)
    # ---- 8a-1. 废弃字段 enabled：不返回值，只声明键名 ----
    check('顶层 enabled 不再返回给前端', 'enabled' not in plugin_cfg, list(plugin_cfg))
    check('config_keys 也不含废弃的 enabled',
          'enabled' not in (payload.get('config_keys') or []), payload.get('config_keys'))
    check('deprecated_keys 声明 enabled（只给键名不给值）',
          payload.get('deprecated_keys') == ['enabled'], payload.get('deprecated_keys'))
    check('插件配置 GET 不含任何明文凭据',
          all(secret not in raw_body for secret in
              (PLUGIN_SECRET, PLUGIN_NESTED_SECRET, PLUGIN_ARRAY_SECRET, PLUGIN_FLAT_SECRET,
               PLUGIN_DEFAULT_SECRET)))
    check('tavily_api_key 只回掩码',
          plugin_cfg.get('tavily_api_key', {}).get('value') == '***' + PLUGIN_SECRET[-4:],
          plugin_cfg.get('tavily_api_key'))
    check('tavily_api_key 带 hasKey 标记',
          plugin_cfg.get('tavily_api_key', {}).get('hasKey') is True)
    # ---- 8a-2. schema 节点的 default 与 value 同规则掩码 ----
    check('default 里的密钥被掩码',
          plugin_cfg.get('backup_api_key', {}).get('default') == '***' + PLUGIN_DEFAULT_SECRET[-4:],
          plugin_cfg.get('backup_api_key'))
    check('default 掩码不补 hasKey（没有 value 不算已配置）',
          'hasKey' not in plugin_cfg.get('backup_api_key', {}),
          plugin_cfg.get('backup_api_key'))
    check('ptt_key 不被掩码',
          plugin_cfg.get('ptt_key', {}).get('value') == 'v'
          and 'hasKey' not in plugin_cfg.get('ptt_key', {}),
          plugin_cfg.get('ptt_key'))
    nested_value = plugin_cfg.get('nested', {}).get('value') or {}
    check('嵌套对象里的 password 被掩码',
          nested_value.get('password') == '***' + PLUGIN_NESTED_SECRET[-4:],
          nested_value.get('password'))
    check('嵌套数组里的 token 被掩码',
          nested_value.get('backup_token') == ['***' + PLUGIN_ARRAY_SECRET[-4:]],
          nested_value.get('backup_token'))
    check('非字符串值原样保留',
          nested_value.get('retries') == 3 and nested_value.get('enabled') is True)
    check('平铺老格式凭据也被掩码',
          plugin_cfg.get('legacy_token') == '***' + PLUGIN_FLAT_SECRET[-4:],
          plugin_cfg.get('legacy_token'))
    masked_keys = payload.get('masked_keys') or []
    check('masked_keys 覆盖 schema/嵌套/平铺路径',
          'tavily_api_key' in masked_keys and 'nested.password' in masked_keys
          and 'legacy_token' in masked_keys and 'ptt_key' not in masked_keys,
          masked_keys)

    # ---- 8b. 回传掩码/空串 → 磁盘原值不变 ----
    resp = post_json(PLUGIN_URL, {
        'tavily_api_key': plugin_cfg['tavily_api_key']['value'],
        'ptt_key': plugin_cfg['ptt_key']['value'],
        'search_base_url': plugin_cfg['search_base_url']['value'],
        'nested': nested_value,
        'legacy_token': plugin_cfg['legacy_token'],
    })
    disk_text = PLUGIN_CONFIG_PATH.read_text(encoding='utf-8')
    disk_doc = json.loads(disk_text)
    check('回传掩码保存成功', resp.status_code == 200, resp.get_data(as_text=True)[:200])
    check('回传掩码后 tavily key 仍是原值',
          disk_doc['tavily_api_key']['value'] == PLUGIN_SECRET)
    check('回传掩码后嵌套 password / 数组 token 仍是原值',
          disk_doc['nested']['value']['password'] == PLUGIN_NESTED_SECRET
          and disk_doc['nested']['value']['backup_token'] == [PLUGIN_ARRAY_SECRET])
    check('回传掩码后平铺 token 仍是原值', disk_doc['legacy_token'] == PLUGIN_FLAT_SECRET)
    check('磁盘上没有掩码串', '***' not in disk_text)
    check('保存后 ptt_key / 数字 / 布尔未被改动',
          disk_doc['ptt_key']['value'] == 'v'
          and disk_doc['nested']['value']['retries'] == 3
          and disk_doc['nested']['value']['enabled'] is True)
    check('保存未提交 enabled 时磁盘原值保留', disk_doc['enabled']['value'] is True)

    # 老前端（GET 仍带 enabled 的缓存页面）回传 enabled=false：一律保留磁盘原值
    resp = post_json(PLUGIN_URL, {'enabled': False})
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('老客户端回传 enabled 也不能改磁盘值（启停只认能力页）',
          resp.status_code == 200 and disk_doc['enabled']['value'] is True,
          disk_doc.get('enabled'))

    # 空串同样视为「保持原值」
    resp = post_json(PLUGIN_URL, {
        'tavily_api_key': '',
        'nested': {'password': '', 'host': '127.0.0.1',
                   'backup_token': [''], 'retries': 3, 'enabled': True},
    })
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('空串回传不清空真实 key',
          resp.status_code == 200
          and disk_doc['tavily_api_key']['value'] == PLUGIN_SECRET
          and disk_doc['nested']['value']['password'] == PLUGIN_NESTED_SECRET,
          disk_doc.get('tavily_api_key'))
    check('空串数组元素回填原 token',
          disk_doc['nested']['value']['backup_token'] == [PLUGIN_ARRAY_SECRET])

    # 整节点原样回传（GET→POST 往返）也只取 value，不污染 schema
    resp = post_json(PLUGIN_URL, {'tavily_api_key': plugin_cfg['tavily_api_key']})
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('整节点回传时只取 value 且不落掩码',
          resp.status_code == 200
          and disk_doc['tavily_api_key']['value'] == PLUGIN_SECRET
          and isinstance(disk_doc['tavily_api_key'], dict)
          and 'title' in disk_doc['tavily_api_key'],
          disk_doc.get('tavily_api_key'))

    # ---- 8b-2. default 回传：掩码/空 → 保留磁盘原值；真值 → 覆盖 ----
    resp = post_json(PLUGIN_URL, {'backup_api_key': plugin_cfg['backup_api_key']})
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('整节点回传掩码 default 后磁盘原值不变',
          resp.status_code == 200
          and disk_doc['backup_api_key']['default'] == PLUGIN_DEFAULT_SECRET,
          disk_doc.get('backup_api_key'))
    resp = post_json(PLUGIN_URL, {'backup_api_key': {
        'title': '备用 API Key', 'type': 'string', 'default': '', 'value': ''}})
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('空 default 回传不清空磁盘原值',
          resp.status_code == 200
          and disk_doc['backup_api_key']['default'] == PLUGIN_DEFAULT_SECRET,
          disk_doc.get('backup_api_key'))
    check('default 掩码串不落盘',
          '***' not in json.dumps(disk_doc.get('backup_api_key'), ensure_ascii=False))
    resp = post_json(PLUGIN_URL, {'backup_api_key': {
        'title': '备用 API Key', 'type': 'string',
        'default': PLUGIN_NEW_DEFAULT, 'value': ''}})
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('提交全新 default 正常写入',
          resp.status_code == 200
          and disk_doc['backup_api_key']['default'] == PLUGIN_NEW_DEFAULT,
          disk_doc.get('backup_api_key'))

    # ---- 8c. 提交全新真实值 → 真实写入 ----
    resp = post_json(PLUGIN_URL, {
        'tavily_api_key': PLUGIN_NEW_SECRET,
        'nested': {'password': PLUGIN_NEW_NESTED, 'host': '127.0.0.1',
                   'backup_token': [PLUGIN_ARRAY_SECRET], 'retries': 3, 'enabled': True},
    })
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('提交新 key 后真实写入',
          resp.status_code == 200 and disk_doc['tavily_api_key']['value'] == PLUGIN_NEW_SECRET,
          disk_doc.get('tavily_api_key'))
    check('提交新嵌套凭据后真实写入',
          disk_doc['nested']['value']['password'] == PLUGIN_NEW_NESTED)

    # ---- 8d. 新增凭据键：真实值写入，孤立掩码不落盘 ----
    resp = post_json(PLUGIN_URL, {'brand_new_api_key': '***abcd'})
    disk_text = PLUGIN_CONFIG_PATH.read_text(encoding='utf-8')
    check('没有原值可回填的掩码不写盘', 'brand_new_api_key' not in disk_text)
    resp = post_json(PLUGIN_URL, {'brand_new_api_key': PLUGIN_NEW_SECRET})
    disk_doc = json.loads(PLUGIN_CONFIG_PATH.read_text(encoding='utf-8'))
    check('新增凭据键的真实值正常写入',
          disk_doc.get('brand_new_api_key') == PLUGIN_NEW_SECRET,
          disk_doc.get('brand_new_api_key'))
finally:
    plugin_manager.PROJECT_ROOT = _prev_project_root

# ---------------------------------------------------------------- 汇总
print(f'临时目录：{TEMP_ROOT}')
if '--keep' not in sys.argv:
    shutil.rmtree(TEMP_ROOT, ignore_errors=True)
print('')
print(f'PASS {PASS_COUNT} / FAIL {FAIL_COUNT}')
if FAILURES:
    print('失败项：' + ', '.join(FAILURES))
sys.exit(0 if FAIL_COUNT == 0 else 1)
