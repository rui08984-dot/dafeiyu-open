#!/usr/bin/env node
// scripts/fetch-models.mjs —— Ollama 模型获取 / 体检
//
// 为什么单独成脚本（2026-11-23 安装完整性审计）：
//   皮套/看屏/OCR 依赖三个 Ollama 模型，但 Ollama 没有「依赖清单」机制，
//   clone 下来的人只能靠 README 手抄命令，抄漏一个就是「功能悄悄不存在」。
//   这里把模型名钉在代码里，拉取和检查同一份清单。
//
// 用法：
//   node scripts/fetch-models.mjs            # 缺什么拉什么（会联网、会占磁盘，几 GB）
//   node scripts/fetch-models.mjs --check    # 只检查，不下载（离线安全）
//   node scripts/fetch-models.mjs --json     # 机器可读（配合 --check 常用）
//
// 说明：
//   · 只访问本机 Ollama（127.0.0.1:11434），不直接连模型仓库；
//     pull 的下载由 Ollama 自己完成。
//   · qwen3-vl 必须用 *-instruct：基础 tag 是 thinking 版，看屏时小 max_tokens
//     会被思考过程吃光，content 为空（2026-11-23 实测结论，见 docs/HANDOFF-2026-11-23.md）。
//   · glm-ocr 是默认 OCR；paddleocr-vl 是可选第二档（PET_OCR_MODEL=paddleocr-vl 切换）。

import { spawnSync } from 'node:child_process';

const OLLAMA = process.env.OLLAMA_HOST && !process.env.OLLAMA_HOST.includes('://')
  ? `http://${process.env.OLLAMA_HOST}`
  : (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434');
const checkOnly = process.argv.includes('--check');
const asJson = process.argv.includes('--json');

// 清单单一事实源：name 是 ollama 的完整 tag，why 是缺了会怎样。
const MODELS = [
  {
    name: 'qwen3-vl:8b-instruct',
    why: '本地视觉/看屏/游戏画面理解（高分辨率 OCR 也可用）',
    required: false,
  },
  {
    name: 'glm-ocr:latest',
    why: '默认 OCR（pet-runtime/tools/ocr_read.py 的 MODEL_GLM）',
    required: false,
  },
  {
    name: 'paddleocr-vl:latest',
    why: '可选 OCR 第二档（PET_OCR_MODEL=paddleocr-vl）',
    required: false,
  },
];

function normName(name) {
  const s = String(name || '').trim();
  return s.includes(':') ? s : `${s}:latest`;
}

async function listModels() {
  // 先走 HTTP：不依赖 ollama CLI 是否在 PATH，也不会触发任何拉取。
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const names = (data.models || []).map((m) => normName(m.name || m.model));
    return { ok: true, names };
  } catch (e) {
    // 退回 CLI（本机 Ollama 未开 HTTP 兼容时也可能有 CLI）
    const r = spawnSync('ollama', ['list'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (r.status === 0) {
      const names = String(r.stdout || '')
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean)
        .map(normName);
      return { ok: true, names, via: 'cli' };
    }
    return {
      ok: false,
      error: String(e && e.message ? e.message : e),
      hint: '确认 Ollama 已安装并在运行（ollama serve / 托盘图标），或设置 OLLAMA_HOST',
    };
  }
}

function pull(name) {
  // 进度写 stderr：--json 时 stdout 必须只有最终 JSON。
  console.error(`\n[fetch-models] ollama pull ${name}`);
  const r = spawnSync('ollama', ['pull', name], { stdio: 'inherit', windowsHide: true });
  if (r.error) {
    console.error(`[fetch-models] ✗ 无法执行 ollama：${r.error.message}`);
    return false;
  }
  if (r.status !== 0) {
    console.error(`[fetch-models] ✗ ${name} 拉取失败（退出码 ${r.status}）`);
    return false;
  }
  return true;
}

const listed = await listModels();
const rows = [];
if (!listed.ok) {
  rows.push({
    name: '(Ollama)',
    present: false,
    error: listed.error,
    hint: listed.hint,
  });
} else {
  const have = new Set(listed.names);
  for (const m of MODELS) {
    rows.push({
      name: m.name,
      why: m.why,
      required: m.required,
      present: have.has(normName(m.name)),
    });
  }
}

if (!listed.ok) {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, ollama: OLLAMA, error: listed.error, hint: listed.hint, models: rows }, null, 2));
  } else {
    console.error(`\n[fetch-models] ✗ Ollama 不可用：${listed.error}`);
    console.error(`  → ${listed.hint}`);
  }
  process.exit(1);
}

const missing = rows.filter((r) => !r.present);

if (checkOnly) {
  if (asJson) {
    console.log(JSON.stringify({
      ok: missing.length === 0,
      ollama: OLLAMA,
      checked: rows.length,
      missing: missing.map((r) => r.name),
      models: rows,
    }, null, 2));
  } else {
    console.log(`\n[fetch-models] Ollama @ ${OLLAMA}${listed.via === 'cli' ? '（经 CLI）' : ''}\n`);
    for (const r of rows) {
      console.log(`  ${r.present ? '✓' : '✗'} ${r.name}  —  ${r.why}`);
      if (!r.present) console.log(`      → node scripts/fetch-models.mjs   （或 ollama pull ${r.name}）`);
    }
    console.log(missing.length
      ? `\n缺 ${missing.length} 个模型（只影响对应能力，不影响宿主启动）`
      : '\n模型齐了');
  }
  process.exit(missing.length ? 1 : 0);
}

if (!missing.length) {
  if (asJson) console.log(JSON.stringify({ ok: true, ollama: OLLAMA, pulled: [], failed: 0, stillMissing: [] }, null, 2));
  else console.log('[fetch-models] 模型已齐，无需下载');
  process.exit(0);
}

console.error(`[fetch-models] 缺 ${missing.length} 个模型，开始拉取（总计数 GB，Ctrl+C 可中断）`);
let failed = 0;
for (const r of missing) {
  if (!pull(r.name)) failed += 1;
}

// 拉完再验一次：Ollama 返回 0 也可能因为磁盘满而没落盘。
const after = await listModels();
const stillMissing = after.ok
  ? MODELS.filter((m) => !new Set(after.names).has(normName(m.name))).map((m) => m.name)
  : MODELS.map((m) => m.name);

if (asJson) {
  console.log(JSON.stringify({
    ok: failed === 0 && stillMissing.length === 0,
    pulled: missing.map((m) => m.name),
    failed,
    stillMissing,
  }, null, 2));
}
if (failed || stillMissing.length) {
  console.error(`[fetch-models] ✗ 未完成：failed=${failed} stillMissing=${stillMissing.join(', ') || '无'}`);
  process.exit(1);
}
if (!asJson) console.log('[fetch-models] ✓ 全部就绪');
