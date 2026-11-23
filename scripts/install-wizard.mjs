#!/usr/bin/env node
/**
 * install-wizard.mjs —— 首启向导（一期，2026-11-23）
 *
 * 目标：外部用户拿到代码树后，**填一个 LLM API key 就能用**；其余能力按需装。
 * 设计：docs/安装-首启向导-2026-11-23.md；方案：docs/plans/2026-11-23-安装器与首启向导-plan.md
 *
 * 原则：
 *   · 只服务新装/首次配置；不改 launcher、不改注册表、不杀进程。
 *   · key 只从**环境变量**读（`--key-env=NAME`），绝不接受命令行明文；日志一律打码。
 *   · 写配置前先备份，原子写（tmp + rename）；Ctrl+C 不会留下半份配置。
 *   · 判据复用 `scripts/bootstrap.mjs --json`，不另写一套。
 *   · 没有本地模型/Docker/MemOS/moc3 时**明确降级**，不静默失败。
 *
 * 用法：
 *   node scripts/install-wizard.mjs --help
 *   node scripts/install-wizard.mjs --dry-run --json
 *   COMAD_BUNNY_API_KEY=... node scripts/install-wizard.mjs --provider=comad --yes
 *   OPENAI_API_KEY=... node scripts/install-wizard.mjs --provider=openai --base-url=https://api.openai.com/v1 --model=gpt-4o-mini
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT_DEFAULT = path.resolve(path.dirname(SELF), '..');

// ── 参数 ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const HELP = ARGS.help || ARGS.h;
const JSON_OUT = !!ARGS.json;
const DRY = !!ARGS['dry-run'];
const YES = !!ARGS.yes || !process.stdin.isTTY;
const NO_DOWNLOAD = ARGS['no-download'] === undefined ? true : !!ARGS['no-download'];
const SKIP_CHAT = !!ARGS['skip-chat'];
const INSTALL_NPM = !!ARGS['install-npm'];

const PROVIDERS = {
  comad: {
    label: 'Comad 云端（OpenAI 兼容）',
    id: 'comad',
    name: 'Comad 云端',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    keyEnv: ['COMAD_BUNNY_API_KEY', 'COMAD_API_KEY'],
    needsKey: true,
  },
  openai: {
    label: 'OpenAI / 任意 OpenAI 兼容网关',
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyEnv: ['OPENAI_API_KEY'],
    needsKey: true,
  },
  ollama: {
    label: '本地 Ollama（免费、离线）',
    id: 'ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3-vl:8b-instruct',
    keyEnv: [],
    needsKey: false,
  },
};

// ── 输出 ────────────────────────────────────────────────────────────────
const STEPS = [];
function log(line = '') { if (!JSON_OUT) console.log(line); else console.error(line); }
function step(id, title, status, detail = '', extra = {}) {
  STEPS.push({ id, title, status, detail, ...extra });
  const mark = { ok: '✓', warn: '!', fail: '✗', skip: '–' }[status] || '?';
  log(`  ${mark} ${title}${detail ? ' — ' + detail : ''}`);
}
function maskKey() { return '<from env>'; }
function redact(text) { return String(text || '').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***'); }

if (HELP) {
  console.log(`大肥鱼 · 首启向导（一期）

用法：
  node scripts/install-wizard.mjs [options]

选项：
  --dry-run            只检查/连通性测试，不写任何文件
  --json               机器可读输出（stdout 只输出 JSON）
  --yes                非交互（无 TTY 时自动）
  --target=<dir>       项目根目录（默认=本脚本上级）
  --provider=<id>      comad | openai | ollama
  --base-url=<url>     覆盖 provider 的 API 地址
  --model=<id>         覆盖模型 id
  --key-env=<NAME>     从哪个环境变量读 key（默认按 provider）
  --skip-chat          只测 GET /models，不发最小 chat
  --install-npm        缺依赖时真的执行 npm install（默认只打印命令）
  --no-download        不下载模型（默认；模型永远不在向导里静默下载）
  --help               本帮助

示例：
  COMAD_BUNNY_API_KEY=... node scripts/install-wizard.mjs --provider=comad --yes
  OPENAI_API_KEY=... node scripts/install-wizard.mjs --dry-run --json
`);
  process.exit(0);
}

const TARGET = path.resolve(ARGS.target || ROOT_DEFAULT);
const APP = path.join(TARGET, '_incoming', 'my-neuro', 'live-2d');
const CFG = path.join(APP, 'config.json');
const PROV = path.join(APP, 'llm_providers.json');

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}
function backupIfExists(file) {
  if (!fs.existsSync(file)) return '';
  const bak = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, bak);
  return bak;
}
function envKey(provider) {
  const names = ARGS['key-env'] ? [String(ARGS['key-env'])] : provider.keyEnv;
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return { name: n, value: String(v).trim() };
  }
  return { name: names[0] || '', value: '' };
}

async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 200); }
    return { ok: res.ok, status: res.status, body };
  } finally { clearTimeout(timer); }
}

// ── 步骤 1：环境预检（复用 bootstrap --json） ─────────────────────────────
function runBootstrap() {
  const script = path.join(TARGET, 'scripts', 'bootstrap.mjs');
  if (!fs.existsSync(script)) {
    step('preflight', '环境预检', 'fail', '找不到 scripts/bootstrap.mjs（目录不对？）');
    return null;
  }
  const r = spawnSync(process.execPath, [script, '--json'], {
    cwd: TARGET, encoding: 'utf8', timeout: 180000, windowsHide: true,
    env: { ...process.env, PET_BOOTSTRAP_CHILD: '1' },
  });
  let doc = null;
  try { doc = JSON.parse(String(r.stdout || '').trim()); } catch (e) {
    const m = String(r.stdout || '').match(/\{[\s\S]*\}/);
    if (m) { try { doc = JSON.parse(m[0]); } catch (e2) { /* ignore */ } }
  }
  if (!doc) {
    step('preflight', '环境预检', 'warn', 'bootstrap 输出无法解析（退出码 ' + r.status + '）');
    return null;
  }
  const s = doc.summary || {};
  const miss = (s.requiredMissing || []).slice(0, 6).join(', ');
  step('preflight', '环境预检', (s.requiredMissing && s.requiredMissing.length) ? 'warn' : 'ok',
    `bootstrap ${s.ok || 0}/${s.total || 0} ok` + (miss ? `；缺必需：${miss}` : ''));
  return doc;
}

// ── 步骤 2：目标目录 ────────────────────────────────────────────────────
function checkTarget() {
  if (!fs.existsSync(path.join(APP, 'main.js'))) {
    step('target', '目标目录', 'fail', `不是有效的项目根：${TARGET}（缺 _incoming/my-neuro/live-2d/main.js）`);
    return false;
  }
  if (/[\u4e00-\u9fa5]/.test(TARGET) || /\s/.test(TARGET)) {
    step('target', '目标目录', 'warn', '路径含中文/空格，个别 Python/Electron 子进程可能出问题；建议换纯英文路径');
  } else {
    step('target', '目标目录', 'ok', TARGET);
  }
  try { fs.accessSync(TARGET, fs.constants.W_OK); } catch (e) {
    step('target', '目标目录', 'fail', '目录不可写');
    return false;
  }
  return true;
}

// ── 步骤 3：依赖 ────────────────────────────────────────────────────────
function checkDeps(boot) {
  const checks = (boot && boot.checks) || [];
  const by = (id) => checks.find((c) => c.id === id);
  const npm = by('app.npm');
  const pyCore = by('py.core');
  const pyTts = by('py.tts');
  const missing = [];
  if (npm && npm.status !== 'ok') missing.push('Node 依赖（live-2d/node_modules）');
  if (pyCore && pyCore.status !== 'ok') missing.push('Python 核心包（numpy 等）');
  if (pyTts && pyTts.status !== 'ok') missing.push('Python TTS 包（aiohttp/edge-tts）');
  if (!missing.length) { step('deps', '依赖', 'ok', 'Node 与 Python 依赖已就绪'); return; }
  const cmds = [
    `cd "${APP}" && npm install`,
    `pip install -r "${path.join(TARGET, 'pet-runtime', 'requirements-voice.txt')}"`,
  ];
  if (INSTALL_NPM && !DRY) {
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: APP, stdio: 'inherit', shell: true, windowsHide: true });
    step('deps', '依赖', r.status === 0 ? 'ok' : 'fail', r.status === 0 ? 'npm install 完成' : 'npm install 失败，请手动执行');
  } else {
    step('deps', '依赖', 'warn', '缺：' + missing.join('；') + '（自行执行：' + cmds[0] + '）');
  }
}

// ── 步骤 4：provider 与 key ─────────────────────────────────────────────
function resolveProvider() {
  let id = String(ARGS.provider || '').toLowerCase();
  if (!id) {
    if (YES) id = 'comad';
    else {
      log('  选择 LLM provider：1) comad  2) openai  3) ollama');
      const ans = String(readLine('  输入 1/2/3（默认 1）：') || '1').trim();
      id = ans === '2' ? 'openai' : (ans === '3' ? 'ollama' : 'comad');
    }
  }
  if (!PROVIDERS[id]) {
    step('provider', 'LLM provider', 'fail', `未知 provider：${id}（可选 comad|openai|ollama）`);
    return null;
  }
  const p = { ...PROVIDERS[id] };
  if (ARGS['base-url']) p.baseUrl = String(ARGS['base-url']);
  if (ARGS.model) p.model = String(ARGS.model);
  const key = envKey(p);
  if (p.needsKey && !key.value) {
    step('provider', 'LLM provider', 'fail',
      `缺 API key：请先设置环境变量 ${key.name}（不接收命令行明文；本次不会写任何配置）`);
    return { provider: p, keyName: key.name, keyValue: '', missingKey: true };
  }
  step('provider', 'LLM provider', p.needsKey ? 'ok' : 'ok',
    `${p.label} · ${p.baseUrl} · 模型 ${p.model}` + (p.needsKey ? ` · key 来自 ${key.name}（${maskKey()}）` : ' · 无需 key'));
  return { provider: p, keyName: key.name, keyValue: key.value, missingKey: false };
}

function readLine(prompt) {
  // 同步读一行（仅交互模式用；无 TTY 时不会走到这里）
  const fs2 = fs;
  try {
    fs2.writeSync(1, prompt);
    const buf = Buffer.alloc(256);
    let n = 0;
    try { n = fs2.readSync(0, buf, 0, 256, null); } catch (e) { n = 0; }
    return n > 0 ? buf.toString('utf8', 0, n).replace(/[\r\n]+$/, '') : '';
  } catch (e) { return ''; }
}

// ── 步骤 5：写配置（原子写 + 备份） ─────────────────────────────────────
function writeConfigs(pick) {
  const p = pick.provider;
  if (DRY) { step('config', '写配置', 'skip', '--dry-run：不写任何文件'); return true; }
  const now = new Date().toISOString();
  let changed = [];

  // 5a. config.json
  const example = path.join(APP, 'config.example.json');
  let cfg = readJson(CFG, null);
  if (!cfg) {
    const ex = readJson(example, null);
    if (!ex) { step('config', '写配置', 'fail', '缺 config.example.json，无法生成 config.json'); return false; }
    cfg = ex;
    if (cfg.llm && typeof cfg.llm.system_prompt === 'string' && /填你的人设|<\s*你/.test(cfg.llm.system_prompt)) {
      cfg.llm.system_prompt = '你是大肥鱼，一个住在桌面上的数字伙伴：说话自然、简短、有自己的脾气。可以在控制中心或这里修改你的人设。';
    }
    if (cfg.dispatch) {
      cfg.dispatch.workspaces = { default: TARGET };
      cfg.dispatch.defaultWorkspace = 'default';
    }
    if (Array.isArray(cfg.browser_ext_ids)) cfg.browser_ext_ids = [];
    if (cfg.privacy && cfg.privacy.acked_at) delete cfg.privacy.acked_at;
    cfg._wizard = { at: now, by: 'install-wizard' };
    backupIfExists(CFG);
    atomicWrite(CFG, JSON.stringify(cfg, null, 2) + '\n');
    changed.push('config.json（从示例生成）');
  } else {
    cfg.llm = cfg.llm || {};
    if (cfg.llm.provider_id !== p.id || cfg.llm.model_id !== p.model) {
      cfg.llm.provider_id = p.id;
      cfg.llm.model_id = p.model;
      backupIfExists(CFG);
      atomicWrite(CFG, JSON.stringify(cfg, null, 2) + '\n');
      changed.push('config.json（更新 provider/model）');
    }
  }

  // 5b. llm_providers.json
  let doc = readJson(PROV, null);
  if (!doc || !Array.isArray(doc.providers)) doc = { providers: [] };
  let item = doc.providers.find((x) => x && x.id === p.id);
  if (!item) {
    item = { id: p.id, name: p.name, api_key: '', api_url: p.baseUrl, enabled: true, models: [] };
    doc.providers.push(item);
  }
  const before = JSON.stringify(item);
  item.api_url = p.baseUrl;
  item.enabled = true;
  if (pick.keyValue) item.api_key = pick.keyValue;   // 只写本地文件，不回显
  else if (p.id === 'ollama') item.api_key = item.api_key || 'ollama';
  if (!Array.isArray(item.models)) item.models = [];
  if (!item.models.some((m) => m && m.model_id === p.model)) {
    item.models.push({ model_id: p.model, name: p.model, enabled: true });
  }
  if (JSON.stringify(item) !== before) {
    backupIfExists(PROV);
    atomicWrite(PROV, JSON.stringify(doc, null, 2) + '\n');
    changed.push('llm_providers.json（' + p.id + '）');
  }
  step('config', '写配置', 'ok', changed.join('；') || '配置已是最新（无需改动）');
  return true;
}

// ── 步骤 6：连通性 ──────────────────────────────────────────────────────
async function checkConnectivity(pick) {
  const p = pick.provider;
  if (pick.missingKey && p.needsKey) { step('connect', '连通性', 'skip', '缺 key，跳过'); return; }
  const headers = {};
  if (pick.keyValue) headers.Authorization = 'Bearer ' + pick.keyValue;
  try {
    const r = await fetchJson(p.baseUrl.replace(/\/+$/, '') + '/models', { headers }, 8000);
    if (r.status === 401 || r.status === 403) { step('connect', '连通性', 'fail', `鉴权失败（${r.status}）：key 无效或无权限`); return; }
    if (r.status === 402) { step('connect', '连通性', 'fail', '额度/余额不足（402）'); return; }
    if (!r.ok) { step('connect', '连通性', 'warn', `GET /models 返回 ${r.status}（部分网关不实现该端点，继续测 chat）`); }
    else step('connect', '连通性', 'ok', `GET /models ${r.status}`);
    if (SKIP_CHAT) return;
    const body = {
      model: p.model,
      messages: [{ role: 'user', content: '回复 ok' }],
      max_tokens: 8,
      stream: false,
    };
    const c = await fetchJson(p.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 20000);
    if (c.status === 401 || c.status === 403) { step('chat', '最小对话', 'fail', `鉴权失败（${c.status}）`); return; }
    if (c.status === 402) { step('chat', '最小对话', 'fail', '额度/余额不足（402）'); return; }
    if (!c.ok) {
      const msg = typeof c.body === 'object' && c.body && c.body.error ? JSON.stringify(c.body.error).slice(0, 160) : String(c.body).slice(0, 160);
      step('chat', '最小对话', 'fail', `HTTP ${c.status}：${redact(msg)}`);
      return;
    }
    const txt = typeof c.body === 'object' && c.body && c.body.choices && c.body.choices[0]
      ? String((c.body.choices[0].message && c.body.choices[0].message.content) || '').slice(0, 40) : '';
    step('chat', '最小对话', 'ok', '模型已响应' + (txt ? '：' + redact(txt) : ''));
  } catch (e) {
    const m = String(e && (e.name === 'AbortError' ? '超时（8s/20s）' : e.message));
    step('connect', '连通性', 'fail', '请求失败：' + m);
  }
}

// ── 步骤 7：模型下载（默认跳过） ────────────────────────────────────────
function checkModels() {
  const cmds = [
    `node "${path.join(TARGET, 'scripts', 'fetch-models.mjs')}"`,
    `node "${path.join(TARGET, 'asr', 'check-models.mjs')}"`,
    `powershell -ExecutionPolicy Bypass -File "${path.join(TARGET, 'scripts', 'start-embed.ps1')}"`,
  ];
  if (NO_DOWNLOAD) {
    step('models', '模型', 'skip', '默认不下载（可选：Ollama 三模型 ≈9.5GB / ASR ≈241MB / 嵌入 gguf 640MB 自备）；命令见 --help 或 README');
    return;
  }
  step('models', '模型', 'warn', '请手动执行：' + cmds[0]);
}

// ── 步骤 8：自备资产 ────────────────────────────────────────────────────
function checkAssets() {
  const cands = {
    'Live2D 模型（moc3）': [
      path.join(APP, 'assets', 'petbody', 'pet.moc3'),
      path.join(TARGET, 'pet-runtime', 'desktop', 'assets', 'jellyfish', 'pet.moc3'),
    ],
    'Cubism Core（专有 SDK）': [
      path.join(APP, 'vendor', 'cubism', 'live2dcubismcore.min.js'),
      path.join(APP, 'libs', 'live2dcubismcore.min.js'),
    ],
    'MemOS 记忆子树': [
      path.join(APP, 'plugins-dlc', 'memos', 'memos_system'),
      path.join(TARGET, 'pet-runtime', 'memos_system'),
    ],
    'LumenAct 面部片段': [path.join(TARGET, 'pet-runtime', 'data', 'facs-clips', 'index.json')],
  };
  const missing = [];
  for (const [label, list] of Object.entries(cands)) {
    const found = list.some((p) => fs.existsSync(p));
    if (!found) missing.push(label);
  }
  if (!missing.length) step('assets', '自备资产', 'ok', 'moc3 / Cubism / MemOS / LumenAct 均在位');
  else step('assets', '自备资产', 'warn', '缺：' + missing.join('；') + '（按 README「自备资产」获取；缺 moc3 时仅文字/字幕可用，缺 MemOS 时长记忆降级）');
}

// ── 步骤 9：皮套构建 ────────────────────────────────────────────────────
function checkBuild() {
  const build = path.join(TARGET, 'pet-runtime', 'desktop', 'build');
  const deployed = path.join(APP, 'build');
  const ok = fs.existsSync(build) && fs.existsSync(deployed);
  if (ok) step('build', '皮套构建', 'ok', '构建产物已部署');
  else step('build', '皮套构建', 'warn', '未构建/未部署：`node pet-runtime/build-and-deploy-petbody.mjs`（需先装 esbuild）');
}

// ── 步骤 10：启动与健康 ─────────────────────────────────────────────────
async function checkHealth() {
  const urls = [
    ['控制口 8103', 'http://127.0.0.1:8103/health'],
    ['自检 8004', 'http://127.0.0.1:8004/health'],
  ];
  let up = 0;
  for (const [label, url] of urls) {
    try {
      const r = await fetchJson(url, {}, 2500);
      if (r.ok) { step('health-' + label, '健康 ' + label, 'ok', 'HTTP ' + r.status); up += 1; }
      else step('health-' + label, '健康 ' + label, 'warn', 'HTTP ' + r.status);
    } catch (e) {
      step('health-' + label, '健康 ' + label, 'skip', '未启动（起服务后再看）');
    }
  }
  step('start', '启动', up ? 'ok' : 'skip',
    up ? '服务已在跑' : '执行 `大肥鱼.cmd start`（或 node pet-runtime/tools/launch-my-neuro.mjs）后重跑本向导');
}

// ── 主流程 ──────────────────────────────────────────────────────────────
(async () => {
  log('');
  log('大肥鱼 · 首启向导' + (DRY ? '（dry-run：不写文件）' : ''));
  log('─'.repeat(52));

  const boot = runBootstrap();
  if (!checkTarget()) { finish(); return; }
  checkDeps(boot);

  const pick = resolveProvider();
  if (pick && pick.missingKey) { finish(); process.exitCode = 2; return; }

  if (pick) {
    const wrote = writeConfigs(pick);
    if (wrote) await checkConnectivity(pick);
  }
  checkModels();
  checkAssets();
  checkBuild();
  await checkHealth();
  finish();

  function finish() {
    const fails = STEPS.filter((s) => s.status === 'fail');
    const warns = STEPS.filter((s) => s.status === 'warn');
    log('─'.repeat(52));
    // 「最低可用性」单列一行：聊天 + TTS + 字幕 + 基础人格
    const keyOk = STEPS.find((s) => s.id === 'provider' && s.status === 'ok');
    const targetOk = STEPS.find((s) => s.id === 'target' && s.status !== 'fail');
    const chatOk = !!keyOk && !!targetOk;
    log(`最低可用性：${chatOk ? '聊天 + TTS + 字幕 + 基础人格（起服务后可用）' : '未满足（缺 key 或目录无效）'}`);
    log(`结果：${fails.length ? fails.length + ' 项失败' : '通过'} · ${warns.length} 项提示 · ${STEPS.filter((s) => s.status === 'skip').length} 项跳过`);
    if (JSON_OUT) {
      console.log(JSON.stringify({
        ok: fails.length === 0,
        dryRun: DRY,
        target: TARGET,
        provider: pick ? { id: pick.provider.id, baseUrl: pick.provider.baseUrl, model: pick.provider.model, keyEnv: pick.keyName, keySet: !!pick.keyValue } : null,
        steps: STEPS,
        minUsability: chatOk,
        next: ['大肥鱼.cmd start', 'node scripts/install-wizard.mjs --dry-run --json'],
      }, null, 2));
    }
    if (fails.length) process.exitCode = 1;
  }
})().catch((e) => {
  console.error('向导异常：' + redact(e && e.stack || e));
  process.exitCode = 1;
});

process.on('SIGINT', () => {
  console.error('\n已取消：配置写入是原子的，不会留下半份文件。');
  process.exit(130);
});
