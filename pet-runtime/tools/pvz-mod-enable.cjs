#!/usr/bin/env node
/**
 * PVZ 杂交版 Mod 配置式启用（2026-11-10 三十八轮）。
 *
 * 为什么不是点 GUI：游戏内「选项 → Mod 管理」的袋子按钮对合成点击不响应
 * （已记录在交接件 §18.4，UIA Invoke 也唤不醒 ModEditorPanel）。但 ModManager
 * 的启用状态是**文件持久化**的（Mods/mod_last_good.json → selection.enabledIds），
 * 而启动日志明确说「本次将按已保存的启用配置继续加载」——所以直接改配置即可，
 * 不需要碰 GUI。
 *
 * 安全设计：
 *   · 改前必备份（mod_last_good.json.bak-<ts>），--revert 一键还原
 *   · 只动 selection.enabledIds / preferredOrder，packages 原样保留（不猜结构）
 *   · 游戏自带事务回滚（journal + last_good + safeMode），坏配置不会坏档
 *
 * 用法：
 *   node pet-runtime/tools/pvz-mod-enable.cjs                 # 启用 pvzhe-dsh-state
 *   node pet-runtime/tools/pvz-mod-enable.cjs --revert        # 还原最近一次备份
 *   node pet-runtime/tools/pvz-mod-enable.cjs --status        # 只看当前启用列表
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const MOD_ID = 'pvzhe-dsh-state';
const USER_DIR = process.env.PVZ_USER_DIR ||
  path.join(os.homedir(), 'AppData', 'Roaming', 'Godot', 'app_userdata', '植物大战僵尸杂交版');
const LAST_GOOD = path.join(USER_DIR, 'Mods', 'mod_last_good.json');
const MOD_DIR = path.join(USER_DIR, 'Mods', MOD_ID);
const PMOD = path.join(USER_DIR, 'Mods', MOD_ID + '.pmod');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function main() {
  const argv = process.argv.slice(2);
  if (!fs.existsSync(LAST_GOOD)) {
    console.log(JSON.stringify({ ok: false, error: '找不到 mod_last_good.json：' + LAST_GOOD }, null, 1));
    process.exit(1);
  }
  const cur = readJson(LAST_GOOD);
  const enabled = (cur.selection && cur.selection.enabledIds) || [];

  if (argv.includes('--status')) {
    console.log(JSON.stringify({ ok: true, enabledIds: enabled, packages: cur.packages || [], hasMod: fs.existsSync(MOD_DIR) || fs.existsSync(PMOD) }, null, 1));
    return;
  }

  if (argv.includes('--revert')) {
    const dir = path.dirname(LAST_GOOD);
    const baks = fs.readdirSync(dir)
      .filter((f) => f.startsWith('mod_last_good.json.bak-'))
      .sort();
    if (!baks.length) {
      console.log(JSON.stringify({ ok: false, error: '没有备份可还原' }, null, 1));
      process.exit(1);
    }
    const src = path.join(dir, baks[baks.length - 1]);
    fs.copyFileSync(src, LAST_GOOD);
    console.log(JSON.stringify({ ok: true, revertedFrom: baks[baks.length - 1] }, null, 1));
    return;
  }

  // 前置：mod 文件得在
  if (!fs.existsSync(MOD_DIR) && !fs.existsSync(PMOD)) {
    console.log(JSON.stringify({ ok: false, error: 'mod 文件不在（%s 或 .pmod 都不存在）' }, null, 1));
    process.exit(1);
  }

  if (enabled.includes(MOD_ID)) {
    console.log(JSON.stringify({ ok: true, changed: false, note: '已经启用着（enabledIds 里已有 ' + MOD_ID + '）', enabledIds: enabled }, null, 1));
    return;
  }

  // 备份 → 改 → 写
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = LAST_GOOD + '.bak-' + ts;
  fs.copyFileSync(LAST_GOOD, bak);

  const next = JSON.parse(JSON.stringify(cur));
  next.selection = next.selection || { schemaVersion: 2, enabledIds: [], preferredOrder: [] };
  next.selection.enabledIds = enabled.concat([MOD_ID]);
  // preferredOrder 同步（保持用户原有顺序，新的追加）
  const order = Array.isArray(next.selection.preferredOrder) ? next.selection.preferredOrder.slice() : [];
  if (!order.includes(MOD_ID)) order.push(MOD_ID);
  next.selection.preferredOrder = order;

  fs.writeFileSync(LAST_GOOD, JSON.stringify(next, null, 2), 'utf8');

  // 回读校验（落盘不是终点，读回来一致才算）
  const check = readJson(LAST_GOOD);
  const ok = !!(check.selection && check.selection.enabledIds && check.selection.enabledIds.includes(MOD_ID));

  console.log(JSON.stringify({
    ok,
    changed: true,
    backup: path.basename(bak),
    enabledBefore: enabled,
    enabledAfter: check.selection.enabledIds,
    note: ok
      ? '下次启动游戏会自动加载 ' + MOD_ID + '（日志应出现 loaded 1 enabled Mod package(s)）。'
        + '如果游戏内不生效，用 --revert 还原后改走 GUI 手动装。'
      : '写入后回读不一致——已保留备份，请 --revert',
  }, null, 1));
  process.exit(ok ? 0 : 1);
}

main();
