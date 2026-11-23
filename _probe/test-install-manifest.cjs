#!/usr/bin/env node
/**
 * _probe/test-install-manifest.cjs —— 从零安装完整性（2026-11-23）
 *
 * 背景：发布审计发现「新人 clone 后按文档装不出完整成品」的几类缺口：
 *   · MemOS 的 memos_config.json 被 ignore 且没有 example → 没有 storage/embedding 结构；
 *   · Python 依赖只散落在文档里，没有 requirements；
 *   · pet-runtime 用 esbuild 构建皮套却只声明 ws；
 *   · 模型/资产获取没有脚本，只有口头说明。
 *
 * 这个测试把「安装面」钉住，防止以后再漂：
 *   ① services.json 里每个 start.script 真实存在（启动器不会指向空气）；
 *   ② 安装清单文件齐全：requirements / 配置模板 / compose / 获取脚本，
 *      JS 过 node --check、Python 过 py_compile（临时目录，不写仓库）；
 *      配置模板不泄漏真实密钥（逐值比对，只报字段路径，不打印值）；
 *   ③ bootstrap --json 结构可解析、字段完整、且运行前后仓库文件零变化（不写文件）；
 *   ④ 根 README / 应用 README 代码块里出现的 node/py/pwsh 路径都存在
 *      （只静态解析，不执行；生成物/虚拟环境/绝对路径跳过）。
 *
 * 用法：node _probe/test-install-manifest.cjs
 * 退出码：0 = PASS，1 = FAIL
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const MEMOS_CFG = path.join(MEMOS, 'config');
// 公开导出树（E 副本）不含 MemOS 子树与本地运行文件：相关清单项按「用户自备」跳过，不判红。
const PUBLIC_TREE = fs.existsSync(path.join(ROOT, '.public-tree')) || !fs.existsSync(MEMOS);

let pass = 0;
let fail = 0;
let skip = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
  fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  return false;
}
function logSkip(name, detail) {
  skip += 1;
  console.log('  ~ ' + name + (detail ? ' — ' + detail : ''));
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

// ── ① services.json 引用的脚本必须存在 ───────────────────────────────
console.log('[1/4] services.json：启动清单里的脚本必须存在');
{
  const p = path.join(ROOT, 'pet-runtime', 'tools', 'services.json');
  let manifest = null;
  try { manifest = JSON.parse(read(p)); } catch (e) { manifest = null; }
  ok('services.json 可解析', Boolean(manifest && Array.isArray(manifest.services)));
  if (manifest) {
    const services = manifest.services || [];
    ok('服务数量 > 0', services.length > 0, `${services.length} 个`);
    const idSet = new Set();
    let dup = '';
    for (const s of services) {
      if (s.id) {
        if (idSet.has(s.id)) dup = s.id;
        idSet.add(s.id);
      }
    }
    ok('服务 id 不重复', !dup, dup ? `重复：${dup}` : '');
    let bad = 0;
    for (const s of services) {
      if (!s.start || !s.start.script) continue;
      if (PUBLIC_TREE && s.id === 'memos') continue;   // MemOS 子树由用户自备
      // 约定：start.script 是**项目根相对**路径（restart-pet.ps1 也是 Join-Path $root script），
      // start.cwd 只决定工作目录，不参与路径拼接。
      const scriptPath = path.resolve(ROOT, s.start.script);
      const exists = isFile(scriptPath);
      if (!exists) { bad += 1; console.error(`      · ${s.id} → ${rel(scriptPath)} 不存在`); }
    }
    ok('所有 start.script 存在', bad === 0, `${services.filter((s) => s.start && s.start.script).length} 个脚本`);
    // venvPython 是可选环境：存在才检查，不存在不算失败（bootstrap 会提示）
    const vp = services.find((s) => s.start && s.start.venvPython);
    if (vp) {
      const vpPath = path.resolve(ROOT, vp.start.venvPython);
      if (isFile(vpPath)) ok('声纹 venvPython 存在', true, rel(vpPath));
      else logSkip('声纹 venvPython 未创建（可选）', rel(vpPath));
    }
  }
}

// ── ② 安装清单文件 + 语法 + 模板不泄密 ──────────────────────────────
console.log('\n[2/4] 安装清单：requirements / 配置模板 / compose / 获取脚本');
const REQUIREMENTS = [
  'asr/requirements.txt',
  'edge-tts/requirements.txt',
  'audio-loop/requirements.txt',
  'audio_common/requirements.txt',
  'pet-runtime/requirements-voice.txt',
  '_incoming/my-neuro/plugins-dlc/memos/memos_system/requirements.txt',
];
const EXAMPLES = [
  '_incoming/my-neuro/live-2d/config.example.json',
  '_incoming/my-neuro/live-2d/llm_providers.example.json',
  '_incoming/my-neuro/plugins-dlc/memos/memos_system/config/memos_config.example.json',
];
const INSTALL_FILES = [
  'docker-compose.embed.yml',
  'scripts/start-embed.ps1',
  'scripts/fetch-models.mjs',
  'asr/check-models.mjs',
  'scripts/fetch-lumenact.md',
];
const JS_FILES = [
  'scripts/bootstrap.mjs',
  'scripts/fetch-models.mjs',
  'asr/check-models.mjs',
  'scripts/gen-config-example.mjs',
  'pet-runtime/build-petbody.mjs',
  'pet-runtime/build-and-deploy-petbody.mjs',
];
const PY_FILES = [
  'asr/asr_server.py',
  'edge-tts/tts_server.py',
  'audio-loop/audio_loop_server.py',
  'audio_common/voiceprint_server.py',
  '_incoming/my-neuro/plugins-dlc/memos/memos_system/api/memos_api_server_v2.py',
  'pet-runtime/tools/lumen-semantic-server.py',
];

// 公开树不含 MemOS 子树：把 memos 相关清单项降级为 SKIP（用户自备后才有）。
if (PUBLIC_TREE) {
  for (const arr of [REQUIREMENTS, EXAMPLES, PY_FILES]) {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      if (arr[i].includes('plugins-dlc/memos')) {
        logSkip(`${arr[i]}（公开树不含 MemOS 子树，用户自备）`);
        arr.splice(i, 1);
      }
    }
  }
}

for (const r of REQUIREMENTS) {
  const p = path.join(ROOT, r);
  const text = read(p);
  ok(`${r} 存在且非空`, isFile(p) && text.trim().length > 20, isFile(p) ? `${text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).length} 行依赖` : '缺失');
}
for (const r of EXAMPLES) ok(`${r} 存在`, isFile(path.join(ROOT, r)));
for (const r of INSTALL_FILES) ok(`${r} 存在`, isFile(path.join(ROOT, r)));

// JS 语法
for (const r of JS_FILES) {
  const p = path.join(ROOT, r);
  if (!isFile(p)) { ok(`${r} node --check`, false, '文件缺失'); continue; }
  const out = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  ok(`${r} node --check`, out.status === 0, out.status === 0 ? '' : String(out.stderr || out.stdout).trim().split(/\r?\n/)[0]);
}

// pet-runtime/package.json 必须声明并安装 esbuild（build-petbody.mjs 直接 import）
{
  const pkgPath = path.join(ROOT, 'pet-runtime', 'package.json');
  let pkg = null;
  try { pkg = JSON.parse(read(pkgPath)); } catch (e) { pkg = null; }
  const declared = Boolean(pkg && ((pkg.dependencies && pkg.dependencies.esbuild) || (pkg.devDependencies && pkg.devDependencies.esbuild)));
  ok('pet-runtime/package.json 声明 esbuild', declared, declared ? String(pkg.dependencies?.esbuild || pkg.devDependencies?.esbuild) : '只声明了 ws');
  let resolved = false;
  try { createRequire(pkgPath).resolve('esbuild'); resolved = true; } catch (e) { resolved = false; }
  ok('esbuild 可解析（npm install 后）', resolved, resolved ? '' : 'cd pet-runtime && npm install');
}

// Python 语法：py_compile 到临时目录，绝不写仓库（不产生 __pycache__）
function findPython() {
  const candidates = [];
  if (process.env.PET_PYTHON) candidates.push(process.env.PET_PYTHON);
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python313', 'python.exe'));
  candidates.push('py', 'python');
  for (const cmd of candidates) {
    const r = spawnSync(cmd, ['-c', 'import sys;print(sys.version.split()[0])'], {
      encoding: 'utf8', windowsHide: true, timeout: 8000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (r.status === 0 && String(r.stdout).trim()) return cmd;
  }
  return null;
}
const PY = findPython();
if (!PY) {
  logSkip('Python py_compile 语法检查', '本机没有可用 Python（静态清单已检查）');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-pyc-'));
  try {
    const code = 'import py_compile,sys;py_compile.compile(sys.argv[1],cfile=sys.argv[2],doraise=True)';
    for (const r of PY_FILES) {
      const p = path.join(ROOT, r);
      if (!isFile(p)) { ok(`${r} py_compile`, false, '文件缺失'); continue; }
      const cfile = path.join(tmp, r.replace(/[\\/]/g, '_') + 'c');
      const out = spawnSync(PY, ['-B', '-c', code, p, cfile], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      });
      ok(`${r} py_compile`, out.status === 0, out.status === 0 ? '' : String(out.stderr || '').trim().split(/\r?\n/).slice(-1)[0]);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结果 */ }
  }
}

// compose 静态约束：容器名 / 端口 / 模型 / pooling 必须与运行实况一致
{
  const text = read(path.join(ROOT, 'docker-compose.embed.yml'));
  ok('compose 容器名 llama-embed', /container_name:\s*llama-embed/.test(text));
  ok('compose 端口 127.0.0.1:8090:8080', /127\.0\.0\.1:8090:8080/.test(text));
  ok('compose 模型 Qwen3-Embedding-0.6B-Q8_0.gguf', /Qwen3-Embedding-0\.6B-Q8_0\.gguf/.test(text));
  ok('compose --pooling last（Qwen3 要求）', /--pooling[\s\S]{0,40}last/.test(text));
}

// 模板不泄漏真实密钥：只比对「真实配置的敏感叶子值」，只报字段路径
{
  const SENSITIVE = /api_key|token|secret|password|credential/i;
  function collect(value, p, out, key) {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) collect(v, `${p}.${k}`.replace(/^\./, ''), out, k);
      return out;
    }
    if (typeof value === 'string' && key && SENSITIVE.test(key) && value.length >= 8 && !value.startsWith('<')) {
      out.push({ path: p, value });
    }
    return out;
  }
  const pairs = [
    ['_incoming/my-neuro/live-2d/config.json', '_incoming/my-neuro/live-2d/config.example.json'],
    ['_incoming/my-neuro/live-2d/llm_providers.json', '_incoming/my-neuro/live-2d/llm_providers.example.json'],
    ['_incoming/my-neuro/plugins-dlc/memos/memos_system/config/memos_config.json', '_incoming/my-neuro/plugins-dlc/memos/memos_system/config/memos_config.example.json'],
  ].filter(([realRel]) => !(PUBLIC_TREE && realRel.includes('plugins-dlc/memos')));
  for (const [realRel, tplRel] of pairs) {
    const realPath = path.join(ROOT, realRel);
    const tplPath = path.join(ROOT, tplRel);
    if (!isFile(realPath) || !isFile(tplPath)) { logSkip(`模板脱敏 ${tplRel}`, '真实配置或模板不存在'); continue; }
    let real = null;
    try { real = JSON.parse(read(realPath)); } catch (e) { real = null; }
    if (!real) { logSkip(`模板脱敏 ${tplRel}`, '真实配置不可解析'); continue; }
    const tplText = read(tplPath);
    const secrets = collect(real, '', [], '');
    const leaked = secrets.filter((s) => tplText.includes(s.value));
    ok(`${tplRel} 不含真实密钥`, leaked.length === 0,
      leaked.length ? `泄漏字段：${leaked.map((s) => s.path).join(', ')}` : `${secrets.length} 个敏感值已脱敏`);
  }
  // MemOS 模板必须保留可填的占位符结构（公开树不含 MemOS → 跳过）
  if (PUBLIC_TREE) {
    logSkip('memos 模板占位符结构（公开树不含 MemOS 子树）');
  } else {
    const memosTpl = read(path.join(MEMOS_CFG, 'memos_config.example.json'));
    ok('memos 模板 llm.config.api_key 是占位符', /"api_key"\s*:\s*"<填你的密钥>"/.test(memosTpl));
    ok('memos 模板保留 storage/embedding 结构', /"storage"\s*:/.test(memosTpl) && /"embedding"\s*:/.test(memosTpl) && /8090/.test(memosTpl));
  }
  // 结构一致性：模板叶子键路径必须覆盖真实配置（否则 clone 的人照模板配会缺字段）
  if (PUBLIC_TREE) {
    logSkip('memos 模板结构一致性（公开树不含 MemOS 子树）');
  } else {
    const realPath = path.join(MEMOS_CFG, 'memos_config.json');
    if (isFile(realPath)) {
      const leafPaths = (obj, p = '', out = []) => {
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          for (const [k, v] of Object.entries(obj)) leafPaths(v, p ? `${p}.${k}` : k, out);
        } else out.push(p);
        return out;
      };
      const realLeaves = leafPaths(JSON.parse(read(realPath)));
      const tplLeaves = new Set(leafPaths(JSON.parse(read(path.join(MEMOS_CFG, 'memos_config.example.json')))));
      const missingLeaves = realLeaves.filter((p) => !tplLeaves.has(p));
      ok('memos 模板覆盖真实配置全部字段', missingLeaves.length === 0,
        missingLeaves.length ? `缺 ${missingLeaves.slice(0, 8).join(', ')}` : `${realLeaves.length} 个叶子路径一致`);
    } else {
      logSkip('memos 模板结构一致性', '真实配置不存在');
    }
  }
}

// ── ③ bootstrap --json：结构可解析 + 不写文件 ───────────────────────
console.log('\n[3/4] bootstrap --json：结构 / 零写入');
function snapshotDirs(dirs) {
  const out = {};
  const walk = (abs, base) => {
    let st;
    try { st = fs.statSync(abs); } catch (e) { return; }
    if (st.isDirectory()) {
      let entries = [];
      try { entries = fs.readdirSync(abs); } catch (e) { return; }
      for (const name of entries) {
        if (name === 'node_modules' || name === '.git' || name === 'venv-voice') continue;
        walk(path.join(abs, name), `${base}/${name}`);
      }
      return;
    }
    out[base] = `${st.size}:${Math.floor(st.mtimeMs)}`;
  };
  for (const d of dirs) walk(path.join(ROOT, d), d);
  return out;
}
{
  const watchDirs = ['scripts', 'asr', 'edge-tts', 'audio-loop', 'audio_common', '_incoming/my-neuro/plugins-dlc/memos/memos_system/config']
    .filter((d) => fs.existsSync(path.join(ROOT, d)));
  const composeRel = 'docker-compose.embed.yml';
  const before = snapshotDirs(watchDirs);
  const composeBefore = (() => { try { const s = fs.statSync(path.join(ROOT, composeRel)); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch (e) { return 'missing'; } })();

  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'bootstrap.mjs'), '--json'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 90000,
  });
  const after = snapshotDirs(watchDirs);
  const composeAfter = (() => { try { const s = fs.statSync(path.join(ROOT, composeRel)); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch (e) { return 'missing'; } })();

  ok('bootstrap --json 退出码 0/1', r.status === 0 || r.status === 1, `exit=${r.status}`);
  let data = null;
  try { data = JSON.parse(String(r.stdout || '')); } catch (e) { data = null; }
  ok('stdout 是纯 JSON', Boolean(data), data ? '' : String(r.stdout || '').slice(0, 120));
  if (data) {
    ok('schemaVersion=1', data.schemaVersion === 1, String(data.schemaVersion));
    ok('ok 是布尔', typeof data.ok === 'boolean');
    ok('summary 结构完整', Boolean(data.summary) && ['total', 'ok', 'missing', 'warn', 'skip', 'requiredMissing'].every((k) => k in data.summary));
    ok('checks 非空数组', Array.isArray(data.checks) && data.checks.length > 0, `${(data.checks || []).length} 项`);
    const validStatus = new Set(['ok', 'missing', 'warn', 'skip']);
    ok('每个 check 有 id/status/required', (data.checks || []).every((c) => c.id && validStatus.has(c.status) && typeof c.required === 'boolean'));
    ok('check id 不重复', new Set((data.checks || []).map((c) => c.id)).size === (data.checks || []).length);
    const ids = new Set((data.checks || []).map((c) => c.id));
    const requiredIds = ['app.repo', 'config', 'providers', 'memos.config', 'py.memos', 'asr.models', 'ollama', 'embed', 'petbody', 'lumenact'];
    const absent = requiredIds.filter((id) => !ids.has(id));
    ok('关键检查项齐全', absent.length === 0, absent.length ? `缺 ${absent.join(', ')}` : `${requiredIds.length} 项`);
  }
  const beforeKeys = Object.keys(before).sort().join('|');
  const afterKeys = Object.keys(after).sort().join('|');
  ok('bootstrap 未新增/删除文件', beforeKeys === afterKeys,
    beforeKeys === afterKeys ? '' : `新增/删除 ${Math.abs(Object.keys(after).length - Object.keys(before).length)} 个`);
  const changed = Object.keys(before).filter((k) => after[k] !== before[k]);
  ok('bootstrap 未改动文件（大小/mtime）', changed.length === 0,
    changed.length ? `改动：${changed.slice(0, 5).join(', ')}` : `${Object.keys(before).length} 个文件保持原样`);
  ok('bootstrap 未改动 compose', composeBefore === composeAfter);
}

// ── ④ README 代码块里的命令路径必须存在 ─────────────────────────────
console.log('\n[4/4] README 命令路径：静态解析，不执行');
{
  const readmes = ['README.md', '_incoming/my-neuro/README.md'];
  function extractPaths(text) {
    const found = new Set();
    const blocks = text.match(/```[^\n]*\n[\s\S]*?```/g) || [];
    for (const block of blocks) {
      // 续行合并（README 里有 `\` 折行）
      const lines = block.replace(/```[^\n]*\n/, '').replace(/```$/, '').split(/\r?\n/);
      const joined = [];
      let buf = '';
      for (const line of lines) {
        buf += buf ? ' ' + line.trim() : line.trim();
        if (!/\\\s*$/.test(buf)) { joined.push(buf); buf = ''; }
      }
      for (const line of joined) {
        if (!line || /^\s*(#|::)/.test(line)) continue;
        for (const m of line.matchAll(/\bnode\s+([^\s#]+\.(?:mjs|cjs|js))\b/g)) found.add(m[1]);
        for (const m of line.matchAll(/\b(?:py|python(?:\.exe)?)\s+([^\s#]+\.py)\b/g)) found.add(m[1]);
        for (const m of line.matchAll(/\bpwsh(?:\.exe)?\b[^\n]*?-File\s+([^\s#]+\.ps1)\b/g)) found.add(m[1]);
      }
    }
    return [...found];
  }
  for (const readme of readmes) {
    const text = read(path.join(ROOT, readme));
    if (!text) { ok(`${readme} 存在`, false); continue; }
    const paths = extractPaths(text);
    const checked = [];
    const missing = [];
    for (const raw of paths) {
      const p = raw.replace(/\\/g, '/');
      // 跳过：生成物 / 虚拟环境 / 绝对路径 / shell 变量 / 占位符 / 目录级示例
      if (!p || /^(<|\$|~|\/|[A-Za-z]:)/.test(p)) continue;
      if (p.includes('node_modules') || p.includes('venv-voice') || p.includes('*') || p.includes('<')) continue;
      if (!/\.(mjs|cjs|js|py|ps1)$/.test(p)) continue;
      checked.push(p);
      if (!isFile(path.join(ROOT, p))) missing.push(p);
    }
    ok(`${readme} 命令路径存在`, missing.length === 0 && checked.length > 0,
      missing.length ? `缺：${missing.join(', ')}` : `${checked.length} 个路径`);
  }
}

console.log(`\n安装清单：PASS ${pass} / FAIL ${fail} / SKIP ${skip}`);
process.exit(fail ? 1 : 0);
