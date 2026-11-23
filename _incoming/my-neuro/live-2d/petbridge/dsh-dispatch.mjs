// dsh-dispatch.mjs — 「派活给 DSH」的 CLI 薄壳（P1 起只是入口，不再是实现）
//
// 用法：node petbridge/dsh-dispatch.mjs --task "做点什么" [--session <id>] [--cwd <dir>] [--json]
//
// 为什么变薄（2026-11-23 P1，设计 §3.1）：
//   原来 vts-server 是 spawn 本文件、本文件再 spawn DSH —— 主进程只拿到壳的 pid，
//   taskkill /T 杀不到 DSH 自己派生的会话，壳一退句柄就丢，取消无从谈起。
//   现在 spawn/持句柄/事件解析/取消全部在 petbridge/dispatch-runner.mjs（主进程内），
//   vts-server 直接调 runner；本文件只给「手动跑一次」和旧脚本留一个兼容入口，
//   与主进程走同一份实现（TASK_SUFFIX、凭据注入、windowsHide 口径不会分叉）。
import { createDispatchRunner } from './dispatch-runner.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback; };
const rawTask = arg('task', '');
const sessionId = arg('session', '');
const cwd = arg('cwd', process.cwd());
const asJson = argv.includes('--json');
if (!rawTask) { console.error('缺少 --task'); process.exit(2); }

const runner = createDispatchRunner({});
let handle = null;
try {
  handle = runner.start({
    taskId: 'cli-' + Date.now().toString(36),
    task: rawTask,
    cwd,
    sessionId,
    onEvent: asJson ? (ev) => { try { process.stdout.write(JSON.stringify(ev.value) + '\n'); } catch (e) { /* 管道已关 */ } } : null,
  });
} catch (e) {
  console.error('[dsh-dispatch] 启动失败：' + String((e && e.message) || e));
  process.exit(1);
}

handle.result.then((info) => {
  if (!asJson) {
    console.log(JSON.stringify({
      ok: info.ok,
      code: info.code,
      tookMs: info.tookMs,
      sessionId: info.sessionId,
      text: info.text,
      error: info.error,
      tools: (info.tools || []).slice(0, 20),
    }, null, 2));
  }
  process.exit(info.cancelled ? 1 : (info.code || 0));
}).catch((e) => {
  console.error('[dsh-dispatch] 执行异常：' + String((e && e.message) || e));
  process.exit(1);
});
