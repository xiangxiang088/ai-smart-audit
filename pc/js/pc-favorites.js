/* ============================================================
 * pc-favorites.js - 我的收藏页面逻辑
 * ============================================================ */

let favState = {
  categories: [],
  currentCategoryId: '',   // '' = 全部，'none' = 未分类，其它 = 分类ID
  subjectId: ''
};

document.addEventListener('DOMContentLoaded', () => {
  loadCategories();
  loadSubjects();
  loadFavorites();
});

// 加载学科下拉（用于筛选）
async function loadSubjects() {
  try {
    const subjects = await request('/edu/subjects');
    const select = document.getElementById('subjectFilter');
    if (!select || !Array.isArray(subjects)) return;
    subjects.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    });
  } catch (e) { /* 忽略学科加载失败，不影响收藏主流程 */ }
}

// 加载分类列表
async function loadCategories() {
  try {
    const res = await request('/edu/favorites/categories');
    favState.categories = (res && res.list) || [];
    renderCategoryList();
  } catch (e) {
    showToast('加载分类失败', 'error');
  }
}

// 渲染左侧分类列表
function renderCategoryList() {
  const container = document.getElementById('categoryList');
  if (!container) return;

  const items = [
    { id: '', name: '全部收藏' },
    ...favState.categories.map(c => ({ id: c.id, name: c.name })),
    { id: 'none', name: '未分类' }
  ];

  container.innerHTML = items.map(item => {
    const isActive = String(favState.currentCategoryId) === String(item.id);
    const isCustom = item.id !== '' && item.id !== 'none';
    return `
      <div class="fav-cat-item ${isActive ? 'active' : ''}" onclick="selectCategory('${esc(item.id)}', '${esc(item.name)}')">
        <span class="fav-cat-name">${esc(item.name)}</span>
        ${isCustom ? `
          <span class="fav-cat-actions">
            <button type="button" class="fav-cat-action-btn" onclick="event.stopPropagation();renameCategory('${esc(item.id)}','${esc(item.name)}')" title="重命名">✏️</button>
            <button type="button" class="fav-cat-action-btn" onclick="event.stopPropagation();removeCategory('${esc(item.id)}')" title="删除分类">🗑️</button>
          </span>
        ` : ''}
      </div>
    `;
  }).join('');
}

// 选择分类
function selectCategory(id, name) {
  favState.currentCategoryId = id;
  document.getElementById('currentCategoryLabel').textContent = name;
  renderCategoryList();
  loadFavorites();
}

// 新增分类
async function showAddCategoryModal() {
  const name = await showPrompt({
    title: '新增分类',
    message: '请输入分类名称',
    placeholder: '例如：错题精选'
  });
  if (!name || !name.trim()) return;
  try {
    await request('/edu/favorites/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    showToast('分类创建成功', 'success');
    await loadCategories();
  } catch (e) {
    showToast(e.message || '创建失败', 'error');
  }
}

// 重命名分类
async function renameCategory(id, oldName) {
  const name = await showPrompt({
    title: '重命名分类',
    message: '请输入新的分类名称',
    defaultValue: oldName
  });
  if (!name || !name.trim() || name.trim() === oldName) return;
  try {
    await request(`/edu/favorites/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
    showToast('修改成功', 'success');
    await loadCategories();
  } catch (e) {
    showToast(e.message || '修改失败', 'error');
  }
}

// 删除分类
async function removeCategory(id) {
  const confirmed = await showConfirm({
    title: '删除分类',
    message: '删除后该分类下的题目将变为"未分类"，不会被删除。确定删除吗？',
    okText: '删除',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await request(`/edu/favorites/categories/${id}`, { method: 'DELETE' });
    showToast('分类已删除', 'success');
    if (String(favState.currentCategoryId) === String(id)) {
      favState.currentCategoryId = '';
      document.getElementById('currentCategoryLabel').textContent = '全部收藏';
    }
    await loadCategories();
    loadFavorites();
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}

const FAV_TYPE_LABELS = { single: '单选题', multiple: '多选题', fill: '填空题', subjective: '主观题' };

// 加载收藏题目列表
async function loadFavorites() {
  const container = document.getElementById('favoritesList');
  if (!container) return;
  container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">⏳</div><div class="pc-empty-text">加载中...</div></div>';

  favState.subjectId = document.getElementById('subjectFilter')?.value || '';

  const params = new URLSearchParams();
  if (favState.currentCategoryId) params.set('category_id', favState.currentCategoryId);
  if (favState.subjectId) params.set('subject_id', favState.subjectId);

  try {
    const res = await request(`/edu/favorites?${params.toString()}`);
    const list = (res && res.list) || [];
    renderFavoritesList(list);
  } catch (e) {
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">⚠️</div><div class="pc-empty-text">加载失败，请刷新重试</div></div>';
  }
}

// 渲染收藏题目卡片列表
function renderFavoritesList(list) {
  const container = document.getElementById('favoritesList');
  if (!container) return;
  if (!list || list.length === 0) {
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">⭐</div><div class="pc-empty-text">暂无收藏题目，去评测结果页收藏喜欢的题目吧</div></div>';
    return;
  }

  const catOptions = favState.categories.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');

  container.innerHTML = list.map(item => {
    let options = [];
    if (item.options_json) {
      try {
        options = typeof item.options_json === 'string' ? JSON.parse(item.options_json) : item.options_json;
      } catch (e) { options = []; }
    }
    const optionsHtml = Array.isArray(options) && options.length > 0
      ? `<div style="margin:8px 0;">
          ${options.map(o => `<div style="font-size:13px;color:var(--text-secondary);margin:3px 0;">
            <span style="display:inline-block;min-width:22px;font-weight:600;color:var(--text-muted);">${esc(o.key)}.</span>${esc(o.text)}
          </div>`).join('')}
        </div>`
      : '';

    return `
      <div class="fav-question-card">
        <div class="fav-question-card-header">
          <div class="fav-question-meta">
            <span>${esc(FAV_TYPE_LABELS[item.type] || item.type || '')}</span>
            ${item.subject_name ? `<span>· ${esc(item.subject_name)}</span>` : ''}
            ${item.knowledge_name ? `<span>· ${esc(item.knowledge_name)}</span>` : ''}
            ${item.category_name ? `<span>· 📁 ${esc(item.category_name)}</span>` : '<span>· 未分类</span>'}
          </div>
          <div class="fav-question-actions">
            <select class="form-select fav-move-select" onchange="moveFavorite('${esc(item.question_id)}', this.value)">
              <option value="">移动到...</option>
              <option value="__none__">未分类</option>
              ${catOptions}
            </select>
            <button type="button" class="fav-remove-btn" onclick="removeFavorite('${esc(item.question_id)}')" title="取消收藏">★</button>
          </div>
        </div>
        <div style="font-size:14px;font-weight:500;color:var(--text-primary);line-height:1.6;">${esc(item.content || '')}</div>
        ${optionsHtml}
        <div style="margin:8px 0;font-size:13px;">
          <span>正确答案：<strong style="color:#10b981;">${esc(item.answer || '--')}</strong></span>
        </div>
        ${item.analysis ? `
          <div style="margin-top:6px;padding:10px;background:var(--bg-secondary);border-radius:6px;border-left:3px solid var(--primary,#3b82f6);font-size:13px;color:var(--text-secondary);line-height:1.6;">
            <strong style="color:var(--text-primary);">💡 解析：</strong>${esc(item.analysis)}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// 移动收藏到其它分类
async function moveFavorite(questionId, categoryId) {
  if (!categoryId) return;
  const target = categoryId === '__none__' ? null : categoryId;
  try {
    await request('/edu/favorites', { method: 'POST', body: JSON.stringify({ question_id: questionId, category_id: target }) });
    showToast('已移动', 'success');
    loadFavorites();
  } catch (e) {
    showToast(e.message || '移动失败', 'error');
  }
}

// 取消收藏
async function removeFavorite(questionId) {
  const confirmed = await showConfirm({
    title: '取消收藏',
    message: '确定要取消收藏这道题目吗？',
    okText: '取消收藏',
    variant: 'warning'
  });
  if (!confirmed) return;
  try {
    await request(`/edu/favorites/${questionId}`, { method: 'DELETE' });
    showToast('已取消收藏', 'info');
    loadFavorites();
  } catch (e) {
    showToast(e.message || '操作失败', 'error');
  }
}
