/**
 * 公共JS库 - 所有页面共享
 */

// ===== 滚动穿透锁 =====
let _scrollLockCount = 0;
let _scrollLockY = 0;
function lockBodyScroll() {
  _scrollLockCount++;
  if (_scrollLockCount > 1) return;
  _scrollLockY = window.scrollY;
  document.body.style.overflow = 'hidden';
  document.body.style.position = 'fixed';
  document.body.style.top = `-${_scrollLockY}px`;
  document.body.style.width = '100%';
}
function unlockBodyScroll() {
  _scrollLockCount = Math.max(0, _scrollLockCount - 1);
  if (_scrollLockCount > 0) return;
  document.body.style.overflow = '';
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, _scrollLockY);
}

// ===== 全局状态 =====
const state = {
  token: localStorage.getItem('ledger_token'),
  user: JSON.parse(localStorage.getItem('ledger_user') || 'null'),
  currentMonth: new Date().toISOString().slice(0, 7),
  currentBook: localStorage.getItem('ledger_book') || null,  // 雪花ID为18位数字字符串，不能用parseInt（超出JS安全整数范围）
  categories: [],
  accounts: [],
  entities: [],
  templates: [],
  books: [],
  theme: localStorage.getItem('ledger_theme') || 'light',
  unreadCount: 0,
  unreadNotifCount: 0,
  isAdmin: false,
  permKeys: new Set(),
  noticePollTimer: null
};

const API = '/api';

// ===== 工具函数 =====
// HTML转义，防止XSS攻击
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(n) {
  return '¥' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 计算到期状态
 * @param {string} dueDate - YYYY-MM-DD
 * @returns {{status:'overdue'|'soon'|'normal', days:number, text:string}|null}
 *   overdue=已逾期, soon=3天内到期, normal=安全, null=无到期日
 */
function getDueStatus(dueDate) {
  if (!dueDate) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + 'T00:00:00');
  const diff = Math.round((due - today) / 86400000);
  if (diff < 0) return { status: 'overdue', days: -diff, text: `逾期${-diff}天` };
  if (diff === 0) return { status: 'overdue', days: 0, text: '今日到期' };
  if (diff <= 3) return { status: 'soon', days: diff, text: `${diff}天后到期` };
  return { status: 'normal', days: diff, text: `${diff}天后到期` };
}

/**
 * 计算信用卡下次还款日
 * @param {number} repayDay - 还款日(1-31)
 * @returns {string} YYYY-MM-DD
 */
function getNextCreditDueDate(repayDay) {
  if (!repayDay || repayDay < 1 || repayDay > 31) return null;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const today = now.getDate();
  // 如果今天 <= 当月还款日，还款日为当月；否则为下月
  let dueY = y, dueM = m;
  if (today > repayDay) {
    dueM = m + 1;
    if (dueM > 11) { dueM = 0; dueY = y + 1; }
  }
  // 处理月末日期（如2/30、4/31）
  const daysInMonth = new Date(dueY, dueM + 1, 0).getDate();
  const day = Math.min(repayDay, daysInMonth);
  return `${dueY}-${String(dueM + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ===== 通用字典缓存 =====
// 按类型缓存，同一页面同一类型只请求一次
window.__dictCache = window.__dictCache || {};
async function getDictList(type) {
  if (window.__dictCache[type]) return window.__dictCache[type];
  const list = await request(`/admin/dict/${type}`);
  window.__dictCache[type] = Array.isArray(list) ? list : [];
  return window.__dictCache[type];
}
function getDictLabel(type, code) {
  const list = window.__dictCache[type] || [];
  const item = list.find(d => d.dict_code === code);
  return item ? item.dict_label : code;
}
function getDictIcon(type, code) {
  const list = window.__dictCache[type] || [];
  const item = list.find(d => d.dict_code === code);
  return item ? (item.dict_icon || '') : '';
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ===== 请求封装 =====
async function request(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;

  try {
    const res = await fetch(API + url, { ...options, headers });
    const data = await res.json();
    // 401：未登录 / token 失效 → 清理凭证并跳转登录页
    if (res.status === 401) {
      localStorage.removeItem('ledger_token');
      localStorage.removeItem('ledger_user');
      localStorage.removeItem('ledger_book');
      sessionStorage.removeItem('sidebarMenus'); // 清除侧边栏菜单缓存，避免下次登录仍显示旧菜单
      window.location.href = isPCPage() ? '/pc/login.html' : '/login.html';
      // 抛出标记错误，防止调用方代码继续执行
      const authErr = new Error(data.error || '登录已过期，请重新登录');
      showToast(authErr.message);
      authErr._toastShown = true; // 已弹过 toast，调用方不必重复弹
      throw authErr;
    }
    // 403：已登录但权限不足 → 保留登录态，仅提示“无权访问”，绝不跳登录页
    // （误跳登录页会让用户以为被登出，重新登录后依旧失败，且丢失当前页面上下文）
    if (res.status === 403) {
      const permErr = new Error(data.error || '你没有执行该操作的权限');
      permErr._forbidden = true; // 标记为权限错误，供调用方区分处理
      permErr._toastShown = true;
      showToast(permErr.message);
      throw permErr;
    }
    if (!res.ok) {
      const err = new Error(data.error || '请求失败');
      showToast(err.message);
      err._toastShown = true; // 已弹过 toast，调用方不必重复弹
      throw err;
    }
    return data;
  } catch (err) {
    if (!err._toastShown) showToast(err.message);
    throw err;
  }
}

// 文件上传专用
async function uploadFile(file) {
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch(API + '/upload', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${state.token}` },
    body: formData
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '上传失败');
  return data.url;
}

// ===== 认证 =====
function isPCPage() {
  return location.pathname.startsWith('/pc/');
}

/**
 * 判断当前用户是否拥有某个按钮权限
 * 超级管理员始终返回 true
 * @param {string} key 权限标识，如 'question:add'
 */
function hasPerm(key) {
  if (localStorage.getItem('isAdmin') === 'true') return true;
  return state.permKeys.has(key);
}

function requireAuth() {
  if (!state.token || !state.user) {
    window.location.href = isPCPage() ? '/pc/login.html' : '/login.html';
    return false;
  }
  applyTheme();
  return true;
}

function redirectIfLoggedIn() {
  if (state.token && state.user) {
    window.location.href = isPCPage() ? '/pc/index.html' : '/index.html';
    return true;
  }
  return false;
}

// ===== 主题 =====
function applyTheme() {
  document.documentElement.setAttribute('data-theme', state.theme);
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem('ledger_theme', state.theme);
  applyTheme();
}

// ===== 数据加载 =====
async function loadCategories() {
  if (!state.currentBook) return;
  state.categories = await request(`/categories?book_id=${state.currentBook}`);
}

async function loadAccounts() {
  if (!state.currentBook) return;
  const data = await request(`/accounts?book_id=${state.currentBook}`);
  state.accounts = data.accounts;
  state.accountSummary = data.summary;
}

async function loadEntities() {
  if (!state.currentBook) return;
  state.entities = await request(`/entities?book_id=${state.currentBook}`);
}

async function loadTemplates() {
  if (!state.currentBook) return;
  state.templates = await request(`/templates?book_id=${state.currentBook}`);
}

async function loadBooks() {
  state.books = await request('/books');
}

function getAllCategories() {
  return state.categories.flatMap(c => [c, ...(c.children || [])]);
}

function getCategoryById(id) {
  return getAllCategories().find(c => c.id === id) || { icon: '💸', name: '未知', color: '#64748b' };
}

// ===== 切换账本 =====
async function switchBook(bookId) {
  state.currentBook = bookId;
  localStorage.setItem('ledger_book', bookId);
  await Promise.all([loadCategories(), loadAccounts()]);
  if (typeof pageRefresh === 'function') pageRefresh();
  showToast('已切换账本');
}

// ===== 退出登录 =====
function logout() {
  localStorage.removeItem('ledger_token');
  localStorage.removeItem('ledger_user');
  localStorage.removeItem('ledger_book');
  sessionStorage.removeItem('sidebarMenus'); // 清除侧边栏菜单缓存，避免下次登录仍显示旧菜单
  window.location.href = isPCPage() ? '/pc/login.html' : '/login.html';
}

// ===== 底部导航 =====
function renderBottomNav(activePage) {
  const navItems = [
    { page: 'home', icon: '🏠', text: '首页', url: '/index.html' },
    { page: 'bills', icon: '📝', text: '账单', url: '/bills.html' },
    { page: 'accounts', icon: '💳', text: '账户', url: '/accounts.html' },
    { page: 'reports', icon: '📊', text: '报表', url: '/reports.html' },
    { page: 'profile', icon: '👤', text: '我的', url: '/profile.html' }
  ];

  const navHtml = `
    <nav class="bottom-nav">
      ${navItems.map(item => `
        <a href="${item.url}" class="nav-item ${item.page === activePage ? 'active' : ''}">
          <span class="nav-icon">${item.icon}</span>
          <span>${item.text}</span>
        </a>
      `).join('')}
    </nav>
    <button class="fab" onclick="openAddModal()">+</button>
  `;
  document.body.insertAdjacentHTML('beforeend', navHtml);
}

// ===== 记账弹窗 =====
function renderAddModal() {
  const modalHtml = `
  <div class="modal" id="addModal">
    <div class="modal-content add-modal-content">
      <div class="modal-header">
        <button class="modal-close" onclick="closeAddModal()">✕</button>
        <span class="modal-title">记一笔</span>
        <button class="modal-template-btn" id="templateToggleBtn" title="模板记账">📋</button>
      </div>
      <div class="modal-body add-modal-body">
        <!-- AI智能输入（语音融合） -->
        <div class="ai-input-bar">
          <div class="ai-input-row">
            <button class="ai-voice-btn" id="aiVoiceBtn" onclick="toggleAiVoice()" title="语音输入">🎤</button>
            <input type="text" id="aiParseInput" class="ai-parse-input" placeholder="🤖 输入或说：午餐外卖30元" maxlength="100">
            <button class="ai-parse-btn" id="aiParseBtn" onclick="aiParseText()">解析</button>
          </div>
          <div class="ai-parse-result" id="aiParseResult" style="display:none;"></div>
        </div>

        <!-- 模板面板 -->
        <div class="template-panel" id="templatePanel" style="display:none;">
          <div class="template-list" id="templateList"></div>
        </div>

        <!-- 类型切换 -->
        <div class="type-tabs">
          <button class="type-tab expense active" data-type="expense">支出</button>
          <button class="type-tab income" data-type="income">收入</button>
          <button class="type-tab transfer" data-type="transfer">转账</button>
        </div>

        <!-- 金额 -->
        <div class="amount-input-wrap">
          <span class="amount-currency">¥</span>
          <input type="number" id="recordAmount" class="amount-input" placeholder="0.00" step="0.01">
        </div>

        <!-- 分类选择按钮（点击弹出底部选择面板） -->
        <button class="cat-select-btn" id="catSelectBtn" onclick="openCatSheet()">
          <span class="cat-select-icon" id="catSelectIcon">🍜</span>
          <span class="cat-select-text" id="catSelectText">选择分类</span>
          <span class="cat-select-arrow">›</span>
        </button>

        <!-- 账户 -->
        <div class="form-row" id="accountFormRow">
          <div class="form-group">
            <label class="form-label">账户</label>
            <button type="button" class="cat-select-btn" id="accSelectBtn" onclick="openAccSheet('main')">
              <span class="cat-select-icon" id="accSelectIcon">💵</span>
              <span class="cat-select-text" id="accSelectText">选择账户</span>
              <span class="acc-select-bal" id="accSelectBal"></span>
              <span class="cat-select-arrow">›</span>
            </button>
            <input type="hidden" id="recordAccount">
          </div>
          <div class="form-group" id="toAccountGroup" style="display:none;">
            <label class="form-label">转入账户</label>
            <button type="button" class="cat-select-btn" id="toAccSelectBtn" onclick="openAccSheet('to')">
              <span class="cat-select-icon" id="toAccSelectIcon">💵</span>
              <span class="cat-select-text" id="toAccSelectText">选择账户</span>
              <span class="acc-select-bal" id="toAccSelectBal"></span>
              <span class="cat-select-arrow">›</span>
            </button>
            <input type="hidden" id="recordToAccount">
          </div>
        </div>

        <!-- 日期 + 备注（文本域） -->
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">日期</label>
            <input type="date" id="recordDate">
          </div>
          <div class="form-group">
            <label class="form-label">时间</label>
            <input type="time" id="recordTime">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <textarea id="recordNote" rows="2" placeholder="记录详情有助AI帮分析健康饮食，如早餐3个包子，中餐猪脚饭+青菜" list="entityList"></textarea>
          <datalist id="entityList"></datalist>
        </div>

        <!-- 图片上传 -->
        <div class="image-upload-area" id="imageUploadArea">
          <label class="image-upload-label" for="recordImage">
            <span>📷 添加小票</span>
          </label>
          <input type="file" id="recordImage" accept="image/*" style="display:none;" onchange="handleImageUpload(event)">
          <div class="image-preview" id="imagePreview" style="display:none;">
            <img id="previewImg" src="">
            <button class="image-remove" onclick="removeImage()">✕</button>
          </div>
        </div>

        <label class="save-template-label" id="saveTemplateLabel">
          <input type="checkbox" id="saveAsTemplate">
          <span class="save-template-text">📋 同时存为模板</span>
        </label>
      </div>
      <!-- 固定底部保存按钮 -->
      <div class="modal-footer">
        <button class="btn-primary btn-save" onclick="saveRecord()">保存</button>
      </div>
    </div>
  </div>

  <!-- 分类底部弹出面板 -->
  <div class="cat-sheet-overlay" id="catSheetOverlay" onclick="closeCatSheet()"></div>
  <div class="cat-sheet" id="catSheet">
    <div class="cat-sheet-header">
      <button class="cat-sheet-close" onclick="closeCatSheet()">✕</button>
      <span class="cat-sheet-title">选择分类</span>
      <button class="cat-sheet-edit-toggle" id="catSheetEditToggle" onclick="toggleCatEditMode()">修改</button>
    </div>
    <div class="cat-sheet-body">
      <div class="cat-sheet-section-label">一级分类</div>
      <div class="cat-sheet-parents" id="catSheetParents"></div>
      <div class="cat-sheet-section-label">二级分类</div>
      <div class="cat-sheet-subs" id="catSheetSubs"></div>
    </div>
  </div>

  <!-- 分类新增/编辑弹窗 -->
  <div class="cat-edit-overlay" id="catEditOverlay" onclick="closeCatEditModal()"></div>
  <div class="cat-edit-modal" id="catEditModal">
    <div class="cat-edit-header">
      <span class="cat-edit-title" id="catEditTitle">新增分类</span>
      <button class="cat-edit-close" onclick="closeCatEditModal()">✕</button>
    </div>
    <div class="cat-edit-body">
      <div class="cat-edit-emoji-row" id="catEditEmojiRow"></div>
      <div class="cat-edit-preview-row">
        <span class="cat-edit-preview" id="catEditPreview">🍜</span>
        <input type="hidden" id="catEditIcon" value="🍜">
        <input type="text" id="catEditName" class="cat-edit-name-input" placeholder="分类名称" maxlength="12">
      </div>
      <div class="cat-edit-parent-row" id="catEditParentRow" style="display:none;">
        <label class="cat-edit-label">归属一级分类</label>
        <select id="catEditParentSel" class="cat-edit-parent-sel"></select>
      </div>
    </div>
    <div class="cat-edit-footer">
      <button class="cat-edit-cancel" onclick="closeCatEditModal()">取消</button>
      <button class="cat-edit-save" id="catEditSaveBtn" onclick="saveCatModal()">保存</button>
    </div>
  </div>

  <!-- 账户底部弹出面板 -->
  <div class="cat-sheet-overlay" id="accSheetOverlay" onclick="closeAccSheet()"></div>
  <div class="cat-sheet" id="accSheet">
    <div class="cat-sheet-header">
      <span class="cat-sheet-title" id="accSheetTitle">选择账户</span>
      <button class="cat-sheet-close" onclick="closeAccSheet()">✕</button>
    </div>
    <div class="cat-sheet-body">
      <div id="accSheetList"></div>
    </div>
  </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

let currentRecordType = 'expense';
let currentParentCatId = null;
let currentSubCatId = null;
let currentCategoryId = null;
let currentImageUrl = null;
let isTemplateMode = false;
let editingRecordId = null;

window.openAddModal = async function(presetDate) {
  editingRecordId = null;
  currentRecordType = 'expense';
  currentParentCatId = null;
  currentSubCatId = null;
  currentCategoryId = null;
  lockBodyScroll();
  document.getElementById('addModal').classList.add('show');
  document.querySelector('#addModal .modal-title').textContent = '记一笔';
  // 重置类型标签
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === 'expense');
  });
  setToAccountVisible(false);
  document.getElementById('recordAmount').value = '';
  document.getElementById('recordNote').value = '';
  document.getElementById('recordDate').value = presetDate || new Date().toISOString().slice(0, 10);
  document.getElementById('recordTime').value = new Date().toTimeString().slice(0, 5);
  document.getElementById('saveAsTemplate').checked = false;
  const tplLabel = document.getElementById('saveTemplateLabel');
  if (tplLabel) {
    tplLabel.style.background = '';
    tplLabel.style.borderColor = '';
    tplLabel.style.color = '';
    tplLabel.style.display = '';
  }
  document.getElementById('templatePanel').style.display = 'none';
  // 重置AI输入区
  document.getElementById('aiParseInput').value = '';
  document.getElementById('aiParseResult').style.display = 'none';
  removeImage();
  updateCatSelectBtn();
  renderAccountSelects();
  renderEntityDatalist();
  await loadTemplates();
  // 聚焦金额输入框
  setTimeout(() => document.getElementById('recordAmount').focus(), 100);
};

window.closeAddModal = function() {
  unlockBodyScroll();
  document.getElementById('addModal').classList.remove('show');
  closeCatSheet();
  // 重置AI输入区
  const aiInput = document.getElementById('aiParseInput');
  const aiResult = document.getElementById('aiParseResult');
  if (aiInput) aiInput.value = '';
  if (aiResult) aiResult.style.display = 'none';
};

// AI智能解析记账文本
window.aiParseText = async function() {
  const input = document.getElementById('aiParseInput');
  const resultEl = document.getElementById('aiParseResult');
  const btn = document.getElementById('aiParseBtn');
  const text = input.value.trim();

  if (!text) {
    showToast('请输入记账内容');
    return;
  }

  btn.disabled = true;
  btn.textContent = '解析中...';
  resultEl.style.display = 'none';

  try {
    const data = await request('/ai/parse', {
      method: 'POST',
      body: JSON.stringify({ text, book_id: state.currentBook })
    });

    resultEl.style.display = 'block';
    const p = data.parsed;
    const typeLabels = { expense: '支出', income: '收入', transfer: '转账' };
    resultEl.innerHTML = `
      <div class="ai-parse-ok">
        <div class="ai-parse-info">
          <span class="ai-parse-type ${esc(p.type)}">${typeLabels[p.type] || ''}</span>
          <span class="ai-parse-amount">¥${Number(p.amount).toFixed(2)}</span>
          <span class="ai-parse-cat">${esc(p.category_icon)} ${esc(p.category_name)}</span>
        </div>
        <div class="ai-parse-detail">${esc(p.account_icon)} ${esc(p.account_name)} · ${esc(p.record_date)}${p.note ? ' · ' + esc(p.note) : ''}</div>
        <button class="ai-parse-apply" onclick='applyParsedResult(${JSON.stringify(p).replace(/'/g, "&#39;")})'>自动填充 →</button>
      </div>
    `;
  } catch (e) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="ai-parse-err">😕 ${e.message || '解析失败，请检查AI配置'}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '解析';
  }
};

// 将AI解析结果应用到表单
window.applyParsedResult = function(p) {
  // 设置类型
  currentRecordType = p.type;
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === p.type);
  });
  setToAccountVisible(p.type === 'transfer');

  // 设置分类：通过getAllCategories查找路径
  const allCats = getAllCategories();
  const cat = allCats.find(c => c.id === p.category_id);
  currentParentCatId = null;
  currentSubCatId = null;
  currentCategoryId = p.category_id;

  if (cat) {
    if (cat.parent_id) {
      const parentCat = allCats.find(c => c.id === cat.parent_id);
      currentParentCatId = parentCat && parentCat.parent_id ? parentCat.parent_id : cat.parent_id;
      currentSubCatId = p.category_id;
    } else {
      currentParentCatId = p.category_id;
      currentSubCatId = null;
    }
  }
  updateCatSelectBtn();

  // 填充表单
  document.getElementById('recordAmount').value = p.amount;
  setAccPickerValue('main', p.account_id);
  if (p.to_account_id) setAccPickerValue('to', p.to_account_id);
  document.getElementById('recordDate').value = p.record_date;
  if (!document.getElementById('recordTime').value) {
    document.getElementById('recordTime').value = new Date().toTimeString().slice(0, 5);
  }
  document.getElementById('recordNote').value = p.note || '';

  // 隐藏AI结果
  document.getElementById('aiParseResult').style.display = 'none';
  document.getElementById('aiParseInput').value = '';

  showToast('已填充，请确认后保存');
};

// 编辑记录 - 打开弹窗并填充已有数据
window.editRecord = async function(r) {
  editingRecordId = r.id;
  lockBodyScroll();
  document.getElementById('addModal').classList.add('show');
  document.querySelector('#addModal .modal-title').textContent = '编辑记录';
  document.getElementById('templatePanel').style.display = 'none';

  // 设置类型
  currentRecordType = r.type;
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === r.type);
  });
  setToAccountVisible(r.type === 'transfer');

  // 设置分类 - 二级层级
  currentParentCatId = null;
  currentSubCatId = null;
  currentCategoryId = r.category_id;

  // 在扁平化的二级分类树中查找该分类属于哪个一级分类
  for (const topCat of state.categories.filter(c => c.type === r.type)) {
    if (topCat.id === r.category_id) {
      currentParentCatId = topCat.id;
      break;
    }
    if ((topCat.children || []).some(c => c.id === r.category_id)) {
      currentParentCatId = topCat.id;
      currentSubCatId = r.category_id;
      break;
    }
  }
  // 兼容旧数据：如果没找到，用parent_id回退
  if (!currentParentCatId && r.category_parent_id) {
    const allCats = getAllCategories();
    const parentCat = allCats.find(c => c.id === r.category_parent_id);
    if (parentCat && parentCat.parent_id) {
      currentParentCatId = parentCat.parent_id;
      currentSubCatId = r.category_id;
    } else {
      currentParentCatId = r.category_parent_id;
      currentSubCatId = r.category_id;
    }
  } else if (!currentParentCatId) {
    currentParentCatId = r.category_id;
  }

  // 先渲染下拉选项（避免设置value后innerHTML被重建丢失值）
  updateCatSelectBtn();
  renderAccountSelects();
  renderEntityDatalist();

  // 填充表单
  document.getElementById('recordAmount').value = r.amount;
  setAccPickerValue('main', r.account_id);
  if (r.to_account_id) setAccPickerValue('to', r.to_account_id);
  document.getElementById('recordDate').value = r.record_date;
  document.getElementById('recordTime').value = r.record_time || '';
  document.getElementById('recordNote').value = r.note || '';
  document.getElementById('saveAsTemplate').checked = false;
  const tplLabel = document.getElementById('saveTemplateLabel');
  if (tplLabel) tplLabel.style.display = 'none';

  // 图片
  removeImage();
  if (r.image_url) {
    currentImageUrl = r.image_url;
    document.getElementById('previewImg').src = r.image_url;
    document.getElementById('imagePreview').style.display = 'block';
    document.getElementById('imageUploadArea').querySelector('.image-upload-label').style.display = 'none';
  }
};

function renderEntityDatalist() {
  const dl = document.getElementById('entityList');
  dl.innerHTML = state.entities.map(e => `<option value="${esc(e.name)}">`).join('');
}

// 图片上传
window.handleImageUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    showToast('上传中...');
    const url = await uploadFile(file);
    currentImageUrl = url;
    document.getElementById('previewImg').src = url;
    document.getElementById('imagePreview').style.display = 'block';
    document.getElementById('imageUploadArea').querySelector('.image-upload-label').style.display = 'none';
    showToast('上传成功');
  } catch (e) {}
};

window.removeImage = function() {
  currentImageUrl = null;
  document.getElementById('imagePreview').style.display = 'none';
  document.getElementById('imageUploadArea').querySelector('.image-upload-label').style.display = 'flex';
  document.getElementById('recordImage').value = '';
};

// 模板面板
function renderTemplatePanel() {
  const panel = document.getElementById('templatePanel');
  const list = document.getElementById('templateList');
  if (state.templates.length === 0) {
    list.innerHTML = '<div class="empty-hint">暂无模板，勾选"存为模板"保存常用交易</div>';
  } else {
    list.innerHTML = state.templates.map(t => {
      const cat = getCategoryById(t.category_id);
      return `
        <div class="template-item" onclick="useTemplate('${t.id}')">
          <span class="template-cat-icon">${esc(cat.icon)}</span>
          <div class="template-info">
            <div class="template-name">${esc(cat.name)}</div>
            <div class="template-amount">${formatMoney(t.amount)}</div>
          </div>
        </div>
      `;
    }).join('');
  }
  panel.style.display = 'block';
}

window.useTemplate = async function(id) {
  const t = state.templates.find(x => x.id === id);
  if (!t) return;
  // 填充表单
  currentRecordType = t.type;
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === t.type);
  });
  setToAccountVisible(t.type === 'transfer');
  currentCategoryId = t.category_id;
  document.getElementById('recordAmount').value = t.amount;
  setAccPickerValue('main', t.account_id);
  if (t.to_account_id) setAccPickerValue('to', t.to_account_id);
  document.getElementById('recordNote').value = t.note || '';
  document.getElementById('templatePanel').style.display = 'none';
  updateCatSelectBtn();
  showToast('模板已填充');
};

// 更新分类选择按钮显示
function updateCatSelectBtn() {
  const categories = state.categories.filter(c => c.type === currentRecordType);
  const btn = document.getElementById('catSelectBtn');
  if (!btn) return;

  if (categories.length === 0) {
    document.getElementById('catSelectIcon').textContent = '💸';
    document.getElementById('catSelectText').textContent = '暂无分类';
    return;
  }

  if (!currentParentCatId || !categories.find(c => c.id === currentParentCatId)) {
    currentParentCatId = categories[0].id;
  }

  const parentCat = categories.find(c => c.id === currentParentCatId);
  let selectedCat = parentCat;

  if (currentSubCatId && parentCat && parentCat.children) {
    const subCat = parentCat.children.find(c => c.id === currentSubCatId);
    if (subCat) selectedCat = subCat;
  }

  if (selectedCat) {
    currentCategoryId = selectedCat.id;
    document.getElementById('catSelectIcon').textContent = selectedCat.icon;
    document.getElementById('catSelectText').textContent = selectedCat.name;
  }
}

// 打开分类底部面板
window.openCatSheet = function() {
  const categories = state.categories.filter(c => c.type === currentRecordType);
  if (categories.length === 0) return;

  if (!currentParentCatId || !categories.find(c => c.id === currentParentCatId)) {
    currentParentCatId = categories[0].id;
  }

  renderCatSheet();
  lockBodyScroll();
  document.getElementById('catSheetOverlay').classList.add('show');
  document.getElementById('catSheet').classList.add('show');
};

window.closeCatSheet = function() {
  _catSheetEditing = false;
  const toggleBtn = document.getElementById('catSheetEditToggle');
  if (toggleBtn) toggleBtn.classList.remove('active');
  unlockBodyScroll();
  document.getElementById('catSheetOverlay').classList.remove('show');
  document.getElementById('catSheet').classList.remove('show');
};

window.toggleCatEditMode = function() {
  _catSheetEditing = !_catSheetEditing;
  const toggleBtn = document.getElementById('catSheetEditToggle');
  toggleBtn.classList.toggle('active', _catSheetEditing);
  toggleBtn.textContent = _catSheetEditing ? '完成' : '修改';
  renderCatSheet();
};

function renderCatSheet() {
  const categories = state.categories.filter(c => c.type === currentRecordType);
  const parentsEl = document.getElementById('catSheetParents');
  const subsEl = document.getElementById('catSheetSubs');
  const editing = _catSheetEditing;

  // 一级分类 + 末尾"+"按钮
  parentsEl.innerHTML = categories.map(cat => `
    <button class="cat-sheet-parent ${cat.id === currentParentCatId ? 'active' : ''} ${editing ? 'edit-mode' : ''}" data-id="${cat.id}">
      ${editing ? `<span class="cat-edit-badge">✏️</span>` : ''}
      <span>${esc(cat.icon)}</span> ${esc(cat.name)}
    </button>
  `).join('') + `
    <button class="cat-sheet-add-tile" onclick="openCatEditModal('add','parent')">
      <span class="cat-sheet-add-icon">＋</span>
      <span class="cat-sheet-add-text">新增</span>
    </button>`;

  parentsEl.querySelectorAll('.cat-sheet-parent').forEach(btn => {
    btn.addEventListener('click', () => {
      if (editing) {
        openCatEditModal('edit', 'parent', btn.dataset.id);
      } else {
        currentParentCatId = btn.dataset.id;
        currentSubCatId = null;
        renderCatSheet();
      }
    });
  });

  // 二级分类 + 末尾"+"按钮
  const parentCat = categories.find(c => c.id === currentParentCatId);
  const subCats = parentCat ? (parentCat.children || []) : [];

  if (subCats.length === 0) {
    currentCategoryId = currentParentCatId;
    subsEl.innerHTML = `
      <div class="cat-sheet-sub active ${editing ? 'edit-mode' : ''}" data-id="${currentParentCatId}">
        ${editing ? `<span class="cat-edit-badge">✏️</span>` : ''}
        <span>${esc(parentCat.icon)}</span> ${esc(parentCat.name)}
      </div>
      <div class="cat-sheet-sub cat-sheet-add-tile" onclick="openCatEditModal('add','sub')">
        <span class="cat-sheet-add-icon">＋</span>
        <span class="cat-sheet-add-text">新增</span>
      </div>`;
  } else {
    if (!currentSubCatId || !subCats.find(c => c.id === currentSubCatId)) {
      currentSubCatId = subCats[0].id;
      currentCategoryId = subCats[0].id;
    }
    subsEl.innerHTML = subCats.map(cat => `
      <div class="cat-sheet-sub ${cat.id === currentSubCatId ? 'active' : ''} ${editing ? 'edit-mode' : ''}" data-id="${cat.id}">
        ${editing ? `<span class="cat-edit-badge">✏️</span>` : ''}
        <span>${esc(cat.icon)}</span> ${esc(cat.name)}
      </div>
    `).join('') + `
      <div class="cat-sheet-sub cat-sheet-add-tile" onclick="openCatEditModal('add','sub')">
        <span class="cat-sheet-add-icon">＋</span>
        <span class="cat-sheet-add-text">新增</span>
      </div>`;
  }

  subsEl.querySelectorAll('.cat-sheet-sub:not(.cat-sheet-add-tile)').forEach(item => {
    item.addEventListener('click', () => {
      if (editing) {
        openCatEditModal('edit', 'sub', item.dataset.id);
      } else {
        currentSubCatId = item.dataset.id;
        currentCategoryId = currentSubCatId;
        updateCatSelectBtn();
        closeCatSheet();
      }
    });
  });
}

// ===== 分类新增/编辑弹窗 =====
let _catEditMode = 'add';   // 'add' | 'edit'
let _catEditLevel = 'parent'; // 'parent' | 'sub'
let _catEditId = null;
let _catSheetEditing = false; // 是否处于"修改"模式

window.openCatEditModal = function(mode, level, catId) {
  _catEditMode = mode;
  _catEditLevel = level;
  _catEditId = catId || null;

  const titleEl = document.getElementById('catEditTitle');
  titleEl.textContent = mode === 'add'
    ? (level === 'parent' ? '新增一级分类' : '新增二级分类')
    : (level === 'parent' ? '编辑一级分类' : '编辑二级分类');

  // 填充归属下拉（仅二级）
  const parentRow = document.getElementById('catEditParentRow');
  const parentSel = document.getElementById('catEditParentSel');
  if (level === 'sub') {
    const parents = state.categories.filter(c => c.type === currentRecordType);
    parentSel.innerHTML = parents.map(c =>
      `<option value="${c.id}" ${c.id === currentParentCatId ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`
    ).join('');
    parentRow.style.display = '';
  } else {
    parentRow.style.display = 'none';
  }

  // 编辑时回填数据
  let initIcon = '🍜', initName = '';
  if (mode === 'edit' && catId) {
    const allCats = state.categories.flatMap(c => [c, ...(c.children || [])]);
    const found = allCats.find(c => c.id === catId);
    if (found) { initIcon = found.icon || '🍜'; initName = found.name || ''; }
    if (level === 'sub' && found?.parent_id) {
      const opt = parentSel.querySelector(`option[value="${found.parent_id}"]`);
      if (opt) opt.selected = true;
    }
  }

  // 初始化输入框值
  document.getElementById('catEditIcon').value = initIcon;
  document.getElementById('catEditPreview').textContent = initIcon;
  document.getElementById('catEditName').value = initName;

  // 动态构建 emoji 选择器：系统分类图标 + 当前账本分类图标 + 兜底常用池
  const _fallbackEmojis = ['🍜','🍔','🍕','🍱','🥗','🛒','🚗','🚌','✈️','🏠','🏋️','🎮','👗','💄','💊','🏥','📚','🎓','🎵','🎨','💡','💰','🎁','🐾','⚽','🎭','☕','🍺','🎪','📱','💻','🔧','🧴','🧾','🏦','💈','🧹','🌿','🎂','🛁','🎯','🏖️','🧘','🚀','🌍','🔑','🎀','🌸'];
  const userCatIcons = state.categories.flatMap(c => [c.icon, ...(c.children || []).map(ch => ch.icon)]).filter(Boolean);
  const emojiRow = document.getElementById('catEditEmojiRow');

  // 先用已有图标渲染，再异步加载系统图标补充
  const buildEmojiGrid = (extraIcons) => {
    const emojiSet = [...new Set([...userCatIcons, ...extraIcons, ..._fallbackEmojis])];
    emojiRow.innerHTML = emojiSet.map(e =>
      `<button type="button" class="cat-edit-emoji-btn${e === (document.getElementById('catEditIcon').value || initIcon) ? ' selected' : ''}" onclick="selectCatEmoji('${e}')">${e}</button>`
    ).join('');
  };
  buildEmojiGrid([]);
  request('/categories/icons').then(sysIcons => {
    if (Array.isArray(sysIcons) && sysIcons.length) buildEmojiGrid(sysIcons);
  }).catch(() => {});

  document.getElementById('catEditOverlay').classList.add('show');
  document.getElementById('catEditModal').classList.add('show');
  document.getElementById('catEditName').focus();
};

window.closeCatEditModal = function() {
  document.getElementById('catEditOverlay').classList.remove('show');
  document.getElementById('catEditModal').classList.remove('show');
};

window.selectCatEmoji = function(emoji) {
  document.getElementById('catEditIcon').value = emoji;
  document.getElementById('catEditPreview').textContent = emoji;
  document.querySelectorAll('.cat-edit-emoji-btn').forEach(b => {
    b.classList.toggle('selected', b.textContent === emoji);
  });
};

window.saveCatModal = async function() {
  const name = document.getElementById('catEditName').value.trim();
  const icon = document.getElementById('catEditIcon').value || '🍜';
  if (!name) { showToast('请输入分类名称'); return; }
  const saveBtn = document.getElementById('catEditSaveBtn');
  saveBtn.disabled = true;
  try {
    if (_catEditMode === 'add') {
      const parentId = _catEditLevel === 'sub'
        ? (document.getElementById('catEditParentSel')?.value || currentParentCatId || null)
        : null;
      await request('/categories', { method: 'POST', body: JSON.stringify({
        name, icon, type: currentRecordType,
        book_id: state.currentBook,
        parent_id: parentId || undefined
      })});
      await loadCategories();
      if (_catEditLevel === 'parent') {
        const newCat = state.categories.filter(c => c.type === currentRecordType).at(-1);
        if (newCat) currentParentCatId = newCat.id;
      }
      showToast('分类已添加');
    } else {
      await request(`/categories/${_catEditId}`, { method: 'PUT', body: JSON.stringify({ name, icon, color: '#3b82f6' }) });
      await loadCategories();
      showToast('分类已更新');
    }
    closeCatEditModal();
    renderCatSheet();
  } catch (e) {
    showToast('保存失败：' + (e.message || '未知错误'));
  } finally {
    saveBtn.disabled = false;
  }
};
const _accTypeNames = {
  cash: '现金', bank: '银行卡', credit: '信用卡',
  wechat: '微信', alipay: '支付宝', invest: '投资理财', other: '其他'
};
const _accTypeIcons = {
  cash: '💵', wechat: '💬', alipay: '💰', bank: '💳',
  credit: '💳', invest: '📈', other: '📂'
};
const _accTypeColors = {
  cash:   { bg: 'linear-gradient(135deg,#4ade80,#16a34a)', text: '#14532d' },
  wechat: { bg: 'linear-gradient(135deg,#4ade80,#22c55e)', text: '#14532d' },
  alipay: { bg: 'linear-gradient(135deg,#60a5fa,#2563eb)', text: '#1e3a8a' },
  bank:   { bg: 'linear-gradient(135deg,#818cf8,#6366f1)', text: '#312e81' },
  credit: { bg: 'linear-gradient(135deg,#f472b6,#db2777)', text: '#831843' },
  invest: { bg: 'linear-gradient(135deg,#fbbf24,#d97706)', text: '#78350f' },
  other:  { bg: 'linear-gradient(135deg,#94a3b8,#64748b)', text: '#1e293b' },
};
const _accGroupOrder = ['cash', 'wechat', 'alipay', 'bank', 'credit', 'invest', 'other'];
let _accSheetWhich = 'main';

function formatBalance(acc) {
  const bal = Number(acc.balance);
  if (acc.type === 'credit') {
    return bal < 0 ? `待还 ¥${Math.abs(bal).toFixed(2)}` : `¥${bal.toFixed(2)}`;
  }
  return `¥${bal.toFixed(2)}`;
}

window.openAccSheet = function(which) {
  _accSheetWhich = which;
  const title = document.getElementById('accSheetTitle');
  if (title) title.textContent = which === 'main' ? '选择账户' : '选择转入账户';

  const currentId = document.getElementById(which === 'main' ? 'recordAccount' : 'recordToAccount').value;
  const groups = {};
  state.accounts.forEach(a => {
    if (!groups[a.type]) groups[a.type] = [];
    groups[a.type].push(a);
  });

  let html = '';
  _accGroupOrder.forEach(type => {
    const list = groups[type];
    if (!list || list.length === 0) return;
    const typeColor = _accTypeColors[type] || _accTypeColors.other;
    html += `<div class="acc-sheet-group-label">${_accTypeIcons[type]} ${_accTypeNames[type] || type}</div>`;
    list.forEach(a => {
      const bal = formatBalance(a);
      const isSelected = String(a.id) === String(currentId);
      const isCreditDue = a.type === 'credit' && Number(a.balance) < 0;
      html += `<div class="acc-sheet-item ${isSelected ? 'selected' : ''}" onclick="selectAccFromSheet('${a.id}','${esc(a.icon)}','${esc(a.name)}','${esc(bal)}')">
        <span class="acc-sheet-icon" style="background:${typeColor.bg};">${esc(a.icon)}</span>
        <span class="acc-sheet-info">
          <span class="acc-sheet-name">${esc(a.name)}</span>
          <span class="acc-sheet-bal ${isCreditDue ? 'credit-due' : ''}">${esc(bal)}</span>
        </span>
        ${isSelected ? '<span class="acc-sheet-check">✓</span>' : ''}
      </div>`;
    });
  });

  document.getElementById('accSheetList').innerHTML = html;
  lockBodyScroll();
  document.getElementById('accSheetOverlay').classList.add('show');
  document.getElementById('accSheet').classList.add('show');
};

window.closeAccSheet = function() {
  unlockBodyScroll();
  document.getElementById('accSheetOverlay').classList.remove('show');
  document.getElementById('accSheet').classList.remove('show');
};

window.selectAccFromSheet = function(id, icon, name, bal) {
  const which = _accSheetWhich;
  const hiddenId = which === 'main' ? 'recordAccount'  : 'recordToAccount';
  const iconId   = which === 'main' ? 'accSelectIcon'  : 'toAccSelectIcon';
  const nameId   = which === 'main' ? 'accSelectText'  : 'toAccSelectText';
  const balId    = which === 'main' ? 'accSelectBal'   : 'toAccSelectBal';
  document.getElementById(hiddenId).value = id;
  document.getElementById(iconId).textContent = icon;
  document.getElementById(nameId).textContent = name;
  document.getElementById(balId).textContent  = bal;
  closeAccSheet();
};

function setToAccountVisible(visible) {
  document.getElementById('toAccountGroup').style.display = visible ? 'block' : 'none';
  const row = document.getElementById('accountFormRow');
  if (row) {
    row.classList.toggle('single-col', !visible);
    row.classList.toggle('transfer-col', visible);
  }
  // 转账时标签改为"转出账户"，否则还原"账户"
  const mainLabel = document.querySelector('#accountFormRow > .form-group:first-child > .form-label');
  if (mainLabel) mainLabel.textContent = visible ? '转出账户' : '账户';
}

function setAccPickerValue(which, accountId) {
  const acc = state.accounts.find(a => String(a.id) === String(accountId));
  if (!acc) return;
  const prev = _accSheetWhich;
  _accSheetWhich = which;
  const hiddenId = which === 'main' ? 'recordAccount'  : 'recordToAccount';
  const iconId   = which === 'main' ? 'accSelectIcon'  : 'toAccSelectIcon';
  const nameId   = which === 'main' ? 'accSelectText'  : 'toAccSelectText';
  const balId    = which === 'main' ? 'accSelectBal'   : 'toAccSelectBal';
  document.getElementById(hiddenId).value = acc.id;
  document.getElementById(iconId).textContent = acc.icon;
  document.getElementById(nameId).textContent = acc.name;
  document.getElementById(balId).textContent  = formatBalance(acc);
  _accSheetWhich = prev;
}

function renderAccountSelects() {
  if (state.accounts.length > 0) {
    setAccPickerValue('main', state.accounts[0].id);
    setAccPickerValue('to', state.accounts.length > 1 ? state.accounts[1].id : state.accounts[0].id);
  }
}

// 点击面板外关闭
document.addEventListener('click', (e) => {
  if (!e.target.closest('.acc-picker')) {
    document.querySelectorAll('.acc-picker-panel.open').forEach(p => p.classList.remove('open'));
  }
});

// 事件绑定
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('type-tab')) {
    document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
    e.target.classList.add('active');
    currentRecordType = e.target.dataset.type;
    currentParentCatId = null;
    currentSubCatId = null;
    currentCategoryId = null;
    setToAccountVisible(currentRecordType === 'transfer');
    document.getElementById('templatePanel').style.display = 'none';
    updateCatSelectBtn();
  }

  if (e.target.id === 'addModal') closeAddModal();

  if (e.target.id === 'noticeModal') closeNoticeModal();

  if (e.target.id === 'templateToggleBtn') {
    const panel = document.getElementById('templatePanel');
    if (panel.style.display === 'none') {
      renderTemplatePanel();
    } else {
      panel.style.display = 'none';
    }
  }
});

// 保存记录
window.saveRecord = async function() {
  const amount = parseFloat(document.getElementById('recordAmount').value);
  if (!amount || amount <= 0) return showToast('请输入有效金额');
  if (!currentCategoryId) return showToast('请选择分类');

  const note = document.getElementById('recordNote').value.trim();
  const isTemplate = document.getElementById('saveAsTemplate').checked;

  // 如果输入了新商家名，自动保存
  if (note && !state.entities.find(e => e.name === note)) {
    try {
      await request('/entities', {
        method: 'POST',
        body: JSON.stringify({ book_id: state.currentBook, name: note, type: 'merchant', icon: '🏪' })
      });
      state.entities.push({ id: Date.now(), name: note, type: 'merchant', icon: '🏪' });
    } catch (e) {}
  }

  const body = {
    book_id: state.currentBook,
    type: currentRecordType,
    category_id: currentCategoryId,
    amount,
    account_id: document.getElementById('recordAccount').value,  // 雪花ID保持字符串
    to_account_id: currentRecordType === 'transfer' ? document.getElementById('recordToAccount').value : null,
    note,
    record_date: document.getElementById('recordDate').value,
    record_time: document.getElementById('recordTime').value || null,
    image_url: currentImageUrl
  };

  try {
    if (editingRecordId) {
      await request(`/records/${editingRecordId}`, { method: 'PUT', body: JSON.stringify(body) });
      showToast('修改成功');
    } else {
      body.is_template = isTemplate;
      await request('/records', { method: 'POST', body: JSON.stringify(body) });
      showToast(isTemplate ? '已保存为模板并记账' : '记账成功');
    }
    closeAddModal();
    await loadAccounts();
    if (typeof pageRefresh === 'function') pageRefresh();
  } catch (e) {}
};

// ===== AI栏语音识别 =====
let aiVoiceRecognition = null;
let aiVoiceTimer = null;
let aiVoiceSaved = false;

window.toggleAiVoice = function() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    const isHttp = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
    showToast(isHttp ? '语音识别需要HTTPS环境' : '您的浏览器不支持语音识别，请使用Chrome/Edge浏览器');
    return;
  }
  const btn = document.getElementById('aiVoiceBtn');

  if (!aiVoiceRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    aiVoiceRecognition = recognition;

    function resetBtn() {
      btn.style.background = '';
      btn.style.color = '';
      btn.textContent = '🎤';
      if (aiVoiceTimer) { clearTimeout(aiVoiceTimer); aiVoiceTimer = null; }
    }

    recognition.onstart = () => {
      btn.style.background = '#ef4444';
      btn.style.color = 'white';
      btn.textContent = '🔴';
      aiVoiceSaved = false;
      if (aiVoiceTimer) clearTimeout(aiVoiceTimer);
      aiVoiceTimer = setTimeout(() => { try { recognition.stop(); } catch (e) {} }, 8000);
    };

    recognition.onresult = (e) => {
      let finalText = '', interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += transcript;
        else interimText += transcript;
      }
      document.getElementById('aiParseInput').value = (finalText + interimText).trim();
      if (finalText.trim() && !aiVoiceSaved) {
        aiVoiceSaved = true;
        const text = finalText.trim();
        document.getElementById('aiParseInput').value = text;
        try { recognition.stop(); } catch (e) {}
        clearTimeout(aiVoiceTimer);
        resetBtn();
        showToast('识别到：' + text);
        aiParseText();
      }
    };

    recognition.onend = () => {
      clearTimeout(aiVoiceTimer);
      resetBtn();
      if (!aiVoiceSaved) {
        const text = (document.getElementById('aiParseInput').value || '').trim();
        if (text) { aiParseText(); }
      }
    };

    recognition.onerror = (e) => {
      clearTimeout(aiVoiceTimer);
      resetBtn();
      if (e.error === 'aborted') return;
      const msgs = {
        'no-speech': '没有检测到说话',
        'not-allowed': '请允许麦克风权限',
        'service-not-allowed': '语音服务被禁用',
        'network': '网络异常（语音服务在国内可能需要翻墙）',
        'audio-capture': '未检测到麦克风'
      };
      showToast(msgs[e.error] || '识别失败：' + e.error);
    };
  }

  clearTimeout(aiVoiceTimer);
  aiVoiceSaved = false;
  try {
    aiVoiceRecognition.start();
  } catch (err) {
    try { aiVoiceRecognition.stop(); } catch (e) {}
  }
};

// ===== 通知公告铃铛 =====
function renderNoticeBell(activePage) {
  if (activePage === 'bills') return; // 账单页顶栏按钮已满，不注入通知铃铛
  if (document.getElementById('noticeBell')) return;
  const bell = document.createElement('button');
  bell.id = 'noticeBell';
  bell.className = 'notice-bell';
  bell.setAttribute('aria-label', '通知公告');
  bell.innerHTML =
    '<span class="notice-bell-icon">🔔</span>' +
    '<span class="notice-bell-badge" id="noticeBadge" style="display:none;">0</span>';
  bell.addEventListener('click', openNoticeModal);

  // .top-bar 页面（bills/accounts/loans）：作为 flex 子元素插到标题之后
  const topBar = document.querySelector('.top-bar');
  if (topBar) {
    bell.classList.add('notice-bell-inbar');
    const title = topBar.querySelector('.top-bar-title');
    if (title && title.nextSibling) topBar.insertBefore(bell, title.nextSibling);
    else topBar.appendChild(bell);
    return;
  }

  // 渐变头部页面（home/reports/profile）：绝对定位右上角
  const header = document.querySelector('.home-header, .reports-header, .profile-header');
  if (header) {
    bell.classList.add('notice-bell-ondark');
    const pos = getComputedStyle(header).position;
    if (pos === 'static') header.style.position = 'relative';
    header.appendChild(bell);
  }
}

function renderNoticeModal() {
  if (document.getElementById('noticeModal')) return;
  const html = `
  <div class="modal" id="noticeModal">
    <div class="modal-content notice-modal-content">
      <div class="modal-header">
        <button class="modal-close" onclick="closeNoticeModal()">✕</button>
        <span class="modal-title">🔔 消息中心</span>
        <button class="notice-readall-btn" id="noticeReadAllBtn" onclick="markAllNoticesRead()">全部已读</button>
      </div>
      <div class="notice-tabs">
        <button class="notice-tab active" data-tab="notif" onclick="switchNoticeTab('notif')">
          我的提醒<span class="notice-tab-badge" id="notifTabBadge"></span>
        </button>
        <button class="notice-tab" data-tab="notice" onclick="switchNoticeTab('notice')">
          系统公告<span class="notice-tab-badge" id="noticeTabBadge"></span>
        </button>
      </div>
      <div class="modal-body" id="noticeListPanel">
        <div id="notifList"></div>
        <div class="notice-loadmore" id="notifLoadMore" style="display:none;">
          <button onclick="loadMoreNotifs()">加载更多</button>
        </div>
        <div id="noticeList" style="display:none;"></div>
        <div class="notice-loadmore" id="noticeLoadMore" style="display:none;">
          <button onclick="loadMoreNotices()">加载更多</button>
        </div>
      </div>
      <div class="modal-body" id="noticeDetailPanel" style="display:none;">
        <button class="notice-back-btn" onclick="backToNoticeList()">‹ 返回列表</button>
        <h2 class="notice-detail-title" id="noticeDetailTitle"></h2>
        <div class="notice-detail-meta" id="noticeDetailMeta"></div>
        <div class="notice-detail-content" id="noticeDetailContent"></div>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// 当前激活的tab
let currentNoticeTab = 'notif';
let notifListPage = 1;
let notifHasMore = false;
let notifLoading = false;

// 切换tab
window.switchNoticeTab = function(tab) {
  currentNoticeTab = tab;
  document.querySelectorAll('.notice-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  if (tab === 'notif') {
    document.getElementById('notifList').style.display = '';
    document.getElementById('noticeList').style.display = 'none';
    document.getElementById('notifLoadMore').style.display = notifHasMore ? '' : 'none';
    document.getElementById('noticeLoadMore').style.display = 'none';
    loadNotifList(1);
  } else {
    document.getElementById('notifList').style.display = 'none';
    document.getElementById('noticeList').style.display = '';
    document.getElementById('notifLoadMore').style.display = 'none';
    document.getElementById('noticeLoadMore').style.display = noticeHasMore ? '' : 'none';
    loadNoticeList(1);
  }
};

// 更新tab上的小徽章
function updateTabBadges() {
  const notifBadge = document.getElementById('notifTabBadge');
  const noticeBadge = document.getElementById('noticeTabBadge');
  if (notifBadge) {
    notifBadge.textContent = state.unreadNotifCount > 0 ? state.unreadNotifCount : '';
    notifBadge.style.display = state.unreadNotifCount > 0 ? '' : 'none';
  }
  if (noticeBadge) {
    noticeBadge.textContent = state.unreadCount > 0 ? state.unreadCount : '';
    noticeBadge.style.display = state.unreadCount > 0 ? '' : 'none';
  }
}

// 加载个人通知列表
async function loadNotifList(page) {
  if (notifLoading) return;
  notifLoading = true;
  const listEl = document.getElementById('notifList');
  const loadMoreEl = document.getElementById('notifLoadMore');
  try {
    if (page === 1) listEl.innerHTML = '<div class="notice-empty">加载中...</div>';
    const data = await request(`/notifications?page=${page}&page_size=20`);
    notifListPage = page;
    notifHasMore = data.has_more;
    if (page === 1 && data.list.length === 0) {
      listEl.innerHTML = '<div class="notice-empty">暂无提醒消息</div>';
      loadMoreEl.style.display = 'none';
      return;
    }
    const typeIcon = { loan_due: '🤝', credit_due: '💳', system: '📢' };
    const items = data.list.map(n => {
      const icon = typeIcon[n.type] || '🔔';
      const time = formatNoticeTime(n.created_at);
      const clickAction = n.related_type === 'loan'
        ? `onclick="openNotifDetail(${n.id}, '${n.related_type}', '${n.related_id}')"`
        : `onclick="openNotifDetail(${n.id})"`;
      return `
      <div class="notice-item ${n.is_read ? 'read' : ''}" data-notif-id="${n.id}" ${clickAction}>
        <span class="notice-unread-dot ${n.is_read ? 'read' : ''}"></span>
        <div class="notice-item-body">
          <div class="notice-item-title">${icon} ${esc(n.title)}</div>
          <div class="notice-item-content-preview">${esc(n.content)}</div>
          <div class="notice-item-meta">
            <span>${time}</span>
            <button class="notice-item-del" onclick="event.stopPropagation();deleteNotif(${n.id})">删除</button>
          </div>
        </div>
      </div>`;
    }).join('');
    if (page === 1) listEl.innerHTML = items;
    else listEl.insertAdjacentHTML('beforeend', items);
    loadMoreEl.style.display = data.has_more ? '' : 'none';
  } catch (e) {
    if (page === 1) listEl.innerHTML = '<div class="notice-empty">加载失败</div>';
  } finally {
    notifLoading = false;
  }
}

window.loadMoreNotifs = function() {
  if (notifHasMore && !notifLoading) loadNotifList(notifListPage + 1);
};

// 打开通知详情（标记已读，如果关联借贷则跳转）
window.openNotifDetail = async function(id, relatedType, relatedId) {
  try {
    await request(`/notifications/${id}/read`, { method: 'POST' });
    state.unreadNotifCount = Math.max(0, state.unreadNotifCount - 1);
    refreshUnreadCount();
    updateTabBadges();
    const itemEl = document.querySelector(`.notice-item[data-notif-id="${id}"]`);
    if (itemEl) {
      itemEl.classList.add('read');
      const dot = itemEl.querySelector('.notice-unread-dot');
      if (dot) dot.classList.add('read');
    }
    // 如果关联借贷，跳转到借贷页
    if (relatedType === 'loan' && relatedId) {
      closeNoticeModal();
      const isPC = location.pathname.startsWith('/pc/');
      setTimeout(() => { location.href = isPC ? '/pc/loans.html' : '/loans.html'; }, 300);
    }
  } catch (e) { console.error('[openNotifDetail]', e); }
};

// 删除通知
window.deleteNotif = async function(id) {
  try {
    await request(`/notifications/${id}`, { method: 'DELETE' });
    const item = document.querySelector(`.notice-item[data-notif-id="${id}"]`);
    if (item) item.remove();
    const listEl = document.getElementById('notifList');
    if (listEl && !listEl.children.length) {
      listEl.innerHTML = '<div class="notice-empty">暂无提醒消息</div>';
    }
    refreshUnreadCount();
  } catch (e) {}
};

// 居中弹窗公告（系统升级/重要通知，需用户确认）
function renderNoticePopup() {
  if (document.getElementById('noticePopupModal')) return;
  const html = `
  <div class="notice-popup-overlay" id="noticePopupModal">
    <div class="notice-popup-dialog">
      <div class="notice-popup-header">
        <span class="notice-popup-icon">📣</span>
        <span class="notice-popup-title" id="noticePopupTitle"></span>
      </div>
      <div class="notice-popup-body" id="noticePopupContent"></div>
      <div class="notice-popup-footer">
        <span class="notice-popup-date" id="noticePopupDate"></span>
        <button class="notice-popup-btn" id="noticePopupConfirm">我知道了</button>
      </div>
    </div>
  </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  document.getElementById('noticePopupConfirm').addEventListener('click', confirmPopupNotice);
}

let popupQueue = [];
let popupShowing = false;

async function checkPopupNotices() {
  try {
    const data = await request('/notice/popup');
    if (!data.list || data.list.length === 0) return;
    popupQueue = data.list;
    showNextPopupNotice();
  } catch (e) { /* 静默失败 */ }
}

function showNextPopupNotice() {
  if (popupShowing) return;
  const notice = popupQueue.shift();
  if (!notice) return;
  popupShowing = true;
  document.getElementById('noticePopupTitle').textContent = notice.notice_title;
  document.getElementById('noticePopupContent').textContent = notice.notice_content;
  document.getElementById('noticePopupDate').textContent = formatNoticeTime(notice.created_at);
  const modal = document.getElementById('noticePopupModal');
  modal.dataset.noticeId = notice.id;
  lockBodyScroll();
  modal.classList.add('show');
}

async function confirmPopupNotice() {
  const modal = document.getElementById('noticePopupModal');
  const id = modal.dataset.noticeId;
  modal.classList.remove('show');
  unlockBodyScroll();
  popupShowing = false;
  if (id) {
    try {
      await request(`/notice/${id}/read`, { method: 'POST' });
      refreshUnreadCount();
    } catch (e) {}
  }
  // 显示队列中的下一条
  setTimeout(showNextPopupNotice, 200);
}

let noticeListPage = 1;
let noticeHasMore = false;
let noticeLoading = false;

async function refreshUnreadCount() {
  try {
    const [noticeData, notifData] = await Promise.all([
      request('/notice/unread-count').catch(() => ({})),
      request('/notifications/unread-count').catch(() => ({}))
    ]);
    state.unreadCount = noticeData.unread_count || 0;
    state.unreadNotifCount = notifData.unread_count || 0;
    if (noticeData.is_admin !== undefined) state.isAdmin = !!noticeData.is_admin;
    const total = state.unreadCount + state.unreadNotifCount;
    const badge = document.getElementById('noticeBadge');
    if (badge) {
      if (total > 0) {
        badge.style.display = '';
        badge.textContent = total > 99 ? '99+' : total;
      } else {
        badge.style.display = 'none';
      }
    }
  } catch (e) { /* 静默失败，不阻塞页面 */ }
}

window.openNoticeModal = function() {
  document.getElementById('noticeDetailPanel').style.display = 'none';
  document.getElementById('noticeListPanel').style.display = '';
  updateTabBadges();
  switchNoticeTab(currentNoticeTab);
  lockBodyScroll();
  document.getElementById('noticeModal').classList.add('show');
};

window.closeNoticeModal = function() {
  unlockBodyScroll();
  document.getElementById('noticeModal').classList.remove('show');
  refreshUnreadCount();
};

async function loadNoticeList(page) {
  if (noticeLoading) return;
  noticeLoading = true;
  const listEl = document.getElementById('noticeList');
  const loadMoreEl = document.getElementById('noticeLoadMore');
  try {
    if (page === 1) listEl.innerHTML = '<div class="notice-empty">加载中...</div>';
    const data = await request(`/notice?page=${page}&page_size=20`);
    noticeListPage = page;
    noticeHasMore = data.has_more;
    if (page === 1 && data.list.length === 0) {
      listEl.innerHTML = '<div class="notice-empty">暂无通知</div>';
      loadMoreEl.style.display = 'none';
      return;
    }
    const items = data.list.map(n => `
      <div class="notice-item ${n.is_read ? 'read' : ''}" data-notice-id="${n.id}" onclick="openNoticeDetail('${n.id}')">
        <span class="notice-unread-dot ${n.is_read ? 'read' : ''}"></span>
        <div class="notice-item-body">
          <div class="notice-item-title">${esc(n.notice_title)}</div>
          <div class="notice-item-meta">
            <span class="notice-tag">${n.notice_type === '2' ? '公告' : '通知'}</span>
            ${n.is_popup == 1 ? '<span class="notice-tag notice-tag-popup">弹窗</span>' : ''}
            <span>${formatNoticeTime(n.created_at)}</span>
          </div>
        </div>
      </div>`).join('');
    if (page === 1) listEl.innerHTML = items;
    else listEl.insertAdjacentHTML('beforeend', items);
    loadMoreEl.style.display = data.has_more ? '' : 'none';
  } catch (e) {
    if (page === 1) listEl.innerHTML = '<div class="notice-empty">加载失败</div>';
  } finally {
    noticeLoading = false;
  }
}

window.loadMoreNotices = function() {
  if (noticeHasMore && !noticeLoading) loadNoticeList(noticeListPage + 1);
};

window.openNoticeDetail = async function(id) {
  try {
    const n = await request(`/notice/${id}`);
    document.getElementById('noticeListPanel').style.display = 'none';
    document.getElementById('noticeDetailPanel').style.display = '';
    document.getElementById('noticeDetailTitle').textContent = n.notice_title;
    document.getElementById('noticeDetailMeta').textContent =
      `${n.notice_type === '2' ? '公告' : '通知'} · ${formatNoticeTime(n.created_at)}`;
    document.getElementById('noticeDetailContent').textContent = n.notice_content;
    request(`/notice/${id}/read`, { method: 'POST' }).then(() => {
      refreshUnreadCount();
      const itemEl = document.querySelector(`.notice-item[data-notice-id="${id}"]`);
      if (itemEl) {
        itemEl.classList.add('read');
        const dot = itemEl.querySelector('.notice-unread-dot');
        if (dot) dot.classList.add('read');
      }
    }).catch(e => console.error('[mark read]', e));
  } catch (e) {
    console.error('[openNoticeDetail]', e);
  }
};

window.backToNoticeList = function() {
  document.getElementById('noticeDetailPanel').style.display = 'none';
  document.getElementById('noticeListPanel').style.display = '';
  if (currentNoticeTab === 'notif') loadNotifList(1);
  else loadNoticeList(1);
};

window.markAllNoticesRead = async function() {
  try {
    await Promise.all([
      request('/notice/read-all', { method: 'POST' }).catch(() => {}),
      request('/notifications/read-all', { method: 'POST' }).catch(() => {})
    ]);
    showToast('已全部标为已读');
    state.unreadCount = 0;
    state.unreadNotifCount = 0;
    updateTabBadges();
    if (currentNoticeTab === 'notif') loadNotifList(1);
    else loadNoticeList(1);
    refreshUnreadCount();
  } catch (e) {}
};

function formatNoticeTime(s) {
  if (!s) return '';
  return String(s).replace('T', ' ').slice(0, 16);
}

// ===== 初始化 =====
async function initCommon(activePage) {
  if (!requireAuth()) return;

  if (!state.currentBook) {
    try {
      const books = await request('/books');
      if (books.length > 0) {
        state.currentBook = books[0].id;
        localStorage.setItem('ledger_book', books[0].id);
      } else {
        // 没有任何账本，说明用户数据异常，重新登录
        logout();
        return;
      }
    } catch (e) { console.error(e); }
  }

  await Promise.all([loadCategories(), loadAccounts(), loadEntities(), loadBooks()]);

  renderBottomNav(activePage);
  renderAddModal();
  renderNoticeBell(activePage);
  renderNoticeModal();
  renderNoticePopup();

  // "存为模板"复选框视觉反馈
  document.getElementById('saveAsTemplate').addEventListener('change', function() {
    const label = document.getElementById('saveTemplateLabel');
    if (this.checked) {
      label.style.background = 'rgba(102,126,234,0.08)';
      label.style.borderColor = 'var(--primary-light)';
      label.style.color = 'var(--primary)';
    } else {
      label.style.background = '';
      label.style.borderColor = '';
      label.style.color = '';
    }
  });

  // AI解析输入框回车触发
  document.getElementById('aiParseInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      aiParseText();
    }
  });

  await refreshUnreadCount();
  if (state.noticePollTimer) clearInterval(state.noticePollTimer);
  state.noticePollTimer = setInterval(refreshUnreadCount, 60000);
  // 检查弹窗公告（系统升级/重要通知）
  checkPopupNotices();

  if (typeof pageInit === 'function') await pageInit();
}

// ===== PC / 移动端切换 =====
// 移动端页面 → PC 端对应页面映射
const _PC_PAGE_MAP = {
  '/index.html': '/pc/index.html',
  '/bills.html': '/pc/bills.html',
  '/accounts.html': '/pc/accounts.html',
  '/reports.html': '/pc/reports.html',
  '/': '/pc/index.html',
  '': '/pc/index.html',
};

// 手动切换到 PC 版
// 窄屏（手机）访问时弹确认，避免误操作；宽屏（PC浏览器）直接切换
window.switchToPC = function() {
  const doSwitch = () => {
    localStorage.setItem('preferredLayout', 'pc');
    const page = location.pathname;
    const dest = _PC_PAGE_MAP[page] || '/pc/index.html';
    location.href = dest;
  };
  // 宽屏（PC浏览器访问）直接跳，不打扰
  if (window.innerWidth >= 900) {
    doSwitch();
    return;
  }
  // 手机端：确认后再切换
  if (confirm('PC版针对大屏键鼠操作设计，移动端设备屏幕较小，确定要切换到PC版吗？')) {
    doSwitch();
  }
};

// 自动检测：宽屏且未手动选择移动端时，跳转到 PC 版
// 在 <head> 引入 common.js 后、DOM 加载前尽早执行，避免闪烁
(function autoRedirectToPC() {
  try {
    // 已在 PC 目录不处理
    if (location.pathname.startsWith('/pc/')) return;
    // 登录页不处理
    if (location.pathname.includes('login')) return;
    const pref = localStorage.getItem('preferredLayout');
    if (pref === 'mobile') return;            // 用户明确选了移动端
    const isWide = window.innerWidth >= 900;
    if (pref === 'pc' || isWide) {
      const dest = _PC_PAGE_MAP[location.pathname];
      if (dest) location.replace(dest);
    }
  } catch (e) { /* 忽略，继续用移动端 */ }
})();
