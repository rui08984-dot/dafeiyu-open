#!/usr/bin/env node
/**
 * _probe/test-world-priors.cjs — C1 世界可纠错（用户纠偏先验）
 *
 * 钉住六类容易腐坏的东西：
 *   ① 键归一：大小写/空白/应用名尾巴（换应用不需要改代码，但归一规则变了必须有人知道）
 *   ② 先验生命周期：upsert → lookup 命中、TTL 到点失效并顺手清理
 *   ③ 坏文件不炸主链：损坏 JSON 当空表 + lastError 留痕，覆盖前先备份
 *   ④ 原子写：两次写后新实例能读回，且不残留 .tmp 文件
 *   ⑤ world-store 接入：命中先验直接采用（why=user-prior）、越过防抖、TTL 后回到启发式
 *   ⑥ world 工具：status 只读、correct 非法活动报人话原因、合法纠正立刻生效
 *
 * 数据隔离（A2）：require 业务模块之前设 PET_DATA_ROOT + mkdtemp，
 * 并用 assertIsolated 证明真的落在临时目录 —— 测试绝不写真实 data。
 *
 * 用法：node _probe/test-world-priors.cjs
 * 退出码：0 = 全过，1 = 有失败
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const iso = require('./lib/test-isolation.cjs');

// 必须在 require 业务模块之前：records-path 在模块加载时就解析记录室路径。
const tmpRoot = iso.setUpTempDataRoot('pet-priors-');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, '_incoming', 'my-neuro', 'live-2d');
const { recordFile } = require(path.join(APP, 'js', 'core', 'records-path.js'));
const P = require(path.join(APP, 'js', 'core', 'world-priors.js'));
const WS = require(path.join(APP, 'js', 'core', 'world-store.js'));
const WorldSense = require(path.join(APP, 'plugins', 'community', 'world-sense', 'index.js'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(name + (detail ? '：' + detail : ''));
  console.error('  ✗ ' + name + (detail ? ' — ' + detail : ''));
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, '期望 ' + b + '，实际 ' + a);
}
function listTmpLeftovers(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.indexOf('.tmp-') >= 0);
  } catch (e) {
    return [];
  }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

(async () => {
  try {
    // ══ ⓪ 数据隔离 ═══════════════════════════════════════════════════
    {
      const target = recordFile('world-priors.json');
      eq('先验文件落在 PET_DATA_ROOT 下（不写真实记录室）', iso.assertIsolated(target), true);
      eq('默认存储路径就是 records-path 的唯一真源', P.file, target);
      ok('临时数据根已建立', !!tmpRoot && fs.existsSync(tmpRoot), tmpRoot);
    }

    // ══ ① 键归一 ═════════════════════════════════════════════════════
    {
      eq('app 去 .exe + 剥应用名尾巴',
        P.keyOf({ app: 'Notepad.EXE', title: '我的笔记 - Notepad' }), 'notepad::我的笔记');
      eq('浏览器标题尾巴（Google Chrome）被剥掉',
        P.keyOf({ app: 'chrome', title: 'GitHub - Google Chrome' }), 'chrome::github');
      eq('编辑器标题尾巴（Visual Studio Code）被剥掉',
        P.keyOf({ app: 'code', title: 'main.js - Visual Studio Code' }), 'code::main.js');
      eq('大小写与多余空白归一',
        P.keyOf({ app: '  CHROME ', title: '  Hello   WORLD  ' }), 'chrome::hello world');
      eq('中文内容尾巴不被误剥（不是应用名）',
        P.keyOf({ app: 'vlc', title: '第一章 - 第二章' }), 'vlc::第一章 - 第二章');
      eq('带数字的内容尾巴不被误剥（Part 2）',
        P.keyOf({ app: 'vlc', title: '第1集 - Part 2' }), 'vlc::第1集 - part 2');
      eq('内容里恰好含应用名也不误剥（PR #12 - Code Review）',
        P.keyOf({ app: 'code', title: 'PR #12 - Code Review' }), 'code::pr #12 - code review');
      eq('音乐标题不把歌手当应用名（Song - Artist）',
        P.keyOf({ app: 'spotify', title: 'Yesterday - The Beatles' }), 'spotify::yesterday - the beatles');
      eq('没有 app 时也能认出应用名尾巴',
        P.keyOf({ app: '', title: '某个页面 - Chrome' }), '::某个页面');
      eq('app 和 title 都空 → 不用先验', P.keyOf({ app: '', title: '   ' }), '');
      eq('只有 app 也能建键', P.keyOf({ app: 'Steam.exe', title: '' }), 'steam::');
      eq('标题截前 40 字',
        P.keyOf({ app: 'app', title: 'x'.repeat(60) }), 'app::' + 'x'.repeat(40));
      // 这条钉住两处枚举不漂移：world-priors 不能 require world-store（循环），只能靠测试对齐
      eq('活动枚举与 world-store 的 ACTIVITY_LABEL 一致',
        P.ACTIVITIES.slice().sort(), Object.keys(WS.ACTIVITY_LABEL).sort());
    }

    // ══ ② upsert → lookup / TTL ══════════════════════════════════════
    {
      let T = 1_700_000_000_000;
      const file = path.join(tmpRoot, 'ttl-priors.json');
      const p = P.createWorldPriors({ file, ttlMs: 1000, now: () => T });

      const up = p.upsert({ app: 'chrome', title: '周会 - Google Chrome', activity: 'working', note: '例会' });
      eq('upsert 成功', up.ok, true);
      eq('upsert 键已归一', up.key, 'chrome::周会');
      eq('先验条目带百分比置信度', up.entry.conf, 100);
      eq('先验来源是用户', up.entry.source, 'user');
      eq('先验条目记住 TTL', up.entry.ttlMs, 1000);

      const hit = p.lookup({ app: 'chrome', title: '周会' }, T + 999);
      eq('未过期 → 命中活动', hit && hit.activity, 'working');
      eq('命中置信度 100', hit && hit.conf, 100);
      eq('命中原因 user-prior', hit && hit.why, 'user-prior');
      eq('命中带年龄', hit && hit.ageMs, 999);
      eq('别的 app 不串味', p.lookup({ app: 'firefox', title: '周会' }, T + 1), null);
      eq('没有 app/title 不命中', p.lookup({ app: '', title: '' }, T + 1), null);

      eq('TTL 到点 → null', p.lookup({ app: 'chrome', title: '周会' }, T + 1000), null);
      const after = readJson(file);
      eq('过期条目被顺手从文件里清掉',
        after && Object.keys(after.priors).length, 0);
      eq('list 只返回未过期', p.list(T + 1000).priors.length, 0);

      const bad = p.upsert({ app: 'chrome', title: '周会', activity: 'sleeping' });
      eq('非法 activity 拒绝', bad.ok, false);
      ok('非法 activity 给人话原因', /sleeping/.test(String(bad.detail)), String(bad.detail));
      eq('非法 activity 不写进表', p.list(T + 1000).priors.length, 0);
    }

    // ══ ②c meeting 是合法活动（C1 用户原话场景）═══════════════════════
    {
      const T = 1_700_150_000_000;
      const file = path.join(tmpRoot, 'meeting-priors.json');
      const p = P.createWorldPriors({ file, ttlMs: 60000, now: () => T });
      const up = p.upsert({ app: 'wemeet', title: '周会', activity: 'meeting' });
      eq('meeting 写先验成功', up.ok, true);
      eq('meeting 先验可命中', (p.lookup({ app: 'wemeet', title: '周会' }, T) || {}).activity, 'meeting');
      eq('world-store 的 meeting 中文标签是「开会」', WS.ACTIVITY_LABEL.meeting, '开会');
      eq('世界行会渲染「开会」', WS.worldFields({ activity: 'meeting' }).activity, '开会');
    }

    // ══ ②b prune 只清过期的 ══════════════════════════════════════════
    {
      let T = 1_700_200_000_000;
      const file = path.join(tmpRoot, 'prune-priors.json');
      const p = P.createWorldPriors({ file, ttlMs: 1000, now: () => T });
      p.upsert({ app: 'a', title: 'old', activity: 'working' });
      T += 500;
      p.upsert({ app: 'b', title: 'new', activity: 'gaming' });
      T += 600;   // a 存活 1100ms（过期），b 存活 600ms（未过期）
      const pr = p.prune();
      eq('prune 清掉 1 条', pr.removed, 1);
      eq('prune 留下 1 条', pr.left, 1);
      eq('留下的是新的那条', p.list().priors[0].key, 'b::new');
    }

    // ══ ③ 损坏文件不炸 + 留痕 + 覆盖前备份 ═══════════════════════════
    {
      let T = 1_700_300_000_000;
      const file = path.join(tmpRoot, 'corrupt-priors.json');
      fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
      const p = P.createWorldPriors({ file, now: () => T });

      let threw = false;
      let hit = 'unset';
      try { hit = p.lookup({ app: 'x', title: 'y' }, T); } catch (e) { threw = true; }
      ok('损坏文件 lookup 不 throw', !threw);
      eq('损坏文件 lookup 返回 null', hit, null);
      ok('lookup 之后实例仍能报出损坏原因（不静默）', String(p.lastError || '').length > 0, String(p.lastError));

      const l = p.list();
      ok('损坏在 list() 里留痕', String(l.lastError || '').length > 0, String(l.lastError));
      eq('list 标记 corrupt', l.corrupt, true);

      const up = p.upsert({ app: 'x', title: 'y', activity: 'idle' });
      eq('损坏后仍能写入新先验', up.ok, true);
      const backups = fs.readdirSync(tmpRoot).filter((n) => n.indexOf('corrupt-priors.json.corrupt-') === 0);
      eq('覆盖前把坏文件改名备份（不丢残骸）', backups.length, 1);
      eq('新先验立刻可查', (p.lookup({ app: 'x', title: 'y' }, T) || {}).activity, 'idle');
      eq('修好后 lastError 清空', p.list().lastError, '');
    }

    // ══ ④ 原子写：两次写后新实例读回，且无 .tmp 残留 ═════════════════
    {
      const T = 1_700_400_000_000;
      const file = path.join(tmpRoot, 'atomic-priors.json');
      const p = P.createWorldPriors({ file, now: () => T });
      eq('第一次写成功', p.upsert({ app: 'chrome', title: 'a', activity: 'working' }).ok, true);
      eq('第二次写成功', p.upsert({ app: 'chrome', title: 'b', activity: 'watching' }).ok, true);

      const p2 = P.createWorldPriors({ file, now: () => T });
      eq('新实例能读回两条', p2.list().priors.length, 2);
      const doc = readJson(file);
      eq('文件结构是 {version,updatedAt,priors}', Object.keys(doc || {}).sort(), ['priors', 'updatedAt', 'version']);
      const one = doc && doc.priors ? Object.values(doc.priors)[0] : null;
      eq('先验条目结构固定', Object.keys(one || {}).sort(),
        ['activity', 'conf', 'note', 'source', 'ttlMs', 'updatedAt']);
      eq('落盘后再查仍在', (p2.lookup({ app: 'chrome', title: 'b' }, T) || {}).activity, 'watching');
      eq('没有 .tmp 残留', listTmpLeftovers(tmpRoot).length, 0);

      // 写失败要给人话原因（拿一个「父级是文件」的路径模拟建目录失败）
      const blocker = path.join(tmpRoot, 'not-a-dir.txt');
      fs.writeFileSync(blocker, 'x', 'utf8');
      const broken = P.createWorldPriors({ file: path.join(blocker, 'sub', 'priors.json'), now: () => T });
      const bw = broken.upsert({ app: 'a', title: 'b', activity: 'idle' });
      eq('写盘失败 → ok:false', bw.ok, false);
      ok('写盘失败给原因', String(bw.detail || '').length > 0, String(bw.detail));
    }

    // ══ ⑤ world-store 接入 ═══════════════════════════════════════════
    {
      let T = 1_700_500_000_000;
      const file = path.join(tmpRoot, 'store-priors.json');
      const p = P.createWorldPriors({ file, ttlMs: 60000, now: () => T });
      const store = WS.createWorldStore({ now: () => T, priors: p });
      const snapIn = () => ({
        fg: { ok: true, app: 'chrome', title: '周会 - Google Chrome', fullscreen: false },
        idleMs: 1000,
      });

      store.apply(snapIn(), { source: 'system' });
      eq('没有先验时走启发式（working）', store.snapshot().activity, 'working');
      eq('启发式原因不变', store.snapshot().activityWhy, 'fg-app');

      eq('写入先验（原始标题带应用名尾巴）',
        p.upsert({ app: 'chrome', title: '周会', activity: 'watching' }).ok, true);
      // 同一毫秒内重算：若走 stabilize，minDwell(4s) 会把状态按回 working；
      // 先验越过防抖 → 立刻变成 watching，这就是「用户纠正后下一帧就该看到」。
      store.refreshActivity();
      const s1 = store.snapshot();
      eq('先验命中 → 直接采用 watching', s1.activity, 'watching');
      eq('采用原因 why=user-prior', s1.activityWhy, 'user-prior');
      ok('store 置信度仍是 0..1 口径（/world 与验收依赖）', s1.activityConf === 1, String(s1.activityConf));

      T += 59999;
      store.apply(snapIn(), { source: 'system' });
      eq('TTL 内持续采用先验', store.snapshot().activity, 'watching');
      eq('TTL 内原因仍是 user-prior', store.snapshot().activityWhy, 'user-prior');

      T += 1;
      store.apply(snapIn(), { source: 'system' });
      eq('TTL 到点 → 回到启发式', store.snapshot().activity, 'working');
      ok('TTL 到点不再声称 user-prior', store.snapshot().activityWhy !== 'user-prior');
      const doc = readJson(file);
      eq('store 侧过期也顺手清理文件', doc && Object.keys(doc.priors).length, 0);

      // 「人不在」比「他在干嘛」更硬：先验命中也不能把 away 压成在看视频
      p.upsert({ app: 'chrome', title: '周会', activity: 'watching' });
      store.apply(Object.assign(snapIn(), { idleMs: 600000 }), { source: 'system' });
      eq('先验命中 + 启发式 away → 仍是 away', store.snapshot().activity, 'away');
      eq('away 的原因来自空闲判据', store.snapshot().activityWhy, 'idle>=awaySec');

      // 显式 priors:null 必须与旧行为完全一致
      const plain = WS.createWorldStore({ now: () => T, priors: null });
      plain.apply(snapIn(), { source: 'system' });
      eq('priors:null 时完全走启发式', plain.snapshot().activity, 'working');
      eq('priors:null 时原因是启发式', plain.snapshot().activityWhy, 'fg-app');
    }

    // ══ ⑤b 默认接线（createWorldStore 不传 priors 时自动 require）════
    {
      const now = Date.now();
      eq('默认实例写入先验',
        P.upsert({ app: 'pw-test', title: '先验窗口', activity: 'idle' }).ok, true);
      const store = WS.createWorldStore({ now: () => now });
      store.apply({
        fg: { ok: true, app: 'pw-test', title: '先验窗口', fullscreen: false },
        idleMs: 1000,
      }, { source: 'system' });
      eq('不传 priors 也会自动采用（默认文件路径）', store.snapshot().activity, 'idle');
      eq('默认接线原因 user-prior', store.snapshot().activityWhy, 'user-prior');
    }

    // ══ ⑤c away 优先（人不在压过任何先验；人回来先验恢复）══════════════
    {
      let T = 1_700_600_000_000;
      const file = path.join(tmpRoot, 'away-wins-priors.json');
      const p = P.createWorldPriors({ file, ttlMs: 60000, now: () => T });
      eq('写入「开会」先验', p.upsert({ app: 'wemeet', title: '周会', activity: 'meeting' }).ok, true);
      const store = WS.createWorldStore({ now: () => T, priors: p });
      const snap = (idleMs) => ({
        fg: { ok: true, app: 'wemeet', title: '周会', fullscreen: false },
        idleMs,
      });

      store.apply(snap(1000), { source: 'system' });
      eq('人在电脑前 → 先验生效（meeting）', store.snapshot().activity, 'meeting');
      eq('先验来源 user-prior', store.snapshot().activityWhy, 'user-prior');

      T += 1000;
      store.apply(snap(600000), { source: 'system' });
      eq('先验命中 + 启发式 away → 不采用先验（仍是 away）', store.snapshot().activity, 'away');
      ok('away 时不声称 user-prior', store.snapshot().activityWhy !== 'user-prior', store.snapshot().activityWhy);

      // 人回来：idle 降下来，但还处在「离开→回来」的 4s 防抖里，away 仍应保持
      T += 1000;
      store.apply(snap(1000), { source: 'system' });
      eq('刚回来仍在 away 防抖内 → 不急着改口', store.snapshot().activity, 'away');

      // 过了防抖窗口，先验重新生效
      T += 5000;
      store.apply(snap(1000), { source: 'system' });
      eq('离开防抖后先验重新生效', store.snapshot().activity, 'meeting');
      eq('恢复后原因回到 user-prior', store.snapshot().activityWhy, 'user-prior');
    }

    {
      const ctx = {
        getConfig: () => ({}),
        getPluginFileConfig: () => ({}),
        log: () => {},
      };
      const plugin = new WorldSense({ name: 'world-sense' }, ctx);
      await plugin.onInit();

      const tools = plugin.getTools();
      eq('getTools 只声明一个 world 工具', tools.length, 1);
      eq('工具名是 world', tools[0] && tools[0].function && tools[0].function.name, 'world');
      ok('activity 参数带活动枚举（含 meeting）',
        tools[0].function.parameters.properties.activity.enum.indexOf('working') >= 0
        && tools[0].function.parameters.properties.activity.enum.indexOf('meeting') >= 0
        && tools[0].function.parameters.properties.activity.enum.indexOf('away') >= 0);

      const badAction = JSON.parse(await plugin.executeTool('world', { action: 'nope' }));
      eq('未知 action → ok:false', badAction.ok, false);
      ok('未知 action 给原因', String(badAction.detail || '').length > 0, String(badAction.detail));

      const missing = JSON.parse(await plugin.executeTool('world', { action: 'correct' }));
      eq('correct 缺 activity → ok:false', missing.ok, false);
      ok('缺 activity 给原因', /activity/.test(String(missing.detail)), String(missing.detail));

      const beforeCount = plugin._priors.list().priors.length;
      const badAct = JSON.parse(await plugin.executeTool('world', { action: 'correct', activity: 'sleeping' }));
      eq('correct 非法 activity → ok:false', badAct.ok, false);
      ok('非法 activity 报原因（人话）', /sleeping/.test(String(badAct.detail)), String(badAct.detail));
      eq('非法 activity 不落盘', plugin._priors.list().priors.length, beforeCount);

      // 先喂一拍世界状态：chrome 的周会窗口，启发式会判 working
      plugin._store.apply({
        fg: { ok: true, app: 'chrome', title: '周会 - Google Chrome', fullscreen: false },
        idleMs: 1000,
      }, { source: 'system' });

      const st0 = JSON.parse(await plugin.executeTool('world', { action: 'status' }));
      eq('status ok', st0.ok, true);
      eq('status 活动来自 store', st0.activity, 'working');
      eq('status 前台应用', st0.app, 'chrome');
      ok('status 带窗口标题', /周会/.test(st0.title), st0.title);
      eq('status 空闲秒数', st0.idle, 1);
      ok('status 带 since', Number(st0.since) > 0);
      ok('status 带 history 数组', Array.isArray(st0.history));
      ok('status 带 priors 数组', Array.isArray(st0.priors));

      // 用户说「不是，我在开会」→ 模型调 correct(meeting)
      const cor = JSON.parse(await plugin.executeTool('world', { action: 'correct', activity: 'meeting' }));
      eq('correct 成功', cor.ok, true);
      eq('correct 立刻被当前 store 采用', cor.adopted, true);
      eq('correct 返回归一后的键', cor.key, 'chrome::周会');
      ok('到期时刻在未来', Number(cor.expiresAt) > Date.now(), String(cor.expiresAt));

      const st1 = JSON.parse(await plugin.executeTool('world', { action: 'status' }));
      eq('status 下一帧就是纠正后的活动（meeting）', st1.activity, 'meeting');
      eq('status 原因 user-prior', st1.why, 'user-prior');
      ok('status 能看到生效中的先验', st1.priors.length >= 1, String(st1.priors.length));

      // 显式指定别的窗口：先验保存成功，但当前前台不匹配 → adopted:false + hint
      const cor2 = JSON.parse(await plugin.executeTool('world', {
        action: 'correct', activity: 'gaming', app: 'steam', title: '某游戏',
      }));
      eq('给别的窗口纠正也保存成功', cor2.ok, true);
      eq('当前前台不匹配 → adopted:false', cor2.adopted, false);
      ok('不匹配时说清什么时候生效', /生效/.test(String(cor2.hint || '')), String(cor2.hint));

      const st2 = JSON.parse(await plugin.executeTool('world', { action: 'status' }));
      ok('status 里能看到两条生效先验', st2.priors.length >= 2, String(st2.priors.length));

      await plugin.onStop();
    }

    console.log('  ' + (fail === 0 ? '✅' : '❌') + ' 世界可纠错（用户先验）：PASS ' + pass + ' / FAIL ' + fail);
    if (fail && failures.length) console.error('  失败项：\n   - ' + failures.join('\n   - '));
    // 不用 process.exit：那会跳过 finally，临时目录（含测试先验文件）就清不掉了
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('  ✗ 测试自身崩溃：' + ((e && e.stack) || e));
    console.log('  ❌ 世界可纠错（用户先验）：PASS ' + pass + ' / FAIL ' + (fail + 1));
    process.exitCode = 1;
  } finally {
    iso.cleanup(tmpRoot);
  }
})();
