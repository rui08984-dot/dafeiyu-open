#!/usr/bin/env node
/**
 * _probe/test-memory-hygiene.cjs —— 记忆库空占位治理（2026-11-24）
 *
 * 两块要守住的东西：
 *   ① 启动不再写「交互N：」空占位；日期/交互头改为「第一条真实内容落盘前」惰性写，
 *      且一次会话只写一个头（同会话后续对话都追加在同一个头下面）。
 *   ② scripts/cleanup-memory-placeholders.mjs 只删「交互N：后到下一个非空行前无内容」的块：
 *      dry-run 不改文件；--apply 先备份；内容行逐字节不变；最新 K=20 个交互头保留。
 *
 * 全部离线：临时 PET_DATA_ROOT + temp 夹具；不碰真实 data。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const iso = require('./lib/test-isolation.cjs');

// ⚠ 顺序：先隔离数据根，再 require 业务模块（records-path 在加载时定 RECORDS_DIR）
const TMP = iso.setUpTempDataRoot('pet-memory-hygiene-');
const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const SCRIPT = path.join(LIVE, 'scripts', 'cleanup-memory-placeholders.mjs');

const { MessageInitializer } = require(path.join(LIVE, 'js', 'ai', 'conversation', 'MessageInitializer.js'));
const { InputRouter } = require(path.join(LIVE, 'js', 'ai', 'conversation', 'InputRouter.js'));
const { recordFile } = require(path.join(LIVE, 'js', 'core', 'records-path.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function run(args) {
    return execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function listFiles(dir) {
    return fs.readdirSync(dir);
}

function contentLines(text) {
    return text.split('\n').filter((l) => l.trim() && !/^交互\d+：/.test(l) && !/^\[20/.test(l) && !/^-{10,}/.test(l));
}

(async () => {
    // ── ① 启动不写占位；第一条真实内容才写会话头 ─────────────────────────────
    const logPath = recordFile('记忆库.txt');
    iso.assertIsolated(logPath);
    {
        const init = new MessageInitializer({ llm: { system_prompt: '' }, context: { persistent_history: false } });
        await init.initialize();
        ok('启动后创建了记忆库文件', fs.existsSync(logPath));
        const afterBoot = fs.readFileSync(logPath, 'utf8');
        ok('启动不写任何「交互N：」占位', !/交互\d+：/.test(afterBoot), JSON.stringify(afterBoot));
        ok('启动也不写日期头', !/\[20\d\d年/.test(afterBoot), JSON.stringify(afterBoot));

        // 模拟一个 InputRouter（不接 LLM/DOM，只测落盘时机）
        const messages = [{ role: 'user', content: '你好呀' }, { role: 'assistant', content: '干嘛' }];
        const router = new InputRouter({ getMessages: () => messages }, null, {});
        router.saveToMemoryLog();
        const afterFirst = fs.readFileSync(logPath, 'utf8');
        ok('第一条真实内容前才写日期头 + 交互1',
            /(^|\n)-{10,}\n\[20\d\d年\d\d月\d\d日\]\n\n交互1：\n/.test(afterFirst), JSON.stringify(afterFirst));
        ok('内容按旧格式落盘', afterFirst.includes('【用户】: 你好呀') && afterFirst.includes('【大肥鱼】: 干嘛'));

        messages.push({ role: 'user', content: '今天好热' }, { role: 'assistant', content: '开空调' });
        router.saveToMemoryLog();
        const afterSecond = fs.readFileSync(logPath, 'utf8');
        const headers = afterSecond.match(/交互\d+：/g) || [];
        ok('同会话第二次落盘不再新增交互头', headers.length === 1, headers.join(','));
        ok('第二次内容仍追加在同一个头下',
            afterSecond.indexOf('【用户】: 今天好热') > afterSecond.indexOf('交互1：'));
        ok('会话落盘后没有空占位块', !/交互\d+：\n\s*\n(?!交互)/.test(afterSecond), JSON.stringify(afterSecond));
        ok('编号逻辑未被破坏：下个编号 = 2',
            new MessageInitializer({}).getNextInteractionNumber() === 2,
            String(new MessageInitializer({}).getNextInteractionNumber()));
    }

    // ── ② 清理脚本：夹具 = 23 个交互头 / 2 个有内容 / 21 个空占位 ────────────
    const fxDir = fs.mkdtempSync(path.join(TMP, 'fixture-'));
    const fx = path.join(fxDir, '记忆库.txt');
    {
        const lines = ['------------------------------------', '[2026年11月01日]', ''];
        for (let n = 1; n <= 3; n += 1) lines.push(`交互${n}：`, '');
        for (let n = 4; n <= 5; n += 1) {
            lines.push(`交互${n}：`, `【用户】: 第${n}轮的问题`, `【大肥鱼】: 第${n}轮的回答`, '');
        }
        for (let n = 6; n <= 23; n += 1) lines.push(`交互${n}：`, '');
        lines.push('------------------------------------', '[2026年11月02日]', '', '【用户】: 尾部内容', '');
        fs.writeFileSync(fx, lines.join('\n'), 'utf8');
    }
    const fixtureOriginal = fs.readFileSync(fx, 'utf8');
    const fixtureContentBefore = contentLines(fixtureOriginal);

    {
        const out = run(['--file', fx]);
        ok('dry-run 打印将删除的空占位块数', /将删除空占位块：3 个/.test(out), out.split('\n')[2]);
        ok('dry-run 未改文件', fs.readFileSync(fx, 'utf8') === fixtureOriginal);
        ok('dry-run 不产生备份文件', listFiles(fxDir).filter((f) => f.includes('清理备份')).length === 0,
            listFiles(fxDir).join(','));
    }

    let backupPath = '';
    {
        const out = run(['--file', fx, '--apply']);
        const saved = fs.readFileSync(fx, 'utf8');
        const backups = listFiles(fxDir).filter((f) => /清理备份-\d{8}-\d{6}\.txt$/.test(f));
        backupPath = backups.length ? path.join(fxDir, backups[0]) : '';
        ok('apply 生成同目录备份（记忆库.清理备份-YYYYMMDD-HHmmss.txt）', backups.length === 1, backups.join(','));
        ok('备份内容与原始文件逐字节一致', Boolean(backupPath) && fs.readFileSync(backupPath, 'utf8') === fixtureOriginal);
        ok('apply 输出统计（删除 3 个块）', /删除空占位块 3 个/.test(out), out.split('\n')[1]);

        ok('最早 3 个空占位已删净', !/交互[123]：/.test(saved), (saved.match(/交互\d+：/g) || []).join(','));
        ok('最新 20 个交互头全部保留',
            [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
                .every((n) => saved.includes(`交互${n}：`)),
            (saved.match(/交互\d+：/g) || []).length + ' 个');
        ok('有内容的交互一字不差（内容行逐字节不变）',
            JSON.stringify(contentLines(saved)) === JSON.stringify(fixtureContentBefore),
            contentLines(saved).length + ' 行');
        ok('日期头/分隔线保留', (saved.match(/^-{10,}$/gm) || []).length === 2
            && saved.includes('[2026年11月01日]') && saved.includes('[2026年11月02日]'));
        ok('末尾空行结构保留（文件仍以换行结束）', saved.endsWith('\n'));

        // 幂等：再跑一次没有可删的，不写盘、不再备份
        const beforeSecond = fs.readFileSync(fx, 'utf8');
        const backupsBefore = listFiles(fxDir).filter((f) => f.includes('清理备份')).length;
        const out2 = run(['--file', fx, '--apply']);
        ok('幂等：第二次 apply 无改动', fs.readFileSync(fx, 'utf8') === beforeSecond && /没有可删的空占位块/.test(out2));
        ok('幂等：不重复生成备份',
            listFiles(fxDir).filter((f) => f.includes('清理备份')).length === backupsBefore,
            String(backupsBefore));
    }

    // ── ③ --keep 可调：保留更多/更少 ────────────────────────────────────────
    {
        const fx2Dir = fs.mkdtempSync(path.join(TMP, 'fixture2-'));
        const fx2 = path.join(fx2Dir, '记忆库.txt');
        const lines = [];
        for (let n = 1; n <= 5; n += 1) lines.push(`交互${n}：`, '');
        fs.writeFileSync(fx2, lines.join('\n') + '\n', 'utf8');
        run(['--file', fx2, '--keep', '2', '--apply']);
        const saved = fs.readFileSync(fx2, 'utf8');
        ok('--keep 2：只保留最新 2 个交互头', /交互4：/.test(saved) && /交互5：/.test(saved)
            && !/交互1：/.test(saved) && !/交互3：/.test(saved), (saved.match(/交互\d+：/g) || []).join(','));
    }

    // ── ④ 真实文件只做干跑检查（不 apply）─────────────────────────────────────
    {
        // 用脚本自己的默认路径干跑一次，确认统计可读、且不改真实数据（字节不变）
        const real = path.resolve(path.join(LIVE, '..', 'data', '记忆库.txt'));
        if (fs.existsSync(real)) {
            const before = fs.statSync(real);
            const out = run(['--file', real]);
            const after = fs.statSync(real);
            ok('真实记忆库干跑可读且文件字节数不变',
                /交互头 \d+ 个/.test(out) && before.size === after.size && before.mtimeMs === after.mtimeMs,
                out.split('\n')[1]);
        } else {
            ok('真实记忆库不存在（跳过干跑）', true, 'skip');
        }
    }

    // ── ④ 后台 LLM 闸（判官是额外一次 API 调用，静默/配额耗尽时不该烧）─────────────
    {
        const PersonaGuard = require(path.join(LIVE, 'plugins', 'community', 'persona-guard', 'index.js'));
        const mkGuard = (cfg = {}) => {
            const p = new PersonaGuard();
            const logs = [];
            const state = { calls: 0 };
            p.context = {
                getPluginFileConfig: () => ({ max_chars: 200, judge_every: 1 }),
                getConfig: () => cfg,
                log: (lv, m) => logs.push(lv + ':' + m),
                addSystemPromptPatch: () => {},
                removeSystemPromptPatch: () => {},
                callLLM: async () => { state.calls += 1; return '{"dimension":"none"}'; },
                getMessages: () => [],
            };
            return { p, logs, state };
        };

        // 真实模块（background-llm.js）的返回契约是 {ok, reason, retryAt}
        const BG = require(path.join(LIVE, 'js', 'core', 'background-llm.js'));
        const realVerdict = BG.canRun({ getConfig: () => ({}) });
        ok('background-llm.canRun 返回 {ok:boolean}（persona-guard 必须判 .ok）',
            realVerdict && typeof realVerdict.ok === 'boolean', JSON.stringify(realVerdict));

        // 真实闸 + 用户关掉后台 LLM → {ok:false, reason:'disabled'}
        const off = mkGuard({ cost: { background_llm: false } });
        await off.p.onInit();
        ok('真实 canRun 返回 {ok:false} 时 _backgroundAllowed 拒绝',
            (await off.p._backgroundAllowed()) === false);
        const rOff = await off.p._judgeOoc('这句会不会出戏呢');
        ok('真实闸 {ok:false}：跳过判官、不调 LLM', rOff === null && off.state.calls === 0,
            'calls=' + off.state.calls);
        ok('真实闸 {ok:false}：只 log 一次（不每轮刷）',
            off.logs.filter((l) => l.includes('后台 LLM 闸不可用')).length === 1,
            off.logs.filter((l) => l.includes('后台 LLM 闸不可用')).length + ' 条');
        ok('被跳过的那句没被标记成「已判」（闸恢复后可补判）',
            !(off.p._judged && off.p._judged.size), 'judged=' + (off.p._judged ? off.p._judged.size : 0));

        // 2026-11-25：persona-guard 改用 background-llm.ensureCanRun(context,{kind})，
        // 不再有 _bgGate/_bgGateReady 注入点。这里直接桩模块导出，测完还原。
        const withEnsureCanRun = async (impl, fn) => {
            const orig = BG.ensureCanRun;
            BG.ensureCanRun = impl;
            try { return await fn(); } finally { BG.ensureCanRun = orig; }
        };

        // 配额耗尽（reason 直传）同样必须挡
        await withEnsureCanRun(
            () => ({ ok: false, reason: 'quota_exhausted', retryAt: Date.now() + 60000 }),
            async () => {
                const quota = mkGuard();
                await quota.p.onInit();
                ok('{ok:false, reason:quota_exhausted} → 跳过判官',
                    (await quota.p._backgroundAllowed()) === false
                    && (await quota.p._judgeOoc('配额耗尽的时候别判')) === null && quota.state.calls === 0,
                    'calls=' + quota.state.calls);
            });

        // 闸允许 → 正常判
        await withEnsureCanRun(
            () => ({ ok: true, reason: null, retryAt: null }),
            async () => {
                const on = mkGuard();
                await on.p.onInit();
                await on.p._judgeOoc('闸允许的时候要判');
                ok('{ok:true} → 判官照常跑', on.state.calls === 1, 'calls=' + on.state.calls);
            });

        // 闸抛错：2026-11-25 契约改为「不在 _backgroundAllowed 内吞掉」——真抛了让
        // 调用方（onLLMResponse 的 Promise.catch）记失败；这里断言异常确实向上抛。
        await withEnsureCanRun(
            () => { throw new Error('boom'); },
            async () => {
                const boom = mkGuard();
                await boom.p.onInit();
                let thrown = null;
                try { await boom.p._backgroundAllowed(); } catch (e) { thrown = e; }
                ok('ensureCanRun 抛错时向上抛（由调用方 catch 兜底，不静默放行）',
                    !!thrown && /boom/.test(String(thrown && thrown.message)),
                    thrown ? String(thrown.message) : 'not thrown');
            });

        // 模块缺 ensureCanRun（旧版/加载失败）→ fail-open
        await withEnsureCanRun(undefined, async () => {
            const none = mkGuard();
            await none.p.onInit();
            ok('模块缺失（无闸）时 fail-open', (await none.p._backgroundAllowed()) === true);
        });
    }

    iso.cleanup(TMP);
    console.log('\n  记忆库卫生：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试异常：', e && e.stack || e);
    iso.cleanup(TMP);
    process.exit(2);
});
