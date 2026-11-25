#!/usr/bin/env node
/**
 * _probe/test-tool-subset.cjs —— 会话级动态工具子集（ADR-014 轨道 2-7，2026-11-24）
 *
 * 要防的回归：
 *   ① 筛掉了核心工具（记忆/画像/see/act/app）→ 静默劣化，比 schema 大更糟；
 *   ② 筛完不足 minKeep(8) → 模型「手里没工具」，一个简单任务要绕三圈；
 *   ③ 同一会话同一模式两次选择不一致 → tools 段每轮变，前缀缓存每轮 miss；
 *   ④ 模式变了还不重选（进了游戏还在给看视频的工具）或每轮都重选（模式没变也换）；
 *   ⑤ 默认（config.toolFilter 未开）误启用 → 主链行为变化；
 *   ⑥ 输出顺序漂移（哪怕集合一样，顺序变也会打穿前缀缓存）。
 *
 * 纯逻辑 + 静态断言，不启动插件、不碰网络。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const picker = require(path.join(LIVE, 'js', 'ai', 'tool-picker.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const names = (r) => r.tools.map((t) => String(t.function.name)).sort();

// 真机工具面（2026-11-23 的 29 个名字 + 几个只用于排序覆盖的占位）
const REAL = [
    'diary', 'code', 'memory', 'image', 'import', 'tool_usage', 'note', 'schedule',
    'play_sound_effect', 'web_search', 'pet_care', 'dawn_dusk',
    'appearance', 'see', 'act', 'app', 'file', 'clipboard', 'game', 'batch',
    'knowledge', 'skill', 'dispatch_to_dsh', 'dispatch_cancel', 'check_dispatch', 'hand_action',
    'recall', 'profile', 'cowatch',
];
const mk = (list) => list.map((n) => ({ type: 'function', function: { name: n } }));
const ALL = mk(REAL);
const CORE = ['memory', 'note', 'recall', 'profile', 'pet_care', 'see', 'act', 'app'];

// ── ① 四种模式都保留核心工具 ────────────────────────────────────────────
{
    for (const mode of ['chat', 'game', 'watch', 'control']) {
        picker.resetSessions();
        const r = picker.pickForSession(ALL, { sessionKey: 'core-' + mode, mode });
        const missing = CORE.filter((n) => !names(r).includes(n));
        ok('mode=' + mode + ' 保留全部核心工具', missing.length === 0, '缺：' + missing.join(',') + ' / mode=' + r.mode);
        ok('mode=' + mode + ' 至少 minKeep 个', r.tools.length >= picker.MIN_KEEP, 'n=' + r.tools.length);
    }
}

// ── ② 模式差异：该给的给、不该给的不给 ─────────────────────────────────
{
    picker.resetSessions();
    const game = picker.pickForSession(ALL, { sessionKey: 'm-game', mode: 'game' });
    ok('game 模式带 game/knowledge/skill',
        ['game', 'knowledge', 'skill'].every((n) => names(game).includes(n)), names(game).join(','));
    ok('game 模式不带 cowatch（看视频的工具）', !names(game).includes('cowatch'));

    picker.resetSessions();
    const watch = picker.pickForSession(ALL, { sessionKey: 'm-watch', mode: 'watch' });
    ok('watch 模式带 cowatch', names(watch).includes('cowatch'), names(watch).join(','));
    ok('watch 模式不带 game 专属 knowledge/skill',
        !names(watch).includes('knowledge') && !names(watch).includes('skill'));

    picker.resetSessions();
    const ctl = picker.pickForSession(ALL, { sessionKey: 'm-ctl', mode: 'control' });
    ok('control 模式带 file/code/clipboard/dispatch',
        ['file', 'code', 'clipboard', 'dispatch_to_dsh'].every((n) => names(ctl).includes(n)), names(ctl).join(','));

    picker.resetSessions();
    const chat = picker.pickForSession(ALL, { sessionKey: 'm-chat', mode: 'chat' });
    ok('chat 模式不带 game/cowatch（不白白多给）',
        !names(chat).includes('game') && !names(chat).includes('cowatch'), names(chat).join(','));
}

// ── ③ 同一会话 + 同一模式：第二次直接复用 ──────────────────────────────
{
    picker.resetSessions();
    const a = picker.pickForSession(ALL, { sessionKey: 'stable', mode: 'game' });
    const b = picker.pickForSession(ALL, { sessionKey: 'stable', mode: 'game' });
    ok('第一次是新选', a.reused === false);
    ok('第二次标记复用', b.reused === true);
    ok('两次工具列表完全一致（名字 + 顺序）',
        JSON.stringify(a.tools.map((t) => t.function.name)) === JSON.stringify(b.tools.map((t) => t.function.name)),
        a.tools.length + ' vs ' + b.tools.length);
    ok('两次 hash 一致（前缀缓存前提）', JSON.stringify(names(a)) === JSON.stringify(names(b)));
}

// ── ④ 模式变化才重选 ────────────────────────────────────────────────────
{
    picker.resetSessions();
    const g = picker.pickForSession(ALL, { sessionKey: 'switch', mode: 'game' });
    const w = picker.pickForSession(ALL, { sessionKey: 'switch', mode: 'watch' });
    const w2 = picker.pickForSession(ALL, { sessionKey: 'switch', mode: 'watch' });
    ok('模式变化 → 重选（reused=false）', w.reused === false && w.mode === 'watch');
    ok('新模式的工具集变了（game → watch 不再给 knowledge）',
        names(g).includes('knowledge') && !names(w).includes('knowledge'));
    ok('模式没再变 → 继续复用', w2.reused === true && JSON.stringify(names(w)) === JSON.stringify(names(w2)));

    // 不同会话各自独立（互动 A 打游戏不该影响互动 B 看视频）
    const other = picker.pickForSession(ALL, { sessionKey: 'switch-other', mode: 'game' });
    ok('不同会话互不影响', other.reused === false && names(other).includes('game'));
}

// ── ⑤ minKeep 保底与极端工具面 ──────────────────────────────────────────
{
    picker.resetSessions();
    // 只有 3 个工具：补不出 8 个，也不能崩、不能凭空造假工具
    const tiny = picker.pickForSession(mk(['memory', 'see', 'play_sound_effect']), { sessionKey: 'tiny', mode: 'chat' });
    ok('工具面本来就少时不报错、不造假', tiny.tools.length === 3, 'n=' + tiny.tools.length);

    picker.resetSessions();
    // 非核心/非通用名：minKeep 只能靠「按原顺序补齐」
    const odd = mk(['memory', 'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']);
    const r = picker.pickForSession(odd, { sessionKey: 'odd', mode: 'chat' });
    ok('非通用名也能补到 minKeep=8', r.tools.length >= 8, 'n=' + r.tools.length);
}

// ── ⑥ 顺序稳定：输出顺序 = allTools 原顺序 ──────────────────────────────
{
    picker.resetSessions();
    const r = picker.pickForSession(ALL, { sessionKey: 'order', mode: 'game' });
    const idx = r.tools.map((t) => REAL.indexOf(t.function.name));
    const sorted = idx.slice().sort((x, y) => x - y);
    ok('输出保持 allTools 原顺序（不重排）', JSON.stringify(idx) === JSON.stringify(sorted), idx.join(','));
    ok('dropped 计数 = 原数 - 保留数', r.dropped === REAL.length - r.tools.length, 'dropped=' + r.dropped);
}

// ── ⑦ deriveMode：屏幕状态优先 ──────────────────────────────────────────
{
    ok('game:植物大战僵尸 → game', picker.deriveMode({ screenState: 'game:植物大战僵尸' }) === 'game');
    ok('video:哔哩哔哩 → watch', picker.deriveMode({ screenState: 'video:哔哩哔哩' }) === 'watch');
    ok('control=true → control', picker.deriveMode({ control: true }) === 'control');
    ok('空上下文 → chat', picker.deriveMode({}) === 'chat');
    ok('显式 mode 优先', picker.deriveMode({ mode: 'watch', screenState: 'game:x' }) === 'watch');
    ok('屏幕状态优先于文本关键词', picker.deriveMode({ screenState: 'game:x', lastUserText: '看视频' }) === 'game');
}

// ── ⑧ 默认关闭 = 走全量（静态断言）─────────────────────────────────────
{
    const src = fs.readFileSync(path.join(LIVE, 'js', 'ai', 'llm-handler.js'), 'utf8');
    ok('llm-handler 只在 toolFilter.enabled === true 时筛选',
        /config\.toolFilter && config\.toolFilter\.enabled === true/.test(src));
    ok('没有无条件调用 pickForSession（都在开关内）',
        src.split('pickForSession(').length === 2 || /enabled === true[\s\S]{0,600}pickForSession/.test(src));
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(LIVE, 'config.json'), 'utf8')); } catch (e) { /* 没配置按默认 */ }
    ok('config.json 默认没开 toolFilter', !(cfg.toolFilter && cfg.toolFilter.enabled === true),
        JSON.stringify(cfg.toolFilter || null));
}

console.log('\n' + (fail ? '✗' : '✓') + ' 工具子集：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
