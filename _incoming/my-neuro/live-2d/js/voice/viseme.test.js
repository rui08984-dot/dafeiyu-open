// viseme.test.js —— 口型映射单测（node js/voice/viseme.test.js 直接跑）
'use strict';
const assert = require('assert');
const { opennessForFinal, VOWEL_OPENNESS, NASAL_OPENNESS, shapeFor } = require('./viseme.js');

(async () => {
    let pass = 0;
    const ok = (name) => { pass += 1; console.log('  ✅', name); };

    // 1. 单元音：a 最大 u 最小，单调有序
    {
        const o = VOWEL_OPENNESS;
        assert.ok(o.a > o.o && o.o > o.e && o.e > o.i && o.i > o.u, '开口度响度序成立');
        assert.strictEqual(opennessForFinal('a'), o.a, 'a → 满开');
        assert.strictEqual(opennessForFinal('u'), o.u, 'u → 最小');
        ok('单元音开口度（响度序 a>o>e>i>u）');
    }

    // 2. 缩写韵母展开：iu 主元音是 o（不是 i）、ui/un 主元音是 e（不是 u/i）
    {
        assert.strictEqual(opennessForFinal('iu'), VOWEL_OPENNESS.o, 'iu=iou 主元音 o');
        assert.strictEqual(opennessForFinal('ui'), VOWEL_OPENNESS.e, 'ui=uei 主元音 e');
        assert.strictEqual(opennessForFinal('un'), VOWEL_OPENNESS.e, 'un=uen 主元音 e');
        ok('缩写韵母展开（iu→o、ui/un→e）');
    }

    // 3. 复合韵母取主元音：ang/ai/a→a；ei/eng→e；iang→a；ong→o；in/ing→i
    {
        assert.strictEqual(opennessForFinal('ang'), VOWEL_OPENNESS.a);
        assert.strictEqual(opennessForFinal('ai'), VOWEL_OPENNESS.a);
        assert.strictEqual(opennessForFinal('iang'), VOWEL_OPENNESS.a);
        assert.strictEqual(opennessForFinal('ei'), VOWEL_OPENNESS.e);
        assert.strictEqual(opennessForFinal('eng'), VOWEL_OPENNESS.e);
        assert.strictEqual(opennessForFinal('ong'), VOWEL_OPENNESS.o);
        assert.strictEqual(opennessForFinal('in'), VOWEL_OPENNESS.i);
        assert.strictEqual(opennessForFinal('ing'), VOWEL_OPENNESS.i);
        ok('复合韵母主元音扫描');
    }

    // 4. 成音节鼻音与兜底：嗯(n)/呣(m)/ng 有小开口；空串/怪串给中开口不闭死
    {
        assert.strictEqual(opennessForFinal('n'), NASAL_OPENNESS.n);
        assert.strictEqual(opennessForFinal('m'), NASAL_OPENNESS.m);
        assert.strictEqual(opennessForFinal('ng'), NASAL_OPENNESS.ng);
        assert.ok(opennessForFinal('') > 0 && opennessForFinal('xyz123') > 0, '未知韵母不闭死');
        assert.ok(opennessForFinal('xyz123') < 0.6, '未知韵母也不满开');
        ok('鼻音 + 未知韵母兜底');
    }

    // 5. shapeFor：未预热返回 null（驱动侧回落正弦）；空/怪输入不炸
    {
        assert.strictEqual(shapeFor('从没预热过的字'), null, '未预热 → null');
        assert.strictEqual(shapeFor(''), null);
        assert.strictEqual(shapeFor(null), null);
        ok('shapeFor 未预热/怪输入 → null 不炸');
    }

    console.log(`\nviseme.test.js：${pass}/5 全过`);
    process.exit(0);
})().catch((e) => { console.error('❌ 测试失败:', e.message); process.exit(1); });
