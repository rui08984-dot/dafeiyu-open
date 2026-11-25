#!/usr/bin/env node
/**
 * _probe/test-volatile-edge.cjs —— 易变尾巴的边界：超长截断 / 行级去重 / 代理对（2026-11-25）
 *
 * 撞的是「截断本身会不会破坏冻结」：
 *   ① >MAX_VOLATILE_CHARS 的尾巴：截断点必须**确定性**（同输入 → 同字节），否则同一轮里
 *      每次重算都截在不同位置 → 前缀缓存从尾巴处断；appendVolatile 二次调用也必须幂等；
 *   ② 行级去重（两条召回路径撞同一件事）：稳定的顺序与结果，短行（<8 字）不参与，
 *      项目符号/序号归一化后去重；
 *   ③ 截断不许切半个 emoji（lone surrogate = 坏字节）；
 *   ④ 多模态 content（text+image_url）：易变块只追加 text part，图片/原文字节不动。
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const PL = require(path.join(LIVE, 'js', 'core', 'prompt-layout.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s)
    || /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
const clone = (x) => JSON.parse(JSON.stringify(x));

// ══════════════════════════════════════════════════════════════════════
// ① 超长截断：确定性 + 幂等
// ══════════════════════════════════════════════════════════════════════
{
    console.log('\n[①] 超长截断的确定性');
    const segs = [
        '世界行：他在写代码（第 1 段）' + '甲'.repeat(1500),
        '召回记忆：昨天聊过模型缓存' + '乙'.repeat(1500),
        '（你现在的状态：困；情绪：平稳）' + '丙'.repeat(1500),
        'mood 指令：保持简短' + '丁'.repeat(1500),
    ];
    const b1 = PL.buildVolatileBlock(segs);
    const b2 = PL.buildVolatileBlock(segs.slice());
    ok('① 超 MAX 被截断并标记', b1.truncated === true && /补充内容过长，已截断/.test(b1.block));
    ok('① 同一输入两次拼接逐字节相同（不会每轮截在不同字）', b1.block === b2.block,
        b1.chars + ' vs ' + b2.chars);
    ok('① 正文字数被压到 MAX 以内（标记另算）',
        b1.block.length - PL.VOLATILE_HEADER.length - 8 < PL.MAX_VOLATILE_CHARS + 40,
        'len=' + b1.block.length);
    ok('① 截断标记在最后（模型最后看到的是「已截断」）',
        b1.block.trimEnd().endsWith('（补充内容过长，已截断）'));
    ok('① count 是**段数**（截断不影响段计数）', b1.count === 4, String(b1.count));

    // appendVolatile：同一份超长集合拼两次 → 第二次 already、字节不动
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: '问' }];
    const r1 = PL.appendVolatile(msgs, segs);
    const after1 = String(msgs[1].content);
    const r2 = PL.appendVolatile(msgs, segs);
    ok('① 超长尾巴重复拼接幂等（already，字节不变）',
        r1.ok === true && r2.reason === 'already' && String(msgs[1].content) === after1);
    ok('① 原标题字节是前缀（纯追加）', after1.startsWith('问'));

    // 模拟同一轮 30 次请求：每次都用同一份冻结字节（这里验证「重算也不会漂」）
    const thirty = Array.from({ length: 30 }, () => {
        const m = [{ role: 'user', content: '问' }];
        PL.appendVolatile(m, segs);
        return String(m[0].content);
    });
    ok('① 30 次独立重算得到同一段字节（重算不漂）',
        thirty.every((x) => x === thirty[0]));
}

// ══════════════════════════════════════════════════════════════════════
// ② 行级去重：稳定、短行不误删、符号归一化
// ══════════════════════════════════════════════════════════════════════
{
    console.log('\n[②] 行级去重');
    const a = '用户喜欢猫\n- 用户在写一个语音陪伴项目';
    const b = '记忆：猫的事情\n1. 用户在写一个语音陪伴项目';
    const r1 = PL.buildVolatileBlock([a, b]);
    const r2 = PL.buildVolatileBlock([a, b]);
    ok('② 结果稳定（同输入两次相同）', r1.block === r2.block);
    const countOf = (hay, needle) => hay.split(needle).length - 1;
    ok('② 重复行只出现一次（跨段、跨项目符号）', countOf(r1.block, '用户在写一个语音陪伴项目') === 1,
        String(countOf(r1.block, '用户在写一个语音陪伴项目')));
    ok('② 两段各自独有的行都在（不是把整段吃了）',
        r1.block.includes('用户喜欢猫') && r1.block.includes('记忆：猫的事情'));
    ok('② 段数不变（去重的是行，不是段）', r1.count === 2, String(r1.count));

    // 短行（<8 字）不参与行级去重，避免误删结构（「1.」「- 」）
    const s = PL.buildVolatileBlock(['1. 好', '1. 好']);
    ok('② 短行不被行级去重吃掉（结构行保留）', /1\. 好/.test(s.block));

    // 整段完全重复 → 整段丢（整段去重）
    const dup = PL.buildVolatileBlock(['同一段完整文本（超过八个字）', '同一段完整文本（超过八个字）']);
    ok('② 整段重复只留一份', dup.count === 1 && countOf(dup.block, '同一段完整文本') === 1);

    // 空/空白段被过滤
    const empty = PL.buildVolatileBlock(['', '   ', null]);
    ok('② 全空 → 空块（count=0，不拼「不必回应」空话）',
        empty.count === 0 && empty.block.trim() === '');
}

// ══════════════════════════════════════════════════════════════════════
// ③ 截断不许切半个 emoji
// ══════════════════════════════════════════════════════════════════════
{
    console.log('\n[③] 代理对安全');
    const emojiBody = '🐟'.repeat(3000);        // 6000 个 UTF-16 单元 > 4000
    ok('③ 前置：输入本身没有 lone surrogate', !hasLoneSurrogate(emojiBody));
    const r = PL.buildVolatileBlock([emojiBody]);
    ok('③ 超长 emoji 尾巴被截断', r.truncated === true);
    ok('③ 截断结果没有 lone surrogate（半个 emoji）', !hasLoneSurrogate(r.block),
        JSON.stringify(r.block.slice(-12)));
    // 边界：正好落在 3999 位置是高位代理
    const odd = 'a' + '🐟'.repeat(3000);
    const r2 = PL.buildVolatileBlock([odd]);
    ok('③ 偏移一位后仍不切代理对', !hasLoneSurrogate(r2.block));
}

// ══════════════════════════════════════════════════════════════════════
// ④ 多模态：只追加 text part
// ══════════════════════════════════════════════════════════════════════
{
    console.log('\n[④] 多模态尾巴');
    const msgs = [{
        role: 'user',
        content: [
            { type: 'text', text: '看这张图：屏幕上是代码' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + 'A'.repeat(64) } },
        ],
    }];
    const imgBefore = JSON.stringify(msgs[0].content[1]);
    const r1 = PL.appendVolatile(msgs, ['世界行：白天' + '戊'.repeat(3000)]);
    const tailPart = msgs[0].content[msgs[0].content.length - 1];
    ok('④ 追加的 text part 在最后', tailPart.type === 'text' && tailPart.text.includes(PL.VOLATILE_HEADER));
    ok('④ 图片 part 字节/位置不变', JSON.stringify(msgs[0].content[1]) === imgBefore);
    ok('④ 原有文字 part 不变', msgs[0].content[0].text === '看这张图：屏幕上是代码');
    const r2 = PL.appendVolatile(msgs, ['世界行：白天' + '戊'.repeat(3000)]);
    ok('④ 多模态重复拼接幂等（already，part 数不变）',
        r2.reason === 'already' && msgs[0].content.length === 3);
    ok('④ 冻结快照与请求一致（多模态同样适用）', (() => {
        const host = [{ role: 'system', content: 'S' }, clone(msgs[0])];
        const req = clone(host);
        PL.appendVolatile(req, ['易变X']);
        const f = PL.freezeTurnPrefix(req, host, {});
        const c = PL.composeTurnPrefix(f, host);
        return c.ok && JSON.stringify(c.messages) === JSON.stringify(req);
    })());
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
