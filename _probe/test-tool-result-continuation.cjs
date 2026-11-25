#!/usr/bin/env node
/**
 * _probe/test-tool-result-continuation.cjs —— 12k 截断 × 续读通道的**组合面**（2026-11-25）
 *
 * 背景：tool-result-cap 单条上限 12000 字符，dispatch/file 这类工具会把全文落 artifact 并给
 * next/offset。但**不走分页的工具**（code-executor、第三方插件、MCP 回执…）一旦超 12k，
 * 旧实现只截中间、标记里写「完整结果见 runtime.log 或工具 artifact」—— 可那个 artifact
 * 从来没被写出来：模型按标记去续读，什么都没有。ADR-014 说「截断是换通道，不是丢内容」，
 * 通道得真的存在。
 *
 * 覆盖：
 *   ① 单条 20k → 标记含 offset/limit/next/**artifactPath**，且 artifact 真存在、内容完整；
 *   ② capText 对已截断态二次调用幂等；同一内容重复截断落在同一 artifact（哈希去重）；
 *   ③ 与 dispatch 分页组合：已带 artifactPath/next 的回执被 cap 后，续读指针仍在（不二次落盘）；
 *   ④ 截断不许把 emoji/代理对切成半个字（lone surrogate = 坏字节）；
 *   ⑤ 工具链配对不被破坏（tool_call_id/name 原样）。
 *
 * 全程离线：PET_DATA_ROOT 指到临时目录。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cap-cont-'));
process.env.PET_DATA_ROOT = TMP;

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const cap = require(path.join(LIVE, 'js', 'ai', 'tool-result-cap.js'));
const artifact = require(path.join(LIVE, 'js', 'ai', 'tool-result-artifact.js'));
const Dispatch = require(path.join(LIVE, 'plugins', 'community', 'dispatch', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const ART = artifact.artifactDir();
const hasLoneSurrogate = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s)
    || /(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

function toolMsg(content, id, name) {
    return { role: 'tool', name: name || 'code', content, tool_call_id: id || 'c1' };
}
function makeHost(content) {
    return [
        { role: 'system', content: 'S' },
        { role: 'user', content: '跑个长输出' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'code', arguments: '{}' } }] },
        toolMsg(content),
    ];
}

try {
    // ══════════════════════════════════════════════════════════════════
    // ① 单条 20k：标记必须带可续读指针，且 artifact 真的存在
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[①] 20k 单条：截断 = 换通道');
        const big = '头'.repeat(200) + '中'.repeat(19600) + '尾'.repeat(200);   // 20,000 字
        const host = makeHost(big);
        const filesBefore = artifact.listArtifacts().length;
        const r = cap.enforceToolBudget(host, 1, { perResultChars: 12000, perTurnChars: 320000 });
        const out = String(host[3].content);
        ok('① 确实截断了', r.capped === 1, 'capped=' + r.capped);
        ok('① 截断后不超过上限', out.length <= 12000, 'len=' + out.length);
        ok('① 保留头与尾', out.startsWith('头'.repeat(200)) && out.endsWith('尾'.repeat(200)));
        ok('① 标记说明截了多少', /已截断 \d+ 字符/.test(out), (out.match(/…\[工具输出过长[^\n]*/) || [''])[0]);
        ok('① 标记给出 offset/limit 续读通道', /offset\/limit/.test(out));
        const pathMatch = out.match(/artifactPath[=：:\s]+([^\s（）)]+)|已落盘[：:\s]+([^\s（）)]+)/);
        const artPath = pathMatch ? (pathMatch[1] || pathMatch[2]) : '';
        ok('① 标记里写出**真实** artifactPath（不是「见 tool-artifacts/」这种空话）',
            !!artPath && /tool-artifacts/.test(artPath), 'path=' + artPath);
        ok('① artifact 文件真的存在', !!artPath && fs.existsSync(artPath));
        ok('① artifact 内容是完整原文（一个字都没丢）',
            !!artPath && fs.existsSync(artPath) && fs.readFileSync(artPath, 'utf8') === big,
            artPath ? String(fs.statSync(artPath).size) + 'B' : 'no file');
        ok('① 本次只多写一个 artifact', artifact.listArtifacts().length === filesBefore + 1,
            artifact.listArtifacts().length + ' vs ' + filesBefore);
        ok('① 工具链配对没坏（tool_call_id/name 原样）',
            host[3].tool_call_id === 'c1' && host[3].name === 'code' && host.length === 4);
    }

    // ══════════════════════════════════════════════════════════════════
    // ② 幂等 + 同内容去重
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[②] 幂等 / 哈希去重');
        const big = 'A'.repeat(20000);
        const h1 = makeHost(big);
        const r1 = cap.enforceToolBudget(h1, 1, {});
        const after1 = String(h1[3].content);
        const r2 = cap.enforceToolBudget(h1, 1, {});
        ok('② 二次执行不再改内容（capped=0）', r2.capped === 0 && String(h1[3].content) === after1);
        ok('② 二次执行不报丢弃字符（droppedChars=0）', r2.droppedChars === 0, String(r2.droppedChars));
        const pure2 = cap.capText(after1, 12000);
        ok('② capText 对已截断态幂等（原样返回）',
            pure2.capped === false && pure2.text === after1);

        // 同一份内容在两条 tool 消息里：只落一份 artifact，两条消息里指向同一路径
        const before = artifact.listArtifacts().length;
        const h2 = makeHost(big);
        h2.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'code', arguments: '{}' } }] });
        h2.push(toolMsg(big, 'c2', 'code'));
        const r3 = cap.enforceToolBudget(h2, 1, {});
        const p = (m) => {
            const mm = String(m.content).match(/artifactPath[=：:\s]+([^\s（）)]+)|已落盘[：:\s]+([^\s（）)]+)/);
            return mm ? (mm[1] || mm[2]) : '';
        };
        ok('② 两条同内容回执都被截断', r3.capped === 2, 'capped=' + r3.capped);
        ok('② 两条指向同一个 artifact（哈希去重）', !!p(h2[3]) && p(h2[3]) === p(h2[5]),
            p(h2[3]) + ' vs ' + p(h2[5]));
        ok('② 磁盘上一份新 artifact 都没多（复用已有哈希）',
            artifact.listArtifacts().length === before, artifact.listArtifacts().length + ' vs ' + before);
    }

    // ══════════════════════════════════════════════════════════════════
    // ③ 与 dispatch 分页组合
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[③] 与 dispatch 分页组合');
        const items = Array.from({ length: 260 }, (_, i) => ({
            title: '窗口 ' + (i + 1) + ' 的长标题用来撑体积',
            pid: 1000 + i,
            text: 'x'.repeat(40),
        }));
        const raw = JSON.stringify({ windows: items });
        ok('③ 构造的回执 > 12k（会触发 cap）', raw.length > 12000, 'raw=' + raw.length);
        const paged1 = Dispatch.paginateToolResult('see', { limit: 150 }, raw);
        const obj1 = JSON.parse(paged1);
        ok('③ 分页回执带 next + artifactPath', !!obj1.next && !!obj1.artifactPath,
            'next=' + JSON.stringify(obj1.next) + ' art=' + (obj1.artifactPath ? 'yes' : 'no'));
        ok('③ 按 150 条切会超预算 → 生产方自动收小页', obj1.page.limit < 150,
            'limit=' + obj1.page.limit + ' returned=' + obj1.page.returned);

        ok('③ 分页回执自身 ≤ 12k（信封 + 数组都算进预算）', paged1.length <= 12000, 'len=' + paged1.length);
        ok('③ 分页回执是合法 JSON（不再被盲切成半截）', (() => {
            try { JSON.parse(paged1); return true; } catch (e) { return false; }
        })());
        ok('③ 分页回执不需要 cap 再动手（生产方自己守预算）',
            cap.capText(paged1, 12000).capped === false);

        const beforeArt = artifact.listArtifacts().length;
        const host = makeHost(paged1);
        const r = cap.enforceToolBudget(host, 1, { perResultChars: 12000, perTurnChars: 320000 });
        const out = String(host[3].content);
        ok('③ cap 对已合规的分页回执是空操作', r.capped === 0, 'capped=' + r.capped);
        ok('③ next/artifactPath 完整保留', /"next":\{/.test(out) && /artifactPath/.test(out));
        ok('③ offset/limit 续读提示还在', /续读传 offset=/.test(out), out.slice(-160));
        ok('③ 没有为「已带 artifactPath 的回执」再落一份重复全文',
            artifact.listArtifacts().length === beforeArt,
            artifact.listArtifacts().length + ' vs ' + beforeArt);

        // 跟着 next 一路续读，拼回来必须覆盖全部 260 项（无丢失段、无重复）
        const seen = [];
        let cursor = { offset: 0, limit: obj1.page.limit };
        for (let guard = 0; guard < 20; guard += 1) {
            const rawPage = guard === 0 ? paged1 : Dispatch.paginateToolResult('see', cursor, raw);
            const pg = JSON.parse(rawPage);
            (pg.windows || []).forEach((w) => seen.push(w.pid));
            if (!pg.next) break;
            cursor = { offset: pg.next.offset, limit: pg.next.limit };
        }
        const uniq = new Set(seen);
        ok('③ 续读拼回完整内容（260 项无丢失/无重复）',
            seen.length === 260 && uniq.size === 260, 'seen=' + seen.length + ' uniq=' + uniq.size);

        const paged2 = Dispatch.paginateToolResult('see', obj1.next, raw);
        const obj2 = JSON.parse(paged2);
        ok('③ 第二页 artifact 去重：与第一页同一路径（哈希同内容）',
            obj2.artifactPath === obj1.artifactPath, obj1.artifactPath + ' vs ' + obj2.artifactPath);

        // JSON 信封（detail 很长、带续读指针）：cap 只截 detail，指针与可解析性都不许丢
        const env = JSON.stringify({
            detail: '「大文件」共 30000 字符：\n' + 'Y'.repeat(30000),
            next: { offset: 12000, limit: 12000 },
            artifactPath: '/tmp/tool-artifacts/x-y.txt',
        });
        const envCap = cap.capText(env, 12000);
        ok('③ detail 型信封被截断', envCap.capped === true && envCap.text.length <= 12000,
            'len=' + envCap.text.length + ' envelope=' + envCap.envelope);
        ok('③ detail 型信封截完仍是合法 JSON（不是盲切）', (() => {
            try { JSON.parse(envCap.text); return true; } catch (e) { return false; }
        })());
        ok('③ detail 型信封的 next/artifactPath 一字不动', (() => {
            try {
                const o = JSON.parse(envCap.text);
                return o.next && o.next.offset === 12000 && o.artifactPath === '/tmp/tool-artifacts/x-y.txt';
            } catch (e) { return false; }
        })());
        ok('③ detail 里留了截断标记', /已截断 \d+ 字符/.test(envCap.text));
    }

    // ══════════════════════════════════════════════════════════════════
    // ④ 代理对安全：不许截出半个 emoji
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[④] 截断不许切半个字');
        const emoji = '🐟'.repeat(6000);          // 12000 个 UTF-16 单元 = 6000 个码点
        ok('④ 前置：原文本身没有 lone surrogate', !hasLoneSurrogate(emoji));
        const r = cap.capText(emoji, 4001);
        ok('④ 超长 emoji 文本被截断', r.capped === true && r.text.length <= 4001, 'len=' + r.text.length);
        ok('④ 截断结果没有 lone surrogate（半个 emoji 会变成 U+FFFD 或坏字节）',
            !hasLoneSurrogate(r.text),
            JSON.stringify(r.text.slice(0, 8)) + ' ... ' + JSON.stringify(r.text.slice(-8)));
        ok('④ 头尾仍是完整 emoji', r.text.startsWith('🐟') && r.text.endsWith('🐟'));
    }

    // ══════════════════════════════════════════════════════════════════
    // ⑤ 边界：刚好 12000 不截、12001 截、极限小上限也有标记
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[⑤] 边界');
        ok('⑤ 刚好 12000 不截', cap.capText('y'.repeat(12000), 12000).capped === false);
        ok('⑤ 12001 截且不超上限', (() => {
            const r = cap.capText('y'.repeat(12001), 12000);
            return r.capped === true && r.text.length <= 12000;
        })());
        const tiny = cap.capText('z'.repeat(5000), 120);
        ok('⑤ 上限只有 120 时也不能静默丢标记（至少说明被截了）',
            tiny.capped === true && /截断|省略/.test(tiny.text), tiny.text.slice(-40));
        const det1 = cap.capText('q'.repeat(30000), 9000).text;
        const det2 = cap.capText('q'.repeat(30000), 9000).text;
        ok('⑤ 同一输入两次截断逐字节相同（确定性）', det1 === det2);
    }

    // ══════════════════════════════════════════════════════════════════
    // ⑥ 累计闸的 stub 幂等（P1-2）：已省略的字节不许再被重写
    // ══════════════════════════════════════════════════════════════════
    {
        console.log('\n[⑥] stub 二次省略');
        const host = makeHost('Z'.repeat(20000));
        host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'code', arguments: '{}' } }] });
        host.push(toolMsg('B'.repeat(5000), 'c2', 'code'));
        const opts = { perResultChars: 12000, perTurnChars: 8000 };

        const r0 = cap.enforceToolBudget(host, 1, opts);
        ok('⑥ 第一轮：单条截断 + 累计超限省略最旧一条', r0.capped === 1 && r0.stubbed === 1,
            JSON.stringify(r0));
        const r1 = cap.enforceToolBudget(host, 1, opts);
        ok('⑥ 同一状态再跑一遍不再省略（幂等）', r1.stubbed === 0 && r1.capped === 0, JSON.stringify(r1));
        const stubAt = host.findIndex((m) => m.role === 'tool' && cap._isStub(m.content));
        const frozenStub = String(host[stubAt].content);
        ok('⑥ 省略标记是固定文案（不含动态数字）', frozenStub === cap.STUB_MARKER,
            JSON.stringify(frozenStub.slice(0, 40)));

        // 之后每轮再追加一条 5k 回执：旧 stub 的字节必须**一个字都不变**
        let stable = true;
        const counts = [];
        for (let round = 0; round < 4; round += 1) {
            host.push({ role: 'assistant', content: null, tool_calls: [{ id: 'cn' + round, type: 'function', function: { name: 'code', arguments: '{}' } }] });
            host.push(toolMsg('C'.repeat(5000), 'cn' + round, 'code'));
            const r = cap.enforceToolBudget(host, 1, opts);
            counts.push(r.stubbed);
            if (String(host[stubAt].content) !== frozenStub) stable = false;
        }
        ok('⑥ 后续 4 轮里旧 stub 字节完全不变（前缀缓存不被打穿）', stable);
        ok('⑥ stubbed 只算「新省略的」，不再重复计数', counts.every((n) => n === 1),
            JSON.stringify(counts));
        ok('⑥ 已 stub 的消息不会被 capText 再动', (() => {
            const x = cap.capText(frozenStub, 100);
            return x.capped === false && x.text === frozenStub;
        })());
        ok('⑥ 最新一条永远保留（不被省略）', !cap._isStub(host[host.length - 1].content));
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 清理失败不判红 */ }
    process.exit(fail === 0 ? 0 : 1);
} catch (e) {
    console.error('  ✗ 测试自身异常：' + (e && e.stack || e));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    process.exit(1);
}
