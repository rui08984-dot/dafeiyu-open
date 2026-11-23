// verify-contract.js —— 统一结果契约（2026-11-09 三十五轮）
//
// 为什么单独做一个模块：
//   交接件 §12 定的根因是「把工具调用的成功当成任务的完成」——26 个 ok:true 里 24 个没验证。
//   但只「加验证」不够：如果每个动作各自拼 evidence 文案、各自决定 verified 是 true/false/null，
//   下次还是会漂。所以先定契约，所有动作都往同一个形状里填。
//
// 契约字段：
//   ok           动作本身有没有发出去（向后兼容，LLM 和历史调用方都在看这个）
//   verified     验证结论的真值来源：
//                  true  = 有可观测后果，且后果符合预期
//                  false = 有可观测后果，但不符合预期（做错了 / 没生效）
//                  null  = 无法验证（纯查询 / 环境不支持），调用方必须当成「未知」而不是「成功」
//   unverified   便捷布尔：=== (verified === null)，给只看布尔的地方用
//   effect       细粒度结论（借 ZCode CUA 的词汇，比 true/false 信息量大）：
//                  'confirmed'     确认生效
//                  'confirmed_idempotent' 确认生效，但动作前后状态一样（本来就那样，比如输入框已有同值）
//                  'suspected_noop' 前后状态一致，怀疑没效果（真危险信号）
//                  'unverifiable'  没法判断
//   evidence     人话证据（「画面变化距离 18，用了 340ms」），给 LLM 看，让它能自己决定要不要重试
//   nextIfFailed 失败时建议的下一步（LLM 最需要的字段：不是「失败了」而是「接下来试什么」）
//   tier         用的哪一档验证：'L1' 像素 / 'L2' UI树 / 'L3' 无验证
//   action_sent  动作有没有真的发出去（和 ok 的区别：ok=false + action_sent=true 表示
//                「发出去了但不确定成没成」，这种情况绝不能重试，会做两遍）
//   costMs       验证花了多少毫秒（成本可见，防止偷偷加 2 秒）

'use strict';

const TIER = Object.freeze({ L1: 'L1', L2: 'L2', L3: 'L3' });

/**
 * 造一个结果对象。所有字段都有默认值，调用方只填知道的。
 * @param {object} o
 * @returns {object}
 */
function result(o) {
    const src = o || {};
    const verified = src.verified === true ? true : src.verified === false ? false : null;
    const out = {
        ok: src.ok === true,
        verified,
        unverified: verified === null,
        // 兼容旧字段：有些调用方已经在看 res.ok / res.detail
        detail: src.detail === undefined ? '' : String(src.detail),
    };
    if (src.effect) out.effect = String(src.effect);
    if (src.evidence) out.evidence = String(src.evidence);
    if (src.nextIfFailed) out.nextIfFailed = String(src.nextIfFailed);
    if (src.tier) out.tier = String(src.tier);
    if (src.action_sent !== undefined) out.action_sent = src.action_sent === true;
    // ⚠ 2026-11-10 三十六轮加固（回归测试用例 9 的「潜在暗门」）：
    //   六个工厂都是 `Object.assign({默认值}, extra)` —— extra 能覆盖 `action_sent`，
    //   于是能造出 `confirmed + action_sent:false`（生效了但说没发）和
    //   `not_sent + action_sent:true`（没发但说发了）这种自相矛盾的契约。
    //   生产代码目前没有这么调（grep 过，全库只有两处显式传，都传 false 配 not_sent），
    //   但这属于「类型系统没挡住」的坑：将来谁手滑传一次，调用方就会做出错误判断
    //   （action_sent 是唯一能决定「能不能安全重试」的字段，重试就是做两遍）。
    //   这里按 effect 语义强制纠正 —— 表里没有的 effect 不碰，保持扩展性。
    const EFFECT_MEANS_SENT = {
        confirmed: true, confirmed_idempotent: true,
        suspected_noop: true, unverifiable: true,
        not_sent: false, readonly: false,
    };
    if (out.effect && Object.prototype.hasOwnProperty.call(EFFECT_MEANS_SENT, out.effect)
        && out.action_sent !== undefined
        && EFFECT_MEANS_SENT[out.effect] !== out.action_sent) {
        out.action_sent = EFFECT_MEANS_SENT[out.effect];
        out.actionSentCorrected = true;   // 留痕：审计时能看到「这里被纠正过」
    }
    if (Number.isFinite(src.costMs)) out.costMs = Math.round(src.costMs);
    if (src.error) out.error = String(src.error);
    // 其余业务字段原样带出去（elements / image / pos / players …），不做白名单
    // —— 白名单透传已经踩过三次坑（SoM / mc / pvz 都因为字段被丢而「后端算了但 AI 拿不到」）
    for (const k of Object.keys(src)) {
        if (out[k] === undefined) out[k] = src[k];
    }
    return out;
}

/**
 * ensure(raw, opts) —— 把**现成的**返回对象补成合法契约（A3，2026-11-21）。
 *
 * 与 result() 的分工：
 *   result() 是「造」新结果（调用方知道每个字段该填什么）；
 *   ensure() 是「修」现成对象（历史动作 / 外部执行器 / 插件返回的形状）。
 *
 * 硬约束（A3 验收口径）：
 *   ① 失败必须有 detail —— 否则补一句并把 `_backfilled:true` 留痕，
 *      审计据此统计「有多少工具失败却不说原因」（验收要求 0）；
 *   ② ok/verified/effect/action_sent 的自洽交给 result()（它已做纠正与留痕）；
 *   ③ 不改其它业务字段（result 的白名单透传会原样带出）。
 *
 * 「没有 ok 字段」按**成功**处理：历史只读工具（see 的 windows 列表等）从不写 ok，
 * 只有显式 ok:false 或「有 error 但没 ok」才算失败 —— 与 js/core/tool-result.js 同一口径。
 *
 * @param {any} raw - 任意形状：对象 / JSON 字符串 / 字符串 / null
 * @param {{name?:string, fallbackDetail?:string}} [opts]
 * @returns {object} 合法契约
 */
function ensure(raw, opts) {
    const o = opts || {};
    let src = raw;
    if (typeof src === 'string') {
        const s = src.trim();
        if (s && (s[0] === '{' || s[0] === '[')) {
            try { src = JSON.parse(s); } catch (e) { src = { ok: true, detail: s }; }
        } else {
            src = { ok: true, detail: s };
        }
    }
    if (!src || typeof src !== 'object' || Array.isArray(src)) {
        src = { ok: false, detail: '' };
    }
    const ok = src.ok === true || (src.ok === undefined && !src.error);
    const r = result(Object.assign({}, src, {
        ok,
        detail: src.detail || src.error || src.message || '',
    }));
    if (!r.ok && !r.detail) {
        r.detail = String(o.fallbackDetail || ('工具 ' + (o.name || '?') + ' 失败（工具未给原因）'));
        r._backfilled = true;
    }
    return r;
}

/** 成功且有可观测证据。 */
function confirmed(detail, extra) {
    const o = Object.assign({ ok: true, verified: true, effect: 'confirmed', detail, tier: TIER.L1 }, extra || {});
    if (o.action_sent === undefined) o.action_sent = true;   // 生效了 = 一定发出去了
    return result(o);
}

/** 成功但前后状态一样（本来就已经是那样了，不是失败）。 */
function idempotent(detail, extra) {
    const o = Object.assign({ ok: true, verified: true, effect: 'confirmed_idempotent', detail, tier: TIER.L1 }, extra || {});
    if (o.action_sent === undefined) o.action_sent = true;
    return result(o);
}

/** 发出去了，但观测到「没有达到预期效果」。这是最需要警惕的一档。 */
function failed(detail, extra) {
    const o = Object.assign({ ok: false, verified: true, effect: 'suspected_noop', detail, tier: TIER.L1 }, extra || {});
    // ⚠ 关键：failed 的 action_sent 默认 true —— 动作发出去了、只是没效果。
    //   调用方据此知道「不能盲目重试」（重试可能做两遍）。
    //   真的是「没发出去」请用 notSent()，不要用 failed()。
    if (o.action_sent === undefined) o.action_sent = true;
    return result(o);
}

/** 发出去了，但环境不支持验证。ok 仍然为 true（动作大概率生效了），但必须标明未知。 */
function unverified(detail, extra) {
    const o = Object.assign({ ok: true, verified: null, effect: 'unverifiable', detail, tier: TIER.L3 }, extra || {});
    if (o.action_sent === undefined) o.action_sent = true;
    return result(o);
}

/** 纯查询/只读：没有「后果」可言，不该被算进验证覆盖率。 */
function readonly(detail, extra) {
    return result(Object.assign({ ok: true, verified: null, effect: 'readonly', detail, tier: TIER.L3, action_sent: false }, extra || {}));
}

/** 动作根本没发出去（前置检查拦住 / 参数不合法）。
 *
 * ⚠ 2026-11-10 三十六轮补：**必须同时写 `error`**。
 *   回归测试实测（`_probe/regress-fake-success.cjs` 用例 5d/6d）：
 *   `wgc_shot` 抓不存在的窗口 / 抓最小化窗口，返回里 `error` 恒为 `undefined`，
 *   失败原因只写在 `detail`。而调用方（LLM/上层插件）习惯按 `r.error` 判失败 ——
 *   按那个判据看就是「没报错」，等于把失败又说成了一次成功。
 *   `detail` 是给人看的话术，`error` 是给代码看的判据，两个都要有。
 */
function notSent(detail, extra) {
    const base = {
        ok: false, verified: null, effect: 'not_sent', detail,
        tier: TIER.L3, action_sent: false,
        error: String(detail || '动作未发出'),
    };
    return result(Object.assign(base, extra || {}));
}

/**
 * 从 actAndVerify 的原始返回翻译成契约形状。
 * actAndVerify 返回：{ ok, actionResult, verified, changed, dist, elapsed, hint, note }
 * @param {object} av actAndVerify 的返回值
 * @param {object} meta { detail, name }
 */
function fromActAndVerify(av, meta) {
    const m = meta || {};
    const name = m.name || '动作';
    if (!av || !av.verified) {
        // 无法验证的三种情况要分开说（2026-11-09：原来都写「拍不到画面」，不准确）：
        //   ① 画面在动（基线抖动大）→ 前后对比本身无效
        //   ② 真拍不到（屏幕捕获不可用）
        const jitter = av && Number.isFinite(av.jitter) ? av.jitter : null;
        const sent = av && av.actionResult && av.actionResult.ok !== false;
        let why;
        let next;
        if (jitter !== null) {
            why = '画面本身在动（基线抖动 ' + jitter + '，静止时应 ≤10），前后对比不可信';
            next = '等画面静下来（暂停视频/停下游戏动画）再试；或者用 snapshot / UIA 树对比代替像素对比';
        } else if (av && av.note) {
            why = String(av.note);
            next = '屏幕捕获不可用：检查 pet-core 二进制是否存在（pet-core/target/release/pet-core.exe）或回落到 Python 版';
        } else {
            why = '拍不到画面';
            next = '检查 screen-hash 链路（Rust pet-core 或 Python 兜底）';
        }
        return result({
            ok: !!sent,
            verified: null,
            // ⚠ 2026-11-10 三十六轮修（回归测试 9b 的第二半）：
            //   这里原来无论 sent 真假都写 `effect:'unverifiable'` + detail `name + '已执行'`。
            //   但 `actionResult.ok === false` 时动作**根本没发出去** —— 说「已执行」是假的，
            //   而且 `unverified:true` 还会让调用方以为「发了但不知道效果」。
            //   现在拆开：没发 → `not_sent`（确定没做），发了但拍不到 → `unverifiable`（不知道）。
            effect: sent ? 'unverifiable' : 'not_sent',
            detail: (m.detail || name) + (sent ? '已执行' : ' 没发出去') +
                '（' + (jitter !== null ? '画面在动，无法验证效果' : '无法验证效果') + '）',
            ...(sent ? {} : {
                error: String((av && av.actionResult && av.actionResult.error) || '动作未发出').slice(0, 200),
            }),
            evidence: why,
            tier: TIER.L3,
            action_sent: !!sent,
            ...(jitter !== null ? { jitter } : {}),
            nextIfFailed: sent ? next : '动作没发出去：检查 pwsh / pet-core 是否可用、目标窗口是否还在、参数是否合法',
            actionResult: av && av.actionResult,
        });
    }
    const changed = av.changed === true;
    const dist = Number.isFinite(av.dist) ? av.dist : null;
    const ms = Number.isFinite(av.elapsed) ? av.elapsed : null;
    // 画面确实变了 → 不管动作返回什么，它一定发出去了
    const sent = changed || !!(av.actionResult && av.actionResult.ok !== false);
    if (changed) {
        return result({
            ok: true, verified: true, effect: 'confirmed',
            detail: m.detail || name + '已执行',
            evidence: '画面确实变了（像素距离 ' + dist + '，观测 ' + ms + 'ms）',
            tier: TIER.L1, action_sent: sent, costMs: ms,
            actionResult: av.actionResult,
        });
    }
    // ⚠ 2026-11-10 三十六轮修（回归测试用例 9b 抓到的**最核心**的一个假成功）：
    //   原来这里不管 `sent` 是什么，都返回 `suspected_noop` + detail「已执行，但画面没变化」。
    //   但 `suspected_noop` 的定义是「**发出去了**但没效果」；当 `av.actionResult.ok === false`
    //   时动作**根本没发出去**（pwsh 失败 / 超时 / pet-core 不存在），`sent` 就是 false。
    //   于是产出 `{effect:'suspected_noop', action_sent:false, detail:'…已执行…'}` ——
    //   三个字段互相打脸：说「疑似空转」又说「没发」还说「已执行」。
    //   生产可达：`clickAt()` 底层是 runPs，任一失败就返回 ok:false，
    //   `click_at` / `click_text` / `click_element` / `som_click` **全部**会走进这个错位分支。
    //   正确语义：没发出去 = `not_sent`，而且 verified 仍是 true（我们确实做了前后对比，只是没东西可对比）。
    if (!sent) {
        const ar = av.actionResult || {};
        return result({
            ok: false, verified: true, effect: 'not_sent',
            detail: (m.detail || name) + ' 没发出去（底层动作返回失败）',
            evidence: '底层动作 ok:false' + (ar.error ? '：' + String(ar.error).slice(0, 120) : ''),
            error: String(ar.error || '动作未发出').slice(0, 200),
            tier: TIER.L1, action_sent: false, costMs: ms,
            nextIfFailed: '动作没发出去：检查 pwsh / pet-core 是否可用、目标窗口是否还在、参数是否合法',
            actionResult: av.actionResult,
        });
    }
    return result({
        ok: false, verified: true, effect: 'suspected_noop',
        detail: (m.detail || name + '已执行') + '，但画面没变化',
        evidence: '像素距离 ' + dist + '（阈值 5），观测 ' + ms + 'ms',
        hint: av.hint || '',
        tier: TIER.L1, action_sent: sent, costMs: ms,
        nextIfFailed: av.hint || '画面没变：可能被弹窗挡住 / 目标坐标是空的 / 动作真的没生效。先 snapshot 或截图确认现场，再换方式',
        actionResult: av.actionResult,
    });
}

/**
 * 统计一批动作的验证覆盖率（给 doctor / 审计用）。
 * @param {Array<object>} results
 */
function coverage(results) {
    const rs = (results || []).filter((r) => r && r.effect !== 'readonly');
    const total = rs.length;
    const verified = rs.filter((r) => r.verified === true || r.verified === false).length;
    const unknown = rs.filter((r) => r.verified === null).length;
    const noop = rs.filter((r) => r.effect === 'suspected_noop').length;
    return { total, verified, unknown, noop, rate: total ? Math.round((verified / total) * 100) : 0 };
}

module.exports = { result, ensure, confirmed, idempotent, failed, unverified, readonly, notSent, fromActAndVerify, coverage, TIER };
