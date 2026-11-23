#!/usr/bin/env node
/**
 * _probe/test-latency-budget.cjs — 延迟预算（E4，2026-11-22）
 *
 * 要防的回归：
 *   ① 没有基线也在判（样本不足时乱告警）→ 第一次就红，狼来了
 *   ② 永远不红（超 20% 连着涨也不报）
 *   ③ 累计值告警（本该「现在慢了」变成「历史上慢过」）
 *   ④ 状态文件写进真实仓库（测试污染）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-latbudget-'));
const telDir = path.join(tmpRoot, 'runtime');
fs.mkdirSync(telDir, { recursive: true });
process.env.PET_TELEMETRY_DIR = telDir;
process.env.PET_LATENCY_STATE = path.join(tmpRoot, 'state.json');

const LB = require(path.join(__dirname, '..', '_incoming', 'my-neuro', 'live-2d', 'js', 'core', 'latency-budget.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function writeTelemetry(turnMs, toolMs) {
    const lines = [];
    // 真实对话回合一定带 LLM 阶段（2026-11-22：latency-budget 现在只认这种样本，
    // 探针回合/续讲早退不进基线 —— 否则 3ms 探针会把基线拉到 3ms，正常 2.6s 判假红）
    for (const ms of turnMs) lines.push(JSON.stringify({ ts: Date.now(), cat: 'turn', type: 'turn.end', title: 't', metrics: { total_ms: ms, phase_llm_ms: Math.max(1, ms - 10) } }));
    for (const ms of toolMs) lines.push(JSON.stringify({ ts: Date.now(), cat: 'tool', type: 'tool.end', title: 't', metrics: { duration_ms: ms } }));
    fs.writeFileSync(path.join(telDir, 'telemetry.jsonl'), lines.join('\n') + '\n', 'utf8');
}

try {
    ok('状态文件在临时目录', LB.STATE.startsWith(tmpRoot), LB.STATE);

    // ① 样本不足不判
    writeTelemetry([1000], [100]);
    const e1 = LB.evaluate();
    const turn1 = e1.items.find((i) => i.key === 'turn_p50_ms');
    ok('首测（样本 <3）不判 warn', turn1.status === 'ok' && turn1.baseline === null, 'status=' + turn1.status);
    ok('首测记录数值', turn1.value === 1000, 'value=' + turn1.value);

    // ② 建立基线（4 次 1000ms）
    LB.evaluate(); LB.evaluate(); LB.evaluate();
    const e5 = LB.evaluate();
    const turn5 = e5.items.find((i) => i.key === 'turn_p50_ms');
    ok('样本够了之后有基线', turn5.baseline != null && turn5.status === 'ok', 'baseline=' + turn5.baseline);

    // ③ 超 20% → warn；连 3 次 → bad
    writeTelemetry([2000], [100]);
    const w1 = LB.evaluate().items.find((i) => i.key === 'turn_p50_ms');
    ok('超基线 20% → warn', w1.status === 'warn' && w1.overPct > 20, 'over=' + w1.overPct + '%');
    LB.evaluate();
    const w3 = LB.evaluate().items.find((i) => i.key === 'turn_p50_ms');
    ok('连续 3 次 → bad', w3.status === 'bad' && w3.streak >= 3, 'streak=' + w3.streak);

    // ④ 回落清零
    writeTelemetry([1000], [100]);
    const back = LB.evaluate().items.find((i) => i.key === 'turn_p50_ms');
    ok('回落 → streak 清零、status ok', back.status === 'ok' && back.streak === 0, 'status=' + back.status + ' streak=' + back.streak);

    // ⑤ 工具 p90 独立统计
    writeTelemetry([1000], [100, 120, 140, 900]);
    const m = LB.measure();
    ok('measure 出 turn p50', m.turn_p50_ms === 1000, String(m.turn_p50_ms));
    ok('measure 出 tool p90', m.tool_p90_ms >= 140, String(m.tool_p90_ms));

    // ⑤b 重工具不污染轻工具 p90（v2，2026-11-23：doctor 唯一红的根因）
    {
        const lines = [];
        for (let i = 0; i < 5; i += 1) lines.push({ ts: Date.now(), cat: 'tool', type: 'tool.end', metrics: { duration_ms: 100 + i * 10, tool: 'note' } });
        for (let i = 0; i < 4; i += 1) lines.push({ ts: Date.now(), cat: 'tool', type: 'tool.end', metrics: { duration_ms: 9000 + i * 1000, tool: 'see' } });
        fs.writeFileSync(path.join(telDir, 'telemetry.jsonl'), lines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        const mm = LB.measure();
        ok('轻工具 p90 不被 see(9–12s) 污染', mm.tool_p90_ms <= 140, 'p90=' + mm.tool_p90_ms);
        ok('重工具 p50 单独统计', mm.tool_heavy_p50_ms >= 9000, 'heavy=' + mm.tool_heavy_p50_ms);
        ok('重工具条数可读', mm.tool_heavy_count === 4, String(mm.tool_heavy_count));
    }

    // ⑤c 7 天外样本不参与（v2：避免久远流量把 p90 钉死）
    {
        const old = Date.now() - 30 * 24 * 3600 * 1000;
        const lines = [];
        for (let i = 0; i < 40; i += 1) lines.push({ ts: old, cat: 'tool', type: 'tool.end', metrics: { duration_ms: 9000, tool: 'game_control' } });
        for (let i = 0; i < 30; i += 1) lines.push({ ts: Date.now(), cat: 'tool', type: 'tool.end', metrics: { duration_ms: 200, tool: 'note' } });
        fs.writeFileSync(path.join(telDir, 'telemetry.jsonl'), lines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        const mm = LB.measure();
        ok('30 天前样本被 7 天窗口排除', mm.tool_p90_ms === 200 && mm.tool_heavy_p50_ms === null, 'p90=' + mm.tool_p90_ms + ' heavy=' + mm.tool_heavy_p50_ms);
    }

    // ⑤d v1 → v2 状态迁移：口径变了，tool 样本清空重建；turn 样本保留
    {
        fs.writeFileSync(LB.STATE, JSON.stringify({
            version: 1,
            items: {
                turn_p50_ms: { samples: [1000, 1000, 1000], streak: 0, status: 'ok' },
                tool_p90_ms: { samples: [5004, 5004, 5004], streak: 9, status: 'bad' },
            },
        }), 'utf8');
        writeTelemetry([1000], [100]);
        const ee = LB.evaluate();
        const tt = ee.items.find((i) => i.key === 'turn_p50_ms');
        const tp = ee.items.find((i) => i.key === 'tool_p90_ms');
        ok('v1→v2 保留 turn 基线', tt.baseline != null, 'baseline=' + tt.baseline);
        ok('v1→v2 清空并重建 tool 样本', tp.streak === 0 && tp.status === 'ok', 'streak=' + tp.streak + ' status=' + tp.status);
        const doc2 = JSON.parse(fs.readFileSync(LB.STATE, 'utf8'));
        ok('状态版本升到 2', doc2.version === 2, String(doc2.version));
    }

    // ⑥ 探针/无 LLM 阶段回合不进基线（2026-11-22 医生假红根因）
    {
        fs.writeFileSync(path.join(telDir, 'telemetry.jsonl'), [
            { cat: 'turn', type: 'turn.end', source: 'probe', metrics: { total_ms: 3, phase_input_ms: 1 } },
            { cat: 'turn', type: 'turn.end', source: 'probe', metrics: { total_ms: 4, phase_input_ms: 1 } },
            { cat: 'turn', type: 'turn.end', metrics: { total_ms: 30 } },   // 没有 llm 阶段＝不是一轮对话
            { cat: 'turn', type: 'turn.end', metrics: { total_ms: 2600, phase_llm_ms: 2500 } },
        ].map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
        const mm = LB.measure();
        ok('探针/无 LLM 阶段回合不进样本（防假红）', mm.turn_p50_ms === 2600, String(mm.turn_p50_ms));
    }

    // ⑥ 无数据不崩
    fs.writeFileSync(path.join(telDir, 'telemetry.jsonl'), '', 'utf8');
    const empty = LB.measure();
    ok('空 telemetry 不崩且为 null', empty.turn_p50_ms === null && empty.tool_p90_ms === null);

    // ⑦ 状态文件持久化（跨进程可读）
    const doc = JSON.parse(fs.readFileSync(LB.STATE, 'utf8'));
    ok('状态文件有 samples 与 status', Array.isArray(doc.items.turn_p50_ms.samples) && typeof doc.items.turn_p50_ms.status === 'string');
} finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
