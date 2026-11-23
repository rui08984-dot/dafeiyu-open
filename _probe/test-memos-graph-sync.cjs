#!/usr/bin/env node
/**
 * _probe/test-memos-graph-sync.cjs — B3 删记忆清图谱（2026-11-23）
 *
 * 现场：`/delete_memory` 只删向量 + BM25，NetworkX 图里实体节点的
 * source_memory_ids 继续指向已不存在的记忆；实体永远不消失，图越用越脏。
 *
 * 本探针盯住的契约：
 *   ① unlink_entity_from_memory：顶层与 properties 两份 source_memory_ids 都摘干净
 *   ② 全部来源都没了 → delete_entity 删节点（连带边）
 *   ③ 硬删两个入口（DELETE /delete 与 POST /delete_memory）都调用图清理；软删不调用
 *   ④ 备份脚本导出全部 profile（user_id 空串）且带 sha256 清单
 *   ⑤ 图文件保存是原子替换（tmp + os.replace），备份/崩溃不会读到半截 JSON
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const PY = 'py';

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); }
    else { fail += 1; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memos-graph-'));
const graphPath = path.join(tmp, 'graph_store.json').replace(/\\/g, '/');

const py = [
    'import sys, json, os',
    'sys.path.insert(0, ".")',
    'from storage.networkx_graph import NetworkXGraphClient',
    'p = ' + JSON.stringify(graphPath),
    'g = NetworkXGraphClient(data_path=p)',
    'g.add_entity("ent_a", "person", "主人", properties={"source_memory_ids": ["m1", "m2"], "description": "x"}, user_id="u")',
    'g.add_entity("ent_b", "concept", "咖啡", properties={"source_memory_ids": ["m1"]}, user_id="u")',
    'g.add_relation("ent_a", "ent_b", "likes")',
    'out = {}',
    'get = lambda eid: dict(g.graph.nodes[eid])',
    'g._normalize_entity_attrs(g.graph.nodes["ent_a"])',
    'out["top_before"] = list(get("ent_a").get("source_memory_ids"))',
    'out["props_before"] = list((get("ent_a").get("properties") or {}).get("source_memory_ids") or [])',
    'out["unlink_ok"] = g.unlink_entity_from_memory("ent_a", "m1")',
    'out["top_after"] = list(get("ent_a").get("source_memory_ids"))',
    'out["props_after"] = list((get("ent_a").get("properties") or {}).get("source_memory_ids") or [])',
    'out["unlink_missing"] = g.unlink_entity_from_memory("ent_nope", "m1")',
    'out["del_orphan"] = g.delete_entity("ent_b")  # ent_b 只剩 m1，调用方判断为空后删',
    'out["nodes_after_b"] = sorted(g.graph.nodes)',
    'out["edge_gone"] = not g.graph.has_edge("ent_a", "ent_b")',
    'out["reload_same"] = None',
    'g2 = NetworkXGraphClient(data_path=p)',
    'g2._normalize_entity_attrs(g2.graph.nodes["ent_a"])',
    'out["reload_same"] = list(g2.graph.nodes["ent_a"].get("source_memory_ids"))',
    'print(json.dumps(out))',
].join('\n');

let out = {};
try {
    const stdout = execFileSync(PY, ['-I', '-c', py], { cwd: MEMOS, encoding: 'utf8', timeout: 60000 });
    out = JSON.parse(stdout.trim().split(/\r?\n/).pop());
} catch (e) {
    console.error('python probe failed:', e.message);
}

console.log('test-memos-graph-sync');
ok(Array.isArray(out.top_before) && out.top_before.length === 2, '初始顶层引用 2 条', JSON.stringify(out.top_before));
ok(Array.isArray(out.props_before) && out.props_before.length === 2, '初始 properties 引用 2 条', JSON.stringify(out.props_before));
ok(out.unlink_ok === true, 'unlink 返回成功');
ok(JSON.stringify(out.top_after) === '["m2"]', '顶层摘掉 m1', JSON.stringify(out.top_after));
ok(JSON.stringify(out.props_after) === '["m2"]', 'properties 摘掉 m1（不会下次被提回）', JSON.stringify(out.props_after));
ok(out.unlink_missing === false, '实体不存在时返回 false（不抛）');
ok(out.del_orphan === true, '无来源实体可删除');
ok(Array.isArray(out.nodes_after_b) && out.nodes_after_b.join(',') === 'ent_a', '节点确实消失', JSON.stringify(out.nodes_after_b));
ok(out.edge_gone === true, '关联边一并消失');
ok(JSON.stringify(out.reload_same) === '["m2"]', '落盘后重载仍是摘干净的状态', JSON.stringify(out.reload_same));

const server = fs.readFileSync(path.join(MEMOS, 'api', 'memos_api_server_v2.py'), 'utf8');
ok(/graph_sync = _sync_graph_after_memory_delete\(memory_id\) if hard else None/.test(server), 'DELETE /delete 只在 hard 时清图谱');
ok(/if success and request\.hard:\s*\n\s*payload\["graph_sync"\]/.test(server), 'POST /delete_memory 硬删也清图谱');
ok(/def _sync_graph_after_memory_delete/.test(server), '图清理 helper 存在');

const graphSrc = fs.readFileSync(path.join(MEMOS, 'storage', 'networkx_graph.py'), 'utf8');
ok(/tmp_path = self\.data_path \+ '\.tmp'/.test(graphSrc) && /os\.replace\(tmp_path, self\.data_path\)/.test(graphSrc), '图文件原子替换（tmp+os.replace）');
ok(/def unlink_entity_from_memory/.test(graphSrc), 'unlink 方法在存储层');

const backup = fs.readFileSync(path.join(ROOT, 'pet-runtime', 'tools', 'memos-backup.mjs'), 'utf8');
ok(/user_id: ''/.test(backup), '备份按全部 profile 导出（user_id 空串）');
ok(/sha256: /.test(backup) && /manifest\.json/.test(backup), '备份带 sha256 清单');
ok(/get_memory_by_ids/.test(backup), '备份导出完整 payload（不是 /list 的裁剪字段）');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exitCode = fail === 0 ? 0 : 1;
