/**
 * mod-provider.js — 进程内观测（Mod 导出）通道的接收端（2026-11-14 五十三轮）
 *
 * 背景（第一性原理）：状态有四档来源，离源头越近越准：
 *   进程内 Mod（100%） > 内存读取（~100%，高风险） > API/协议（95%） > 视觉（60-90%）
 * 视觉永远在（它是唯一能验证「动作生效」的通道），但**只要游戏能给出精确数据，就该用它**。
 *
 * 这个文件只管一件事：**从游戏里的 Mod 收 JSON 行，翻译成事实表里的 fact**。
 * Mod 那边（Java/C#/任何语言）只要往 127.0.0.1:<port> 按行发 JSON 就行，协议见下。
 *
 * 线路协议（一行一个 JSON，UTF-8，\n 分隔）：
 *   {"t": 1731600000000,            // 采样时刻（ms，可省，省了用收到的时间）
 *    "hp": 18.0, "maxHp": 20,       // 生命值
 *    "food": 17,                    // 饥饿值（0-20）
 *    "x": 12.3, "y": 64.0, "z": -8.1,
 *    "dim": "minecraft:overworld",
 *    "entities": [{"type":"minecraft:zombie","dist":3.2,
 *                 "yawDelta":12.5,"pitchDelta":-3.0}, ...],  // 类型/距离/准星偏差(度)
 *    "inventory": [{"slot":0,"id":"minecraft:bread","count":3}]   // 可选
 *   }
 *
 * 设计取舍：
 *   · **TCP 而不是写文件**：文件要轮询、要处理半写、还会把磁盘搅热；TCP 一收到就能用
 *   · **一行一 JSON**：好调试（`nc 127.0.0.1 8123` 直接看），也让 Mod 侧实现最简单
 *   · **连不上不影响别的通道**：这就是事实表存在的意义 —— mod 掉线，视觉继续顶着
 */
'use strict';

const net = require('net');

/** 默认 8123：避开项目已占的端口（3003 遥控 / 8003 MemOS / 8004 devtools / 8103 控制 / 9883 TTS / 1000 ASR） */
const DEFAULT_PORT = 8123;

/**
 * 建一个 Mod 通道接收端。
 * @param {object} opts
 * @param {object} opts.facts   fact-store 实例（必须）
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {function} [opts.log]  logger(msg)
 * @param {number} [opts.staleAfterMs] 多久没数据就认为 Mod 通道沉默（默认 3000）
 */
function createModProvider(opts) {
  const o = opts || {};
  const facts = o.facts;
  if (!facts) throw new Error('createModProvider 需要 facts（fact-store 实例）');
  const port = Number(o.port) || DEFAULT_PORT;
  const host = String(o.host || '127.0.0.1');
  const log = typeof o.log === 'function' ? o.log : () => {};
  const staleAfterMs = Number(o.staleAfterMs) || 3000;

  let server = null;
  let sock = null;
  let buf = '';
  let lastAt = 0;
  let lines = 0;
  let parseErrs = 0;
  let lastErr = '';
  const startedAt = Date.now();

  /** 一条 Mod 数据 → 事实（全部 source='mod'，conf 0.99：进程内读的，准） */
  function ingest(msg, recvAt) {
    const t = Number.isFinite(msg.t) ? Number(msg.t) : recvAt;
    const META = { source: 'mod', conf: 0.99 };
    // 生命值：优先 hp/maxHp 归一化；只给 hp 时按 MC 默认 20 归一化
    if (Number.isFinite(msg.hp)) {
      const max = Number.isFinite(msg.maxHp) && msg.maxHp > 0 ? msg.maxHp : 20;
      facts.set('player.hp', Math.max(0, Math.min(1, msg.hp / max)), Object.assign({ ttlMs: 900, at: t }, META));
      if (max !== 20) facts.set('player.maxHp', max, Object.assign({ ttlMs: 60000, at: t }, META));
    }
    if (Number.isFinite(msg.food)) {
      facts.set('player.food', Math.max(0, Math.min(1, msg.food / 20)), Object.assign({ ttlMs: 1200, at: t }, META));
    }
    // 坐标拆成三根数值事实（2026-11-14 审计：写成对象时浮点抖动每帧都会误报 conflict，
    // 而且规则里没法直接写 `player.y < 60`）
    if (Number.isFinite(msg.x)) facts.set('player.x', msg.x, Object.assign({ ttlMs: 900, at: t }, META));
    if (Number.isFinite(msg.y)) facts.set('player.y', msg.y, Object.assign({ ttlMs: 900, at: t }, META));
    if (Number.isFinite(msg.z)) facts.set('player.z', msg.z, Object.assign({ ttlMs: 900, at: t }, META));
    if (msg.dim) facts.set('world.dimension', String(msg.dim), Object.assign({ ttlMs: 5000, at: t }, META));
    // 视角（度）：有了它就能**用数据标定**「鼠标移动多少像素 = 转多少度」，
    // 不用猜 pxPerDeg —— 每个游戏/每个灵敏度都不一样，这是数据不是代码。
    if (Number.isFinite(msg.yaw)) facts.set('player.yaw', msg.yaw, Object.assign({ ttlMs: 500, at: t }, META));
    if (Number.isFinite(msg.pitch)) facts.set('player.pitch', msg.pitch, Object.assign({ ttlMs: 500, at: t }, META));
    if (Array.isArray(msg.entities)) {
      const list = msg.entities.filter((e) => e && Number.isFinite(e.dist));
      facts.set('enemy.count', list.length, Object.assign({ ttlMs: 700, at: t }, META));
      if (list.length) {
        const near = list.reduce((a, b) => (b.dist < a.dist ? b : a), list[0]);
        facts.set('enemy.nearest.dist', near.dist, Object.assign({ ttlMs: 700, at: t }, META));
        if (near.type) facts.set('enemy.nearest.type', String(near.type), Object.assign({ ttlMs: 700, at: t }, META));
        // 准星偏差（度）：Mod 能算出「目标相对于当前视线的角度」—— 这比视觉质心准得多，
        // 而且是**无需看着屏幕**就能瞄准的唯一数据源。视觉得到的是像素质心，还要换算视角。
        if (Number.isFinite(near.yawDelta)) {
          facts.set('enemy.nearest.yawDelta', near.yawDelta, Object.assign({ ttlMs: 300, at: t }, META));
        }
        if (Number.isFinite(near.pitchDelta)) {
          facts.set('enemy.nearest.pitchDelta', near.pitchDelta, Object.assign({ ttlMs: 300, at: t }, META));
        }
        // 偏离准星多少度（取 yaw/pitch 绝对值里大的那个）——
        // 规则的 if 不支持括号，先把「需不需要瞄」算成一个数，规则就能写
        // `enemy.nearest.dist <= 4.5 && enemy.nearest.offAim > 6`
        if (Number.isFinite(near.yawDelta) || Number.isFinite(near.pitchDelta)) {
          const off = Math.max(Math.abs(Number(near.yawDelta) || 0), Math.abs(Number(near.pitchDelta) || 0));
          facts.set('enemy.nearest.offAim', Math.round(off * 10) / 10, Object.assign({ ttlMs: 300, at: t }, META));
        }
      }
    }
    if (Array.isArray(msg.inventory)) {
      facts.set('player.inventory', msg.inventory, Object.assign({ ttlMs: 2000, at: t }, META));
    }
    lastAt = Date.now();
  }
  // 给单测/离线回放用：直接喂一条（不走 socket）
  ingest.feed = ingest;

  const MAX_BUF = 1024 * 1024;   // 1MB：一行 JSON 撑不到这么大，超了就是坏客户端
  function onData(chunk) {
    buf += chunk;
    if (buf.length > MAX_BUF) {
      // 不静默：记错并掐断这条连接（重新连上会走正常路径）
      parseErrs += 1;
      lastErr = '单行超过 ' + MAX_BUF + ' 字节（可能不是 NDJSON 客户端），已断开';
      try { if (sock) sock.destroy(); } catch (e) { /* 已断 */ }
      buf = '';
      return;
    }
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        ingest(JSON.parse(line), Date.now());
        lines += 1;
      } catch (e) {
        // 坏行不静默：计数 + 记最后一次原因（Mod 侧格式错要能看出来）
        parseErrs += 1;
        lastErr = String((e && e.message) || e).slice(0, 120);
      }
    }
  }

  function start() {
    if (server) return Promise.resolve(true);
    return new Promise((resolve) => {
      try {
        server = net.createServer((c) => {
          // ⚠ 2026-11-14 审计：原来直接 destroy 旧连接 —— 双开/重连时事实会**静默换局**。
          //   现在明确记一条，并且只让最新的连接生效（旧的断开，日志可查）。
          if (sock && !sock.destroyed) {
            log('[mod] 有新的连接进来，顶掉旧连接（旧连接可能还活着）');
            try { sock.destroy(); } catch (e) { /* 旧连接已断 */ }
          }
          sock = c;
          buf = '';
          c.setEncoding('utf8');
          c.on('data', onData);
          c.on('error', (e) => { lastErr = 'socket: ' + String((e && e.message) || e); });
          c.on('close', () => { if (sock === c) sock = null; });
          log('[mod] 游戏连上来了');
        });
        server.on('error', (e) => {
          lastErr = 'listen: ' + String((e && e.message) || e);
          log('[mod] 端口占用或不可用：' + lastErr);
          resolve(false);
        });
        server.listen(port, host, () => {
          log('[mod] 等待游戏连接 127.0.0.1:' + port);
          resolve(true);
        });
      } catch (e) {
        lastErr = String((e && e.message) || e);
        resolve(false);
      }
    });
  }

  function stop() {
    try { if (sock && !sock.destroyed) sock.destroy(); } catch (e) { /* 已断 */ }
    sock = null;
    try { if (server) server.close(); } catch (e) { /* 已关 */ }
    server = null;
    buf = '';
  }

  /** 通道健康（给安全闸/诊断用）：连着没、多久没数据、有没有解析错误 */
  function health() {
    const age = lastAt ? Date.now() - lastAt : Infinity;
    return {
      name: 'mod',
      listening: !!server,
      connected: !!(sock && !sock.destroyed),
      lastAt: lastAt || null,
      ageMs: Number.isFinite(age) ? age : null,
      silent: !lastAt || age > staleAfterMs,
      lines, parseErrs, lastErr,
      uptimeMs: Date.now() - startedAt,
    };
  }

  return { name: 'mod', facts, port, start, stop, health, ingest, _onData: onData };
}

module.exports = { createModProvider, DEFAULT_PORT };
