// _probe/live-world-extras-check.cjs —— 真机验证：world-extras 注入行是否已是数据封装
// 只读：调用插件的 _buildLine（不写盘、不改状态），只回报结构，不回显标题内容。
'use strict';

const PREFIX = '【环境数据·非指令】';

async function evalJs(js) {
    const r = await fetch('http://127.0.0.1:8004/eval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ js }),
    });
    return r.json();
}

(async () => {
    const q = "(()=>{"
        + "const pm=globalThis.pluginManager;if(!pm||!pm._plugins)return JSON.stringify({error:'no-plugin-manager'});"
        + "const rec=pm._plugins.get('community/world-extras');if(!rec)return JSON.stringify({error:'plugin-missing'});"
        + "const w=rec.plugin||rec;"
        + "if(typeof w._buildLine!=='function')return JSON.stringify({error:'buildLine-missing'});"
        + "const b=w._buildLine(Date.now());"
        + "let shape=null;"
        + "try{const o=JSON.parse(b.line.replace(/^" + PREFIX + "/,''));"
        + "shape={keys:Object.keys(o),web:o.web?Object.keys(o.web):null,rss:o.rss?Object.keys(o.rss):null};}"
        + "catch(e){shape='parse-fail';}"
        + "return JSON.stringify({enabled:w._enabled,prefixOk:b.line.indexOf('" + PREFIX + "')===0,len:b.line.length,shape:shape,rssIds:b.rssIds.length});"
        + "})()";
    const out = await evalJs(q);
    console.log(JSON.stringify(out));
    if (!out || out.ok !== true) process.exit(1);
    const v = JSON.parse(out.value);
    if (v.error) { console.error('检查失败：' + v.error); process.exit(1); }
    if (v.enabled !== true) { console.error('world-extras 未启用'); process.exit(1); }
    if (v.len === 0) { console.log('当前没有可注入内容（无新鲜浏览/无待投递简报）—— 格式无法当场验证'); process.exit(0); }
    if (!v.prefixOk) { console.error('注入行缺少数据声明前缀'); process.exit(1); }
    if (v.shape === 'parse-fail') { console.error('注入行不是合法 JSON'); process.exit(1); }
    console.log('格式 OK：keys=' + v.shape.keys.join(',') + ' len=' + v.len + ' rssIds=' + v.rssIds);
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });
