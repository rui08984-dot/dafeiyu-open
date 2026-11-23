const fs = require('fs');
const path = require('path');

const targetFile = path.resolve(__dirname, '../control-v2-renderer.js');
let content = fs.readFileSync(targetFile, 'utf8');

if (content.includes('loadKnowledge')) {
  console.log('control-v2-renderer.js already contains loadKnowledge!');
  process.exit(0);
}

// 1. 在 switchPage 中追加新页签分支
const switchPageAnchor = 'if (pageId === \'petbody\') { loadDressup().catch(() => {}); loadScenes(); }';
const switchPageAddition = `if (pageId === 'petbody') { loadDressup().catch(() => {}); loadScenes(); }
    if (pageId === 'knowledge') loadKnowledge();
    if (pageId === 'skills') loadSkills();
    if (pageId === 'actions') loadActions();`;
content = content.replace(switchPageAnchor, switchPageAddition);

// 2. 在启动闭包前追加实现函数
const launchAnchor = '// ── 启动 ─────────────────────────────────────────────────────────────';
const implementation = `
  // ── 知识库、技能库与操控日志业务逻辑 ───────────────────────────────────

  // 1. 知识库
  let currentKnGame = '植物大战僵尸';
  let knCurrentData = null;

  async function loadKnowledge(game = null) {
    if (game) currentKnGame = game;
    try {
      const games = await api.knowledgeListGames();
      const tabsEl = $('kn-game-tabs');
      if (tabsEl && Array.isArray(games)) {
        tabsEl.innerHTML = games.map(g => \`
          <button class="game-tab \${g === currentKnGame ? 'active' : ''}" data-game="\${escapeHtml(g)}" type="button">\${escapeHtml(g)}</button>
        \`).join('');
        tabsEl.querySelectorAll('.game-tab').forEach(btn => {
          btn.addEventListener('click', () => loadKnowledge(btn.dataset.game));
        });
      }

      const res = await api.knowledgeGetGame(currentKnGame);
      if (!res.ok) {
        toast('知识读取失败: ' + res.error);
        return;
      }
      knCurrentData = res.data;
      paintKnowledge(res.data, res.reliability);
    } catch (e) {
      console.warn('[v2] loadKnowledge failed:', e);
    }
  }

  function paintKnowledge(data, reliability) {
    if (!data) return;
    $('kn-rule-count').textContent = Array.isArray(data.rules) ? data.rules.length : 0;
    $('kn-exp-count').textContent = Array.isArray(data.experience) ? data.experience.length : 0;

    const freshEl = $('kn-live-freshness');
    if (data.live && data.live.updatedAt) {
      const days = Math.floor((Date.now() - Date.parse(data.live.updatedAt)) / 86400000);
      if (days <= 30) {
        freshEl.className = 'kn-badge fresh';
        freshEl.textContent = \`鲜活 (近\${days}天)\`;
      } else if (days <= 90) {
        freshEl.className = 'kn-badge aging';
        freshEl.textContent = \`临期 (\${days}天)\`;
      } else {
        freshEl.className = 'kn-badge stale';
        freshEl.textContent = \`过时降权 (\${days}天)\`;
      }
      $('kn-live-time').textContent = \`更新时间: \${data.live.updatedAt} (\${data.live.source || '用户实测'})\`;
    } else {
      freshEl.className = 'kn-badge';
      freshEl.textContent = '未配置动态层';
      $('kn-live-time').textContent = '暂无动态 RAG 层覆盖';
    }

    const confEl = $('kn-confidence-badge');
    confEl.textContent = (data.confidence || 'medium').toUpperCase();
    confEl.className = 'kn-badge ' + (data.confidence === 'high' ? 'high' : 'med');

    const rulesList = $('kn-rules-list');
    if (rulesList) {
      if (Array.isArray(data.rules) && data.rules.length) {
        rulesList.innerHTML = data.rules.map(r => \`
          <div class="kn-rule-item">
            <span class="kn-rule-tag">\${escapeHtml(r.kind || '规则')}</span>
            <span>\${escapeHtml(r.text || '')}</span>
          </div>
        \`).join('');
      } else {
        rulesList.innerHTML = '<p class="hint">暂无稳定规则条目</p>';
      }
    }

    const keysGrid = $('kn-keys-grid');
    if (keysGrid) {
      const keys = Object.entries(data.keys || {});
      if (keys.length) {
        keysGrid.innerHTML = keys.map(([k, v]) => \`
          <div class="kn-key-chip">
            <span class="kn-key-name">\${escapeHtml(k)}</span>
            <span class="kn-key-val">\${escapeHtml(v)}</span>
          </div>
        \`).join('');
      } else {
        keysGrid.innerHTML = '<span class="hint">无特定键位</span>';
      }
    }

    const actBox = $('kn-typical-actions');
    if (actBox) {
      if (Array.isArray(data.typicalActions) && data.typicalActions.length) {
        actBox.innerHTML = data.typicalActions.map(a => \`
          <span class="kn-act-chip">\${escapeHtml(a)}</span>
        \`).join('');
      } else {
        actBox.innerHTML = '<span class="hint">无常用动作预设</span>';
      }
    }

    const liveBox = $('kn-live-content');
    if (liveBox) {
      if (data.live) {
        liveBox.innerHTML = \`
          <div><strong>版本：</strong>\${escapeHtml(data.live.version || '最新')}</div>
          \${data.live.overrides ? '<div style="margin-top:6px;"><strong>覆盖键位：</strong>' + escapeHtml(JSON.stringify(data.live.overrides.keys || {})) + '</div>' : ''}
          \${Array.isArray(data.live.extra) ? '<div style="margin-top:6px;">' + data.live.extra.map(e => '<div>✦ ' + escapeHtml(e.text) + '</div>').join('') + '</div>' : ''}
        \`;
      } else {
        liveBox.innerHTML = '<span class="hint">当前游戏完全走稳定 rules 层，无需动态覆盖。</span>';
      }
    }

    const expTimeline = $('kn-exp-timeline');
    if (expTimeline) {
      if (Array.isArray(data.experience) && data.experience.length) {
        expTimeline.innerHTML = data.experience.slice().reverse().map(e => \`
          <div class="kn-exp-card \${e.kind === 'success' ? 'success' : 'failure'}">
            <div class="kn-exp-head">
              <span class="kn-exp-badge \${e.kind === 'success' ? 'success' : 'failure'}">
                \${e.kind === 'success' ? '✓ 成功验证' : '✗ 尝试失败'}
              </span>
              <span class="sub mono">\${escapeHtml(String(e.ts || '').slice(5, 16))}</span>
            </div>
            <div class="kn-exp-action">\${escapeHtml(e.action || '')}</div>
            <div class="kn-exp-evidence">
              \${e.evidence ? '<span><strong>证据：</strong>' + escapeHtml(e.evidence) + '</span> ' : ''}
              \${e.note ? '<span>(' + escapeHtml(e.note) + ')</span>' : ''}
            </div>
          </div>
        \`).join('');
      } else {
        expTimeline.innerHTML = '<p class="hint">暂无该游戏的实操经验记录。</p>';
      }
    }
  }

  // 规则编辑弹窗
  function wireKnowledgeModals() {
    $('kn-refresh')?.addEventListener('click', () => loadKnowledge());
    $('kn-edit-rules-btn')?.addEventListener('click', () => {
      if (!knCurrentData) return;
      $('kn-modal-gamename').value = currentKnGame;
      $('kn-modal-keys').value = JSON.stringify(knCurrentData.keys || {}, null, 2);
      $('kn-modal-rules').value = JSON.stringify(knCurrentData.rules || [], null, 2);
      $('kn-edit-modal').classList.add('open');
    });

    $('kn-add-rule-btn')?.addEventListener('click', () => {
      const gName = prompt('请输入新游戏名称：');
      if (!gName) return;
      $('kn-modal-gamename').value = gName.trim();
      $('kn-modal-keys').value = '{\\n  "暂停": "space",\\n  "菜单": "esc"\\n}';
      $('kn-modal-rules').value = '[\\n  {\\n    "id": "intro",\\n    "text": "规则概述",\\n    "kind": "mechanic"\\n  }\\n]';
      $('kn-edit-modal').classList.add('open');
    });

    $('kn-add-exp-btn')?.addEventListener('click', async () => {
      const act = prompt('请输入执行的动作（如 pvz auto 1,3,2）：');
      if (!act) return;
      const ok = confirm('该动作是否成功执行？点击“确定”为成功，点击“取消”为失败');
      const note = prompt('备注说明（例如：卡槽1种向日葵）：') || '';
      try {
        await api.knowledgeAddExperience({
          game: currentKnGame,
          kind: ok ? 'success' : 'failure',
          action: act.trim(),
          verified: ok,
          evidence: ok ? '手动录入验证' : '人工标记失败',
          note: note.trim()
        });
        toast('实操经验已入库！');
        loadKnowledge(currentKnGame);
      } catch (err) {
        toast('写入经验失败: ' + err.message);
      }
    });

    const closeModal = () => $('kn-edit-modal')?.classList.remove('open');
    $('kn-modal-close')?.addEventListener('click', closeModal);
    $('kn-modal-cancel')?.addEventListener('click', closeModal);

    $('kn-modal-save')?.addEventListener('click', async () => {
      const game = $('kn-modal-gamename').value;
      let keys = {}, rules = [];
      try {
        keys = JSON.parse($('kn-modal-keys').value);
      } catch (e) {
        alert('键位映射 JSON 格式错误: ' + e.message);
        return;
      }
      try {
        rules = JSON.parse($('kn-modal-rules').value);
      } catch (e) {
        alert('规则列表 JSON 格式错误: ' + e.message);
        return;
      }

      const payload = {
        game,
        version: '1.x 通用',
        updatedAt: new Date().toISOString().slice(0, 10),
        confidence: 'high',
        rules,
        keys,
        typicalActions: knCurrentData ? (knCurrentData.typicalActions || []) : []
      };

      const res = await api.knowledgeSaveRules(game, payload);
      if (res.ok) {
        toast('游戏规则已更新！');
        closeModal();
        loadKnowledge(game);
      } else {
        toast('保存失败: ' + res.error);
      }
    });
  }

  // 2. 技能库
  async function loadSkills() {
    try {
      const res = await api.skillsList();
      const skills = (res && res.skills) || [];
      $('sk-total-count').textContent = skills.length;

      let sumRel = 0;
      let lastRun = '-';
      skills.forEach(s => {
        if (s.reliability && s.reliability.mean) sumRel += s.reliability.mean;
        if (s.lastRunAt && (!lastRun || s.lastRunAt > lastRun)) lastRun = s.lastRunAt;
      });
      const avg = skills.length ? Math.round((sumRel / skills.length) * 100) : 0;
      $('sk-avg-rel').textContent = avg + '%';
      $('sk-last-run').textContent = lastRun !== '-' ? lastRun.slice(5, 19).replace('T', ' ') : '无记录';

      const grid = $('skills-grid');
      if (!grid) return;
      if (!skills.length) {
        grid.innerHTML = '<p class="hint" style="grid-column:1/-1;">技能库尚为空。当她在操控中验证完成一个成功序列时，会自动或手动固化成技能。</p>';
        return;
      }

      grid.innerHTML = skills.map(sk => {
        const mean = sk.reliability ? Math.round(sk.reliability.mean * 100) : 50;
        const sCount = sk.successCount || 0;
        const aCount = sk.attemptCount || 0;
        const isDeleted = sk.deleted === true;
        const steps = Array.isArray(sk.steps) ? sk.steps : [];

        return \`
          <div class="skill-card \${isDeleted ? 'deleted' : ''}">
            <div class="skill-head">
              <h3 class="skill-title">\${escapeHtml(sk.name)}</h3>
              \${isDeleted ? '<span class="kn-badge stale">已归档</span>' : '<span class="kn-badge fresh">已就绪</span>'}
            </div>
            <p class="skill-desc">\${escapeHtml(sk.description || '无详细描述')}</p>

            <div class="skill-rel-box">
              <div class="skill-rel-meta">
                <span>Beta后验可靠度: <strong>\${mean}%</strong></span>
                <span class="mono">验证: \${sCount} / 尝试: \${aCount}</span>
              </div>
              <div class="skill-rel-track">
                <div class="skill-rel-bar" style="width: \${mean}%;"></div>
              </div>
            </div>

            <div class="skill-steps-title">包含动作序列 (\${steps.length} 步):</div>
            <div class="skill-steps-list">
              \${steps.map((st, i) => \`
                <div class="skill-step-row">
                  <span class="skill-step-num">\${i + 1}.</span>
                  <span class="skill-step-act">\${escapeHtml(st.action || '')}</span>
                  <span class="skill-step-arg">\${escapeHtml(st.arg || '')}</span>
                </div>
              \`).join('')}
            </div>

            <div class="skill-actions-bar">
              \${!isDeleted ? \`
                <button class="btn tiny" data-skill-del="\${escapeHtml(sk.name)}" type="button">遗忘</button>
                <button class="btn tiny primary" data-skill-run="\${escapeHtml(sk.name)}" type="button">▶ 跑一次</button>
              \` : '<span class="sub">已软删除</span>'}
            </div>
          </div>
        \`;
      }).join('');

      grid.querySelectorAll('[data-skill-run]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const nm = btn.dataset.skillRun;
          toast('开始执行技能: ' + nm);
          try {
            const r = await api.skillsRun(nm);
            if (r.ok) toast('✓ 技能执行完成: ' + nm);
            else toast('✕ 技能执行未通过: ' + (r.detail || r.error || '失败'));
            loadSkills();
          } catch (e) {
            toast('执行错误: ' + e.message);
          }
        });
      });

      grid.querySelectorAll('[data-skill-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const nm = btn.dataset.skillDel;
          if (confirm('确认遗忘技能「' + nm + '」吗？')) {
            await api.skillsDelete(nm);
            toast('已遗忘技能: ' + nm);
            loadSkills();
          }
        });
      });
    } catch (e) {
      console.warn('[v2] loadSkills failed:', e);
    }
  }

  // 3. 操控执行日志
  let actionFilter = 'all';

  async function loadActions(filter = null) {
    if (filter) actionFilter = filter;
    try {
      const res = await api.actionsGetHistory();
      const list = (res && res.history) || [];
      $('act-count-hint').textContent = \`共 \${list.length} 条实战执行\`;

      const filtered = list.filter(item => {
        if (actionFilter === 'all') return true;
        return item.effect === actionFilter;
      });

      const timelineEl = $('actions-timeline');
      if (!timelineEl) return;
      if (!filtered.length) {
        timelineEl.innerHTML = '<p class="hint">当前无符合筛选条件的操控日志。</p>';
        return;
      }

      timelineEl.innerHTML = filtered.map(item => {
        const isNoop = item.effect === 'suspected_noop';
        return \`
          <div class="act-log-card \${isNoop ? 'suspected_noop' : ''}">
            <div class="act-left-info">
              <span class="act-time">\${escapeHtml(String(item.ts || '').slice(11, 19) || '-')}</span>
              <span class="act-command">\${escapeHtml(item.action || '')} \${escapeHtml(item.arg || '')}</span>
              <span class="act-detail">\${escapeHtml(item.detail || '')} \${item.evidence ? '· ' + escapeHtml(item.evidence) : ''}</span>
            </div>
            <div class="act-right-meta">
              <span class="act-tier-pill">\${escapeHtml(item.tier || 'L1')}</span>
              <span class="act-effect-pill \${escapeHtml(item.effect || '')}">
                \${isNoop ? '⚠️ 疑似空操作' : escapeHtml(item.effect || 'confirmed')}
              </span>
              <span class="act-cost">\${item.costMs || 0}ms</span>
            </div>
          </div>
        \`;
      }).join('');
    } catch (e) {
      console.warn('[v2] loadActions failed:', e);
    }
  }

  function wireActionsFilters() {
    document.querySelectorAll('#act-filter-chips .chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#act-filter-chips .chip').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        loadActions(btn.dataset.filter);
      });
    });
    $('act-refresh')?.addEventListener('click', () => loadActions());
    $('sk-refresh')?.addEventListener('click', () => loadSkills());
  }

`;

content = content.replace(launchAnchor, implementation + '\n  ' + launchAnchor);

// 在启动函数尾部挂载 wire
const initTail = 'loadScenes();';
const initWire = 'loadScenes(); wireKnowledgeModals(); wireActionsFilters();';
content = content.replace(initTail, initWire);

fs.writeFileSync(targetFile, content, 'utf8');
console.log('Successfully patched control-v2-renderer.js!');
