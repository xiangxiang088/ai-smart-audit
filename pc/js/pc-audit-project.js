/**
 * 审计项目页
 */
const AUDIT_TYPE_LABEL = { cost: '造价/结算审计' };

async function pageInit() {
  renderPCTopbar('📁 审计项目');
  document.getElementById('btnNew').addEventListener('click', () => openProjectModal());
  document.getElementById('btnSearch').addEventListener('click', () => loadList());
  document.getElementById('searchInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadList();
  });
  document.getElementById('btnModelCfg').addEventListener('click', () => {
    location.href = '/pc/ai-model-config.html';
  });
  await loadList();
}

// 模型配置已独立成页面 /pc/ai-model-config.html（侧边栏「模型配置」或本页按钮进入），
// 支持调整降级顺序、停用某个模型、一键「只用此模型」——不再在本页维护。

async function loadList() {
  const grid = document.getElementById('projectGrid');
  const keyword = document.getElementById('searchInput').value.trim();
  try {
    const list = await request(`/audit/projects${keyword ? '?keyword=' + encodeURIComponent(keyword) : ''}`);
    if (!list || list.length === 0) {
      grid.innerHTML = '<div class="au-empty" style="grid-column:1/-1;"><span class="icon">📂</span>暂无审计项目，点击右上角「新建审计项目」开始</div>';
      return;
    }
    grid.innerHTML = list.map(p => {
      const docs = Number(p.doc_count) || 0;
      const parsed = Number(p.parsed_count) || 0;
      const findings = Number(p.finding_count) || 0;
      const pct = docs > 0 ? Math.round(parsed / docs * 100) : 0;
      return `
      <div class="au-project-card audit-card" data-id="${p.id}">
        <div class="audit-card-banner">
          <div class="audit-card-icon">📁</div>
          <span class="audit-card-banner-type">${AUDIT_TYPE_LABEL[p.audit_type] || p.audit_type || '造价审计'}</span>
          ${pct === 100 ? '<span class="audit-card-ready">解析完成</span>' : docs > 0 ? `<span class="audit-card-progress">解析 ${pct}%</span>` : ''}
        </div>
        <div class="audit-card-body">
          <div class="audit-card-name" title="${esc(p.project_name)}">${esc(p.project_name)}</div>
          <div class="audit-card-sub">
            ${p.project_code ? '<span>🔖 ' + esc(p.project_code) + '</span>' : ''}
            ${p.audit_period ? '<span>📅 ' + esc(p.audit_period) + '</span>' : ''}
            ${!p.project_code && !p.audit_period ? '<span>未设置编号 / 期间</span>' : ''}
          </div>
          ${docs > 0 ? `<div class="audit-card-bar"><span style="width:${pct}%"></span></div>` : ''}
          <div class="audit-card-stats">
            <div class="audit-stat">
              <span class="n">${docs}</span><span class="lbl">📄 资料</span>
            </div>
            <div class="audit-stat parsed">
              <span class="n">${parsed}</span><span class="lbl">✅ 已解析</span>
            </div>
            <div class="audit-stat finding">
              <span class="n">${findings}</span><span class="lbl">⚠️ 疑点</span>
            </div>
          </div>
        </div>
        <div class="audit-card-foot"><span>进入资料舱</span><span class="audit-card-go">›</span></div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.au-project-card').forEach(card => {
      card.addEventListener('click', () => {
        setAuditProject(card.dataset.id);
        location.href = '/pc/audit-documents.html?id=' + card.dataset.id;
      });
    });
  } catch (err) {
    if (!err._toastShown) grid.innerHTML = '<div class="au-empty">加载失败：' + esc(err.message) + '</div>';
  }
}

function openProjectModal(project) {
  const isEdit = !!project;
  const mask = document.createElement('div');
  mask.className = 'au-modal-mask';
  mask.innerHTML = `
    <div class="au-modal" onclick="event.stopPropagation()">
      <div class="au-modal-header">${isEdit ? '编辑审计项目' : '新建审计项目'}</div>
      <div class="au-modal-body">
        <div class="au-form-row">
          <label>项目名称（建议使用脱敏代号，如「某厂区改造项目」）<span style="color:#ef4444">*</span></label>
          <input class="au-input" id="f_name" maxlength="200" value="${isEdit ? esc(project.project_name) : ''}">
        </div>
        <div class="au-form-row">
          <label>项目编号</label>
          <input class="au-input" id="f_code" maxlength="64" value="${isEdit ? esc(project.project_code || '') : ''}">
        </div>
        <div style="display:flex;gap:12px;">
          <div class="au-form-row" style="flex:1;">
            <label>审计类型</label>
            <select class="au-select" id="f_type">
              <option value="cost" ${isEdit && project.audit_type !== 'cost' ? '' : 'selected'}>造价/结算审计</option>
            </select>
          </div>
          <div class="au-form-row" style="flex:1;">
            <label>审计/工程期间</label>
            <input class="au-input" id="f_period" maxlength="100" placeholder="如 2025.03-2026.08" value="${isEdit ? esc(project.audit_period || '') : ''}">
          </div>
        </div>
        <div class="au-form-row">
          <label>项目说明</label>
          <textarea class="au-textarea" id="f_desc" maxlength="500">${isEdit ? esc(project.description || '') : ''}</textarea>
        </div>
      </div>
      <div class="au-modal-footer">
        <button class="au-btn" id="f_cancel">取消</button>
        <button class="au-btn primary" id="f_save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', () => mask.remove());
  document.getElementById('f_cancel').addEventListener('click', () => mask.remove());
  document.getElementById('f_save').addEventListener('click', async () => {
    const body = {
      project_name: document.getElementById('f_name').value.trim(),
      project_code: document.getElementById('f_code').value.trim(),
      audit_type: document.getElementById('f_type').value,
      audit_period: document.getElementById('f_period').value.trim(),
      description: document.getElementById('f_desc').value.trim()
    };
    if (!body.project_name) return showToast('请填写项目名称');
    try {
      if (isEdit) {
        await request('/audit/projects/' + project.id, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await request('/audit/projects', { method: 'POST', body: JSON.stringify(body) });
      }
      mask.remove();
      showToast('保存成功');
      loadList();
    } catch (err) { /* request 已弹 toast */ }
  });
}
