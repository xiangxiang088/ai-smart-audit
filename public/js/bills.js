/**
 * 账单页逻辑
 */

let currentFilter = 'all';
let filterStartDate = '';
let filterEndDate = '';
let filterParentCat = '';
let filterSubCat = '';

// 日历视图状态
let calYear, calMonth; // 当前显示的年月 (0-indexed month)
let calSelectedDate = null;
let calData = {}; // { 'YYYY-MM-DD': { income, expense, count } }
let isCalendarView = false;
let billRecordsCache = {}; // 缓存当前页记录数据用于编辑
let expandedMonths = new Set(); // 展开的月份集合，如 {'2026-07'}
let currentYearOffset = 0; // 年份偏移：0=本年, -1=去年, 1=明年
// 按月懒加载状态
let monthSummary = {}; // { '2026-07': { income, expense, count } } 全年12月汇总
let loadedMonths = {}; // { '2026-07': [records] } 已加载明细的月份
let loadingMonths = new Set(); // 正在加载中的月份

async function pageInit() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  bindEvents();
  renderCatFilterBar();
  // AI快捷输入回车
  document.getElementById('aiQuickInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); aiQuickParse(); }
  });
  // 检测语音识别支持，不支持则隐藏按钮
  if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
    const voiceBtn = document.getElementById('aiQuickVoiceBtn');
    if (voiceBtn) voiceBtn.style.display = 'none';
  }

  // 检测 ?view=calendar 参数（首页"日历视图"快捷入口）
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('view') === 'calendar') {
    // 切换到日历视图
    isCalendarView = true;
    document.getElementById('billsList').style.display = 'none';
    document.getElementById('calendarView').style.display = 'block';
    const toggleBtn = document.getElementById('viewToggleBtn');
    toggleBtn.classList.add('active');
    toggleBtn.querySelector('.top-bar-action-icon').textContent = '📋';
    toggleBtn.querySelector('.top-bar-action-text').textContent = '列表';
    await loadCalendar();
    // 如果今天有数据，自动展示今日明细
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    if (calData[todayStr]) {
      calSelectedDate = todayStr;
      renderCalendar();
      await showDayDetail(todayStr);
    }
  } else {
    await loadBills();
  }

  // 检测 ?diet=1 参数（首页"健康助手"快捷入口）
  if (urlParams.get('diet') === '1') {
    openDietAnalysis();
  }
}

async function pageRefresh() {
  if (isCalendarView) {
    await loadCalendar();
  } else {
    await refreshAfterChange();
  }
}

function bindEvents() {
  // 视图切换（列表/日历）
  document.getElementById('viewToggleBtn').addEventListener('click', async () => {
    isCalendarView = !isCalendarView;
    const listView = document.getElementById('billsList');
    const calView = document.getElementById('calendarView');
    const toggleBtn = document.getElementById('viewToggleBtn');
    const iconEl = toggleBtn.querySelector('.top-bar-action-icon');
    const textEl = toggleBtn.querySelector('.top-bar-action-text');
    const filterBtn = document.getElementById('filterToggleBtn');

    if (isCalendarView) {
      listView.style.display = 'none';
      calView.style.display = 'block';
      toggleBtn.classList.add('active');
      document.getElementById('filterSection').style.display = 'none';
      filterBtn.classList.remove('active');
      await loadCalendar();
      // 自动选中今天并显示当天明细
      const now = new Date();
      const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      if (calData[todayStr]) {
        calSelectedDate = todayStr;
        renderCalendar();
        await showDayDetail(todayStr);
      }
    } else {
      listView.style.display = 'block';
      calView.style.display = 'none';
      toggleBtn.classList.remove('active');
      calSelectedDate = null;
      document.getElementById('calDayDetail').innerHTML = '';
    }
  });

  // 日历月份导航
  document.getElementById('calPrevMonth').addEventListener('click', async () => {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    calSelectedDate = null;
    document.getElementById('calDayDetail').innerHTML = '';
    await loadCalendar();
  });
  document.getElementById('calNextMonth').addEventListener('click', async () => {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    calSelectedDate = null;
    document.getElementById('calDayDetail').innerHTML = '';
    await loadCalendar();
  });

  // 类型筛选
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      // 切换类型时重置分类筛选
      filterParentCat = '';
      filterSubCat = '';
      renderCatFilterBar();
      if (isCalendarView) {
        calSelectedDate = null;
        document.getElementById('calDayDetail').innerHTML = '';
        loadCalendar();
      } else {
        expandedMonths.clear();
        loadBills();
      }
    });
  });

  // 筛选面板切换（打开筛选时自动关闭日历视图）
  document.getElementById('filterToggleBtn').addEventListener('click', () => {
    const section = document.getElementById('filterSection');
    const btn = document.getElementById('filterToggleBtn');
    const isShown = section.style.display !== 'none';

    if (isShown) {
      section.style.display = 'none';
      btn.classList.remove('active');
    } else {
      // 打开筛选：如果当前在日历视图，切回列表
      if (isCalendarView) {
        isCalendarView = false;
        document.getElementById('billsList').style.display = 'block';
        document.getElementById('calendarView').style.display = 'none';
        document.getElementById('viewToggleBtn').classList.remove('active');
        document.getElementById('viewToggleBtn').querySelector('.top-bar-action-icon').textContent = '📅';
        document.getElementById('viewToggleBtn').querySelector('.top-bar-action-text').textContent = '日历';
        calSelectedDate = null;
        document.getElementById('calDayDetail').innerHTML = '';
      }
      section.style.display = 'block';
      btn.classList.add('active');
    }
  });

  // 日期筛选
  document.getElementById('filterStartDate').addEventListener('change', (e) => {
    filterStartDate = e.target.value;
    expandedMonths.clear();
    loadBills();
  });
  document.getElementById('filterEndDate').addEventListener('change', (e) => {
    filterEndDate = e.target.value;
    expandedMonths.clear();
    loadBills();
  });

  // 快捷日期按钮
  document.querySelectorAll('.filter-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const now = new Date();
      const y = now.getFullYear();
      const m = now.getMonth();
      let start, end;
      switch (btn.dataset.range) {
        case 'month':
          start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
          end = `${y}-${String(m + 1).padStart(2, '0')}-${new Date(y, m + 1, 0).getDate()}`;
          break;
        case 'lastmonth':
          const lm = new Date(y, m - 1, 1);
          start = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}-01`;
          end = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, '0')}-${new Date(lm.getFullYear(), lm.getMonth() + 1, 0).getDate()}`;
          break;
        case 'year':
          start = `${y}-01-01`;
          end = `${y}-12-31`;
          break;
        case 'lastyear':
          start = `${y - 1}-01-01`;
          end = `${y - 1}-12-31`;
          break;
      }
      filterStartDate = start;
      filterEndDate = end;
      expandedMonths.clear();
      document.getElementById('filterStartDate').value = start;
      document.getElementById('filterEndDate').value = end;
      loadBills();
    });
  });

  // 重置筛选
  document.getElementById('filterResetBtn').addEventListener('click', () => {
    currentFilter = 'all';
    filterStartDate = '';
    filterEndDate = '';
    filterParentCat = '';
    filterSubCat = '';
    currentYearOffset = 0;
    expandedMonths.clear();
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');
    document.getElementById('filterStartDate').value = '';
    document.getElementById('filterEndDate').value = '';
    renderCatFilterBar();
    loadBills();
  });
}

// 渲染分类筛选药丸（两级：一级分类 + 二级/三级子分类）
function renderCatFilterBar() {
  const bar = document.getElementById('catFilterBar');
  const subBar = document.getElementById('catSubFilterBar');
  if (!bar) return;

  let cats = [];
  if (currentFilter === 'all') {
    cats = state.categories;
  } else {
    cats = state.categories.filter(c => c.type === currentFilter);
  }

  const activeParentId = filterParentCat || null;  // 雪花ID保持字符串

  // 一级分类药丸
  bar.innerHTML = `<button class="cat-filter-pill ${!activeParentId ? 'active' : ''}" data-id="">全部</button>` +
    cats.map(c => `<button class="cat-filter-pill ${c.id === activeParentId ? 'active' : ''}" data-id="${c.id}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');

  // 绑定一级分类点击
  bar.querySelectorAll('.cat-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      filterParentCat = id;
      filterSubCat = '';
      expandedMonths.clear();
      renderCatFilterBar();
      loadBills();
    });
  });

  // 二级/三级分类药丸
  if (!activeParentId || !subBar) {
    if (subBar) subBar.style.display = 'none';
    return;
  }

  const parentCat = cats.find(c => c.id === activeParentId);
  const subCats = parentCat ? (parentCat.children || []) : [];

  if (subCats.length === 0) {
    subBar.style.display = 'none';
    return;
  }

  const activeSubId = filterSubCat || null;  // 雪花ID保持字符串
  subBar.style.display = 'flex';
  subBar.innerHTML = `<button class="cat-filter-pill sub ${!activeSubId ? 'active' : ''}" data-id="">全部</button>` +
    subCats.map(c => `<button class="cat-filter-pill sub ${c.id === activeSubId ? 'active' : ''}" data-id="${c.id}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');

  subBar.querySelectorAll('.cat-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      filterSubCat = btn.dataset.id;
      expandedMonths.clear();
      renderCatFilterBar();
      loadBills();
    });
  });
}

// 删除记录
window.deleteRecord = async (id, event) => {
  if (event) event.stopPropagation();
  if (confirm('确定删除这条记录吗？')) {
    await request(`/records/${id}`, { method: 'DELETE' });
    showToast('已删除');
    await refreshAfterChange();
    await loadAccounts();
  }
};

// 增删改后智能刷新：有筛选条件时全量重载；懒加载模式下只刷新汇总和已加载月份
async function refreshAfterChange() {
  if (filterStartDate || filterEndDate || filterParentCat || filterSubCat) {
    await loadBills();
    return;
  }
  const now = new Date();
  const year = now.getFullYear() + currentYearOffset;

  // 重新加载月度汇总
  let sumUrl = `/records/monthly-summary?book_id=${state.currentBook}&year=${year}`;
  if (currentFilter !== 'all') sumUrl += `&type=${currentFilter}`;
  const summary = await request(sumUrl);
  monthSummary = {};
  summary.forEach(s => {
    monthSummary[s.month] = { income: Number(s.income), expense: Number(s.expense), count: Number(s.count) };
  });

  // 重新加载所有已展开月份的明细
  const monthsToReload = [...expandedMonths];
  loadedMonths = {};
  billRecordsCache = {};
  for (const mk of monthsToReload) {
    const [y, m] = mk.split('-');
    const daysInMonth = new Date(parseInt(y), parseInt(m), 0).getDate();
    let url = `/records?book_id=${state.currentBook}&start_date=${mk}-01&end_date=${mk}-${String(daysInMonth).padStart(2, '0')}`;
    if (currentFilter !== 'all') url += `&type=${currentFilter}`;
    const records = await request(url);
    loadedMonths[mk] = records;
    records.forEach(r => { billRecordsCache[r.id] = r; });
  }

  renderMonthsView();
}

async function loadBills() {
  // 有手动日期/分类筛选时，走全量加载模式（数据量有限）
  if (filterStartDate || filterEndDate || filterParentCat || filterSubCat) {
    await loadBillsFiltered();
    return;
  }

  // 按年模式：先加载月度汇总(极轻量)，再加载当月明细
  await loadBillsByYear();
}

// 有筛选条件时的全量加载（兼容旧逻辑）
async function loadBillsFiltered() {
  const now = new Date();
  const year = now.getFullYear() + currentYearOffset;
  let urlStartDate = filterStartDate || `${year}-01-01`;
  let urlEndDate = filterEndDate || `${year}-12-31`;

  let url = `/records?book_id=${state.currentBook}`;
  if (currentFilter !== 'all') url += `&type=${currentFilter}`;
  url += `&start_date=${urlStartDate}&end_date=${urlEndDate}`;
  if (filterSubCat) {
    url += `&category_id=${filterSubCat}`;
  } else if (filterParentCat) {
    url += `&parent_category_id=${filterParentCat}`;
  }

  const records = await request(url);
  billRecordsCache = {};
  records.forEach(r => { billRecordsCache[r.id] = r; });

  // 将数据塞入 loadedMonths 以便统一渲染
  loadedMonths = {};
  monthSummary = {};
  records.forEach(r => {
    const mk = r.record_date.substring(0, 7);
    if (!loadedMonths[mk]) loadedMonths[mk] = [];
    loadedMonths[mk].push(r);
    if (!monthSummary[mk]) monthSummary[mk] = { income: 0, expense: 0, count: 0 };
    if (r.type === 'income') monthSummary[mk].income += Number(r.amount);
    else if (r.type === 'expense') monthSummary[mk].expense += Number(r.amount);
    monthSummary[mk].count++;
  });

  if (expandedMonths.size === 0) {
    const cmk = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (loadedMonths[cmk]) expandedMonths.add(cmk);
  }

  renderMonthsView();
}

// 按年懒加载：1) 月度汇总  2) 当月明细
async function loadBillsByYear() {
  const now = new Date();
  const year = now.getFullYear() + currentYearOffset;
  expandedMonths.clear();
  loadedMonths = {};
  loadingMonths.clear();
  monthSummary = {};
  billRecordsCache = {};

  const container = document.getElementById('billsList');
  container.innerHTML = renderYearNav(year) + `<div class="empty-state"><div class="emoji">⏳</div><p>加载中...</p></div>`;

  try {
    // 1. 加载全年12月汇总（极轻量，仅聚合数据）
    let sumUrl = `/records/monthly-summary?book_id=${state.currentBook}&year=${year}`;
    if (currentFilter !== 'all') sumUrl += `&type=${currentFilter}`;
    const summary = await request(sumUrl);
    summary.forEach(s => {
      monthSummary[s.month] = { income: Number(s.income), expense: Number(s.expense), count: Number(s.count) };
    });

    // 2. 加载当月明细
    const cmk = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expandedMonths.add(cmk);
    await loadMonthRecords(cmk);

    renderMonthsView();
  } catch (e) {
    container.innerHTML = renderYearNav(year) + `<div class="empty-state"><div class="emoji">😕</div><p>加载失败</p></div>`;
  }
}

// 按需加载单个月的明细
async function loadMonthRecords(monthKey) {
  if (loadedMonths[monthKey] || loadingMonths.has(monthKey)) return;
  loadingMonths.add(monthKey);
  renderMonthsView(); // 显示加载状态

  try {
    const [y, m] = monthKey.split('-');
    const daysInMonth = new Date(parseInt(y), parseInt(m), 0).getDate();
    let url = `/records?book_id=${state.currentBook}&start_date=${monthKey}-01&end_date=${monthKey}-${String(daysInMonth).padStart(2, '0')}`;
    if (currentFilter !== 'all') url += `&type=${currentFilter}`;
    const records = await request(url);

    loadedMonths[monthKey] = records;
    records.forEach(r => { billRecordsCache[r.id] = r; });
  } catch (e) {
    loadedMonths[monthKey] = [];
  }
  loadingMonths.delete(monthKey);
  renderMonthsView();
}

// 渲染年月导航
function renderYearNav(year) {
  return `
    <div class="year-nav">
      <button class="year-nav-btn" onclick="changeYear(-1)">‹</button>
      <span class="year-nav-text">${year}年</span>
      <button class="year-nav-btn" onclick="changeYear(1)">›</button>
    </div>
  `;
}

// 统一渲染月份视图
function renderMonthsView() {
  const container = document.getElementById('billsList');
  const now = new Date();
  const year = now.getFullYear() + currentYearOffset;
  const isFiltered = filterStartDate || filterEndDate || filterParentCat || filterSubCat;

  // 计算全年总收支（来自monthSummary）
  let totalIncome = 0, totalExpense = 0, totalCount = 0;
  Object.values(monthSummary).forEach(m => {
    totalIncome += m.income;
    totalExpense += m.expense;
    totalCount += m.count;
  });

  let html = (!isFiltered ? renderYearNav(year) : '') + `
    <div class="filter-summary">
      <div class="filter-summary-count">共 ${totalCount} 笔记录</div>
      <div class="filter-summary-stats">
        <div class="filter-summary-item">
          <div class="summary-label">收入</div>
          <div class="summary-value summary-income">+${formatMoney(totalIncome)}</div>
        </div>
        <div class="filter-summary-item">
          <div class="summary-label">支出</div>
          <div class="summary-value summary-expense">-${formatMoney(totalExpense)}</div>
        </div>
        <div class="filter-summary-item">
          <div class="summary-label">结余</div>
          <div class="summary-value summary-balance">${formatMoney(totalIncome - totalExpense)}</div>
        </div>
      </div>
    </div>
  `;

  if (totalCount === 0) {
    html += `<div class="empty-state"><div class="emoji">📝</div><p>暂无账单记录</p></div>`;
    container.innerHTML = html;
    return;
  }

  // 12个月倒序渲染
  const months = [];
  for (let m = 12; m >= 1; m--) {
    months.push(`${year}-${String(m).padStart(2, '0')}`);
  }

  months.forEach(monthKey => {
    const ms = monthSummary[monthKey];
    if (!ms || ms.count === 0) return; // 无数据的月不显示

    const monthLabel = `${parseInt(monthKey.split('-')[1])}月`;
    const balance = ms.income - ms.expense;
    const isExpanded = expandedMonths.has(monthKey);
    const isLoading = loadingMonths.has(monthKey);
    const records = loadedMonths[monthKey];

    html += `
      <div class="month-section">
        <div class="month-header ${isExpanded ? 'expanded' : ''}" onclick="toggleMonth('${monthKey}')">
          <span class="month-arrow">${isLoading ? '⏳' : isExpanded ? '▼' : '▶'}</span>
          <span class="month-label">${monthLabel}</span>
          <span class="month-stats">
            <span class="month-stat-item">
              <span class="month-stat-label">收入</span>
              <span class="month-stat-value summary-income">+${formatMoney(ms.income)}</span>
            </span>
            <span class="month-stat-item">
              <span class="month-stat-label">支出</span>
              <span class="month-stat-value summary-expense">-${formatMoney(ms.expense)}</span>
            </span>
            <span class="month-stat-item">
              <span class="month-stat-label">结余</span>
              <span class="month-stat-value summary-balance">${formatMoney(balance)}</span>
            </span>
          </span>
        </div>
    `;

    if (isExpanded) {
      if (isLoading) {
        html += `<div class="month-body" style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px;">加载中...</div>`;
      } else if (records) {
        // 按日期分组
        const dayGroups = {};
        records.forEach(r => {
          if (!dayGroups[r.record_date]) dayGroups[r.record_date] = [];
          dayGroups[r.record_date].push(r);
        });
        const sortedDays = Object.keys(dayGroups).sort((a, b) => b.localeCompare(a));

        html += `<div class="month-body">`;
        sortedDays.forEach(dateStr => {
          const dayRecords = dayGroups[dateStr];
          const dayIncome = dayRecords.filter(r => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0);
          const dayExpense = dayRecords.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0);
          const d = new Date(dateStr);
          const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
          const dateLabel = `${d.getMonth() + 1}月${d.getDate()}日 ${weekDays[d.getDay()]}`;

          html += `
            <div class="record-day">
              <div class="record-day-header">
                <span>${dateLabel}</span>
                <span>
                  ${dayIncome > 0 ? `收入 ${formatMoney(dayIncome)} ` : ''}
                  ${dayExpense > 0 ? `支出 ${formatMoney(dayExpense)}` : ''}
                </span>
              </div>
              ${dayRecords.map(r => {
                const cat = getCategoryById(r.category_id);
                const timeStr = r.record_time ? r.record_time.substring(0, 5) : '';
                const parentName = r.parent_category_name ? `${esc(r.parent_category_icon || '')} ${esc(r.parent_category_name)} · ` : '';
                const safeColor = /^#[0-9a-fA-F]{6}$/.test(cat.color) ? cat.color : '#64748b';
                return `
                  <div class="record-item" onclick="editRecord(billRecordsCache['${r.id}'])">
                    <div class="record-icon" style="background: ${safeColor}20;">${esc(cat.icon)}</div>
                    <div class="record-info">
                      <div class="record-title">
                        ${esc(cat.name)}
                        ${timeStr ? `<span class="record-time">${esc(timeStr)}</span>` : ''}
                      </div>
                      <div class="record-note">
                        ${parentName}${esc(r.account_name || '')}${r.note ? ' · ' + esc(r.note) : ''}
                      </div>
                    </div>
                    <div class="record-amount-wrap">
                      <div class="record-amount ${esc(r.type)}">
                        ${r.type === 'income' ? '+' : r.type === 'expense' ? '-' : ''}${formatMoney(r.amount)}
                      </div>
                      <button class="record-delete-btn" onclick="deleteRecord('${r.id}', event)">✕</button>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        });
        html += `</div>`;
      }
    }

    html += `</div>`;
  });

  container.innerHTML = html;
}

// 切换月份展开/收起（懒加载）
window.toggleMonth = function(monthKey) {
  if (expandedMonths.has(monthKey)) {
    expandedMonths.delete(monthKey);
    renderMonthsView();
  } else {
    expandedMonths.add(monthKey);
    // 如果该月数据未加载，先加载
    if (!loadedMonths[monthKey] && !loadingMonths.has(monthKey)) {
      loadMonthRecords(monthKey);
    } else {
      renderMonthsView();
    }
  }
};

// 切换年份
window.changeYear = function(offset) {
  currentYearOffset += offset;
  expandedMonths.clear();
  loadBills();
};

// ===== 日历视图 =====
async function loadCalendar() {
  const monthStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}`;
  document.getElementById('calMonthText').textContent = `${calYear}年${calMonth + 1}月`;

  let url = `/records/calendar?book_id=${state.currentBook}&month=${monthStr}`;
  if (currentFilter !== 'all') url += `&type=${currentFilter}`;

  calData = {};
  try {
    const data = await request(url);
    data.forEach(d => {
      calData[d.record_date] = {
        income: Number(d.income) || 0,
        expense: Number(d.expense) || 0,
        count: d.count
      };
    });
  } catch (e) {}

  renderCalendar();
}

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 计算当月第一天是星期几 和 当月天数
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

  let html = weekDays.map(w => `<div class="calendar-weekday">${w}</div>`).join('');

  // 上月末尾的填充
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    html += `<div class="calendar-day other-month">${day}</div>`;
  }

  // 当月日期
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayData = calData[dateStr];
    const isToday = dateStr === todayStr;
    const isSelected = dateStr === calSelectedDate;

    let classes = 'calendar-day';
    if (isToday) classes += ' today';
    if (isSelected) classes += ' selected';

    html += `<div class="${classes}" data-date="${dateStr}">
      <span>${d}</span>
      ${dayData ? `
        ${dayData.expense > 0 ? `<span class="day-expense">${dayData.expense >= 10000 ? (dayData.expense / 10000).toFixed(1) + '万' : dayData.expense.toFixed(0)}</span>` : ''}
        ${dayData.income > 0 ? `<span class="day-income">${dayData.income >= 10000 ? (dayData.income / 10000).toFixed(1) + '万' : dayData.income.toFixed(0)}</span>` : ''}
      ` : ''}
    </div>`;
  }

  // 下月开头的填充 (补齐6行42格)
  const totalCells = firstDay + daysInMonth;
  const remaining = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  const extraRows = Math.max(0, 6 * 7 - (totalCells + remaining));
  for (let i = 1; i <= remaining + extraRows; i++) {
    html += `<div class="calendar-day other-month">${i}</div>`;
  }

  grid.innerHTML = html;

  // 绑定日期点击
  grid.querySelectorAll('.calendar-day[data-date]').forEach(cell => {
    cell.addEventListener('click', () => {
      calSelectedDate = cell.dataset.date;
      renderCalendar();
      showDayDetail(calSelectedDate);
    });
  });
}

async function showDayDetail(dateStr) {
  const detail = document.getElementById('calDayDetail');
  const records = await request(`/records?book_id=${state.currentBook}&start_date=${dateStr}&end_date=${dateStr}${currentFilter !== 'all' ? '&type=' + currentFilter : ''}`);
  records.forEach(r => { billRecordsCache[r.id] = r; });

  if (records.length === 0) {
    detail.innerHTML = `
      <div style="background:var(--card);border-radius:var(--radius);padding:24px 20px;text-align:center;color:var(--text-muted);box-shadow:var(--shadow);">
        <div style="font-size:13px;margin-bottom:12px;">${dateStr} 无记录</div>
        <button onclick="openAddModal('${dateStr}')" style="background:var(--primary);color:#fff;border:none;border-radius:20px;padding:8px 24px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(59,130,246,0.3);">+ 记一笔</button>
      </div>`;
    return;
  }

  const dayIncome = records.filter(r => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0);
  const dayExpense = records.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0);

  detail.innerHTML = `
    <div style="background:var(--card);border-radius:var(--radius);padding:12px 16px;margin-bottom:8px;box-shadow:var(--shadow);display:flex;justify-content:space-between;align-items:center;font-size:13px;">
      <span style="font-weight:600;">${dateStr}</span>
      <div style="display:flex;align-items:center;gap:10px;">
        <span>
          ${dayIncome > 0 ? `<span style="color:var(--success);">收入 ${formatMoney(dayIncome)}</span> ` : ''}
          ${dayExpense > 0 ? `<span style="color:var(--danger);">支出 ${formatMoney(dayExpense)}</span>` : ''}
        </span>
        <button onclick="openAddModal('${dateStr}')" style="background:var(--primary);color:#fff;border:none;border-radius:14px;width:28px;height:28px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0;">+</button>
      </div>
    </div>
    <div style="background:var(--card);border-radius:var(--radius);box-shadow:var(--shadow);overflow:hidden;">
      ${records.map(r => {
        const cat = getCategoryById(r.category_id);
        const safeColor = /^#[0-9a-fA-F]{6}$/.test(cat.color) ? cat.color : '#64748b';
        return `
          <div class="record-item" onclick="editRecord(billRecordsCache['${r.id}'])" style="padding:12px 16px;border-bottom:1px solid var(--border);">
            <div class="record-icon" style="background:${safeColor}20;">${esc(cat.icon)}</div>
            <div class="record-info">
              <div class="record-title">${esc(cat.name)}</div>
              <div class="record-note">${esc(r.account_name || '')}${r.note ? ' · ' + esc(r.note) : ''}</div>
            </div>
            <div class="record-amount-wrap">
              <div class="record-amount ${esc(r.type)}">
                ${r.type === 'income' ? '+' : r.type === 'expense' ? '-' : ''}${formatMoney(r.amount)}
              </div>
              <button class="record-delete-btn" onclick="deleteRecord('${r.id}', event)">✕</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ===== AI快捷记账 =====
window.aiQuickParse = async function() {
  const input = document.getElementById('aiQuickInput');
  const resultEl = document.getElementById('aiQuickResult');
  const btn = document.getElementById('aiQuickBtn');
  const text = input.value.trim();
  if (!text) { showToast('请输入记账内容'); return; }

  btn.disabled = true;
  btn.textContent = '解析中...';
  resultEl.style.display = 'none';

  try {
    const data = await request('/ai/parse', {
      method: 'POST',
      body: JSON.stringify({ text, book_id: state.currentBook })
    });
    const p = data.parsed;
    resultEl.style.display = 'block';
    const typeLabels = { expense: '支出', income: '收入', transfer: '转账' };
    resultEl.innerHTML = `
      <div class="ai-quick-ok">
        <div class="ai-quick-info">
          <span class="ai-quick-type ${esc(p.type)}">${typeLabels[p.type] || ''}</span>
          <span class="ai-quick-amount">¥${Number(p.amount).toFixed(2)}</span>
          <span>${esc(p.category_icon)} ${esc(p.category_name)}</span>
          <span style="color:var(--text-muted);font-size:12px;">${esc(p.account_icon)} ${esc(p.account_name)} · ${esc(p.record_date)}${p.note ? ' · ' + esc(p.note) : ''}</span>
        </div>
        <div class="ai-quick-actions">
          <button class="ai-quick-save" onclick='aiQuickSave(${JSON.stringify(p).replace(/'/g,"&#39;")})'>✓ 直接保存</button>
          <button class="ai-quick-edit" onclick='aiQuickEdit(${JSON.stringify(p).replace(/'/g,"&#39;")})'>✎ 修改后保存</button>
          <button class="ai-quick-cancel" onclick="document.getElementById('aiQuickResult').style.display='none'">✕</button>
        </div>
      </div>
    `;
  } catch (e) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="ai-quick-err">😕 ${e.message || '解析失败'}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '记一笔';
  }
};

// AI直接保存
window.aiQuickSave = async function(p) {
  try {
    await request('/records', {
      method: 'POST',
      body: JSON.stringify({
        book_id: state.currentBook,
        type: p.type,
        category_id: p.category_id,
        amount: p.amount,
        account_id: p.account_id,
        to_account_id: p.to_account_id || null,
        note: p.note || '',
        record_date: p.record_date
      })
    });
    document.getElementById('aiQuickResult').style.display = 'none';
    document.getElementById('aiQuickInput').value = '';
    showToast('记账成功 🎉');
    await pageRefresh();
  } catch (e) {
    showToast('保存失败：' + (e.message || ''));
  }
};

// AI打开编辑弹窗
window.aiQuickEdit = async function(p) {
  document.getElementById('aiQuickResult').style.display = 'none';
  document.getElementById('aiQuickInput').value = '';
  // 复用common.js中的openAddModal并填充（applyParsedResult在common.js中定义）
  await openAddModal();
  applyParsedResult(p);
};

// OCR小票识别
window.aiOcrRecognize = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';

  const resultEl = document.getElementById('aiQuickResult');
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div class="ai-quick-loading">📷 正在识别小票...</div>';

  try {
    // 转base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const data = await request('/ai/ocr', {
      method: 'POST',
      body: JSON.stringify({ image_base64: base64, book_id: state.currentBook })
    });
    const p = data.parsed;
    const typeLabels = { expense: '支出', income: '收入' };
    resultEl.innerHTML = `
      <div class="ai-quick-ok">
        <div class="ai-quick-info">
          <span class="ai-quick-type ${esc(p.type)}">${typeLabels[p.type] || '支出'}</span>
          <span class="ai-quick-amount">¥${Number(p.amount).toFixed(2)}</span>
          <span>${esc(p.category_icon)} ${esc(p.category_name)}</span>
          <span style="color:var(--text-muted);font-size:12px;">${esc(p.account_icon)} ${esc(p.account_name)} · ${esc(p.record_date)}${p.note ? ' · ' + esc(p.note) : ''}</span>
        </div>
        <div class="ai-quick-actions">
          <button class="ai-quick-save" onclick='aiQuickSave(${JSON.stringify(p).replace(/'/g,"&#39;")})'>✓ 保存</button>
          <button class="ai-quick-edit" onclick='aiQuickEdit(${JSON.stringify(p).replace(/'/g,"&#39;")})'>✎ 修改</button>
          <button class="ai-quick-cancel" onclick="document.getElementById('aiQuickResult').style.display='none'">✕</button>
        </div>
      </div>
    `;
  } catch (e) {
    resultEl.innerHTML = `<div class="ai-quick-err">😕 ${e.message || '识别失败'}</div>`;
  }
};

// 语音识别后自动解析并保存（跳过确认卡片）
async function aiQuickVoiceAutoSave(text) {
  const resultEl = document.getElementById('aiQuickResult');
  resultEl.style.display = 'block';
  resultEl.innerHTML = '<div class="ai-quick-loading">🤖 AI解析中：' + esc(text) + '</div>';

  try {
    const data = await request('/ai/parse', {
      method: 'POST',
      body: JSON.stringify({ text, book_id: state.currentBook })
    });
    const p = data.parsed;

    // 直接保存
    await request('/records', {
      method: 'POST',
      body: JSON.stringify({
        book_id: state.currentBook,
        type: p.type,
        category_id: p.category_id,
        amount: p.amount,
        account_id: p.account_id,
        to_account_id: p.to_account_id || null,
        note: p.note || '',
        record_date: p.record_date
      })
    });

    resultEl.style.display = 'none';
    document.getElementById('aiQuickInput').value = '';
    const typeLabels = { expense: '支出', income: '收入', transfer: '转账' };
    showToast(`${typeLabels[p.type]} ¥${p.amount.toFixed(2)} 记账成功 🎉`);
    await pageRefresh();
  } catch (e) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="ai-quick-err">😕 ${e.message || '解析失败，请点击输入框手动修改后保存'}</div>`;
  }
}

// ===== AI快捷栏语音记账 =====
let quickRecognition = null;
let quickVoiceTimer = null;
let quickVoiceSaved = false; // 防止重复保存

window.aiQuickVoice = function() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
    showToast(isHttp ? '语音识别需要HTTPS环境，请使用Chrome并通过HTTPS访问' : '您的浏览器不支持语音识别，请使用Chrome浏览器');
    return;
  }
  const btn = document.getElementById('aiQuickVoiceBtn');

  if (!quickRecognition) {
    quickRecognition = new SpeechRecognition();
    quickRecognition.lang = 'zh-CN';
    quickRecognition.continuous = false;
    quickRecognition.interimResults = true;
    quickRecognition.maxAlternatives = 1;

    function resetBtn() {
      btn.style.background = '';
      btn.style.color = '';
      btn.textContent = '🎤';
      if (quickVoiceTimer) { clearTimeout(quickVoiceTimer); quickVoiceTimer = null; }
    }

    quickRecognition.onstart = () => {
      btn.style.background = '#ef4444';
      btn.style.color = 'white';
      btn.textContent = '🔴';
      quickVoiceSaved = false;
      document.getElementById('aiQuickInput').value = '';
      // 8秒超时保护
      quickVoiceTimer = setTimeout(() => {
        try { quickRecognition.stop(); } catch (e) {}
      }, 8000);
    };

    // 拿到最终识别结果时直接触发保存（不等onend，更可靠）
    quickRecognition.onresult = (e) => {
      let finalText = '';
      let interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }
      // 实时显示
      const display = (finalText + interimText).trim();
      document.getElementById('aiQuickInput').value = display;

      // 有最终结果且还没保存过，立即停止录音并保存
      if (finalText.trim() && !quickVoiceSaved) {
        quickVoiceSaved = true;
        const text = finalText.trim();
        document.getElementById('aiQuickInput').value = text;
        try { quickRecognition.stop(); } catch (e) {}
        clearTimeout(quickVoiceTimer);
        resetBtn();
        aiQuickVoiceAutoSave(text);
      }
    };

    // onend兜底（onresult没触发final时）
    quickRecognition.onend = () => {
      clearTimeout(quickVoiceTimer);
      resetBtn();
      if (!quickVoiceSaved) {
        const text = (document.getElementById('aiQuickInput').value || '').trim();
        if (text) {
          quickVoiceSaved = true;
          aiQuickVoiceAutoSave(text);
        } else {
          showToast('未识别到语音，请靠近麦克风再试');
        }
      }
    };

    quickRecognition.onerror = (e) => {
      clearTimeout(quickVoiceTimer);
      resetBtn();
      if (e.error === 'aborted') return;
      const msgs = {
        'no-speech': '没听到声音，请靠近麦克风重试',
        'not-allowed': '请允许麦克风权限',
        'service-not-allowed': '语音服务被禁用，请检查浏览器设置',
        'network': '网络异常（语音识别需访问Google/Azure服务，可能需要翻墙）',
        'audio-capture': '未检测到麦克风设备'
      };
      showToast(msgs[e.error] || '识别失败：' + e.error);
    };
  }

  clearTimeout(quickVoiceTimer);
  quickVoiceSaved = false;
  document.getElementById('aiQuickInput').value = '';
  document.getElementById('aiQuickResult').style.display = 'none';
  try {
    quickRecognition.start();
  } catch (err) {
    // 已在识别中，先停止再重启
    try { quickRecognition.stop(); } catch (e) {}
  }
};

// ===== AI 餐饮健康建议（聊天模式） =====
let _dietMessages = []; // 当前会话消息历史 {role, content}
let _dietAnalysisCtx = null; // 初始分析上下文（数据摘要）
let _dietSessionId = null; // 当前会话ID（用于更新历史）
let _dietStart = ''; // 饮食分析专属日期范围（独立于账单筛选）
let _dietEnd = '';

function dietInitDates() {
  if (!_dietStart) {
    const now = new Date();
    _dietStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    _dietEnd = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${lastDay}`;
  }
}

window.dietSetRange = function(range) {
  const now = new Date();
  let s, e;
  if (range === 'month') {
    s = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
    const ld = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
    e = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${ld}`;
  } else if (range === 'lastmonth') {
    const lm = new Date(now.getFullYear(), now.getMonth(), 0);
    const lmo = lm.getMonth() + 1;
    s = `${lm.getFullYear()}-${String(lmo).padStart(2,'0')}-01`;
    e = `${lm.getFullYear()}-${String(lmo).padStart(2,'0')}-${lm.getDate()}`;
  } else if (range === 'year') {
    s = `${now.getFullYear()}-01-01`;
    e = `${now.getFullYear()}-12-31`;
  }
  _dietStart = s;
  _dietEnd = e;
  const si = document.getElementById('dietStartInput');
  const ei = document.getElementById('dietEndInput');
  if (si) si.value = s;
  if (ei) ei.value = e;
};

window.dietInputChange = function() {
  const si = document.getElementById('dietStartInput');
  const ei = document.getElementById('dietEndInput');
  if (si && si.value) _dietStart = si.value;
  if (ei && ei.value) _dietEnd = ei.value;
};

window.openDietAnalysis = function() {
  let modal = document.getElementById('dietModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'dietModal';
    modal.className = 'modal show';
    modal.innerHTML = `
      <div class="modal-content diet-modal-content">
        <div class="modal-header">
          <button class="modal-close" onclick="document.getElementById('dietModal').classList.remove('show')">✕</button>
          <span class="modal-title">🥗 AI健康饮食顾问</span>
          <span style="width:32px;"></span>
        </div>
        <div class="diet-tab-bar">
          <button class="diet-tab-btn active" data-tab="chat" onclick="dietSwitchTab('chat')">对话</button>
          <button class="diet-tab-btn" data-tab="history" onclick="dietSwitchTab('history')">历史记录</button>
        </div>
        <div id="dietChatPane" class="diet-chat-pane">
          <div class="diet-chat-msgs" id="dietChatMsgs"></div>
          <div class="diet-chat-bar">
            <input type="text" id="dietChatInput" class="diet-chat-input" placeholder="继续提问，如：多吃蔬菜有什么好处？" maxlength="200">
            <button class="diet-chat-send" id="dietChatSend" onclick="dietSendMsg()">发送</button>
          </div>
        </div>
        <div id="dietHistoryPane" class="diet-history-pane" style="display:none;"></div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });
    modal.querySelector('#dietChatInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dietSendMsg(); }
    });
    document.body.appendChild(modal);
  } else {
    modal.classList.add('show');
  }
  dietSwitchTab('chat');
};

window.dietSwitchTab = function(tab) {
  document.querySelectorAll('.diet-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('dietChatPane').style.display = tab === 'chat' ? 'flex' : 'none';
  document.getElementById('dietHistoryPane').style.display = tab === 'history' ? 'block' : 'none';
  if (tab === 'chat' && _dietMessages.length === 0) dietRenderWelcome();
  if (tab === 'history') dietLoadHistory();
};

// 渲染聊天初始欢迎界面（未开始分析时）
function dietRenderWelcome() {
  dietInitDates();
  const msgsEl = document.getElementById('dietChatMsgs');
  msgsEl.innerHTML = `
    <div class="diet-welcome">
      <div class="diet-welcome-icon">🥗</div>
      <div class="diet-welcome-title">AI健康饮食顾问</div>
      <div class="diet-welcome-desc">我会根据你的餐饮消费记录分析饮食结构，给出个性化健康建议。</div>
      <div class="diet-range-bar">
        <button class="diet-range-btn" onclick="dietSetRange('month')">本月</button>
        <button class="diet-range-btn" onclick="dietSetRange('lastmonth')">上月</button>
        <button class="diet-range-btn" onclick="dietSetRange('year')">本年</button>
      </div>
      <div class="diet-range-inputs">
        <input type="date" id="dietStartInput" value="${_dietStart}" onchange="dietInputChange()">
        <span class="diet-range-sep">~</span>
        <input type="date" id="dietEndInput" value="${_dietEnd}" onchange="dietInputChange()">
      </div>
      <button class="diet-start-btn" onclick="dietStartAnalysis()">开始分析</button>
    </div>
  `;
}

// 开始分析（用户主动触发）
window.dietStartAnalysis = async function() {
  dietInitDates();
  const start = _dietStart;
  const end = _dietEnd;
  const label = start.slice(0, 7) === end.slice(0, 7)
    ? `${start.slice(0,4)}年${parseInt(start.slice(5,7))}月`
    : `${start} ~ ${end}`;

  _dietMessages = [];
  _dietAnalysisCtx = null;
  _dietSessionId = null;

  const msgsEl = document.getElementById('dietChatMsgs');
  msgsEl.innerHTML = '';
  dietAppendBubble('ai', '🤖 正在分析你的餐饮数据，请稍候...', true);

  try {
    const data = await request('/ai/diet', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook, start_date: start, end_date: end, period_label: label })
    });

    // 保存分析上下文供追问使用
    _dietAnalysisCtx = `【餐饮分析范围】${label}，共${data.record_count}笔，总支出¥${Number(data.total_expense).toFixed(2)}`;
    _dietMessages.push({ role: 'assistant', content: data.analysis });
    if (data.session_id) _dietSessionId = data.session_id;

    // 替换loading气泡
    msgsEl.querySelector('.diet-bubble-loading')?.remove();
    dietAppendBubble('ai', data.analysis);
    dietAppendBubble('system', `📅 ${label} · 🍽️ ${data.record_count}笔 · 💰 ¥${Number(data.total_expense).toFixed(2)} · 已保存到历史`);
    dietScrollBottom();

    // 激活输入框
    document.getElementById('dietChatInput').disabled = false;
    document.getElementById('dietChatSend').disabled = false;
  } catch (e) {
    msgsEl.querySelector('.diet-bubble-loading')?.remove();
    dietAppendBubble('ai', `😕 ${e.message || '分析失败，请检查AI配置'}`);
    dietScrollBottom();
  }
};

// 发送追问
window.dietSendMsg = async function() {
  const input = document.getElementById('dietChatInput');
  const sendBtn = document.getElementById('dietChatSend');
  const text = input.value.trim();
  if (!text) return;
  if (!_dietAnalysisCtx) { dietAppendBubble('ai', '请先点击「开始分析」生成饮食分析，再进行提问。'); dietScrollBottom(); return; }

  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;

  dietAppendBubble('user', text);
  dietAppendBubble('ai', '🤖 思考中...', true);
  dietScrollBottom();

  _dietMessages.push({ role: 'user', content: text });

  // 构建消息历史（带上下文）
  const contextMsg = { role: 'user', content: `背景信息：${_dietAnalysisCtx}\n\n用户问题：${text}` };
  const sendMessages = _dietMessages.length <= 2
    ? [contextMsg]
    : [..._dietMessages.slice(-6), { role: 'user', content: text }];

  try {
    const data = await request('/ai/diet-chat', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook, messages: sendMessages, session_id: _dietSessionId || undefined })
    });
    _dietMessages.push({ role: 'assistant', content: data.reply });
    document.querySelector('#dietChatMsgs .diet-bubble-loading')?.remove();
    dietAppendBubble('ai', data.reply);
  } catch (e) {
    document.querySelector('#dietChatMsgs .diet-bubble-loading')?.remove();
    dietAppendBubble('ai', `😕 ${e.message || '回复失败，请重试'}`);
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
    dietScrollBottom();
  }
};

function dietAppendBubble(role, text, isLoading) {
  const msgsEl = document.getElementById('dietChatMsgs');
  const div = document.createElement('div');
  if (role === 'user') {
    div.className = 'diet-bubble diet-bubble-user';
    div.textContent = text;
  } else if (role === 'system') {
    div.className = 'diet-bubble-system';
    div.innerHTML = esc(text);
  } else {
    div.className = isLoading ? 'diet-bubble diet-bubble-ai diet-bubble-loading' : 'diet-bubble diet-bubble-ai';
    div.innerHTML = esc(text).replace(/\n/g, '<br>');
  }
  msgsEl.appendChild(div);
}

function dietScrollBottom() {
  const msgsEl = document.getElementById('dietChatMsgs');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function dietLoadHistory() {
  const pane = document.getElementById('dietHistoryPane');
  pane.innerHTML = '<div class="diet-loading">⏳ 加载历史记录...</div>';
  try {
    const data = await request(`/ai/history?book_id=${state.currentBook}&period_type=diet&page_size=20`);
    if (!data.list || data.list.length === 0) {
      pane.innerHTML = '<div style="text-align:center;padding:32px 0;color:var(--text-muted);font-size:14px;">暂无历史记录</div>';
      return;
    }
    pane.innerHTML = data.list.map(item => {
      const title = item.session_title || item.period_label || '';
      const date = item.created_at ? item.created_at.slice(0, 10) : '';
      return `
        <div class="diet-history-item" data-id="${item.id}">
          <div class="diet-history-header" onclick="dietToggleHistory('${item.id}')">
            <div class="diet-history-label-wrap">
              <span class="diet-history-label">${esc(title)}</span>
              <span class="diet-history-time">${date}</span>
            </div>
            <span class="diet-history-chevron">›</span>
          </div>
          <div class="diet-history-stat">💰 餐饮支出 ¥${Number(item.total_expense).toFixed(2)}</div>
          <div class="diet-history-body" id="dietHistBody_${item.id}" style="display:none;"></div>
        </div>`;
    }).join('');
  } catch (e) {
    pane.innerHTML = `<div class="diet-error">😕 ${esc(e.message || '加载失败')}</div>`;
  }
}

window.dietToggleHistory = async function(id) {
  const bodyEl = document.getElementById(`dietHistBody_${id}`);
  if (!bodyEl) return;
  const isOpen = bodyEl.style.display !== 'none';
  // 折叠
  if (isOpen) {
    bodyEl.style.display = 'none';
    const item = bodyEl.closest('.diet-history-item');
    item?.querySelector('.diet-history-chevron')?.classList.remove('open');
    return;
  }
  // 展开
  bodyEl.style.display = 'block';
  const item = bodyEl.closest('.diet-history-item');
  item?.querySelector('.diet-history-chevron')?.classList.add('open');
  if (bodyEl.dataset.loaded) return;
  bodyEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">加载中...</div>';
  try {
    const record = await request(`/ai/history/${id}`);
    // 解析 messages_json，渲染成聊天气泡
    let msgs = [];
    try { msgs = JSON.parse(record.messages_json || '[]'); } catch(e) {}
    if (!msgs.length) {
      // 兼容旧记录：只有 analysis_text
      msgs = [{ role: 'assistant', content: record.analysis_text }];
    }
    const bubblesHtml = msgs.map(m => {
      if (m.role === 'user') {
        return `<div class="diet-bubble diet-bubble-user diet-hist-bubble">${esc(m.content)}</div>`;
      }
      return `<div class="diet-bubble diet-bubble-ai diet-hist-bubble">${esc(m.content).replace(/\n/g,'<br>')}</div>`;
    }).join('');
    bodyEl.innerHTML = `
      <div class="diet-hist-chat">${bubblesHtml}</div>
      <button class="diet-continue-btn" onclick="dietContinueFromHistory('${id}')">💬 继续对话</button>
    `;
    bodyEl.dataset.loaded = '1';
  } catch (e) {
    bodyEl.innerHTML = `<div style="color:var(--danger);font-size:13px;">加载失败</div>`;
  }
};

window.dietContinueFromHistory = async function(id) {
  try {
    const record = await request(`/ai/history/${id}`);
    let msgs = [];
    try { msgs = JSON.parse(record.messages_json || '[]'); } catch(e) {}
    if (!msgs.length) msgs = [{ role: 'assistant', content: record.analysis_text }];

    // 切换到对话面板
    dietSwitchTab('chat');
    const msgsEl = document.getElementById('dietChatMsgs');
    msgsEl.innerHTML = '';

    // 恢复会话状态
    _dietSessionId = id;
    _dietMessages = msgs.slice();
    const label = record.period_label || '';
    _dietAnalysisCtx = `【餐饮分析范围】${label}，总支出¥${Number(record.total_expense).toFixed(2)}`;

    // 渲染历史气泡
    dietAppendBubble('system', `↩️ 继续历史对话：${record.session_title || label}`);
    msgs.forEach(m => dietAppendBubble(m.role === 'user' ? 'user' : 'ai', m.content));
    dietScrollBottom();

    // 激活输入框
    document.getElementById('dietChatInput').disabled = false;
    document.getElementById('dietChatSend').disabled = false;
    document.getElementById('dietChatInput').focus();
  } catch(e) {
    showToast('加载对话失败：' + (e.message || ''));
  }
};
