#!/usr/bin/env node
/**
 * _probe/test-single-compressor.cjs —— 「上下文压缩器只有一个」不变量（2026-11-24 审计 §8.3）
 *
 * 以前有两条压缩链同时活着：
 *   · `js/ai/ContextCompressor.js` 的 rolling summary（默认开，每 10 对消息裸 fetch 云主模型，
 *     不写 llm.usage、不过 background-llm 闸）；
 *   · `plugins/built-in/context-compressor`（token 触发、缓存感知、走 callLLM）。
 * 两者写同一个 `[历史对话总结]` system 槽，互相覆盖，且旧链绕过了账本与后台闸。
 *
 * 本轮把旧链整个删掉。这个测试把「只剩一个压缩器」钉成仓库不变量，
 * 防止下次有人「顺手恢复 rolling」或再起一条写同一个槽的链。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'vendor', 'libs', '.runtime', 'assets']);

/** 递归收集 js/ 与 plugins/ 下的 .js/.cjs/.mjs/.json 文件。 */
function walk(dir, out) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue;
            walk(p, out);
        } else if (/\.(?:js|cjs|mjs|json)$/i.test(ent.name)) {
            out.push(p);
        }
    }
    return out;
}

const files = [...walk(path.join(LIVE, 'js'), []), ...walk(path.join(LIVE, 'plugins'), [])];
const rel = (p) => path.relative(LIVE, p).split(path.sep).join('/');

// ── ① 旧文件已经不在了 ────────────────────────────────────────────────────
ok('① js/ai/ContextCompressor.js 已删除', !fs.existsSync(path.join(LIVE, 'js', 'ai', 'ContextCompressor.js')));
ok('① js/ai/context-rolling.test.js 已删除', !fs.existsSync(path.join(LIVE, 'js', 'ai', 'context-rolling.test.js')));

// ── ② 全仓不再有 rolling summary 的任何活引用 ─────────────────────────────
const rollingHits = [];
const classHits = [];
for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (/rolling_summary|checkAndRollAsync|rollingDigestTag|rollingBusy/.test(text)) rollingHits.push(rel(f));
    // ContextCompressorPlugin 是现存插件的类名，不算旧类
    if (/\bContextCompressor(?!Plugin)/.test(text) || /\bcontextCompressor\b/.test(text)) classHits.push(rel(f));
}
ok('② 没有任何文件引用 rolling_summary / checkAndRollAsync', rollingHits.length === 0, rollingHits.join(', ') || '0 处');
ok('② 没有任何文件引用旧 ContextCompressor 类 / contextCompressor 字段',
    classHits.length === 0, classHits.join(', ') || '0 处');

// ── ③ 旧配置读取点全部消失（context.compression / compressionConfig）─────
const cfgHits = [];
for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (/compressionConfig|context\s*\?\s*\.\s*compression|context\.compression\b/.test(text)) cfgHits.push(rel(f));
}
ok('③ 不再读取 config.context.compression.*', cfgHits.length === 0, cfgHits.join(', ') || '0 处');

// ── ④ `[历史对话总结]` 的写入口只有插件一处 ───────────────────────────────
// 写入 = 模板里拼「[历史对话总结] ${…}」。读取/过滤（replace、startsWith、正则）不算。
const writers = [];
const mentions = [];
for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (!text.includes('[历史对话总结]')) continue;
    mentions.push(rel(f));
    if (/`\[历史对话总结\]\s*\$\{/.test(text)) writers.push(rel(f));
}
ok('④ 写 `[历史对话总结]` 的只有 context-compressor 插件',
    writers.length === 1 && writers[0] === 'plugins/built-in/context-compressor/index.js',
    JSON.stringify(writers));
const nonPluginMentions = mentions.filter((m) => !/^plugins\/built-in\/context-compressor\//.test(m)
    && m !== 'js/core/memory-scaffold.js');   // memory-scaffold 只做正则过滤（读），不是写
ok('④ 其它文件最多只做「读/过滤」，不存在第二处写入', nonPluginMentions.length === 0,
    nonPluginMentions.join(', ') || '0 处');

// ── ⑤ 幸存的那个压缩器确实是「token 触发 + 缓存感知」那个 ─────────────────
{
    const pluginDir = path.join(LIVE, 'plugins', 'built-in', 'context-compressor');
    const idx = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8');
    const cfg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin_config.json'), 'utf8'));
    ok('⑤ 压缩触发是 history token 预算（不是条数/rolling）',
        /history_token_budget/.test(idx) && Object.prototype.hasOwnProperty.call(cfg, 'history_token_budget'),
        'history_token_budget');
    ok('⑤ 压缩调用走 context.callLLM（进账本），不再有裸 fetch',
        /context\.callLLM\(/.test(idx) && !/fetch\(/.test(idx), 'callLLM');
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
