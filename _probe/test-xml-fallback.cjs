#!/usr/bin/env node
/**
 * XML 伪工具调用兜底解析器单测（2026-11-10 三十八轮）。
 * 覆盖三种实测量产变体：
 *   ① 标准 tool_calls + invoke + parameter（Anthropic/Hermes 风格）
 *   ② DSML 双竖线：<||DSML|| calls> / <||DSML|| invoke name="..."> 
 *   ③ DSML with 全角竖线
 *   ④ 回归：原有 <tool_call>{json}</tool_call> 仍要能解析
 */
const path = require('path');
const { LLMClient } = require(path.join(__dirname, '..', '_incoming/my-neuro/live-2d/js/ai/llm-client.js'));

const c = new LLMClient({ apiKey: 'x', baseURL: 'http://x', model: 'm' });

const BAR = '|';
const samples = {
  '标准 tool_calls': [
    '<tool_calls>',
    '<invoke name="game_control">',
    '<parameter name="action" string="true">som_click</parameter>',
    '<parameter name="arg" string="true">3</parameter>',
    '</invoke>',
    '</tool_calls>',
  ].join('\n'),

  'DSML 双竖线': [
    '<' + BAR + BAR + 'DSML' + BAR + BAR + ' calls>',
    '<' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke name="game_control">',
    '<' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter name="action" string="true">wgc_shot</' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter>',
    '<' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter name="arg" string="true">QQ</' + BAR + BAR + 'DSML' + BAR + BAR + ' parameter>',
    '</' + BAR + BAR + 'DSML' + BAR + BAR + ' invoke>',
    '</' + BAR + BAR + 'DSML' + BAR + BAR + ' calls>',
  ].join('\n'),

  '规则 tool_call JSON（回归）': '<tool_call>\n{"name":"game_control","arguments":{"action":"snapshot","arg":"QQ"}}\n</tool_call>',
};

let pass = 0; let fail = 0;
for (const [name, text] of Object.entries(samples)) {
  const got = c._parseQwenToolCalls(text);
  const ok = Array.isArray(got) && got.length === 1 && got[0].function && got[0].function.name === 'game_control';
  console.log(ok ? 'PASS' : 'FAIL', '|', name, '→', got ? JSON.stringify(got.map((t) => ({ n: t.function.name, a: t.function.arguments }))) : 'null');
  if (ok) pass += 1; else fail += 1;
}

// 清理器：三种变体都要从正文里移除
const dirty = samples['标准 tool_calls'] + ' 后面还有正文';
const cleaned = c._removeToolCallsFromContent(dirty);
const cleanOk = cleaned.trim() === '后面还有正文';
console.log(cleanOk ? 'PASS' : 'FAIL', '| 清理器只留正文 →', JSON.stringify(cleaned));
if (cleanOk) pass += 1; else fail += 1;

console.log('---');
console.log('PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
