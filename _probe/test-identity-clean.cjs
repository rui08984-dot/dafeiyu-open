#!/usr/bin/env node
/**
 * _probe/test-identity-clean.cjs —— 自我身份清理回归（2026-11-23）
 *
 * 断言：
 *   ① 用户可见 / 自我认知出口里不再有旧自称「肥牛 / Fake Neuro / fake neuro」
 *      （B/C 类保留项走 allowlist：user_id、路径、上游插件描述、许可证文档）
 *   ② MemOS `/add` 的角色标签是「大肥鱼」，user_id 仍是 feiniu_default
 *   ③ rename-self-identity 的 dry-run：只命中预期样例、幂等、不碰 user_id
 *   ④ 误改防护：食物「肥牛卷/火锅/饭/片」与上游名「肥牛插件包 / fake_neuro_audio」不动
 *
 * 本测试全部在临时目录跑迁移，不读写真实 data。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const TOOL = path.join(ROOT, 'pet-runtime', 'tools', 'rename-self-identity.mjs');
const PY = process.env.PET_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function readApp(rel) { return fs.readFileSync(path.join(APP, rel), 'utf8'); }

function runTool(args, env) {
    const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...(env || {}) } });
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function runToolAsync(args, env) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [TOOL, ...args], {
            cwd: ROOT,
            env: { ...process.env, ...(env || {}) },
            windowsHide: true,
        });
        let out = '';
        const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* gone */ } }, 120000);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('close', (status) => { clearTimeout(timer); resolve({ status, out }); });
    });
}
function parseJson(out) {
    const i = out.indexOf('{');
    if (i < 0) throw new Error('没有 JSON 输出：' + out.slice(0, 200));
    return JSON.parse(out.slice(i));
}
function tmpRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-identity-'));
}
function findManifest(dir) {
    let hit = null;
    try {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, d.name);
            if (d.isDirectory()) hit = hit || findManifest(p);
            else if (d.name === 'MANIFEST.json') hit = p;
        }
    } catch (_) { /* ignore */ }
    return hit;
}

function startGraphStub() {
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push(req.method + ' ' + req.url);
        res.setHeader('Content-Type', 'application/json');
        if (req.url.startsWith('/list')) return res.end(JSON.stringify({ memories: [] }));
        if (req.url.startsWith('/graph/consistency')) {
            return res.end(JSON.stringify({
                status: 'ok',
                graph: {},
                suspected_old_self_count: 1,
                suspected_old_self: [{ id: 'abcdef1234567890', name: '肥牛', entity_type: 'person' }],
            }));
        }
        if (req.url.startsWith('/graph/entities')) return res.end(JSON.stringify({ entities: [] }));
        res.statusCode = 404;
        res.end('{}');
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, calls, url: 'http://127.0.0.1:' + server.address().port });
        });
    });
}

const ENDPOINT_PROBE = String.raw`
import sys, os, json, tempfile, shutil
sys.path.insert(0, '.')
from storage.networkx_graph import NetworkXGraphClient
from fastapi import FastAPI
from fastapi.testclient import TestClient
import api.memos_api_server_v2 as srv

res = {"pass": 0, "fail": 0, "errors": []}
def ok(name, cond, detail=""):
    if cond:
        res["pass"] += 1
    else:
        res["fail"] += 1
        res["errors"].append(name + (": " + str(detail) if detail else ""))

def client_for(g):
    srv.neo4j_client = g
    srv._graph_memory_id_list = lambda: []
    app = FastAPI()
    app.post('/graph/rename-entity')(srv.graph_rename_entity)
    app.get('/graph/consistency')(srv.graph_consistency)
    return TestClient(app)

tmp = tempfile.mkdtemp()
try:
    p = os.path.join(tmp, 'g.json')
    g = NetworkXGraphClient(data_path=p)
    g.add_entity('id-old-123456', 'ai', '肥牛', properties={'source_memory_ids': ['m1']})
    g.add_entity('id-master', 'person', '主人')
    g.add_relation('id-master', 'id-old-123456', 'owns', properties={'source_memory_id': 'm1'})
    g.add_relation('id-old-123456', 'id-master', 'likes')
    c = client_for(g)
    r = c.post('/graph/rename-entity', json={'from': '肥牛', 'to': '大肥鱼'})
    j = r.json() if str(r.headers.get('content-type', '')).startswith('application/json') else {}
    ok('rename 200', r.status_code == 200, r.text)
    ok('renamed=1', j.get('renamed') == 1, j)
    ok('id 是 8 位前缀', len(str(j.get('id') or '')) == 8, j.get('id'))
    ok('node id 保留', 'id-old-123456' in g.graph.nodes)
    ok('name=大肥鱼', g.graph.nodes['id-old-123456'].get('name') == '大肥鱼', g.graph.nodes['id-old-123456'])
    ok('边数不变', len(g.graph.edges) == 2, len(g.graph.edges))
    ok('边属性保留', g.graph.edges['id-master', 'id-old-123456'].get('source_memory_id') == 'm1', dict(g.graph.edges['id-master', 'id-old-123456']))
    ok('不碰向量库', srv.qdrant_client is None)
    r = c.post('/graph/rename-entity', json={'from': '肥牛', 'to': '大肥鱼'})
    ok('第二次 404（幂等由调用方）', r.status_code == 404, r.status_code)
    r = c.post('/graph/rename-entity', json={'from': '不存在', 'to': 'x'})
    ok('不存在 404', r.status_code == 404, r.status_code)
    r = c.post('/graph/rename-entity', json={'from': '主人', 'to': '大肥鱼'})
    ok('目标重名 409', r.status_code == 409, r.status_code)
    r = c.post('/graph/rename-entity', json={'from': '', 'to': 'x'})
    ok('空 from 400', r.status_code == 400, r.status_code)

    g2 = NetworkXGraphClient(data_path=os.path.join(tmp, 'g2.json'))
    g2.add_entity('dup1', 'ai', '肥牛')
    g2.add_entity('dup2', 'ai', '肥牛')
    c2 = client_for(g2)
    r = c2.post('/graph/rename-entity', json={'from': '肥牛', 'to': '大肥鱼'})
    ok('from 重名 409', r.status_code == 409, r.status_code)

    g3 = NetworkXGraphClient(data_path=os.path.join(tmp, 'g3.json'))
    g3.add_entity('abcdef123456', 'ai', '肥牛')
    c3 = client_for(g3)
    r = c3.get('/graph/consistency')
    j = r.json()
    ok('consistency 200', r.status_code == 200, r.text)
    ok('疑似旧自称 1 个', j.get('suspected_old_self_count') == 1, j.get('suspected_old_self'))
    s = (j.get('suspected_old_self') or [{}])[0]
    ok('疑似 id 只有 8 位', len(str(s.get('id') or '')) == 8, s.get('id'))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print(json.dumps(res, ensure_ascii=False))
`;

function runEndpointProbe() {
    const r = spawnSync(PY, ['-I', '-W', 'ignore', '-c', ENDPOINT_PROBE], { cwd: MEMOS, encoding: 'utf8', timeout: 120000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    let json = null;
    try { json = JSON.parse(lines[lines.length - 1]); } catch (_) { json = null; }
    return { status: r.status, out, json };
}

(async () => {
    try {
        // ── ① 源码里的自我认知 / 用户可见出口 ───────────────────────────
        const v2 = read('_incoming/my-neuro/plugins-dlc/memos/memos_system/api/memos_api_server_v2.py');
        const v1 = read('_incoming/my-neuro/plugins-dlc/memos/memos_system/api/memos_api_server.py');
        ok('MemOS v2 /add 角色标签=大肥鱼', /role_label = "主人" if role == 'user' else "大肥鱼"/.test(v2)
            && !/else "肥牛"/.test(v2));
        ok('MemOS v2 记忆提取 prompt 身份=大肥鱼', /- "大肥鱼"是AI助手/.test(v2) && !/- "肥牛"是AI助手/.test(v2));
        ok('MemOS v1 /add 角色标签=大肥鱼', /role_label = "主人" if role == 'user' else "大肥鱼"/.test(v1));
        ok('MemOS v1 加工提示=【大肥鱼说】', /role_hint = "【大肥鱼说】"/.test(v1) && !/【肥牛说】/.test(v1));
        ok('MemOS user_id 仍是 feiniu_default（B 类不改）', /USER_ID = "feiniu_default"/.test(v2));

        const inputRouter = readApp('js/ai/conversation/InputRouter.js');
        ok('记忆库写入标签=【大肥鱼】', /【大肥鱼】: \$\{lastAIMsg\.content\}/.test(inputRouter)
            && !/【Fake Neuro】/.test(inputRouter));
        ok('聊天框助手名=大肥鱼', /role === 'user' \? '你' : '大肥鱼'/.test(inputRouter));

        const diary = readApp('js/ai/DiaryManager.js');
        ok('日记文件头=大肥鱼的日记', /大肥鱼的日记/.test(diary) && !/肥牛的日记/.test(diary));

        const mood = readApp('js/ai/MoodChatModule.js');
        ok('心情评估 prompt 不再叫 fake neuro（肥牛）', !/fake neuro（肥牛）/.test(mood) && /评估大肥鱼/.test(mood));

        const diaryCfg = readApp('plugins/built-in/diary/plugin_config.json');
        ok('日记提示词=大肥鱼身份', !/肥牛/.test(diaryCfg) && /以大肥鱼的身份/.test(diaryCfg));

        const profile = readApp('plugins/community/user-profile/index.js');
        ok('用户画像 prompt 基于大肥鱼的长期记忆', /基于大肥鱼的长期记忆/.test(profile) && !/基于肥牛的长期记忆/.test(profile));

        for (const f of ['js/voice/tts-factory.js', 'js/voice/tts-processor.js', 'js/voice/tts-playback-engine.js', 'js/voice/volcengine-streaming.js']) {
            const s = readApp(f);
            ok('字幕/聊天标签无 Fake Neuro：' + f, !/Fake Neuro/.test(s));
        }
        const init = readApp('js/app-initializer.js');
        ok('兜底自我介绍=大肥鱼', !/fake neuro/i.test(init) && /我叫大肥鱼/.test(init));

        ok('WebUI 副标题=管理大肥鱼各项服务与配置', /管理大肥鱼各项服务与配置/.test(readApp('webui/templates/index_new.html')));
        ok('控制中心插件标签=大肥鱼棋盘游戏', /'feiniu-board-game': '大肥鱼棋盘游戏'/.test(readApp('control-main.js')));

        const audioDir = path.join(APP, 'fake_neuro_audio', 'Reference_audio');
        ok('参考音频已改名 大肥鱼.wav（旧文件不存在）',
            fs.existsSync(path.join(audioDir, '大肥鱼.wav')) && !fs.existsSync(path.join(audioDir, '肥牛.wav')));
        ok('参考音频引用已同步（asr 测试/说明/上传脚本）',
            !/肥牛\.wav/.test(read('asr/test_asr.py')) && !/肥牛\.wav/.test(read('asr/README.md'))
            && !/肥牛\.wav/.test(readApp('fake_neuro_audio/process_audio.py')));

        // allowlist：B/C 类必须**原样保留**（证明是分类迁移，不是一刀切删除）
        ok('保留 user_id=feiniu_default（app 侧）', /user_id: 'feiniu_default'/.test(readApp('plugins/built-in/memos/memos-client.js')));
        ok('保留模型路径 2D/肥牛（B 类）', /2D\/肥牛/.test(readApp('js/model/model-setup.js')));
        ok('保留情绪配置角色键「肥牛」（B 类）', /"肥牛"\s*:/.test(readApp('emotion_actions.json')));
        ok('保留上游插件描述（C 类）', /肥牛/.test(readApp('plugins/plugin-house/plugin_hub.json')));

        // ── ② 迁移函数：预期命中 + 幂等 + 不碰 user_id ─────────────────
        const mod = await import('file://' + TOOL.replace(/\\/g, '/'));
        const rw = mod.rewriteSelfIdentity;
        const cases = [
            ['【Fake Neuro】: 你好', '【大肥鱼】: 你好'],
            ['我是肥牛，桌面上的假神经AI宠物', '我是大肥鱼，桌面上的假神经AI宠物'],
            ['主人与肥牛一起看完屏幕', '主人与大肥鱼一起看完屏幕'],
            ['并询问肥牛是否还记得', '并询问大肥鱼是否还记得'],
            ['肥牛调侃该记进病历', '大肥鱼调侃该记进病历'],
            ['[2026年11月20日] 肥牛的日记', '[2026年11月20日] 大肥鱼的日记'],
            ['请以fake neuro（肥牛）的身份写日记', '请以大肥鱼的身份写日记'],
            ['肥牛说：今天不想动', '大肥鱼说：今天不想动'],
        ];
        for (const [before, after] of cases) {
            const got = rw(before).text;
            ok('迁移样例：' + before.slice(0, 22), got === after, got === after ? '' : 'got=' + got);
        }
        const once = rw('【Fake Neuro】: 我是肥牛，主人与肥牛一起看肥牛的日记').text;
        ok('迁移幂等（第二次 0 命中）', rw(once).changed === false && once === rw(once).text);
        const idText = "{ user_id: 'feiniu_default', path: 'fake_neuro_audio/Reference_audio/肥牛.wav' }";
        ok('迁移不碰 user_id / fake_neuro_audio / 音频文件名', rw(idText).text === idText);
        const food = ['今天吃肥牛卷', '肥牛火锅真香', '点了一份肥牛饭', '肥牛片下锅', '这家肥牛说不上好吃', '肥牛价格涨了'];
        ok('食物语义不误改（卷/火锅/饭/片/说不上/价格）', food.every((s) => rw(s).text === s), food.filter((s) => rw(s).text !== s).join(' | '));
        ok('上游插件名不误改（肥牛插件包）', rw('这不是肥牛插件包').text === '这不是肥牛插件包');

        // ── ③ dry-run 只命中预期样例（临时目录，不碰真实数据）──────────
        const tmp = tmpRoot();
        const dataDir = path.join(tmp, '_incoming', 'my-neuro', 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        const memoryLog = path.join(dataDir, '记忆库.txt');
        const diaryFile = path.join(dataDir, 'AI日记.txt');
        const userMem = path.join(dataDir, '用户记忆.json');
        const memoryText = '【Fake Neuro】: 我是肥牛\n今天吃肥牛卷，真香\nuser_id: feiniu_default\n';
        const diaryText = '[2026-11-20] 肥牛的日记\n今天把肥牛火锅吃了\n';
        const userMemText = '{"items":[{"content":"主人喜欢猫"}]}';
        fs.writeFileSync(memoryLog, memoryText, 'utf8');
        fs.writeFileSync(diaryFile, diaryText, 'utf8');
        fs.writeFileSync(userMem, userMemText, 'utf8');

        const d1 = runTool(['--root', tmp, '--offline', '--json']);
        const j1 = parseJson(d1.out);
        ok('dry-run 退出码 0', d1.status === 0, 'status=' + d1.status);
        ok('dry-run 预期命中数=3（记忆库2 + 日记1）', j1.totalPlanned === 3, 'total=' + j1.totalPlanned);
        const memPlan = (j1.files || []).find((f) => f.name === '记忆库.txt');
        ok('dry-run 报告把食物「肥牛卷」列为 residual（不自动改）', memPlan && memPlan.residual.niuniu === 1,
            memPlan ? JSON.stringify(memPlan.residual) : 'missing');
        ok('dry-run 不写文件', fs.readFileSync(memoryLog, 'utf8') === memoryText && fs.readFileSync(diaryFile, 'utf8') === diaryText);
        const d2 = runTool(['--root', tmp, '--offline', '--json']);
        ok('dry-run 幂等（再跑仍 3 条）', parseJson(d2.out).totalPlanned === 3);

        // ── ④ --apply 只在临时目录验证：替换正确、食物不动、再跑为 0 ──────
        const a1 = runTool(['--root', tmp, '--offline', '--apply', '--json']);
        ok('临时目录 --apply 退出码 0', a1.status === 0, 'status=' + a1.status);
        const afterMem = fs.readFileSync(memoryLog, 'utf8');
        const afterDiary = fs.readFileSync(diaryFile, 'utf8');
        ok('apply 后自我称呼=大肥鱼', afterMem.startsWith('【大肥鱼】: 我是大肥鱼\n') && afterDiary.includes('大肥鱼的日记'));
        ok('apply 后食物词不动', afterMem.includes('吃肥牛卷') && afterDiary.includes('肥牛火锅'));
        ok('apply 后 user_id 不动', afterMem.includes("user_id: feiniu_default"));
        ok('apply 时备份改动的文件（files/MANIFEST.json 存在）', !!findManifest(path.join(dataDir, '记忆备份')));
        const a2 = runTool(['--root', tmp, '--offline', '--apply', '--json']);
        ok('apply 幂等（第二次 0 条）', parseJson(a2.out).totalPlanned === 0, 'total=' + parseJson(a2.out).totalPlanned);
        fs.rmSync(tmp, { recursive: true, force: true });

        // ── ⑤ 图谱端点：只改名、不删边、重名/缺失拒绝（临时图 + TestClient）──
        const ep = runEndpointProbe();
        ok('图谱端点探针退出码 0', ep.status === 0, 'status=' + ep.status);
        ok('图谱端点断言全过', !!ep.json && ep.json.fail === 0,
            ep.json ? JSON.stringify(ep.json.errors) : ep.out.slice(-400));
        if (ep.json) console.log('    端点探针：通过 ' + ep.json.pass + '，失败 ' + ep.json.fail);

        // ── ⑥ 图谱 dry-run：只读统计 name=肥牛，只打 id 前缀 ─────────────
        const gstub = await startGraphStub();
        const tmp3 = tmpRoot();
        fs.mkdirSync(path.join(tmp3, '_incoming', 'my-neuro', 'data'), { recursive: true });
        const g1 = await runToolAsync(['--root', tmp3, '--json'], { MEMOS_API: gstub.url, IDENTITY_DEBUG: '' });
        const gj = parseJson(g1.out);
        ok('图谱 dry-run 退出码 0', g1.status === 0, 'status=' + g1.status);
        ok('图谱 dry-run 命中 1 个 name=肥牛', !!gj.graph && gj.graph.skipped === false
            && gj.graph.exact.length === 1 && gj.totalPlanned === 1, JSON.stringify(gj.graph));
        ok('图谱 dry-run 只打 id 前缀（8 位）', gj.graph.exact[0].id === 'abcdef12' && gj.graph.exact[0].id.length === 8,
            gj.graph.exact[0].id);
        ok('图谱 dry-run 只读（无 POST）', gstub.calls.every((c) => c.startsWith('GET')), gstub.calls.join(', '));
        await new Promise((resolve) => gstub.server.close(resolve));
        fs.rmSync(tmp3, { recursive: true, force: true });
    } catch (e) {
        fail += 1;
        console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    process.exit(fail === 0 ? 0 : 1);
})();
