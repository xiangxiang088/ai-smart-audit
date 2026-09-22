/**
 * 首页逻辑
 */

// 页面初始化 - 由common.js调用
async function pageInit() {
  bindEvents();
  await loadHomeData();
}

// 页面刷新 - 记账成功后调用
async function pageRefresh() {
  await loadHomeData();
}

// 绑定事件
function bindEvents() {
  // 月份切换
  document.getElementById('prevMonth').addEventListener('click', () => {
    const d = new Date(state.currentMonth + '-01');
    d.setMonth(d.getMonth() - 1);
    state.currentMonth = d.toISOString().slice(0, 7);
    loadHomeData();
  });

  document.getElementById('nextMonth').addEventListener('click', () => {
    const d = new Date(state.currentMonth + '-01');
    d.setMonth(d.getMonth() + 1);
    state.currentMonth = d.toISOString().slice(0, 7);
    loadHomeData();
  });

  // 预算设置
  document.getElementById('budgetSetBtn').addEventListener('click', () => {
    const input = document.getElementById('budgetAmountInput');
    input.value = state._monthlyBudget ? state._monthlyBudget.amount : '';
    document.getElementById('budgetModal').classList.add('show');
  });

  // 点击遮罩关闭预算弹窗
  document.getElementById('budgetModal').addEventListener('click', (e) => {
    if (e.target.id === 'budgetModal') {
      closeBudgetModal();
    }
  });
}

window.closeBudgetModal = function() {
  document.getElementById('budgetModal').classList.remove('show');
};

window.saveBudget = async function() {
  const amount = parseFloat(document.getElementById('budgetAmountInput').value);
  if (!amount || amount <= 0) {
    return showToast('请输入有效金额');
  }
  await request('/budgets', {
    method: 'POST',
    body: JSON.stringify({
      book_id: state.currentBook,
      category_id: null,
      month: state.currentMonth,
      amount
    })
  });
  showToast('预算保存成功');
  closeBudgetModal();
  loadHomeData();
};

// 加载首页数据
async function loadHomeData() {
  const month = state.currentMonth;
  document.getElementById('currentMonth').textContent =
    `${month.slice(0, 4)}年${parseInt(month.slice(5))}月`;

  // 获取月度报表
  const data = await request(`/reports/summary?book_id=${state.currentBook}&month=${month}`);
  const s = data.summary;

  const income = Number(s.total_income) || 0;
  const expense = Number(s.total_expense) || 0;
  document.getElementById('homeIncome').textContent = formatMoney(income);
  document.getElementById('homeExpense').textContent = formatMoney(expense);
  document.getElementById('monthBalance').textContent = formatMoney(income - expense);
  document.getElementById('monthCount').textContent =
    (Number(s.income_count) + Number(s.expense_count)) + '笔';

  // 今日支出
  const today = new Date().toISOString().slice(0, 10);
  const todayRecords = await request(
    `/records?book_id=${state.currentBook}&start_date=${today}&end_date=${today}`
  );
  const todayExpense = todayRecords
    .filter(r => r.type === 'expense')
    .reduce((sum, r) => sum + Number(r.amount), 0);
  document.getElementById('todayExpense').textContent = formatMoney(todayExpense);

  // 分类排行
  renderCategoryRank(data.categoryExpense, expense);

  // 预算
  renderBudgets(data.budgets, expense);

  // 最近记录（计算当月最后一天）
  const [y, m] = month.split('-');
  const lastDay = new Date(y, m, 0).getDate();
  const records = await request(
    `/records?book_id=${state.currentBook}&start_date=${month}-01&end_date=${month}-${String(lastDay).padStart(2, '0')}`
  );
  renderRecentRecords(records.slice(0, 5));
}

// 渲染分类排行
function renderCategoryRank(categoryExpense, totalExpense) {
  const container = document.getElementById('categoryRank');
  if (categoryExpense.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无支出记录</div>';
    return;
  }

  container.innerHTML = categoryExpense.slice(0, 5).map(c => {
    const safeColor = /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#64748b';
    return `
    <div class="category-rank-item">
      <div class="rank-icon" style="background: ${safeColor}20;">${esc(c.icon)}</div>
      <div class="rank-info">
        <div class="rank-name">${esc(c.name)}</div>
        <div class="rank-percent">${((c.total / totalExpense) * 100).toFixed(1)}%</div>
      </div>
      <div class="rank-amount" style="color:${safeColor}">${formatMoney(c.total)}</div>
    </div>
  `;
  }).join('');
}

// 渲染预算
function renderBudgets(budgets, totalExpense) {
  const container = document.getElementById('budgetList');
  const monthlyBudget = budgets.find(b => b.category_id === null);
  state._monthlyBudget = monthlyBudget || null;
  const categoryBudgets = budgets.filter(b => b.category_id !== null);

  let html = '';

  if (monthlyBudget) {
    const percent = Math.min((totalExpense / monthlyBudget.amount) * 100, 100);
    const cls = percent < 70 ? 'safe' : percent < 90 ? 'warning' : 'danger';
    html += `
      <div class="budget-item">
        <div class="budget-info">
          <span>本月总预算</span>
          <span>${formatMoney(totalExpense)} / ${formatMoney(monthlyBudget.amount)}</span>
        </div>
        <div class="budget-bar">
          <div class="budget-fill ${cls}" style="width:${percent}%"></div>
        </div>
      </div>
    `;
  }

  categoryBudgets.forEach(b => {
    const spent = Number(b.spent) || 0;
    const percent = Math.min((spent / b.amount) * 100, 100);
    const cls = percent < 70 ? 'safe' : percent < 90 ? 'warning' : 'danger';
    html += `
      <div class="budget-item">
        <div class="budget-info">
          <span>${b.category_icon || '📂'} ${b.category_name}</span>
          <span>${formatMoney(spent)} / ${formatMoney(b.amount)}</span>
        </div>
        <div class="budget-bar">
          <div class="budget-fill ${cls}" style="width:${percent}%"></div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html || '<div class="empty-hint">暂无预算，点击右上角设置</div>';
}

// 渲染最近记录
function renderRecentRecords(records) {
  const container = document.getElementById('recentRecords');
  if (records.length === 0) {
    container.innerHTML = '<div class="empty-hint">暂无记录</div>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  container.innerHTML = records.map(r => {
    const cat = getCategoryById(r.category_id);
    let dateLabel;
    if (r.record_date === today) dateLabel = '今天';
    else if (r.record_date === yesterdayStr) dateLabel = '昨天';
    else {
      const d = new Date(r.record_date);
      dateLabel = `${d.getMonth() + 1}/${d.getDate()}`;
    }
    const noteParts = [dateLabel];
    if (r.account_name) noteParts.push(r.account_name);
    if (r.note) noteParts.push(r.note);
    const safeColor = /^#[0-9a-fA-F]{6}$/.test(cat.color) ? cat.color : '#64748b';
    return `
      <div class="record-item" onclick="location.href='/bills.html'">
        <div class="record-icon" style="background: ${safeColor}20;">${esc(cat.icon)}</div>
        <div class="record-info">
          <div class="record-title">${esc(cat.name)}</div>
          <div class="record-note">${esc(noteParts.join(' · '))}</div>
        </div>
        <div class="record-amount ${esc(r.type)}">${r.type === 'income' ? '+' : '-'}${formatMoney(r.amount)}</div>
      </div>
    `;
  }).join('');
}
