const path = require('node:path');
const KB = require('<project-root>/_incoming/my-neuro/live-2d/plugins/community/dispatch/knowledge-base.js');

(async () => {
  console.log('ROOT:', KB.ROOT);
  console.log('CORE_BIN:', KB.CORE_BIN);
  const games = ['植物大战僵尸', '我的世界', '原神', 'generic-desktop', '不存在的游戏xyz'];
  const rows = [];
  for (const g of games) {
    const kn = await KB.loadLayers(g);
    const docs = KB.flattenToDocs(kn);
    rows.push({ g, found: kn.found, game: kn.game, rules: kn.rules.length, exp: kn.experience.length, live: !!kn.live, docs: docs.length, confidence: kn.confidence });
  }
  console.table(rows);
  const total = rows.reduce((a, r) => a + r.docs, 0);
  console.log('total docs across probes:', total);

  const queries = [
    ['植物大战僵尸', '向日葵 怎么种'],
    ['植物大战僵尸', '僵尸 来了 用什么'],
    ['我的世界', '钻石镐 怎么合成'],
    ['原神', '甘雨 冰 弓'],
    ['generic-desktop', '计算器 怎么打开'],
  ];
  for (const [g, q] of queries) {
    const t0 = performance.now();
    let kn, err = null;
    try { kn = await KB.getKnowledge(g, { query: q, topK: 5 }); } catch (e) { err = e.message; }
    const ms = Math.round(performance.now() - t0);
    const hits = kn?.retrieved?.length || 0;
    console.log(`\n[${g}] "${q}"  ${ms}ms  err=${err}  hits=${hits}  totalUs=${kn?.retrievalTotalUs ?? '-'}`);
    if (kn?.retrievalTrace) console.log('  trace:', JSON.stringify(kn.retrievalTrace).slice(0, 200));
    for (const h of (kn?.retrieved || []).slice(0, 3)) console.log(`   ${h.score} ${h.layer} ${String(h.text).slice(0, 80).replace(/\n/g, ' ')}`);
  }
})();
