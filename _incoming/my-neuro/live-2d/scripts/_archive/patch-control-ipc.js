const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../control-main.js');
let content = fs.readFileSync(targetFile, 'utf8');

const anchor = 'app.whenReady().then(createControlWindow);';
if (!content.includes(anchor)) {
  console.error('Anchor not found!');
  process.exit(1);
}

if (content.includes('control:knowledge-list-games')) {
  console.log('Already patched!');
  process.exit(0);
}

const addition = `
// ── 知识库、技能库与操控执行日志 IPC（2026-11-09 前端可视化）────────────────────
const kbModule = (() => {
  try { return require('./plugins/community/dispatch/knowledge-base.js'); } catch (e) { return null; }
})();
const skModule = (() => {
  try { return require('./plugins/community/dispatch/skill-library.js'); } catch (e) { return null; }
})();
const gcModule = (() => {
  try { return require('./plugins/community/dispatch/game-control.js'); } catch (e) { return null; }
})();

ipcMain.handle('control:knowledge-list-games', async () => {
  if (!kbModule || !kbModule.ROOT) return ['植物大战僵尸', '原神', '我的世界', 'generic-desktop'];
  const games = new Set();
  ['rules', 'live', 'experience'].forEach(sub => {
    const dir = path.join(kbModule.ROOT, sub);
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(f => {
        if (f.endsWith('.json') || f.endsWith('.jsonl')) {
          games.add(f.replace(/\\.jsonl?$/, ''));
        }
      });
    }
  });
  return Array.from(games);
});

ipcMain.handle('control:knowledge-get-game', async (_event, gameName) => {
  if (!kbModule) return { ok: false, error: '知识库模块不可用' };
  try {
    const data = await kbModule.loadLayers(gameName);
    const reliability = {};
    if (data.typicalActions && Array.isArray(data.typicalActions)) {
      for (const act of data.typicalActions) {
        const prefix = act.split(' ')[0];
        reliability[prefix] = kbModule.getActionReliability(gameName, prefix);
      }
    }
    return { ok: true, data, reliability };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:knowledge-save-rules', async (_event, gameName, ruleData) => {
  if (!kbModule || !kbModule.ROOT) return { ok: false, error: '知识库目录不存在' };
  try {
    const rulesDir = path.join(kbModule.ROOT, 'rules');
    if (!fs.existsSync(rulesDir)) fs.mkdirSync(rulesDir, { recursive: true });
    const target = path.join(rulesDir, \`\${gameName}.json\`);
    fs.writeFileSync(target, JSON.stringify(ruleData, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:knowledge-save-live', async (_event, gameName, liveData) => {
  if (!kbModule || !kbModule.ROOT) return { ok: false, error: '知识库目录不存在' };
  try {
    const liveDir = path.join(kbModule.ROOT, 'live');
    if (!fs.existsSync(liveDir)) fs.mkdirSync(liveDir, { recursive: true });
    const target = path.join(liveDir, \`\${gameName}.json\`);
    fs.writeFileSync(target, JSON.stringify(liveData, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:knowledge-add-experience', async (_event, expItem) => {
  if (!kbModule) return { ok: false, error: '知识库模块不可用' };
  try {
    const res = kbModule.recordExperience(expItem);
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:skills-list', async () => {
  if (!skModule) return { ok: false, skills: [] };
  try {
    const db = JSON.parse(fs.readFileSync(skModule.SKILL_FILE, 'utf8'));
    const skills = (db.skills || []).map(s => {
      const rel = skModule.reliabilityOf(s);
      return Object.assign({}, s, { reliability: rel });
    });
    return { ok: true, skills };
  } catch (err) {
    return { ok: false, skills: [] };
  }
});

ipcMain.handle('control:skills-run', async (_event, skillName) => {
  if (!skModule) return { ok: false, error: '技能库模块不可用' };
  try {
    const res = await skModule.runSkill(skillName, {
      runGameAction: gcModule ? gcModule.runGameAction : null,
    });
    return res;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:skills-delete', async (_event, skillName) => {
  if (!skModule) return { ok: false, error: '技能库模块不可用' };
  try {
    return skModule.forgetSkill(skillName);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('control:actions-get-history', async () => {
  const list = [];
  if (skModule) {
    const h = skModule.getHistory();
    if (Array.isArray(h)) list.push(...h);
  }
  if (kbModule && kbModule.ROOT) {
    try {
      const expDir = path.join(kbModule.ROOT, 'experience');
      if (fs.existsSync(expDir)) {
        fs.readdirSync(expDir).filter(f => f.endsWith('.jsonl')).forEach(f => {
          const c = fs.readFileSync(path.join(expDir, f), 'utf8');
          c.split('\\n').filter(Boolean).forEach(line => {
            try {
              const item = JSON.parse(line);
              list.push({
                ts: item.ts,
                action: item.action,
                arg: item.game || '',
                ok: item.kind === 'success',
                verified: item.verified,
                effect: item.kind === 'success' ? 'confirmed' : 'suspected_noop',
                tier: item.verified ? 'L2' : 'L1',
                evidence: item.evidence || item.note || '',
                detail: item.note || '',
                costMs: 45
              });
            } catch (_) {}
          });
        });
      }
    } catch (_) {}
  }
  list.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  return { ok: true, history: list };
});

`;

content = content.replace(anchor, addition + anchor);
fs.writeFileSync(targetFile, content, 'utf8');
console.log('Successfully patched control-main.js!');
