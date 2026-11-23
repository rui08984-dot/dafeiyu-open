// minecraft-rcon.cjs —— Minecraft 零注入陪玩（2026-11-09 三十轮）
//
// 为什么用 RCON 而不是键鼠注入：
//   调研结论（docs/研究-游戏陪玩技术方案-2026-11-09.md）：
//   键鼠注入属「模拟输入」，腾讯把鼠标宏定性为外挂；而 Minecraft 服务端**原生支持 RCON**，
//   这是官方协议，零注入、零反作弊风险，单机/自建服都能开。
//
// 能力（全部走服务端命令，不是按键）：
//   · 看她/他在哪：`data get entity <player> Pos`（只读）
//   · 说话：`tellraw <player> {"text":"..."}`（游戏内聊天框出现她的话）
//   · 给东西/效果：`give` / `effect`（可关）
//   · 传送/时间/天气：`tp` / `time set` / `weather`
//   · 执行任意白名单命令
//
// 前提：服务端 server.properties 里
//   enable-rcon=true
//   rcon.port=25575
//   rcon.password=<自己设一个>
//
// 协议：RCON over TCP（Valve RCON 变体），packet = len(4) + id(4) + type(4) + body + \0\0
//   type 3 = 命令, type 2 = 命令响应, type 0 = 认证
//   ⚠ RCON 是**明文**协议，只在本机/局域网内用，别暴露公网。

const net = require('net');
const crypto = require('crypto');

const STATE = { lastAt: 0, window: [] };

class Rcon {
    constructor({ host = '127.0.0.1', port = 25575, password = '', timeout = 5000 } = {}) {
        this.host = host; this.port = port; this.password = password; this.timeout = timeout;
        this.sock = null; this.id = 0; this.buf = Buffer.alloc(0); this.pending = null;
    }

    connect() {
        return new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: this.host, port: this.port });
            sock.setTimeout(this.timeout);
            let settled = false;
            const fail = (e) => { if (settled) return; settled = true; try { sock.destroy(); } catch (_) { /* ignore */ } reject(e); };
            sock.once('error', (e) => fail(new Error('RCON 连接失败：' + (e.code || e.message))));
            sock.once('timeout', () => fail(new Error('RCON 超时（服务端没开 enable-rcon 或端口不对）')));
            sock.once('connect', () => { settled = true; this.sock = sock; this._bindReader(); resolve(); });
        });
    }

    _bindReader() {
        this.sock.on('data', (chunk) => {
            this.buf = Buffer.concat([this.buf, chunk]);
            while (this.buf.length >= 12) {
                const len = this.buf.readInt32LE(0);
                if (this.buf.length < 4 + len) break;
                const id = this.buf.readInt32LE(4);
                const type = this.buf.readInt32LE(8);
                const body = this.buf.slice(12, 4 + len - 2).toString('utf8');
                this.buf = this.buf.slice(4 + len);
                if (this.pending) {
                    const p = this.pending; this.pending = null;
                    if (type === 2 && id === -1) p.reject(new Error('RCON 密码错误'));
                    else p.resolve({ id, type, body });
                }
            }
        });
    }

    send(type, body) {
        return new Promise((resolve, reject) => {
            if (!this.sock || this.sock.destroyed) return reject(new Error('RCON 未连接'));
            const id = ++this.id;
            const payload = Buffer.from(body, 'utf8');
            const buf = Buffer.alloc(4 + 4 + 4 + payload.length + 2);
            buf.writeInt32LE(payload.length + 10, 0);
            buf.writeInt32LE(id, 4);
            buf.writeInt32LE(type, 8);
            payload.copy(buf, 12);
            buf.writeInt16LE(0, 12 + payload.length);
            this.pending = { resolve, reject };
            this.sock.write(buf);
            setTimeout(() => {
                if (this.pending && this.pending.reject === reject) {
                    this.pending = null;
                    reject(new Error('RCON 响应超时'));
                }
            }, this.timeout);
        });
    }

    async auth() {
        const r = await this.send(3, this.password);
        if (r.id === -1) throw new Error('RCON 密码错误');
        return true;
    }

    async command(cmd) {
        const r = await this.send(2, String(cmd));
        return String(r.body || '').trim();
    }

    close() { try { if (this.sock) this.sock.destroy(); } catch (_) { /* ignore */ } this.sock = null; }
}

// ── 安全白名单（只放行这些命令类型）──────────────────────────────────────
// 原则：只读查询全放行；改世界的命令要显式 allowWorldModify。
const READONLY_CMDS = /^(list|data get|tellraw|say|time query|weather query|scoreboard players get|seed|difficulty|gamerule .*query)/i;
const SAFE_CMDS = /^(list|data get|tellraw|say|time (query|set)|weather (clear|rain|thunder|query)|effect give|effect clear|give|tp|spawnpoint|gamemode (survival|creative|adventure|spectator)|playsound|title|actionbar|summon (armor_stand|item))/i;
const DANGEROUS = /(op |deop |ban |kick |stop|save-off|whitelist off|kill @a|fill .* air|setblock .* air|clone |function )/i;

function guard(cmd, { allowWorldModify = false } = {}) {
    const c = String(cmd || '').trim();
    if (!c) return '命令为空';
    if (DANGEROUS.test(c)) return '这条命令被安全策略拒绝（会改坏世界或踢人）';
    if (READONLY_CMDS.test(c)) return null;
    if (SAFE_CMDS.test(c)) return allowWorldModify ? null : '改世界/给物品类命令需要先开启 allowWorldModify';
    return '不认识或不安全的命令（只允许查询说话类与白名单内动作）';
}

function rateGate() {
    const now = Date.now();
    if (now - STATE.lastAt < 200) return '太快了（200ms 冷却）';
    STATE.window = STATE.window.filter((t) => now - t < 60000);
    if (STATE.window.length >= 120) return '一分钟 120 条上限';
    STATE.lastAt = now; STATE.window.push(now);
    return null;
}

/** JSON 转义（tellraw 需要合法 JSON 字符串） */
function jsonStr(s) { return JSON.stringify(String(s)); }

let _client = null;
async function getClient(cfg) {
    if (_client && _client.sock && !_client.sock.destroyed) return _client;
    const c = new Rcon({
        host: cfg.host || '127.0.0.1',
        port: Number(cfg.port) || 25575,
        password: String(cfg.password || ''),
        timeout: Number(cfg.timeout) || 5000,
    });
    await c.connect();
    await c.auth();
    _client = c;
    return c;
}

function closeClient() { if (_client) { _client.close(); _client = null; } }

/**
 * 执行一条 RCON 命令。
 * @param {string} cmd
 * @param {object} cfg { host, port, password, timeout, allowWorldModify }
 * @returns {Promise<{ok:boolean, result?:string, error?:string}>}
 */
async function run(cmd, cfg = {}) {
    const g = guard(cmd, cfg);
    if (g) return { ok: false, error: g };
    const rg = rateGate();
    if (rg) return { ok: false, error: rg };
    try {
        const c = await getClient(cfg);
        const out = await c.command(cmd);
        return { ok: true, result: out };
    } catch (e) {
        closeClient();
        return { ok: false, error: e && e.message || String(e) };
    }
}

/** 读取玩家位置（只读，最常用） */
async function playerPos(player, cfg = {}) {
    const r = await run(`data get entity ${String(player).replace(/[^\w]/g, '')} Pos`, cfg);
    if (!r.ok) return r;
    // 返回形如：X has the following entity data: [1.5d, 64.0d, -3.2d]
    const m = String(r.result).match(/\[\s*([-\d.]+)d?,\s*([-\d.]+)d?,\s*([-\d.]+)d?\s*\]/);
    if (!m) return { ok: false, error: '读不出坐标（玩家不在线？）' };
    return { ok: true, pos: { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) }, raw: r.result };
}

/** 在游戏里让她说话（聊天框显示，不是打字） */
async function say(text, cfg = {}, player = '') {
    const t = String(text || '').slice(0, 200);
    if (!t) return { ok: false, error: '内容为空' };
    const cmd = player
        ? `tellraw ${String(player).replace(/[^\w]/g, '')} ${jsonStr({ text: t, color: 'light_purple' })}`
        : `say ${t}`;
    return run(cmd, cfg);
}

/** 列出在线玩家 */
async function listPlayers(cfg = {}) {
    const r = await run('list', cfg);
    if (!r.ok) return r;
    // "There are 2 of a max of 20 players online: Steve, Alex"
    const m = String(r.result).match(/online:\s*(.*)$/i);
    const players = m && m[1] ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    return { ok: true, players, raw: r.result };
}

module.exports = { run, playerPos, say, listPlayers, closeClient, guard, Rcon };

// CLI：node minecraft-rcon.cjs <host> <port> <password> <command>
if (require.main === module) {
    const [host, port, password, ...rest] = process.argv.slice(2);
    if (!password || rest.length === 0) {
        process.stdout.write(JSON.stringify({ ok: false, error: '用法: node minecraft-rcon.cjs <host> <port> <password> <command...>' }));
        process.exit(0);
    }
    run(rest.join(' '), { host, port: Number(port), password })
        .then((r) => { process.stdout.write(JSON.stringify(r)); })
        .catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e) })); })
        .finally(() => { closeClient(); process.exit(0); });
}
