/**
 * 错题本页面逻辑 - pc-wrong-book.js
 * 功能：错题列表（分页+筛选）、艾宾浩斯复习提醒、AI变式题、手动录入错题
 */

'use strict';

// ─── 全局状态 ───
let wqPage         = 1;
const WQ_PAGE_SIZE = 10;
let wqTotal         = 0;
let showingDue      = false;
let _manualWqImageUrl = '';
let _manualWqOptions = []; // 选项数组 [{key: 'A', text: ''}, {key: 'B', text: ''}, ...]

const ERROR_TYPE_LABELS = {
  careless: '粗心', concept: '概念模糊',
  method: '方法缺失', prerequisite: '前置缺失', unknown: '未知'
};

// ──────────────────────────────────────────────────────────────
// 页面初始化
// ──────────────────────────────────────────────────────────────
async function pageInit() {
  renderPCTopbar('错题本');
  await loadWqSubjects();
  await Promise.all([loadWqStats(), loadWrongQuestions()]);
}

// 轻量加载学科列表，仅用于填充筛选下拉和手动录入弹窗的学科选择
async function loadWqSubjects() {
  try {
    const data = await request('/edu/subjects');
    const subjects = Array.isArray(data) ? data : (data.list || []);

    // 存储所有学科供筛选使用
    window._allWqSubjects = subjects;

    // 初始加载时显示全部学科
    populateWqSubjectFilter(subjects);
  } catch {}
}

// 填充学科筛选下拉
function populateWqSubjectFilter(subjects) {
  const sel = document.getElementById('wqSubjectFilter');
  sel.innerHTML = '<option value="">全部学科</option>';
  subjects.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = (s.icon || '') + ' ' + s.name;
    sel.appendChild(opt);
  });
}

// 学段筛选切换
function onWqLevelChange() {
  const level = document.getElementById('wqLevelFilter').value;
  const allSubjects = window._allWqSubjects || [];

  if (!level) {
    // 显示全部学科
    populateWqSubjectFilter(allSubjects);
  } else {
    // 只显示当前学段的学科
    const filtered = allSubjects.filter(s => s.education_level === level);
    populateWqSubjectFilter(filtered);
  }

  // 重置学科选择并触发查询
  document.getElementById('wqSubjectFilter').value = '';
  onWqFilterChange();
}

// ──────────────────────────────────────────────────────────────
// 错题本
// ──────────────────────────────────────────────────────────────
async function loadWqStats() {
  const statsEl = document.getElementById('wqStats');
  try {
    const s = await request('/edu/analytics/wrong-questions/stats');
    statsEl.innerHTML = `
      <div class="an-wq-stat">总错题：<strong>${s.total}</strong> 道</div>
      <div class="an-wq-stat">已掌握：<strong>${s.mastered}</strong> 道</div>
      <div class="an-wq-stat">今日待复习：<strong>${s.due_count}</strong> 道</div>
    `;
    const dueBtn = document.getElementById('dueBtn');
    if (s.due_count > 0) {
      dueBtn.textContent = `今日待复习 (${s.due_count})`;
      dueBtn.style.background = '#f59e0b';
      dueBtn.style.color = '#fff';
      dueBtn.style.borderColor = '#f59e0b';
    }
  } catch (e) {
    statsEl.innerHTML = '<div class="an-wq-stat">加载失败</div>';
  }
}

async function loadDueQuestions() {
  showingDue = true;
  const listEl    = document.getElementById('wqList');
  const dueBanner = document.getElementById('dueBanner');
  const paginEl   = document.getElementById('wqPagination');
  paginEl.innerHTML = '';
  dueBanner.innerHTML = '<div class="an-due-badge">⏰ 今日待复习</div>';
  dueBanner.style.display = 'block';

  listEl.innerHTML = '<div class="an-empty"><div class="an-empty-icon">⏳</div>加载中...</div>';
  try {
    const { list } = await request('/edu/analytics/wrong-questions/due');
    renderWqList(list, true);
  } catch (e) {
    listEl.innerHTML = '<div class="an-empty">加载失败</div>';
  }
}

function onWqFilterChange() {
  showingDue = false;
  document.getElementById('dueBanner').style.display = 'none';
  wqPage = 1;
  loadWrongQuestions();
}

async function loadWrongQuestions() {
  if (showingDue) return;
  const listEl   = document.getElementById('wqList');
  const subject  = document.getElementById('wqSubjectFilter').value;
  const errType  = document.getElementById('wqErrorTypeFilter').value;
  const source   = document.getElementById('wqSourceFilter') ? document.getElementById('wqSourceFilter').value : '';

  let url = `/edu/analytics/wrong-questions?page=${wqPage}&page_size=${WQ_PAGE_SIZE}`;
  if (subject)  url += `&subject_id=${encodeURIComponent(subject)}`;
  if (errType)  url += `&error_type=${encodeURIComponent(errType)}`;
  if (source)   url += `&source=${encodeURIComponent(source)}`;

  listEl.innerHTML = '<div class="an-empty"><div class="an-empty-icon">⏳</div>加载中...</div>';
  try {
    const data = await request(url);
    wqTotal = data.total || 0;
    renderWqList(data.list || [], false);
    renderWqPagination();
  } catch (e) {
    listEl.innerHTML = '<div class="an-empty">加载失败</div>';
  }
}

function renderWqList(list, isDue) {
  const listEl = document.getElementById('wqList');
  if (!list || list.length === 0) {
    listEl.innerHTML = `<div class="an-empty"><div class="an-empty-icon">${isDue ? '✅' : '📭'}</div>${isDue ? '今日无待复习错题，继续保持！' : '暂无错题记录'}</div>`;
    return;
  }

  listEl.innerHTML = list.map(q => {
    const errLabel = ERROR_TYPE_LABELS[q.error_type] || q.error_type;
    const isManual = q.source === 'manual';
    const stageDots = Array.from({ length: 6 }, (_, i) =>
      `<div class="an-wq-stage-dot ${i < (q.review_stage || 0) ? 'filled' : ''}"></div>`
    ).join('');

    // 题目内容：手动录入用 manual_content，系统评测用 question_content
    const content = isManual ? (q.manual_content || '') : (q.question_content || '');
    // 图片
    const imgHtml = (isManual && q.manual_image_url)
      ? `<div style="margin:6px 0;"><img src="${esc(q.manual_image_url)}" style="max-width:100%;max-height:200px;border-radius:6px;border:1px solid var(--border);" /></div>`
      : '';

    // 选项（系统评测题或手动录入的单选/多选题）
    let optionsHtml = '';
    if (!isManual && q.options_json) {
      try {
        const options = typeof q.options_json === 'string' ? JSON.parse(q.options_json) : q.options_json;
        if (Array.isArray(options) && options.length > 0) {
          optionsHtml = `<div class="an-wq-options">${options.map(o =>
            `<div class="an-wq-option"><span class="an-wq-option-key">${esc(o.key)}.</span> ${esc(o.text)}</div>`
          ).join('')}</div>`;
        }
      } catch (e) {}
    } else if (isManual && q.manual_options) {
      try {
        const options = typeof q.manual_options === 'string' ? JSON.parse(q.manual_options) : q.manual_options;
        if (Array.isArray(options) && options.length > 0) {
          optionsHtml = `<div class="an-wq-options">${options.map(o =>
            `<div class="an-wq-option"><span class="an-wq-option-key">${esc(o.key)}.</span> ${esc(o.text)}</div>`
          ).join('')}</div>`;
        }
      } catch (e) {}
    }

    // 答案和解析（默认隐藏，点击按钮后显示）
    let answerBoxHtml = '';
    let toggleAnswerBtn = '';
    if (isManual && q.manual_answer) {
      answerBoxHtml = `<div class="an-wq-answer-box hidden" id="wqAnswerBox-${esc(q.id)}">
        <div class="an-wq-answer-label">💡 答案/思路：</div>
        <div class="an-wq-answer-content">${esc(q.manual_answer)}</div>
      </div>`;
      toggleAnswerBtn = `<button class="an-wq-btn" id="wqAnswerBtn-${esc(q.id)}" onclick="toggleWqAnswer('${esc(q.id)}', this)">👁️ 查看答案</button>`;
    } else if (q.correct_answer) {
      answerBoxHtml = `<div class="an-wq-answer-box hidden" id="wqAnswerBox-${esc(q.id)}">
        <div class="an-wq-answer-label">✅ 正确答案：</div>
        <div class="an-wq-answer-content">${esc(q.correct_answer)}</div>
        ${q.analysis ? `<div class="an-wq-analysis"><strong>📖 解析：</strong>${esc(q.analysis)}</div>` : ''}
      </div>`;
      toggleAnswerBtn = `<button class="an-wq-btn" id="wqAnswerBtn-${esc(q.id)}" onclick="toggleWqAnswer('${esc(q.id)}', this)">👁️ 查看答案</button>`;
    }

    const sourceTag = isManual
      ? `<span style="font-size:11px;background:#7c3aed;color:#fff;padding:1px 6px;border-radius:3px;margin-left:4px;">手动录入</span>`
      : `<span style="font-size:11px;background:#6b7280;color:#fff;padding:1px 6px;border-radius:3px;margin-left:4px;">系统评测</span>`;

    const actions = isDue
      ? `${toggleAnswerBtn}
         <button class="an-wq-btn success" onclick="markReviewed('${esc(q.id)}', 1, this)">✅ 答对了</button>
         <button class="an-wq-btn" onclick="markReviewed('${esc(q.id)}', 0, this)">❌ 还不会</button>
         <button class="an-wq-btn" onclick="loadVariant('${esc(q.id)}', this)">🔀 变式题</button>`
      : `${toggleAnswerBtn}
         <button class="an-wq-btn" onclick="loadVariant('${esc(q.id)}', this)">🔀 AI变式题</button>
         ${isManual ? `<button class="an-wq-btn" style="color:#ef4444;border-color:#ef4444;" onclick="deleteManualWq('${esc(q.id)}', this)">🗑️ 删除</button>` : ''}`;

    return `
      <div class="an-wq-item ${q.is_mastered ? 'mastered' : ''}" id="wqItem-${esc(q.id)}">
        <div class="an-wq-item-header">
          <div class="an-wq-meta">
            ${q.subject_icon ? `<span>${esc(q.subject_icon)}</span>` : ''}
            <span class="an-wq-subject">${esc(q.subject_name || '未知学科')}</span>
            <span class="an-wq-knowledge">${esc(q.knowledge_name || '')}</span>
            <span class="an-error-tag ${q.error_type || 'unknown'}">${errLabel}</span>
            ${sourceTag}
          </div>
          <span class="an-wq-count">错 ${q.wrong_count} 次</span>
        </div>
        ${imgHtml}
        <div class="an-wq-content">${esc(content)}</div>
        ${optionsHtml}
        ${answerBoxHtml}
        <div class="an-wq-stage-dots" title="复习进度（${q.review_stage}/5）">
          ${stageDots}
          <span style="font-size:10px;color:var(--text-muted);margin-left:4px;">复习进度</span>
        </div>
        <div class="an-wq-actions">${actions}</div>
        <div id="variantArea-${esc(q.id)}"></div>
      </div>`;
  }).join('');
}

// 显示/隐藏答案（点击按钮切换）
function toggleWqAnswer(wqId, btn) {
  const answerBox = document.getElementById(`wqAnswerBox-${wqId}`);
  if (!answerBox) return;
  const isHidden = answerBox.classList.contains('hidden');
  if (isHidden) {
    answerBox.classList.remove('hidden');
    btn.textContent = '🙈 隐藏答案';
  } else {
    answerBox.classList.add('hidden');
    btn.textContent = '👁️ 查看答案';
  }
}

// 显示/隐藏变式题答案
function toggleVariantAnswer(wqId, btn) {
  const answerBox = document.getElementById(`variantAnswerBox-${wqId}`);
  if (!answerBox) return;
  const isHidden = answerBox.classList.contains('hidden');
  if (isHidden) {
    answerBox.classList.remove('hidden');
    btn.textContent = '🙈 隐藏答案';
  } else {
    answerBox.classList.add('hidden');
    btn.textContent = '👁️ 查看答案';
  }
}

// 答对/答错后更新遗忘曲线进度
async function markReviewed(wqId, isCorrect, btn) {
  const origText = btn.textContent;
  btn.disabled = true;
  try {
    const result = await request(`/edu/analytics/wrong-questions/${wqId}/reviewed`, {
      method: 'POST',
      body: JSON.stringify({ is_correct: isCorrect })
    });
    const item = document.getElementById(`wqItem-${wqId}`);
    if (result.is_mastered) {
      item.classList.add('mastered');
      showToast('已掌握！此题将移出待复习列表');
    } else {
      showToast(isCorrect ? `答对！下次复习：${formatDate(result.next_review_at)}` : '继续加油，已重置复习进度');
    }
    // 刷新统计
    await loadWqStats();
  } catch (e) {
    showToast('更新失败');
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// 加载AI变式题
async function loadVariant(wqId, btn) {
  const variantArea = document.getElementById(`variantArea-${wqId}`);
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 生成中...';
  try {
    const result = await request(`/edu/analytics/wrong-questions/${wqId}/variant`, {
      method: 'POST',
      body: '{}'
    });
    if (result.variant && result.variant.content) {
      const v = result.variant;
      const optionsHtml = Array.isArray(v.options_json)
        ? v.options_json.map(o => `<div>${esc(o.key)}. ${esc(o.text)}</div>`).join('')
        : '';
      const answerBoxHtml = v.answer ? `
        <div class="an-wq-answer-box hidden" id="variantAnswerBox-${esc(wqId)}">
          <div class="an-wq-answer-label">✅ 正确答案：</div>
          <div class="an-wq-answer-content">${esc(v.answer)}</div>
          ${v.analysis ? `<div class="an-wq-analysis"><strong>📖 解析：</strong>${esc(v.analysis)}</div>` : ''}
        </div>` : '';
      const toggleBtn = v.answer ? `<button class="an-wq-btn" style="margin-top:8px;" onclick="toggleVariantAnswer('${esc(wqId)}', this)">👁️ 查看答案</button>` : '';

      variantArea.innerHTML = `
        <div class="an-variant-area">
          <div class="an-variant-label">🔀 变式题${result.from_cache ? '（已缓存）' : ''}</div>
          <div class="an-variant-content">${esc(v.content)}</div>
          ${optionsHtml ? `<div style="margin-top:6px;">${optionsHtml}</div>` : ''}
          ${answerBoxHtml}
          ${toggleBtn}
        </div>`;
      btn.style.display = 'none';
    } else {
      showToast(result.message || 'AI生成失败，请稍后重试');
      btn.disabled = false;
      btn.textContent = origText;
    }
  } catch (e) {
    showToast('生成失败');
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// 分页渲染
function renderWqPagination() {
  const container = document.getElementById('wqPagination');
  const totalPages = Math.ceil(wqTotal / WQ_PAGE_SIZE);
  if (totalPages <= 1) { container.innerHTML = ''; return; }

  let html = `<button class="an-page-btn" onclick="wqGoPage(${wqPage - 1})" ${wqPage <= 1 ? 'disabled' : ''}>‹ 上一页</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || Math.abs(i - wqPage) <= 2) {
      html += `<button class="an-page-btn ${i === wqPage ? 'active' : ''}" onclick="wqGoPage(${i})">${i}</button>`;
    } else if (Math.abs(i - wqPage) === 3) {
      html += `<span style="padding:5px 4px;color:var(--text-muted);">…</span>`;
    }
  }
  html += `<button class="an-page-btn" onclick="wqGoPage(${wqPage + 1})" ${wqPage >= totalPages ? 'disabled' : ''}>下一页 ›</button>`;
  container.innerHTML = html;
}

function wqGoPage(page) {
  const totalPages = Math.ceil(wqTotal / WQ_PAGE_SIZE);
  if (page < 1 || page > totalPages) return;
  wqPage = page;
  loadWrongQuestions();
}

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return '未知';
  try {
    return new Date(dateStr).toLocaleDateString('zh-CN');
  } catch { return dateStr; }
}

// ──────────────────────────────────────────────────────────────
// 手动录入错题弹窗
// ──────────────────────────────────────────────────────────────
async function openManualWqModal() {
  _manualWqImageUrl = '';
  _manualWqOptions = [
    { key: 'A', text: '' },
    { key: 'B', text: '' },
    { key: 'C', text: '' },
    { key: 'D', text: '' }
  ];
  document.getElementById('manualWqLevel').value = '';
  document.getElementById('manualWqSubject').innerHTML = '<option value="">-- 请先选择学段 --</option>';
  document.getElementById('manualWqKnowledge').innerHTML = '<option value="">-- 不指定 --</option>';
  document.getElementById('manualWqContent').value  = '';
  document.getElementById('manualWqAnswer').value   = '';
  document.getElementById('manualWqType').value     = 'subjective';
  document.getElementById('manualWqErrorType').value = 'unknown';
  document.getElementById('manualWqImageName').textContent = '未选择';
  document.getElementById('manualWqImagePreview').innerHTML = '';
  document.getElementById('manualWqImageFile').value = '';

  onManualWqTypeChange(); // 根据题型显示/隐藏选项录入区

  document.getElementById('manualWqModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('manualWqLevel').focus(), 50);
}

// 学段切换：加载对应学段的学科
async function loadManualWqSubjects() {
  const level = document.getElementById('manualWqLevel').value;
  const subjectSel = document.getElementById('manualWqSubject');
  const knowledgeSel = document.getElementById('manualWqKnowledge');

  subjectSel.innerHTML = '<option value="">-- 请选择学科 --</option>';
  knowledgeSel.innerHTML = '<option value="">-- 不指定 --</option>';

  if (!level) {
    subjectSel.innerHTML = '<option value="">-- 请先选择学段 --</option>';
    return;
  }

  try {
    const data = await request('/edu/subjects');
    const subjects = Array.isArray(data) ? data : (data.list || []);
    const filtered = subjects.filter(s => s.education_level === level);

    if (filtered.length === 0) {
      subjectSel.innerHTML = '<option value="">-- 该学段暂无学科 --</option>';
      return;
    }

    filtered.forEach(s => {
      const opt = document.createElement('option');
      opt.value = String(s.id);
      opt.textContent = (s.icon || '') + ' ' + s.name;
      subjectSel.appendChild(opt);
    });
  } catch (e) {
    subjectSel.innerHTML = '<option value="">-- 加载失败 --</option>';
  }
}

// 学科切换：加载知识点
async function loadManualWqKnowledge(subjectId) {
  const sel = document.getElementById('manualWqKnowledge');
  sel.innerHTML = '<option value="">-- 不指定 --</option>';
  if (!subjectId) return;
  try {
    const tree = await request(`/edu/subjects/${subjectId}/tree`);
    const flat = (nodes) => {
      nodes.forEach(n => {
        const opt = document.createElement('option');
        opt.value = String(n.id);
        opt.textContent = ('　'.repeat((n.level || 1) - 1)) + n.name;
        sel.appendChild(opt);
        if (n.children && n.children.length) flat(n.children);
      });
    };
    flat(tree || []);
  } catch (e) {
    console.error('加载知识点失败:', e);
  }
}

function closeManualWqModal() {
  document.getElementById('manualWqModal').classList.add('hidden');
}

function onManualWqImageChange(input) {
  const file = input.files[0];
  if (!file) return;
  document.getElementById('manualWqImageName').textContent = file.name;

  // 上传图片
  const formData = new FormData();
  formData.append('image', file);  // 后端期望的字段名是 'image'
  const token = localStorage.getItem('ledger_token');
  fetch('/api/upload', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.url) {
        _manualWqImageUrl = data.url;
        document.getElementById('manualWqImagePreview').innerHTML =
          `<img src="${esc(data.url)}" style="max-width:100%;max-height:160px;border-radius:6px;border:1px solid var(--border);" />`;
        showToast('图片上传成功');
      } else {
        showToast(data.error || '图片上传失败', 'error');
      }
    })
    .catch(err => {
      console.error('上传失败:', err);
      showToast('图片上传失败', 'error');
    });
}

async function saveManualWq() {
  const level      = document.getElementById('manualWqLevel').value;
  const subjectId  = document.getElementById('manualWqSubject').value;
  const knowId     = document.getElementById('manualWqKnowledge').value;
  const content    = document.getElementById('manualWqContent').value.trim();
  const answer     = document.getElementById('manualWqAnswer').value.trim();
  const type       = document.getElementById('manualWqType').value;
  const errorType  = document.getElementById('manualWqErrorType').value;

  if (!level)     { showToast('请选择学段', 'error'); return; }
  if (!subjectId) { showToast('请选择学科', 'error'); return; }
  if (!content)   { showToast('请填写题目内容', 'error'); return; }

  // 如果是单选或多选题，收集选项
  let optionsJson = null;
  if (type === 'single' || type === 'multi') {
    const options = _manualWqOptions.filter(o => o.text.trim());
    if (options.length < 2) {
      showToast('单选题或多选题至少需要2个选项', 'error');
      return;
    }
    optionsJson = options;
  }

  const btn = document.getElementById('manualWqSaveBtn');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    await request('/edu/analytics/wrong-questions/manual', {
      method: 'POST',
      body: JSON.stringify({
        subject_id:        subjectId,
        knowledge_id:      knowId || null,
        manual_content:    content,
        manual_answer:     answer || null,
        manual_type:       type,
        manual_image_url:  _manualWqImageUrl || null,
        manual_options:    optionsJson,
        error_type:        errorType
      })
    });
    showToast('录入成功');
    closeManualWqModal();
    await loadWqStats();
    wqPage = 1;
    loadWrongQuestions();
  } catch (e) {
    showToast(e.message || '录入失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '保存录入';
  }
}

async function deleteManualWq(wqId, btn) {
  if (!confirm('确认删除此条手动录入的错题？')) return;
  btn.disabled = true;
  try {
    await request(`/edu/analytics/wrong-questions/${wqId}`, { method: 'DELETE' });
    const item = document.getElementById(`wqItem-${wqId}`);
    if (item) item.remove();
    showToast('已删除');
    await loadWqStats();
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
    btn.disabled = false;
  }
}

// 题型切换时显示/隐藏选项录入区
function onManualWqTypeChange() {
  const type = document.getElementById('manualWqType').value;
  const optionsArea = document.getElementById('manualWqOptionsArea');

  if (type === 'single' || type === 'multi') {
    optionsArea.style.display = 'block';
    renderManualWqOptions();
  } else {
    optionsArea.style.display = 'none';
  }
}

// 渲染选项录入界面
function renderManualWqOptions() {
  const container = document.getElementById('manualWqOptionsContainer');
  container.innerHTML = _manualWqOptions.map((opt, idx) => `
    <div class="pc-option-item">
      <span class="pc-option-key">${esc(opt.key)}.</span>
      <input type="text" class="pc-option-input" value="${esc(opt.text)}"
             placeholder="输入选项内容..."
             oninput="updateManualWqOption(${idx}, this.value)">
      ${_manualWqOptions.length > 2 ? `<button class="pc-option-del" onclick="deleteManualWqOption(${idx})" title="删除">×</button>` : ''}
    </div>
  `).join('');
}

// 更新选项内容
function updateManualWqOption(idx, text) {
  if (_manualWqOptions[idx]) {
    _manualWqOptions[idx].text = text;
  }
}

// 删除选项
function deleteManualWqOption(idx) {
  if (_manualWqOptions.length <= 2) {
    showToast('至少保留2个选项', 'error');
    return;
  }
  _manualWqOptions.splice(idx, 1);
  renderManualWqOptions();
}

// 添加选项
function addManualWqOption() {
  const nextKey = String.fromCharCode(65 + _manualWqOptions.length); // A=65, B=66...
  if (_manualWqOptions.length >= 26) {
    showToast('最多支持26个选项（A-Z）', 'error');
    return;
  }
  _manualWqOptions.push({ key: nextKey, text: '' });
  renderManualWqOptions();
}

