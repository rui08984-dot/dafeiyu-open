#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成组件包里的 memos_config.json（llm 留空，安装时由 setup 写用户 key）。"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXAMPLE = os.path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos',
                       'memos_system', 'config', 'memos_config.example.json')

def main(out_path):
    with open(EXAMPLE, encoding='utf-8') as f:
        doc = json.load(f)
    doc.setdefault('storage', {}).setdefault('vector', {})
    doc['storage']['vector'].update({'type': 'qdrant', 'path': './data/qdrant', 'vector_size': 1024})
    doc['embedding'] = {
        'provider': 'api', 'use_api': True, 'vector_size': 1024,
        'api_model': 'qwen3-embed', 'api_dimensions': 1024,
        'api': {'base_url': 'http://127.0.0.1:8090/v1', 'model': 'qwen3-embed', 'api_key': 'local'},
    }
    doc['llm'] = {'config': {'model': '', 'api_key': '', 'base_url': '', 'max_tokens': 2048}}
    doc['llm_fallback'] = {'enabled': False, 'config': {'model': '', 'api_key': '', 'base_url': ''}}
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('wrote', out_path)

if __name__ == '__main__':
    if len(sys.argv) != 2:
        print('usage: build-memos-config.py <out.json>')
        sys.exit(2)
    main(sys.argv[1])
