/**
 * PC端报表页逻辑（完全独立，不依赖 reports.js）
 * 依赖：/js/common.js, /pc/js/pc-common.js
 */

let currentPieType = 'expense';
let reportMode = 'week';
let weekStart = getMonday(new Date());
let quarterYear = new Date().getFullYear();
let quarterNum = Math.floor(new Date().getMonth() / 3) + 1;
let reportYear = new Date().getFullYear();

let lastCategoryExpense = [];
let lastCategoryIncome = [];
let lastTotalExpense = 0;
let lastTotalIncome = 0;
let currentTrendData = [];
let currentCompareData = [];

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

async function pageInit() {
  renderPCTopbar('数据报表');
  refreshPCNoticeBadge();
  document.getElementById('currentPeriodText').textContent = formatPeriod();
  bindEvents();
  await loadReports();
  if (reportMode === 'month') {
    loadAnomaly();
    loadPrediction();
  }
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderAllCharts(), 200);
  });
}

async function pageRefresh() {
  await loadReports();
}

function formatPeriod() {
  if (reportMode === 'week') {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    const m1 = weekStart.getMonth() + 1;
    const d1 = weekStart.getDate();
    const m2 = end.getMonth() + 1;
    const d2 = end.getDate();
    if (m1 === m2) return `${weekStart.getFullYear()}年${m1}月${d1}日-${d2}日`;
    return `${weekStart.getFullYear()}年${m1}月${d1}日-${m2}月${d2}日`;
  }
  if (reportMode === 'month') {
    return `${state.currentMonth.slice(0, 4)}年${parseInt(state.currentMonth.slice(5))}月`;
  }
  if (reportMode === 'quarter') {
    return `${quarterYear}年 Q${quarterNum}`;
  }
  return `${reportYear}年`;
}

function getDateRange() {
  if (reportMode === 'week') {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    return { start: fmt(weekStart), end: fmt(end) };
  }
  if (reportMode === 'month') {
    const [y, m] = state.currentMonth.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return {
      start: `${y}-${String(m).padStart(2, '0')}-01`,
      end: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      month: state.currentMonth
    };
  }
  if (reportMode === 'quarter') {
    const startMonth = (quarterNum - 1) * 3;
    const startDate = new Date(quarterYear, startMonth, 1);
    const endDate = new Date(quarterYear, startMonth + 3, 0);
    return { start: fmt(startDate), end: fmt(endDate) };
  }
  return { start: `${reportYear}-01-01`, end: `${reportYear}-12-31` };
}

function navigatePeriod(dir) {
  if (reportMode === 'week') {
    weekStart.setDate(weekStart.getDate() + dir * 7);
  } else if (reportMode === 'month') {
    const d = new Date(state.currentMonth + '-01');
    d.setMonth(d.getMonth() + dir);
    state.currentMonth = d.toISOString().slice(0, 7);
  } else if (reportMode === 'quarter') {
    quarterNum += dir;
    if (quarterNum > 4) { quarterNum = 1; quarterYear++; }
    if (quarterNum < 1) { quarterNum = 4; quarterYear--; }
  } else {
    reportYear += dir;
  }
}

function bindEvents() {
  document.getElementById('prevPeriod').addEventListener('click', () => {
    navigatePeriod(-1);
    document.getElementById('currentPeriodText').textContent = formatPeriod();
    loadReports();
  });
  document.getElementById('nextPeriod').addEventListener('click', () => {
    navigatePeriod(1);
    document.getElementById('currentPeriodText').textContent = formatPeriod();
    loadReports();
  });

  document.querySelectorAll('.reports-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.reports-mode-btn').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      reportMode = btn.dataset.mode;
      document.getElementById('currentPeriodText').textContent = formatPeriod();
      const insightsRow = document.querySelector('.ai-insights-row');
      const budgetCard = document.getElementById('budgetCard');
      if (reportMode === 'month') {
        insightsRow.style.display = '';
        loadAnomaly();
        loadPrediction();
      } else {
        document.getElementById('anomalyCard').style.display = 'none';
        document.getElementById('predictCard').style.display = 'none';
        insightsRow.style.display = 'none';
        budgetCard.style.display = 'none';
        document.getElementById('aiBudgetBtn').style.display = '';
      }
      loadReports();
    });
  });

  document.querySelectorAll('.tab-item').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-item').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPieType = tab.dataset.type;
      updatePieAndRank();
    });
  });

  document.getElementById('aiAnalyzeBtn').addEventListener('click', runAIAnalysis);
  document.getElementById('aiHistoryBtn').addEventListener('click', openAIHistory);
}

async function runAIAnalysis() {
  const range = getDateRange();
  const modal = document.getElementById('aiResultModal');
  const analyzing = document.getElementById('aiAnalyzing');
  const result = document.getElementById('aiResult');

  modal.classList.add('show');
  analyzing.style.display = 'block';
  result.style.display = 'none';

  try {
    const data = await request('/ai/analyze', {
      method: 'POST',
      body: JSON.stringify({
        book_id: state.currentBook,
        start_date: range.start,
        end_date: range.end,
        period_label: formatPeriod(),
        period_type: reportMode
      })
    });

    analyzing.style.display = 'none';
    result.style.display = 'block';
    result.innerHTML = `
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">
        📅 ${data.data_summary.period} · 收入${formatMoney(data.data_summary.total_income)} · 支出${formatMoney(data.data_summary.total_expense)}
      </div>
      <div class="ai-analysis-content">${formatAIContent(data.analysis)}</div>
    `;
  } catch (e) {
    analyzing.style.display = 'none';
    result.style.display = 'block';
    result.innerHTML = `
      <div style="text-align:center;padding:20px 0;">
        <div style="font-size:36px;margin-bottom:10px;">😕</div>
        <div style="color:var(--danger);font-size:14px;margin-bottom:8px;">分析失败</div>
        <div style="color:var(--text-secondary);font-size:12px;">${e.message || '请检查AI配置是否正确'}</div>
        <div style="margin-top:14px;font-size:12px;color:var(--primary);cursor:pointer;" onclick="document.getElementById('aiResultModal').classList.remove('show');location.href='/pc/profile.html'">前往设置 →</div>
      </div>
    `;
  }
}

function formatAIContent(text) {
  return text.split('\n').filter(line => line.trim()).map(line => {
    const trimmed = line.trim();
    if (/^[📊⚠️💡🎯1-4一二三四]/.test(trimmed) || /^\d+[.、]/.test(trimmed)) {
      return `<p style="font-weight:600;margin:12px 0 6px;color:var(--text-primary);font-size:14px;">${esc(trimmed)}</p>`;
    }
    return `<p style="margin:4px 0;line-height:1.7;color:var(--text-secondary);font-size:13px;">${esc(trimmed)}</p>`;
  }).join('');
}

async function openAIHistory() {
  const modal = document.getElementById('aiHistoryModal');
  const listEl = document.getElementById('aiHistoryList');
  modal.classList.add('show');
  listEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中...</div>';

  try {
    const data = await request(`/ai/history?book_id=${state.currentBook}&page_size=30`);
    const list = (data.list || []).filter(item => item.period_type !== 'diet');
    if (list.length === 0) {
      listEl.innerHTML = `
        <div style="text-align:center;padding:30px 0;">
          <div style="font-size:40px;margin-bottom:10px;">📭</div>
          <div style="color:var(--text-secondary);font-size:14px;">暂无历史分析记录</div>
          <div style="color:var(--text-muted);font-size:12px;margin-top:6px;">点击"AI智能分析"按钮生成分析后会自动保存</div>
        </div>
      `;
      return;
    }

    const typeLabels = { week: '周报', month: '月报', quarter: '季报', year: '年报' };
    listEl.innerHTML = list.map(item => {
      const income = Number(item.total_income) || 0;
      const expense = Number(item.total_expense) || 0;
      const bal = Number(item.balance) || 0;
      const date = new Date(item.created_at);
      const dateStr = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      return `
        <div class="ai-history-item" onclick="viewAIHistoryDetail('${item.id}')">
          <div class="ai-history-left">
            <div class="ai-history-type">${typeLabels[item.period_type] || '分析'}</div>
            <div class="ai-history-period">${item.period_label}</div>
            <div class="ai-history-date">${dateStr}</div>
          </div>
          <div class="ai-history-right">
            <div class="ai-history-nums">
              <span class="ai-history-income">收${formatMoney(income)}</span>
              <span class="ai-history-expense">支${formatMoney(expense)}</span>
            </div>
            <div class="ai-history-balance ${bal >= 0 ? 'positive' : 'negative'}">
              结余${formatMoney(bal)}
            </div>
          </div>
          <div class="ai-history-arrow">›</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger);">加载失败：${e.message || '未知错误'}</div>`;
  }
}

async function viewAIHistoryDetail(id) {
  const modal = document.getElementById('aiHistoryDetailModal');
  const titleEl = document.getElementById('aiHistoryDetailTitle');
  const contentEl = document.getElementById('aiHistoryDetailContent');

  document.getElementById('aiHistoryModal').classList.remove('show');
  modal.classList.add('show');
  contentEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-secondary);">加载中...</div>';

  try {
    const item = await request(`/ai/history/${id}`);
    const income = Number(item.total_income) || 0;
    const expense = Number(item.total_expense) || 0;
    const bal = Number(item.balance) || 0;
    const typeLabels = { week: '周报', month: '月报', quarter: '季报', year: '年报' };

    titleEl.textContent = `📋 ${typeLabels[item.period_type] || '分析'} - ${item.period_label}`;
    contentEl.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
        <span>📅 ${item.start_date} ~ ${item.end_date}</span>
        <button class="ai-history-delete-btn" onclick="deleteAIHistory('${item.id}')">删除</button>
      </div>
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:14px;padding:10px;background:var(--bg-secondary);border-radius:8px;">
        收入${formatMoney(income)} · 支出${formatMoney(expense)} · 结余<span style="color:${bal >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:600;">${formatMoney(bal)}</span>
      </div>
      <div class="ai-analysis-content">${formatAIContent(item.analysis_text)}</div>
    `;
  } catch (e) {
    contentEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--danger);">加载失败：${e.message || '未知错误'}</div>`;
  }
}

window.deleteAIHistory = async function(id) {
  if (!await showConfirm({ title: '删除记录', message: '确定要删除这条分析记录吗？', okText: '删除', variant: 'danger' })) return;
  try {
    await request(`/ai/history/${id}`, { method: 'DELETE' });
    document.getElementById('aiHistoryDetailModal').classList.remove('show');
    showToast('已删除');
    openAIHistory();
  } catch (e) {
    showToast('删除失败：' + (e.message || ''));
  }
};

async function loadAnomaly() {
  const card = document.getElementById('anomalyCard');
  const content = document.getElementById('anomalyContent');
  try {
    const data = await request('/ai/anomaly', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook })
    });
    if (data.has_anomaly) {
      card.style.display = 'block';
      let html = '';
      if (data.anomalies && data.anomalies.length > 0) {
        html += `<div style="font-size:12px;color:var(--danger);margin-bottom:6px;">📈 分类异常增长：</div>`;
        html += data.anomalies.map(a => `<div style="font-size:13px;color:var(--text-primary);padding:2px 0;">• ${esc(a)}</div>`).join('');
      }
      if (data.big_days && data.big_days.length > 0) {
        html += `<div style="font-size:12px;color:var(--warning);margin-top:8px;margin-bottom:4px;">💰 大额支出日：</div>`;
        html += data.big_days.map(d => `<div style="font-size:13px;color:var(--text-primary);padding:2px 0;">• ${esc(d)}</div>`).join('');
      }
      content.innerHTML = html;
    }
  } catch(e) { /* 静默失败 */ }
}

async function loadPrediction() {
  const card = document.getElementById('predictCard');
  const content = document.getElementById('predictContent');
  try {
    const data = await request('/ai/predict', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook })
    });
    card.style.display = 'block';
    const balColor = data.predicted_balance >= 0 ? 'var(--success)' : 'var(--danger)';
    content.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
        <span style="font-size:12px;color:var(--text-muted);">已过${data.days_passed}/${data.days_in_month}天，剩余${data.days_remaining}天</span>
      </div>
      <div style="font-size:13px;margin-bottom:8px;line-height:1.6;">
        已支出 <b style="color:var(--danger);">${formatMoney(data.current_expense)}</b> ·
        预计月底支出 <b>${formatMoney(data.predicted_expense)}</b><br>
        预计月底结余 <b style="color:${balColor};font-size:15px;">${formatMoney(data.predicted_balance)}</b>
      </div>
      ${data.ai_comment ? `<div style="font-size:12px;color:var(--text-secondary);background:var(--bg-secondary);padding:8px 10px;border-radius:8px;">💬 ${esc(data.ai_comment)}</div>` : ''}
    `;
  } catch(e) { /* 静默失败 */ }
}

window.loadBudgetRecommend = async function() {
  const card = document.getElementById('budgetCard');
  const content = document.getElementById('budgetContent');
  const btn = document.getElementById('aiBudgetBtn');

  card.style.display = 'block';
  btn.disabled = true;
  btn.textContent = '💡 生成中...';
  content.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px;">AI正在计算推荐预算...</div>';

  try {
    const data = await request('/ai/budget-recommend', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook })
    });
    content.innerHTML = `
      <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;">
        基于过去3个月消费数据，推荐下月总预算：
        <b style="color:var(--primary);font-size:16px;">${formatMoney(data.total_budget)}</b>
      </div>
      ${(data.categories || []).map(c => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
          <div style="flex:1;font-size:13px;color:var(--text-primary);">${esc(c.name)}</div>
          <div style="font-weight:700;font-size:14px;color:var(--primary);">${formatMoney(c.budget)}</div>
          <div style="font-size:11px;color:var(--text-muted);max-width:100px;text-align:right;">${esc(c.suggestion || '')}</div>
        </div>
      `).join('')}
    `;
    btn.style.display = 'none';
  } catch(e) {
    content.innerHTML = `<div style="text-align:center;padding:16px;color:var(--danger);font-size:13px;">生成失败：${e.message || ''}</div>`;
    btn.disabled = false;
    btn.textContent = '💡 重试';
  }
};

async function loadReports() {
  const range = getDateRange();
  let url = `/reports/summary?book_id=${state.currentBook}&start_date=${range.start}&end_date=${range.end}`;
  if (range.month) url += `&month=${range.month}`;
  const data = await request(url);

  const income = Number(data.summary.total_income) || 0;
  const expense = Number(data.summary.total_expense) || 0;
  document.getElementById('sumIncome').textContent = formatMoney(income);
  document.getElementById('sumExpense').textContent = formatMoney(expense);
  document.getElementById('sumBalance').textContent = formatMoney(income - expense);

  lastCategoryExpense = data.categoryExpense || [];
  lastCategoryIncome = data.categoryIncome || [];
  lastTotalExpense = expense;
  lastTotalIncome = income;

  updatePieAndRank();

  const records = await request(`/records?book_id=${state.currentBook}&start_date=${range.start}&end_date=${range.end}`);
  currentTrendData = buildTrendData(records, range);
  currentCompareData = await buildCompareData();

  renderAccountStats(data.accountStats || []);
  renderAllCharts();
}

function buildTrendData(records, range) {
  if (reportMode === 'week') {
    const days = ['一', '二', '三', '四', '五', '六', '日'];
    const result = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      const key = fmt(d);
      result.push({ label: days[i], key, income: 0, expense: 0 });
    }
    records.forEach(r => {
      const item = result.find(x => x.key === r.record_date);
      if (item) {
        if (r.type === 'income') item.income += Number(r.amount);
        else if (r.type === 'expense') item.expense += Number(r.amount);
      }
    });
    document.getElementById('trendChartTitle').textContent = '本周每日收支';
    return result;
  }
  if (reportMode === 'month') {
    const [y, m] = state.currentMonth.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const result = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      result.push({ label: d, key, income: 0, expense: 0 });
    }
    records.forEach(r => {
      const item = result.find(x => x.key === r.record_date);
      if (item) {
        if (r.type === 'income') item.income += Number(r.amount);
        else if (r.type === 'expense') item.expense += Number(r.amount);
      }
    });
    document.getElementById('trendChartTitle').textContent = '本月每日收支趋势';
    return result;
  }
  if (reportMode === 'quarter') {
    const startMonth = (quarterNum - 1) * 3;
    const result = [];
    for (let i = 0; i < 3; i++) {
      const m = startMonth + i;
      const label = `${m + 1}月`;
      result.push({ label, key: `${quarterYear}-${String(m + 1).padStart(2, '0')}`, income: 0, expense: 0 });
    }
    records.forEach(r => {
      const monthKey = r.record_date.slice(0, 7);
      const item = result.find(x => x.key === monthKey);
      if (item) {
        if (r.type === 'income') item.income += Number(r.amount);
        else if (r.type === 'expense') item.expense += Number(r.amount);
      }
    });
    document.getElementById('trendChartTitle').textContent = '本季度月度收支';
    return result;
  }
  const result = [];
  for (let m = 1; m <= 12; m++) {
    result.push({ label: `${m}月`, key: `${reportYear}-${String(m).padStart(2, '0')}`, income: 0, expense: 0 });
  }
  records.forEach(r => {
    const monthKey = r.record_date.slice(0, 7);
    const item = result.find(x => x.key === monthKey);
    if (item) {
      if (r.type === 'income') item.income += Number(r.amount);
      else if (r.type === 'expense') item.expense += Number(r.amount);
    }
  });
  document.getElementById('trendChartTitle').textContent = '本年度月度收支';
  return result;
}

async function buildCompareData() {
  if (reportMode === 'month') {
    const year = parseInt(state.currentMonth.slice(0, 4));
    const records = await request(`/records?book_id=${state.currentBook}&start_date=${year}-01-01&end_date=${year}-12-31`);
    const result = [];
    for (let m = 1; m <= 12; m++) {
      result.push({ label: `${m}月`, key: `${year}-${String(m).padStart(2, '0')}`, income: 0, expense: 0 });
    }
    records.forEach(r => {
      const item = result.find(x => x.key === r.record_date.slice(0, 7));
      if (item) {
        if (r.type === 'income') item.income += Number(r.amount);
        else if (r.type === 'expense') item.expense += Number(r.amount);
      }
    });
    document.getElementById('compareCard').style.display = '';
    document.getElementById('compareChartTitle').textContent = `${year}年月度对比`;
    return result;
  }
  if (reportMode === 'quarter') {
    const result = [];
    for (let q = 1; q <= 4; q++) {
      const sm = (q - 1) * 3;
      const sd = fmt(new Date(quarterYear, sm, 1));
      const ed = fmt(new Date(quarterYear, sm + 3, 0));
      result.push({ label: `Q${q}`, key: q, income: 0, expense: 0, start: sd, end: ed });
    }
    const promises = result.map(item =>
      request(`/reports/summary?book_id=${state.currentBook}&start_date=${item.start}&end_date=${item.end}`)
    );
    const datas = await Promise.all(promises);
    datas.forEach((d, i) => {
      result[i].income = Number(d.summary.total_income) || 0;
      result[i].expense = Number(d.summary.total_expense) || 0;
    });
    document.getElementById('compareCard').style.display = '';
    document.getElementById('compareChartTitle').textContent = `${quarterYear}年季度对比`;
    return result;
  }
  document.getElementById('compareCard').style.display = 'none';
  return [];
}

function renderAllCharts() {
  if (reportMode === 'week') {
    renderBarChart('trendChart', currentTrendData, { barLabel: (d) => d.label });
  } else if (reportMode === 'month') {
    renderLineChart('trendChart', currentTrendData);
    renderBarChart('monthlyChart', currentCompareData, { barLabel: (d) => d.label });
  } else if (reportMode === 'quarter') {
    renderBarChart('trendChart', currentTrendData, { barLabel: (d) => d.label });
    renderBarChart('monthlyChart', currentCompareData, { barLabel: (d) => d.label });
  } else {
    renderBarChart('trendChart', currentTrendData, { barLabel: (d) => d.label });
  }
}

function updatePieAndRank() {
  if (currentPieType === 'expense') {
    renderPieChart(lastCategoryExpense, lastTotalExpense, '总支出');
    renderCategoryRank(lastCategoryExpense, lastTotalExpense, '支出排行');
  } else {
    renderPieChart(lastCategoryIncome, lastTotalIncome, '总收入');
    renderCategoryRank(lastCategoryIncome, lastTotalIncome, '收入排行');
  }
}

function renderPieChart(categoryData, total, label) {
  const pieChart = document.getElementById('pieChart');
  document.getElementById('pieLabel').textContent = label;
  document.getElementById('pieTotal').textContent = formatMoney(total);

  if (categoryData.length === 0 || total === 0) {
    pieChart.style.background = 'var(--border)';
    document.getElementById('pieLegend').innerHTML =
      '<div style="color:var(--text-muted); font-size:13px;">暂无数据</div>';
    return;
  }

  const parentMap = {};
  categoryData.forEach(c => {
    let topId, topName, topIcon, topColor;
    if (c.grandparent_id) {
      topId = c.grandparent_id; topName = c.grandparent_name; topIcon = c.grandparent_icon; topColor = c.grandparent_color;
    } else if (c.parent_id) {
      topId = c.parent_id; topName = c.parent_name; topIcon = c.parent_icon; topColor = c.color;
    } else {
      topId = c.id; topName = c.name; topIcon = c.icon; topColor = c.color;
    }
    if (!parentMap[topId]) {
      parentMap[topId] = { id: topId, name: topName, icon: topIcon, color: topColor, total: 0 };
    }
    parentMap[topId].total += Number(c.total);
  });
  const parentList = Object.values(parentMap).sort((a, b) => b.total - a.total);

  let gradient = [];
  let currentAngle = 0;
  parentList.forEach(c => {
    const percent = (c.total / total) * 100;
    gradient.push(`${c.color} ${currentAngle}deg ${currentAngle + percent * 3.6}deg`);
    currentAngle += percent * 3.6;
  });
  pieChart.style.background = `conic-gradient(${gradient.join(',')})`;

  document.getElementById('pieLegend').innerHTML = parentList.slice(0, 6).map(c => `
    <div class="legend-item">
      <div class="legend-dot" style="background:${c.color}"></div>
      <div class="legend-label">${c.icon} ${c.name}</div>
      <div class="legend-value">${((c.total / total) * 100).toFixed(0)}%</div>
    </div>
  `).join('');
}

function renderCategoryRank(categoryData, total, title) {
  document.getElementById('rankTitle').textContent = title;
  const container = document.getElementById('categoryRank');

  if (categoryData.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无数据</div>';
    return;
  }

  const parentMap = {};
  categoryData.forEach(c => {
    let topId, topName, topIcon, topColor;
    if (c.grandparent_id) {
      topId = c.grandparent_id; topName = c.grandparent_name; topIcon = c.grandparent_icon; topColor = c.grandparent_color;
    } else if (c.parent_id) {
      topId = c.parent_id; topName = c.parent_name; topIcon = c.parent_icon; topColor = c.color;
    } else {
      topId = c.id; topName = c.name; topIcon = c.icon; topColor = c.color;
    }
    if (!parentMap[topId]) {
      parentMap[topId] = { id: topId, name: topName, icon: topIcon, color: topColor, total: 0 };
    }
    parentMap[topId].total += Number(c.total);
  });
  const sorted = Object.values(parentMap).sort((a, b) => b.total - a.total);
  const maxVal = sorted[0].total || 1;

  container.innerHTML = sorted.slice(0, 10).map((c, i) => {
    const pct = (c.total / maxVal) * 100;
    const isTop3 = i < 3;
    return `
      <div class="rank-item">
        <div class="rank-index ${isTop3 ? 'top3' : ''}">${i + 1}</div>
        <div class="rank-bar-wrap">
          <div class="rank-bar-name">
            <span>${c.icon} ${c.name}</span>
            <span style="color:${c.color};">${formatMoney(c.total)}</span>
          </div>
          <div class="rank-bar">
            <div class="rank-bar-fill" style="width:${pct}%;background:${c.color};"></div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function getCanvasCtx(canvasId) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return null;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  return {
    ctx, width: rect.width, height: rect.height,
    padding: { top: 14, right: 14, bottom: 28, left: 48 },
    chartW: rect.width - 62, chartH: rect.height - 42
  };
}

function drawGrid(c, niceMax) {
  const { ctx, width, padding, chartW, chartH } = c;
  const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#64748b';
  const borderColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e2e8f0';

  ctx.strokeStyle = borderColor;
  ctx.fillStyle = textColor;
  ctx.lineWidth = 1;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const yy = padding.top + chartH * i / 4;
    const val = niceMax - (niceMax * i / 4);
    ctx.beginPath();
    ctx.moveTo(padding.left, yy);
    ctx.lineTo(width - padding.right, yy);
    ctx.stroke();
    const label = val >= 10000 ? (val / 10000).toFixed(1) + 'w' : val.toFixed(0);
    ctx.fillText(label, padding.left - 8, yy);
  }
}

function formatAxisValue(val) {
  return val >= 10000 ? (val / 10000).toFixed(1) + 'w' : Math.round(val).toString();
}

function renderLineChart(canvasId, data) {
  const c = getCanvasCtx(canvasId);
  if (!c) return;
  const { ctx, width, height, padding, chartW, chartH } = c;
  ctx.clearRect(0, 0, width, height);

  const maxVal = Math.max(...data.map(d => Math.max(d.income, d.expense)), 100);
  const niceMax = Math.ceil(maxVal / 100) * 100 || 100;
  drawGrid(c, niceMax);

  const n = data.length;
  const stepX = chartW / (n - 1 || 1);
  const labelInterval = n > 15 ? Math.ceil(n / 6) : 2;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#64748b';
  data.forEach((d, i) => {
    if (d.label % labelInterval === 0 || d.label === 1 || d.label === n) {
      ctx.fillText(d.label, padding.left + i * stepX, height - 18);
    }
  });

  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top + chartH);
  data.forEach((d, i) => {
    const x = padding.left + i * stepX;
    const y2 = padding.top + chartH - (d.expense / niceMax) * chartH;
    ctx.lineTo(x, y2);
  });
  ctx.lineTo(padding.left + chartW, padding.top + chartH);
  ctx.closePath();
  const gradE = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartH);
  gradE.addColorStop(0, 'rgba(239,68,68,0.15)');
  gradE.addColorStop(1, 'rgba(239,68,68,0.01)');
  ctx.fillStyle = gradE;
  ctx.fill();

  ctx.beginPath();
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  data.forEach((d, i) => {
    const x = padding.left + i * stepX;
    const y2 = padding.top + chartH - (d.expense / niceMax) * chartH;
    i === 0 ? ctx.moveTo(x, y2) : ctx.lineTo(x, y2);
  });
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = '#10b981'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  data.forEach((d, i) => {
    const x = padding.left + i * stepX;
    const y2 = padding.top + chartH - (d.income / niceMax) * chartH;
    i === 0 ? ctx.moveTo(x, y2) : ctx.lineTo(x, y2);
  });
  ctx.stroke();
}

function renderBarChart(canvasId, data, opts = {}) {
  const c = getCanvasCtx(canvasId);
  if (!c) return;
  const { ctx, width, height, padding, chartW, chartH } = c;
  ctx.clearRect(0, 0, width, height);

  const maxVal = Math.max(...data.map(d => Math.max(d.income, d.expense)), 100);
  const step = data.length <= 4 ? 100 : data.length <= 7 ? 100 : 1000;
  const niceMax = Math.ceil(maxVal / step) * step || step;
  drawGrid(c, niceMax);

  const n = data.length;
  const barGroupW = chartW / n;
  const barW = Math.min(Math.max(barGroupW * 0.3, 6), n <= 4 ? 24 : 14);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#64748b';
  data.forEach((d, i) => {
    const cx = padding.left + i * barGroupW + barGroupW / 2;
    const label = opts.barLabel ? opts.barLabel(d) : d.label;
    ctx.fillText(label, cx, height - 18);

    const incomeH = (d.income / niceMax) * chartH;
    const expenseH = (d.expense / niceMax) * chartH;

    ctx.fillStyle = '#10b981';
    const ix = cx - barW - 1;
    roundRect(ctx, ix, padding.top + chartH - incomeH, barW, incomeH, 3);
    ctx.fill();

    ctx.fillStyle = '#ef4444';
    const ex = cx + 1;
    roundRect(ctx, ex, padding.top + chartH - expenseH, barW, expenseH, 3);
    ctx.fill();
  });
}

function roundRect(ctx, x, y, w, h, r) {
  if (h < r * 2) r = h / 2;
  if (h <= 0) { ctx.rect(x, y, w, 0); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function renderAccountStats(accountStats) {
  const container = document.getElementById('accountStats');
  if (!accountStats || accountStats.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无数据</div>';
    return;
  }

  container.innerHTML = accountStats.map(a => {
    const expense = Number(a.expense) || 0;
    const income = Number(a.income) || 0;
    return `
      <div class="account-stat-row">
        <div class="account-stat-icon">${a.icon}</div>
        <div class="account-stat-info">
          <div class="account-stat-name">${a.name}</div>
          <div class="account-stat-values">
            ${income > 0 ? `<span class="stat-income">收${formatMoney(income)}</span>` : ''}
            ${expense > 0 ? `<span class="stat-expense">支${formatMoney(expense)}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}
