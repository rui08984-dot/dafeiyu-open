#!/usr/bin/env node
/**
 * _probe/test-history-dedupe.cjs —— 落盘历史不许按「内容相同」去重（2026-11-22 审计 P0-3）
 *
 * 真事故：旧实现拿「历史上任何一条内容相同」判断是否已保存 ——
 *   隔天再说「好 / 嗯 / 我回来了」会被静默丢掉，召回、片段卡、跨会话接续都看不到。
 * 修法：按消息**对象引用**记「已落盘」（WeakSet），新对象哪怕内容一模一样也要写。
 *
 * 数据隔离：PET_DATA_ROOT 指到 mkdtemp，绝不碰真实 data。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-hist-'));
process.env.PET_DATA_ROOT = TMP;

const { ContextManager } = require(path.join(LIVE, 'js', 'ai', 'ContextManager.js'));
const { recordFile } = require(path.join(LIVE, 'js', 'core', 'records-path.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function readLines() {
    try {
        return fs.readFileSync(recordFile('对话历史.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { return []; }
}

try {
    ok('落盘目录已隔离', recordFile('对话历史.jsonl').startsWith(TMP), recordFile('对话历史.jsonl'));

    // 启动态：messages 与 fullConversationHistory 共享对象引用（MessageInitializer 的真实行为）
    const u1 = { role: 'user', content: '好' };
    const a1 = { role: 'assistant', content: '嗯，在。' };
    const fake = {
        enableContextLimit: true,
        maxContextMessages: 16,
        messages: [{ role: 'system', content: 'base' }, u1, a1],
        fullConversationHistory: [u1, a1],
    };
    const cm = new ContextManager(fake);
    cm.markLoadedHistorySaved();

    // 隔天同一句话：新对象、同内容 —— 必须写进去
    const u2 = { role: 'user', content: '好' };
    const a2 = { role: 'assistant', content: '又见到你了。' };
    fake.messages.push(u2, a2);
    cm.saveConversationHistory();

    let lines = readLines();
    ok('历史首轮落盘包含新消息（不是把加载的历史重写一遍）',
        lines.length === 2, 'lines=' + lines.length + ' ' + JSON.stringify(lines));
    ok('同内容的第二次「好」被保留', lines.filter((m) => m.role === 'user' && m.content === '好').length === 1);
    ok('她的回复也落盘', lines.some((m) => m.role === 'assistant' && m.content === '又见到你了。'));

    // 幂等：没有新对象就不重复写
    cm.saveConversationHistory();
    ok('没有新消息时不重复追加', readLines().length === 2, 'lines=' + readLines().length);

    // 压缩场景：数组被替换成「总结(新对象) + 保留的近期旧对象」——
    // 旧对象不重复写、总结写一次
    const summary = { role: 'system', content: '[历史对话总结] 前面在聊好/嗯' };
    fake.messages = [summary, u1, a1, u2, a2];
    cm.saveConversationHistory();
    lines = readLines();
    ok('压缩后：保留的旧消息不重复写', lines.filter((m) => m.role === 'user').length === 1, JSON.stringify(lines.map((m) => m.content)));
    // 原设计：只落 user/assistant/tool，system（含压缩总结）不进 JSONL —— 这里锁住，防有人顺手改坏
    ok('压缩后：system 总结不落盘（按原设计）', lines.filter((m) => m.role === 'system').length === 0,
        JSON.stringify(lines.filter((m) => m.role === 'system')));

    // 第三次说「好」仍然要进历史
    const u3 = { role: 'user', content: '好' };
    fake.messages.push(u3, { role: 'assistant', content: '你好烦。' });
    cm.saveConversationHistory();
    lines = readLines();
    ok('第三次同内容「好」也保留（按对象而非内容去重）',
        lines.filter((m) => m.role === 'user' && m.content === '好').length === 2,
        'count=' + lines.filter((m) => m.role === 'user' && m.content === '好').length);

    console.log('────────────────────────────────────────────────────');
    console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `（PASS ${pass} / FAIL ${fail}）`);
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

process.exit(fail === 0 ? 0 : 1);
