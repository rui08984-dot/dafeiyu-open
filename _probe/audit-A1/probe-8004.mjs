const P = 'http://127.0.0.1:8004';
const post = async (js) => {
  const r = await fetch(P + '/eval', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ js }),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

const probes = {
  heap: 'JSON.stringify({used:performance.memory?.usedJSHeapSize,total:performance.memory?.totalJSHeapSize,limit:performance.memory?.jsHeapSizeLimit})',
  mood: 'JSON.stringify((()=>{const m=window.__petMood;if(!m)return {none:true};return {wounds:(m.wounds||[]).length,residue:+m.residue().toFixed(3),desc:m.describe()};})())',
  alive: 'JSON.stringify((()=>{const e=window.pluginManager&&window.pluginManager._plugins.get("community/alive-state");return e&&e.plugin&&e.plugin.stats?e.plugin.stats():{none:true};})())',
  aliveRaw: 'JSON.stringify((()=>{const e=window.pluginManager&&window.pluginManager._plugins.get("community/alive-state");return e&&e.plugin?Object.keys(e.plugin):[];})())',
  plugins: 'JSON.stringify([...(window.pluginManager?window.pluginManager._plugins.keys():[])])',
  dispatch: 'JSON.stringify((()=>{const e=window.pluginManager&&window.pluginManager._plugins.get("community/dispatch");if(!e||!e.plugin)return {none:true};return {keys:Object.keys(e.plugin),stats:e.plugin.stats?e.plugin.stats():null};})())',
  moodKeys: 'JSON.stringify((()=>{const m=window.__petMood;return m?Object.keys(m):[];})())',
};
for (const [k, js] of Object.entries(probes)) {
  const r = await post(js);
  const v = r.value ?? r.raw ?? r;
  console.log(`\n=== ${k} ===\n${String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 1200)}`);
}
