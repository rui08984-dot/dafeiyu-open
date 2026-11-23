const KB = require('<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/knowledge-base.js');
(async () => {
  console.log('ROOT:', KB.ROOT);
  console.log('CORE_BIN:', KB.CORE_BIN);
  console.log('CORE 存在:', require('fs').existsSync(KB.CORE_BIN || ''));

  console.log('\n=== 1. 无查询：植物大战僵尸骨架 ===');
  let t0 = Date.now();
  let kn = await KB.getKnowledge('植物大战僵尸');
  console.log('(' + (Date.now()-t0) + 'ms) found=' + kn.found + ' rules=' + kn.rules.length + ' keys=' + Object.keys(kn.keys).length);
  console.log(kn.promptText);

  console.log('\n=== 2. 有查询：「为什么种不上」 ===');
  t0 = Date.now();
  kn = await KB.getKnowledge('植物大战僵尸', { query: '为什么种不上', topK: 5 });
  console.log('(' + (Date.now()-t0) + 'ms)');
  console.log('检索 trace:', JSON.stringify(kn.retrievalTrace), 'total_us:', kn.retrievalTotalUs);
  console.log(kn.promptText);

  console.log('\n=== 3. 模糊匹配：「植物大战僵尸杂交重制版v0.31」 ===');
  t0 = Date.now();
  kn = await KB.getKnowledge('植物大战僵尸杂交重制版v0.31', { query: '卡槽冷却' });
  console.log('(' + (Date.now()-t0) + 'ms) 匹配到:', kn.source);

  console.log('\n=== 4. 完全不认识的游戏 → 应退 generic ===');
  kn = await KB.getKnowledge('某个不存在的游戏xyz');
  console.log('found=' + kn.found + ' source=' + JSON.stringify(kn.source) + ' rules=' + kn.rules.length);

  console.log('\n=== 5. 写一条经验 + 读回 ===');
  const w = KB.recordExperience({ game: '植物大战僵尸', kind: 'success', action: 'pvz auto 1,3,2', verified: true, evidence: '像素距离 18', note: '卡槽1是向日葵，第3行第2列安全' });
  console.log('写入:', w.ok, w.file);
  const rel = KB.getActionReliability('植物大战僵尸', 'pvz auto');
  console.log('可靠度:', JSON.stringify(rel));
  process.exit(0);
})().catch(e => { console.error('崩:', e.message, e.stack); process.exit(1); });
