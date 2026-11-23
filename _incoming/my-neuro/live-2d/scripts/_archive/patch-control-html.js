const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../control-v2.html');
let content = fs.readFileSync(targetFile, 'utf8');

if (content.includes('data-page="knowledge"')) {
  console.log('control-v2.html already contains knowledge tab!');
  process.exit(0);
}

// 1. 更新导航栏
const navTarget = '<button class="nav" data-page="memory" type="button">记忆</button>';
const navAddition = `<button class="nav" data-page="memory" type="button">记忆</button>
      <button class="nav" data-page="knowledge" type="button">知识库</button>
      <button class="nav" data-page="skills" type="button">技能库</button>
      <button class="nav" data-page="actions" type="button">操控日志</button>`;
content = content.replace(navTarget, navAddition);

// 2. 插入页面内容到 settings 页面之后、.pages 结束之前
const pagesEndTarget = '</section>\n\n      </div>';
const pagesEndTargetAlt = '</section>\r\n\r\n      </div>';

const newSections = `
        <!-- 9 知识库 -->
        <section class="page" id="knowledge">
          <div class="page-head">
            <div>
              <h1>知识库</h1>
              <p class="page-sub">稳定规则 · 动态时效 · 探索经验三层沉淀</p>
            </div>
            <div class="head-actions">
              <button class="btn small" id="kn-refresh" type="button">刷新</button>
              <button class="btn small primary" id="kn-add-rule-btn" type="button">+ 新增游戏规则</button>
            </div>
          </div>

          <!-- 游戏选择器 -->
          <div class="game-selector-bar">
            <span class="game-sel-label">知识域：</span>
            <div class="game-tabs" id="kn-game-tabs"></div>
          </div>

          <!-- 知识概览状态带 -->
          <div class="kn-status-banner" id="kn-status-banner">
            <div class="kn-stat-item">
              <span class="kn-stat-label">稳定规则 (Rules)</span>
              <strong class="kn-stat-val" id="kn-rule-count">-</strong>
            </div>
            <div class="kn-stat-item">
              <span class="kn-stat-label">动态时效 (Live)</span>
              <span class="kn-badge" id="kn-live-freshness">检测中</span>
            </div>
            <div class="kn-stat-item">
              <span class="kn-stat-label">实战经验数</span>
              <strong class="kn-stat-val" id="kn-exp-count">-</strong>
            </div>
            <div class="kn-stat-item">
              <span class="kn-stat-label">综合可信度</span>
              <span class="kn-badge high" id="kn-confidence-badge">High</span>
            </div>
          </div>

          <!-- 层级展示区 -->
          <div class="kn-layers-layout">
            <!-- 左栏：稳定规则与按键绑定 -->
            <div class="kn-left-col">
              <div class="kn-card">
                <div class="kn-card-head">
                  <h2>① 稳定规则层 (rules)</h2>
                  <button class="btn tiny" id="kn-edit-rules-btn" type="button">编辑此游戏规则</button>
                </div>
                <div id="kn-rules-list" class="kn-rules-container"></div>

                <div class="kn-card-head" style="margin-top:16px;">
                  <h2>常用键位映射</h2>
                </div>
                <div id="kn-keys-grid" class="kn-keys-matrix"></div>

                <div class="kn-card-head" style="margin-top:16px;">
                  <h2>常用推荐动作</h2>
                </div>
                <div id="kn-typical-actions" class="kn-actions-chips"></div>
              </div>

              <!-- 动态层 (live) -->
              <div class="kn-card" style="margin-top:16px;">
                <div class="kn-card-head">
                  <h2>② 动态 RAG 层 (live)</h2>
                  <span class="sub" id="kn-live-time">更新时间：-</span>
                </div>
                <div id="kn-live-content" class="kn-live-body"></div>
              </div>
            </div>

            <!-- 右栏：她的经验时间线 -->
            <div class="kn-right-col">
              <div class="kn-card">
                <div class="kn-card-head">
                  <h2>③ 她的实战经验 (experience)</h2>
                  <button class="btn tiny primary" id="kn-add-exp-btn" type="button">+ 补录实操经验</button>
                </div>
                <p class="hint" style="margin:4px 0 10px;">她在游戏与系统中的每一次尝试：✓ 成功沉淀有效模式，✗ 失败立下排坑警示。</p>
                <div id="kn-exp-timeline" class="kn-timeline"></div>
              </div>
            </div>
          </div>
        </section>

        <!-- 10 技能库 -->
        <section class="page" id="skills">
          <div class="page-head">
            <div>
              <h1>技能库</h1>
              <p class="page-sub">验证成功的自足动作序列 · 一键复现 · Beta后验可靠度</p>
            </div>
            <div class="head-actions">
              <button class="btn small" id="sk-refresh" type="button">刷新技能</button>
            </div>
          </div>

          <div class="kn-status-banner">
            <div class="kn-stat-item">
              <span class="kn-stat-label">总就绪技能</span>
              <strong class="kn-stat-val" id="sk-total-count">-</strong>
            </div>
            <div class="kn-stat-item">
              <span class="kn-stat-label">已验证动作率</span>
              <strong class="kn-stat-val" id="sk-avg-rel">-</strong>
            </div>
            <div class="kn-stat-item">
              <span class="kn-stat-label">最近执行记录</span>
              <span class="sub mono" id="sk-last-run">-</span>
            </div>
          </div>

          <div id="skills-grid" class="skills-card-grid"></div>
        </section>

        <!-- 11 操控执行日志 -->
        <section class="page" id="actions">
          <div class="page-head">
            <div>
              <h1>操控执行日志</h1>
              <p class="page-sub">闭环执行监控 · 重点关注疑似未生效状态 (suspected_noop)</p>
            </div>
            <div class="head-actions">
              <button class="btn small" id="act-refresh" type="button">刷新日志</button>
            </div>
          </div>

          <!-- 过滤器栏 -->
          <div class="act-filter-bar">
            <div class="filter-group" id="act-filter-chips">
              <button class="chip active" data-filter="all">全部</button>
              <button class="chip warn" data-filter="suspected_noop">⚠️ 疑似空操作 (重点关注)</button>
              <button class="chip ok" data-filter="confirmed">✓ 确认生效</button>
              <button class="chip neutral" data-filter="unverifiable">? 未验证</button>
              <button class="chip bad" data-filter="not_sent">✕ 未发送</button>
            </div>
            <span class="sub" id="act-count-hint">正在读取…</span>
          </div>

          <div id="actions-timeline" class="actions-log-timeline"></div>
        </section>
`;

if (content.includes('</section>\n\n      </div>')) {
  content = content.replace('</section>\n\n      </div>', '</section>' + newSections + '\n      </div>');
} else if (content.includes('</section>\r\n\r\n      </div>')) {
  content = content.replace('</section>\r\n\r\n      </div>', '</section>' + newSections + '\r\n      </div>');
} else {
  // 查找 settings 闭合
  const idx = content.lastIndexOf('</section>');
  content = content.slice(0, idx + 10) + newSections + content.slice(idx + 10);
}

// 3. 模态弹窗
const modalAddition = `
<div class="modal" id="kn-edit-modal" role="dialog" aria-modal="true" aria-label="编辑规则">
  <div class="modal-card">
    <div class="modal-head">
      <h3 id="kn-modal-title">编辑游戏规则</h3>
      <button class="modal-close" id="kn-modal-close" type="button">×</button>
    </div>
    <div class="modal-body">
      <div class="row col">
        <span class="row-label">游戏名称</span>
        <input type="text" id="kn-modal-gamename" readonly class="mono">
      </div>
      <div class="row col">
        <span class="row-label">键位映射 (JSON: 如 {"暂停": "space"})</span>
        <textarea id="kn-modal-keys" rows="5" class="mono"></textarea>
      </div>
      <div class="row col">
        <span class="row-label">规则列表 (JSON Array: [{"id": "...", "text": "...", "kind": "..."}])</span>
        <textarea id="kn-modal-rules" rows="7" class="mono"></textarea>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn small" id="kn-modal-cancel" type="button">取消</button>
      <button class="btn small primary" id="kn-modal-save" type="button">保存规则</button>
    </div>
  </div>
</div>
`;

content = content.replace('</body>', modalAddition + '</body>');

fs.writeFileSync(targetFile, content, 'utf8');
console.log('Successfully patched control-v2.html!');
