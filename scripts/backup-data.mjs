#!/usr/bin/env node
// scripts/backup-data.mjs —— 她的记忆与对话：加密打包 → 独立分支
//
// 为什么单独一个分支（2026-11-14）：
//   `data/`（6.6MB：全部对话历史、截图、心情/情绪、一起看）+ MemOS 的
//   `data/`（2.0MB：184 条记忆、知识图谱、嵌入式 Qdrant）是**隐私数据**。
//   不能进主分支 —— `git log` 一翻就全看见了。加密后用 `data-backup` 分支存，
//   主分支永远只有代码。
//
// 密钥：环境变量 `DAFEIYU_BACKUP_KEY`；没设就读 `备份/.backup-key`（自动生成，
//       已被 gitignore）。⚠ 密钥丢了数据就解不开，请自己另存一份。
//
// 用法：
//   node scripts/backup-data.mjs              打包 + 加密 + 推到 data-backup 分支
//   node scripts/backup-data.mjs --dry        只打包加密到 备份/，不推
//   node scripts/backup-data.mjs --restore <加密文件>
//                                             解密 + 解包到 备份/restore-<时间>/
//   node scripts/backup-data.mjs --verify [目录|manifest]
//                                             只读校验备份完整性（E3，2026-11-22）
//
// E3（2026-11-22）：每次备份额外写 `备份/manifest-<时间>.json`
//   {version, toolVersion, at, files:[{path, bytes, sha256}]}
//   ——`--verify` 逐个比对字节数与 sha256；doctor 读它判断「最近备份 ≤7 天」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOL_VERSION, buildManifest, writeManifest, verifyTarget } from './backup-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro');
const RECORDS = path.join(APP, 'data');
const MEMOS = path.join(APP, 'plugins-dlc', 'memos', 'memos_system', 'data');
const LOCAL = path.join(ROOT, '备份');
const KEY_FILE = path.join(LOCAL, '.backup-key');
const WT = path.join(ROOT, '.data-backup-tree');
const BRANCH = 'data-backup';
const KEY_ENV = 'DAFEIYU_BACKUP_KEY';

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
const say = (s) => console.log('  ' + s);

function loadKey(needCreate) {
  const fromEnv = process.env[KEY_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!needCreate) return '';
  fs.mkdirSync(LOCAL, { recursive: true });
  const key = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(KEY_FILE, key + '\n', { encoding: 'utf8', mode: 0o600 });
  console.log('\n⚠ 已生成备份密钥：备份/.backup-key');
  console.log('  这个文件**不要提交、不要丢** —— 丢了就解不开备份。建议抄到密码管理器。\n');
  return key;
}

function pack(key, tag) {
  // 时间戳：toISOString 是 UTC，取到分钟就够（20261113-1724）
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const stamped = stamp.replace(/(\d{8})(\d{4})/, '$1-$2');
  const tarFile = path.join(os.tmpdir(), `dafeiyu-data-${stamped}.tar.gz`).replace(/\\/g, '/');
  const encFile = path.join(LOCAL, `dafeiyu-data-${stamped}.tar.gz.enc`);
  fs.mkdirSync(LOCAL, { recursive: true });

  // 打包：data + MemOS data（相对路径保持，恢复时能放回原位）
  const targets = [];
  if (fs.existsSync(RECORDS)) targets.push(['data', RECORDS]);
  if (fs.existsSync(MEMOS)) targets.push(['memos-data', MEMOS]);
  if (!targets.length) throw new Error('没找到要备份的数据（data / MemOS data 都不在）');

  const parts = [];
  for (const [name, dir] of targets) {
    const part = `${tarFile}.${name}`;
    // ⚠ `--force-local`：GNU tar 默认把 `D:/...` 里的 `D:` 当远程主机（报
    //   「Cannot connect to D: resolve failed」）。加上它 + 正斜杠才认本地盘。
    // ⚠ `--exclude='*.lock'`：Qdrant 是嵌入式，MemOS 跑着的时候 `.lock` 被占用
    //   （报 Device or resource busy），跳过它不影响数据本身。
    sh('tar', ['--force-local', '-czf', part, '--exclude=*.lock', '-C', path.dirname(dir).replace(/\\/g, '/'), path.basename(dir)]);
    parts.push(part);
  }
  say(`打包完成：${parts.map((p) => path.basename(p) + '（' + (fs.statSync(p).size / 1024 / 1024).toFixed(1) + 'MB）').join(' + ')}`);

  const outputs = [];
  for (const part of parts) {
    const out = path.join(LOCAL, path.basename(part) + '.enc');
    // openssl 的 pass 从环境变量读，避免出现在进程参数里（ps 能看到）
    process.env[KEY_ENV] = key;
    sh('openssl', ['enc', '-aes-256-cbc', '-pbkdf2', '-salt', '-in', part, '-out', out, '-pass', `env:${KEY_ENV}`]);
    fs.unlinkSync(part);
    outputs.push(out);
    say(`加密：${path.basename(out)}（${(fs.statSync(out).size / 1024 / 1024).toFixed(1)}MB）`);
  }
  return { files: outputs, stamp };
}

function pushToBranch(files) {
  const branchExists = (() => {
    try { sh('git', ['rev-parse', '--verify', BRANCH], { cwd: ROOT }); return true; } catch (e) { return false; }
  })();

  if (!branchExists) {
    sh('git', ['worktree', 'add', '--detach', WT], { cwd: ROOT });
    sh('git', ['checkout', '--orphan', BRANCH], { cwd: WT });
    sh('git', ['rm', '-rf', '--cached', '--ignore-unmatch', '.'], { cwd: WT });
    for (const f of fs.readdirSync(WT)) {
      if (f === '.git') continue;
      fs.rmSync(path.join(WT, f), { recursive: true, force: true });
    }
    say('已创建孤儿分支 ' + BRANCH + '（不带主分支历史）');
  } else if (!fs.existsSync(path.join(WT, '.git'))) {
    sh('git', ['worktree', 'add', WT, BRANCH], { cwd: ROOT });
    say('已挂载 ' + BRANCH + ' 的工作区');
  }

  fs.mkdirSync(path.join(WT, 'data'), { recursive: true });
  for (const f of files) fs.copyFileSync(f, path.join(WT, 'data', path.basename(f)));
  fs.writeFileSync(path.join(WT, 'README.md'),
    '# 数据备份（加密）\n\n这里是她（大肥鱼）的记忆与对话的**加密**备份。\n\n' +
    '- 内容：`data/`（对话历史、截图、情绪、一起看）+ MemOS `data/`（记忆、图谱、向量库）\n' +
    '- 算法：AES-256-CBC + PBKDF2（openssl），密钥**不在仓库里**\n' +
    '- 恢复：`node scripts/backup-data.mjs --restore <文件>`（在主仓库跑，需要同一个密钥）\n' +
    '- 为什么不放主分支：这些是隐私数据，`git log` 一翻就全看见了\n\n' +
    '生成时间：' + new Date().toISOString() + '\n', 'utf8');

  sh('git', ['add', '-A'], { cwd: WT });
  sh('git', ['commit', '-m', 'data: 加密备份 ' + new Date().toISOString().slice(0, 16)], { cwd: WT });
  for (let i = 0; i < 3; i += 1) {
    try { sh('git', ['push', '-u', 'origin', BRANCH], { cwd: WT }); say('已推送 ' + BRANCH); return; }
    catch (e) { say('推送失败，重试 ' + (i + 1)); execFileSync('sleep', ['6']); }
  }
  throw new Error('推送失败（网络？）—— 加密包已在 备份/ 里，可以手动推');
}

function restore(file) {
  const key = loadKey(false);
  if (!key) throw new Error(`没有密钥：设 ${KEY_ENV} 或放 ${KEY_FILE}`);
  const outDir = path.join(LOCAL, 'restore-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const tar = path.join(os.tmpdir(), 'restore-' + Date.now() + '.tar.gz');
  process.env[KEY_ENV] = key;
  sh('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-in', file, '-out', tar, '-pass', `env:${KEY_ENV}`]);
  sh('tar', ['--force-local', '-xzf', tar.replace(/\\/g, '/'), '-C', outDir.replace(/\\/g, '/')]);
  fs.unlinkSync(tar);
  console.log('  已解到 ' + outDir);
  for (const d of fs.readdirSync(outDir)) console.log('    ' + d);
}

// ── main ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);

// E3（2026-11-22）：--verify 是只读路径 —— 不读密钥、不建目录、不改任何文件。
if (argv[0] === '--verify') {
  const target = argv[1] ? path.resolve(argv[1]) : LOCAL;
  const r = verifyTarget(target);
  if (r.error) {
    console.error('✗ 备份校验失败：' + r.error);
    process.exit(2);
  }
  console.log('\n大肥鱼 · 备份完整性校验');
  console.log('  清单：' + r.manifestFile);
  if (r.at) console.log('  备份时间：' + r.at);
  console.log('  PASS ' + r.passed + ' / FAIL ' + r.failed.length + '（共 ' + r.total + ' 个文件）');
  for (const f of r.failed) console.log('    ✗ ' + f.path + ' —— ' + f.reason);
  console.log('');
  process.exit(r.ok ? 0 : 1);
}

if (argv[0] === '--restore') {
  if (!argv[1]) { console.error('用法：node scripts/backup-data.mjs --restore <加密文件>'); process.exit(2); }
  restore(argv[1]);
  process.exit(0);
}

const dry = argv.includes('--dry');
const key = loadKey(true);
console.log('\n大肥鱼 · 数据备份' + (dry ? '（--dry：只打包不推）' : ''));
const packed = pack(key, 'backup');
const files = packed.files;

// E3：每份备份配一张 manifest（失败明细由 --verify 给出）
let manifestFile = null;
try {
  const manifest = buildManifest(LOCAL, files, { toolVersion: TOOL_VERSION });
  manifestFile = writeManifest(LOCAL, manifest, 'manifest-' + packed.stamp + '.json');
  say('清单：' + path.basename(manifestFile) + '（' + manifest.files.length + ' 个文件，sha256 已记录）');
} catch (e) {
  // 清单写不出来不该让加密包白打 —— 明确警告，仍然继续（--verify 会报「没有清单」）
  console.error('⚠ manifest 生成失败：' + (e && e.message || e));
}

if (dry) {
  console.log('\n加密包在：');
  for (const f of files) console.log('  ' + f);
  if (manifestFile) console.log('  清单：' + manifestFile);
  console.log('\n要推到 data-backup 分支：去掉 --dry 再跑\n');
  process.exit(0);
}
pushToBranch(manifestFile ? files.concat([manifestFile]) : files);
console.log('\n完成。校验：node scripts/backup-data.mjs --verify');
console.log('恢复：node scripts/backup-data.mjs --restore <加密文件>\n');
