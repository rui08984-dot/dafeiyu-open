#!/usr/bin/env node
/**
 * _probe/ensure-control-center.mjs — 门禁里「按需拉起控制中心」，跑完再收掉（2026-11-18 §75 / §68 B18）
 *
 * 问题：控制中心是**独立 Electron 进程**（托盘「打开设置」才起），它顺手在 127.0.0.1:8771
 * 挂了自检口。门禁里两条 UI 验收（按钮真实点击 / 能力注册表接前端）靠这个口，所以
 * 平时没人开面板时它们只能 SKIP —— 而且现在有了陈旧度台账，这两项会一直挂在「从未通过」。
 *
 * 做法：门禁开始时探一下 8771；不通就**自己拉起**（和 main.js 的 openControlCenter 同一套：
 * electron control-main.js），等到口子能应答；跑完门禁再把「我们自己起的那个」杀掉。
 * 用户本来就开着的话一个字节都不动它（不抢、不杀）。
 *
 * 为什么不做成常驻服务：它是个 520×720 的可见窗口，常驻等于给用户桌面多加一个窗口；
 * 只在需要验证的那几分钟活着才是对的。
 */

import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_PORT = 8771;

/** 8771 能不能应答 /bounds（800ms 内） */
export function probeControlCenter(port = DEFAULT_PORT, timeoutMs = 800) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/bounds', method: 'GET', timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done(Boolean(j && j.bounds));
        } catch (e) { done(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
    req.end();
  });
}

/**
 * 确保控制中心在跑（不在就拉起并等待）。
 * @param {{appDir:string, electronExe?:string, port?:number, timeoutMs?:number, log?:Function}} opts
 * @returns {Promise<{ok:boolean, started:boolean, pid:number|null, error?:string}>}
 */
export async function ensureControlCenter(opts) {
  const o = opts || {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const port = Number(o.port) || DEFAULT_PORT;
  const timeoutMs = Number(o.timeoutMs) || 25000;
  const appDir = o.appDir;
  if (!appDir) return { ok: false, started: false, pid: null, error: '缺 appDir' };

  if (await probeControlCenter(port, 600)) return { ok: true, started: false, pid: null };

  const electronExe = o.electronExe || path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
  let child;
  try {
    child = spawn(electronExe, [path.join(appDir, 'control-main.js')], {
      cwd: appDir,
      env: { ...process.env, PET_CONTROL_DEVTOOLS_PORT: String(port) },
      detached: true,
      stdio: 'ignore',
      windowsHide: false,   // 面板要真的渲染出 DOM，自检口才有东西可点
    });
    child.unref();
  } catch (error) {
    return { ok: false, started: false, pid: null, error: '拉起失败：' + ((error && error.message) || error) };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    if (await probeControlCenter(port, 600)) {
      log('[control-center] 已为门禁拉起（pid=' + child.pid + '，跑完会关掉）');
      return { ok: true, started: true, pid: child.pid || null };
    }
  }
  // 起不来：把它留给排查（别静默），并如实返回
  return {
    ok: false, started: true, pid: child.pid || null,
    error: `等了 ${timeoutMs}ms 8771 仍不应答（面板可能起不来：看 Electron 是否被杀软拦、或 8771 被占）`,
  };
}

/**
 * 收掉「我们起的」那个面板（/T 连子进程；用户自己开的不动）。
 * @param {number|null} pid
 * @returns {{ok:boolean, error?:string}}
 */
export function stopControlCenter(pid) {
  if (!pid) return { ok: true };
  try {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    if (r.status === 0) return { ok: true };
    return { ok: false, error: String((r.stderr || r.stdout || '').trim() || ('taskkill exit ' + r.status)) };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

export { DEFAULT_PORT };
