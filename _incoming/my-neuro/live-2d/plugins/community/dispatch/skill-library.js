// skill-library.js —— 技能库（2026-11-09 三十五轮，P1）
//
// 为什么需要：
//   「打开 QQ 给张三发消息」这个任务她第一次要试 6 步（focus → snapshot → 找联系人 →
//   click → type → enter），第二次还得重试 6 步。人不是这样的——人做第二次就熟练了。
//   技能库就是把「验证成功过的动作序列」存下来，下次一条命令跑完。
//
// 设计来源（均为实测源码，见 docs/研究-DSH操控插件源码对比-2026-11-09.md）：
//   · beijingwahw/dsh-computer-use-plugin 的 Skill schema：
//       Skill{description, entrySceneHash, steps, successCount, attemptCount}
//     两个关键字段照抄：
//       entrySceneHash  → 我们叫 entryHash：存的时候记下画面 dHash，
//                          跑之前比对（sim ≥ 0.9 才允许跑）——「同一界面才可信」
//       exitFingerprint → 我们叫 exitHash：跑完比对（sim ≥ 0.75 才算成）——「用完是不是真成了」
//   · 关键纪律：**只有 verified 的成功才 successCount++**，未验证只加 attemptCount。
//     可靠度由世界盖章，不是自我报告。这条比任何技术实现都重要。
//   · Beta(1,1) 后验：mean = (s+1)/(n+2)，样本 <3 时把置信度打折（不吹牛）。
//
// 不做的（调研明确结论）：
//   · 参数化模板 / DTW 泛化（beijingwahw 那套 1085 行）—— 现阶段过度设计。
//     等技能库里同骨架技能真攒到 ≥5 条再考虑蒸馏。
//   · REPLAYABLE 白名单照抄：依赖运行时缓存的工具（click_element 靠编号）不能进技能，
//     因为编号每轮都变。只允许「参数自足」的动作。

'use strict';
const fs_ = require('fs');
const path_ = require('path');
const jsonStore = require('../../../js/core/json-store.js');
// E7（2026-11-22）：技能健康档案（生命周期 + 记账）。只依赖 json-store，无循环依赖。
const skillHealth = require('../../../js/core/skill-health.js');
// 解释器统一解析（原来这里也有一份硬编码的本机 Python313 绝对路径）
const { resolvePython } = require('../../../js/core/runtime-paths.js');

function findRoot(start, marker) {
    let dir = start || __dirname;
    for (let i = 0; i < 12; i += 1) {
        const cand = path_.join(dir, ...marker);
        if (fs_.existsSync(cand)) return cand;
        const up = path_.dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return null;
}

const KB_ROOT = findRoot(__dirname, ['pet-runtime', 'knowledge']);
// E7（2026-11-22）：PET_DATA_ROOT 隔离（测试用）。不设时与历史行为完全一致。
// 注意必须在 require 前设环境变量（skill-library 在模块加载时解析路径）。
const SKILL_DIR = process.env.PET_DATA_ROOT
    ? path_.join(path_.resolve(process.env.PET_DATA_ROOT), 'skills')
    : (KB_ROOT ? path_.join(KB_ROOT, 'skills') : null);
const SKILL_FILE = SKILL_DIR ? path_.join(SKILL_DIR, 'skills.json') : null;

// 可以进技能的动作（**参数自足**，不依赖运行时状态）。
// 关键排除：click_element / som_click / click_text（都靠编号/查找，编号每轮变）
// 2026-11-10 三十七轮加 visual_click：模板匹配是确定性动作（同模板+同窗口 → 同坐标），
//   参数就一个模板名，自足 ✓。PVZ 实测 3/3 命中，适合录进「进关卡」这类技能。
//   ⚠ 前提：模板文件还在（pet-runtime/knowledge/templates/）——重放时模板丢了会 notSent，
//   这是可接受的失败（诚实报错优于盲重放）。
const REPLAYABLE = new Set([
    'press_key', 'hold_key', 'click_at', 'type_text', 'focus_window',
    'launch_app', 'semantic', 'pvz', 'volume', 'mc', 'visual_click',
]);

// 危险动作：跑技能时要额外确认（技能是「以前成功过」不代表「现在该做」）
const RISKY = /删除|删除|格式化|关机|重启|注销|退出|卸载|clear|delete|format|shutdown|reboot/i;

// ── 存储 ────────────────────────────────────────────────────────────
//
// 原子写 + 损坏隔离统一在 js/core/json-store.js：
//   · 写 = 同目录 tmp → rename，不会留下半截 skills.json；
//   · 读坏了 = 改名 `skills.json.corrupt-<时间戳>` 隔离并锁死本进程读写，
//     避免「解析失败 → 空库 → 下一次 save 整个覆盖」把旧技能全丢。
//   本文件只保留技能库特有的严格语义：损坏必须抛错（save 也不能静默成功）。

// JSON.parse 永远不会返回 Symbol，用它区分「读失败」和「文件内容真的是 null」
const READ_FAILED = Symbol('skill-library-read-failed');

function load() {
    if (!SKILL_FILE) return { version: 1, skills: [] };
    if (jsonStore.isQuarantined(SKILL_FILE)) {
        throw new Error('技能库已隔离为 ' + (jsonStore.quarantinedPath(SKILL_FILE) || '（改名失败）') +
            '（本进程拒绝读写，避免空库覆盖）');
    }
    // 只有「文件不存在」= 首次运行，空库是正确的；权限/IO 错误不能当空库
    if (!fs_.existsSync(SKILL_FILE)) return { version: 1, skills: [] };

    const d = jsonStore.readJson(SKILL_FILE, READ_FAILED);
    if (jsonStore.isQuarantined(SKILL_FILE)) {
        throw new Error('技能库文件损坏。已隔离为 ' + (jsonStore.quarantinedPath(SKILL_FILE) || '（改名失败）') +
            '；为避免空库覆盖旧技能，本次拒绝写入。修好后把该文件改名回 skills.json 即可');
    }
    if (d === READ_FAILED) {
        throw new Error('技能库读不出来（权限/IO 错误）；为避免用空库覆盖，本次拒绝读写');
    }
    if (!d || !Array.isArray(d.skills)) {
        // 结构不合法也算损坏：隔离掉，避免下一次 save 用空库覆盖
        jsonStore.quarantineFile(SKILL_FILE, '结构不合法（缺 skills 数组）');
        throw new Error('技能库文件损坏（结构不合法，缺 skills 数组）。已隔离为 ' +
            (jsonStore.quarantinedPath(SKILL_FILE) || '（改名失败）') +
            '；为避免空库覆盖旧技能，本次拒绝写入。修好后把该文件改名回 skills.json 即可');
    }
    return d;
}

function save(db) {
    if (!SKILL_FILE) return { ok: false, error: '找不到知识库目录' };
    try {
        jsonStore.writeJson(SKILL_FILE, db);   // 自动建目录 + 原子替换；已隔离则抛错
        return { ok: true };
    } catch (e) {
        return { ok: false, error: '写入失败：' + e.message };
    }
}

// ── 执行历史（供 saveSkillFromHistory 用 + 跨会话「她记得做过什么」）──────────
//
// ⚠ 2026-11-10 三十九轮：原来 `_history` 是**纯内存**，重启即忘 —— 用户问
//   「你刚才让我干嘛了」她答不出来，saveSkillFromHistory 也只能切本轮。
//   现在：① 落盘 `pet-runtime/data/dispatch-history.jsonl`（滚动保留最近 500 条）
//         ② 启动时回读最近 40 条（内存窗口）③ 新增 `recent_actions` 动作让她可自查。
//   历史是「发生过的事实」，不是推断——这是她回答「刚才/上次做过什么」的唯一可靠来源。

let _history = [];
const HISTORY_MAX = 40;          // 内存窗口（saveSkillFromHistory 只切本轮）
const HIST_FILE_MAX = 500;       // 磁盘滚动窗口
const HIST_FLUSH_MS = 200;       // 批量落盘间隔（recordHistory 10 次/秒 → 合并成 5 次/秒）
let _histWrites = 0;
let _histQueue = [];
let _histTimer = null;

function _historyFile() {
    // E7：路径统一由 js/core/skill-health.js 决定（PET_DATA_ROOT 测试隔离也在这里生效）。
    // findRoot 返回的是**命中路径本身**（<root>/pet-runtime），不是父目录。
    return skillHealth.historyFile();
}

// ── 失败病历本（2026-11-14）──────────────────────────────────────────────
// 为什么要有它：同一类坑会反复踩。实证：用户让「打开 PCL」，PCL 开了又被关，
// 她连派三次都没解决 —— 真正的原因（`D:\mc\pcl.exe` 是另一份、有单实例锁、
// 检测到已有实例会自己退出）当时只存在于事后 grep 出来的日志里，**模型读不到**。
// 这里把它变成持久的「病历」：key = 应用名/关键词，note = 一句话说清坑在哪。
// 拦截 GUI 任务和 launch_app 失败时都读它，主动告诉模型「这个坑以前踩过」。
const PITFALL_MAX = 200;
const PITFALL_NOTE_MAX = 300;

function _pitfallFile() {
    const rt = findRoot(__dirname, ['pet-runtime']);
    return rt ? path_.join(rt, 'data', 'pitfalls.json') : null;
}

/**
 * 记一条坑。同 key 累计次数并更新时间；note 用后写的覆盖（越新越准）。
 * @param {string} key 应用名或关键词（大小写不敏感）
 * @param {string} note 一句话说清坑在哪、怎么绕
 */
function recordPitfall(key, note) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return null;
    const f = _pitfallFile();
    if (!f) return null;
    try {
        const db = jsonStore.readJson(f, { items: [] }) || { items: [] };
        if (!Array.isArray(db.items)) db.items = [];
        const now = Date.now();
        const hit = db.items.find((x) => x && x.key === k);
        if (hit) {
            hit.count = (hit.count || 1) + 1;
            hit.lastAt = now;
            if (note) hit.note = String(note).slice(0, PITFALL_NOTE_MAX);
        } else {
            db.items.push({ key: k, note: String(note || '').slice(0, PITFALL_NOTE_MAX), count: 1, firstAt: now, lastAt: now });
        }
        if (db.items.length > PITFALL_MAX) db.items = db.items.slice(-PITFALL_MAX);
        jsonStore.writeJson(f, db);
        return db.items.find((x) => x && x.key === k) || null;
    } catch (e) { return null; }
}

/** 查坑：不传 key 返回全部；传 key 时按「相等或互相包含」模糊匹配。 */
function getPitfalls(key) {
    const f = _pitfallFile();
    if (!f) return [];
    try {
        const db = jsonStore.readJson(f, { items: [] }) || { items: [] };
        const items = Array.isArray(db.items) ? db.items : [];
        const k = String(key || '').trim().toLowerCase();
        if (!k) return items.slice();
        return items.filter((x) => x && x.key && (x.key === k || x.key.includes(k) || k.includes(x.key)));
    } catch (e) { return []; }
}

/**
 * 从磁盘读执行历史（新→旧保持文件顺序，未反转）。
 * @param {number} limit 最多返回多少条（默认 HIST_FILE_MAX）；磁盘滚动窗口要看到 500 条时不能再被截到 200
 *
 * ⚠ 2026-11-10 修复：原来无论调用方要多少都 `slice(-200)`，但 HIST_FILE_MAX=500 ——
 *   每 50 次写做滚动压缩时用的是这 200 条 → **每 50 条把文件截到 200 行**，历史反复丢。
 *   现在加载用独立 limit，readHistoryFromDisk 才按调用方需要切片。
 */
function _loadHistoryFromDisk(limit) {
    try {
        const f = _historyFile();
        if (!f || !fs_.existsSync(f)) return [];
        const rows = fs_.readFileSync(f, 'utf8').split('\n').filter(Boolean)
            .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
            .filter(Boolean);
        const n = Number(limit);
        const cap = (Number.isFinite(n) && n > 0) ? Math.floor(n) : HIST_FILE_MAX;
        return cap >= rows.length ? rows : rows.slice(-cap);
    } catch (e) { return []; }
}

/**
 * 读跨会话执行历史（新的在前）。`limit` 默认 20。
 * 给 `recent_actions` 动作用：她回答「刚才/上次做了什么」时的唯一事实来源。
 */
function readHistoryFromDisk(limit = 20) {
    const rows = _loadHistoryFromDisk(HIST_FILE_MAX);
    const n = Math.max(1, Math.min(HIST_FILE_MAX, Number(limit) || 20));
    return rows.slice(-n).reverse();
}

/**
 * 把内存队列里的历史一次性同步刷盘（append 批量写 + 每 50 条滚动压缩）。
 * 同步实现：`process.on('exit')` 里也能用（exit 事件里不允许异步）。
 */
function _flushHistory() {
    if (_histTimer) { clearTimeout(_histTimer); _histTimer = null; }
    if (!_histQueue.length) return;
    const batch = _histQueue;
    _histQueue = [];
    try {
        const f = _historyFile();
        if (!f) return;
        fs_.mkdirSync(path_.dirname(f), { recursive: true });
        fs_.appendFileSync(f, batch.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');
        _histWrites += batch.length;
        // 每 50 次写做一次滚动压缩（别让文件无限长）
        if (_histWrites >= 50) {
            _histWrites = 0;
            // 多读 1 条用来判断「是否真的超了」：没超就不重写（避免无谓整文件重写）
            const rows = _loadHistoryFromDisk(HIST_FILE_MAX + 1);
            if (rows.length > HIST_FILE_MAX) jsonStore.writeJsonl(f, rows.slice(-HIST_FILE_MAX));
        }
    } catch (e) { /* 历史落盘失败不影响主链 */ }
}

function _scheduleHistoryFlush() {
    if (_histTimer) return;
    _histTimer = setTimeout(_flushHistory, HIST_FLUSH_MS);
    // unref：不因为一个待刷盘的定时器把进程钉住（Electron 里尤其重要）
    if (_histTimer && typeof _histTimer.unref === 'function') _histTimer.unref();
}

// 退出前同步兜底：保证 200ms 窗口内的最后几条不丢
process.on('exit', () => { try { _flushHistory(); } catch (e) { /* ignore */ } });

// 启动时回读（模块加载即执行一次）
try { _history = _loadHistoryFromDisk(HISTORY_MAX); } catch (e) { _history = []; }

/** 每次 runGameAction 成功/失败都进来记一笔，saveSkillFromHistory 从里面切片 */
function recordHistory(entry) {
    if (!entry || !entry.action) return;
    const rec = {
        ts: Date.now(),
        action: String(entry.action),
        arg: String(entry.arg || ''),
        ok: entry.ok === true,
        verified: entry.verified,
        effect: String(entry.effect || ''),
    };
    // B1（2026-11-21）：账本 join 字段（任务/目标/执行器/成本）。
    // 只写有值的 —— 历史文件里不该出现一排 null；老读取方忽略未知键，形状向后兼容。
    if (entry.taskId) rec.taskId = String(entry.taskId).slice(0, 64);
    if (entry.goalId) rec.goalId = String(entry.goalId).slice(0, 64);
    if (entry.via) rec.via = String(entry.via).slice(0, 24);
    if (Number.isFinite(entry.costMs)) rec.costMs = Math.round(entry.costMs);
    _history.push(rec);
    if (_history.length > HISTORY_MAX) _history = _history.slice(-HISTORY_MAX);
    // ⚠ 2026-11-10 修复：原来每个动作都同步 append 一次（GAME_ACTIONS 600/分 = 10 次/秒）。
    //   现在进内存队列，200ms 批量 flush 一次（数量级降到 5 次/秒，且一次 write 写多行）。
    _histQueue.push(rec);
    if (_histQueue.length >= 200) { _flushHistory(); return; }   // 刷盘持续失败时防内存无界
    _scheduleHistoryFlush();
}

function getHistory() { return _history.slice(); }
function clearHistory() { _history = []; }

// ── 画面指纹（复用 game-control 的 dHash 思路，这里独立实现避免循环依赖）──

function screenHash() {
    return new Promise((resolve) => {
        const py = resolvePython();
        // ⚠ findRoot 返回的是**目录本身**（pet-runtime/tools），不能再 join 一次
        // （踩过：之前 path.join(root, 'pet-runtime','tools',...) 拼成 .../tools/pet-runtime/tools/...）
        const toolsDir = findRoot(__dirname, ['pet-runtime', 'tools']);
        if (!toolsDir) return resolve(null);
        const script = path_.join(toolsDir, 'screen-hash.py');
        if (!fs_.existsSync(script)) return resolve(null);
        require('child_process').execFile(py, [script], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
            if (err) return resolve(null);
            const h = String(stdout || '').trim();
            resolve(/^[0-9a-f]{16}$/i.test(h) ? h.toLowerCase() : null);
        });
    });
}

/** 两个 dHash 的相似度（0~1）。1 = 完全相同。 */
function hashSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) { diff += x & 1; x >>= 1; }
    }
    const total = a.length * 4;
    return Math.max(0, 1 - diff / total);
}

// ── 可靠度（Beta 后验）────────────────────────────────────────────────

function reliabilityOf(sk) {
    const s = Number(sk.successCount) || 0;
    const n = Number(sk.attemptCount) || 0;
    const mean = (s + 1) / (n + 2);
    const alpha = s + 1;
    const beta = (n - s) + 1;
    const ci = 1.96 * Math.sqrt((alpha * beta) / ((alpha + beta) * (alpha + beta) * (alpha + beta + 1)));
    return {
        successCount: s, attemptCount: n,
        mean: Math.round(mean * 1000) / 1000,
        ciHalf: Math.round(ci * 1000) / 1000,
        verdict: n < 3 ? 'insufficient' : (mean >= 0.7 ? 'reliable' : (mean <= 0.3 ? 'unreliable' : 'mixed')),
    };
}

// ── 对外 API ─────────────────────────────────────────────────────────

function listSkills() {
    const db = load();
    return db.skills
        .filter((s) => !s.deleted)
        .map((s) => Object.assign({}, s, { reliability: reliabilityOf(s) }));
}

/**
 * 把最近一段「连续成功的动作」存成技能。
 * @param {string} name
 * @param {object} opts { description, maxSteps }
 */
function saveSkillFromHistory(name, opts) {
    const o = opts || {};
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, error: '技能名不能为空' };

    // 从历史里切出「最近一段连续成功」的动作
    const hist = getHistory();
    if (!hist.length) return { ok: false, error: '执行历史是空的', hint: '先做几个动作（成功的），再 skill save' };

    const steps = [];
    for (let i = hist.length - 1; i >= 0; i -= 1) {
        const h = hist[i];
        if (!h.ok && h.effect !== 'confirmed_idempotent') break;   // 断了
        if (!REPLAYABLE.has(h.action)) {
            // 不可重放的动作跳过（但不断链 —— 它可能只是个查询）
            continue;
        }
        steps.unshift({ action: h.action, arg: h.arg });
        if (steps.length >= (o.maxSteps || 12)) break;
    }
    if (!steps.length) {
        return {
            ok: false, error: '最近没有可重放的成功动作',
            hint: 'click_element / som_click / click_text 依赖编号，不能存进技能。用 click_at（坐标）或 semantic（语义动作）替代',
        };
    }

    // 危险动作警告
    const risky = steps.find((s) => RISKY.test(s.arg));

    // 自动判定 scope（见上面 schema 注释）
    const first = steps[0] || {};
    const firstIsEntryReset =
        first.action === 'focus_window' ||
        (first.action === 'press_key' && /^(esc|escape|alt\+f4)$/i.test(String(first.arg || ''))) ||
        (first.action === 'click_element' && /首页|home|返回|back/i.test(String(first.arg || '')));
    const scope = firstIsEntryReset ? 'any' : 'exact';
    const db = load();
    // ⚠ 2026-11-09 修：原来查找不排除 deleted —— 删过的技能会被当成「已存在」，
    //   走 dedup 分支只 bump 计数，技能永远「复活」不了（实测：save 返回 ok 但 list 是空）。
    //   现在：同名但已删的记录直接**原地复活**（保留历史成功/失败计数，那是有价值的）。
    let existing = db.skills.find((s) => s.name === nm && !s.deleted);
    const tombstone = db.skills.find((s) => s.name === nm && s.deleted);
    if (!existing && tombstone) {
        tombstone.deleted = false;
        tombstone.deletedAt = undefined;
        existing = tombstone;
    }
    if (existing) {
        // 去重：步骤签名一致 → 只 bump 计数不建新卡（照 beijingwahw 的做法）
        const sig = JSON.stringify(steps.map((s) => s.action + '|' + s.arg));
        const oldSig = JSON.stringify((existing.steps || []).map((s) => s.action + '|' + s.arg));
        if (sig === oldSig) {
            existing.attemptCount = (existing.attemptCount || 0) + 1;
            existing.updatedAt = new Date().toISOString();
            const w = save(db);
            if (!w.ok) return { ok: false, error: w.error };
            return { ok: true, deduped: true, steps: steps.length, skill: existing, hint: '步骤完全一样，只更新了计数' };
        }
        // 步骤变了 → 覆盖
        existing.steps = steps;
        existing.description = o.description || existing.description;
        existing.updatedAt = new Date().toISOString();
        const w = save(db);
        if (!w.ok) return { ok: false, error: w.error };
        return { ok: true, updated: true, steps: steps.length, skill: existing };
    }

    const sk = {
        name: nm,
        description: o.description || name + '（' + steps.length + ' 步）',
        steps,
        // 前置条件：存的时候记画面指纹（「同一界面才可信」）
        entryHash: null,        // 异步补，下面 save 后再补
        exitHash: null,
        // scope 决定「entryHash 检查有多严」（2026-11-09 三十五轮补）：
        //   'exact' —— 必须画面相似（sim ≥ 0.9）才能跑。适合「点某个特定按钮」这类技能
        //   'any'   —— 任意画面都能跑。适合「回首页 / 切窗口 / 按 esc」这类**本身就是改变界面**的技能
        // 自动判定：第一步是 focus_window / press_key(esc) / click_element 首页 → 'any'
        // 为什么：这类技能录的时候和跑的时候画面天然不同，用 0.9 卡它就是永远跑不了（实测踩到）
        scope: 'exact',
        successCount: 0,        // 从 0 开始 —— 第一次跑成功才算 1
        attemptCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        risky: !!risky,
        scope,
    };
    db.skills.push(sk);
    const w = save(db);
    if (!w.ok) return { ok: false, error: w.error };

    // 异步补 entryHash（存技能时的画面 = 「这个技能适用的场景」）
    screenHash().then((h) => {
        if (!h) return;
        const db2 = load();
        const s2 = db2.skills.find((x) => x.name === nm);
        if (s2 && !s2.entryHash) { s2.entryHash = h; save(db2); }
    }).catch(() => { /* 拍不到就留空，不阻塞 */ });

    return { ok: true, steps: steps.length, skill: sk, risky: !!risky };
}

/**
 * 技能回放内核（E7 拆出）：前置场景检查 → 逐步执行 → 后置验证。
 * 生命周期闸门/记账在下面的 runSkill 包装层（保持这段逻辑原样，便于回归）。
 * @param {string} name
 * @param {object} deps { runGameAction }
 */
async function _runSkillCore(name, deps) {
    const nm = String(name || '').trim();
    const db = load();
    const sk = db.skills.find((s) => s.name === nm && !s.deleted);
    if (!sk) return { ok: false, verified: null, unverified: true, effect: 'not_sent', detail: '没这个技能：' + nm, tier: 'L3', noSuchSkill: true };

    const VC = require('./verify-contract.js');
    const run = (deps && deps.runGameAction) || null;
    if (!run) return VC.notSent('技能库缺少 runGameAction 依赖（内部错误）');

    // ① 前置场景检查：画面得和存的时候像（sim ≥ 0.9）
    //    ⚠ 这一环比「直接跑」重要得多：技能里存的坐标/动作只在特定画面下成立。
    //      在别的界面跑，轻则失败，重则点到不该点的地方。
    //
    //    ⚠ 2026-11-09 三十五轮修：`scope === 'any'` 的技能**跳过**这一环。
    //      实测踩到：「回 ZCode 首页」（focus_window → press_key esc）录的时候在 A 页面，
    //      跑的时候在 B 页面，sim 0.70 < 0.9 → 永远拒绝执行。
    //      但这类技能**本来就是用来改变界面**的，用「同一界面」卡它是逻辑错误。
    let entryCheck = null;
    const isAnyScope = sk.scope === 'any';
    if (sk.entryHash && !isAnyScope) {
        const now = await screenHash();
        if (now) {
            const sim = hashSimilarity(sk.entryHash, now);
            entryCheck = { sim: Math.round(sim * 1000) / 1000, threshold: 0.9, pass: sim >= 0.9 };
            if (!entryCheck.pass) {
                // 不硬跑 —— 报清楚为什么
                sk.attemptCount = (sk.attemptCount || 0) + 1;
                save(db);
                return VC.notSent(
                    '技能「' + nm + '」的前置画面不匹配（相似度 ' + entryCheck.sim + ' < 0.9）',
                    {
                        tier: 'L2', entryCheck,
                        scope: sk.scope || 'exact',
                        nextIfFailed: '这个技能是在另一个界面下录的。先把界面切回去（或用 focus_window），或者把这个技能当成参考而不是照抄。' +
                            '如果它本身就是「改变界面」的技能（回首页之类），删掉重存会自动识别成 scope=any',
                    },
                );
            }
        }
    }

    // ② 逐步执行
    const t0 = Date.now();
    const results = [];
    let allOk = true;
    for (let i = 0; i < (sk.steps || []).length; i += 1) {
        const step = sk.steps[i];
        let r;
        try {
            r = await run(step.action, step.arg);
        } catch (e) {
            r = { ok: false, error: e && e.message || String(e) };
        }
        results.push({ step: i + 1, action: step.action, arg: step.arg, ok: r && r.ok === true, effect: r && r.effect, detail: r && r.detail });
        // 只要一步明确失败就停（继续跑下去可能把状态搞乱）
        if (r && r.ok === false) { allOk = false; break; }
    }

    // ③ 后置验证：画面得和存的时候像（sim ≥ 0.75）—— 这才是「真的做成了」
    let exitCheck = null;
    let exitSim = null;
    if (sk.exitHash) {
        const now = await screenHash();
        if (now) {
            exitSim = hashSimilarity(sk.exitHash, now);
            exitCheck = { sim: Math.round(exitSim * 1000) / 1000, threshold: 0.75, pass: exitSim >= 0.75 };
        }
    }

    // ④ 记账：**只有 verified 的成功才 successCount++**（照 beijingwahw 的纪律）
    //   ⚠ 2026-11-09 修：原来 verifiedOk 要求 exitCheck 存在且 pass，
    //     导致「技能还没录 exitHash」（第一次跑）永远判失败 —— 实测踩到。
    //     正确语义分三档：
    //       有 exitHash 且 sim ≥ 0.75  → 确认成功
    //       有 exitHash 且 sim <  0.75 → 确认失败（做了但结果不对，这是最危险的）
    //       没 exitHash（第一次跑）    → **无法验证**，不算成功也不算失败，顺手把这次画面记成 exitHash
    const hasExit = !!sk.exitHash;
    const verifiedOk = allOk && hasExit && exitCheck && exitCheck.pass;
    sk.attemptCount = (sk.attemptCount || 0) + 1;
    if (verifiedOk) sk.successCount = (sk.successCount || 0) + 1;
    // 没 exitHash 的技能第一次跑成功（每步都 ok）→ 把这次画面记下来当后置指纹
    let learnedExit = false;
    if (allOk && !sk.exitHash) {
        const now = await screenHash();
        if (now) { sk.exitHash = now; learnedExit = true; }
    }
    sk.lastRunAt = new Date().toISOString();
    save(db);

    const ms = Date.now() - t0;
    const base = {
        steps: results, entryCheck, exitCheck, costMs: ms,
        scope: sk.scope || 'exact',
        reliability: reliabilityOf(sk),
    };

    if (verifiedOk) {
        return VC.confirmed('技能「' + nm + '」跑完了（' + results.length + ' 步，' + ms + 'ms）', Object.assign({ tier: 'L2' }, base));
    }
    if (!allOk) {
        const failed = results[results.length - 1];
        return VC.failed('技能「' + nm + '」在第 ' + failed.step + ' 步失败了：' + (failed.detail || ''), Object.assign({
            tier: 'L2',
            nextIfFailed: '这一步当年是成功的，现在失败说明界面变了或状态不对。先 snapshot 或截图看看现场，别盲目重跑',
        }, base));
    }
    // 每步都 ok，但要么刚学到 exitHash、要么后置画面不匹配
    if (exitCheck && !exitCheck.pass) {
        return VC.failed('技能「' + nm + '」每步都执行了，但最后画面和预期不一致（相似度 ' + exitCheck.sim + '）', Object.assign({
            tier: 'L2',
            nextIfFailed: '动作发出去了但结果不像预期。这正是「假成功」最容易藏的地方——先截图确认到底做了什么',
        }, base));
    }
    // 第一次跑：每步都 ok 但没有基准可对比 —— 诚实标「未验证」
    return VC.unverified('技能「' + nm + '」每步都执行了（' + results.length + ' 步，' + ms + 'ms）' + (learnedExit ? '；已把当前画面记成这个技能的预期结果，下次跑就能验证' : '；拍不到画面，没法记预期结果'), Object.assign({
        tier: 'L3',
        nextIfFailed: '第一次跑没有基准画面，无法确认最终结果。用 som_snapshot 或截图看一眼；下次再跑就能自动比对了',
        learnedExit,
    }, base));
}

/**
 * 跑一个技能（E7 生命周期包装层，2026-11-22）：
 *   ① 执行前查健康档案：quarantined → **拒绝执行**并给出 --revive 说明；
 *      dormant → 放行，但在结果里标「降权」。
 *   ② 执行后记账：连败 ≥5 自动隔离、≥3 转休眠（skillHealth 里判定）。
 *   ③ 追加一条 skill_run 历史（跨会话 `skill health` 也能从执行档案算）。
 */
async function runSkill(name, deps) {
    const nm = String(name || '').trim();

    // ① 生命周期闸门（隔离 = 连败 ≥5 / 显式隔离）
    let gate = null;
    try { gate = skillHealth.canRun(nm); } catch (e) { gate = { allowed: true, state: 'active', reason: '' }; }
    if (gate && gate.allowed === false) {
        const VC = require('./verify-contract.js');
        return VC.notSent('技能「' + nm + '」已被隔离（' + gate.reason + '），本次拒绝执行', {
            tier: 'L3',
            quarantined: true,
            health: { state: gate.state, reason: gate.reason },
            nextIfFailed: gate.nextIfFailed || ('确认修好后显式复活：skill health --revive ' + nm),
        });
    }

    // ② 执行
    const r = await _runSkillCore(nm, deps);

    // ③ 记账（找不到技能不记；隔离拒绝在上面已经返回，不会走到这里）
    try {
        if (r && r.noSuchSkill !== true) {
            const rec = skillHealth.recordAttempt(nm, r, { kind: 'skill' });
            if (gate && gate.state === 'dormant' && r) {
                r.health = (rec && rec.health) || { state: 'dormant', reason: gate.reason };
                r.healthHint = '该技能处于休眠（降权，仍会执行）：' + (gate.reason || '') +
                    '；可 skill health 查看，skill health --revive ' + nm + ' 恢复';
            }
        }
    } catch (e) { /* 记账失败不影响执行结果的真假 */ }

    // ④ 执行档案（skill_run 行；滚动 500 条）
    try {
        if (r && r.noSuchSkill !== true) {
            recordHistory({
                action: 'skill_run', arg: nm,
                ok: r.ok === true, verified: r.verified, effect: r.effect,
                detail: String(r.detail || '').slice(0, 160),
            });
        }
    } catch (e) { /* ignore */ }

    return r;
}

function forgetSkill(name) {
    const nm = String(name || '').trim();
    const db = load();
    const sk = db.skills.find((s) => s.name === nm && !s.deleted);
    if (!sk) return { ok: false, error: '没这个技能' };
    sk.deleted = true;
    sk.deletedAt = new Date().toISOString();
    const w = save(db);
    return w.ok ? { ok: true } : { ok: false, error: w.error };
}

// ── 技能自动沉淀（2026-11-10）──────────────────────────────────────────
// 用户原话：「24h 内同序列成功 2 次 → 提示 skill save」。
// 只做提示，不自动建卡：技能要不要存、叫什么名字，仍由她/用户决定。
const SEDIMENT_WINDOW_MS = 24 * 3600 * 1000;
const SEDIMENT_MIN_STEPS = 2;
const SEDIMENT_MAX_STEPS = 6;
const SEDIMENT_HINT_GAP_MS = 10 * 60 * 1000;
let _lastHintSig = '';
let _lastHintAt = 0;

const _sigOf = (steps) => JSON.stringify((steps || []).map((s) => String(s.action) + '|' + String(s.arg || '')));

/** 把历史切成「连续成功段」；查询类跳过但不断链（与 saveSkillFromHistory 同口径）。 */
function _successfulRuns(rows) {
    const runs = [];
    let run = [];
    for (const h of rows || []) {
        const good = h && (h.ok === true || h.effect === 'confirmed_idempotent');
        if (!good) { if (run.length) runs.push(run); run = []; continue; }
        if (!REPLAYABLE.has(String(h.action))) continue;
        run.push({ action: String(h.action), arg: String(h.arg || '') });
    }
    if (run.length) runs.push(run);
    return runs;
}

/**
 * 纯逻辑：从历史行里检测「最近这一段动作」是否在窗口内成功跑过 ≥2 次。
 * 抽出来是为了可单测（不读盘、不看节流）。返回 null 或命中。
 */
function detectRepeatedSequenceIn(rows) {
    try {
        const runs = _successfulRuns(rows);
        if (!runs.length) return null;
        const tail = runs[runs.length - 1].slice(-12);
        if (tail.length < SEDIMENT_MIN_STEPS) return null;
        const activeSigs = new Set(listSkills().map((s) => _sigOf(s.steps)));
        for (let k = SEDIMENT_MIN_STEPS; k <= Math.min(SEDIMENT_MAX_STEPS, tail.length); k += 1) {
            const seq = tail.slice(-k);
            // 至少要有两个不同的步骤，否则「同一个键连按两次」也会被当技能（噪声）
            if (new Set(seq.map((x) => x.action + '|' + x.arg)).size < 2) continue;
            const sig = _sigOf(seq);
            if (activeSigs.has(sig)) continue;             // 已经存成技能了，不烦她
            let count = 0;
            for (const run of runs) {
                for (let i = 0; i + k <= run.length; i += 1) {
                    let same = true;
                    for (let j = 0; j < k; j += 1) {
                        if (run[i + j].action !== seq[j].action || run[i + j].arg !== seq[j].arg) { same = false; break; }
                    }
                    if (same) count += 1;
                }
            }
            if (count < 2) continue;
            const head = seq[0];
            const suggestedName = (head.action + (head.arg ? ' ' + head.arg : '')).slice(0, 24) + ' 流程';
            return { steps: seq, sig, count, suggestedName };
        }
    } catch (e) { try { __silentAudit.audit('skill-library.js:detectRepeatedSequenceIn', e); } catch (e2) {} }
    return null;
}

/**
 * 检测「最近这一段动作」在 24h 内是否已经成功跑过 ≥2 次（带 10 分钟提示节流）。
 * @returns {null | { steps:Array<{action,arg}>, sig:string, count:number, suggestedName:string }}
 */
function detectRepeatedSequence() {
    try {
        const now = Date.now();
        const rows = readHistoryFromDisk(HIST_FILE_MAX)
            .filter((h) => now - Number(h.ts || 0) <= SEDIMENT_WINDOW_MS);
        const found = detectRepeatedSequenceIn(rows);
        if (!found) return null;
        if (_lastHintSig === found.sig && now - _lastHintAt < SEDIMENT_HINT_GAP_MS) return null;
        _lastHintSig = found.sig;
        _lastHintAt = now;
        return found;
    } catch (e) { try { __silentAudit.audit('skill-library.js:detectRepeatedSequence', e); } catch (e2) {} }
    return null;
}

module.exports = {
    listSkills, saveSkillFromHistory, runSkill, forgetSkill,
    recordHistory, getHistory, clearHistory, readHistoryFromDisk,
    recordPitfall, getPitfalls,
    detectRepeatedSequence, detectRepeatedSequenceIn,
    reliabilityOf, hashSimilarity, REPLAYABLE,
    SKILL_FILE,
};
