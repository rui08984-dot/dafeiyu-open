// export-metrics.mjs —— 科研级纵向评估出口（RealCompanion 式指标的本地聚合）。
// 把已经在跑的仪表（陪伴时长/漂移/心情/整理日志/打分器统计）聚合成
// data/评估指标.json——论文与回归都用它。纯本地。
// 用法：node pet-runtime/tools/export-metrics.mjs
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const room = join(root, '_incoming', 'my-neuro', 'data');
const read = (rel) => {
    const abs = join(room, rel);
    if (!existsSync(abs)) return null;
    try { return JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { return { _raw: readFileSync(abs, 'utf8').slice(0, 2000) }; }
};

const metrics = {
    exportedAt: new Date().toISOString(),
    // 纵向关系质量
    companionship: read('陪伴时长.json'),
    mood: read('心情.json'),
    // 人设一致性（TtFD/漂移次数——persona-guard 写入）
    personaDrift: read('人设漂移.json'),
    // 记忆质量（巩固日志按天）
    memoryDigestDays: existsSync(join(room, '记忆整理'))
        ? (await import('node:fs')).readdirSync(join(room, '记忆整理')).filter((f) => f.endsWith('.md')).length
        : 0,
    // 一起看事件卡与共看产物
    coWatch: existsSync(join(room, '一起看')) ? 'present' : null,
    // 原始对话历史（用于 RealCompanion 式消息数统计）
    conversation: read('对话历史.jsonl')?._raw || null,
};

const out = join(room, '评估指标.json');
writeFileSync(out, JSON.stringify(metrics, null, 2), 'utf8');
console.log('[metrics] 已聚合 → ' + out);
console.log('[metrics] 覆盖: 陪伴/心情/漂移/整理天数=' + metrics.memoryDigestDays);
