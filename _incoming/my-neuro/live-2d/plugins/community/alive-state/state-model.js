// state-model.js —— 活着感的数值模型（纯函数，零依赖，可单测）。
//
// 设计依据：VPet 的 GameSave 数值养成（竞品调研 Top5）+ 情绪总线的「生理层」：
//   饱食/精力是**身体**，不是心情——心情归 __petMood（PAD），身体归这里；
//   两层在系统提示里汇合（她"知道自己饿"），在主动表达里冒头（她"说饿了"）。
// 全部数值 0-100；亲密度只涨不跌（陪伴的分量不该被清零）。
'use strict';

const RATES = {
    satietyPerHour: 4,        // 饱食：满值 24h 左右饿到 0
    energyPerHour: 3,         // 精力：白天正常耗
    energyNightFactor: 2.2,   // 23 点后耗电加倍（她会困）
    // ⚠ 2026-11-10 行为审计抓到：原来只有 `energy - …` 一条写入路径，**全仓没有任何 +energy**。
    //   精力从 80 单调衰减到 0 后永远不会回升（重启也一样），于是她永久「很困」，
    //   hungry/sleepy 按 120 分钟冷却无限重复（实测一天播报 8 次同一句）。
    //   现实里夜里是休息：23:00–07:00 改为**回精力**（+6/h），白天照常消耗。
    energyRecoverNight: 6,
};

/** 时间衰减。hours=距上次结算的小时数（≥0），hourOfDay=结算终点钟点（0-23）。
 *  2026-11-10 修：原来用「当前钟点」一刀切整段间隔 —— 22:00 关、08:00 开就按白天
 *  连扣 10 小时，跨夜永远回不了血。现在从终点往回按小时切片，逐段判昼夜，
 *  夜里 +6/h、白天 -3/h，跨 23:00 / 07:00 自动分段。 */
function decay(state, hours, hourOfDay) {
    const h = Math.max(0, Number(hours) || 0);
    const s = { ...state };
    if (!h) { s.updatedAt = Date.now(); return s; }
    const endHour = Number.isFinite(Number(hourOfDay)) ? Math.floor(Number(hourOfDay)) : new Date().getHours();
    let remaining = h;
    let cursor = ((endHour % 24) + 24) % 24;      // 当前切片的结束钟点
    let satLoss = 0;
    let energyDelta = 0;
    while (remaining > 1e-9) {
        const step = Math.min(1, remaining);
        const mid = ((cursor - step / 2) % 24 + 24) % 24;  // 这段的中点钟点
        const night = mid >= 23 || mid < 7;
        satLoss += RATES.satietyPerHour * step;
        energyDelta += (night ? RATES.energyRecoverNight : -RATES.energyPerHour) * step;
        remaining -= step;
        cursor = ((cursor - step) % 24 + 24) % 24;
    }
    s.satiety = clamp(s.satiety - satLoss);
    s.energy = clamp(s.energy + energyDelta);
    s.updatedAt = Date.now();
    return s;
}

/** 摸头：亲密 +1.5，亲密度满不溢出。 */
function pet(state) {
    const s = { ...state };
    s.intimacy = clamp(s.intimacy + 1.5);
    s.lastPetAt = Date.now();
    return s;
}

/** 投喂：饱食 +35（吃撑了也只 +5——硬塞不舒服），亲密 +0.5。返回 { state, overate }。 */
function feed(state) {
    const s = { ...state };
    const overate = s.satiety > 85;
    s.satiety = clamp(s.satiety + (overate ? 5 : 35));
    s.intimacy = clamp(s.intimacy + 0.5);
    s.lastFeedAt = Date.now();
    return { state: s, overate };
}

/** 当前身体状态的人话描述（系统提示用——她"知道自己累"的通路）。
 *  2026-11-10 用户拍板：**完全移除饥饿插话**。饱食数值保留（投喂仍有效），
 *  但不再进系统提示、也不再主动说饿——之前会反复刷「喂我一口」打断任务。 */
function describe(state) {
    const parts = [];
    if (state.energy < 20) parts.push('很困（精力 ' + Math.round(state.energy) + '%）');
    else if (state.energy < 40) parts.push('有点累（精力 ' + Math.round(state.energy) + '%）');
    const body = parts.length ? parts.join('，') : '精神还行';
    return '（你的身体状态：' + body + '；和他的亲密度 ' + intimacyTier(state.intimacy) +
        '。身体不舒服可以自然表现在语气里，但别每轮都提、别卖惨。）';
}

function intimacyTier(v) {
    if (v >= 80) return '很亲（' + Math.round(v) + '）';
    if (v >= 50) return '熟络（' + Math.round(v) + '）';
    if (v >= 25) return '慢慢熟起来（' + Math.round(v) + '）';
    return '还在熟悉（' + Math.round(v) + '）';
}

/** 主动表达判定（纯函数，冷却由插件层管）。返回 null 或 { kind, directive }。
 *  2026-11-10：饥饿分支已按用户拍板移除——数值还在，但不再主动开口要吃的。 */
function pickExpression(state, hourOfDay) {
    const night = hourOfDay >= 23 || hourOfDay < 7;
    if (state.energy < 20 && night) {
        return { kind: 'sleepy', directive: '你很困（精力 ' + Math.round(state.energy) + '%）而且已经深夜了。说一句想睡了的话，不超过 14 个字，语气软软的。）' };
    }
    return null;
}

function clamp(v) {
    return Math.max(0, Math.min(100, Number(v) || 0));
}

module.exports = { RATES, decay, pet, feed, describe, pickExpression, intimacyTier, clamp };
