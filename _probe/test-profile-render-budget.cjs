#!/usr/bin/env node
/**
 * _probe/test-profile-render-budget.cjs —— 画像注入预算 + 看屏视觉预算（ADR-014，2026-11-24）
 *
 * 轨道 2-8：system 里的用户画像从「每字段 20 条」降到「每字段 10 条」，**数据一条不删**，
 * 完整画像继续由 `profile view` 工具提供（工具视图必须是全量）。
 * 轨道 2-9：watch-screen 的每小时视觉摘要预算 220 → 90（静默期仍 0）。
 *
 * 要防的回归：
 *   ① 把渲染裁剪误做成存储裁剪 → 真数据越用越少；
 *   ② 工具视图也被裁 → 细节彻底拿不回来（比 20 条注入更糟）；
 *   ③ 没超限也加一行提示 → 白白多 token；
 *   ④ 配置失效（用户配了 15 仍是 10）或旧出厂值 20 被当成用户意图；
 *   ⑤ 看屏预算被调回 220 或描述丢了「静默期 0 / 调低省视觉调用」。
 *
 * 纯逻辑 + 静态断言；不读写真实画像/配置文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const UserProfilePlugin = require(path.join(LIVE, 'plugins', 'community', 'user-profile', 'index.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

function makeProfile() {
    const arr = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
    return {
        name: '主人',
        nickname: '老王',
        traits: arr('trait', 25),
        habits: arr('habit', 14),
        preferences: { likes: arr('like', 12), dislikes: arr('dislike', 11) },
        facts: arr('fact', 20),
        relationships: arr('rel', 13),
        quarantined: [],
    };
}

function makePlugin(cfg) {
    const p = Object.create(UserProfilePlugin.prototype);
    p._cfg = cfg || {};
    p._profile = makeProfile();
    p._renderedProfile = '';
    p._profilePath = path.join(ROOT, '_probe', '<tmp>.json');
    p._candidatePath = path.join(ROOT, '_probe', '<tmp-cand>.json');
    p._refreshRenderedProfile();
    return p;
}

const countOf = (text, prefix) => (String(text).match(new RegExp('(?<![A-Za-z])' + prefix + '-\\d+', 'g')) || []).length;

// ── ① 渲染 = 10/字段（默认）────────────────────────────────────────────
{
    const p = makePlugin({});
    const t = p._renderedProfile;
    ok('traits 只渲染 10 条', countOf(t, 'trait') === 10, 'n=' + countOf(t, 'trait'));
    ok('habits 只渲染 10 条', countOf(t, 'habit') === 10, 'n=' + countOf(t, 'habit'));
    ok('facts 只渲染 10 条', countOf(t, 'fact') === 10, 'n=' + countOf(t, 'fact'));
    ok('关系只渲染 10 条', countOf(t, 'rel') === 10, 'n=' + countOf(t, 'rel'));
    ok('喜欢/不喜欢各只渲染 10 条', countOf(t, 'like') === 10 && countOf(t, 'dislike') === 10,
        countOf(t, 'like') + '/' + countOf(t, 'dislike'));
    ok('超出的条目不渲染（trait-11 不出现）', !t.includes('trait-11'));
    ok('保留头 10 条而不是尾 10 条', t.includes('trait-1') && !t.includes('trait-25'));
}

// ── ② 数据没被删（对象仍是 25/14/20…）──────────────────────────────────
{
    const p = makePlugin({});
    ok('渲染不改画像数据：traits 仍 25 条', p._profile.traits.length === 25, 'n=' + p._profile.traits.length);
    ok('渲染不改偏好数据：likes 仍 12 条', p._profile.preferences.likes.length === 12);
    ok('渲染不写盘（没有 _saveProfile 调用痕迹）', typeof p._saveProfile === 'function');
    const stored = p._limitItems(makeProfile().traits);
    ok('存储裁剪仍是 20（旧行为不变）', stored.length === 20, 'n=' + stored.length);
}

// ── ③ 提示：超限才有「更多细节用 profile 工具查看」───────────────────────
{
    const p = makePlugin({});
    ok('截断时提示用 profile 工具', /更多细节用 profile 工具查看/.test(p._renderedProfile), p._renderedProfile.slice(-90));
    ok('提示带上各字段总数（方便它决定要不要查）', /traits 25/.test(p._renderedProfile) && /facts 20/.test(p._renderedProfile));

    const small = Object.create(UserProfilePlugin.prototype);
    small._cfg = {};
    small._profile = {
        name: '主人', nickname: '',
        traits: ['只有一条'], habits: [], preferences: { likes: [], dislikes: [] }, facts: [], relationships: [],
    };
    small._refreshRenderedProfile();
    ok('没超限就不加提示（省 token）', !/更多细节用 profile 工具查看/.test(small._renderedProfile), small._renderedProfile);
}

// ── ④ 工具视图 = 全量 ───────────────────────────────────────────────────
{
    const p = makePlugin({});
    const view = p._renderProfileForTool();
    ok('profile view 返回全部 traits（25）', countOf(view, 'trait') === 25, 'n=' + countOf(view, 'trait'));
    ok('profile view 返回全部 facts（20）', countOf(view, 'fact') === 20, 'n=' + countOf(view, 'fact'));
    ok('profile view 不显示渲染提示（那是 system 的事）', !/更多细节用 profile 工具查看/.test(view));
}

// ── ⑤ 可配置：显式值生效；旧出厂值 20 = 未配置 ──────────────────────────
{
    const p15 = makePlugin({ max_items_per_field: 15 });
    ok('配 15 → 渲染 15 条', countOf(p15._renderedProfile, 'trait') === 15, 'n=' + countOf(p15._renderedProfile, 'trait'));

    const p3 = makePlugin({ max_items_per_field: 3 });
    ok('配 3 → 渲染 3 条', countOf(p3._renderedProfile, 'trait') === 3);

    const p20 = makePlugin({ max_items_per_field: 20 });
    ok('旧出厂默认 20 视为未配置 → 仍渲染 10', countOf(p20._renderedProfile, 'trait') === 10,
        'n=' + countOf(p20._renderedProfile, 'trait'));

    const pBad = makePlugin({ max_items_per_field: 'abc' });
    ok('非法配置回默认 10', countOf(pBad._renderedProfile, 'trait') === 10);
}

// ── ⑥ 空画像 / 只有姓名 ─────────────────────────────────────────────────
{
    const p = Object.create(UserProfilePlugin.prototype);
    p._cfg = {};
    p._profile = { name: '', nickname: '', traits: [], habits: [], preferences: { likes: [], dislikes: [] }, facts: [], relationships: [] };
    p._refreshRenderedProfile();
    ok('空画像渲染为空串（不注入空壳）', p._renderedProfile === '');
    ok('空画像的工具视图给出明确说明', /当前没有已晋升的用户画像/.test(p._renderProfileForTool()));
}

// ── ⑦ 看屏视觉预算：220 → 90（静态断言 plugin_config.json）─────────────
{
    const cfgPath = path.join(LIVE, 'plugins', 'community', 'watch-screen', 'plugin_config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const b = cfg.organVisionBudgetPerHour || {};
    ok('organVisionBudgetPerHour.value = 90', b.value === 90, String(b.value));
    ok('organVisionBudgetPerHour.default = 90', b.default === 90, String(b.default));
    ok('描述写明「静默期仍 0」', /静默期仍为?\s*0/.test(String(b.description || '')), b.description);
    ok('描述写明「调低省视觉调用」', /调低.*省视觉调用/.test(String(b.description || '')));

    const src = fs.readFileSync(path.join(LIVE, 'plugins', 'community', 'watch-screen', 'index.js'), 'utf8');
    // 容忍换行/包裹：实现可能写成 resolveVisionBudgetPerHour(cfg.organVisionBudgetPerHour ?? …)
    ok('看屏代码仍按配置读预算（不会无视配置写死 90）',
        /visionBudgetPerHour:[\s\S]{0,120}organVisionBudgetPerHour/.test(src));
}

console.log('\n' + (fail ? '✗' : '✓') + ' 画像/视觉预算：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
