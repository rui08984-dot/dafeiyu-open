// 端到端验证：契约 + /focus + /fg + UIA elements + dHash 闭环
const path = require('path');
const gc = require('<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js');

(async () => {
  const t = (name) => console.log('\n=== ' + name + ' ===');
  const show = (r, keys) => {
    const o = {};
    for (const k of (keys || ['ok','verified','unverified','effect','tier','detail','evidence','nextIfFailed','costMs','action_sent','error'])) {
      if (r[k] !== undefined) o[k] = r[k];
    }
    console.log(JSON.stringify(o, null, 1).replace(/\n/g, ' '));
  };

  t('1. list_windows（只读，应 effect=readonly）');
  let t0 = Date.now();
  let r = await gc.runGameAction('list_windows', '');
  show(r); console.log('  用时', Date.now()-t0, 'ms, 窗口数', (r.windows||[]).length);

  t('2. list_game_profiles（只读）');
  t0 = Date.now();
  r = await gc.runGameAction('list_game_profiles', '');
  show(r, ['ok','effect','tier','matched','foreground']); console.log('  用时', Date.now()-t0, 'ms');

  t('3. volume up（应 unverified）');
  t0 = Date.now();
  r = await gc.runGameAction('volume', 'volume_up');
  show(r); console.log('  用时', Date.now()-t0, 'ms');

  t('4. focus_window ZCode（应 confirmed + L2 复核）');
  t0 = Date.now();
  r = await gc.runGameAction('focus_window', 'ZCode');
  show(r); console.log('  用时', Date.now()-t0, 'ms');

  t('5. focus_window 不存在的窗口（应 notSent）');
  r = await gc.runGameAction('focus_window', '绝对不存在xyz');
  show(r);

  process.exit(0);
})().catch(e => { console.error('崩了:', e.message); process.exit(1); });
