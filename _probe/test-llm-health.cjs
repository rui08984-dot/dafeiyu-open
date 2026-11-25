#!/usr/bin/env node
/**
 * _probe/test-llm-health.cjs — 云端 LLM 健康/配额熔断单测（2026-11-24 P0-1）
 *
 * 覆盖 js/core/llm-health.js 与 js/core/background-llm.js 的约定：
 *   ① 429 + 配额重置时刻（响应体 ISO 文本 / 附带的 quotaResetAt）→ 暂停到重置 +2 分钟
 *   ② 429 无重置时刻 / 网络错误 / 5xx → 指数退避 5→10→20→40 分钟，Retry-After 更大时尊重
 *   ③ 连败 ≥5 → 停到下一个本地 00:05（day_stop）
 *   ④ 成功 → 全清；持久化跨实例；canCall 窗口与过期清理
 *   ⑤ 日志只在状态迁移时喊一次；错误摘要不含 key
 *   ⑥ background-llm：配置开关 + 共享熔断
 *
 * 全部离线：状态文件写在 mkdtemp 临时目录（每个用例自己的 LLM健康.json），
 * 不读不写真实 data、不发一次网络请求。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const H = require(path.join(LIVE, 'js', 'core', 'llm-health.js'));
const BL = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
const PC = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));
const T = H.__test;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dafeiyu-llmhealth-'));
let seq = 0;
function statePath() {
    seq += 1;
    return path.join(TMP_ROOT, 'case' + seq, 'LLM健康.json');
}
function mk(opts) {
    const logs = [];
    const h = H.createLlmHealth(Object.assign({
        path: statePath(),
        logger: (m) => logs.push(String(m)),
    }, opts || {}));
    return { h, logs };
}
function mkErr(status, body, extra) {
    const e = new Error('LLM API error: ' + status);
    if (status) e.status = status;
    if (body !== undefined) e.body = body;
    return Object.assign(e, extra || {});
}

const QUOTA_BODY = JSON.stringify({
    error: {
        message: "You've reached your weekly usage limit for your plan. " +
            'Your limit resets at 2026-11-24T08:30:32.238Z',
    },
});
const RESET_AT = Date.parse('2026-11-24T08:30:32.238Z');
const MIN = 60 * 1000;

(async () => {
    try {
        // ═══════════════════════════════════════════════════════════════
        // ① 429 + 配额重置：暂停到「重置 + 2 分钟」，reason=quota_exhausted
        // ═══════════════════════════════════════════════════════════════
        {
            const { h, logs } = mk();
            const now = RESET_AT - 90 * MIN;
            const r = h.noteFailure(mkErr(429, QUOTA_BODY), now);
            const st = h.getStatus();
            ok('429+重置时刻 → pausedUntil = 重置 + 2 分钟',
                st.pausedUntil === RESET_AT + 2 * MIN, 'pausedUntil=' + st.pausedUntil + ' 期望=' + (RESET_AT + 2 * MIN));
            ok('429+重置时刻 → source=quota_exhausted', st.source === 'quota_exhausted', st.source);
            ok('noteFailure 返回 retryAt = pausedUntil', r.retryAt === RESET_AT + 2 * MIN, String(r.retryAt));
            const gate = h.canCall(now);
            ok('canCall 在暂停窗口内 → ok:false + reason + retryAt',
                gate.ok === false && gate.reason === 'quota_exhausted' && gate.retryAt === st.pausedUntil,
                JSON.stringify(gate));
            ok('暂停窗口结束前 1ms 仍不可调', h.canCall(st.pausedUntil - 1).ok === false);
            ok('暂停窗口到点后放行', h.canCall(st.pausedUntil).ok === true, JSON.stringify(h.canCall(st.pausedUntil)));
            ok('状态迁移只告警一次（重复失败同一窗口不刷屏）',
                logs.filter((m) => /quota_exhausted/.test(m)).length === 1, 'logs=' + logs.length);
        }

        // ═══════════════════════════════════════════════════════════════
        // ② 解析容错：插件层附带的 quotaResetAt / 纯文本 resets at / 秒级时间戳
        // ═══════════════════════════════════════════════════════════════
        {
            ok('__test.parseQuotaResetAt 认 err.quotaResetAt', T.parseQuotaResetAt({ quotaResetAt: RESET_AT }) === RESET_AT);
            ok('__test.parseQuotaResetAt 从纯文本 resets at 解析',
                T.parseQuotaResetAt({ body: 'Your limit resets at 2026-11-24T08:30:32.238Z' }) === RESET_AT);
            ok('__test.parseQuotaResetAt 认秒级 resets_at',
                T.parseQuotaResetAt({ body: JSON.stringify({ resets_at: Math.floor(RESET_AT / 1000) }) }) === Math.floor(RESET_AT / 1000) * 1000);
            const { h } = mk();
            const now = RESET_AT - 10 * MIN;
            h.noteFailure(mkErr(429, '', { quotaResetAt: RESET_AT }), now);
            ok('插件层已解析的 quotaResetAt 优先于响应体',
                h.getStatus().pausedUntil === RESET_AT + 2 * MIN, 'pausedUntil=' + h.getStatus().pausedUntil);
        }

        // ═══════════════════════════════════════════════════════════════
        // ③ 429 无重置时刻 / 网络错误：指数退避 5→10→20→40
        // ═══════════════════════════════════════════════════════════════
        {
            const { h } = mk();
            const now = Date.parse('2026-11-24T10:00:00Z');
            const seen = [];
            for (let i = 0; i < 4; i += 1) {
                h.noteFailure(i === 0 ? mkErr(429, 'rate limited') : mkErr(0, ''), now);
                const st = h.getStatus();
                seen.push((st.nextAttemptAt - now) / MIN);
            }
            ok('退避阶梯 5/10/20/40 分钟', JSON.stringify(seen) === JSON.stringify([5, 10, 20, 40]), JSON.stringify(seen));
            const { h: h5 } = mk();
            h5.noteFailure(mkErr(503, 'upstream 503'), now);
            const s5 = h5.getStatus();
            ok('5xx 也走退避（且 source=backoff）',
                s5.source === 'backoff' && s5.nextAttemptAt === now + 5 * MIN, JSON.stringify({ source: s5.source, at: s5.nextAttemptAt }));
            const gate = h5.canCall(now + MIN);
            ok('退避窗口内 canCall → reason=backoff', gate.ok === false && gate.reason === 'backoff', JSON.stringify(gate));
            ok('未到退避时刻不放行 / 到点放行',
                h5.canCall(now + 5 * MIN - 1).ok === false && h5.canCall(now + 5 * MIN).ok === true);
        }

        // ═══════════════════════════════════════════════════════════════
        // ④ Retry-After：比退避更大就尊重；单次封顶 6 小时
        // ═══════════════════════════════════════════════════════════════
        {
            const { h } = mk();
            const now = Date.parse('2026-11-24T10:00:00Z');
            h.noteFailure(mkErr(429, JSON.stringify({ retry_after: 3600 })), now);
            ok('body.retry_after（秒）被尊重', h.getStatus().nextAttemptAt === now + 3600 * 1000,
                String(h.getStatus().nextAttemptAt - now));
            const { h: h2 } = mk();
            h2.noteFailure(mkErr(429, '', { headers: { 'retry-after': '7200' } }), now);
            ok('Retry-After 头（秒）被尊重', h2.getStatus().nextAttemptAt === now + 7200 * 1000);
            const { h: h3 } = mk();
            h3.noteFailure(mkErr(429, JSON.stringify({ retry_after: 10 * 3600 })), now);
            ok('单次退避封顶 6 小时', h3.getStatus().nextAttemptAt === now + 6 * 3600 * 1000,
                String((h3.getStatus().nextAttemptAt - now) / 3600000) + 'h');
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑤ 连败 ≥5 → 停到下一个本地 00:05（day_stop）
        // ═══════════════════════════════════════════════════════════════
        {
            const { h, logs } = mk();
            const now = Date.parse('2026-11-24T10:00:00Z');
            for (let i = 0; i < 5; i += 1) h.noteFailure(mkErr(0, ''), now);
            const st = h.getStatus();
            const expect = T.nextDayStop(now);
            ok('连败 5 次 → source=day_stop', st.source === 'day_stop', st.source);
            ok('连败 5 次 → pausedUntil = 下一个本地 00:05', st.pausedUntil === expect,
                new Date(st.pausedUntil).toString() + ' / 期望 ' + new Date(expect).toString());
            ok('day_stop 时 nextAttemptAt 归零', st.nextAttemptAt === 0);
            ok('day_stop 只告警一次', logs.filter((m) => /day_stop|今天不再调用/.test(m)).length === 1);
            ok('day_stop 窗口内 canCall 拒绝', h.canCall(now).ok === false && h.canCall(now).reason === 'day_stop');
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑥ 非健康类错误（400）：记失败但不暂停；成功清空一切
        // ═══════════════════════════════════════════════════════════════
        {
            const { h } = mk();
            const now = Date.parse('2026-11-24T10:00:00Z');
            h.noteFailure(mkErr(400, JSON.stringify({ error: { message: 'bad request' } })), now);
            const st = h.getStatus();
            ok('400 不触发退避/暂停（可继续调）',
                h.canCall(now).ok === true && st.nextAttemptAt === 0 && st.pausedUntil === 0, JSON.stringify(st));
            ok('400 仍计入连续失败（≥5 会停当天）', st.consecutiveFailures === 1, String(st.consecutiveFailures));
            h.noteSuccess();
            const after = h.getStatus();
            ok('成功 → 连续失败/退避/暂停/错误摘要全清',
                after.consecutiveFailures === 0 && after.nextAttemptAt === 0 && after.pausedUntil === 0 &&
                after.lastError === null && after.source === 'none', JSON.stringify(after));
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑦ 持久化跨实例 + getStatus 字段 + 错误摘要脱敏
        // ═══════════════════════════════════════════════════════════════
        {
            const p = statePath();
            const { h } = mk({ path: p });
            const now = RESET_AT - 60 * MIN;
            h.noteFailure(mkErr(429, QUOTA_BODY + ' sk-abcdef123456'), now);
            ok('状态文件已落盘', fs.existsSync(p), p);
            const { h: h2 } = mk({ path: p });
            const st2 = h2.getStatus();
            ok('新实例从磁盘恢复暂停窗口', st2.pausedUntil === RESET_AT + 2 * MIN && st2.source === 'quota_exhausted',
                JSON.stringify({ pausedUntil: st2.pausedUntil, source: st2.source }));
            ok('新实例 canCall 同样拒绝', h2.canCall(now).ok === false);
            const keys = Object.keys(st2).sort().join(',');
            ok('getStatus 字段齐全', keys === 'consecutiveFailures,lastError,lastErrorAt,nextAttemptAt,pausedUntil,source,updated_at', keys);
            ok('lastError 不含明文 key', !/sk-abcdef123456/.test(String(st2.lastError)), String(st2.lastError).slice(0, 80));
            ok('lastErrorAt 记录失败时刻', st2.lastErrorAt === now);
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑧ 过期清理：窗口过去后 canCall 放行并落盘
        // ═══════════════════════════════════════════════════════════════
        {
            const p = statePath();
            const { h } = mk({ path: p });
            const now = RESET_AT - 60 * MIN;
            h.noteFailure(mkErr(429, QUOTA_BODY), now);
            const later = RESET_AT + 3 * MIN;
            const gate = h.canCall(later);
            const st = h.getStatus();
            ok('窗口过期 → canCall 放行且清状态',
                gate.ok === true && st.pausedUntil === 0 && st.nextAttemptAt === 0 && st.source === 'none',
                JSON.stringify({ gate, st }));
            const disk = JSON.parse(fs.readFileSync(p, 'utf8'));
            ok('过期清理已写盘', disk.pausedUntil === 0 && disk.source === 'none');
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑨ resetForTests 隔离
        // ═══════════════════════════════════════════════════════════════
        {
            const p = statePath();
            const { h } = mk({ path: p });
            h.noteFailure(mkErr(429, QUOTA_BODY), Date.now());
            h.resetForTests();
            ok('resetForTests 清空内存状态',
                h.getStatus().pausedUntil === 0 && h.getStatus().consecutiveFailures === 0 &&
                h.canCall().ok === true);
            ok('resetForTests 清掉隔离状态文件', !fs.existsSync(p));
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑩ plugin-context 错误透出（响应体/重试/重置时刻不丢）
        // ═══════════════════════════════════════════════════════════════
        {
            const info = PC.__test.extractLlmErrorInfo(QUOTA_BODY, {});
            ok('plugin-context 从响应体解析出 quotaResetAt', info.quotaResetAt === RESET_AT, String(info.quotaResetAt));
            ok('plugin-context 提取 error.message 作为人话', /weekly usage limit/.test(info.message), info.message.slice(0, 60));
            const info2 = PC.__test.extractLlmErrorInfo('{"retry_after": 90}', {});
            ok('plugin-context 解析 retry_after（秒→毫秒）', info2.retryAfterMs === 90000, String(info2.retryAfterMs));
            const info3 = PC.__test.extractLlmErrorInfo('', { 'retry-after': '30' });
            ok('plugin-context 读 Retry-After 头', info3.retryAfterMs === 30000, String(info3.retryAfterMs));
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑪ background-llm：配置开关 + 共享熔断
        // ═══════════════════════════════════════════════════════════════
        {
            const p = statePath();
            H.llmHealth.resetForTests({ path: p });
            ok('background-llm 默认允许（配置缺省）',
                BL.isEnabled({ getConfig: () => ({}) }) === true &&
                BL.isEnabled({ getConfig: () => ({ cost: {} }) }) === true);
            ok('background-llm 认 cost.background_llm=false',
                BL.isEnabled({ getConfig: () => ({ cost: { background_llm: false } }) }) === false);
            const off = BL.canRun({ getConfig: () => ({ cost: { background_llm: false } }) }, Date.now());
            ok('background-llm 关闭时 canRun.reason=disabled', off.ok === false && off.reason === 'disabled', JSON.stringify(off));
            const now = RESET_AT - 60 * MIN;
            H.llmHealth.noteFailure(mkErr(429, QUOTA_BODY), now);
            const blocked = BL.canRun({ getConfig: () => ({}) }, now);
            ok('background-llm 共享熔断（reason 透传）',
                blocked.ok === false && blocked.reason === 'quota_exhausted' && blocked.retryAt === RESET_AT + 2 * MIN,
                JSON.stringify(blocked));
            H.llmHealth.noteSuccess();
            ok('成功后 background-llm 恢复可跑', BL.canRun({ getConfig: () => ({}) }, now).ok === true);
        }

        // ═══════════════════════════════════════════════════════════════
        // ⑫ P0-2（2026-11-25）：网络失败（status=0）必须有 producer
        //    审计：llm-health 的 `status===0` 分支存在，但 fetch reject / 超时 /
        //    ECONNRESET 没人记 → ensureCanRun 永远放行，后台每周期继续撞。
        // ═══════════════════════════════════════════════════════════════
        {
            const api = require(path.join(LIVE, 'js', 'api-utils.js'));

            // ── 判据（只认网络/中断特征或网络码；编程型 TypeError 不算）──
            ok('isNetworkError: fetch failed / TypeError', api.isNetworkError(new TypeError('fetch failed')) === true);
            ok('isNetworkError: ECONNRESET', api.isNetworkError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })) === true);
            ok('isNetworkError: 编程型 TypeError（x is not a function）**不算**网络错误',
                api.isNetworkError(new TypeError('x is not a function')) === false);
            ok('isNetworkError: 编程型 TypeError（Cannot read properties）不算',
                api.isNetworkError(new TypeError('Cannot read properties of undefined (reading \'a\')')) === false);
            ok('isNetworkError: AbortError（用户主动打断）不算网络错误',
                api.isNetworkError(Object.assign(new Error('aborted'), { name: 'AbortError' })) === false);
            ok('isNetworkError: code=ABORT_ERR 不算网络错误',
                api.isNetworkError(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })) === false);
            ok('isNetworkError: code=ENOTFOUND / ETIMEDOUT 认（即使 message 无特征）',
                api.isNetworkError(Object.assign(new Error('boom'), { code: 'ENOTFOUND' })) === true
                && api.isNetworkError(Object.assign(new Error('boom'), { code: 'ETIMEDOUT' })) === true);
            ok('isNetworkError: 请求 deadline 超时（PLUGIN_LLM_TIMEOUT）算传输失败',
                api.isNetworkError(Object.assign(new Error('Plugin LLM request timed out after 1000ms'),
                    { name: 'TimeoutError', code: 'PLUGIN_LLM_TIMEOUT' })) === true);
            ok('isNetworkError: 有 HTTP 状态 → 不算网络错误（429 走原路径）',
                api.isNetworkError(Object.assign(new Error('LLM API error: 429'), { status: 429 })) === false);
            ok('isNetworkError: 普通业务错误不误判', api.isNetworkError(new Error('bad json')) === false);

            // ── status=0 退避分支可达 + 文案标明「网络错误」──
            {
                const { h, logs } = mk();
                const now = Date.parse('2026-11-25T10:00:00Z');
                const r = h.noteFailure({ status: 0, reason: 'network', message: 'fetch failed' }, now);
                const st = h.getStatus();
                ok('status=0 → source=backoff、退避 5 分钟',
                    st.source === 'backoff' && st.nextAttemptAt === now + 5 * MIN, JSON.stringify({ source: st.source, at: st.nextAttemptAt - now }));
                ok('status=0 → canCall 立即拒绝（reason=backoff）',
                    h.canCall(now).ok === false && h.canCall(now).reason === 'backoff');
                ok('status=0 的日志文案说明是网络错误', logs.some((m) => /网络错误/.test(m)), logs.join(' | ').slice(0, 80));
                ok('noteFailure 返回 retryAt = 退避到点', r.retryAt === now + 5 * MIN, String(r.retryAt));
                // 第二次网络失败 → 10 分钟（阶梯真的在走）
                h.noteFailure({ status: 0, message: 'fetch failed' }, now);
                ok('连续网络失败 5→10 分钟', h.getStatus().nextAttemptAt === now + 10 * MIN,
                    String((h.getStatus().nextAttemptAt - now) / MIN));
            }

            // ── api-utils.noteLlmNetworkFailure：记账 + 同一错误只记一次 ──
            {
                const p = statePath();
                H.llmHealth.resetForTests({ path: p });
                // 编程型 TypeError 必须**不**记账（旧实现会把 callLLM 内部 bug 误判成网络故障，
                // 后台被无谓熔断 5 分钟）
                const progErr = new TypeError('x is not a function');
                ok('noteLlmNetworkFailure：编程型 TypeError 不 noteFailure（状态保持空）',
                    api.noteLlmNetworkFailure(progErr) === false
                    && H.llmHealth.getStatus().consecutiveFailures === 0
                    && H.llmHealth.canCall().ok === true);

                const netErr = new TypeError('fetch failed');
                const t0 = Date.now();
                ok('noteLlmNetworkFailure 记一次（返回 true）', api.noteLlmNetworkFailure(netErr) === true);
                const st = H.llmHealth.getStatus();
                ok('共享熔断已进入 backoff（1 次失败）',
                    st.consecutiveFailures === 1 && st.source === 'backoff', JSON.stringify({ n: st.consecutiveFailures, src: st.source }));
                const waitMin = (st.nextAttemptAt - t0) / MIN;
                ok('网络失败退避 ≈5 分钟', waitMin > 4.5 && waitMin < 5.5, waitMin.toFixed(2) + 'min');
                ok('同一条错误再记一次被跳过（不重复计数）',
                    api.noteLlmNetworkFailure(netErr) === false && H.llmHealth.getStatus().consecutiveFailures === 1);
                ok('错误对象带 __llmHealthNoted（调用方 catch 再记会被 llm-health 跳过）',
                    netErr.__llmHealthNoted === true);
                ok('带着标记的错误再进 noteFailure 不计数',
                    (H.llmHealth.noteFailure(netErr), H.llmHealth.getStatus().consecutiveFailures === 1));
                ok('HTTP 429 错误不会被网络分支记账',
                    api.noteLlmNetworkFailure(Object.assign(new Error('429'), { status: 429 })) === false
                    && H.llmHealth.getStatus().consecutiveFailures === 1);
            }

            // ── 连败 5 次网络错误 → 停当天（与 HTTP 失败同一条规则）──
            {
                const p = statePath();
                H.llmHealth.resetForTests({ path: p });
                const now = Date.parse('2026-11-25T10:00:00Z');
                for (let i = 0; i < 4; i += 1) H.llmHealth.noteFailure({ status: 0, message: 'fetch failed' }, now);
                ok('4 次网络失败仍在 backoff（未停当天）', H.llmHealth.getStatus().source === 'backoff');
                H.llmHealth.noteFailure({ status: 0, message: 'fetch failed' }, now);
                ok('第 5 次网络失败 → day_stop', H.llmHealth.getStatus().source === 'day_stop',
                    H.llmHealth.getStatus().source);
                ok('day_stop 后 background-llm.canRun=false',
                    BL.canRun({ getConfig: () => ({}) }, now).ok === false);
                H.llmHealth.noteSuccess();
                ok('成功清空后 canRun 恢复', BL.canRun({ getConfig: () => ({}) }, now).ok === true
                    && H.llmHealth.getStatus().consecutiveFailures === 0);
            }

            // ── plugin-context.callLLM：fetch reject 真的落进熔断（端到端）──
            {
                const p = statePath();
                H.llmHealth.resetForTests({ path: p });
                const origFetch = global.fetch;
                global.fetch = async () => { throw new TypeError('fetch failed'); };
                let thrown = null;
                try {
                    await PC.PluginContext.prototype.callLLM.call({}, 'hi', {
                        api_url: 'http://127.0.0.1:9/v1', api_key: 'k', model: 'm',
                    });
                } catch (e) { thrown = e; }
                finally { global.fetch = origFetch; }
                ok('callLLM 网络失败原样抛出（不吞错）', !!thrown && /fetch failed/.test(String(thrown.message)));
                ok('callLLM 网络失败已记进 llm-health（status=0）',
                    H.llmHealth.getStatus().consecutiveFailures === 1 && H.llmHealth.getStatus().source === 'backoff',
                    JSON.stringify({ n: H.llmHealth.getStatus().consecutiveFailures, src: H.llmHealth.getStatus().source }));
                ok('抛出的错误带 __llmHealthNoted（调用方再记不双计）', thrown && thrown.__llmHealthNoted === true);
                ok('ensureCanRun/后台闸随即拒绝（同一份共享状态）',
                    BL.ensureCanRun({ getConfig: () => ({}) }, { kind: 'probe-net' }).ok === false
                    || BL.canRun({ getConfig: () => ({}) }).ok === false);
            }

            // ── plugin-context.callLLM：HTTP 429 也进熔断（旧实现整条路径无 producer）──
            {
                const p = statePath();
                H.llmHealth.resetForTests({ path: p });
                const origFetch = global.fetch;
                global.fetch = async () => ({
                    ok: false,
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: { get: () => null },
                    text: async () => '{"error":{"message":"rate limited"}}',
                });
                let thrown = null;
                try {
                    await PC.PluginContext.prototype.callLLM.call({}, 'hi', {
                        api_url: 'http://127.0.0.1:9/v1', api_key: 'k', model: 'm',
                    });
                } catch (e) { thrown = e; }
                finally { global.fetch = origFetch; }
                ok('callLLM 429 错误对象形状不变（status 仍在）', !!thrown && thrown.status === 429, thrown && String(thrown.status));
                ok('callLLM 429 也进 llm-health（backoff）',
                    H.llmHealth.getStatus().consecutiveFailures === 1 && H.llmHealth.getStatus().source === 'backoff',
                    JSON.stringify({ n: H.llmHealth.getStatus().consecutiveFailures, src: H.llmHealth.getStatus().source }));
                ok('429 错误同样带 __llmHealthNoted（memory-evolve 再记不双计）',
                    thrown && thrown.__llmHealthNoted === true
                    && (H.llmHealth.noteFailure(thrown), H.llmHealth.getStatus().consecutiveFailures === 1));
            }
        }
    } finally {
        try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响结论 */ }
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('  ✗ 测试自身异常：' + ((e && e.stack) || e));
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    process.exit(1);
});
