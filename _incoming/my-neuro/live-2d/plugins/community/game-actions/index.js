// game-actions —— 运行时动作注册（2026-11-15 六十三轮，对照 Neuro-sdk 的 actions.register）
//
// 要解决的问题：现在「她能对游戏做什么」写死在代码里（dispatch 的 game 工具 + action 枚举）。
// 换一个游戏想让她做新动作，就得改代码 —— 违反「换游戏要改代码吗」这条判据。
//
// 做法：动作写在 **profile 里**（数据），这个插件在加载时把它们注册成 LLM 工具：
//
//   "actions": [
//     { "name": "jump",
//       "description": "让角色跳一下（短按空格）",
//       "parameters": { "type": "object", "properties": {}, "required": [] },
//       "run": { "tool": "game", "args": { "action": "press_key", "key": "space", "ms": 120 } } }
//   ]
//
// 关键约束：
//   · 只做「声明 → 工具」这一层，**不新增底层能力**：run.tool 必须是已有工具，
//     这样动作不会绕过安全闸（前台校验/HUD 校验等）。
//   · 换 profile 时先注销旧动作再注册新的（工具面只增不减会污染模型选择 + 让 schema 一直变）。
//   · 没有 actions 的 profile 不会注册任何东西（默认零行为变化）。
'use strict';

const fs = require('fs');
const path = require('path');
const { Plugin } = require('../../../js/core/plugin-base.js');

const PREFIX = 'ga_';

class GameActionsPlugin extends Plugin {

    async onInit() {
        this._actions = [];
        this._source = '';
    }

    async onStart() {
        this._load();
    }

    async onStop() {
        this._unregisterAll();
    }

    _cfg() {
        try { return this.context.getPluginFileConfig() || {}; } catch (e) { return {}; }
    }

    /** 优先用配置里的 profile；否则找 pet-runtime/data/game-profiles 下第一个带 actions 的 */
    _profilePath() {
        const cfg = this._cfg();
        if (cfg.profile) return String(cfg.profile);
        const dir = path.join(__dirname, '..', '..', '..', '..', 'pet-runtime', 'data', 'game-profiles');
        try {
            for (const f of fs.readdirSync(dir)) {
                if (!f.endsWith('.json')) continue;
                const p = path.join(dir, f);
                const j = JSON.parse(fs.readFileSync(p, 'utf8'));
                if (Array.isArray(j.actions) && j.actions.length) return p;
            }
        } catch (e) { /* 没有目录/没有 actions：不注册，保持零行为变化 */ }
        return null;
    }

    _load() {
        // 先把**旧动作**注销掉，再换成新表 —— 顺序反了的话 _unregisterAll 用的是新表，
        // 旧工具永远摘不掉（实测：换 profile 后 ga_jump 还在，工具面只增不减）。
        this._unregisterAll();
        const p = this._profilePath();
        if (!p) { this._actions = []; this._source = ''; return; }
        let prof = null;
        try { prof = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
            this.context.log('warn', '动作包读取失败: ' + (e && e.message || e));
            this._actions = [];
            return;
        }
        const list = Array.isArray(prof.actions) ? prof.actions : [];
        this._actions = list
            .filter((a) => a && a.name && a.run && a.run.tool)
            .map((a) => ({
                name: String(a.name),
                description: String(a.description || a.name),
                parameters: a.parameters || { type: 'object', properties: {}, required: [] },
                run: { tool: String(a.run.tool), args: a.run.args || {} },
            }));
        for (const a of this._actions) this.context.registerTool(this._toolDef(a));
        this._source = path.basename(p);
        if (this._actions.length) {
            this.context.log('info', '已注册 ' + this._actions.length + ' 个游戏动作（' + this._source + '）：'
                + this._actions.map((a) => a.name).join(', '));
        }
    }

    _toolDef(a) {
        const safe = String(a.name).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'action';
        return {
            type: 'function',
            function: {
                name: PREFIX + safe,
                description: a.description,
                parameters: a.parameters,
            },
        };
    }

    _toolNameOf(a) { return this._toolDef(a).function.name; }

    _unregisterAll() {
        for (const a of this._actions || []) {
            try { if (this.context.unregisterTool) this.context.unregisterTool(this._toolNameOf(a)); } catch (e) { /* 注销失败不影响加载 */ }
        }
    }

    getTools() {
        return (this._actions || []).map((a) => this._toolDef(a));
    }

    handlesToolName(name) {
        return this.getTools().some((t) => t.function && t.function.name === name);
    }

    async executeTool(name, params) {
        const action = (this._actions || []).find((a) => this._toolNameOf(a) === name);
        if (!action) throw new Error('未知游戏动作: ' + name);
        const args = Object.assign({}, action.run.args || {}, params || {});
        if (!global.pluginManager || typeof global.pluginManager.executeTool !== 'function') {
            throw new Error('工具执行器不可用，无法执行动作 ' + action.name);
        }
        return await global.pluginManager.executeTool(action.run.tool, args);
    }

    /** 给 doctor/eval 看 */
    stats() {
        return { source: this._source, count: (this._actions || []).length, actions: (this._actions || []).map((a) => a.name) };
    }
}

module.exports = GameActionsPlugin;
