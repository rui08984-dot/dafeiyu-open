#!/usr/bin/env node
// scripts/bootstrap.mjs —— 「clone 下来能不能跑」的自检（安装完整性）
//
// 为什么要有它（2026-11-14）：实际测过「把远端内容解到临时目录跑 check-all」，
// 4 项直接红 —— 因为主仓库的脚本硬编码依赖 `_incoming/my-neuro/live-2d`，
// 而她在**另一个仓库**里，README 之前也没说该 clone 到哪。
// 2026-11-23 安装完整性审计后扩展：配置模板 / Python 依赖 / ASR 模型 /
// Ollama 模型 / 8090 嵌入 / petbody build / LumenAct（可选）都纳入同一份报告。
//
// 设计纪律：
//   · 默认**只检查不安装**：不 npm install、不 pip install、不 ollama pull、不 docker start；
//   · 不写任何文件（Python 用 -B，禁 pycache；不建目录、不落日志）；
//   · --json 只输出一个 JSON（stdout 可直接 JSON.parse），供测试/CI 用；
//   · 每项都有 status：ok / missing（该项要补）/ warn（能跑但降级）/ skip（可选未装）。
//     退出码只看 required 项；可选能力缺失不会让 bootstrap 判红。
//
// 用法：
//   node scripts/bootstrap.mjs            # 人类可读
//   node scripts/bootstrap.mjs --json     # 机器可读
//   node scripts/bootstrap.mjs --verbose  # 连通过项也打印 fix/详情

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const asJson = process.argv.includes('--json');
const verbose = process.argv.includes('--verbose');

const checks = [];
/**
 * @param {object} c
 * @param {string} c.id
 * @param {string} c.name
 * @param {'ok'|'missing'|'warn'|'skip'} c.status
 * @param {boolean} c.required  false = 缺失只提示，不判红
 * @param {string} [c.detail]
 * @param {string} [c.fix]
 * @param {object} [c.meta]
 */
function add(c) {
  checks.push({
    id: c.id,
    name: c.name,
    status: c.status,
    required: Boolean(c.required),
    detail: c.detail || '',
    fix: c.fix || '',
    meta: c.meta || {},
  });
}

const exists = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
const MEMOS_PRESENT = (() => { try { return fs.statSync(MEMOS).isDirectory(); } catch (e) { return false; } })();
const PUBLIC_TREE = fs.existsSync(path.join(ROOT, '.public-tree'));
const PLACEHOLDER_RE = /<填你的密钥>|<你的人设提示词/;

// ── 1. 她的应用仓库（独立 git 仓库，必须摆在固定位置）─────────────────
{
  const pkg = path.join(APP, 'package.json');
  const main = path.join(APP, 'main.js');
  if (!exists(APP)) {
    add({
      id: 'app.repo', name: '应用仓库位置', status: 'missing', required: true,
      detail: '缺 `_incoming/my-neuro/live-2d`',
      fix: 'git clone https://github.com/rui08984-dot/dafeiyu-app.git _incoming/my-neuro',
    });
  } else if (!isFile(pkg) || !isFile(main)) {
    add({
      id: 'app.repo', name: '应用仓库位置', status: 'missing', required: true,
      detail: '目录在，但 package.json / main.js 不全（clone 不完整？）',
      fix: '重新 clone 到 _incoming/my-neuro，确认 live-2d/main.js 存在',
    });
  } else {
    add({ id: 'app.repo', name: '应用仓库位置', status: 'ok', required: true, detail: 'live-2d 就位' });
  }
}

// ── 2. 应用依赖（Electron 运行时）────────────────────────────────────
{
  const nm = path.join(APP, 'node_modules');
  const electronExe = path.join(nm, 'electron', 'dist', 'electron.exe');
  if (!exists(nm)) {
    add({
      id: 'app.npm', name: '应用 node_modules', status: 'missing', required: true,
      detail: '没装（Electron 跑不起来）',
      fix: 'cd _incoming/my-neuro/live-2d && npm install',
    });
  } else if (!isFile(electronExe)) {
    add({
      id: 'app.npm', name: '应用 node_modules', status: 'missing', required: true,
      detail: 'node_modules 在，但 electron 运行时缺失',
      fix: 'cd _incoming/my-neuro/live-2d && npm install',
    });
  } else {
    add({ id: 'app.npm', name: '应用 node_modules', status: 'ok', required: true, detail: 'electron 运行时就位' });
  }
}

// ── 3. 配置：模板 + 真配置（含密钥，不入库）──────────────────────────
const CFG = [
  {
    id: 'config', name: 'config.json', dir: APP, real: 'config.json', example: 'config.example.json',
    field: 'llm.system_prompt（她的人设）',
  },
  {
    id: 'providers', name: 'llm_providers.json', dir: APP, real: 'llm_providers.json', example: 'llm_providers.example.json',
    field: '每个 provider 的 api_key',
  },
  {
    id: 'memos.config', name: 'memos_config.json', dir: path.join(MEMOS, 'config'),
    real: 'memos_config.json', example: 'memos_config.example.json',
    field: 'llm.config.api_key（MemOS 后台总结/实体抽取用）',
  },
];
for (const c of CFG) {
  const real = path.join(c.dir, c.real);
  const example = path.join(c.dir, c.example);
  if (c.id === 'memos.config' && !MEMOS_PRESENT) {
    add({
      id: `${c.id}.example`, name: `${c.example}（可选）`, status: 'skip', required: false,
      detail: '缺少 memos_config 模板（本仓应含；缺失说明导出不完整）',
      fix: '取得 MemOS 官方代码后放到 _incoming/my-neuro/plugins-dlc/memos/',
    });
    add({
      id: c.id, name: `${c.real}（可选）`, status: 'skip', required: false,
      detail: '未安装 MemOS（长期记忆默认不可用，聊天/TTS 照常）',
      fix: '自备 MemOS 后 cp memos_config.example.json memos_config.json 并填 llm.config.api_key',
    });
    continue;
  }
  if (!isFile(example)) {
    add({
      id: `${c.id}.example`, name: `${c.example}`, status: 'missing', required: true,
      detail: '模板缺失（clone 的人不知道要填哪些字段）',
      fix: c.id === 'memos.config'
        ? '在仓库里补 config/memos_config.example.json（脱敏副本）'
        : 'node scripts/gen-config-example.mjs',
    });
  } else {
    add({ id: `${c.id}.example`, name: `${c.example}`, status: 'ok', required: true, detail: '模板就位' });
  }

  if (!isFile(real)) {
    add({
      id: c.id, name: c.real, status: 'missing', required: c.id === 'memos.config' ? false : true,
      detail: '不存在（脚本会读不到配置）',
      fix: `cp ${c.example} ${c.real}，然后填 ${c.field}`,
    });
    continue;
  }
  const text = readText(real);
  if (PLACEHOLDER_RE.test(text)) {
    add({
      id: c.id, name: c.real, status: 'missing', required: c.id === 'memos.config' ? false : true,
      detail: '还是模板内容，占位符没替换',
      fix: `把 ${c.field} 换成真的`,
    });
  } else {
    add({ id: c.id, name: c.real, status: 'ok', required: true, detail: '已配置' });
  }
}

// ── 4. Python 与各服务依赖 import ────────────────────────────────────
function resolvePython() {
  const candidates = [];
  if (process.env.PET_PYTHON) candidates.push(process.env.PET_PYTHON);
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'));
  if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Python313', 'python.exe'));
  candidates.push('py', 'python');
  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, ['-c', 'import sys;print(sys.version.split()[0])'], {
        encoding: 'utf8', windowsHide: true, timeout: 8000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      }).trim();
      if (out) return { cmd, version: out };
    } catch (e) { /* 下一个 */ }
  }
  return null;
}
const py = resolvePython();
if (!py) {
  add({
    id: 'python', name: 'Python', status: 'missing', required: true,
    detail: '跑不起来', fix: '装 Python 3.13；或用 PET_PYTHON 指定完整路径（PATH 里的 python 可能是商店占位符）',
  });
} else {
  add({ id: 'python', name: 'Python', status: 'ok', required: true, detail: py.version });
}

// 依赖分组：core=必需；optional=缺失只 warn/skip。
// 用 importlib.util.find_spec 而不是真正 import：快、无副作用、不写 pycache。
const PY_GROUPS = [
  { id: 'py.core', name: 'Python 依赖 · 核心', required: true, mods: ['numpy'] },
  { id: 'py.tts', name: 'Python 依赖 · TTS 9883', required: true, mods: ['aiohttp', 'edge_tts'] },
  {
    id: 'py.memos', name: 'Python 依赖 · MemOS 8003（可选）', required: MEMOS_PRESENT,
    mods: ['fastapi', 'uvicorn', 'pydantic', 'sklearn', 'qdrant_client', 'networkx', 'rank_bm25', 'bs4', 'pypdf', 'httpx', 'requests', 'aiohttp', 'PIL'],
  },
  { id: 'py.asr', name: 'Python 依赖 · ASR 1000', required: false, mods: ['aiohttp', 'sherpa_onnx', 'soundfile', 'scipy'] },
  { id: 'py.cowatch', name: 'Python 依赖 · 一起看 1001', required: false, mods: ['soundcard'] },
  { id: 'py.lumen', name: 'Python 依赖 · LumenAct 8120（可选）', required: false, mods: ['onnxruntime', 'transformers'] },
];
if (py) {
  const mods = [...new Set(PY_GROUPS.flatMap((g) => g.mods))];
  const code = [
    'import importlib.util as u, json',
    `mods = ${JSON.stringify(mods)}`,
    'print(json.dumps({m: bool(u.find_spec(m)) for m in mods}))',
  ].join('\n');
  let found = {};
  try {
    const out = execFileSync(py.cmd, ['-B', '-c', code], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    found = JSON.parse(String(out).trim().split(/\r?\n/).pop());
  } catch (e) {
    found = {};
  }
  for (const g of PY_GROUPS) {
    const missingMods = g.mods.filter((m) => !found[m]);
    if (!missingMods.length) {
      add({ id: g.id, name: g.name, status: 'ok', required: g.required, detail: `${g.mods.length} 个模块可用` });
      continue;
    }
    const reqFile = g.id === 'py.memos' ? '_incoming/my-neuro/plugins-dlc/memos/memos_system/requirements.txt'
      : g.id === 'py.tts' ? 'edge-tts/requirements.txt'
        : g.id === 'py.asr' ? 'asr/requirements.txt'
          : g.id === 'py.cowatch' ? 'audio-loop/requirements.txt'
            : g.id === 'py.lumen' ? null : null;
    add({
      id: g.id, name: g.name,
      status: g.required ? 'missing' : 'warn',
      required: g.required,
      detail: `缺 ${missingMods.join(', ')}`,
      fix: reqFile
        ? `py -m pip install -r ${reqFile}`
        : 'pip install onnxruntime transformers（可选能力，见 scripts/fetch-lumenact.md）',
      meta: { missing: missingMods },
    });
  }
}

// 声纹隔离环境（可选）：只查解释器是否存在，不 import（torch 很重）
{
  const vpPy = process.env.PET_VOICE_PYTHON || path.join(ROOT, 'pet-runtime', 'venv-voice', 'Scripts', 'python.exe');
  if (!isFile(vpPy)) {
    add({
      id: 'py.voice', name: '声纹环境 venv-voice（可选）', status: 'skip', required: false,
      detail: '未创建（只影响声纹 8020，其它服务照常）',
      fix: 'py -m venv pet-runtime/venv-voice && pet-runtime/venv-voice/Scripts/python.exe -m pip install -r pet-runtime/requirements-voice.txt',
    });
  } else {
    add({ id: 'py.voice', name: '声纹环境 venv-voice（可选）', status: 'ok', required: false, detail: '解释器就位' });
  }
}

// ── 5. 安装清单文件（requirements / example / compose / fetch 脚本）──
{
  const files = [
    'asr/requirements.txt',
    'edge-tts/requirements.txt',
    'audio-loop/requirements.txt',
    'audio_common/requirements.txt',
    'pet-runtime/requirements-voice.txt',
    ...(MEMOS_PRESENT ? ['_incoming/my-neuro/plugins-dlc/memos/memos_system/requirements.txt'] : []),
    'docker-compose.embed.yml',
    'scripts/start-embed.ps1',
    'scripts/fetch-models.mjs',
    'asr/check-models.mjs',
    'scripts/fetch-lumenact.md',
  ];
  const missing = files.filter((rel) => !isFile(path.join(ROOT, rel)));
  if (missing.length) {
    add({
      id: 'install.manifest', name: '安装清单文件', status: 'missing', required: false,
      detail: `缺 ${missing.length} 个：${missing.join(', ')}`,
      fix: '这些文件应当随仓库分发；缺了说明检出/同步不完整',
      meta: { missing },
    });
  } else {
    add({ id: 'install.manifest', name: '安装清单文件', status: 'ok', required: false, detail: `${files.length} 个就位` });
  }
}

// ── 6. ASR 模型文件 ──────────────────────────────────────────────────
{
  const dir = process.env.ASR_MODEL_DIR || path.join(os.homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models');
  const need = ['sensevoice-onnx/model.int8.onnx', 'sensevoice-onnx/tokens.txt', 'silero/silero_vad.onnx'];
  const missing = need.filter((rel) => !isFile(path.join(dir, rel)));
  if (missing.length) {
    add({
      id: 'asr.models', name: 'SenseVoice 模型（可选）', status: 'warn', required: false,
      detail: `缺 ${missing.length}/${need.length}（按住 V 会没反应）`,
      fix: 'node asr/check-models.mjs 会打印下载命令；或 py asr/asr_server.py --model-dir <dir>',
      meta: { dir, missing },
    });
  } else {
    add({ id: 'asr.models', name: 'SenseVoice 模型（可选）', status: 'ok', required: false, detail: '模型齐了' });
  }
}

// ── 7. Ollama 模型（本机 API，不联网、不 pull）───────────────────────
{
  const host = process.env.OLLAMA_HOST && !process.env.OLLAMA_HOST.includes('://')
    ? `http://${process.env.OLLAMA_HOST}` : (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
  const want = ['qwen3-vl:8b-instruct', 'glm-ocr:latest', 'paddleocr-vl:latest'];
  const norm = (n) => (String(n).includes(':') ? String(n) : `${n}:latest`);
  let names = null;
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    names = new Set((data.models || []).map((m) => norm(m.name || m.model)));
  } catch (e) {
    try {
      const out = execFileSync('ollama', ['list'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      names = new Set(String(out).split(/\r?\n/).slice(1).map((l) => l.trim().split(/\s+/)[0]).filter(Boolean).map(norm));
    } catch (e2) { names = null; }
  }
  if (!names) {
    add({
      id: 'ollama', name: 'Ollama 模型（可选）', status: 'skip', required: false,
      detail: 'Ollama 未运行（本地视觉/OCR 不可用，其余照常）',
      fix: '启动 Ollama，然后 node scripts/fetch-models.mjs',
    });
  } else {
    const missing = want.filter((w) => !names.has(norm(w)));
    if (missing.length) {
      add({
        id: 'ollama', name: 'Ollama 模型（可选）', status: 'warn', required: false,
        detail: `缺 ${missing.join(', ')}`,
        fix: 'node scripts/fetch-models.mjs（只影响本地视觉/OCR）',
        meta: { missing },
      });
    } else {
      add({ id: 'ollama', name: 'Ollama 模型（可选）', status: 'ok', required: false, detail: '三个模型齐全' });
    }
  }
}

// ── 8. 8090 嵌入服务（MemOS 的硬依赖）────────────────────────────────
{
  let healthy = false;
  let err = '';
  try {
    const res = await fetch('http://127.0.0.1:8090/health', { signal: AbortSignal.timeout(2000) });
    const text = await res.text();
    healthy = res.ok && /"status"\s*:\s*"ok"/.test(text);
    if (!healthy) err = `HTTP ${res.status}`;
  } catch (e) { err = e && e.message ? e.message : String(e); }
  if (healthy) {
    add({ id: 'embed', name: '嵌入服务 8090（可选）', status: 'ok', required: false, detail: 'health=ok' });
  } else {
    add({
      id: 'embed', name: '嵌入服务 8090（可选）', status: 'warn', required: false,
      detail: `连不上或未就绪（${err}）；没有它时 MemOS 记忆嵌入降级，聊天/TTS 不受影响`,
      fix: 'pwsh -File scripts/start-embed.ps1（模型放 ./models/Qwen3-Embedding-0.6B-Q8_0.gguf，见 docker-compose.embed.yml）',
    });
  }
}

// ── 8.5 自备资产（公开版仅模型需自备；Cubism/MemOS 已随仓）───────────
{
  const moc3 = [
    path.join(APP, 'assets', 'petbody', 'pet.moc3'),
    path.join(ROOT, 'pet-runtime', 'desktop', 'assets', 'jellyfish', 'pet.moc3'),
  ].find(isFile);
  const cubismCore = [
    path.join(APP, 'libs', 'live2dcubismcore.min.js'),
    path.join(ROOT, 'pet-runtime', 'desktop', 'vendor2', 'live2dcubismcore.min.js'),
  ].find(isFile);
  const missing = [];
  if (!moc3) missing.push('Live2D 模型（本仓应含；缺失说明导出不完整）');
  if (!cubismCore) missing.push('Live2D Cubism Core（本仓应含；缺失说明导出不完整）');
  if (!MEMOS_PRESENT) missing.push('MemOS 记忆后端（本仓应含；缺失说明导出不完整）');
  if (!missing.length) {
    add({ id: 'assets.selfsupply', name: '自备资产', status: 'ok', required: false, detail: '模型 / Cubism / MemOS 齐了' });
  } else {
    add({
      id: 'assets.selfsupply', name: '自备资产（模型需自备）', status: 'warn', required: false,
      detail: `缺：${missing.join('、')}（不影响聊天/TTS/字幕；皮套渲染降级）`,
      fix: '确认 _incoming/my-neuro/live-2d/assets/petbody/ 完整（.moc3 + 纹理 + model3.json + motions/expressions）',
      meta: { missing },
    });
  }
}

// ── 9. petbody build（皮套 bundle 必须先构建）─────────────────────────
{
  const pkgPath = path.join(ROOT, 'pet-runtime', 'package.json');
  let pkg = null;
  try { pkg = JSON.parse(readText(pkgPath)); } catch (e) { pkg = null; }
  const declared = Boolean(pkg && ((pkg.dependencies && pkg.dependencies.esbuild) || (pkg.devDependencies && pkg.devDependencies.esbuild)));
  let resolvable = false;
  try {
    const req = createRequire(pkgPath);
    req.resolve('esbuild');
    resolvable = true;
  } catch (e) { resolvable = false; }
  const entry = path.join(ROOT, 'pet-runtime', 'desktop', 'petbody-entry.mjs');
  const built = path.join(ROOT, 'pet-runtime', 'desktop', 'build', 'petbody.js');
  const deployed = path.join(APP, 'build', 'petbody.js');
  const problems = [];
  const cubismVendor = path.join(ROOT, 'pet-runtime', 'desktop', 'vendor', 'cubism');
  const sdkPresent = exists(cubismVendor);
  if (!declared) problems.push('package.json 未声明 esbuild');
  if (!resolvable) problems.push('esbuild 未安装');
  if (!isFile(entry)) problems.push('缺 desktop/petbody-entry.mjs');
  if (!isFile(built)) problems.push('未构建 desktop/build/petbody.js');
  if (!isFile(deployed)) problems.push('未部署到 live-2d/build/petbody.js');

  if (!problems.length) {
    add({ id: 'petbody', name: '皮套 bundle', status: 'ok', required: true, detail: '已构建并部署' });
  } else if (PUBLIC_TREE) {
    add({
      id: 'petbody', name: '皮套 bundle（待构建）', status: 'warn', required: false,
      detail: problems.join('；'),
      fix: 'cd pet-runtime && npm install && cd .. && node pet-runtime/build-and-deploy-petbody.mjs',
    });
  } else {
    add({
      id: 'petbody', name: '皮套 bundle', status: 'missing', required: true,
      detail: problems.join('；'),
      fix: 'cd pet-runtime && npm install && cd .. && node pet-runtime/build-and-deploy-petbody.mjs',
    });
  }
}

// ── 10. Rust 内核（可选：缺了降级 PowerShell，慢一个量级）─────────────
{
  const coreRelease = path.join(ROOT, 'pet-core', 'target', 'release', 'pet-core.exe');
  if (!isFile(coreRelease)) {
    add({
      id: 'pet-core', name: 'pet-core（可选）', status: 'skip', required: false,
      detail: '没编译（降级到 PowerShell 兜底，慢 20 倍左右）',
      fix: 'cd pet-core && cargo build --release',
    });
  } else {
    add({ id: 'pet-core', name: 'pet-core（可选）', status: 'ok', required: false, detail: 'release 就位' });
  }
}

// ── 11. LumenAct 语义模型（可选）─────────────────────────────────────
{
  const models = path.join(ROOT, '_research', 'lumenact', 'models');
  const cfg = path.join(ROOT, '_research', 'lumenact', 'assets', 'semantic-config.json');
  const need = [path.join(models, 'selector.onnx'), path.join(models, 'tokenizer.json'), cfg];
  const missing = need.filter((p) => !isFile(p));
  if (missing.length) {
    add({
      id: 'lumenact', name: 'LumenAct 语义模型（可选）', status: 'skip', required: false,
      detail: '未安装（8120 语义选择器不可用；按句选表情会走规则兜底）',
      fix: '见 scripts/fetch-lumenact.md（HF: AaBbcoder/LumenAct，约 146MB）',
      meta: { missing: missing.map((p) => path.relative(ROOT, p)) },
    });
  } else {
    add({ id: 'lumenact', name: 'LumenAct 语义模型（可选）', status: 'ok', required: false, detail: '模型齐了' });
  }
}

// ── 汇总与输出 ───────────────────────────────────────────────────────
const requiredMissing = checks.filter((c) => c.required && c.status !== 'ok');
const ok = requiredMissing.length === 0;
const summary = {
  total: checks.length,
  ok: checks.filter((c) => c.status === 'ok').length,
  missing: checks.filter((c) => c.status === 'missing').length,
  warn: checks.filter((c) => c.status === 'warn').length,
  skip: checks.filter((c) => c.status === 'skip').length,
  requiredMissing: requiredMissing.map((c) => c.id),
};

if (asJson) {
  console.log(JSON.stringify({
    schemaVersion: 1,
    ok,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    app: APP,
    summary,
    checks,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

const mark = { ok: '✓', missing: '✗', warn: '!', skip: '?' };
console.log('\n大肥鱼 · 安装自检（只检查，不安装）\n');
for (const c of checks) {
  if (!verbose && c.status === 'ok') {
    console.log(`  ✓ ${c.name}  —  ${c.detail}`);
    continue;
  }
  console.log(`  ${mark[c.status]} ${c.name}  —  ${c.detail}`);
  if (c.status !== 'ok' && c.fix) console.log(`      → ${c.fix}`);
}
console.log('');
if (ok) {
  console.log('必需项齐了。启动：node pet-runtime/tools/launch-my-neuro.mjs');
  console.log('体检：node pet-runtime/tools/doctor.mjs    门禁：node _probe/check-all.mjs --smoke');
} else {
  console.log(`${requiredMissing.length} 项必需项待补：${requiredMissing.map((c) => c.name).join('、')}`);
  console.log('补齐后重跑：node scripts/bootstrap.mjs');
}
process.exit(ok ? 0 : 1);
