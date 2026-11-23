#!/usr/bin/env node
// _probe/voice-style-inert.mjs —— 证明「语义语气层默认关闭时，请求体里根本没有 prosody_gain」
//
// 为什么不用 mock：mock 掉 fetch 只能证明「我以为我发的 body」，证明不了线上真发的是什么。
// 这里起一个**本地假 TTS**（127.0.0.1:19883，只收 /tts、记录 body、回 4 字节假音频），
// 然后用**真实的** TTSRequestHandler.convertTextToSpeech 走完整构造链，观察 TCP 上实际收到的 JSON。
//
// 五种情况（同一句话，除 voice_style 配置外完全相同）：
//   A   voice_style.enabled = false          → 无 prosody_gain
//   A2  A 重跑一次                            → 与 A 逐字节相同（证明请求体本身确定）
//   D0  config 里没有 voice_style 段（真默认）  → 无 prosody_gain
//   B   启用但无语义结果                       → 无 prosody_gain
//   C   启用 + 置信度 0.3（低于门槛 0.5）       → 无 prosody_gain
//   D'  启用 + 置信度 0.9 + voice=joyful       → 有，且 rate/pitch/energy ∈ [0.9,1.1]
//
// 易变字段：先看实际 body 有什么，再把已知易变键（id/时间戳/nonce…）从比较中剔除后比较；
// 当前实现的 body 只有 text/text_language/speed_factor，无任何易变字段，故同时断言原始 bytes 相同。
//
// 用法：node _probe/voice-style-inert.mjs
// 约束：只监听 19883；不碰 9883（真实 TTS）、8103（宿主）；结束必关假服务。

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const require = createRequire(import.meta.url);

const PORT = 19883;
const FAKE_URL = `http://127.0.0.1:${PORT}/tts`;
// 无标点、无括号、无星号：convertTextToSpeech 的清洗不会改写它，
// 而 _attachVoiceGain 用的是**原文**，所以 ingest 与 apply 的锚点必须是同一串。
const TEXT = '今天真开心';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + name + (detail ? ' — ' + detail : ''));
  } else {
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
  return Boolean(cond);
}

const { TTSRequestHandler } = require(path.join(APP, 'js', 'voice', 'tts-request-handler.js'));
const voiceStyle = require(path.join(APP, 'js', 'core', 'voice-style.js'));

// ── 假 TTS ────────────────────────────────────────────────────────────────
const captured = [];
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    captured.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      raw: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    res.end(Buffer.from([0xff, 0xf1, 0x00, 0x00]));
  });
});

// ── 比较口径 ──────────────────────────────────────────────────────────────
// 当前实现里这些键一个都不出现；留着是为了「以后有人加了时间戳」时比较仍成立，
// 同时下面单独断言它们现在确实不存在（这决定将来能不能做重放/缓存）。
const VOLATILE_KEYS = ['id', 'request_id', 'requestId', 'timestamp', 'ts', 'nonce',
  'trace_id', 'session_id', 'created_at', 'time'];

function normalize(raw) {
  const o = JSON.parse(raw);
  for (const k of VOLATILE_KEYS) if (k in o) delete o[k];
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return JSON.stringify(out);
}

function baseConfig(voiceStyleCfg) {
  const cfg = {
    tts: { language: 'zh', speed_factor: 1, backend: 'edge', url: FAKE_URL },
  };
  if (voiceStyleCfg !== undefined) cfg.voice_style = voiceStyleCfg;
  return cfg;
}

async function sendCase(label, { voiceStyleCfg, prepare } = {}) {
  voiceStyle.reset({ stats: true });
  const prep = prepare ? prepare() : undefined;
  const handler = new TTSRequestHandler(baseConfig(voiceStyleCfg), FAKE_URL);
  const before = captured.length;
  const blob = await handler.convertTextToSpeech(TEXT);
  const rec = captured[before];
  if (!rec) throw new Error(`${label}: 假 TTS 没收到请求（转换链提前返回了？）`);
  if (captured.length !== before + 1) {
    throw new Error(`${label}: 一次调用发了 ${captured.length - before} 个请求`);
  }
  return { label, rec, blob, prep, body: JSON.parse(rec.raw) };
}

(async () => {
  const guard = setTimeout(() => {
    console.error('  ✗ 探针超时（30s）：假 TTS 未被调用或请求挂起');
    process.exit(1);
  }, 30000);
  guard.unref();

  await new Promise((resolve, reject) => {
    fake.once('error', reject);
    fake.listen(PORT, '127.0.0.1', resolve);
  }).catch((e) => {
    console.error(`  ✗ 无法监听 127.0.0.1:${PORT}（${e.code || e.message}）。`
      + '请先腾出端口；本探针绝不占用 9883/8103，也不会去停真实服务。');
    process.exit(1);
  });

  try {
    // 四种「应当无字段」的情况
    const a = await sendCase('A enabled=false', { voiceStyleCfg: { enabled: false } });
    const a2 = await sendCase('A2 enabled=false 重跑', { voiceStyleCfg: { enabled: false } });
    const d0 = await sendCase('D0 无 voice_style 段', {});
    const b = await sendCase('B 启用但无语义结果', { voiceStyleCfg: { enabled: true } });
    const c = await sendCase('C 启用+置信度 0.3', {
      voiceStyleCfg: { enabled: true },
      prepare: () => {
        voiceStyle.configure({ enabled: true });
        return voiceStyle.ingestSemantic(
          { ok: true, voice: 'joyful', confidence: 0.3 },
          { text: TEXT },
        );
      },
    });
    // 唯一「应当有字段」的情况
    const d = await sendCase('D 启用+置信度 0.9+joyful', {
      voiceStyleCfg: { enabled: true },
      prepare: () => {
        voiceStyle.configure({ enabled: true });
        return voiceStyle.ingestSemantic(
          { ok: true, voice: 'joyful', confidence: 0.9 },
          { text: TEXT },
        );
      },
    });

    // ① 假服务确实收到了真实请求（否则后面所有「没有字段」都是假绿）
    ok('假 TTS 收到 POST /tts', a.rec.method === 'POST' && a.rec.url === '/tts',
      `${a.rec.method} ${a.rec.url}`);
    ok('响应是音频字节流（转换链走完）', a.blob && a.blob.size === 4,
      a.blob ? `${a.blob.size} bytes` : 'null');

    // ② 基线 body 的真实形状（这决定将来能否重放/缓存）
    const keysA = Object.keys(a.body);
    console.log('  · 基线 body 字段: ' + keysA.join(', ')
      + '；原始 bytes = ' + Buffer.byteLength(a.rec.raw, 'utf8'));
    ok('基线 body 只有 text/text_language/speed_factor',
      keysA.length === 3
      && keysA.includes('text') && keysA.includes('text_language') && keysA.includes('speed_factor'),
      keysA.join(','));
    ok('基线 text 与入参一致', a.body.text === TEXT, JSON.stringify(a.body.text));
    const volatilePresent = VOLATILE_KEYS.filter((k) => k in a.body);
    ok('基线没有任何易变字段（id/时间戳/nonce…）', volatilePresent.length === 0,
      volatilePresent.length ? volatilePresent.join(',') : '无');

    // ③ 默认关闭：A / A2 / D0 / B / C 都没有该字段
    ok('A（enabled=false）没有 prosody_gain', !('prosody_gain' in a.body));
    ok('A2（重跑）没有 prosody_gain', !('prosody_gain' in a2.body));
    ok('D0（config 无 voice_style 段）没有 prosody_gain', !('prosody_gain' in d0.body));
    ok('B（启用但无语义结果）没有 prosody_gain', !('prosody_gain' in b.body));
    ok('C（启用+置信度 0.3）ingest 被拒', c.prep === false, String(c.prep));
    ok('C 没有 prosody_gain', !('prosody_gain' in c.body));

    // ④ 「零变化」的两种口径
    ok('A 两次原始 bytes 完全相同', a.rec.raw === a2.rec.raw,
      a.rec.raw === a2.rec.raw ? '逐字节相同' : `${a.rec.raw} ≠ ${a2.rec.raw}`);
    const inert = [a, d0, b, c];
    const rawSame = inert.every((x) => x.rec.raw === a.rec.raw);
    ok('A/D0/B/C 原始 bytes 与基线完全相同', rawSame,
      rawSame ? '逐字节相同' : inert.map((x) => x.label).join(' / '));
    const normSame = inert.every((x) => normalize(x.rec.raw) === normalize(a.rec.raw));
    ok('A/D0/B/C 归一化（剔除易变键后）也相同', normSame);

    // ⑤ 探针的灵敏度：D 必须能看见字段（否则「没有」可能只是探针瞎）
    const g = d.body.prosody_gain;
    ok('D（0.9+joyful）出现 prosody_gain', !!g && typeof g === 'object',
      JSON.stringify(g));
    if (g) {
      const inBand = [g.rate, g.pitch, g.energy].every((v) => Number(v) >= 0.9 && Number(v) <= 1.1);
      ok('D 的 rate/pitch/energy 都在 [0.9,1.1]', inBand,
        `rate=${g.rate} pitch=${g.pitch} energy=${g.energy}`);
      const near = (x, y) => Math.abs(Number(x) - y) < 1e-9;
      ok('D 的值等于 joyful 映射（1.06/1.08/1.08）',
        near(g.rate, 1.06) && near(g.pitch, 1.08) && near(g.energy, 1.08),
        JSON.stringify(g));
    }
    ok('D 的归一化结果与基线不同（字段确实进入了请求体）',
      normalize(d.rec.raw) !== normalize(a.rec.raw));
  } finally {
    voiceStyle.reset({ stats: true });
    try { fake.closeAllConnections?.(); } catch (e) { /* 老 node 没有，忽略 */ }
    await new Promise((resolve) => fake.close(() => resolve()));
  }

  console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 语义语气默认关闭 = 请求体零变化：'
    + `PASS ${pass} / FAIL ${fail}`);
  // 不用 process.exit()：Windows + Node 24 下，fetch 的 undici 句柄还在收尾时强退
  // 会触发 libuv 断言（async.c:94），退出码变成 127 —— 明明 PASS 却把门禁判红。
  // 设 exitCode 让事件循环自然排空即可；假服务已 close，keep-alive 不会一直吊着进程。
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((e) => {
  console.error('  ✗ 探针中断：' + (e && e.message || e));
  process.exitCode = 1;
});
