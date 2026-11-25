#!/usr/bin/env node
/**
 * _probe/test-template-url-whitelist.cjs — 模板生成器 URL 白名单 / 实例值中性化（2026-11-25）
 *
 * 背景：`scripts/gen-config-example.mjs` 的 URL host 白名单是 2026-11-24 P0 的修复
 * （natapp 隧道地址曾被原样复印进公开模板）。白名单写错有两种方向：
 *   · 过宽/可绕过：`example.com.evil.com`、`api.example.com@evil.com` 之类被当成合法 →
 *     个人/恶意地址照样进模板（P1）；
 *   · 过严：带端口、IPv6、大写 host 被误杀 → clone 的人照着模板连不上本机服务。
 *
 * 2026-11-25 P2-11 起生成器改为「扫所有 string 值里的 http(s)」，不再依赖 URL 键名
 * （`proxy` / `callback` 这类键也覆盖）；本测试直接 **import 生成器导出的纯函数**
 * （生成器已把 main() 收进 isDirectRun，导入不会执行生成），用样本矩阵打。
 *
 * 不写文件、不跑生成器、不碰网络。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const GEN = path.join(ROOT, 'scripts', 'gen-config-example.mjs');
const GATE = path.join(__dirname, 'check-config-template.mjs');
const EXAMPLE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'config.example.json');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); }
    else { fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

/** 从源码里抠出 `const NAME = <literal>`（用于校验生成器与门禁的实例键/允许集口径）。 */
function extractObjectLiteral(src, name) {
    const at = src.indexOf('const ' + name + ' = {');
    if (at < 0) return null;
    const start = src.indexOf('{', at);
    let depth = 0;
    for (let i = start; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = src.slice(start, i + 1).replace(/\/\/[^\n]*/g, '');
                try { return new Function('return (' + body + ');')(); } catch (e) { return null; }
            }
        }
    }
    return null;
}
function extractStringSet(src, name) {
    const m = src.match(new RegExp('const ' + name + ' = new Set\\(\\[([^\\]]*)\\]\\)'));
    if (!m) return null;
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

(async () => {
    console.log('== 模板生成器 URL 白名单 / 实例值中性化 ==');

    let G = null;
    try {
        G = await import(pathToFileURL(GEN).href);
        ok('生成器纯函数可导入（import 不执行 main）',
            typeof G.hostAllowed === 'function' && typeof G.isHttpUrl === 'function'
            && typeof G.scrubInstanceUrls === 'function' && typeof G.URL_PLACEHOLDER === 'string',
            'exports=' + Object.keys(G).join(','));
    } catch (e) {
        ok('生成器纯函数可导入', false, String(e && e.message || e));
    }
    if (!G) {
        console.log('\nFAIL ' + pass + '/' + (pass + fail));
        process.exit(1);
        return;
    }

    const genSrc = fs.readFileSync(GEN, 'utf8');

    // ── ① isHttpUrl：只认 http(s)，不认 ws/wss / 普通文本 ─────────────────
    {
        const yes = ['http://127.0.0.1/x', 'https://api.example.com/v1', 'HTTPS://EXAMPLE.COM/V1', ' http://a'.trim()];
        const no = ['ws://127.0.0.1:1000/v1/ws/vad', 'wss://vop.baidu.com/realtime_asr', 'ftp://x/y', 'not a url', '', null, 42];
        const missed = yes.filter((v) => G.isHttpUrl(v) !== true);
        const over = no.filter((v) => G.isHttpUrl(v) !== false);
        ok('isHttpUrl 识别 http(s)（含大写协议）', missed.length === 0, missed.join(',') || '全中');
        ok('isHttpUrl 不认 ws/wss/ftp/普通文本', over.length === 0, JSON.stringify(over));
        // 已知口径（跨边界：生成器不改）：ws/wss 不在脱敏范围。当前 config 的 ws 地址都是本机；
        // 若以后把对外隧道写成 ws，需要单独补一条规则。
        ok('ws/wss 不参与脱敏 —— 已知口径（当前 ws 仅 127.0.0.1）',
            G.isHttpUrl('ws://tunnel.example.invalid/ws') === false);
    }

    // ── ② host 白名单样本矩阵（含 P1 绕过样例）─────────────────────────────
    {
        const hostOf = (url) => {
            try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (e) { return null; }
        };
        const cases = [
            ['http://127.0.0.1:9883/tts', true, '本机 + 端口'],
            ['http://localhost:8000/x', true, 'localhost + 端口'],
            ['http://[::1]:9000/a', true, 'IPv6 回环（方括号）'],
            ['https://api.example.com:8443/v1', true, 'example.com 子域 + 端口'],
            ['https://EXAMPLE.COM/v1', true, '大写 host（归一化后命中）'],
            ['https://sub.example.org/x', true, 'example.org 子域'],
            ['https://example.net/x', true, 'example.net'],
            ['https://example.com.evil.com/v1', false, 'P1 绕过：example.com.evil.com'],
            ['https://notexample.com/v1', false, 'notexample.com（无点边界）'],
            ['https://127.0.0.1.evil.com/x', false, 'IP 前缀嫁接'],
            ['https://api.example.com@evil.com/v1', false, 'userinfo 混淆（真实 host=evil.com）'],
            ['https://evil.com/?next=https://example.com', false, 'query 里带允许域名不改变 host'],
            ['http://192.168.1.10:8000/x', false, '内网 IP（模板要中性化）'],
            ['https://example.com./x', false, '尾点 host（严格集不认，宁严勿宽）'],
            ['https://example.com.evil.com.example.com/x', true, '真·example.com 子域（host 以 .example.com 结尾）'],
        ];
        for (const [url, allowed, label] of cases) {
            const host = hostOf(url);
            const got = G.hostAllowed(host);
            ok(`白名单：${label}`, got === allowed, `host=${host} got=${got} 期望=${allowed}`);
        }

        // P1 防回归：白名单不能用 includes 判 —— `example.com.evil.com` 会被绕过
        ok('hostAllowed 不是 includes 判白名单（防 P1 绕过回归）',
            !/hostAllowed[\s\S]{0,300}\.includes\(\s*['"]example/.test(genSrc)
            && /\(\^\|\\\.\)example\\\.\(com\|org\|net\)\$/.test(genSrc),
            '使用 (^|\\.)example\\.(com|org|net)$ 锚定');
        ok('占位地址本身在白名单内（自查不会二次替换）',
            G.hostAllowed(hostOf(G.URL_PLACEHOLDER)) === true, G.URL_PLACEHOLDER);
    }

    // ── ③ scrubInstanceUrls：只替换不允许的 http(s)，与键名无关 ────────────
    {
        const sample = {
            api_gateway: { base_url: 'http://ominifn.natapp1.cc/api/v1' },
            tts: { url: 'http://127.0.0.1:9883/tts' },
            asr: { vad_url: 'ws://127.0.0.1:1000/v1/ws/vad', asr_url: 'http://127.0.0.1:1000/v1/upload_audio' },
            game: { Minecraft: { server_url: 'http://localhost:8080' } },
            cloud: { baidu_asr: { url: 'wss://vop.baidu.com/realtime_asr' } },
            // P2-11：键名不像 URL 的值也必须扫（proxy/callback 是漏网高发区）
            proxy: 'http://ominifn.natapp1.cc/api',
            callback: { notify: 'https://api.internal-corp.cn/hook' },
            plain_text: '就是一句话，不是 URL',
            nested: [{ api_url: 'https://example.com.evil.com/v1' }],
        };
        const out = G.scrubInstanceUrls(sample);
        ok('个人隧道 base_url 被替换成示例地址', out.api_gateway.base_url === G.URL_PLACEHOLDER,
            out.api_gateway.base_url);
        ok('本机 http URL 原样保留', out.tts.url === 'http://127.0.0.1:9883/tts'
            && out.asr.asr_url === 'http://127.0.0.1:1000/v1/upload_audio');
        ok('localhost 原样保留', out.game.Minecraft.server_url === 'http://localhost:8080');
        ok('P2-11：proxy 键的隧道 URL 也被替换（不再看键名）',
            out.proxy === G.URL_PLACEHOLDER, out.proxy);
        ok('P2-11：嵌套 callback.notify 的私有域名也被替换',
            out.callback.notify === G.URL_PLACEHOLDER, out.callback.notify);
        ok('数组里的 URL 同样被检查（example.com.evil.com → 占位）',
            out.nested[0].api_url === G.URL_PLACEHOLDER, out.nested[0].api_url);
        ok('非 URL 普通文本不被改写', out.plain_text === '就是一句话，不是 URL');
        ok('ws 地址不在范围（已知口径；当前仅本机）',
            out.asr.vad_url === 'ws://127.0.0.1:1000/v1/ws/vad'
            && out.cloud.baidu_asr.url === 'wss://vop.baidu.com/realtime_asr');
    }

    // ── ④ 实例键中性化：生成器与门禁同一份清单、且模板已是中性值 ───────────
    {
        const genDefaults = extractObjectLiteral(genSrc, 'INSTANCE_DEFAULTS');
        const gateSrc = fs.readFileSync(GATE, 'utf8');
        const gateDefaults = extractObjectLiteral(gateSrc, 'INSTANCE_DEFAULTS');
        ok('生成器 INSTANCE_DEFAULTS 可解析', !!genDefaults, JSON.stringify(genDefaults || null));
        ok('门禁 INSTANCE_DEFAULTS 与生成器完全一致',
            !!genDefaults && !!gateDefaults
            && JSON.stringify(Object.entries(genDefaults).sort()) === JSON.stringify(Object.entries(gateDefaults).sort()),
            JSON.stringify(Object.keys(gateDefaults || {})));

        const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
        const getPath = (obj, dotted) => dotted.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj);
        const bad = Object.entries(genDefaults || {}).filter(([p, want]) => {
            const got = getPath(example, p);
            return JSON.stringify(got) !== JSON.stringify(want);
        });
        ok('config.example.json 的实例键都是中性默认（不是本机快照）', bad.length === 0,
            bad.map(([p]) => p).join(',') || `${Object.keys(genDefaults || {}).length} 个键全中性`);

        // 合成对象验证 applyInstanceDefaults 的实际效果（生成器未导出它，用同一份清单模拟）
        const obj = {
            ui: {
                pet_window: { x: 512, y: 733, width: 420, height: 760 },
                click_through_default: true,
                screen_extend: { extend: true, left: true, right: false },
            },
            voice: { duplex: { backchannel_gate: true } },
        };
        for (const [dotted, val] of Object.entries(genDefaults || {})) {
            const parts = dotted.split('.');
            let cur = obj;
            for (let i = 0; i < parts.length - 1; i += 1) {
                if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
                cur = cur[parts[i]];
            }
            cur[parts[parts.length - 1]] = val;
        }
        const stillBad = Object.entries(genDefaults || {}).filter(([p, want]) => {
            const got = getPath(obj, p);
            return JSON.stringify(got) !== JSON.stringify(want);
        });
        ok('实例键压回中性默认后逐键一致', stillBad.length === 0, stillBad.map(([p]) => p).join(',') || '全中性');
        ok('未列入实例键的尺寸/位置列保留（width/height）',
            obj.ui.pet_window.width === 420 && obj.ui.pet_window.height === 760);
    }

    // ── ⑤ 允许集精确性 + 门禁侧同口径（避免生成器放过、门禁拦下）───────────
    {
        const genSet = extractStringSet(genSrc, 'ALLOWED_URL_HOSTS');
        const gateSet = extractStringSet(fs.readFileSync(GATE, 'utf8'), 'ALLOWED_URL_HOSTS');
        const must = ['example.com', '127.0.0.1', 'localhost', '::1', '0.0.0.0'];
        ok('生成器允许集包含本机/示例地址', !!genSet && must.every((h) => genSet.has(h)),
            genSet ? [...genSet].join(',') : '解析失败');
        ok('生成器允许集没有多余的生产域名', !!genSet && [...genSet].every((h) => must.includes(h)),
            genSet ? [...genSet].join(',') : '解析失败');
        ok('门禁允许集与生成器完全一致',
            !!genSet && !!gateSet
            && JSON.stringify([...genSet].sort()) === JSON.stringify([...gateSet].sort()),
            gateSet ? [...gateSet].join(',') : '解析失败');
        // 门禁直接 import 生成器的 scrub（P2-11 收口），不再维护第二份实现
        ok('门禁复用生成器的 scrubInstanceUrls（没有第二份实现）',
            /from '\.\.\/scripts\/gen-config-example\.mjs'/.test(fs.readFileSync(GATE, 'utf8'))
            && /scrubInstanceUrls as scrubInstanceUrlsForTest/.test(fs.readFileSync(GATE, 'utf8')));
    }

    console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('测试自身异常：', e && e.stack || e);
    process.exit(1);
});
