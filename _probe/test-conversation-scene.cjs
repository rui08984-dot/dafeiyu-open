#!/usr/bin/env node
/**
 * _probe/test-conversation-scene.cjs —— 对话现场（ADR-013）与 E8 压缩元数据
 *
 * 防的是 2026-11-22 那族「接不上话」：
 *   ① 她主动说完、用户马上回复，却被判「久别重逢」（锚点只在用户输入时刷新）
 *   ② 旧话题/她刚说的话被当成「现在」
 *   ③ 压缩/裁剪后「刚才在聊什么」消失，且没有 tokensBefore/firstKeptMessageId 可查
 *
 * 数据隔离（A2）：PET_DATA_ROOT 指到 mkdtemp，绝不碰真实 data。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

// ⚠ 必须在任何 require 之前（records-path 加载时就算好目录）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-scene-'));
process.env.PET_DATA_ROOT = TMP;

const scene = require(path.join(LIVE, 'js', 'core', 'conversation-scene.js'));
const LC = require(path.join(LIVE, 'js', 'core', 'last-contact.js'));
const RP = require(path.join(LIVE, 'js', 'core', 'records-path.js'));
const { ContextManager } = require(path.join(LIVE, 'js', 'ai', 'ContextManager.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

try {
    ok('数据目录已隔离（不碰真实记录室）', RP.recordFile('上次见面.json').startsWith(TMP), RP.recordFile('上次见面.json'));
    ok('globalThis.conversationScene 挂的是真导出（不是空壳）',
        globalThis.conversationScene && typeof globalThis.conversationScene.snapshot === 'function'
        && globalThis.conversationScene === scene);

    // ── ① 对话现场：用户/她的最后一句 ────────────────────────────────────
    scene._resetForTests();
    ok('noteUser 写入话题', scene.noteUser('我在看 GTA6 的劫案视频') === true);
    let snap = scene.snapshot();
    ok('snapshot 最后说话人=user', snap.lastSpeaker === 'user', snap.lastSpeaker);
    ok('话题就是用户最近一句', snap.topic.text.includes('GTA6') && snap.topic.fresh === true);
    ok('describe 含「刚在聊」与「最后说话的是你」',
        /刚在聊/.test(snap.promptLine) && /最后说话的是你/.test(snap.promptLine), snap.promptLine);

    ok('noteCompanion 写她的回复（并剥掉 #mood 行）',
        scene.noteCompanion('这劫案玩得挺干净啊。  #mood: 看得入神', { source: 'watch-screen' }) === true);
    snap = scene.snapshot();
    ok('最后说话人变成她', snap.lastSpeaker === 'companion', snap.lastSpeaker);
    ok('她刚说的话里没有 #mood 噪音', !/#mood/i.test(snap.companion.text), snap.companion.text);
    ok('来源被记下（watch-screen）', snap.companion.source === 'watch-screen', snap.companion.source);
    ok('describe 含「她刚说」', /她刚说/.test(scene.describeForPrompt()), scene.describeForPrompt());

    // ── ①b 被打断：她刚说只留**真播出去**的部分（2026-11-22 heard_response）──
    {
        scene.noteCompanion('第一句。第二句。第三句。', { source: 'reply' });
        ok('reviseCompanionHeard 只截匹配的这条',
            scene.reviseCompanionHeard('第一句。第二句。第三句。', '第一句。') === true);
        ok('她刚说变成实际播出的前缀 + 省略号',
            /第一句。……$/.test(scene.snapshot().companion.text), scene.snapshot().companion.text);
        ok('不是这条回复时不乱改',
            scene.reviseCompanionHeard('完全不相干的一句话。', '完全') === false);
        ok('正文仍未被改成不相干内容',
            /第一句。……$/.test(scene.snapshot().companion.text), scene.snapshot().companion.text);
        scene.noteCompanion('另一个全文。', { source: 'reply' });
        ok('空 heard → 只留省略号（不假装说过）',
            scene.reviseCompanionHeard('另一个全文。', '') === true
            && /^……$/.test(scene.snapshot().companion.text), scene.snapshot().companion.text);
        // 恢复一条正常文本，避免影响后面 TTL 用例
        scene.noteCompanion('恢复：她刚说。', { source: 'reply' });
    }

    // ── ② TTL：旧事不能当现在 ────────────────────────────────────────────
    const t0 = Date.now();
    const after11 = scene.describeForPrompt(t0 + 11 * 60 * 1000);
    ok('11 分钟后不再说「她刚说」', !/她刚说/.test(after11), after11);
    const after31 = scene.describeForPrompt(t0 + 31 * 60 * 1000);
    ok('31 分钟后不再说「刚在聊」', !/刚在聊/.test(after31), after31);

    // ── ②b 对着空房间说话 ≠ 真实接触（子代理审计的下一层 bug）──────────
    {
        globalThis.__userActivity = { state: 'away', idleMs: 8 * 3600 * 1000 };
        const atBefore = LC.lastContactAt();
        scene.noteCompanion('（没人听也要说）', { source: 'watch-screen' });
        snap = scene.snapshot();
        ok('away 时主动说话不刷新「上次见面」锚点', LC.lastContactAt() === atBefore,
            atBefore + ' → ' + LC.lastContactAt());
        ok('away 时这句话标记为没人听（heard=false）', snap.companion.heard === false);
        ok('现场不把「没人听的话」当刚说过', !/她刚说/.test(scene.describeForPrompt()), scene.describeForPrompt());
        ok('lastContactAt 也不把「没人听的话」算接触', scene.lastContactAt() === atBefore,
            atBefore + ' vs ' + scene.lastContactAt());
        ok('跳过有计数（可观测）', LC.statsSnapshot().skippedAway >= 1, JSON.stringify(LC.statsSnapshot()));
        globalThis.__userActivity = { state: 'active', idleMs: 0 };
        scene.noteCompanion('回复用户的一句', { source: 'user' });
        ok('回复用户时强制写锚点（用户就在场）', LC.lastContactAt() > atBefore);
        globalThis.__userActivity = null;
    }

    // ── ③ 接触锚点：她说话也算 ───────────────────────────────────────────
    const contact = LC.lastContactAt();
    ok('她说完后锚点文件被刷新', contact > 0 && Math.abs(contact - Date.now()) < 5000, String(contact));
    ok('lastContactAt 取内存与文件更近者', scene.lastContactAt() >= contact);

    scene.noteUser('接着说');
    const startedAt = Date.now() + 1000;   // 明确晚于当前锚点
    const before = LC.lastContactAt();
    const wroteA = scene.markUserContactIfStale(startedAt + 1);
    ok('锚点比这一轮旧 → 补写锚点', wroteA === true && LC.lastContactAt() >= before, 'before=' + before);
    const wroteB = scene.markUserContactIfStale(startedAt - 60000);
    ok('锚点已被 memory-recall 写过 → 不重复写', wroteB === false);

    // ── ④ 主动来源识别（纯函数）──────────────────────────────────────────
    ok('[自动触发] → auto-chat', scene.detectProactiveSource('[自动触发] 你说点什么') === 'auto-chat');
    ok('一起看脚手架 → watch-screen', scene.detectProactiveSource('（你正和用户一起看屏幕，这是你自己想开口）') === 'watch-screen');
    ok('摸头 → alive-state', scene.detectProactiveSource('（他刚才摸了摸你的头。）回应一句') === 'alive-state');
    ok('话题重访 → dawn-dusk', scene.detectProactiveSource('你在自己的记忆里想起他之前说过的事' ) === 'dawn-dusk');
    ok('普通用户话 → user', scene.detectProactiveSource('晚上吃什么') === 'user');

    // ── ⑤ 持久化（重启后还能接上）───────────────────────────────────────
    scene.noteMood('轻松');
    scene._persistNow();
    const disk = JSON.parse(fs.readFileSync(RP.recordFile('对话现场.json'), 'utf8'));
    ok('落盘有话题/她的话/气氛', disk.topic.text.includes('接着说') && !!disk.companion.text && disk.mood.text === '轻松',
        JSON.stringify({ topic: disk.topic.text, mood: disk.mood.text }));
    ok('她的话落盘已清洗（无 #mood）', !/#mood/.test(JSON.stringify(disk.companion)), JSON.stringify(disk.companion));

    // ── ⑥ E8/P0-2：紧急裁剪有账可查（2026-11-24：96→48 + history token 兜底）──
    const msgs = [{ role: 'system', content: 'base' }];
    for (let i = 0; i < 120; i += 1) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: '消息 ' + i });
    const fake = {
        messages: msgs.slice(),
        enableContextLimit: true,
        maxContextMessages: 16,
        fullConversationHistory: [],
    };
    const cm = new ContextManager(fake);
    cm.trimMessages();
    ok('120 条触发紧急裁剪（48 条门槛，正常先走压缩）', fake.messages.length < msgs.length, 'after=' + fake.messages.length);
    ok('裁剪记账：tokensBefore 是数字', fake._lastTrim && Number.isFinite(fake._lastTrim.tokensBefore),
        JSON.stringify(fake._lastTrim && { tokens: fake._lastTrim.tokensBefore }));
    ok('裁剪记账：firstKeptMessageId 可回查', !!(fake._lastTrim && /^idx:\d+:/.test(fake._lastTrim.firstKeptMessageId)),
        fake._lastTrim && fake._lastTrim.firstKeptMessageId);
    ok('裁剪记账：reason=count（条数触发）', fake._lastTrim && fake._lastTrim.reason === 'count',
        fake._lastTrim && fake._lastTrim.reason);
    ok('裁剪记账：historySource 标注口径（无 provider 基线时为 estimate）',
        fake._lastTrim && fake._lastTrim.historySource === 'estimate',
        fake._lastTrim && fake._lastTrim.historySource);

    // 低于 48 条且 token 不高 → 不裁（前缀缓存优先）
    const small = { messages: msgs.slice(0, 40), enableContextLimit: true, maxContextMessages: 16, fullConversationHistory: [] };
    new ContextManager(small).trimMessages();
    ok('40 条不触发硬裁（留给压缩插件）', small.messages.length === 40 && !small._lastTrim);

    // 51 条**短**消息：history 不到 8k → 仍走 96 条闸，不裁（别为两千 token 丢现场/打穿缓存）
    const short51 = { messages: msgs.slice(0, 52), enableContextLimit: true, maxContextMessages: 16, fullConversationHistory: [] };
    new ContextManager(short51).trimMessages();
    ok('51 条短消息不裁（token 低于 8k 时用 96 条闸）', short51.messages.length === 52 && !short51._lastTrim);

    // 51 条**长**消息：history >8k → 48 条闸生效
    const longMsgsCount = [{ role: 'system', content: 'base' }];
    for (let i = 0; i < 51; i += 1) {
        longMsgsCount.push({ role: i % 2 ? 'assistant' : 'user', content: '长'.repeat(250) + i });
    }
    const overCount = { messages: longMsgsCount, enableContextLimit: true, maxContextMessages: 16, fullConversationHistory: [] };
    new ContextManager(overCount).trimMessages();
    ok('51 条长消息触发 48 条闸（history >8k）', overCount._lastTrim && overCount._lastTrim.reason === 'count',
        JSON.stringify(overCount._lastTrim && { reason: overCount._lastTrim.reason, before: overCount._lastTrim.historyTokensBefore }));

    // 30 条但每条很长 → token 兜底触发（条数远低于 48）
    const longMsgs = [{ role: 'system', content: 'base' }];
    for (let i = 0; i < 30; i += 1) {
        longMsgs.push({ role: i % 2 ? 'assistant' : 'user', content: '长'.repeat(1200) + i });
    }
    const overTokens = {
        messages: longMsgs,
        enableContextLimit: true,
        maxContextMessages: 16,
        config: { context: { hard_trim_tokens: 24000 } },
        fullConversationHistory: [],
    };
    new ContextManager(overTokens).trimMessages();
    ok('30 条长消息触发 token 兜底（条数闸没到）', overTokens._lastTrim && overTokens._lastTrim.reason === 'tokens',
        JSON.stringify(overTokens._lastTrim && { reason: overTokens._lastTrim.reason, before: overTokens._lastTrim.historyTokensBefore, after: overTokens._lastTrim.historyTokensAfter }));
    ok('token 兜底后 history ≤ 24000', overTokens._lastTrim && overTokens._lastTrim.historyTokensAfter <= 24000,
        overTokens._lastTrim && overTokens._lastTrim.historyTokensAfter);
    ok('token 兜底不切断工具链（无孤儿 tool）', (() => {
        const t = overTokens.messages;
        return !t.some((m, i) => m.role === 'tool' && t[i - 1] && t[i - 1].role !== 'assistant');
    })());

    // ── ⑥b 审计 P1 的接线护栏（静态，防「清理无用代码」时把守卫删掉）────
    {
        const llm = fs.readFileSync(path.join(LIVE, 'js', 'ai', 'llm-handler.js'), 'utf8');
        ok('记忆兑现只在真实用户轮结算（主动轮不消费 pending）',
            /detectProactiveSource\(prompt\) === 'user'[\s\S]{0,220}memoryUsage\.noteUsed/.test(llm));
        ok('submitTurn 只在用户轮推进 resume TTL',
            /const isUserTurn = scene\.detectProactiveSource\(prompt\) === 'user'/.test(llm)
            && /if \(isUserTurn\) \{[\s\S]{0,120}resumeSpeech\.beginTurn\(\)/.test(llm));
        ok('llm-handler 在 heard-response 里同步修正对话现场（她刚说=真播出）',
            /reviseCompanionHeard\(full, heard\)/.test(llm));
        const dp = fs.readFileSync(path.join(LIVE, 'plugins', 'community', 'dynamic-persona', 'index.js'), 'utf8');
        ok('dynamic-persona 不从脚手架更新状态', /isScaffolding\(userText, 'user'\)/.test(dp));
    }

    // ── ⑦ 压缩插件静态护栏（它要带现场 + 记元数据 + 缓存感知持有）────────────
    {
        const src = fs.readFileSync(path.join(LIVE, 'plugins', 'built-in', 'context-compressor', 'index.js'), 'utf8');
        ok('压缩摘要带「对话现场」', /describeForPrompt\(\)/.test(src) && /当前对话现场/.test(src));
        ok('压缩后写 _lastCompression（historyTokensBefore/After + firstKeptMessageId）',
            /_lastCompression/.test(src) && /historyTokensBefore/.test(src)
            && /historyTokensAfter/.test(src) && /firstKeptMessageId/.test(src));
        ok('压缩触发：history-only token + 回差（旧的 70% 总量口径已移除）',
            /history_token_budget/.test(src) && /history_growth_min/.test(src) && !/budget \* 0\.7/.test(src));
        // ADR-014 轨道 1：生成 → 持有 → 到水位才替换
        ok('缓存感知：摘要先持有（_pending + summaryUpToIndex）',
            /_pending/.test(src) && /summaryUpToIndex/.test(src));
        ok('缓存感知：应用水位 apply_at / 最多持有 max_hold_turns',
            /apply_at/.test(src) && /max_hold_turns/.test(src));
        ok('缓存感知：缓存冷判定（_cacheIsCold，无 lastUsage 视为冷）',
            /_cacheIsCold/.test(src) && /CACHE_TTL_MS/.test(src));
        ok('压缩遥测：trigger/reason/heldMs/truePostTokens/willRetriggerNextTurn',
            /trigger\s*,/.test(src) && /reason/.test(src) && /heldMs/.test(src)
            && /truePostTokens/.test(src) && /willRetriggerNextTurn/.test(src));
        ok('rapid-refill 闸：同一 3 轮两次应用 → 退避',
            /_rapidRefillUntilTurn/.test(src) && /rapidRefill/.test(src));
    }

    console.log('────────────────────────────────────────────────────');
    console.log((fail === 0 ? '✅ 全部通过' : '❌ 有失败') + `（PASS ${pass} / FAIL ${fail}）`);
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不判红 */ }
}

process.exit(fail === 0 ? 0 : 1);
