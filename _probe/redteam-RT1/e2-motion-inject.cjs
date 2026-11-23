// RT1-E2: 证明 /control-motion 的 motion_index 是**裸插值**（在离线副本里执行，不碰真实进程）
// 这段模板是从 _incoming/my-neuro/live-2d/js/services/http-server.js 第 88-97 行原样复制的。
'use strict';

function buildJs(motion_index) {
  return `
                    if (global.emotionMapper && global.emotionMapper.playMotion) {
                        global.emotionMapper.playMotion(${motion_index});
                        "触发动作索引: ${motion_index}";
                    } else {
                        "情绪映射器未初始化";
                    }
                `;
}

// 模拟渲染进程：nodeIntegration=true 的页面里 global 就是 window
const sandbox = { global: { emotionMapper: { calls: [], playMotion(n) { this.calls.push(n); } } } };
sandbox.globalThis = sandbox;

function run(motion_index, label) {
  const js = buildJs(motion_index);
  let out;
  try {
    // eslint-disable-next-line no-new-func
    const f = new Function('global', js);
    out = 'OK, playMotion 收到 ' + JSON.stringify(sandbox.global.emotionMapper.calls) + ' | 返回=' + JSON.stringify(f(sandbox.global));
  } catch (e) {
    out = 'THROW -> ' + e.constructor.name + ': ' + e.message;
  }
  console.log(label.padEnd(10), JSON.stringify(motion_index).slice(0, 60), '\n            ', out);
  sandbox.global.emotionMapper.calls.length = 0;
}

run('3', '正常');
run('"3"', '字符串');
// 合法数字后面接任意语句：证明「参数」能变成「代码」
run('0);global.__rt1Probe=String.fromCharCode(82,84,49);(0', '注入-set');
console.log('            注入后 global.__rt1Probe =', JSON.stringify(sandbox.global.__rt1Probe));
run('0);require(String.fromCharCode(99,104,105,108,100,95,112,114,111,99,101,115,115));(0', '注入-require');
run('0);null.x;(0', '注入-TypeError');
