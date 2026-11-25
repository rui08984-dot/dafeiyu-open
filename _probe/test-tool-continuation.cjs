#!/usr/bin/env node
/**
 * _probe/test-tool-continuation.cjs —— 大工具输出「可续读」回归（ADR-014 轨道 1-6，2026-11-24）
 *
 * 要防的回归：
 *   ① 工具结果超限只返回「已截断」三个字 → 模型永远拿不回被截掉的内容；
 *   ② artifact 写盘失败却拖垮工具（必须 null + warn，工具照常返回预览）；
 *   ③ artifact 把 key 落进磁盘（sk-* / api_key= / Bearer 必须脱敏）；
 *   ④ 清理把「最近的文件」删了，或不遵守 200 个/7 天上限；
 *   ⑤ file read 的 offset/limit 不连续（next.offset 对不上、重复/漏页）；
 *   ⑥ see 快照分页后编号变了（click #编号 会点错元素）；
 *   ⑦ 分页/截断破坏了 tool_calls 与 tool 消息配对；
 *   ⑧ 重复执行还在改内容（幂等）。
 *
 * 全部离线：PET_DATA_ROOT 指到临时目录，不写真实 data。
 * 判定：0 = 全过；非 0 = 有失败。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ⚠ 必须在 require 记录室相关模块之前设：records-path 在 require 时解析 RECORDS_DIR。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cont-'));
process.env.PET_DATA_ROOT = TMP_ROOT;

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const artifact = require(path.join(LIVE, 'js', 'ai', 'tool-result-artifact.js'));
const cap = require(path.join(LIVE, 'js', 'ai', 'tool-result-cap.js'));
const scaffold = require(path.join(LIVE, 'js', 'core', 'memory-scaffold.js'));
const Dispatch = require(path.join(LIVE, 'plugins', 'community', 'dispatch', 'index.js'));
const CodeExec = require(path.join(LIVE, 'plugins', 'built-in', 'code-executor', 'index.js'));
const WebSearch = require(path.join(LIVE, 'plugins', 'built-in', 'web-search', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
const ARTDIR = artifact.artifactDir();

(async () => {
try {
    // ── ① artifact：落盘 / 原子 / 命名 ──────────────────────────────────
    {
        const text = 'A'.repeat(5000) + '\n尾巴';
        const r = artifact.writeArtifact('file', text, { turnId: 't-turn-1' });
        ok('writeArtifact 返回 path/bytes', !!r && !!r.path && r.bytes > 5000, r && ('bytes=' + r.bytes));
        ok('落在 PET_DATA_ROOT/data/tool-artifacts 下（测试隔离）',
            !!r && path.resolve(r.path).startsWith(path.resolve(ARTDIR)), r && r.path);
        ok('文件名带 turnId 与 tool', !!r && /t-turn-1-file-/.test(path.basename(r.path)), r && path.basename(r.path));
        ok('文件内容完整', !!r && fs.readFileSync(r.path, 'utf8') === text);
        const list = artifact.listArtifacts();
        ok('listArtifacts 能看到它', list.some((x) => x.path === r.path), 'count=' + list.length);

        ok('空文本不落盘（返回 null）', artifact.writeArtifact('file', '', {}) === null);
    }

    // ── ② 脱敏：key 不落盘 ─────────────────────────────────────────────
    {
        // 故意分两段拼：公开仓的卫生扫描会把连续的 sk-<长串> 当真实 key；
        // 运行时仍是完整 key，脱敏断言不受影响（2026-11-25 发布自检）。
        const secret = 'sk-' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const r = artifact.writeArtifact('code', 'token=' + secret + '\napi_key = "abcdefgh12345678"\nAuthorization: Bearer '
            + 'eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop.qrstuvwx\n', { turnId: 't-redact' });
        const body = fs.readFileSync(r.path, 'utf8');
        ok('sk-* 被脱敏', !body.includes(secret) && body.includes('sk-***'), body.split('\n')[0]);
        ok('api_key= 被脱敏', !/abcdefgh12345678/.test(body), body.split('\n')[1]);
        ok('Bearer token 被脱敏', !/eyJhbGciOiJIUzI1NiJ9\./.test(body), body.split('\n')[2]);
        ok('redactSecrets 标了 redacted', artifact.redactSecrets(secret).redacted === true);
        ok('普通文本不被乱改', artifact.redactSecrets('这就是一句普通的话').text === '这就是一句普通的话');
    }

    // ── ③ 清理：保留最近 N 个 / 超龄删除 ────────────────────────────────
    {
        const dir = path.join(TMP_ROOT, 'cleanup-case');
        const files = [];
        for (let i = 0; i < 6; i += 1) {
            const r = artifact.writeArtifact('file', 'x' + i, { turnId: 't-clean-' + i, dir });
            files.push(r.path);
            const t = new Date(Date.now() - (6 - i) * 60000);   // 越靠后越新
            fs.utimesSync(r.path, t, t);
        }
        const res = artifact.cleanupArtifacts({ dir, keep: 3, maxAgeDays: 0 });
        ok('cleanup keep=3 删掉 3 个', res.removed === 3 && res.failed === 0, JSON.stringify(res));
        const left = artifact.listArtifacts({ dir }).map((x) => path.basename(x.path));
        ok('保留的是最新 3 个', left.length === 3 && left.some((n) => /t-clean-5/.test(n)) && !left.some((n) => /t-clean-0/.test(n)),
            left.join(','));

        const old = artifact.writeArtifact('file', 'old', { turnId: 't-old', dir });
        const tOld = new Date(Date.now() - 8 * 86400000);
        fs.utimesSync(old.path, tOld, tOld);
        const res2 = artifact.cleanupArtifacts({ dir, keep: 100, maxAgeDays: 7 });
        ok('超过 7 天的被清（哪怕没到 keep 上限）', res2.removed >= 1
            && !artifact.listArtifacts({ dir }).some((x) => x.path === old.path), JSON.stringify(res2));

        const noDir = artifact.cleanupArtifacts({ dir: path.join(TMP_ROOT, 'never-created'), keep: 3 });
        ok('目录不存在时不抛（scanned=0）', noDir.scanned === 0 && noDir.failed === 0, JSON.stringify(noDir));
    }

    // ── ④ file read：按字符分页 + 全文 artifact ─────────────────────────
    {
        const p = Object.create(Dispatch.prototype);
        const caseDir = path.join(TMP_ROOT, 'file-case');
        fs.mkdirSync(caseDir, { recursive: true });
        const big = path.join(caseDir, 'big.txt');
        const BODY = '0123456789'.repeat(3000);   // 30,000 字符
        fs.writeFileSync(big, BODY, 'utf8');
        const call = async (args) => JSON.parse(await p._fileTool(args));
        const j = (s) => String(s).split(path.sep).join('/');

        const p1 = await call({ action: 'read', path: j(big) });
        ok('默认页返回 4000 字符', p1.returned_chars === 4000 && p1.total_chars === 30000, JSON.stringify({ r: p1.returned_chars, t: p1.total_chars }));
        ok('默认页给出 next.offset=4000', p1.next_offset === 4000 && p1.next && p1.next.offset === 4000, JSON.stringify(p1.next));
        ok('默认页文字带「续读传 offset」提示', /续读传 offset=4000/.test(p1.detail), String(p1.detail).slice(-80));
        ok('大文件落 artifact 且内容完整', !!p1.artifactPath && fs.readFileSync(p1.artifactPath, 'utf8') === BODY, p1.artifactPath);

        const p2 = await call({ action: 'read', path: j(big), offset: p1.next_offset, limit: 12000 });
        // P1-3（2026-11-25）：单页 = 回执整体（detail + 信封元数据）不超上限，正文因此略小于 12000；
        //   关键是 next_offset 必须等于「这一页真正返回到的位置」——续读不许有丢失段。
        ok('第二页从 4000 开始、正文不超 12000、next 接得上',
            p2.offset === 4000 && p2.returned_chars > 0 && p2.returned_chars <= 12000
            && p2.next_offset === 4000 + p2.returned_chars
            && JSON.stringify(p2).length <= 12000,
            JSON.stringify({ o: p2.offset, r: p2.returned_chars, n: p2.next_offset, json: JSON.stringify(p2).length }));
        ok('页首字符对得上（没有重复/漂移）', p2.detail.includes(BODY.slice(4000, 4010)), p2.detail.slice(0, 40));

        const p3 = await call({ action: 'read', path: j(big), offset: 28000, limit: 4000 });
        ok('最后一页 next=null', p3.next_offset === null && p3.returned_chars === 2000, JSON.stringify({ r: p3.returned_chars, n: p3.next_offset }));

        const full = await call({ action: 'read', path: j(big), offset: 0, limit: 12000 });
        ok('单页连同信封不超预算（正文略小于 12000）',
            full.returned_chars <= 12000 && full.returned_chars > 10000
            && JSON.stringify(full).length <= 12000,
            'returned=' + full.returned_chars + ' json=' + JSON.stringify(full).length);

        // list 分页
        for (let i = 0; i < 80; i += 1) fs.writeFileSync(path.join(caseDir, 'f' + String(i).padStart(3, '0') + '.txt'), 'x');
        const l1 = await call({ action: 'list', path: j(caseDir) });
        ok('list 默认一页 60 条', (l1.entries || []).length === 60 && l1.next_offset === 60, 'entries=' + (l1.entries || []).length);
        const l2 = await call({ action: 'list', path: j(caseDir), offset: l1.next_offset });
        ok('list 第二页剩 21 条（1 + 80）且 next=null', (l2.entries || []).length === 21 && l2.next_offset === null,
            'entries=' + (l2.entries || []).length + ' next=' + l2.next_offset);
    }

    // ── ⑤ see 快照分页：编号不变、next/artifact 齐 ──────────────────────
    {
        const els = Array.from({ length: 60 }, (_, i) => ({
            rid: 'rid-' + i, type: 'Button', name: '很长的按钮名字'.repeat(20), x: 100 + i, y: 200 + i, idx: i + 1,
        }));
        const raw = JSON.stringify({ ok: true, verified: null, effect: 'readonly', detail: 'x', elements: els });
        ok('构造的快照确实超过 12k', raw.length > 12000, 'len=' + raw.length);

        const g1 = JSON.parse(Dispatch.paginateToolResult('see', {}, raw));
        ok('默认页 20 个元素', g1.elements.length === 20 && g1.page.total === 60, JSON.stringify(g1.page));
        ok('next.offset=20', g1.next && g1.next.offset === 20, JSON.stringify(g1.next));
        ok('保留全局编号（第 1 页从 #1 起）', g1.elements[0].idx === 1 && g1.elements[19].idx === 20);
        ok('detail 给出续读提示', /offset=20/.test(g1.detail), String(g1.detail).slice(-60));
        ok('超限结果落 artifact', !!g1.artifactPath && fs.existsSync(g1.artifactPath), g1.artifactPath);

        const g2 = JSON.parse(Dispatch.paginateToolResult('see', { offset: 40, limit: 20 }, raw));
        ok('第 3 页编号仍是 #41 起（click #编号 不受影响）', g2.elements[0].idx === 41 && g2.elements[19].idx === 60);
        ok('最后一页 next=null', g2.next === null && g2.page.next_offset === null);

        const small = JSON.stringify({ ok: true, detail: 'd', elements: [{ idx: 1, rid: 'a', type: 'b', name: 'c', x: 1, y: 2 }] });
        ok('小结果不传分页参数 → 原样返回（默认形状零变化）', Dispatch.paginateToolResult('see', {}, small) === small);
        const forced = JSON.parse(Dispatch.paginateToolResult('app', { limit: 1 }, JSON.stringify({ ok: true, detail: 'd', apps: ['a', 'b', 'c'] })));
        ok('显式 limit 即使结果小也分页', forced.apps.length === 1 && forced.next.offset === 1, JSON.stringify(forced.page));
    }

    // ── ⑥ code 输出：截断 + artifact + 可读提示 ─────────────────────────
    {
        const c = Object.create(CodeExec.prototype);
        const out = 'OUT'.repeat(7000);   // 21,000 字符
        const r = c._capOutput(out);
        ok('超限输出被压到 ≤12000', r.text.length <= 12000, 'len=' + r.text.length);
        ok('保留头尾', r.text.startsWith('OUTOUT') && r.text.endsWith(out.slice(-20)) && r.text.includes('已截断 21000 字符'));
        ok('给了 artifactPath', !!r.artifactPath && fs.existsSync(r.artifactPath), r.artifactPath);
        ok('标记指向 file read 续读', /file read \+ offset/.test(r.text) && /已落盘/.test(r.text), r.text.slice(-120));
        ok('artifact 里是完整输出', fs.readFileSync(r.artifactPath, 'utf8').length === out.length);
        ok('短输出不落盘', c._capOutput('短').artifactPath === null && c._capOutput('短').text === '短');
    }

    // ── ⑦ web_search 分页参数（静态 schema 断言）────────────────────────
    {
        const w = Object.create(WebSearch.prototype);
        const def = w.getTools()[0].function;
        ok('web_search 声明 offset/limit', !!(def.parameters.properties.offset && def.parameters.properties.limit),
            Object.keys(def.parameters.properties).join(','));
        ok('web_search 描述写明可续读', /续读/.test(def.description));
    }

    // ── ⑧ 配对不破 + 幂等（含续读标记）──────────────────────────────────
    {
        const messages = [
            { role: 'user', content: 'q' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'file', arguments: '{}' } }] },
            { role: 'tool', name: 'file', tool_call_id: 'c1', content: 'R'.repeat(20000) },
            { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'code', arguments: '{}' } }] },
            { role: 'tool', name: 'code', tool_call_id: 'c2', content: 'C'.repeat(20000) },
        ];
        const out = cap.enforceToolBudget(messages, 0, {});
        ok('两条超长回执都被截断', out.capped === 2, JSON.stringify(out));
        ok('tool 消息仍有 tool_call_id', messages.filter((m) => m.role === 'tool').every((m) => !!m.tool_call_id));
        ok('tool_calls 与 tool 一一对应',
            messages.filter((m) => m.role === 'assistant' && m.tool_calls).length === 2
            && messages.filter((m) => m.role === 'tool').length === 2);
        const snapshot = JSON.stringify(messages);
        const out2 = cap.enforceToolBudget(messages, 0, {});
        ok('第二次执行幂等（内容零变化）', out2.capped === 0 && out2.stubbed === 0 && JSON.stringify(messages) === snapshot);
    }

    // ── ⑨ artifact 指针不进记忆索引 ─────────────────────────────────────
    {
        const r = artifact.writeArtifact('file', 'x', { turnId: 't-noise' });
        const lines = [
            '[工具输出过长，已截断 9108 字符（上限 12000）；完整结果见 runtime.log 或工具 artifact（tool-artifacts/），可用 offset/limit 或 next 续读]',
            '完整内容已落盘：' + r.path + '（可用 file read + offset 分段读）',
            '…还有 6000 字符；续读传 offset=16000 limit=12000',
        ];
        ok('截断标记是噪声', scaffold.isNoise(lines[0], 'tool') === true);
        ok('artifact 路径是噪声', scaffold.isNoise(lines[1], 'tool') === true);
        ok('续读提示是噪声', scaffold.isNoise(lines[2], 'tool') === true);
        ok('普通用户文本不误杀', scaffold.isNoise('我今天想去看电影，顺便买点零食', 'user') === false);
    }

    // ── ⑩ artifact 内容哈希去重（第四轮 P2 根因修）──────────────────────
    // 病根：分页读大文件时**每一页**都会把同一份全文再写一次 artifact → 磁盘被同内容塞满，
    // 还会把别的 artifact 挤掉。修法：文件名带 sha1 前 12 位，同内容复用同一份。
    {
        const dir = path.join(TMP_ROOT, 'dedupe-case');
        const body = 'X'.repeat(30000);
        const a = artifact.writeArtifact('file', body, { turnId: 't-d1', dir });
        const b = artifact.writeArtifact('file', body, { turnId: 't-d2', dir });
        const c = artifact.writeArtifact('file', body, { turnId: 't-d3', dir });
        ok('同内容写 3 次（不同 turnId）→ 复用同一路径', !!a && a.path === b.path && b.path === c.path, a && a.path);
        ok('同内容写 3 次 → 磁盘只有 1 份', artifact.listArtifacts({ dir }).length === 1,
            'count=' + artifact.listArtifacts({ dir }).length);
        ok('复用会标 deduped（第 2/3 次）', !!b && b.deduped === true && !!c && c.deduped === true);
        ok('文件名带内容哈希（sha1 前 12 位）',
            !!a && new RegExp('-' + artifact.contentHash(body) + '\\.txt$').test(path.basename(a.path)),
            a && path.basename(a.path));
        ok('复用文件内容仍完整', !!a && fs.readFileSync(a.path, 'utf8') === body);

        const d = artifact.writeArtifact('file', body + 'y', { turnId: 't-d4', dir });
        ok('内容不同 → 另写一份（共 2 份）',
            !!d && d.path !== a.path && artifact.listArtifacts({ dir }).length === 2,
            'count=' + artifact.listArtifacts({ dir }).length);
        ok('清理仍按数量（keep=1 只留 1 份）',
            artifact.cleanupArtifacts({ dir, keep: 1, maxAgeDays: 0 }).removed === 1
            && artifact.listArtifacts({ dir }).length === 1);
    }

    // ── ⑪ file read 单页上限跟随 config.context.tool_result_max_chars ──
    // 病根：单页写死 12000；把 tool_result_max_chars 改小后每页又被 cap 截一刀，
    // 模型按 next.offset 续读也拼不回完整内容。
    {
        const caseDir = path.join(TMP_ROOT, 'file-cap-case');
        fs.mkdirSync(caseDir, { recursive: true });
        const body = '0123456789'.repeat(3000);          // 30,000 字符（>12000，才测得到上限）
        const big = path.join(caseDir, 'cap.txt');
        fs.writeFileSync(big, body, 'utf8');
        const j = (s) => String(s).split(path.sep).join('/');
        const mk = (cfg) => {
            const p = Object.create(Dispatch.prototype);
            p.context = { getConfig: () => cfg };
            return p;
        };

        const p2k = mk({ context: { tool_result_max_chars: 2000 } });
        const r2k = JSON.parse(await p2k._fileTool({ action: 'read', path: j(big), limit: 12000 }));
        ok('config=2000 → 回执整体不超 2000（正文按信封开销收小，不再被 12000 撑回去）',
            r2k.returned_chars <= 2000 && r2k.returned_chars > 0 && r2k.limit === r2k.returned_chars
            && r2k.next_offset === r2k.returned_chars && JSON.stringify(r2k).length <= 2000,
            JSON.stringify({ r: r2k.returned_chars, limit: r2k.limit, next: r2k.next_offset, json: JSON.stringify(r2k).length }));

        const r2kDefault = JSON.parse(await p2k._fileTool({ action: 'read', path: j(big) }));
        ok('config=2000 且不传 limit → 默认页也不超 2000', r2kDefault.returned_chars <= 2000,
            String(r2kDefault.returned_chars));

        const pBig = mk({});
        const r12k = JSON.parse(await pBig._fileTool({ action: 'read', path: j(big), limit: 50000 }));
        ok('无 config → 上限仍是 12000（回执整体）', r12k.returned_chars <= 12000 && r12k.returned_chars > 10000
            && JSON.stringify(r12k).length <= 12000,
            String(r12k.returned_chars));

        const pNoCtx = Object.create(Dispatch.prototype);   // 完全没有 context（旧调用方/单测）
        const rNoCtx = JSON.parse(await pNoCtx._fileTool({ action: 'read', path: j(big), limit: 50000 }));
        ok('没有 context → 兜底 12000', rNoCtx.returned_chars <= 12000 && rNoCtx.returned_chars > 10000,
            String(rNoCtx.returned_chars));

        // 纯函数钳位：下限 1000 / 上限 12000 / 缺失或非法值回落 12000
        ok('fileReadPageCap：改小到 500 → 钳到 1000',
            Dispatch.fileReadPageCap({ context: { tool_result_max_chars: 500 } }) === 1000,
            String(Dispatch.fileReadPageCap({ context: { tool_result_max_chars: 500 } })));
        ok('fileReadPageCap：改大到 50000 → 钳到 12000',
            Dispatch.fileReadPageCap({ context: { tool_result_max_chars: 50000 } }) === 12000,
            String(Dispatch.fileReadPageCap({ context: { tool_result_max_chars: 50000 } })));
        ok('fileReadPageCap：无 config / null / 非法值 → 12000',
            Dispatch.fileReadPageCap({}) === 12000
            && Dispatch.fileReadPageCap(null) === 12000
            && Dispatch.fileReadPageCap({ context: { tool_result_max_chars: 'abc' } }) === 12000);
    }
} finally {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
}

console.log('\n' + (fail ? '✗' : '✓') + ' 工具续读：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
})();
