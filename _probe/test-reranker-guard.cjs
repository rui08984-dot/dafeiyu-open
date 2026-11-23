#!/usr/bin/env node
/**
 * _probe/test-reranker-guard.cjs — B4 reranker 配置陷阱（2026-11-23）
 *
 * 现场：memos_config.json 的 reranker 指向 8090 嵌入服务（model=qwen3-embed），
 * 但那个端点没有 /v1/rerank（实测 HTTP 501）。RemoteCrossEncoder 构造时不联网、
 * is_available() 只看熔断器，于是启动日志写「已就绪」，第一次用户检索才逐个失败。
 *
 * 本探针盯住的契约：
 *   ① 配置自洽：enable_reranker=false；provider=local；不再把嵌入模型当 reranker；
 *      auto_download=false（避免误开时静默拉 2GB）
 *   ② Reranker.probe()：成功 → {ok:true,scores}；端点 501 → {ok:false,error}；
 *      model=None → {ok:false,error:'no_model'}（绝不抛）
 *   ③ 启动接线：startup_event 里调 probe()，失败则 reranker=None 并记原因
 *   ④ /health：reranker 段带 probe_error 与 effective 字段
 *
 * 不启动服务、不联网：probe 用假 model 注入。
 */
'use strict';

const fs = require('fs');
const path = require('path');
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

console.log('test-reranker-guard');

// ① 配置自洽
const cfgPath = path.join(MEMOS, 'config', 'memos_config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const search = cfg.search || {};
const api = search.reranker_api || {};
ok(search.enable_reranker === false, 'enable_reranker 默认关闭', String(search.enable_reranker));
ok(String(search.reranker_provider || '').toLowerCase() === 'local', 'provider=local（没有可用 rerank 端点）', String(search.reranker_provider));
ok(search.reranker_auto_download === false, 'auto_download=false（不静默拉模型）', String(search.reranker_auto_download));
ok(!api.model || !String(api.model).includes('embed'), 'reranker_api 不再把嵌入模型当重排模型', String(api.model));
ok(!api.base_url || !String(api.base_url).includes('8090'), 'reranker_api 不再指向嵌入服务 8090', String(api.base_url));

// ② probe() 三态（Python 侧真跑）
const pyScript = [
    'import sys, json',
    'sys.path.insert(0, ".")',
    'from utils.search_utils import Reranker',
    'class Ok:',
    '    def predict(self, pairs): return [0.9 for _ in pairs]',
    'class Bad:',
    '    def predict(self, pairs): raise RuntimeError("HTTP 501 not implemented")',
    'r = Reranker.__new__(Reranker)',
    'r.model = Ok(); a = r.probe()',
    'r.model = Bad(); b = r.probe()',
    'r.model = None; c = r.probe()',
    'print(json.dumps({"ok": a, "bad": b, "none": c}))',
].join('\n');
const pyOut = execFileSync(PY, ['-I', '-c', pyScript], { cwd: MEMOS, encoding: 'utf8', timeout: 30000 });
const probe = JSON.parse(pyOut.trim().split(/\r?\n/).pop());
ok(probe.ok && probe.ok.ok === true && Array.isArray(probe.ok.scores), 'probe 成功返回 ok+scores', JSON.stringify(probe.ok));
ok(probe.bad && probe.bad.ok === false && /501/.test(probe.bad.error || ''), 'probe 端点 501 返回 ok:false+原因', JSON.stringify(probe.bad));
ok(probe.none && probe.none.ok === false && probe.none.error === 'no_model', 'probe 无模型返回 no_model（不抛）', JSON.stringify(probe.none));

// ⑤ 插件启动同步不得把 reranker 绑回嵌入端点（真跑 buildBackendEmbeddingConfig）
//    2026-11-23 门禁抓到的真回归：memos_config 改好后，插件一启动又写回 api+8090。
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { buildBackendEmbeddingConfig } = require(path.join(APP, 'plugins', 'built-in', 'memos', 'embedding-config.js'));
const synced = buildBackendEmbeddingConfig({
    backend_embedding: {
        provider: 'api',
        api_base_url: 'http://127.0.0.1:8090/v1',
        api_key: 'local',
        embedding_model: 'qwen3-embed',
        rerank_model: 'qwen3-embed',
    },
}, { search: { reranker_provider: 'api', reranker_api: { base_url: 'http://127.0.0.1:8090/v1', model: 'qwen3-embed' } } });
ok(synced.embedding && synced.embedding.provider === 'api', '嵌入仍按 api 同步（不受影响）', JSON.stringify(synced.embedding && synced.embedding.provider));
ok(synced.search && synced.search.reranker_provider === 'local', '重排 provider 不被嵌入 provider 带走', String(synced.search && synced.search.reranker_provider));
ok(!(synced.search && synced.search.reranker_api), '残留的旧 reranker_api 被清掉', JSON.stringify(synced.search && synced.search.reranker_api));

const explicit = buildBackendEmbeddingConfig({
    backend_embedding: {
        provider: 'api',
        api_base_url: 'http://127.0.0.1:8090/v1',
        reranker_provider: 'api',
        rerank_api_base_url: 'http://127.0.0.1:9999/v1',
        rerank_api_key: 'k',
        rerank_model: 'BAAI/bge-reranker-v2-m3',
    },
}, {});
ok(explicit.search && explicit.search.reranker_provider === 'api'
    && explicit.search.reranker_api && explicit.search.reranker_api.base_url === 'http://127.0.0.1:9999/v1',
'显式配置了独立 rerank 端点时仍可走 api', JSON.stringify(explicit.search));

const pluginCfg = JSON.parse(fs.readFileSync(path.join(APP, 'plugins', 'built-in', 'memos', 'plugin_config.json'), 'utf8'));
const pSearch = (pluginCfg.backend_search && pluginCfg.backend_search.fields) || {};
const pEmbed = (pluginCfg.backend_embedding && pluginCfg.backend_embedding.fields) || {};
ok(pSearch.reranker_auto_download && pSearch.reranker_auto_download.value === false, '插件默认不自动下载 2GB 精排模型', String(pSearch.reranker_auto_download && pSearch.reranker_auto_download.value));
ok(pEmbed.rerank_model && pEmbed.rerank_model.value !== 'qwen3-embed', '插件里的精排模型名不再填嵌入模型', String(pEmbed.rerank_model && pEmbed.rerank_model.value));

// ③ 启动接线 + ④ health 字段（静态断言：防止以后被改回“只信 is_available”）
const server = fs.readFileSync(path.join(MEMOS, 'api', 'memos_api_server_v2.py'), 'utf8');
ok(/reranker\.probe\(\)/.test(server), 'startup_event 调用了 reranker.probe()');
ok(/reranker_probe_error\s*=\s*str\(probe\.get\('error'\)/.test(server), '探活失败会记录原因并停用');
ok(/"probe_error":\s*reranker_probe_error/.test(server), '/health.reranker 暴露 probe_error');
ok(/"effective":\s*bool\(reranker and reranker\.is_available\(\)\)/.test(server), '/health.reranker 暴露 effective');

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ' ' + pass + '/' + (pass + fail));
process.exitCode = fail === 0 ? 0 : 1;
