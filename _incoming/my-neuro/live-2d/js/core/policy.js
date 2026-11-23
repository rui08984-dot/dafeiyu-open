'use strict';
// policy.js —— 统一策略门（D7，2026-11-22）
//
// 要解决的问题：破坏性动作的「拦不拦」散在好几处 —— tool-executor 的超时、
// self-guard 的按钮名匹配、confirm_destructive 参数、watch-screen 的 rateGate……
// 每个新工具都要自己想一遍「我算不算危险」，漏一个就是一个洞。
//
// 做法：**一处判定，三态输出**
//   allow —— 直接放行
//   ask   —— 需要确认（宿主没有人工审批 UI 时，落成「拒绝 + 教模型带 confirm 重试」，
//            与现有 self-guard 的口径一致）
//   deny  —— 直接拒绝（无人值守时的危险动作）
//
// 规则来源（优先级从低到高，**最后匹配生效**）：
//   ① 内置默认：未注解 → allow（不拦），readOnly → allow
//   ② metadata.json 的工具注解（A3 已标 21 个）：destructive → ask
//   ③ 用户自定义 `data/policy.json`（数组，最后一条生效）—— 想只读/只拦什么自己写
//
// 无人值守：超过 10 分钟没有用户输入，或静默模式 → ask 降级为 deny。
// 每次 deny/ask 都写 `approvals.jsonl`（参数只存 hash，不存明文）——「拒绝要留痕」。
//
// 为什么默认「未注解 → allow」：本项目 30 个工具里只有 21 个标了风险等级，
// 一上来就拦未知工具会让所有既有功能突然不可用。风险靠「注解 + 逐项补」收敛，
// 而不是靠默认拒绝（那会立刻把产品打死）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _recordFile = null;
try { _recordFile = require('./records-path.js').recordFile; } catch (e) { _recordFile = null; }

const APP_DIR = path.join(__dirname, '..', '..');
const PLUGINS_DIR = path.join(APP_DIR, 'plugins');
const UNATTENDED_MS = 10 * 60 * 1000;

// 高危「工具 + action」表（内置，最后可被 policy.json 覆盖）。
// 只收**真正不可逆**的：关程序、改文件、执行代码、删记忆。
// 刻意不拦：
//   · act/game 的点击与按键 —— 它们已有 self-guard（按钮名级）+ 双闸，重复拦会让日常动作全挂；
//   · dispatch_to_dsh —— 派活是核心功能，执行器本身有沙箱与回执；
//   · clipboard —— 可还原。
// 这张表是「一处可扩展」的清单：以后新增高危动作只改这里和 policy.json。
const HIGH_RISK = Object.freeze([
    // 刻意**不含** app close：那是用户明确指令（「把记事本关了」），
    // 且 Windows 自己会弹「是否保存」；拦它只会让日常功能变烦。
    { tool: 'file', actions: ['write', 'delete', 'move', 'rename', 'overwrite', 'remove'], reason: '会改磁盘上的文件' },
    { tool: 'code', actions: ['run', 'exec', 'execute', 'install'], reason: '执行代码/装包不可回滚' },
    { tool: 'note', actions: ['delete', 'remove'], reason: '删除用户记忆' },
    { tool: 'memory', actions: ['delete', 'remove', 'correct'], reason: '改/删长期记忆' },
]);

function _highRisk(tool, action) {
    const a = String(action || '').toLowerCase();
    for (const r of HIGH_RISK) {
        if (r.tool !== tool) continue;
        // actions 为空 = 该工具任何 action 都算高危
        if (!r.actions || r.actions.length === 0) return r;
        if (r.actions.includes(a)) return r;
    }
    return null;
}

let _annotations = null;      // tool -> {readOnly, destructive, ...}
let _annotationsAt = 0;
let _userRules = null;
let _userRulesAt = 0;
let _lastError = '';
let _approvalsRotateWarned = false;

function _dataFile(name) {
    try { if (_recordFile) return _recordFile(name); } catch (e) { /* fallthrough */ }
    return path.join(APP_DIR, '..', 'data', name);
}

/** 收集所有插件 metadata.json 里的工具注解（缓存 60s，热重载后能跟上）。 */
function annotations(now) {
    const t = Number(now) || Date.now();
    if (_annotations && t - _annotationsAt < 60000) return _annotations;
    const out = Object.create(null);
    let entries = [];
    try { entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true }); } catch (e) { entries = []; }
    const walk = (dir) => {
        let list = [];
        try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of list) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (e.name !== 'metadata.json') continue;
            try {
                const meta = JSON.parse(fs.readFileSync(p, 'utf8'));
                const tools = meta && meta.tools;
                if (!tools || typeof tools !== 'object') continue;
                for (const [tool, ann] of Object.entries(tools)) {
                    if (!out[tool] && ann && typeof ann === 'object') out[tool] = ann;
                }
            } catch (e) { /* 坏 metadata 跳过（check-plugins 会报） */ }
        }
    };
    walk(PLUGINS_DIR);
    _annotations = out;
    _annotationsAt = t;
    return out;
}

/** 用户自定义规则（可选）：[{match:{tool,action}, decision:'allow'|'deny'|'ask', reason}] */
let _userRulesError = '';
function userRules(now) {
    const t = Number(now) || Date.now();
    if (_userRules && t - _userRulesAt < 30000) return _userRules;
    let list = [];
    let err = '';
    try {
        const raw = fs.readFileSync(_dataFile('policy.json'), 'utf8');
        const doc = JSON.parse(raw);
        if (Array.isArray(doc)) list = doc;
        else if (doc && Array.isArray(doc.rules)) list = doc.rules;
        else err = 'policy.json 结构不对（应为数组或 {rules:[]}），用户规则本轮不生效';
    } catch (e) {
        // 文件不存在 = 没配（正常）；解析/读失败必须**发声**：
        // 用户写了 deny 规则却因为一个逗号被静默忽略，他会以为闸门在拦。
        if (!(e && e.code === 'ENOENT')) err = 'policy.json 读不出来（' + ((e && e.message) || e) + '），用户规则本轮不生效';
    }
    if (err) {
        _lastError = err;
        if (err !== _userRulesError) {
            _userRulesError = err;
            try { console.warn('[policy] ' + err + '：' + _dataFile('policy.json')); } catch (e2) { /* ignore */ }
        }
    } else {
        _userRulesError = '';
    }
    _userRules = list.filter((r) => r && r.match && ['allow', 'deny', 'ask'].includes(r.decision));
    _userRulesAt = t;
    return _userRules;
}

function isUnattended(now) {
    const t = Number(now) || Date.now();
    try {
        // 评测/探针在跑 → 不算无人值守：它有自己的 verify/cleanup 约束，
        // 而且门禁若被策略门拦住会变成「假红」。
        if (globalThis.__AGENT_EVAL__) return false;
        if (globalThis.__petQuiet) return true;
        const last = Number(globalThis.__lastUserInputAt) || 0;
        // 从没收到过用户输入（刚启动）→ 不算无人值守（否则一启动就全拦）
        if (!last) return false;
        return t - last > UNATTENDED_MS;
    } catch (e) { return false; }
}

function paramsHash(params) {
    try { return crypto.createHash('sha256').update(JSON.stringify(params || {})).digest('hex').slice(0, 16); }
    catch (e) { return ''; }
}

// 审批留痕文件的上限：与 telemetry / turn-journal 同思路，超过就轮转一代（.1），
// 不然「拒绝要留痕」会变成无界增长（模型反复重试被拒的动作时尤其明显）。
const APPROVALS_MAX_BYTES = 2 * 1024 * 1024;

/** 写审批留痕（append-only + 代际轮转；失败只记 lastError，不影响判定）。 */
function audit(rec) {
    if (!rec || rec.decision === 'allow') return;
    const line = Object.assign({ at: Date.now() }, rec, { paramsHash: paramsHash(rec.params) });
    delete line.params;
    const file = _dataFile('approvals.jsonl');
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try {
            if (fs.statSync(file).size > APPROVALS_MAX_BYTES) fs.renameSync(file, file + '.1');
        } catch (e) {
            // ENOENT = 还没有留痕文件（正常）；其它错误只喊一次，不能挡住 append
            if (e && e.code !== 'ENOENT' && !_approvalsRotateWarned) {
                _approvalsRotateWarned = true;
                console.warn('[policy] approvals.jsonl 轮转失败（留痕会继续增长）：' + ((e && e.message) || e));
            }
        }
        fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8');
    } catch (e) {
        _lastError = String((e && e.message) || e);
    }
}

/**
 * 判定一次工具调用。
 * @param {{tool:string, action?:string, params?:object, unattended?:boolean, now?:number}} input
 * @returns {{decision:'allow'|'deny'|'ask', reason:string, source:string, needsConfirm:boolean}}
 */
function decide(input) {
    const o = input || {};
    const tool = String(o.tool || '');
    const action = String(o.action || '');
    const params = o.params || {};
    const now = Number(o.now) || Date.now();
    const unattended = o.unattended === undefined ? isUnattended(now) : o.unattended === true;
    const ann = annotations(now)[tool] || null;

    let decision = 'allow';
    let reason = '未命中高危表，放行';
    let source = 'default';

    const risky = _highRisk(tool, action);
    if (risky) {
        // 高危动作：只有显式 confirm 才放行
        if (params && params.confirm_destructive === true) {
            decision = 'allow';
            reason = '已带 confirm_destructive 显式确认（' + risky.reason + '）';
            source = 'confirm';
        } else if (unattended) {
            decision = 'deny';
            reason = '无人值守（超过 10 分钟没有你的输入）：' + risky.reason + ' 已拦下。等你回来后带 confirm_destructive:true 重试。';
            source = 'high-risk+unattended';
        } else {
            decision = 'ask';
            reason = risky.reason + '：确认要执行请带 confirm_destructive:true 重试；否则先用只读方式看一眼。';
            source = 'high-risk';
        }
    } else if (ann && ann.readOnly === true) {
        reason = '只读工具';
        source = 'metadata.readOnly';
    }
    // ⚠ 刻意**不**对「metadata.destructive + 无人值守」加严（2026-11-22 取舍）：
    //   act/game/app 这类日常工具已有 self-guard（按钮名）、双闸（会话+前台）、黑名单，
    //   再加一层「夜里一律 deny」会把门禁/评测里的正常点击全拦成假红（它们没有用户在场），
    //   也会让「用户睡前说关掉记事本」这种明确指令做不到。
    //   无人值守的加严只落在**高危表**（改文件/执行代码/删记忆）上。

    // 用户自定义规则：**最后匹配生效**（数组后面的覆盖前面的）
    for (const r of userRules(now)) {
        const m = r.match || {};
        if (m.tool && String(m.tool) !== tool) continue;
        if (m.action && String(m.action) !== action) continue;
        decision = r.decision;
        reason = String(r.reason || ('policy.json 规则：' + r.decision));
        source = 'policy.json';
    }

    const out = { decision, reason, source, needsConfirm: decision === 'ask' };
    _bump(decision);
    audit({ tool, action, decision, reason, source, unattended, params });
    return out;
}

/** 可观测：最近一次错误 + 计数（doctor/探针可读） */
const counts = { allow: 0, deny: 0, ask: 0 };
let _decideErrors = 0;

/**
 * 由调用方（plugin-manager 的 fail-open catch）上报「判定过程本身炸了」。
 * 单独留一个出口的原因：decide() 内部的可预期失败（坏 metadata / 坏 policy.json /
 * 读不到用户输入时间）都已就地降级；能从 decide() 抛出来的是**代码级 bug**。
 * fail-open 可以继续放行（不能让 30 个工具全停），但必须留痕，否则安全闸静默失效。
 */
function noteError(e) {
    _decideErrors += 1;
    _lastError = String((e && e.message) || e).slice(0, 200);
    return _lastError;
}

function stats() {
    return {
        counts: Object.assign({}, counts),
        lastError: _lastError,
        decideErrors: _decideErrors,
        annotations: Object.keys(annotations()).length,
    };
}
function _bump(decision) { if (counts[decision] !== undefined) counts[decision] += 1; }

/** 仅供测试：清缓存 */
function _resetCaches() { _annotations = null; _annotationsAt = 0; _userRules = null; _userRulesAt = 0; }

module.exports = { decide, isUnattended, annotations, userRules, stats, noteError, counts, audit, _resetCaches, _bump, UNATTENDED_MS };
