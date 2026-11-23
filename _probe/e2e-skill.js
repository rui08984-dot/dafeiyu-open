const SK = require('<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/skill-library.js');
const gc = require('<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js');

(async () => {
  const brief = (r) => { const o={}; for (const k of ['ok','verified','effect','tier','detail','evidence','nextIfFailed','costMs','entryCheck','exitCheck']) if (r[k]!==undefined) o[k]=r[k]; return JSON.stringify(o); };

  console.log('=== 1. 空技能库 ===');
  console.log(JSON.stringify(SK.listSkills()));

  console.log('\n=== 2. 跑几个真动作，攒历史 ===');
  let r = await gc.runGameAction('focus_window', 'ZCode');
  SK.recordHistory({ action: 'focus_window', arg: 'ZCode', ok: r.ok, verified: r.verified, effect: r.effect });
  console.log('focus:', brief(r));
  r = await gc.runGameAction('press_key', 'esc');
  SK.recordHistory({ action: 'press_key', arg: 'esc', ok: r.ok, verified: r.verified, effect: r.effect });
  console.log('esc:', brief(r));
  console.log('历史条数:', SK.getHistory().length);
  console.log('历史:', JSON.stringify(SK.getHistory().map(h => h.action + ':' + h.arg + ':' + h.effect)));

  console.log('\n=== 3. 存成技能 ===');
  const saved = SK.saveSkillFromHistory('回到 ZCode 首页', { description: '聚焦 ZCode 然后按 esc' });
  console.log('保存:', JSON.stringify({ ok: saved.ok, steps: saved.steps, risky: saved.risky, hint: saved.hint }));
  if (saved.skill) console.log('  技能:', JSON.stringify({ name: saved.skill.name, steps: saved.skill.steps, entryHash: saved.skill.entryHash }));

  console.log('\n=== 4. list（带可靠度）===');
  console.log(JSON.stringify(SK.listSkills().map(s => ({ name: s.name, steps: s.steps.length, rel: s.reliability })), null, 1));

  console.log('\n=== 5. 跑技能 ===');
  await new Promise(r2 => setTimeout(r2, 1500));  // 等 entryHash 异步补上
  const runRes = await SK.runSkill('回到 ZCode 首页', { runGameAction: gc.runGameAction });
  console.log(brief(runRes));
  if (runRes.steps) console.log('  步骤:', JSON.stringify(runRes.steps));

  console.log('\n=== 6. 再 list 看可靠度变化 ===');
  console.log(JSON.stringify(SK.listSkills().map(s => ({ name: s.name, rel: s.reliability }))));

  console.log('\n=== 7. 删掉 ===');
  console.log(JSON.stringify(SK.forgetSkill('回到 ZCode 首页')));
  console.log('剩余:', SK.listSkills().length);

  process.exit(0);
})().catch(e => { console.error('崩:', e.message, e.stack); process.exit(1); });
