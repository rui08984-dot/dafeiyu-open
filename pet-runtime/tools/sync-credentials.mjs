#!/usr/bin/env node
// sync-credentials.mjs —— 启动前把模型密钥从 ~/.dsh/.credentials.yaml 注入到 llm_providers.json。
//
// 为什么不把密钥直接写进 llm_providers.json：
//   · 那个文件在应用目录里，会被备份/打包/截图带出去；
//   · 密钥本来就存在 DSH 的凭证库里，那里有统一的轮换与权限管理。
// 所以 llm_providers.json 里只留占位符 __INJECTED__，每次启动时现填。
//
// 用法：node tools/sync-credentials.mjs [--check]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..', '_incoming', 'my-neuro', 'live-2d');
const PROVIDERS = path.join(APP, 'llm_providers.json');
const CREDS = path.join(os.homedir(), '.dsh', '.credentials.yaml');

// provider id → 凭证库里的 key 名
const ENV_MAP = {
  comad: 'COMAD_BUNNY_API_KEY',
  wb: 'WB_BRIDGE_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  zen: 'ZEN_GATE_API_KEY',
};

function readCredentialRefs() {
  try {
    const raw = fs.readFileSync(CREDS, 'utf8');
    const out = {};
    let inRefs = false;
    for (const line of raw.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs && /^\S/.test(line)) inRefs = false;
      if (!inRefs) continue;
      const m = line.match(/^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/);
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch (error) {
    return { __error: error.message };
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const refs = readCredentialRefs();
  if (refs.__error) { console.warn('[cred] 读不到凭证库:', refs.__error); return 1; }
  let data;
  try { data = JSON.parse(fs.readFileSync(PROVIDERS, 'utf8')); }
  catch (error) { console.error('[cred] 读不到 llm_providers.json:', error.message); return 1; }

  const report = [];
  const resolved = new Set();
  for (const provider of data.providers || []) {
    const keyName = ENV_MAP[provider.id] || (String(provider.id).toUpperCase() + '_API_KEY');
    const value = refs[keyName];
    if (!value) { report.push(provider.id + ': 缺 ' + keyName); continue; }
    if (!checkOnly) provider.api_key = value;
    resolved.add(provider.id);
    report.push(provider.id + ': OK (' + String(value).length + ' chars)');
  }

  if (!checkOnly) fs.writeFileSync(PROVIDERS, JSON.stringify(data, null, 2));
  console.log('[cred] ' + (checkOnly ? '体检' : '注入') + ': ' + report.join(' | '));

  // 体检模式下不写文件，所以用 resolved 集合判断可用性，而不是看 api_key 字面值
  const usable = (data.providers || []).filter((p) => p.enabled && resolved.has(p.id));
  if (!usable.length) { console.error('[cred] 没有任何可用的 provider（enabled + 有密钥）'); return 1; }
  if (!checkOnly) console.log('[cred] 可用 provider: ' + usable.map((p) => p.id).join(', '));
  return 0;
}

process.exit(main());