#!/usr/bin/env node
/**
 * _probe/profile-audit.cjs — 用户画像「一次性事件」只读审计（2026-11-21 记忆质量轮）
 *
 * 背景：用户画像 facts 里混进了「今天下午三点有会议安排」「自述确诊中度抑郁」这类
 * 一次性内容，habits 里混进了「本次表示要去自慰，一次性行为」这类一次性行为。
 * 这些都是**用户数据**，不能自动删。本脚本只做一件事：
 *
 *   · 读 用户画像.json（或 --file 指定文件）；
 *   · 按通用规则给每条打「疑似一次性事件」标签并给出匹配理由；
 *   · 打印候选清单与统计，**绝不写任何文件**。
 *
 * 用法：
 *   node _probe/profile-audit.cjs                 # 审计真实画像（只读）
 *   node _probe/profile-audit.cjs --file <path>   # 审计指定画像文件（单测用）
 *   node _probe/profile-audit.cjs --json          # 机器可读输出
 *
 * 判定分三档：
 *   one_off  强证据：相对时间/具体钟点日期/一次性事件动词/一次性措辞/临时情绪自述
 *   meta     在描述「测试助手/压测提示词」等操作，不是用户长期习惯
 *   weak     弱提示：计划、当下状态描述（可能是一次性，也可能只是措辞随意）
 * 退出码：0 = 扫描完成（无论有没有候选）；1 = 读不到/解析失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_PROFILE = path.join(ROOT, '_incoming', 'my-neuro', 'data', '用户画像.json');

// ── 规则表：id / 档位 / 理由 / 正则 ─────────────────────────────────────
// 「生日/纪念日」是稳定事实，即使带日期也不该进一次性候选 —— 用 exempt 排除。
const RULES = [
    { id: 'relative_time', tier: 'one_off', label: '相对时间词（一次性时点）',
        re: /今天|昨天|前天|刚才|刚刚|本次|这次|本周|这周|今晚|今早|最近|目前|现在|当天|明日|明天|下次/ },
    { id: 'event_verb', tier: 'one_off', label: '一次性事件动词（开会/出差/面试…）',
        re: /开会|会议|出差|面试|晋升|确诊|看病|就诊|去医院|住院|考试|搬家|请假|约了|参加了|买了|去了|吃了|喝了|旅游|旅行/ },
    { id: 'one_off_word', tier: 'one_off', label: '显式一次性措辞',
        re: /一次性|本次表示|这一次|临时/ },
    { id: 'mood_state', tier: 'one_off', label: '临时情绪/身体状态自述（不是稳定特质）',
        re: /(?:自述|表示|说)[^，。]{0,14}(?:累|疲惫|难受|压力|撑不住|低落|抑郁|焦虑|困|饿)/ },
    { id: 'explicit_date', tier: 'one_off', label: '具体日期/钟点（一次性时点）',
        re: /\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*[点:：]\s*\d{0,2}|(?:下午|上午|晚上|凌晨)\s*\d/,
        exempt: /生日|纪念日|周年|习惯|每天|每周|常常|经常|作息|总是/ },
    { id: 'short_state', tier: 'one_off', label: '当下状态开头的描述',
        re: /^(?:有点|感到|感觉)/ },
    { id: 'test_meta', tier: 'meta', label: '在描述测试助手/压测操作，不是用户长期习惯',
        re: /(?:测试|压测|提示词|皮套|复述|字幕输出|能力边界)/ },
    { id: 'plan', tier: 'weak', label: '计划/打算（可能已完成或已放弃）',
        re: /计划|打算|准备去/ },
];

// 字段 → 中文名
const FIELDS = ['facts', 'habits', 'traits', 'relationships', 'preferences.likes', 'preferences.dislikes'];
const FIELD_LABEL = {
    facts: 'facts（稳定事实）',
    habits: 'habits（习惯）',
    traits: 'traits（性格）',
    relationships: 'relationships（关系）',
    'preferences.likes': 'preferences.likes（喜欢）',
    'preferences.dislikes': 'preferences.dislikes（不喜欢）',
};

function getField(profile, field) {
    const parts = field.split('.');
    let node = profile;
    for (const p of parts) {
        if (!node || typeof node !== 'object') return [];
        node = node[p];
    }
    return Array.isArray(node) ? node : [];
}

/** 对一条文本跑规则，返回 [{id,tier,label}]；exempt 命中的规则跳过 */
function matchReasons(text) {
    const s = String(text || '');
    const out = [];
    for (const r of RULES) {
        if (r.exempt && r.exempt.test(s)) continue;
        if (r.re.test(s)) out.push({ id: r.id, tier: r.tier, label: r.label });
    }
    return out;
}

/** 分类：有 one_off → one_off；否则有 meta → meta；否则 weak；都没有 → none */
function classify(reasons) {
    const tiers = new Set(reasons.map((r) => r.tier));
    if (tiers.has('one_off')) return 'one_off';
    if (tiers.has('meta')) return 'meta';
    if (tiers.has('weak')) return 'weak';
    return 'none';
}

function loadProfile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('画像文件不是 JSON 对象');
    }
    return obj;
}

function audit(profile, file) {
    const items = [];
    const totals = {};
    for (const field of FIELDS) {
        const list = getField(profile, field);
        totals[field] = list.length;
        for (const raw of list) {
            const text = String(raw == null ? '' : raw).trim();
            if (!text) continue;
            const reasons = matchReasons(text);
            const kind = classify(reasons);
            if (kind === 'none') continue;
            items.push({ field, text, kind, reasons });
        }
    }
    const counts = { one_off: 0, meta: 0, weak: 0 };
    for (const it of items) counts[it.kind] += 1;
    return {
        file,
        readOnly: true,
        total: Object.values(totals).reduce((a, b) => a + b, 0),
        fields: totals,
        counts,
        candidates: items,
    };
}

function printReport(res) {
    console.log('用户画像审计（只读，不会修改任何文件）');
    console.log('画像：' + res.file);
    const fieldText = Object.entries(res.fields).map(([k, v]) => k + ' ' + v).join(' / ');
    console.log('字段总计 ' + res.total + ' 条（' + fieldText + '）');
    console.log('');

    const section = (kind, title, hint) => {
        const rows = res.candidates.filter((c) => c.kind === kind);
        if (!rows.length) return;
        console.log(title + '：' + rows.length + ' 条' + (hint ? '（' + hint + '）' : ''));
        rows.forEach((c, i) => {
            console.log('  ' + (i + 1) + '. [' + c.field + '] ' + c.text);
            const why = c.reasons.map((r) => r.label + '(' + r.id + ')').join('；');
            console.log('     理由：' + why);
        });
        console.log('');
    };

    section('one_off', '疑似一次性事件候选', '建议人工确认后迁移到 episode/一次性记录');
    section('meta', '疑似测试/助手元行为', '不是用户长期习惯，建议人工确认是否移出 habits');
    section('weak', '弱提示', '可能是一次性计划或随意措辞，建议抽查');

    const pending = res.counts.one_off + res.counts.meta + res.counts.weak;
    if (!pending) {
        console.log('没有发现疑似一次性事件。');
    } else {
        console.log('合计 ' + pending + ' 条待用户拍板：'
            + '一次性 ' + res.counts.one_off + ' / 元行为 ' + res.counts.meta + ' / 弱提示 ' + res.counts.weak);
    }
    console.log('本脚本未写入任何文件；是否迁移由用户决定。');
}

function parseArgs(argv) {
    const opts = { file: DEFAULT_PROFILE, json: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--file') { opts.file = path.resolve(argv[i + 1] || ''); i += 1; }
        else if (a === '--help' || a === '-h') { opts.help = true; }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('用法：node _probe/profile-audit.cjs [--file <画像.json>] [--json]');
        return 0;
    }
    if (!fs.existsSync(opts.file)) {
        console.error('画像文件不存在：' + opts.file);
        return 1;
    }
    let profile;
    try {
        profile = loadProfile(opts.file);
    } catch (e) {
        console.error('读取画像失败：' + (e && e.message || e));
        return 1;
    }
    const res = audit(profile, opts.file);
    if (opts.json) console.log(JSON.stringify(res, null, 2));
    else printReport(res);
    return 0;
}

if (require.main === module) {
    process.exitCode = main();
}

module.exports = { audit, matchReasons, classify, RULES, FIELDS };
