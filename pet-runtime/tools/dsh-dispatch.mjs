// dsh-dispatch.mjs — 把「派活给 DSH」变成一次 CLI 调用：起会话、跑任务、收回执。
// 用法：node tools/dsh-dispatch.mjs --task "做点什么" [--session <id>] [--cwd <dir>] [--json]
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback; };
const task = arg('task', '');
const sessionId = arg('session', '');
const cwd = arg('cwd', process.cwd());
const asJson = argv.includes('--json');
if (!task) { console.error('缺少 --task'); process.exit(2); }

// DSH 的 key 存在 ~/.dsh/.credentials.yaml 的 refs 里；headless profile 不会自己读，
// 所以我们作为启动者把它注入环境变量（不落盘、不打印）。
function readCredential(name) {
  try {
    const p = join(homedir(), '.dsh', '.credentials.yaml');
    if (!existsSync(p)) return '';
    const text = readFileSync(p, 'utf8');
    const m = text.match(new RegExp('^\\s*' + name + ':\\s*(.+)$', 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

const env = { ...process.env };
for (const name of ['COMAD_BUNNY_API_KEY', 'DEEPSEEK_API_KEY']) {
  if (env[name]) continue;
  const key = readCredential(name);
  if (key) env[name] = key;
}

const args = ['--profile', 'headless', '--json'];
if (sessionId) args.push('--session-id', sessionId);
args.push(task);

const started = Date.now();
const child = spawn('dsh', args, { cwd, env, shell: true, windowsHide: true });
let session = '';
let finalText = '';
let error = '';
const toolNames = [];
let buffer = '';
const onLine = (line) => {
  const s = line.trim();
  if (!s.startsWith('{')) return;
  let ev; try { ev = JSON.parse(s); } catch { return; }
  if (ev.type === 'session') { session = ev.sessionId || ''; }
  else if (ev.type === 'final') { finalText = ev.text || ''; }
  else if (ev.type === 'status' && ev.reason && ev.reason.kind === 'error') { error = ev.reason.error?.message || 'error'; }
  else if (ev.type === 'tool' || ev.type === 'tool_call') { toolNames.push(ev.name || ev.tool || ''); }
  if (asJson) process.stdout.write(s + '\n');
};
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const parts = buffer.split('\n'); buffer = parts.pop() || '';
  for (const line of parts) onLine(line);
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.on('exit', (code) => {
  if (buffer) onLine(buffer);
  const took = Date.now() - started;
  if (asJson) process.exit(code || 0);
  console.log(JSON.stringify({ ok: code === 0 && !error, code, tookMs: took, sessionId: session, text: finalText, error: error || (code ? stderr.slice(-400) : ''), tools: toolNames.slice(0, 20) }, null, 2));
  process.exit(code || 0);
});
