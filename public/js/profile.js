/**
 * 我的页面逻辑
 */

let selectedBookIcon = '📒';

async function pageInit() {
  document.getElementById('profileName').textContent = state.user.nickname;
  document.getElementById('themeText').textContent = state.theme === 'dark' ? '开启' : '关闭';
  renderBookDropdown();
  bindEvents();
  loadAIConfigStatus();
  if (state.isAdmin) {
    document.getElementById('noticeAdminBtn').style.display = '';
  }
}

async function loadAIConfigStatus() {
  try {
    const config = await request('/settings/ai');
    const statusEl = document.getElementById('aiStatusText');
    if (config.ai_enabled && config.ai_api_key_masked) {
      statusEl.textContent = '已启用';
      statusEl.style.color = 'var(--success)';
    } else if (config.ai_api_key_masked) {
      statusEl.textContent = '已配置';
      statusEl.style.color = 'var(--warning)';
    } else {
      statusEl.textContent = '未配置';
      statusEl.style.color = 'var(--text-muted)';
    }
  } catch (e) {}
}

function pageRefresh() {}

window.closeSettingsSheet = function() {
  document.getElementById('settingsSheet').classList.remove('show');
  document.getElementById('settingsSheetMask').classList.remove('show');
};

function renderBookDropdown() {
  const currentBook = state.books.find(b => b.id === state.currentBook);
  if (currentBook) {
    const ownerLabel = currentBook.user_role === 'owner' ? '' : ` (${currentBook.owner_nickname || '共享'})`;
    document.getElementById('currentBookName').textContent = currentBook.cover_icon + ' ' + currentBook.name + ownerLabel + ' ▾';
  }

  const dropdown = document.getElementById('bookDropdown');
  dropdown.innerHTML = state.books.map(b => {
    const ownerLabel = b.user_role === 'owner' ? '' : `<span class="book-owner-tag">${b.owner_nickname || '共享'}</span>`;
    return `
    <div class="book-option ${b.id === state.currentBook ? 'active' : ''}" data-id="${b.id}">
      <span class="book-option-icon">${b.cover_icon}</span>
      <span class="book-option-name">${b.name}${ownerLabel}</span>
      <span class="book-option-badge">${b.record_count || 0}笔</span>
    </div>
  `}).join('') + `
    <div class="book-add-btn" id="addBookBtn">+ 新建账本</div>
  `;

  dropdown.querySelectorAll('.book-option').forEach(opt => {
    opt.addEventListener('click', async (e) => {
      e.stopPropagation();
      const bookId = opt.dataset.id;  // 雪花ID保持字符串
      dropdown.classList.remove('show');
      await switchBook(bookId);
      renderBookDropdown();
    });
  });

  document.getElementById('addBookBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.remove('show');
    showNewBookModal();
  });
}

function showNewBookModal() {
  const icons = ['📒','🏠','✈️','💼','👶','🎉','🏥','🎓','🍜','🎮','💝','🏖️'];
  const picker = document.getElementById('bookIconPicker');
  selectedBookIcon = '📒';
  picker.innerHTML = icons.map(i => `
    <button class="book-icon-option" data-icon="${i}" style="width:40px;height:40px;border-radius:8px;border:2px solid ${i === '📒' ? 'var(--primary)' : 'var(--border)'};font-size:20px;background:var(--card);">${i}</button>
  `).join('');
  picker.querySelectorAll('.book-icon-option').forEach(btn => {
    btn.addEventListener('click', () => {
      picker.querySelectorAll('.book-icon-option').forEach(b => b.style.borderColor = 'var(--border)');
      btn.style.borderColor = 'var(--primary)';
      selectedBookIcon = btn.dataset.icon;
    });
  });
  document.getElementById('newBookName').value = '';
  document.getElementById('newBookModal').classList.add('show');
}

window.createBook = async function() {
  const name = document.getElementById('newBookName').value.trim();
  if (!name) return showToast('请输入账本名称');
  const type = document.getElementById('newBookType').value;

  const book = await request('/books', {
    method: 'POST',
    body: JSON.stringify({ name, cover_icon: selectedBookIcon, type })
  });

  state.books.push({ id: book.id, name, cover_icon: selectedBookIcon, type, record_count: 0 });
  document.getElementById('newBookModal').classList.remove('show');
  await switchBook(book.id);
  renderBookDropdown();
  showToast('账本创建成功');
};

function bindEvents() {
  document.getElementById('bookSwitcher').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('bookDropdown').classList.toggle('show');
  });

  document.addEventListener('click', () => {
    document.getElementById('bookDropdown').classList.remove('show');
  });

  document.getElementById('profileSettingsBtn').addEventListener('click', () => {
    document.getElementById('settingsSheet').classList.add('show');
    document.getElementById('settingsSheetMask').classList.add('show');
  });

  document.getElementById('themeMenu').addEventListener('click', () => {
    toggleTheme();
    document.getElementById('themeText').textContent = state.theme === 'dark' ? '开启' : '关闭';
  });

  document.getElementById('exportCsvBtn').addEventListener('click', () => {
    const url = `${API}/export/csv?book_id=${state.currentBook}`;
    fetch(url, { headers: { 'Authorization': `Bearer ${state.token}` } })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ledger-${state.currentMonth}.csv`;
        a.click();
        showToast('CSV已下载');
      });
  });

  document.getElementById('exportJsonBtn').addEventListener('click', () => {
    const url = `${API}/export/json?book_id=${state.currentBook}`;
    fetch(url, { headers: { 'Authorization': `Bearer ${state.token}` } })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ledger-backup-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        showToast('备份已下载');
      });
  });

  document.getElementById('inviteBtn').addEventListener('click', () => {
    document.getElementById('inviteUsername').value = '';
    document.getElementById('inviteModal').classList.add('show');
  });

  document.getElementById('logoutBtn').addEventListener('click', logout);

  document.getElementById('aiSettingsBtn').addEventListener('click', openAISettingsModal);

  document.getElementById('syncCatsBtn').addEventListener('click', syncCategories);

  document.getElementById('changePwdBtn').addEventListener('click', () => {
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    document.getElementById('changePwdModal').classList.add('show');
  });

  document.getElementById('contactBtn').addEventListener('click', () => {
    document.getElementById('contactModal').classList.add('show');
  });

  document.getElementById('versionBtn').addEventListener('click', openVersionModal);

  document.getElementById('feedbackBtn').addEventListener('click', openFeedbackModal);

  const noticeAdminBtn = document.getElementById('noticeAdminBtn');
  if (noticeAdminBtn) noticeAdminBtn.addEventListener('click', openNoticeAdminModal);

  document.querySelectorAll('.feedback-tab').forEach(tab => {
    tab.addEventListener('click', () => switchFeedbackTab(tab.dataset.tab));
  });

  // 反馈类型单选切换
  document.querySelectorAll('.feedback-type-option input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.querySelectorAll('.feedback-type-option').forEach(opt => opt.classList.remove('active'));
      radio.closest('.feedback-type-option').classList.add('active');
    });
  });

  const contentEl = document.getElementById('feedbackContent');
  if (contentEl) {
    contentEl.addEventListener('input', () => {
      document.getElementById('feedbackCharCount').textContent = contentEl.value.length;
    });
  }
}

function openFeedbackModal() {
  // 重置到提交tab
  switchFeedbackTab('submit');
  document.getElementById('feedbackContent').value = '';
  document.getElementById('feedbackContact').value = '';
  document.getElementById('feedbackCharCount').textContent = '0';
  document.querySelectorAll('.feedback-type-option').forEach(opt => opt.classList.remove('active'));
  const bugRadio = document.querySelector('input[name="feedbackType"][value="bug"]');
  bugRadio.checked = true;
  bugRadio.closest('.feedback-type-option').classList.add('active');
  document.getElementById('feedbackModal').classList.add('show');
}

function switchFeedbackTab(tab) {
  document.querySelectorAll('.feedback-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  document.getElementById('feedbackSubmitPanel').style.display = tab === 'submit' ? '' : 'none';
  document.getElementById('feedbackHistoryPanel').style.display = tab === 'history' ? '' : 'none';
  if (tab === 'history') {
    loadFeedbackHistory();
  }
}

window.submitFeedback = async function() {
  const type = document.querySelector('input[name="feedbackType"]:checked').value;
  const content = document.getElementById('feedbackContent').value.trim();
  const contact = document.getElementById('feedbackContact').value.trim();

  if (!content) return showToast('请填写反馈内容');
  if (content.length > 2000) return showToast('反馈内容不能超过2000字');

  try {
    await request('/feedback', {
      method: 'POST',
      body: JSON.stringify({ type, content, contact })
    });
    showToast('反馈已提交，感谢您的建议！');
    document.getElementById('feedbackModal').classList.remove('show');
  } catch (e) {}
};

async function loadFeedbackHistory() {
  const listEl = document.getElementById('feedbackHistoryList');
  listEl.innerHTML = '<div class="feedback-loading">加载中...</div>';

  try {
    const list = await request('/feedback');
    if (!list || list.length === 0) {
      listEl.innerHTML = '<div class="feedback-empty"><div class="emoji">📭</div><p>暂无反馈记录</p></div>';
      return;
    }

    const typeMap = { bug: '🐛 缺陷', suggestion: '💡 建议', other: '📝 其他' };
    const statusMap = {
      pending: { text: '待处理', cls: 'pending' },
      processing: { text: '处理中', cls: 'processing' },
      resolved: { text: '已处理', cls: 'resolved' }
    };

    listEl.innerHTML = list.map(f => {
      const status = statusMap[f.status] || statusMap.pending;
      return `
        <div class="feedback-item">
          <div class="feedback-item-header">
            <span class="feedback-item-type">${typeMap[f.type] || f.type}</span>
            <span class="feedback-item-status ${status.cls}">${status.text}</span>
          </div>
          <div class="feedback-item-content">${esc(f.content)}</div>
          ${f.admin_reply ? `
            <div class="feedback-reply">
              <div class="feedback-reply-label">管理员回复：</div>
              <div class="feedback-reply-content">${esc(f.admin_reply)}</div>
            </div>
          ` : ''}
          <div class="feedback-item-date">${formatFeedbackDate(f.created_at)}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="feedback-empty"><p>加载失败，请稍后重试</p></div>';
  }
}

function formatFeedbackDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function syncCategories() {
  showToast('正在同步分类...');
  try {
    const result = await request('/settings/sync-categories', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook })
    });
    await loadCategories();
    if (result.added > 0) {
      showToast(`同步成功，新增${result.added}个分类`);
    } else {
      showToast('分类已是最新，无需更新');
    }
  } catch (e) {}
}

async function openAISettingsModal() {
  try {
    const config = await request('/settings/ai');
    document.getElementById('aiEnabled').checked = config.ai_enabled;
    document.getElementById('aiApiUrl').value = config.ai_api_url || 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    document.getElementById('aiModel').value = config.ai_model || 'glm-4-flash';
    document.getElementById('aiVisionModel').value = config.ai_vision_model || 'glm-4v-flash';
    document.getElementById('aiApiKey').value = '';
    document.getElementById('aiKeyHint').textContent = config.ai_api_key_masked
      ? `当前Key: ${config.ai_api_key_masked}（留空则不修改）`
      : '尚未配置API Key';
    document.getElementById('aiSettingsModal').classList.add('show');
  } catch (e) {}
}

window.saveAISettings = async function() {
  const body = {
    ai_enabled: document.getElementById('aiEnabled').checked,
    ai_api_url: document.getElementById('aiApiUrl').value.trim(),
    ai_model: document.getElementById('aiModel').value.trim(),
    ai_vision_model: document.getElementById('aiVisionModel').value.trim()
  };
  const newKey = document.getElementById('aiApiKey').value.trim();
  if (newKey) body.ai_api_key = newKey;

  try {
    await request('/settings/ai', { method: 'PUT', body: JSON.stringify(body) });
    showToast('AI设置已保存');
    document.getElementById('aiSettingsModal').classList.remove('show');
    loadAIConfigStatus();
  } catch (e) {}
};

window.sendInvite = async function() {
  const username = document.getElementById('inviteUsername').value.trim();
  const role = document.getElementById('inviteRole').value;
  if (!username) return showToast('请输入用户名');

  try {
    await request(`/books/${state.currentBook}/invite`, {
      method: 'POST',
      body: JSON.stringify({ username, role })
    });
    showToast('邀请成功');
    document.getElementById('inviteModal').classList.remove('show');
  } catch (e) {}
};

window.changePassword = async function() {
  const oldPwd = document.getElementById('oldPassword').value;
  const newPwd = document.getElementById('newPassword').value;
  const confirmPwd = document.getElementById('confirmPassword').value;

  if (!oldPwd) return showToast('请输入原密码');
  if (!newPwd) return showToast('请输入新密码');
  if (newPwd.length < 6) return showToast('新密码长度不能少于6位');
  if (newPwd !== confirmPwd) return showToast('两次输入的新密码不一致');

  try {
    await request('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldPwd, new_password: newPwd })
    });
    showToast('密码修改成功，请重新登录');
    document.getElementById('changePwdModal').classList.remove('show');
    setTimeout(() => logout(), 1000);
  } catch (e) {}
};

// ===== 公告管理（管理员） =====
let editingNoticeId = null;

window.openNoticeAdminModal = function() {
  document.getElementById('noticeAdminEditorPanel').style.display = 'none';
  document.getElementById('noticeAdminListPanel').style.display = '';
  document.getElementById('noticeAdminModal').classList.add('show');
  loadNoticeAdminList();
};

async function loadNoticeAdminList() {
  const listEl = document.getElementById('noticeAdminList');
  listEl.innerHTML = '<div class="feedback-loading">加载中...</div>';
  try {
    const data = await request('/notice/admin/list?page=1&page_size=50');
    if (!data.list || data.list.length === 0) {
      listEl.innerHTML = '<div class="feedback-empty"><p>暂无公告</p></div>';
      return;
    }
    listEl.innerHTML = data.list.map(n => `
      <div class="notice-admin-item">
        <div class="notice-admin-info">
          <div class="notice-admin-title">${esc(n.notice_title)}</div>
          <div class="notice-admin-meta">
            <span class="notice-tag">${n.notice_type === '2' ? '公告' : '通知'}</span>
            ${n.is_popup == 1 ? '<span class="notice-tag notice-tag-popup">弹窗</span>' : ''}
            <span class="notice-status-tag notice-status-${n.status}">${n.status === '0' ? '已发布' : '草稿'}</span>
            <span>${formatFeedbackDate(n.created_at)}</span>
          </div>
        </div>
        <div class="notice-admin-actions">
          <button onclick="showNoticeEditor('${n.id}')">编辑</button>
          <button class="del" onclick="deleteNoticeAdmin('${n.id}')">删除</button>
        </div>
      </div>
    `).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="feedback-empty"><p>加载失败</p></div>';
  }
}

window.showNoticeEditor = async function(id) {
  editingNoticeId = id || null;
  document.getElementById('noticeAdminListPanel').style.display = 'none';
  document.getElementById('noticeAdminEditorPanel').style.display = '';
  if (id) {
    try {
      const n = await request(`/notice/admin/${id}`);
      document.getElementById('noticeEditTitle').value = n.notice_title;
      document.getElementById('noticeEditType').value = n.notice_type;
      document.getElementById('noticeEditStatus').value = n.status;
      document.getElementById('noticeEditPopup').checked = n.is_popup == 1;
      document.getElementById('noticeEditContent').value = n.notice_content;
    } catch (e) {}
  } else {
    document.getElementById('noticeEditTitle').value = '';
    document.getElementById('noticeEditType').value = '1';
    document.getElementById('noticeEditStatus').value = '0';
    document.getElementById('noticeEditPopup').checked = false;
    document.getElementById('noticeEditContent').value = '';
  }
};

window.backToNoticeAdminList = function() {
  document.getElementById('noticeAdminEditorPanel').style.display = 'none';
  document.getElementById('noticeAdminListPanel').style.display = '';
  loadNoticeAdminList();
};

window.saveNoticeAdmin = async function() {
  const title = document.getElementById('noticeEditTitle').value.trim();
  const content = document.getElementById('noticeEditContent').value.trim();
  const notice_type = document.getElementById('noticeEditType').value;
  const status = document.getElementById('noticeEditStatus').value;
  const is_popup = document.getElementById('noticeEditPopup').checked ? 1 : 0;

  if (!title) return showToast('请填写公告标题');
  if (title.length > 100) return showToast('标题不能超过100字');
  if (!content) return showToast('请填写公告内容');

  try {
    if (editingNoticeId) {
      await request(`/notice/admin/${editingNoticeId}`, {
        method: 'PUT',
        body: JSON.stringify({ notice_title: title, notice_content: content, notice_type, status, is_popup })
      });
    } else {
      await request('/notice/admin', {
        method: 'POST',
        body: JSON.stringify({ notice_title: title, notice_content: content, notice_type, status, is_popup })
      });
    }
    showToast('保存成功');
    backToNoticeAdminList();
    refreshUnreadCount();
  } catch (e) {}
};

window.deleteNoticeAdmin = async function(id) {
  if (!confirm('确定删除该公告吗？')) return;
  try {
    await request(`/notice/admin/${id}`, { method: 'DELETE' });
    showToast('已删除');
    loadNoticeAdminList();
    refreshUnreadCount();
  } catch (e) {}
};

// ===== 版本记录 =====
async function openVersionModal() {
  document.getElementById('versionModal').classList.add('show');
  const listEl = document.getElementById('versionList');
  if (listEl.dataset.loaded) return; // 已加载，无需重复请求
  listEl.innerHTML = '<div class="version-loading">加载中...</div>';
  try {
    const list = await request('/version');
    if (!list || list.length === 0) {
      listEl.innerHTML = '<div class="version-loading">暂无版本记录</div>';
      return;
    }
    listEl.innerHTML = list.map(v => `
      <div class="version-item">
        <div class="version-header">
          <span class="version-tag">${esc(v.version)}</span>
          ${v.title ? `<span class="version-title">${esc(v.title)}</span>` : ''}
          <span class="version-date">${v.release_date ? String(v.release_date).slice(0, 10) : ''}</span>
        </div>
        <div class="version-content">${esc(v.content)}</div>
      </div>
    `).join('');
    listEl.dataset.loaded = '1';
  } catch (e) {
    listEl.innerHTML = '<div class="version-loading">加载失败，请稍后重试</div>';
  }
}

