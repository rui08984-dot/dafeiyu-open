// proto-test.mjs — 快速验证 VTS 协议补全项（事件 / 模型切换 / 合帧 / HTTP 控制口）。
import WebSocket from 'ws';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name, pass, extra) => { results.push({ name, pass, extra }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + JSON.stringify(extra) : '')); };

const vts = new WebSocket('ws://127.0.0.1:8001');
const inner = new WebSocket('ws://127.0.0.1:8102');
const events = [];
const innerParams = [];
let id = 0;
const pending = new Map();

function rpc(messageType, data) {
  return new Promise((resolve) => {
    id += 1; const requestID = 't' + id;
    pending.set(requestID, resolve);
    vts.send(JSON.stringify({ apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType, data }));
  });
}

vts.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.requestID && pending.has(msg.requestID)) { pending.get(msg.requestID)(msg); pending.delete(msg.requestID); return; }
  if (msg.messageType && msg.messageType.endsWith('Event')) events.push(msg.messageType);
});
inner.on('message', (raw) => { const msg = JSON.parse(String(raw)); if (msg.type === 'params') innerParams.push(msg.values); });

await Promise.all([new Promise((r) => vts.on('open', r)), new Promise((r) => inner.on('open', r))]);
await rpc('APIStateRequest', {});
await rpc('AuthenticationTokenRequest', { pluginName: 'proto-test', pluginDeveloper: 'lead' });
await rpc('AuthenticationRequest', { pluginName: 'proto-test', pluginDeveloper: 'lead', authenticationToken: 'pet-runtime-token' });

const sub = await rpc('EventSubscriptionRequest', { eventName: 'ModelLoadedEvent', config: { subscribe: true } });
ok('EventSubscriptionRequest', !!sub.data, sub.data);

const load = await rpc('ModelLoadRequest', { modelID: 'dafeiyu' });
await wait(200);
ok('ModelLoadRequest -> ModelLoadedEvent', events.includes('ModelLoadedEvent'), { events });

const avail = await rpc('AvailableModelsRequest', {});
ok('AvailableModelsRequest', Array.isArray(avail.data?.availableModels) && avail.data.availableModels.length > 0, avail.data);

// 120Hz 注入 24 次，应被合帧成远少于 24 条内部消息
innerParams.length = 0;
for (let i = 0; i < 24; i++) rpc('InjectParameterDataRequest', { parameterValues: [{ id: 'ParamMouthOpenY', value: i / 23 }], mode: 'set' });
await wait(300);
ok('InjectParameterData 合帧', innerParams.length > 0 && innerParams.length <= 8 && innerParams.length < 24, { forwarded: innerParams.length, injected: 24 });

// HTTP 控制口
const state = await fetch('http://127.0.0.1:8103/state').then((r) => r.json()).catch((e) => ({ error: String(e) }));
ok('GET /state', state.ok === true, state);
const said = await fetch('http://127.0.0.1:8103/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好呀，我是大肥鱼' }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
ok('POST /say', said.ok === true, said);
const asset = await fetch('http://127.0.0.1:8103/asset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'key11', on: true }) }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
ok('POST /asset', asset.ok === true, asset);

vts.close(); inner.close();
await wait(150);
const failed = results.filter((r) => !r.pass).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exitCode = failed ? 1 : 0;
