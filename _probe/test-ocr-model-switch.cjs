#!/usr/bin/env node
/**
 * test-ocr-model-switch.cjs —— OCR 模型可切换 + 三道闸不依赖模型名
 *
 * 覆盖（对应任务 4）：
 *   1. 默认（无环境变量）仍是 glm-ocr:latest
 *   2. PET_OCR_MODEL=paddleocr-vl 时命令行/请求体里的模型名正确
 *   3. PET_OCR_MODEL 优先于旧变量 GLM_OCR_MODEL（回滚兼容）
 *   4. 请求体：模型名、prompt、temperature=0、stream、keep_alive=0（本地 mock，不发真实请求）
 *   5. 三道闸函数级断言：guard / dedup_repeat / clean 的签名里没有 model 参数，
 *      且空白图判空、有字图判有、复读被截断 —— 换模型不改闸
 *   6. 源码级：VLM 之前仍先 guard()，空帧走 engine='guard' 拒绝
 *
 * 纯 Node + 本地 Python（PIL/numpy 已装）。不连 Ollama、不截屏。
 * 运行：node _probe/test-ocr-model-switch.cjs
 */
'use strict';

const { spawnSync, spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON_EXE || 'py';
const SCRIPT = path.join(ROOT, 'pet-runtime', 'tools', 'ocr_read.py');
const TOOLS = path.join(ROOT, 'pet-runtime', 'tools');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    failures.push(name + (detail ? ' :: ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? ' :: ' + detail : ''));
  }
}
function envWithout(...keys) {
  const e = { ...process.env };
  for (const k of keys) delete e[k];
  return e;
}
function runPy(args, env) {
  const r = spawnSync(PY, [SCRIPT, ...args], {
    cwd: ROOT, env: env || process.env, encoding: 'utf8', timeout: 60000,
  });
  if (r.error) throw r.error;
  let parsed = null;
  try { parsed = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch {}
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: parsed };
}
function runPyInline(code, env) {
  const r = spawnSync(PY, ['-I', '-c', code], {
    cwd: ROOT, env: env || process.env, encoding: 'utf8', timeout: 60000,
  });
  if (r.error) throw r.error;
  let parsed = null;
  try { parsed = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); } catch {}
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: parsed };
}
// mock 服务器跑在本进程里，必须用异步 spawn：spawnSync 会堵住事件循环，导致 mock 永不回包
function runPyInlineAsync(code, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(PY, ['-I', '-c', code], { cwd: ROOT, env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('python 超时')); }, 60000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code2) => {
      clearTimeout(timer);
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split(/\r?\n/).pop()); } catch {}
      resolve({ code: code2, stdout: out, stderr: err, json: parsed });
    });
  });
}

// ---------------------------------------------------------------- 1) 默认
console.log('\n[1] 默认仍是 glm-ocr');
{
  const r = runPy(['--dry-run'], envWithout('PET_OCR_MODEL', 'GLM_OCR_MODEL'));
  check('exit 0', r.code === 0, r.stderr.slice(0, 300));
  check('model = glm-ocr:latest', r.json && r.json.model === 'glm-ocr:latest', JSON.stringify(r.json));
  check('prompt 是 GLM 长指令', !!(r.json && /读出图中所有文字/.test(r.json.prompt)), r.json && r.json.prompt);
  check('paddle=false', r.json && r.json.paddle === false);
}

// ------------------------------------------------- 2) PET_OCR_MODEL 切换
console.log('\n[2] PET_OCR_MODEL=paddleocr-vl');
{
  const r = runPy(['--dry-run'], { ...envWithout('GLM_OCR_MODEL'), PET_OCR_MODEL: 'paddleocr-vl' });
  check('exit 0', r.code === 0, r.stderr.slice(0, 300));
  check('model = paddleocr-vl', r.json && r.json.model === 'paddleocr-vl', JSON.stringify(r.json));
  check('prompt = OCR:（官方任务前缀）', r.json && r.json.prompt === 'OCR:', r.json && r.json.prompt);
  check('paddle=true', r.json && r.json.paddle === true);
}

// ------------------------------------------- 3) 优先级 / 回滚兼容 / --model
console.log('\n[3] 优先级与回滚');
{
  const both = runPy(['--dry-run'], { ...envWithout(), PET_OCR_MODEL: 'paddleocr-vl', GLM_OCR_MODEL: 'glm-ocr:latest' });
  check('PET_OCR_MODEL 优先于 GLM_OCR_MODEL', both.json && both.json.model === 'paddleocr-vl', JSON.stringify(both.json));

  const legacy = runPy(['--dry-run'], { ...envWithout('PET_OCR_MODEL'), GLM_OCR_MODEL: 'glm-ocr:latest' });
  check('旧变量 GLM_OCR_MODEL 仍生效（回滚）', legacy.json && legacy.json.model === 'glm-ocr:latest', JSON.stringify(legacy.json));

  const empty = runPy(['--dry-run'], { ...envWithout(), PET_OCR_MODEL: '   ', GLM_OCR_MODEL: 'glm-ocr:latest' });
  check('空白 PET_OCR_MODEL 视为未设', empty.json && empty.json.model === 'glm-ocr:latest', JSON.stringify(empty.json));

  const cli = runPy(['--dry-run', '--model', 'paddleocr-vl'], envWithout('PET_OCR_MODEL', 'GLM_OCR_MODEL'));
  check('--model 命令行覆盖', cli.json && cli.json.model === 'paddleocr-vl' && cli.json.prompt === 'OCR:', JSON.stringify(cli.json));

  const tbl = runPy(['--dry-run', '--model', 'paddleocr-vl', '--prompt', '表格用 Markdown'], envWithout('PET_OCR_MODEL', 'GLM_OCR_MODEL'));
  check('自定义 prompt 保留 OCR: 前缀', tbl.json && tbl.json.prompt === 'OCR:\n表格用 Markdown', tbl.json && tbl.json.prompt);
}

// ------------------------------------------------- 4) 真实请求体（本地 mock）
const DUMMY = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
function withMockServer(fn) {
  return new Promise((resolve, reject) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { seen.push(JSON.parse(raw)); } catch (e) { seen.push({ parse_error: String(e), raw: raw.slice(0, 200) }); }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ response: '你好' }) + '\n');
        res.write(JSON.stringify({ response: '，世界', done: true }) + '\n');
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', async () => {
      try {
        const port = srv.address().port;
        await fn(`http://127.0.0.1:${port}/api/generate`, seen);
        resolve();
      } catch (e) {
        reject(e);
      } finally {
        srv.close();
      }
    });
  });
}

const PY_CALL = `
import sys, os, json
sys.path.insert(0, os.environ['OCR_TOOLS'])
import ocr_read
png = bytes.fromhex(os.environ['OCR_PNG_HEX'])
prompt = ocr_read.build_prompt(os.environ['PET_OCR_MODEL'])
text, aborted = ocr_read.read_vlm(png, prompt, os.environ['PET_OCR_MODEL'])
print(json.dumps({'ok': True, 'text': text, 'aborted': aborted, 'prompt': prompt}))
`;

(async () => {
  console.log('\n[4] 请求体（mock 端点，不发真实请求）');
  for (const [model, wantPrompt, label] of [
    ['glm-ocr:latest', null, 'glm'],
    ['paddleocr-vl', 'OCR:', 'paddle'],
  ]) {
    await withMockServer(async (endpoint, seen) => {
      const r = await runPyInlineAsync(PY_CALL, {
        ...envWithout('GLM_OCR_MODEL'), PET_OCR_MODEL: model, PET_OCR_ENDPOINT: endpoint,
        OCR_TOOLS: TOOLS, OCR_PNG_HEX: DUMMY.toString('hex'),
      });
      check(label + ': python exit 0', r.code === 0, r.stderr.slice(0, 400));
      check(label + ': 收到 1 个请求', seen.length === 1, 'seen=' + seen.length);
      const b = seen[0] || {};
      check(label + ': body.model = ' + model, b.model === model, JSON.stringify(b.model));
      check(label + ': prompt 正确',
        wantPrompt ? String(b.prompt || '').startsWith(wantPrompt) : /读出图中所有文字/.test(b.prompt || ''),
        JSON.stringify(b.prompt));
      // 2026-11-23 调参：paddle 用 repeat_penalty 1.0（1.08 会把 21 读成全角７２１）；
      // glm 保持 1.08（对惩罚不敏感）。paddle 的 prompt 追加半角数字要求。
      check(label + ': repeat_penalty 按引擎',
        b.options && b.options.repeat_penalty === (label === 'paddle' ? 1.0 : 1.08),
        JSON.stringify(b.options));
      if (label === 'paddle') {
        check('paddle: prompt 追加半角数字要求', /半角阿拉伯数字/.test(String(b.prompt || '')), JSON.stringify(b.prompt));
      }
      check(label + ': temperature=0', b.options && b.options.temperature === 0, JSON.stringify(b.options));
      check(label + ': stream=true', b.stream === true);
      check(label + ': keep_alive=0', b.keep_alive === 0);
      check(label + ': images 1 张', Array.isArray(b.images) && b.images.length === 1 && b.images[0] === DUMMY.toString('base64'));
      check(label + ': 流式拼回文本', r.json && r.json.text === '你好，世界', r.json && r.json.text);
    });
  }
  await mockDone();
})().catch((e) => {
  failures.push('mock 阶段异常: ' + e.message);
  console.log('  FAIL  mock 阶段异常 :: ' + e.message);
  summary();
});

async function mockDone() {
  // ------------------------------------------------------ 5) 三道闸函数级
  console.log('\n[5] 三道闸与模型名解耦');
  const GATE_PY = `
import sys, os, json, inspect
sys.path.insert(0, os.environ['OCR_TOOLS'])
import ocr_read
from PIL import Image, ImageDraw
import random

# ① 空帧：深色纯色（实测 UWP 黑屏同款）
blank = Image.new('RGB', (240, 140), (32, 32, 32))
ok_blank, gb = ocr_read.guard(blank)

# ② 有字：白底黑条纹（模拟文本行）
img = Image.new('L', (320, 160), 255)
d = ImageDraw.Draw(img)
random.seed(7)
for y in range(10, 150, 14):
    x = 8
    while x < 300:
        w = random.randint(4, 14)
        d.rectangle([x, y, x + w, y + 8], fill=0)
        x += w + random.randint(3, 7)
ok_text, gt = ocr_read.guard(img.convert('RGB'))

# ③ 复读：同一段正文写两遍
lines = ['第一行标题', '第二行内容', '第三行内容', '第四行内容', '']
rep = '\\n'.join(lines + lines)
ded = ocr_read.dedup_repeat(rep)
cln = ocr_read.clean(rep + '\\n' + '\`\`\`')

sigs = {n: str(inspect.signature(getattr(ocr_read, n)))
        for n in ('guard', 'dedup_repeat', 'clean', 'read_vlm', 'build_prompt')}
print(json.dumps({
  'ok_blank': ok_blank, 'g_blank': gb,
  'ok_text': ok_text, 'g_text': gt,
  'rep_len': len(rep), 'ded_len': len(ded),
  'ded_head_count': ded.count('第一行标题'),
  'ded_no_fence': ('\`\`\`' not in cln),
  'sigs': sigs,
}))
`;
  const g = runPyInline(GATE_PY, { ...process.env, OCR_TOOLS: TOOLS });
  check('闸函数可独立调用', g.code === 0, g.stderr.slice(0, 500));
  const j = g.json || {};
  check('① 空帧被拒绝（guard=false）', j.ok_blank === false, JSON.stringify(j.g_blank));
  check('② 有字图放行（guard=true）', j.ok_text === true, JSON.stringify(j.g_text));
  check('③ 复读被截断（长度变短）', typeof j.ded_len === 'number' && j.ded_len < j.rep_len, `${j.ded_len} vs ${j.rep_len}`);
  check('③ 截到第一次重复开头（标题只留 1 次）', j.ded_head_count === 1, 'count=' + j.ded_head_count);
  check('③ 围栏行被清掉', j.ded_no_fence === true);
  const sigs = j.sigs || {};
  for (const fn of ['guard', 'dedup_repeat', 'clean']) {
    check('闸 ' + fn + '() 签名不含 model', !!sigs[fn] && !/\bmodel\b/.test(sigs[fn]), sigs[fn]);
  }
  check('build_prompt(model, ...) 含 model', !!(sigs.build_prompt && /\bmodel\b/.test(sigs.build_prompt)), sigs.build_prompt);
  check('read_vlm(..., model=None) 可注入', !!(sigs.read_vlm && /model=None/.test(sigs.read_vlm)), sigs.read_vlm);

  // ------------------------------------------------------ 6) 源码级闸位
  console.log('\n[6] 源码级：VLM 前仍先过 guard');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  check('guard 在 VLM 之前调用', /ok, g = guard\(img\)/.test(src));
  check('空帧走 engine=guard 拒绝', /'engine': 'guard'/.test(src));
  check('VLM 失败回落 rapidocr', /read_rapid\(img\)/.test(src));
  check('read_vlm 传入解析后的 model', /read_vlm\(png, prompt, model\)/.test(src));
  check('请求体不再硬编码 MODEL', !/'model': MODEL/.test(src));
  summary();
}

function summary() {
  console.log('\n' + '='.repeat(56));
  console.log(`结果：${pass} PASS / ${failures.length} FAIL`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  }
  console.log('='.repeat(56));
}
