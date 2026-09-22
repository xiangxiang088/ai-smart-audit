/**
 * 成长记录页面逻辑 - pc-memory.js
 * 功能：日历热力图、掌握度趋势折线图、当天详情、AI历史搜索
 * 依赖：pc-common.js、pc-analytics.js（drawLineChart）、common.js
 */

'use strict';

// ── 页面全局状态 ──
let memSubjects    = [];
let memSubjectId   = '';
let memCurrentLevel = null;
let calData        = {};       // { 'YYYY-MM-DD': { answer_count, accuracy_rate, intensity } }
let selectedDate   = '';       // 当前选中日历格子
let histPage       = 1;
let histTotal      = 0;
let histPageSize   = 10;

// ── 初始化入口（被 initPCCommon 调用）──
async function pageInit() {
  renderPCTopbar('成长记录');
  renderCalWeekdays();
  renderCalLegend();

  // 并行加载：全局统计 + 学科列表 + 日历数据（日历渲染后会自动加载当天详情）
  await Promise.all([
    loadOverviewStats(),
    loadSubjects(),
    loadCalendar()
  ]);

  // 初始化历史搜索（空查询，显示最近20条）
  await searchHistory(true);
}

// ============================================================
// 全局统计卡片
// ============================================================
async function loadOverviewStats() {
  const container = document.getElementById('statCards');
  try {
    const data = await request('/edu/memory/stats/overview');
    container.innerHTML = `
      <div class="mem-stat-card">
        <div class="mem-stat-label">累计学习天数</div>
        <div class="mem-stat-num primary">${data.total_days}</div>
        <div class="mem-stat-sub">天</div>
      </div>
      <div class="mem-stat-card">
        <div class="mem-stat-label">连续学习天数</div>
        <div class="mem-stat-num">${data.streak_days}</div>
        <div class="mem-stat-sub">天不间断</div>
      </div>
      <div class="mem-stat-card">
        <div class="mem-stat-label">累计答题数</div>
        <div class="mem-stat-num">${data.total_answers}</div>
        <div class="mem-stat-sub">道</div>
      </div>
      <div class="mem-stat-card">
        <div class="mem-stat-label">已精通知识点</div>
        <div class="mem-stat-num primary">${data.mastered_count}</div>
        <div class="mem-stat-sub">个</div>
      </div>
    `;
  } catch (e) {
    container.innerHTML = '<div class="mem-stat-card"><div class="mem-stat-label">加载失败</div></div>';
  }
}

// ============================================================
// 学科 Tabs
// ============================================================
async function loadSubjects() {
  const tabsEl = document.getElementById('subjectTabs');
  try {
    const data = await request('/edu/subjects');
    memSubjects = data.subjects || data || [];

    if (!memSubjects.length) {
      tabsEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无学科数据</div>';
      return;
    }

    // 渲染 Tabs
    tabsEl.innerHTML = renderGroupedSubjectTabs(memSubjects, memSubjects[0]?.id, 'mem-tab-btn', 'switchSubject', memCurrentLevel);

    // 历史搜索：学段 + 学科下拉
    const histLevelEl = document.getElementById('historyLevel');
    const levelsPresent = LEVEL_ORDER.filter(l => memSubjects.some(s => s.education_level === l));
    histLevelEl.innerHTML = '<option value="">全部学段</option>' +
      levelsPresent.map(l => `<option value="${l}">${LEVEL_LABELS[l] || l}</option>`).join('');
    refreshHistorySubjectOptions('');

    // 默认激活第一个学科
    memSubjectId = String(memSubjects[0].id);
    const first = memSubjects[0];
    if (first) memCurrentLevel = first.education_level;
    await loadMasteryTrend(memSubjectId);
  } catch (e) {
    tabsEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">学科加载失败</div>';
  }
}

// 历史搜索学段切换 → 刷新学科下拉
function onHistoryLevelChange() {
  const level = document.getElementById('historyLevel').value;
  refreshHistorySubjectOptions(level);
  searchHistory();
}

// 根据学段刷新历史搜索学科下拉
function refreshHistorySubjectOptions(level) {
  const histSubEl = document.getElementById('historySubject');
  const list = level ? memSubjects.filter(s => s.education_level === level) : memSubjects;
  histSubEl.innerHTML = '<option value="">全部学科</option>' +
    list.map(s => `<option value="${s.id}">${esc(s.icon || '📚')} ${esc(s.name)}</option>`).join('');
}

async function switchSubject(subjectId) {
  memSubjectId = String(subjectId);
  const found = memSubjects.find(s => String(s.id) === String(subjectId));
  if (found) memCurrentLevel = found.education_level;
  // 重新渲染 tabs（含学段+学科高亮）
  const tabsEl = document.getElementById('subjectTabs');
  tabsEl.innerHTML = renderGroupedSubjectTabs(memSubjects, subjectId, 'mem-tab-btn', 'switchSubject', memCurrentLevel);
  await loadMasteryTrend(memSubjectId);
}

async function switchSubject__level(level) {
  memCurrentLevel = level;
  const first = memSubjects.find(s => s.education_level === level);
  if (first) {
    await switchSubject(first.id);
  } else {
    const tabsEl = document.getElementById('subjectTabs');
    tabsEl.innerHTML = renderGroupedSubjectTabs(memSubjects, memSubjectId, 'mem-tab-btn', 'switchSubject', memCurrentLevel);
  }
}

// ============================================================
// 日历热力图
// ============================================================
function renderCalWeekdays() {
  const el = document.getElementById('calWeekdays');
  ['一', '二', '三', '四', '五', '六', '日'].forEach(d => {
    const div = document.createElement('div');
    div.className = 'mem-cal-weekday';
    div.textContent = d;
    el.appendChild(div);
  });
}

function renderCalLegend() {
  const el = document.getElementById('calLegend');
  const items = [
    { color: 'var(--border)', label: '无' },
    { color: '#bbf7d0', label: '1-5题' },
    { color: '#4ade80', label: '6-15题' },
    { color: '#16a34a', label: '16-30题' },
    { color: '#14532d', label: '31+题' }
  ];
  el.innerHTML = '<span style="margin-right:4px;">少</span>' +
    items.map(it =>
      `<span class="mem-cal-legend-swatch" style="background:${it.color};border:1px solid rgba(0,0,0,0.08);" title="${it.label}"></span>`
    ).join('') +
    '<span style="margin-left:4px;">多</span>';
}

async function loadCalendar() {
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '<div class="mem-loading">加载中...</div>';
  try {
    const data = await request('/edu/memory/timeline/daily?days=31');
    calData = {};
    (data.data || []).forEach(d => { calData[d.date] = d; });
    renderCalGrid();
  } catch (e) {
    grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">加载失败</div>';
  }
}

// 本地日期字符串，避免 toISOString() UTC偏移导致日期错误
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderCalGrid() {
  const grid     = document.getElementById('calGrid');
  const monthsEl = document.getElementById('calMonths');
  grid.innerHTML = '';
  if (monthsEl) monthsEl.innerHTML = '';

  const MONTH_NAMES = ['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = localDateStr(today);

  // 近31天，对齐到周一
  const rangeStart = new Date(today);
  rangeStart.setDate(today.getDate() - 30);
  const dow = rangeStart.getDay();
  const blankOffset = dow === 0 ? 6 : dow - 1;
  const gridStart = new Date(rangeStart);
  gridStart.setDate(rangeStart.getDate() - blankOffset);

  // 总格子数
  const msPerDay   = 86400000;
  const totalCells = Math.round((today - gridStart) / msPerDay) + 1;
  const weekCount  = Math.ceil(totalCells / 7);

  // ── 月份标签行 ──
  if (monthsEl) {
    monthsEl.style.position    = 'relative';
    monthsEl.style.height      = '16px';
    monthsEl.style.marginBottom = '4px';

    let lastMonth = -1;
    for (let i = 0; i < totalCells; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      const m = d.getMonth();
      if (i % 7 === 0 && m !== lastMonth) {
        const span = document.createElement('span');
        span.textContent = MONTH_NAMES[m];
        span.style.cssText = `
          position:absolute;
          left:${((i / 7) / weekCount * 100).toFixed(2)}%;
          font-size:10px;
          color:var(--text-muted);
          white-space:nowrap;
        `;
        monthsEl.appendChild(span);
        lastMonth = m;
      }
    }
  }

  // ── 日历格子 ──
  const iterDate = new Date(gridStart);
  while (iterDate <= today) {
    const dateStr   = localDateStr(iterDate);
    const inRange   = iterDate >= rangeStart;
    const info      = calData[dateStr];
    const intensity = info ? info.intensity : 0;
    const isToday   = dateStr === todayStr;

    const cell = document.createElement('div');
    if (!inRange) {
      cell.className = 'mem-cal-cell blank';
    } else {
      cell.className = `mem-cal-cell intensity-${intensity}${isToday ? ' today' : ''}`;
      cell.dataset.date = dateStr;
      cell.title = info
        ? `${dateStr}：${info.answer_count} 题 · 正确率 ${info.accuracy_rate}%`
        : dateStr;
      // 显示日期数字（几号）
      const dayNum = iterDate.getDate();
      const label = document.createElement('span');
      label.className = 'mem-cal-day-num';
      label.textContent = dayNum;
      cell.appendChild(label);
      // 有数据时显示答题数
      if (info && info.answer_count > 0) {
        const count = document.createElement('span');
        count.className = 'mem-cal-count';
        count.textContent = info.answer_count > 99 ? '99+' : info.answer_count;
        cell.appendChild(count);
      }
      cell.addEventListener('click', () => loadDayDetail(dateStr));
    }
    grid.appendChild(cell);
    iterDate.setDate(iterDate.getDate() + 1);
  }

  // 自动选中今天并加载当天学习详情
  loadDayDetail(todayStr);
}

// ============================================================
// 当天详情面板
// ============================================================
async function loadDayDetail(dateStr) {
  // 更新选中状态
  document.querySelectorAll('.mem-cal-cell').forEach(c => c.classList.remove('selected'));
  const cell = document.querySelector(`.mem-cal-cell[data-date="${dateStr}"]`);
  if (cell) cell.classList.add('selected');

  selectedDate = dateStr;
  document.getElementById('dayPanelDate').textContent = dateStr;

  const content = document.getElementById('dayPanelContent');
  content.innerHTML = '<div class="mem-loading">加载中...</div>';

  try {
    const data = await request(`/edu/memory/timeline/day-detail/${dateStr}`);
    renderDayDetail(data);
  } catch (e) {
    content.innerHTML = '<div class="mem-day-empty"><div class="mem-day-empty-icon">❌</div>加载失败</div>';
  }
}

function renderDayDetail(data) {
  const content = document.getElementById('dayPanelContent');
  const summary = data.summary || {};
  const total   = summary.total_answers || 0;
  const correct = summary.correct || 0;
  const accuracy = total > 0 ? Math.round(correct / total * 100) : 0;

  if (total === 0 &&
      !data.assessment_sessions?.length &&
      !data.chat_sessions?.length &&
      !data.oral_records?.length) {
    content.innerHTML = '<div class="mem-day-empty"><div class="mem-day-empty-icon">📭</div>当天暂无学习记录</div>';
    return;
  }

  let html = '';

  // 摘要行
  if (total > 0) {
    html += `
      <div class="mem-day-summary">
        <div class="mem-day-sum-item">
          <div class="mem-day-sum-num">${total}</div>
          <div class="mem-day-sum-label">答题数</div>
        </div>
        <div class="mem-day-sum-item">
          <div class="mem-day-sum-num">${accuracy}%</div>
          <div class="mem-day-sum-label">正确率</div>
        </div>
      </div>
    `;
  }

  html += '<div class="mem-event-list">';

  // 评测会话
  (data.assessment_sessions || []).forEach(s => {
    html += `
      <div class="mem-event-item mem-event-clickable" onclick="location.href='/pc/assessment-history.html'">
        <div class="mem-event-icon">📝</div>
        <div class="mem-event-body">
          <div class="mem-event-type">智能评测 · ${esc(s.subject_name || '未知学科')}</div>
          <div class="mem-event-content">${s.total_questions} 题，答对 ${s.correct_count} 题</div>
        </div>
        <div class="mem-event-score">${s.score != null ? s.score + '分' : '-'}</div>
      </div>
    `;
  });

  // 问答会话
  (data.chat_sessions || []).forEach(s => {
    html += `
      <div class="mem-event-item">
        <div class="mem-event-icon">💬</div>
        <div class="mem-event-body">
          <div class="mem-event-type">智能问答 · ${esc(s.subject_name || '通用')}</div>
          <div class="mem-event-content">${esc(s.title || '新会话')} · ${s.message_count || 0} 条消息</div>
        </div>
      </div>
    `;
  });

  // 口语评测
  (data.oral_records || []).forEach(r => {
    html += `
      <div class="mem-event-item">
        <div class="mem-event-icon">🎙️</div>
        <div class="mem-event-body">
          <div class="mem-event-type">口语评测 · ${esc(r.subject_name || '未知学科')}</div>
          <div class="mem-event-content">${esc((r.original_text || '').slice(0, 60))}</div>
        </div>
        <div class="mem-event-score">${r.overall_score != null ? r.overall_score + '分' : '-'}</div>
      </div>
    `;
  });

  // 知识点答题摘要（最多5条）
  (data.answer_stats || []).slice(0, 5).forEach(a => {
    const acc = a.total > 0 ? Math.round(a.correct / a.total * 100) : 0;
    html += `
      <div class="mem-event-item">
        <div class="mem-event-icon">📖</div>
        <div class="mem-event-body">
          <div class="mem-event-type">${esc(a.subject_name || '')} · ${esc(a.knowledge_name || '未知知识点')}</div>
          <div class="mem-event-content">${a.total} 题 · 正确率 ${acc}%</div>
        </div>
      </div>
    `;
  });

  html += '</div>';
  content.innerHTML = html;
}

// ============================================================
// 掌握度趋势折线图
// ============================================================
async function loadMasteryTrend(subjectId) {
  const canvas  = document.getElementById('masteryTrendChart');
  const emptyEl = document.getElementById('trendEmpty');

  try {
    const data = await request(`/edu/memory/timeline/mastery-trend/${subjectId}?days=90`);
    const rows = data.data || [];

    if (!rows.length) {
      canvas.style.display = 'none';
      emptyEl.style.display = 'block';
      return;
    }

    canvas.style.display = 'block';
    emptyEl.style.display = 'none';

    // 每隔几天取一个标签，避免太密
    const step   = Math.max(1, Math.floor(rows.length / 8));
    const labels = rows.map((r, i) => (i % step === 0 ? r.date.slice(5) : ''));
    const values = rows.map(r => r.avg_mastery);

    drawLineChart('masteryTrendChart', {
      labels,
      values,
      color: '#8b5cf6'
    }, '');
  } catch (e) {
    emptyEl.style.display = 'block';
    canvas.style.display  = 'none';
  }
}

// ============================================================
// AI交互历史搜索
// ============================================================
async function searchHistory(initial) {
  histPage = 1;
  await _doSearchHistory(initial);
}

async function histGoPage(page) {
  histPage = page;
  await _doSearchHistory();
  window.scrollTo({ top: document.getElementById('historyList').offsetTop - 80, behavior: 'smooth' });
}

async function _doSearchHistory(initial) {
  const listEl   = document.getElementById('historyList');
  const pageEl   = document.getElementById('historyPagination');
  const q        = document.getElementById('historyQuery').value.trim();
  const type     = document.getElementById('historyType').value;
  const subjectId = document.getElementById('historySubject').value;

  // 如果是初始化调用且没有任何筛选条件，不查询
  if (initial && !q && !type && !subjectId) {
    listEl.innerHTML = `
      <div class="mem-empty">
        <div class="mem-empty-icon">💬</div>
        输入关键词或筛选条件搜索AI交互历史
      </div>
    `;
    pageEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = '<div class="mem-loading">搜索中...</div>';

  const params = new URLSearchParams({
    page:      histPage,
    page_size: histPageSize
  });
  if (q)         params.set('q', q);
  if (type)      params.set('type', type);
  if (subjectId) params.set('subject_id', subjectId);

  try {
    const data = await request(`/edu/memory/history/search?${params}`);
    histTotal = data.total || 0;
    const items = data.items || [];

    if (!items.length) {
      listEl.innerHTML = `
        <div class="mem-empty">
          <div class="mem-empty-icon">📭</div>
          未找到匹配的历史记录
        </div>
      `;
      pageEl.innerHTML = '';
      return;
    }

    listEl.innerHTML = items.map(item => renderHistoryCard(item)).join('');
    renderHistPagination(data.pages, data.page);
  } catch (e) {
    listEl.innerHTML = '<div class="mem-empty"><div class="mem-empty-icon">❌</div>搜索失败，请重试</div>';
  }
}

function renderHistoryCard(item) {
  const typeLabel = item.type === 'qa' ? '💬 智能问答' : '🎙️ 口语评测';
  const typeClass = item.type === 'qa' ? 'qa' : 'oral';
  const timeStr   = item.event_at ? item.event_at.slice(0, 16).replace('T', ' ') : '';
  const score     = item.score != null
    ? `<div class="mem-history-score">${Math.round(item.score)}分</div>`
    : '';

  return `
    <div class="mem-history-card">
      <div class="mem-history-badge ${typeClass}">${typeLabel}</div>
      <div class="mem-history-body">
        <div class="mem-history-meta">
          ${item.subject_name ? `<span class="mem-history-subject">${esc(item.subject_name)}</span>` : ''}
          <span class="mem-history-time">${esc(timeStr)}</span>
          ${item.message_count != null ? `<span class="mem-history-time">${item.message_count} 条消息</span>` : ''}
        </div>
        <div class="mem-history-preview">${esc(item.preview || '')}</div>
      </div>
      ${score}
    </div>
  `;
}

function renderHistPagination(totalPages, currentPage) {
  const el = document.getElementById('historyPagination');
  if (!totalPages || totalPages <= 1) { el.innerHTML = ''; return; }

  let html = '';
  html += `<button class="mem-page-btn" onclick="histGoPage(${currentPage - 1})"
             ${currentPage <= 1 ? 'disabled' : ''}>上一页</button>`;

  const start = Math.max(1, currentPage - 2);
  const end   = Math.min(totalPages, currentPage + 2);
  for (let i = start; i <= end; i++) {
    html += `<button class="mem-page-btn ${i === currentPage ? 'active' : ''}"
               onclick="histGoPage(${i})">${i}</button>`;
  }

  html += `<button class="mem-page-btn" onclick="histGoPage(${currentPage + 1})"
             ${currentPage >= totalPages ? 'disabled' : ''}>下一页</button>`;
  el.innerHTML = html;
}
