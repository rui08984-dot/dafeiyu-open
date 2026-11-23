#!/usr/bin/env node
/**
 * _probe/test-upload-hygiene.cjs — 上传前卫生门禁（2026-11-23）
 *
 * 只做静态/本地检查，不联网、不打印真实密钥：
 *   ① 两个仓库的「当前跟踪工作树」里不再出现 sk-zk / sk-yg 真实密钥形态
 *      （允许 synthetic fixture：行内带 FIXTURE/EXAMPLE/... 标记）
 *      注意：本任务约定不 commit，所以这里检查的是 git ls-files 对应的**工作树内容**；
 *      HEAD 提交里仍有旧 key，需在 commit + 历史重写后才能复查 HEAD 树。
 *   ② set_live2d.py / process_audio.py 在缺环境变量时给出明确错误且不发起网络
 *      （runpy 执行时把 socket.connect 换成抛 NETWORK_BLOCKED 的桩）
 *   ③ 敏感文件已不在 git ls-files（本地文件必须仍在）
 *   ④ .gitignore 覆盖 _probe/recovery/ 与 .state 日志/音频
 *
 * 用法：node _probe/test-upload-hygiene.cjs
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro');
// 解释器不写死用户路径：PET_PYTHON > 宿主 runtime-paths 探测 > py 启动器。
// （写死路径在公开树会被脱敏成占位符，测试就没法跑了；2026-11-23 E 树验收发现）
const PY = process.env.PET_PYTHON || (() => {
  try {
    const { resolvePython } = require(path.join(APP, 'live-2d', 'js', 'core', 'runtime-paths.js'));
    return resolvePython();
  } catch (e) { return 'py'; }
})();

const KEY_RE = /sk-zk[0-9a-f]{20,}|sk-yg[a-z]{20,}/;
const SYNTH_RE = /FIXTURE|EXAMPLE|SYNTHETIC|PLACEHOLDER|REDACTED|哑元|示例/i;

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];

// 公开导出树（E 副本）：没有 app 的 .git、data、fake_neuro_audio 与 MemOS。
// D 专属的「本地文件必须还在」类检查降级为 SKIP；密钥/资产/跟踪面扫描照常执行。
const PUBLIC_TREE = fs.existsSync(path.join(ROOT, '.public-tree'))
  || (!fs.existsSync(path.join(APP, '.git')) && !fs.existsSync(path.join(APP, 'data')));

function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  failures.push(`${name}${detail === undefined ? '' : `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
function logSkip(name, detail) {
  skip++;
  console.log('  ~ ' + name + (detail ? ' — ' + detail : ''));
}

// 失败详情可能包含脚本输出；统一把任何 key 形态打成星号，绝不回显真实值。
function redact(text) {
  return String(text || '').replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***');
}

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
}

// ── ① 当前跟踪工作树无真实 key ───────────────────────────────────────────
function scanRepoKeys(repo, label) {
  const r = git(repo, ['grep', '-n', '-I', '-E', 'sk-zk[0-9a-f]{20,}|sk-yg[a-z]{20,}', '--', '.']);
  if (r.status === 1) { check(`${label} 无 sk-zk/sk-yg 形态`, true); return; }
  if (r.status !== 0) {
    check(`${label} 可扫描`, false, redact(String(r.stderr || '').trim().slice(0, 120)));
    return;
  }
  const hits = String(r.stdout || '').split(/\r?\n/).filter(Boolean)
    .filter((line) => !SYNTH_RE.test(line));
  // 只报 文件:行号，绝不打印命中行内容。
  const where = hits.map((line) => line.split(':').slice(0, 2).join(':')).slice(0, 8);
  check(`${label} 无 sk-zk/sk-yg 形态`, hits.length === 0, where.join(', '));
}

scanRepoKeys(APP, 'app 仓');
scanRepoKeys(ROOT, '主仓');

// 两脚本仍被跟踪（不能因为删 key 把文件删了）
if (PUBLIC_TREE) {
  logSkip('两脚本仍被跟踪（公开树只保留 set_live2d.py；fake_neuro_audio 不随公开仓分发）');
} else {
  const r = git(APP, ['ls-files', '--', 'live-2d/set_live2d.py', 'live-2d/fake_neuro_audio/process_audio.py']);
  const files = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  check('两脚本仍被跟踪', files.length === 2, files.join(', '));
}

// ── ② 缺环境变量：明确报错且不联网 ───────────────────────────────────────
const NET_GUARD = [
  'import runpy, socket',
  'def _blocked(*a, **k):',
  "    raise RuntimeError('NETWORK_BLOCKED')",
  'socket.socket.connect = _blocked',
  'socket.create_connection = _blocked',
  "runpy.run_path(%s, run_name='__main__')",
];

function expectEnvError(scriptRel, envName) {
  if (!fs.existsSync(path.join(APP, scriptRel))) {
    logSkip(`${scriptRel} 缺 ${envName} 报错检查（公开树不含该脚本）`);
    return;
  }
  const env = { ...process.env };
  delete env.ZHIZENGZENG_API_KEY;
  delete env.SILICONFLOW_API_KEY;
  const code = NET_GUARD.join('\n').replace('%s', JSON.stringify(path.join(APP, scriptRel)));
  const r = spawnSync(PY, ['-c', code], { cwd: APP, encoding: 'utf8', timeout: 60000, env, windowsHide: true });
  const out = String(r.stdout || '') + String(r.stderr || '');
  check(`${scriptRel} 缺 ${envName} 退出非零`, r.status !== 0, `status=${r.status}`);
  check(`${scriptRel} 报错点名 ${envName}`, out.includes(envName));
  check(`${scriptRel} 报错说明缺变量`, out.includes('缺少环境变量'), redact(out.slice(-160)));
  check(`${scriptRel} 未发起网络`, !out.includes('NETWORK_BLOCKED'), redact(out.slice(-160)));
  check(`${scriptRel} 未回显密钥`, !KEY_RE.test(out), redact(out.slice(-160)));
}

expectEnvError('live-2d/set_live2d.py', 'ZHIZENGZENG_API_KEY');
expectEnvError('live-2d/fake_neuro_audio/process_audio.py', 'SILICONFLOW_API_KEY');

// ── ③ 敏感文件不在 git ls-files ──────────────────────────────────────────
function trackedList(repo) {
  const r = git(repo, ['ls-files', '-z']);
  if (r.status !== 0) return null;
  return String(r.stdout || '').split('\0').filter(Boolean);
}

{
  const tracked = trackedList(ROOT);
  check('主仓 git ls-files 可读', tracked !== null);
  if (tracked) {
    check('恢复记忆不再被跟踪', !tracked.includes('_probe/recovery/memos-list.json'));
    check('_probe/recovery/ 整目录未被跟踪', !tracked.some((f) => f.startsWith('_probe/recovery/')));
    const badLogs = tracked.filter((f) => /^pet-runtime\/\.state\/.*\.(out|err|log)/.test(f)
      || /^pet-runtime\/\.state\/_.*\.(wav|mp3)$/.test(f));
    check('运行日志/音频未被跟踪', badLogs.length === 0, badLogs.slice(0, 6).join(', '));
    check('10MB 运行日志未被跟踪', !tracked.includes('pet-runtime/.state/my-neuro.out.log.1'));
  }

  const appTracked = trackedList(APP);
  if (PUBLIC_TREE) {
    logSkip('app 仓独立 git 检查（公开树是合并仓，无独立 .git）');
  } else {
    check('app 仓 git ls-files 可读', appTracked !== null);
    if (appTracked) {
      const appBad = appTracked.filter((f) => /(^|\/)\.state\/|\.log$|_probe\/recovery\//.test(f));
      check('app 仓无 .state/日志被跟踪', appBad.length === 0, appBad.slice(0, 6).join(', '));
    }
  }
}

// 本地文件必须还在（git rm --cached 不是删除）
if (PUBLIC_TREE) {
  logSkip('本地运行文件保留检查（公开树不含 _probe/recovery 与 pet-runtime/.state）');
} else {
  for (const rel of ['_probe/recovery/memos-list.json', 'pet-runtime/.state/my-neuro.out.log.1', 'pet-runtime/.state/_user.wav']) {
    check(`本地保留 ${rel}`, fs.existsSync(path.join(ROOT, rel)));
  }
}

// ── ④ .gitignore 覆盖 ────────────────────────────────────────────────────
for (const rel of [
  '_probe/recovery/memos-list.json',
  'pet-runtime/.state/my-neuro.out.log.1',
  'pet-runtime/.state/launch.out',
  'pet-runtime/.state/launch.err',
  'pet-runtime/.state/_user.wav',
  'pet-runtime/.state/_ref.mp3',
]) {
  const r = git(ROOT, ['check-ignore', '-q', '--', rel]);
  check(`.gitignore 覆盖 ${rel}`, r.status === 0, `status=${r.status}`);
}

{
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const rule of ['_probe/recovery/', 'pet-runtime/.state/*.log*', '*.out.log*']) {
    check(`.gitignore 含规则 ${rule}`, gi.includes(rule));
  }
}

// ── 汇总（check-all 认这个格式）────────────────────────────────────────
console.log(`PASS ${pass} / FAIL ${fail}${skip ? ` / SKIP ${skip}` : ''}`);
if (fail) {
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(1);
}
