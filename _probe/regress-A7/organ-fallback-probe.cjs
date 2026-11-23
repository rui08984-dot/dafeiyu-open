// probe: vision-organ 摘要器「单次失败」是否就永久降级 + 能否自动复活（纯内存，不截图、不联网）
const path = require('path');
const APP = '<project-root>/_incoming/my-neuro/live-2d';
const { VisionOrgan } = require(path.join(APP, 'plugins/community/watch-screen/vision-organ.js'));

let now = 1_000_000;
let calls = 0;
const organ = new VisionOrgan({
  now: () => now,
  capture: async () => 'AAAA',
  signature: async () => new Array(32 * 18).fill(0),
  // 第一次抛错，之后成功 —— 模拟一次网络抖动
  summarize: async () => { calls += 1; if (calls === 1) throw new Error('network blip'); return '画面：测试'; },
  log: (l) => console.log('   [organ]', l),
});

(async () => {
  const e1 = await organ._record(now, { kind: 'change', mad: 9, histDist: 0.2, base64: 'AAAA' });
  console.log('第 1 次摘要抛错 → entry =', e1 && e1.text);
  console.log('  fallbackMode =', organ.fallbackMode, ' | summarize 调用数 =', calls);

  now += 16000;
  const e2 = await organ._record(now, { kind: 'change', mad: 9, histDist: 0.2, base64: 'AAAA' });
  console.log('第 2 次（摘要器其实已恢复）→ entry =', e2 && e2.text);
  console.log('  fallbackMode =', organ.fallbackMode, ' | summarize 调用数 =', calls, '(没涨=根本没再试)');

  // 模拟 5 分钟后的复活窗口（点 _tick 里的复活逻辑是通过 _summarizerDead 触发的）
  now += 6 * 60 * 1000;
  await organ.sampleOnce();          // 触发 _summarizeFrame（若仍降级则走 fallback 文本）
  console.log('6 分钟后 sampleOnce → fallbackMode =', organ.fallbackMode);
  process.exit(0);
})().catch((e) => { console.error('probe error', e); process.exit(1); });
