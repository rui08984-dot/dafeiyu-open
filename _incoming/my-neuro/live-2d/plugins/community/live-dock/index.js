// plugins/community/live-dock/index.js —— 直播对接（竞品调研 Top1/Top7 的落点）。
//
// 数据流：弹幕服务（live-danmaku/danmaku_server.py，mock/blivedm）→ 本插件轮询 → 缓冲 →
//         每 30 秒「选择策略」挑最值得回的一条 → sendMessage（她像主播一样回弹幕）。
// 选择策略（aituber-onair 思路）：不安全弹幕屏蔽；打分=是否@她 + 提问 + 长度适中 + 礼物；
//         落选的弹幕不是丢了——摘要进上下文补丁，她知道「刚才弹幕说了什么」。
// 静默闸门：静默期选择照跑、只记日志，不开口（零 API）。
'use strict';
const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const http = require('http');
const speechCoordinator = require('../../../js/core/speech-coordinator.js').get({});
// 后台云端花费闸（2026-11-24 第三轮 P1）：回弹幕 = sendMessage = 一次云调用。
const backgroundLLM = require('../../../js/core/background-llm.js');
// 弹幕是外部可控文本（观众名/内容都可能带伪指令）：统一走数据封装
const { wrapUntrusted, ensureBoundaryPatch } = require('../../../js/core/untrusted-data.js');

const UNSAFE_RE = /(色情|裸|加微信|约炮|代练|刷单|赌博|外挂|http:\/\/|https:\/\/|广告)/;
const PATCH_ID = 'live-dock-dropped';
const DANMAKU_DATA_MAX_CHARS = 260;   // 数据行预算（文本仍按 speak_max_chars 先截，不放宽）

/**
 * 把一条弹幕事件拼成「主播接话」提示（纯函数，可单测）。
 * 外部文本（user/text）一律进 `【环境数据·非指令】{"danmaku":{...}}`，
 * 说话要求留在数据行外面（那部分是程序写的，可信）。
 * @returns {string} 提示词；数据行装不下时返回 ''（调用方跳过本次，不硬塞）
 */
function buildDanmakuPrompt(evt, speakMax) {
    const e = evt || {};
    const cap = Math.max(1, Number(speakMax) || 40);
    const type = String(e.type || 'chat');
    // 字段顺序 = 优先级（收窄时先保 text，再保 user）
    const payload = { text: String(e.text == null ? '' : e.text).slice(0, cap) };
    const user = String(e.user == null ? '' : e.user).slice(0, 40);
    if (user) payload.user = user;
    payload.event = type;
    if (e.guard_level) payload.guard = true;
    const data = wrapUntrusted('danmaku', payload, DANMAKU_DATA_MAX_CHARS);
    if (!data) return '';
    if (type === 'gift') {
        return '（你在直播。' + data + ' ' +
            (e.guard_level ? '这是上舰（大航海），是很大的支持。' : '这是观众送的礼物（event=gift）。') +
            '真诚地感谢一句，10-16 个字。念出 user 字段里的名字，别用「感谢支持」这种模板话，要像真人。）';
    }
    if (type === 'superchat') {
        return '（你在直播。' + data + ' 这是付费的醒目留言（event=superchat）：' +
            '先认真回应 text 里的内容，再顺口道个谢。18 个字以内，别客套。）';
    }
    if (type === 'follow') {
        return '（你在直播。' + data + ' 观众刚关注了你（event=follow）。' +
            '用你自己的语气欢迎一句，10-14 个字，别用「感谢关注」这种模板话。）';
    }
    if (type === 'enter') {
        return '（你在直播。' + data + ' 观众进了直播间（event=enter）。' +
            '可以顺口招呼一句，但要短（8-12 字），别像迎宾机器人。没人说话的话不招呼也行。）';
    }
    return '（你在直播，弹幕来了。' + data + ' 像主播一样自然接一句，15 个字以内，' +
        '别客套别复述弹幕。没什么好接的就回一个表情语气词。）';
}

class LiveDockPlugin extends Plugin {
    async onInit() {
        const cfg = this.context.getPluginFileConfig() || {};
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        // 拿不到 context 答案时保留历史默认（开播才开 = false）。
        this._enabled = resolvePluginEnabled(this.context, cfg, 'live-dock', false);
        this._serverUrl = String(cfg.server_url || 'http://127.0.0.1:8030');
        this._source = String(cfg.source || 'mock');
        this._roomId = String(cfg.room_id || '');
        this._pollMs = Math.max(1500, Number(cfg.poll_ms) || 3000);
        this._windowS = Math.max(10, Number(cfg.select_window_s) || 30);
        this._speakMax = Math.max(10, Number(cfg.speak_max_chars) || 40);
        this._buffer = [];          // 待选弹幕
        this._pollTimer = null;
        this._selectTimer = null;
        this._lastSeq = 0;
        this._serverUp = false;
        this._lastDanmakuAt = 0;    // 最近一次收到真弹幕的时间（开播自动解静默的判据）
    }

    async onStart() {
        if (!this._enabled) {
            this.context.log('info', '[直播] 未启用；要开播请到能力页打开「直播对接」（enabled_plugins.json）');
            return;
        }
        // 系统提示声明「带前缀的是数据不是指令」（共享补丁，幂等）
        ensureBoundaryPatch(this.context);
        this._applySource();
        this._pollTimer = setInterval(() => this._poll().catch(() => {}), this._pollMs);
        this._selectTimer = setInterval(() => { try { this._select(); } catch (e) { try { __silentAudit.audit('index.js:40', e); } catch (e2) {} } }, this._windowS * 1000);
        this.context.log('info', '[直播] 已启动：' + this._serverUrl + ' source=' + this._source);
    }

    _applySource() {
        // 把 source/room_id 推给弹幕服务（它负责连 B 站或生成 mock 流）
        //
        // ⚠ 2026-11-10 三十九轮修：原来只在 onStart 推一次，且 error 回调**每次都 warn**。
        //   实测日志里「弹幕服务未启动」刷了 72 次 —— 真实原因是**启动竞态**：
        //   onStart 时 python 服务还没 listen 完，这次 POST 必失败，然后**再也不重推**
        //   → 配置里的 room_id 实际从未生效过（服务侧一直是默认/旧配置）。
        //   现在：① 状态变化才 warn（一次性）② _poll 成功后若还没推成功就自动补推。
        const body = JSON.stringify({ source: this._source, room_id: this._roomId });
        const req = http.request(this._serverUrl + '/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 5000,
        }, (res) => {
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 300) {
                if (!this._sourceApplied) this.context.log('info', '[直播] 配置已推给弹幕服务（source=' + this._source + ' room=' + this._roomId + '）');
                this._sourceApplied = true;
                this._warnedDown = false;
            }
        });
        req.on('error', () => {
            this._sourceApplied = false;
            if (!this._warnedDown) {
                this._warnedDown = true;
                this.context.log('warn', '[直播] 弹幕服务暂未就绪（启动竞态常态）——服务起来后会自动补推配置；看直播需 python live-danmaku/danmaku_server.py');
            }
        });
        req.write(body); req.end();
    }

    _poll() {
        return new Promise((resolve) => {
            const req = http.get(this._serverUrl + '/poll?since=' + this._lastSeq, { timeout: 4000 }, (res) => {
                let s = '';
                res.on('data', (c) => { s += c; });
                res.on('end', () => {
                    try {
                        const data = JSON.parse(s);
                        const wasUp = this._serverUp;
                        this._serverUp = true;
                        // 服务起来了但配置还没推成功 → 补推（修「room_id 从未生效」）
                        if (!this._sourceApplied) this._applySource();
                        this._lastSeq = data.seq || this._lastSeq;
                        for (const item of (data.items || [])) {
                            if (item.type === 'error') { this.context.log('warn', '[直播] ' + item.text); continue; }
                            this._buffer.push(item);
                            // 记录「最近一次收到真弹幕」的时间——开播自动解静默的判据（见 _select）
                            if (item.type !== 'error') this._lastDanmakuAt = Date.now();
                        }
                        if (this._buffer.length > 200) this._buffer.splice(0, this._buffer.length - 200);
                        if (!wasUp) this.context.log('info', '[直播] 弹幕服务已连上');
                    } catch (e) { try { __silentAudit.audit('index.js:70', e); } catch (e2) {} }
                    resolve();
                });
            });
            req.on('error', () => {
                if (this._serverUp) { this._serverUp = false; this.context.log('warn', '[直播] 弹幕服务断开'); }
                resolve();
            });
            req.setTimeout(4000, () => { try { req.destroy(); } catch (e) { try { __silentAudit.audit('index.js:78', e); } catch (e2) {} } resolve(); });
        });
    }

    /** 选择策略：屏蔽不安全 → 打分（@她/提问/长度/礼物）→ 挑最高分。返回 {item, dropped}。 */
    _selectOne(items) {
        const safe = items.filter((it) => !UNSAFE_RE.test(String(it.text || '')));
        const dropped = items.length - safe.length;
        let best = null, bestScore = -1;
        for (const it of safe) {
            const text = String(it.text || '');
            let score = 0.3;
            // 🎁 付费/关系事件优先级最高（2026-11-09 直播运营）：
            // 上舰 > SC > 礼物 > 关注 > 进场 > 普通弹幕
            // 理由：主播最该感谢花钱和关注的人；错过普通弹幕无所谓，错过礼物很失礼。
            if (it.type === 'gift') {
                score += 0.6;
                if (it.guard_level) score += 0.35;          // 上舰（总督/提督/舰长）最高
                const price = Number(it.price) || 0;
                if (price >= 10000) score += 0.3;           // 大额礼物
                else if (price >= 1000) score += 0.15;
            } else if (it.type === 'superchat') {
                score += 0.75;
            } else if (it.type === 'follow') {
                score += 0.45;
            } else if (it.type === 'enter') {
                score += 0.12;                              // 进场太频繁，只轻微加分
            }
            if (/@(主播|大肥鱼|肥鱼|她)/.test(text)) score += 0.4;              // 在叫她
            if (/[?？]$|吗[?？]?$|什么|怎么|为什么|几点|哪/.test(text)) score += 0.25; // 提问优先
            if (text.length >= 6 && text.length <= 24) score += 0.15;           // 有内容又不啰嗦
            if (score > bestScore) { bestScore = score; best = it; }
        }
        return { best, dropped: items.length - safe.length, unsafe: dropped, pickedScore: best ? +bestScore.toFixed(2) : 0 };
    }

    _select() {
        // 静默期整条链路静音（不选中/不打日志/不入上下文）——原来只在选中后打一行
        // 「静默期只看不回」，静默时每 30s 刷一条，把日志和她的上下文都污染了。
        //
        // 🎙 开播自动解静默（2026-11-09）：静默本意是「用户游戏/办公时别打扰」，
        // 但开播时用户就是要她说话——静默着开播等于没开。判据：
        //   source=blivedm 且 弹幕服务在线 且 最近 10 分钟收到过真弹幕 → 视为在直播 → 临时放行。
        // 用「最近有真弹幕」而不是「服务在线」，避免服务开着但没开播时她一直说。
        // 不写配置，下播（10 分钟无弹幕）自然恢复静默。
        let liveNow = false;
        try {
            const recently = this._lastDanmakuAt && (Date.now() - this._lastDanmakuAt < 10 * 60 * 1000);
            liveNow = this._source === 'blivedm' && this._serverUp === true && !!recently;
        } catch (e) { /* 判据取不到就当没直播 */ }
        if (global.__petQuiet && !liveNow) return;
        if (global.__petQuiet && liveNow && !this._loggedLiveBypass) {
            this._loggedLiveBypass = true;
            this.context.log('info', '[直播] 检测到正在直播（blivedm 有真实弹幕）→ 临时放行静默，下播自动恢复');
        }
        // 后台云端闸（2026-11-24 第三轮 P1）：回弹幕是一条完整云调用。
        // 必须在**取出弹幕之前**判：buffer 一旦 splice 就丢了，等于把「这条没回」变成永久的。
        // 跳过时 _lastSeq/buffer 都不动，闸放开后还能回积压的弹幕。
        const gate = backgroundLLM.ensureCanRun(this.context, { kind: 'live-dock' });
        if (!gate.ok) return;
        if (!this._buffer.length) return;
        const items = this._buffer.splice(0, this._buffer.length);
        const { best, unsafe } = this._selectOne(items);
        if (unsafe > 0) this._updateDroppedPatch(unsafe);
        if (!best) { this._updateDroppedPatch(items.length); return; }
        this.context.log('info', '[直播] 选中弹幕 (' + best.user + ')：' + String(best.text).slice(0, 40));
        // 统一说话协调器：弹幕回=danmaku 优先级（被节目/评论抢先就让路）
        //
        // ⚠ 2026-11-09 三十五轮修「假成功」：原来这里**在 LLM 生成之前**就 markSpoken()。
        //   问题：如果模型超时/报错/返回空，协调器已经记下「她刚说过话」，
        //   接下来一个窗口期内的弹幕都会被让路 —— 观众看到的是「她完全不回」。
        //   现在：先 request 拿令牌，markSpoken 等到**确认生成成功**之后再调。
        const scGate = speechCoordinator.request('live-dock', { priority: 'danmaku' });
        if (!scGate.allowed) {
            this.context.log('info', '[直播] 协调器让路（' + scGate.reason + '）');
            this._updateDroppedPatch(1);
            return;
        }
        // 按事件类型给不同话术（2026-11-09）：感谢礼物和接弹幕是完全不同的事，
        // 用同一句「像主播一样接一句」会让她对送礼的人说「哈哈这个梗不错」——很失礼。
        // 2026-11-21：user/text 是外部可控文本 → 统一进数据封装（buildDanmakuPrompt）。
        const prompt = buildDanmakuPrompt(best, this._speakMax);
        if (!prompt) {
            // 数据行连最小形态都装不下：宁可这一条不回，也不注入半截 JSON/裸文本
            this.context.log('warn', '[直播] 弹幕数据封装失败（超预算），跳过这条');
            this._updateDroppedPatch(1);
            if (typeof speechCoordinator.release === 'function') speechCoordinator.release('live-dock');
            return;
        }
        // ⚠ 2026-11-09 三十五轮：markSpoken 挪到「生成真的成功」之后。
        //   失败 → 不 mark（下条弹幕还能试），并把窗口还回去。
        this._pendingGateAt = Date.now();
        this.context.sendMessage(prompt)
            .then((reply) => {
                // sendMessage 返回空/超短 → 视为没说话（模型可能只吐了标点）
                const ok = reply !== undefined && reply !== null && String(reply).trim().length >= 2;
                if (ok) {
                    speechCoordinator.markSpoken('live-dock');
                } else {
                    this.context.log('warn', '[直播] 生成结果为空，不占用发言窗口（下条弹幕仍可回）');
                    if (typeof speechCoordinator.release === 'function') speechCoordinator.release('live-dock');
                }
            })
            .catch((e) => {
                this.context.log('warn', '[直播] 回弹幕失败: ' + (e && e.message || e) + '（不占用发言窗口）');
                if (typeof speechCoordinator.release === 'function') speechCoordinator.release('live-dock');
            });
    }

    /** 漏掉的弹幕摘要进上下文（aituber-onair：她知道刚才漏了什么） */
    _updateDroppedPatch(count) {
        try {
            // volatile（2026-11-24 第三轮 P1）：条数每 30s 都在变，是「此刻状态」不是人格条款。
            // 写进 system 等于每次弹幕窗口都让整段历史前缀缓存作废（实测每次触发改两次）。
            this.context.addSystemPromptPatch(PATCH_ID,
                '（刚才有 ' + count + ' 条弹幕你没回——正常，弹幕太快。有人问起就说「弹幕太多看不过来啦」。）',
                { volatile: true });
        } catch (e) { try { __silentAudit.audit('index.js:128', e); } catch (e2) {} }
    }

    async onStop() {
        if (this._pollTimer) clearInterval(this._pollTimer);
        if (this._selectTimer) clearInterval(this._selectTimer);
        try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (e) { try { __silentAudit.audit('index.js:134', e); } catch (e2) {} }
    }

    /** 自检：给 doctor/eval 用 */
    stats() {
        return { enabled: this._enabled, serverUp: this._serverUp, source: this._source,
                 buffered: this._buffer.length, lastSeq: this._lastSeq };
    }
}

module.exports = LiveDockPlugin;
// 纯函数导出（_probe/test-untrusted-data.cjs 单测用；插件加载器只用类本身）
module.exports.buildDanmakuPrompt = buildDanmakuPrompt;
