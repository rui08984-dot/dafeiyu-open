// state-model.test.js —— 活着感数值模型单测（node 直接跑）
'use strict';
const assert = require('assert');
const { decay, pet, feed, describe, pickExpression, intimacyTier, clamp } = require('./state-model.js');

const S = (over = {}) => ({ satiety: 70, energy: 80, intimacy: 20, updatedAt: 0, ...over });

(async () => {
    let pass = 0;
    const ok = (name) => { pass += 1; console.log('  ✅', name); };

    // 1. 衰减：白天 4h 线性；夜间回血；跨夜不扣光；不越界
    {
        const day = decay(S({ satiety: 100, energy: 100 }), 4, 14);
        assert.ok(Math.abs(day.satiety - 84) < 0.01, '白天 4h 饱食 -16（4/h）');
        assert.ok(Math.abs(day.energy - 88) < 0.01, '白天 4h 精力 -12（3/h）');
        // 终点 01:00，往回 4h = 21,22 白天 + 23,00 夜间 → -3-3+6+6 = +6
        const night = decay(S({ satiety: 100, energy: 50 }), 4, 1);
        assert.ok(Math.abs(night.energy - 56) < 0.01, '夜间 23-07 回精力 +6/h');
        // 终点 07:00，往回 24h：夜里 8h +48，白天 16h -48 → 净值 0（跨夜不再扣光）
        const cross = decay(S({ satiety: 100, energy: 50 }), 24, 7);
        assert.ok(Math.abs(cross.energy - 50) < 0.01, '跨夜 24h 净值 0，不再按当前钟点一刀切');
        assert.strictEqual(clamp(-5), 0, '钳底');
        ok('衰减（白天/夜间回血/跨夜/钳位）');
    }

    // 2. 摸头：亲密 +1.5 只涨不跌，记住时间
    {
        const p = pet(S({ intimacy: 20, lastPetAt: 0 }));
        assert.strictEqual(p.intimacy, 21.5);
        assert.ok(p.lastPetAt > 0);
        const cap = pet(S({ intimacy: 99.8 }));
        assert.strictEqual(cap.intimacy, 100, '封顶不溢出');
        ok('摸头（亲密 +1.5 / 封顶）');
    }

    // 3. 投喂：正常 +35、吃撑只 +5（硬塞不舒服）
    {
        const a = feed(S({ satiety: 50 }));
        assert.strictEqual(a.state.satiety, 85);
        assert.strictEqual(a.overate, false);
        const b = feed(S({ satiety: 90 }));
        assert.strictEqual(b.state.satiety, 95, '撑了只 +5');
        assert.strictEqual(b.overate, true);
        ok('投喂（+35 / 撑了 +5）');
    }

    // 4. 表达判定：深夜困才开口；饥饿插话已按用户拍板移除
    {
        assert.strictEqual(pickExpression(S({ satiety: 20, energy: 90 }), 14), null, '饿了也不再主动要吃的');
        assert.strictEqual(pickExpression(S({ satiety: 60, energy: 15 }), 1).kind, 'sleepy', '深夜+困 → 想睡');
        assert.strictEqual(pickExpression(S({ satiety: 60, energy: 15 }), 14), null, '白天困不表达（夜间因子才困）');
        assert.strictEqual(pickExpression(S({ satiety: 60, energy: 80 }), 14), null, '没事不开口');
        ok('表达判定（夜困 > 沉默；饥饿已移除）');
    }

    // 5. describe：只报困倦，不再报饿；提示不卖惨
    {
        const tired = describe(S({ satiety: 20, energy: 15, intimacy: 30 }));
        assert.ok(/很困/.test(tired) && /慢慢熟起来/.test(tired));
        assert.ok(!/饿|馋/.test(tired), 'hunger 不再进系统提示');
        const fine = describe(S({ satiety: 80, energy: 80, intimacy: 60 }));
        assert.ok(/精神还行/.test(fine) && /熟络/.test(fine));
        ok('身体话术（describe：无饥饿）');
    }

    // 6. 亲密档位
    {
        assert.strictEqual(intimacyTier(90).includes('很亲'), true);
        assert.strictEqual(intimacyTier(10).includes('还在熟悉'), true);
        ok('亲密档位');
    }

    console.log(`\nstate-model.test.js：${pass}/6 全过`);
    process.exit(0);
})().catch((e) => { console.error('❌ 测试失败:', e.message); process.exit(1); });
