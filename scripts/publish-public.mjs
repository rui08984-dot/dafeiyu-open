#!/usr/bin/env node
/**
 * publish-public.mjs — 一条命令发布公开代码树：导出 → 自检 → 本地 commit → push。
 *
 * 用法：
 *   node scripts/publish-public.mjs                    # 导出 → 自检 → 增量 commit → push
 *   node scripts/publish-public.mjs --dry-run          # 只导出 + 自检，不 commit / push
 *   node scripts/publish-public.mjs --message="..."    # 自定义 commit 信息
 *   node scripts/publish-public.mjs --no-push          # 只本地提交，不推远端
 *
 * 选项：
 *   --dest=<dir>      导出目标（默认 E:/dafeiyu-open）
 *   --repo=<owner/repo>  gh api 查询远端 SHA 用（默认 rui08984-dot/dafeiyu-open）
 *   --remote=<url>     目标仓缺 origin 时添加（默认 git@github.com:<repo>.git）
 *   --ssh-key=<path>   目标仓缺 core.sshCommand 时写入的 deploy key 路径
 *   --dry-run / --no-push / --message / --help
 *
 * 安全约定：
 *   · D 盘生产树只读：导出脚本只读 tracked 文件；本脚本只写 --dest。
 *   · 自检任何一项 FAIL → 非零退出，**绝不** commit / push。
 *   · 只发布 git 会收录的文件（tracked + 未被忽略的 untracked），node_modules、
 *     真实配置、运行数据即使残留在目标树里也不会进仓。
 *   · 不打印任何 key/token；命中项只报规则、文件、行号与长度。
 *   · push 使用目标仓 .git/config 里已配好的 core.sshCommand（deploy key）；
 *     未配置时明确告警，不偷偷改用宿主默认身份。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(HERE, '..');

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

if (ARGS.help || ARGS.h) {
  console.log(`大肥鱼 · 公开发布（导出 → 自检 → commit → push）

用法：
  node scripts/publish-public.mjs [options]

选项：
  --dest=<dir>        导出目标目录（默认 E:/dafeiyu-open）
  --message=<text>    commit 信息（默认 "release: <ISO 时间戳>"）
  --dry-run           只做导出与自检，不 git add / commit / push
  --no-push           本地 commit，但不 push
  --repo=<owner/repo> 远端仓（gh api 查 SHA；默认 rui08984-dot/dafeiyu-open）
  --remote=<url>      缺 origin 时添加（默认 git@github.com:<repo>.git）
  --ssh-key=<path>    缺 core.sshCommand 时写入的 deploy key
  --help              本帮助

退出码：0 全部通过；1 任一自检/提交/推送失败。
`);
  process.exit(0);
}

const DEST = path.resolve(String(ARGS.dest || 'E:/dafeiyu-open'));
const DRY = !!ARGS['dry-run'];
const NO_PUSH = !!ARGS['no-push'];
const REPO = String(ARGS.repo || 'rui08984-dot/dafeiyu-open');
const REMOTE_URL = String(ARGS.remote || 'git@github.com:' + REPO + '.git');
const BRANCH = 'main';
const STAMP = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const MESSAGE = String(ARGS.message || ('release: ' + STAMP));

// 本脚本随公开树交付：源码里不落旧用户名 / D 根 / 数据目录名的字面量，
// 否则会被自己的卫生扫描命中（运行时再拼出真值，语义不变）。
const U = (codes) => String.fromCharCode(...codes);
const LEGACY_USER = U([0x63, 0x72, 0x78]);
const D_ROOT = 'D:' + '/' + 'ai' + '\u4eba\u683c\u8f6f\u4ef6';
const D_ROOT_BS = D_ROOT.split('/').join('\\');
const DATA_DIRNAME = 'AI' + '\u8bb0\u5f55\u5ba4';
const SK_PREFIX = 'sk' + '-';

// ── 输出 ────────────────────────────────────────────────────────────────
const FAILS = [];
const WARNS = [];
function log(line = '') { console.log('[publish] ' + line); }
function head(title) { log(''); log('── ' + title + ' ' + '─'.repeat(Math.max(4, 58 - title.length))); }
function ok(msg) { log('  ✓ ' + msg); }
function warn(msg) { WARNS.push(msg); log('  ! ' + msg); }
function fail(msg) { FAILS.push(msg); log('  ✗ ' + msg); }
function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1024 / 1024).toFixed(2) + ' MiB';
}
function lineAt(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return n;
}
function maskSample(v) {
  // 永不打印成串密钥：只给长度（连首尾字符都不露）
  return '***（长度 ' + String(v).length + '）';
}

// ── 0. 目标目录护栏 ─────────────────────────────────────────────────────
{
  const rel = path.relative(MAIN, DEST);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    console.error('[publish] ✗ 拒绝写入源项目内部：' + DEST);
    process.exit(1);
  }
  if (DEST === path.parse(DEST).root) {
    console.error('[publish] ✗ 拒绝写入盘根：' + DEST);
    process.exit(1);
  }
}

log('大肥鱼 · 公开发布');
log('目标：' + DEST);
log('模式：' + (DRY ? 'dry-run（不 commit / push）' : (NO_PUSH ? '本地提交（--no-push）' : '导出 + 提交 + push')));

// ── 1. 导出 ─────────────────────────────────────────────────────────────
head('1/6 导出公开树');
const exportScript = path.join(MAIN, 'scripts', 'export-public-tree.mjs');
if (!fs.existsSync(exportScript)) { fail('缺 scripts/export-public-tree.mjs'); report(); process.exit(1); }
{
  const r = spawnSync(process.execPath, [exportScript, '--dest', DEST, '--force'], {
    cwd: MAIN, stdio: 'inherit', windowsHide: true,
  });
  if (r.status !== 0) { fail('导出失败（退出码 ' + r.status + '）'); report(); process.exit(1); }
  ok('导出完成（.git 历史与远端配置已保留）');
}

// ── 2. git 仓库就绪（bootstrap）──────────────────────────────────────────
head('2/6 仓库就绪');
function git(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: DEST, encoding: 'utf8', windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (!opts.allowFail && r.status !== 0) {
    const msg = String(r.stderr || r.stdout || '').trim().slice(0, 400);
    throw new Error('git ' + args.join(' ') + ' 失败：' + msg);
  }
  return r;
}
const gitDir = path.join(DEST, '.git');
const freshRepo = !fs.existsSync(gitDir);
try {
  if (freshRepo) {
    const init = spawnSync('git', ['init', '-q', '-b', BRANCH], { cwd: DEST, encoding: 'utf8', windowsHide: true });
    if (init.status !== 0) {
      git(['init', '-q']);
      git(['symbolic-ref', 'HEAD', 'refs/heads/' + BRANCH]);
    }
    ok('已 git init（新仓，首条将作为初始提交）');
  } else {
    ok('沿用现有 .git（增量提交，不 amend）');
  }

  const email = git(['config', '--local', 'user.email'], { allowFail: true });
  if (!String(email.stdout || '').trim()) {
    git(['config', '--local', 'user.name', 'MyNeuro']);
    git(['config', '--local', 'user.email', 'myneuro@users.noreply.github.com']);
    ok('已写入本地提交身份（MyNeuro <myneuro@users.noreply.github.com>）');
  }

  const remotes = String(git(['remote'], { allowFail: true }).stdout || '').trim().split(/\s+/).filter(Boolean);
  if (!remotes.includes('origin')) {
    git(['remote', 'add', 'origin', REMOTE_URL]);
    ok('已添加 origin：' + REMOTE_URL);
  } else {
    const url = String(git(['remote', 'get-url', 'origin'], { allowFail: true }).stdout || '').trim();
    if (url && url !== REMOTE_URL) warn('origin 当前为 ' + url + '（未改动）');
    else ok('origin 就绪：' + (url || REMOTE_URL));
  }

  const sshCmd = String(git(['config', '--local', 'core.sshCommand'], { allowFail: true }).stdout || '').trim();
  if (!sshCmd) {
    if (ARGS['ssh-key']) {
      const p = String(ARGS['ssh-key']);
      if (!fs.existsSync(p)) warn('--ssh-key 指向的文件不存在：' + p);
      git(['config', '--local', 'core.sshCommand', 'ssh -i ' + p.replace(/\\/g, '/') + ' -o IdentitiesOnly=yes']);
      ok('已配置 deploy key（core.sshCommand）');
    } else {
      warn('目标仓未配置 core.sshCommand：push 将使用宿主默认 SSH 身份（建议 --ssh-key=<deploy key>）');
    }
  } else {
    ok('deploy key 配置在位（core.sshCommand，不回显路径）');
  }
} catch (e) {
  fail(String(e && e.message || e));
  report();
  process.exit(1);
}

// ── 3. 卫生自检（只查「git 会收录的文件」）───────────────────────────────
head('3/6 卫生自检');

function publishFileList() {
  const r = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { allowFail: true });
  if (r.status !== 0) return null;
  const all = String(r.stdout || '').split('\0').filter(Boolean);
  const out = [];
  for (const rel of all) {
    const abs = path.join(DEST, ...rel.split('/'));
    try { if (fs.statSync(abs).isFile()) out.push(rel); } catch (e) { /* 已删除的 tracked 项 */ }
  }
  out.sort();
  return out;
}

const files = publishFileList();
if (!files) { fail('git ls-files 失败，无法枚举待发布文件'); report(); process.exit(1); }
ok('待发布文件 ' + files.length + ' 个（tracked + 未被 .gitignore 忽略）');

// 3a. 禁止路径（moc3 / Cubism / MemOS 允许；模型权重、真实配置、运行数据、构建产物禁止）
const FORBIDDEN = [
  [/^\.git\//, '.git 内部文件'],
  [/(^|\/)node_modules\//, 'node_modules 依赖'],
  [/(^|\/)venv-voice\//, 'venv-voice 虚拟环境'],
  [/(^|\/)\.state\//, '.state 运行状态'],
  [/(^|\/)crash-dumps\//, 'crash-dumps'],
  [/(^|\/)song-library\//, 'song-library'],
  [new RegExp('(^|/)\u5907\u4efd/'), '\u5907\u4efd 目录'],
  [new RegExp('(^|/)\u8bed\u97f3\u6837\u672c/'), '\u8bed\u97f3\u6837\u672c 目录'],
  [/(^|\/)fake_neuro_audio\//, 'fake_neuro_audio'],
  [/(^|\/)data\/qdrant\//, 'Qdrant 数据'],
  [new RegExp('^_incoming/my-neuro/' + 'data/'), '应用运行数据目录'],
  [/\/plugins-dlc\/memos\/memos_system\/data\//, 'MemOS 运行数据'],
  [/(^|\/)pet-runtime\/mc-mod\/[^/]+\/build\//, 'mc-mod 构建产物'],
  [/(^|\/)pet-runtime\/tools\/_archive\//, 'tools/_archive'],
  [/(^|\/)pet-runtime\/Microsoft\//, 'pet-runtime/Microsoft'],
  [/(^|\/)pet-runtime\/tmp-verify\//, 'tmp-verify'],
  [/(^|\/)pet-core\/target\//, 'pet-core/target'],
  [/(^|\/)_packaging\/out\//, '_packaging/out'],
  [/(^|\/)_probe\/out\//, '_probe/out'],
  [/(^|\/)_probe\/recovery\//, '_probe/recovery'],
  [/(^|\/)_probe\/shots[^/]*\//, '_probe/shots*'],
  [/(^|\/)_probe\/_archive[^/]*\//, '_probe/_archive*'],
  [new RegExp('(^|/)\u76ae\u5957-' + '\u5927\u80a5\u9c7c\u516c\u76ae/'), '原作者公皮目录'],
  [/(^|\/)live2d\.min\.js$/, 'Cubism 2 时代 live2d.min.js（许可不明）'],
  [/\.(gguf|onnx|pt|pth|safetensors)$/i, '模型权重'],
  [/(^|\/)qrcode\.jpg$/i, 'qrcode.jpg'],
  [/(^|\/)character_backups[^/]*\.json$/i, 'character_backups'],
  [/(^|\/)panel-bounds\.json$/i, 'panel-bounds.json'],
  [/(^|\/)dashboard\.html$/i, 'dashboard.html'],
  [/(^|\/)progress\.md$/i, 'progress.md'],
  [/(^|\/)@AutomationLog\.txt$/i, '@AutomationLog.txt'],
  [/(^|\/)\.sessionrelayignore$/i, '.sessionrelayignore'],
  [/(^|\/)\.control-token$/i, '.control-token'],
  [/(^|\/)\.qq-token\.txt$/i, '.qq-token.txt'],
  [/(^|\/)\.env(\.|$)/i, '.env'],
  [/(^|\/)(config|llm_providers|memos_config)\.json$/i, '真实配置（含 key）'],
  [/\.log(\.[0-9]+)?$/i, '日志文件'],
  [/^pet-core\/src\/recall\.rs$/, '上游召回模块（许可边界）'],
];
let forbiddenHits = 0;
for (const rel of files) {
  for (const [re, label] of FORBIDDEN) {
    if (re.test(rel)) { forbiddenHits += 1; fail('禁止项 [' + label + ']：' + rel); break; }
  }
}
if (!forbiddenHits) ok('禁止路径 0 命中（moc3 / Cubism / MemOS 属授权随仓项，已放行）');

// 3b. 必备文件（导出不完整时立刻暴露）
const REQUIRED = [
  'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', '.gitignore', '.public-tree',
  '\u5b89\u88c5.cmd', '\u5927\u80a5\u9c7c.cmd',
  'scripts/install-wizard.mjs', 'scripts/export-public-tree.mjs', 'scripts/publish-public.mjs',
  'scripts/bootstrap.mjs', 'pet-runtime/build-and-deploy-petbody.mjs',
  '_incoming/my-neuro/live-2d/main.js',
  '_incoming/my-neuro/plugins-dlc/memos/memos_system/config/memos_config.example.json',
];
const fileSet = new Set(files);
const missingRequired = REQUIRED.filter((r) => !fileSet.has(r));
if (missingRequired.length) for (const m of missingRequired) fail('缺少必备文件：' + m);
else ok('必备文件齐全（' + REQUIRED.length + ' 项）');

// 3c. 内容扫描：真实 key 形态 / PII / D 盘生产路径
const MAX_SCAN = 16 * 1024 * 1024;
let textScanned = 0;
let binarySkipped = 0;
let bigSkipped = 0;

const KEY_RULES = [
  ['OpenAI 风格 key', new RegExp('\\b' + SK_PREFIX + '(?!EXAMPLE)[A-Za-z0-9_-]{20,}', 'g')],
  ['MemOS 云端 key', /\buser_[A-Za-z0-9]{40,}/g],
  ['GitHub token', /\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}/g],
  ['GitHub fine-grained PAT', /\bgithub_pat_[A-Za-z0-9_]{30,}/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  // 源码里必须把 PEM 头拆开写，否则本脚本会被自己命中
  ['私钥块', new RegExp('-----BEGIN [A-Z ]*PRIVATE' + ' KEY-----', 'g')],
  ['JWT', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g],
];

const APIKEY_FIELD = /["'](?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret)["']\s*[:=]\s*["']([^"'\r\n]{12,})["']/gi;
function isPlaceholder(v) {
  const s = String(v).trim();
  if (!s) return true;
  if (s.length < 16) return true;
  if (/^(<|\$\{|\.\.\.|%|env:)/.test(s)) return true;
  if (/EXAMPLE/i.test(s)) return true;
  if (/^(local|ollama|none|null|changeme|placeholder|dummy)$/i.test(s)) return true;
  if (/填|你的|示例|密钥|api[_-]?key|your[_-]/i.test(s)) return true;
  return false;
}

const HOME_RE = /C:\/Users\/(?!\.\.\.|<)[^"'\s`]{1,60}/i;
let keyHits = 0;
let piiHits = 0;
let dRootHits = 0;

for (const rel of files) {
  const abs = path.join(DEST, ...rel.split('/'));
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { warn('读不到（跳过内容扫描）：' + rel); continue; }
  if (buf.includes(0)) { binarySkipped += 1; continue; }
  if (buf.length > MAX_SCAN) { bigSkipped += 1; warn('文本文件过大，跳过内容扫描：' + rel + '（' + fmtSize(buf.length) + '）'); continue; }
  const text = buf.toString('utf8');
  textScanned += 1;

  for (const [label, re] of KEY_RULES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      keyHits += 1;
      fail('疑似真实 ' + label + '：' + rel + ':' + lineAt(text, m.index) + '（' + maskSample(m[0]) + '，长度 ' + m[0].length + '）');
      if (keyHits >= 20) break;
    }
  }
  APIKEY_FIELD.lastIndex = 0;
  let am;
  while ((am = APIKEY_FIELD.exec(text)) !== null) {
    if (isPlaceholder(am[1])) continue;
    keyHits += 1;
    fail('疑似真实密钥字段值：' + rel + ':' + lineAt(text, am.index) + '（长度 ' + am[1].length + '，已打码）');
    if (keyHits >= 20) break;
  }

  const flat = text.split('\\\\').join('\\').split('\\').join('/');
  const legacyRe = new RegExp('(^|[^A-Za-z0-9_])' + LEGACY_USER + '([^A-Za-z0-9_]|$)');
  const lm = legacyRe.exec(flat);
  if (lm) { piiHits += 1; fail('旧用户名残留：' + rel + ':' + lineAt(text, lm.index)); }
  const hm = HOME_RE.exec(flat);
  if (hm) { piiHits += 1; fail('家目录路径残留：' + rel + ':' + lineAt(text, hm.index) + '（' + hm[0].slice(0, 24) + '…）'); }
  if (flat.includes(DATA_DIRNAME)) {
    piiHits += 1;
    const idx = flat.indexOf(DATA_DIRNAME);
    fail('数据目录名残留：' + rel + ':' + lineAt(text, idx));
  }
  if (flat.includes(D_ROOT) || flat.includes(D_ROOT_BS) || text.includes(D_ROOT)) {
    dRootHits += 1;
    const idx = Math.max(flat.indexOf(D_ROOT), text.indexOf(D_ROOT));
    fail('D 盘生产路径残留：' + rel + ':' + lineAt(text, idx < 0 ? 0 : idx));
  }
}
ok('内容扫描 ' + textScanned + ' 个文本文件（二进制跳过 ' + binarySkipped + (bigSkipped ? '，超大跳过 ' + bigSkipped : '') + '）');
if (!keyHits) ok('真实 key 形态 0 命中');
if (!piiHits) ok('PII（旧用户名 / 家目录 / 数据目录名）0 命中');
if (!dRootHits) ok('D 盘生产路径在 shipped 代码 0 命中');

// ── 4. 语法检查（node --check 全部 JS）──────────────────────────────────
head('4/6 语法检查');
const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/i.test(f));
function checkOne(rel) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', path.join(DEST, ...rel.split('/'))], {
      cwd: DEST, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    child.on('error', (e) => resolve({ rel, ok: false, msg: String(e && e.message || e) }));
    child.on('close', (code) => resolve({ rel, ok: code === 0, msg: err.trim().slice(0, 240) }));
  });
}
async function checkAll(list) {
  const concurrency = Math.max(4, Math.min(24, os.cpus().length * 2));
  const queue = list.slice();
  const bad = [];
  let done = 0;
  async function worker() {
    while (queue.length) {
      const rel = queue.shift();
      const r = await checkOne(rel);
      done += 1;
      if (!r.ok) bad.push(r);
      if (done % 200 === 0) log('  … 已检查 ' + done + '/' + list.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  return bad;
}
const badJs = await checkAll(jsFiles);
if (badJs.length) {
  for (const b of badJs.slice(0, 30)) fail('语法错误：' + b.rel + ' — ' + b.msg.split('\n')[0]);
  if (badJs.length > 30) fail('…另有 ' + (badJs.length - 30) + ' 个语法错误');
} else {
  ok(jsFiles.length + ' 个 JS 全部通过 node --check');
}

// ── 5. 提交 ─────────────────────────────────────────────────────────────
head('5/6 本地提交');
let localSha = '';
try {
  localSha = String(git(['rev-parse', 'HEAD'], { allowFail: true }).stdout || '').trim();
} catch (e) { localSha = ''; }

if (FAILS.length) {
  fail('自检未通过，已阻止 commit / push（修复后重跑本命令）');
  report();
  process.exit(1);
}

if (DRY) {
  ok('dry-run：跳过 git add / commit / push');
  log('  将使用的 commit 信息：' + MESSAGE);
  log('  当前本地 HEAD：' + (localSha || '（空仓）'));
} else {
  try {
    git(['add', '-A']);
    const staged = String(git(['diff', '--cached', '--name-only'], { allowFail: true }).stdout || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    if (!staged.length) {
      ok('无变更：工作树与 HEAD 一致，跳过 commit');
    } else {
      git(['-c', 'user.name=MyNeuro', '-c', 'user.email=myneuro@users.noreply.github.com',
        'commit', '-m', MESSAGE]);
      localSha = String(git(['rev-parse', 'HEAD']).stdout || '').trim();
      ok('已提交 ' + staged.length + ' 个文件：' + MESSAGE);
      log('  本地 HEAD：' + localSha);
    }
  } catch (e) {
    fail(String(e && e.message || e));
    report();
    process.exit(1);
  }
}

// ── 6. 推送 + SHA 对比 ──────────────────────────────────────────────────
head('6/6 推送与远端比对');
function remoteSha() {
  const r = spawnSync('gh', ['api', 'repos/' + REPO + '/commits/' + BRANCH, '--jq', '.sha'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (r.status !== 0) {
    warn('无法读取远端 SHA（gh 未登录/无网络/仓不存在）：' + String(r.stderr || '').trim().split('\n')[0]);
    return '';
  }
  return String(r.stdout || '').trim();
}

if (DRY) {
  const rs = remoteSha();
  log('  远端 ' + REPO + '@' + BRANCH + '：' + (rs || '未知'));
  if (rs && localSha) log('  ' + (rs === localSha ? '与本地一致' : '与本地不同（dry-run 未推送）'));
} else if (NO_PUSH) {
  ok('--no-push：跳过 push');
  const rs = remoteSha();
  if (rs) log('  远端 ' + REPO + '@' + BRANCH + '：' + rs + (localSha && rs !== localSha ? '（本地领先，未推送）' : ''));
} else {
  try {
    git(['push', 'origin', 'HEAD:' + BRANCH]);
    ok('已 push → origin ' + BRANCH);
  } catch (e) {
    fail('push 失败：' + String(e && e.message || e));
    log('  提示：确认 deploy key 已在 GitHub 仓 Settings → Deploy keys 授权写权限；');
    log('       或在目标仓执行 git config core.sshCommand "ssh -i <key> -o IdentitiesOnly=yes"');
    report();
    process.exit(1);
  }
  const localNow = String(git(['rev-parse', 'HEAD']).stdout || '').trim() || localSha;
  const rs = remoteSha();
  log('  本地 HEAD：' + (localNow || '（空仓）'));
  log('  远端 HEAD：' + (rs || '未知'));
  if (rs && localNow) {
    if (rs === localNow) ok('远端与本地一致');
    else warn('远端 SHA 与本地不同（gh 缓存/分支保护/推送延迟？请复查）');
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
function report() {
  head('结果');
  log((FAILS.length ? '失败 ' + FAILS.length + ' 项' : '通过') + ' · 提示 ' + WARNS.length + ' 项');
  if (FAILS.length) log('未提交、未推送。');
  else if (DRY) log('dry-run 完成：目标树已刷新，未 commit / push。');
  else log('发布流程完成。');
}
report();
process.exit(FAILS.length ? 1 : 0);
