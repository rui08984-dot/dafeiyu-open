#!/usr/bin/env node
/**
 * _probe/test-memory-provenance.cjs — B2 记忆来源标注（2026-11-23）
 *
 * 现场：AddMemoryRequest 只有 messages/user_id，写进 MemOS 的记忆分不清
 * 「用户让记的 / 随手记的 / 反思猜的 / 一起看总结的」；冲突时无法仲裁。
 *
 * 本探针盯住的契约：
 *   ① /add 与 /add_raw 接受 source/turn_id/confidence；脏值不写库（不抛、不超长）
 *   ② 三个字段进 payload，并且 /memory、/get_memory_by_ids 的扁平结果能带出来
 *   ③ /search 把 payload 里的来源提升到结果顶层（注入侧能直接读）
 *   ④ 六个写入口都带 source 代码：remember/note/explicit/watch-screen/evolve
 *   ⑤ memos 工具搜索输出带【来源:…】人话标签
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const PY = 'py';

let pass = 0;
let fail = 0;
function ok(cond, name, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name); }
    else { fail += 1; console.log('  ✗ ' + name + (detail ? '  [' + detail + ']' : '')); }
}

console.log('test-memory-provenance');

// ① + ② Python 侧真跑
const py = [
    'import sys, json',
    'sys.path.insert(0, ".")',
    'import api.memos_api_server_v2 as s',
    'req = s.AddMemoryRequest(messages=[{"role":"user","content":"hi"}], source="evolve", turn_id="turn-1", confidence=0.7)',
    'raw = s.AddRawMemoryRequest(messages=[{"content":"x"}], source="note", confidence=0.4)',
    'payload = s._apply_provenance({}, req.source, req.turn_id, req.confidence)',
    'dirty = s._apply_provenance({}, "x" * 200, None, "not-a-number")',
    'flat = s._flatten_memory({"id": "1", "payload": payload})',
    'print(json.dumps({',
    '  "req": [req.source, req.turn_id, req.confidence],',
    '  "raw": [raw.source, raw.confidence],',
    '  "payload": payload,',
    '  "dirty_source_len": len(dirty.get("source", "")),',
    '  "dirty_conf": dirty.get("confidence", "missing"),',
    '  "flat": {k: flat.get(k) for k in ("source", "turn_id", "confidence")}',
    '}))',
].join('\n');
let out = {};
try {
    const stdout = execFileSync(PY, ['-I', '-c', py], { cwd: MEMOS, encoding: 'utf8', timeout: 60000 });
    out = JSON.parse(stdout.trim().split(/\r?\n/).pop());
} catch (e) {
    console.error('python probe failed:', e.message);
}

ok(JSON.stringify(out.req) === '["evolve","turn-1",0.7]', '/add 接受三个来源字段', JSON.stringify(out.req));
ok(JSON.stringify(out.raw) === '["note",0.4]', '/add_raw 接受来源字段', JSON.stringify(out.raw));
ok(out.payload && out.payload.source === 'evolve' && out.payload.turn_id === 'turn-1' && out.payload.confidence === 0.7, 'payload 写入三个字段', JSON.stringify(out.payload));
ok(out.dirty_source_len === 64, 'source 超长截断到 64', String(out.dirty_source_len));
ok(out.dirty_conf === 'missing', '非法 confidence 丢弃（不写脏值）', String(out.dirty_conf));
ok(out.flat && out.flat.source === 'evolve' && out.flat.turn_id === 'turn-1' && out.flat.confidence === 0.7, '扁平结果带出来源', JSON.stringify(out.flat));

// ③ /search 顶层提升（静态断言）
const server = fs.readFileSync(path.join(MEMOS, 'api', 'memos_api_server_v2.py'), 'utf8');
ok(/_apply_provenance\(payload, request\.source, request\.turn_id, request\.confidence\)/.test(server), '/add 接线 provenance');
ok((server.match(/_apply_provenance\(payload, request\.source/g) || []).length >= 2, '/add_raw 也接线 provenance');
ok(/for meta_key in \('source', 'turn_id', 'confidence'\)/.test(server), '/search 把来源提升到顶层');

// ④ 六个写入口
const entries = [
    ['plugins/community/memory-recall/index.js', "source: 'remember'"],
    ['plugins/built-in/note/index.js', "source: 'note'"],
    ['plugins/built-in/memos/tools.js', "source: 'explicit'"],
    ['plugins/community/watch-screen/index.js', "source: 'watch-screen'"],
    ['plugins/community/memory-evolve/index.js', "source: 'evolve'"],
];
for (const [rel, needle] of entries) {
    const src = fs.readFileSync(path.join(APP, rel), 'utf8');
    ok(src.includes(needle), rel + ' 带 ' + needle, 'not found');
}
const evolveSrc = fs.readFileSync(path.join(APP, 'plugins/community/memory-evolve/index.js'), 'utf8');
ok((evolveSrc.match(/source: 'evolve'/g) || []).length >= 2, 'memory-evolve 两个写入口都带来源');

// ⑤ 人话标签
const toolsSrc = fs.readFileSync(path.join(APP, 'plugins/built-in/memos/tools.js'), 'utf8');
ok(/SOURCE_LABEL\s*=/.test(toolsSrc) && /'watch-screen': '一起看总结'/.test(toolsSrc), '来源代码→人话映射存在');
ok(/【来源:\$\{sourceLabel\}】/.test(toolsSrc), '搜索输出带【来源:…】标签');

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exitCode = fail === 0 ? 0 : 1;
