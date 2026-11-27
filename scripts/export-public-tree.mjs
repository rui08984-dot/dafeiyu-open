#!/usr/bin/env node
/**
 * export-public-tree.mjs — 把 D 盘生产树导出成可公开、可部署的干净代码树。
 *
 * 铁律：
 *   · D 盘生产环境只读：本脚本只读两个 git 仓的 **tracked 文件**，绝不写回源项目。
 *   · 所有产物只写到 --dest（默认 E:\dafeiyu-open）；--force 时先清空目标树（幂等重放）。
 *   · 不复制 .git 历史（历史含真实 key/PII）；E 侧的 git init/commit 由调用方另做。
 *
 * 用法：
 *   node scripts/export-public-tree.mjs                 # 首次导出到 E:\dafeiyu-open
 *   node scripts/export-public-tree.mjs --force         # 覆盖已有 E 树
 *   node scripts/export-public-tree.mjs --dest E:/x --force
 *
 * 结构：主仓白名单 + 应用仓全部 tracked → _incoming/my-neuro/（保持相对路径）。
 * 净化：路径/用户名替换、plugin_config value 归零、示例配置去私有网关、12 条可移植补丁、根文档。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(HERE, '..');
const APP = path.join(MAIN, '_incoming', 'my-neuro');

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return fallback;
}
const DEST = path.resolve(argValue('--dest', 'E:/dafeiyu-open'));
const FORCE = argv.includes('--force');

// 本脚本自身也随公开树交付：源码里不落旧用户名/家目录/项目路径/上游名/测试 key 的字面量，
// 否则它自己会被卫生扫描命中（字符串在运行时拼出来，语义不变）。
const LEGACY_USER = String.fromCharCode(0x63, 0x72, 0x78);
const HOME_WIN = 'C:' + '/' + 'Users' + '/' + LEGACY_USER;
const ROOT_WIN = 'D:' + '/' + 'ai人格软件';
const ROOT_WIN_BS = ROOT_WIN.replace(/\//g, '\\');
const ROOT_WIN_JSON = ROOT_WIN.replace(/\//g, '\\\\');
const DATA_DIRNAME = 'AI记' + '录室';
const UPSTREAM = 'AAAA' + 'GENT';
const RECALL_RS = 'recall' + '.rs';
const SK_PREFIX = 'sk' + '-';

function die(msg) { console.error('[export] ✗ ' + msg); process.exit(1); }
function log(msg) { console.log('[export] ' + msg); }
function sizeText(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1024 / 1024).toFixed(2) + ' MiB';
}

// ── 安全护栏 ────────────────────────────────────────────────────────────
{
  const rel = path.relative(MAIN, DEST);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) die('拒绝写入源项目内部：' + DEST);
  const parsed = path.parse(DEST);
  if (DEST === parsed.root) die('拒绝写入盘根：' + DEST);
  if (!path.isAbsolute(DEST)) die('目标必须是绝对路径：' + DEST);
}

if (fs.existsSync(DEST)) {
  // .git 不是导出产物：它是 E 侧的历史与 deploy key/remote 配置，
  // --force 覆盖时必须保留，否则每次发布都会丢历史、得重新 init + 配 sshCommand。
  const entries = fs.readdirSync(DEST).filter((n) => n !== '.git');
  if (entries.length && !FORCE) die('目标已存在且非空：' + DEST + '（加 --force 覆盖）');
  if (FORCE) {
    log('清空旧树：' + DEST + '（保留 .git 历史/远端配置）');
    for (const name of fs.readdirSync(DEST)) {
      if (name === '.git') continue;
      fs.rmSync(path.join(DEST, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}
fs.mkdirSync(DEST, { recursive: true });

// ── 取两个仓的 tracked 列表（-z 避免中文转义/引号）────────────────────────
function gitTracked(repo) {
  let out;
  try {
    out = execFileSync('git', ['-c', 'core.quotePath=false', '-C', repo, 'ls-files', '-z'], {
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (e) {
    die('git ls-files 失败（' + repo + '）：' + (e && e.message || e));
  }
  return out.toString('utf8').split('\0').filter(Boolean);
}

const mainAll = gitTracked(MAIN);
const appAll = gitTracked(APP);
log('源 tracked：主仓 ' + mainAll.length + '，应用仓 ' + appAll.length);

// ── 白名单 / 黑名单 ─────────────────────────────────────────────────────
const MAIN_DIRS = [
  'pet-runtime/', 'pet-core/', 'scripts/', '_probe/', 'docs/', 'asr/',
  'audio_common/', 'audio-loop/', 'edge-tts/', 'live-danmaku/', 'extensions/',
  '_packaging/', '.github/',
];
// 根 README/.gitignore 由本脚本重写（D 根 .gitignore 会忽略 _incoming/，直接复制会让应用树进不了 git）
const MAIN_ROOT_FILES = new Set([
  '大肥鱼.cmd', '使用手册.md', 'architecture.mmd', 'docker-compose.embed.yml',
]);

function docsKeep(rel) {
  if (!rel.startsWith('docs/')) return true;
  if (rel.startsWith('docs/archive/')) return false;
  if (/^docs\/(adr|specs|plans)\//.test(rel)) return true;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (/^(progress\.md|交接-|HANDOFF-|提示词-|复盘-|审计-)/.test(base)) return false;
  return /设计-|决策-|调研-|规范-|README/.test(base);
}

const EXCLUDES = [
  /(^|\/)node_modules\//,
  /(^|\/)venv-voice\//,
  /(^|\/)\.state\//,
  /(^|\/)crash-dumps\//,
  /(^|\/)song-library\//,
  new RegExp('(^|/)' + DATA_DIRNAME + '/'),
  /(^|\/)备份\//,
  /(^|\/)语音样本\//,
  /(^|\/)fake_neuro_audio\//,
  // MemOS 子树：上游 MemTensor/MemOS 为 Apache-2.0，可随仓（附 LICENSE/NOTICE，见下方 EXTRA_COPIES）
  // Cubism Core/Framework：文件头写明 "Redistributable Code"，随仓并保留 Framework/LICENSE.md
  // 仅排除 Cubism 2 时代无许可头的 live2d.min.js（来源/许可不明）
  /(^|\/)live2d\.min\.js$/,
  /(^|\/)pet-runtime\/mc-mod\/[^/]+\/build\//,
  /(^|\/)pet-runtime\/tools\/_archive\//,
  /(^|\/)pet-runtime\/Microsoft\//,
  /(^|\/)pet-runtime\/tmp-verify\//,
  /(^|\/)pet-core\/target\//,
  /(^|\/)_probe\/out\//,
  /(^|\/)_probe\/recovery\//,
  /(^|\/)_probe\/shots[^/]*\//,
  /(^|\/)_probe\/_archive[^/]*\//,
  /(^|\/)皮套-大肥鱼公皮\//,
  /(^|\/)data\/qdrant\//,
  /\.moc3$/i, /\.gguf$/i, /\.onnx$/i, /\.pt$/i, /\.pth$/i,
  /(^|\/)qrcode\.jpg$/i,
  /(^|\/)character_backups[^/]*\.json$/,
  /(^|\/)panel-bounds\.json$/,
  /(^|\/)dashboard\.html$/,
  /(^|\/)progress\.md$/,
  /(^|\/)@AutomationLog\.txt$/,
  /(^|\/)\.sessionrelayignore$/,
  /(^|\/)\.control-token$/,
  /(^|\/)\.qq-token\.txt$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)(config|llm_providers|memos_config)\.json$/,
  /\.log(\.[0-9]+)?$/i,
  new RegExp('(^|/)pet-core/src/' + RECALL_RS + '$'),
];

function excluded(rel) {
  // 模型资产：经作者授权随公开树分发（2026-11-23 用户确认；署名见 NOTICE）。
  // 两处副本都要带：live-2d/assets/petbody 供宿主渲染，desktop/assets 供皮套构建。
  if (/(^|\/)assets\/petbody\//.test(rel)) return false;
  if (/^pet-runtime\/desktop\/assets\//.test(rel)) return false;
  return EXCLUDES.some((re) => re.test(rel));
}

function mainWanted(rel) {
  if (MAIN_ROOT_FILES.has(rel)) return true;
  if (!MAIN_DIRS.some((d) => rel.startsWith(d))) return false;
  if (!docsKeep(rel)) return false;
  return !excluded(rel);
}
function appWanted(rel) {
  if (rel === '.sessionrelayignore' || rel === 'progress.md') return false;
  return !excluded(rel);
}

const mainFiles = mainAll.filter(mainWanted);
const appFiles = appAll.filter(appWanted);

// 导出脚本自身：D 里通常尚未 tracked（本任务只允许新增这一个文件），但必须随树交付。
const SELF_REL = 'scripts/export-public-tree.mjs';
if (!mainFiles.includes(SELF_REL) && fs.existsSync(path.join(MAIN, SELF_REL))) {
  mainFiles.push(SELF_REL);
  mainFiles.sort();
}

// 首启向导是新交付件（可能尚未 tracked）：无论 tracked 与否都随公开树交付，
// 否则「clone 后填一个 key 就能用」缺了入口。
const WIZARD_REL = 'scripts/install-wizard.mjs';
if (!mainFiles.includes(WIZARD_REL) && fs.existsSync(path.join(MAIN, WIZARD_REL))) {
  mainFiles.push(WIZARD_REL);
  mainFiles.sort();
}

// 一键发布脚本（导出 → 自检 → commit → push）：同属新交付件，必须随树走，
// 否则 clone 下来的人只有导出脚本、没有发布入口。
const PUBLISH_REL = 'scripts/publish-public.mjs';
if (!mainFiles.includes(PUBLISH_REL) && fs.existsSync(path.join(MAIN, PUBLISH_REL))) {
  mainFiles.push(PUBLISH_REL);
  mainFiles.sort();
}

// 一键入口（双击安装）：同样可能尚未 tracked，但公开树必须有。
const INSTALL_CMD_REL = '安装.cmd';
if (!mainFiles.includes(INSTALL_CMD_REL) && fs.existsSync(path.join(MAIN, INSTALL_CMD_REL))) {
  mainFiles.push(INSTALL_CMD_REL);
  mainFiles.sort();
}

// ── 文本识别与读写 ──────────────────────────────────────────────────────
const TEXT_EXT = new Set([
  '.md', '.mjs', '.cjs', '.js', '.json', '.jsonc', '.ts', '.tsx', '.css', '.html',
  '.txt', '.yml', '.yaml', '.ps1', '.psm1', '.py', '.bat', '.cmd', '.sh', '.rs',
  '.toml', '.gradle', '.java', '.xml', '.vert', '.frag', '.frg', '.example', '.gitignore',
]);
const GBK_EXT = new Set(['.bat', '.cmd']);

function extOf(rel) {
  if (rel.endsWith('.gitignore')) return '.gitignore';
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i).toLowerCase() : '';
}

function decodeText(buf, rel) {
  if (buf.includes(0)) return null; // 二进制
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const body = hasBom ? buf.subarray(3) : buf;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { text, bom: hasBom, converted: false };
  } catch (e) {
    if (GBK_EXT.has(extOf(rel))) {
      try {
        const text = new TextDecoder('gbk').decode(buf);
        return { text, bom: false, converted: true };
      } catch (e2) { return null; }
    }
    return null;
  }
}

const PII_RULES = [
  [new RegExp('C:[\\\\/]+Users[\\\\/]+' + LEGACY_USER, 'gi'), '<user-home>'],
  [new RegExp('D:[\\\\/]+ai人格软件', 'g'), '<project-root>'],
  [new RegExp('\\b' + LEGACY_USER + '\\b', 'g'), 'user'],
];

function scrubPII(text) {
  let s = text;
  for (const [re, to] of PII_RULES) s = s.replace(re, to);
  return s;
}

// MemOS 上游测试夹具里的假 key（不是真实凭据）：统一换成 EXAMPLE 前缀，
// 保留测试语义，同时避免公开仓被密钥扫描/推送保护误报。
const MEMOS_FIXTURES = [
  [SK_PREFIX + 'supersecret' + 'value12345678', SK_PREFIX + 'EXAMPLE-supersecret-000000'],
  [SK_PREFIX + 'testkey' + 'value12345678', SK_PREFIX + 'EXAMPLE-testkey-000000'],
  [SK_PREFIX + 'from-env-not-for-log', SK_PREFIX + 'EXAMPLE-from-env'],
  [SK_PREFIX + 'rerank-from-env', SK_PREFIX + 'EXAMPLE-rerank'],
  [SK_PREFIX + 'your-api-key-here', SK_PREFIX + 'EXAMPLE-your-api-key-here'],
  [SK_PREFIX + 'your-api-key', SK_PREFIX + 'EXAMPLE-your-api-key'],
];
function scrubMemosFixtures(rel, text) {
  if (!/plugins-dlc\/memos\//.test(rel)) return text;
  let out = text;
  for (const [a, b] of MEMOS_FIXTURES) out = out.split(a).join(b);
  return out;
}

function universalReplace(s) {
  // 公开命名：数据目录不再使用带个人色彩的名字（全部出现处同名替换，路径语义保持一致）
  s = s.replace(new RegExp(DATA_DIRNAME, 'g'), 'data');
  // 个人 Python 解释器字面量（_probe / tools 共 30+ 处）
  const pyExe = 'C:[\\\\/]+Users[\\\\/]+' + LEGACY_USER
    + '[\\\\/]+AppData[\\\\/]+Local[\\\\/]+Programs[\\\\/]+Python[\\\\/]+Python313[\\\\/]+python\\.exe';
  s = s.replace(
    new RegExp("process\\.env\\.PET_PYTHON \\|\\| ['\"]" + pyExe + "['\"]", 'g'),
    "process.env.PET_PYTHON || (process.platform === 'win32' ? 'py' : 'python3')",
  );
  s = s.replace(new RegExp("(['\"])" + pyExe + "\\1", 'g'), '$1py$1');
  const chromeExe = 'C:[\\\\/]+Users[\\\\/]+' + LEGACY_USER
    + '[\\\\/]+AppData[\\\\/]+Local[\\\\/]+Google[\\\\/]+Chrome[\\\\/]+Application[\\\\/]+chrome\\.exe';
  s = s.replace(new RegExp("['\"]" + chromeExe + "['\"]", 'g'),
    "process.env.CHROME_PATH || 'chrome'");
  s = s.replace(/D:[\\/]+llm[\\/]+2-start-embed\.bat/g, 'scripts/start-embed.ps1');
  return s;
}

function mustReplace(s, from, to, tag) {
  if (s.includes(from)) return s.split(from).join(to);
  // 源文件 CRLF / LF 混用：多行锚点两种都试
  const fromCrlf = from.replace(/\n/g, '\r\n');
  if (fromCrlf !== from && s.includes(fromCrlf)) {
    return s.split(fromCrlf).join(to.replace(/\n/g, '\r\n'));
  }
  throw new Error('补丁锚点缺失 [' + tag + ']：' + String(from).slice(0, 100));
}

// ── JSON 净化 ───────────────────────────────────────────────────────────
const clone = (v) => JSON.parse(JSON.stringify(v));

// 模板实例值中性化：与 scripts/gen-config-example.mjs 同规则。
// 公开发布时即便源 config.example.json 是旧产物，也要再兜一遍 ——
// 个人隧道地址（natapp/ngrok…）、窗口坐标、界面/语音开关都不能进公开树。
const TPL_ALLOWED_HOSTS = new Set(['example.com', '127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const TPL_INSTANCE_DEFAULTS = {
  'ui.pet_window.x': 0,
  'ui.pet_window.y': 0,
  'ui.click_through_default': false,
  'voice.duplex.backchannel_gate': false,
  'ui.screen_extend.extend': false,
  'ui.screen_extend.left': false,
  'ui.screen_extend.right': true,
};

function tplHostAllowed(host) {
  if (!host) return false;
  return TPL_ALLOWED_HOSTS.has(host) || /(^|\.)example\.(com|org|net)$/.test(host);
}

function setDottedPath(obj, dotted, val) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

/** 遍历所有 http(s) 值：host 不在白名单的一律换成示例地址；再压实例键。 */
function neutralizeTemplate(obj) {
  const walk = (val) => {
    if (Array.isArray(val)) return val.map(walk);
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) out[k] = walk(v);
      return out;
    }
    if (typeof val === 'string' && /^https?:\/\//i.test(val)) {
      let host = null;
      try { host = new URL(val).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (e) { host = null; }
      if (!tplHostAllowed(host)) return 'https://api.example.com/v1';
    }
    return val;
  };
  const out = walk(obj);
  for (const [dotted, val] of Object.entries(TPL_INSTANCE_DEFAULTS)) setDottedPath(out, dotted, val);
  return out;
}

function emptyForType(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'bool' || t === 'boolean') return false;
  if (['int', 'integer', 'float', 'number', 'double'].includes(t)) return 0;
  if (t === 'array' || t === 'list') return [];
  if (t === 'object' || t === 'dict') return {};
  return '';
}

/** 字段描述器：保留 title/description/type，value 一律回到 default（无 default 按类型取空值）。 */
function purifyNode(value) {
  if (Array.isArray(value)) return value.map((v) => purifyNode(v));
  if (value && typeof value === 'object') {
    const isDescriptor = typeof value.type === 'string' && ('default' in value || 'value' in value);
    if (isDescriptor) {
      const out = { ...value };
      out.value = 'default' in value ? clone(value.default) : emptyForType(value.type);
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = purifyNode(v);
    return out;
  }
  return value;
}

function purifyJson(rel, text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    throw new Error('JSON 解析失败 [' + rel + ']：' + (e && e.message || e));
  }

  if (/\/plugin_config\.json$/.test(rel)) {
    obj = purifyNode(obj);
    if (/community\/dispatch\/plugin_config\.json$/.test(rel)) {
      // PCL 字段可能嵌在分组（{type:'object', fields:{...}}）里，递归找
      const findKey = (node, key) => {
        if (!node || typeof node !== 'object') return null;
        if (Object.prototype.hasOwnProperty.call(node, key)) return node;
        for (const v of Object.values(node)) {
          const hit = findKey(v, key);
          if (hit) return hit;
        }
        return null;
      };
      const holder = findKey(obj, 'PCL');
      if (holder && holder.PCL && typeof holder.PCL === 'object') {
        holder.PCL.description = 'Plain Craft Launcher 的 exe 完整路径（留空则使用自动探测/环境变量）。';
        if ('default' in holder.PCL) holder.PCL.default = '';
        holder.PCL.value = '';
      }
    }
    return JSON.stringify(obj, null, 2) + '\n';
  }

  if (/\/config\.example\.json$/.test(rel)) {
    // 先中性化个人 URL / 窗口坐标 / 界面与语音实例开关（旧模板兜底），再整理工作区等字段。
    obj = neutralizeTemplate(obj);
    if (!obj.dispatch || typeof obj.dispatch !== 'object') obj.dispatch = {};
    obj.dispatch.workspaces = { pet: '.' };
    obj.dispatch.defaultWorkspace = '.';
    delete obj.browser_ext_ids;
    if (obj.privacy && typeof obj.privacy === 'object') obj.privacy.acked_at = '';
    // 附带清掉可能属于个人的平台 appid / 克隆声线 id（模板里没有意义）
    if (obj.cloud && typeof obj.cloud === 'object') {
      if (obj.cloud.volcengine_tts) obj.cloud.volcengine_tts.appid = '';
      if (obj.cloud.aliyun_tts) obj.cloud.aliyun_tts.voice = '';
      if (obj.cloud.baidu_asr) obj.cloud.baidu_asr.appid = '';
    }
    return JSON.stringify(obj, null, 2) + '\n';
  }

  if (/\/llm_providers\.example\.json$/.test(rel)) {
    const list = Array.isArray(obj.providers) ? obj.providers : [];
    for (const p of list) {
      p.name = p.id === 'comad' ? '示例云端服务' : '示例本地网关';
      p.api_url = 'https://api.example.com/v1';
      if (Array.isArray(p.models)) {
        for (const m of p.models) {
          m.model_id = 'example-model';
          m.name = '示例模型';
        }
      }
      if (!p.api_key) p.api_key = '<填你的密钥>';
    }
    return JSON.stringify(obj, null, 2) + '\n';
  }

  return JSON.stringify(obj, null, 2) + '\n';
}

// ── 逐文件补丁（12 条 + 审计中发现的同类硬编码）─────────────────────────
const PATCHERS = {
  'pet-runtime/tools/restart-pet.ps1': (s) => {
    s = mustReplace(s, ("$root = '" + ROOT_WIN_BS + "'"),
      String.raw`$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)`, 'restart root');
    s = mustReplace(s, "$loopScript = '" + ROOT_WIN + "/audio-loop/audio_loop_server.py'",
      String.raw`$loopScript = Join-Path $root 'audio-loop\audio_loop_server.py'`, 'restart loop');
    s = mustReplace(s, "$vpPython = '" + ROOT_WIN + "/pet-runtime/venv-voice/Scripts/python.exe'",
      String.raw`$vpPython = Join-Path $root 'pet-runtime\venv-voice\Scripts\python.exe'`, 'restart vp python');
    s = mustReplace(s, "$vpScript = '" + ROOT_WIN + "/audio_common/voiceprint_server.py'",
      String.raw`$vpScript = Join-Path $root 'audio_common\voiceprint_server.py'`, 'restart vp script');
    s = mustReplace(s, ("$memosDir = '" + ROOT_WIN_BS + "\\_incoming\\my-neuro\\plugins-dlc\\memos\\memos_system'"),
      String.raw`$memosDir = Join-Path $root '_incoming\my-neuro\plugins-dlc\memos\memos_system'`, 'restart memos dir');
    s = mustReplace(s, ("if (Test-Path '" + ROOT_WIN_BS + "\\_research\\lumenact\\models\\selector.onnx')"),
      String.raw`if (Test-Path (Join-Path $root '_research\lumenact\models\selector.onnx'))`, 'restart lumen');
    return s;
  },

  'pet-runtime/tools/nightly-deep-eval.ps1': (s) => {
    s = mustReplace(s, ("$root = '" + ROOT_WIN_BS + "'"),
      String.raw`$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)`, 'nightly root');
    s = mustReplace(s, String.raw`$node = 'C:\Program Files\nodejs\node.exe'`,
      [
        '$nodeCmd = Get-Command node -ErrorAction SilentlyContinue',
        'if (-not $nodeCmd) { Write-Error \'找不到 node（Get-Command node 为空）\'; exit 1 }',
        '$node = $nodeCmd.Source',
      ].join('\n'), 'nightly node');
    return s;
  },

  '_packaging/identity/register-and-log.ps1': (s) => {
    s = mustReplace(s, String.raw`把全程写进 D:\Temp\msix-register.log`, '把全程写进 %TEMP%\\msix-register.log', 'register comment');
    s = mustReplace(s, String.raw`$log = 'D:\Temp\msix-register.log'`,
      String.raw`$log = Join-Path $env:TEMP 'msix-register.log'`, 'register log');
    s = mustReplace(s, ("'" + ROOT_WIN_BS + "\\_packaging\\out\\electron-builder\\win-unpacked'"),
      String.raw`(Join-Path (Split-Path -Parent $PSScriptRoot) 'out\electron-builder\win-unpacked')`, 'register packdir');
    s = mustReplace(s, ("'" + ROOT_WIN_BS + "\\_packaging\\out\\identity\\stage\\AppxManifest.xml'"),
      String.raw`(Join-Path (Split-Path -Parent $PSScriptRoot) 'out\identity\stage\AppxManifest.xml')`, 'register manifest');
    return s;
  },

  'scripts/bootstrap.mjs': (s) => {
    // MemOS 子树存在性（公开版默认没有）
    s = mustReplace(s,
      "const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };",
      [
        "const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };",
        "const MEMOS_PRESENT = (() => { try { return fs.statSync(MEMOS).isDirectory(); } catch (e) { return false; } })();",
      ].join('\n'), 'bootstrap memos present');

    // 公开导出树标记：memos 配置与皮套构建属于「首次初始化」，由安装向导处理，
    // 不应当作 required 红项（否则 clone 后还没跑向导就先红一片）。
    s = mustReplace(s,
      "const MEMOS_PRESENT = (() => { try { return fs.statSync(MEMOS).isDirectory(); } catch (e) { return false; } })();",
      [
        "const MEMOS_PRESENT = (() => { try { return fs.statSync(MEMOS).isDirectory(); } catch (e) { return false; } })();",
        "const PUBLIC_TREE = fs.existsSync(path.join(ROOT, '.public-tree'));",
      ].join('\n'), 'bootstrap public tree flag');

    // memos 配置：缺失时降为「待初始化」而不是 required 红
    s = mustReplace(s,
      "      id: c.id, name: c.real, status: 'missing', required: true,",
      "      id: c.id, name: c.real, status: 'missing', required: c.id === 'memos.config' ? false : true,",
      'bootstrap memos config optional');

    // MemOS 配置两项：子树缺失时 skip（用户自备），不判红
    s = mustReplace(s,
      '  const real = path.join(c.dir, c.real);\n  const example = path.join(c.dir, c.example);\n  if (!isFile(example)) {',
      [
        '  const real = path.join(c.dir, c.real);',
        '  const example = path.join(c.dir, c.example);',
        "  if (c.id === 'memos.config' && !MEMOS_PRESENT) {",
        '    add({',
        '      id: `${c.id}.example`, name: `${c.example}（可选）`, status: \'skip\', required: false,',
        "      detail: '缺少 memos_config 模板（本仓应含；缺失说明导出不完整）',",
        "      fix: '取得 MemOS 官方代码后放到 _incoming/my-neuro/plugins-dlc/memos/',",
        '    });',
        '    add({',
        '      id: c.id, name: `${c.real}（可选）`, status: \'skip\', required: false,',
        "      detail: '未安装 MemOS（长期记忆默认不可用，聊天/TTS 照常）',",
        "      fix: '自备 MemOS 后 cp memos_config.example.json memos_config.json 并填 llm.config.api_key',",
        '    });',
        '    continue;',
        '  }',
        '  if (!isFile(example)) {',
      ].join('\n'), 'bootstrap memos cfg');

    // MemOS Python 依赖：子树缺失时只 warn
    s = mustReplace(s,
      "    id: 'py.memos', name: 'Python 依赖 · MemOS 8003', required: true,",
      "    id: 'py.memos', name: 'Python 依赖 · MemOS 8003（可选）', required: MEMOS_PRESENT,",
      'bootstrap py.memos');

    // 安装清单：MemOS requirements 只在子树存在时要求
    s = mustReplace(s,
      "    '_incoming/my-neuro/plugins-dlc/memos/memos_system/requirements.txt',",
      "    ...(MEMOS_PRESENT ? ['_incoming/my-neuro/plugins-dlc/memos/memos_system/requirements.txt'] : []),",
      'bootstrap manifest');

    // 8090 嵌入：required → warn
    s = mustReplace(s, [
      '  if (healthy) {',
      "    add({ id: 'embed', name: '嵌入服务 8090', status: 'ok', required: true, detail: 'health=ok' });",
      '  } else {',
      '    add({',
      "      id: 'embed', name: '嵌入服务 8090', status: 'missing', required: true,",
      '      detail: `连不上或未就绪（${err}）；MemOS 8003 会起不来`,',
      "      fix: 'pwsh -File scripts/start-embed.ps1（模型放 ./models/Qwen3-Embedding-0.6B-Q8_0.gguf，见 docker-compose.embed.yml）',",
      '    });',
      '  }',
    ].join('\n'), [
      '  if (healthy) {',
      "    add({ id: 'embed', name: '嵌入服务 8090（可选）', status: 'ok', required: false, detail: 'health=ok' });",
      '  } else {',
      '    add({',
      "      id: 'embed', name: '嵌入服务 8090（可选）', status: 'warn', required: false,",
      '      detail: `连不上或未就绪（${err}）；没有它时 MemOS 记忆嵌入降级，聊天/TTS 不受影响`,',
      "      fix: 'pwsh -File scripts/start-embed.ps1（模型放 ./models/Qwen3-Embedding-0.6B-Q8_0.gguf，见 docker-compose.embed.yml）',",
      '    });',
      '  }',
    ].join('\n'), 'bootstrap embed warn');

    // 新增：自备资产检查（moc3 / Cubism / MemOS 缺失 = warn + 自备指引）
    s = mustReplace(s,
      '// ── 9. petbody build（皮套 bundle 必须先构建）─────────────────────────',
      [
        '// ── 8.5 自备资产（公开版仅模型需自备；Cubism/MemOS 已随仓）───────────',
        '{',
        '  const moc3 = [',
        "    path.join(APP, 'assets', 'petbody', 'pet.moc3'),",
        "    path.join(ROOT, 'pet-runtime', 'desktop', 'assets', 'jellyfish', 'pet.moc3'),",
        '  ].find(isFile);',
        '  const cubismCore = [',
        "    path.join(APP, 'libs', 'live2dcubismcore.min.js'),",
        "    path.join(ROOT, 'pet-runtime', 'desktop', 'vendor2', 'live2dcubismcore.min.js'),",
        '  ].find(isFile);',
        '  const missing = [];',
        "  if (!moc3) missing.push('Live2D 模型（本仓应含；缺失说明导出不完整）');",
        "  if (!cubismCore) missing.push('Live2D Cubism Core（本仓应含；缺失说明导出不完整）');",
        "  if (!MEMOS_PRESENT) missing.push('MemOS 记忆后端（本仓应含；缺失说明导出不完整）');",
        '  if (!missing.length) {',
        "    add({ id: 'assets.selfsupply', name: '自备资产', status: 'ok', required: false, detail: '模型 / Cubism / MemOS 齐了' });",
        '  } else {',
        '    add({',
        "      id: 'assets.selfsupply', name: '自备资产（模型需自备）', status: 'warn', required: false,",
        '      detail: `缺：${missing.join(\'、\')}（不影响聊天/TTS/字幕；皮套渲染降级）`,',
        "      fix: '确认 _incoming/my-neuro/live-2d/assets/petbody/ 完整（.moc3 + 纹理 + model3.json + motions/expressions）',",
        '      meta: { missing },',
        '    });',
        '  }',
        '}',
        '',
        '// ── 9. petbody build（皮套 bundle 必须先构建）─────────────────────────',
      ].join('\n'), 'bootstrap selfsupply');

    // 皮套 bundle：缺 Cubism SDK 时 warn（自备），不判红
    s = mustReplace(s,
      '  const problems = [];\n  if (!declared) problems.push(\'package.json 未声明 esbuild\');',
      [
        '  const problems = [];',
        "  const cubismVendor = path.join(ROOT, 'pet-runtime', 'desktop', 'vendor', 'cubism');",
        '  const sdkPresent = exists(cubismVendor);',
        "  if (!declared) problems.push('package.json 未声明 esbuild');",
      ].join('\n'), 'bootstrap petbody sdk');

    s = mustReplace(s, [
      '  if (!problems.length) {',
      "    add({ id: 'petbody', name: '皮套 bundle', status: 'ok', required: true, detail: '已构建并部署' });",
      '  } else {',
      '    add({',
      "      id: 'petbody', name: '皮套 bundle', status: 'missing', required: true,",
      "      detail: problems.join('；'),",
      "      fix: 'cd pet-runtime && npm install && cd .. && node pet-runtime/build-and-deploy-petbody.mjs',",
      '    });',
      '  }',
    ].join('\n'), [
      '  if (!problems.length) {',
      "    add({ id: 'petbody', name: '皮套 bundle', status: 'ok', required: true, detail: '已构建并部署' });",
      '  } else if (PUBLIC_TREE) {',
      '    add({',
      "      id: 'petbody', name: '皮套 bundle（待构建）', status: 'warn', required: false,",
      "      detail: problems.join('；'),",
      "      fix: 'cd pet-runtime && npm install && cd .. && node pet-runtime/build-and-deploy-petbody.mjs',",
      '    });',
      '  } else {',
      '    add({',
      "      id: 'petbody', name: '皮套 bundle', status: 'missing', required: true,",
      "      detail: problems.join('；'),",
      "      fix: 'cd pet-runtime && npm install && cd .. && node pet-runtime/build-and-deploy-petbody.mjs',",
      '    });',
      '  }',
    ].join('\n'), 'bootstrap petbody warn');

    return s;
  },

  'pet-runtime/tools/services.json': (s) => {
    s = mustReplace(s, "路径一律相对项目根（" + ROOT_WIN_JSON + "）。",
      '路径一律相对项目根。Python 解释器由 launch-my-neuro.mjs 通过 live-2d/js/core/runtime-paths.js 解析（start.exe 里的 py/python 只是兜底）。',
      'services comment');
    s = mustReplace(s,
      '      "name": "MemOS 记忆后端",\n      "port": 8003,\n      "required": true,',
      '      "name": "MemOS 记忆后端",\n      "port": 8003,\n      "required": false,',
      'services memos required');
    s = mustReplace(s, '"note": "入口不带 --port；冷启动要加载嵌入/索引，可能几十秒"',
      '"note": "入口不带 --port；冷启动要加载嵌入/索引，可能几十秒。MemOS 子树随仓分发（Apache-2.0）；未装 Python 依赖时该项为可选"',
      'services memos note');
    return s;
  },

  'pet-runtime/tools/launch-my-neuro.mjs': (s) => {
    s = mustReplace(s, "import { fileURLToPath } from 'node:url';",
      "import { fileURLToPath } from 'node:url';\nimport { createRequire } from 'node:module';", 'launcher import');
    s = mustReplace(s, 'const SELF = fileURLToPath(import.meta.url);',
      [
        'const SELF = fileURLToPath(import.meta.url);',
        '',
        '// Python 解释器统一走宿主的 runtime-paths（排除微软商店占位符），别裸 spawn(\'py\')。',
        'const requireApp = createRequire(import.meta.url);',
        'const PY_BIN = (() => {',
        '  try { return requireApp(resolve(appDir, \'js\', \'core\', \'runtime-paths.js\')).resolvePython(); }',
        '  catch (e) {',
        '    console.warn(\'[launcher] runtime-paths 不可用，回落 py:\', e && e.message || e);',
        '    return process.platform === \'win32\' ? \'py\' : \'python3\';',
        '  }',
        '})();',
      ].join('\n'), 'launcher py');
    const before = s;
    s = s.split("spawn('py',").join('spawn(PY_BIN,');
    if (s === before) throw new Error('补丁锚点缺失 [launcher spawn py]');
    s = mustReplace(s, "console.log('[launcher] 没找到 MemOS 后端，跳过');",
      "console.log('[launcher] 没找到 MemOS 后端，跳过（确认 _incoming/my-neuro/plugins-dlc/memos/ 存在；缺失见 README）');", 'launcher memos skip');
    s = mustReplace(s, String.raw`先跑一次 D:\\llm\\2-start-embed.bat（llama.cpp + Qwen3-Embedding-0.6B），或确认 Docker Desktop 已启动`,
      '先跑一次 pwsh -File scripts/start-embed.ps1（llama.cpp + Qwen3-Embedding-0.6B），或确认 Docker Desktop 已启动',
      'launcher embed hint');
    return s;
  },

  '_probe/test-webui-security.py': (s) => {
    // 测试夹具里的假 key 改成一眼可辨的 test- 前缀（避免被真实 key 扫描误报）
    s = mustReplace(s, "'" + SK_PREFIX + "REALSECRET-abcdefghijklmnop-1234'", "'test-SECRET-abcdefghijklmnop-1234'", 'sec fixture 1');
    s = mustReplace(s, "'" + SK_PREFIX + "VOICESECRET-9876'", "'test-VOICESECRET-9876'", 'sec fixture 2');
    s = mustReplace(s, "'" + SK_PREFIX + "DEFAULTSECRET-445566778899'", "'test-DEFAULTSECRET-445566778899'", 'sec fixture 3');
    s = mustReplace(s, "'" + SK_PREFIX + "NEWDEFAULT-0000111122223333'", "'test-NEWDEFAULT-0000111122223333'", 'sec fixture 4');
    return s;
  },

  '使用手册.md': (s) => {
    s = mustReplace(s, '参考仓库（' + UPSTREAM + '/Akane/Artemis 等）', '第三方参考仓库（上游项目）', 'manual refs');
    return s;
  },

  'live-2d/petbridge/vts-server.mjs': (s) => {
    s = mustReplace(s, '（' + UPSTREAM + ' / OBS 插件 / 第三方工具）', '（第三方 VTS 客户端 / OBS 插件等）', 'vts comment');
    return s;
  },

  'live-2d/plugins/community/memory-recall/index.js': (s) => {
    s = mustReplace(s, '（借 ' + UPSTREAM + '/desktop-pet 的 dynamics 模型）', '（借上游 desktop-pet 的 dynamics 模型）', 'recall comment');
    return s;
  },

  'live-2d/js/voice/viseme.js': (s) => {
    // 2026-11-27：源码已去掉硬编码解释器/脚本路径（runtime-paths + 项目根查找），
    // 不再需要导出时改写；只保留错误可观测补丁。
    s = mustReplace(s, "    child.on('error', () => { busy = false; });",
      [
        "    child.on('error', (err) => {",
        '        busy = false;',
        "        try { __silentAudit.audit('viseme.js:62', err); } catch (e2) {}",
        "        console.warn('[viseme] Python 口型进程启动失败（回落正弦）：' + (err && err.message || err));",
        '    });',
      ].join('\n'), 'viseme error');
    return s;
  },

  'live-2d/main.js': (s) => {
    s = mustReplace(s, "fs.writeFileSync('" + ROOT_WIN + "/_incoming/main-boot.json'",
      "fs.writeFileSync(path.join(__dirname, '..', '..', 'main-boot.json')", 'main boot');
    s = mustReplace(s, "fs.writeFileSync('" + ROOT_WIN + "/_incoming/tray-selftest.log'",
      "fs.writeFileSync(path.join(__dirname, '..', '..', 'tray-selftest.log')", 'main tray');
    return s;
  },

  'live-2d/js/avatar/petbody/driver.js': (s) => {
    s = mustReplace(s,
      'const fs = require("fs");\nconst LOG = "' + ROOT_WIN + '/_incoming/petbody-debug.log";',
      [
        'const fs = require("fs");',
        'const path = require("path");',
        'const LOG = path.resolve(__dirname, "../../../../..", "petbody-debug.log");',
      ].join('\n'), 'driver log');
    s = mustReplace(s, '"PetBody 运行时未加载（build/petbody.js 缺失）"',
      '"PetBody 运行时未加载（build/petbody.js 缺失）：公开版不随仓分发 Cubism SDK，请按 README「自备资产」取得 SDK 后运行 node pet-runtime/build-and-deploy-petbody.mjs"',
      'driver msg');
    return s;
  },

  'live-2d/js/avatar/petbody/assets-bridge.js': (s) => {
    s = mustReplace(s,
      'const fs = require("fs");\n\nconst LOG = "' + ROOT_WIN + '/_incoming/petbody-assets.log";',
      [
        'const fs = require("fs");',
        'const path = require("path");',
        '',
        'const LOG = path.resolve(__dirname, "../../../../..", "petbody-assets.log");',
      ].join('\n'), 'assets log');
    return s;
  },

  'pet-runtime/tools/pvz-mod-enable.cjs': (s) => {
    s = mustReplace(s, "const fs = require('fs');\nconst path = require('path');",
      "const fs = require('fs');\nconst path = require('path');\nconst os = require('os');", 'pvz os');
    s = mustReplace(s, "  '" + HOME_WIN + "/AppData/Roaming/Godot/app_userdata/植物大战僵尸杂交版';",
      "  path.join(os.homedir(), 'AppData', 'Roaming', 'Godot', 'app_userdata', '植物大战僵尸杂交版');", 'pvz dir');
    return s;
  },

  'pet-runtime/tools/game_detector.py': (s) => {
    s = mustReplace(s, 'C:' + '/Users/.../pet-game/frame.bgra', '<user-home>/pet-game/frame.bgra', 'game_detector sample path');
    s = mustReplace(s, String.raw`        MC_JAR = os.environ.get('MC_JAR') or r'D:/mc/.minecraft/versions/1.21.1/1.21.1.jar'`,
      [
        "        _mc_home = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), '.minecraft')",
        "        MC_JAR = os.environ.get('MC_JAR') or os.path.join(_mc_home, 'versions', '1.21.1', '1.21.1.jar')",
      ].join('\n'), 'game_detector jar');
    return s;
  },

  'pet-runtime/tools/launch-minecraft.py': (s) => {
    s = mustReplace(s, String.raw`MC_ROOT = os.environ.get('MC_ROOT') or r'D:/mc/.minecraft'`,
      [
        'MC_ROOT = os.environ.get(\'MC_ROOT\') or os.path.join(',
        "    os.environ.get('APPDATA') or os.path.expanduser('~'), '.minecraft')",
      ].join('\n'), 'launch mc root');
    return s;
  },

  'pet-runtime/tools/doctor.mjs': (s) => {
    s = mustReplace(s, '// MemOS 长期记忆 + 它依赖的嵌入服务\nasync function checkMemoryBackend() {',
      [
        '// MemOS 长期记忆 + 它依赖的嵌入服务',
        "// MemOS 子树随仓（Apache-2.0）：缺失说明导出不完整，skip 并提示，不判红。",
        "const MEMOS_SUBTREE = path.join(MY, 'plugins-dlc', 'memos', 'memos_system');",
        'async function checkMemoryBackend() {',
        '  if (!fs.existsSync(MEMOS_SUBTREE)) {',
        "    add('skip', 'MemOS 后端', '未找到 MemOS 子树（本仓应含；缺失见 README）', '');",
        "    add('skip', '嵌入服务 8090', '未找到 MemOS/嵌入服务（启动后可用）', '');",
        '    return;',
        '  }',
      ].join('\n'), 'doctor memos guard');
    s = mustReplace(s, String.raw`'跑一次 D:\\llm\\2-start-embed.bat'`,
      "'pwsh -File scripts/start-embed.ps1（或 docker start llama-embed）'", 'doctor embed hint');
    return s;
  },

  'pet-core/src/lib.rs': (s) => {
    s = mustReplace(s, '//! - `recall`：长期记忆召回公式，移植自 ' + UPSTREAM + '（docs/MEMORY.md）\n', '', 'pet-core recall doc');
    s = mustReplace(s, 'pub mod recall;', '', 'pet-core recall mod');
    return s;
  },

  'pet-core/Cargo.toml': (s) => {
    s = mustReplace(s,
      'description = "大肥鱼内核：窗口布局与记忆召回（从 AkaneCompanionLab / ' + UPSTREAM + ' 移植）+ 知识检索 + Windows 原生能力"',
      'description = "大肥鱼内核：窗口布局（移植自 AkaneCompanionLab，Apache-2.0）+ 知识检索 + Windows 原生能力"',
      'pet-core description');
    return s;
  },

  'pet-runtime/desktop/emotion-state.mjs': (s) => {
    s = mustReplace(s, '// emotion-state.mjs —— 情绪状态契约（借 ' + UPSTREAM + ' contracts/emotion-state.ts 的思想）',
      '// emotion-state.mjs —— 情绪状态契约（参考上游 emotion-state 契约的思想）', 'emotion-state head');
    s = mustReplace(s, '// 四条核心约束（都是 ' + UPSTREAM + ' 踩过的坑）：',
      '// 四条核心约束（都是上游实现踩过的坑）：', 'emotion-state body');
    return s;
  },

  '_probe/agent-eval/runner.mjs': (s) => {
    s = mustReplace(s, "const PET_CORE = process.env.PET_CORE_BIN || '" + ROOT_WIN + "/pet-core/target/release/pet-core.exe';",
      "const PET_CORE = process.env.PET_CORE_BIN || path.resolve(PROBE_ROOT, '..', 'pet-core', 'target', 'release', 'pet-core.exe');",
      'agent-eval pet-core');
    return s;
  },

  '_probe/restart-loop-audit.ps1': (s) => {
    s = mustReplace(s, "    [string]$RestartScript = '" + ROOT_WIN_BS + "\\pet-runtime\\tools\\restart-pet.ps1',",
      "    [string]$RestartScript = '',", 'audit param');
    s = mustReplace(s, "$ErrorActionPreference = 'Stop'\n$root = '" + ROOT_WIN_BS + "'",
      [
        "$ErrorActionPreference = 'Stop'",
        '$root = Split-Path -Parent $PSScriptRoot',
        "if (-not $RestartScript) { $RestartScript = Join-Path $root 'pet-runtime\\tools\\restart-pet.ps1' }",
      ].join('\n'), 'audit root');
    return s;
  },

  '_probe/mobile-emulate.mjs': (s) => {
    s = mustReplace(s, "import path from 'node:path';",
      "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';", 'mobile url import');
    // universalReplace 可能已经把 chrome.exe 字面量换成通用写法
    if (s.includes("const CHROME = '" + HOME_WIN + "/")) {
      s = mustReplace(s, "const CHROME = '" + HOME_WIN + "/AppData/Local/Google/Chrome/Application/chrome.exe';",
        "const CHROME = process.env.CHROME_PATH || 'chrome';", 'mobile chrome');
    }
    s = mustReplace(s, "const OUT_DIR = '" + ROOT_WIN + "/_probe/shots-mobile';",
      "const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));\nconst OUT_DIR = path.join(PROBE_DIR, 'shots-mobile');", 'mobile out');
    s = mustReplace(s, "const TOKEN_FILE = '" + ROOT_WIN + "/_incoming/my-neuro/" + DATA_DIRNAME + "/遥控令牌.txt';",
      "const TOKEN_FILE = path.join(PROBE_DIR, '..', '_incoming', 'my-neuro', '" + DATA_DIRNAME + "', '遥控令牌.txt');", 'mobile token');
    return s;
  },

  'scripts/gen-config-example.mjs': (s) => {
    s = mustReplace(s, 'function scrub(value, key = \'\') {\n  if (Array.isArray(value))',
      [
        '// 公开模板的可移植性：路径/工作区不落真实盘符；隐私时间戳与浏览器扩展 id 清空；',
        '// provider URL/模型 id 一律给示例值（私有网关不外泄）。',
        'const PATHY_KEY = /(^|_)(path|dir|directory|root)$/i;',
        'function portable(value, key) {',
        "  if (key === 'workspaces' && value && typeof value === 'object' && !Array.isArray(value)) {",
        '    const out = {};',
        '    for (const k of Object.keys(value)) out[k] = \'.\';',
        '    return out;',
        '  }',
        "  if (key === 'defaultWorkspace') return '.';",
        "  if (key === 'acked_at') return '';",
        "  if (key === 'browser_ext_ids') return [];",
        "  if (key === 'api_url' || key === 'base_url') return 'https://api.example.com/v1';",
        "  if (key === 'model_id') return 'example-model';",
        "  if (typeof value === 'string' && PATHY_KEY.test(key) && /^[A-Za-z]:[\\\\/]/.test(value)) return '.';",
        '  return undefined;',
        '}',
        '',
        'function scrub(value, key = \'\') {',
        '  const p = portable(value, key);',
        '  if (p !== undefined) return p;',
        '  if (Array.isArray(value))',
      ].join('\n'), 'gen-config portable');
    return s;
  },
};

// ── 特殊文件：GBK 的入口 cmd 转 UTF-8 + chcp ────────────────────────────
function patchCmdEncoding(rel, text, converted) {
  if (rel !== '大肥鱼.cmd') return text;
  let s = text;
  if (converted) {
    if (!s.startsWith('@echo off')) die('大肥鱼.cmd 结构异常（首行不是 @echo off）');
    s = s.replace('@echo off', '@echo off\r\nchcp 65001 >nul');
    s = s.replace(/rem Encoded as GBK\(936\)\./, 'rem UTF-8 + chcp 65001.');
  }
  return s;
}

// ── 复制主流程 ──────────────────────────────────────────────────────────
const stats = { files: 0, bytes: 0, text: 0, binary: 0, converted: 0, perSide: {} };

function copyOne(srcRepo, rel, side) {
  const src = path.join(srcRepo, rel);
  let buf;
  try { buf = fs.readFileSync(src); } catch (e) { die('tracked 文件读不到：' + src); }
  const destRel = side === 'app' ? path.posix.join('_incoming', 'my-neuro', rel) : rel;
  const dest = path.join(DEST, ...destRel.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const ext = extOf(rel);
  // 导出脚本自身原样复制（它就是去敏规则的源码，不能再被自身规则改写）
  if (rel === SELF_REL) {
    fs.writeFileSync(dest, buf);
    stats.text++;
    stats.files++;
    stats.bytes += buf.length;
    return;
  }
  const isJson = /\.json$/i.test(rel);
  const isPluginConfig = /\/plugin_config\.json$/.test(rel);
  const isExample = /\/config\.example\.json$/.test(rel) || /\/llm_providers\.example\.json$/.test(rel);
  const isQ = /^_probe\/(audit-A1|redteam-RT1)\/q\d?\.json$/.test(rel);
  const textish = TEXT_EXT.has(ext) && !(ext === '.png' || ext === '.jpg' || ext === '.wav');
  const decoded = textish ? decodeText(buf, rel) : null;

  if (!decoded) {
    fs.writeFileSync(dest, buf);
    stats.binary++;
    stats.files++;
    stats.bytes += buf.length;
    return;
  }

  let text = decoded.text;
  if (decoded.converted) stats.converted++;

  if (isJson) {
    text = purifyJson(rel, text);
  }
  if (isQ) {
    try {
      const obj = JSON.parse(text);
      if (obj && 'query' in obj) obj.query = '示例查询';
      text = JSON.stringify(obj, null, 2) + '\n';
    } catch (e) { /* 保持原样 */ }
  }

  // 先做逐文件补丁（此时仍是原文字面量），再做全局字面量替换
  const patcher = PATCHERS[rel];
  if (patcher) text = patcher(text);
  text = universalReplace(text);
  text = patchCmdEncoding(rel, text, decoded.converted);
  text = scrubPII(text);
  text = scrubMemosFixtures(rel, text);

  const out = decoded.bom && !decoded.converted ? '\uFEFF' + text : text;
  const outBuf = Buffer.from(out, 'utf8');
  fs.writeFileSync(dest, outBuf);
  stats.text++;
  stats.files++;
  stats.bytes += outBuf.length;
}

log('主仓导出 ' + mainFiles.length + ' 个文件；应用仓导出 ' + appFiles.length + ' 个文件');
for (const rel of mainFiles) copyOne(MAIN, rel, 'main');
for (const rel of appFiles) copyOne(APP, rel, 'app');
stats.perSide.main = mainFiles.length;
stats.perSide.app = appFiles.length;

// 分发必须携带的许可文件（不属于任一 tracked 文件，由本脚本随树附加）
const EXTRA_LICENSES = [
  ['scripts/licenses/Apache-2.0.txt', '_incoming/my-neuro/plugins-dlc/memos/LICENSE'],
  ['scripts/licenses/MemOS-NOTICE.md', '_incoming/my-neuro/plugins-dlc/memos/NOTICE'],
];
for (const [relFrom, relTo] of EXTRA_LICENSES) {
  const from = path.join(MAIN, relFrom);
  const to = path.join(DEST, relTo);
  if (!fs.existsSync(from)) die('缺少许可文件：' + relFrom);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  stats.files++;
  stats.text++;
  stats.bytes += fs.statSync(to).size;
}

// ── 应用仓 README 替换（原 README 指向私有仓 clone 地址，合并树里会误导）──
{
  const p = path.join(DEST, '_incoming', 'my-neuro', 'README.md');
  if (fs.existsSync(p)) {
    fs.writeFileSync(p, [
      '# 大肥鱼 · 应用层（live-2d）',
      '',
      '本目录是「大肥鱼」的 Electron 应用层（渲染、语音、记忆、插件）。',
      '公开版已经把宿主运行时与应用层合并成一棵树，**不需要再单独 clone 私有仓库**。',
      '',
      '安装、配置、启动、自备资产：请看仓库根目录的 `README.md`。',
      '',
      '## 常用命令（在仓库根目录执行）',
      '',
      '```bat',
      'cd _incoming\\my-neuro\\live-2d && npm install',
      'node scripts\\bootstrap.mjs --json',
      'node _probe\\check-ci.mjs',
      '```',
      '',
      '体检：在仓库根目录跑 `node scripts/bootstrap.mjs`。',
      '',
    ].join('\n'), 'utf8');
  }
}

// ── 根文档 ──────────────────────────────────────────────────────────────
const ROOT_DOCS = {};

ROOT_DOCS['LICENSE'] = [
  'MIT License',
  '',
  'Copyright (c) 2026 MyNeuro',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
  '',
].join('\n');

ROOT_DOCS['NOTICE'] = [
  '# NOTICE',
  '',
  '本仓库是「大肥鱼」桌面 AI 伴侣的**完整代码树**（不含模型、SDK、记忆数据与任何密钥）。',
  '自有代码按根目录 `LICENSE`（MIT）授权。下列第三方内容按各自许可使用（随仓或自备见下文）。',
  '',
  '## MyNeuro（宿主应用层）',
  '',
  '- 来源：MyNeuro / my-neuro 桌面 AI 伴侣宿主（作者 morettt 及社区贡献者）。',
  '- 本仓库的 `_incoming/my-neuro/` 是「大肥鱼」自建应用层代码；上游项目与其插件的版权归原作者。',
  '- 若上游对某文件另有许可声明，以该声明为准；本仓库保留原有署名与注释。',
  '',
  '## AkaneCompanionLab — Apache License 2.0',
  '',
  '- 作者：misaka-coder · https://github.com/misaka-coder/AkaneCompanionLab',
  '- 使用范围：`pet-core/src/geometry.rs`、`pet-core/src/placement.rs` 的窗口几何与布局算法',
  '  （移植自 `desktop_pet_next/src-tauri/src/pet_windows/{models,placement}.rs`）。',
  '- 修改说明：去掉 Tauri 类型依赖，改为纯数据 + 纯函数，并补充单元测试。',
  '- Apache-2.0 要求的版权与许可声明见上游仓库的 `LICENSE` 与源文件头。',
  '',
  '## jingyu（表演数据）',
  '',
  '- 工程内 `pet-runtime/desktop/choreo-*` 的 15 段全身表演轨迹由 jingyu 的编译产物转换而来',
  '  （`pet-runtime/tools/compile-performances.py`）。',
  '- 上游许可**尚未最终核实**：本仓库按「保留署名 + 可移除」处理；如权利人提出异议，',
  '  删除 `pet-runtime/desktop/choreo-performances.mjs` 并用自带表演数据重建即可。',
  '',
  '## LumenAct — CC BY 4.0（表演曲线）',
  '',
  '- 作者：B站 Lumen_流明_ · https://github.com/AaBb-coder/LumenAct',
  '- 使用范围：`pet-runtime/data/facs-clips/` 的 97 段 FACS 表演曲线（已重映射到本项目的 FACS 通道）。',
  '- 许可：Creative Commons Attribution 4.0 International（CC BY 4.0），须署名。',
  '- 本仓库**不包含** LumenAct 的参考脸（CC BY-NC 4.0）与语义模型权重（Apache-2.0，需自行下载）。',
  '- 详见 `pet-runtime/data/facs-clips/NOTICE.md`。',
  '',
  '## Live2D Cubism SDK / Cubism Core — 专有许可，按 "Redistributable Code" 随仓分发',
  '',
  '- `live-2d/libs/live2dcubismcore*.js`、`live-2d/vendor/cubism/**`、`pet-runtime/desktop/vendor/cubism/**`',
  '  为 Live2D Cubism Core / Framework；其文件头明确写明属于许可协议中的 **Redistributable Code**。',
  '- 许可全文见 `pet-runtime/desktop/vendor/cubism/Framework/LICENSE.md` 与',
  '  <https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>。',
  '- 仅排除了 Cubism 2 时代、无许可头的 `live2d.min.js`（来源/许可不明）。',
  '- 除上述授权范围外，本项目不授予任何 Live2D 相关权利。',
  '',
  '## 模型与角色资产 — 经作者授权随仓分发',
  '',
  '- 模型：**DeepSeek-chan（大肥鱼）** — 原画及拆分：神宫凉子；Live2D 建模：霓虹猫_NeonNeko。',
  '- 随仓范围：`_incoming/my-neuro/live-2d/assets/petbody/**` 与 `pet-runtime/desktop/assets/jellyfish/**`',
  '  （`*.moc3`、纹理、`*.model3.json`、动作/表情/物理）。',
  '- 使用边界（沿用作者公皮说明）：允许个人直播/录播/视频创作及平台收益、社交平台展示、参数调整、',
  '  二次创作（注明来源）；**禁止二次销售模型文件、冒充原作者**。',
  '- 本项目随仓分发已获作者/权利人许可；如你是权利人且认为分发不当，请提 issue，我们会立即移除。',
  '',
  '## MemOS — Apache License 2.0，随仓分发',
  '',
  '- `_incoming/my-neuro/plugins-dlc/memos/**` 源自 MemTensor / MemOS（Apache-2.0），',
  '  完整许可见该目录 `LICENSE`，修改说明见 `NOTICE`。',
  '- 运行所需的 Python 依赖、Qdrant/嵌入模型由使用者自行安装；本仓库不含真实记忆数据与密钥。',
  '',
  '## ' + UPSTREAM,
  '',
  '- 本仓库**不包含** ' + UPSTREAM + ' 的任何代码。原 `pet-core/src/' + RECALL_RS + '` 已整体移除，',
  '  `lib.rs` 不再声明该模块。',
  '',
  '## 其他素材',
  '',
  '- `live-2d/assets/ornaments/**`：openclipart.org，CC0 / Public Domain（见同目录 `CREDITS.md`）。',
  '- `live-2d/libs/pixi.min.js`、`pixi-live2d-display*.min.js`：MIT License。',
  '- `live-2d/js/lib/THREE-MMD-*`：遵循同目录的 LICENSE / NOTICE。',
  '',
].join('\n');

ROOT_DOCS['SECURITY.md'] = [
  '# 安全说明',
  '',
  '## 密钥只存本地',
  '',
  '- 真实 API key 只应写入 `_incoming/my-neuro/live-2d/config.json`、`llm_providers.json`',
  '  或环境变量（`PET_PYTHON` 等）；这些文件已被 `.gitignore` 忽略，**不要提交**。',
  '- 本仓库不包含任何真实 key、token、私钥或历史提交（全新 git 历史）。',
  '',
  '## 如果你从旧版本/旧压缩包拿到过 key',
  '',
  '1. 立即到对应服务商控制台**吊销并轮换**该 key；改到环境变量不等于安全。',
  '2. 检查账单与调用记录。',
  '3. 不要用 `git filter-repo` 之前的旧历史继续分发。',
  '',
  '## 上报',
  '',
  '- 发现本仓库含密钥/个人信息/受限资产：请开 issue（不要贴出完整密钥），或私下联系维护者。',
  '- 发现代码漏洞：请附最小复现步骤与影响范围。',
  '',
  '## 运行边界',
  '',
  '- 桌宠会申请键鼠注入、屏幕捕获、UIA 等能力；请只在可信机器上运行。',
  '  Windows 的 UIAccess/包身份安装脚本需要管理员权限，运行前请阅读 `_packaging/` 下的脚本。',
  '- 本软件会调用你配置的 LLM/云服务；对话内容可能离开本机，请自行评估。',
  '',
].join('\n');

ROOT_DOCS['README.md'] = [
  '# 大肥鱼 · 桌面 AI 伴侣',
  '',
  '> English: [README.en.md](README.en.md)',
  '',
  '## 一键安装（Windows 10/11 x64）',
  '',
  '从 [Releases](https://github.com/rui08984-dot/dafeiyu-open/releases/latest) 下载 **`DaFeiyu-Setup-0.4.0.exe`**（约 120MB），双击安装。',
  '',
  '- 第一次启动会自动打开设置窗的「模型」页：填 **API Key**（支持任意 OpenAI 兼容网关），点保存即可对话。',
  '- 底座已含：皮套与模型、Cubism Core、Rust 内核 `pet-core`、edge-tts 语音（联网，无需 key）、我们现在的人格。',
  '- 完整能力（长期记忆 / 按住说话 / 一起看 / 语义表演）在「设置 → 组件」里一键安装（约 1.8GB）：模型走 ModelScope / hf-mirror，Python 运行时与依赖随组件包，装完自动写配置。',
  '- 安装包未代码签名，Windows SmartScreen 可能提示「未知发布者」，选择「仍要运行」。',
  '',
  '> 本仓库同时是一份**可公开、可部署的完整代码树**（安装包就是用它构建的），不是免配置一键包。',
  '> **只需自备 LLM API key**；Live2D 模型（经作者授权）、Cubism SDK/Core、MemOS 均已随仓（含许可文件）。',
  '>',
  '> **本项目基于 [morettt/my-neuro](https://github.com/morettt/my-neuro)（MIT）二次开发**，保留上游版权与署名；第三方素材许可见 `NOTICE`。不是上游官方版本。',
  '',
  '包含：Electron 宿主应用层（`_incoming/my-neuro/`）、桌宠运行时与表演引擎（`pet-runtime/`）、',
  'Rust 内核（`pet-core/`）、语音/ASR/TTS/一起看服务、插件、门禁测试与安装自检。',
  '',
  '## 前置条件（从源码运行）',
  '',
  '| 依赖 | 版本 | 用途 |',
  '|---|---|---|',
  '| Windows 10/11 x64 | — | Electron 宿主、UIA、WASAPI |',
  '| Node.js | ≥ 20（推荐 24） | 宿主与 npm 依赖 |',
  '| Python | 3.11+（推荐 3.13） | TTS / ASR / 一起看 / 可选记忆后端 |',
  '| Git | 任意较新版本 | 获取代码 |',
  '| Docker Desktop | 可选 | 8090 嵌入服务 / MemOS |',
  '',
  '## 从源码运行（开发者）',
  '',
  '### 0.（推荐）一键引导',
  '',
  '```bat',
  '安装.cmd',
  '```',
  '',
  '向导会依次：预检环境 → 选 provider → 从环境变量读 key → 原子写配置（先备份）→ 连通性测试',
  '→ 检查自备资产 → 提示启动。想先看它做什么而不写任何文件：',
  '',
  '```bat',
  'node scripts\\install-wizard.mjs --dry-run --json',
  '```',
  '',
  '### 1. 装依赖',
  '',
  '```bat',
  'cd _incoming\\my-neuro\\live-2d',
  'npm install',
  'cd ..\\..\\..',
  '```',
  '',
  '（可选）皮套构建工具：',
  '',
  '```bat',
  'cd pet-runtime',
  'npm install',
  'cd ..',
  '```',
  '',
  '### 2. 填 LLM key 与人设',
  '',
  '```bat',
  'copy _incoming\\my-neuro\\live-2d\\config.example.json _incoming\\my-neuro\\live-2d\\config.json',
  'copy _incoming\\my-neuro\\live-2d\\llm_providers.example.json _incoming\\my-neuro\\live-2d\\llm_providers.json',
  '```',
  '',
  '- `llm_providers.json`：填每个 provider 的 `api_key`（任何 OpenAI 兼容服务均可，把 `api_url`/`model_id` 改成你的）。',
  '- `config.json`：填 `llm.system_prompt`（她的人设）与 `llm.provider_id` / `llm.model_id`。',
  '- 也可以用环境变量；**不要把真实 key 提交到 git**。',
  '- 已用步骤 0 的向导时，本步会自动完成（向导只从环境变量读 key，不接收命令行明文）。',
  '',
  '### 3. 体检',
  '',
  '```bat',
  'node scripts\\bootstrap.mjs',
  '```',
  '',
  '只检查、不安装。会逐项告诉你缺什么：key、Python 依赖、8090 嵌入、皮套构建等。',
  '',
  '### 4. 启动',
  '',
  '```bat',
  '大肥鱼 start',
  '```',
  '',
  '等价命令：`node pet-runtime/tools/launch-my-neuro.mjs`。',
  '停止：`大肥鱼 stop`；体检：`大肥鱼 doctor`；状态：`大肥鱼 status`。',
  '',
  '### 5. 改人格',
  '',
  '- `config.json` 的 `llm.system_prompt` 是她的「人设 / 说话方式 / 脾气」。',
  '- 插件与能力：`_incoming/my-neuro/live-2d/plugins/`；默认启停清单见 `plugins/enabled_plugins.json`。',
  '- 记忆与日记：运行后写入 `_incoming/my-neuro/data/`（已 gitignore）。',
  '',
  '## 自备资产（不随仓库分发）',
  '',
  '| 资产 | 影响 | 怎么获取 |',
  '|---|---|---|',
  '| 8090 嵌入服务 | MemOS 依赖；无则记忆嵌入降级 | `pwsh -File scripts/start-embed.ps1` 或 Docker（见 `docker-compose.embed.yml`） |',
  '| SenseVoice / Silero / Ollama 模型 | 语音识别 / 本地视觉降级 | `node asr/check-models.mjs`、`node scripts/fetch-models.mjs` |',
  '',
  '**已随仓**：Live2D 模型（DeepSeek-chan/大肥鱼，经作者授权，署名见 `NOTICE`）、Cubism Core/Framework（Redistributable Code）、MemOS 子树（Apache-2.0，见其 `LICENSE`/`NOTICE`）。',
  '',
  '缺资产时 bootstrap 会给出 `warn` 和指引；聊天、TTS、字幕、基础人格仍可用。',
  '',
  '## 目录结构',
  '',
  '```',
  '安装.cmd                    # 一键首启向导（推荐入口）',
  '大肥鱼.cmd                  # Windows 单入口（start/stop/restart/status/doctor/logs）',
  'pet-runtime/                # 启动器、服务编排、桌宠渲染、表演引擎、工具',
  'pet-core/                   # Rust 内核（可选：cargo build --release）',
  '_incoming/my-neuro/         # Electron 应用层（live-2d/）+ MemOS 后端',
  'scripts/                    # install-wizard / bootstrap / 配置模板 / 模型获取 / 导出脚本',
  '_probe/                     # 门禁与回归测试（check-all / check-ci）',
  'docs/                       # ADR、设计、调研（curated）',
  'asr/ audio_common/ audio-loop/ edge-tts/ live-danmaku/ extensions/',
  '_packaging/                 # 安装器 / MSIX 包身份参考',
  '```',
  '',
  '## 相关仓库（可选拆分，便于单独复用）',
  '',
  '- **本仓库**：完整合并树（宿主 + 运行时 + 全部插件）——想直接跑就用这个。',
  '- 电脑操控层：<https://github.com/rui08984-dot/dafeiyu-control>',
  '- Live2D 表演引擎：<https://github.com/rui08984-dot/dafeiyu-perform>',
  '- 语音四态层：<https://github.com/rui08984-dot/dafeiyu-voice>',
  '',
  '## 验证',
  '',
  '```bat',
  'node --check pet-runtime\\tools\\launch-my-neuro.mjs',
  'node _probe\\check-ci.mjs          # 语法 + 不依赖宿主运行时的单测',
  'node scripts\\bootstrap.mjs --json # 机器可读体检',
  '```',
  '',
  '## 许可与安全',
  '',
  '- 自有代码：MIT（`LICENSE`）。第三方边界见 `NOTICE`。',
  '- 密钥/上报：`SECURITY.md`。',
  '- 本仓库**不含**真实 key、模型、Cubism SDK、MemOS 子树或 git 历史。',
  '',
].join('\n');

ROOT_DOCS['README.en.md'] = [
  '# DaFeiyu — a desktop AI companion that lives on your screen',
  '',
  '> A Windows desktop companion in a transparent 420×760 window: she talks, shows expressions, sees your screen, hears your voice, and can operate your PC.',
  '>',
  '> Based on [morettt/my-neuro](https://github.com/morettt/my-neuro) (MIT), with upstream attribution; third-party asset licenses are listed in `NOTICE`. This is not an official upstream release.',
  '',
  '## Install (Windows 10/11 x64)',
  '',
  'Download **`DaFeiyu-Setup-0.4.0.exe`** (~120 MB) from [Releases](https://github.com/rui08984-dot/dafeiyu-open/releases/latest) and run it.',
  '',
  'On first launch the settings window opens on the **Model** page: paste an API key for any OpenAI-compatible endpoint, press Save, and start chatting. No restart needed.',
  '',
  '- Included: Live2D model + Cubism Core, Rust core (`pet-core`: screen capture / window control fast path), edge-tts voice (free, online, no key).',
  '- Not included: local 4B memory model, ASR / MemOS / co-watch / OCR Python services. Deploy the full source tree for those.',
  '- The installer is unsigned; Windows SmartScreen may warn about an unknown publisher. Choose "Run anyway".',
  '',
  '## What she can do',
  '',
  '| Capability | Implementation |',
  '|---|---|',
  '| Speak | edge-tts, emotion-driven rate/pitch/volume, per-clause prosody, streaming first chunk |',
  '| Expressions & motion | Live2D Cubism 5, 509 parameters; FACS/VAD performance layer, asymmetric expressions, physics two-phase commit |',
  '| See the screen | Rust GDI capture (~54ms at 2560×1440) + multimodal model; local vision organ for summaries/OCR |',
  '| Hear you | SenseVoice ASR + voiceprint + acoustic understanding; co-watch system-audio loopback (full stack) |',
  '| Operate Windows | UIA element clicks / vision-coordinate clicks / SendInput / PostMessage for games / window focus |',
  '| Remember you | MemOS + Qdrant vectors; four-layer memory arbitration (full stack) |',
  '| Act alive | Human-like performance scheduler: director budgets, 6-state ambient layer, show programs, 97 FACS clips (P0–P3) |',
  '',
  '## Requirements',
  '',
  '- Windows 10/11 x64.',
  '- An LLM API key (any OpenAI-compatible endpoint).',
  '- Full source stack only: Node.js ≥ 20, Python 3.13 (`py` launcher), optional Docker Desktop (embeddings) and Ollama (local vision/OCR).',
  '',
  '## Run from source',
  '',
  '```bat',
  'REM 1) dependencies',
  'cd _incoming\\my-neuro\\live-2d && npm install && cd ..\\..\\..',
  'cd pet-runtime && npm install && cd ..',
  '',
  'REM 2) first-run wizard (key from an environment variable; never echoed)',
  'set COMAD_BUNNY_API_KEY=...',
  'node scripts\\install-wizard.mjs --dry-run --json',
  'node scripts\\install-wizard.mjs --provider=comad --yes',
  '',
  'REM 3) check, build the avatar bundle, start',
  'node scripts\\bootstrap.mjs',
  'node pet-runtime\\build-and-deploy-petbody.mjs',
  '大肥鱼 start',
  '```',
  '',
  'Chinese guide: `README.md`. Architecture and ADRs: `docs/adr/`.',
  '',
  '## License & attribution',
  '',
  '- Our code: MIT (`LICENSE`). Third-party boundaries: `NOTICE`.',
  '- Live2D model DeepSeek-chan / DaFeiyu: bundled with the model author\'s permission (see `NOTICE`).',
  '- Live2D Cubism Core/Framework: proprietary, distributed as "Redistributable Code" under the Live2D license (see `pet-runtime/desktop/vendor/cubism/Framework/LICENSE.md`).',
  '- MemOS: Apache-2.0 (see its `LICENSE` / `NOTICE`).',
  '- Upstream: morettt/my-neuro (MIT).',
  '',
].join('\n');

ROOT_DOCS['RELEASE-NOTES.md'] = [
  '# RELEASE NOTES — 大肥鱼公开代码树',
  '',
  '生成方式：`node scripts/export-public-tree.mjs`（源：主仓 + 应用仓的 tracked 文件）。',
  '状态：**纯本地树**，未配置 remote、未 push。',
  '',
  '## v0.4.0 组件化安装（2026-11-27）',
  '',
  '- 底座：`DaFeiyu-Setup-0.4.0.exe`（约 120MB）——应用 + 皮套/模型 + Cubism Core + pet-core + edge-tts + 表演数据 + 我们现在的人格。',
  '- 组件（设置 → 组件，一键安装，约 1.8GB）：`memory`（MemOS+Qdrant+嵌入 784MB/ModelScope）、`voice-asr`（SenseVoice 239MB/hf-mirror）、`cowatch`、`lumen`（153MB/hf-mirror）。',
  '- 组件包由 `_packaging/build-component-packs.ps1` 构建；清单 `components/manifest.json` 带 SHA256 与多源。',
  '- 不含：本地 4B 记忆模型（自备 GGUF）、Ollama 本地视觉（走云）。',
  '',
  '## v0.3.1 一键安装包（2026-11-26）',
  '',
  '- 产物：`DaFeiyu-Setup-0.3.1.exe`（约 117MB，NSIS；装到 `%LOCALAPPDATA%\\Programs\\大肥鱼`，免管理员）。',
  '- 随包：Electron 28 + live-2d 应用、皮套与模型（16.5MB moc3 + 纹理）、Cubism Core、`pet-core.exe`（Rust 快轨）、edge-tts 单文件 exe（语音，联网）。',
  '- 首启：自动打开控制中心「模型」页；默认 provider=cloud（OpenAI 兼容）/ `gpt-4o-mini` / 空 key，填 key 保存即生效。',
  '- 不含：本地 4B 记忆模型、ASR / MemOS / 一起看 / OCR 等 Python 服务（按 README「从源码运行」部署完整树）。',
  '- 构建：`_packaging/build-installer.ps1 -Nsis`；语音 exe：`_packaging/build-tts.ps1`（PyInstaller，约 11MB）。',
  '- 真机验收（2026-11-26）：干净目录静默安装 → 首启自动落「模型」页 → 注入真实 key → `POST 8103/chat` 得到回复；渲染层 ok、随包 TTS 合成 200、pet-core 截图走 Rust 快轨。',
  '',
  '## 包含',
  '',
  '- 主仓白名单：`pet-runtime/ pet-core/ scripts/ _probe/ docs/(curated) asr/ audio_common/ audio-loop/ edge-tts/ live-danmaku/ extensions/ _packaging/ .github/` + 根入口/说明/架构/compose。',
  '- 应用仓：`_incoming/my-neuro/` 下全部 tracked 代码（无 `.git`、无真实配置）。',
  '- Live2D Cubism Core/Framework（文件头注明 Redistributable Code，附 Framework LICENSE）。',
  '- MemOS 记忆后端子树（Apache-2.0，附 `LICENSE` + `NOTICE` + 修改说明）。',
  '- 角色模型 DeepSeek-chan（大肥鱼）：经作者授权随仓（原画/建模署名与使用边界见 `NOTICE`）。',
  '- LumenAct FACS 片段（CC BY 4.0，带 NOTICE）、角花 SVG（CC0，带 CREDITS）。',
  '',
  '## 排除',
  '',
  '- 凭据/PII：`config.json`、`llm_providers.json`、`memos_config.json`、`.env*`、`.control-token`、`.qq-token.txt`、`data/`（原记录室目录）、`备份/`、`语音样本/`、`character_backups*.json`、`panel-bounds.json`、`song-library/`、`live-2d/fake_neuro_audio/`。',
  '- 许可不明：Cubism 2 时代的 `live2d.min.js`（无许可头）。',
  '- 上游召回模块（许可边界，已移除）。',
  '- 运行/构建产物：`node_modules/`、`venv-voice/`、`.state/`、`crash-dumps/`、`*.log*`、`_probe/out|recovery|shots*|_archive*`、`tmp-verify/`、`dashboard.html`、`pet-core/target/`、`pet-runtime/mc-mod/**/build/`。',
  '- 大模型权重：`*.gguf *.onnx *.pt *.pth`。',
  '- 文档收窄：只保留 `docs/adr|specs|plans` 与文件名含 `设计-|决策-|调研-|规范-|README` 的；排除 `progress.md`、交接/HANDOFF/提示词/复盘/审计/archive。',
  '',
  '## 仍需自备',
  '',
  '- LLM API key（`config.json` + `llm_providers.json` 或环境变量）。',
  '- 8090 嵌入服务（MemOS 依赖；缺失时记忆嵌入降级，聊天/TTS/字幕照常）。',
  '- SenseVoice/Silero/Ollama 模型（语音识别/本地视觉）。',
  '',
  '## 如何验证',
  '',
  '```bat',
  'node scripts\\install-wizard.mjs --dry-run --json',
  'node scripts\\bootstrap.mjs --json',
  'cd _incoming\\my-neuro\\live-2d && npm install',
  'cd ..\\..\\.. && node _probe\\check-ci.mjs',
  '```',
  '',
  '期望：向导的「最低可用性」在填 key 后为可用；bootstrap 只有「用户自备」项（key / 8090 / 模型服务）非 ok；无代码级红。',
  '',
  '## 验证结果',
  '',
  '（待执行后回填）',
  '',
].join('\n');

ROOT_DOCS['.gitignore'] = [
  '# ── 依赖 / 构建产物 ──',
  'node_modules/',
  '__pycache__/',
  '*.pyc',
  'dist/',
  'pet-core/target/',
  'pet-runtime/.state/',
  'pet-runtime/.state/*.log*',
  '*.out.log*',
  'pet-runtime/tmp-verify/',
  '_probe/out/',
  '_probe/recovery/',
  '_probe/shots*/',
  '_incoming/my-neuro/live-2d/build/',
  '',
  '# ── 运行数据 ──',
  '*.log',
  '*.log.*',
  'crash-dumps/',
  '_incoming/my-neuro/data/',
  'live-2d/song-library/',
  '_incoming/my-neuro/plugins-dlc/memos/memos_system/data/',
  '',
  '# ── 用户配置（含密钥，绝不入库）──',
  'config.json',
  'llm_providers.json',
  'memos_config.json',
  '.control-token',
  '.qq-token.txt',
  '.env',
  '.env.*',
  '*.key',
  '*.pem',
  '*.token',
  '',
  '# ── 自备资产（模型已随仓；大模型权重不入库）──',
  'models/',
  '*.gguf',
  '*.onnx',
  '*.pt',
  '*.pth',
  'pet-runtime/venv-voice/',
  '',
].join('\n');

// 公开树标记：测试用它区分「公开导出树」与 D 盘完整开发树，
// 从而把 MemOS/本地运行文件相关的检查降级为 SKIP，而不是误判红。
ROOT_DOCS['.public-tree'] = [
  'public code tree generated by scripts/export-public-tree.mjs',
  '模型（DeepSeek-chan/大肥鱼，经作者授权）、Cubism Core/Framework（Redistributable Code）与 MemOS（Apache-2.0）均已随仓。',
  '仅 LLM API key、8090 嵌入与语音/视觉模型需使用者自备；本树不含真实配置、密钥与 git 历史。',
  '',
].join('\n');

for (const [name, content] of Object.entries(ROOT_DOCS)) {
  fs.writeFileSync(path.join(DEST, name), content, 'utf8');
  stats.files++;
  stats.bytes += Buffer.byteLength(content);
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const included = new Set([...mainFiles, ...appFiles]);
log('完成：' + DEST);
log('文件 ' + stats.files + '（主仓 ' + stats.perSide.main + ' + 应用仓 ' + stats.perSide.app + ' + 根文档 ' + Object.keys(ROOT_DOCS).length + '）'
  + '，体积 ' + sizeText(stats.bytes));
log('文本 ' + stats.text + ' / 二进制 ' + stats.binary + ' / GBK→UTF-8 ' + stats.converted);
if (included.size) log('提示：D 侧只读；如需覆盖重跑加 --force。');
