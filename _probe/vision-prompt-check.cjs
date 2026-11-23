'use strict';
// 小探针：验证「桌宠窗口算桌面不算游戏」这条提示词修正对云端是否生效（2 次）。
const fs = require('fs');
const path = require('path');
const APP = '<project-root>/_incoming/my-neuro/live-2d';
const { LLMClient } = require(path.join(APP, 'js/ai/llm-client.js'));
const providers = require(path.join(APP, 'llm_providers.json'));
const images = JSON.parse(fs.readFileSync('<project-root>/_probe/out/vision-ab/images.json', 'utf8'));

const system = [
    '你是一个「看屏幕」的感知器官，不是助手。你的输出会被存成一条时间线记录，供另一个模型读。',
    '规则：',
    '1) 只输出一句中文，不超过 40 个字，不要引号、不要「用户似乎」、不要建议或提问。',
    '2) 必须先定性内容类型：剧集 / 电影 / 游戏 / 代码 / 网页 / 聊天 / 文档 / 音乐 / 桌面 / 其他。桌宠、动漫角色立绘窗口算「桌面」，不要算游戏。',
    '3) 再补一个能认出来的细节：画面里在发生什么、界面上有什么、有没有字幕台词。',
    '4) 不要描述「有图标」「有窗口」这种废话——那是任何桌面都有的。',
    '示例：「剧集：两个男人在昏暗房间里对峙，字幕写着『你早就知道』」。',
].join('\n');

const messages = [
    { role: 'system', content: system },
    {
        role: 'user',
        content: [
            { type: 'text', text: '这一帧是什么内容？按规则回一句。' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + images.pet.b64, detail: 'low' } },
        ],
    },
];

(async () => {
    const arr = Array.isArray(providers.providers) ? providers.providers : Object.values(providers.providers || {});
    const p = arr.find((x) => x.id === 'comad');
    const client = LLMClient.fromProviderConfig({
        id: p.id, api_key: p.api_key, api_url: p.api_url,
        model: 'deepseek/deepseek-v4.1-flash', temperature: 0.85, temperature_enabled: true, reasoning_enabled: false,
    }, {});
    for (let i = 1; i <= 2; i += 1) {
        const t0 = Date.now();
        const reply = await client.chatCompletion(messages, null, false);
        console.log('#' + i, (Date.now() - t0) + 'ms', String((reply && reply.content) || '').replace(/\s+/g, ' ').trim());
    }
})().then(() => { setTimeout(() => process.exit(0), 800); }).catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
