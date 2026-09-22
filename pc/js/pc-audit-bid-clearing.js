/**
 * 清标分析页（独立功能，不绑定审计项目）
 * 招标控制价（1 份）+ 多家投标方报价文件 → 复用解析管线（Excel/Word/PaddleOCR）
 * → 拼装喂给大模型（资深造价清标专家）→ Markdown 报告落库、可重新分析/下载
 */
let sessions = [];
let currentSessionId = '';
let detail = null;
let pollTimer = null;
let uploadTarget = null; // { kind:'control' } | { kind:'party', partyId }

const SESSION_STATUS_CN = { draft: '草稿', analyzing: '分析中', done: '已完成', failed: '失败' };

// ---------------- 初始化 ----------------

async function pageInit() {
  renderPCTopbar('🧹 清标分析');

  document.getElementById('mainView').style.display = 'block';

  document.getElementById('btnRefresh').addEventListener('click', loadSessions);
  document.getElementById('btnAddSession').addEventListener('click', createSession);
  document.getElementById('btnAddParty').addEventListener('click', addParty);
  document.getElementById('newPartyName').addEventListener('keydown', e => { if (e.key === 'Enter') addParty(); });
  document.getElementById('btnAnalyze').addEventListener('click', analyze);
  document.getElementById('btnDownload').addEventListener('click', downloadReport);
  document.getElementById('btnDeleteSession').addEventListener('click', deleteCurrentSession);

  document.getElementById('sessionTabs').addEventListener('click', e => {
    const btn = e.target.closest('[data-session]');
    if (btn) { currentSessionId = btn.getAttribute('data-session'); reloadDetail(); }
  });
  document.getElementById('controlSlot').addEventListener('click', onControlSlotClick);
  document.getElementById('partyList').addEventListener('click', onPartyListClick);

  document.getElementById('controlFileInput').addEventListener('change', e => handleFiles(e.target));
  document.getElementById('partyFileInput').addEventListener('change', e => handleFiles(e.target));

  await loadSessions();
}

// ---------------- 任务列表 ----------------

async function loadSessions() {
  sessions = await request('/audit/bid-clearing/sessions');
  if (!sessions.some(s => String(s.id) === String(currentSessionId))) {
    currentSessionId = sessions.length ? String(sessions[0].id) : '';
  }
  document.getElementById('sessionEmpty').style.display = sessions.length ? 'none' : 'block';
  document.getElementById('sessionTabs').innerHTML = sessions.map(s => {
    const active = String(s.id) === String(currentSessionId);
    return `<button type="button" class="bc-session-tab${active ? ' active' : ''}" data-session="${s.id}">
      <span class="bc-session-name">${esc(s.title)}</span>
      <span class="bc-session-meta">${SESSION_STATUS_CN[s.status] || s.status} · ${s.party_count}家投标</span>
    </button>`;
  }).join('');

  document.getElementById('sessionView').style.display = currentSessionId ? 'block' : 'none';
  if (currentSessionId) await reloadDetail();
}

async function createSession() {
  const s = await request('/audit/bid-clearing/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: '清标任务 ' + (sessions.length + 1) })
  });
  currentSessionId = String(s.id);
  await loadSessions();
}

async function deleteCurrentSession() {
  if (!currentSessionId) return;
  if (!await showConfirm({ variant: 'danger', title: '删除清标任务', message: '将删除该任务及其投标方配置（原始资料保留在资料舱），确定？' })) return;
  await request('/audit/bid-clearing/sessions/' + currentSessionId, { method: 'DELETE' });
  currentSessionId = '';
  await loadSessions();
}

// ---------------- 任务详情 ----------------

async function reloadDetail() {
  if (!currentSessionId) return;
  detail = await request('/audit/bid-clearing/sessions/' + currentSessionId);
  renderDetail();
  // 解析中 / 分析中 → 每 3s 自动刷新（但僵尸会话不轮询）
  const polling = !detail.is_stale && (detail.status === 'analyzing' || detail.docs_busy);
  if (polling && !pollTimer) pollTimer = setInterval(reloadDetail, 3000);
  if (!polling && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function docStatusBadge(d) {
  if (d.parse_status === 'done') return '<span class="au-badge done">已解析</span>';
  if (d.parse_status === 'failed') return '<span class="au-badge failed">解析失败</span>';
  if (d.parse_status === 'processing') return `<span class="au-badge processing">解析中 ${d.parse_progress || 0}%</span>`;
  return '<span class="au-badge pending">等待解析</span>';
}

function renderDetail() {
  // 招标控制价
  const slot = document.getElementById('controlSlot');
  if (!detail.control) {
    slot.innerHTML = `<div class="bc-upload-slot">
      <span class="bc-upload-hint">📤 上传招标控制价文件（Excel / PDF / Word）</span>
      <button type="button" class="au-btn sm primary" data-act="upload-control">选择文件</button>
    </div>`;
  } else {
    const d = detail.control;
    slot.innerHTML = `<div class="bc-doc-row">
      <span class="au-file-name">📄 ${esc(d.file_name)}</span>
      ${docStatusBadge(d)}
      <span class="au-actions" style="margin-left:auto;">
        <button type="button" class="au-btn sm" data-act="upload-control">替换</button>
      </span>
    </div>${d.parse_status === 'failed' ? `<div class="au-error-text">${esc(d.parse_error || '解析失败')}</div>` : ''}`;
  }

  // 投标方
  document.getElementById('partyList').innerHTML = detail.parties.map(p => `
    <div class="bc-party">
      <div class="bc-party-head">
        <span class="bc-party-name" id="partyName-${p.id}">🏢 ${esc(p.party_name)}</span>
        <span class="au-actions">
          <button type="button" class="au-btn sm" data-act="party-rename" data-party="${p.id}">✏ 改名</button>
          <button type="button" class="au-btn sm primary" data-act="party-upload" data-party="${p.id}">＋ 上传报价</button>
          <button type="button" class="au-btn sm danger" data-act="party-remove" data-party="${p.id}">删除</button>
        </span>
      </div>
      <div class="bc-doc-list">
        ${p.docs.length ? p.docs.map(d => `
          <div class="bc-doc-row">
            <span class="au-file-name">📄 ${esc(d.file_name)}</span>
            ${docStatusBadge(d)}
            <span class="au-actions" style="margin-left:auto;">
              <button type="button" class="au-btn sm danger" data-act="party-doc-remove" data-party="${p.id}" data-doc="${d.id}">移除</button>
            </span>
          </div>${d.parse_status === 'failed' ? `<div class="au-error-text">${esc(d.parse_error || '解析失败')}</div>` : ''}
        `).join('') : '<span class="bc-hint">尚未上传报价文件</span>'}
      </div>
    </div>`).join('');

  renderReportSection();
}

// ---------------- 报告区 ----------------

function renderReportSection() {
  // 任务标题行（注入一次）
  let titleLine = document.getElementById('sessionTitleLine');
  if (!titleLine) {
    titleLine = document.createElement('div');
    titleLine.id = 'sessionTitleLine';
    titleLine.className = 'bc-session-title-line';
    document.getElementById('statusLine').before(titleLine);
  }
  titleLine.innerHTML = `任务：<b>${esc(detail.title)}</b>
    <button type="button" class="au-btn sm" data-act="session-rename">✏ 重命名</button>`;
  titleLine.querySelector('button').addEventListener('click', renameSessionInline);

  // 状态提示
  const line = document.getElementById('statusLine');
  line.className = 'bc-status-line';
  line.innerHTML = '';
  if (detail.is_stale) {
    // 僵尸会话检测（服务器重启导致任务丢失）
    line.classList.add('warning');
    line.innerHTML = '⚠️ 检测到上次分析任务异常中断（可能因服务器重启），请重新点击"开始分析"按钮';
  } else if (detail.status === 'analyzing') {
    line.classList.add('info');
    line.innerHTML = '🤖 大模型清标分析进行中，通常需要 30 秒至数分钟，可稍后回到本页查看…';
  } else if (detail.docs_busy) {
    line.classList.add('info');
    line.innerHTML = '⏳ 资料解析中，请稍候；全部解析完成后即可开始分析';
  } else if (detail.status === 'failed') {
    line.classList.add('error');
    line.innerHTML = '❌ ' + esc(detail.error_msg || '分析失败');
  } else if (detail.status === 'done') {
    let usageTxt = '';
    try { const u = detail.usage_json ? JSON.parse(detail.usage_json) : null; if (u && u.total_tokens) usageTxt = ` · 共消耗 ${u.total_tokens} tokens`; } catch (e) {}
    line.classList.add('success');
    line.innerHTML = `✅ 报告已生成${detail.model_info ? '（模型：' + esc(detail.model_info) + '）' : ''}${usageTxt}`;
  } else if (!detail.can_analyze) {
    line.classList.add('info');
    line.innerHTML = 'ℹ️ 请上传已解析的招标控制价，并为每家投标方上传已解析的报价文件';
  }

  // 报告正文
  const wrap = document.getElementById('reportWrap');
  const empty = document.getElementById('reportEmpty');
  if (detail.report_md) {
    wrap.style.display = 'block';
    wrap.innerHTML = renderMarkdown(detail.report_md);
    empty.style.display = 'none';
  } else {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    empty.style.display = 'block';
  }

  // 按钮状态
  const btn = document.getElementById('btnAnalyze');
  const btnDl = document.getElementById('btnDownload');
  btnDl.disabled = !detail.report_md;
  if (detail.is_stale) {
    // 僵尸会话：允许重新分析
    btn.disabled = !detail.can_analyze;
    btn.textContent = '🔄 重新开始分析';
  } else if (detail.status === 'analyzing') {
    btn.disabled = true; btn.textContent = '⏳ 分析中…';
  } else {
    btn.disabled = !detail.can_analyze;
    btn.textContent = detail.status === 'done' ? '🔄 重新分析' : '▶ 开始清标分析';
  }
}

async function analyze() {
  if (!detail || detail.status === 'analyzing') return;
  if (!detail.can_analyze) { showToast('请先完成控制价与全部投标方资料的解析'); return; }
  if (detail.status === 'done' &&
      !await showConfirm({ variant: 'info', title: '重新清标分析', message: '将覆盖现有报告，确定重新分析？' })) return;
  await request('/audit/bid-clearing/sessions/' + currentSessionId + '/analyze', { method: 'POST' });
  await reloadDetail();
}

function downloadReport() {
  if (!detail || !detail.report_md) return;
  const blob = new Blob([detail.report_md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '清标报告-' + detail.title + '.md';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 投标方增删改 ----------------

async function addParty() {
  const input = document.getElementById('newPartyName');
  const name = input.value.trim();
  if (!name) { showToast('请输入投标单位名称'); return; }
  await request('/audit/bid-clearing/sessions/' + currentSessionId + '/parties', {
    method: 'POST',
    body: JSON.stringify({ party_name: name })
  });
  input.value = '';
  await reloadDetail();
}

async function onPartyListClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  const partyId = btn.getAttribute('data-party');

  if (act === 'party-upload') {
    uploadTarget = { kind: 'party', partyId };
    const input = document.getElementById('partyFileInput');
    input.value = '';
    input.click();
  } else if (act === 'party-rename') {
    renamePartyInline(partyId);
  } else if (act === 'party-remove') {
    if (await showConfirm({ variant: 'danger', title: '删除投标方', message: '将移除该投标方及其报价文件配置（原始资料保留在资料舱），确定？' })) {
      await request('/audit/bid-clearing/parties/' + partyId, { method: 'DELETE' });
      await reloadDetail();
    }
  } else if (act === 'party-doc-remove') {
    const docId = btn.getAttribute('data-doc');
    await request(`/audit/bid-clearing/parties/${partyId}/documents/${docId}`, { method: 'DELETE' });
    await reloadDetail();
  }
}

function onControlSlotClick(e) {
  const btn = e.target.closest('[data-act="upload-control"]');
  if (!btn) return;
  uploadTarget = { kind: 'control' };
  const input = document.getElementById('controlFileInput');
  input.value = '';
  input.click();
}

// ---------------- 上传（复用 /audit/documents/upload 解析管线） ----------------

async function handleFiles(inputEl) {
  const files = Array.from(inputEl.files || []);
  inputEl.value = '';
  const target = uploadTarget;
  if (!files.length || !target) { uploadTarget = null; return; }

  const fd = new FormData();
  // 清标分析资料不绑定项目，project_id 设为空字符串（后端会存 NULL）
  fd.append('project_id', '');
  files.forEach(f => fd.append('files', f));
  let docIds = [];
  try {
    const rsp = await fetch('/api/audit/documents/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + state.token },
      body: fd
    });
    const data = await rsp.json();
    if (!rsp.ok) throw new Error(data.error || '上传失败');
    docIds = (data.documents || []).map(d => d.id);
  } catch (e) {
    showToast(e.message);
    uploadTarget = null;
    return;
  }

  try {
    for (const docId of docIds) {
      if (target.kind === 'control') {
        await request('/audit/bid-clearing/sessions/' + currentSessionId + '/control', {
          method: 'PUT',
          body: JSON.stringify({ document_id: docId })
        });
      } else {
        await request('/audit/bid-clearing/parties/' + target.partyId + '/documents', {
          method: 'POST',
          body: JSON.stringify({ document_id: docId })
        });
      }
    }
    showToast('上传成功，开始解析…');
  } catch (e) {}
  uploadTarget = null;
  await reloadDetail();
}

// ---------------- 行内重命名 ----------------

function inlineEdit(container, value, onSave, onCancel) {
  container.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'au-input';
  input.maxLength = 200;
  input.value = value;
  input.style.maxWidth = '260px';
  const okBtn = document.createElement('button');
  okBtn.type = 'button'; okBtn.className = 'au-btn sm primary'; okBtn.textContent = '保存';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button'; cancelBtn.className = 'au-btn sm'; cancelBtn.textContent = '取消';
  container.append(input, okBtn, cancelBtn);
  input.focus();

  const finish = async (commit) => {
    if (commit) {
      try { await onSave(input.value); } catch (e) { return; }
    } else {
      try { await onCancel(); } catch (e) {}
    }
  };
  okBtn.addEventListener('click', () => finish(true));
  cancelBtn.addEventListener('click', () => finish(false));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
}

function renameSessionInline() {
  const container = document.getElementById('sessionTitleLine');
  inlineEdit(container, detail.title,
    async (val) => {
      const name = String(val || '').trim();
      if (!name) throw new Error('名称不能为空');
      await request('/audit/bid-clearing/sessions/' + currentSessionId, {
        method: 'PUT',
        body: JSON.stringify({ title: name })
      });
      await reloadDetail();
    },
    reloadDetail);
}

function renamePartyInline(partyId) {
  const party = detail.parties.find(x => String(x.id) === String(partyId));
  if (!party) return;
  const container = document.getElementById('partyName-' + partyId);
  inlineEdit(container, party.party_name,
    async (val) => {
      const name = String(val || '').trim();
      if (!name) throw new Error('名称不能为空');
      await request('/audit/bid-clearing/parties/' + partyId, {
        method: 'PUT',
        body: JSON.stringify({ party_name: name })
      });
      await reloadDetail();
    },
    reloadDetail);
}
