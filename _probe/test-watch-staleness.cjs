#!/usr/bin/env node
/**
 * _probe/test-watch-staleness.cjs —— 「一起看」上下文陈旧 + 记忆污染四处修复的回归
 *
 * 盯住 2026-11-22 审计剩余路径：
 *   ① vision-organ.latestSummary(maxAge=90s)：过老摘要必须返回空；
 *   ② watch-screen._coWatchContext 只在 video / game companion 状态返回内容；
 *   ③ 被协调器拒绝的评论不再进 intent-queue（10 分钟内不重放旧剧情）；
 *   ④ episode-store.readTurns 跳过程序脚手架 user 消息，但保留「（笑）今天好热」；
 *   ⑤ 真说出口后调用 speech-budget.noteSpoken（主动日志 spoke:false 修正）。
 *
 * 全部纯 Node：不联网、不启 Electron、不写真实 data（临时目录 + 注入时钟）。
 * 判定：0 = 全过；非 0 = 有失败（check-all 认退出码）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const WATCH_INDEX = path.join(LIVE, 'plugins', 'community', 'watch-screen', 'index.js');
const EPISODE = require(path.join(LIVE, 'js', 'core', 'episode-store.js'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
    if (cond) { pass += 1; return; }
    fail += 1;
    failures.push(name + (detail ? '：' + detail : ''));
}
function section(title) { console.log('\n[' + title + ']'); }
function okLog(name, cond, detail) {
    ok(name, cond, detail);
    if (cond) console.log('  ✓ ' + name);
    else console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

async function main() {
    // ── ① latestSummary 的 maxAge ─────────────────────────────────────────
    section('vision-organ.latestSummary(maxAge=90s)');
    const { VisionOrgan } = require(path.join(LIVE, 'plugins', 'community', 'watch-screen', 'vision-organ.js'));
    const clock = 1700000000000;
    const organ = new VisionOrgan({ now: () => clock });

    organ.entries = [{ t: clock, clock: '00:00:00', kind: 'change', text: '两人在车里接吻' }];
    okLog('刚生成的摘要返回', organ.latestSummary(90000) === '两人在车里接吻');

    organ.entries = [{ t: clock - 89000, clock: '00:00:00', kind: 'change', text: '89 秒前的摘要' }];
    okLog('89 秒内的摘要仍然返回', organ.latestSummary(90000) === '89 秒前的摘要');

    organ.entries = [{ t: clock - 91000, clock: '00:00:00', kind: 'change', text: '91 秒前的摘要' }];
    okLog('超过 90 秒的摘要返回空', organ.latestSummary(90000) === '');
    okLog('不传参数时默认也按 90 秒过期', organ.latestSummary() === '');

    // 最新的那条过期、但更老的非内部记录也过期 → 空；内部记录不参与
    organ.entries = [
        { t: clock - 5000, clock: '00:00:00', kind: 'change', text: '刚生成的摘要' },
        { t: clock, clock: '00:00:00', kind: 'wake', text: '刚看了一眼屏幕', internal: true },
    ];
    okLog('internal 记录不当作画面摘要', organ.latestSummary(90000) === '刚生成的摘要');

    // ── ② _coWatchContext 的状态门 ────────────────────────────────────────
    section('watch-screen._coWatchContext 状态门');
    const Plugin = require(WATCH_INDEX);
    const plugin = new Plugin();
    plugin.context = {
        getPluginFileConfig: () => ({}),
        getConfig: () => ({}),
        log: () => {},
        addSystemPromptPatch: () => {},
        removeSystemPromptPatch: () => {},
    };
    await plugin.onInit();
    plugin._organ = { latestSummary: () => '两人在车里接吻' };
    plugin._audioLines = [];
    plugin._audioDown = false;
    plugin._gameCompanion = false;

    plugin._screenState = { state: 'working', what: 'VS Code', since: Date.now() };
    okLog('working 状态不返回同看内容', plugin._coWatchContext(60) === '', JSON.stringify(plugin._coWatchContext(60)));

    plugin._screenState = { state: 'idle', what: '', since: Date.now() };
    okLog('idle 状态不返回同看内容', plugin._coWatchContext(60) === '');

    plugin._screenState = null;
    okLog('状态还没判定时不返回同看内容', plugin._coWatchContext(60) === '');

    plugin._screenState = { state: 'video', what: 'movie.mp4', since: Date.now() };
    const videoCtx = plugin._coWatchContext(60);
    okLog('video 状态返回同看内容', videoCtx.includes('两人在车里接吻'), JSON.stringify(videoCtx));

    plugin._gameCompanion = true;
    plugin._screenState = { state: 'game', what: '', since: Date.now() };
    okLog('game companion 状态仍返回同看内容', plugin._coWatchContext(60).includes('两人在车里接吻'));

    const allows = typeof Plugin.coWatchStateAllows === 'function'
        ? Plugin.coWatchStateAllows
        : () => undefined;
    okLog('状态门纯函数：video 放行', allows({ state: 'video' }, false) === true);
    okLog('状态门纯函数：working 拒绝', allows({ state: 'working' }, false) === false);
    okLog('状态门纯函数：状态缺失拒绝', allows(null, false) === false);
    okLog('状态门纯函数：game companion 放行', allows({ state: 'game' }, true) === true);

    // ── ③④⑤ 源码静态护栏 ─────────────────────────────────────────────────
    section('watch-screen 源码护栏');
    const src = fs.readFileSync(WATCH_INDEX, 'utf8');

    const commentStart = src.indexOf('async _commentOn(entry)');
    const commentEnd = src.indexOf('// ── 工具（给 LLM 的 function calling）', commentStart);
    okLog('能定位 _commentOn 段', commentStart > 0 && commentEnd > commentStart);
    const commentBody = commentStart >= 0 && commentEnd > commentStart ? src.slice(commentStart, commentEnd) : '';
    okLog('_commentOn 不再把被拒评论塞进 intent 队列（intentQueue.defer 调用已删）',
        !/intentQueue\s*\.\s*defer\s*\(/.test(commentBody));
    okLog('_commentOn 真说出口后记 noteSpoken（带 scGate.attemptId）',
        /noteSpoken\(\s*'watch-screen'\s*,\s*scGate\.attemptId/.test(commentBody));

    const refreshStart = src.indexOf('_refreshCoWatchPatch() {');
    const refreshEnd = src.indexOf('async _fetchJson', refreshStart);
    okLog('能定位 _refreshCoWatchPatch', refreshStart > 0 && refreshEnd > refreshStart);
    const refreshBody = refreshStart >= 0 && refreshEnd > refreshStart ? src.slice(refreshStart, refreshEnd) : '';
    okLog('离开 video 状态会摘掉同看补丁',
        /state\s*!==\s*'video'/.test(refreshBody)
        && refreshBody.includes("removeSystemPromptPatch('watch-screen-cowatch')"));

    const onReqStart = src.indexOf('async onLLMRequest(request)');
    const onReqEnd = src.indexOf('// ── v1 旧行为', onReqStart);
    const onReqBody = onReqStart >= 0 && onReqEnd > onReqStart ? src.slice(onReqStart, onReqEnd) : '';
    okLog('onLLMRequest 每轮重建同看补丁', onReqBody.includes('_refreshCoWatchPatch()'));

    // ── ⑥ episode-store.readTurns 跳过脚手架 ──────────────────────────────
    section('episode-store.readTurns 记忆污染');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-stale-episode-'));
    const file = path.join(dir, '对话历史.jsonl');
    const rows = [
        { role: 'user', content: '（笑）今天好热' },
        { role: 'user', content: '[自动触发] 主动说一句，20 字以内，不要客套' },
        { role: 'user', content: '（你正和用户一起看屏幕，这是你自己想开口，不是用户问你。）' },
        { role: 'user', content: '{"ok":true,"tool":"read_file"}' },
        { role: 'user', content: '（他刚才摸了摸你的头。）' },
        { role: 'assistant', content: '（笑）我也觉得' },
        { role: 'user', content: '今天好热' },
        { role: 'system', content: 'system 不进卡片' },
    ];
    fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const read = EPISODE.readTurns(file, 0, 60);
    const texts = read.turns.map((t) => t.text);
    okLog('保留带括号动作的真实用户话「（笑）今天好热」', texts.includes('（笑）今天好热'));
    okLog('跳过 [自动触发] 脚手架', !texts.some((t) => t.includes('[自动触发]')));
    okLog('跳过第二人称屏幕提示词', !texts.some((t) => t.includes('你正和用户')));
    okLog('跳过工具 JSON 回执', !texts.some((t) => t.startsWith('{"ok"')));
    okLog('跳过「他刚才…你」程序模板', !texts.some((t) => t.includes('他刚才摸了摸你的头')));
    okLog('assistant 的话保留', texts.includes('（笑）我也觉得'));
    okLog('普通用户话保留', texts.includes('今天好热'));
    okLog('只保留 user/assistant', read.turns.every((t) => t.role === 'user' || t.role === 'assistant'));

    // 反卡死：前 60 行几乎全是脚手架时，不能只返回 0 条真实 turn（下游 turns<6 不前进游标
    // → 窗口固定从游标开始 → 永远读同一批）。必须向后补扫，直到凑够真实 turn 或文件尾。
    const file2 = path.join(dir, '对话历史_mixed.jsonl');
    const rows2 = [];
    for (let i = 0; i < 60; i += 1) rows2.push({ role: 'user', content: '[自动触发] 主动说一句 ' + i });
    for (let i = 1; i <= 6; i += 1) rows2.push({ role: 'assistant', content: '真实回复 ' + i });
    fs.writeFileSync(file2, rows2.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    const read2 = EPISODE.readTurns(file2, 0, 60);
    okLog('脚手架占满窗口时向后补扫真实 turn（不卡死游标）',
        read2.turns.length === 6, 'turns=' + read2.turns.length);
    okLog('补扫后 consumed 覆盖实际读过的行', read2.consumed === 66, 'consumed=' + read2.consumed);
    okLog('补扫能读到窗口之后的真实对话', read2.turns.some((t) => t.text === '真实回复 6'));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响断言 */ }

    // ── 汇总 ─────────────────────────────────────────────────────────────
    console.log('\n' + (fail === 0 ? '全部通过：' : '有失败：') + pass + ' 通过 / ' + fail + ' 失败');
    if (fail) {
        console.error('\n失败项：');
        for (const f of failures) console.error('  · ' + f);
        process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error('探针自身异常：', e && e.stack || e);
    process.exitCode = 1;
});
