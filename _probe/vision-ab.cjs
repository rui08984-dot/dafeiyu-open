'use strict';
/**
 * vision A/B：本地三档（8B/4B/2B-instruct）vs 生产云端（deepseek-v4.1-flash）
 * 用生产提示词逐字复刻；图片按生产尺寸（长边 640，JPEG 0.72）预生成。
 * 产出 _probe/out/vision-ab/results.json（逐条增量落盘）。
 */
const fs = require('fs');
const path = require('path');

const APP = '<project-root>/_incoming/my-neuro/live-2d';
const OUT = '<project-root>/_probe/out/vision-ab';
const visionTier = require(path.join(APP, 'js/core/vision-tier.js'));
const { LLMClient } = require(path.join(APP, 'js/ai/llm-client.js'));
const providers = require(path.join(APP, 'llm_providers.json'));

const IMAGES = ['game', 'pet', 'remote', 'settings', 'para', 'table'];
const SHEET = 'sheet';
const OLLAMA = 'http://127.0.0.1:11434';
const REQUEST_TIMEOUT = 180000;

const SYSTEM_SINGLE = [
    '你是一个「看屏幕」的感知器官，不是助手。你的输出会被存成一条时间线记录，供另一个模型读。',
    '规则：',
    '1) 只输出一句中文，不超过 40 个字，不要引号、不要「用户似乎」、不要建议或提问。',
    '2) 必须先定性内容类型：剧集 / 电影 / 游戏 / 代码 / 网页 / 聊天 / 文档 / 音乐 / 桌面 / 其他。桌宠、动漫角色立绘窗口算「桌面」，不要算游戏。',
    '3) 再补一个能认出来的细节：画面里在发生什么、界面上有什么、有没有字幕台词。',
    '4) 不要描述「有图标」「有窗口」这种废话——那是任何桌面都有的。',
    '示例：「剧集：两个男人在昏暗房间里对峙，字幕写着『你早就知道』」。',
].join('\n');

const SYSTEM_SHEET = [
    '你是一个「看屏幕」的感知器官，输出会被存成时间线。',
    '给你的是**连续画面拼成的一张格子图**：从左到右、从上到下按时间排列，每格左下角是时间码。',
    '规则：',
    '1) 只输出一句中文，不超过 40 字，不要引号、不要建议。',
    '2) 先定性内容：剧集/电影/游戏/代码/网页/聊天/文档/桌面/其他。桌宠、动漫角色立绘窗口算「桌面」，不要算游戏。',
    '3) 再说这段里在做什么（人物在干什么、画面怎么变）。',
    '4) **如果中途换了内容**（换了节目、换了窗口、界面整个变了），必须指出从第几格开始换的。',
    '示例：「剧集：两人在厨房争论，第 8 格起换成了街景追逐」。',
].join('\n');

const LOW_HINT = '这是低配视觉档：只回一句话，不要展开。';

const images = JSON.parse(fs.readFileSync(path.join(OUT, 'images.json'), 'utf8'));

function msgSingle(name, lowHint) {
    const sys = lowHint ? SYSTEM_SINGLE + '\n' + LOW_HINT : SYSTEM_SINGLE;
    return [
        { role: 'system', content: sys },
        {
            role: 'user',
            content: [
                { type: 'text', text: '这一帧是什么内容？按规则回一句。' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + images[name].b64, detail: 'low' } },
            ],
        },
    ];
}

function msgSheet(lowHint) {
    const sys = lowHint ? SYSTEM_SHEET + '\n' + LOW_HINT : SYSTEM_SHEET;
    return [
        { role: 'system', content: sys },
        {
            role: 'user',
            content: [
                { type: 'text', text: '这是最近 12 格连续画面，说说这段里在做什么。' },
                { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + images.sheet.b64, detail: 'low' } },
            ],
        },
    ];
}

function freeVram() {
    try {
        const out = require('child_process').execFileSync('nvidia-smi',
            ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 5000 }).toString();
        return parseInt(out.trim(), 10);
    } catch (_) { return null; }
}

async function unload(model) {
    try {
        await fetch(OLLAMA + '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, keep_alive: 0 }),
            signal: AbortSignal.timeout(15000),
        });
        await new Promise((r) => setTimeout(r, 1200));
    } catch (_) { /* ignore */ }
}

function cloudClient() {
    const arr = Array.isArray(providers.providers) ? providers.providers : Object.values(providers.providers || {});
    const p = arr.find((x) => x.id === 'comad');
    if (!p) throw new Error('comad provider not found');
    return LLMClient.fromProviderConfig({
        id: p.id,
        api_key: p.api_key,
        api_url: p.api_url,
        model: 'deepseek/deepseek-v4.1-flash',
        temperature: 0.85,
        temperature_enabled: true,
        reasoning_enabled: false,
    }, {});
}

async function callLocal(model, messages, lowHint) {
    const t0 = Date.now();
    try {
        const text = await visionTier.callOllama({
            model,
            messages,
            baseUrl: OLLAMA,
            timeoutMs: REQUEST_TIMEOUT,
            maxTokens: 900,
        });
        return { ok: true, text, ms: Date.now() - t0 };
    } catch (error) {
        return { ok: false, text: '', ms: Date.now() - t0, error: String((error && error.message) || error) };
    }
}

async function callCloud(client, messages) {
    const t0 = Date.now();
    try {
        const reply = await client.chatCompletion(messages, null, false);
        const text = String((reply && reply.content) || '').replace(/\s+/g, ' ').trim();
        return { ok: !!text, text, ms: Date.now() - t0, raw: { usage: reply && reply.usage } };
    } catch (error) {
        return { ok: false, text: '', ms: Date.now() - t0, error: String((error && error.message) || error) };
    }
}

function classify(text) {
    const types = ['剧集', '电影', '游戏', '代码', '网页', '聊天', '文档', '音乐', '桌面', '其他'];
    const hit = types.find((t) => text.indexOf(t) === 0 || text.slice(0, 4).includes(t));
    const hasSwitch = /第\s*\d+\s*格|换成|切到|切换到|换了/.test(text);
    const cells = text.match(/第\s*(\d+)\s*格/);
    return {
        type: hit || null,
        sentences: (text.match(/[。！？!?]/g) || []).length,
        chars: text.length,
        hasSwitch,
        switchCell: cells ? Number(cells[1]) : null,
        quotes: /[「」“”"]/.test(text),
    };
}

async function main() {
    const results = {
        generatedAt: new Date().toISOString(),
        images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, { w: v.w, h: v.h }])),
        vramStart: freeVram(),
        arms: {},
        runs: [],
    };
    const save = () => fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));

    const cases = [
        ...IMAGES.map((n) => ({ name: n, messages: msgSingle(n, false), kind: 'single' })),
        { name: SHEET, messages: msgSheet(false), kind: 'sheet' },
    ];

    // 1) 云端（无显存占用，先跑）
    const client = cloudClient();
    results.arms.cloud = { model: 'deepseek/deepseek-v4.1-flash', note: 'temperature 0.85（生产配置）' };
    for (const c of cases) {
        const r = await callCloud(client, c.messages);
        const row = { arm: 'cloud', case: c.name, kind: c.kind, ...r, ...(r.ok ? classify(r.text) : {}) };
        results.runs.push(row); save();
        console.log('[cloud]', c.name, r.ms + 'ms', r.ok ? r.text : ('ERR ' + r.error));
    }
    // 云端复跑（看随机性）：game/pet/sheet
    for (const name of ['game', 'pet', SHEET]) {
        const c = cases.find((x) => x.name === name);
        const r = await callCloud(client, c.messages);
        const row = { arm: 'cloud#2', case: name, kind: c.kind, ...r, ...(r.ok ? classify(r.text) : {}) };
        results.runs.push(row); save();
        console.log('[cloud#2]', name, r.ms + 'ms', r.ok ? r.text : ('ERR ' + r.error));
    }

    // 2) 本地三档：低→高，逐档卸载，冷/热分别记录
    const arms = [
        { id: 'low', model: 'qwen3-vl:2b-instruct', lowHint: true },
        { id: 'mid', model: 'qwen3-vl:4b-instruct', lowHint: false },
        { id: 'high', model: 'qwen3-vl:8b-instruct', lowHint: false },
    ];
    for (const arm of arms) {
        await unload('qwen3-vl:8b-instruct');
        await unload('qwen3-vl:4b-instruct');
        await unload('qwen3-vl:2b-instruct');
        results.arms[arm.id] = { model: arm.model, lowHint: arm.lowHint, vramBefore: freeVram() };
        let first = true;
        for (const c of cases) {
            // low 档按生产行为：低档 prompt 追加一句约束（sheet 也一样）
            const messages = c.kind === 'sheet' ? msgSheet(arm.lowHint) : msgSingle(c.name, arm.lowHint);
            const r = await callLocal(arm.model, messages);
            const row = {
                arm: arm.id, case: c.name, kind: c.kind, cold: first,
                ...r, ...(r.ok ? classify(r.text) : {}),
            };
            row.vramAfter = freeVram();
            first = false;
            results.runs.push(row); save();
            console.log('[' + arm.id + ']', c.name, (row.cold ? 'COLD ' : '') + r.ms + 'ms', r.ok ? r.text : ('ERR ' + r.error));
        }
        results.arms[arm.id].vramPeak = freeVram();
        save();
        await unload(arm.model);
    }

    // 汇总
    const summary = {};
    for (const row of results.runs) {
        const key = row.arm;
        summary[key] = summary[key] || { n: 0, ok: 0, cold: null, warm: [], chars: [] };
        const s = summary[key];
        s.n += 1;
        if (row.ok) { s.ok += 1; s.chars.push(row.chars); }
        if (row.cold) s.cold = row.ms; else s.warm.push(row.ms);
    }
    for (const s of Object.values(summary)) {
        s.warmP50 = s.warm.length ? s.warm.slice().sort((a, b) => a - b)[Math.floor(s.warm.length / 2)] : null;
        s.warmMin = s.warm.length ? Math.min(...s.warm) : null;
        s.warmMax = s.warm.length ? Math.max(...s.warm) : null;
    }
    results.summary = summary;
    save();
    console.log('\nSUMMARY', JSON.stringify(summary, null, 1));
}

main().then(() => {
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 1500);
}).catch((e) => {
    console.error('FATAL', e);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1500);
});
