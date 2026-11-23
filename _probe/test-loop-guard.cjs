#!/usr/bin/env node
/**
 * _probe/test-loop-guard.cjs —— 复读护栏 + 打断提示（2026-11-15 六十三轮）
 *
 * 来源：Neuro-sama 行为调研里的两类失败 ——「同一句反复说」与「被打断却不自知、接着讲完」。
 * 这两条都用**易变尾巴**提醒（不写历史、不改 system），所以顺带验一下没碰缓存布局。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIVE = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const LG = require(path.join(LIVE, 'js', 'core', 'loop-guard.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
    if (cond) { pass += 1; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')); return; }
    fail += 1;
    console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}

// ── ① 相似度 ─────────────────────────────────────────────────────────────
{
    ok('完全相同 = 1', LG.similarity('今天真开心', '今天真开心') === 1);
    ok('标点/空格不影响', LG.similarity('今天真开心！', '今天 真开心') === 1);
    ok('完全不同 ≈ 0', LG.similarity('今天真开心', '外面下雨了') < 0.2, String(LG.similarity('今天真开心', '外面下雨了')));
    ok('近义改写仍有相似度', LG.similarity('今天真是够折腾的', '今天真是够折腾的呀') > 0.6);
    ok('表情符号被忽略', LG.similarity('晚安啦🌙', '晚安啦') === 1);
}

// ── ② 复读判定 ───────────────────────────────────────────────────────────
{
    const prev = ['今天真是够折腾的', '那你早点休息吧', '别又熬夜了'];
    ok('原句重复 → 命中', LG.detectLoop('今天真是够折腾的', prev).loop === true);
    ok('轻微改写 → 命中（≥0.9 阈值边界另测）', LG.detectLoop('今天真是够折腾的呀', prev).loop === true,
        String(LG.detectLoop('今天真是够折腾的呀', prev).score));
    ok('正常换话 → 不命中', LG.detectLoop('我先去忙了，晚点再说', prev).loop === false);
    ok('太短不算复读（嗯/好）', LG.detectLoop('嗯嗯', ['嗯嗯']).loop === false);
    ok('空回复不报错', LG.detectLoop('', prev).loop === false);
    ok('阈值可调（0.99 时不放过轻微改写）', LG.detectLoop('今天真是够折腾的呀', prev, { threshold: 0.99 }).loop === false);
}

// ── ③ 源码护栏：两条提示必须走易变尾巴，不许写 history/system ─────────────
{
    const src = fs.readFileSync(path.join(LIVE, 'js', 'ai', 'llm-handler.js'), 'utf8');
    ok('打断提示已定义', /_pendingInterruptNote\s*=\s*'（你上一句还没说完就被他打断了/.test(src));
    ok('打断提示进 volatileTexts', /_pendingInterruptNote\)\s*\{[\s\S]{0,200}volatileTexts\.push\(_pendingInterruptNote\)/.test(src));
    ok('复读提示进 volatileTexts', /volatileTexts\.push\(_pendingLoopNote\)/.test(src));
    ok('复读检测接在最终回复之后', /finalResponseContent[\s\S]{0,900}detectLoop\(finalResponseContent/.test(src));
    // 不许把提示塞进 system / 历史
    ok('打断提示没有被拼进 system', !/sysMsg[\s\S]{0,120}_pendingInterruptNote/.test(src));
}

console.log('\n' + pass + '/' + (pass + fail) + ' 全过');
process.exit(fail === 0 ? 0 : 1);
