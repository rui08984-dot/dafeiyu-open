#!/usr/bin/env node
/**
 * _probe/voice-intent.cjs —— B5 语音话语四态分类 + response-intent 门（纯函数，2026-11-23）
 *
 * 被测：`live-2d/js/core/voice-intent.js`（不依赖 Electron/DOM/网络，纯逻辑）
 *
 * 钉住的事：
 *   ① 四态齐全：backchannel / noise / barge_in / turn_take，且返回字段类型稳定；
 *   ② backchannel：她在说话时「嗯/对/好/行/是/好的/行吧」→ 不打断、不额外回应；
 *   ③ response-intent 门：她在问问题时，短确认升级为回答（不能被吞）；
 *   ④ noise：空/全标点/重复字符/近静音/低置信度 → 不打断、不回应；
 *   ⑤ barge_in：「等等/停/别说了/不对」→ 打断（优先级高于疑问与附和）；
 *   ⑥ 保守：输入缺失 / 解析异常 → turn_take 放行，绝不吞真话；
 *   ⑦ 纯函数：不需要 Electron/DOM，源码里也没有这些依赖。
 *
 * 判定：0 = 全过；非 0 = 有失败。汇总行 "PASS n / FAIL m" 供 check-all 识别。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const SRC = path.join(APP, 'js', 'core', 'voice-intent.js');
const vi = require(SRC);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return true; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
    return false;
}
function cls(input, opts) { return vi.classifyVoiceUtterance(input, opts); }
function fmt(v) { return v.kind + '/' + v.reason + ' int=' + v.shouldInterrupt + ' res=' + v.shouldRespond; }

// ══ ① 四态覆盖与返回契约 ═══════════════════════════════════════════════════
console.log('\n[①] 四态与返回契约');
{
    const cases = [
        { name: 'backchannel', input: { text: '嗯', ttsPlaying: true } },
        { name: 'noise', input: { text: '' } },
        { name: 'barge_in', input: { text: '等等', ttsPlaying: true } },
        { name: 'turn_take', input: { text: '我想问个问题', ttsPlaying: true } },
    ];
    const kinds = new Set();
    let shapeOk = true;
    for (const c of cases) {
        const v = cls(c.input);
        kinds.add(v.kind);
        const keys = Object.keys(v).sort().join(',');
        const typesOk = typeof v.kind === 'string' && typeof v.reason === 'string'
            && typeof v.shouldInterrupt === 'boolean' && typeof v.shouldRespond === 'boolean';
        if (keys !== 'kind,reason,shouldInterrupt,shouldRespond' || !typesOk) shapeOk = false;
        ok('S' + c.name + ' 判定为 ' + c.name, v.kind === c.name, fmt(v));
    }
    ok('S5 四态全部可达（集合大小 = 4）', kinds.size === 4, [...kinds].join(','));
    ok('S6 返回形状固定 {kind,reason,shouldInterrupt,shouldRespond} 且布尔为真布尔', shapeOk);
}

// ══ ② backchannel（她在说话） ═════════════════════════════════════════════
console.log('\n[②] backchannel：她在说话时短确认不打断、不回应');
{
    const words = ['嗯', '哦', '对', '好', '行', '是', '啊', '嗯嗯', '对对', '好的', '行吧', '好啊', '是的', '收到'];
    let allOk = true;
    const bad = [];
    for (const w of words) {
        const v = cls({ text: w, ttsPlaying: true });
        const good = v.kind === 'backchannel' && v.shouldInterrupt === false && v.shouldRespond === false;
        if (!good) { allOk = false; bad.push(w + '→' + fmt(v)); }
    }
    ok('B1 14 个短确认全部 backchannel（不打断/不回应）', allOk, bad.join(' | ') || words.join(' '));
    ok('B2 「好的」带标点也一样（好的。）',
        cls({ text: '好的。', ttsPlaying: true }).kind === 'backchannel',
        fmt(cls({ text: '好的。', ttsPlaying: true })));
    ok('B3 「嗯…对」这类纯确认组合仍算 backchannel',
        cls({ text: '嗯，对。', ttsPlaying: true }).kind === 'backchannel',
        fmt(cls({ text: '嗯，对。', ttsPlaying: true })));
    ok('B4 5 个汉字就不算短确认（好我知道了）',
        cls({ text: '好我知道了', ttsPlaying: true }).kind === 'turn_take',
        fmt(cls({ text: '好我知道了', ttsPlaying: true })));
    ok('B5 混了非确认字就不算（好厉害啊）',
        cls({ text: '好厉害啊', ttsPlaying: true }).kind === 'turn_take',
        fmt(cls({ text: '好厉害啊', ttsPlaying: true })));
    // 她没在说话：不打断（没东西可打断），但要正常回应（她说完你应一声）
    const idle = cls({ text: '嗯', ttsPlaying: false });
    ok('B6 她没在说话时「嗯」= backchannel，但不许吞（shouldRespond=true）',
        idle.kind === 'backchannel' && idle.shouldInterrupt === false && idle.shouldRespond === true,
        fmt(idle));
    ok('B7 ttsPlaying 缺失按「没在播」保守处理（可回应）',
        cls({ text: '对' }).shouldRespond === true, fmt(cls({ text: '对' })));
}

// ══ ③ response-intent 门：她在问 → 短确认升级为回答 ═══════════════════════
console.log('\n[③] response-intent 门：她在问问题时短确认不能吞');
{
    const a1 = cls({ text: '嗯', ttsPlaying: true, ttsQuestioning: true });
    ok('R1 她问 + 用户「嗯」→ turn_take（backchannel-answer）',
        a1.kind === 'turn_take' && a1.reason === 'backchannel-answer', fmt(a1));
    ok('R2 升级后允许回应（shouldRespond=true）', a1.shouldRespond === true, fmt(a1));
    ok('R3 升级后 TTS 在播就允许打断（用户是在回答）', a1.shouldInterrupt === true, fmt(a1));
    const a2 = cls({ text: '对', ttsPlaying: false, ttsQuestioning: true });
    ok('R4 她问、她已说完 + 「对」→ 回应但不打断',
        a2.kind === 'turn_take' && a2.shouldRespond === true && a2.shouldInterrupt === false, fmt(a2));
    const a3 = cls({ text: '好的', ttsPlaying: true, ttsQuestioning: false });
    ok('R5 她没在问 → 「好的」仍是 backchannel', a3.kind === 'backchannel', fmt(a3));
    const a4 = cls({ text: '', ttsPlaying: true, ttsQuestioning: true });
    ok('R6 空文本在她的问句后仍是 noise（不因在问就放大噪音）',
        a4.kind === 'noise' && a4.shouldRespond === false, fmt(a4));
    const a5 = cls({ text: '啊啊啊啊', ttsPlaying: true, ttsQuestioning: true });
    ok('R7 重复叹词在她的问句后仍是 noise', a5.kind === 'noise', fmt(a5));
    ok('R8 looksLikeQuestioning：问号结尾', vi.looksLikeQuestioning('你今天开心吗？') === true);
    ok('R9 looksLikeQuestioning：吗字结尾', vi.looksLikeQuestioning('你想吃点什么吗') === true);
    ok('R10 looksLikeQuestioning：疑问词', vi.looksLikeQuestioning('我们在干什么') === true);
    ok('R11 looksLikeQuestioning：普通陈述为 false', vi.looksLikeQuestioning('今天天气不错') === false);
    ok('R12 looksLikeQuestioning：空文本 false', vi.looksLikeQuestioning('') === false);
}

// ══ ④ noise ═══════════════════════════════════════════════════════════════
console.log('\n[④] noise：空/标点/重复/近静音/低置信');
{
    const n1 = cls({ text: '', ttsPlaying: true });
    ok('N1 空文本 → noise/empty，不打断不回应',
        n1.kind === 'noise' && n1.reason === 'empty' && !n1.shouldInterrupt && !n1.shouldRespond, fmt(n1));
    const n2 = cls({ text: '。。。！？', ttsPlaying: true });
    ok('N2 全标点 → noise/punct-only', n2.kind === 'noise' && n2.reason === 'punct-only', fmt(n2));
    const n3 = cls({ text: '啊啊啊啊', ttsPlaying: true });
    ok('N3 重复单字 → noise/repeated-char', n3.kind === 'noise' && n3.reason === 'repeated-char', fmt(n3));
    const n4 = cls({ text: '啊啊啊', ttsPlaying: true });
    ok('N4 三连叹词 → noise/filler-repeat', n4.kind === 'noise' && n4.reason === 'filler-repeat', fmt(n4));
    const n5 = cls({ text: '对', ttsPlaying: true, confidence: 0.2 });
    ok('N5 置信度 0.2 < 0.35 → noise/low-confidence', n5.kind === 'noise' && n5.reason === 'low-confidence', fmt(n5));
    const n6 = cls({ text: '对', ttsPlaying: true, confidence: 0.4 });
    ok('N6 置信度 0.4 ≥ 0.35 → 仍 backchannel（不误杀）', n6.kind === 'backchannel', fmt(n6));
    const n7 = cls({ text: '对', ttsPlaying: true, confidence: 0.45 }, { noiseConfidenceThreshold: 0.5 });
    ok('N7 阈值可配：高到 0.5 时 0.45 变 noise', n7.kind === 'noise' && n7.reason === 'low-confidence', fmt(n7));
    const n8 = cls({ text: '对', ttsPlaying: true }, { noiseConfidenceThreshold: 'x' });
    ok('N8 非法阈值回落默认 0.35（不抛）', n8.kind === 'backchannel', fmt(n8));
    ok('N9 置信度缺失不当噪音（保守）',
        cls({ text: '对', ttsPlaying: true }).kind === 'backchannel',
        fmt(cls({ text: '对', ttsPlaying: true })));
    const n10 = cls({ text: '对', ttsPlaying: true, energyRms: 0.0001 });
    ok('N10 近静音 RMS → noise/low-energy', n10.kind === 'noise' && n10.reason === 'low-energy', fmt(n10));
    const n11 = cls({ text: '对', ttsPlaying: true, energyRms: 0.02 });
    ok('N11 正常 RMS 不影响判定', n11.kind === 'backchannel', fmt(n11));
    ok('N12 noise 永远不打断（她在播）',
        cls({ text: '。。。', ttsPlaying: true }).shouldInterrupt === false);
}

// ══ ⑤ barge_in ════════════════════════════════════════════════════════════
console.log('\n[⑤] barge_in：明确要求停下');
{
    const words = ['等等', '等一下', '停', '停一下', '别说了', '先别说', '不对，我不是这个意思', '错了错了'];
    const bad = [];
    for (const w of words) {
        const v = cls({ text: w, ttsPlaying: true });
        if (!(v.kind === 'barge_in' && v.shouldInterrupt === true && v.shouldRespond === true)) {
            bad.push(w + '→' + fmt(v));
        }
    }
    ok('G1 8 个明确停下短句全部 barge_in 且打断', bad.length === 0, bad.join(' | ') || words.join(' '));
    ok('G2 barge_in 优先级高于疑问（停一下好吗？）',
        cls({ text: '停一下好吗？', ttsPlaying: true }).kind === 'barge_in',
        fmt(cls({ text: '停一下好吗？', ttsPlaying: true })));
    ok('G3 barge_in 不受她是否在问影响（她问「停了吗」→ 用户「停！」仍是打断）',
        cls({ text: '停！', ttsPlaying: true, ttsQuestioning: true }).kind === 'barge_in',
        fmt(cls({ text: '停！', ttsPlaying: true, ttsQuestioning: true })));
    ok('G4 她没在播时 barge_in 不打断（没东西可打断）但允许回应',
        cls({ text: '等等' }).shouldInterrupt === false && cls({ text: '等等' }).shouldRespond === true);
    ok('G5 「停车场在哪」不误判成打断（停 前导词护栏）',
        cls({ text: '停车场在哪', ttsPlaying: true }).kind === 'turn_take',
        fmt(cls({ text: '停车场在哪', ttsPlaying: true })));
    ok('G6 「我们等一下吧」不含「停/等等」起手 → turn_take（正常抢话）',
        cls({ text: '我们等一下吧', ttsPlaying: true }).kind === 'turn_take',
        fmt(cls({ text: '我们等一下吧', ttsPlaying: true })));
}

// ══ ⑥ turn_take 与保守路径 ════════════════════════════════════════════════
console.log('\n[⑥] turn_take 与保守路径');
{
    const t1 = cls({ text: '我想问一下明天几点出门', ttsPlaying: true });
    ok('T1 完整话语 → turn_take + 打断 + 回应',
        t1.kind === 'turn_take' && t1.shouldInterrupt === true && t1.shouldRespond === true, fmt(t1));
    const t2 = cls({ text: '嗯', ttsPlaying: true, isFinal: false });
    ok('T2 中间结果（isFinal:false）不打断不回应', !t2.shouldInterrupt && !t2.shouldRespond, fmt(t2));
    const t3 = cls({ text: '嗯', ttsPlaying: true, durationMs: 3500 });
    ok('T3 拖了 3.5s 的「嗯」升级为完整话（backchannel-too-long）',
        t3.kind === 'turn_take' && t3.reason === 'backchannel-too-long', fmt(t3));
    ok('T4 正常 500ms 的「嗯」仍是 backchannel',
        cls({ text: '嗯', ttsPlaying: true, durationMs: 500 }).kind === 'backchannel');
    const t5 = cls(null);
    ok('T5 整个 input 缺失 → turn_take/invalid-input（保守放行）',
        t5.kind === 'turn_take' && t5.reason === 'invalid-input' && t5.shouldRespond === true, fmt(t5));
    const boom = { get text() { throw new Error('boom'); }, ttsPlaying: true };
    const t6 = cls(boom);
    ok('T6 取值抛异常 → turn_take/error-conservative（不抛、不吞）',
        t6.kind === 'turn_take' && t6.reason === 'error-conservative' && t6.shouldRespond === true, fmt(t6));
    ok('T7 数字/对象文本不抛', (() => {
        try { cls({ text: 12345 }); cls({ text: { a: 1 } }); cls({ text: ['嗯'] }); return true; } catch (e) { return false; }
    })());
    ok('T8 字符串规范化去标点/空白', vi.normalizeText(' 嗯 ， 对 。 ') === '嗯对', vi.normalizeText(' 嗯 ， 对 。 '));
    ok('T9 汉字计数', vi.countHan('你好a1') === 2 && vi.countHan('') === 0);
    ok('T10 默认常量与约定一致',
        vi.DEFAULT_NOISE_CONFIDENCE === 0.35 && vi.SILENCE_RMS === 0.0005 && vi.MAX_BACKCHANNEL_HAN === 4);
}

// ══ ⑦ 纯函数：不依赖 Electron/DOM ════════════════════════════════════════
console.log('\n[⑦] 纯函数约束');
{
    const src = fs.readFileSync(SRC, 'utf8');
    ok('P1 不 require electron', !/require\(\s*['"]electron['"]\s*\)/.test(src));
    ok('P2 不 require 任何模块（纯自包含）', !/require\s*\(/.test(src), (src.match(/require\s*\(/g) || []).length + ' 处');
    ok('P3 不触碰 document/window/globalThis', !/\bdocument\.|\bwindow\.|\bglobalThis\./.test(src));
    ok('P4 无定时器/IO（setTimeout/fetch/fs）',
        !/\bsetTimeout\b|\bsetInterval\b|\bfetch\s*\(|\bfs\./.test(src));
    ok('P5 同一输入重复调用结果一致', (() => {
        const a = cls({ text: '嗯', ttsPlaying: true });
        const b = cls({ text: '嗯', ttsPlaying: true });
        return JSON.stringify(a) === JSON.stringify(b);
    })());
}

console.log('\nPASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
