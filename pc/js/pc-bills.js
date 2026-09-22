/**
 * PC端账单页逻辑
 * bills.js 已先加载，共享其 aiParseText / openAddModal 等函数
 * 本文件覆写 pageInit / pageRefresh，并新增 PC 专用渲染
 */

let pcBillsFilter = { type: 'all', start: '', end: '', catId: '' };
let pcIsCalendar = false;
let pcBillsData = [];
let pcBillsCache = {};

// 覆盖 bills.js 的 pageInit（bills.js 的 pageInit 不在此文件定义，直接定义即可）
async function pageInit() {
  renderPCTopbar('账单记录');
  refreshPCNoticeBadge();
  initMonthNav();
  populateCatFilter();
  await loadPCBills();
}

async function pageRefresh() {
  await loadPCBills();
}

function initMonthNav() {
  const label = document.getElementById('currentMonthLabel');
  const m = state.currentMonth;
  label.textContent = `${m.slice(0,4)}年${parseInt(m.slice(5))}月`;

  document.getElementById('prevMonth').addEventListener('click', () => {
    const d = new Date(state.currentMonth + '-01');
    d.setMonth(d.getMonth() - 1);
    state.currentMonth = d.toISOString().slice(0, 7);
    state._pcCalSelected = null;
    const nm = state.currentMonth;
    document.getElementById('currentMonthLabel').textContent = `${nm.slice(0,4)}年${parseInt(nm.slice(5))}月`;
    const det = document.getElementById('calDayDetail');
    if (det) det.innerHTML = '';
    loadPCBills();
  });
  document.getElementById('nextMonth').addEventListener('click', () => {
    const d = new Date(state.currentMonth + '-01');
    d.setMonth(d.getMonth() + 1);
    state.currentMonth = d.toISOString().slice(0, 7);
    state._pcCalSelected = null;
    const nm = state.currentMonth;
    document.getElementById('currentMonthLabel').textContent = `${nm.slice(0,4)}年${parseInt(nm.slice(5))}月`;
    const det = document.getElementById('calDayDetail');
    if (det) det.innerHTML = '';
    loadPCBills();
  });
}

function populateCatFilter() {
  const sel = document.getElementById('filterCat');
  if (!sel) return;
  sel.innerHTML = '<option value="">全部分类</option>' +
    state.categories.flatMap(c => [c, ...(c.children || [])]).map(c =>
      `<option value="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</option>`
    ).join('');
}

window.setTypeFilter = function(type) {
  pcBillsFilter.type = type;
  document.querySelectorAll('[data-type]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
    btn.style.background = btn.dataset.type === type ? 'var(--primary)' : '';
    btn.style.color = btn.dataset.type === type ? '#fff' : '';
    btn.style.borderColor = btn.dataset.type === type ? 'var(--primary)' : '';
  });
};

window.applyPCFilter = function() {
  pcBillsFilter.start = document.getElementById('filterStart').value;
  pcBillsFilter.end   = document.getElementById('filterEnd').value;
  pcBillsFilter.catId = document.getElementById('filterCat').value;
  loadPCBills();
};

window.resetPCFilter = function() {
  pcBillsFilter = { type: 'all', start: '', end: '', catId: '' };
  document.getElementById('filterStart').value = '';
  document.getElementById('filterEnd').value = '';
  document.getElementById('filterCat').value = '';
  setTypeFilter('all');
  loadPCBills();
};

window.togglePCView = function() {
  pcIsCalendar = !pcIsCalendar;
  document.getElementById('calendarView').style.display = pcIsCalendar ? 'block' : 'none';
  document.getElementById('listView').style.display    = pcIsCalendar ? 'none'  : 'block';
  document.getElementById('viewToggleBtn').textContent = pcIsCalendar ? '📋 切换列表视图' : '📅 切换日历视图';
  if (pcIsCalendar) renderPCCalendar();
};

async function loadPCBills() {
  const [y, m] = state.currentMonth.split('-');
  const lastDay = new Date(y, m, 0).getDate();
  const start = pcBillsFilter.start || `${state.currentMonth}-01`;
  const end   = pcBillsFilter.end   || `${state.currentMonth}-${String(lastDay).padStart(2,'0')}`;

  let url = `/records?book_id=${state.currentBook}&start_date=${start}&end_date=${end}`;
  if (pcBillsFilter.type !== 'all') url += `&type=${pcBillsFilter.type}`;
  if (pcBillsFilter.catId) url += `&category_id=${pcBillsFilter.catId}`;

  const records = await request(url);
  pcBillsData = records;
  pcBillsCache = {};
  records.forEach(r => { pcBillsCache[r.id] = r; });

  // 月度汇总
  const income  = records.filter(r => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0);
  const expense = records.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0);
  document.getElementById('monthIncome').textContent  = formatMoney(income);
  document.getElementById('monthExpense').textContent = formatMoney(expense);

  if (pcIsCalendar) renderPCCalendar();
  else renderPCBillsList(records);
}

function renderPCBillsList(records) {
  const container = document.getElementById('billsList');
  if (!records || records.length === 0) {
    container.innerHTML = `
      <div class="pc-card">
        <div class="pc-empty"><div class="pc-empty-icon">📭</div><div class="pc-empty-text">暂无记录</div></div>
      </div>`;
    return;
  }

  // 按日期分组
  const groups = {};
  records.forEach(r => {
    const d = r.record_date;
    if (!groups[d]) groups[d] = [];
    groups[d].push(r);
  });
  const sortedDates = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  container.innerHTML = sortedDates.map(date => {
    const dayRecs = groups[date];
    const dayExp = dayRecs.filter(r => r.type === 'expense').reduce((s, r) => s + Number(r.amount), 0);
    const dayInc = dayRecs.filter(r => r.type === 'income').reduce((s, r) => s + Number(r.amount), 0);
    let dateLabel;
    if (date === today) dateLabel = '今天';
    else if (date === yesterday) dateLabel = '昨天';
    else { const d = new Date(date); dateLabel = `${d.getMonth()+1}月${d.getDate()}日`; }

    const items = dayRecs.map(r => {
      const cat = getCategoryById(r.category_id);
      const safeColor = /^#[0-9a-fA-F]{6}$/.test(cat.color) ? cat.color : '#64748b';
      const sign = r.type === 'income' ? '+' : r.type === 'transfer' ? '' : '-';
      const noteParts = [];
      if (r.account_name) noteParts.push(r.account_name);
      if (r.note) noteParts.push(r.note);
      return `
        <div class="pc-bill-item" onclick="editRecord(pcBillsCache['${esc(r.id)}'])">
          <div class="pc-bill-icon" style="background:${safeColor}20;">${esc(cat.icon)}</div>
          <div class="pc-bill-info">
            <div class="pc-bill-title">${esc(cat.name)}</div>
            ${noteParts.length ? `<div class="pc-bill-note">${esc(noteParts.join(' · '))}</div>` : ''}
          </div>
          <div class="pc-bill-amount ${esc(r.type)}">${sign}${formatMoney(r.amount)}</div>
        </div>`;
    }).join('');

    return `
      <div class="pc-card" style="margin-bottom:8px;padding:0;overflow:hidden;">
        <div style="display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg);">
          <span style="font-size:13px;font-weight:600;color:var(--text);flex:1;">${dateLabel}</span>
          ${dayExp > 0 ? `<span style="font-size:12px;color:var(--danger);margin-right:10px;">支出 ${formatMoney(dayExp)}</span>` : ''}
          ${dayInc > 0 ? `<span style="font-size:12px;color:var(--success);">收入 ${formatMoney(dayInc)}</span>` : ''}
        </div>
        ${items}
      </div>`;
  }).join('');
}

function renderPCCalendar() {
  const [y, m] = state.currentMonth.split('-');
  const year = parseInt(y), month = parseInt(m);
  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const dayData = {};
  pcBillsData.forEach(r => {
    const d = r.record_date.slice(8, 10);
    if (!dayData[d]) dayData[d] = { exp: 0, inc: 0 };
    if (r.type === 'expense') dayData[d].exp += Number(r.amount);
    if (r.type === 'income')  dayData[d].inc += Number(r.amount);
  });

  const today = new Date().toISOString().slice(0, 10);
  const weekDays = ['日','一','二','三','四','五','六'];
  let html = weekDays.map((d, i) =>
    `<div class="pc-calendar-header${(i === 0 || i === 6) ? ' weekend' : ''}">${d}</div>`
  ).join('');

  // 前置占位
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="pc-calendar-day other-month"></div>';
  }

  const fmtAmt = (v) => {
    v = Math.abs(v);
    if (v >= 10000) return (v / 10000).toFixed(1) + 'w';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(Math.round(v));
  };

  for (let d = 1; d <= daysInMonth; d++) {
    const ds = String(d).padStart(2, '0');
    const fullDate = `${y}-${String(month).padStart(2,'0')}-${ds}`;
    const data = dayData[ds];
    const isToday = fullDate === today;
    const dow = new Date(year, month - 1, d).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const hasData = data && (data.exp > 0 || data.inc > 0);
    const cls = [
      'pc-calendar-day',
      isToday ? 'today' : '',
      isWeekend ? 'weekend' : '',
      state._pcCalSelected === fullDate ? 'selected' : ''
    ].filter(Boolean).join(' ');

    html += `
      <div class="${cls}" onclick="showCalDayDetail('${fullDate}')">
        <div class="pc-calendar-date">${d}</div>
        ${hasData ? '<div class="pc-calendar-dot"></div>' : ''}
        <div class="pc-calendar-amounts">
          ${data && data.exp > 0 ? `<div class="pc-calendar-amount expense">-${fmtAmt(data.exp)}</div>` : ''}
          ${data && data.inc > 0 ? `<div class="pc-calendar-amount income">+${fmtAmt(data.inc)}</div>` : ''}
        </div>
      </div>`;
  }

  // 尾部补齐到完整行
  const totalCells = firstDay + daysInMonth;
  const trailing = (7 - totalCells % 7) % 7;
  for (let i = 0; i < trailing; i++) {
    html += '<div class="pc-calendar-day other-month"></div>';
  }

  document.getElementById('pcCalendar').innerHTML = html;

  // 默认选中今天（若在当前显示月份内），否则选中第一个有数据的日期
  let defaultDate = null;
  if (today.slice(0, 7) === state.currentMonth) {
    defaultDate = today;
  } else {
    const firstWithData = Object.keys(dayData).sort()[0];
    if (firstWithData) defaultDate = `${y}-${String(month).padStart(2,'0')}-${firstWithData}`;
  }
  if (defaultDate) {
    showCalDayDetail(defaultDate);
  } else {
    document.getElementById('calDayDetail').innerHTML = '';
  }
}

window.showCalDayDetail = function(date) {
  state._pcCalSelected = date;
  document.querySelectorAll('.pc-calendar-day').forEach(el => el.classList.remove('selected'));
  const activeEl = document.querySelector(`.pc-calendar-day[onclick*="${date}"]`);
  if (activeEl) activeEl.classList.add('selected');

  const recs = pcBillsData.filter(r => r.record_date === date);
  const container = document.getElementById('calDayDetail');
  if (!recs.length) { container.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:16px;font-size:13px;">该日无记录</div>'; return; }
  const d = new Date(date);
  container.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:8px;">${d.getMonth()+1}月${d.getDate()}日</div>
    ${recs.map(r => {
      const cat = getCategoryById(r.category_id);
      const safeColor = /^#[0-9a-fA-F]{6}$/.test(cat.color) ? cat.color : '#64748b';
      const sign = r.type === 'income' ? '+' : r.type === 'transfer' ? '' : '-';
      return `
        <div class="pc-bill-item" onclick="editRecord(pcBillsCache['${esc(r.id)}'])">
          <div class="pc-bill-icon" style="background:${safeColor}20;">${esc(cat.icon)}</div>
          <div class="pc-bill-info">
            <div class="pc-bill-title">${esc(cat.name)}</div>
            ${r.note ? `<div class="pc-bill-note">${esc(r.note)}</div>` : ''}
          </div>
          <div class="pc-bill-amount ${esc(r.type)}">${sign}${formatMoney(r.amount)}</div>
        </div>`;
    }).join('')}`;
};
