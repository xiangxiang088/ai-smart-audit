/**
 * 评测历史页面逻辑 - pc-assessment-history.js
 * 功能：评测历史列表、详情查看、AI总结
 */

'use strict';

let currentPage = 1;
const PAGE_SIZE = 10;
let _allHistSubjects = []; // 全量学科列表（含 education_level）

async function pageInit() {
  renderPCTopbar('评测历史');
  await getDictList('education_level');
  await loadSubjects();
  await loadHistory();
}

// 加载学科列表
async function loadSubjects() {
  try {
    const data = await request('/edu/subjects');
    _allHistSubjects = Array.isArray(data) ? data : (data.list || []);
    populateHistSubjectFilter(_allHistSubjects);
  } catch (e) {
    console.error('加载学科失败:', e);
  }
}

function populateHistSubjectFilter(subjects) {
  const sel = document.getElementById('subjectFilter');
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
  const level = document.getElementById('levelFilter').value;
  const filtered = level ? _allHistSubjects.filter(s => s.education_level === level) : _allHistSubjects;
  populateHistSubjectFilter(filtered);
  document.getElementById('subjectFilter').value = '';
  loadHistory();
}

// 加载评测历史
async function loadHistory() {
  const container = document.getElementById('historyList');
  const subjectId = document.getElementById('subjectFilter').value;
  const sessionType = document.getElementById('typeFilter').value;
  const educationLevel = document.getElementById('levelFilter').value;

  container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">⏳</div><div class="pc-empty-text">加载中...</div></div>';

  try {
    const params = new URLSearchParams({ page: currentPage, page_size: PAGE_SIZE });
    if (subjectId) params.set('subject_id', subjectId);
    if (sessionType) params.set('session_type', sessionType);
    if (educationLevel) params.set('education_level', educationLevel);

    const data = await request(`/edu/assessment/history?${params}`);
    const { list, total } = data;

    if (!list || list.length === 0) {
      container.innerHTML = `
        <div class="pc-empty">
          <div class="pc-empty-icon">📭</div>
          <div class="pc-empty-text">暂无评测记录<br>
            <a href="/pc/assessment.html" style="color:var(--primary);font-size:13px;">开始新的评测</a>
          </div>
        </div>`;
      document.getElementById('historyPagination').innerHTML = '';
      return;
    }

    // 渲染列表
    container.innerHTML = list.map(item => renderHistoryItem(item)).join('');

    // 分页
    renderPagination(total);
  } catch (e) {
    console.error('加载评测历史失败:', e);
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-text">加载失败，请刷新重试</div></div>';
  }
}

// 渲染单个评测记录
function renderHistoryItem(item) {
  const statusLabels = {
    pending: '进行中',
    completed: '已完成',
    timeout: '已超时'
  };
  const typeLabels = {
    entry: '入学水平评测',
    scan: '知识点漏洞扫描'
  };

  const statusClass = item.status === 'completed' ? 'success' : 'warning';
  const accuracy = item.answered_count > 0
    ? Math.round((item.correct_count / item.answered_count) * 100)
    : 0;

  const startTime = item.started_at
    ? new Date(item.started_at).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      })
    : '--';

  const completedTime = item.completed_at
    ? new Date(item.completed_at).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      })
    : '--';

  // 计算用时
  let duration = '--';
  if (item.started_at && item.completed_at) {
    const ms = new Date(item.completed_at) - new Date(item.started_at);
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    duration = `${minutes}分${seconds}秒`;
  }

  return `
    <div class="history-item">
      <div class="history-item-header">
        <div class="history-meta">
          ${item.education_level ? `<span class="level-badge">${esc(getDictIcon('education_level', item.education_level))} ${esc(getDictLabel('education_level', item.education_level))}</span>` : ''}
          <span class="subject-badge">${esc(item.subject_icon || '')} ${esc(item.subject_name || '未知学科')}</span>
          <span class="type-label">${typeLabels[item.session_type] || item.session_type}</span>
          <span class="status-badge ${statusClass}">${statusLabels[item.status] || item.status}</span>
        </div>
        <div class="history-time">${startTime}</div>
      </div>

      <div class="history-stats">
        <div class="stat-item">
          <div class="stat-label">得分</div>
          <div class="stat-value score">${item.score || 0}分</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">正确率</div>
          <div class="stat-value">${accuracy}%</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">答题数</div>
          <div class="stat-value">${item.correct_count}/${item.answered_count}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">用时</div>
          <div class="stat-value">${duration}</div>
        </div>
      </div>

      <div class="history-actions">
        <button class="history-btn primary" onclick="viewDetail('${esc(item.id)}')">📋 查看详情</button>
        <button class="history-btn" onclick="viewAISummary('${esc(item.id)}')">🤖 AI总结</button>
      </div>

      <!-- AI总结区域（默认隐藏）-->
      <div id="summary-${esc(item.id)}" class="ai-summary-box hidden"></div>
    </div>
  `;
}

// 查看详情
async function viewDetail(sessionId) {
  window.location.href = `/pc/assessment.html?report=${sessionId}`;
}

// 查看AI总结
async function viewAISummary(sessionId) {
  const summaryBox = document.getElementById(`summary-${sessionId}`);

  // 如果已经展开，则收起
  if (!summaryBox.classList.contains('hidden')) {
    summaryBox.classList.add('hidden');
    return;
  }

  summaryBox.innerHTML = '<div class="summary-loading">🤖 AI分析中...</div>';
  summaryBox.classList.remove('hidden');

  try {
    const data = await request(`/edu/assessment/${sessionId}/ai-summary`, {
      method: 'POST'
    });

    if (data.summary) {
      summaryBox.innerHTML = `
        <div class="summary-title">🤖 AI学习总结</div>
        <div class="summary-content">${esc(data.summary)}</div>
        ${data.suggestions ? `<div class="summary-suggestions"><strong>💡 改进建议：</strong><br>${esc(data.suggestions)}</div>` : ''}
      `;
    } else {
      summaryBox.innerHTML = '<div class="summary-error">AI总结生成失败，请稍后重试</div>';
    }
  } catch (e) {
    console.error('获取AI总结失败:', e);
    summaryBox.innerHTML = '<div class="summary-error">获取AI总结失败</div>';
  }
}

// 分页
function renderPagination(total) {
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const container = document.getElementById('historyPagination');
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  const buttons = [];
  if (currentPage > 1) {
    buttons.push(`<button class="page-btn" onclick="changePage(${currentPage - 1})">上一页</button>`);
  }
  buttons.push(`<span class="page-info">${currentPage} / ${totalPages}</span>`);
  if (currentPage < totalPages) {
    buttons.push(`<button class="page-btn" onclick="changePage(${currentPage + 1})">下一页</button>`);
  }
  container.innerHTML = buttons.join('');
}

// 翻页
function changePage(page) {
  currentPage = page;
  loadHistory();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
