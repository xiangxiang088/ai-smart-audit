/**
 * pc-admin.js - 后台管理页面逻辑
 * 审计项目全局管理 / 通知公告 / 用户 / 角色 / 菜单 / 字典
 */

// ===== 页面初始化 =====
async function pageInit() {
  // 管理员权限检查
  if (localStorage.getItem('isAdmin') !== 'true') {
    document.querySelector('.pc-content').innerHTML =
      '<div style="text-align:center;padding:80px 20px;"><div style="font-size:48px;">🔒</div><div style="font-size:18px;margin-top:12px;color:var(--text-secondary);">无权访问，仅管理员可用</div><a href="/pc/index.html" class="pc-btn pc-btn-primary" style="margin-top:20px;display:inline-block;">返回首页</a></div>';
    return;
  }
  renderPCTopbar('⚙️ 后台管理');
  applyToolbarPerms();
  document.getElementById('adminProjectKeyword').addEventListener('keydown', e => {
    if (e.key === 'Enter') loadAdminProjects();
  });
  await loadAdminProjects();
}

// 根据权限控制工具栏静态按钮的显示/隐藏
function applyToolbarPerms() {
  const rules = [
    ['btnNoticeAdd',   'notice:add'],
    ['btnUserAdd',     'user:add'],
    ['btnRoleAdd',     'role:add'],
    ['btnMenuAdd',     'menu:add'],
  ];
  rules.forEach(([id, perm]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = hasPerm(perm) ? '' : 'none';
  });
}

// ===== Tab 切换 =====
const ADMIN_TABS = ['audit-projects', 'notices', 'users', 'roles', 'menus', 'dict'];

function switchAdminTab(tabName) {
  document.querySelectorAll('.admin-tab').forEach((btn, i) => {
    btn.classList.toggle('active', ADMIN_TABS[i] === tabName);
  });
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + tabName).classList.remove('hidden');

  if (tabName === 'audit-projects') loadAdminProjects();
  if (tabName === 'notices') loadAdminNotices(1);
  if (tabName === 'users') loadAdminUsers(1);
  if (tabName === 'roles') loadAdminRoles();
  if (tabName === 'menus') loadAdminMenus();
  if (tabName === 'dict') loadAdminDict();
}

// ===== ==================== =====
// ===== 审计项目全局管理 =====
// ===== ==================== =====

let _adminProjects = [];

const ADMIN_AUDIT_TYPE_LABELS = { cost: '造价/结算审计' };

async function loadAdminProjects() {
  const wrap = document.getElementById('adminProjectWrap');
  const keyword = (document.getElementById('adminProjectKeyword')?.value || '').trim();
  if (wrap) wrap.innerHTML = '<div class="admin-empty">加载中...</div>';
  try {
    _adminProjects = await request('/audit/projects' + (keyword ? '?keyword=' + encodeURIComponent(keyword) : ''));
    renderAdminProjectTable(_adminProjects);
  } catch (e) {
    if (wrap) wrap.innerHTML = '<div class="admin-empty">加载失败，请刷新重试</div>';
  }
}

function renderAdminProjectTable(list) {
  const wrap = document.getElementById('adminProjectWrap');
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = '<div class="admin-empty">暂无审计项目，点击「+ 新增项目」添加</div>';
    return;
  }
  wrap.innerHTML = `
    <div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th>项目名称</th>
          <th>审计类型</th>
          <th>所属用户</th>
          <th>资料（已解析/总数）</th>
          <th>疑点</th>
          <th>状态</th>
          <th>更新时间</th>
          <th style="text-align:center;">操作</th>
        </tr>
      </thead>
      <tbody>
        ${list.map((p, i) => `
          <tr>
            <td style="max-width:220px;">
              <div class="admin-q-content" title="${esc(p.project_name)}">${esc(p.project_name)}</div>
              ${p.project_code ? `<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(p.project_code)}</div>` : ''}
            </td>
            <td><span class="admin-type-badge">${ADMIN_AUDIT_TYPE_LABELS[p.audit_type] || esc(p.audit_type || '')}</span></td>
            <td style="font-size:13px;">${esc(p.owner_nickname || p.owner_username || '-')}</td>
            <td>${Number(p.parsed_count) || 0} / ${Number(p.doc_count) || 0}</td>
            <td>${Number(p.finding_count) || 0}</td>
            <td><span class="admin-type-badge ${Number(p.status) ? 'type-single' : ''}">${Number(p.status) ? '已完成' : '进行中'}</span></td>
            <td style="font-size:12px;color:var(--text-secondary);">${esc(String(p.updated_at || '').slice(0, 10))}</td>
            <td>
              <div class="admin-action-btns">
                <button class="admin-btn-icon edit" onclick="openAdminProjectModal(${i})">✏️ 编辑</button>
                <button class="admin-btn-icon" style="background:#0891b2;color:#fff;" onclick="enterAdminProject(${i})">📂 进入</button>
                <button class="admin-btn-icon" style="background:${Number(p.status) ? '#d97706' : '#059669'};color:#fff;" onclick="toggleAdminProjectStatus(${i})">${Number(p.status) ? '↩️ 重开' : '✅ 完成'}</button>
                <button class="admin-btn-icon del" onclick="deleteAdminProject(${i})">🗑️ 删除</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function openAdminProjectModal(idx) {
  // idx 为 null/undefined 时表示新增
  const p = (typeof idx === 'number') ? _adminProjects[idx] : null;
  document.getElementById('adminProjectModalTitle').textContent = p ? '编辑项目' : '新增项目';
  document.getElementById('apId').value = p ? String(p.id) : '';
  document.getElementById('apName').value = p ? (p.project_name || '') : '';
  document.getElementById('apCode').value = p ? (p.project_code || '') : '';
  document.getElementById('apType').value = p ? (p.audit_type || 'cost') : 'cost';
  document.getElementById('apPeriod').value = p ? (p.audit_period || '') : '';
  document.getElementById('apDesc').value = p ? (p.description || '') : '';
  document.getElementById('apStatus').value = p ? String(p.status ?? 0) : '0';
  document.getElementById('apStatusRow').style.display = p ? '' : 'none';
  document.getElementById('adminProjectModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('apName').focus(), 50);
}

function closeAdminProjectModal() {
  document.getElementById('adminProjectModal').classList.add('hidden');
}

async function saveAdminProject() {
  const id = document.getElementById('apId').value;
  const body = {
    project_name: document.getElementById('apName').value.trim(),
    project_code: document.getElementById('apCode').value.trim() || null,
    audit_type: document.getElementById('apType').value,
    audit_period: document.getElementById('apPeriod').value.trim() || null,
    description: document.getElementById('apDesc').value.trim() || null,
  };
  if (!body.project_name) { showToast('项目名称不能为空', 'error'); return; }
  if (id) body.status = Number(document.getElementById('apStatus').value);
  try {
    if (id) {
      await request('/audit/projects/' + id, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await request('/audit/projects', { method: 'POST', body: JSON.stringify(body) });
    }
    showToast('保存成功');
    closeAdminProjectModal();
    loadAdminProjects();
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function toggleAdminProjectStatus(idx) {
  const p = _adminProjects[idx];
  if (!p) return;
  const toDone = Number(p.status) === 0;
  if (toDone) {
    const ok = await showConfirm({
      title: '标记为已完成',
      message: `确认将项目「${p.project_name}」标记为已完成？`,
      variant: 'info',
      okText: '确认完成'
    });
    if (!ok) return;
  }
  try {
    await request('/audit/projects/' + p.id, {
      method: 'PUT',
      body: JSON.stringify({ status: toDone ? 1 : 0 })
    });
    showToast(toDone ? '项目已完成' : '项目已重新打开');
    loadAdminProjects();
  } catch (e) {
    showToast(e.message || '操作失败', 'error');
  }
}

async function deleteAdminProject(idx) {
  const p = _adminProjects[idx];
  if (!p) return;
  const ok = await showConfirm({
    title: '删除审计项目',
    message: `确认删除项目「${p.project_name}」？将同时软删除其全部资料与要素，此操作不可恢复。`,
    variant: 'danger',
    okText: '删除'
  });
  if (!ok) return;
  try {
    await request('/audit/projects/' + p.id, { method: 'DELETE' });
    showToast('项目已删除');
    loadAdminProjects();
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}

function enterAdminProject(idx) {
  const p = _adminProjects[idx];
  if (!p) return;
  setAuditProject(p.id);
  location.href = '/pc/audit-documents.html?id=' + encodeURIComponent(p.id);
}

// ===== ==================== =====
// ===== 通知公告管理 =====
// ===== ==================== =====

let _noticePage = 1;
let _noticeTotal = 0;
const _noticePageSize = 20;

const NOTICE_TYPE_LABELS  = { '1': '通知', '2': '公告' };
const NOTICE_STATUS_LABELS = { '0': '已发布', '1': '草稿' };

async function loadAdminNotices(page) {
  _noticePage = page || 1;
  const wrap = document.getElementById('noticeTableWrap');
  const status = document.getElementById('noticeFilterStatus').value;
  const noticeType = document.getElementById('noticeFilterType').value;

  let url = `/notice/admin/list?page=${_noticePage}&page_size=${_noticePageSize}`;
  if (status !== '') url += `&status=${status}`;
  if (noticeType !== '') url += `&notice_type=${noticeType}`;

  try {
    const data = await request(url);
    _noticeTotal = data.total || 0;
    renderNoticeTable(data.list || []);
    renderNoticePagination();
  } catch (e) {
    if (wrap) wrap.innerHTML = '<div class="admin-empty">加载失败，请刷新重试</div>';
  }
}

function renderNoticeTable(list) {
  const wrap = document.getElementById('noticeTableWrap');
  if (!wrap) return;
  if (list.length === 0) {
    wrap.innerHTML = '<div class="admin-empty">暂无公告，点击"新增公告"添加</div>';
    return;
  }
  wrap.innerHTML = `
    <div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th>标题</th>
          <th>类型</th>
          <th>状态</th>
          <th>弹窗</th>
          <th>发布时间</th>
          <th style="text-align:center;">操作</th>
        </tr>
      </thead>
      <tbody>
        ${list.map(n => `
          <tr>
            <td style="max-width:260px;"><div class="admin-q-content" title="${esc(n.notice_title)}">${esc(n.notice_title)}</div></td>
            <td><span class="admin-type-badge">${NOTICE_TYPE_LABELS[n.notice_type] || n.notice_type}</span></td>
            <td><span class="admin-type-badge ${n.status === '0' ? 'type-single' : ''}">${NOTICE_STATUS_LABELS[n.status] || n.status}</span></td>
            <td>${n.is_popup ? '🔔 是' : '否'}</td>
            <td style="font-size:12px;color:var(--text-secondary);">${esc(n.created_at ? String(n.created_at).slice(0,10) : '')}</td>
            <td>
              <div class="admin-action-btns">
                ${hasPerm('notice:edit')   ? `<button class="admin-btn-icon edit" onclick="openNoticeAdminModal('${esc(String(n.id))}')">✏️ 编辑</button>` : ''}
                ${hasPerm('notice:delete') ? `<button class="admin-btn-icon del" onclick="deleteNoticeAdmin('${esc(String(n.id))}')">🗑️ 删除</button>` : ''}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderNoticePagination() {
  const el = document.getElementById('noticePagination');
  if (!el) return;
  const totalPages = Math.ceil(_noticeTotal / _noticePageSize) || 1;
  el.innerHTML = `
    <span>共 ${_noticeTotal} 条</span>
    <button class="admin-page-btn" onclick="loadAdminNotices(${_noticePage - 1})" ${_noticePage <= 1 ? 'disabled' : ''}>‹ 上一页</button>
    <span>第 ${_noticePage} / ${totalPages} 页</span>
    <button class="admin-page-btn" onclick="loadAdminNotices(${_noticePage + 1})" ${_noticePage >= totalPages ? 'disabled' : ''}>下一页 ›</button>
  `;
}

async function openNoticeAdminModal(id) {
  document.getElementById('noticeAdminId').value = id || '';
  document.getElementById('noticeAdminModalTitle').textContent = id ? '编辑公告' : '新增公告';
  document.getElementById('noticeAdminTitle').value = '';
  document.getElementById('noticeAdminType').value = '1';
  document.getElementById('noticeAdminStatus').value = '0';
  document.getElementById('noticeAdminPopup').value = '0';
  document.getElementById('noticeAdminContent').value = '';

  if (id) {
    try {
      const n = await request(`/notice/admin/${id}`);
      document.getElementById('noticeAdminTitle').value = n.notice_title || '';
      document.getElementById('noticeAdminType').value = n.notice_type || '1';
      document.getElementById('noticeAdminStatus').value = n.status || '0';
      document.getElementById('noticeAdminPopup').value = n.is_popup ? '1' : '0';
      document.getElementById('noticeAdminContent').value = n.notice_content || '';
    } catch (e) {
      showToast('加载公告失败', 'error');
      return;
    }
  }

  document.getElementById('noticeAdminModal').classList.remove('hidden');
}

function closeNoticeAdminModal() {
  document.getElementById('noticeAdminModal').classList.add('hidden');
}

async function saveNoticeAdmin() {
  const id = document.getElementById('noticeAdminId').value;
  const body = {
    notice_title: document.getElementById('noticeAdminTitle').value.trim(),
    notice_type: document.getElementById('noticeAdminType').value,
    status: document.getElementById('noticeAdminStatus').value,
    is_popup: document.getElementById('noticeAdminPopup').value === '1' ? 1 : 0,
    notice_content: document.getElementById('noticeAdminContent').value.trim(),
  };

  if (!body.notice_title) { showToast('标题不能为空', 'error'); return; }
  if (!body.notice_content) { showToast('内容不能为空', 'error'); return; }

  try {
    if (id) {
      await request(`/notice/admin/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('公告已更新');
    } else {
      await request('/notice/admin', { method: 'POST', body: JSON.stringify(body) });
      showToast('公告已发布');
    }
    closeNoticeAdminModal();
    loadAdminNotices(_noticePage);
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function deleteNoticeAdmin(id) {
  const ok = await showConfirm({ title: '删除公告', message: '确认删除此公告？删除后不可恢复。', variant: 'danger', okText: '删除' });
  if (!ok) return;
  try {
    await request(`/notice/admin/${id}`, { method: 'DELETE' });
    showToast('公告已删除');
    loadAdminNotices(_noticePage);
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}

// ===================================================================
// ===== 用户管理 =====
// ===================================================================
let _userPage = 1;
let _userTotal = 0;
const _userPageSize = 20;
let _allRoles = [];      // 全部角色缓存
let _userListCache = []; // 当前页用户数据缓存（按 index 传参，避免 HTML 注入）

async function loadAdminUsers(page) {
  _userPage = page || 1;
  const wrap = document.getElementById('userTableWrap');
  if (wrap) wrap.innerHTML = '<div class="admin-empty">加载中...</div>';

  const keyword = (document.getElementById('userKeyword')?.value || '').trim();
  let url = `/admin/users?page=${_userPage}&page_size=${_userPageSize}`;
  if (keyword) url += `&keyword=${encodeURIComponent(keyword)}`;

  try {
    const data = await request(url);
    _userTotal = data.total || 0;
    _userListCache = data.list || [];
    renderUserTable(_userListCache);
    renderUserPagination();
  } catch (e) {
    if (wrap) wrap.innerHTML = '<div class="admin-empty">加载失败，请刷新重试</div>';
  }
}

function renderUserTable(list) {
  const wrap = document.getElementById('userTableWrap');
  if (!wrap) return;
  if (list.length === 0) {
    wrap.innerHTML = '<div class="admin-empty">暂无用户数据</div>';
    return;
  }
  const myId = localStorage.getItem('userId') || '';
  wrap.innerHTML = `
    <div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th>用户名</th>
          <th>昵称</th>
          <th>邮箱</th>
          <th>角色</th>
          <th>注册时间</th>
          <th style="text-align:center;">操作</th>
        </tr>
      </thead>
      <tbody>
        ${list.map((u, i) => `
          <tr>
            <td>${esc(u.username)}</td>
            <td>${esc(u.nickname || '-')}</td>
            <td style="font-size:12px;">${esc(u.email || '-')}</td>
            <td>${(u.role_names || []).map(r => `<span class="admin-role-badge">${esc(r)}</span>`).join(' ') || '<span style="color:var(--text-muted);font-size:12px;">未分配</span>'}</td>
            <td style="font-size:12px;color:var(--text-secondary);">${esc(String(u.created_at || '').slice(0,10))}</td>
            <td>
              <div class="admin-action-btns">
                ${hasPerm('user:edit')         ? `<button class="admin-btn-icon edit" onclick="openUserEditModal(${i})">✏️ 编辑</button>` : ''}
                ${(!u.is_admin && hasPerm('user:assign_roles'))  ? `<button class="admin-btn-icon" style="background:#7c3aed;color:#fff;" onclick="openUserRoleModal(${i})">🎭 角色</button>` : ''}
                ${(!u.is_admin && hasPerm('user:reset_password'))? `<button class="admin-btn-icon" style="background:#d97706;color:#fff;" onclick="resetUserPassword(${i})">🔑 重置密码</button>` : ''}
                ${(!u.is_admin && hasPerm('user:delete'))        ? `<button class="admin-btn-icon del" onclick="deleteAdminUser(${i})">🗑️ 删除</button>` : ''}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function renderUserPagination() {
  const el = document.getElementById('userPagination');
  if (!el) return;
  const totalPages = Math.ceil(_userTotal / _userPageSize) || 1;
  el.innerHTML = `
    <span>共 ${_userTotal} 条</span>
    <button class="admin-page-btn" onclick="loadAdminUsers(${_userPage - 1})" ${_userPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>
    <span>第 ${_userPage} / ${totalPages} 页</span>
    <button class="admin-page-btn" onclick="loadAdminUsers(${_userPage + 1})" ${_userPage >= totalPages ? 'disabled' : ''}>下一页 ›</button>
  `;
}

function openUserEditModal(idx) {
  const u = _userListCache[idx];
  if (!u) return;
  document.getElementById('userEditId').value = String(u.id);
  document.getElementById('userEditUsername').textContent = u.username;
  document.getElementById('userEditNickname').value = u.nickname || '';
  document.getElementById('userEditEmail').value = u.email || '';
  document.getElementById('userEditModal').classList.remove('hidden');
}

function closeUserEditModal() {
  document.getElementById('userEditModal').classList.add('hidden');
}

function openCreateUserModal() {
  document.getElementById('createUserUsername').value = '';
  document.getElementById('createUserNickname').value = '';
  document.getElementById('createUserPassword').value = '';
  document.getElementById('createUserModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('createUserUsername').focus(), 50);
}

function closeCreateUserModal() {
  document.getElementById('createUserModal').classList.add('hidden');
}

async function saveCreateUser() {
  const username = document.getElementById('createUserUsername').value.trim();
  const nickname = document.getElementById('createUserNickname').value.trim();
  const password = document.getElementById('createUserPassword').value;
  if (!username) { showToast('用户名不能为空', 'error'); return; }
  if (!password || password.length < 6) { showToast('密码不能少于6位', 'error'); return; }
  try {
    await request('/admin/users', { method: 'POST', body: JSON.stringify({ username, nickname, password, is_admin: 0 }) });
    showToast('用户创建成功');
    closeCreateUserModal();
    loadAdminUsers(1);
  } catch (e) {
    showToast(e.message || '创建失败', 'error');
  }
}


async function saveUserEdit() {
  const id = document.getElementById('userEditId').value;
  const body = {
    nickname: document.getElementById('userEditNickname').value.trim(),
    email: document.getElementById('userEditEmail').value.trim() || null,
  };
  try {
    await request(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    showToast('用户信息已更新');
    closeUserEditModal();
    loadAdminUsers(_userPage);
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function openUserRoleModal(idx) {
  const u = _userListCache[idx];
  if (!u) return;
  document.getElementById('userRoleUserId').value = String(u.id);
  document.getElementById('userRoleModalTitle').textContent = `分配角色 - ${u.username}`;

  // 每次都重新加载，确保最新
  try { _allRoles = await request('/admin/roles'); } catch { _allRoles = []; }

  const currentIds = (u.role_ids || []).map(String);
  document.getElementById('userRoleCheckboxList').innerHTML = _allRoles.map(r => `
    <label class="admin-checkbox-item">
      <input type="checkbox" value="${r.id}" ${currentIds.includes(String(r.id)) ? 'checked' : ''}>
      <span>${esc(r.role_name)}</span>
      <span style="font-size:11px;color:var(--text-muted);margin-left:4px;">${esc(r.role_code)}</span>
    </label>
  `).join('');
  document.getElementById('userRoleModal').classList.remove('hidden');
}

function closeUserRoleModal() {
  document.getElementById('userRoleModal').classList.add('hidden');
}

async function saveUserRoles() {
  const userId = document.getElementById('userRoleUserId').value;
  const checked = [...document.querySelectorAll('#userRoleCheckboxList input:checked')].map(el => el.value);
  try {
    await request(`/admin/users/${userId}/roles`, { method: 'POST', body: JSON.stringify({ role_ids: checked }) });
    showToast('角色已更新');
    closeUserRoleModal();
    loadAdminUsers(_userPage);
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function resetUserPassword(idx) {
  const u = _userListCache[idx];
  if (!u) return;
  const newPassword = prompt(`重置 ${u.username} 的密码（最少6位）：`);
  if (!newPassword) return;
  if (newPassword.length < 6) { showToast('密码不能少于6位', 'error'); return; }
  try {
    await request(`/admin/users/${u.id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });
    showToast('密码已重置');
  } catch (e) {
    showToast(e.message || '重置失败', 'error');
  }
}

async function deleteAdminUser(idx) {
  const u = _userListCache[idx];
  if (!u) return;
  const ok = await showConfirm({ title: '删除用户', message: `确认删除用户 "${u.username}"？此操作不可恢复。`, variant: 'danger', okText: '删除' });
  if (!ok) return;
  try {
    await request(`/admin/users/${u.id}`, { method: 'DELETE' });
    showToast('用户已删除');
    loadAdminUsers(_userPage);
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}

// ===================================================================
// ===== 角色管理 =====
// ===================================================================
let _roleList = [];

async function loadAdminRoles() {
  const wrap = document.getElementById('roleTableWrap');
  if (wrap) wrap.innerHTML = '<div class="admin-empty">加载中...</div>';
  try {
    _roleList = await request('/admin/roles');
    _allRoles = _roleList;
    renderRoleTable(_roleList);
  } catch (e) {
    if (wrap) wrap.innerHTML = '<div class="admin-empty">加载失败，请刷新重试</div>';
  }
}

function renderRoleTable(list) {
  const wrap = document.getElementById('roleTableWrap');
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = '<div class="admin-empty">暂无角色数据</div>';
    return;
  }
  wrap.innerHTML = `
    <div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th>角色名称</th>
          <th>标识码</th>
          <th>描述</th>
          <th>用户数</th>
          <th>状态</th>
          <th style="text-align:center;">操作</th>
        </tr>
      </thead>
      <tbody>
        ${list.map((r, i) => `
          <tr>
            <td>${esc(r.role_name)}</td>
            <td><code style="font-size:12px;background:var(--bg-secondary);padding:2px 6px;border-radius:4px;">${esc(r.role_code)}</code></td>
            <td style="font-size:12px;color:var(--text-secondary);">${esc(r.description || '-')}</td>
            <td>${r.user_count || 0} 人</td>
            <td><span class="admin-type-badge ${r.status ? 'type-single' : ''}">${r.status ? '启用' : '禁用'}</span></td>
            <td>
              <div class="admin-action-btns">
                ${hasPerm('role:edit')         ? `<button class="admin-btn-icon edit" onclick="openRoleModal(${i})">✏️ 编辑</button>` : ''}
                ${hasPerm('role:assign_menus') ? `<button class="admin-btn-icon" style="background:#7c3aed;color:#fff;" onclick="openRoleMenuModal(${i})">📋 菜单权限</button>` : ''}
                ${(String(r.id) !== '1' && String(r.id) !== '2' && hasPerm('role:delete')) ? `<button class="admin-btn-icon del" onclick="deleteAdminRole(${i})">🗑️ 删除</button>` : (String(r.id) === '1' || String(r.id) === '2' ? '<span style="font-size:11px;color:var(--text-muted);">预置</span>' : '')}
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function openRoleModal(idx) {
  // idx 为 null/undefined 时表示新增
  const r = (idx !== null && idx !== undefined) ? _roleList[idx] : null;
  const isEdit = !!r;
  document.getElementById('roleEditModalTitle').textContent = isEdit ? '编辑角色' : '新增角色';
  document.getElementById('roleEditId').value = isEdit ? String(r.id) : '';
  document.getElementById('roleEditName').value = isEdit ? (r.role_name || '') : '';
  const codeInput = document.getElementById('roleEditCode');
  codeInput.value = isEdit ? (r.role_code || '') : '';
  codeInput.disabled = isEdit;  // 编辑时不能改标识码
  document.getElementById('roleEditDesc').value = isEdit ? (r.description || '') : '';
  document.getElementById('roleEditSort').value = isEdit ? (r.sort_no || 0) : 0;
  document.getElementById('roleEditStatus').value = isEdit ? String(r.status ?? 1) : '1';
  document.getElementById('roleEditModal').classList.remove('hidden');
}

function closeRoleModal() {
  document.getElementById('roleEditModal').classList.add('hidden');
}

async function saveRole() {
  const id = document.getElementById('roleEditId').value;
  const body = {
    role_name: document.getElementById('roleEditName').value.trim(),
    role_code: document.getElementById('roleEditCode').value.trim().toUpperCase(),
    description: document.getElementById('roleEditDesc').value.trim() || null,
    sort_no: Number(document.getElementById('roleEditSort').value) || 0,
    status: Number(document.getElementById('roleEditStatus').value),
  };
  if (!body.role_name) { showToast('角色名称不能为空', 'error'); return; }
  if (!id && !body.role_code) { showToast('角色标识不能为空', 'error'); return; }
  try {
    if (id) {
      await request(`/admin/roles/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('角色已更新');
    } else {
      await request('/admin/roles', { method: 'POST', body: JSON.stringify(body) });
      showToast('角色已创建');
    }
    closeRoleModal();
    loadAdminRoles();
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function openRoleMenuModal(idx) {
  const r = _roleList[idx];
  if (!r) return;
  document.getElementById('roleMenuRoleId').value = String(r.id);
  document.getElementById('roleMenuModalTitle').textContent = `菜单权限 - ${r.role_name}`;

  let menus = [];
  try { menus = await request('/admin/menus'); } catch {}
  const currentIds = (r.menu_ids || []).map(String);

  // 三级结构：根菜单 → 分组节点 → 按钮
  const roots     = menus.filter(m => !m.menu_type && !Number(m.parent_id) && m.is_enabled);
  const groupsOf  = (pid) => menus.filter(m => !m.menu_type  && Number(m.parent_id) === Number(pid) && m.is_enabled);
  const buttonsOf = (pid) => menus.filter(m =>  m.menu_type === 1 && Number(m.parent_id) === Number(pid) && m.is_enabled);

  document.getElementById('roleMenuCheckboxList').innerHTML = roots.map(root => {
    const groups = groupsOf(root.id);
    const directBtns = buttonsOf(root.id);
    return `
      <div class="role-menu-group">
        <label class="admin-checkbox-item role-menu-parent">
          <input type="checkbox" value="${root.id}" ${currentIds.includes(String(root.id)) ? 'checked' : ''}
            onchange="onParentMenuCheck(this)">
          <span>${root.menu_icon || ''} <strong>${esc(root.menu_name)}</strong></span>
        </label>
        ${(groups.length || directBtns.length) ? `<div class="role-menu-children">
          ${groups.map(g => {
            const btns = buttonsOf(g.id);
            return `
            <div class="role-menu-subgroup">
              <label class="admin-checkbox-item role-menu-subparent">
                <input type="checkbox" value="${g.id}" data-parent="${root.id}" ${currentIds.includes(String(g.id)) ? 'checked' : ''}
                  onchange="onGroupMenuCheck(this)">
                <span>${g.menu_icon || '📂'} ${esc(g.menu_name)}</span>
              </label>
              ${btns.length ? `<div class="role-menu-buttons">
                ${btns.map(b => `
                  <label class="admin-checkbox-item">
                    <input type="checkbox" value="${b.id}" data-parent="${root.id}" data-group="${g.id}"
                      ${currentIds.includes(String(b.id)) ? 'checked' : ''}>
                    <span>🔘 ${esc(b.menu_name)}${b.perm_key ? `<code class="perm-key-badge">${esc(b.perm_key)}</code>` : ''}</span>
                  </label>
                `).join('')}
              </div>` : ''}
            </div>`;
          }).join('')}
          ${directBtns.map(b => `
            <label class="admin-checkbox-item">
              <input type="checkbox" value="${b.id}" data-parent="${root.id}"
                ${currentIds.includes(String(b.id)) ? 'checked' : ''}>
              <span>🔘 ${esc(b.menu_name)}${b.perm_key ? `<code class="perm-key-badge">${esc(b.perm_key)}</code>` : ''}</span>
            </label>
          `).join('')}
        </div>` : ''}
      </div>
    `;
  }).join('');

  document.getElementById('roleMenuModal').classList.remove('hidden');
}

function onParentMenuCheck(checkbox) {
  const parentId = checkbox.value;
  // 勾选/取消根菜单时，级联所有子分组和子按钮
  document.querySelectorAll(`#roleMenuCheckboxList input[data-parent="${parentId}"]`)
    .forEach(cb => { cb.checked = checkbox.checked; });
}

function onGroupMenuCheck(checkbox) {
  const groupId = checkbox.value;
  const parentId = checkbox.dataset.parent;
  // 勾选/取消分组时，级联该分组下的按钮
  document.querySelectorAll(`#roleMenuCheckboxList input[data-group="${groupId}"]`)
    .forEach(cb => { cb.checked = checkbox.checked; });
  // 如果取消分组，同步取消父根菜单（可选，不强制）
}

function closeRoleMenuModal() {
  document.getElementById('roleMenuModal').classList.add('hidden');
}

async function saveRoleMenus() {
  const roleId = document.getElementById('roleMenuRoleId').value;
  const checked = [...document.querySelectorAll('#roleMenuCheckboxList input:checked')].map(el => Number(el.value));
  try {
    await request(`/admin/roles/${roleId}/menus`, { method: 'PUT', body: JSON.stringify({ menu_ids: checked }) });
    showToast('菜单权限已保存');
    closeRoleMenuModal();
    sessionStorage.removeItem('sidebarMenus');
    loadAdminRoles();
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function deleteAdminRole(idx) {
  const r = _roleList[idx];
  if (!r) return;
  const ok = await showConfirm({ title: '删除角色', message: `确认删除角色 "${r.role_name}"？关联用户的角色绑定也会一并删除。`, variant: 'danger', okText: '删除' });
  if (!ok) return;
  try {
    await request(`/admin/roles/${r.id}`, { method: 'DELETE' });
    showToast('角色已删除');
    loadAdminRoles();
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}

// ===================================================================
// ===== 菜单管理 =====
// ===================================================================
let _menuList = [];

async function loadAdminMenus() {
  const wrap = document.getElementById('menuTableWrap');
  if (wrap) wrap.innerHTML = '<div class="admin-empty">加载中...</div>';
  try {
    _menuList = await request('/admin/menus');
    renderMenuTable(_menuList);
  } catch (e) {
    if (wrap) wrap.innerHTML = '<div class="admin-empty">加载失败，请刷新重试</div>';
  }
}

function renderMenuTable(list) {
  const wrap = document.getElementById('menuTableWrap');
  if (!wrap) return;
  if (!list.length) { wrap.innerHTML = '<div class="admin-empty">暂无菜单数据</div>'; return; }

  // 三级结构：根菜单(parent_id=0,menu_type=0) → 分组节点(parent_id=root,menu_type=0) → 按钮(menu_type=1)
  const roots     = list.filter(m => !m.menu_type && !Number(m.parent_id));
  const groupsOf  = (pid) => list.filter(m => !m.menu_type  && Number(m.parent_id) === Number(pid));
  const buttonsOf = (pid) => list.filter(m =>  m.menu_type === 1 && Number(m.parent_id) === Number(pid));

  const btnRowHtml = (b, indent) => {
    const bi = list.indexOf(b);
    return `
    <tr style="background:var(--table-stripe,#f1f5f9);">
      <td style="padding-left:${indent}px;color:var(--text-muted);font-size:12px;">└ ${b.sort_no}</td>
      <td style="font-size:13px;">${b.menu_icon || '🔘'}</td>
      <td style="font-size:13px;">
        <span style="color:var(--text-secondary);">${esc(b.menu_name)}</span>
        ${b.perm_key ? `<code style="font-size:11px;color:var(--primary,#3b82f6);background:rgba(59,130,246,.08);padding:1px 5px;border-radius:3px;margin-left:6px;">${esc(b.perm_key)}</code>` : ''}
      </td>
      <td style="font-size:11px;color:var(--text-muted);">按钮权限</td>
      <td>${b.is_builtin ? '<span style="font-size:11px;color:var(--text-muted);">内置</span>' : ''}</td>
      <td><span class="admin-type-badge ${b.is_enabled ? 'type-single' : ''}">${b.is_enabled ? '启用' : '禁用'}</span></td>
      <td>
        <div class="admin-action-btns">
          ${hasPerm('menu:edit')   ? `<button class="admin-btn-icon edit" onclick="openMenuModal(${bi})">✏️ 编辑</button>` : ''}
          ${(!b.is_builtin && hasPerm('menu:delete')) ? `<button class="admin-btn-icon del" onclick="deleteAdminMenu(${bi})">🗑️ 删除</button>` : ''}
        </div>
      </td>
    </tr>`;
  };

  wrap.innerHTML = `
    <div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th>排序</th><th>图标</th><th>名称 / 权限Key</th>
          <th>路径 / 类型</th><th>内置</th><th>状态</th>
          <th style="text-align:center;">操作</th>
        </tr>
      </thead>
      <tbody>
        ${roots.map(m => {
          const i = list.indexOf(m);
          const groups = groupsOf(m.id);
          const directBtns = buttonsOf(m.id);
          return `
          <tr style="background:var(--bg-card,#fff);">
            <td>${m.sort_no}</td>
            <td style="font-size:20px;">${m.menu_icon || ''}</td>
            <td style="font-weight:600;">${esc(m.menu_name)}</td>
            <td style="font-size:12px;color:var(--text-secondary);">${esc(m.menu_url || '')}</td>
            <td>${m.is_builtin ? '<span style="font-size:11px;color:var(--text-muted);">内置</span>' : ''}</td>
            <td><span class="admin-type-badge ${m.is_enabled ? 'type-single' : ''}">${m.is_enabled ? '启用' : '禁用'}</span></td>
            <td>
              <div class="admin-action-btns">
                ${hasPerm('menu:edit') ? `<button class="admin-btn-icon edit" onclick="openMenuModal(${i})">✏️ 编辑</button>` : ''}
                ${(!m.is_builtin && hasPerm('menu:delete')) ? `<button class="admin-btn-icon del" onclick="openMenuModal(${i})">🗑️ 删除</button>` : ''}
              </div>
            </td>
          </tr>
          ${groups.map(g => {
            const gi = list.indexOf(g);
            const btns = buttonsOf(g.id);
            return `
            <tr style="background:var(--bg-secondary,#f8fafc);">
              <td style="padding-left:20px;color:var(--text-muted);font-size:12px;">├ ${g.sort_no}</td>
              <td style="font-size:16px;">${g.menu_icon || '📂'}</td>
              <td style="font-weight:500;font-size:13px;color:var(--text-primary);">${esc(g.menu_name)}</td>
              <td style="font-size:11px;color:var(--text-muted);">功能分组</td>
              <td>${g.is_builtin ? '<span style="font-size:11px;color:var(--text-muted);">内置</span>' : ''}</td>
              <td><span class="admin-type-badge ${g.is_enabled ? 'type-single' : ''}">${g.is_enabled ? '启用' : '禁用'}</span></td>
              <td>
                <div class="admin-action-btns">
                  ${hasPerm('menu:edit') ? `<button class="admin-btn-icon edit" onclick="openMenuModal(${gi})">✏️ 编辑</button>` : ''}
                  ${hasPerm('menu:add')  ? `<button class="admin-btn-icon" style="background:#7c3aed;color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;" onclick="openMenuModal(null,${g.id})">+ 按钮</button>` : ''}
                  ${(!g.is_builtin && hasPerm('menu:delete')) ? `<button class="admin-btn-icon del" onclick="deleteAdminMenu(${gi})">🗑️ 删除</button>` : ''}
                </div>
              </td>
            </tr>
            ${btns.map(b => btnRowHtml(b, 40)).join('')}`;
          }).join('')}
          ${directBtns.map(b => btnRowHtml(b, 20)).join('')}
          `;
        }).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function openMenuModal(idx, defaultParentId) {
  const m = (idx !== null && idx !== undefined) ? _menuList[idx] : null;
  const isEdit = !!m;
  const isBtn = isEdit ? (Number(m.menu_type) === 1) : (defaultParentId != null);

  document.getElementById('menuEditModalTitle').textContent =
    isEdit ? (isBtn ? '编辑按钮' : '编辑菜单') : (isBtn ? '新增按钮' : '新增菜单');
  document.getElementById('menuEditId').value      = isEdit ? String(m.id) : '';
  document.getElementById('menuEditType').value    = isBtn ? '1' : '0';
  document.getElementById('menuEditName').value    = isEdit ? (m.menu_name || '') : '';
  document.getElementById('menuEditIcon').value    = isEdit ? (m.menu_icon || '') : (isBtn ? '🔘' : '📄');
  document.getElementById('menuEditUrl').value     = isEdit ? (m.menu_url || '') : '';
  document.getElementById('menuEditSort').value    = isEdit ? (m.sort_no || 0) : 99;
  document.getElementById('menuEditEnabled').value = isEdit ? String(m.is_enabled ?? 1) : '1';
  document.getElementById('menuEditPermKey').value = isEdit ? (m.perm_key || '') : '';

  // 父菜单下拉：包含根菜单和分组节点（按钮可挂到分组下）
  const roots  = _menuList.filter(x => !x.menu_type && !Number(x.parent_id));
  const parentSel = document.getElementById('menuEditParent');
  parentSel.innerHTML = '<option value="0">（无，作为一级菜单）</option>';
  roots.forEach(r => {
    parentSel.innerHTML += `<option value="${r.id}">${esc(r.menu_icon || '')} ${esc(r.menu_name)}</option>`;
    const grps = _menuList.filter(g => !g.menu_type && Number(g.parent_id) === Number(r.id));
    grps.forEach(g => {
      parentSel.innerHTML += `<option value="${g.id}">&nbsp;&nbsp;└ ${esc(g.menu_icon || '📂')} ${esc(g.menu_name)}</option>`;
    });
  });
  const selPid = isEdit ? (m.parent_id || 0) : (defaultParentId || 0);
  parentSel.value = String(selPid);

  // 控制字段显示
  document.getElementById('menuUrlRow').style.display     = isBtn ? 'none' : '';
  document.getElementById('menuPermKeyRow').style.display = isBtn ? '' : 'none';

  document.getElementById('menuEditModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('menuEditName').focus(), 50);
}

function closeMenuModal() {
  document.getElementById('menuEditModal').classList.add('hidden');
}

async function saveMenu() {
  const id       = document.getElementById('menuEditId').value;
  const type     = Number(document.getElementById('menuEditType').value);
  const permKey  = document.getElementById('menuEditPermKey').value.trim();
  const url      = document.getElementById('menuEditUrl').value.trim();
  const parentId = Number(document.getElementById('menuEditParent').value) || 0;

  const body = {
    menu_name:  document.getElementById('menuEditName').value.trim(),
    menu_icon:  document.getElementById('menuEditIcon').value.trim(),
    menu_url:   url,
    sort_no:    Number(document.getElementById('menuEditSort').value) || 0,
    is_enabled: Number(document.getElementById('menuEditEnabled').value),
    menu_type:  type,
    parent_id:  parentId,
    perm_key:   permKey || null,
  };
  if (!body.menu_name) { showToast('名称不能为空', 'error'); return; }
  if (type === 0 && !body.menu_url) { showToast('菜单页面路径不能为空', 'error'); return; }
  if (type === 1 && !body.perm_key) { showToast('按钮权限标识不能为空', 'error'); return; }
  try {
    if (id) {
      await request(`/admin/menus/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('已更新');
    } else {
      await request('/admin/menus', { method: 'POST', body: JSON.stringify(body) });
      showToast(type === 1 ? '按钮已创建' : '菜单已创建');
    }
    closeMenuModal();
    loadAdminMenus();
    sessionStorage.removeItem('sidebarMenus');
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function deleteAdminMenu(idx) {
  const m = _menuList[idx];
  if (!m) return;
  const ok = await showConfirm({ title: '删除菜单', message: `确认删除菜单 "${m.menu_name}"？`, variant: 'danger', okText: '删除' });
  if (!ok) return;
  try {
    await request(`/admin/menus/${m.id}`, { method: 'DELETE' });
    showToast('菜单已删除');
    loadAdminMenus();
    sessionStorage.removeItem('sidebarMenus');
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}

// ===================================================================
// ===== 字典管理 =====
// ===================================================================
let _dictList = [];

async function loadAdminDict() {
  const wrap = document.getElementById('dictTableWrap');
  if (wrap) wrap.innerHTML = '<div class="admin-empty">加载中...</div>';
  try {
    const types = await request('/admin/dict/types');
    fillDictTypeFilter(types);
    const type = document.getElementById('dictFilterType').value;
    const qs = type ? `?type=${encodeURIComponent(type)}` : '';
    _dictList = await request('/admin/dict' + qs);
    renderDictTable(_dictList);
  } catch (e) {
    if (wrap) wrap.innerHTML = '<div class="admin-empty">加载失败，请刷新重试</div>';
  }
}

function fillDictTypeFilter(types) {
  const sel = document.getElementById('dictFilterType');
  if (!sel || sel.options.length > 1) return;
  (types || []).forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    sel.appendChild(opt);
  });
}

function renderDictTable(list) {
  const wrap = document.getElementById('dictTableWrap');
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = '<div class="admin-empty">暂无字典数据，点击"新增字典项"添加</div>';
    return;
  }
  wrap.innerHTML = `
    <div class="admin-table-wrap">
    <table class="admin-table">
      <thead>
        <tr>
          <th>类型</th><th>图标</th><th>编码</th><th>名称</th>
          <th>排序</th><th>状态</th><th style="text-align:center;">操作</th>
        </tr>
      </thead>
      <tbody>
        ${list.map((d, i) => `
          <tr>
            <td><code style="font-size:12px;background:var(--bg-secondary);padding:2px 6px;border-radius:4px;">${esc(d.dict_type)}</code></td>
            <td style="text-align:center;font-size:18px;">${esc(d.dict_icon || '')}</td>
            <td style="font-family:monospace;font-size:12px;">${esc(d.dict_code)}</td>
            <td style="font-weight:600;">${esc(d.dict_label)}</td>
            <td style="text-align:center;">${d.sort_order}</td>
            <td><span class="admin-type-badge ${d.status ? 'type-single' : ''}">${d.status ? '启用' : '停用'}</span></td>
            <td>
              <div class="admin-action-btns">
                <button class="admin-btn-icon edit" onclick="openDictModal(${i})">✏️ 编辑</button>
                <button class="admin-btn-icon del" onclick="deleteDict(${i})">🗑️ 删除</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  `;
}

function openDictModal(idx) {
  const d = (typeof idx === 'number') ? _dictList[idx] : null;
  const isEdit = !!d;
  document.getElementById('dictModalTitle').textContent = isEdit ? '编辑字典项' : '新增字典项';
  document.getElementById('dictId').value = isEdit ? String(d.id) : '';
  const typeInput = document.getElementById('dictType');
  typeInput.value = isEdit ? d.dict_type : '';
  typeInput.disabled = isEdit;
  const codeInput = document.getElementById('dictCode');
  codeInput.value = isEdit ? d.dict_code : '';
  codeInput.disabled = isEdit;
  document.getElementById('dictLabel').value = isEdit ? d.dict_label : '';
  document.getElementById('dictIcon').value = isEdit ? (d.dict_icon || '') : '';
  document.getElementById('dictSort').value = isEdit ? (d.sort_order || 0) : 0;
  document.getElementById('dictStatus').value = isEdit ? String(d.status ?? 1) : '1';
  document.getElementById('dictModal').classList.remove('hidden');
}

function closeDictModal() {
  document.getElementById('dictModal').classList.add('hidden');
}

async function saveDict() {
  const id = document.getElementById('dictId').value;
  const dictType = document.getElementById('dictType').value.trim();
  const body = {
    dict_type: dictType,
    dict_code: document.getElementById('dictCode').value.trim(),
    dict_label: document.getElementById('dictLabel').value.trim(),
    dict_icon: document.getElementById('dictIcon').value.trim() || null,
    sort_order: Number(document.getElementById('dictSort').value) || 0,
    status: Number(document.getElementById('dictStatus').value),
  };
  if (!id && (!body.dict_type || !body.dict_code)) { showToast('类型和编码不能为空', 'error'); return; }
  if (!body.dict_label) { showToast('名称不能为空', 'error'); return; }
  try {
    if (id) {
      await request(`/admin/dict/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('字典项已更新');
    } else {
      await request('/admin/dict', { method: 'POST', body: JSON.stringify(body) });
      showToast('字典项已创建');
    }
    closeDictModal();
    // 清除该类型的字典缓存，让其他页面重新加载
    if (window.__dictCache) delete window.__dictCache[dictType];
    loadAdminDict();
  } catch (e) {
    showToast(e.message || '保存失败', 'error');
  }
}

async function deleteDict(idx) {
  const d = _dictList[idx];
  if (!d) return;
  const ok = await showConfirm({ title: '删除字典项', message: `确认删除字典项 "${d.dict_label}"？`, variant: 'danger', okText: '删除' });
  if (!ok) return;
  try {
    await request(`/admin/dict/${d.id}`, { method: 'DELETE' });
    showToast('字典项已删除');
    if (window.__dictCache) delete window.__dictCache[d.dict_type];
    loadAdminDict();
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}
