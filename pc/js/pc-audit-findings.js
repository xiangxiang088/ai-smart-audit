/**
 * 疑点台账页
 * 数据源：规则扫描（量差异常 / 三无签证 / 凑整金额 / 连号发票 / 集中签证）+ 核对程序差异，落库 audit_finding。
 * 支持：风险分级展示、人工复核标记（待核实 / 已核实 / 误报 / 已关闭）、原件页码溯源、Excel·Word 导出。
 */
let projectId = getAuditProjectId();
let projects = [];
let findingData = { summary: {}, typeLabel: {}, list: [] };

const RISK_CN = { high: '高', mid: '中', low: '低' };
const STATUS_OPTIONS = [
  { v: 'open', t: '待核实' },
  { v: 'confirmed', t: '已核实' },
  { v: 'misreport', t: '误报' },
  { v: 'closed', t: '已关闭' }
];

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
  renderPCTopbar('⚠️ 疑点台账');
  if (!projectId) { await showProjectPicker(); return; }

  try {
    projects = await request('/audit/projects');
  } catch (e) {}
  if (!projects.some(x => String(x.id) === String(projectId))) {
    clearAuditProject();
    await showProjectPicker();
    return;
  }
  setAuditProject(projectId);
  if (!new URLSearchParams(location.search).get('id')) history.replaceState(null, '', '?id=' + projectId);
  renderProjectContext(document.getElementById('ctxSwitch'), document.getElementById('ctxMeta'), projects, projectId);

  document.getElementById('projectView').style.display = 'block';
  document.getElementById('btnRefresh').addEventListener('click', load);
  document.getElementById('btnRescan').addEventListener('click', rescan);
  document.getElementById('btnExportXlsx').addEventListener('click', () => downloadExport('export', '审计核对台账.xlsx'));
  document.getElementById('btnExportWord').addEventListener('click', () => downloadExport('export-word', '审计发现清单.docx'));
  document.getElementById('riskFilter').addEventListener('change', render);
  document.getElementById('statusFilter').addEventListener('change', render);
  await load();
}

async function downloadExport(path, fallbackName) {
  const btn = document.getElementById(path === 'export' ? 'btnExportXlsx' : 'btnExportWord');
  btn.disabled = true; const old = btn.textContent; btn.textContent = '导出中…';
  try {
    const token = localStorage.getItem('ledger_token');
    const resp = await fetch('/api/audit/checks/' + path + '?project_id=' + projectId, { headers: { Authorization: 'Bearer ' + token } });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || '导出失败'); }
    const blob = await resp.blob();
    const m = /filename\*=UTF-8''([^;]+)/i.exec(resp.headers.get('Content-Disposition') || '');
    const name = m ? decodeURIComponent(m[1]) : fallbackName;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) { showToast(e.message); } finally { btn.disabled = false; btn.textContent = old; }
}

/** 重新执行规则扫描 */
async function rescan() {
  const btn = document.getElementById('btnRescan');
  btn.disabled = true; const old = btn.textContent; btn.textContent = '扫描中…';
  try {
    const r = await request('/audit/findings/scan', { method: 'POST', body: JSON.stringify({ project_id: projectId }) });
    const s = r.summary || {};
    showToast(`扫描完成：共 ${s.total} 条疑点（高 ${s.high} / 中 ${s.mid} / 低 ${s.low}）`);
    await load();
  } catch (e) {
    if (!e._toastShown) showToast(e.message);
  } finally { btn.disabled = false; btn.textContent = old; }
}

async function load() {
  try {
    const r = await request('/audit/findings?project_id=' + projectId);
    findingData = { summary: r.summary || {}, typeLabel: r.typeLabel || {}, list: r.list || [] };
  } catch (e) {
    if (!e._toastShown) showToast(e.message);
    findingData = { summary: {}, typeLabel: {}, list: [] };
  }
  const s = findingData.summary || {};
  const meta = document.getElementById('findingMeta');
  if (meta) {
    meta.textContent = `共 ${s.total || 0} 条 · 高 ${s.high || 0} / 中 ${s.mid || 0} / 低 ${s.low || 0} · 待核实 ${s.open || 0}`;
  }
  render();
}

function riskBadge(level) {
  const cls = level === 'high' ? 'au-badge failed' : level === 'mid' ? 'au-badge pending' : 'au-badge done';
  return `<span class="${cls}">${RISK_CN[level] || level || '—'}</span>`;
}

function render() {
  const riskF = document.getElementById('riskFilter').value;
  const statusF = document.getElementById('statusFilter').value;
  const rows = findingData.list.filter(f =>
    (!riskF || f.risk_level === riskF) && (!statusF || f.status === statusF));

  document.getElementById('findingEmpty').style.display = rows.length ? 'none' : 'block';
  document.getElementById('findingRows').innerHTML = rows.map((f, i) => {
    const ev = f.evidence || {};
    const link = (side) => {
      const e = ev[side];
      if (!e || !e.docId) return '';
      const u = `/pc/audit-documents.html?id=${projectId}&doc=${e.docId}${e.pageNo ? '&page=' + e.pageNo : ''}`;
      return `<a href="${u}" target="_blank" class="au-btn sm">${side === 'left' ? '原件' : '对照'}</a>`;
    };
    const opts = STATUS_OPTIONS.map(o => `<option value="${o.v}" ${f.status === o.v ? 'selected' : ''}>${o.t}</option>`).join('');
    return `<tr>
      <td>${i + 1}</td>
      <td>${riskBadge(f.risk_level)}</td>
      <td style="font-size:12px;color:#64748b;">${esc(f.type_label || f.finding_type)}</td>
      <td style="max-width:420px;font-size:13px;">${esc(f.description || '').replace(/\n/g, '<br>')}</td>
      <td style="max-width:220px;font-size:12px;color:#64748b;">${esc(f.suggestion || '')}</td>
      <td style="color:#b91c1c;font-weight:600;">${f.amount != null ? Number(f.amount).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—'}</td>
      <td style="white-space:nowrap;">${link('left')} ${link('right')}</td>
      <td>
        <select class="au-select sm" data-fid="${f.id}" style="min-width:88px;">${opts}</select>
      </td>
    </tr>`;
  }).join('');

  document.querySelectorAll('#findingRows select[data-fid]').forEach(sel => {
    sel.addEventListener('change', async e => {
      const id = e.target.dataset.fid;
      sel.disabled = true;
      try {
        await request(`/audit/findings/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) });
        showToast('已更新复核状态');
        await load();
      } catch (err) {
        if (!err._toastShown) showToast(err.message);
      } finally { sel.disabled = false; }
    });
  });
}
