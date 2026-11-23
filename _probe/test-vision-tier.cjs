'use strict';
/**
 * test-vision-tier.cjs —— 视觉分档路由单测（纯 Node，不启动 Electron）
 *
 * 覆盖：
 *   1) 阈值边界 0 / 2499 / 2500 / 4499 / 4500 / 8000
 *   2) freeVram=null / undefined / 非数字 → high；tiers.enabled=false → high
 *   3) 缺省配置（无 cfg）模型名与旧行为一致（qwen3-vl:8b）
 *   4) 回退链：选中档失败 → 8B（标记 fallback=true）；全失败 → disabled + reason
 *   5) 低档 prompt 追加「只回一句话」，可由 lowPromptHint=false 关闭
 *   6) nvidia-smi 解析 / 5s 超时失败返回 null / 30s 缓存
 *   7) ollama list 真实模型存在性：high 必须存在；mid/low 缺失只 skip 打印（不判红）
 *
 * 运行：node _probe/test-vision-tier.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const MOD = path.join(APP, 'js', 'core', 'vision-tier.js');
const tier = require(MOD);

let pass = 0;
let fail = 0;
let skipped = 0;

function ok(name, fn) {
    try {
        fn();
        pass += 1;
        console.log('ok   - ' + name);
    } catch (error) {
        fail += 1;
        console.log('FAIL - ' + name + ' :: ' + (error && error.message));
    }
}

async function okAsync(name, fn) {
    try {
        await fn();
        pass += 1;
        console.log('ok   - ' + name);
    } catch (error) {
        fail += 1;
        console.log('FAIL - ' + name + ' :: ' + (error && error.message));
    }
}

function skip(name, why) {
    skipped += 1;
    console.log('skip - ' + name + ' :: ' + why);
}

const TIERS = {
    enabled: true,
    high: 'qwen3-vl:8b',
    mid: 'qwen3-vl:4b',
    low: 'qwen3-vl:2b',
};

async function main() {
    console.log('== 1. 阈值边界 ==');
    const cases = [
        [0, 'low'],
        [1, 'low'],
        [2499, 'low'],
        [2500, 'mid'],
        [3000, 'mid'],
        [4499, 'mid'],
        [4500, 'high'],
        [8000, 'high'],
    ];
    for (const [mb, expected] of cases) {
        ok(`freeVramMb=${mb} -> ${expected}`, () => {
            assert.strictEqual(tier.pickTier({ freeVramMb: mb, cfg: TIERS }), expected);
        });
    }

    console.log('== 2. 读不到显存 / 分档关闭 ==');
    for (const v of [null, undefined, '', 'n/a', NaN]) {
        ok(`freeVramMb=${String(v)} -> high`, () => {
            assert.strictEqual(tier.pickTier({ freeVramMb: v, cfg: TIERS }), 'high');
        });
    }
    ok('tiers.enabled=false 时 0MB 也走 high（旧行为）', () => {
        assert.strictEqual(tier.pickTier({ freeVramMb: 0, cfg: { ...TIERS, enabled: false } }), 'high');
    });
    ok('阈值可配：8000/3000 时 7000 -> mid、2999 -> low', () => {
        const cfg = { ...TIERS, highMinFreeVramMb: 8000, midMinFreeVramMb: 3000 };
        assert.strictEqual(tier.pickTier({ freeVramMb: 7000, cfg }), 'mid');
        assert.strictEqual(tier.pickTier({ freeVramMb: 2999, cfg }), 'low');
    });
    ok('midMin 高于 highMin 时被收敛（mid 仍可达）', () => {
        const cfg = { ...TIERS, highMinFreeVramMb: 3000, midMinFreeVramMb: 9000 };
        assert.strictEqual(tier.pickTier({ freeVramMb: 2999, cfg }), 'low');
        assert.strictEqual(tier.pickTier({ freeVramMb: 3000, cfg }), 'high');
    });

    console.log('== 3. 配置缺省与旧行为一致 ==');
    ok('无 cfg：pickTier -> high', () => {
        assert.strictEqual(tier.pickTier({ freeVramMb: 0 }), 'high');
    });
    ok('无 cfg：high 模型名 = qwen3-vl:8b', () => {
        assert.strictEqual(tier.modelForTier('high'), 'qwen3-vl:8b');
    });
    ok('mid/low 未配：逐级回落到 high（不会没有模型）', () => {
        const cfg = { enabled: true, high: 'qwen3-vl:8b' };
        assert.strictEqual(tier.modelForTier('mid', cfg), 'qwen3-vl:8b');
        assert.strictEqual(tier.modelForTier('low', cfg), 'qwen3-vl:8b');
    });
    ok('low 未配但 mid 有：low -> mid', () => {
        const cfg = { ...TIERS, low: '' };
        assert.strictEqual(tier.modelForTier('low', cfg), 'qwen3-vl:4b');
    });

    console.log('== 4. 回退链 ==');
    await okAsync('mid 失败 -> 8B 成功，ok=true / model=8B / fallback=true', async () => {
        const calls = [];
        const out = await tier.summarize({
            messages: [{ role: 'user', content: 'hi' }],
            cfg: TIERS,
            freeVramMb: 3000,
            log: () => {},
            call: async ({ model }) => {
                calls.push(model);
                if (model === 'qwen3-vl:4b') throw new Error('模拟 4B 崩溃');
                return '八档摘要';
            },
        });
        assert.strictEqual(out.ok, true);
        assert.strictEqual(out.tier, 'mid');
        assert.strictEqual(out.chosenModel, 'qwen3-vl:4b');
        assert.strictEqual(out.model, 'qwen3-vl:8b');
        assert.strictEqual(out.fallback, true);
        assert.strictEqual(out.text, '八档摘要');
        assert.deepStrictEqual(calls, ['qwen3-vl:4b', 'qwen3-vl:8b']);
        assert.strictEqual(out.attempts.length, 2);
        assert.strictEqual(out.attempts[0].ok, false);
        assert.strictEqual(out.attempts[1].ok, true);
    });

    await okAsync('high 失败 -> 无重复档位，直接 disabled + reason', async () => {
        const out = await tier.summarize({
            messages: [],
            cfg: TIERS,
            freeVramMb: 6000,
            log: () => {},
            call: async () => { throw new Error('Ollama 没开'); },
        });
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.disabled, true);
        assert.strictEqual(out.chosenModel, 'qwen3-vl:8b');
        assert.strictEqual(out.attempts.length, 1);
        assert.ok(String(out.reason).includes('Ollama 没开'), 'reason 应包含具体失败原因');
    });

    await okAsync('low 成功：tier=low / model=2B / 收到低档提示', async () => {
        let seen = null;
        const out = await tier.summarize({
            messages: [
                { role: 'system', content: '系统规则' },
                { role: 'user', content: '看图' },
            ],
            cfg: TIERS,
            freeVramMb: 1000,
            log: () => {},
            call: async ({ model, messages }) => {
                seen = { model, messages };
                return '低档粗摘要';
            },
        });
        assert.strictEqual(out.ok, true);
        assert.strictEqual(out.tier, 'low');
        assert.strictEqual(out.model, 'qwen3-vl:2b');
        assert.strictEqual(out.fallback, false);
        assert.strictEqual(seen.model, 'qwen3-vl:2b');
        assert.ok(String(seen.messages[0].content).includes('只回一句话'), '低档应追加一句约束');
        assert.ok(String(seen.messages[0].content).startsWith('系统规则'), '原 prompt 必须保留');
    });

    await okAsync('lowPromptHint=false 时不追加提示', async () => {
        let seen = '';
        await tier.summarize({
            messages: [{ role: 'system', content: '系统规则' }],
            cfg: { ...TIERS, lowPromptHint: false },
            freeVramMb: 1000,
            log: () => {},
            call: async ({ messages }) => { seen = messages[0].content; return 'x'; },
        });
        assert.strictEqual(seen, '系统规则');
    });

    await okAsync('call 返回 {content} 也能解析', async () => {
        const out = await tier.summarize({
            messages: [],
            cfg: TIERS,
            freeVramMb: 6000,
            log: () => {},
            call: async () => ({ content: '  带空白的摘要  ' }),
        });
        assert.strictEqual(out.ok, true);
        assert.strictEqual(out.text, '带空白的摘要');
    });

    ok('stripThink：闭合的思考段只留正文', () => {
        assert.strictEqual(tier.stripThink('thinking\n推理过程\n</think>表格：四列，共三行'), '表格：四列，共三行');
        assert.strictEqual(tier.stripThink('  Plain 答案 '), 'Plain 答案');
    });
    ok('stripThink：未闭合的思考段 -> 空（按空回复走回退）', () => {
        assert.strictEqual(tier.stripThink('thinking\n被截断的推理……'), '');
    });
    ok('stripThink：英文句子以 thinking 开头不误判', () => {
        assert.strictEqual(tier.stripThink('thinking about the image, it is a table'),
            'thinking about the image, it is a table');
    });

    console.log('== 5. nvidia-smi 解析 / 缓存 / 失败返回 null ==');
    ok('parseFreeVram：数字行', () => {
        assert.strictEqual(tier.parseFreeVram('5123\n'), 5123);
        assert.strictEqual(tier.parseFreeVram('  4096  \r\n'), 4096);
        assert.strictEqual(tier.parseFreeVram('0\n'), 0);
    });
    ok('parseFreeVram：空/N/A -> null', () => {
        assert.strictEqual(tier.parseFreeVram(''), null);
        assert.strictEqual(tier.parseFreeVram('N/A\n'), null);
        assert.strictEqual(tier.parseFreeVram(null), null);
    });

    await okAsync('readFreeVramMb：解析成功并在 30s 内命中缓存', async () => {
        tier._resetVramCache();
        let calls = 0;
        const fake = (cmd, args, opts, cb) => {
            calls += 1;
            cb(null, ' 5123\n');
        };
        const v1 = await tier.readFreeVramMb({ execFileImpl: fake, now: () => 1000 });
        assert.strictEqual(v1, 5123);
        const v2 = await tier.readFreeVramMb({ execFileImpl: fake, now: () => 20000 });
        assert.strictEqual(v2, 5123);
        assert.strictEqual(calls, 1, '30s 内不应重复开子进程');
        const v3 = await tier.readFreeVramMb({ execFileImpl: fake, now: () => 31001 });
        assert.strictEqual(v3, 5123);
        assert.strictEqual(calls, 2, '超过 TTL 应重探');
    });

    await okAsync('readFreeVramMb：命令失败 -> null（不抛）', async () => {
        tier._resetVramCache();
        const v = await tier.readFreeVramMb({
            execFileImpl: (cmd, args, opts, cb) => cb(new Error('nvidia-smi not found'), ''),
            now: () => 1000,
            noCache: true,
        });
        assert.strictEqual(v, null);
    });

    await okAsync('readFreeVramMb：execFile 同步抛错 -> null', async () => {
        tier._resetVramCache();
        const v = await tier.readFreeVramMb({
            execFileImpl: () => { throw new Error('boom'); },
            now: () => 1000,
            noCache: true,
        });
        assert.strictEqual(v, null);
    });

    await okAsync('summarize：freeVramMb=null -> 直接用 high', async () => {
        let model = null;
        const out = await tier.summarize({
            messages: [],
            cfg: TIERS,
            freeVramMb: null,
            log: () => {},
            call: async ({ model: m }) => { model = m; return 'ok'; },
        });
        assert.strictEqual(out.tier, 'high');
        assert.strictEqual(model, 'qwen3-vl:8b');
    });

    console.log('== 6. 真实模型存在性（ollama list） ==');
    let listing = null;
    try {
        listing = execFileSync('ollama', ['list'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    } catch (error) {
        listing = null;
    }
    if (!listing) {
        skip('ollama list', '命令不可用或超时');
    } else {
        const names = listing.split(/\r?\n/).slice(1)
            .map((line) => line.trim().split(/\s+/)[0])
            .filter(Boolean);
        let cfgFile = null;
        try {
            cfgFile = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'));
        } catch (error) {
            cfgFile = null;
        }
        const cfgTiers = (cfgFile && cfgFile.vision && cfgFile.vision.tiers) || null;
        const high = (cfgTiers && cfgTiers.high) || tier.DEFAULTS.high;
        ok(`high 档模型存在：${high}`, () => {
            assert.ok(names.includes(high), `ollama list 里没有 ${high}；现有：${names.join(', ')}`);
        });
        if (!cfgTiers) {
            skip('mid/low 档', 'config.json 没有 vision.tiers');
        } else if (cfgTiers.enabled !== true) {
            skip('mid/low 档', 'vision.tiers.enabled != true（保持 8B 单档）');
        } else {
            for (const key of ['mid', 'low']) {
                const model = cfgTiers[key];
                if (!model) {
                    skip(`${key} 档`, '未配置模型名（回落到 high）');
                } else if (!names.includes(model)) {
                    skip(`${key} 档模型 ${model}`, '未拉取成功，运行时自动回落 high（不判红）');
                } else {
                    ok(`${key} 档模型存在：${model}`, () => { assert.ok(names.includes(model)); });
                }
            }
        }
    }

    console.log('');
    console.log(`== 结果：pass=${pass} fail=${fail} skip=${skipped} ==`);
    if (fail > 0) process.exit(1);
}

main().catch((error) => {
    console.error('测试自身崩溃：', error);
    process.exit(1);
});
