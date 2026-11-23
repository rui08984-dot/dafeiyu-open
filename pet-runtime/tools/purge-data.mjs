// purge-data.mjs —— 数据删除权（隐私说明 §1/§4）。
// 分项清除：memory（记忆库+MemOS 需另走 API）/ profile / diary / all。
// 两道保险：必须 --confirm；且会先在原位留 .purged-<ts> 备份（可手动恢复）。
// 用法：node pet-runtime/tools/purge-data.mjs --scope memory --confirm
import { renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const scopeIdx = args.indexOf('--scope');
const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : '';
const confirmed = args.includes('--confirm');

const TARGETS = {
    memory: ['_incoming/my-neuro/data/记忆库.txt', '_incoming/my-neuro/data/核心用户记忆.txt', '_incoming/my-neuro/data/用户记忆.json'],
    profile: ['_incoming/my-neuro/data/用户画像.json', '_incoming/my-neuro/data/用户画像_候选.json'],
    diary: ['_incoming/my-neuro/data/AI日记.txt'],
    coWatch: ['_incoming/my-neuro/data/一起看'],
};

if (!TARGETS[scope]) {
    console.error('用法: node pet-runtime/tools/purge-data.mjs --scope memory|profile|diary|coWatch --confirm');
    console.error('scopes: ' + Object.keys(TARGETS).join(' | '));
    process.exit(1);
}
if (!confirmed) {
    console.error('危险操作：需要 --confirm 才会执行（会先留 .purged-<时间戳> 备份）');
    process.exit(1);
}
// 提示：MemOS(8003) 里的向量记忆不在文件系统，需在面板记忆页逐条删或停用 MemOS 后清其数据目录
console.log('[purge] scope=' + scope + '（提示：MemOS 向量记忆在 8003 服务内，文件清除不覆盖它）');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
let moved = 0;
for (const rel of TARGETS[scope]) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    const backupDir = abs + '.purged-' + stamp;
    if (!existsSync(dirname(backupDir))) mkdirSync(dirname(backupDir), { recursive: true });
    renameSync(abs, backupDir);
    console.log('[purge] ' + rel + ' → ' + backupDir);
    moved += 1;
}
console.log('[purge] 完成：移动 ' + moved + ' 项到备份。要彻底删除请手动清理 .purged-* 目录。');
