// scripts/backup-manifest.mjs —— 备份清单（E3 备份演练，2026-11-22）
//
// 为什么需要：
//   备份「跑成功了」不等于「备份能用」。原来 backup-data.mjs 打完包打印一行
//   「加密：xxx.enc（3.7MB）」就结束了 —— 如果 tar/openssl 中途只写了一半，
//   下一次 restore 才会发现解不开，而那时可能已经没有原始数据了。
//   这里给每份备份配一张 manifest（文件/字节数/sha256），并提供一个
//   **只读**的 --verify：读清单逐个校验，坏在哪一个文件说得出来。
//
// 设计约束：
//   · manifest 里的 path 一律相对备份目录、用 '/' 分隔 —— 备份目录被整体搬到
//     另一台机器/另一个分支时仍然能校验（不写死本机盘符）。
//   · 只依赖 node 内置模块，不引新依赖。
//   · verify 永远不抛异常：清单缺失/损坏/字段非法都返回 {ok:false,error}，
//     调用方（CLI / doctor / 单测）自己决定怎么显示。
//
// 用法（由 scripts/backup-data.mjs 调用，也可单独 import）：
//   import { buildManifest, writeManifest, verifyTarget, inspectBackupDir } from './backup-manifest.mjs';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOOL_VERSION = 'backup-data.mjs/2';
export const MANIFEST_NAME = 'manifest.json';
const MANIFEST_RE = /^manifest(?:-[^/\\]+)?\.json$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

/** 文件 sha256（小写十六进制）。读不出来会抛错（调用方负责包住）。 */
export function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function toRel(baseDir, abs) {
  return path.relative(baseDir, abs).split(path.sep).join('/');
}

/**
 * 生成 manifest 对象（不写盘）。
 * @param {string} baseDir 备份目录（manifest 里的 path 相对它）
 * @param {string[]} files 绝对路径或相对 baseDir 的路径
 * @param {{toolVersion?:string, at?:string|number|Date}} [opts]
 * @returns {{version:number, toolVersion:string, at:string, files:Array<{path:string,bytes:number,sha256:string}>}}
 */
export function buildManifest(baseDir, files, opts = {}) {
  const base = path.resolve(String(baseDir));
  const at = opts.at instanceof Date ? opts.at.toISOString()
    : (typeof opts.at === 'number' ? new Date(opts.at).toISOString()
      : (typeof opts.at === 'string' && opts.at ? new Date(opts.at).toISOString() : new Date().toISOString()));
  const out = [];
  for (const f of Array.isArray(files) ? files : []) {
    const abs = path.isAbsolute(String(f)) ? path.resolve(String(f)) : path.resolve(base, String(f));
    let st;
    try { st = fs.statSync(abs); } catch (e) { throw new Error('要写进 manifest 的文件不存在：' + f); }
    if (!st.isFile()) throw new Error('要写进 manifest 的不是文件：' + f);
    out.push({ path: toRel(base, abs), bytes: st.size, sha256: sha256File(abs) });
  }
  if (!out.length) throw new Error('manifest 没有任何文件（拒绝生成空清单）');
  return {
    version: 1,
    toolVersion: opts.toolVersion || TOOL_VERSION,
    at,
    files: out,
  };
}

/** 原子写 manifest（同目录 tmp → rename）。返回写入路径。 */
export function writeManifest(baseDir, manifest, filename = MANIFEST_NAME) {
  const base = path.resolve(String(baseDir));
  const name = path.basename(String(filename || MANIFEST_NAME));
  if (!MANIFEST_RE.test(name)) throw new Error('manifest 文件名不合法：' + name);
  const file = path.join(base, name);
  fs.mkdirSync(base, { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 目录下所有候选 manifest，按 mtime 新→旧。 */
export function listManifests(baseDir) {
  const base = path.resolve(String(baseDir));
  let names = [];
  try { names = fs.readdirSync(base); } catch (e) { return []; }
  const rows = [];
  for (const n of names) {
    if (!MANIFEST_RE.test(n)) continue;
    const f = path.join(base, n);
    try {
      const st = fs.statSync(f);
      if (st.isFile()) rows.push({ file: f, mtimeMs: st.mtimeMs });
    } catch (e) { /* 并发删除忽略 */ }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows.map((r) => r.file);
}

/** 找最近的 manifest；没有返回 null。 */
export function findLatestManifest(baseDir) {
  const all = listManifests(baseDir);
  return all.length ? all[0] : null;
}

function bad(error) { return { ok: false, error: String(error || '未知错误') }; }

/**
 * 读 manifest。target 可以是 manifest 文件，也可以是目录（取最近一份）。
 * 永远不抛异常。
 * @returns {{ok:true,file:string,manifest:object}|{ok:false,error:string}}
 */
export function loadManifest(target) {
  const p = path.resolve(String(target || ''));
  let file = p;
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      file = findLatestManifest(p) || '';
      if (!file) return bad('目录里没有 manifest（找不到 manifest.json / manifest-*.json）：' + p);
    } else if (!st.isFile()) {
      return bad('不是文件也不是目录：' + p);
    }
  } catch (e) {
    return bad('找不到 manifest：' + p);
  }

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return bad('manifest 读不出来：' + file + '（' + e.message + '）'); }
  let m;
  try { m = JSON.parse(raw); } catch (e) { return bad('manifest 损坏（JSON 解析失败）：' + file + '（' + e.message + '）'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return bad('manifest 损坏（不是对象）：' + file);
  if (!Array.isArray(m.files)) return bad('manifest 损坏（缺 files 数组）：' + file);
  if (!m.files.length) return bad('manifest 是空的（files 数组为 0）：' + file);
  return { ok: true, file, manifest: m };
}

/**
 * 对照 manifest 逐个校验文件：存在、字节数、sha256。
 * 永远不抛异常。
 * @param {object} manifest
 * @param {string} baseDir
 * @returns {{ok:boolean,total:number,passed:number,failed:Array<{path:string,reason:string}>,at?:string,error?:string}}
 */
export function verifyManifest(manifest, baseDir) {
  const base = path.resolve(String(baseDir || ''));
  const files = manifest && Array.isArray(manifest.files) ? manifest.files : null;
  if (!files || !files.length) return { ok: false, total: 0, passed: 0, failed: [], error: 'manifest 没有 files' };
  const failed = [];
  let passed = 0;
  for (const ent of files) {
    const rel = ent && typeof ent.path === 'string' ? ent.path : '';
    if (!rel) { failed.push({ path: '(空路径)', reason: 'manifest 条目缺 path' }); continue; }
    // 拒绝 ../ 逃出备份目录：清单可能是从别处拷来的，不能让它读到外面
    const abs = path.resolve(base, rel);
    const relCheck = path.relative(base, abs);
    if (relCheck.startsWith('..' + path.sep) || relCheck === '..' || path.isAbsolute(relCheck)) {
      failed.push({ path: rel, reason: '路径越界（不在备份目录内）' });
      continue;
    }
    let st;
    try { st = fs.statSync(abs); } catch (e) { failed.push({ path: rel, reason: '文件缺失' }); continue; }
    if (!st.isFile()) { failed.push({ path: rel, reason: '不是文件' }); continue; }
    if (!Number.isFinite(Number(ent.bytes)) || Number(ent.bytes) < 0) {
      failed.push({ path: rel, reason: 'manifest 条目 bytes 非法' });
      continue;
    }
    if (st.size !== Number(ent.bytes)) {
      failed.push({ path: rel, reason: '字节数不符（期望 ' + Number(ent.bytes) + '，实际 ' + st.size + '）' });
      continue;
    }
    if (!SHA256_RE.test(String(ent.sha256 || ''))) {
      failed.push({ path: rel, reason: 'manifest 条目 sha256 非法' });
      continue;
    }
    let actual;
    try { actual = sha256File(abs); } catch (e) { failed.push({ path: rel, reason: '读文件失败：' + e.message }); continue; }
    if (actual !== String(ent.sha256).toLowerCase()) {
      failed.push({ path: rel, reason: 'sha256 不符（期望 ' + String(ent.sha256).slice(0, 12) + '…，实际 ' + actual.slice(0, 12) + '…）' });
      continue;
    }
    passed += 1;
  }
  return { ok: failed.length === 0, total: files.length, passed, failed, at: manifest.at || null };
}

/**
 * 一步到位：target 可以是 manifest 文件、备份目录（含 manifest）或旧式备份目录
 * （没有 manifest 时明确报错，不猜）。
 */
export function verifyTarget(target) {
  const loaded = loadManifest(target);
  if (!loaded.ok) return { ok: false, total: 0, passed: 0, failed: [], error: loaded.error, manifestFile: null };
  const base = path.dirname(loaded.file);
  const r = verifyManifest(loaded.manifest, base);
  return Object.assign({}, r, { manifestFile: loaded.file, toolVersion: loaded.manifest.toolVersion || null });
}

const DAY_MS = 24 * 3600 * 1000;

function ageDaysOf(ms, now) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.max(0, Math.floor((now - ms) / DAY_MS));
}

/**
 * doctor 用的轻量巡检（**不算 sha256**，只 stat；完整校验请跑 --verify）。
 * 约定目录里优先用最近 manifest；没有 manifest 时退回「最近 .enc 文件的 mtime」，
 * 这样加 E3 之前产生的旧备份也能显示新鲜度（标 legacy）。
 * @param {string} dir 备份目录
 * @param {{now?:number}} [opts]
 * @returns {{found:boolean,dir:string,reason?:string,legacy?:boolean,manifestFile?:string|null,at?:number,ageDays?:number|null,fileCount?:number,missing?:string[]}}
 */
export function inspectBackupDir(dir, opts = {}) {
  const base = path.resolve(String(dir || ''));
  const now = Number(opts.now) || Date.now();
  let st;
  try { st = fs.statSync(base); } catch (e) { return { found: false, dir: base, reason: '备份目录不存在' }; }
  if (!st.isDirectory()) return { found: false, dir: base, reason: '备份路径不是目录' };

  const manifestFile = findLatestManifest(base);
  if (manifestFile) {
    const loaded = loadManifest(manifestFile);
    if (loaded.ok) {
      const m = loaded.manifest;
      const parsed = Date.parse(String(m.at || ''));
      const at = Number.isFinite(parsed) ? parsed : (() => { try { return fs.statSync(manifestFile).mtimeMs; } catch (e) { return null; } })();
      const missing = [];
      for (const ent of m.files) {
        const rel = ent && typeof ent.path === 'string' ? ent.path : '';
        if (!rel) { missing.push('(空路径)'); continue; }
        const abs = path.resolve(base, rel);
        const relCheck = path.relative(base, abs);
        if (relCheck.startsWith('..' + path.sep) || path.isAbsolute(relCheck)) { missing.push(rel); continue; }
        if (!fs.existsSync(abs)) missing.push(rel);
      }
      return {
        found: true, dir: base, legacy: false, manifestFile,
        at, ageDays: ageDaysOf(at, now), fileCount: m.files.length, missing,
      };
    }
    // manifest 存在但坏了：不能静默退回 mtime（否则「坏清单」看起来一切正常）
    return { found: false, dir: base, reason: '最近的 manifest 损坏：' + loaded.error, manifestFile };
  }

  // 旧式备份：没有 manifest，用最近 .enc 的时间当新鲜度
  let names = [];
  try { names = fs.readdirSync(base); } catch (e) { names = []; }
  let newest = null;
  let count = 0;
  for (const n of names) {
    if (!/\.enc$/i.test(n)) continue;
    const f = path.join(base, n);
    try {
      const s = fs.statSync(f);
      if (!s.isFile()) continue;
      count += 1;
      if (!newest || s.mtimeMs > newest) newest = s.mtimeMs;
    } catch (e) { /* ignore */ }
  }
  if (!count) return { found: false, dir: base, reason: '目录里没有备份（没有 manifest，也没有 .enc）' };
  return {
    found: true, dir: base, legacy: true, manifestFile: null,
    at: newest, ageDays: ageDaysOf(newest, now), fileCount: count, missing: [],
  };
}
