#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
WebUI 模块化重构 - 日志与监控模块
负责日志读取、心情状态监控和 Live2D 动作管理
"""

import json
import datetime
import os
import re
import urllib.request
from pathlib import Path

from flask import Blueprint, request, jsonify

from .utils import PROJECT_ROOT, SERVICE_LOG_SERVICES, logger

# 创建日志监控蓝图
log_bp = Blueprint('log', __name__)

RUNTIME_INITIAL_LINES = 200
TAIL_READ_LIMIT_BYTES = 512 * 1024
INCREMENTAL_READ_LIMIT_BYTES = 256 * 1024

# 声音克隆的文件名/参数白名单：
# - role_name 会变成 .pth/.wav/.ckpt/.txt/.ps1/.bat 的文件名，绝不允许路径分隔符；
# - language 会进入 PowerShell 参数数组，只允许语言标签形态。
ROLE_NAME_RE = re.compile(r'^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,40}$')
LANGUAGE_RE = re.compile(r'^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})?$')


def _safe_child_path(root, filename):
    """把 filename 限制在 root 目录内（解析后校验，防 ../ 与符号链接穿越）。"""
    root_real = os.path.realpath(str(root))
    candidate = os.path.realpath(os.path.join(root_real, filename))
    try:
        inside = os.path.commonpath([root_real, candidate]) == root_real
    except ValueError:
        inside = False
    if not inside or candidate == root_real:
        raise ValueError(f'非法文件路径：{filename}')
    return Path(candidate)



def _read_last_lines(path, max_lines, max_bytes=TAIL_READ_LIMIT_BYTES):
    with open(path, 'rb') as stream:
        stream.seek(0, 2)
        position = stream.tell()
        chunks = []
        bytes_read = 0
        newline_count = 0

        while position > 0 and bytes_read < max_bytes and newline_count <= max_lines:
            chunk_size = min(64 * 1024, position, max_bytes - bytes_read)
            position -= chunk_size
            stream.seek(position)
            chunk = stream.read(chunk_size)
            chunks.append(chunk)
            bytes_read += len(chunk)
            newline_count += chunk.count(b'\n')

    data = b''.join(reversed(chunks))
    if position > 0:
        first_newline = data.find(b'\n')
        if first_newline >= 0:
            data = data[first_newline + 1:]
    return data.decode('utf-8', errors='ignore').splitlines()[-max_lines:]


def _read_lines_from_offset(path, offset, max_bytes=INCREMENTAL_READ_LIMIT_BYTES):
    with open(path, 'rb') as stream:
        stream.seek(offset)
        data = stream.read(max_bytes + 1)

    if len(data) > max_bytes:
        bounded = data[:max_bytes]
        last_newline = bounded.rfind(b'\n')
        consumed = last_newline + 1 if last_newline >= 0 else max_bytes
        data = bounded[:consumed]
    else:
        consumed = len(data)

    return (
        data.decode('utf-8', errors='ignore').splitlines(),
        offset + consumed,
    )


def _runtime_cursor(stat_result):
    return f'{stat_result.st_dev}:{stat_result.st_ino}'


def _categorize_runtime_lines(lines):
    result = {'pet': [], 'tool': []}
    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            continue
        category = 'tool' if '[TOOL]' in line else 'pet'
        result[category].append(line)
    return result


# ============ 日志 API ============

@log_bp.route('/api/logs/runtime')
def get_runtime_logs():
    """Return one bounded initial tail or the bytes appended after a cursor."""
    log_file = PROJECT_ROOT / 'runtime.log'
    if not log_file.exists():
        return jsonify({
            'logs': {'pet': [], 'tool': []},
            'offset': 0,
            'cursor': '',
            'reset': True,
        })

    try:
        stat_result = log_file.stat()
        cursor = _runtime_cursor(stat_result)
        requested_cursor = request.args.get('cursor', '')
        requested_offset = request.args.get('offset', type=int)
        reset = (
            requested_offset is None
            or requested_offset < 0
            or requested_offset > stat_result.st_size
            or requested_cursor != cursor
        )

        if reset:
            lines = _read_last_lines(log_file, RUNTIME_INITIAL_LINES)
            next_offset = stat_result.st_size
        else:
            lines, next_offset = _read_lines_from_offset(
                log_file,
                requested_offset,
            )

        return jsonify({
            'logs': _categorize_runtime_lines(lines),
            'offset': next_offset,
            'cursor': cursor,
            'reset': reset,
        })
    except Exception as e:
        return jsonify({
            'logs': {'pet': [], 'tool': []},
            'error': str(e),
        }), 500


@log_bp.route('/api/logs/<log_type>')
def get_logs(log_type):
    """获取指定类型的日志（优化版：只读取最后 100 行）"""
    try:
        log_file = PROJECT_ROOT / 'runtime.log'
        if not log_file.exists():
            return jsonify({'logs': [], 'error': '日志文件不存在'})

        categories = _categorize_runtime_lines(_read_last_lines(log_file, 100))
        return jsonify({'logs': categories.get(log_type, [])})
    except Exception as e:
        return jsonify({'logs': [], 'error': str(e)})


@log_bp.route('/api/logs/tail/<log_type>')
def tail_logs(log_type):
    """获取日志的最新内容（增量）"""
    try:
        log_file = PROJECT_ROOT / 'runtime.log'
        if not log_file.exists():
            return jsonify({'logs': [], 'error': '日志文件不存在'})

        categories = _categorize_runtime_lines(_read_last_lines(log_file, 10))
        return jsonify({'logs': categories.get(log_type, [])})
    except Exception as e:
        return jsonify({'logs': [], 'error': str(e)})


@log_bp.route('/api/logs/service/<service>')
def get_service_logs(service):
    """获取 ASR/TTS/记忆系统内嵌服务日志。"""
    if service not in SERVICE_LOG_SERVICES:
        return jsonify({'logs': [], 'error': f'未知服务日志：{service}'}), 404

    try:
        log_file = PROJECT_ROOT.parent / 'logs' / f'{service}.log'
        if not log_file.exists():
            return jsonify({'logs': []})

        logs = [
            line.rstrip()
            for line in _read_last_lines(log_file, 200)
            if line.strip()
        ]
        return jsonify({'logs': logs})
    except Exception as e:
        return jsonify({'logs': [], 'error': str(e)})


@log_bp.route('/api/logs/service/<service>/clear', methods=['POST'])
def clear_service_logs(service):
    """清空 ASR/TTS/记忆系统内嵌服务日志。"""
    if service not in SERVICE_LOG_SERVICES:
        return jsonify({'success': False, 'error': f'未知服务日志：{service}'}), 404

    try:
        log_file = PROJECT_ROOT.parent / 'logs' / f'{service}.log'
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with open(log_file, 'w', encoding='utf-8') as f:
            f.write('')
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


# ============ Live2D 动作管理 API ============
# 注意：这些 API 已在 config_manager.py 中定义，此处注释掉避免冲突

# @log_bp.route('/api/live2d/singing/start', methods=['POST'])
# def start_singing():
#     """开始唱歌"""
#     try:
#         try:
#             json_data = json.dumps({'action': 'trigger_emotion', 'emotion_name': '唱歌'}).encode('utf-8')
#             req = urllib.request.Request('http://localhost:3002/control-motion', data=json_data, method='POST')
#             req.add_header('Content-Type', 'application/json')
#             with urllib.request.urlopen(req, timeout=2) as response:
#                 if response.status == 200:
#                     return jsonify({'success': True, 'message': '已开始唱歌'})
#         except Exception:
#             pass
#         return jsonify({'success': True, 'message': '唱歌请求已发送'})
#     except Exception as e:
#         return jsonify({'error': str(e)}), 500
#
#
# @log_bp.route('/api/live2d/singing/stop', methods=['POST'])
# def stop_singing():
#     """停止唱歌"""
#     try:
#         try:
#             json_data = json.dumps({'action': 'trigger_emotion', 'emotion_name': '停止'}).encode('utf-8')
#             req = urllib.request.Request('http://localhost:3002/control-motion', data=json_data, method='POST')
#             req.add_header('Content-Type', 'application/json')
#             with urllib.request.urlopen(req, timeout=2) as response:
#                 if response.status == 200:
#                     return jsonify({'success': True, 'message': '已停止唱歌'})
#         except Exception:
#             pass
#         return jsonify({'success': True, 'message': '停止请求已发送'})
#     except Exception as e:
#         return jsonify({'error': str(e)}), 500
#
#
# @log_bp.route('/api/live2d/motion/reset', methods=['POST'])
# def reset_motion():
#     """复位动作配置（从备份恢复）"""
#     try:
#         import re
#         
#         # 从 main.js 读取当前模型名
#         live2d_path = PROJECT_ROOT / 'live-2d'
#         main_js_path = live2d_path / 'main.js'
#         model_name = '肥牛'  # 默认
#         
#         if main_js_path.exists():
#             with open(main_js_path, 'r', encoding='utf-8') as f:
#                 content = f.read()
#             match = re.search(r"const priorityFolders = \['([^']+)'", content)
#             if match:
#                 model_name = match.group(1)
#         
#         # 从备份配置恢复
#         backup_path = live2d_path / 'character_backups.json'
#         config_path = live2d_path / 'emotion_actions.json'
#
#         if backup_path.exists():
#             with open(backup_path, 'r', encoding='utf-8') as f:
#                 backup = json.load(f)
#
#             # 读取现有配置（保留其他模型的数据）
#             existing_config = {}
#             if config_path.exists():
#                 with open(config_path, 'r', encoding='utf-8') as f:
#                     existing_config = json.load(f)
#
#             # 从备份中提取当前模型的动作配置
#             if model_name in backup:
#                 model_backup = backup[model_name]
#                 if 'original_config' in model_backup:
#                     emotion_actions = model_backup['original_config'].get('emotion_actions', {})
#                     existing_config[model_name] = {
#                         'emotion_actions': emotion_actions
#                     }
#                 else:
#                     existing_config[model_name] = model_backup
#
#             with open(config_path, 'w', encoding='utf-8') as f:
#                 json.dump(existing_config, f, ensure_ascii=False, indent=2)
#
#             logger.info(f'动作配置已从备份恢复（模型：{model_name}）')
#             return jsonify({'success': True, 'message': '动作配置已重置'})
#         else:
#             logger.error(f'备份文件不存在：{backup_path}')
#             return jsonify({'success': False, 'error': '备份文件不存在'})
#     except Exception as e:
#         logger.error(f'重置动作配置失败：{str(e)}')
#         return jsonify({'success': False, 'error': str(e)}), 500
#
#
# @log_bp.route('/api/live2d/motion/preview', methods=['POST'])
# def preview_motion():
#     """预览动作"""
#     try:
#         data = request.get_json()
#         motion_name = data.get('motion', '')
#         
#         # 使用 trigger_emotion action 来触发情绪对应的动作
#         try:
#             json_data = json.dumps({
#                 'action': 'trigger_emotion',
#                 'emotion_name': motion_name
#             }).encode('utf-8')
#             req = urllib.request.Request('http://localhost:3002/control-motion', data=json_data, method='POST')
#             req.add_header('Content-Type', 'application/json')
#             with urllib.request.urlopen(req, timeout=2) as response:
#                 if response.status == 200:
#                     return jsonify({'success': True, 'message': f'正在预览动作：{motion_name}'})
#         except Exception as http_error:
#             logger.warning(f'HTTP 请求失败：{http_error}')
#
#         return jsonify({'success': True, 'message': f'预览请求已发送：{motion_name}'})
#     except Exception as e:
#         return jsonify({'error': str(e)}), 500


# ============ 声音克隆 API ============

@log_bp.route('/api/voice-clone/generate-bat', methods=['POST'])
def generate_tts_bat():
    """生成 TTS 的 bat 文件"""
    try:
        # 获取上传的文件
        model_file = request.files.get('model_file')
        audio_file = request.files.get('audio_file')
        gpt_model_file = request.files.get('gpt_model_file')  # 可选：GPT 模型（.ckpt）
        role_name = str(request.form.get('role_name', '') or '').strip()
        language = str(request.form.get('language', 'zh') or 'zh').strip()
        text = str(request.form.get('text', '') or '')

        if not model_file or not audio_file or not role_name or not text:
            return jsonify({'success': False, 'error': '缺少必要参数'}), 400

        # 根因：role_name 原来直接拼进路径，text 直接拼进 bat 命令。
        if not ROLE_NAME_RE.match(role_name):
            return jsonify({
                'success': False,
                'error': 'role_name 只允许 1-40 个中英文、数字、下划线或短横线'
            }), 400
        if not LANGUAGE_RE.match(language):
            return jsonify({'success': False, 'error': 'language 参数不合法'}), 400

        # 保存到 Voice_Model_Factory 目录
        voice_model_dir = PROJECT_ROOT / 'Voice_Model_Factory'
        voice_model_dir.mkdir(parents=True, exist_ok=True)

        # 保存模型文件（路径再次做 realpath 校验，双保险）
        model_path = _safe_child_path(voice_model_dir, f'{role_name}.pth')
        model_file.save(str(model_path))

        # 保存音频文件
        audio_path = _safe_child_path(voice_model_dir, f'{role_name}.wav')
        audio_file.save(str(audio_path))

        # 保存 GPT 模型文件（可选，未提供时 api.py 使用默认 GPT 权重）
        gpt_model_path = None
        if gpt_model_file and gpt_model_file.filename:
            gpt_model_path = _safe_child_path(voice_model_dir, f'{role_name}.ckpt')
            gpt_model_file.save(str(gpt_model_path))

        # 用户文本写入同目录 .txt（UTF-8），绝不拼进命令行/bat
        text_path = _safe_child_path(voice_model_dir, f'{role_name}.txt')
        with open(text_path, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)

        # 生成 .ps1：PowerShell 读取文本文件并用参数数组调用 python，
        # 文本内容不经过 cmd 解析，双击 .bat 仍可运行。
        gpt_arg_line = ''
        if gpt_model_path is not None:
            gpt_arg_line = (
                f"$ttsArgs += @('-g', (Join-Path $here '{role_name}.ckpt'))\n"
            )
        ps1_content = f"""# -*- coding: utf-8 -*-
# 由 WebUI 生成：文本从同目录 {role_name}.txt 读取，参数以数组传递，避免命令注入。
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$bundle = Join-Path $here '..\\..\\full-hub\\tts-hub\\GPT-SoVITS-Bundle'
$ttsText = Get-Content -LiteralPath (Join-Path $here '{role_name}.txt') -Raw -Encoding UTF8
if ($null -eq $ttsText) {{ $ttsText = '' }}
$env:PATH = (Join-Path $bundle 'runtime') + ';' + $env:PATH
Set-Location -LiteralPath $bundle
$ttsArgs = @(
  'api.py', '-p', '5000', '-d', 'cuda',
  '-s', (Join-Path $here '{role_name}.pth'),
  '-dr', (Join-Path $here '{role_name}.wav'),
  '-dt', $ttsText,
  '-dl', '{language}'
)
{gpt_arg_line}& python @ttsArgs
"""
        ps1_path = _safe_child_path(voice_model_dir, f'{role_name}.ps1')
        with open(ps1_path, 'w', encoding='utf-8-sig', newline='\n') as stream:
            stream.write(ps1_content)

        # .bat 只是固定模板 + 白名单角色名，负责双击入口
        bat_content = f'''@echo off
chcp 65001 >nul
echo.
echo ========================================
echo  TTS 声音克隆 - {role_name}
echo ========================================
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0{role_name}.ps1"
pause
'''

        bat_path = _safe_child_path(voice_model_dir, f'{role_name}.bat')
        with open(bat_path, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(bat_content)

        return jsonify({
            'success': True,
            'message': f'已生成 TTS 的 bat 文件：{role_name}.bat',
            'bat_path': str(bat_path),
            'text_path': str(text_path),
        })
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


# ============ 对话历史 API ============

def _resolve_chat_history_file():
    """对话历史文件双候选：本地布局 live-2d/data 优先，线上布局 <root>/data 兜底。"""
    candidates = [
        PROJECT_ROOT / 'data' / '对话历史.jsonl',
        PROJECT_ROOT.parent / 'data' / '对话历史.jsonl',
    ]
    for path in candidates:
        if path.exists():
            return path
    return candidates[0]


@log_bp.route('/api/chat-history')
def get_chat_history():
    """获取对话历史记录（支持分页）"""
    try:
        # 获取分页参数
        page = request.args.get('page', 1, type=int)
        page_size = request.args.get('page_size', 50, type=int)

        # 对话历史文件路径
        history_file = _resolve_chat_history_file()
        
        if not history_file.exists():
            return jsonify({'messages': [], 'has_more': False, 'has_prev': False, 'total': 0})

        # 读取所有对话
        messages = []
        with open(history_file, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        messages.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue

        total = len(messages)

        # 分页：返回指定范围的对话（保持原文件顺序，旧→新）
        # 第一页返回最早的对话，最后一页返回最新的对话
        start = (page - 1) * page_size
        end = start + page_size
        page_messages = []
        for index, message in enumerate(messages[start:end], start=start):
            if isinstance(message, dict):
                message_with_index = dict(message)
                message_with_index['_history_index'] = index
                page_messages.append(message_with_index)
            else:
                page_messages.append(message)

        return jsonify({
            'messages': page_messages,
            'has_more': end < total,  # 是否有下一页（更新的对话）
            'has_prev': page > 1,     # 是否有上一页（更早的对话）
            'total': total
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@log_bp.route('/api/chat-history/clear', methods=['POST'])
def clear_chat_history():
    """清空对话历史记录"""
    try:
        history_file = _resolve_chat_history_file()
        
        if history_file.exists():
            # 清空文件内容
            with open(history_file, 'w', encoding='utf-8') as f:
                pass
        
        return jsonify({'success': True, 'message': '对话历史已清空'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
