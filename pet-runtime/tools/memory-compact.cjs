#!/usr/bin/env node
'use strict';
/**
 * memory-compact.js —— 对话历史压缩器（2026-11-10 三十七轮）
 *
 * 为什么要有：`data/对话历史.jsonl` 只增不压（实测 884 行 / 224KB，还在滚）。
 *   不压缩的后果：上下文拼装越来越慢、token 越花越多、旧记忆被稀释。
 *
 * 设计（Letta 的「驱逐 70% + 递归摘要」的**纯本地版**，零 API 成本）：
 *   · 触发：总行数 > --trigger（默认 500）
 *   · 保留：最近 --keep 行（默认 200）原样 + **关键行原样**（生日/承诺/偏好…）
 *           + 全部 system 行（历史摘要/标记）
 *   · 驱逐段：每 ~80 行生成一条统计摘要（轮次、环境注入数、CJK bigram 高频词 top6）
 *     —— 只统计**真实存在的内容**，不编造；原文都在备份里可回查
 *   · 安全：--apply 前自动全量备份 `对话历史.backup-<时间戳>.jsonl`；
 *     --dry-run 只报告不落盘；system 压缩标记行幂等（重复跑不会二次压缩）
 *
 * ⚠ 诚实边界：纯本地摘要 = **体积控制**，不是「理解历史」。
 *   要真正提炼历史语义，把 --llm 开关接到对话模型上（每段一次 API，几毛钱）——
 *   按用户成本纪律默认关，接口留好（compactWithLlm() 钩子）。
 *
 * 用法：
 *   node memory-compact.js --dry-run                 # 只报告将压缩多少
 *   node memory-compact.js --apply                   # 执行（先备份）
 *   node memory-compact.js --apply --keep 300        # 自定义保留行数
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');   // pet-runtime/tools → 项目根（<project-root>）

const HISTORY = ROOT
    ? path.join(ROOT, '_incoming', 'my-neuro', 'data', '对话历史.jsonl')
    : null;
const LOCK = HISTORY ? HISTORY + '.lock' : null;

/**
 * 独占锁：`openSync(lockPath, 'wx')` 由内核保证「同时只有一个进程能创建」。
 * 拿不到就走人（退出码 0）——不是错误，是「已经有人在压了，别并发起第二个」。
 *
 * 为什么需要：ContextManager 每次 >500 行都会 detached spawn 一个 --apply，
 * 而它自己是异步的（两分钟级）。写一条历史时连续触发两次 → 两个进程同时
 * 「读 → 算 → tmp → rename」，后写完的覆盖先写完的，且两边备份互不知情。
 *
 * 落锁后正常退出由 'exit' 钩子删锁。硬杀（TerminateProcess / kill -9）不会执行
 * exit 钩子，会留下锁 —— 所以再加一层陈旧锁检测：锁里记的 pid 已经不存在 → 删掉重试。
 */
function acquireLock() {
    const tryOpen = () => {
        const fd = fs.openSync(LOCK, 'wx');
        try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
        process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch (e) { /* 已被清掉 */ } });
        return true;
    };
    try {
        return tryOpen();
    } catch (e) {
        if (e.code !== 'EEXIST') throw e;
    }
    try {
        const pid = Number(String(fs.readFileSync(LOCK, 'utf8')).trim());
        if (!Number.isFinite(pid) || pid <= 0) {
            fs.unlinkSync(LOCK);
            return tryOpen();
        }
        try {
            process.kill(pid, 0);       // 信号 0 = 只探测存在性
            return false;               // 还活着 → 真锁
        } catch (e) {
            if (e.code === 'ESRCH') {   // 进程不存在 → 陈旧锁
                fs.unlinkSync(LOCK);
                return tryOpen();
            }
            return false;
        }
    } catch (e) {
        return false;                   // 读不到/删不掉 → 保守当活跃锁
    }
}

// 关键行：这些内容丢了会伤感情/误事（和 user-profile 的关键维度对齐）
const KEY_RE = /生日|礼物|面试|喜欢|讨厌|承诺|答应|记住|别忘了|老婆|女朋友|重要|纪念日|约定|生病|吃药/;

// 环境注入（屏幕感知文本）：占行数但不是"她说过的话"
function isEnvLine(d) {
    if (d.role !== 'user') return false;
    const c = d.content;
    const txt = typeof c === 'string' ? c
        : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ')
        : '';
    return txt.startsWith('（你正在旁边看') || txt.startsWith('(你正在旁边看');
}

// CJK bigram 高频词（和知识库检索同一思路，零依赖）
function topBigrams(texts, n) {
    const freq = new Map();
    for (const t of texts) {
        const s = String(t).replace(/[\s\p{P}]+/gu, '');
        for (let i = 0; i + 2 <= s.length; i += 1) {
            const g = s.slice(i, i + 2);
            if (/^[\u4e00-\u9fff]{2}$/.test(g)) freq.set(g, (freq.get(g) || 0) + 1);
        }
    }
    return [...freq.entries()].filter(([, c]) => c >= 3)
        .sort((a, b) => b[1] - a[1]).slice(0, n).map(([g, c]) => g + '×' + c);
}

function classify(lines) {
    return lines.map((raw, idx) => {
        let d = null;
        try { d = JSON.parse(raw); } catch (e) { return { idx, raw, kind: 'broken', role: '' }; }
        const role = d.role || '';
        if (role === 'system') return { idx, raw, kind: 'system', role };
        if (isEnvLine(d)) return { idx, raw, kind: 'env', role, obj: d };
        if (KEY_RE.test(raw)) return { idx, raw, kind: 'key', role, obj: d };
        return { idx, raw, kind: 'chat', role, obj: d };
    });
}

function summarizeSegment(seg) {
    const chat = seg.filter((l) => l.kind === 'chat' || l.kind === 'key');
    const userLines = seg.filter((l) => l.role === 'user');
    const asstLines = seg.filter((l) => l.role === 'assistant');
    const envCount = seg.filter((l) => l.kind === 'env').length;
    // 热词只统计**真实用户输入** —— 环境注入（屏幕感知模板）会把「一句话×75」这种
    // 固定提示词刷成高频，污染统计（首跑实测踩到）。
    const texts = userLines.filter((l) => l.kind !== 'env').map((l) => {
        const c = l.obj && l.obj.content;
        return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '';
    });
    const hot = topBigrams(texts, 6);
    return {
        lines: seg.length, turns: chat.length, userLines: userLines.length,
        asstLines: asstLines.length, envInjected: envCount,
        hotTopics: hot,
    };
}

function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const apply = args.includes('--apply');
    const getNum = (flag, def) => {
        const i = args.indexOf(flag);
        return i >= 0 && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : def;
    };
    const keep = getNum('--keep', 200);
    const trigger = getNum('--trigger', 500);

    if (!HISTORY || !fs.existsSync(HISTORY)) {
        console.log(JSON.stringify({ ok: false, error: '找不到对话历史：' + HISTORY }));
        process.exit(1);
    }
    const rawLines = fs.readFileSync(HISTORY, 'utf8').split('\n')
        .filter((l, i, arr) => l.trim() !== '' || i < arr.length - 1)
        .filter((l) => l.trim() !== '');
    const cls = classify(rawLines);

    // 幂等：已经压过的（有 system 压缩标记）不再压
    const alreadyCompacted = cls.some((l) => l.kind === 'system' && l.raw.includes('[历史压缩'));
    const stats = {
        total: cls.length,
        chat: cls.filter((l) => l.kind === 'chat').length,
        env: cls.filter((l) => l.kind === 'env').length,
        key: cls.filter((l) => l.kind === 'key').length,
        system: cls.filter((l) => l.kind === 'system').length,
        broken: cls.filter((l) => l.kind === 'broken').length,
        alreadyCompacted,
    };

    // ⚠ 2026-11-10 行为审计抓到（死锁）：原来只要文件里有「[历史压缩」标记行就永远 skip ——
    //   压过一次后标记永久存在，之后哪怕又涨到 628 行 / 2MB 也不再压；而 ContextManager
    //   每次 >500 行都会 spawn 一次这个空转进程。
    //   现在幂等判据改成「标记在 **且** 总量还在阈值附近（≤ trigger×1.2）」才 skip；
    //   又涨过阈值就允许再压一轮（压完不涨就不压 = 真幂等）。
    const shouldSkipForIdem = alreadyCompacted && cls.length <= Math.floor(trigger * 1.2);
    if (shouldSkipForIdem) {
        console.log(JSON.stringify({ ok: true, action: 'skip', reason: '已压缩过且总量仍在阈值附近（幂等），无需再压', stats }));
        return;
    }
    if (cls.length <= trigger) {
        console.log(JSON.stringify({ ok: true, action: 'skip', reason: `共 ${cls.length} 行 ≤ 触发阈值 ${trigger}，暂不压缩`, stats }));
        return;
    }

    // 剥离重字段（2026-11-10 审计）：tool 消息里的 som_snapshot 标注图 base64
    //   （单条可达 39 万字符，top10 消息占全部 89%）不进压缩后历史——只留 detail 文本。
    const stripHeavy = (raw) => {
        try {
            const o = JSON.parse(raw);
            if (o && (o.role === 'tool' || o.role === 'assistant')) {
                let hit = false;
                for (const k of ['image', 'imageIsBase64', 'imageBase64', 'frames']) {
                    if (o[k] !== undefined) { delete o[k]; hit = true; }
                }
                if (hit) return JSON.stringify(o);
            }
            return raw;
        } catch (e) { return raw; }
    };

    const cut = cls.length - keep;                       // 驱逐区：[0, cut)
    const evict = cls.slice(0, cut);
    const evictKey = evict.filter((l) => l.kind === 'key');
    const keepLines = [
        ...evictKey.map((l) => stripHeavy(l.raw)),       // 关键行提到保留区（剥掉 base64 大字段）
        ...cls.slice(cut).map((l) => stripHeavy(l.raw)),
    ];

    // 驱逐段按 80 行一切片生成统计摘要
    const summaries = [];
    for (let i = 0; i < evict.length; i += 80) {
        const seg = evict.slice(i, i + 80);
        const s = summarizeSegment(seg);
        summaries.push({
            role: 'system',
            content: `[历史压缩] 第 ${i + 1}~${i + seg.length} 行归档：${s.turns} 轮对话（user ${s.userLines} / assistant ${s.asstLines}，环境注入 ${s.envInjected} 已弃）。` +
                (s.hotTopics.length ? '高频话题：' + s.hotTopics.join('、') + '。' : '') +
                '原文见同目录 对话历史.backup-*.jsonl。',
        });
    }

    const newLines = [
        ...summaries.map((s) => JSON.stringify(s)),
        ...keepLines,
    ];

    const report = {
        ok: true, action: dryRun ? 'dry-run' : 'apply',
        stats,
        plan: {
            evictLines: cut, evictKeyRescued: evictKey.length,
            summaries: summaries.length, newTotal: newLines.length,
            sizeBefore: fs.statSync(HISTORY).size,
        },
    };

    if (dryRun) {
        report.sampleSummary = summaries[0] || null;
        console.log(JSON.stringify(report, null, 2));
        return;
    }
    if (!apply) {
        console.log(JSON.stringify({ ok: false, error: '给 --dry-run 或 --apply' }));
        process.exit(1);
    }

    // ⚠ 2026-11-10 修复（并发压盘）：--apply 前先拿独占锁；另一个实例在跑就直接退出。
    //   dry-run 只读不落盘，不拿锁（原子 rename 保证它读到的一定是完整文件）。
    if (!acquireLock()) {
        console.log(JSON.stringify({ ok: true, action: 'skip', reason: '另一个压缩进程正在运行（锁文件 ' + LOCK + ' 存在），跳过本次' }));
        return;
    }

    // 备份 → 写回（原子：tmp + rename；tmp 名带 pid，两个进程不会共用同一个 tmp）
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const backup = path.join(path.dirname(HISTORY), '对话历史.backup-' + stamp + '.jsonl');
    fs.copyFileSync(HISTORY, backup);
    const tmp = HISTORY + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, newLines.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, HISTORY);
    report.plan.sizeAfter = fs.statSync(HISTORY).size;
    report.plan.backup = backup;
    console.log(JSON.stringify(report, null, 2));
}

main();
