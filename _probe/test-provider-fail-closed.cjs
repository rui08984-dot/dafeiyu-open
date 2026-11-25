#!/usr/bin/env node
/**
 * _probe/test-provider-fail-closed.cjs —— 插件指定 provider 必须 fail-closed（2026-11-24 第三轮 P1）
 *
 * 防的是「隐式回云」：
 *   llm-provider.js 的 resolveProviderOrFallback 在**找不到指定 provider 时降级到默认（云端）
 *   provider**。旧 plugin-context.callLLM 接受这个降级结果 —— memory-evolve 用
 *   provider_id:'local-memory'，一旦 provider 配置丢失 / manager 未初始化 / provider 被禁用，
 *   片段卡就会静默打到云端（审计 §8.5 最后一条）。
 *
 * 现在规则：
 *   ① provider_id 真存在 → 用它的 api_url/key/model；
 *   ② provider_id 不存在（或已禁用）→ 抛 code=PROVIDER_NOT_FOUND，**一个请求都不发**；
 *   ③ provider_id 为空 → 保留旧回退（legacy api_url / voiceChat 全局 / 默认 provider）；
 *   ④ local-memory 解析到非回环地址 → warn（按 URL 去重，不阻断：配置责任在人）。
 *
 * 全程离线：global.fetch 换成假实现，不连任何网络。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const iso = require('./lib/test-isolation.cjs');

// 先隔离数据根，再 require 业务模块（与其它 probe 同口径；本测试其实不写盘，但保持惯例）
const TMP = iso.setUpTempDataRoot('pet-provider-failclosed-');
// 账本也要落临时目录：⑤ 会走 callLLM 成功路径（会写 llm.usage），
// 不隔离就会往真实 .runtime/telemetry.jsonl 里灌探针行。
process.env.PET_TELEMETRY_DIR = TMP;

const LIVE = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const { PluginContext, __test } = require(path.join(LIVE, 'js', 'core', 'plugin-context.js'));
const { llmProviderManager } = require(path.join(LIVE, 'js', 'core', 'llm-provider.js'));

/** 读临时目录里的账本行（文件很小，每次全量读）。 */
function usageRows() {
    const file = path.join(TMP, 'telemetry.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
        .filter((r) => r && r.type === 'llm.usage');
}

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ── 假 fetch（记录每次请求，永远成功）──────────────────────────────────────
const calls = [];
global.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
        text: async () => '',
    };
};

const PROVIDERS = [
    {
        id: 'main', name: '云端主模型', enabled: true,
        api_url: 'https://cloud.example.com/v1', api_key: 'cloud-key',
        models: [{ model_id: 'main-model' }],
    },
    {
        id: 'local-memory', name: '本地记忆模型', enabled: true,
        api_url: 'http://127.0.0.1:11435/v1', api_key: 'local-key',
        models: [{ model_id: 'MemOperator-4B' }],
    },
    {
        id: 'offline-one', name: '已停用的提供商', enabled: false,
        api_url: 'https://offline.example.com/v1', api_key: 'x',
        models: [{ model_id: 'off' }],
    },
];

function initProviders(list) {
    llmProviderManager.init({ llm: { provider_id: 'main' }, llm_providers: list || PROVIDERS });
}

(async () => {
    const ctx = new PluginContext('probe', {}, null);

    // ── ① 指定存在的 provider：用它的连接，不回退云端 ────────────────────────
    {
        initProviders();
        calls.length = 0;
        const text = await ctx.callLLM('把这段对话压成卡片', { provider_id: 'local-memory' });
        ok('callLLM 返回模型输出', text === 'OK', String(text));
        ok('发出且只发出 1 个请求', calls.length === 1, 'calls=' + calls.length);
        const url = calls[0] ? calls[0].url : '';
        ok('请求打到 local-memory 的 api_url（不是云端默认）',
            url === 'http://127.0.0.1:11435/v1/chat/completions', url);
        const auth = (calls[0] && calls[0].init.headers && calls[0].init.headers.Authorization) || '';
        ok('用 local-memory 的 key', auth === 'Bearer local-key', auth);
        let body = {};
        try { body = JSON.parse((calls[0] && calls[0].init.body) || '{}'); } catch (e) { body = {}; }
        ok('模型来自 local-memory 的模型表', body.model === 'MemOperator-4B', String(body.model));
    }

    // ── ② 指定不存在的 provider：throw，且一个请求都不发 ─────────────────────
    {
        initProviders();
        calls.length = 0;
        let err = null;
        try { await ctx.callLLM('不该发出去的请求', { provider_id: 'no-such-provider' }); }
        catch (e) { err = e; }
        ok('抛错而不是静默回退', !!err, err && err.message);
        ok('err.code = PROVIDER_NOT_FOUND', !!err && err.code === 'PROVIDER_NOT_FOUND', err && err.code);
        ok('错误信息带 providerId', !!err && String(err.message).includes('no-such-provider'));
        ok('错误信息带可用 provider 名单（main / local-memory）',
            !!err && String(err.message).includes('main') && String(err.message).includes('local-memory'),
            err && err.message);
        ok('err.availableProviders 不含已停用的 provider',
            !!err && Array.isArray(err.availableProviders)
            && err.availableProviders.includes('main')
            && err.availableProviders.includes('local-memory')
            && !err.availableProviders.includes('offline-one'),
            JSON.stringify(err && err.availableProviders));
        ok('一个请求都没发（fail-closed）', calls.length === 0, 'calls=' + calls.length);
    }

    // ── ②b provider 存在但被禁用：同样 fail-closed（不许偷偷用默认云端）──────
    {
        initProviders();
        calls.length = 0;
        let err = null;
        try { await ctx.callLLM('禁用 provider 也不许回云', { provider_id: 'offline-one' }); }
        catch (e) { err = e; }
        ok('已禁用 provider → PROVIDER_NOT_FOUND', !!err && err.code === 'PROVIDER_NOT_FOUND',
            err && (err.code + ':' + err.message));
        ok('已禁用 provider → 不发请求', calls.length === 0, 'calls=' + calls.length);
    }

    // ── ③ provider_id 为空：保留旧回退（voiceChat 全局模型）─────────────────
    {
        initProviders();
        calls.length = 0;
        global.voiceChat = {
            API_URL: 'https://global.example.com/v1',
            API_KEY: 'global-key',
            MODEL: 'global-model',
            messages: [],
        };
        const text = await ctx.callLLM('走全局模型');
        ok('provider_id 为空仍走全局（不抛）', text === 'OK', String(text));
        ok('确实打到 voiceChat.API_URL',
            calls.length === 1 && calls[0].url === 'https://global.example.com/v1/chat/completions',
            calls[0] && calls[0].url);
        let body = {};
        try { body = JSON.parse((calls[0] && calls[0].init.body) || '{}'); } catch (e) { body = {}; }
        ok('全局模型名沿用 voiceChat.MODEL', body.model === 'global-model', String(body.model));
        delete global.voiceChat;
    }

    // ── ③b provider_id 为空且无 voiceChat：回退默认 provider（旧行为不变）────
    {
        initProviders();
        calls.length = 0;
        const text = await ctx.callLLM('没有全局模型时用默认 provider');
        ok('无 voiceChat 时落到默认 provider', text === 'OK', String(text));
        ok('默认 provider 是 main（云端）',
            calls.length === 1 && calls[0].url === 'https://cloud.example.com/v1/chat/completions',
            calls[0] && calls[0].url);
    }

    // ── ④ local-memory 指到非回环地址：warn 一次，不阻断 ────────────────────
    {
        initProviders([
            PROVIDERS[0],
            {
                id: 'local-memory', name: '本地记忆模型', enabled: true,
                api_url: 'http://192.168.1.9:11435/v1', api_key: 'lan-key',
                models: [{ model_id: 'MemOperator-4B' }],
            },
        ]);
        calls.length = 0;
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...args) => { warns.push(args.join(' ')); };
        try {
            await ctx.callLLM('第一次', { provider_id: 'local-memory' });
            await ctx.callLLM('第二次', { provider_id: 'local-memory' });
        } finally {
            console.warn = origWarn;
        }
        const loopWarns = warns.filter((w) => w.includes('非回环地址'));
        ok('非回环 local-memory 记录 warn', loopWarns.length >= 1, loopWarns.join(' | '));
        ok('同一 URL 只 warn 一次（两次调用）', loopWarns.length === 1, 'warns=' + loopWarns.length);
        ok('warn 不阻断：两个请求都发了', calls.length === 2, 'calls=' + calls.length);
        ok('warn 文案点名 local-memory',
            loopWarns.length > 0 && loopWarns[0].includes('local-memory'), loopWarns[0] || '');
    }

    // ── ⑤ 回环判定：本地别名一律 source=local（不消耗云端配额）──────────────
    // 旧实现只认裸 `::1`：`[::1%25lo0]`（zone id）与 `[::ffff:127.0.0.1]`（v4-mapped）
    // 被判成云端，本地调用进了 80% 周预算（方向是多算钱）。这里同时验纯函数与账本落点。
    {
        const host = __test.isLoopbackHost;
        ok('[::1] → 本机', host('[::1]') === true);
        ok('[::1%25lo0]（zone id）→ 本机', host('[::1%25lo0]') === true);
        ok('[::ffff:127.0.0.1]（v4-mapped）→ 本机', host('[::ffff:127.0.0.1]') === true);
        ok('127.0.0.2 → 本机（127/8）', host('127.0.0.2') === true);
        ok('LOCALHOST → 本机（大小写不敏感）', host('LOCALHOST') === true);
        ok('0.0.0.0 → 本机（监听地址，模板里出现过）', host('0.0.0.0') === true);
        ok('192.168.1.10 → 云端', host('192.168.1.10') === false);
        ok('api.commandcode.ai → 云端', host('api.commandcode.ai') === false);
        ok('https://x:11435（非回环 host）→ 云端', __test.isLoopbackUrl('https://x:11435') === false);

        // 端到端：callLLM 落账本的 source 必须与判定一致（doctor 的 80% 只算 plugin）
        const callLLM = PluginContext.prototype.callLLM;
        const sourceFor = async (apiUrl) => {
            const self = {
                resolveLLM: () => ({ id: 'p', api_url: apiUrl, api_key: 'k', model: 'm' }),
            };
            global.fetch = async () => ({
                ok: true, status: 200,
                json: async () => ({
                    choices: [{ message: { content: 'OK' } }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                }),
            });
            const before = usageRows().length;
            await callLLM.call(self, 'p', { provider_id: 'p' });
            return (usageRows()[before] || {}).source;
        };

        ok('账本：[::1%25lo0] → source=local',
            (await sourceFor('http://[::1%25lo0]:11435/v1')) === 'local');
        ok('账本：[::ffff:127.0.0.1] → source=local',
            (await sourceFor('http://[::ffff:127.0.0.1]:11435/v1')) === 'local');
        ok('账本：127.0.0.2:8080 → source=local',
            (await sourceFor('http://127.0.0.2:8080/v1')) === 'local');
        ok('账本：api.commandcode.ai → source=plugin（算云端预算）',
            (await sourceFor('https://api.commandcode.ai/v1')) === 'plugin');
        ok('账本：https://x:11435 → source=plugin（非回环 host）',
            (await sourceFor('https://x:11435/v1')) === 'plugin');
    }

    iso.cleanup(TMP);
    console.log('\n  provider fail-closed：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('探针自身异常：', e);
    try { iso.cleanup(TMP); } catch (e2) { /* ignore */ }
    process.exit(1);
});
