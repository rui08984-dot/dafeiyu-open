// tts-backends.js —— TTS 引擎适配层（「随便换个 TTS 也完美适配」）。
//
// 设计：换引擎只换「请求形状」，播放/打断/降级/看门狗全部复用：
//   统一意图 { text, text_language, speed_factor }  →  各家 API 的 { url, headers, body }
//   返回仍然是音频 blob，走原有 tts-playback-engine 流程。
// 情绪韵律说明：Edge 走 /prosody 状态通道（驱动层在推，请求体不用带）；
//   其它后端没有情绪口，靠 speed_factor 兜底——适配层不做假情绪。
// 后端专属参数放 config.tts.backend_params（JSON 字符串，面板「引擎参数」里贴）：
//   sovits: {"ref_audio_path":"...","prompt_text":"...","prompt_lang":"zh","text_split_method":"cut5"}
//   openai: {"base_url":"https://api.xxx.com/v1","api_key":"sk-...","model":"tts-1","voice":"alloy"}
// 新增后端 = 往 BACKENDS 加一个 buildRequest，零处改动其它代码。

const clampSpeed = (v) => Math.max(0.25, Math.min(4, Number(v) || 1));

function parseParams(cfg) {
    try {
        const raw = cfg && cfg.tts && cfg.tts.backend_params;
        const obj = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
        return (obj && typeof obj === 'object') ? obj : {};
    } catch (e) {
        return { __parse_error: String(e && e.message || e) };
    }
}

const BACKENDS = {
    edge: {
        label: 'Edge TTS（本地包装）',
        buildRequest(intent, cfg) {
            return {
                url: cfg.tts.url,
                headers: { 'Content-Type': 'application/json' },
                // speed_factor：全局语速档（面板「语速」），服务端按 base_speed 再乘情绪/分句系数
                body: { text: intent.text, text_language: intent.text_language || 'zh', speed_factor: clampSpeed(intent.speed_factor ?? 1) },
            };
        },
    },

    // GPT-SoVITS api_v2：POST /tts，返回 wav 流。参考音频与文本在其面板里配。
    sovits: {
        label: 'GPT-SoVITS api_v2',
        buildRequest(intent, cfg) {
            const p = parseParams(cfg);
            return {
                url: cfg.tts.url,
                headers: { 'Content-Type': 'application/json' },
                body: {
                    text: intent.text,
                    text_lang: p.text_lang || intent.text_language || 'zh',
                    ref_audio_path: p.ref_audio_path || '',
                    prompt_text: p.prompt_text || '',
                    prompt_lang: p.prompt_lang || 'zh',
                    text_split_method: p.text_split_method || 'cut5',
                    speed_factor: clampSpeed(intent.speed_factor ?? 1),
                    ...(p.extra || {}),
                },
            };
        },
    },

    // OpenAI 兼容 /audio/speech（含各类代理：siliconflow/openrouter/自建 new-api）
    openai: {
        label: 'OpenAI 兼容接口',
        buildRequest(intent, cfg) {
            const p = parseParams(cfg);
            const base = String(p.base_url || cfg.tts.url || '').replace(/\/+$/, '');
            const url = /\/audio\/speech$/.test(base) ? base : base + '/audio/speech';
            const headers = { 'Content-Type': 'application/json' };
            if (p.api_key) headers.Authorization = `Bearer ${p.api_key}`;
            return {
                url,
                headers,
                body: {
                    model: p.model || 'tts-1',
                    input: intent.text,
                    voice: p.voice || 'alloy',
                    speed: clampSpeed(intent.speed_factor ?? 1),
                    response_format: p.response_format || 'mp3',
                },
            };
        },
    },

    // 自定义本地服务：只认 {text} 的 POST（大多数自建包装器都长这样）
    custom: {
        label: '自定义 POST {text}',
        buildRequest(intent, cfg) {
            return {
                url: cfg.tts.url,
                headers: { 'Content-Type': 'application/json' },
                body: { text: intent.text },
            };
        },
    },
};

function buildTTSRequest(backendId, intent, cfg) {
    const resolved = BACKENDS[backendId] ? backendId : 'edge';   // 未知后端回落 edge
    return { backend: resolved, ...BACKENDS[resolved].buildRequest(intent, cfg) };
}

function listBackends() {
    return Object.entries(BACKENDS).map(([id, b]) => ({ id, label: b.label }));
}

module.exports = { BACKENDS, buildTTSRequest, listBackends, parseParams };
