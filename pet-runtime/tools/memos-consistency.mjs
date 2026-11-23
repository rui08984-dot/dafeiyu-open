#!/usr/bin/env node
/**
 * memos-consistency.mjs —— MemOS 记忆一致性体检 / 安全修复（B3，2026-11-23）
 *
 * 要回答的问题：向量库（Qdrant 条数）、BM25（能不能检索到已知内容）、
 * 图谱（source_memory_ids 指向的记忆是否还在）三处到底一不一致。
 *
 * 用法：
 *   node pet-runtime/tools/memos-consistency.mjs                 # 只读体检（默认）
 *   node pet-runtime/tools/memos-consistency.mjs --json          # 机器可读
 *   node pet-runtime/tools/memos-consistency.mjs --fix           # 调 POST /graph/cleanup 清图
 *   node pet-runtime/tools/memos-consistency.mjs --fix --dry-run # 只演练清理，不落盘
 *   node pet-runtime/tools/memos-consistency.mjs --no-bm25       # 跳过 /search 抽查
 *   node pet-runtime/tools/memos-consistency.mjs --api URL --graph FILE --samples 3 --topk 10
 *
 * 离线/停服直写（8003 未重启、还没有 /graph/cleanup 时）：
 *   node pet-runtime/tools/memos-consistency.mjs --fix --direct-write \
 *        --graph .../data/graph_store.json [--ids-file 备份/memories.json]
 *   仅在 8003 未监听时允许；服务在跑时内存态会把直写覆盖回去（要 --force-direct-write 才放行）。
 *
 * 退出码：0=一致或只读报告；1=--fix 后仍不一致 / 无法修复；2=报告不可信（API 不可达、
 * 图 JSON 损坏、HTTP 5xx）。
 *
 * 隐私：只打印 id 前 8 位与计数，不打印记忆正文。修复只动图：
 * 不删记忆、不删向量、不碰 BM25。BM25 抽查走 /search，会让命中条目的
 * access_count 变化（这是现有检索行为，不是本工具改的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const PY = process.env.PET_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const hit = args.find((a) => a === name || a.startsWith(name + '='));
    if (!hit) return fallback;
    if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
    const idx = args.indexOf(hit);
    return args[idx + 1] || fallback;
}
const API = argValue('--api', process.env.MEMOS_API || 'http://127.0.0.1:8003');
const FIX = args.includes('--fix');
const DRY_RUN = args.includes('--dry-run');
const JSON_OUT = args.includes('--json');
const SKIP_BM25 = args.includes('--no-bm25');
const DIRECT_WRITE = args.includes('--direct-write');
const FORCE_DIRECT = args.includes('--force-direct-write');
const SAMPLES = Math.max(1, Math.min(10, Number(argValue('--samples', '3')) || 3));
const TOP_K = Math.max(1, Math.min(50, Number(argValue('--topk', '10')) || 10));
const EXAMPLES = Math.max(1, Math.min(20, Number(argValue('--examples', '5')) || 5));
const GRAPH_ARG = argValue('--graph', null);
const IDS_FILE = argValue('--ids-file', null);

class CodedError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

function log(msg) {
    if (!JSON_OUT) console.log(msg);
}

function p8(value) {
    return String(value == null ? '' : value).slice(0, 8);
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function httpJson(method, urlPath, body, timeoutMs = 15000) {
    const url = new URL(API + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
            agent: false,
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { data += d; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (_) { /* keep raw */ }
                if (res.statusCode >= 400) {
                    const err = new Error('HTTP ' + res.statusCode + ' ' + data.slice(0, 200));
                    err.status = res.statusCode;
                    err.body = json;
                    return reject(err);
                }
                if (data && json === null) {
                    const err = new Error('HTTP ' + res.statusCode + ' 非 JSON 响应: ' + data.slice(0, 120));
                    err.status = res.statusCode;
                    return reject(err);
                }
                resolve(json);
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout ' + timeoutMs + 'ms')); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function sha256File(file) {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return null; }
}

function defaultGraphPath() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(MEMOS, 'config', 'memos_config.json'), 'utf8'));
        const raw = (cfg.storage && cfg.storage.graph && cfg.storage.graph.path) || './data/graph_store.json';
        return path.isAbsolute(raw) ? raw : path.resolve(MEMOS, raw);
    } catch (_) {
        return path.join(MEMOS, 'data', 'graph_store.json');
    }
}

const GRAPH_FILE = GRAPH_ARG ? path.resolve(GRAPH_ARG) : defaultGraphPath();

function loadGraphFile() {
    if (!fs.existsSync(GRAPH_FILE)) {
        return { exists: false, file: GRAPH_FILE, hash: null, data: null };
    }
    const hash = sha256File(GRAPH_FILE);
    let data;
    try {
        data = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8'));
    } catch (e) {
        throw new CodedError('图文件 JSON 解析失败: ' + GRAPH_FILE + '（' + e.message + '）', 2);
    }
    if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
        throw new CodedError('图文件结构损坏（缺 nodes/edges 数组）: ' + GRAPH_FILE, 2);
    }
    return { exists: true, file: GRAPH_FILE, hash, data };
}

/** 在 MemOS 目录下用同一份 NetworkXGraphClient 做只读统计或原子写清理。 */
function runPython(op, payload) {
    // 用 base64 走 argv，避免 Windows 上 stdin 被按 cp936 解码而破坏中文路径。
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const script = [
        'import sys, json, base64',
        'sys.path.insert(0, ".")',
        'from storage.networkx_graph import NetworkXGraphClient',
        'payload = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))',
        'g = NetworkXGraphClient(data_path=payload["graph"])',
        'if not g.is_available():',
        '    raise SystemExit("networkx 不可用")',
        'ids = payload.get("memory_ids") or []',
        'if payload["op"] == "analyze":',
        '    out = g.analyze_consistency(ids, user_id=payload.get("user_id"), sample_limit=payload.get("sample_limit", 5))',
        'elif payload["op"] == "cleanup":',
        '    out = g.cleanup_dead_references(ids, user_id=payload.get("user_id"), dry_run=payload.get("dry_run", True))',
        'else:',
        '    raise SystemExit("unknown op: " + payload["op"])',
        'print(json.dumps(out))',
    ].join('\n');
    const r = spawnSync(PY, ['-I', '-c', script, encoded], {
        cwd: MEMOS,
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
    });
    if (r.error) throw new CodedError('Python 调用失败: ' + r.error.message, 2);
    if (r.status !== 0) {
        throw new CodedError('Python 退出码 ' + r.status + ': ' + String(r.stderr || '').trim().slice(-300), 2);
    }
    const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    try {
        return JSON.parse(lines[lines.length - 1]);
    } catch (e) {
        throw new CodedError('Python 输出不是 JSON: ' + String(r.stdout || '').slice(0, 200), 2);
    }
}

function loadIdsFile() {
    if (!IDS_FILE) return null;
    let data;
    try { data = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8')); } catch (e) {
        throw new CodedError('--ids-file 读取/解析失败: ' + e.message, 2);
    }
    const list = Array.isArray(data)
        ? data
        : (Array.isArray(data.ids) ? data.ids : (Array.isArray(data.memories) ? data.memories : []));
    const ids = list.map((item) => {
        if (item && typeof item === 'object') return item.id != null ? String(item.id) : null;
        return item != null ? String(item) : null;
    }).filter(Boolean);
    return ids;
}

function setIdDiff(a, b) {
    const out = [];
    for (const item of a) if (!b.has(item)) out.push(item);
    return out;
}

function idsOf(response) {
    return ((response && response.memories) || []).map((m) => String(m.id)).filter(Boolean);
}

async function listQuery(status, includeDeleted) {
    let q = '/list?limit=0&user_id=';
    if (status) q += '&status=' + encodeURIComponent(status);
    if (includeDeleted) q += '&include_deleted=true';
    const res = await httpJson('GET', q, null, 30000);
    const ids = idsOf(res);
    return {
        count: num(res && res.count),
        total_count: num(res && res.total_count),
        ids,
        memories: (res && res.memories) || [],
    };
}

async function collectVector() {
    const stats = await httpJson('GET', '/stats', null, 20000);
    const [active, archived, deleted, includeDeleted] = await Promise.all([
        listQuery(null, false),
        listQuery('archived', false),
        listQuery('deleted', false),
        listQuery(null, true),
    ]);

    const activeIds = new Set(active.ids);
    const archivedIds = new Set(archived.ids);
    const deletedIds = new Set(deleted.ids);
    const includeIds = new Set(includeDeleted.ids);
    const unionActiveDeleted = new Set([...active.ids, ...deleted.ids]);

    const statsTotal = num(stats.total_count);
    const statsArchived = num(stats.archived_count);
    const statsDeleted = num(stats.deleted_count);
    const rawPointsAvailable = stats.raw_points_count != null;
    const rawPoints = num(stats.raw_points_count);

    const checks = {
        stats_vs_list_active: statsTotal === active.count && active.count === active.total_count,
        stats_archived_vs_list: statsArchived === archived.count && archived.count === archived.total_count,
        stats_deleted_vs_list: statsDeleted === deleted.count && deleted.count === deleted.total_count,
        include_deleted_vs_active_plus_deleted:
            includeDeleted.count === active.count + deleted.count
            && includeDeleted.count === includeDeleted.total_count
            && setIdDiff(includeIds, unionActiveDeleted).length === 0
            && setIdDiff(unionActiveDeleted, includeIds).length === 0,
        // /stats 不保证所有版本都有 raw_points_count；没有就不拿它判红。
        raw_points_vs_partition: !rawPointsAvailable || rawPoints === active.count + archived.count + deleted.count,
    };

    return {
        report: {
            available: true,
            stats: { total: statsTotal, archived: statsArchived, deleted: statsDeleted, raw_points: rawPoints },
            lists: {
                active: { count: active.count, total_count: active.total_count },
                archived: { count: archived.count, total_count: archived.total_count },
                deleted: { count: deleted.count, total_count: deleted.total_count },
                include_deleted: { count: includeDeleted.count, total_count: includeDeleted.total_count },
            },
            checks,
            diffs: {
                stats_total_minus_list_active: statsTotal - active.count,
                stats_archived_minus_list: statsArchived - archived.count,
                stats_deleted_minus_list: statsDeleted - deleted.count,
                raw_points_minus_partition: rawPoints - (active.count + archived.count + deleted.count),
                include_deleted_extra_ids: setIdDiff(includeIds, unionActiveDeleted).slice(0, EXAMPLES).map(p8),
                include_deleted_missing_ids: setIdDiff(unionActiveDeleted, includeIds).slice(0, EXAMPLES).map(p8),
            },
            ok: Object.values(checks).every(Boolean),
        },
        memoryIds: [...activeIds, ...archivedIds, ...deletedIds],
        activeMemories: active.memories,
    };
}

function graphReportFrom(raw, source, extra) {
    const report = {
        available: true,
        source,
        entity_count: num(raw.entity_count),
        relation_count: num(raw.relation_count),
        referenced_memory_count: num(raw.referenced_memory_count),
        dead_reference_count: num(raw.dead_reference_count),
        dead_entity_count: num(raw.dead_entity_count),
        dead_only_entity_count: num(raw.dead_only_entity_count),
        orphan_entity_count: num(raw.orphan_entity_count),
        props_mismatch_count: num(raw.props_mismatch_count),
        edge_dead_reference_count: num(raw.edge_dead_reference_count),
        multi_entity_memory_count: num(raw.multi_entity_memory_count),
        samples: raw.samples || {},
        stats_match: null,
        ok: num(raw.dead_reference_count) === 0
            && num(raw.edge_dead_reference_count) === 0
            && num(raw.props_mismatch_count) === 0,
        ...(extra || {}),
    };
    return report;
}

async function collectGraph(memoryIds) {
    const statsPromise = httpJson('GET', '/graph/stats', null, 10000).catch(() => null);
    let graph;
    try {
        const res = await httpJson('GET', '/graph/consistency?sample_limit=' + EXAMPLES, null, 20000);
        if (!res || res.status === 'disabled') {
            graph = {
                available: false,
                source: 'endpoint',
                ok: true,
                note: '知识图谱未启用',
                stats_match: null,
                samples: {},
            };
        } else {
            graph = graphReportFrom(res.graph || {}, 'endpoint', {
                memory_total: num(res.memory_total),
            });
        }
    } catch (e) {
        if (e.status === 404 || e.status === 405) {
            // 8003 还在跑旧代码：退回本地图文件（只读），语义相同。
            const file = loadGraphFile();
            if (!file.exists) {
                graph = {
                    available: false, source: 'file', ok: true,
                    note: '图文件不存在且端点未加载', stats_match: null, samples: {},
                };
            } else if (!memoryIds || memoryIds.length === 0) {
                graph = {
                    available: false, source: 'file', ok: false,
                    note: '端点未加载（需重启 8003），且没有记忆 id 基准', stats_match: null, samples: {},
                };
            } else {
                const raw = runPython('analyze', {
                    op: 'analyze',
                    graph: GRAPH_FILE,
                    memory_ids: memoryIds,
                    sample_limit: EXAMPLES,
                });
                graph = graphReportFrom(raw, 'file', { memory_total: memoryIds.length });
            }
        } else if (e.status === 503) {
            graph = {
                available: false, source: 'endpoint', ok: true,
                note: '图存储不支持一致性检查（需 NetworkX）', stats_match: null, samples: {},
            };
        } else if (!e.status) {
            // 8003 不可达：向量侧也会判不可读，最终退出码 2。
            graph = {
                available: false, source: 'endpoint', ok: false,
                note: '图谱端点不可达: ' + String(e.message || e).slice(0, 100), stats_match: null, samples: {},
            };
        } else {
            throw new CodedError('图谱端点 HTTP ' + e.status + ': ' + String(e.message).slice(0, 120), 2);
        }
    }

    const gstats = await statsPromise;
    if (graph.available && gstats && gstats.status === 'enabled') {
        graph.stats_match = num(gstats.entity_count) === graph.entity_count
            && num(gstats.relation_count) === graph.relation_count;
        graph.stats = { entity_count: num(gstats.entity_count), relation_count: num(gstats.relation_count) };
    }
    return graph;
}

async function collectBm25(activeMemories) {
    if (SKIP_BM25) {
        return { available: false, skipped: true, tested: 0, hit: 0, hit_rate: null, samples: [], note: '--no-bm25' };
    }
    const candidates = (activeMemories || [])
        .filter((m) => m && m.id && typeof m.content === 'string' && m.content.length >= 12)
        .slice(0, SAMPLES);
    if (!candidates.length) {
        return { available: true, skipped: false, tested: 0, hit: 0, hit_rate: null, samples: [], note: '没有可抽查的 active 记忆' };
    }

    // /search 的 user_id 默认是主用户；先用 /get_memory_by_ids 查样本真实 user_id，避免跨 profile 误判。
    const userIds = new Map();
    try {
        const res = await httpJson('POST', '/get_memory_by_ids', {
            memory_ids: candidates.map((m) => m.id),
            include_deleted: true,
            user_id: '',
        }, 20000);
        for (const m of (res && res.memories) || []) {
            const uid = m && m.payload && m.payload.user_id;
            if (m && m.id && uid) userIds.set(String(m.id), String(uid));
        }
    } catch (_) {
        // 查不到就用默认 user（'' → 服务端主用户）
    }

    const samples = [];
    let hit = 0;
    let error = null;
    for (const mem of candidates) {
        const row = { id: p8(mem.id), hit: false, rank: null, bm25_seen: false };
        try {
            const res = await httpJson('POST', '/search', {
                query: mem.content.slice(0, 12),
                top_k: TOP_K,
                user_id: userIds.get(String(mem.id)) || '',
                use_bm25: true,
                use_graph: false,
                similarity_threshold: 0.3,
            }, 45000);
            const hits = (res && res.memories) || [];
            const idx = hits.findIndex((h) => String(h.id) === String(mem.id));
            row.hit = idx >= 0;
            row.rank = idx >= 0 ? idx + 1 : null;
            if (idx >= 0) {
                row.bm25_seen = hits[idx].bm25_only === true || num(hits[idx].bm25_score) > 0;
                hit += 1;
            }
        } catch (e) {
            row.error = e.status ? 'HTTP ' + e.status : e.message.slice(0, 80);
            error = error || row.error;
        }
        samples.push(row);
    }
    return {
        available: true,
        skipped: false,
        tested: samples.length,
        hit,
        hit_rate: samples.length ? Number((hit / samples.length).toFixed(3)) : null,
        top_k: TOP_K,
        samples,
        error,
        note: error
            ? '抽查失败：' + error
            : (hit < samples.length ? '前 12 字查询会与语义近义记忆竞争，命中率只作趋势提示' : null),
    };
}

function buildIssues(report) {
    const issues = [];
    const v = report.vector;
    if (!v.available) {
        issues.push({ code: 'vector_unavailable', level: 'hard', message: '向量库不可读（/stats 或 /list 失败）' });
    } else if (!v.ok) {
        const failed = Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k);
        issues.push({
            code: 'vector_count_mismatch',
            level: 'hard',
            message: '向量库计数对不上：' + failed.join(', '),
            details: v.diffs,
        });
    }

    const g = report.graph;
    if (g.available) {
        if (num(g.dead_reference_count) > 0) {
            issues.push({
                code: 'graph_dead_references',
                level: 'hard',
                message: '图谱有 ' + g.dead_reference_count + ' 处死引用（' + g.dead_entity_count + ' 个实体）',
                samples: g.samples && g.samples.dead_entity_ids,
            });
        }
        if (num(g.edge_dead_reference_count) > 0) {
            issues.push({
                code: 'graph_edge_dead_references',
                level: 'hard',
                message: '图谱边上有 ' + g.edge_dead_reference_count + ' 处死引用',
                samples: g.samples && g.samples.edge_dead_entity_ids,
            });
        }
        if (num(g.props_mismatch_count) > 0) {
            issues.push({
                code: 'graph_dual_store_mismatch',
                level: 'hard',
                message: '有 ' + g.props_mismatch_count + ' 个实体的顶层/properties 两份 source_memory_ids 不一致',
                samples: g.samples && g.samples.props_mismatch_entity_ids,
            });
        }
        if (num(g.orphan_entity_count) > 0) {
            issues.push({
                code: 'graph_orphan_entities',
                level: 'warn',
                message: '有 ' + g.orphan_entity_count + ' 个实体没有任何来源记忆（可能是人工建的，本工具不删）',
                samples: g.samples && g.samples.orphan_entity_ids,
            });
        }
        if (g.stats_match === false) {
            issues.push({ code: 'graph_stats_mismatch', level: 'hard', message: '/graph/stats 与一致性报告的实体/边数不一致' });
        }
        if (g.memory_total != null && report.vector.available && g.memory_total !== report.memory_id_count) {
            issues.push({ code: 'graph_memory_base_mismatch', level: 'hard', message: '图谱端点用的记忆基准数与 /list 汇总不一致' });
        }
        if (!g.ok) {
            // 具体原因已在上面的字段里逐项列出
        }
    } else if (g.note) {
        issues.push({ code: 'graph_unavailable', level: 'warn', message: g.note });
    }

    const b = report.bm25;
    if (b.available && !b.skipped && b.tested > 0 && b.hit < b.tested) {
        issues.push({
            code: 'bm25_partial_hit',
            level: 'warn',
            message: 'BM25 抽查前 ' + b.top_k + ' 命中 ' + b.hit + '/' + b.tested + '（只提示，不参与退出码）',
            samples: b.samples.filter((s) => !s.hit).map((s) => s.id),
        });
    }
    if (b.error) {
        issues.push({ code: 'bm25_probe_error', level: 'warn', message: 'BM25 抽查失败：' + b.error });
    }
    return issues;
}

async function collect({ skipBm25 = SKIP_BM25 } = {}) {
    const report = {
        tool: 'memos-consistency',
        version: 1,
        generated_at: new Date().toISOString(),
        api: API,
        graph_file: GRAPH_FILE,
        vector: null,
        graph: null,
        bm25: null,
        memory_id_count: 0,
        issues: [],
        summary: null,
    };

    let vector = null;
    let memoryIds = null;
    let activeMemories = [];
    try {
        const collected = await collectVector();
        vector = collected.report;
        memoryIds = collected.memoryIds;
        activeMemories = collected.activeMemories;
    } catch (e) {
        vector = {
            available: false,
            ok: false,
            error: e.status ? 'HTTP ' + e.status : e.message,
            stats: {}, lists: {}, checks: {}, diffs: {},
        };
    }

    if (!memoryIds && IDS_FILE) {
        const ids = loadIdsFile();
        if (ids) memoryIds = ids;
    }

    // 图文件损坏要在任何统计前就判 2，别让 NetworkX 把它当空图。
    loadGraphFile();

    const graph = await collectGraph(memoryIds);
    const bm25 = skipBm25
        ? { available: false, skipped: true, tested: 0, hit: 0, hit_rate: null, samples: [], note: '--no-bm25' }
        : (vector.available ? await collectBm25(activeMemories) : { available: false, skipped: false, tested: 0, hit: 0, hit_rate: null, samples: [], note: '向量库不可读，跳过' });

    report.vector = vector;
    report.graph = graph;
    report.bm25 = bm25;
    report.memory_id_count = Array.isArray(memoryIds) ? memoryIds.length : 0;
    report.issues = buildIssues(report);
    const hard = report.issues.filter((i) => i.level === 'hard').length;
    const warn = report.issues.filter((i) => i.level === 'warn').length;
    report.summary = {
        consistent: hard === 0,
        hard_issue_count: hard,
        warning_count: warn,
        bm25_hit: bm25.tested > 0 ? bm25.hit + '/' + bm25.tested : 'n/a',
    };
    // 完整 id 只在进程内给 --fix 用；不可枚举 → 不会进 --json 输出。
    Object.defineProperty(report, 'vector_memory_ids', {
        value: Array.isArray(memoryIds) ? memoryIds.slice() : null,
        enumerable: false,
    });
    return report;
}

function printReport(report) {
    log('[memos-consistency] ' + report.generated_at + '  API=' + report.api);
    log('图文件 ' + report.graph_file);

    const v = report.vector;
    log('── 向量库 ──');
    if (!v.available) {
        log('  ✗ 不可读：' + (v.error || '未知错误'));
    } else {
        log('  /stats total=' + v.stats.total + ' archived=' + v.stats.archived
            + ' deleted=' + v.stats.deleted + ' raw_points=' + v.stats.raw_points);
        log('  /list  active=' + v.lists.active.count + ' archived=' + v.lists.archived.count
            + ' deleted=' + v.lists.deleted.count + ' include_deleted=' + v.lists.include_deleted.count);
        const failed = Object.entries(v.checks).filter(([, ok]) => !ok).map(([k]) => k);
        log('  计数核对 ' + (Object.keys(v.checks).length - failed.length) + '/' + Object.keys(v.checks).length
            + (failed.length ? '  不一致：' + failed.join(', ') : '  通过'));
        if (failed.length) {
            for (const [key, value] of Object.entries(v.diffs)) {
                if (Array.isArray(value) ? value.length : Number(value) !== 0) {
                    log('    ' + key + ' = ' + (Array.isArray(value) ? value.join(',') || '[]' : value));
                }
            }
        }
    }

    const g = report.graph;
    log('── 图谱 ──');
    if (!g.available) {
        log('  ⚠ ' + (g.note || '不可用'));
    } else {
        log('  来源=' + g.source + '  实体=' + g.entity_count + ' 边=' + g.relation_count
            + '  现存记忆引用=' + g.referenced_memory_count);
        log('  死引用=' + g.dead_reference_count + '（' + g.dead_entity_count + ' 实体，其中纯死 '
            + g.dead_only_entity_count + '）  边死引用=' + g.edge_dead_reference_count
            + '  双份不一致=' + g.props_mismatch_count + '  无来源实体=' + g.orphan_entity_count);
        if (g.samples && g.samples.dead_entity_ids && g.samples.dead_entity_ids.length) {
            log('  示例 死实体: ' + g.samples.dead_entity_ids.join(', '));
        }
        if (g.samples && g.samples.props_mismatch_entity_ids && g.samples.props_mismatch_entity_ids.length) {
            log('  示例 双份不一致: ' + g.samples.props_mismatch_entity_ids.join(', '));
        }
        if (g.stats_match === false) log('  ✗ /graph/stats 与报告计数不一致');
    }

    const b = report.bm25;
    log('── BM25 ──');
    if (b.skipped) {
        log('  已跳过（' + (b.note || '--no-bm25') + '）');
    } else if (b.tested === 0) {
        log('  ' + (b.note || '无样本'));
    } else {
        log('  抽查 ' + b.tested + ' 条，前 ' + b.top_k + ' 命中 ' + b.hit + '/' + b.tested
            + (b.hit_rate == null ? '' : '（' + Math.round(b.hit_rate * 100) + '%）')
            + (b.error ? '  错误：' + b.error : ''));
        if (b.note && !b.error) log('  提示：' + b.note);
        for (const s of b.samples) {
            log('    ' + s.id + ' ' + (s.hit ? '命中 rank=' + s.rank + (s.bm25_seen ? ' (BM25)' : '') : '未命中'));
        }
    }

    log('── 结论 ──');
    for (const issue of report.issues) {
        log('  ' + (issue.level === 'hard' ? '✗' : '⚠') + ' [' + issue.code + '] ' + issue.message
            + (issue.samples && issue.samples.length ? '  例:' + issue.samples.join(',') : ''));
    }
    const s = report.summary;
    log('  ' + (s.consistent ? '一致（硬伤 0）' : '不一致（硬伤 ' + s.hard_issue_count + ' 处）')
        + '  警告 ' + s.warning_count + '  BM25 ' + s.bm25_hit);
}

/** --fix：优先走服务端点；停服/旧代码时才允许直写图文件。 */
async function runFix(report) {
    const result = {
        attempted: false,
        path: null,
        result: null,
        file_hash_before: null,
        file_hash_after: null,
        file_written: null,
        post: null,
        ok: false,
        error: null,
    };
    const health = await httpJson('GET', '/health', null, 3000).catch(() => null);
    const file = loadGraphFile();
    result.file_hash_before = file.hash;

    if (!DIRECT_WRITE) {
        result.attempted = true;
        result.path = 'endpoint';
        try {
            result.result = await httpJson('POST', '/graph/cleanup', {
                dry_run: DRY_RUN,
                user_id: null,
                sample_limit: EXAMPLES,
            }, 30000);
        } catch (e) {
            if (e.status === 404 || e.status === 405) {
                result.error = '8003 还没有 /graph/cleanup（仍在跑旧代码）：重启 8003 后重试；'
                    + '或停服后加 --direct-write --graph <图文件> 直写';
                return result;
            }
            if (e.status === 409) {
                result.error = '服务拒绝清理：' + ((e.body && e.body.detail) || e.message);
                return result;
            }
            throw e;
        }
    } else {
        result.attempted = true;
        result.path = 'file';
        if (!GRAPH_ARG) {
            result.error = '--direct-write 必须显式给 --graph <图文件>（避免写错文件）';
            return result;
        }
        if (health && !FORCE_DIRECT) {
            result.error = '8003 正在运行，直写图文件会被内存态覆盖；先停服，或加 --force-direct-write';
            return result;
        }
        const ids = report.vector.available ? report.vector_memory_ids : loadIdsFile();
        if (!ids || !ids.length) {
            result.error = '直写需要记忆 id 基准：8003 不可用时请给 --ids-file <memories.json|ids.json>';
            return result;
        }
        result.result = runPython('cleanup', {
            op: 'cleanup',
            graph: GRAPH_FILE,
            memory_ids: ids,
            dry_run: DRY_RUN,
        });
    }

    const afterFile = loadGraphFile();
    result.file_hash_after = afterFile.hash;
    const changed = !!(result.result && result.result.changed);
    result.file_written = DRY_RUN ? false : (changed ? result.file_hash_after !== result.file_hash_before : true);

    if (!DRY_RUN && changed && file.exists && result.file_hash_after === result.file_hash_before) {
        result.error = '清理报告有变化，但图文件哈希未变（保存可能失败）';
        return result;
    }
    if (DRY_RUN) {
        result.ok = true;
        return result;
    }

    if (result.path === 'endpoint') {
        // 清理后重新完整采集，不重复跑 BM25（检索有 access_count 副作用）。
        result.post = await collect({ skipBm25: true });
        const p = result.post;
        result.ok = p.vector.available && p.vector.ok
            && p.graph.available && num(p.graph.dead_reference_count) === 0
            && num(p.graph.edge_dead_reference_count) === 0
            && num(p.graph.props_mismatch_count) === 0;
    } else {
        const ids = report.vector.available ? report.vector_memory_ids : loadIdsFile();
        const after = runPython('cleanup', {
            op: 'cleanup',
            graph: GRAPH_FILE,
            memory_ids: ids || [],
            dry_run: true,
        });
        result.post = after;
        result.ok = after.changed === false
            && num(after.after && after.after.dead_reference_count) === 0
            && num(after.after && after.after.props_mismatch_count) === 0
            && num(after.after && after.after.edge_dead_reference_count) === 0;
    }
    return result;
}

async function main() {
    log('[memos-consistency] 检查 ' + API);
    const report = await collect();

    if (FIX) {
        const fix = await runFix(report);
        report.mode = DRY_RUN ? 'fix-dry-run' : 'fix';
        report.fix = {
            attempted: fix.attempted,
            path: fix.path,
            error: fix.error,
            changed: !!(fix.result && fix.result.changed),
            saved: !!(fix.result && fix.result.saved),
            changes: (fix.result && fix.result.changes) || null,
            file_written: fix.file_written,
            ok: fix.ok,
        };
        if (fix.post && fix.path === 'endpoint') {
            report.post = {
                vector_ok: fix.post.vector.available && fix.post.vector.ok,
                graph: fix.post.graph,
                issues: fix.post.issues,
                summary: fix.post.summary,
            };
        } else if (fix.post) {
            report.post = fix.post;
        }

        if (JSON_OUT) {
            console.log(JSON.stringify(report, null, 2));
        } else {
            printReport(report);
            log('── 修复 ──');
            log('  方式=' + (fix.path || 'n/a') + (DRY_RUN ? '（dry-run）' : ''));
            if (fix.error) log('  ✗ ' + fix.error);
            if (fix.result) {
                log('  变化 refs=' + num(fix.result.changes && fix.result.changes.refs_removed)
                    + ' 删实体=' + num(fix.result.changes && fix.result.changes.entities_deleted)
                    + ' 修双份=' + num(fix.result.changes && fix.result.changes.entities_repaired)
                    + ' 清边引用=' + num(fix.result.changes && fix.result.changes.edge_refs_cleared)
                    + ' saved=' + !!(fix.result.saved));
            }
            if (fix.post && fix.path === 'endpoint') {
                log('  复核 ' + (fix.ok ? '通过（图谱死引用/双份不一致均为 0）' : '未通过'));
            } else if (fix.post) {
                log('  复核 ' + (fix.ok ? '通过（幂等：再跑 0 变化）' : '未通过'));
            }
        }
        if (DRY_RUN) return 0;
        return fix.ok ? 0 : 1;
    }

    if (JSON_OUT) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        printReport(report);
    }
    // 只读模式：能出报告就 0（即使发现不一致，也不擅自修）。
    if (!report.vector.available) return 2;
    return 0;
}

main().then((code) => {
    process.exitCode = code;
}).catch((e) => {
    const code = e && Number.isInteger(e.code) ? e.code : (e && e.status ? 2 : 1);
    if (JSON_OUT) {
        console.log(JSON.stringify({ tool: 'memos-consistency', fatal: true, code, error: String(e && e.message || e) }, null, 2));
    } else {
        console.error('[memos-consistency] FAIL ' + String(e && e.message || e));
    }
    process.exitCode = code;
});
