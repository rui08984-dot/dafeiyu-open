// js/core/json-store.js —— 所有 JSON 落盘的唯一入口（原子写 + 损坏隔离）
//
// 为什么需要这一层：
//   项目里原来散着 7+ 套裸 `fs.writeFileSync`，其中多处读失败直接 `catch { return [] }`。
//   两个后果都很要命：
//     ① 直接写目标文件，写到一半崩溃/断电 → 留下半截 JSON；
//     ② 读的时候解析失败静默返回空数组，下一次保存拿空数组**整个覆盖** → 旧数据永久丢失。
//        用户收不到任何提示，只会发现「我记的东西没了」。
//
// 这里的约定（调用方只需要改读写这一层，业务逻辑不用动）：
//   · 写 = 同目录 tmp 文件 → rename 覆盖（同分区原子替换）；绝不直接写目标文件。
//     tmp 名带 pid + 时间戳 + 随机后缀，同进程并发写也不会互相踩。
//   · 读坏了 = 把坏文件改名成 `<name>.corrupt-<时间戳>` **隔离**（原始数据还在，可以人工抢救），
//     并在进程内记住「这个文件坏过」——调用方用 isQuarantined 判断，本轮别写回。
//     为什么不直接覆盖：坏文件是用户数据唯一的残骸，覆盖掉就真没了；隔离后至少还能手工修。
//   · 一切异常都有 console.warn，不再静默。文件不存在/空文件不算损坏（首次运行的正常态）。
'use strict';
const fs = require('fs');
const path = require('path');

// 已隔离文件表：绝对路径 → 隔离后的路径（改名失败时为 null，但仍禁止写回）
const _quarantined = new Map();

function _abs(filePath) {
    return path.resolve(String(filePath));
}

// 同目录 tmp：同分区才能保证 rename 是原子替换（跨分区 rename 会退化成复制）
function _tmpPath(file) {
    return file + '.tmp-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 把损坏文件改名隔离，并在本进程内锁定它。
 * @param {string} filePath 坏文件
 * @param {string} [reason] 损坏原因（会写进日志）
 * @returns {string|null} 隔离后的路径；改名失败返回 null（但仍会锁定写回）
 */
function quarantineFile(filePath, reason) {
    const file = _abs(filePath);
    if (_quarantined.has(file)) return _quarantined.get(file);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bad = file + '.corrupt-' + stamp;
    try {
        fs.renameSync(file, bad);
    } catch (e) {
        // 文件已经不存在 = 没东西可隔离，不算损坏（并发下可能出现）
        if (e && e.code === 'ENOENT') return null;
        // 改名失败（被占用/权限）也不能让下一次保存把坏文件盖掉：仍然锁定，只是没有备份名
        console.warn('[json-store] 损坏文件隔离失败：' + file +
            '（' + (e && e.message) + '）；本进程拒绝写回，请手工备份后检查');
        _quarantined.set(file, null);
        return null;
    }

    _quarantined.set(file, bad);
    console.warn('[json-store] 文件损坏' + (reason ? '（' + reason + '）' : '') +
        '，已隔离为 ' + bad + '；本进程不再写回（数据可人工抢救，修好后改名回原文件即可）');
    return bad;
}

/**
 * 读 JSON（同步）。解析失败 → 隔离坏文件、记 warn、返回 fallback；并在本进程标记禁止写回。
 * 文件不存在 / 空文件返回 fallback，不算损坏（首次运行是正常的）。
 * 注意：一旦本进程隔离过该文件，后续 readJson 一律返回 fallback，直到重启（防止「读空 → 写空」循环）。
 * @template T
 * @param {string} filePath
 * @param {T} [fallback]
 * @returns {any|T}
 */
function readJson(filePath, fallback = null) {
    const file = _abs(filePath);
    if (_quarantined.has(file)) return fallback;

    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        // 只有「文件不存在」是正常态；权限/IO 错误要出声，但仍按调用方约定返回 fallback
        if (e && e.code !== 'ENOENT') {
            console.warn('[json-store] 读不出来：' + file + '（' + (e && e.message) + '）');
        }
        return fallback;
    }

    // 空文件 = 还没写过数据，不是损坏；也不能隔离（否则第一次启动就会被锁死）
    if (!text.trim()) return fallback;

    try {
        return JSON.parse(text);
    } catch (e) {
        quarantineFile(file, e && e.message);
        return fallback;
    }
}

// 项目里全是同步调用，保留这个别名方便调用方按语义选名字
const readJsonSync = readJson;

/**
 * 原子写 JSON：先写同目录 tmp，再 rename 覆盖目标。
 * 写前自动建目录；文件一旦被隔离过则**拒绝写回**（抛错，让调用方明确知道这轮没保存）。
 * @param {string} filePath
 * @param {any} data
 * @param {{pretty?: boolean}} [options] pretty=false 用于体积敏感的大缓存（默认两空格缩进）
 */
function writeJson(filePath, data, options) {
    const file = _abs(filePath);
    if (_quarantined.has(file)) {
        throw new Error('文件已隔离为 ' + (_quarantined.get(file) || '（改名失败）') +
            '，本进程拒绝写回：' + file);
    }

    const pretty = !options || options.pretty !== false;
    const text = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const tmp = _tmpPath(file);
    try {
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* 清不掉就留审计，不掩盖原错误 */ }
        throw e;
    }
}

/**
 * 读 JSONL（一行一条）。单行坏了只跳过该行，不影响其他行；整文件读不到返回 fallback。
 * 与 readJson 不同：**不隔离整文件**——JSONL 的容损单位是行，不是文件。
 * @param {string} filePath
 * @param {any[]} [fallback]
 * @returns {any[]}
 */
function readJsonl(filePath, fallback = []) {
    const file = _abs(filePath);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            console.warn('[json-store] 读不出来：' + file + '（' + (e && e.message) + '）');
        }
        return fallback;
    }

    const out = [];
    let bad = 0;
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { out.push(JSON.parse(t)); } catch (e) { bad += 1; }
    }
    if (bad) console.warn('[json-store] ' + file + ' 有 ' + bad + ' 行不是合法 JSON，已跳过（其余行正常）');
    return out;
}

/**
 * 原子写 JSONL：整文件重写时用（追加请直接 appendFileSync，追加不存在半截覆盖问题）。
 * @param {string} filePath
 * @param {any[]} rows
 */
function writeJsonl(filePath, rows) {
    const file = _abs(filePath);
    if (_quarantined.has(file)) {
        throw new Error('文件已隔离为 ' + (_quarantined.get(file) || '（改名失败）') +
            '，本进程拒绝写回：' + file);
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = _tmpPath(file);
    try {
        fs.writeFileSync(tmp, (rows || []).map((r) => JSON.stringify(r) + '\n').join(''), 'utf8');
        fs.renameSync(tmp, file);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
        throw e;
    }
}

/** 这个文件在本进程里是否损坏过（坏过就别再写回，避免用空数据覆盖残骸） */
function isQuarantined(filePath) {
    return _quarantined.has(_abs(filePath));
}

/** 隔离后的备份路径；没隔离过或改名失败返回 null */
function quarantinedPath(filePath) {
    return _quarantined.get(_abs(filePath)) || null;
}

module.exports = {
    readJson,
    readJsonSync,
    writeJson,
    readJsonl,
    writeJsonl,
    isQuarantined,
    quarantinedPath,
    quarantineFile,
};
