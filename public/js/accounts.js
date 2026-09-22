/**
 * 账户页逻辑
 */

const typeNames = {
  cash: '现金', bank: '银行卡', credit: '信用卡',
  wechat: '微信', alipay: '支付宝', invest: '投资理财', other: '其他'
};

const typeIcons = {
  cash: '💵', wechat: '💬', alipay: '💰', bank: '💳',
  credit: '💳', invest: '📈', other: '📂'
};

// 分组顺序
const groupOrder = ['cash', 'wechat', 'alipay', 'bank', 'credit', 'invest', 'other'];

// 是否使用银行卡片式设计
const cardTypes = ['bank', 'credit'];

// 各分组品牌渐变色
const groupGradients = {
  cash:   'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
  wechat: 'linear-gradient(135deg, #07c160 0%, #06ad56 100%)',
  alipay: 'linear-gradient(135deg, #1677ff 0%, #0958d9 100%)',
  invest: 'linear-gradient(135deg, #0d9488 0%, #0f766e 100%)',
  other:  'linear-gradient(135deg, #64748b 0%, #475569 100%)'
};

const iconOptions = ['💵','💬','💰','💳','📈','🏦','🪙','💴','💶','💷','📂','🎯','🐷','🏠','✈️','🎁'];

// 流水类型映射
const txTypeMeta = {
  initial:     { label: '期初余额', color: 'var(--text-muted)', sign: '' },
  adjust:      { label: '余额调整', color: 'var(--warning)', sign: '' },
  expense:     { label: '支出', color: 'var(--danger)', sign: '-' },
  income:      { label: '收入', color: 'var(--success)', sign: '+' },
  transfer_out:{ label: '转出', color: 'var(--danger)', sign: '-' },
  transfer_in: { label: '转入', color: 'var(--success)', sign: '+' }
};

let selectedAccIcon = '💳';
let editingAccId = null;
let balanceAccId = null;

// 流水弹窗状态
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

async function pageInit() {
  bindEvents();
  renderAccounts();
}

async function pageRefresh() {
  await loadAccounts();
  renderAccounts();
}

function bindEvents() {
  document.getElementById('addAccountBtn').addEventListener('click', () => openAccountModal());

  // 账户类型切换时显示/隐藏信用卡日期字段
  const accType = document.getElementById('accType');
  if (accType) {
    accType.addEventListener('change', () => {
      document.getElementById('accCreditDates').style.display = accType.value === 'credit' ? 'block' : 'none';
    });
  }

  // 流水弹窗 - 滚动加载更多
  const txList = document.getElementById('txList');
  if (txList) {
    txList.addEventListener('scroll', () => {
      if (txState.loading || !txState.hasMore) return;
      if (txList.scrollTop + txList.clientHeight >= txList.scrollHeight - 50) {
        loadMoreTx();
      }
    });
  }

  // 流水弹窗 - 日期筛选
  const txFilterBtn = document.getElementById('txFilterBtn');
  if (txFilterBtn) {
    txFilterBtn.addEventListener('click', applyTxFilter);
  }
  const txResetBtn = document.getElementById('txResetBtn');
  if (txResetBtn) {
    txResetBtn.addEventListener('click', resetTxFilter);
  }
}

function openAccountModal(acc) {
  editingAccId = acc ? acc.id : null;
  document.getElementById('accModalTitle').textContent = acc ? '编辑账户' : '新增账户';
  document.getElementById('accName').value = acc ? acc.name : '';
  document.getElementById('accType').value = acc ? acc.type : 'other';
  document.getElementById('accBalance').value = acc ? acc.balance : '0';
  document.getElementById('accBalanceLabel').textContent = acc ? '当前余额' : '初始余额';
  selectedAccIcon = acc ? acc.icon : (typeIcons[acc ? acc.type : 'other'] || '💳');
  // 信用卡日期
  const isCredit = (acc ? acc.type : 'other') === 'credit';
  document.getElementById('accCreditDates').style.display = isCredit ? 'block' : 'none';
  document.getElementById('accBillDay').value = acc && acc.bill_day ? acc.bill_day : '';
  document.getElementById('accRepayDay').value = acc && acc.repay_day ? acc.repay_day : '';
  document.getElementById('accDeleteBtn').style.display = acc ? 'block' : 'none';
  renderIconPicker();
  document.getElementById('accountModal').classList.add('show');
}

function closeAccountModal() {
  document.getElementById('accountModal').classList.remove('show');
  editingAccId = null;
}

function renderIconPicker() {
  const picker = document.getElementById('accIconPicker');
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
      // 如果余额变了，单独更新
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
    renderAccounts();
  } catch (e) {
    showToast(e.message || '操作失败');
  }
};

window.deleteAccount = async function() {
  if (!editingAccId) return;
  if (!confirm('确定删除该账户吗？账户下的交易记录不会被删除。')) return;
  try {
    await request(`/accounts/${editingAccId}`, { method: 'DELETE' });
    showToast('已删除');
    closeAccountModal();
    await loadAccounts();
    renderAccounts();
  } catch (e) {
    showToast(e.message || '删除失败');
  }
};

// 打开余额调整弹窗
window.openBalanceModal = function(accId) {
  const acc = state.accounts.find(a => a.id === accId);
  if (!acc) return;
  balanceAccId = accId;
  document.getElementById('balAccName').textContent = `${acc.icon} ${acc.name}`;
  document.getElementById('balCurrent').textContent = formatMoney(acc.balance);
  document.getElementById('balNewValue').value = acc.balance;
  document.getElementById('balNote').value = '';
  document.getElementById('balanceModal').classList.add('show');
  setTimeout(() => document.getElementById('balNewValue').focus(), 100);
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
    document.getElementById('balanceModal').classList.remove('show');
    balanceAccId = null;
    await loadAccounts();
    renderAccounts();
  } catch (e) {
    showToast('调整失败');
  }
};

// ===== 账户流水 =====

window.openTxModal = function(accId) {
  const acc = state.accounts.find(a => a.id === accId);
  if (!acc) return;

  txState = {
    accountId: accId,
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    loading: false,
    list: [],
    startDate: '',
    endDate: ''
  };

  document.getElementById('txModalTitle').textContent = `${acc.icon} ${acc.name} · 流水明细`;
  document.getElementById('txStartDate').value = '';
  document.getElementById('txEndDate').value = '';
  document.getElementById('txList').innerHTML = `
    <div class="tx-loading">
      <div class="tx-loading-spinner"></div>
      <span>加载中...</span>
    </div>`;
  document.getElementById('txModal').classList.add('show');

  loadTxPage();
};

async function loadTxPage() {
  if (txState.loading) return;
  txState.loading = true;
  const params = new URLSearchParams({
    page: txState.page,
    page_size: txState.pageSize
  });
  if (txState.startDate) params.append('start_date', txState.startDate);
  if (txState.endDate) params.append('end_date', txState.endDate);

  let data;
  try {
    data = await request(`/accounts/${txState.accountId}/transactions?${params}`);
  } catch (e) {
    document.getElementById('txList').innerHTML = `<div class="tx-empty">加载失败：${e.message || '请重试'}</div>`;
    txState.loading = false;
    return;
  }
  txState.total = data.total;
  txState.hasMore = data.has_more;
  txState.list = txState.list.concat(data.list || []);
  txState.loading = false;
  renderTxList();
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
  document.getElementById('txList').innerHTML = `
    <div class="tx-loading">
      <div class="tx-loading-spinner"></div>
      <span>加载中...</span>
    </div>`;
  loadTxPage();
}

function resetTxFilter() {
  document.getElementById('txStartDate').value = '';
  document.getElementById('txEndDate').value = '';
  txState.startDate = '';
  txState.endDate = '';
  txState.page = 1;
  txState.list = [];
  document.getElementById('txList').innerHTML = `
    <div class="tx-loading">
      <div class="tx-loading-spinner"></div>
      <span>加载中...</span>
    </div>`;
  loadTxPage();
}

function renderTxList() {
  const container = document.getElementById('txList');

  if (txState.list.length === 0) {
    container.innerHTML = '<div class="tx-empty"><div class="emoji">📋</div><p>暂无流水记录</p></div>';
    return;
  }

  // 按日期分组
  const groups = {};
  txState.list.forEach(tx => {
    const date = (tx.created_at || '').slice(0, 10);
    if (!groups[date]) groups[date] = [];
    groups[date].push(tx);
  });

  let html = '';
  let dateIdx = 0;
  const dateKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  for (const date of dateKeys) {
    const items = groups[date];
    // 计算当日收入/支出合计
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
        </div>
    `;

    items.forEach(tx => {
      const meta = txTypeMeta[tx.change_type] || { label: tx.change_type, color: 'var(--text-muted)', sign: '' };
      const amount = Number(tx.change_amount);
      const isPositive = amount >= 0;
      const amountText = (isPositive ? '+' : '') + formatMoney(amount);
      const time = (tx.created_at || '').slice(11, 16);
      const operator = tx.operator_name || '';

      // 优先用分类图标+名称，否则用流水类型
      const typeLabel = tx.category_name
        ? `${tx.category_icon || ''} ${tx.category_name}`
        : meta.label;

      // 备注：优先用记账记录备注，其次流水备注；过滤掉和类型标签重复的通用文字
      const genericNotes = ['支出', '收入', '转账转出', '转账转入', '期初余额', '手动调整余额'];
      const rawNote = tx.record_note || tx.note || '';
      const noteText = rawNote && !genericNotes.includes(rawNote) ? rawNote : '';

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
        </div>
      `;
    });

    html += '</div>';
    dateIdx++;
  }

  // 加载更多提示
  if (txState.loading) {
    html += `
      <div class="tx-loading-more">
        <div class="tx-loading-spinner small"></div>
        <span>加载中...</span>
      </div>`;
  } else if (txState.hasMore) {
    html += '<div class="tx-load-more-hint">上拉加载更多...</div>';
  } else {
    html += `<div class="tx-total-hint">共 ${txState.total} 条记录</div>`;
  }

  container.innerHTML = html;
}

window.editAccount = function(accId) {
  const acc = state.accounts.find(a => a.id === accId);
  if (acc) openAccountModal(acc);
};

function renderAccounts() {
  document.getElementById('netAssets').textContent = formatMoney(state.accountSummary.netAssets);
  document.getElementById('totalAssets').textContent = formatMoney(state.accountSummary.totalAssets);
  document.getElementById('totalLiabilities').textContent = formatMoney(state.accountSummary.totalLiabilities);

  // 按类型分组
  const groups = {};
  state.accounts.forEach(a => {
    if (!groups[a.type]) groups[a.type] = [];
    groups[a.type].push(a);
  });

  const container = document.getElementById('accountsList');
  let html = '';

  groupOrder.forEach(type => {
    const list = groups[type];
    if (!list || list.length === 0) return;

    const total = list.reduce((sum, a) => {
      const bal = Number(a.balance);
      // 信用卡：只有负数（欠款）计入应还合计
      if (type === 'credit') return sum + (bal < 0 ? Math.abs(bal) : 0);
      return sum + bal;
    }, 0);

    html += `
      <div class="acc-group">
        <div class="acc-group-header">
          <span class="acc-group-title">
            <span class="acc-group-icon">${typeIcons[type]}</span>
            ${typeNames[type] || type}
          </span>
          <span class="acc-group-total ${type === 'credit' ? 'debt' : ''}">${type === 'credit' ? '应还 ' : ''}${formatMoney(total)}</span>
        </div>
        <div class="acc-group-body ${cardTypes.includes(type) ? 'card-style' : 'list-style'} group-color-${type}" ${!cardTypes.includes(type) && groupGradients[type] ? `style="background:${groupGradients[type]}"` : ''}>
          ${list.map(a => renderAccountItem(a)).join('')}
        </div>
      </div>
    `;
  });

  container.innerHTML = html || '<div class="empty-state"><div class="emoji">💳</div><p>暂无账户，点击右上角新增</p></div>';
}

function renderAccountItem(a) {
  const isCard = cardTypes.includes(a.type);
  const balance = Number(a.balance);
  const isCredit = a.type === 'credit';
  // 信用卡：支出会扣减余额，所以负数表示欠款
  const hasDebt = isCredit && balance < 0;
  const displayBalance = isCredit ? Math.abs(balance) : balance;
  const balanceLabel = isCredit ? (hasDebt ? '应还款' : (balance > 0 ? '溢存款' : '已还清')) : '余额';
  const dueInfo = isCredit && hasDebt && a.repay_day ? getDueStatus(getNextCreditDueDate(a.repay_day)) : null;
  const dueBadge = dueInfo && dueInfo.status !== 'normal'
    ? `<span class="cc-due-badge ${dueInfo.status}">⚠️ ${esc(dueInfo.text)}</span>` : '';

  if (isCard) {
    return `
      <div class="bank-card ${isCredit ? 'credit-card' : 'debit-card'}${dueInfo && dueInfo.status === 'overdue' ? ' cc-overdue' : (dueInfo && dueInfo.status === 'soon' ? ' cc-due-soon' : '')}" data-type="${esc(a.type)}">
        <div class="bank-card-top">
          <span class="bank-card-name">${esc(a.name)}</span>
          <span class="bank-card-icon">${esc(a.icon)}</span>
        </div>
        ${dueBadge}
        <div class="bank-card-balance">
          <span class="bank-card-label">${balanceLabel}</span>
          <span class="bank-card-amount ${hasDebt ? 'debt' : ''}">${formatMoney(displayBalance)}</span>
        </div>
        <div class="bank-card-sub">${isCredit && a.repay_day ? `每月${a.repay_day}日还款` : ''}</div>
        <div class="bank-card-actions">
          <button onclick="openTxModal('${a.id}')">📊 流水</button>
          <button onclick="openBalanceModal('${a.id}')">✏️ 调整</button>
          <button onclick="editAccount('${a.id}')">⚙️ 编辑</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="acc-list-item">
      <div class="acc-list-left">
        <span class="acc-list-name">${esc(a.name)}</span>
        <span class="acc-list-balance">${formatMoney(balance)}</span>
      </div>
      <div class="acc-list-actions">
        <button onclick="openTxModal('${a.id}')" title="流水">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
        </button>
        <button onclick="openBalanceModal('${a.id}')" title="调余额">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
        </button>
        <button onclick="editAccount('${a.id}')" title="编辑">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </button>
      </div>
    </div>
  `;
}
