// probe: auto-chat 静默/用户活跃早退后是否还会重排下一次（只读；把 sendToLLM 换成计数桩）
const path = require('path');
const APP = '<project-root>/_incoming/my-neuro/live-2d';
const { AutoChatModule } = require(path.join(APP, 'js/live/auto-chat.js'));

const m = new AutoChatModule({ idle_time: 0.001, prompt: 'x', quiet_hours: {} }, { vision: {} }, null);
m.isRunning = true;
let scheduled = 0;
const origSchedule = m.scheduleNext.bind(m);
m.scheduleNext = () => { scheduled += 1; };   // 只计数，不真起定时器

let sent = 0;
global.voiceChat = { sendToLLM: async () => { sent += 1; } };

(async () => {
  // 场景 A：静默模式
  global.__petQuiet = true;
  scheduled = 0;
  await m.executeChat();
  console.log('A 静默期: scheduleNext 调用次数 =', scheduled, '（0 = 定时链断了，自动搭话再也不会触发）');

  // 场景 B：用户活跃（__userActivity.state = active）
  global.__petQuiet = false;
  global.__userActivity = { state: 'active' };
  scheduled = 0;
  await m.executeChat();
  console.log('B 用户活跃: scheduleNext 调用次数 =', scheduled, '（0 = 同样断链）');

  // 场景 C：正常路径（无闸门）
  global.__userActivity = { state: 'idle' };
  scheduled = 0;
  await m.executeChat();
  console.log('C 正常路径: scheduleNext 调用次数 =', scheduled, 'sendToLLM 调用 =', sent);
  process.exit(0);
})().catch((e) => { console.error('probe error', e); process.exit(1); });
