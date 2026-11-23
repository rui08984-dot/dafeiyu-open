#!/usr/bin/env node
/**
 * memos-backup.mjs —— MemOS 记忆逻辑备份（B3，2026-11-23）
 *
 * 为什么需要：Qdrant 是嵌在 8003 进程里的本地目录，直接拷文件在服务运行时可能
 * 拿到半截状态；而记忆又没有快照。这个脚本走 HTTP 把每条记忆的完整 payload
 * 导出成 JSON，再顺带拷图谱/旧 JSON/配置，生成带 sha256 清单的目录。
 *
 * 用法：
 *   node pet-runtime/tools/memos-backup.mjs                 # 备份到 data/记忆备份/<ts>
 *   node pet-runtime/tools/memos-backup.mjs --out D:/bk     # 指定父目录
 *   node pet-runtime/tools/memos-backup.mjs --keep 10       # 保留最近 10 份（默认 7）
 *   node pet-runtime/tools/memos-backup.mjs --with-raw      # 额外拷 data/qdrant（热拷贝，不保证一致）
 *   node pet-runtime/tools/memos-backup.mjs --dry-run       # 只报告将写什么
 *
 * 恢复见产物里的 RESTORE.md。脚本只读 8003，不修改任何记忆。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const MEMOS = path.join(ROOT, '_incoming', 'my-neuro', 'plugins-dlc', 'memos', 'memos_system');
const DEFAULT_OUT = path.join(ROOT, '_incoming', 'my-neuro', 'data', '记忆备份');
const API = process.env.MEMOS_API || 'http://127.0.0.1:8003';

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const hit = args.find((a) => a === name || a.startsWith(name + '='));
    if (!hit) return fallback;
    if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
    const idx = args.indexOf(hit);
    return args[idx + 1] || fallback;
}
const OUT_PARENT = argValue('--out', DEFAULT_OUT);
const KEEP = Math.max(1, Number(argValue('--keep', '7')) || 7);
const WITH_RAW = args.includes('--with-raw');
const DRY = args.includes('--dry-run');

function httpJson(method, urlPath, body, timeoutMs = 15000) {
    const url = new URL(API + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: url.hostname, port: url.port, path: url.pathname + url.search,
            method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
            agent: false,
            timeout: timeoutMs,
        }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { data += d; });
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (_) { /* keep raw */ }
                if (res.statusCode >= 400) {
                    const err = new Error('HTTP ' + res.statusCode + ' ' + data.slice(0, 200));
                    err.status = res.statusCode;
                    err.body = json;
                    return reject(err);
                }
                resolve(json);
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout ' + timeoutMs + 'ms')); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function collectIds() {
    const ids = new Set();
    const statuses = [null, 'archived', 'deleted'];
    for (const status of statuses) {
        // user_id= 空串 → 不按用户过滤（默认值只导出主用户，会漏别的 profile）
        const q = '/list?limit=0&include_deleted=true&user_id=' + (status ? '&status=' + status : '');
        const res = await httpJson('GET', q, null, 30000);
        for (const m of (res && res.memories) || []) {
            if (m && m.id) ids.add(m.id);
        }
    }
    return [...ids];
}

async function fetchPayloads(ids) {
    const out = [];
    const CHUNK = 100;
    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        // user_id 空串：该模型默认值是主用户 id，会把其他 profile 的记忆过滤掉
        const res = await httpJson('POST', '/get_memory_by_ids', { memory_ids: chunk, include_deleted: true, user_id: '' }, 30000);
        for (const m of (res && res.memories) || []) out.push(m);
    }
    return out;
}

function prune(parent, keep) {
    const dirs = fs.readdirSync(parent, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^memos-\d{8}-\d{6}$/.test(d.name))
        .map((d) => ({ name: d.name, at: fs.statSync(path.join(parent, d.name)).mtimeMs }))
        .sort((a, b) => b.at - a.at);
    const pruned = [];
    for (const d of dirs.slice(keep)) {
        fs.rmSync(path.join(parent, d.name), { recursive: true, force: true });
        pruned.push(d.name);
    }
    return pruned;
}

const RESTORE = `# 如何恢复这次备份

1. **先停 8003**（记忆服务），避免边写边恢复。
2. 图谱/旧 JSON（可直接覆盖）：
   - \`graph_store.json\` → \`plugins-dlc/memos/memos_system/data/graph_store.json\`
   - \`memory_store.json\`（若存在）→ 同目录
   - \`memos_config.json\` → \`memos_system/config/memos_config.json\`（注意会覆盖当前配置）
3. **记忆正文**（\`memories.json\`）是逻辑导出，不保 id：
   - 重放：逐条 POST \`http://127.0.0.1:8003/add\`，body 用 \`content\` + \`metadata\`（\`importance\`/\`tags\` 等）。
   - 新 id 会生成，图谱里的 \`source_memory_ids\` 需要重跑实体提取或接受旧引用失效。
4. 若要**原样**恢复（保 id/向量）：用 \`--with-raw\` 产出的 \`qdrant/\` 覆盖 \`data/qdrant\`（必须在服务停止时覆盖；热拷贝不保证一致）。
5. 恢复后 \`curl http://127.0.0.1:8003/health\` 看 ready；再 \`/stats\` 核对条数。
`;

async function main() {
    console.log('[memos-backup] API=' + API);
    const health = await httpJson('GET', '/health', null, 5000).catch((e) => {
        throw new Error('8003 不可用：' + e.message + '（先启动记忆服务）');
    });
    const stats = await httpJson('GET', '/stats', null, 10000).catch(() => null);

    const ids = await collectIds();
    const memories = await fetchPayloads(ids);
    console.log('[memos-backup] list ids=' + ids.length + ' payloads=' + memories.length
        + (stats ? ' /stats total=' + (stats.total_count ?? '?') : ''));
    if (stats && Number.isFinite(Number(stats.total_count)) && memories.length < Number(stats.total_count)) {
        console.warn('[memos-backup] WARN 导出条数少于 /stats 总数（'
            + memories.length + ' < ' + stats.total_count + '），备份不完整');
    }

    const ts = stamp();
    const dir = path.join(OUT_PARENT, 'memos-' + ts);
    if (DRY) {
        console.log('[memos-backup] --dry-run：将写入 ' + dir + '（' + memories.length + ' 条，图谱/配置随附，keep=' + KEEP + '）');
        return;
    }
    fs.mkdirSync(dir, { recursive: true });

    const files = [];
    function writeJson(name, obj) {
        const p = path.join(dir, name);
        fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8');
        files.push(p);
        return p;
    }

    writeJson('memories.json', {
        exported_at: new Date().toISOString(),
        api: API,
        count: memories.length,
        memories,
    });
    writeJson('stats.json', stats || { unavailable: true });

    const copies = [
        [path.join(MEMOS, 'data', 'graph_store.json'), 'graph_store.json'],
        [path.join(MEMOS, 'data', 'memory_store.json'), 'memory_store.json'],
        [path.join(MEMOS, 'config', 'memos_config.json'), 'memos_config.json'],
    ];
    for (const [src, name] of copies) {
        if (!fs.existsSync(src)) { console.log('[memos-backup] skip ' + name + '（不存在）'); continue; }
        const dst = path.join(dir, name);
        fs.copyFileSync(src, dst);
        files.push(dst);
    }

    if (WITH_RAW) {
        const src = path.join(MEMOS, 'data', 'qdrant');
        if (fs.existsSync(src)) {
            const dst = path.join(dir, 'qdrant');
            fs.cpSync(src, dst, { recursive: true });
            files.push(dst);
            console.log('[memos-backup] raw qdrant 已拷（服务运行中，快照不保证一致，仅作兜底）');
        } else {
            console.log('[memos-backup] skip raw：data/qdrant 不存在');
        }
    }

    fs.writeFileSync(path.join(dir, 'RESTORE.md'), RESTORE, 'utf8');
    const manifest = {
        created_at: new Date().toISOString(),
        api: API,
        health_ok: !!(health && (health.status === 'ok' || health.ready !== false)),
        memory_count: memories.length,
        files: files.map((p) => ({
            name: path.relative(dir, p),
            bytes: fs.statSync(p).isFile() ? fs.statSync(p).size : null,
            sha256: fs.statSync(p).isFile() ? sha256(p) : null,
        })),
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');

    const pruned = prune(OUT_PARENT, KEEP);
    if (pruned.length) console.log('[memos-backup] 清理旧备份：' + pruned.join(', '));
    console.log('[memos-backup] OK ' + dir + '（' + memories.length + ' 条，' + files.length + ' 个文件）');
}

main().catch((e) => {
    console.error('[memos-backup] FAIL ' + e.message);
    process.exitCode = 1;
});
