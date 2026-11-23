// test-voice-style.cjs —— 语义语气层（voice-style.js）纯逻辑单测
// 跑法：node _probe/test-voice-style.cjs
//
// 钉住四件事（全是「多出来的一层不能造反」的边界）：
//   ① 14 类 voice 的增益都夹在 [0.9,1.1]；
//   ② 叠加后比值仍夹在 [0.9,1.1]（极端 base 也不许放大/抹平情绪韵律）；
//   ③ TTL 过期 / 句子不匹配 / 一句一用 → 不再生效；
//   ④ 未启用 / 置信度不足 / 服务失败 → 输出与 base **逐字段完全相同**。
const path = require('path');

const APP = path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d');
const VS = require(path.join(APP, 'js', 'core', 'voice-style.js'));

const BASE = { rate: 1, pitch: 1, energy: 1 };
const RATIO_MIN = 0.9 - 1e-12;
const RATIO_MAX = 1.1 + 1e-12;

let pass = 0;
let fail = 0;
function ok(cond, label) {
    if (cond) { pass += 1; console.log('PASS  ' + label); }
    else { fail += 1; console.log('FAIL  ' + label); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const inRange = (x) => Number.isFinite(x) && x >= RATIO_MIN && x <= RATIO_MAX;

// ① 14 类 voice：增益表本身 + 叠加结果都必须在 ±10% 内
{
    VS.configure({ enabled: true, ttl_ms: 3000 });
    const voices = Object.keys(VS.VOICE_TO_PROSODY);
    ok(voices.length === 14, 'voice 表有 14 类（实际 ' + voices.length + '）');
    for (const voice of voices) {
        const g = VS.VOICE_TO_PROSODY[voice];
        const gainsOk = ['rate', 'pitch', 'energy'].every((f) => inRange(VS.clampGain(g[f])));
        const out = VS.applyGain(BASE, g);
        const outOk = ['rate', 'pitch', 'energy'].every((f) => inRange(out[f]));
        ok(gainsOk && outOk, 'voice ' + voice + ' 的增益与叠加结果都在 [0.9,1.1]');
    }
    // 表里超出边界的两个（urgent.rate=1.12 / angry.energy=1.12）必须被夹回来
    ok(VS.clampGain(1.12) === 1.1 && VS.clampGain(0.85) === 0.9,
        '越界增益被夹到 1.1 / 0.9（urgent.rate、angry.energy）');
}

// ② 极端 base：乘的是「比值」，不是绝对值——不能把情绪链路已有的起伏抹平
{
    const base = { rate: 0.3, pitch: 2.4, energy: 0.05, volume: 7 };
    const out = VS.applyGain(base, VS.VOICE_TO_PROSODY.urgent);
    const ratiosOk = ['rate', 'pitch', 'energy'].every((f) => out[f] / base[f] >= RATIO_MIN && out[f] / base[f] <= RATIO_MAX);
    ok(ratiosOk, '极端 base（0.3/2.4/0.05）叠加后比值仍在 [0.9,1.1]');
    ok(out.volume === 7, 'base 里不参与增益的字段（volume）原样保留');
    ok(base.rate === 0.3 && base.pitch === 2.4, '不修改调用方传入的 base 对象');
    // base 缺字段时不许凭空造
    const partial = VS.applyGain({ rate: 1 }, VS.VOICE_TO_PROSODY.joyful);
    ok(!('pitch' in partial) && !('energy' in partial), 'base 没有的旋钮不会被凭空补出来');
}

// ③ TTL：过期就不再生效
{
    VS.configure({ enabled: true, ttl_ms: 1000 });
    VS.reset({ stats: true });
    const text = '今天天气真好呀';
    VS.ingestSemantic({ ok: true, voice: 'joyful', voiceConfidence: 0.9 }, { text, nowMs: 1000 });
    const fresh = VS.applyToProsody(BASE, 1500, text);
    ok(fresh.rate > 1 && inRange(fresh.rate), 'TTL 内（500ms）生效');

    VS.ingestSemantic({ ok: true, voice: 'joyful', voiceConfidence: 0.9 }, { text, nowMs: 1000 });
    const stale = VS.applyToProsody(BASE, 2001, text);
    ok(same(stale, BASE), 'TTL 过期（1001ms > 1000ms）输出与 base 完全相同');
    ok(VS.stats().counts.expired === 1, '过期计数 +1');
    ok(VS.stats(2001).entry === null && VS.stats(2001).pending === 0, '过期后缓存被清掉（不会复活）');
}

// ④ 一句一用 + 句子锚定：不粘到后面几句
{
    VS.configure({ enabled: true, ttl_ms: 5000 });
    VS.reset({ stats: true });
    const now = 5000;
    VS.ingestSemantic({ ok: true, voice: 'sad', voiceConfidence: 0.8 }, { text: '第一句。', nowMs: now });
    const other = VS.applyToProsody(BASE, now + 10, '第二句。');
    ok(same(other, BASE), '句子不匹配 → 不生效（风格不会跨句粘连）');
    const mine = VS.applyToProsody(BASE, now + 20, '第一句。');
    ok(mine.rate < 1 && mine.energy < 1 && inRange(mine.rate), '同一句 → 生效（rate/energy 收）');
    const again = VS.applyToProsody(BASE, now + 30, '第一句。');
    ok(same(again, BASE), 'one-shot：同一句第二次不再生效');
}

// ⑤ 置信度：不足就整句不用；voiceConfidence 缺失才回落到 confidence
{
    VS.configure({ enabled: true, ttl_ms: 5000 });
    VS.reset({ stats: true });
    const text = '哼，不理你了。';
    ok(VS.ingestSemantic({ ok: true, voice: 'angry', voiceConfidence: 0.49 }, { text, nowMs: 1 }) === false,
        '置信度 0.49 < 0.5 → 拒绝入库');
    ok(same(VS.applyToProsody(BASE, 2, text), BASE), '置信度不足 → 输出与 base 完全相同');

    ok(VS.ingestSemantic({ ok: true, voice: 'angry', confidence: 0.9 }, { text, nowMs: 3 }) === true,
        'voiceConfidence 缺失时回落整体 confidence，0.9 可入库');
    const out = VS.applyToProsody(BASE, 4, text);
    ok(out.energy > 1 && inRange(out.energy), '回落置信度后正常生效');

    // 低置信度只清自己那一句：上一句的残留不能顶替它
    VS.reset({ stats: true });
    VS.ingestSemantic({ ok: true, voice: 'joyful', voiceConfidence: 0.9 }, { text: '上一句', nowMs: 10 });
    VS.ingestSemantic({ ok: true, voice: 'sad', voiceConfidence: 0.2 }, { text: '这一句', nowMs: 11 });
    ok(same(VS.applyToProsody(BASE, 12, '这一句'), BASE), '低置信度 → 这一句没有风格（不被上一句顶替）');
}

// ⑥ 多句各吃各的（这正是不能用「单槽」的原因：整段回复会一次性入队多句）
{
    VS.configure({ enabled: true, ttl_ms: 5000 });
    VS.reset({ stats: true });
    VS.ingestSemantic({ ok: true, voice: 'joyful', voiceConfidence: 0.9 }, { text: 'A句。', nowMs: 100 });
    VS.ingestSemantic({ ok: true, voice: 'sad', voiceConfidence: 0.9 }, { text: 'B句。', nowMs: 101 });
    const a = VS.applyToProsody(BASE, 102, 'A句。');
    const b = VS.applyToProsody(BASE, 103, 'B句。');
    ok(a.rate > 1, 'A句 用 joyful（rate 扬）');
    ok(b.rate < 1, 'B句 用 sad（rate 收）');
    ok(same(VS.applyToProsody(BASE, 104, 'A句。'), BASE), 'A句 已 one-shot，取第二次不再生效');
    ok(VS.stats(105).pending === 0, '两句都被吃掉，表清空');
}

// ⑦ 重复 ingest 是覆盖而不是相乘（同一句不会被叠两次）
{
    VS.configure({ enabled: true, ttl_ms: 5000 });
    VS.reset({ stats: true });
    const text = '重复。';
    VS.ingestSemantic({ ok: true, voice: 'joyful', voiceConfidence: 0.9 }, { text, nowMs: 1 });
    VS.ingestSemantic({ ok: true, voice: 'joyful', voiceConfidence: 0.9 }, { text, nowMs: 2 });
    const out = VS.applyToProsody(BASE, 3, text);
    ok(Math.abs(out.rate - 1.06) < 1e-12, '两次 ingest 只乘一次（rate=1.06，不是 1.06²）');
}

// ⑧ stats 可观测
{
    const s = VS.stats();
    ok(s && typeof s.enabled === 'boolean' && s.counts && typeof s.counts.applied === 'number' && typeof s.pending === 'number',
        'stats() 返回开关/待用条数/计数');
}

// ⑨ 未启用 / 服务失败 / 未知风格 → 一律与 base 逐字段相同
{
    const text = '随便一句。';
    VS.configure({ enabled: false });
    VS.reset({ stats: true });
    ok(VS.ingestSemantic({ ok: true, voice: 'joyful', voiceConfidence: 0.99 }, { text }) === false,
        '未启用 → ingest 直接拒绝（不浪费状态）');
    ok(same(VS.applyToProsody(BASE, Date.now(), text), BASE), '未启用 → 输出与 base 完全相同');

    VS.configure({ enabled: true, ttl_ms: 5000 });
    VS.reset({ stats: true });
    ok(VS.ingestSemantic({ ok: false, error: 'timeout', voice: 'joyful' }, { text, nowMs: 1 }) === false,
        '服务失败（ok:false）→ 拒绝入库');
    ok(same(VS.applyToProsody(BASE, 2, text), BASE), '服务失败 → 输出与 base 完全相同');

    ok(VS.ingestSemantic({ ok: true, voice: '不存在的风格', voiceConfidence: 0.99 }, { text, nowMs: 3 }) === false,
        '未知风格 → 不猜');
    ok(same(VS.applyToProsody(BASE, 4, text), BASE), '未知风格 → 输出与 base 完全相同');
}

console.log(`\n汇总: PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
