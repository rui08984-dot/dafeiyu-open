// export-data.mjs —— 数据导出（隐私说明 §1 的「导出权」）：
// 把 data + 关键配置拷到 dist/数据导出-<时间戳>/，纯本地。
//
// 用法：
//   node pet-runtime/tools/export-data.mjs                  # 默认：配置里的凭据全部脱敏
//   node pet-runtime/tools/export-data.mjs --with-secrets   # 带明文凭据（自己保管，别分享）
//   node pet-runtime/tools/export-data.mjs --out D:/Temp/x  # 指定导出目录（测试用）
//
// 为什么默认脱敏（2026-11-21 红队 P1 #9）：导出目录常被拷进网盘/U 盘/发给别人，
// 里面若带 provider api_key，一次「数据导出」就是一次凭据泄露。脱敏不破坏可用性 ——
// 导入回新机器后把 key 重填即可；聊天记录/记忆/日记一条不少。
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const withSecrets = process.argv.includes('--with-secrets');
const outIdx = process.argv.indexOf('--out');
const outArg = outIdx >= 0 ? process.argv[outIdx + 1] : '';
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const dest = outArg ? outArg : join(root, 'dist', '数据导出-' + stamp);

const REDACTED = '***REDACTED***';
// 键名命中即脱敏；ptt_key 是「按键名」不是凭据（模板生成器里已定为例外），脱了反而误导
const SECRET_KEY_RE = /(api[_-]?key|apikey|secret|token|password|passwd|cookie|authorization|credential)/i;
const KEEP_KEYS = new Set(['ptt_key']);

const sources = [
    ['_incoming/my-neuro/data', 'data', false],
    ['_incoming/my-neuro/live-2d/config.json', 'config.json', true],
    ['_incoming/my-neuro/live-2d/llm_providers.json', 'llm_providers.json', true],
];

/** 递归脱敏：只替换「键名像凭据且值是非空字符串」的叶子；结构原样保留 */
function redact(value, hits, path) {
    if (Array.isArray(value)) return value.map((v, i) => redact(v, hits, path + '[' + i + ']'));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const p = path ? path + '.' + k : k;
            if (typeof v === 'string' && v && SECRET_KEY_RE.test(k) && !KEEP_KEYS.has(k)) {
                out[k] = REDACTED;
                hits.push(p);
            } else {
                out[k] = redact(v, hits, p);
            }
        }
        return out;
    }
    return value;
}

let copied = 0;
const missing = [];
const redactedFiles = [];
const failed = [];

for (const [src, name, isJson] of sources) {
    const abs = join(root, src);
    if (!existsSync(abs)) { missing.push(src); continue; }
    const outPath = join(dest, name);
    if (!isJson) {
        cpSync(abs, outPath, { recursive: true });
        copied += 1;
        continue;
    }
    if (withSecrets) {
        cpSync(abs, outPath);
        copied += 1;
        continue;
    }
    // 解析失败 → 不拷贝（宁可缺文件也不把明文凭据带出去），并明确报错
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
        failed.push(name + '（解析失败，已跳过以免带出明文：' + e.message + '）');
        continue;
    }
    const hits = [];
    const safe = redact(parsed, hits, '');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(safe, null, 2) + '\n', 'utf8');
    copied += 1;
    if (hits.length) redactedFiles.push(name + '（' + hits.length + ' 个：' + hits.join(', ') + '）');
}

mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, 'README.txt'),
    '大肥鱼数据导出 ' + stamp + '\n' +
    '来源均在本地；导入回新机器时放回相同相对路径即可。\n' +
    '隐私提醒：data/browser-tabs.jsonl 保存的是浏览页「域名+标题」明文（含历史浏览），' +
    '分享这个目录前请先清理该文件。\n' +
    (withSecrets
        ? '\n⚠ 本次带明文凭据（--with-secrets）：不要分享/上传这个目录。\n'
        : '\n配置里的凭据已脱敏为 ' + REDACTED + '；导入新机器后重填 provider key / token 即可。\n' +
          (redactedFiles.length ? '已脱敏：' + redactedFiles.join('；') + '\n' : '')),
    'utf8');

console.log('[export] 已导出 ' + copied + ' 项 → ' + dest);
if (!withSecrets && redactedFiles.length) console.log('[export] 已脱敏: ' + redactedFiles.join('；'));
if (withSecrets) console.log('[export] ⚠ 含明文凭据（--with-secrets）—— 别分享这个目录');
if (missing.length) console.log('[export] 未找到（跳过）: ' + missing.join(', '));
if (failed.length) console.log('[export] 失败: ' + failed.join('；'));
if (copied === 0 || failed.length) process.exit(1);
