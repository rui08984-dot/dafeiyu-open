#!/usr/bin/env node
/**
 * _probe/longrun.cjs — 长跑采样（2026-11-15 六十轮，P5 性能基线）
 *
 * 为什么要它：现在所有数字都是**单点**（「p95 0.3ms」「内存 273MB」）。长跑才能看出
 * 泄漏/退化：几小时后内存有没有爬、索引会不会反复重建、看门狗判死过几次、
 * 主动预算有没有被某个来源吃光、片段/事实会不会无限膨胀。
 *
 * 采样内容（默认 60 秒一次）：
 *   · /health：uptime / renderer.state / healthAgeMs
 *   · 她的进程内：JS 堆、索引条数、事实/片段条数、主动预算用量、孩子进程数
 *   · 看门狗日志：判死/自愈次数（读 render-watchdog.log）
 *
 * 用法：
 *   node _probe/longrun.cjs                 # 默认 30 分钟 / 60 秒一次
 *   node _probe/longrun.cjs --minutes 5 --every 20
 * 输出：_probe/out/longrun-<时间>.csv + 结束时打印汇总（首末对比 + 结论）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const MIN = (() => { const i = process.argv.indexOf('--minutes'); return i >= 0 ? Math.max(1, Number(process.argv[i + 1])) : 30; })();
const EVERY = (() => { const i = process.argv.indexOf('--every'); return i >= 0 ? Math.max(5, Number(process.argv[i + 1])) : 60; })();
const WATCH_LOG = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d', 'render-watchdog.log');

function get(port, pathname, timeoutMs) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', timeout: timeoutMs || 5000 }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
    });
}

function post(port, pathname, body, timeoutMs) {
    return new Promise((resolve) => {
        const data = Buffer.from(JSON.stringify(body), 'utf8');
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', timeout: timeoutMs || 12000,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } }, (res) => {
            let s = '';
            res.on('data', (c) => { s += c; });
            res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve(null); } });
        });
        req.on('timeout', () => { try { req.destroy(); } catch (e) {} resolve(null); });
        req.on('error', () => resolve(null));
        req.write(data);
        req.end();
    });
}

const PROBE_JS = '(function(){try{var m=performance.memory||{};var mr=window.pluginManager&&window.pluginManager._plugins.get("community/memory-recall");var me=window.pluginManager&&window.pluginManager._plugins.get("community/memory-evolve");var p=mr&&mr.plugin;var SB=null;try{SB=require("<project-root>/_incoming/my-neuro/live-2d/js/core/speech-budget.js").singleton();}catch(e){}var st=SB?SB.stats():null;var docs=p&&p._docs?p._docs.length:0;var by={};if(p&&p._docs){p._docs.forEach(function(d){by[d.src]=(by[d.src]||0)+1;});}return JSON.stringify({heapMB:Math.round((m.usedJSHeapSize||0)/1048576),docs:docs,bySrc:by,budget:st?{used:st.used,limit:st.limit,acc:st.accept_rate,annoy:st.annoy_index}:null,episodeTimer:!!(me&&me.plugin&&me.plugin._episodeTimer)});}catch(e){return JSON.stringify({error:String(e&&e.message||e)});}})()';

function watchdogStats() {
    try {
        const s = fs.readFileSync(WATCH_LOG, 'utf8');
        const lines = s.split(/\r?\n/).filter(Boolean);
        return {
            lines: lines.length,
            deaths: lines.filter((l) => /判死：/.test(l)).length,
            heals: lines.filter((l) => /自愈成功/.test(l)).length,
            memWarn: lines.filter((l) => /内存偏高/.test(l)).length,
            last: lines.slice(-1)[0] || '',
        };
    } catch (e) { return { lines: 0, deaths: 0, heals: 0, memWarn: 0, last: '' }; }
}

(async () => {
    const t0 = Date.now();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const outDir = path.join(__dirname, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const csv = path.join(outDir, 'longrun-' + stamp + '.csv');
    fs.writeFileSync(csv, 'at,min,renderer,healthAgeMs,uptimeSec,heapMB,docs,talk,mem,core,fact,ep,frag,budgetUsed,budgetLimit,acceptRate,deaths,heals,memWarn\n', 'utf8');

    const base = watchdogStats();          // 基线：只看本次期间新增的判死/自愈
    const rows = [];
    const total = Math.round((MIN * 60 * 1000) / (EVERY * 1000));
    for (let i = 0; i <= total; i += 1) {
        const at = new Date();
        const h = await get(8103, '/health', 5000);
        const ev = await post(8004, '/eval', { js: PROBE_JS }, 12000);
        let inner = {};
        if (ev && ev.ok && typeof ev.value === 'string') { try { inner = JSON.parse(ev.value); } catch (e) { inner = {}; } }
        const wd = watchdogStats();
        const by = inner.bySrc || {};
        const row = {
            at: at.toISOString().slice(11, 19),
            min: Math.round((i * EVERY) / 60 * 10) / 10,
            renderer: (h && h.renderer && h.renderer.state) || (h ? 'up' : 'down'),
            healthAgeMs: (h && h.renderer && h.renderer.healthAgeMs) || '',
            uptimeSec: (h && h.uptime) || '',
            heapMB: inner.heapMB == null ? '' : inner.heapMB,
            docs: inner.docs == null ? '' : inner.docs,
            talk: by['对话'] || 0, mem: by['记忆库'] || 0, core: by['核心'] || 0,
            fact: by['事实'] || 0, ep: by['片段'] || 0, frag: by['用户记忆'] || 0,
            budgetUsed: inner.budget ? inner.budget.used : '',
            budgetLimit: inner.budget ? inner.budget.limit : '',
            acceptRate: inner.budget && inner.budget.acc != null ? inner.budget.acc : '',
            deaths: wd.deaths, heals: wd.heals, memWarn: wd.memWarn,
        };
        rows.push(row);
        fs.appendFileSync(csv, [row.at, row.min, row.renderer, row.healthAgeMs, row.uptimeSec, row.heapMB, row.docs,
            row.talk, row.mem, row.core, row.fact, row.ep, row.frag,
            row.budgetUsed, row.budgetLimit, row.acceptRate, row.deaths, row.heals, row.memWarn].join(',') + '\n', 'utf8');
        if (i % 5 === 0 || i === total) {
            console.log('[' + row.at + '] +' + row.min + 'min ' + row.renderer + ' heap=' + row.heapMB + 'MB docs=' + row.docs
                + ' fact=' + row.fact + ' ep=' + row.ep + ' budget=' + row.budgetUsed + '/' + row.budgetLimit
                + ' deaths=' + row.deaths + ' heals=' + row.heals);
        }
        if (i < total) await new Promise((r) => setTimeout(r, EVERY * 1000));
    }

    const first = rows.find((r) => r.docs !== '');
    const last = rows[rows.length - 1];
    const num = (v) => (v === '' ? null : Number(v));
    const dHeap = (num(last.heapMB) != null && num(first && first.heapMB) != null) ? num(last.heapMB) - num(first.heapMB) : null;
    const dDocs = (num(last.docs) != null && num(first && first.docs) != null) ? num(last.docs) - num(first.docs) : null;
    const downMin = rows.filter((r) => r.renderer !== 'ok' && r.renderer !== 'up').length;
    console.log('\n── 长跑汇总（' + MIN + ' 分钟 / ' + EVERY + 's）──');
    console.log('  采样 ' + rows.length + ' 点 · 写入 ' + csv);
    console.log('  JS 堆 ' + (first && first.heapMB) + 'MB → ' + last.heapMB + 'MB（Δ' + (dHeap == null ? '?' : (dHeap > 0 ? '+' : '') + dHeap) + 'MB）');
    console.log('  索引 ' + (first && first.docs) + ' → ' + last.docs + '（Δ' + (dDocs == null ? '?' : dDocs) + '）· 事实 ' + last.fact + ' · 片段 ' + last.ep);
    console.log('  看门狗（本次期间新增）：判死 ' + (last.deaths - base.deaths) + ' 次 / 自愈 ' + (last.heals - base.heals) + ' 次 / 内存告警 ' + (last.memWarn - base.memWarn) + ' 次（累计 ' + last.deaths + '/' + last.heals + '）');
    console.log('  渲染非 ok 的采样点 ' + downMin + '/' + rows.length);
    console.log('  主动预算 ' + last.budgetUsed + '/' + last.budgetLimit + '（接受率 ' + (last.acceptRate === '' ? '无数据' : last.acceptRate) + '）');
    const verdict = [];
    if (downMin > 0) verdict.push('渲染有 ' + downMin + ' 个采样点不正，需要看日志');
    if (dHeap != null && dHeap > 120) verdict.push('JS 堆涨了 ' + dHeap + 'MB（疑似泄漏）');
    if (last.deaths - base.deaths > 0) verdict.push('期间判死过 ' + (last.deaths - base.deaths) + ' 次');
    console.log('  结论：' + (verdict.length ? verdict.join('；') : '无退化（堆平、渲染全 ok、看门狗零判死）'));
    process.exit(0);
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });
