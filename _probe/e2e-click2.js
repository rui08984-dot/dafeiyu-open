const gc = require('<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/game-control.js');
(async () => {
  const brief = (r) => { const o={}; for (const k of ['ok','verified','effect','tier','detail','evidence','nextIfFailed','costMs','via','action_sent']) if (r[k]!==undefined) o[k]=r[k]; return JSON.stringify(o); };
  let t0 = Date.now();
  const snap = await gc.runGameAction('snapshot', 'ZCode');
  const btns = (snap.elements||[]).map((e,i)=>({...e, idx:i+1})).filter(e => e.type === 'button' && e.name);
  console.log('可点按钮:', btns.length, '个 —— ', btns.slice(0,6).map(b=>'#'+b.idx+':'+String(b.name).slice(0,12)).join(' '));
  if (!btns.length) { console.log('没按钮可测'); process.exit(0); }
  // 挑一个「无副作用」的：搜索按钮（点了只是聚焦搜索框）
  const target = btns.find(b => /搜索|筛选/.test(String(b.name))) || btns[0];
  console.log('\n目标: #' + target.idx + ' [' + target.type + '] ' + target.name);
  t0 = Date.now();
  const r = await gc.runGameAction('click_element', String(target.idx));
  console.log('(' + (Date.now()-t0) + 'ms)', brief(r));
  process.exit(0);
})().catch(e => { console.error('崩:', e.message); process.exit(1); });
