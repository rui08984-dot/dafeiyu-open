// plugins/community/memory-evolve/lib/memos-contract.js —— MemOS 写/删的「机器可读成功」判定
//
// 背景（2026-11-21 审计 P0/P1）：
//   · /add 后端在「模型全挂 / 配置为空 / 没提取到任何记忆」时仍然 HTTP 200，
//     只在 body 里写 message。旧调用方用 `ok && !ok.error`（ok 是响应对象，永远真）
//     或只看 HTTP 2xx → 把**没写进去**当成已记住，队列条目被删掉，数据静默丢失。
//   · /delete_memory 失败时返回 200 + {"status":"failed"}，旧代码只看 2xx → 假删除。
//
// 契约（Python 侧 /add 现在显式返回 ok/added/error）：
//   { status: 'success'|'failed', ok: bool, added: int, merged: int, error: string|null }
//
// 兼容旧后端：没有 ok 字段时退回 status==='success' 且 (added+merged)>0。
// 关键词是 **added/merged 必须 >0** —— 「200 + added:0」不是成功（什么都没写）。
'use strict';

/** 判断 /add 的响应体是否代表「确实写进去了」。 */
function isAddOk(body) {
    if (!body || typeof body !== 'object') return false;
    const added = Number(body.added);
    const merged = Number(body.merged);
    const wrote = (Number.isFinite(added) && added > 0) || (Number.isFinite(merged) && merged > 0);
    if (body.ok === true) return true;
    if (body.ok === false) return false;
    if (body.status === 'failed' || body.status === 'error') return false;
    // 旧后端：只有 status，没有 ok
    return body.status === 'success' && wrote;
}

/** 失败原因（日志/回报用）：优先 error，其次 message，最后给一个确定的兜底。 */
function addErrorText(body) {
    if (!body || typeof body !== 'object') return '无响应体（连不上或返回非 JSON）';
    const t = body.error || body.message;
    if (t) return String(t).slice(0, 200);
    if (body.status === 'failed' || body.status === 'error') return '后端返回 ' + body.status;
    return '后端未确认写入（added=' + String(body.added) + '）';
}

/** 判断 /delete_memory 的响应体是否代表「确实删掉了」。 */
function isDeleteOk(body) {
    if (!body || typeof body !== 'object') return false;
    if (body.ok === true) return true;
    if (body.ok === false) return false;
    return body.status === 'success';
}

module.exports = { isAddOk, addErrorText, isDeleteOk };
