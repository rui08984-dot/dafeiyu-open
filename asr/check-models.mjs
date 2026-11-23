#!/usr/bin/env node
// asr/check-models.mjs —— SenseVoice / Silero 模型文件体检
//
// 为什么需要它：asr_server.py 在模型缺失时会 FATAL 退出，但那是**启动后**才发生；
// clone 下来的人往往先看到「按住 V 没反应」，再去翻日志。这里提前把缺失项说清楚。
//
// 用法：
//   node asr/check-models.mjs
//   node asr/check-models.mjs --json
//   node asr/check-models.mjs --model-dir D:/models/sensevoice
//
// 退出码：0 = 三个文件都在；1 = 有缺失。
// 不联网、不下载。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dirArg = args.indexOf('--model-dir');
const explicitDir = dirArg >= 0 ? args[dirArg + 1] : '';
const modelDir = path.resolve(
  explicitDir || process.env.ASR_MODEL_DIR || path.join(os.homedir(), '.dsh', 'speech-to-text', 'sensevoice', 'models')
);

const FILES = [
  { rel: 'sensevoice-onnx/model.int8.onnx', what: 'SenseVoice-Small int8 ONNX 权重' },
  { rel: 'sensevoice-onnx/tokens.txt', what: 'SenseVoice 词表' },
  { rel: 'silero/silero_vad.onnx', what: 'Silero VAD（端点检测）' },
];

const rows = FILES.map((f) => {
  const p = path.join(modelDir, f.rel);
  let size = 0;
  let ok = false;
  try {
    const st = fs.statSync(p);
    ok = st.isFile() && st.size > 0;
    size = st.size;
  } catch (e) { ok = false; }
  return { ...f, path: p, ok, bytes: size };
});

const missing = rows.filter((r) => !r.ok);

if (asJson) {
  console.log(JSON.stringify({
    ok: missing.length === 0,
    modelDir,
    files: rows.map((r) => ({ path: r.path, ok: r.ok, bytes: r.bytes, what: r.what })),
    missing: missing.map((r) => r.path),
  }, null, 2));
  process.exit(missing.length ? 1 : 0);
}

console.log(`\n[asr/check-models] 模型目录：${modelDir}\n`);
for (const r of rows) {
  const size = r.ok ? `${(r.bytes / 1024 / 1024).toFixed(1)} MB` : '缺失';
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.rel}  —  ${r.what}（${size}）`);
}

if (missing.length) {
  console.log(`
缺 ${missing.length} 个文件。获取方式（在 PowerShell 里执行）：

  $dir = "$HOME\\.dsh\\speech-to-text\\sensevoice\\models"
  New-Item -ItemType Directory -Force -Path "$dir\\sensevoice-onnx","$dir\\silero" | Out-Null

  # SenseVoice（k2-fsa 发布包，解压后把目录内文件放到 sensevoice-onnx/）
  curl.exe -L -o "$env:TEMP\\sensevoice.tar.bz2" "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2"
  tar -xjf "$env:TEMP\\sensevoice.tar.bz2" -C "$env:TEMP"
  Copy-Item "$env:TEMP\\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17\\model.int8.onnx" "$dir\\sensevoice-onnx\\"
  Copy-Item "$env:TEMP\\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17\\tokens.txt" "$dir\\sensevoice-onnx\\"

  # Silero VAD
  curl.exe -L -o "$dir\\silero\\silero_vad.onnx" "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx"

也可以放到别的目录，然后用 \`asr_server.py --model-dir <dir>\` 或环境变量 ASR_MODEL_DIR 指过去。
`);
  process.exit(1);
}
console.log('\n[asr/check-models] ✓ 模型齐了\n');
