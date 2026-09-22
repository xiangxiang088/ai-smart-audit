/**
 * PC端记一笔模块（完全独立，不使用移动端底部弹窗）
 * 功能与移动端一致，但UI全部为居中弹窗风格
 * 依赖：common.js（API、state、工具函数）
 */

// ===== 渲染PC端记一笔弹窗HTML（覆盖common.js的同名函数） =====
function renderAddModal() {
  // 移除已有弹窗（如果存在）
  const old = document.getElementById('addModal');
  if (old) old.parentElement.removeChild(old);
  document.querySelectorAll('.pc-dialog-overlay[data-pc-add]').forEach(e => e.remove());
  document.querySelectorAll('.pc-cat-dialog, .pc-acc-dialog').forEach(e => e.remove());

  const modalHtml = `
  <div class="modal" id="addModal">
    <div class="modal-content add-modal-content">
      <div class="modal-header">
        <button class="modal-close" onclick="closeAddModal()">✕</button>
        <span class="modal-title">记一笔</span>
        <button class="modal-template-btn" id="templateToggleBtn" title="模板记账">📋</button>
      </div>
      <div class="modal-body add-modal-body">
        <!-- AI智能输入 -->
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

        <div class="pc-add-grid">
          <!-- 左列：金额 + 分类 -->
          <div class="pc-add-section">
            <div class="pc-add-section-label">金额</div>
            <div class="amount-input-wrap">
              <span class="amount-currency">¥</span>
              <input type="number" id="recordAmount" class="amount-input" placeholder="0.00" step="0.01">
            </div>

            <div class="pc-add-section-label">分类</div>
            <button class="cat-select-btn" id="catSelectBtn" onclick="openCatSheet()">
              <span class="cat-select-icon" id="catSelectIcon">🍜</span>
              <span class="cat-select-text" id="catSelectText">选择分类</span>
              <span class="cat-select-arrow">›</span>
            </button>
          </div>

          <!-- 右列：账户 + 日期 + 备注 -->
          <div class="pc-add-section">
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
          </div>
        </div>

        <!-- 图片上传 -->
        <div class="image-upload-area" id="imageUploadArea" style="margin-top:14px;">
          <label class="image-upload-label" for="recordImage">
            <span>📷 添加小票</span>
          </label>
          <input type="file" id="recordImage" accept="image/*" style="display:none;" onchange="handleImageUpload(event)">
          <div class="image-preview" id="imagePreview" style="display:none;">
            <img id="previewImg" src="">
            <button class="image-remove" onclick="removeImage()">✕</button>
          </div>
        </div>

        <label class="save-template-label" id="saveTemplateLabel" style="margin-top:12px;">
          <input type="checkbox" id="saveAsTemplate">
          <span class="save-template-text">📋 同时存为模板</span>
        </label>
      </div>
      <div class="modal-footer">
        <button class="btn-primary btn-save" onclick="saveRecord()">保存</button>
      </div>
    </div>
  </div>

  <!-- PC端遮罩层（分类/账户选择共用） -->
  <div class="pc-dialog-overlay" id="pcCatOverlay" data-pc-add="1" onclick="closeCatSheet()"></div>

  <!-- PC端分类选择弹窗 -->
  <div class="pc-cat-dialog" id="pcCatDialog">
    <div class="pc-cat-dialog-header">
      <button class="pc-cat-dialog-close" onclick="closeCatSheet()">✕</button>
      <span class="pc-cat-dialog-title">选择分类</span>
      <button class="pc-cat-dialog-close" id="pcCatEditToggle" onclick="toggleCatEditMode()" style="background:transparent;width:auto;height:auto;padding:4px 12px;font-size:13px;border-radius:6px;">修改</button>
    </div>
    <div class="pc-cat-dialog-body" id="pcCatDialogBody"></div>
  </div>

  <!-- PC端账户选择弹窗 -->
  <div class="pc-cat-dialog pc-acc-dialog" id="pcAccDialog">
    <div class="pc-cat-dialog-header">
      <span class="pc-cat-dialog-title" id="pcAccDialogTitle">选择账户</span>
      <button class="pc-cat-dialog-close" onclick="closeAccSheet()">✕</button>
    </div>
    <div class="pc-cat-dialog-body" id="pcAccDialogBody"></div>
  </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// ===== 状态变量复用 common.js 中已声明的同名变量 =====
// （common.js 已声明：currentRecordType/currentParentCatId/currentSubCatId/currentCategoryId/
//   currentImageUrl/isTemplateMode/editingRecordId/_catSheetEditing/_catEditMode/_catEditLevel/
//   _catEditId/_accSheetWhich/_accTypeNames/_accTypeIcons/_accTypeColors/_accGroupOrder/formatBalance）

// ===== 打开/关闭主弹窗 =====
window.openAddModal = async function(presetDate) {
  editingRecordId = null;
  currentRecordType = 'expense';
  currentParentCatId = null;
  currentSubCatId = null;
  currentCategoryId = null;
  document.getElementById('addModal').classList.add('show');
  document.querySelector('#addModal .modal-title').textContent = '记一笔';
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === 'expense');
  });
  setToAccountVisible(false);
  document.getElementById('recordAmount').value = '';
  document.getElementById('recordNote').value = '';
  document.getElementById('recordDate').value = presetDate || new Date().toISOString().slice(0,10);
  document.getElementById('recordTime').value = new Date().toTimeString().slice(0,5);
  document.getElementById('saveAsTemplate').checked = false;
  const tplLabel = document.getElementById('saveTemplateLabel');
  if (tplLabel) { tplLabel.style.display=''; tplLabel.style.background=''; tplLabel.style.borderColor=''; tplLabel.style.color=''; }
  document.getElementById('templatePanel').style.display = 'none';
  document.getElementById('aiParseInput').value = '';
  document.getElementById('aiParseResult').style.display = 'none';
  removeImage();
  updateCatSelectBtn();
  renderAccountSelects();
  renderEntityDatalist();
  if (typeof loadTemplates === 'function') await loadTemplates();
  setTimeout(() => document.getElementById('recordAmount').focus(), 100);
};

window.closeAddModal = function() {
  document.getElementById('addModal').classList.remove('show');
  closeCatSheet();
  closeAccSheet();
  const aiInput = document.getElementById('aiParseInput');
  const aiResult = document.getElementById('aiParseResult');
  if (aiInput) aiInput.value = '';
  if (aiResult) aiResult.style.display = 'none';
};

// ===== 类型切换 / 转账账户显隐 =====
function setToAccountVisible(visible) {
  document.getElementById('toAccountGroup').style.display = visible ? 'block' : 'none';
  const row = document.getElementById('accountFormRow');
  if (row) {
    row.classList.toggle('single-col', !visible);
    row.classList.toggle('transfer-col', visible);
  }
  const mainLabel = document.querySelector('#accountFormRow > .form-group:first-child > .form-label');
  if (mainLabel) mainLabel.textContent = visible ? '转出账户' : '账户';
}

function renderEntityDatalist() {
  const dl = document.getElementById('entityList');
  if (!dl) return;
  dl.innerHTML = (state.entities||[]).map(e => `<option value="${esc(e.name)}">`).join('');
}

// ===== 分类选择按钮更新 =====
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

// ===== PC端分类选择弹窗 =====
window.openCatSheet = function() {
  const categories = state.categories.filter(c => c.type === currentRecordType);
  if (categories.length === 0) return;
  if (!currentParentCatId || !categories.find(c => c.id === currentParentCatId)) {
    currentParentCatId = categories[0].id;
  }
  renderCatSheet();
  document.getElementById('pcCatOverlay').classList.add('show');
  document.getElementById('pcCatDialog').classList.add('show');
};

window.closeCatSheet = function() {
  _catSheetEditing = false;
  const toggleBtn = document.getElementById('pcCatEditToggle');
  if (toggleBtn) { toggleBtn.classList.remove('active'); toggleBtn.textContent = '修改'; }
  document.getElementById('pcCatOverlay').classList.remove('show');
  document.getElementById('pcCatDialog').classList.remove('show');
};

window.toggleCatEditMode = function() {
  _catSheetEditing = !_catSheetEditing;
  const toggleBtn = document.getElementById('pcCatEditToggle');
  toggleBtn.classList.toggle('active', _catSheetEditing);
  toggleBtn.textContent = _catSheetEditing ? '完成' : '修改';
  renderCatSheet();
};

function renderCatSheet() {
  const categories = state.categories.filter(c => c.type === currentRecordType);
  const body = document.getElementById('pcCatDialogBody');
  const editing = _catSheetEditing;

  // 一级分类 chips
  const parentChips = categories.map(cat => `
    <button class="pc-cat-parent-chip ${cat.id === currentParentCatId ? 'active' : ''}" data-id="${cat.id}" data-level="parent" data-mode="${editing?'edit':'select'}">
      <span>${esc(cat.icon)}</span> ${esc(cat.name)}
      ${editing ? ' ✏️' : ''}
    </button>
  `).join('') + `
    <button class="pc-cat-parent-chip" data-level="parent" data-mode="add" style="border-style:dashed;">
      <span>＋</span> 新增
    </button>`;

  // 二级分类网格
  const parentCat = categories.find(c => c.id === currentParentCatId);
  const subCats = parentCat ? (parentCat.children || []) : [];

  let subHtml = '';
  if (subCats.length === 0) {
    currentCategoryId = currentParentCatId;
    subHtml = `
      <button class="pc-cat-tile selected" data-id="${currentParentCatId}" data-level="parent" data-mode="select">
        <span class="pc-cat-tile-icon">${esc(parentCat.icon)}</span>
        <span class="pc-cat-tile-name">${esc(parentCat.name)}</span>
      </button>`;
  } else {
    if (!currentSubCatId || !subCats.find(c => c.id === currentSubCatId)) {
      currentSubCatId = subCats[0].id;
      currentCategoryId = subCats[0].id;
    }
    subHtml = subCats.map(cat => `
      <button class="pc-cat-tile ${cat.id === currentSubCatId ? 'selected' : ''}" data-id="${cat.id}" data-level="sub" data-mode="${editing?'edit':'select'}">
        ${editing ? '<span style="position:absolute;top:4px;right:6px;font-size:11px;">✏️</span>' : ''}
        <span class="pc-cat-tile-icon">${esc(cat.icon)}</span>
        <span class="pc-cat-tile-name">${esc(cat.name)}</span>
      </button>
    `).join('');
  }
  subHtml += `
    <button class="pc-cat-tile" data-level="sub" data-mode="add" style="background:transparent;border:2px dashed var(--border);">
      <span class="pc-cat-tile-icon" style="opacity:0.5;">＋</span>
      <span class="pc-cat-tile-name" style="opacity:0.6;">新增</span>
    </button>`;

  body.innerHTML = `
    <div class="pc-cat-parent-row">${parentChips}</div>
    <div class="pc-cat-group-label">${esc(parentCat ? parentCat.name : '')} 子分类</div>
    <div class="pc-cat-grid" id="pcSubGrid">${subHtml}</div>
  `;

  // 绑定事件
  body.querySelectorAll('.pc-cat-parent-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === 'add') { openCatEditModal('add','parent'); return; }
      if (mode === 'edit') { openCatEditModal('edit','parent', btn.dataset.id); return; }
      currentParentCatId = btn.dataset.id;
      currentSubCatId = null;
      renderCatSheet();
    });
  });
  body.querySelectorAll('#pcSubGrid .pc-cat-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      const mode = tile.dataset.mode;
      if (mode === 'add') { openCatEditModal('add','sub'); return; }
      if (mode === 'edit') { openCatEditModal('edit','sub', tile.dataset.id); return; }
      const level = tile.dataset.level;
      if (level === 'sub') {
        currentSubCatId = tile.dataset.id;
        currentCategoryId = currentSubCatId;
        updateCatSelectBtn();
        closeCatSheet();
      } else {
        // 无子分类时，一级分类本身就是选中项
        currentSubCatId = null;
        currentCategoryId = currentParentCatId;
        updateCatSelectBtn();
        closeCatSheet();
      }
    });
  });
}

// ===== 分类新增/编辑弹窗（复用 common.js 的 catEditModal HTML） =====
window.openCatEditModal = function(mode, level, catId) {
  // 确保分类编辑弹窗HTML存在（由renderAddModal在common.js中渲染，但PC端renderAddModal不包含它）
  if (!document.getElementById('catEditModal')) {
    document.body.insertAdjacentHTML('beforeend', `
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
    `);
  }

  _catEditMode = mode;
  _catEditLevel = level;
  _catEditId = catId || null;

  const titleEl = document.getElementById('catEditTitle');
  titleEl.textContent = mode === 'add'
    ? (level === 'parent' ? '新增一级分类' : '新增二级分类')
    : (level === 'parent' ? '编辑一级分类' : '编辑二级分类');

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

  let initIcon = '🍜', initName = '';
  if (mode === 'edit' && catId) {
    const allCats = state.categories.flatMap(c => [c, ...(c.children || [])]);
    const found = allCats.find(c => c.id === catId);
    if (found) { initIcon = found.icon || '🍜'; initName = found.name || ''; }
    if (level === 'sub' && found && found.parent_id) {
      const opt = parentSel.querySelector(`option[value="${found.parent_id}"]`);
      if (opt) opt.selected = true;
    }
  }

  document.getElementById('catEditIcon').value = initIcon;
  document.getElementById('catEditPreview').textContent = initIcon;
  document.getElementById('catEditName').value = initName;

  const _fallbackEmojis = ['🍜','🍔','🍕','🍱','🥗','🛒','🚗','🚌','✈️','🏠','🏋️','🎮','👗','💄','💊','🏥','📚','🎓','🎵','🎨','💡','💰','🎁','🐾','⚽','🎭','☕','🍺','🎪','📱','💻','🔧','🧴','🧾','🏦','💈','🧹','🌿','🎂','🛁','🎯','🏖️','🧘','🚀','🌍','🔑','🎀','🌸'];
  const userCatIcons = state.categories.flatMap(c => [c.icon, ...(c.children || []).map(ch => ch.icon)]).filter(Boolean);
  const emojiRow = document.getElementById('catEditEmojiRow');
  const currentIconVal = document.getElementById('catEditIcon').value || initIcon;
  const buildEmojiGrid = (extraIcons) => {
    const emojiSet = [...new Set([...userCatIcons, ...extraIcons, ..._fallbackEmojis])];
    emojiRow.innerHTML = emojiSet.map(e =>
      `<button type="button" class="cat-edit-emoji-btn${e === currentIconVal ? ' selected' : ''}" onclick="selectCatEmoji('${e}')">${e}</button>`
    ).join('');
  };
  buildEmojiGrid([]);
  request('/categories/icons').then(sysIcons => {
    if (Array.isArray(sysIcons) && sysIcons.length) buildEmojiGrid(sysIcons);
  }).catch(() => {});

  document.getElementById('catEditOverlay').classList.add('show');
  document.getElementById('catEditModal').classList.add('show');
  setTimeout(() => document.getElementById('catEditName').focus(), 50);
};

window.closeCatEditModal = function() {
  const ov = document.getElementById('catEditOverlay');
  const md = document.getElementById('catEditModal');
  if (ov) ov.classList.remove('show');
  if (md) md.classList.remove('show');
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

// ===== PC端账户选择弹窗 =====
window.openAccSheet = function(which) {
  _accSheetWhich = which;
  const title = document.getElementById('pcAccDialogTitle');
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
    html += `<div class="pc-acc-group-label">${_accTypeIcons[type] || '📂'} ${_accTypeNames[type] || type}</div><div class="pc-acc-list">`;
    list.forEach(a => {
      const bal = formatBalance(a);
      const isSelected = String(a.id) === String(currentId);
      const isCreditDue = a.type === 'credit' && Number(a.balance) < 0;
      html += `<div class="pc-acc-item ${isSelected ? 'selected' : ''}" onclick="selectAccFromSheet('${a.id}')">
        <span class="pc-acc-icon" style="background:${typeColor.bg};">${esc(a.icon)}</span>
        <span class="pc-acc-info">
          <span class="pc-acc-name">${esc(a.name)}</span>
          <span class="pc-acc-bal ${isCreditDue ? 'credit-due' : ''}">${esc(bal)}</span>
        </span>
        ${isSelected ? '<span class="pc-acc-check">✓</span>' : ''}
      </div>`;
    });
    html += `</div>`;
  });

  document.getElementById('pcAccDialogBody').innerHTML = html;
  document.getElementById('pcCatOverlay').classList.add('show');
  document.getElementById('pcAccDialog').classList.add('show');
};

window.closeAccSheet = function() {
  document.getElementById('pcCatOverlay').classList.remove('show');
  document.getElementById('pcAccDialog').classList.remove('show');
};

window.selectAccFromSheet = function(id) {
  const acc = state.accounts.find(a => String(a.id) === String(id));
  if (!acc) return;
  const which = _accSheetWhich;
  const hiddenId = which === 'main' ? 'recordAccount' : 'recordToAccount';
  const iconId   = which === 'main' ? 'accSelectIcon'  : 'toAccSelectIcon';
  const nameId   = which === 'main' ? 'accSelectText'  : 'toAccSelectText';
  const balId    = which === 'main' ? 'accSelectBal'   : 'toAccSelectBal';
  document.getElementById(hiddenId).value = acc.id;
  document.getElementById(iconId).textContent = acc.icon;
  document.getElementById(nameId).textContent = acc.name;
  document.getElementById(balId).textContent  = formatBalance(acc);
  closeAccSheet();
};

function setAccPickerValue(which, accountId) {
  const acc = state.accounts.find(a => String(a.id) === String(accountId));
  if (!acc) return;
  const prev = _accSheetWhich;
  _accSheetWhich = which;
  const hiddenId = which === 'main' ? 'recordAccount' : 'recordToAccount';
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

// ===== 图片上传 =====
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
  const prev = document.getElementById('imagePreview');
  if (prev) prev.style.display = 'none';
  const label = document.querySelector('#imageUploadArea .image-upload-label');
  if (label) label.style.display = 'flex';
  const inp = document.getElementById('recordImage');
  if (inp) inp.value = '';
};

// ===== 模板 =====
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
  currentRecordType = t.type;
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === t.type);
  });
  setToAccountVisible(t.type === 'transfer');
  currentCategoryId = t.category_id;
  // 尝试定位parent/sub
  const allCats = getAllCategories();
  const cat = allCats.find(c => c.id === t.category_id);
  if (cat) {
    if (cat.parent_id) {
      const parent = allCats.find(c => c.id === cat.parent_id);
      currentParentCatId = parent && parent.parent_id ? parent.parent_id : cat.parent_id;
      currentSubCatId = t.category_id;
    } else {
      currentParentCatId = t.category_id;
      currentSubCatId = null;
    }
  }
  document.getElementById('recordAmount').value = t.amount;
  setAccPickerValue('main', t.account_id);
  if (t.to_account_id) setAccPickerValue('to', t.to_account_id);
  document.getElementById('recordNote').value = t.note || '';
  document.getElementById('templatePanel').style.display = 'none';
  updateCatSelectBtn();
  showToast('模板已填充');
};

// ===== AI 解析（复用接口，UI部分重写） =====
window.aiParseText = async function() {
  const input = document.getElementById('aiParseInput');
  const resultEl = document.getElementById('aiParseResult');
  const btn = document.getElementById('aiParseBtn');
  const text = input.value.trim();
  if (!text) { showToast('请输入记账内容'); return; }

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
    const typeLabels = { expense:'支出', income:'收入', transfer:'转账' };
    resultEl.innerHTML = `
      <div class="ai-parse-ok">
        <div class="ai-parse-info">
          <span class="ai-parse-type ${esc(p.type)}">${typeLabels[p.type]||''}</span>
          <span class="ai-parse-amount">¥${Number(p.amount).toFixed(2)}</span>
          <span class="ai-parse-cat">${esc(p.category_icon)} ${esc(p.category_name)}</span>
        </div>
        <div class="ai-parse-detail">${esc(p.account_icon)} ${esc(p.account_name)} · ${esc(p.record_date)}${p.note?' · '+esc(p.note):''}</div>
        <button class="ai-parse-apply" onclick='applyParsedResult(${JSON.stringify(p).replace(/'/g,"&#39;")})'>自动填充 →</button>
      </div>`;
  } catch (e) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = `<div class="ai-parse-err">😕 ${e.message||'解析失败，请检查AI配置'}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '解析';
  }
};

window.applyParsedResult = function(p) {
  currentRecordType = p.type;
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === p.type);
  });
  setToAccountVisible(p.type === 'transfer');

  const allCats = getAllCategories();
  const cat = allCats.find(c => c.id === p.category_id);
  currentParentCatId = null; currentSubCatId = null; currentCategoryId = p.category_id;
  if (cat) {
    if (cat.parent_id) {
      const parentCat = allCats.find(c => c.id === cat.parent_id);
      currentParentCatId = parentCat && parentCat.parent_id ? parentCat.parent_id : cat.parent_id;
      currentSubCatId = p.category_id;
    } else {
      currentParentCatId = p.category_id;
    }
  }
  updateCatSelectBtn();

  document.getElementById('recordAmount').value = p.amount;
  setAccPickerValue('main', p.account_id);
  if (p.to_account_id) setAccPickerValue('to', p.to_account_id);
  document.getElementById('recordDate').value = p.record_date;
  if (!document.getElementById('recordTime').value) {
    document.getElementById('recordTime').value = new Date().toTimeString().slice(0,5);
  }
  document.getElementById('recordNote').value = p.note || '';
  document.getElementById('aiParseResult').style.display = 'none';
  document.getElementById('aiParseInput').value = '';
  showToast('已填充，请确认后保存');
};

// ===== 编辑记录 =====
window.editRecord = async function(r) {
  editingRecordId = r.id;
  document.getElementById('addModal').classList.add('show');
  document.querySelector('#addModal .modal-title').textContent = '编辑记录';
  document.getElementById('templatePanel').style.display = 'none';

  currentRecordType = r.type;
  document.querySelectorAll('.type-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.type === r.type);
  });
  setToAccountVisible(r.type === 'transfer');

  currentParentCatId = null; currentSubCatId = null; currentCategoryId = r.category_id;
  for (const topCat of state.categories.filter(c => c.type === r.type)) {
    if (topCat.id === r.category_id) { currentParentCatId = topCat.id; break; }
    if ((topCat.children||[]).some(c => c.id === r.category_id)) {
      currentParentCatId = topCat.id;
      currentSubCatId = r.category_id;
      break;
    }
  }
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

  updateCatSelectBtn();
  renderAccountSelects();
  renderEntityDatalist();

  document.getElementById('recordAmount').value = r.amount;
  setAccPickerValue('main', r.account_id);
  if (r.to_account_id) setAccPickerValue('to', r.to_account_id);
  document.getElementById('recordDate').value = r.record_date;
  document.getElementById('recordTime').value = r.record_time || '';
  document.getElementById('recordNote').value = r.note || '';
  document.getElementById('saveAsTemplate').checked = false;
  const tplLabel = document.getElementById('saveTemplateLabel');
  if (tplLabel) tplLabel.style.display = 'none';

  removeImage();
  if (r.image_url) {
    currentImageUrl = r.image_url;
    document.getElementById('previewImg').src = r.image_url;
    document.getElementById('imagePreview').style.display = 'block';
    document.getElementById('imageUploadArea').querySelector('.image-upload-label').style.display = 'none';
  }
};

// ===== 保存记录 =====
window.saveRecord = async function() {
  const amount = parseFloat(document.getElementById('recordAmount').value);
  if (!amount || amount <= 0) return showToast('请输入有效金额');
  if (!currentCategoryId) return showToast('请选择分类');

  const note = document.getElementById('recordNote').value.trim();
  const isTemplate = document.getElementById('saveAsTemplate').checked;

  if (note && !state.entities.find(e => e.name === note)) {
    try {
      await request('/entities', {
        method: 'POST',
        body: JSON.stringify({ book_id: state.currentBook, name: note, type:'merchant', icon:'🏪' })
      });
      state.entities.push({ id: Date.now(), name: note, type:'merchant', icon:'🏪' });
    } catch (e) {}
  }

  const body = {
    book_id: state.currentBook,
    type: currentRecordType,
    category_id: currentCategoryId,
    amount,
    account_id: document.getElementById('recordAccount').value,
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

// 注意：类型tab切换、模板按钮、遮罩关闭等事件已由 common.js 的 document 点击处理器统一处理，
// 由于 PC 端的相关函数（renderTemplatePanel/closeAddModal/updateCatSelectBtn 等）均已覆写，
// common.js 处理器会自动调用 PC 版本。此处不再重复绑定，否则会导致模板面板双重切换（开了又关）。

// Enter键触发AI解析
document.addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'aiParseInput' && e.key === 'Enter') {
    e.preventDefault();
    aiParseText();
  }
});
