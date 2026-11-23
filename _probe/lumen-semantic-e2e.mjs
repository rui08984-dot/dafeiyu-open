#!/usr/bin/env node
/**
 * _probe/lumen-semantic-e2e.mjs —— LumenAct 语义服务端到端（2026-11-17 六十五轮）
 *
 * 它自己**启动**服务、自己测、自己杀 —— 不依赖「你已经把 8120 起好了」。
 * 这样它既能进 CI（模型缺失时 SKIP），也能当本地体检用。
 *
 * 钉住：
 *   ① 服务能起来（冷启动含 146MB 模型加载，实测 11s 量级 → 给 60s）
 *   ② /health 报 ready 且模型名对
 *   ③ 三条明确样例判对（害羞 / 开心 / 反问）
 *   ④ 单次推理 < 60ms（实测 7–9ms；给 60ms 是留出机器抖动的余量）
 *   ⑤ 客户端映射表覆盖全部 27 类（否则会出现「模型认得、我们认不得」）
 *
 * 用法：node _probe/lumen-semantic-e2e.mjs
 * 退出码：0 通过/SKIP · 1 失败
 */

'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'pet-runtime', 'tools', 'lumen-semantic-server.py');
const MODELS = path.join(ROOT, '_research', 'lumenact', 'models');
const CFG = path.join(ROOT, '_research', 'lumenact', 'assets', 'semantic-config.json');
const PY = process.env.PET_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const PORT = 18120;   // 备用端口，避免撞线上 8120

const S = require(path.join(ROOT, 'pet-runtime', 'desktop', 'perf', 'lumen-semantic-client.cjs'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
  fail += 1;
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 资产缺失 → SKIP（146MB 权重在 gitignored 的 _research 里，CI 不该因此红）
  if (!fs.existsSync(path.join(MODELS, 'selector.onnx')) || !fs.existsSync(CFG)) {
    console.log('  · SKIP：缺 _research/lumenact 资产（见交接 §63 的下载命令）');
    console.log('  ✅ 语义服务 e2e：SKIP（0/0）');
    process.exit(0);
  }
  if (!fs.existsSync(PY)) {
    console.log('  · SKIP：找不到 Python（' + PY + '）');
    process.exit(0);
  }

  // ① 起服务
  const child = spawn(PY, ['-I', SERVER, '--port', String(PORT)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.stdout.on('data', () => { /* 启动日志不需要 */ });

  const url = 'http://127.0.0.1:' + PORT;
  let health = null;
  try {
    const t0 = Date.now();
    for (let i = 0; i < 120; i += 1) {
      await sleep(500);
      health = await S.health({ url, timeoutMs: 800 });
      if (health && health.ready === true) break;
      if (child.exitCode !== null) break;    // 进程已死，别等了
    }
    const bootMs = Date.now() - t0;
    ok('服务能起来并报 ready', !!(health && health.ready === true),
      health ? 'boot=' + bootMs + 'ms ready=' + health.ready : 'no health；stderr=' + stderr.slice(0, 200));
    if (!health || health.ready !== true) throw new Error('服务未就绪');

    ok('/health 模型名正确', /RBT3-Lumen/.test(String(health.model)), String(health.model));
    ok('/health 报出加载耗时', Number(health.loadedMs) > 0, health.loadedMs + 'ms');

    // ③ 样例判对
    const cases = [
      ['被夸了有点害羞', '你这样说我会不好意思的', ['害羞', '尴尬']],
      ['开心地打招呼', '早上好！今天也一起加油吧', ['大眼微笑', '微笑', '开心欢快']],
      ['反问质疑', '你确定是这样吗？', ['震惊疑惑质问', '惊讶震惊']],
    ];
    const lats = [];
    for (const [intent, text, expect] of cases) {
      const r = await S.classify({ url, intent, text, timeoutMs: 3000 });
      ok('判对「' + intent + '」', r.ok && expect.indexOf(r.category) >= 0,
        r.ok ? r.category + ' ' + Math.round(r.confidence * 100) + '% (voice=' + r.voice + ')' : r.error);
      if (r.ok && r.elapsedMs) lats.push(r.elapsedMs);
    }

    // ④ 延迟
    if (lats.length) {
      const max = Math.max(...lats);
      ok('单次推理 < 60ms', max < 60, 'lats=' + lats.join('/') + 'ms');
    }

    // ⑤ 映射覆盖
    const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    const labels = cfg.catalog.labels || [];
    const missing = labels.filter((l) => !S.CATEGORY_TO_EMOTION[l]);
    ok('客户端映射覆盖全部 ' + labels.length + ' 类', missing.length === 0, missing.join(','));
    const voices = cfg.catalog.speech_styles || [];
    const vMissing = voices.filter((v) => !S.VOICE_TO_PROSODY[v]);
    ok('语音风格映射覆盖全部 ' + voices.length + ' 类', vMissing.length === 0, vMissing.join(','));
  } finally {
    try { child.kill(); } catch (e) { /* 关不掉不影响结论 */ }
    await sleep(300);
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 语义服务 e2e：PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('  ✗ 探针异常：' + (e && e.message || e));
  console.log('  ❌ 语义服务 e2e：PASS ' + pass + ' / FAIL ' + (fail + 1));
  process.exit(1);
});
