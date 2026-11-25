// scripts/gen-config-example.mjs —— 从真实配置生成脱敏模板
//
// 为什么要有它（2026-11-14）：`config.json` / `llm_providers.json` 含真 key，不能入库；
// 但 clone 下来的人（或换机器的自己）得知道「要填哪些字段」。手抄模板一定会漏字段，
// 所以用脚本从真实配置生成：结构 100% 一致，只把敏感值换成占位符。
// 2026-11-24 起还做「实例值中性化」：个人隧道 URL / 窗口坐标 / 界面与语音开关
// 一律换成示例地址或代码默认值（见下方 INSTANCE_DEFAULTS / scrubInstanceUrls）。
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
// 模板专属注记（JSON 不能写注释）：clone 的人看到 `diary.local_enabled: false`
// 并不知道 false 是什么意思。注记只写进 **config.example.json** 的父对象 `_comment`，
// 不污染真实 config.json（真实配置里没人读 `_comment`，也不该多出键）。
const TEMPLATE_NOTES = {
  'diary.local_enabled': 'false=日记摘要走云端主模型（默认）；true 才走本地 llama.cpp:11435（MemOperator-4B，需先启动）。本地不可用时跳过、不回退云。',
};

// ── 实例值中性化（2026-11-24 P0：公开模板不再复印「这台机器」）──────────
// 旧脱敏只按**字段名**（key/token/secret…）与 sk-/JWT 形态命中，于是：
//   · `api_gateway.base_url` 的 natapp 隧道地址被原样复印；
//   · `pet_window.x/y`、`click_through_default`、`voice.duplex.backchannel_gate`
//     这类「个人部署/界面/语音」实例值也一起进了模板。
// 这等于把用户的运行环境细节贴到公开仓。规则分两层：
//   ① URL 值兜底：**所有** http(s) 字符串（不再只看键名是否像 URL），
//      host 不在允许集（example.com / 127.0.0.1 / localhost / ::1 / 0.0.0.0）→
//      换成示例占位符（`https://api.example.com/v1`）。与门禁 ⑩「扫所有 URL」对称：
//      键名叫 `proxy` / `callback` / `upstream` 也一样会被替换。
//   ② 已知实例键 → 写**代码默认**的中性值，不从实盘复制。
// 注意：①只对 config.json 生效；llm_providers 的 api_url 必须与实盘一致
// （_probe/check-config-template.mjs ⑥ 会逐条比对），不能在这里改写。
const ALLOWED_URL_HOSTS = new Set(['example.com', '127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const URL_PLACEHOLDER = 'https://api.example.com/v1';

// 点路径 → 代码默认值。新增实例键时，与 _probe/check-config-template.mjs 的
// INSTANCE_DEFAULTS 保持同步（门禁会断言模板等于这里的值）。
const INSTANCE_DEFAULTS = {
  'ui.pet_window.x': 0,                     // 窗口位置：用户拖动/记忆，模板不落个人坐标
  'ui.pet_window.y': 0,
  'ui.click_through_default': false,        // main.js 用 === true，缺键即不穿透 → 默认 false
  'voice.duplex.backchannel_gate': false,   // asr-processor.js 严格 === true 才开，默认关
  'ui.screen_extend.extend': false,         // main.js 默认 { extend:false, left:false, right:true }
  'ui.screen_extend.left': false,
  'ui.screen_extend.right': true,
};

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function hostOf(value) {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch (err) {
    return null;
  }
}

function hostAllowed(host) {
  if (!host) return false;
  if (ALLOWED_URL_HOSTS.has(host)) return true;
  return /(^|\.)example\.(com|org|net)$/.test(host);
}

/** 把任意字符串值里的个人隧道/私有域名换成示例地址（只对 config 调用）。
 *  2026-11-25 P2-11：不再依赖键名白名单 —— 键叫 proxy/callback 但值是 URL 也要扫。 */
function scrubInstanceUrls(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => scrubInstanceUrls(item, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubInstanceUrls(v, k);
    return out;
  }
  if (isHttpUrl(value)) {
    if (!hostAllowed(hostOf(value))) return URL_PLACEHOLDER;
  }
  return value;
}

function setDotted(obj, dotted, val) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

/** 已知实例键一律回到代码默认的中性值。 */
function applyInstanceDefaults(obj) {
  for (const [dotted, val] of Object.entries(INSTANCE_DEFAULTS)) setDotted(obj, dotted, val);
}

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
  let clean = scrub(raw);
  if (name === 'config.json') {
    // 先换个人 URL，再压实例键，最后挂注记（顺序无关，但语义上先脱敏后注记）。
    clean = scrubInstanceUrls(clean);
    applyInstanceDefaults(clean);
    applyTemplateNotes(clean);
  }
  fs.writeFileSync(dst, JSON.stringify(clean, null, 2), 'utf8');
  const size = fs.statSync(dst).size;
  console.log(`  ✓ ${path.basename(dst)}（${size} 字节）`);
}

/** 把 TEMPLATE_NOTES 挂到父对象的 `_comment`（只写模板，不改实盘）。 */
function applyTemplateNotes(obj) {
  for (const [dotted, note] of Object.entries(TEMPLATE_NOTES)) {
    const parts = dotted.split('.');
    parts.pop();
    let cur = obj;
    for (const p of parts) {
      cur = cur && typeof cur[p] === 'object' ? cur[p] : null;
      if (!cur) break;
    }
    if (cur && !cur._comment) cur._comment = note;
  }
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

function main() {
  console.log('[gen-config-example] 从真实配置生成脱敏模板（不含任何密钥）');
  generate('config.json');
  generate('llm_providers.json');
  // MemOS 后端配置：storage/embedding/search 结构必须保留（插件同步只覆盖自己管的字段），
  // 但 llm.config.api_key 是真实密钥，必须脱敏（2026-11-23 安装完整性审计）。
  const memosDir = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system', 'config');
  generateFrom(path.join(memosDir, 'memos_config.json'), path.join(memosDir, 'memos_config.example.json'), 'memos_config.json');
  console.log('完成。把 example 复制成真配置，填上密钥即可。');
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();

// 导出给 _probe/check-config-template.mjs 做「URL 兜底」断言（导入时不会执行 main）。
export { scrubInstanceUrls, hostAllowed, isHttpUrl, URL_PLACEHOLDER };
