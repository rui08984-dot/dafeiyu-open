'use strict';
// latency-budget.js —— 延迟预算（E4，2026-11-22；v2 2026-11-23）
//
// 要解决的问题：项目里只有「语音首响」被量化过（500ms 目标），
// 轮次总时长 / 工具耗时 / 评测耗时**没有预算** —— 没有预算的指标不会被人持续盯着，
// 退化就只能靠用户抱怨才发现（这次拖动性能就是这么漏掉的，见审计文档 §6）。
//
// 四条预算（都是「最近样本的统计量」，不是单次抖动）：
//   turn_p50_ms  —— 近 50 轮轮次总时长 p50（她回一句话的端到端）
//   tool_p90_ms  —— 近 100 次**轻工具**调用耗时 p90（最慢那批轻工具）
//   tool_heavy_p50_ms —— 近 100 次**重工具**调用 p50（看屏/游戏这类天生慢的）
//   eval_total_ms—— 最近一次真机评测总耗时（门禁可用性）
//
// v2 修复（2026-11-23 定位，doctor 唯一红的根因）：
//   · v1 把「看屏 see 9–16s、game_control 6–16s」和「100–300ms 的轻工具」混在一个 p90 里；
//     实测最后 100 次成功调用里 52 次是重工具 → p90 恒落在 5–6s，指标失去分辨率。
//   · v2 先按工具名算自身 p50，p50 ≥ 3s（且样本 ≥3）判为「重工具」，从轻工具 p90 中剔除；
//     重工具单独报 p50。旧样本没有工具名 → 按轻工具处理（向后兼容）。
//   · 窗口只取最近 7 天（≥30 条才启用），避免 12 天前的久远流量把 p90 钉死。
//   · 状态 v1 → v2：tool_p90_ms 的旧样本因口径变了清空重建；turn 样本保留。
//
// 判定：
//   · 基线 = 该指标**最近 20 次测量的中位数**（自适应；样本 <3 时「数据不足」，不判）
//   · 当前值 > 基线 × TOL → warn（黄）；连续 3 次 warn → bad（红）
//   · 指标回落 → 清零 streak（不搞「历史累计」那套狼来了）
//
// 数据源：telemetry.jsonl（turn.end / tool.end）+ _probe/agent-eval/last-run.json。
// 状态落 pet-runtime/.state/latency-budget.json（原子写）。

const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', '..');
// live-2d → my-neuro → _incoming → 项目根（3 层）
const ROOT = path.join(APP, '..', '..', '..');
// 测试隔离：PET_LATENCY_STATE 可把状态文件指到临时目录（不设=原路径）
const STATE = process.env.PET_LATENCY_STATE
    ? path.resolve(process.env.PET_LATENCY_STATE)
    : path.join(ROOT, 'pet-runtime', '.state', 'latency-budget.json');
const TOL = 1.2;              // 超基线 20% 算 warn
const BAD_STREAK = 3;         // 连续 3 次 warn → bad
const KEEP = 20;              // 基线样本窗口
const FRESH_MS = 7 * 24 * 3600 * 1000;  // 工具样本的新鲜窗口（7 天）
const MIN_FRESH = 30;         // 新鲜样本 ≥30 条才启用窗口（否则退回最近 100 条）
const HEAVY_P50_MS = 3000;    // 自身 p50 ≥3s → 重工具（看屏/游戏/批量这类）
const HEAVY_MIN_N = 3;        // 至少 3 条才敢判定重工具
const STATE_VERSION = 2;      // v2：tool_p90 只算轻工具；tool_heavy_p50 独立
// 重工具天然抖（9s 与 16s 都正常）→ 放宽阈值，否则天天狼来了
const TOL_BY_KEY = { tool_heavy_p50_ms: 1.5 };

function _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function _writeJson(file, doc) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n', 'utf8');
        fs.renameSync(file + '.tmp', file);
        return true;
    } catch (e) { return false; }
}
function pct(arr, p) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))];
}
function median(arr) { return pct(arr, 50); }

/** 从 telemetry 抓原始样本。 */
function _samples() {
    const dir = process.env.PET_TELEMETRY_DIR
        ? path.resolve(process.env.PET_TELEMETRY_DIR)
        : path.join(APP, '.runtime');
    const file = path.join(dir, 'telemetry.jsonl');
    let lines = [];
    try {
        lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-6000)
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
    } catch (e) { return { turn: [], tool: [] }; }
    const turn = lines.filter((l) => l.cat === 'turn' && l.type === 'turn.end' && l.metrics && Number.isFinite(Number(l.metrics.total_ms)))
        // 2026-11-22 医生假红根因：telemetry 里混着 `source:"probe"` 的探针回合（2–4ms、
        // 只有 input 阶段），它们被当成真实对话样本，把基线 p50 拉到 3ms；之后正常回合
        // （2–3s）全部被判「+86600% 连续超预算」。真实对话一定有 LLM 阶段；
        // 续讲早退/被打断这类「没调模型的回合」也不该进「一轮对话耗时」的基线。
        .filter((l) => String(l.source || '') !== 'probe' && Number(l.metrics.phase_llm_ms) > 0)
        .slice(-50).map((l) => Number(l.metrics.total_ms));

    // 工具样本：带工具名与时间戳（v2 起 tool-executor 会写 metrics.tool；旧样本没有名字）
    let tool = lines.filter((l) => l.cat === 'tool' && l.type === 'tool.end' && l.metrics && Number.isFinite(Number(l.metrics.duration_ms)))
        .slice(-100)
        .map((l) => ({
            ms: Number(l.metrics.duration_ms),
            name: String((l.metrics && l.metrics.tool) || ''),
            ts: Number(l.ts) || 0,
        }));
    // 新鲜度：有 ≥30 条 7 天内的样本时，只用这些；否则保留最近 100 条（旧数据/冷启动）
    const now = Date.now();
    const fresh = tool.filter((r) => r.ts > 0 && now - r.ts <= FRESH_MS);
    if (fresh.length >= MIN_FRESH) tool = fresh;

    return { turn, tool };
}

/** 从样本里识别「重工具」：同名 ≥3 条且自身 p50 ≥3s。 */
function _heavyNames(tool) {
    const byName = new Map();
    for (const r of tool) {
        if (!r.name) continue;   // 旧样本没名字 → 当轻工具（兼容 v1）
        if (!byName.has(r.name)) byName.set(r.name, []);
        byName.get(r.name).push(r.ms);
    }
    const heavy = new Set();
    for (const [name, arr] of byName) {
        if (arr.length >= HEAVY_MIN_N && median(arr) >= HEAVY_P50_MS) heavy.add(name);
    }
    return heavy;
}

/** 评测总耗时：读最近一次 runner 的报告（只读，不跑评测）。 */
function _evalTotal() {
    const file = path.join(ROOT, '_probe', 'agent-eval', 'last-run.json');
    const doc = _readJson(file, null);
    const n = doc && Number(doc.totalMs);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 测量当前指标。
 * @returns {{turn_p50_ms:number|null, tool_p90_ms:number|null, tool_heavy_p50_ms:number|null,
 *            tool_heavy_count:number, eval_total_ms:number|null}}
 */
function measure() {
    const s = _samples();
    const heavy = _heavyNames(s.tool);
    const light = s.tool.filter((r) => !r.name || !heavy.has(r.name));
    const heavyRows = s.tool.filter((r) => r.name && heavy.has(r.name));
    return {
        turn_p50_ms: pct(s.turn, 50),
        // 轻工具 p90：重工具（看屏/游戏/批量）不再污染这条预算
        tool_p90_ms: pct(light.map((r) => r.ms), 90),
        // 重工具单独报 p50；样本不足时 null（doctor 显示 skip）
        tool_heavy_p50_ms: heavyRows.length ? pct(heavyRows.map((r) => r.ms), 50) : null,
        tool_heavy_count: heavyRows.length,
        eval_total_ms: _evalTotal(),
    };
}

/**
 * 判定（会读写状态文件；纯测量请用 measure()）。
 * @returns {{items:Array<{key,label,value,baseline,overPct,status,streak}>, bad:number, warn:number}}
 */
function evaluate() {
    const cur = measure();
    const doc = _readJson(STATE, { version: 1, items: {} });
    doc.items = doc.items && typeof doc.items === 'object' ? doc.items : {};
    // v1 → v2 迁移：tool_p90 口径变了（只算轻工具），旧样本不再可比，清空重建。
    // turn / eval 的样本保留；重工具项从零开始。
    const prevVersion = Number(doc.version) || 1;
    if (prevVersion < STATE_VERSION) {
        if (doc.items.tool_p90_ms) doc.items.tool_p90_ms.samples = [];
        doc.version = STATE_VERSION;
    }
    const LABEL = { turn_p50_ms: '轮次 p50', tool_p90_ms: '轻工具 p90', tool_heavy_p50_ms: '重工具 p50', eval_total_ms: '评测总耗时' };
    const items = [];
    for (const key of Object.keys(LABEL)) {
        const value = cur[key];
        const st = doc.items[key] || { samples: [], streak: 0, status: 'ok' };
        st.samples = (Array.isArray(st.samples) ? st.samples : []).filter((n) => Number.isFinite(Number(n))).slice(-KEEP);
        let status = 'ok';
        let baseline = null;
        if (Number.isFinite(value) && value > 0) {
            baseline = st.samples.length >= 3 ? pct(st.samples, 50) : null;
            const tol = TOL_BY_KEY[key] || TOL;
            if (baseline && baseline > 0) {
                if (value > baseline * tol) {
                    st.streak = (Number(st.streak) || 0) + 1;
                    status = st.streak >= BAD_STREAK ? 'bad' : 'warn';
                } else {
                    st.streak = 0;
                    status = 'ok';
                }
            } else {
                status = 'ok';   // 数据不足，不判
                st.streak = 0;
            }
            st.samples.push(Math.round(value));
            st.samples = st.samples.slice(-KEEP);
        } else {
            status = 'skip';
        }
        st.status = status;
        doc.items[key] = st;
        items.push({
            key, label: LABEL[key], value: Number.isFinite(value) ? Math.round(value) : null,
            baseline: baseline == null ? null : Math.round(baseline),
            overPct: (baseline && value) ? Math.round((value / baseline - 1) * 100) : 0,
            status, streak: Number(st.streak) || 0,
        });
    }
    doc.version = STATE_VERSION;
    doc.updatedAt = Date.now();
    _writeJson(STATE, doc);
    return { items, bad: items.filter((i) => i.status === 'bad').length, warn: items.filter((i) => i.status === 'warn').length };
}

module.exports = { measure, evaluate, TOL, BAD_STREAK, KEEP, STATE, HEAVY_P50_MS, FRESH_MS };
