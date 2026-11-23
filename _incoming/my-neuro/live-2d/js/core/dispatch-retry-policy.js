// dispatch-retry-policy.js —— 派活「重试」的唯一判定源（2026-11-23 B9）
//
// 设计（docs/设计-派活v2-2026-11-23.md §4.2）：**只有 spawn 同步失败**
// （outcome=failed 且 attempted=false）才允许安全重派；一旦 attempted=true，
// 同一任务可能已经跑过/还在写盘，重派就是双执行。UI 与 IPC 必须共用这个判据，
// 不能各写一套（历史上「界面上的能/不能」和真实闸门对不上过）。
'use strict';

/** 是否允许在 UI 上给「重试」。 */
function canRetry(task) {
    if (!task || typeof task !== 'object') return false;
    if (String(task.state || '') !== 'failed') return false;
    // 必须是**明确**的 attempted=false；缺字段按「可能执行过」处理（保守）
    if (task.attempted !== false) return false;
    if (!String(task.taskText || '').trim()) return false;
    return true;
}

/** 生成新的任务 id（不复用旧 id：账本是按 taskId 分文件的）。 */
function makeRetryTaskId(now = Date.now()) {
    return 'ui-retry-' + Number(now).toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/** 由详情记录构造 /dispatch 请求体；只带原本就有的参数，不猜。 */
function buildRetryBody(task, ids = {}) {
    const body = {
        task: String(task.taskText || ''),
        taskId: String(ids.taskId || ''),
    };
    if (ids.requestId) body.requestId = String(ids.requestId);
    if (task.workspaceAlias) body.workspace = String(task.workspaceAlias);
    if (task.verifyCommand) body.verify = String(task.verifyCommand);
    if (Number(task.timeoutMs) > 0) body.timeoutMs = Number(task.timeoutMs);
    return body;
}

/** 重试为什么不可用（给 UI 的禁用原因，不出现空按钮）。 */
function retryBlockedReason(task) {
    if (!task) return '没有任务详情';
    if (String(task.state || '') !== 'failed') return '只有失败的任务可以重试';
    if (task.attempted === true) return '这个任务已经执行过（attempted=true），重派可能双执行';
    if (task.attempted !== false) return '账本没有明确 attempted=false，按可能执行过处理';
    if (!String(task.taskText || '').trim()) return '账本里没有任务正文';
    return '';
}

module.exports = { canRetry, makeRetryTaskId, buildRetryBody, retryBlockedReason };
