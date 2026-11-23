#!/usr/bin/env node
// _probe/test-backup-manifest.cjs —— E3 备份演练单测（2026-11-22）
//
// 验四件事：
//   ① 假文件树 → manifest → verify 通过（字节数 + sha256 都对得上）
//   ② 改 1 个字节 → verify 失败，且**点名具体文件**（不能只报「校验失败」）
//   ③ manifest 缺失 / JSON 损坏 / 结构非法 → 明确报错，不抛异常、不崩
//   ④ doctor 用的 inspectBackupDir：新鲜度、缺文件、旧式 .enc 回退
// 全程只写 mkdtemp，不碰真实 备份/。
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backup-data.mjs');

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ✅ ' + name); };
const dirs = [];
function mk(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function cleanup() {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
}
function cli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}

(async () => {
  const M = await import(pathToFileURL(path.join(ROOT, 'scripts', 'backup-manifest.mjs')).href);

  // ── ① 正常路径：假文件树 → manifest → verify PASS ──────────────────────
  const d1 = mk('bak-manifest-ok-');
  fs.mkdirSync(path.join(d1, 'data', 'sub'), { recursive: true });
  const a = path.join(d1, 'data', 'a.txt');
  const b = path.join(d1, 'data', 'sub', 'b.bin');
  fs.writeFileSync(a, 'hello backup\n', 'utf8');
  fs.writeFileSync(b, Buffer.from([0, 1, 2, 3, 250]));
  const shaA = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');

  const manifest = M.buildManifest(d1, ['data/a.txt', 'data/sub/b.bin']);
  assert.strictEqual(manifest.version, 1);
  assert.strictEqual(manifest.files.length, 2);
  assert.strictEqual(manifest.files[0].path, 'data/a.txt');           // '/' 分隔（跨机器可读）
  assert.strictEqual(manifest.files[0].bytes, fs.statSync(a).size);
  assert.strictEqual(manifest.files[0].sha256, shaA);
  assert.strictEqual(manifest.files[1].path, 'data/sub/b.bin');
  assert.ok(/^[0-9a-f]{64}$/.test(manifest.files[1].sha256));
  ok('manifest 生成：2 个文件、相对路径、字节数/sha256 正确');

  const mf1 = M.writeManifest(d1, manifest, 'manifest.json');
  assert.ok(fs.existsSync(mf1));
  let v = M.verifyTarget(d1);
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  assert.strictEqual(v.passed, 2);
  assert.strictEqual(v.failed.length, 0);
  assert.strictEqual(v.total, 2);
  ok('verify 通过：PASS 2 / FAIL 0');

  // ── ② 篡改 1 个字节（长度不变）→ 必须抓到并点名 ────────────────────────
  const buf = fs.readFileSync(a);
  buf[0] = buf[0] === 0x68 ? 0x69 : 0x68;                              // 'h' ↔ 'i'，字节数不变
  fs.writeFileSync(a, buf);
  v = M.verifyTarget(d1);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.passed, 1);
  assert.strictEqual(v.failed.length, 1);
  assert.strictEqual(v.failed[0].path, 'data/a.txt');
  assert.ok(/sha256 不符/.test(v.failed[0].reason), v.failed[0].reason);
  ok('篡改 1 字节 → 失败，并点名 data/a.txt（sha256 不符）');

  // 恢复内容 → 又通过（证明失败不是误报）
  fs.writeFileSync(a, 'hello backup\n', 'utf8');
  assert.strictEqual(M.verifyTarget(d1).ok, true);
  ok('内容恢复 → verify 重新通过（无误报）');

  // ── ③ 缺文件 / manifest 缺失 / 损坏 / 越界 → 明确报错不崩 ──────────────
  fs.unlinkSync(b);
  v = M.verifyTarget(d1);
  assert.strictEqual(v.ok, false);
  assert.ok(v.failed.some((f) => f.path === 'data/sub/b.bin' && /缺失/.test(f.reason)));
  ok('删掉一个文件 → 失败明细指出「文件缺失」');

  fs.writeFileSync(b, Buffer.from([0, 1, 2, 3, 250]));
  fs.writeFileSync(mf1, '{ this is not json', 'utf8');
  v = M.verifyTarget(d1);
  assert.strictEqual(v.ok, false);
  assert.ok(/损坏/.test(v.error || ''), v.error);
  ok('manifest JSON 损坏 → {ok:false,error} 明确报错（不抛异常）');

  const dEmpty = mk('bak-manifest-missing-');
  fs.writeFileSync(path.join(dEmpty, 'x.enc'), 'x');
  v = M.verifyTarget(dEmpty);
  assert.strictEqual(v.ok, false);
  assert.ok(/没有 manifest/.test(v.error || ''), v.error);
  ok('目录没有 manifest → 明确报「没有 manifest」');

  const evil = M.buildManifest(d1, ['data/a.txt', 'data/sub/b.bin']);
  evil.files.push({ path: '../../escape.txt', bytes: 1, sha256: 'a'.repeat(64) });
  const vEvil = M.verifyManifest(evil, d1);
  assert.strictEqual(vEvil.ok, false);
  assert.ok(vEvil.failed.some((f) => /越界/.test(f.reason)));
  ok('manifest 路径越界（../../）→ 拒绝并报错');

  const vEmpty = M.verifyManifest({ files: [] }, d1);
  assert.strictEqual(vEmpty.ok, false);
  assert.ok(/没有 files/.test(vEmpty.error || ''));
  ok('空 manifest → 拒绝（不允许「0 个文件也算通过」）');

  // ── ④ inspectBackupDir（doctor 用）：新鲜度 / 缺文件 / 旧式回退 ─────────
  fs.writeFileSync(mf1, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  let info = M.inspectBackupDir(d1);
  assert.strictEqual(info.found, true);
  assert.strictEqual(info.legacy, false);
  assert.strictEqual(info.fileCount, 2);
  assert.strictEqual(info.ageDays, 0);
  assert.deepStrictEqual(info.missing, []);
  ok('inspect：manifest 备份 → 0 天前、2 个文件、无缺失');

  fs.unlinkSync(b);
  info = M.inspectBackupDir(d1);
  assert.strictEqual(info.missing.length, 1);
  assert.strictEqual(info.missing[0], 'data/sub/b.bin');
  ok('inspect：缺文件能列出来（doctor 会因此转黄）');

  const dLegacy = mk('bak-manifest-legacy-');
  fs.writeFileSync(path.join(dLegacy, 'dafeiyu-data-20260101-0000.tar.gz.data.enc'), 'enc');
  info = M.inspectBackupDir(dLegacy);
  assert.strictEqual(info.found, true);
  assert.strictEqual(info.legacy, true);
  assert.strictEqual(info.fileCount, 1);
  assert.strictEqual(info.ageDays, 0);
  ok('inspect：无 manifest 的旧备份 → 用 .enc mtime 回退（legacy=true）');

  const dNone = path.join(mk('bak-manifest-none-'), 'nope');
  info = M.inspectBackupDir(dNone);
  assert.strictEqual(info.found, false);
  assert.ok(/不存在/.test(info.reason || ''));
  ok('inspect：目录不存在 → found=false（doctor 走 skip）');

  // 最新 manifest 选择：mtime 更新的赢
  const d2 = mk('bak-manifest-latest-');
  fs.writeFileSync(path.join(d2, 'f1.bin'), 'one');
  fs.writeFileSync(path.join(d2, 'f2.bin'), 'two');
  const m1 = M.buildManifest(d2, ['f1.bin'], { at: '2026-01-01T00:00:00.000Z' });
  const m2 = M.buildManifest(d2, ['f2.bin'], { at: '2026-06-01T00:00:00.000Z' });
  const p1 = M.writeManifest(d2, m1, 'manifest-20260101-0000.json');
  const p2 = M.writeManifest(d2, m2, 'manifest-20260601-0000.json');
  fs.utimesSync(p1, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.utimesSync(p2, new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
  assert.strictEqual(M.findLatestManifest(d2), p2);
  assert.strictEqual(M.verifyTarget(d2).passed, 1);
  ok('多份 manifest → 校验最近一份（按 mtime 选）');

  // ── ⑤ CLI 端到端：PASS / FAIL / 缺清单 的退出码与输出 ──────────────────
  const d3 = mk('bak-manifest-cli-');
  fs.mkdirSync(path.join(d3, 'data'), { recursive: true });
  const c1 = path.join(d3, 'data', 'c.txt');
  fs.writeFileSync(c1, 'cli payload');
  M.writeManifest(d3, M.buildManifest(d3, ['data/c.txt']), 'manifest.json');

  let r = cli(['--verify', d3]);
  assert.strictEqual(r.code, 0, r.stdout + '\n' + (r.stderr || ''));
  assert.ok(/PASS 1 \/ FAIL 0/.test(r.stdout), r.stdout);
  ok('CLI --verify 正常 → 退出码 0，输出 PASS 1 / FAIL 0');

  const cb = fs.readFileSync(c1); cb[0] = cb[0] ^ 0xff; fs.writeFileSync(c1, cb);
  r = cli(['--verify', d3]);
  assert.strictEqual(r.code, 1);
  assert.ok(/FAIL 1/.test(r.stdout) && /data\/c\.txt/.test(r.stdout), r.stdout);
  ok('CLI --verify 被篡改 → 退出码 1，stdout 点名文件');

  const d4 = mk('bak-manifest-cli-missing-');
  r = cli(['--verify', d4]);
  assert.strictEqual(r.code, 2);
  assert.ok(/没有 manifest/.test((r.stderr || '') + (r.stdout || '')));
  ok('CLI --verify 缺清单 → 退出码 2（明确报错）');

  cleanup();
  console.log('\ntest-backup-manifest.cjs：' + pass + '/' + pass + ' 全过');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ test-backup-manifest 失败：', e && e.stack || e);
  cleanup();
  process.exit(1);
});
