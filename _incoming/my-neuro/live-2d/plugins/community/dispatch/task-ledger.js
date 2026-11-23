'use strict';
// task-ledger.js —— 任务结案三态判定（B1，2026-11-21）
//
// 要解决的问题：dispatch 的完成判据原来只有「执行器回报 ok」——
//   `row.state = data.ok ? 'done' : 'failed'`（dispatch/index.js 的 _run），
//   然后 `_finishGoalForTask` 直接把 `row.state === 'done'` 当成功交给目标账本。
//   也就是说：**执行器自述即结案**。后台执行器（DSH）是个黑盒，它说 ok 我们就记 done，
//   没有任何外部证据 —— 用户看到「已完成」，但可能只是它自己认为完成了。
//
// 三态（研讨 B1）：
//   done_verified —— 有外部证据（执行器返回 verified===true 或 evidence）
//                    或**纯查询任务**（没有副作用，自述可信，白名单豁免）
//   done_unproven —— 执行器报成功，但拿不出证据（诚实状态：已完成，未证实）
//   failed        —— 执行器报失败（带原因）
//
// 为什么纯查询要豁免：读文件/搜资料/查天气这类任务没有「可观测后果」，
// 强行要求 verified 会让所有查询都变成「未证实」，反而把真实风险淹掉。
// 判据只看**动词**（不是应用名），换应用/换任务类型都不用改这段代码。

// 查询性动词（中文 + 英文）。注意：必须锚定在句首或「帮我/请/然后」之后，
// 否则「查看并删除」会被误判 —— 所以还要叠加 MUTATE 否决。
const QUERY_VERB = /^(?:帮我|请|麻烦|然后|先|再)?\s*(?:查|搜|读|找|看|列出|列一下|检查|确认|告诉我|what|read|search|list|find|check|show|look)/i;
// 破坏/写入性动词：出现即**取消豁免**（宁可标 done_unproven，也不要假证实）
const MUTATE_VERB = /(删|改|写|创建|新建|安装|卸载|运行|执行|启动|关闭|停止|重启|部署|提交|推送|拉取|替换|覆盖|删除|move|rename|delete|write|create|install|run|exec|start|stop|restart|deploy|commit|push|pull|replace|overwrite)/i;

/**
 * 纯查询任务判定：以查询动词开头，且**不含**任何破坏/写入动词。
 * @param {string} task
 */
function isSelfReportOnlyTask(task) {
    const t = String(task || '').trim();
    if (!t) return false;
    return QUERY_VERB.test(t) && !MUTATE_VERB.test(t);
}

/**
 * 结案三态判定。
 * P1（2026-11-23）：新增 verify（四态）与 changed（文件快照有没有改动）。
 * 信任顺序同 fleet：command(verify) > evidence > model(自述) > none。
 * verify 的 broken/timeout 是「无法判定」，按 done_unproven，不是 failed ——
 * 环境坏不能算模型的锅，也不能冒充已证实（设计 §4.1）。
 *
 * @param {{ok?:boolean, verified?:boolean, evidence?:string, task?:string,
 *          verify?:{verdict?:string}, changed?:boolean}} input
 * @returns {{outcome:'done_verified'|'done_unproven'|'failed', why:string}}
 */
function classifyOutcome(input) {
    const o = input || {};
    const verdict = o.verify && typeof o.verify === 'object' ? String(o.verify.verdict || '') : '';
    if (verdict === 'pass') return { outcome: 'done_verified', why: '验收命令通过（command 级证据）' };
    if (verdict === 'fail') return { outcome: 'failed', why: '验收命令未通过' };
    if (verdict === 'broken') return { outcome: 'done_unproven', why: '验收命令本身无法执行，结果无法判定' };
    if (verdict === 'timeout') return { outcome: 'done_unproven', why: '验收命令超时，结果无法判定' };
    if (o.ok !== true) {
        return { outcome: 'failed', why: '执行器回报失败' + (o.evidence ? '（' + String(o.evidence).slice(0, 80) + '）' : '') };
    }
    // 执行器自带的证据（有的后端会返回 verified/evidence；DSH 目前不返回）
    if (o.verified === true) return { outcome: 'done_verified', why: '执行器返回 verified=true' };
    if (o.evidence && String(o.evidence).trim()) {
        return { outcome: 'done_verified', why: '有外部证据：' + String(o.evidence).trim().slice(0, 80) };
    }
    if (isSelfReportOnlyTask(o.task)) {
        return { outcome: 'done_verified', why: '纯查询任务（无副作用，自述可信）' };
    }
    if (o.changed === true) {
        return { outcome: 'done_unproven', why: '有文件改动，但没有验收命令（未证实）' };
    }
    if (o.changed === false) {
        return { outcome: 'done_unproven', why: '执行器回报成功，但没有任何可观测后果（未证实）' };
    }
    return { outcome: 'done_unproven', why: '执行器回报成功，但没有外部证据' };
}

/** 状态 → 目标账本状态（终态） */
const GOAL_STATUS = {
    done_verified: 'done',
    done_unproven: 'done_unproven',
    failed: 'failed',
};

/** 状态 → 执行档案的 verified 三值（true/false/null=不知道） */
const HISTORY_VERIFIED = {
    done_verified: true,
    done_unproven: null,
    failed: false,
};

module.exports = { classifyOutcome, isSelfReportOnlyTask, GOAL_STATUS, HISTORY_VERIFIED, QUERY_VERB, MUTATE_VERB };
