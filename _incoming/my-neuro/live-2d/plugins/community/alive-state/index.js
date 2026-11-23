// plugins/community/alive-state/index.js
//
// 活着感状态机（VPet 数值养成思路 + 情绪总线生理层）
//
// 她不只是"回复机器"：有饱食、精力和亲密度，随时间流动、被交互改变，
// 并通过三条通路活出来——
//   ① 系统提示：她"知道自己饿/困"（describe 注入，语气自然带出来）
//   ② 主动表达：饿了/深夜困了 → 说话协调器仲裁后开口（不抢话、有冷却）
//   ③ 被触摸：摸头（长按她不动）→ 演出 + 心情真变好（写进 __petMood 余味）
// 数值落在 data/活着感.json；纯模型在 state-model.js（有单测）。
'use strict';
const __silentAudit = require('../../../js/core/silent-audit.js');
const { Plugin } = require('../../../js/core/plugin-base.js');
const { resolvePluginEnabled } = require('../../../js/core/plugin-context.js');
const model = require('./state-model.js');
const jsonStore = require('../../../js/core/json-store.js');
const fs = require('fs');
const path = require('path');

const PATCH_ID = 'alive-state-body';
const speechCoordinator = require('../../../js/core/speech-coordinator.js').get({});
const intentQueue = require('../../../js/core/intent-queue.js');
// U4（2026-11-22）：被拒入队/后来直说用的是同一句前缀。直说成功后按这个前缀
// 撤回自己排过的待补说项 —— 否则 auto-chat 空闲时会把她已经说过的话再说一遍。
const INTENT_TEXT_PREFIX = '（你正想主动开口，不是他问你。）';

class AliveStatePlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig() || {};
        // 总开关单一真相源（2026-11-21）：enabled_plugins.json（context）优先；
        // plugin_config.enabled 只作旧配置兼容（显式 false 才关，并警告一次）。
        this._enabled = resolvePluginEnabled(this.context, cfg, 'alive-state');
        // 冷却（分钟）：饿了 2h 说一次、困了 4h 一次、摸头的口头回应 3min 一次
        this._cooldownMin = { hungry: Number(cfg.hungry_cooldown_min) || 120, sleepy: Number(cfg.sleepy_cooldown_min) || 240, pet: 3 };
        this._decayMin = Math.max(1, Number(cfg.decay_interval_min) || 5);
        this._state = { satiety: 70, energy: 80, intimacy: 20, lastPetAt: 0, lastFeedAt: 0, lastExpressAt: {}, updatedAt: Date.now() };
        try {
            const { RECORDS_DIR } = require('../../../js/core/records-path.js');
            this._file = path.join(RECORDS_DIR, '活着感.json');
            fs.mkdirSync(RECORDS_DIR, { recursive: true });
            this._load();
        } catch (e) { this._file = null; }
        this._patchInstalled = false;
    }

    async onStart() {
        if (!this._enabled) return;
        // 摸头：petbody interaction 的长按轻抚事件（同渲染进程，直听窗口事件）
        // §10.2#12：long:true = 长抚（>2.5s 依依不舍），亲密度加成更高
        this._strokeHandler = (ev) => this.onPetted({ long: !!(ev && ev.detail && ev.detail.long) }).catch(() => {});
        try { window.addEventListener('pet-care-stroke', this._strokeHandler); } catch (e) { try { __silentAudit.audit('index.js:42', e); } catch (e2) {} }
        // 衰减定时
        this._timer = setInterval(() => { try { this._decayTick(); } catch (e) { try { __silentAudit.audit('index.js:44', e); } catch (e2) {} } }, this._decayMin * 60000);
        if (this._timer.unref) this._timer.unref();
        this._installPatch();
        this.context.log('info', `[活着感] 启动：饱食 ${Math.round(this._state.satiety)}% 精力 ${Math.round(this._state.energy)}% 亲密 ${Math.round(this._state.intimacy)}`);
    }

    async onStop() {
        try { window.removeEventListener('pet-care-stroke', this._strokeHandler); } catch (e) { try { __silentAudit.audit('index.js:51', e); } catch (e2) {} }
        if (this._timer) clearInterval(this._timer);
        try { this.context.removeSystemPromptPatch(PATCH_ID); } catch (e) { try { __silentAudit.audit('index.js:53', e); } catch (e2) {} }
    }

    // ── 持久化 ───────────────────────────────────────────────────────────
    _load() {
        // 读坏了由 json-store 改名隔离并返回 null（有 console.warn），这里照旧保留默认值
        const raw = jsonStore.readJson(this._file, null);
        if (raw && typeof raw === 'object') this._state = { ...this._state, ...raw };
        // 离线时间也照常衰减（她在你不在的时候也会饿——这就是"活着"）
        const hours = Math.max(0, (Date.now() - (this._state.updatedAt || Date.now())) / 3600000);
        const hourOfDay = new Date().getHours();
        this._state = model.decay(this._state, hours, hourOfDay);
    }

    _save(force) {
        if (!this._file) return;
        const now = Date.now();
        if (!force && now - (this._lastSaveAt || 0) < 60000) return;   // 一分钟最多写一次
        // 文件坏过（本进程已隔离）就别写回：否则等于用默认值把仅剩的残骸盖掉
        if (jsonStore.isQuarantined(this._file)) {
            if (!this._quarantineWarned) {
                this._quarantineWarned = true;
                console.warn('[活着感] 状态文件已隔离，本进程不再写回：' + this._file);
            }
            return;
        }
        this._lastSaveAt = now;
        try { jsonStore.writeJson(this._file, this._state); } catch (e) { try { __silentAudit.audit('index.js:73', e); } catch (e2) {} }
    }

    // ── 衰减与主动表达 ───────────────────────────────────────────────────
    _decayTick() {
        const now = Date.now();
        const hours = (now - (this._state.updatedAt || now)) / 3600000;
        if (hours <= 0) return;
        const before = this._state;
        this._state = model.decay(this._state, hours, new Date().getHours());
        this._installPatch();
        this._save();
        // 数值过线 → 主动表达（协调器仲裁：被节目/弹幕/关心抢了话就让路）
        const pick = model.pickExpression(this._state, new Date().getHours());
        if (!pick) return;
        const cdMin = this._cooldownMin[pick.kind] || 120;
        if (now - ((this._state.lastExpressAt || {})[pick.kind] || 0) < cdMin * 60000) return;
        const gate = speechCoordinator.request('alive-state', { priority: 'proactive' });
        if (!gate.allowed) {
            this.context.log('info', `[活着感] ${pick.kind} 想说但协调器让路（${gate.reason}）`);
            // D3（2026-11-22）：被拒的主动表达进待发队列（≤5 条/TTL 10 分钟/情境指纹），
            // 空闲时由 auto-chat 补说 1 条。原有让路行为不变，只多记一条。
            try {
                if (intentQueue.isEnabled()) {
                    intentQueue.defer({
                        text: INTENT_TEXT_PREFIX + pick.directive,
                        intent: 'alive-state:' + pick.kind,
                        context: intentQueue.currentContext(),
                    });
                }
            } catch (e) { try { __silentAudit.audit('alive-state/index.js:intent-defer', e); } catch (e2) {} }
            return;
        }
        // P1-12（2026-11-22 审计）：冷却不能先说出去再失败 —— 模型超时/空回复会把
        // 2–4 小时的冷却白烧掉。先记 prev，失败时由 _speak 回滚。
        const prevExpressAt = (this._state.lastExpressAt || {})[pick.kind] || 0;
        this._state.lastExpressAt = { ...(this._state.lastExpressAt || {}), [pick.kind]: now };
        this._save(true);
        this.context.log('info', '[活着感] 主动表达：' + pick.kind);
        // 记账交给 _speak：只有「真的说出话」才 markSpoken（原来在这里先记账，模型失败也算她说过）
        this._speak(INTENT_TEXT_PREFIX + pick.directive, pick.kind, { prevExpressAt });
    }

    _installPatch() {
        try {
            // volatile：这句里有「精力 XX% / 亲密度（XX）」——精力在持续衰减，
            // 留 system 里等于每几分钟就把历史前缀缓存作废一次。
            this.context.addSystemPromptPatch(PATCH_ID, model.describe(this._state), { volatile: true });
            this._patchInstalled = true;
        } catch (e) { try { __silentAudit.audit('index.js:106', e); } catch (e2) {} }
    }

    async _speak(prompt, kind, opts) {
        // 失败回滚：调用方在「尝试开口前」已经写了 lastExpressAt，没说出来必须还回去，
        // 否则一次模型超时烧掉 2–4 小时冷却（2026-11-22 审计 P1-12）。
        const rollbackCooldown = () => {
            try {
                if (!opts || opts.prevExpressAt === undefined) return;
                this._state.lastExpressAt = { ...(this._state.lastExpressAt || {}), [kind]: opts.prevExpressAt };
                this._save(true);
            } catch (e) { /* 回滚失败不影响对话 */ }
        };
        try {
            // sendMessage 现在会回传回复文本（2026-11-12 修）：空/超短 = 这次没说出来，
            // 那就别占发言窗口，把令牌还回去让别的发起者（弹幕/评论）有机会说话。
            const reply = await this.context.sendMessage(prompt);
            const said = reply !== undefined && reply !== null && String(reply).trim().length >= 2;
            if (said) {
                speechCoordinator.markSpoken('alive-state');
                // 她说话了 = 一次真实接触（防久别重逢误判，见 js/core/last-contact.js 头部）
                try { require('../../../js/core/last-contact.js').noteContact('alive-state'); } catch (e) { /* 记账失败不影响说话 */ }
                // U4：这句真的说出去了，撤回自己之前排的待补说项（同前缀）。
                // 不撤的话，auto-chat 空闲时会把她已经表达过的情绪再补说一遍。
                // 只在「本次说的就是主动表达」时撤（摸头回应不碰情绪表达队列）。
                if (String(prompt || '').startsWith(INTENT_TEXT_PREFIX)) {
                    try { intentQueue.dropByPrefix(INTENT_TEXT_PREFIX); }
                    catch (e) { try { __silentAudit.audit('alive-state/index.js:intent-withdraw', e); } catch (e2) {} }
                }
            } else {
                this.context.log('warn', '[活着感] ' + kind + ' 没生成有效回复，不占发言窗口');
                rollbackCooldown();
                if (typeof speechCoordinator.release === 'function') speechCoordinator.release('alive-state');
            }
        } catch (e) {
            this.context.log('warn', '[活着感] ' + kind + ' 开口失败: ' + (e && e.message || e));
            rollbackCooldown();
            if (typeof speechCoordinator.release === 'function') speechCoordinator.release('alive-state');
        }
    }

    // ── 被触摸 / 被投喂 ─────────────────────────────────────────────────
    /** 摸头（interaction.js 长按轻抚触发）。演出每次都有，口头回应有冷却。 */
    async onPetted({ long = false } = {}) {
        if (!this._enabled) return;
        const now = Date.now();
        const before = this._state;
        this._state = model.pet(before);
        // 长抚（>2.5s）：亲密加成翻倍——按住不走是明确的亲昵信号
        if (long) {
            this._state.intimacy = Math.min(100, (this._state.intimacy || 0) + 1);
        }
        this._save();
        // 心情真变好：写进情绪总线的余味（几小时内她都还记得被摸过）
        try { global.__petMood && global.__petMood.note && global.__petMood.note('happy', long ? 0.9 : 0.6, long ? '被摸了很久的头' : '被摸头了'); } catch (e) { try { __silentAudit.audit('index.js:126', e); } catch (e2) {} }
        // 演出：撒娇/开心（皮套同进程直调；重复点按演出自身有节流）
        try {
            const pb = (typeof window !== 'undefined') ? window.petBody : null;
            if (pb && pb.perform) {
                const scenes = pb.listScenes ? pb.listScenes() : [];
                pb.perform(scenes.includes('撒娇') ? '撒娇' : (scenes[0] || ''));
            }
        } catch (e) { try { __silentAudit.audit('index.js:134', e); } catch (e2) {} }
        this._installPatch();
        if (now - (before.lastPetAt || 0) < this._cooldownMin.pet * 60000) return;   // 演出每次有，话不连说
        const gate = speechCoordinator.request('alive-state', { priority: 'proactive' });
        if (!gate.allowed) return;
        this.context.log('info', '[活着感] 被摸头，回应一句');
        this._speak('（他刚才摸了你的头。）用一句很短的话回应，害羞或开心都行，不超过 12 个字。）', 'pet');
    }

    /** 投喂（pet_care 工具入口）。返回给 LLM 的结果串。 */
    doFeed() {
        if (!this._enabled) return JSON.stringify({ ok: false, error: '活着感未启用' });
        const { state, overate } = model.feed(this._state);
        this._state = state;
        this._save(true);
        try { global.__petMood && global.__petMood.note && global.__petMood.note('happy', overate ? 0.2 : 0.5, overate ? '被硬塞吃的' : '被投喂了'); } catch (e) { try { __silentAudit.audit('index.js:150', e); } catch (e2) {} }
        this._installPatch();
        this.context.log('info', '[活着感] 被投喂，饱食 ' + Math.round(state.satiety) + '%');
        return JSON.stringify({
            ok: true,
            overate,
            detail: overate
                ? '你本来就很饱了，他还是塞给你一小份。用你自己的语气说吃不下啦，不超过 14 个字。'
                : '吃饱了（饱食 ' + Math.round(state.satiety) + '%）。用你自己的语气说一句好吃的感受，不超过 14 个字。',
            state: { satiety: Math.round(state.satiety), energy: Math.round(state.energy), intimacy: Math.round(state.intimacy) },
        });
    }

    stats() {
        return {
            enabled: this._enabled,
            satiety: Math.round(this._state.satiety),
            energy: Math.round(this._state.energy),
            intimacy: Math.round(this._state.intimacy),
            lastPetAt: this._state.lastPetAt,
            lastFeedAt: this._state.lastFeedAt,
        };
    }

    // ── 工具 ─────────────────────────────────────────────────────────────
    getTools() {
        if (!this._enabled) return [];
        return [{
            type: 'function',
            function: {
                name: 'pet_care',
                description: '照料自己的身体：投喂小零食（他说给你投喂/你很饿的时候用）。会更新饱食度和亲密度，返回身体状态。',
                parameters: {
                    type: 'object',
                    properties: { action: { type: 'string', enum: ['feed'], description: '动作：feed=投喂' } },
                    required: ['action'],
                },
            },
        }];
    }

    async executeTool(name, params) {
        if (name !== 'pet_care') throw new Error('[活着感] 不支持的工具: ' + name);
        const action = String((params && params.action) || '').trim();
        if (action !== 'feed') return JSON.stringify({ ok: false, error: '不认识的照料动作：' + action + '（可用：feed）' });
        return this.doFeed();
    }
}

module.exports = AliveStatePlugin;
