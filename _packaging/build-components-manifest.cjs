#!/usr/bin/env node
'use strict';
// _packaging/build-components-manifest.mjs —— 合并组件包清单（v0.4.0）
//
// 输入：out/packs/manifest.fragments.json（build-component-packs 产出）
// 输出：out/components/manifest.json（安装包随带；组件管理器读它）
//
// 校验（任何一条不过 → 退出码 1，构建中止）：
//   · 每个组件有 id/name/version/files；id 唯一、ASCII；extractTo 是相对路径
//   · 每个 file 有 sources（>=1，http(s)）、sha256（64 hex）、sizeBytes>0
//   · 本地存在同名产物的，重新算哈希必须一致（防止清单与 zip 对不上）
//   · 所有 URL 必须是 https（模型镜像允许 http? 统一 https）

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
function arg(name, def) {
    const hit = args.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
    if (!hit) return def;
    if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
    const i = args.indexOf(hit);
    return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}
const HERE = __dirname;
const fragmentsPath = arg('fragments', path.join(HERE, 'out', 'packs', 'manifest.fragments.json'));
const outPath = arg('out', path.join(HERE, 'out', 'components', 'manifest.json'));
const version = String(arg('version', '0.4.0'));
const packsDir = path.join(HERE, 'out', 'packs');

function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (e) { return false; } }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

let fragments = [];
if (isFile(fragmentsPath)) {
    try { fragments = JSON.parse(fs.readFileSync(fragmentsPath, 'utf8')); } catch (e) { fail('fragments JSON 解析失败：' + e.message); }
    if (!Array.isArray(fragments)) { fragments = fragments.components || []; }
} else {
    console.warn('[manifest] 没有 fragments（' + fragmentsPath + '），生成仅底座的清单');
}
if (!Array.isArray(fragments)) fail('fragments 不是数组');

const seen = new Set();
const components = fragments.map((c) => {
    if (!c || !c.id || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) fail('非法组件 id：' + JSON.stringify(c && c.id));
    if (seen.has(c.id)) fail('组件 id 重复：' + c.id);
    seen.add(c.id);
    if (!c.name || !c.version) fail('组件缺 name/version：' + c.id);
    if (!Array.isArray(c.files) || !c.files.length) fail('组件没有 files：' + c.id);
    for (const f of c.files) {
        if (!Array.isArray(f.sources) || !f.sources.length) fail(c.id + ' 的文件没有下载源：' + (f.name || f.dest));
        for (const s of f.sources) {
            if (!/^https:\/\//i.test(String(s.url || ''))) fail(c.id + ' 的下载源不是 https：' + (s.url || ''));
        }
        if (!/^[a-f0-9]{64}$/i.test(String(f.sha256 || ''))) fail(c.id + ' 的文件缺 sha256：' + (f.name || f.dest));
        if (!(Number(f.sizeBytes) > 0)) fail(c.id + ' 的文件缺 sizeBytes：' + (f.name || f.dest));
        const dest = String(f.dest || '');
        if (!dest || path.isAbsolute(dest) || dest.includes('..')) fail(c.id + ' 的 dest 非法：' + dest);
        // 本地产物交叉校验
        const local = path.join(packsDir, path.basename(dest));
        if (isFile(local)) {
            const got = sha(local);
            if (got.toLowerCase() !== String(f.sha256).toLowerCase()) {
                fail(c.id + ' 清单哈希与本地产物不一致：' + path.basename(local) + '（清单 ' + String(f.sha256).slice(0, 12) + '… / 实得 ' + got.slice(0, 12) + '…）');
            }
            const size = fs.statSync(local).size;
            if (size !== Number(f.sizeBytes)) fail(c.id + ' 清单体积与本地产物不一致：' + path.basename(local) + '（清单 ' + f.sizeBytes + ' / 实得 ' + size + '）');
        }
    }
    return {
        id: c.id,
        name: c.name,
        version: c.version,
        extractTo: c.extractTo || c.id,
        sizeBytes: Number(c.sizeBytes) || c.files.reduce((s, f) => s + Number(f.sizeBytes || 0), 0),
        requires: Array.isArray(c.requires) ? c.requires : [],
        files: c.files,
        config: c.config || {},
        services: Array.isArray(c.services) ? c.services : [],
        setup: c.setup || '',
    };
});

const doc = {
    schema: 1,
    product: 'dafeiyu',
    version,
    generatedAt: new Date().toISOString(),
    components,
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');

const total = components.reduce((s, c) => s + c.sizeBytes, 0);
console.log('[manifest] ✓ ' + components.length + ' 个组件，合计 ' + (total / 1048576).toFixed(1) + 'MB → ' + outPath);
for (const c of components) console.log('  · ' + c.id.padEnd(12) + c.name + '  ' + (c.sizeBytes / 1048576).toFixed(1) + 'MB');
