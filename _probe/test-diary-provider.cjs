#!/usr/bin/env node
/**
 * _probe/test-diary-provider.cjs —— 日记通道选择（2026-11-24）
 *
 * 背景（HANDOFF-2026-11-24 实施 §8.5）：
 *   DiaryManager 之前**只能**走本地 MemOperator-4B（canRunLocal + localLLM.chat），
 *   实测输出是复述输入（「今天调了一整天缓存命中……那以后不会再每轮都压了吧」），
 *   没有人格口吻 —— 4B 指令跟随弱，日记这种 prose 不该交给它。
 *   根因修法：日记默认走**云端主模型**（一天一次、几百 token），本地降级为可选
 *   （config.diary.local_enabled，默认 false）。
 *
 * 本测验收：
 *   ① 默认配置 → 云闸 canRun + 云端 LLMClient，local 一次都不调；
 *   ② local_enabled=true → 本地闸 canRunLocal + localLLM.chat，云一次都不调；
 *   ③ 云闸 {ok:false} → 跳过且不落盘（连 generateDiary 都不进）；
 *   ④ 空输出不落盘（云 / 本地各一条）；
 *   ⑤ 不跨通道回退：云失败不偷偷打本地，本地失败不回云；
 *   ⑥ 素材不变：prompt 仍含心气 / 记忆整理 / 150 字要求。
 *
 * 全部离线：fake bg 闸 + fake local + fake LLMClient；日记写到临时文件。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MY_NEURO = path.join(LIVE, '..');
const { DiaryManager } = require(path.join(LIVE, 'js', 'ai', 'DiaryManager.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-diary-provider-'));
const DATE = '2026年11月24日';
const MEMORY = `[${DATE}]
用户: 今天好累
AI: 那就靠着我歇会儿
------------------------------------
[2026年11月23日]
用户: 昨天的事
AI: 嗯
------------------------------------
`;

function tmpDiaryPath(tag) {
    const file = path.join(TMP, `AI日记-${tag}.txt`);
    // DiaryManager 拼的是 path.join(__dirname,'..','..','..', aiDiaryFile) → my-neuro/<rel>
    const rel = path.relative(MY_NEURO, file);
    const resolved = path.resolve(LIVE, 'js', 'ai', '..', '..', '..', rel);
    if (resolved !== path.resolve(file)) throw new Error('测试日记路径解析不一致: ' + resolved);
    const realRecords = path.join(MY_NEURO, 'data') + path.sep;
    if (path.resolve(file).startsWith(realRecords)) throw new Error('测试会写真实 data，拒绝继续');
    return { abs: file, rel };
}

/**
 * 建一个 DiaryManager + 全部通道替身。
 * @param {object} opts
 *   config      voiceChat.config（日记读 config.diary）
 *   cloud       { content?, throws? } 云端替身行为
 *   local       { content?, throws? } 本地替身行为
 *   gate        { cloud?, local? } 闸返回值
 */
function makeDm(opts = {}) {
    const tag = String(opts.tag || 'case');
    const { abs, rel } = tmpDiaryPath(tag);
    const vc = {
        aiDiaryEnabled: false,
        aiDiaryIdleTime: 0,
        aiDiaryFile: rel,
        aiDiaryPrompt: '请以大肥鱼的身份写日记。',
        config: opts.config || {},
    };
    const dm = new DiaryManager(vc);
    const rec = { cloudCalls: 0, localCalls: 0, cloudGateCalls: 0, localGateCalls: 0, prompts: [] };

    dm._bgLLM = {
        canRun: () => { rec.cloudGateCalls += 1; return opts.gate && opts.gate.cloud ? opts.gate.cloud : { ok: true, reason: null }; },
        canRunLocal: async () => { rec.localGateCalls += 1; return opts.gate && opts.gate.local ? opts.gate.local : { ok: true, reason: null }; },
    };
    dm._cloudClient = {
        chatCompletion: async (messages, tools, stream) => {
            rec.cloudCalls += 1;
            rec.prompts.push({ channel: 'cloud', text: messages.map((m) => m.content).join('\n'), tools, stream });
            const c = opts.cloud || {};
            if (c.throws) throw new Error(c.throws === true ? 'cloud boom' : c.throws);
            return { role: 'assistant', content: c.content === undefined ? '今天挺累的，不过靠着我的时候还算安静，明天再折腾吧。' : c.content };
        },
    };
    dm._localLLM = {
        chat: async (prompt, options) => {
            rec.localCalls += 1;
            rec.prompts.push({ channel: 'local', text: prompt, options });
            const l = opts.local || {};
            if (l.throws) throw new Error(l.throws === true ? 'local boom' : l.throws);
            return l.content === undefined ? '本地日记正文' : l.content;
        },
    };

    return { dm, rec, abs, logs: [] };
}

function resetFile(abs) { try { fs.rmSync(abs, { force: true }); } catch (e) { /* ignore */ } }
function readIf(abs) { return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null; }

(async () => {
    console.log('\n① 默认配置 → 云端主模型');
    {
        const { dm, rec, abs } = makeDm({ tag: 'default' });
        resetFile(abs);
        ok('默认不启用本地（config 无 diary 段）', dm._isLocalDiaryEnabled() === false);
        await dm._diaryGate();
        ok('默认闸走云 canRun（1 次）且不碰 canRunLocal',
            rec.cloudGateCalls === 1 && rec.localGateCalls === 0,
            JSON.stringify({ cloud: rec.cloudGateCalls, local: rec.localGateCalls }));
        await dm.generateDiary(MEMORY, DATE);
        const body = readIf(abs);
        ok('云端 LLMClient 被调用 1 次', rec.cloudCalls === 1, 'calls=' + rec.cloudCalls);
        ok('本地模型一次都没调', rec.localCalls === 0, 'calls=' + rec.localCalls);
        ok('云端非流式、不带工具',
            rec.prompts[0].stream === false && Array.isArray(rec.prompts[0].tools) && rec.prompts[0].tools.length === 0,
            JSON.stringify({ stream: rec.prompts[0].stream, tools: rec.prompts[0].tools }));
        ok('日记落盘且内容是云端正文', !!body && body.includes('靠着我的时候还算安静'));
        resetFile(abs);
    }

    console.log('\n② diary.local_enabled=true → 本地（可选通道）');
    {
        const { dm, rec, abs } = makeDm({ tag: 'local', config: { diary: { local_enabled: true } } });
        resetFile(abs);
        ok('local_enabled=true 被读到', dm._isLocalDiaryEnabled() === true);
        await dm._diaryGate();
        ok('本地闸走 canRunLocal（1 次）且不碰云闸',
            rec.localGateCalls === 1 && rec.cloudGateCalls === 0,
            JSON.stringify({ cloud: rec.cloudGateCalls, local: rec.localGateCalls }));
        await dm.generateDiary(MEMORY, DATE);
        const body = readIf(abs);
        ok('localLLM.chat 被调用 1 次', rec.localCalls === 1, 'calls=' + rec.localCalls);
        ok('云端一次都没调', rec.cloudCalls === 0, 'calls=' + rec.cloudCalls);
        ok('本地日记落盘', !!body && body.includes('本地日记正文'));
        resetFile(abs);
    }

    console.log('\n③ 云闸 {ok:false} → 跳过且不落盘');
    {
        const { dm, rec, abs } = makeDm({
            tag: 'gate-cloud',
            gate: { cloud: { ok: false, reason: 'quota_exhausted', retryAt: Date.now() + 60000 } },
        });
        resetFile(abs);
        let entered = 0;
        dm.generateDiary = async () => { entered += 1; };
        const origLog = console.log;
        const lines = [];
        console.log = (...a) => { lines.push(a.join(' ')); };
        try { await dm.checkAndWriteDiary(); } finally { console.log = origLog; }
        ok('云闸不 ok：连 generateDiary 都不进', entered === 0 && rec.cloudCalls === 0 && rec.localCalls === 0);
        ok('云闸不 ok：不落盘', readIf(abs) === null);
        ok('日志说明走的是云通道并带 reason',
            lines.some((l) => l.includes('云端主模型不可用') && l.includes('quota_exhausted')),
            lines.filter((l) => l.includes('不可用')).join(' / '));
    }

    console.log('\n④ 本地闸 {ok:false} → 跳过且不落盘（不回云）');
    {
        const { dm, rec, abs } = makeDm({
            tag: 'gate-local',
            config: { diary: { local_enabled: true } },
            gate: { local: { ok: false, reason: 'local_down', retryAt: null } },
        });
        resetFile(abs);
        let entered = 0;
        dm.generateDiary = async () => { entered += 1; };
        const origLog = console.log;
        const lines = [];
        console.log = (...a) => { lines.push(a.join(' ')); };
        try { await dm.checkAndWriteDiary(); } finally { console.log = origLog; }
        ok('本地闸不 ok：不进 generateDiary', entered === 0);
        ok('本地闸不 ok：不落盘', readIf(abs) === null);
        ok('本地闸不 ok 也不偷调云端（云闸/云 LLM 都是 0）', rec.cloudCalls === 0 && rec.cloudGateCalls === 0,
            JSON.stringify({ cloudLlm: rec.cloudCalls, cloudGate: rec.cloudGateCalls }));
        ok('日志说明走的是本地通道并带 reason',
            lines.some((l) => l.includes('本地记忆模型不可用') && l.includes('local_down')),
            lines.filter((l) => l.includes('不可用')).join(' / '));
    }

    console.log('\n⑤ 空输出不落盘');
    {
        const { dm, rec, abs } = makeDm({ tag: 'empty-cloud', cloud: { content: '   ' } });
        resetFile(abs);
        await dm.generateDiary(MEMORY, DATE);
        ok('云端空输出：不落盘', readIf(abs) === null && rec.cloudCalls === 1);

        const l = makeDm({ tag: 'empty-local', config: { diary: { local_enabled: true } }, local: { content: '' } });
        resetFile(l.abs);
        await l.dm.generateDiary(MEMORY, DATE);
        ok('本地空输出：不落盘', readIf(l.abs) === null && l.rec.localCalls === 1);
    }

    console.log('\n⑥ 不跨通道回退');
    {
        const { dm, rec, abs } = makeDm({ tag: 'cloud-fail', cloud: { throws: true } });
        resetFile(abs);
        const origErr = console.error;
        console.error = () => {};
        try { await dm.generateDiary(MEMORY, DATE); } finally { console.error = origErr; }
        ok('云端失败：直接放弃（不回退本地）', rec.cloudCalls === 1 && rec.localCalls === 0 && readIf(abs) === null,
            JSON.stringify({ cloud: rec.cloudCalls, local: rec.localCalls }));

        const l = makeDm({ tag: 'local-fail', config: { diary: { local_enabled: true } }, local: { throws: true } });
        resetFile(l.abs);
        const origErr2 = console.error;
        console.error = () => {};
        try { await l.dm.generateDiary(MEMORY, DATE); } finally { console.error = origErr2; }
        ok('本地失败：直接放弃（不回退云端）',
            l.rec.localCalls === 1 && l.rec.cloudCalls === 0 && readIf(l.abs) === null,
            JSON.stringify({ cloud: l.rec.cloudCalls, local: l.rec.localCalls }));
    }

    console.log('\n⑦ 素材不变（心气 / 记忆整理 / 150 字）');
    {
        const { dm, rec, abs } = makeDm({ tag: 'material' });
        resetFile(abs);
        await dm.generateDiary(MEMORY, DATE);
        const p = rec.prompts[0].text;
        ok('prompt 含「今天的心气」', p.includes('今天的心气'));
        ok('prompt 含「今天的记忆整理」', p.includes('今天的记忆整理'));
        ok('prompt 含 150 字要求', p.includes('150 字'));
        ok('prompt 含今日对话素材', p.includes('今天好累'));
        ok('prompt 不含昨天段落（只取当天）', !p.includes('昨天的事'));
        resetFile(abs);
    }

    console.log('\n⑧ 云端 client 缓存：配置变化即重建（第四轮 P2 根因修）');
    {
        // 旧式三格 = 最容易被运行时轮换的一条路（provider 表为空时走这条）
        const vc = {
            aiDiaryEnabled: false,
            aiDiaryIdleTime: 0,
            aiDiaryFile: 'AI日记-cache.txt',
            aiDiaryPrompt: 'p',
            config: {},
            API_URL: 'http://127.0.0.1:1111/v1',
            MODEL: 'model-a',
            API_KEY: 'key-a',
        };
        const dm = new DiaryManager(vc);
        const c1 = dm._getCloudClient();
        ok('首次按当前配置建 client',
            !!c1 && c1.apiUrl === 'http://127.0.0.1:1111/v1' && c1.model === 'model-a' && c1.apiKey === 'key-a',
            JSON.stringify({ url: c1 && c1.apiUrl, model: c1 && c1.model }));

        const c2 = dm._getCloudClient();
        ok('同配置且未过 TTL → 复用同一实例（不每次重建）', c2 === c1);

        // 运行中换 provider（url/model/key 一起变）
        vc.API_URL = 'http://127.0.0.1:2222/v1';
        vc.MODEL = 'model-b';
        vc.API_KEY = 'key-b';
        const c3 = dm._getCloudClient();
        ok('换 provider 配置 → 立刻重建（不再 401 到重启）',
            c3 !== c1 && c3.apiUrl === 'http://127.0.0.1:2222/v1' && c3.model === 'model-b' && c3.apiKey === 'key-b',
            JSON.stringify({ same: c3 === c1, url: c3 && c3.apiUrl, model: c3 && c3.model }));

        const c3b = dm._getCloudClient();
        ok('新配置同样被缓存（未过 TTL 不重建）', c3b === c3);

        // 只换 key（最容易被忽略的轮换）也必须触发重建
        vc.API_KEY = 'key-c';
        const c4 = dm._getCloudClient();
        ok('只换 key → 也重建（指纹含 key 哈希）', c4 !== c3 && c4.apiKey === 'key-c', 'same=' + (c4 === c3));

        // 指纹不变但过了 TTL → 复核重建
        dm._cloudClientAt = Date.now() - 61000;
        const c5 = dm._getCloudClient();
        ok('指纹不变但过 60s TTL → 复核重建', c5 !== c4, 'same=' + (c5 === c4));

        // 外部注入的 client（测试/宿主手动替换）仍被尊重，不被缓存逻辑覆盖
        const injected = { chatCompletion: async () => ({ content: 'x' }) };
        const dm2 = new DiaryManager(vc);
        dm2._cloudClient = injected;
        ok('外部注入的 client 不被覆盖', dm2._getCloudClient() === injected);
    }

    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('\n  日记通道：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('测试异常：', (e && e.stack) || e);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    process.exit(2);
});
