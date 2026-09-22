/**
 * 个人资料页面逻辑 - pc-my-profile.js
 */

async function pageInit() {
  renderPCTopbar('设置');
  loadUserInfo();
  await Promise.all([loadStats(), loadVersions()]);
  bindForms();
}

// 从 state 加载并渲染用户基本信息
function loadUserInfo() {
  const user = state.user || {};
  document.getElementById('fieldUsername').value = user.username || '';
  document.getElementById('fieldNickname').value = user.nickname || '';
  document.getElementById('fieldEmail').value = user.email || '';

  document.getElementById('profileNickname').textContent = user.nickname || user.username || '--';
  document.getElementById('profileUsername').textContent = '@' + (user.username || '');
  const isAdmin = localStorage.getItem('isAdmin') === 'true';
  document.getElementById('profileRole').textContent = isAdmin ? '教务处管理员' : '学生';

  // 用昵称首字作为头像
  const name = user.nickname || user.username || '?';
  document.getElementById('profileAvatar').textContent = name.charAt(0).toUpperCase();
}

// 加载统计数据
async function loadStats() {
  try {
    // 历史评测总数 & 平均分
    const histData = await request('/edu/assessment/history?page=1&page_size=1');
    document.getElementById('statSessions').textContent = histData.total || 0;

    // 学科数（profile summary）
    const summaries = await request('/edu/profile/summary');
    const activeSubjects = summaries.filter(s => s.assessed_count > 0).length;
    document.getElementById('statSubjects').textContent = activeSubjects;

    // 近期评测平均分（取最近10条）
    if (histData.total > 0) {
      const recent = await request('/edu/assessment/history?page=1&page_size=10');
      const completed = recent.list.filter(s => s.status === 'completed' && s.score != null);
      if (completed.length > 0) {
        const avg = completed.reduce((sum, s) => sum + parseFloat(s.score), 0) / completed.length;
        document.getElementById('statAvgScore').textContent = avg.toFixed(1);
      } else {
        document.getElementById('statAvgScore').textContent = '--';
      }
    } else {
      document.getElementById('statAvgScore').textContent = '--';
    }
  } catch (e) {
    // 统计加载失败不影响页面
  }
}

// 绑定表单事件
function bindForms() {
  // 保存基本信息
  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const nickname = document.getElementById('fieldNickname').value.trim();
    const email = document.getElementById('fieldEmail').value.trim();

    if (!nickname) {
      showToast('昵称不能为空');
      return;
    }

    const btn = document.getElementById('saveProfileBtn');
    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
      const data = await request('/auth/me', {
        method: 'PUT',
        body: JSON.stringify({ nickname, email })
      });
      // 更新本地 state
      state.user = { ...state.user, nickname, email };
      localStorage.setItem('ledger_user', JSON.stringify(state.user));
      loadUserInfo();
      showToast('资料已保存');
    } catch (err) {
      // 错误已由 request 函数处理
    } finally {
      btn.disabled = false;
      btn.textContent = '保存修改';
    }
  });

  // 修改密码
  document.getElementById('passwordForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPwd = document.getElementById('fieldOldPassword').value;
    const newPwd = document.getElementById('fieldNewPassword').value;
    const confirmPwd = document.getElementById('fieldConfirmPassword').value;

    if (!oldPwd || !newPwd || !confirmPwd) {
      showToast('请填写所有密码字段');
      return;
    }
    if (newPwd.length < 6) {
      showToast('新密码至少需要6位字符');
      return;
    }
    if (newPwd !== confirmPwd) {
      showToast('两次输入的新密码不一致');
      return;
    }

    const btn = document.getElementById('savePasswordBtn');
    btn.disabled = true;
    btn.textContent = '更新中...';

    try {
      await request('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd })
      });
      showToast('密码已更新，请重新登录');
      document.getElementById('passwordForm').reset();
      // 延迟后跳到登录页
      setTimeout(() => {
        localStorage.removeItem('ledger_token');
        localStorage.removeItem('ledger_user');
        window.location.href = '/pc/login.html';
      }, 1500);
    } catch (err) {
      // 错误已由 request 函数处理
    } finally {
      btn.disabled = false;
      btn.textContent = '更新密码';
    }
  });
}

// 退出登录
async function handleLogout() {
  const ok = await showConfirm({ title: '退出登录', message: '确定要退出登录吗？', variant: 'warning', okText: '退出' });
  if (!ok) return;
  localStorage.removeItem('ledger_token');
  localStorage.removeItem('ledger_user');
  localStorage.removeItem('ledger_book');
  state.token = null;
  state.user = null;
  window.location.href = '/pc/login.html';
}

// 加载版本发布记录
async function loadVersions() {
  const container = document.getElementById('versionList');
  if (!container) return;
  try {
    const list = await request('/version');
    if (!list || list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无版本记录</div>';
      return;
    }
    container.innerHTML = list.map(v => {
      const lines = (v.content || '').split('\n').filter(l => l.trim());
      const itemsHtml = lines.map(l => `
        <div style="display:flex;align-items:flex-start;gap:6px;font-size:13px;color:var(--text-secondary);line-height:1.6;">
          <span style="color:var(--primary);flex-shrink:0;">•</span>
          <span>${esc(l.trim())}</span>
        </div>`).join('');
      return `
        <div style="border-left:3px solid var(--primary);padding-left:12px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:700;color:var(--text-primary);">${esc(v.version)}</span>
            ${v.title ? `<span style="font-size:12px;color:var(--text-secondary);">${esc(v.title)}</span>` : ''}
            <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${esc(v.release_date ? String(v.release_date).slice(0,10) : '')}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">${itemsHtml}</div>
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">版本记录加载失败</div>';
  }
}
