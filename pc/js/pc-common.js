/**
 * PC端公共JS - 侧边栏、顶栏、初始化
 * 依赖：../public/js/common.js（已在各页面 HTML 中先引入）
 */

// ===== PC端 Toast 提示（覆盖移动端 showToast） =====
(function() {
  let container = null;
  function getContainer() {
    if (!container) {
      container = document.createElement('div');
      container.className = 'pc-toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  window.showToast = function(msg, type) {
    // 自动推断类型
    if (!type) {
      if (/成功|已|完成|保存|删除/.test(msg)) type = 'success';
      else if (/失败|错误|异常|不能|请/.test(msg)) type = 'error';
      else type = 'default';
    }
    const iconMap = { success: '✅', error: '❌', warning: '⚠️', default: '💬' };
    const toast = document.createElement('div');
    toast.className = `pc-toast pc-toast-${type}`;
    toast.innerHTML = `<span class="pc-toast-icon">${iconMap[type] || iconMap.default}</span><span class="pc-toast-msg"></span>`;
    toast.querySelector('.pc-toast-msg').textContent = msg;
    getContainer().appendChild(toast);
    setTimeout(() => {
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 200);
    }, 2200);
  };
})();

// ===== PC端确认对话框（替代原生 confirm） =====
window.showConfirm = function(options) {
  return new Promise((resolve) => {
    const opts = typeof options === 'string' ? { message: options } : (options || {});
    const title = opts.title || '确认操作';
    const message = opts.message || '';
    const okText = opts.okText || '确定';
    const cancelText = opts.cancelText || '取消';
    const variant = opts.variant || 'warning';
    const iconMap = { warning: '⚠️', danger: '🗑️', info: 'ℹ️' };

    const overlay = document.createElement('div');
    overlay.className = 'pc-confirm-overlay';
    overlay.innerHTML = `
      <div class="pc-confirm-dialog">
        <div class="pc-confirm-icon ${variant}">${iconMap[variant] || iconMap.info}</div>
        <div class="pc-confirm-title"></div>
        <div class="pc-confirm-message"></div>
        <div class="pc-confirm-actions">
          <button class="pc-confirm-btn pc-confirm-btn-cancel">${cancelText}</button>
          <button class="pc-confirm-btn pc-confirm-btn-ok ${variant === 'danger' ? 'danger' : ''}">${okText}</button>
        </div>
      </div>
    `;
    overlay.querySelector('.pc-confirm-title').textContent = title;
    overlay.querySelector('.pc-confirm-message').textContent = message;
    document.body.appendChild(overlay);

    function close(result) {
      overlay.style.animation = 'pcConfirmFadeIn 0.15s ease reverse';
      overlay.querySelector('.pc-confirm-dialog').style.animation = 'pcConfirmScaleIn 0.15s ease reverse';
      setTimeout(() => { overlay.remove(); resolve(result); }, 150);
    }
    overlay.querySelector('.pc-confirm-btn-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.pc-confirm-btn-ok').addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(false); }
      else if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); close(true); }
    });
  });
};

const PC_NAV_ITEMS = [
  { page: 'home', icon: '🧭', text: '审计驾驶舱', url: '/pc/index.html' },
  // ===== 工程审计模块（Seed Evolving 三期 case）=====
  { page: 'audit-project', icon: '📁', text: '审计项目', url: '/pc/audit-project.html' },
  { page: 'audit-documents', icon: '📄', text: '资料舱', url: '/pc/audit-documents.html' },
  { page: 'audit-chat', icon: '💬', text: '智能问答', url: '/pc/audit-chat.html' },
  { page: 'audit-checks', icon: '✅', text: '核对程序', url: '/pc/audit-checks.html' },
  { page: 'audit-findings', icon: '⚠️', text: '疑点台账', url: '/pc/audit-findings.html' },
  { page: 'audit-bid-clearing', icon: '🧹', text: '清标分析', url: '/pc/audit-bid-clearing.html' },
];

// ===== 工程审计：当前项目上下文（URL ?id 优先，localStorage 兜底） =====
const AUDIT_PROJECT_KEY = 'audit_current_project_id';
// 这些页面的侧边栏链接需要自动带上当前项目 id（audit-project 本身不带，bid-clearing 已独立不绑项目）
const AUDIT_SCOPED_PAGES = new Set(['audit-documents', 'audit-chat', 'audit-checks', 'audit-findings']);

window.getAuditProjectId = function() {
  return new URLSearchParams(location.search).get('id') || localStorage.getItem(AUDIT_PROJECT_KEY) || '';
};
window.setAuditProject = function(id) {
  if (id) localStorage.setItem(AUDIT_PROJECT_KEY, String(id));
};
window.clearAuditProject = function() {
  localStorage.removeItem(AUDIT_PROJECT_KEY);
};
// 填充项目下拉，返回项目列表（复用智能问答页既有写法）
window.fillAuditProjectSelect = async function(selectEl, { blankOption = true } = {}) {
  const projects = await request('/audit/projects');
  selectEl.innerHTML = (blankOption ? '<option value="">— 选择审计项目 —</option>' : '') +
    projects.map(p => `<option value="${p.id}">${esc(p.project_name)}</option>`).join('');
  return projects;
};
// 绑定顶栏「切换项目」下拉（projects 为已加载的项目列表）
window.bindAuditProjectSwitcher = function(selectEl, projects, currentId) {
  selectEl.innerHTML = projects.map(p => `<option value="${p.id}">${esc(p.project_name)}</option>`).join('');
  selectEl.value = String(currentId);
  selectEl.addEventListener('change', e => {
    if (e.target.value && String(e.target.value) !== String(currentId)) {
      setAuditProject(e.target.value);
      location.href = location.pathname + '?id=' + encodeURIComponent(e.target.value);
    }
  });
};

// 渲染侧边栏（动态菜单：从 /api/admin/menus/my 获取，带缓存和回退）
async function renderPCSidebar(activePage) {
  const sidebar = document.getElementById('pcSidebar');
  if (!sidebar) return;

  const isAdminUser = localStorage.getItem('isAdmin') === 'true';

  // 尝试从 sessionStorage 读取缓存（带 TTL：新增/隐藏菜单后不必手动清缓存）
  const MENU_CACHE_TTL = 5 * 60 * 1000;
  let navItems = null;
  try {
    const cached = sessionStorage.getItem('sidebarMenus');
    if (cached) {
      const parsed = JSON.parse(cached);
      // 只认带时间戳的新格式；旧的裸数组一律视为过期 → 重新拉取并升级格式
      if (parsed && Array.isArray(parsed.items) && Date.now() - parsed.at < MENU_CACHE_TTL) {
        navItems = parsed.items;
      }
    }
  } catch {}

  // 缓存不存在/过期时从接口加载
  if (!navItems) {
    try {
      const menus = await request('/admin/menus/my');
      if (Array.isArray(menus) && menus.length > 0) {
        // 初始化按钮权限集合（供 hasPerm() 使用）
        state.permKeys = new Set(
          menus.filter(m => m.menu_type === 1 && m.perm_key).map(m => m.perm_key)
        );
        // 侧边栏只展示根级菜单（menu_type=0 且 parent_id=0，过滤掉分组节点和按钮）
        navItems = menus.filter(m => !m.menu_type && !m.parent_id).map(m => ({
          page: m.page_key,
          icon: m.menu_icon || '📄',
          text: m.menu_name,
          url: m.menu_url,
        }));
        sessionStorage.setItem('sidebarMenus', JSON.stringify({ at: Date.now(), items: navItems }));
      }
    } catch {}
  }

  // 回退到硬编码列表
  if (!navItems || navItems.length === 0) {
    navItems = [...PC_NAV_ITEMS];
    // 硬编码回退时，管理员补充后台管理入口
    if (isAdminUser && !navItems.find(n => n.page === 'admin')) {
      navItems = [...navItems, { page: 'admin', icon: '⚙️', text: '后台管理', url: '/pc/admin.html' }];
    }
  }

  sidebar.innerHTML = `
    <div class="pc-sidebar-logo">
      <div class="pc-sidebar-logo-icon">🔍</div>
      <div class="pc-sidebar-logo-text">工程审计智能审读</div>
    </div>
    <nav class="pc-sidebar-nav" id="pcSidebarNav">
      ${navItems.map(item => {
        let href = item.url;
        if (AUDIT_SCOPED_PAGES.has(item.page)) {
          const pid = getAuditProjectId();
          if (pid) href += (href.includes('?') ? '&' : '?') + 'id=' + encodeURIComponent(pid);
        }
        return `
        <a href="${href}" class="pc-nav-item ${item.page === activePage ? 'active' : ''}">
          <span class="pc-nav-icon">${item.icon}</span>
          <span class="pc-nav-text">${item.text}</span>
        </a>
      `;}).join('')}
    </nav>
    <div class="pc-sidebar-footer">
      <button class="pc-nav-item" onclick="toggleTheme()" style="color:var(--text-muted)">
        <span class="pc-nav-icon">🌙</span>
        <span class="pc-nav-text">切换主题</span>
      </button>
      <a href="/pc/my-profile.html" class="pc-nav-item ${activePage === 'myprofile' ? 'active' : ''}" style="color:var(--text-muted)">
        <span class="pc-nav-icon">⚙️</span>
        <span class="pc-nav-text">设置</span>
      </a>
      <button class="pc-nav-item" onclick="logout()" style="color:var(--danger,#ef4444)">
        <span class="pc-nav-icon">🚪</span>
        <span class="pc-nav-text">退出登录</span>
      </button>
    </div>
  `;
}

// 渲染顶栏
function renderPCTopbar(title, extraActions) {
  const topbar = document.getElementById('pcTopbar');
  if (!topbar) return;

  const user = state.user || {};
  const avatarChar = (user.nickname || user.username || 'U').slice(0, 1).toUpperCase();

  topbar.innerHTML = `
    <div class="pc-topbar-title">${title}</div>
    <div class="pc-topbar-actions">
      ${extraActions || ''}
      <!-- 移动端未开发，暂时隐藏切换按钮
      <button class="pc-switch-mobile-btn" onclick="switchToMobile()" title="切换到移动端">
        📱<span>切换移动端</span>
      </button>
      -->
      <button class="pc-notice-btn" id="pcNoticeBell" onclick="openNoticeModal()" title="通知公告">
        🔔
        <span class="pc-notice-badge" id="pcNoticeBadge" style="display:none;"></span>
      </button>
      <button class="pc-user-btn" onclick="location.href='/pc/my-profile.html'">
        <div class="pc-user-avatar">${avatarChar}</div>
        <span>${esc(user.nickname || user.username || '用户')}</span>
      </button>
    </div>
  `;
}

// 切换账本（PC版）
window.pcSwitchBook = async function(bookId) {
  await switchBook(bookId);
};

// 切换回移动端
window.switchToMobile = function() {
  localStorage.setItem('preferredLayout', 'mobile');
  const page = location.pathname.replace('/pc/', '/') || '/index.html';
  // 对应移动端页面
  const mobileMap = {
    '/index.html': '/index.html',
    '/bills.html': '/bills.html',
    '/accounts.html': '/accounts.html',
    '/reports.html': '/reports.html',
    '/loans.html': '/loans.html',
    '/profile.html': '/profile.html',
  };
  const dest = mobileMap[page] || '/index.html';
  location.href = dest;
};

// 刷新顶栏通知徽章
function refreshPCNoticeBadge() {
  const badge = document.getElementById('pcNoticeBadge');
  if (!badge) return;
  const total = (state.unreadCount || 0) + (state.unreadNotifCount || 0);
  if (total > 0) {
    badge.style.display = 'flex';
    badge.textContent = total > 99 ? '99+' : total;
  } else {
    badge.style.display = 'none';
  }
}

// ──────────────────────────────────────────────────────────────
// Canvas 折线图绘制（供 pc-analytics.js / pc-memory.js 共用）
// 支持两种调用方式：
//   drawLineChart(id, {labels, values, color}, '', unit)
//   drawLineChart(id, [{label, value}], color, unit)  ← 旧版兼容
// ──────────────────────────────────────────────────────────────
function drawLineChart(canvasId, data, colorArg, unit) {
  let chartData, color;
  if (data && !Array.isArray(data) && data.labels) {
    chartData = data.labels.map((label, i) => ({ label, value: data.values[i] ?? null }));
    color = data.color || colorArg || '#3b82f6';
  } else {
    chartData = (data || []).map(d => ({ label: d.label, value: d.value ?? null }));
    color = colorArg || '#3b82f6';
  }

  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.offsetWidth  || 400;
  const H   = canvas.offsetHeight || 180;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 16, right: 16, bottom: 32, left: 40 };
  const cw  = W - pad.left - pad.right;
  const ch  = H - pad.top  - pad.bottom;
  const hasData = chartData.some(d => d.value !== null);

  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--card').trim() || '#fff';
  ctx.fillRect(0, 0, W, H);

  if (!hasData) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无数据', W / 2, H / 2);
    return;
  }

  const isDark    = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  const vals  = chartData.map(d => d.value).filter(v => v !== null);
  const maxV  = Math.max(...vals, 100);
  const minV  = Math.max(0, Math.min(...vals) - 10);
  const range = maxV - minV || 1;
  const n     = chartData.length;

  function xPos(i) { return pad.left + (i / (n - 1 || 1)) * cw; }
  function yPos(v) { return pad.top + ch - ((v - minV) / range) * ch; }

  // 网格线 + Y轴刻度
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.strokeStyle = gridColor;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cw, y); ctx.stroke();
    const val = Math.round(maxV - (range / 4) * i);
    ctx.fillStyle = textColor;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val + (unit || ''), pad.left - 4, y + 4);
  }

  // X轴标签
  ctx.fillStyle = textColor;
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  const step = Math.ceil(n / 7);
  chartData.forEach((d, i) => {
    if (i % step === 0 || i === n - 1) ctx.fillText(d.label, xPos(i), H - pad.bottom + 14);
  });

  const validPts = chartData.map((d, i) => d.value !== null ? { x: xPos(i), y: yPos(d.value) } : null);

  // 填充区域
  ctx.beginPath();
  let started = false;
  validPts.forEach(pt => {
    if (!pt) return;
    if (!started) { ctx.moveTo(pt.x, pt.y); started = true; } else ctx.lineTo(pt.x, pt.y);
  });
  const lastValid  = [...validPts].reverse().find(p => p);
  const firstValid = validPts.find(p => p);
  if (firstValid && lastValid) {
    ctx.lineTo(lastValid.x, pad.top + ch);
    ctx.lineTo(firstValid.x, pad.top + ch);
    ctx.closePath();
    ctx.fillStyle = color + '22';
    ctx.fill();
  }

  // 折线
  ctx.beginPath();
  started = false;
  validPts.forEach(pt => {
    if (!pt) { started = false; return; }
    if (!started) { ctx.moveTo(pt.x, pt.y); started = true; } else ctx.lineTo(pt.x, pt.y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 数据点
  validPts.forEach(pt => {
    if (!pt) return;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}

// PC端初始化入口（教育系统版本）
async function initPCCommon(activePage) {
  if (!requireAuth()) return;

  await renderPCSidebar(activePage);
  renderNoticeModal();
  renderNoticePopup();

  await refreshUnreadCount();
  refreshPCNoticeBadge();
  if (state.noticePollTimer) clearInterval(state.noticePollTimer);
  state.noticePollTimer = setInterval(async () => {
    await refreshUnreadCount();
    refreshPCNoticeBadge();
  }, 60000);

  checkPopupNotices();

  if (typeof pageInit === 'function') await pageInit();
}

// ============================================================
// 学科 Tabs 按学段分组渲染工具函数（全局共享）
// 用法：container.innerHTML = renderGroupedSubjectTabs(subjects, activeId, btnClass, clickFn, activeLevel)
// activeLevel: 当前激活学段（可选），用于多学段 Tab 切换模式
// ============================================================
const LEVEL_LABELS = {
  primary:    '🏫 小学',
  junior:     '📚 初中',
  high:       '🎓 高中',
  university: '🎓 大学',
};
const LEVEL_ORDER = ['primary', 'junior', 'high', 'university'];

function renderGroupedSubjectTabs(subjects, activeId, btnClass, clickFn, activeLevel) {
  // 按学段分组
  const groups = {};
  for (const s of subjects) {
    const lvl = s.education_level || 'junior';
    if (!groups[lvl]) groups[lvl] = [];
    groups[lvl].push(s);
  }

  const levelsPresent = LEVEL_ORDER.filter(l => groups[l]);
  if (levelsPresent.length <= 1) {
    // 只有一个学段，退化为普通 Tabs
    return subjects.map(s => `
      <button class="${btnClass} ${String(s.id) === String(activeId) ? 'active' : ''}"
              data-sid="${esc(s.id)}"
              onclick="${clickFn}('${esc(s.id)}')">
        ${esc(s.icon || '📚')} ${esc(s.name)}
      </button>
    `).join('');
  }

  // 多学段：确定当前激活学段
  // 优先用传入的 activeLevel；其次从 activeId 反查；最后默认初中
  let curLevel = activeLevel;
  if (!curLevel && activeId) {
    const found = subjects.find(s => String(s.id) === String(activeId));
    curLevel = found ? found.education_level : null;
  }
  if (!curLevel) curLevel = levelsPresent.includes('junior') ? 'junior' : levelsPresent[0];

  const levelTabsHtml = levelsPresent.map(lvl => `
    <button class="subj-level-tab ${lvl === curLevel ? 'active' : ''}"
            onclick="${clickFn}__level('${lvl}')">
      ${LEVEL_LABELS[lvl] || lvl}
    </button>
  `).join('');

  const subjectBtnsHtml = (groups[curLevel] || []).map(s => `
    <button class="${btnClass} ${String(s.id) === String(activeId) ? 'active' : ''}"
            data-sid="${esc(s.id)}"
            onclick="${clickFn}('${esc(s.id)}')">
      ${esc(s.icon || '📚')} ${esc(s.name)}
    </button>
  `).join('');

  return `
    <div class="subj-level-tabs">${levelTabsHtml}</div>
    <div class="subj-level-btns">${subjectBtnsHtml}</div>
  `;
}
