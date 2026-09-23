/**
 * 资料舱页：上传 → 自动解析（PaddleOCR / xlsx / mammoth）→ 结果查看（含证据锚点）
 */
const CAT_LABEL = {
  contract: '合同/协议', boq: '工程量清单', control_price: '招标控制价',
  settlement: '结算/审核', payment: '支付凭证', visa: '变更签证',
  photo: '现场照片', invoice: '发票', other: '其他'
};
const DOC_META = {
  pdf_text:  { icon: '📕', label: '文字PDF' },
  pdf_mixed: { icon: '📕', label: '图文PDF' },
  pdf_scan:  { icon: '📕', label: '扫描PDF' },
  excel:     { icon: '📗', label: 'Excel' },
  word:      { icon: '📘', label: 'Word' },
  photo:     { icon: '🖼️', label: '图片' },
  other:     { icon: '📄', label: '其他' }
};
const STATUS_LABEL = { pending: '待解析', processing: '解析中', done: '已完成', failed: '失败' };

const qs = new URLSearchParams(location.search);
let projectId = getAuditProjectId();
const wantDoc = qs.get('doc');
const wantPage = parseInt(qs.get('page'), 10) || 0;
let projects = [];
let docs = [];
let pollTimer = null;
let autoOpened = false;

async function showProjectPicker() {
  try {
    projects = await fillAuditProjectSelect(document.getElementById('projectPick'));
  } catch (e) { return; }
  if (projects.length === 1) {
    setAuditProject(projects[0].id);
    location.href = location.pathname + '?id=' + encodeURIComponent(projects[0].id);
    return;
  }
  document.getElementById('projectPick').addEventListener('change', e => {
    if (e.target.value) {
      setAuditProject(e.target.value);
      location.href = location.pathname + '?id=' + encodeURIComponent(e.target.value);
    }
  });
  document.getElementById('noProject').style.display = 'block';
}

async function pageInit() {
  renderPCTopbar('📄 资料舱');
  if (!projectId) { await showProjectPicker(); return; }

  try {
    projects = await request('/audit/projects');
  } catch (e) {}
  if (!projects.some(x => String(x.id) === String(projectId))) {
    // 记忆中的项目已删除/无权 → 清掉记忆回到选择
    clearAuditProject();
    await showProjectPicker();
    return;
  }
  setAuditProject(projectId);
  if (!qs.get('id')) {
    // id 来自记忆：补进地址栏，同时保留深链 doc/page 参数
    const suffix = (wantDoc ? '&doc=' + encodeURIComponent(wantDoc) : '')
                 + (wantPage ? '&page=' + wantPage : '');
    history.replaceState(null, '', '?id=' + projectId + suffix);
  }
  renderProjectContext(document.getElementById('ctxSwitch'), document.getElementById('ctxMeta'), projects, projectId);

  document.getElementById('projectView').style.display = 'block';
  bindUploader();
  document.getElementById('btnRefresh').addEventListener('click', loadDocs);
  document.getElementById('btnRetryAll').addEventListener('click', retryAll);
  await loadDocs();
}

// 从问答页证据角标跳转而来：?doc=xx&page=n，解析完成后自动打开并定位页
function maybeAutoOpen() {
  if (autoOpened || !wantDoc) return;
  const d = docs.find(x => String(x.id) === String(wantDoc));
  if (d && d.parse_status === 'done') { autoOpened = true; openResult(wantDoc, wantPage); }
}

async function loadDocs() {
  try {
    docs = await request('/audit/documents/project/' + projectId);
    renderRows();
    maybeAutoOpen();
    const busy = docs.some(d => d.parse_status === 'processing' || d.parse_status === 'pending');
    if (busy) {
      if (!pollTimer) pollTimer = setInterval(loadDocs, 3000);
    } else if (pollTimer) {
      clearInterval(pollTimer); pollTimer = null;
    }
  } catch (err) { /* toast 已弹 */ }
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function renderRows() {
  const tbody = document.getElementById('docRows');
  if (!docs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="au-empty">暂无资料，请先上传</td></tr>';
    return;
  }
  tbody.innerHTML = docs.map(d => {
    const meta = DOC_META[d.doc_type] || DOC_META.other;
    const st = d.parse_status;
    let statusHtml = `<span class="au-badge ${st}">${STATUS_LABEL[st] || st}</span>`;
    if (st === 'processing') {
      statusHtml += ` <span class="au-progress"><i style="width:${Number(d.parse_progress) || 0}%"></i></span> <span style="font-size:11px;color:#b45309;">${Number(d.parse_progress) || 0}%</span>`;
    }
    if (st === 'failed' && d.parse_error) {
      statusHtml += `<div class="au-error-text" title="${esc(d.parse_error)}">${esc(d.parse_error.slice(0, 60))}${d.parse_error.length > 60 ? '…' : ''}</div>`;
    }
    const pages = d.doc_type === 'excel'
      ? `${Number(d.sheet_count) || 0} 表`
      : (Number(d.page_count) > 0 ? `${d.page_count} 页` : '—');
    return `<tr>
      <td><span class="au-type-icon">${meta.icon}</span><span class="au-file-name" title="${esc(d.file_name)}">${esc(d.file_name)}</span></td>
      <td><span class="au-badge cat">${CAT_LABEL[d.biz_category] || d.biz_category}</span></td>
      <td style="white-space:nowrap;">${fmtSize(d.file_size)}</td>
      <td>${statusHtml}</td>
      <td>${pages}</td>
      <td><div class="au-actions">
        ${st === 'done' ? `<button class="au-btn sm" data-act="view" data-id="${d.id}">🔎 查看</button>` : ''}
        ${st === 'failed' ? `<button class="au-btn sm" data-act="parse" data-id="${d.id}">重试</button>` : ''}
        <a class="au-btn sm" href="${d.file_url}" target="_blank">原文件</a>
        <button class="au-btn sm danger" data-act="del" data-id="${d.id}">删除</button>
      </div></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'view') openResult(id);
      if (act === 'parse') triggerParse(id);
      if (act === 'del') delDoc(id);
    });
  });
}

async function triggerParse(id) {
  try {
    await request('/audit/documents/' + id + '/parse', { method: 'POST' });
    showToast('已加入解析队列');
    loadDocs();
  } catch (err) { /* toast */ }
}

async function retryAll() {
  const ids = docs.filter(d => d.parse_status === 'failed').map(d => d.id);
  if (!ids.length) return showToast('没有失败项');
  await request('/audit/documents/parse-batch', { method: 'POST', body: JSON.stringify({ ids }) });
  showToast('已重新加入队列');
  loadDocs();
}

async function delDoc(id) {
  const ok = await showConfirm('确认删除该资料？解析结果将一并失效（落盘证据保留）。');
  if (!ok) return;
  await request('/audit/documents/' + id, { method: 'DELETE' });
  showToast('已删除');
  loadDocs();
}

/* ---------------- 上传 ---------------- */
function bindUploader() {
  const box = document.getElementById('uploader');
  const input = document.getElementById('fileInput');
  box.addEventListener('click', () => input.click());
  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag'); });
  box.addEventListener('dragleave', () => box.classList.remove('drag'));
  box.addEventListener('drop', e => {
    e.preventDefault(); box.classList.remove('drag');
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => {
    if (input.files.length) uploadFiles(input.files);
    input.value = '';
  });
}

async function uploadFiles(fileList) {
  const fd = new FormData();
  fd.append('project_id', projectId);
  fd.append('biz_category', document.getElementById('upCat').value);
  fd.append('doc_type', document.getElementById('upDocType').value);
  Array.from(fileList).forEach(f => fd.append('files', f));
  showToast(`开始上传 ${fileList.length} 个文件…`);
  try {
    const res = await fetch('/api/audit/documents/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + state.token },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || '上传失败'); return; }
    showToast(`上传成功，${data.documents.length} 个文件已自动开始解析`);
    loadDocs();
  } catch (err) {
    showToast('上传失败：' + err.message);
  }
}

/* ---------------- 结果查看 ---------------- */
async function openResult(id, focusPage) {
  const doc = docs.find(d => String(d.id) === String(id));
  let data;
  try {
    data = await request('/audit/documents/' + id + '/result');
  } catch (err) { return; }

  const mask = document.createElement('div');
  mask.className = 'au-modal-mask';
  mask.innerHTML = `
    <div class="au-modal wide" onclick="event.stopPropagation()">
      <div class="au-modal-header">
        🔎 ${esc(doc.file_name)}
        <button class="au-btn sm" style="margin-left:auto;" id="rClose">关闭</button>
      </div>
      <div class="au-modal-body" style="padding:0;flex:1;display:flex;flex-direction:column;overflow:hidden;">
        <div id="rTabs" class="au-sheet-tabs"></div>
        <div id="rBody" class="au-result-body"><div class="au-empty">加载中…</div></div>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', () => mask.remove());
  document.getElementById('rClose').addEventListener('click', () => mask.remove());

  const r = data.result;
  const tabs = document.getElementById('rTabs');
  const body = document.getElementById('rBody');

  if (r.kind === 'excel') {
    tabs.innerHTML = r.sheets.map((s, i) =>
      `<button class="au-sheet-tab ${i === 0 ? 'active' : ''}" data-i="${i}">${esc(s.name)}（${s.rowCount}×${s.colCount}）</button>`).join('');
    const showSheet = i => {
      const s = r.sheets[i];
      body.innerHTML = `<div class="au-md" style="overflow:auto;">${s.html}</div>`;
      body.querySelectorAll('table').forEach(t => {
        t.style.borderCollapse = 'collapse';
        t.style.background = '#fff';
      });
    };
    tabs.querySelectorAll('.au-sheet-tab').forEach(t => t.addEventListener('click', () => {
      tabs.querySelectorAll('.au-sheet-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      showSheet(Number(t.dataset.i));
    }));
    showSheet(0);
  } else if (r.kind === 'word') {
    tabs.style.display = 'none';
    body.innerHTML = `<div class="au-md">${sanitizeHtml(r.html)}</div>`;
  } else {
    // OCR（PDF / 图片）：左原图+证据框，右识别文本/要素
    const pages = r.pages || [];
    tabs.innerHTML = pages.map((p, i) =>
      `<button class="au-sheet-tab ${i === 0 ? 'active' : ''}" data-i="${i}">第 ${p.pageNo} 页</button>`).join('');
    const showPage = i => {
      const p = pages[i];
      // asset 接口需 Authorization header，<img> 无法携带，统一用 fetch 取 blob 再渲染
      const localImgUrl = p.localImage
        ? `/api/audit/documents/${id}/asset?path=${encodeURIComponent(p.localImage)}`
        : '';
      body.innerHTML = `
        <div class="au-result-cols">
          <div class="au-result-pane">
            <h4>原件页面（证据锚点）${localImgUrl ? '' : '（底图未固化，显示 OCR 临时图）'}</h4>
            <div id="imgWrap" style="position:relative;overflow:auto;">
              ${localImgUrl ? '<div style="color:#94a3b8;font-size:12px;">底图加载中…</div>' : (p.inputImage ? `<img class="au-page-img" src="${p.inputImage}">` : '<div class="au-empty">无页面图</div>')}
            </div>
          </div>
          <div class="au-result-pane">
            <h4>识别内容（${(p.elements || []).length} 个版面要素）</h4>
            <div class="au-ele-list" id="eleList">${renderElements(p.elements)}</div>
          </div>
        </div>`;
      const wrap = document.getElementById('imgWrap');
      if (localImgUrl) {
        fetch(localImgUrl, { headers: { Authorization: 'Bearer ' + state.token } })
          .then(rsp => rsp.blob())
          .then(blob => {
            const url = URL.createObjectURL(blob);
            wrap.innerHTML = `<div style="position:relative;display:inline-block;width:100%;">
              <img class="au-page-img" id="pageImg" src="${url}">
              <div id="boxLayer" style="position:absolute;inset:0;pointer-events:none;"></div></div>`;
            drawBoxes(p.elements);
          })
          .catch(() => { wrap.innerHTML = p.inputImage ? `<img class="au-page-img" src="${p.inputImage}">` : '<div class="au-empty">底图加载失败</div>'; });
      } else if (p.inputImage) {
        wrap.innerHTML = `<div style="position:relative;display:inline-block;width:100%;">
          <img class="au-page-img" id="pageImg" src="${p.inputImage}">
          <div id="boxLayer" style="position:absolute;inset:0;pointer-events:none;"></div></div>`;
        setTimeout(() => drawBoxes(p.elements), 600);
      }
      bindElementClicks(p.elements);
    };
    tabs.querySelectorAll('.au-sheet-tab').forEach(t => t.addEventListener('click', () => {
      tabs.querySelectorAll('.au-sheet-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      showPage(Number(t.dataset.i));
    }));
    const focusIdx = focusPage && focusPage > 0 ? focusPage - 1 : 0;
    showPage(Math.min(focusIdx, pages.length - 1));
    if (focusIdx > 0 && focusIdx < pages.length) {
      tabs.querySelectorAll('.au-sheet-tab').forEach((x, i) => x.classList.toggle('active', i === focusIdx));
    }
  }
}

function renderElements(elements) {
  if (!elements || !elements.length) return '<div class="au-empty">无要素</div>';
  return elements.map((e, i) => {
    const tagMap = { table: '表格', seal: '印章', title: '标题', image: '图片', text: '文本' };
    const preview = e.content ? String(e.content).replace(/<[^>]+>/g, ' ').slice(0, 180) : '';
    return `<div class="au-ele tag-${e.elementType}" data-i="${i}">
      <span class="au-ele-tag">${tagMap[e.elementType] || e.elementType}</span>${esc(e.label || '')}
      <div style="margin-top:4px;color:#475569;white-space:pre-wrap;max-height:120px;overflow:auto;">${esc(preview)}${e.content && e.content.length > 180 ? '…' : ''}</div>
    </div>`;
  }).join('');
}

function bindElementClicks(elements) {
  document.querySelectorAll('#eleList .au-ele').forEach(el => {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i);
      const bbox = elements[i] && elements[i].bbox;
      const layer = document.getElementById('boxLayer');
      if (!bbox || !layer) return;
      layer.querySelectorAll('.au-ele-box.active').forEach(b => b.remove());
      const box = document.createElement('div');
      box.className = 'au-ele-box active';
      Object.assign(box.style, {
        position: 'absolute', left: (bbox.x * 100) + '%', top: (bbox.y * 100) + '%',
        width: (bbox.w * 100) + '%', height: (bbox.h * 100) + '%',
        border: '2px solid #ef4444', background: 'rgba(239,68,68,.12)', pointerEvents: 'none'
      });
      layer.appendChild(box);
    });
  });
}

function drawBoxes(elements) {
  const layer = document.getElementById('boxLayer');
  if (!layer || !elements) return;
  layer.innerHTML = '';
  elements.forEach((e, i) => {
    if (!e.bbox || e.elementType === 'text') return; // 文本块不画框，避免满页框；表格/印章/标题/图片画框
    const colors = { table: '#2563eb', seal: '#dc2626', title: '#7c3aed', image: '#0891b2' };
    const box = document.createElement('div');
    box.title = e.label || e.elementType;
    Object.assign(box.style, {
      position: 'absolute', left: (e.bbox.x * 100) + '%', top: (e.bbox.y * 100) + '%',
      width: (e.bbox.w * 100) + '%', height: (e.bbox.h * 100) + '%',
      border: `1.5px solid ${colors[e.elementType] || '#2563eb'}`,
      background: `${colors[e.elementType] || '#2563eb'}14`, pointerEvents: 'auto', cursor: 'pointer'
    });
    box.addEventListener('click', () => {
      const el = document.querySelector(`#eleList .au-ele[data-i="${i}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    layer.appendChild(box);
  });
}

/* ---------------- HTML 白名单清洗（Word/HTML 表格渲染） ---------------- */
function sanitizeHtml(html) {
  const allow = new Set(['TABLE','THEAD','TBODY','TR','TD','TH','BR','P','B','STRONG','I','EM','UL','OL','LI','H1','H2','H3','H4','SPAN','DIV','FONT']);
  const allowAttr = { TD: ['rowspan','colspan','align'], TH: ['rowspan','colspan','align'], TABLE: ['border','cellspacing','cellpadding'] };
  const doc = new DOMParser().parseFromString('<div id="root">' + html + '</div>', 'text/html');
  const walk = node => {
    Array.from(node.children).forEach(child => {
      if (!allow.has(child.tagName)) {
        child.replaceWith(document.createTextNode(child.textContent || ''));
        return;
      }
      Array.from(child.attributes).forEach(attr => {
        const ok = (allowAttr[child.tagName] || []).map(s => s.toLowerCase()).includes(attr.name.toLowerCase());
        if (!ok || attr.value.trim().toLowerCase().startsWith('javascript:')) child.removeAttribute(attr.name);
      });
      walk(child);
    });
  };
  const root = doc.getElementById('root');
  walk(root);
  return root.innerHTML;
}
