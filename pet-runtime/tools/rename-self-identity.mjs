#!/usr/bin/env node
/**
 * rename-self-identity.mjs —— 「肥牛 / Fake Neuro」自我称呼 → 「大肥鱼」迁移（2026-11-23）
 *
 * 设计原则（与身份清理任务对齐）：
 *   1. 默认 **dry-run 只读**：只统计、只给样例，不改任何记忆。
 *   2. 只替换**明确的自我称呼模式**：`【Fake Neuro】`、`我是肥牛`、`肥牛说`、
 *      `主人与肥牛一起`、`肥牛的日记`…… 不碰普通名词「肥牛」（肥牛卷/火锅/饭）。
 *   3. **绝不改** `feiniu_default`、`fake_neuro_audio`、`2D/肥牛`、`feiniu-house`
 *      这类内部标识/路径；`--apply` 前必须完成备份（复用 tools/memos-backup.mjs）。
 *   4. 幂等：第二次跑命中数应为 0。
 *
 * 用法：
 *   node pet-runtime/tools/rename-self-identity.mjs                 # dry-run（默认）
 *   node pet-runtime/tools/rename-self-identity.mjs --json          # 机器可读
 *   node pet-runtime/tools/rename-self-identity.mjs --offline       # 只看文件，不连 MemOS
 *   node pet-runtime/tools/rename-self-identity.mjs --root <dir>    # 测试用：换工作区根
 *   node pet-runtime/tools/rename-self-identity.mjs --apply         # 先备份再迁移（本轮不要跑）
 *
 * 退出码：0 = 成功；1 = 有失败/备份失败；2 = 参数错误。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const argValue = (n, d) => {
    const i = args.indexOf(n);
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
    const eq = args.find((a) => a.startsWith(n + '='));
    return eq ? eq.slice(n.length + 1) : d;
};

const ROOT = path.resolve(argValue('--root', DEFAULT_ROOT));
const DATA_DIR = path.join(ROOT, '_incoming', 'my-neuro', 'data');
const MEMOS_API = process.env.MEMOS_API || 'http://127.0.0.1:8003';
const APPLY = has('--apply');
const OFFLINE = has('--offline') || has('--files-only');
const JSON_OUT = has('--json');
const MEMOS_BACKUP = path.join(ROOT, 'pet-runtime', 'tools', 'memos-backup.mjs');
const invokedDirectly = (() => {
    try { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
    catch (_) { return false; }
})();
export { invokedDirectly };

// 只处理人可读的存量记忆；data 里其它运行产物（看屏卡片/RSS）不在本轮范围。
const TARGET_FILES = [
    '记忆库.txt',
    '对话历史.jsonl',
    'AI日记.txt',
    '用户记忆.json',
    '用户事实.json',
    '用户画像.json',
    '用户画像_候选.json',
];

// ── 自我称呼规则（顺序有意义：先吃掉组合形式，再做逐词）──────────────────
// 说明：规则只匹配「肥牛」作为**说话人/她本人**的语境；普通食物词不命中。
const RULES = [
    { name: 'fake-neuro-parenthetical', re: /fake[_ ]?neuro\s*[（(]肥牛[）)]/gi, to: '大肥鱼' },
    { name: 'fake-neuro-label', re: /\bfake neuro\b/gi, to: '大肥鱼' },
    { name: 'self-is', re: /(我(?:是|叫)|叫我|称呼(?:AI)?为|管(?:AI|她|他|助手)?叫|把(?:她|他|AI|助手)?叫(?:做|成)?)肥牛/g, to: '$1大肥鱼' },
    { name: 'self-wo', re: /我肥牛/g, to: '我大肥鱼' },
    { name: 'ai-assistant', re: /(AI助手|人工智能助手|桌面助手)肥牛/g, to: '$1大肥鱼' },
    { name: 'self-possessive', re: /肥牛(的(?:日记|心情|身份|风格|人设|记忆|自称|性格))/g, to: '大肥鱼$1' },
    { name: 'self-says', re: /肥牛(说道|回答|调侃|说(?=[：:，,。.\s]|$))/g, to: '大肥鱼$1' },
    { name: 'with-person', re: /(主人|用户|他|她|你)(与|和|跟|对|问|让|叫|找|告诉|提醒|要求|请|陪)肥牛/g, to: '$1$2大肥鱼' },
    { name: 'follow-verb', re: /肥牛(一起|是否|向|记得|觉得|认为|承诺|陪)/g, to: '大肥鱼$1' },
];

/** 对一段文本应用自我称呼规则；返回 {text, hits, changed}。 */
export function rewriteSelfIdentity(input) {
    let text = String(input ?? '');
    const hits = [];
    for (const r of RULES) {
        let count = 0;
        text = text.replace(r.re, (...m) => {
            count += 1;
            // 支持 $1/$2 回填
            let out = r.to;
            for (let i = 1; i < m.length - 2; i++) out = out.replaceAll('$' + i, m[i] ?? '');
            return out;
        });
        if (count) hits.push({ rule: r.name, count });
    }
    return { text, hits, changed: hits.length > 0 };
}

/** 统计一段文本里「未被规则覆盖」的旧称残片（供报告风险，不自动改）。 */
export function residualOldNames(input) {
    const s = String(input ?? '');
    return {
        niuniu: (s.match(/肥牛/g) || []).length,
        fakeNeuro: (s.match(/fake[_ ]?neuro/gi) || []).length,
        feiniu: (s.match(/feiniu/gi) || []).length,
    };
}

function short(s, n = 46) {
    return String(s || '').replace(/\s+/g, ' ').slice(0, n);
}

function httpJson(method, urlPath, body, timeoutMs = 120000) {
    const url = new URL(MEMOS_API + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname + url.search,
            method,
            headers: payload
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                : {},
            agent: false,
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (_) { /* raw */ }
                if (res.statusCode >= 400) {
                    const err = new Error(`HTTP ${res.statusCode} ${data.slice(0, 160)}`);
                    err.status = res.statusCode;
                    return reject(err);
                }
                resolve(json);
            });
        });
        req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms`)));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 读文件的安全包装：不存在 = 跳过（不是错误）。 */
function readIfExists(file) {
    try { return fs.readFileSync(file, 'utf8'); } catch (e) {
        if (e && e.code === 'ENOENT') return null;
        throw e;
    }
}

function planFiles() {
    const plans = [];
    for (const name of TARGET_FILES) {
        const file = path.join(DATA_DIR, name);
        const text = readIfExists(file);
        if (text === null) continue;
        const rw = rewriteSelfIdentity(text);
        const before = residualOldNames(text);
        const residual = rw.changed ? residualOldNames(rw.text) : before;
        // 行级样例：改动前的片段
        const samples = [];
        if (rw.changed) {
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && samples.length < 3; i++) {
                const one = rewriteSelfIdentity(lines[i]);
                if (one.changed) samples.push({ line: i + 1, before: short(lines[i], 60), after: short(one.text, 60) });
            }
        }
        plans.push({ kind: 'file', name, file, hits: rw.hits, total: rw.hits.reduce((a, h) => a + h.count, 0), changed: rw.changed, residual, samples });
    }
    return plans;
}

async function planMemos() {
    if (OFFLINE) return { skipped: true, reason: '--offline', total: 0, hits: [] };
    let list;
    try {
        list = await httpJson('GET', '/list?limit=0&include_deleted=true&user_id=', null, 30000);
    } catch (e) {
        return { skipped: true, reason: 'MemOS 不可达：' + (e && e.message || e), total: 0, hits: [] };
    }
    const all = Array.isArray(list && list.memories) ? list.memories : [];
    const active = all.filter((m) => m && (m.status || 'active') === 'active');
    const hits = [];
    for (const m of active) {
        const rw = rewriteSelfIdentity(m.content || '');
        if (!rw.changed) continue;
        hits.push({
            id: m.id,
            before: short(m.content, 80),
            after: short(rw.text, 80),
            rules: rw.hits,
            residual: residualOldNames(rw.text),
            newContent: rw.text,
        });
    }
    return { skipped: false, total: active.length, all: all.length, hits };
}

async function planGraph() {
    if (OFFLINE) return { skipped: true, reason: '--offline', suspects: [], exact: [], residual: [] };
    let body = null;
    let reason = null;
    try {
        body = await httpJson('GET', '/graph/consistency?sample_limit=50', null, 30000);
    } catch (e) {
        reason = '图谱一致性接口不可用：' + (e && e.message || e);
    }
    // 回退：一致性接口要求 Qdrant/analyze_consistency；图本身可用时仍能列实体。
    if (!body || body.status === 'disabled' || !Array.isArray(body.suspected_old_self)) {
        try {
            const list = await httpJson('GET', '/graph/entities?user_id=&limit=10000', null, 30000);
            const ents = Array.isArray(list && list.entities) ? list.entities : [];
            const suspects = ents
                .filter((e) => /肥牛|fake\s*neuro/i.test(String(e && e.name || '')))
                .map((e) => ({ id: String(e.id || '').slice(0, 8), name: String(e.name || ''), entity_type: e.entity_type || '' }));
            const exact = suspects.filter((s) => s.name.trim() === '肥牛');
            return {
                skipped: false,
                reason: null,
                suspects,
                exact,
                residual: suspects.filter((s) => s.name.trim() !== '肥牛'),
            };
        } catch (e2) {
            return {
                skipped: true,
                reason: reason || ('图谱接口不可用：' + (e2 && e2.message || e2)),
                suspects: [], exact: [], residual: [],
            };
        }
    }
    const suspects = (body.suspected_old_self || []).map((e) => ({
        id: String(e.id || '').slice(0, 8),
        name: String(e.name || ''),
        entity_type: e.entity_type || '',
    }));
    const exact = suspects.filter((s) => s.name.trim() === '肥牛');
    return {
        skipped: false,
        reason: null,
        suspects,
        exact,
        residual: suspects.filter((s) => s.name.trim() !== '肥牛'),
    };
}

function backupFiles(plans, parent) {
    const dir = path.join(parent, 'files');
    fs.mkdirSync(dir, { recursive: true });
    const manifest = [];
    for (const p of plans) {
        if (!p.changed) continue;
        const dst = path.join(dir, p.name);
        fs.copyFileSync(p.file, dst);
        manifest.push({ name: p.name, bytes: fs.statSync(dst).size });
    }
    fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify({ at: new Date().toISOString(), files: manifest }, null, 2), 'utf8');
    return dir;
}

function runMemosBackup(parent) {
    if (!fs.existsSync(MEMOS_BACKUP)) return { ok: false, reason: '找不到 memos-backup.mjs：' + MEMOS_BACKUP };
    const r = spawnSync(process.execPath, [MEMOS_BACKUP, '--out', parent], { stdio: 'pipe', encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) {
        return { ok: false, reason: (r.stderr || r.stdout || '').slice(-400) || ('exit ' + r.status) };
    }
    return { ok: true, out: (r.stdout || '').trim() };
}

function writeFileAtomic(file, text) {
    const tmp = file + '.identity-tmp-' + process.pid;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
}

async function applyMemos(hits) {
    let ok = 0;
    const failed = [];
    for (const h of hits) {
        try {
            await httpJson('POST', '/memory/feedback', {
                memory_id: h.id,
                feedback_type: 'correct',
                correction: h.newContent,
                reason: '身份清理：旧自称「肥牛/Fake Neuro」→「大肥鱼」',
                user_id: '',
            }, 180000);
            ok += 1;
        } catch (e) {
            failed.push({ id: h.id, error: (e && e.message || String(e)).slice(0, 160) });
        }
    }
    return { ok, failed };
}

async function applyGraph(plan) {
    if (!plan || plan.skipped || !plan.exact.length) return null;
    try {
        const r = await httpJson('POST', '/graph/rename-entity', { from: '肥牛', to: '大肥鱼' }, 30000);
        return { ok: Number(r && r.renamed) || 0, result: r, failed: [] };
    } catch (e) {
        return { ok: 0, failed: [{ error: (e && e.message || String(e)).slice(0, 200) }] };
    }
}

if (invokedDirectly) {
(async () => {
    const filePlans = planFiles();
    const memos = await planMemos();
    const graph = await planGraph();
    const fileTotal = filePlans.reduce((a, p) => a + p.total, 0);
    const memosTotal = memos.skipped ? 0 : memos.hits.length;
    const graphTotal = graph.skipped ? 0 : graph.exact.length;
    const total = fileTotal + memosTotal + graphTotal;

    const report = {
        mode: APPLY ? 'apply' : 'dry-run',
        root: ROOT,
        dataDir: DATA_DIR,
        memos: { skipped: !!memos.skipped, reason: memos.reason || null, active: memos.total || 0, all: memos.all || 0, hits: memosTotal },
        graph: { skipped: !!graph.skipped, reason: graph.reason || null, suspects: graph.suspects, exact: graph.exact, residual: graph.residual, hits: graphTotal },
        files: filePlans.map((p) => ({ name: p.name, total: p.total, hits: p.hits, residual: p.residual, samples: p.samples })),
        totalPlanned: total,
        backup: null,
        applied: null,
    };

    if (!APPLY || total === 0) {
        if (JSON_OUT) {
            // 不把完整 newContent 打进 dry-run JSON，避免报告变噪音
            const slim = { ...report, memos: { ...report.memos, samples: (memos.hits || []).slice(0, 6).map((h) => ({ id: h.id.slice(0, 8), before: h.before, after: h.after })) } };
            console.log(JSON.stringify(slim, null, 2));
        } else {
            console.log(`== rename-self-identity (${report.mode}) ==`);
            console.log(`root: ${ROOT}`);
            console.log(`MemOS: ${memos.skipped ? 'SKIP (' + memos.reason + ')' : `active=${memos.total} all=${memos.all} hit=${memosTotal}`}`);
            for (const h of (memos.hits || []).slice(0, 10)) {
                console.log(`  ${h.id.slice(0, 8)}  ${h.before}`);
                console.log(`           -> ${h.after}`);
            }
            for (const p of filePlans) {
                console.log(`file ${p.name}: hit=${p.total} rules=${p.hits.map((h) => h.rule + ':' + h.count).join(',') || '-'}`);
                for (const s of p.samples) console.log(`  L${s.line}  ${s.before}\n         -> ${s.after}`);
                if (p.residual.niuniu || p.residual.fakeNeuro || p.residual.feiniu) {
                    console.log(`  residual(不自动改): 肥牛=${p.residual.niuniu} fakeNeuro=${p.residual.fakeNeuro} feiniu=${p.residual.feiniu}`);
                }
            }
            console.log(`graph: ${graph.skipped ? 'SKIP (' + graph.reason + ')' : `suspects=${graph.suspects.length} exact肥牛=${graph.exact.length}`}`);
            for (const e of graph.exact) console.log(`  ${e.id}  name=${e.name} type=${e.entity_type || '-'}`);
            for (const e of graph.residual) console.log(`  residual(不自动改) ${e.id}  name=${e.name}`);
            console.log(`TOTAL planned: ${total}${total === 0 ? '（已干净/幂等）' : ''}`);
            if (!APPLY && total > 0) console.log('dry-run only：未改任何文件/记忆/图谱。确认后加 --apply（会先备份）。');
        }
        process.exit(0);
    }

    // ── apply：先备份 ─────────────────────────────────────────────
    const parent = path.join(DATA_DIR, '记忆备份', 'identity-' + stamp());
    fs.mkdirSync(parent, { recursive: true });
    if (!memos.skipped && (memosTotal > 0 || graphTotal > 0)) {
        const bk = runMemosBackup(parent);
        if (!bk.ok) {
            console.error('备份失败，拒绝 --apply：' + bk.reason);
            process.exit(1);
        }
        report.backup = { dir: parent, memos: bk.out.split(/\r?\n/).filter(Boolean).slice(-3) };
    }
    report.backup = { ...(report.backup || { dir: parent }), files: backupFiles(filePlans, parent) };

    const applied = { memos: null, files: [], graph: null };
    if (!memos.skipped && memosTotal > 0) applied.memos = await applyMemos(memos.hits);
    for (const p of filePlans) {
        if (!p.changed) continue;
        const text = readIfExists(p.file);
        const rw = rewriteSelfIdentity(text);
        writeFileAtomic(p.file, rw.text);
        applied.files.push({ name: p.name, total: p.total });
    }
    // 图谱放在文件/MemOS 之后；失败只记 failed，不回滚已完成的迁移。
    if (!graph.skipped && graphTotal > 0) applied.graph = await applyGraph(graph);
    report.applied = applied;

    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
    else {
        console.log('== rename-self-identity (apply) ==');
        console.log('backup:', parent);
        if (applied.memos) console.log(`MemOS corrected=${applied.memos.ok} failed=${applied.memos.failed.length}`);
        console.log(`files rewritten: ${applied.files.map((f) => f.name + '(' + f.total + ')').join(', ') || '-'}`);
        if (applied.graph) console.log(`graph renamed=${applied.graph.ok} failed=${applied.graph.failed.length}`);
    }
    const failed = ((applied.memos && applied.memos.failed.length) || 0)
        + ((applied.graph && applied.graph.failed.length) || 0);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.error('rename-self-identity 失败：' + (e && e.stack || e));
    process.exit(1);
});
}
