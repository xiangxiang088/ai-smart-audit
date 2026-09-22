/**
 * 清标分析 - 任务详情页
 * 配置招标控制价/投标方/资料，运行分析，查看报告
 */
let sessionId = '';
let detail = null;
let pollTimer = null;
let uploadTarget = null; // { kind:'control' } | { kind:'party', partyId }

async function pageInit() {
  sessionId = new URLSearchParams(location.search).get('id');
  if (!sessionId) {
    document.getElementById('noSession').style.display = 'block';
    return;
  }

  renderPCTopbar('🧹 清标任务详情');

  document.getElementById('btnRename').addEventListener('click', renameSession);
  document.getElementById('btnDelete').addEventListener('click', deleteSession);
  document.getElementById('btnAnalyze').addEventListener('click', analyze);
  document.getElementById('btnDownload').addEventListener('click', downloadReport);

  document.getElementById('controlSlot').addEventListener('click', onControlSlotClick);
  document.getElementById('partyList').addEventListener('click', onPartyListClick);

  document.getElementById('controlFileInput').addEventListener('change', e => handleFiles(e.target));
  document.getElementById('partyFileInput').addEventListener('change', e => handleFiles(e.target));

  await reloadDetail();
}

// ---------------- 任务详情 ----------------

async function reloadDetail() {
  try {
    detail = await request('/audit/bid-clearing/sessions/' + sessionId);
    document.getElementById('sessionView').style.display = 'block';
    document.getElementById('noSession').style.display = 'none';
    renderDetail();
    // 解析中 / 分析中 → 每 3s 自动刷新（但僵尸会话不轮询）
    const polling = !detail.is_stale && (detail.status === 'analyzing' || detail.docs_busy);
    if (polling && !pollTimer) pollTimer = setInterval(reloadDetail, 3000);
    if (!polling && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  } catch (e) {
    document.getElementById('sessionView').style.display = 'none';
    document.getElementById('noSession').style.display = 'block';
  }
}

function docStatusBadge(d) {
  if (d.parse_status === 'done') return '<span class="au-badge done">已解析</span>';
  if (d.parse_status === 'failed') return '<span class="au-badge failed">解析失败</span>';
  if (d.parse_status === 'processing') return `<span class="au-badge processing">解析中 ${d.parse_progress || 0}%</span>`;
  return '<span class="au-badge pending">等待解析</span>';
}

function renderDetail() {
  document.getElementById('sessionTitle').textContent = detail.title;

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

  // 投标方 - 方块卡片形式
  renderPartyGrid();

  renderReportSection();
}

// 投标方方块网格渲染
function renderPartyGrid() {
  const container = document.getElementById('partyList');
  const MAX_PARTIES = 10;
  const parties = detail.parties || [];

  let html = '<div class="bc-party-grid">';

  // 已有的投标方方块
  parties.forEach((p, index) => {
    const order = index + 1;
    const docs = p.docs || [];
    const hasParsedDoc = docs.some(d => d.parse_status === 'done');

    let docsHtml = '<div class="bc-party-docs-label">报价文件（' + docs.length + '）</div>';
    if (docs.length === 0) {
      docsHtml += '<div class="bc-party-docs-empty">暂无文件<br>点击下方按钮上传</div>';
    } else {
      docs.forEach(d => {
        docsHtml += `
          <div class="bc-card-doc-row">
            <span class="bc-card-doc-name" title="${esc(d.file_name)}">📄 ${esc(d.file_name)}</span>
            ${compactDocStatus(d)}
            <button type="button" class="bc-card-doc-del" data-act="party-doc-remove" data-party="${p.id}" data-doc="${d.id}" title="移除文件">×</button>
          </div>
          ${d.parse_status === 'failed' ? `<div class="bc-card-doc-err">${esc(d.parse_error || '解析失败')}</div>` : ''}`;
      });
    }

    html += `
      <div class="bc-party-card ${hasParsedDoc ? 'ready' : ''}" data-party-id="${p.id}">
        <div class="bc-party-order">${order}/${MAX_PARTIES}</div>
        <div class="bc-party-head">
          <div class="bc-party-icon">🏢</div>
          <div class="bc-party-card-name" title="${esc(p.party_name)}">${esc(p.party_name)}</div>
        </div>
        <div class="bc-party-docs">${docsHtml}</div>
        <div class="bc-party-card-actions">
          <button type="button" class="bc-party-action-btn upload" data-act="party-upload" data-party="${p.id}" title="上传报价">
            📤 上传报价
          </button>
          <button type="button" class="bc-party-action-btn rename" data-act="party-rename" data-party="${p.id}" title="改名">
            ✏️
          </button>
          <button type="button" class="bc-party-action-btn remove" data-act="party-remove" data-party="${p.id}" title="删除投标方">
            🗑️
          </button>
        </div>
      </div>`;
  });

  // 添加方块（未达上限时显示）
  if (parties.length < MAX_PARTIES) {
    html += `
      <div class="bc-party-card add" id="btnAddPartyCard">
        <div class="bc-party-add-icon">+</div>
        <div class="bc-party-add-text">添加投标方</div>
        <div class="bc-party-add-hint">${parties.length}/${MAX_PARTIES}</div>
      </div>`;
  }

  html += '</div>';

  container.innerHTML = html;

  // 绑定添加按钮
  const addCard = document.getElementById('btnAddPartyCard');
  if (addCard) {
    addCard.addEventListener('click', addParty);
  }
}

// 方块内紧凑文件状态
function compactDocStatus(d) {
  if (d.parse_status === 'done') return '<span class="bc-doc-state done" title="已解析">✅</span>';
  if (d.parse_status === 'failed') return '<span class="bc-doc-state failed" title="解析失败">❌</span>';
  if (d.parse_status === 'processing') return `<span class="bc-doc-state processing" title="解析中">⏳${d.parse_progress || 0}%</span>`;
  return '<span class="bc-doc-state pending" title="等待解析">⏳</span>';
}

// ---------------- 报告区 ----------------

function renderReportSection() {
  // 状态提示
  const line = document.getElementById('statusLine');
  line.className = 'bc-status-line';
  line.innerHTML = '';
  if (detail.is_stale) {
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
  const btn = document.getElementById('btnAnalyze');

  // 防止重复点击
  if (!detail || detail.status === 'analyzing' || btn.disabled) return;
  if (!detail.can_analyze) {
    showToast('请先完成控制价与全部投标方资料的解析');
    return;
  }

  // 重新分析确认
  if (detail.status === 'done') {
    const confirmed = await showConfirm({
      variant: 'info',
      title: '重新清标分析',
      message: '将覆盖现有报告，确定重新分析？'
    });
    if (!confirmed) return;
  }

  // 立即禁用按钮，防止重复点击
  btn.disabled = true;
  btn.textContent = '⏳ 提交中…';

  try {
    await request('/audit/bid-clearing/sessions/' + sessionId + '/analyze', { method: 'POST' });
    showToast('分析任务已启动');
    await reloadDetail();
  } catch (e) {
    showToast(e.message || '启动分析失败');
    btn.disabled = false;
    btn.textContent = detail.status === 'done' ? '🔄 重新分析' : '▶ 开始清标分析';
  }
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

// ---------------- 任务管理 ----------------

async function renameSession() {
  const name = prompt('请输入新名称', detail.title);
  if (!name || name === detail.title) return;
  await request('/audit/bid-clearing/sessions/' + sessionId, {
    method: 'PUT',
    body: JSON.stringify({ title: name.trim() })
  });
  showToast('已重命名');
  await reloadDetail();
}

async function deleteSession() {
  if (!await showConfirm({
    variant: 'danger',
    title: '删除清标任务',
    message: '将删除该任务及其投标方配置（原始资料保留在资料舱），确定？'
  })) return;
  await request('/audit/bid-clearing/sessions/' + sessionId, { method: 'DELETE' });
  showToast('已删除');
  location.href = '/pc/audit-bid-clearing.html';
}

// ---------------- 投标方增删改 ----------------

async function addParty() {
  const currentCount = detail.parties ? detail.parties.length : 0;
  if (currentCount >= 10) {
    showToast('最多只能添加10家投标方');
    return;
  }

  const name = prompt('请输入投标单位名称', '投标单位' + '一二三四五六七八九十'[currentCount]);
  if (!name || !name.trim()) return;

  await request('/audit/bid-clearing/sessions/' + sessionId + '/parties', {
    method: 'POST',
    body: JSON.stringify({ party_name: name.trim() })
  });
  showToast('已添加');
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
    const party = detail.parties.find(x => String(x.id) === String(partyId));
    if (!party) return;
    const name = prompt('请输入新名称', party.party_name);
    if (!name || name === party.party_name) return;
    await request('/audit/bid-clearing/parties/' + partyId, {
      method: 'PUT',
      body: JSON.stringify({ party_name: name.trim() })
    });
    showToast('已重命名');
    await reloadDetail();
  } else if (act === 'party-remove') {
    if (await showConfirm({ variant: 'danger', title: '删除投标方', message: '将移除该投标方及其报价文件配置（原始资料保留在资料舱），确定？' })) {
      await request('/audit/bid-clearing/parties/' + partyId, { method: 'DELETE' });
      showToast('已删除');
      await reloadDetail();
    }
  } else if (act === 'party-doc-remove') {
    const docId = btn.getAttribute('data-doc');
    await request(`/audit/bid-clearing/parties/${partyId}/documents/${docId}`, { method: 'DELETE' });
    showToast('已移除');
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
  fd.append('project_id', ''); // 清标分析资料不绑定项目
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
        await request('/audit/bid-clearing/sessions/' + sessionId + '/control', {
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
  } catch (e) {
    showToast(e.message || '关联失败');
  }
  uploadTarget = null;
  await reloadDetail();
}
