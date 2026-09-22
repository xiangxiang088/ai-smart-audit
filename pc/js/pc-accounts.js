/**
 * PC端账户页逻辑 - 完全独立，不依赖 accounts.js
 */

const typeNames = {
  cash: '现金', bank: '银行卡', credit: '信用卡',
  wechat: '微信', alipay: '支付宝', invest: '投资理财', other: '其他'
};

const groupOrder = ['cash', 'wechat', 'alipay', 'bank', 'credit', 'invest', 'other'];

const gradients = {
  cash:   'linear-gradient(135deg,#f59e0b,#d97706)',
  wechat: 'linear-gradient(135deg,#07c160,#06ad56)',
  alipay: 'linear-gradient(135deg,#1677ff,#0958d9)',
  bank:   'linear-gradient(135deg,#667eea,#764ba2)',
  credit: 'linear-gradient(135deg,#f472b6,#db2777)',
  invest: 'linear-gradient(135deg,#0d9488,#0f766e)',
  other:  'linear-gradient(135deg,#64748b,#475569)',
};

const iconOptions = ['💵','💬','💰','💳','📈','🏦','🪙','💴','💶','💷','📂','🎯','🐷','🏠','✈️','🎁'];

const txTypeMeta = {
  initial:      { label: '期初余额', color: 'var(--text-muted)', sign: '' },
  adjust:       { label: '余额调整', color: 'var(--warning)', sign: '' },
  expense:      { label: '支出', color: 'var(--danger)', sign: '-' },
  income:       { label: '收入', color: 'var(--success)', sign: '+' },
  transfer_out: { label: '转出', color: 'var(--danger)', sign: '-' },
  transfer_in:  { label: '转入', color: 'var(--success)', sign: '+' }
};

let selectedAccIcon = '💳';
let editingAccId = null;
let balanceAccId = null;

let txState = {
  accountId: null,
  page: 1,
  pageSize: 20,
  total: 0,
  hasMore: false,
  loading: false,
  list: [],
  startDate: '',
  endDate: ''
};

// ===== 页面初始化 =====

async function pageInit() {
  renderPCTopbar('账户管理');
  refreshPCNoticeBadge();
  bindAccEvents();
  renderPCAccounts();
}

async function pageRefresh() {
  await loadAccounts();
  renderPCAccounts();
}

function bindAccEvents() {
  document.getElementById('addAccountBtn')?.addEventListener('click', () => openAccountModal());

  // 账户类型切换时显示/隐藏信用卡日期字段
  const accType = document.getElementById('accType');
  if (accType) {
    accType.addEventListener('change', () => {
      document.getElementById('accCreditDates').style.display = accType.value === 'credit' ? 'block' : 'none';
    });
  }

  const txList = document.getElementById('txList');
  if (txList) {
    txList.addEventListener('scroll', () => {
      if (txState.loading || !txState.hasMore) return;
      if (txList.scrollTop + txList.clientHeight >= txList.scrollHeight - 50) loadMoreTx();
    });
  }
  document.getElementById('txFilterBtn')?.addEventListener('click', applyTxFilter);
  document.getElementById('txResetBtn')?.addEventListener('click', resetTxFilter);
}

// ===== 账户渲染 =====

function _creditUrgency(acc) {
  if (acc.type !== 'credit' || Number(acc.balance) >= 0 || !acc.repay_day) return 0;
  const d = getDueStatus(getNextCreditDueDate(acc.repay_day));
  if (!d) return 0;
  if (d.status === 'overdue') return 3;
  if (d.status === 'soon') return 2;
  return 1;
}

function renderPCAccounts() {
  const accounts = state.accounts || [];

  // 汇总
  const summaryEl = document.getElementById('accSummary');
  if (summaryEl) {
    const totalAsset = accounts.filter(a => a.type !== 'credit').reduce((s, a) => s + Number(a.balance), 0);
    const totalDebt  = accounts.filter(a => a.type === 'credit').reduce((s, a) => s + Number(a.balance), 0);
    summaryEl.innerHTML = `
      <div class="pc-stat-item">
        <div class="pc-stat-label">总资产</div>
        <div class="pc-stat-value income">${formatMoney(totalAsset)}</div>
      </div>
      <div class="pc-stat-item">
        <div class="pc-stat-label">信用卡负债</div>
        <div class="pc-stat-value expense">${formatMoney(Math.abs(totalDebt))}</div>
      </div>
      <div class="pc-stat-item">
        <div class="pc-stat-label">净资产</div>
        <div class="pc-stat-value">${formatMoney(totalAsset - Math.abs(totalDebt))}</div>
      </div>`;
  }

  const container = document.getElementById('accountList');
  if (!container) return;

  if (accounts.length === 0) {
    container.innerHTML = '<div class="pc-empty" style="grid-column:1/-1;"><div class="pc-empty-icon">💳</div><div class="pc-empty-text">暂无账户，点击「新增账户」</div></div>';
    return;
  }

  const sorted = [...accounts].sort((a, b) => {
    // 有逾期/即将到期的信用卡排最前
    const urgencyA = _creditUrgency(a);
    const urgencyB = _creditUrgency(b);
    if (urgencyA !== urgencyB) return urgencyB - urgencyA;
    return groupOrder.indexOf(a.type) - groupOrder.indexOf(b.type);
  });
  container.innerHTML = sorted.map(acc => {
    const grad = gradients[acc.type] || gradients.other;
    const bal = Number(acc.balance);
    const isCredit = acc.type === 'credit';
    const balFmt = (isCredit ? '负债 ' : '') + formatMoney(Math.abs(bal));
    const hasDebt = isCredit && bal < 0;
    const dueInfo = isCredit && hasDebt && acc.repay_day ? getDueStatus(getNextCreditDueDate(acc.repay_day)) : null;
    const dueBadge = dueInfo && dueInfo.status !== 'normal'
      ? `<span class="cc-due-badge ${dueInfo.status}">⚠️ ${esc(dueInfo.text)}</span>` : '';
    return `
      <div class="pc-account-card${dueInfo && dueInfo.status === 'overdue' ? ' cc-overdue' : (dueInfo && dueInfo.status === 'soon' ? ' cc-due-soon' : '')}" style="background:${grad};" onclick="openTxModal('${esc(acc.id)}','${esc(acc.name)}')">
        <div class="pc-account-name">
          <span style="font-size:22px;">${esc(acc.icon || '💳')}</span>
          <span>${esc(acc.name)}</span>
          ${dueBadge}
        </div>
        <div class="pc-account-balance">${balFmt}</div>
        <div class="pc-account-type">${typeNames[acc.type] || '其他'}${isCredit && acc.repay_day ? ` · 每月${acc.repay_day}日还款` : ''}</div>
        <div class="pc-account-actions">
          <button class="pc-account-action-btn" onclick="event.stopPropagation();openAccountModal(${JSON.stringify(acc).replace(/"/g,'&quot;')})">✏️ 编辑</button>
          <button class="pc-account-action-btn" onclick="event.stopPropagation();openBalanceModal('${esc(acc.id)}')">💰 调余额</button>
          <button class="pc-account-action-btn" onclick="event.stopPropagation();openTxModal('${esc(acc.id)}','${esc(acc.name)}')">📋 流水</button>
        </div>
      </div>`;
  }).join('');
}

// ===== 账户新增/编辑弹窗 =====

window.openAccountModal = function(acc) {
  editingAccId = acc ? acc.id : null;
  document.getElementById('accModalTitle').textContent = acc ? '编辑账户' : '新增账户';
  document.getElementById('accName').value = acc ? acc.name : '';
  document.getElementById('accType').value = acc ? acc.type : 'other';
  document.getElementById('accBalance').value = acc ? acc.balance : '0';
  document.getElementById('accBalanceLabel').textContent = acc ? '当前余额' : '初始余额';
  selectedAccIcon = acc ? (acc.icon || '💳') : '💳';
  // 信用卡日期字段
  const isCredit = (acc ? acc.type : 'other') === 'credit';
  document.getElementById('accCreditDates').style.display = isCredit ? 'block' : 'none';
  document.getElementById('accBillDay').value = acc && acc.bill_day ? acc.bill_day : '';
  document.getElementById('accRepayDay').value = acc && acc.repay_day ? acc.repay_day : '';
  const delBtn = document.getElementById('accDeleteBtn');
  if (delBtn) delBtn.style.display = acc ? 'block' : 'none';
  renderIconPicker();
  document.getElementById('accountModal').classList.add('show');
};

window.closeAccountModal = function() {
  document.getElementById('accountModal').classList.remove('show');
  editingAccId = null;
};

function renderIconPicker() {
  const picker = document.getElementById('accIconPicker');
  if (!picker) return;
  picker.innerHTML = iconOptions.map(i => `
    <button class="acc-icon-option" data-icon="${i}" style="width:40px;height:40px;border-radius:8px;border:2px solid ${i === selectedAccIcon ? 'var(--primary)' : 'var(--border)'};font-size:20px;background:var(--card);cursor:pointer;">${i}</button>
  `).join('');
  picker.querySelectorAll('.acc-icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedAccIcon = btn.dataset.icon;
      renderIconPicker();
    });
  });
}

window.saveAccount = async function() {
  const name = document.getElementById('accName').value.trim();
  const type = document.getElementById('accType').value;
  const balance = parseFloat(document.getElementById('accBalance').value) || 0;
  const billDay = parseInt(document.getElementById('accBillDay').value) || null;
  const repayDay = parseInt(document.getElementById('accRepayDay').value) || null;
  if (!name) return showToast('请输入账户名称');
  if (type === 'credit') {
    if (billDay !== null && (billDay < 1 || billDay > 31)) return showToast('账单日需在1-31之间');
    if (repayDay !== null && (repayDay < 1 || repayDay > 31)) return showToast('还款日需在1-31之间');
  }
  try {
    if (editingAccId) {
      await request(`/accounts/${editingAccId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, type, icon: selectedAccIcon, bill_day: billDay, repay_day: repayDay })
      });
      const acc = state.accounts.find(a => a.id === editingAccId);
      if (acc && Number(acc.balance) !== balance) {
        await request(`/accounts/${editingAccId}/balance`, {
          method: 'PUT',
          body: JSON.stringify({ balance })
        });
      }
      showToast('修改成功');
    } else {
      await request('/accounts', {
        method: 'POST',
        body: JSON.stringify({ name, type, icon: selectedAccIcon, balance, book_id: state.currentBook, bill_day: billDay, repay_day: repayDay })
      });
      showToast('账户创建成功');
    }
    closeAccountModal();
    await loadAccounts();
    renderPCAccounts();
  } catch (e) {
    showToast(e.message || '操作失败');
  }
};

window.deleteAccount = async function() {
  if (!editingAccId) return;
  if (!await showConfirm({ title: '删除账户', message: '确定删除该账户吗？账户下的交易记录不会被删除。', okText: '删除', variant: 'danger' })) return;
  try {
    await request(`/accounts/${editingAccId}`, { method: 'DELETE' });
    showToast('已删除');
    closeAccountModal();
    await loadAccounts();
    renderPCAccounts();
  } catch (e) {
    showToast(e.message || '删除失败');
  }
};

// ===== 余额调整弹窗 =====

window.openBalanceModal = function(accId) {
  const acc = state.accounts.find(a => a.id === accId);
  if (!acc) return;
  balanceAccId = accId;
  document.getElementById('balAccName').textContent = `${acc.icon || '💳'} ${acc.name}`;
  document.getElementById('balCurrent').textContent = formatMoney(acc.balance);
  document.getElementById('balNewValue').value = acc.balance;
  document.getElementById('balNote').value = '';
  document.getElementById('balanceModal').classList.add('show');
  setTimeout(() => document.getElementById('balNewValue').focus(), 100);
};

window.closeBalanceModal = function() {
  document.getElementById('balanceModal').classList.remove('show');
  balanceAccId = null;
};

window.saveBalance = async function() {
  if (!balanceAccId) return;
  const balance = parseFloat(document.getElementById('balNewValue').value);
  const note = document.getElementById('balNote').value.trim();
  if (isNaN(balance)) return showToast('请输入有效金额');
  try {
    await request(`/accounts/${balanceAccId}/balance`, {
      method: 'PUT',
      body: JSON.stringify({ balance, note: note || undefined })
    });
    showToast('余额已调整');
    closeBalanceModal();
    await loadAccounts();
    renderPCAccounts();
  } catch (e) {
    showToast('调整失败');
  }
};

// ===== 账户流水弹窗 =====

window.openTxModal = function(accId, accName) {
  const acc = state.accounts.find(a => a.id === accId);
  if (!acc) return;
  txState = {
    accountId: accId,
    page: 1, pageSize: 20, total: 0,
    hasMore: false, loading: false, list: [],
    startDate: '', endDate: ''
  };
  document.getElementById('txModalTitle').textContent = `${acc.icon || '💳'} ${acc.name} · 流水明细`;
  document.getElementById('txStartDate').value = '';
  document.getElementById('txEndDate').value = '';
  document.getElementById('txList').innerHTML = `<div class="tx-loading"><div class="tx-loading-spinner"></div><span>加载中...</span></div>`;
  document.getElementById('txModal').classList.add('show');
  loadTxPage();
};

window.closeTxModal = function() {
  document.getElementById('txModal').classList.remove('show');
};

async function loadTxPage() {
  if (txState.loading) return;
  txState.loading = true;
  const params = new URLSearchParams({ page: txState.page, page_size: txState.pageSize });
  if (txState.startDate) params.append('start_date', txState.startDate);
  if (txState.endDate) params.append('end_date', txState.endDate);
  try {
    const data = await request(`/accounts/${txState.accountId}/transactions?${params}`);
    txState.total = data.total;
    txState.hasMore = data.has_more;
    txState.list = txState.list.concat(data.list || []);
    txState.loading = false;
    renderTxList();
  } catch (e) {
    document.getElementById('txList').innerHTML = `<div class="tx-empty">加载失败：${e.message || '请重试'}</div>`;
    txState.loading = false;
  }
}

async function loadMoreTx() {
  txState.page++;
  await loadTxPage();
}

function applyTxFilter() {
  txState.startDate = document.getElementById('txStartDate').value;
  txState.endDate = document.getElementById('txEndDate').value;
  txState.page = 1;
  txState.list = [];
  document.getElementById('txList').innerHTML = `<div class="tx-loading"><div class="tx-loading-spinner"></div><span>加载中...</span></div>`;
  loadTxPage();
}

function resetTxFilter() {
  document.getElementById('txStartDate').value = '';
  document.getElementById('txEndDate').value = '';
  txState.startDate = '';
  txState.endDate = '';
  txState.page = 1;
  txState.list = [];
  document.getElementById('txList').innerHTML = `<div class="tx-loading"><div class="tx-loading-spinner"></div><span>加载中...</span></div>`;
  loadTxPage();
}

function renderTxList() {
  const container = document.getElementById('txList');
  if (txState.list.length === 0) {
    container.innerHTML = '<div class="tx-empty"><div style="font-size:32px;margin-bottom:8px;">📋</div><p>暂无流水记录</p></div>';
    return;
  }

  const groups = {};
  txState.list.forEach(tx => {
    const date = (tx.created_at || '').slice(0, 10);
    if (!groups[date]) groups[date] = [];
    groups[date].push(tx);
  });

  const dateKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  let html = '';

  for (const date of dateKeys) {
    const items = groups[date];
    let dayIn = 0, dayOut = 0;
    items.forEach(tx => {
      const amt = Number(tx.change_amount);
      if (amt > 0) dayIn += amt;
      else dayOut += Math.abs(amt);
    });

    html += `
      <div class="tx-date-group">
        <div class="tx-date-header">
          <span class="tx-date-label">${date}</span>
          <span class="tx-date-summary">
            ${dayIn > 0 ? `<span class="tx-in">+${formatMoney(dayIn)}</span>` : ''}
            ${dayOut > 0 ? `<span class="tx-out">-${formatMoney(dayOut)}</span>` : ''}
          </span>
        </div>`;

    items.forEach(tx => {
      const meta = txTypeMeta[tx.change_type] || { label: tx.change_type, color: 'var(--text-muted)', sign: '' };
      const amount = Number(tx.change_amount);
      const isPositive = amount >= 0;
      const amountText = (isPositive ? '+' : '') + formatMoney(amount);
      const time = (tx.created_at || '').slice(11, 16);
      const typeLabel = tx.category_name ? `${tx.category_icon || ''} ${tx.category_name}` : meta.label;
      const genericNotes = ['支出', '收入', '转账转出', '转账转入', '期初余额', '手动调整余额'];
      const rawNote = tx.record_note || tx.note || '';
      const noteText = rawNote && !genericNotes.includes(rawNote) ? rawNote : '';
      const operator = tx.operator_name || '';

      html += `
        <div class="tx-item">
          <div class="tx-item-left">
            <div class="tx-item-type" style="color:${tx.category_color || meta.color}">${esc(typeLabel)}</div>
            ${noteText ? `<div class="tx-item-note">${esc(noteText)}</div>` : ''}
            <div class="tx-item-meta">
              <span>${time}</span>
              ${operator ? `<span>· ${esc(operator)}</span>` : ''}
              <span>· 余额 ${formatMoney(tx.after_balance)}</span>
            </div>
          </div>
          <div class="tx-item-amount ${isPositive ? 'positive' : 'negative'}">${amountText}</div>
        </div>`;
    });

    html += '</div>';
  }

  if (txState.hasMore) {
    html += '<div class="tx-load-more-hint">上拉加载更多...</div>';
  } else {
    html += `<div class="tx-total-hint">共 ${txState.total} 条记录</div>`;
  }

  container.innerHTML = html;
}
