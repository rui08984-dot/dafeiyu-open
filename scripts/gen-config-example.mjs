// scripts/gen-config-example.mjs —— 从真实配置生成脱敏模板
//
// 为什么要有它（2026-11-14）：`config.json` / `llm_providers.json` 含真 key，不能入库；
// 但 clone 下来的人（或换机器的自己）得知道「要填哪些字段」。手抄模板一定会漏字段，
// 所以用脚本从真实配置生成：结构 100% 一致，只把敏感值换成占位符。
//
// 用法：node scripts/gen-config-example.mjs
// 输出：_incoming/my-neuro/live-2d/config.example.json
//       _incoming/my-neuro/live-2d/llm_providers.example.json
//       _incoming/my-neuro/plugins-dlc/memos/memos_system/config/memos_config.example.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

// 字段名命中这些就脱敏（含 key/token/secret/password/credential 的一律不落盘）
const SENSITIVE = /key|token|secret|password|credential/i;
// 例外：asr.ptt_key 是**键位名**（如 "V"），不是秘密 —— 它只是「按住哪个键说话」。
// 2026-11-16 修：原来被 SENSITIVE 误伤成 <填你的密钥>，照抄模板的人按键全废。
const SENSITIVE_EXCEPTIONS = new Set(['ptt_key']);
// 人设提示词是她的「人格」，属于隐私内容 —— 结构保留、内容清空
const PERSONA = /^system_prompt$/;

const PLACEHOLDER_SECRET = '<填你的密钥>';
const PLACEHOLDER_PERSONA = '<你的人设提示词：这里写「她是谁、怎么说话、什么脾气」。参考 docs/ 里的性格设计>';

function isSecretField(key) {
  return Boolean(key) && SENSITIVE.test(key) && !SENSITIVE_EXCEPTIONS.has(key);
}

// 公开模板的可移植性：路径/工作区不落真实盘符；隐私时间戳与浏览器扩展 id 清空；
// provider URL/模型 id 一律给示例值（私有网关不外泄）。
const PATHY_KEY = /(^|_)(path|dir|directory|root)$/i;
function portable(value, key) {
  if (key === 'workspaces' && value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = '.';
    return out;
  }
  if (key === 'defaultWorkspace') return '.';
  if (key === 'acked_at') return '';
  if (key === 'browser_ext_ids') return [];
  if (key === 'api_url' || key === 'base_url') return 'https://api.example.com/v1';
  if (key === 'model_id') return 'example-model';
  if (typeof value === 'string' && PATHY_KEY.test(key) && /^[A-Za-z]:[\\/]/.test(value)) return '.';
  return undefined;
}

function scrub(value, key = '') {
  const p = portable(value, key);
  if (p !== undefined) return p;
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
    return out;
  }
  // 2026-11-16 修：命中 SENSITIVE 的字符串一律占位符，**不管原值是否为空**。
  // 原来空串保持空串，模板里看不出「这里要填」，clone 的人照抄一份空 key 就跑不起来。
  // null 同空处理；数字/布尔不动（max_tokens 这类只是名字含 token，不是密钥）。
  // 例外：MemOS 的 embedding.api.api_key 是本地 llama.cpp 的占位值 "local"，
  // 服务端不校验；保留它，clone 的人只需要填 llm.config.api_key（2026-11-23 审计）。
  if (key === 'api_key' && value === 'local') return 'local';
  if (isSecretField(key) && (typeof value === 'string' || value === null)) return PLACEHOLDER_SECRET;
  if (typeof value === 'string' && PERSONA.test(key) && value.trim()) return PLACEHOLDER_PERSONA;
  return value;
}

function generate(name) {
  const src = path.join(APP, name);
  const dst = path.join(APP, name.replace(/\.json$/, '.example.json'));
  if (!fs.existsSync(src)) {
    console.log(`  - ${name} 不存在，跳过`);
    return;
  }
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
  const clean = scrub(raw);
  fs.writeFileSync(dst, JSON.stringify(clean, null, 2), 'utf8');
  const size = fs.statSync(dst).size;
  console.log(`  ✓ ${path.basename(dst)}（${size} 字节）`);
}

function generateFrom(src, dst, label) {
  if (!fs.existsSync(src)) {
    console.log(`  - ${label} 不存在，跳过`);
    return;
  }
  const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
  const clean = scrub(raw);
  fs.writeFileSync(dst, JSON.stringify(clean, null, 2), 'utf8');
  const size = fs.statSync(dst).size;
  console.log(`  ✓ ${path.basename(dst)}（${size} 字节）`);
}

console.log('[gen-config-example] 从真实配置生成脱敏模板（不含任何密钥）');
generate('config.json');
generate('llm_providers.json');
// MemOS 后端配置：storage/embedding/search 结构必须保留（插件同步只覆盖自己管的字段），
// 但 llm.config.api_key 是真实密钥，必须脱敏（2026-11-23 安装完整性审计）。
const memosDir = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system', 'config');
generateFrom(path.join(memosDir, 'memos_config.json'), path.join(memosDir, 'memos_config.example.json'), 'memos_config.json');
console.log('完成。把 example 复制成真配置，填上密钥即可。');
