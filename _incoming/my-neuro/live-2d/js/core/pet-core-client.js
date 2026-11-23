/**
 * js/core/pet-core-client.js — pet-core 常驻客户端（2026-11-14 四十八轮续）
 *
 * 为什么要有它：pet-core 原来**每次动作 spawn 一次进程**，实测
 *   一次性 50.3ms/次 → 常驻 6.4ms/次（首次 55ms，之后 **1ms**），约 8 倍。
 *   而鼠标/键盘/UIA 这些热路径本身只要 1–40ms —— 进程启动占了一半以上。
 *   参考：ZCode CUA 的 Helper 也是常驻的（`HELPER_UNAVAILABLE` / 冷启动 not-ready 就是证据）。
 *
 * 协议：`pet-core serve` 从 stdin 读**一行一个 JSON**，往 stdout 写**一行一个响应**。
 *   - 串行：一条 stdout 通道，请求必须排队（本模块内部排队，调用方不用管）
 *   - 退出：EOF 或 `__quit__`
 *
 * 设计要点：
 *   1. **懒启动**：第一次 call 才 spawn，进程没起来不占资源
 *   2. **单例**：全进程一个子进程（getClient()），避免多份 reader 抢 stdout
 *   3. **超时即重启**：请求超时会 kill 子进程 —— 因为管道里可能堆积了半截响应，
 *      继续用会把后面的请求全部错位（错位的响应比超时危险得多）
 *   4. **降级**：spawn 失败/二进制不存在时退回 execFileSync 一次性调用，
 *      保证「常驻坏了功能还在，只是慢」（不静默：console.warn 一次）
 *   5. **退出清理**：父进程 exit 时 kill，避免留下孤儿进程
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DEFAULT_TIMEOUT = 8000;

/** 找 pet-core 二进制（沿目录树向上找含 pet-runtime 的根，不数层级） */
function resolvePetCoreBin(startDir) {
  let dir = path.resolve(startDir || __dirname);
  for (let i = 0; i < 10; i += 1) {
    for (const cand of [
      path.join(dir, 'pet-core', 'target', 'release', 'pet-core.exe'),
      path.join(dir, 'pet-core', 'target', 'release', 'pet-core'),
      path.join(dir, 'pet-core', 'target', 'debug', 'pet-core.exe'),
      path.join(dir, 'pet-core', 'target', 'debug', 'pet-core'),
    ]) {
      try { if (fs.existsSync(cand)) return cand; } catch (e) { /* 权限/不存在都跳过 */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '';
}

class PetCoreClient {
  constructor(options = {}) {
    this.bin = options.bin || resolvePetCoreBin(options.startDir);
    this.timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT;
    this._child = null;
    this._buf = '';
    this._inflight = null;    // { resolve, reject, timer, req, startedAt }
    this._queue = [];         // 排队中的请求
    this._warnedFallback = false;
    this._closed = false;
    this._spawnedAt = 0;
    this._served = 0;         // 这个子进程已经处理了几个请求（诊断用）
    if (this.bin) {
      // 父进程退出时收尾（process 上没有 'exit' 的异步机会，只能同步 kill）
      process.once('exit', () => { try { this.close(); } catch (e) { /* 退出路径不抛 */ } });
    }
  }

  get isRunning() { return !!(this._child && !this._child.killed); }

  /**
   * 发一个请求，返回解析后的 JSON。
   * 永不抛「进程不存在」以外的错 —— 调用方要按 `r.ok` 判断业务成败。
   */
  call(req, timeoutMs) {
    const t = Number(timeoutMs) || this.timeoutMs;
    if (!this.bin) {
      // 没有二进制：走一次性路径也没意义，直接如实返回
      return Promise.resolve({ ok: false, error: 'pet-core 二进制不存在（先 cargo build --release）' });
    }
    return new Promise((resolve, reject) => {
      const job = { line: JSON.stringify(req), resolve, reject, timer: null, startedAt: Date.now(), req, timeout: t };
      this._queue.push(job);
      this._pump();
      // 注意：超时不在这里挂，而是在真正发出去时挂 —— 排队等待的时间不该算进请求超时
    });
  }

  _pump() {
    if (this._inflight || !this._queue.length) return;
    if (!this.isRunning) {
      this._spawn();
      if (!this.isRunning) return;   // spawn 失败 → 由 _rejectAll 立即回绝
    }
    const job = this._queue.shift();
    this._inflight = job;
    job.timer = setTimeout(() => this._onTimeout(), Number(job.timeout) || this.timeoutMs);
    try {
      this._child.stdin.write(job.line + '\n');
    } catch (e) {
      // 管道断了（子进程刚死）：当失败，重启
      this._finish(job, { ok: false, error: 'pet-core 管道写入失败：' + (e && e.message || e) });
      this._killChild('write-failed');
    }
  }

  _spawn() {
    if (!this.bin) return;
    try {
      // 2026-11-22 内存/进程采样：把本进程 pid 交给 pet-core，父进程一死它自己退。
      // 原来只靠 stdin EOF / process.once('exit') —— 硬杀（崩溃/forcefullyCrashRenderer/
      // taskkill）时这两条不保证生效（本机用 Node 复现时 EOF 会到，未见孤儿；但 EOF
      // 跨 Electron 版本不可依赖）。父句柄等待是无条件成立的兜底。
      const ch = spawn(this.bin, ['serve', '--parent-pid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      ch.stdout.setEncoding('utf8');
      ch.stderr.setEncoding('utf8');
      let stderrTail = '';
      ch.stdout.on('data', (d) => this._onData(d));
      ch.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d).slice(-800);   // 只留尾部：崩了要能看到原因
      });
      ch.on('error', (e) => {
        this._child = null;
        this._rejectAll({ ok: false, error: 'pet-core 启动失败：' + (e && e.message || e) });
      });
      ch.on('exit', (code, signal) => {
        this._child = null;
        const detail = stderrTail.trim();
        this._rejectAll({
          ok: false,
          error: 'pet-core serve 退出（code=' + code + (signal ? ' signal=' + signal : '') + '）'
            + (detail ? '：' + detail.slice(0, 300) : ''),
        });
      });
      this._child = ch;
      this._buf = '';
      this._spawnedAt = Date.now();
      this._served = 0;
    } catch (e) {
      this._child = null;
      this._rejectAll({ ok: false, error: 'pet-core spawn 异常：' + (e && e.message || e) });
    }
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      const job = this._inflight;
      if (!job) {
        // 没有在等的请求却有响应 —— 上一次超时留下的残包，丢掉
        continue;
      }
      this._inflight = null;
      this._served += 1;
      if (job.timer) clearTimeout(job.timer);
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        parsed = { ok: false, error: 'pet-core 响应不是 JSON：' + line.slice(0, 200) };
      }
      parsed._ms = Date.now() - job.startedAt;
      job.resolve(parsed);
      this._pump();
    }
  }

  _onTimeout() {
    const job = this._inflight;
    this._inflight = null;
    if (job) {
      this._finish(job, { ok: false, error: 'pet-core 超时（' + Math.round((Date.now() - job.startedAt)) + 'ms）—— 已重启内核', timeout: true });
    }
    // ⚠ 必须重启：管道里可能还有半截响应，留着会把后续请求的响应错位
    this._killChild('timeout');
    this._pump();
  }

  _finish(job, value) {
    if (job.timer) clearTimeout(job.timer);
    value._ms = value._ms || (Date.now() - job.startedAt);
    job.resolve(value);
  }

  _rejectAll(value) {
    const pending = [];
    if (this._inflight) { pending.push(this._inflight); this._inflight = null; }
    for (const j of this._queue.splice(0)) pending.push(j);
    for (const job of pending) this._finish(job, Object.assign({}, value));
  }

  _killChild(reason) {
    const ch = this._child;
    this._child = null;
    this._buf = '';
    if (!ch) return;
    try { ch.stdin.end(); } catch (e) { /* 已关 */ }
    try { ch.kill(); } catch (e) { /* 已死 */ }
    void reason;
  }

  /** 同步一次性调用（降级路径：常驻不可用时别让功能整个瘫掉） */
  callOnce(req, timeoutMs) {
    if (!this.bin) return { ok: false, error: 'pet-core 二进制不存在' };
    if (!this._warnedFallback) {
      this._warnedFallback = true;
      console.warn('[pet-core] 常驻模式不可用，退回一次性 spawn（会慢约 8 倍）');
    }
    const t0 = Date.now();
    try {
      const out = execFileSync(this.bin, [], {
        input: JSON.stringify(req),
        timeout: Number(timeoutMs) || this.timeoutMs,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      const d = JSON.parse(String(out || '{}'));
      d._ms = Date.now() - t0;
      return d;
    } catch (e) {
      return { ok: false, error: 'pet-core 一次性调用失败：' + (e && e.message || e), _ms: Date.now() - t0 };
    }
  }

  stats() {
    return {
      bin: this.bin,
      running: this.isRunning,
      uptimeMs: this._spawnedAt ? Date.now() - this._spawnedAt : 0,
      served: this._served,
      queued: this._queue.length,
      inflight: !!this._inflight,
    };
  }

  close() {
    this._closed = true;
    this._rejectAll({ ok: false, error: 'pet-core 客户端已关闭' });
    this._killChild('close');
  }
}

// ── 单例 ─────────────────────────────────────────────────────────────────
let _client = null;

/** 取全局客户端（懒创建）。options 只在第一次生效。 */
function getClient(options = {}) {
  if (!_client) _client = new PetCoreClient(options);
  return _client;
}

/** 测试/重启用：关掉当前客户端，下次 getClient 重新创建 */
function resetClient() {
  if (_client) { try { _client.close(); } catch (e) { /* 关闭失败不影响重建 */ } }
  _client = null;
}

module.exports = {
  PetCoreClient,
  getClient,
  resetClient,
  resolvePetCoreBin,
};
