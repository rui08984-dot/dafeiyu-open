const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../control-v2.css');
let content = fs.readFileSync(targetFile, 'utf8');

if (content.includes('kn-layers-layout')) {
  console.log('control-v2.css already contains knowledge styles!');
  process.exit(0);
}

const cssAdditions = `
/* ============================================================================
 * 知识库、技能库与操控执行日志样式 (2026-11-09)
 * 融入「绯樱微温 + 水槽边仪表盘」高密度可读性风格
 * ========================================================================= */

/* ── 游戏选择器 ──────────────────────────────────────────────────────── */
.game-selector-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin-bottom: 14px;
}
.game-sel-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
  white-space: nowrap;
}
.game-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.game-tab {
  padding: 4px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--ink);
  font-size: 12.5px;
  cursor: pointer;
  transition: all .15s ease;
  user-select: none;
}
.game-tab:hover {
  background: var(--hover);
  border-color: var(--line-2);
}
.game-tab.active {
  background: #fff0f3;
  border-color: #f472b6;
  color: #db2777;
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(244, 114, 182, 0.18);
}

/* ── 状态指标条 (Status Banner) ────────────────────────────────────────── */
.kn-status-banner {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.kn-stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.kn-stat-label {
  font-size: 11.5px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.kn-stat-val {
  font-size: 18px;
  font-weight: 700;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  font-family: Consolas, monospace;
}
.kn-badge {
  display: inline-block;
  width: fit-content;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  font-weight: 600;
  background: var(--hover);
  color: var(--ink-2);
}
.kn-badge.fresh { background: #ebfbee; color: #2b8a3e; border: 1px solid #b2f2bb; }
.kn-badge.aging { background: #fff9db; color: #e67700; border: 1px solid #ffec99; }
.kn-badge.stale { background: #fff5f5; color: #c92a2a; border: 1px solid #ffc9c9; }
.kn-badge.high  { background: #f0fdf4; color: #166534; border: 1px solid #bbf7d0; }
.kn-badge.med   { background: #fefce8; color: #854d0e; border: 1px solid #fef08a; }

/* ── 三层双栏布局 ─────────────────────────────────────────────────────── */
.kn-layers-layout {
  display: grid;
  grid-template-columns: 1.15fr 1fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 900px) {
  .kn-layers-layout { grid-template-columns: 1fr; }
}

.kn-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 16px;
}
.kn-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.kn-card-head h2 {
  font-size: 13.5px;
  font-weight: 650;
  margin: 0;
  color: var(--ink);
}

/* 规则列表 */
.kn-rules-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kn-rule-item {
  padding: 8px 10px;
  background: var(--bg);
  border-left: 3px solid #f472b6;
  border-radius: 0 4px 4px 0;
  font-size: 13px;
  line-height: 1.5;
}
.kn-rule-tag {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  background: #fce7f3;
  color: #db2777;
  margin-right: 6px;
}

/* 键位矩阵 */
.kn-keys-matrix {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.kn-key-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  background: var(--bg);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  font-size: 12px;
}
.kn-key-name { color: var(--ink-2); }
.kn-key-val {
  background: var(--surface);
  border: 1px solid #ccd2d6;
  border-radius: 3px;
  padding: 1px 6px;
  font-weight: 700;
  font-family: Consolas, monospace;
  box-shadow: 0 1px 0 rgba(0,0,0,0.1);
}

/* 动作标签 */
.kn-actions-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.kn-act-chip {
  padding: 4px 8px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
  font-size: 12px;
  color: #334155;
  font-family: Consolas, monospace;
}

/* Live 层内容 */
.kn-live-body {
  font-size: 13px;
  line-height: 1.55;
  color: var(--ink);
  background: var(--bg);
  padding: 10px;
  border-radius: 4px;
  border: 1px solid var(--line);
}

/* 经验时间线 */
.kn-timeline {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 520px;
  overflow-y: auto;
  padding-right: 4px;
}
.kn-exp-card {
  padding: 9px 12px;
  background: var(--bg);
  border-radius: 6px;
  border: 1px solid var(--line);
  font-size: 12.5px;
  position: relative;
  transition: border-color .15s ease;
}
.kn-exp-card.success { border-left: 3.5px solid #2f9e44; }
.kn-exp-card.failure { border-left: 3.5px solid #e03131; }
.kn-exp-card:hover { border-color: var(--line-2); }
.kn-exp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.kn-exp-badge {
  font-weight: 700;
  font-size: 11.5px;
}
.kn-exp-badge.success { color: #2b8a3e; }
.kn-exp-badge.failure { color: #c92a2a; }
.kn-exp-action {
  font-weight: 600;
  font-family: Consolas, monospace;
  color: var(--ink);
  margin-bottom: 4px;
}
.kn-exp-evidence {
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
}

/* ── 技能库卡片网格 (Skills Grid) ─────────────────────────────────────── */
.skills-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
  align-items: start;
}
.skill-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 14px 16px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
}
.skill-card:hover {
  transform: translateY(-2px);
  border-color: #f472b6;
  box-shadow: 0 6px 16px rgba(244, 114, 182, 0.12);
}
.skill-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.skill-title {
  font-size: 14.5px;
  font-weight: 650;
  color: var(--ink);
  margin: 0;
}
.skill-desc {
  font-size: 12.5px;
  color: var(--ink-2);
  margin: 0 0 10px;
  line-height: 1.45;
}

/* 可靠度进度条 */
.skill-rel-box {
  margin: 10px 0;
  padding: 8px 10px;
  background: var(--bg);
  border-radius: 4px;
}
.skill-rel-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--ink-2);
  margin-bottom: 4px;
}
.skill-rel-track {
  height: 6px;
  background: #e2e8f0;
  border-radius: 3px;
  overflow: hidden;
}
.skill-rel-bar {
  height: 100%;
  background: linear-gradient(90deg, #f472b6, #fb923c);
  border-radius: 3px;
  transition: width .3s ease;
}

/* 步骤序列折叠 */
.skill-steps-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-3);
  text-transform: uppercase;
  margin: 8px 0 4px;
}
.skill-steps-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.skill-step-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-family: Consolas, monospace;
  padding: 3px 6px;
  background: var(--bg);
  border-radius: 4px;
}
.skill-step-num {
  color: var(--ink-3);
  font-weight: bold;
}
.skill-step-act {
  color: #c026d3;
  font-weight: 600;
}
.skill-step-arg {
  color: #0369a1;
}

.skill-actions-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

/* ── 操控执行日志 (Action Execution Log) ────────────────────────────────── */
.act-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
  padding: 8px 12px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
.filter-group {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--line);
  background: var(--bg);
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
  transition: all .15s ease;
}
.chip:hover { background: var(--hover); }
.chip.active {
  background: var(--ink);
  color: #fff;
  border-color: var(--ink);
  font-weight: 600;
}
.chip.warn.active {
  background: #e03131;
  color: #ffffff;
  border-color: #c92a2a;
}

.actions-log-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.act-log-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  font-size: 13px;
  transition: all .15s ease;
}
.act-log-card:hover {
  border-color: var(--line-2);
  box-shadow: 0 2px 8px rgba(0,0,0,0.05);
}

/* ⚠️ suspected_noop 脉冲高亮警戒态 */
.act-log-card.suspected_noop {
  border: 1.5px solid #fa5252 !important;
  background: #fff5f5 !important;
  box-shadow: 0 0 12px rgba(250, 82, 82, 0.22);
}
.act-log-card.suspected_noop .act-effect-pill {
  animation: pulse-warn 2s infinite ease-in-out;
}
@keyframes pulse-warn {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(250, 82, 82, 0.4); }
  50% { transform: scale(1.04); box-shadow: 0 0 0 4px rgba(250, 82, 82, 0); }
}

.act-left-info {
  display: flex;
  align-items: center;
  gap: 12px;
}
.act-time {
  font-size: 11.5px;
  color: var(--ink-3);
  font-family: Consolas, monospace;
}
.act-command {
  font-weight: 650;
  font-family: Consolas, monospace;
  color: var(--ink);
}
.act-detail {
  font-size: 12px;
  color: var(--ink-2);
}

.act-right-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
.act-effect-pill {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  font-weight: 700;
  text-transform: uppercase;
}
.act-effect-pill.confirmed { background: #ebfbee; color: #2b8a3e; }
.act-effect-pill.confirmed_idempotent { background: #e7f5ff; color: #1971c2; }
.act-effect-pill.suspected_noop { background: #ffe3e3; color: #e03131; border: 1px solid #ffa8a8; }
.act-effect-pill.unverifiable { background: #fff9db; color: #e67700; }
.act-effect-pill.not_sent { background: #f1f3f5; color: #868e96; }

.act-tier-pill {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--bg);
  border: 1px solid var(--line);
  font-size: 11px;
  font-family: Consolas, monospace;
  color: var(--ink-3);
}
.act-cost {
  font-size: 11.5px;
  color: var(--ink-3);
  font-family: Consolas, monospace;
}

/* ── 弹窗通用 (Modal) ─────────────────────────────────────────────────── */
.modal-card {
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  width: min(560px, 92vw);
  max-height: 84vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 48px rgba(26, 29, 33, 0.32);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  border-bottom: 1px solid var(--line);
}
.modal-head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.modal-body {
  padding: 16px 18px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 18px;
  border-top: 1px solid var(--line);
  background: var(--bg);
}
`;

content += cssAdditions;
fs.writeFileSync(targetFile, content, 'utf8');
console.log('Successfully updated control-v2.css!');
