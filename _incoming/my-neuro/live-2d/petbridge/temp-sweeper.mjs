// temp-sweeper.mjs —— 清「她自己产的」临时文件（白名单，不递归，不碰别人的东西）
//
// 为什么需要（2026-11-22 内存/磁盘长跑采样）：
//   · %TEMP%/pet-wgc：pet-core WGC 抓图默认落盘目录。实测 91 个 shot-*.bmp = 564MB，
//     最早的是 11-09，**没有任何清理策略**，日常用越久越大。
//   · %TEMP%/pet-screen-*.bmp：take-screenshot 的中间 BMP（15MB/张）。
//     主路径已改成 finally 删除，这里兜底清历史残留（失败路径留下的）。
//   · %TEMP%/pet-frame-trace-*.json：contentTracing 的 trace 文件（已 finally 删，兜底）。
//
// 纪律：
//   1) 只处理 rule.dir() 这一层目录，不递归；
//   2) 文件名必须严格匹配 rule.re（shot-<digits>.bmp 等），别的文件一概不碰；
//   3) 只删普通文件（symlink 跳过）；删除失败（被占用/权限）静默跳过，下轮再试；
//   4) 双保险：超过 maxAgeMs 的删；同时只保留最新 keepNewest 个（0 = 不留）。
//      这样即使有人高频调用也不会把盘写满，且最近一次任务用的图还在。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MB = 1024 * 1024;

export const SWEEP_RULES = [
  {
    id: 'TEMP/pet-wgc',
    dir: () => path.join(os.tmpdir(), 'pet-wgc'),
    // pet-core 自动落盘命名：shot-<unix ms>.bmp（见 pet-core/src/wgc.rs）
    re: /^shot-\d+\.bmp$/,
    maxAgeMs: 6 * 3600 * 1000,
    // 一张 2560×1600 BMP ≈ 5.4MB；留 12 张 ≈ 65MB 上限（一次多步操控最多回看最近几次截图）
    keepNewest: 12,
  },
  {
    id: 'TEMP/pet-screen',
    dir: () => os.tmpdir(),
    // 主进程 take-screenshot 的中间文件：pet-screen-<Date.now()>.bmp
    re: /^pet-screen-\d+\.bmp$/,
    maxAgeMs: 60 * 60 * 1000,
    keepNewest: 0,
  },
  {
    id: 'TEMP/pet-frame-trace',
    dir: () => os.tmpdir(),
    // 主进程帧探针 trace：pet-frame-trace-<pid>-<Date.now()>.json
    re: /^pet-frame-trace-\d+-\d+\.json$/,
    maxAgeMs: 24 * 3600 * 1000,
    keepNewest: 0,
  },
];

/**
 * 扫一轮。可注入 now/rules 便于单测。
 * @returns {Array<{id:string, matched:number, deleted:number, bytes:number, failed:number, missing?:boolean}>}
 */
export function sweepOnce({ now = Date.now(), log = () => {}, rules = SWEEP_RULES } = {}) {
  const report = [];
  for (const rule of rules) {
    let dir;
    try { dir = rule.dir(); } catch (e) { continue; }
    let names;
    try { names = fs.readdirSync(dir); } catch (e) {
      report.push({ id: rule.id, matched: 0, deleted: 0, bytes: 0, failed: 0, missing: true });
      continue;
    }

    const files = [];
    for (const name of names) {
      if (!rule.re.test(name)) continue;          // 白名单：名字必须严格匹配
      const p = path.join(dir, name);
      try {
        const st = fs.lstatSync(p);
        if (!st.isFile() || st.isSymbolicLink()) continue;   // 只删普通文件
        files.push({ p, size: st.size, mtimeMs: st.mtimeMs });
      } catch (e) { /* 读不到就跳过 */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);  // 最新在前

    let deleted = 0; let bytes = 0; let failed = 0;
    for (let i = 0; i < files.length; i += 1) {
      const f = files[i];
      const tooOld = now - f.mtimeMs > rule.maxAgeMs;
      const overKeep = Number.isFinite(rule.keepNewest) && i >= rule.keepNewest;
      if (!tooOld && !overKeep) continue;
      try { fs.unlinkSync(f.p); deleted += 1; bytes += f.size; }
      catch (e) { failed += 1; }                  // 被占用/权限不足：下一轮再试
    }
    report.push({ id: rule.id, matched: files.length, deleted, bytes, failed });
  }

  const cleaned = report.filter((r) => r.deleted > 0);
  if (cleaned.length) {
    try {
      log('[temp-sweeper] 清理 ' + cleaned
        .map((r) => r.id + ' ' + r.deleted + ' 个/' + (Math.round((r.bytes / MB) * 10) / 10) + 'MB')
        .join(' · '));
    } catch (e) { /* 日志失败不影响清理 */ }
  }
  return report;
}

/**
 * 启动周期清理：默认导入后立刻扫一次，之后每 6 小时一次（定时器 unref，不阻止退出）。
 * @returns {{stop:Function, run:Function}}
 */
export function startTempSweeper({ intervalMs = 6 * 3600 * 1000, immediateDelayMs = 0, log = console.log } = {}) {
  const run = () => {
    try { return sweepOnce({ log }); }
    catch (e) { try { log('[temp-sweeper] 失败: ' + (e && e.message || e)); } catch (e2) {} return null; }
  };
  let first = null;
  if (immediateDelayMs > 0) {
    first = setTimeout(run, immediateDelayMs);
    if (first.unref) first.unref();
  } else {
    run();
  }
  const timer = setInterval(run, Math.max(60 * 1000, Number(intervalMs) || 6 * 3600 * 1000));
  if (timer.unref) timer.unref();
  return {
    run,
    stop() { try { if (first) clearTimeout(first); } catch (e) {} try { clearInterval(timer); } catch (e) {} },
  };
}
