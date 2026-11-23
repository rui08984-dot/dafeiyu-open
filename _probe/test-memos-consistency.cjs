#!/usr/bin/env node
/**
 * _probe/test-memos-consistency.cjs — B3 记忆一致性检查/修复（2026-11-23）
 *
 * 盯住的契约：
 *   ① 只读统计：死引用/纯死实体/无来源实体/顶层与 properties 双份不一致，均给计数+示例
 *   ② cleanup 语义：摘死引用；纯死实体连边删除；无来源且从未引用死记忆的实体保持
 *   ③ cleanup 原子写 + 可重载 + 幂等；dry-run 不落盘、不改内存
 *   ④ 端点：GET /graph/consistency、POST /graph/cleanup（默认 dry_run；空记忆基准 409）
 *   ⑤ --fix 只动图：桩 API 断言 0 次 delete/soft_delete；不需要重启真实 8003
 *   ⑥ CLI 退出码：只读 0；--fix 后仍不一致 1；图 JSON 损坏 2
 *   ⑦ 隐私：报告里的 id 只有前 8 位
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const CLI = path.join(ROOT, 'pet-runtime', 'tools', 'memos-consistency.mjs');
const PY = process.env.PET_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); }
    else { fail += 1; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

function sha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memos-consistency-'));
function pyJson(script, label) {
    try {
        const stdout = execFileSync(PY, ['-I', '-W', 'ignore', '-c', script], {
            cwd: MEMOS,
            encoding: 'utf8',
            timeout: 120000,
        });
        const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
        return JSON.parse(lines[lines.length - 1]);
    } catch (e) {
        console.error('python probe failed (' + label + '):', e.message);
        return {};
    }
}

// ── A. 存储层：mkdtemp 图 + 三种输入 ────────────────────────────────────────
const storageScript = [
    'import sys, json, os, tempfile, shutil, hashlib',
    'sys.path.insert(0, ".")',
    'from storage.networkx_graph import NetworkXGraphClient',
    'def sha(p):',
    '    return hashlib.sha256(open(p, "rb").read()).hexdigest()',
    'tmp = tempfile.mkdtemp()',
    'out = {}',
    'try:',
    '    # 1) 空图',
    '    p0 = os.path.join(tmp, "empty.json")',
    '    g0 = NetworkXGraphClient(data_path=p0)',
    '    out["empty_analyze"] = g0.analyze_consistency([])',
    '    c0 = g0.cleanup_dead_references([])',
    '    out["empty_cleanup"] = {"changed": c0["changed"], "saved": c0["saved"]}',
    '    # 2) 全正常图',
    '    p1 = os.path.join(tmp, "normal.json")',
    '    g1 = NetworkXGraphClient(data_path=p1)',
    '    g1.add_entity("n1", "person", "n1", properties={"source_memory_ids": ["m1", "m2"]})',
    '    g1.add_entity("n2", "person", "n2", properties={"source_memory_ids": ["m2"]})',
    '    g1.add_relation("n1", "n2", "likes", properties={"source_memory_id": "m2"})',
    '    h1 = sha(p1)',
    '    a1 = g1.analyze_consistency({"m1", "m2"})',
    '    c1 = g1.cleanup_dead_references({"m1", "m2"})',
    '    out["normal"] = {k: a1[k] for k in ("entity_count","relation_count","dead_reference_count","orphan_entity_count","props_mismatch_count","edge_dead_reference_count")}',
    '    out["normal_cleanup"] = {"changed": c1["changed"], "saved": c1["saved"]}',
    '    out["normal_hash_same"] = sha(p1) == h1',
    '    # 3) 异常图',
    '    p2 = os.path.join(tmp, "dirty.json")',
    '    g = NetworkXGraphClient(data_path=p2)',
    '    g.add_entity("A", "person", "A", properties={"source_memory_ids": ["m1", "m2"]})',
    '    g.add_entity("B", "person", "B", properties={"source_memory_ids": ["m9"]})',
    '    g.add_entity("C", "person", "C")',
    '    g.add_entity("D", "person", "D", properties={"source_memory_ids": ["m1"]})',
    '    g.graph.nodes["D"]["properties"]["source_memory_ids"] = []',
    '    g.add_entity("E", "person", "E", properties={"source_memory_ids": ["m9"]})',
    '    g.graph.nodes["E"]["source_memory_ids"] = ["m9", "m1"]',
    '    g.add_relation("A", "C", "knows", properties={"source_memory_id": "m2"})',
    '    g.add_relation("C", "D", "knows", properties={"source_memory_id": "m9"})',
    '    g._save_graph()',
    '    h2 = sha(p2)',
    '    a2 = g.analyze_consistency({"m1", "m2"})',
    '    out["dirty"] = {k: a2[k] for k in ("entity_count","relation_count","referenced_memory_count","dead_reference_count","dead_entity_count","dead_only_entity_count","orphan_entity_count","props_mismatch_count","edge_dead_reference_count","multi_entity_memory_count")}',
    '    out["samples_short"] = all(len(str(x)) <= 8 for group in a2["samples"].values() for x in group)',
    '    out["dead_samples"] = a2["samples"]["dead_memory_ids"]',
    '    dry = g.cleanup_dead_references({"m1", "m2"}, dry_run=True)',
    '    out["dry"] = {"changed": dry["changed"], "saved": dry["saved"], "changes": dry["changes"]}',
    '    out["dry_hash_same"] = sha(p2) == h2',
    '    out["dry_nodes"] = sorted(g.graph.nodes)',
    '    real = g.cleanup_dead_references({"m1", "m2"}, dry_run=False)',
    '    out["real"] = {"changed": real["changed"], "saved": real["saved"], "changes": real["changes"]}',
    '    out["after"] = {k: real["after"][k] for k in ("entity_count","relation_count","dead_reference_count","dead_entity_count","dead_only_entity_count","orphan_entity_count","props_mismatch_count","edge_dead_reference_count")}',
    '    out["nodes_after"] = sorted(g.graph.nodes)',
    '    out["A"] = [list(g.graph.nodes["A"]["source_memory_ids"]), list(g.graph.nodes["A"]["properties"]["source_memory_ids"])]',
    '    out["C"] = [list(g.graph.nodes["C"]["source_memory_ids"]), list(g.graph.nodes["C"]["properties"].get("source_memory_ids") or [])]',
    '    out["D"] = [list(g.graph.nodes["D"]["source_memory_ids"]), list(g.graph.nodes["D"]["properties"]["source_memory_ids"])]',
    '    out["E"] = [list(g.graph.nodes["E"]["source_memory_ids"]), list(g.graph.nodes["E"]["properties"]["source_memory_ids"])]',
    '    out["edge_ac"] = dict(g.graph.edges["A", "C"])',
    '    out["edge_cd"] = dict(g.graph.edges["C", "D"])',
    '    out["tmp_left"] = os.path.exists(p2 + ".tmp")',
    '    out["file_meta"] = json.load(open(p2, encoding="utf-8"))["metadata"]',
    '    g2 = NetworkXGraphClient(data_path=p2)',
    '    out["reload_nodes"] = sorted(g2.graph.nodes)',
    '    out["reload_a"] = list(g2.graph.nodes["A"]["properties"]["source_memory_ids"])',
    '    h3 = sha(p2)',
    '    g2.analyze_consistency({"m1", "m2"})',
    '    out["analyze_no_write"] = sha(p2) == h3',
    '    idem = g2.cleanup_dead_references({"m1", "m2"}, dry_run=False)',
    '    out["idem"] = {"changed": idem["changed"], "saved": idem["saved"], "changes": idem["changes"]}',
    '    import py_compile',
    '    out["py_ok"] = True',
    '    try:',
    '        py_compile.compile("storage/networkx_graph.py", doraise=True)',
    '        py_compile.compile("api/memos_api_server_v2.py", doraise=True)',
    '    except Exception as e:',
    '        out["py_ok"] = False',
    '        out["py_err"] = str(e)[:160]',
    'finally:',
    '    shutil.rmtree(tmp)',
    'print(json.dumps(out))',
].join('\n');

console.log('test-memos-consistency');
console.log(' [A] 存储层（mkdtemp 图）');
const st = pyJson(storageScript, 'storage');

ok(st.empty_analyze && st.empty_analyze.entity_count === 0 && st.empty_analyze.dead_reference_count === 0, '空图统计全 0');
ok(st.empty_cleanup && st.empty_cleanup.changed === false && st.empty_cleanup.saved === false, '空图清理 0 变化');

ok(st.normal && st.normal.dead_reference_count === 0 && st.normal.orphan_entity_count === 0
    && st.normal.props_mismatch_count === 0 && st.normal.edge_dead_reference_count === 0, '全正常图 0 问题', JSON.stringify(st.normal));
ok(st.normal_cleanup && st.normal_cleanup.changed === false && st.normal_cleanup.saved === false, '全正常图清理不改文件');
ok(st.normal_hash_same === true, '只读统计不写图文件');

ok(st.dirty && st.dirty.entity_count === 5 && st.dirty.relation_count === 2, '异常图实体/边计数', JSON.stringify(st.dirty));
ok(st.dirty && st.dirty.dead_reference_count === 2 && st.dirty.dead_entity_count === 2, '死引用 2 处 / 2 实体');
ok(st.dirty && st.dirty.dead_only_entity_count === 1, '纯死实体 1 个');
ok(st.dirty && st.dirty.orphan_entity_count === 1, '无来源实体 1 个（C）');
ok(st.dirty && st.dirty.props_mismatch_count === 2, '双份不一致 2 个（D/E）');
ok(st.dirty && st.dirty.edge_dead_reference_count === 1, '边死引用 1 处');
ok(st.dirty && st.dirty.multi_entity_memory_count === 1, '同一记忆多实体引用=正常（m1 被 3 个实体引用）');
ok(st.samples_short === true, '示例 id 均 ≤8 位');
ok(Array.isArray(st.dead_samples) && st.dead_samples.length === 1 && st.dead_samples[0].length <= 8, '死记忆示例只给前缀');

ok(st.dry && st.dry.changed === true && st.dry.saved === false, 'dry-run 报告有变化但不保存');
ok(st.dry_hash_same === true, 'dry-run 文件哈希不变');
ok(Array.isArray(st.dry_nodes) && st.dry_nodes.join(',') === 'A,B,C,D,E', 'dry-run 内存节点不变');

ok(st.real && st.real.changed === true && st.real.saved === true, '真实清理已保存');
ok(st.real && st.real.changes.refs_removed === 2 && st.real.changes.entities_deleted === 1
    && st.real.changes.entities_repaired === 2 && st.real.changes.edge_refs_cleared === 1, '清理变化计数', JSON.stringify(st.real && st.real.changes));
ok(st.after && st.after.dead_reference_count === 0 && st.after.dead_entity_count === 0
    && st.after.props_mismatch_count === 0 && st.after.edge_dead_reference_count === 0, '清理后 0 死引用 / 0 双份不一致');
ok(st.after && st.after.entity_count === 4 && st.after.orphan_entity_count === 1, 'B 删除、C 保留');
ok(Array.isArray(st.nodes_after) && st.nodes_after.join(',') === 'A,C,D,E', '节点集合正确', JSON.stringify(st.nodes_after));
ok(JSON.stringify(st.A) === JSON.stringify([['m1', 'm2'], ['m1', 'm2']]), 'A 保留 m1/m2 且两份一致');
ok(JSON.stringify(st.C) === JSON.stringify([[], []]), 'C 保持无来源');
ok(JSON.stringify(st.D) === JSON.stringify([['m1'], ['m1']]), 'D 双份统一为 m1');
ok(JSON.stringify(st.E) === JSON.stringify([['m1'], ['m1']]), 'E 摘掉死引用 m9、保留 m1');
ok(st.edge_ac && st.edge_ac.source_memory_id === 'm2', '活引用边保持不动');
ok(st.edge_cd && !('source_memory_id' in st.edge_cd)
    && !(st.edge_cd.properties && 'source_memory_id' in st.edge_cd.properties), '死引用边只摘字段、边保留');
ok(st.tmp_left === false, '原子写无 .tmp 残留');
ok(st.file_meta && st.file_meta.node_count === 4 && st.file_meta.edge_count === 2, '落盘 metadata 计数正确', JSON.stringify(st.file_meta));
ok(Array.isArray(st.reload_nodes) && st.reload_nodes.join(',') === 'A,C,D,E', '图文件可重载且状态一致');
ok(JSON.stringify(st.reload_a) === JSON.stringify(['m1', 'm2']), '重载后引用仍正确');
ok(st.analyze_no_write === true, 'analyze 只读不写盘');
ok(st.idem && st.idem.changed === false && st.idem.saved === false
    && Object.values(st.idem.changes).every((v) => v === 0), '幂等：再跑 0 变化', JSON.stringify(st.idem));
ok(st.py_ok === true, 'Python 改动 py_compile 通过', st.py_err);

// ── B. HTTP 端点（FastAPI TestClient，不监听端口）───────────────────────────
const apiScript = [
    'import sys, json, os, tempfile, shutil, hashlib',
    'sys.path.insert(0, ".")',
    'from storage.networkx_graph import NetworkXGraphClient',
    'import api.memos_api_server_v2 as srv',
    'from fastapi.testclient import TestClient',
    'def sha(p):',
    '    return hashlib.sha256(open(p, "rb").read()).hexdigest()',
    'class FakeQdrant:',
    '    def __init__(self, ids):',
    '        self.ids = list(ids)',
    '        self.delete_calls = 0',
    '        self.soft_delete_calls = 0',
    '    def is_available(self):',
    '        return True',
    '    def get_all_memories(self, **kwargs):',
    '        return [{"id": i, "payload": {"content": "x"}} for i in self.ids]',
    '    def delete_memory(self, mid):',
    '        self.delete_calls += 1',
    '        return True',
    '    def soft_delete_memory(self, mid, reason=None):',
    '        self.soft_delete_calls += 1',
    '        return True',
    'def build(path):',
    '    g = NetworkXGraphClient(data_path=path)',
    '    g.add_entity("A", "person", "A", properties={"source_memory_ids": ["m1", "m2"]})',
    '    g.add_entity("B", "person", "B", properties={"source_memory_ids": ["m9"]})',
    '    g.add_entity("C", "person", "C")',
    '    g.add_entity("D", "person", "D", properties={"source_memory_ids": ["m1"]})',
    '    g.graph.nodes["D"]["properties"]["source_memory_ids"] = []',
    '    g.add_relation("A", "B", "likes")',
    '    g._save_graph()',
    '    return g',
    'tmp = tempfile.mkdtemp()',
    'out = {}',
    'try:',
    '    p = os.path.join(tmp, "graph.json")',
    '    g = build(p)',
    '    fake = FakeQdrant(["m1", "m2"])',
    '    srv.neo4j_client = g',
    '    srv.qdrant_client = fake',
    '    client = TestClient(srv.app)',
    '    out["routes"] = [r.path for r in srv.app.routes if getattr(r, "path", "") in ("/graph/consistency", "/graph/cleanup")]',
    '    r = client.get("/graph/consistency")',
    '    out["get_status"] = r.status_code',
    '    body = r.json()',
    '    out["get"] = {k: body["graph"][k] for k in ("entity_count","dead_reference_count","dead_entity_count","orphan_entity_count","props_mismatch_count")}',
    '    out["get_memory_total"] = body.get("memory_total")',
    '    h_before = sha(p)',
    '    dry = client.post("/graph/cleanup", json={})',
    '    out["dry"] = {"code": dry.status_code, "changed": dry.json().get("changed"), "saved": dry.json().get("saved"), "dry_run": dry.json().get("dry_run")}',
    '    out["dry_hash_same"] = sha(p) == h_before',
    '    out["dry_nodes"] = sorted(g.graph.nodes)',
    '    real = client.post("/graph/cleanup", json={"dry_run": False})',
    '    out["real"] = {"code": real.status_code, "saved": real.json().get("saved"), "changes": real.json().get("changes")}',
    '    out["real_nodes"] = sorted(g.graph.nodes)',
    '    out["real_hash_changed"] = sha(p) != h_before',
    '    out["delete_calls"] = fake.delete_calls',
    '    out["soft_delete_calls"] = fake.soft_delete_calls',
    '    idem = client.post("/graph/cleanup", json={"dry_run": False})',
    '    out["idem_changed"] = idem.json().get("changed")',
    '    # 空记忆基准护栏',
    '    p2 = os.path.join(tmp, "graph2.json")',
    '    g2 = build(p2)',
    '    h2 = sha(p2)',
    '    srv.neo4j_client = g2',
    '    srv.qdrant_client = FakeQdrant([])',
    '    guard = client.post("/graph/cleanup", json={"dry_run": False})',
    '    out["guard"] = {"code": guard.status_code, "detail_has_allow": "allow_empty_memories" in str(guard.json().get("detail", ""))}',
    '    out["guard_hash_same"] = sha(p2) == h2',
    '    out["guard_nodes"] = sorted(g2.graph.nodes)',
    '    allow = client.post("/graph/cleanup", json={"dry_run": False, "allow_empty_memories": True})',
    '    out["allow"] = {"code": allow.status_code, "nodes": sorted(g2.graph.nodes), "changes": allow.json().get("changes")}',
    '    # 图未启用',
    '    srv.neo4j_client = None',
    '    srv.qdrant_client = FakeQdrant(["m1"])',
    '    disabled = client.get("/graph/consistency")',
    '    out["disabled_get"] = {"code": disabled.status_code, "status": disabled.json().get("status")}',
    '    disabled_post = client.post("/graph/cleanup", json={})',
    '    out["disabled_post_code"] = disabled_post.status_code',
    '    # 向量库不可用：不能把整张图当死引用',
    '    srv.neo4j_client = build(os.path.join(tmp, "graph3.json"))',
    '    srv.qdrant_client = None',
    '    noq_get = client.get("/graph/consistency")',
    '    noq_post = client.post("/graph/cleanup", json={"dry_run": False})',
    '    out["noq"] = {"get": noq_get.status_code, "post": noq_post.status_code}',
    'finally:',
    '    shutil.rmtree(tmp)',
    'print(json.dumps(out))',
].join('\n');

console.log(' [B] HTTP 端点（TestClient）');
const api = pyJson(apiScript, 'api');

ok(Array.isArray(api.routes) && api.routes.includes('/graph/consistency') && api.routes.includes('/graph/cleanup'), '两个端点已注册', JSON.stringify(api.routes));
ok(api.get_status === 200, 'GET /graph/consistency 200');
ok(api.get && api.get.entity_count === 4 && api.get.dead_reference_count === 1
    && api.get.dead_entity_count === 1 && api.get.orphan_entity_count === 1, '端点数与存储层一致', JSON.stringify(api.get));
ok(api.get_memory_total === 2, '端点报告记忆基准数');
ok(api.dry && api.dry.code === 200 && api.dry.dry_run === true && api.dry.changed === true && api.dry.saved === false, 'POST cleanup 默认 dry_run');
ok(api.dry_hash_same === true && Array.isArray(api.dry_nodes) && api.dry_nodes.join(',') === 'A,B,C,D', 'dry_run 不写盘/不改内存');
ok(api.real && api.real.code === 200 && api.real.saved === true, 'POST cleanup 真实保存');
ok(api.real && api.real.changes && api.real.changes.refs_removed === 1 && api.real.changes.entities_deleted === 1, '端点清理变化计数', JSON.stringify(api.real && api.real.changes));
ok(Array.isArray(api.real_nodes) && api.real_nodes.join(',') === 'A,C,D', '端点清理后 B 删除');
ok(api.real_hash_changed === true, '端点清理确实写了图文件');
ok(api.delete_calls === 0 && api.soft_delete_calls === 0, '端点清理 0 次删记忆');
ok(api.idem_changed === false, '端点清理幂等');
ok(api.guard && api.guard.code === 409 && api.guard.detail_has_allow === true, '空记忆基准 409 且提示 allow_empty_memories');
ok(api.guard_hash_same === true && Array.isArray(api.guard_nodes) && api.guard_nodes.join(',') === 'A,B,C,D', '护栏拒后文件/节点不变');
ok(api.allow && api.allow.code === 200 && Array.isArray(api.allow.nodes) && api.allow.nodes.join(',') === 'C', '显式 allow 后只留无来源实体', JSON.stringify(api.allow));
ok(api.disabled_get && api.disabled_get.code === 200 && api.disabled_get.status === 'disabled', '图未启用 GET 返回 disabled');
ok(api.disabled_post_code === 503, '图未启用 POST 503');
ok(api.noq && api.noq.get === 503 && api.noq.post === 503, '向量库不可用 GET/POST 均 503（不把整图当死引用）');

// ── C. CLI：桩 API（0 次删记忆 + 退出码）───────────────────────────────────
function memory(id, status, text) {
    return { id, content: text, status, importance: 0.5, memory_type: 'general', layer: 'LongTermMemory', tags: [] };
}
const ACTIVE = [
    memory('m1', 'active', '主人喜欢吃草莓蛋糕而且不喜欢香菜这是一段足够长的正文'),
    memory('m2', 'active', '大肥鱼每天下午三点会在窗边晒太阳并且打呼噜这是一段正文'),
    memory('m3', 'active', '项目使用NetworkX保存知识图谱并且每周做一次一致性检查'),
    memory('m4', 'active', '主人今天下午去超市买了牛奶和面包还有两盒鸡蛋'),
    memory('m5', 'active', '记忆服务监听8003端口向量库存在本地qdrant目录里面'),
];
const ARCHIVED = [memory('m6', 'archived', '这是一条已经归档的旧记忆内容足够长用于统计')];
const DELETED = [memory('m7', 'deleted', '这是一条软删除的记忆内容足够长用于统计')];

function writeStubGraph(state) {
    const data = state.clean
        ? { nodes: [], edges: [], metadata: { node_count: 0, edge_count: 0 } }
        : {
            nodes: [{ id: 'entY', entity_type: 'person', name: 'y', source_memory_ids: ['m9'], properties: { source_memory_ids: ['m9'] } }],
            edges: [],
            metadata: { node_count: 1, edge_count: 0 },
        };
    fs.writeFileSync(state.graphFile, JSON.stringify(data, null, 2), 'utf8');
}

function startStub(state) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        let body = {};
        if (req.method === 'POST') {
            body = await new Promise((resolve) => {
                let data = '';
                req.on('data', (c) => { data += c; });
                req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
            });
        }
        const send = (code, obj) => {
            res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(obj));
        };
        if (req.method === 'DELETE' || url.pathname === '/delete_memory') {
            state.deleteCalls += 1;
            return send(200, { status: 'success' });
        }
        if (url.pathname === '/health') return send(200, { status: 'healthy' });
        if (url.pathname === '/stats') {
            return send(200, {
                total_count: state.active.length,
                archived_count: state.archived.length,
                deleted_count: state.deleted.length,
                raw_points_count: state.active.length + state.archived.length + state.deleted.length,
                entity_count: 3,
                relation_count: 2,
            });
        }
        if (url.pathname === '/list') {
            const status = url.searchParams.get('status');
            const includeDeleted = url.searchParams.get('include_deleted') === 'true';
            let list;
            if (status === 'archived') list = state.archived;
            else if (status === 'deleted') list = state.deleted;
            else {
                list = state.active.slice();
                if (includeDeleted) list = list.concat(state.deleted);
            }
            return send(200, { count: list.length, total_count: list.length, memories: list });
        }
        if (url.pathname === '/graph/stats') {
            return send(200, { status: 'enabled', entity_count: 3, relation_count: 2 });
        }
        if (url.pathname === '/graph/consistency') {
            if (state.noGraphEndpoint) return send(404, { detail: 'Not Found' });
            return send(200, state.graphReport());
        }
        if (url.pathname === '/graph/cleanup') {
            if (state.noGraphEndpoint) return send(404, { detail: 'Not Found' });
            state.cleanupCalls += 1;
            const dry = body.dry_run !== false;
            if (!dry && !state.stubborn) {
                state.clean = true;
                writeStubGraph(state);
            }
            return send(200, {
                status: 'ok',
                dry_run: dry,
                changed: true,
                saved: !dry,
                existing_memory_count: 7,
                changes: { refs_removed: 1, entities_deleted: 1, entities_repaired: 0, edge_refs_cleared: 0 },
                after: state.graphReport().graph,
            });
        }
        if (url.pathname === '/get_memory_by_ids') {
            const ids = body.memory_ids || [];
            return send(200, { memories: ids.map((id) => ({ id, payload: { user_id: 'u' } })), count: ids.length });
        }
        if (url.pathname === '/search') {
            state.searchCalls += 1;
            return send(200, {
                query: body.query,
                memories: state.active.map((m, i) => ({ id: m.id, similarity: 0.9, bm25_score: 0.8, bm25_only: i === 0 })),
                count: state.active.length,
            });
        }
        return send(404, { detail: 'Not Found' });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function runCli(extra, port) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...extra, '--api', 'http://127.0.0.1:' + port], {
            cwd: ROOT,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

function parseCli(result) {
    try { return JSON.parse(result.stdout); } catch (_) { return null; }
}

function makeState() {
    return {
        active: ACTIVE.map((m) => ({ ...m })),
        archived: ARCHIVED.map((m) => ({ ...m })),
        deleted: DELETED.map((m) => ({ ...m })),
        graphFile: path.join(tmp, 'stub-graph.json'),
        clean: false,
        stubborn: false,
        noGraphEndpoint: false,
        cleanupCalls: 0,
        deleteCalls: 0,
        searchCalls: 0,
        graphReport() {
            const dead = this.clean ? 0 : 1;
            return {
                status: 'ok',
                generated_at: '2026-11-23T00:00:00',
                memory_total: 7,
                user_id: null,
                graph: {
                    available: true,
                    entity_count: 3,
                    relation_count: 2,
                    referenced_memory_count: 2,
                    dead_reference_count: dead,
                    dead_entity_count: dead,
                    dead_only_entity_count: dead,
                    orphan_entity_count: 0,
                    props_mismatch_count: 0,
                    edge_dead_reference_count: 0,
                    multi_entity_memory_count: 1,
                    samples: {
                        dead_entity_ids: dead ? ['deadent1'] : [],
                        dead_only_entity_ids: dead ? ['deadent1'] : [],
                        orphan_entity_ids: [],
                        props_mismatch_entity_ids: [],
                        dead_memory_ids: dead ? ['deadmemo'] : [],
                        edge_dead_entity_ids: [],
                    },
                },
            };
        },
    };
}

(async () => {
    console.log(' [C] CLI 桩 API');
    const state = makeState();
    writeStubGraph(state);
    const stub = await startStub(state);
    const corrupt = path.join(tmp, 'corrupt-graph.json');
    fs.writeFileSync(corrupt, '{ this is not json', 'utf8');
    const validGraph = path.join(tmp, 'valid-graph.json');
    fs.writeFileSync(validGraph, JSON.stringify({
        nodes: [{
            id: 'entX', entity_type: 'person', name: 'x',
            source_memory_ids: ['m9'], properties: { source_memory_ids: ['m9'] },
        }],
        edges: [],
        metadata: { node_count: 1, edge_count: 0 },
    }, null, 2), 'utf8');

    try {
        // C1 只读：发现不一致但退出 0，不调 cleanup
        let r = await runCli(['--json'], stub.port);
        let report = parseCli(r);
        ok(r.code === 0, '只读模式退出 0', 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 120));
        ok(report && report.vector && report.vector.ok === true, '只读报告：向量五条计数核对通过');
        ok(report && report.graph && report.graph.dead_reference_count === 1, '只读报告：图谱死引用 1');
        ok(report && report.bm25 && report.bm25.hit === 3, '只读报告：BM25 抽查 3/3');
        ok(report && report.summary && report.summary.consistent === false && report.summary.hard_issue_count === 1, '只读报告：硬伤 1（图谱死引用）', JSON.stringify(report && report.summary));
        ok(state.cleanupCalls === 0, '只读模式不调 cleanup');
        ok(state.deleteCalls === 0, '只读模式 0 次删记忆');

        // C2 --fix：桩清理成功 → 复核干净 → 0
        state.clean = false;
        state.stubborn = false;
        writeStubGraph(state);
        r = await runCli(['--json', '--fix', '--graph', state.graphFile], stub.port);
        report = parseCli(r);
        ok(r.code === 0, '--fix 成功后退出 0', 'code=' + r.code + ' stderr=' + r.stderr.slice(0, 160));
        ok(report && report.fix && report.fix.changed === true && report.fix.saved === true, '--fix 报告有变化且已保存');
        ok(report && report.post && report.post.graph && report.post.graph.dead_reference_count === 0, '--fix 复核死引用 0');
        ok(state.cleanupCalls === 1, '--fix 只调 1 次 cleanup');
        ok(state.deleteCalls === 0, '--fix 0 次删记忆（硬约束）');

        // C3 --fix 但修复不生效 → 1
        state.clean = false;
        state.stubborn = true;
        writeStubGraph(state);
        r = await runCli(['--json', '--fix', '--graph', state.graphFile], stub.port);
        report = parseCli(r);
        ok(r.code === 1, '--fix 后仍不一致退出 1', 'code=' + r.code);
        ok(report && report.fix && report.fix.ok === false, '--fix 报告 ok=false');
        ok(state.deleteCalls === 0, '失败修复路径 0 次删记忆');

        // C4 dry-run：调 cleanup(dry) 但状态不变，退出 0
        state.clean = false;
        state.stubborn = false;
        const before = state.cleanupCalls;
        r = await runCli(['--json', '--fix', '--dry-run'], stub.port);
        report = parseCli(r);
        ok(r.code === 0 && state.cleanupCalls === before + 1, '--fix --dry-run 调 dry_run 端点并退出 0');
        ok(state.clean === false, 'dry-run 不改变桩状态');

        // C5 图 JSON 损坏 → 2
        r = await runCli(['--json', '--graph', corrupt], stub.port);
        report = parseCli(r);
        ok(r.code === 2, '图 JSON 损坏退出 2', 'code=' + r.code);
        ok(report && report.fatal === true && report.code === 2, '损坏时 JSON 输出 fatal/code=2');

        // C6 旧代码（端点 404）只读：退回图文件
        state.noGraphEndpoint = true;
        r = await runCli(['--json', '--graph', validGraph], stub.port);
        report = parseCli(r);
        ok(r.code === 0, '无端点只读退出 0');
        ok(report && report.graph && report.graph.source === 'file', '无端点时图谱来源=file');
        ok(report && report.graph && report.graph.dead_reference_count === 1, '文件分析发现死引用 1');

        // C7 旧代码 --fix：明确提示重启，退出 1，不改文件
        state.cleanupCalls = 0;
        const hashBefore = sha(validGraph);
        r = await runCli(['--json', '--fix', '--graph', validGraph], stub.port);
        report = parseCli(r);
        ok(r.code === 1, '端点缺失时 --fix 退出 1');
        ok(report && report.fix && /重启 8003/.test(String(report.fix.error || '')), '提示需要重启 8003 才生效');
        ok(sha(validGraph) === hashBefore, '端点缺失时 --fix 不改图文件');
        ok(state.deleteCalls === 0, '全部 CLI 路径 0 次删记忆');
    } finally {
        await new Promise((resolve) => stub.server.close(resolve));
    }

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }

    console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + ' / ' + (pass + fail));
    process.exitCode = fail === 0 ? 0 : 1;
})();
