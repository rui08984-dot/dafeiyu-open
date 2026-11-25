#!/usr/bin/env node
/**
 * _probe/test-profile-category.cjs —— 画像 category 归一化（2026-11-24）
 *
 * 背景（HANDOFF-2026-11-24 实施 §8.5）：
 *   本地 MemOperator-4B 把提示词里的**枚举示例**原样抄进 category：
 *     "category":"identity|preference|habit|relation|goal|health"
 *   旧 _normalizeCategory 只认 6 个正式类别，其它一律兜底 fact →
 *   身份/关系/目标/健康全落进 facts，分桶失真，且没有任何信号。
 *
 * 本测验收（表驱动 + 枚举串拆分 + 同义词 + 兜底可观测）：
 *   ① 精确类别与大小写；
 *   ② 常见复数；
 *   ③ 带分隔符的枚举串 → 取第一个**能翻译**的 token（含全角 ｜）；
 *   ④ 同义词表（identity/preference/relation/goal/health/personality/interest/opinion）；
 *   ⑤ preference 按文本分 like / dislike；
 *   ⑥ 未知值兜底 fact，并只记一次日志 + 一条遥测（带原值）；
 *   ⑦ 端到端：观察归一化、_addProfileItem 落对桶、_candidateId 前缀正确。
 *
 * 全部离线：临时数据根 + 临时遥测目录，不碰真实画像/遥测。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// ⚠ 顺序：先隔离数据根与遥测目录，再 require 业务模块（telemetry 在加载时定路径）
const TMP = iso.setUpTempDataRoot('pet-profile-category-');
const TELEMETRY_DIR = path.join(TMP, 'telemetry');
fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
process.env.PET_TELEMETRY_DIR = TELEMETRY_DIR;

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const Plugin = require(path.join(LIVE, 'plugins', 'community', 'user-profile', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function makePlugin() {
    const p = new Plugin();
    const logs = [];
    p._cfg = {};
    p.context = {
        log: (lv, m) => logs.push(lv + ':' + m),
        getPluginFileConfig: () => ({}),
        getMessages: () => [],
        callLLM: async () => '{}',
        on: () => {},
        off: () => {},
    };
    p._profile = p._normalizeProfile({});
    p._candidateStore = p._normalizeCandidates({ candidates: [], archived: [] });
    p._today = () => '2026-11-24';
    p._unknownCategories = new Set();
    return { p, logs };
}

function telemetryLines() {
    const f = path.join(TELEMETRY_DIR, 'telemetry.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
}

(function main() {
    const { p, logs } = makePlugin();
    const N = (c, t) => p._normalizeCategory(c, t);

    console.log('\n① 精确类别 + 大小写');
    ok('habit → habit', N('habit') === 'habit');
    ok('Habit → habit（大小写不敏感）', N('Habit') === 'habit');
    ok('  TRAIT  → trait', N('  TRAIT  ') === 'trait');
    ok('Dislike → dislike', N('Dislike') === 'dislike');
    ok('"fact" 带引号 → fact', N('"fact"') === 'fact');

    console.log('\n② 常见复数');
    ok('habits → habit', N('habits') === 'habit');
    ok('traits → trait', N('traits') === 'trait');
    ok('likes → like', N('likes') === 'like');
    ok('dislikes → dislike', N('dislikes') === 'dislike');
    ok('facts → fact', N('facts') === 'fact');
    ok('relationships → relationship', N('relationships') === 'relationship');

    console.log('\n③ 枚举串（4B 原样抄回）→ 第一个能翻译的 token');
    const ENUM = 'identity|preference|habit|relation|goal|health';
    ok('实测枚举串 → trait（identity 优先于 preference）', N(ENUM) === 'trait', N(ENUM));
    ok('正式 6 类枚举串 → habit（首 token 命中）',
        N('habit|trait|like|dislike|fact|relationship') === 'habit');
    ok('全角竖线 relation｜goal → relationship', N('relation｜goal') === 'relationship');
    ok('逗号串 "goal, health" → fact（goal 先命中）', N('goal, health') === 'fact');
    ok('分号串 "unknown; interest" → like（跳过翻不出的 token）', N('unknown; interest') === 'like');
    ok('全角逗号 "身份，relation" → relationship', N('身份，relation') === 'relationship');
    ok('枚举串里没有未知值日志（能翻译就不该报未识别）',
        logs.filter((l) => l.includes('画像类别未识别')).length === 0,
        logs.filter((l) => l.includes('画像类别未识别')).join(' / '));

    console.log('\n④ 同义词表');
    ok('identity → trait', N('identity') === 'trait');
    ok('personality → trait', N('personality') === 'trait');
    ok('relation → relationship', N('relation') === 'relationship');
    ok('goal → fact', N('goal') === 'fact');
    ok('health → fact', N('health') === 'fact');
    ok('interest → like', N('interest') === 'like');
    ok('opinion → fact', N('opinion') === 'fact');

    console.log('\n⑤ preference 按文本分 like / dislike');
    ok('preference（中性文本）→ like', N('preference', '主人喜欢喝黑咖啡') === 'like');
    ok('preference + 「讨厌」→ dislike', N('preference', '主人讨厌香菜') === 'dislike');
    ok('preference + 「不喜欢」→ dislike', N('preference', '主人不喜欢早起') === 'dislike');
    ok('枚举串里的 preference 也按文本分（preference|habit）',
        N('preference|habit', '不喜欢太吵的地方') === 'dislike');
    ok('无文本时 preference → like（安全默认）', N('preference') === 'like');

    console.log('\n⑥ 未知值：兜底 fact + 只记一次 + 遥测带原值');
    const unknownLogsBefore = logs.filter((l) => l.includes('画像类别未识别')).length;
    ok('foobar_category → fact', N('foobar_category') === 'fact');
    ok('再调一次仍 fact（幂等）', N('foobar_category') === 'fact');
    const unknownLogs = logs.filter((l) => l.includes('画像类别未识别'));
    ok('未识别只记一次日志（去重）',
        unknownLogs.length === unknownLogsBefore + 1,
        JSON.stringify(unknownLogs));
    ok('日志带原值', unknownLogs.some((l) => l.includes('foobar_category')));
    ok('未知枚举串（一个都翻不出）→ fact + 日志',
        N('aaa|bbb|ccc') === 'fact'
        && logs.filter((l) => l.includes('画像类别未识别')).some((l) => l.includes('aaa|bbb|ccc')));
    const tele = telemetryLines().filter((e) => e.type === 'profile.category_unknown');
    ok('遥测落了一条 profile.category_unknown', tele.length === 2, 'n=' + tele.length);
    ok('遥测标题带原值（可发现新枚举）',
        tele.some((e) => String(e.title || '').includes('foobar_category'))
        && tele.some((e) => String(e.title || '').includes('aaa|bbb|ccc')),
        JSON.stringify(tele.map((e) => e.title)));
    ok('同一未知值不重复进遥测', tele.filter((e) => String(e.title).includes('foobar_category')).length === 1);

    console.log('\n⑦ 端到端：观察归一化 → 落对桶');
    const obs = p._normalizeObservation({ category: ENUM, text: '说话很直接，爱较真', one_off: false });
    ok('_normalizeObservation 把枚举串归一成 trait', obs && obs.category === 'trait', obs && obs.category);

    const { p: p2 } = makePlugin();
    p2._addProfileItem('identity', '嘴硬心软', '2026-11-24');
    ok('_addProfileItem(identity) 落 traits（不再进 facts）',
        p2._profile.traits.includes('嘴硬心软') && !p2._profile.facts.includes('嘴硬心软'),
        JSON.stringify({ traits: p2._profile.traits, facts: p2._profile.facts }));

    p2._addProfileItem('preference', '讨厌下雨天', '2026-11-24');
    ok('_addProfileItem(preference + 讨厌) 落 dislikes',
        p2._profile.preferences.dislikes.includes('讨厌下雨天'));

    p2._addProfileItem('relation', '和妹妹住一起', '2026-11-24');
    ok('_addProfileItem(relation) 落 relationships',
        p2._profile.relationships.includes('和妹妹住一起'));

    ok('_candidateId 前缀用归一化后的类别',
        p2._candidateId('relation', '和妹妹住一起').startsWith('relationship:'),
        p2._candidateId('relation', '和妹妹住一起'));

    ok('_findProfileItem 用同一张表（identity 能查到 traits 里的条目）',
        p2._findProfileItem('identity', '嘴硬心软')?.field === 'traits');

    iso.cleanup(TMP);
    console.log('\n  画像类别归一化：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})();
