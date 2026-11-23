// tts-backends 单测：node tts-backends.test.js（纯函数）
const { buildTTSRequest, listBackends, parseParams } = require('./tts-backends.js');

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); fails++; } };

const CFG = (over = {}) => ({ tts: { url: 'http://127.0.0.1:9883', backend: 'edge', backend_params: over.params || '', ...over.tts } });
const INTENT = { text: '你好呀', text_language: 'zh', speed_factor: 1.1 };

// 1. edge：与旧请求形状一致 + 全局语速透传（兼容硬约束：text/text_language 必在）
{
    const r = buildTTSRequest('edge', INTENT, CFG());
    ok(r.url === 'http://127.0.0.1:9883', 'edge url=tts.url');
    ok(r.body.text === '你好呀' && r.body.text_language === 'zh', 'edge body 形状不变');
    ok(r.body.speed_factor === 1.1, 'edge 语速透传');
}
// 2. sovits：api_v2 形状 + 参数合入
{
    const r = buildTTSRequest('sovits', INTENT, CFG({ params: JSON.stringify({ ref_audio_path: 'D:/ref.wav', prompt_text: '示例' }) }));
    ok(r.body.text_lang === 'zh' && r.body.ref_audio_path === 'D:/ref.wav' && r.body.prompt_text === '示例', 'sovits 参数合入');
    ok(r.body.speed_factor === 1.1, 'sovits 速度透传');
}
// 3. openai：URL 拼接 + Bearer + 字段
{
    const r = buildTTSRequest('openai', INTENT, CFG({ params: JSON.stringify({ base_url: 'https://api.xx.com/v1/', api_key: 'sk-test', voice: 'nex' }) }));
    ok(r.url === 'https://api.xx.com/v1/audio/speech', 'openai url 拼接（多余斜杠容忍）');
    ok(r.headers.Authorization === 'Bearer sk-test', 'openai Bearer');
    ok(r.body.input === '你好呀' && r.body.voice === 'nex' && r.body.speed === 1.1, 'openai 字段');
}
// 4. custom：只有 text
{
    const r = buildTTSRequest('custom', INTENT, CFG());
    ok(Object.keys(r.body).length === 1 && r.body.text === '你好呀', 'custom 只发 text');
}
// 5. 未知后端 → 回落 edge（不炸）
{
    const r = buildTTSRequest('no-such-backend', INTENT, CFG());
    ok(r.backend === 'edge' && r.body.text === '你好呀', '未知后端回落 edge');
}
// 6. 坏 JSON 参数：不炸，speed 等默认兜住
{
    const r = buildTTSRequest('openai', INTENT, CFG({ params: '{bad json' }));
    ok(r.body.model === 'tts-1' && r.body.speed === 1.1, '坏 JSON 参数兜底默认值');
    ok(parseParams(CFG({ params: '{bad' })).__parse_error, '坏 JSON 带错误标记');
}
// 7. 速度限幅
{
    const r = buildTTSRequest('sovits', { ...INTENT, speed_factor: 99 }, CFG());
    ok(r.body.speed_factor === 4, '速度上限 4');
}
// 8. 后端清单（面板用）
ok(listBackends().length === 4 && listBackends().every(b => b.id && b.label), '后端清单 4 项');

if (fails) { console.error(`tts-backends: ${fails} 项失败`); process.exit(1); }
console.log('tts-backends: 全部通过（8 组）');
