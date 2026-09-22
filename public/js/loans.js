/**
 * 借贷中心逻辑
 */

let currentLoanType = 'all';
let currentLoanFormType = 'lend';
let repayLoanId = null;
let loansCache = [];
let editLoanId = null;
let loanImageUrl = null;
let editLoanImageUrl = null;

async function pageInit() {
  bindEvents();
  document.getElementById('loanDate').value = new Date().toISOString().slice(0, 10);
  document.getElementById('repayDate').value = new Date().toISOString().slice(0, 10);
  // 打开新增弹窗时重置图片
  document.getElementById('loanModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('loanModal').classList.remove('show');
  });
  await loadLoans();
}

async function pageRefresh() {
  await loadLoans();
}

function bindEvents() {
  document.getElementById('addLoanBtn').addEventListener('click', () => {
    document.getElementById('loanModal').classList.add('show');
  });

  document.querySelectorAll('.loan-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.loan-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentLoanType = tab.dataset.type;
      loadLoans();
    });
  });

  document.querySelectorAll('[data-loan-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-loan-type]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentLoanFormType = btn.dataset.loanType;
    });
  });
}

async function loadLoans() {
  const loans = await request(`/loans?book_id=${state.currentBook}`);
  loansCache = loans;

  let totalLend = 0, totalBorrow = 0;
  loans.forEach(l => {
    if (l.type === 'lend' && !l.is_settled) totalLend += Number(l.remaining);
    if (l.type === 'borrow' && !l.is_settled) totalBorrow += Number(l.remaining);
  });
  document.getElementById('totalLend').textContent = formatMoney(totalLend);
  document.getElementById('totalBorrow').textContent = formatMoney(totalBorrow);

  let filtered = currentLoanType === 'all' ? loans : loans.filter(l => l.type === currentLoanType);
  filtered = filtered.slice().sort((a, b) => {
    const ka = a.is_settled ? 2 : (a.due_date ? 0 : 1);
    const kb = b.is_settled ? 2 : (b.due_date ? 0 : 1);
    if (ka !== kb) return ka - kb;
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    return 0;
  });

  const container = document.getElementById('loansList');
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="emoji">💰</div><p>暂无借贷记录</p></div>';
    return;
  }

  container.innerHTML = filtered.map(l => {
    const remaining = Number(l.remaining);
    const total = Number(l.amount);
    const repaid = total - remaining;
    const percent = total > 0 ? (repaid / total) * 100 : 0;
    const statusText = l.is_settled ? '已结清' : (l.type === 'lend' ? '借出' : '借入');
    const statusCls = l.is_settled ? 'settled' : l.type;
    const hasRecords = l.records && l.records.length > 0;
    const due = (!l.is_settled && l.due_date) ? getDueStatus(l.due_date) : null;
    const cardCls = ['loan-card', due && due.status === 'overdue' ? 'loan-overdue' : '', due && due.status === 'soon' ? 'loan-due-soon' : ''].filter(Boolean).join(' ');
    const dueBadge = due ? `<span class="loan-due-badge ${due.status}">⚠️ ${esc(due.text)}</span>` : '';

    return `
      <div class="${cardCls}" onclick="openLoanDetail('${l.id}')">
        <div class="loan-card-header">
          <span class="loan-contact">${esc(l.contact_name)}</span>
          <div style="display:flex;align-items:center;gap:6px;">
            ${dueBadge}
            <span class="loan-status ${statusCls}">${statusText}</span>
          </div>
        </div>
        <div class="loan-amount-row">
          <span>金额: ${formatMoney(total)}</span>
          <span>${l.is_settled ? '已还清' : '待还: ' + formatMoney(remaining)}</span>
        </div>
        <div class="loan-progress">
          <div class="loan-progress-fill" style="width:${percent}%;"></div>
        </div>
        <div class="loan-date ${due ? 'due-' + due.status : ''}">${l.loan_date}${l.due_date ? ' ~ ' + l.due_date : ''}${l.note ? ' · ' + esc(l.note) : ''}</div>
        <div class="loan-card-footer">
          ${hasRecords ? `<span class="loan-records-count">${l.records.length}笔还款记录</span>` : '<span></span>'}
          <div class="loan-card-actions">
            ${!l.is_settled ? `<button class="loan-repay-btn" onclick="event.stopPropagation();openRepayModal('${l.id}')">记录还款</button>` : ''}
            <span class="loan-detail-hint">查看详情 ›</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.openLoanDetail = function(loanId) {
  const loan = loansCache.find(l => l.id === loanId);
  if (!loan) return;
  editLoanId = loanId;

  const total = Number(loan.amount);
  const remaining = Number(loan.remaining);
  const repaid = total - remaining;
  const percent = total > 0 ? (repaid / total) * 100 : 0;
  const typeLabel = loan.type === 'lend' ? '借出' : '借入';
  const typeCls = loan.type;

  // 按还款日期倒序排列（显示用）
  const records = (loan.records || []).slice().sort((a, b) => new Date(b.repay_date) - new Date(a.repay_date));

  // 先按时间正序计算每笔还款后的剩余本金
  const ascRecords = (loan.records || []).slice().sort((a, b) => new Date(a.repay_date) - new Date(b.repay_date));
  const remainingMap = {};
  let running = total;
  ascRecords.forEach(r => {
    running -= Number(r.amount);
    remainingMap[r.id] = Math.max(0, running);
  });

  const timelineHtml = records.length > 0 ? records.map(r => {
    return `
      <div class="repay-timeline-item">
        <div class="repay-timeline-dot"></div>
        <div class="repay-timeline-content">
          <div class="repay-timeline-header">
            <span class="repay-timeline-amount">-${formatMoney(r.amount)}</span>
            <span class="repay-timeline-date">${r.repay_date}</span>
          </div>
          ${r.note ? `<div class="repay-timeline-note">${esc(r.note)}</div>` : ''}
          <div class="repay-timeline-balance">还款后剩余: ${formatMoney(remainingMap[r.id] ?? 0)}</div>
        </div>
      </div>
    `;
  }).join('') : '<div class="repay-empty">暂无还款记录</div>';

  document.getElementById('loanDetailBody').innerHTML = `
    <div class="loan-detail-summary ${typeCls}">
      <div class="loan-detail-type">
        <span class="loan-detail-type-badge">${typeLabel}</span>
        ${loan.is_settled ? '<span class="loan-detail-settled">已结清</span>' : ''}
      </div>
      <div class="loan-detail-contact">${esc(loan.contact_name)}</div>
      <div class="loan-detail-amount">${formatMoney(total)}</div>
      <div class="loan-detail-progress-wrap">
        <div class="loan-detail-progress">
          <div class="loan-detail-progress-fill" style="width:${percent}%;"></div>
        </div>
        <div class="loan-detail-progress-text">已还 ${formatMoney(repaid)} / 待还 ${formatMoney(remaining)}</div>
      </div>
    </div>
    <div class="loan-detail-meta">
      <div class="loan-detail-meta-item">
        <span class="meta-label">借款日期</span>
        <span class="meta-value">${loan.loan_date}</span>
      </div>
      ${loan.due_date ? `
      <div class="loan-detail-meta-item ${!loan.is_settled ? 'meta-due-' + (getDueStatus(loan.due_date)?.status || '') : ''}">
        <span class="meta-label">约定还款</span>
        <span class="meta-value">${loan.due_date}${!loan.is_settled && getDueStatus(loan.due_date) ? ' <em>' + esc(getDueStatus(loan.due_date).text) + '</em>' : ''}</span>
      </div>` : ''}
      ${loan.note ? `
      <div class="loan-detail-meta-item full">
        <span class="meta-label">备注</span>
        <span class="meta-value">${esc(loan.note)}</span>
      </div>` : ''}
      ${loan.image_url ? `
      <div class="loan-detail-meta-item full">
        <span class="meta-label">凭证图片</span>
        <img src="${loan.image_url}" class="loan-proof-img" onclick="window.open(this.src)" alt="凭证">
      </div>` : ''}
    </div>
    <div class="repay-timeline-section">
      <div class="repay-timeline-title">还款记录 (${records.length})</div>
      <div class="repay-timeline">
        ${timelineHtml}
      </div>
    </div>
  `;

  document.getElementById('loanDetailModal').classList.add('show');
};

window.saveLoan = async function() {
  const contact_name = document.getElementById('loanContact').value.trim();
  const amount = parseFloat(document.getElementById('loanAmount').value);
  const loan_date = document.getElementById('loanDate').value;
  const due_date = document.getElementById('loanDueDate').value;
  const note = document.getElementById('loanNote').value.trim();

  if (!contact_name) return showToast('请输入对方名称');
  if (!amount || amount <= 0) return showToast('请输入有效金额');
  if (!loan_date) return showToast('请选择日期');

  await request('/loans', {
    method: 'POST',
    body: JSON.stringify({
      book_id: state.currentBook,
      type: currentLoanFormType,
      contact_name, amount, loan_date, due_date, note,
      image_url: loanImageUrl || null
    })
  });

  showToast('添加成功');
  document.getElementById('loanModal').classList.remove('show');
  document.getElementById('loanContact').value = '';
  document.getElementById('loanAmount').value = '';
  document.getElementById('loanNote').value = '';
  loanImageUrl = null;
  document.getElementById('loanImagePreview').style.display = 'none';
  document.getElementById('loanImgUploadHint').style.display = '';
  loadLoans();
};

window.onLoanImageChange = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    showToast('上传中...');
    loanImageUrl = await uploadFile(file);
    const preview = document.getElementById('loanImagePreview');
    preview.src = loanImageUrl;
    preview.style.display = 'block';
    document.getElementById('loanImgUploadHint').style.display = 'none';
  } catch (e) {
    showToast('图片上传失败');
  }
};

window.onEditLoanImageChange = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    showToast('上传中...');
    editLoanImageUrl = await uploadFile(file);
    const preview = document.getElementById('editLoanImagePreview');
    preview.src = editLoanImageUrl;
    preview.style.display = 'block';
    document.getElementById('editLoanImgUploadHint').style.display = 'none';
  } catch (e) {
    showToast('图片上传失败');
  }
};

window.openEditLoanModal = function() {
  const loan = loansCache.find(l => l.id === editLoanId);
  if (!loan) return;
  document.getElementById('editLoanNote').value = loan.note || '';
  editLoanImageUrl = loan.image_url || null;
  const preview = document.getElementById('editLoanImagePreview');
  const hint = document.getElementById('editLoanImgUploadHint');
  if (editLoanImageUrl) {
    preview.src = editLoanImageUrl;
    preview.style.display = 'block';
    hint.style.display = 'none';
  } else {
    preview.style.display = 'none';
    hint.style.display = '';
  }
  document.getElementById('loanEditModal').classList.add('show');
};

window.saveEditLoan = async function() {
  if (!editLoanId) return;
  const note = document.getElementById('editLoanNote').value.trim();
  await request(`/loans/${editLoanId}`, {
    method: 'PATCH',
    body: JSON.stringify({ note, image_url: editLoanImageUrl || null })
  });
  showToast('已保存');
  document.getElementById('loanEditModal').classList.remove('show');
  await loadLoans();
  openLoanDetail(editLoanId);
};

window.openRepayModal = function(loanId) {
  repayLoanId = loanId;
  document.getElementById('repayAmount').value = '';
  document.getElementById('repayNote').value = '';
  document.getElementById('repayModal').classList.add('show');
};

window.confirmRepay = async function() {
  const amount = parseFloat(document.getElementById('repayAmount').value);
  const repay_date = document.getElementById('repayDate').value;
  const note = document.getElementById('repayNote').value.trim();
  if (!amount || amount <= 0) return showToast('请输入有效金额');
  if (!repay_date) return showToast('请选择还款日期');

  await request(`/loans/${repayLoanId}/repay`, {
    method: 'POST',
    body: JSON.stringify({ amount, repay_date, note })
  });

  showToast('还款记录已保存');
  document.getElementById('repayModal').classList.remove('show');
  loadLoans();
};
