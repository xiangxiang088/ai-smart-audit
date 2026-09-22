/**
 * 错因分析页面逻辑 - pc-errors.js
 * 展示错因分布统计和历史错因列表
 */

const ERROR_TYPE_COLORS = {
  careless:     '#f59e0b',
  concept:      '#ef4444',
  method:       '#8b5cf6',
  prerequisite: '#ec4899',
  unknown:      '#94a3b8'
};

let currentPage = 1;
const PAGE_SIZE = 15;
let _allErrSubjects = []; // 全量学科列表（含 education_level）

async function pageInit() {
  renderPCTopbar('错因分析');
  await getDictList('education_level');
  await loadErrSubjects();
  await loadErrors();
}

// 加载学科列表（用于筛选下拉）
async function loadErrSubjects() {
  try {
    const data = await request('/edu/subjects');
    _allErrSubjects = Array.isArray(data) ? data : (data.list || []);
    populateErrSubjectFilter(_allErrSubjects);
  } catch (e) {
    console.error('加载学科失败:', e);
  }
}

function populateErrSubjectFilter(subjects) {
  const sel = document.getElementById('filterSubject');
  sel.innerHTML = '<option value="">全部学科</option>';
  subjects.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = (s.icon || '') + ' ' + s.name;
    sel.appendChild(opt);
  });
}

// 学段筛选变化：级联过滤学科下拉
function onLevelFilterChange() {
  const level = document.getElementById('filterLevel').value;
  const filtered = level ? _allErrSubjects.filter(s => s.education_level === level) : _allErrSubjects;
  populateErrSubjectFilter(filtered);
  document.getElementById('filterSubject').value = '';
  loadErrors();
}

// 加载错因分析列表
async function loadErrors() {
  const container = document.getElementById('errorList');
  const errorType = document.getElementById('filterType').value;
  const educationLevel = document.getElementById('filterLevel').value;
  const subjectId = document.getElementById('filterSubject').value;
  container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">⏳</div><div class="pc-empty-text">加载中...</div></div>';

  try {
    const params = new URLSearchParams({ page: currentPage, page_size: PAGE_SIZE });
    if (errorType) params.set('error_type', errorType);
    if (educationLevel) params.set('education_level', educationLevel);
    if (subjectId) params.set('subject_id', subjectId);

    const data = await request(`/edu/error-analysis/me?${params}`);
    const { list, total, type_stats } = data;

    // 更新统计卡片
    updateTypeStats(type_stats);

    if (!list || list.length === 0) {
      container.innerHTML = `
        <div class="pc-empty">
          <div class="pc-empty-icon">🔍</div>
          <div class="pc-empty-text">暂无错因分析记录<br>
            <a href="/pc/assessment.html" style="color:var(--primary);font-size:13px;">完成评测后进行AI错因分析</a>
          </div>
        </div>`;
      document.getElementById('errorPagination').innerHTML = '';
      return;
    }

    // 渲染错因列表
    container.innerHTML = list.map(item => renderErrorItem(item)).join('');

    // 分页
    renderPagination(total);
  } catch (e) {
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-text">加载失败，请刷新重试</div></div>';
  }
}

// 更新错因类型统计卡片
function updateTypeStats(stats) {
  if (!stats) return;
  document.getElementById('countCareless').textContent     = stats.careless || 0;
  document.getElementById('countConcept').textContent      = stats.concept || 0;
  document.getElementById('countMethod').textContent       = stats.method || 0;
  document.getElementById('countPrerequisite').textContent = stats.prerequisite || 0;
  document.getElementById('countTotal').textContent        = stats.total_errors || 0;
}

// 渲染单个错因条目
function renderErrorItem(item) {
  const color = ERROR_TYPE_COLORS[item.error_type] || '#94a3b8';
  const date = item.created_at ? new Date(item.created_at).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) : '--';
  const diffStars = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
  const typeLabels = { single: '单选', multi: '多选', fill: '填空', subjective: '主观' };

  // 渲染选项（如果有）
  let optionsHtml = '';
  if (item.options_json) {
    try {
      const options = typeof item.options_json === 'string' ? JSON.parse(item.options_json) : item.options_json;
      if (Array.isArray(options) && options.length > 0) {
        optionsHtml = `
          <div style="margin:8px 0;padding:10px;background:var(--bg-secondary);border-radius:6px;border-left:3px solid var(--primary);">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">📋 题目选项：</div>
            ${options.map(o => `<div style="font-size:13px;color:var(--text-primary);margin:4px 0;">
              <span style="display:inline-block;min-width:24px;font-weight:600;color:var(--primary);">${esc(o.key)}.</span> ${esc(o.text)}
            </div>`).join('')}
          </div>`;
      }
    } catch (e) {}
  }

  return `
    <div class="edu-error-item">
      <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <!-- 错因标签 -->
        <div class="edu-error-type-badge" style="background:${color}15;color:${color};border:1px solid ${color}30;">
          ${esc(item.error_type_label)}
        </div>

        <!-- 题目信息 -->
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
            ${item.education_level ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg-secondary);color:var(--text-secondary);font-weight:600;">${esc(getDictIcon('education_level', item.education_level))} ${esc(getDictLabel('education_level', item.education_level))}</span>` : ''}
            <span class="edu-badge" style="font-size:11px;">${esc(item.subject_icon || '')} ${esc(item.subject_name || '')}</span>
            <span style="font-size:13px;color:var(--text-secondary);">→</span>
            <span style="font-size:13px;font-weight:600;">${esc(item.knowledge_name || '')}</span>
            <span style="font-size:11px;color:var(--text-muted);">${typeLabels[item.question_type] || ''} ${diffStars[item.difficulty] || ''}</span>
            <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${date}</span>
          </div>

          <!-- 题干（截断） -->
          <div class="edu-error-question">${esc((item.question_content || '').slice(0, 100))}${item.question_content && item.question_content.length > 100 ? '...' : ''}</div>

          <!-- 选项 -->
          ${optionsHtml}

          <!-- 答案对比 -->
          <div style="display:flex;gap:16px;margin:8px 0;font-size:12px;flex-wrap:wrap;">
            <span>学生作答：<strong style="color:#ef4444;">${esc(item.user_answer || '--')}</strong></span>
            <span>正确答案：<strong style="color:#10b981;">${esc(item.correct_answer || '--')}</strong></span>
          </div>

          <!-- AI分析结论 -->
          ${item.error_detail ? `
            <div class="edu-error-detail">
              <span style="font-size:11px;color:var(--text-muted);">错误原因：</span>${esc(item.error_detail)}
            </div>
          ` : ''}

          <!-- 改进建议 -->
          ${item.suggestion ? `
            <div class="edu-error-suggestion">
              💡 ${esc(item.suggestion)}
            </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
}

// 渲染分页
function renderPagination(total) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const container = document.getElementById('errorPagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const buttons = [];
  if (currentPage > 1) {
    buttons.push(`<button class="pc-topbar-btn" onclick="changePage(${currentPage - 1})" style="padding:6px 14px;">上一页</button>`);
  }
  buttons.push(`<span style="color:var(--text-muted);font-size:13px;padding:0 12px;">${currentPage} / ${totalPages}</span>`);
  if (currentPage < totalPages) {
    buttons.push(`<button class="pc-topbar-btn" onclick="changePage(${currentPage + 1})" style="padding:6px 14px;">下一页</button>`);
  }
  container.innerHTML = buttons.join('');
}

// 翻页
function changePage(page) {
  currentPage = page;
  loadErrors();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
