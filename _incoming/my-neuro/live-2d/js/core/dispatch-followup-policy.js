// dispatch-followup-policy.js —— 派活「继续聊」的唯一判定/文案源（2026-11-23）
//
// 为什么单独成文件：按钮显不显示（渲染层）和 IPC 收不收（主进程）必须同源，
// 历史上「界面上的能/不能」和真实闸门对不上过（见 dispatch-retry-policy.js）。
// 8103 的 /dispatch/followup 自己也有一道闸（父任务终态 + sessionId），这里与之对齐：
//   · 终态 = done / failed / cancelled（petbridge/dispatch-ledger.mjs 的 TERMINAL_STATES）；
//     done_unproven 是 **outcome**（state=done 的未证实结果），不是第四个状态。
//   · running / cancelling / unknown 一律不允许：unknown 可能还在跑，续聊会双执行。
//   · 没有 sessionId（启动失败/后端没回传）不允许：/dispatch/followup 会 409 no_parent_session。
//
// 同一份实现三种加载方式：
//   · control-main.js / _probe 测试：require()
//   · control-v2.html（file:// 渲染层）：<script src> 后挂在 window.DispatchFollowupPolicy
// 只放纯函数，不碰 DOM、不碰网络。
'use strict';

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.DispatchFollowupPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const TERMINAL_STATES = Object.freeze(['done', 'failed', 'cancelled']);
    const LIVE_BLOCK_REASON = {
        running: '任务还在跑：等它结束（done/failed/cancelled）再续聊',
        cancelling: '任务正在停止：等它结束后再续聊',
        unknown: '结果未知（可能还在跑）：先核对结果，别重复续聊',
    };

    function stateOf(task) {
        return String((task && task.state) || '').trim();
    }

    function sessionIdOf(task) {
        return String((task && task.sessionId) || '').trim();
    }

    function isTerminalState(state) {
        return TERMINAL_STATES.indexOf(String(state || '')) >= 0;
    }

    /** 「继续聊」可用吗（与 8103 followupDispatchTask 的准入一致）。 */
    function isFollowupEligible(task) {
        return followupBlockedReason(task) === '';
    }

    /** 不可用时给 UI 的原因；空串 = 可以续聊。 */
    function followupBlockedReason(task) {
        if (!task || typeof task !== 'object') return '没有任务详情';
        const state = stateOf(task);
        if (!state) return '账本没有任务状态';
        if (!isTerminalState(state)) return LIVE_BLOCK_REASON[state] || ('任务状态 ' + state + ' 不是终态，不能续聊');
        if (!sessionIdOf(task)) return '这个任务没有会话 id（启动失败或后端没回传），没法接着原会话';
        return '';
    }

    /** 子任务 id：账本按 taskId 分文件，必须新生成；前缀 ui-followup 便于识别来源。 */
    function makeFollowupTaskId(now = Date.now(), rand = Math.random()) {
        return 'ui-followup-' + Number(now).toString(36) + '-' + String(rand).slice(2, 6);
    }

    /**
     * POST /dispatch/followup 请求体。
     * @returns {{ok:boolean, error?:string, body?:{taskId:string, task:string, newTaskId:string}}}
     */
    function buildFollowupRequest(parentTaskId, task, newTaskId) {
        const pid = String(parentTaskId == null ? '' : parentTaskId).trim();
        const text = String(task == null ? '' : task).trim();
        const child = String(newTaskId == null ? '' : newTaskId).trim();
        if (!pid) return { ok: false, error: 'missing_task_id' };
        if (!text) return { ok: false, error: 'empty_task' };
        if (text.length > 20000) return { ok: false, error: 'task_too_long' };
        if (!child) return { ok: false, error: 'missing_new_task_id' };
        return { ok: true, body: { taskId: pid, task: text, newTaskId: child } };
    }

    /**
     * /dispatch/followup 的最终回执 → 人话。顺序很重要：
     * 失配/回退必须先说「没接上原会话，已带上下文重开」，不能只报成功。
     * @returns {{level:'ok'|'warn'|'error', message:string}}
     */
    function describeFollowupOutcome(result) {
        const r = result && typeof result === 'object' ? result : {};
        const state = String(r.state || '');
        const err = String(r.error || r.stateReason || '').trim();
        const mismatch = r.sessionMismatch === true || r.fallback === true;
        if (mismatch) {
            const base = '没接上原会话，已带上下文重开';
            if (state === 'failed') return { level: 'error', message: base + '；但这次执行失败：' + (err || '未知原因') };
            if (state === 'unknown') return { level: 'warn', message: base + '；结果未知（可能还在跑），别重复派同一件事' };
            if (state === 'cancelled') return { level: 'warn', message: base + '；这次任务被取消了' };
            return { level: 'warn', message: base + (state === 'done' ? '，已完成' : '') };
        }
        if (state === 'unknown') return { level: 'warn', message: '续聊结果未知：可能还在跑，别重复派同一件事' };
        if (state === 'cancelled') return { level: 'warn', message: '续聊任务被取消了' };
        if (state === 'failed' && r.attempted === false) {
            return { level: 'error', message: '续聊没启动：' + (err || '启动执行器失败') };
        }
        if (state === 'failed') return { level: 'error', message: '续聊失败：' + (err || '未知原因') };
        if (r.sessionReused === true) return { level: 'ok', message: '已续聊（会话接上了）' };
        if (state === 'done') return { level: 'warn', message: '已继续执行，但没能确认接上原会话（没收到 session 回传）' };
        return { level: 'ok', message: '已续聊（会话接上了）' };
    }

    /** IPC 8s 窗口内任务还没结束：只确认「已派出」。 */
    function describeFollowupPending(childTaskId) {
        const id = String(childTaskId || '').trim();
        return { level: 'ok', message: '已派出续聊' + (id ? '（' + id + '）' : '') + '，任务还在跑；列表会自动刷新' };
    }

    return {
        TERMINAL_STATES,
        isTerminalState,
        isFollowupEligible,
        followupBlockedReason,
        makeFollowupTaskId,
        buildFollowupRequest,
        describeFollowupOutcome,
        describeFollowupPending,
    };
});
