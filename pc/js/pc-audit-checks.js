/**
 * 核对程序页：清单↔结算跨页表勾稽
 * 运行后展示一致/差异/单边缺失统计与逐项对照明细，每项可跳资料舱原件定位
 */
let projectId = getAuditProjectId();
let projects = [];
let programs = [];
let currentProgram = null;

const CONF = {
  match: { label: '一致', cls: 'done' },
  diff: { label: '差异/缺失', cls: 'failed' },
  unconfirmed: { label: '无法确认', cls: 'pending' }
};

function fmt(n) {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (Number.isNaN(v)) return esc(String(n));
  return v.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
function pair(a, b) {
  const same = (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
  const cls = same ? '' : ' style="color:#b91c1c;font-weight:600;"';
  return `<span>${fmt(a)}</span> / <span${cls}>${fmt(b)}</span>`;
}

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
  renderPCTopbar('✅ 核对程序');
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
  if (!new URLSearchParams(location.search).get('id')) history.replaceState(null, '', '?id=' + projectId);
  const p = projects.find(x => String(x.id) === String(projectId));
  renderPCTopbar('✅ 核对程序',
    `<select class="au-select sm" id="topProjectSwitch" title="切换审计项目" style="width:auto;max-width:220px;"></select>`);
  bindAuditProjectSwitcher(document.getElementById('topProjectSwitch'), projects, projectId);

  document.getElementById('projectView').style.display = 'block';
  if (p) document.getElementById('projTitle').textContent = p.project_name + ' · 核对程序';

  document.getElementById('btnRunBoq').addEventListener('click', () => runCheck('boq_settlement'));
  document.getElementById('btnRunVisa').addEventListener('click', () => runCheck('visa_evidence'));
  document.getElementById('progSelect').addEventListener('change', (e) => {
    currentProgram = programs.find(p => p.id === e.target.value) || null;
    if (currentProgram) { renderSummary(currentProgram); loadItems(currentProgram.id); }
  });
  document.getElementById('filterConcl').addEventListener('change', () => {
    if (currentProgram) loadItems(currentProgram.id);
  });
  await loadPrograms();
}

async function loadPrograms() {
  try {
    programs = await request('/audit/checks/programs?project_id=' + projectId);
  } catch (e) { programs = []; }
  const sel = document.getElementById('progSelect');
  sel.innerHTML = programs.map(p =>
    `<option value="${p.id}">${esc(p.program_name)} · ${(p.created_at || '').slice(5, 16)}</option>`).join('');
  if (!programs.length) {
    renderSummary(null);
    document.getElementById('itemEmpty').style.display = 'block';
    return;
  }
  currentProgram = programs[0];
  sel.value = currentProgram.id;
  renderSummary(currentProgram);
  await loadItems(currentProgram.id);
}

function renderSummary(prg) {
  const box = document.getElementById('summaryCards');
  const meta = document.getElementById('progMeta');
  const note = document.getElementById('summaryNote');
  if (!prg) { box.innerHTML = ''; meta.textContent = ''; note.textContent = ''; return; }
  const s = prg.summary || {};
  meta.textContent = ' · 运行于 ' + (prg.created_at || '');
  const cards = [
    { k: '总清单项', v: s.total, c: '#1f2937' },
    { k: '一致', v: s.match, c: '#047857' },
    { k: '差异/缺失', v: s.diff, c: '#b91c1c' },
    { k: '仅右方有', v: s.onlyRight, c: '#b45309' },
    { k: '仅左方有', v: s.onlyLeft, c: '#b45309' },
  ];
  box.innerHTML = cards.map(x =>
    `<div class="au-stat-chip" style="font-size:13px;padding:8px 14px;">${x.k} <b style="color:${x.c};font-size:18px;margin-left:4px;">${x.v ?? 0}</b></div>`).join('');
  if (prg.program_type === 'visa_evidence') {
    note.innerHTML = `共识别 <b>${s.signPageCount ?? 0}</b> 个签署页、<b>${s.rightCount ?? 0}</b> 枚印章；逐方核对建设/监理/施工三方签字栏与签章。` +
      (s.diff ? `<br>⚠️ <b style="color:#b45309;">发现 ${s.diff} 项签章/会签异常</b>，详见下表。` : '<br>✅ 三方签章齐全。');
  } else {
    note.innerHTML = `左方数据源：<b>${esc(s.leftLabel || '')}（${s.leftCount ?? 0} 项）</b> ｜ 右方数据源：<b>${esc(s.rightLabel || '')}（${s.rightCount ?? 0} 项）</b>` +
      (s.onlyRight ? `<br>⚠️ <b style="color:#b45309;">右方有 ${s.onlyRight} 项清单在左方资料中未找到</b>，疑似左方清单漏项（如漏计单位工程），建议重点核实。` : '');
  }
}

async function loadItems(programId) {
  const concl = document.getElementById('filterConcl').value;
  let items = [];
  try {
    items = await request('/audit/checks/programs/' + programId + '/items' + (concl !== 'all' ? '?conclusion=' + concl : ''));
  } catch (e) { items = []; }
  const tbody = document.getElementById('itemRows');
  document.getElementById('itemEmpty').style.display = items.length ? 'none' : 'block';
  tbody.innerHTML = items.map(it => {
    const c = CONF[it.conclusion] || CONF.unconfirmed;
    const ev = it.evidence || {};
    const link = (side) => {
      const e = ev[side];
      if (!e || !e.docId) return '<span style="color:#cbd5e1;">—</span>';
      const u = `/pc/audit-documents.html?id=${projectId}&doc=${e.docId}${e.pageNo ? '&page=' + e.pageNo : ''}`;
      return `<a href="${u}" target="_blank" class="au-btn sm">${side === 'left' ? '左' : '右'}原件</a>`;
    };
    return `<tr>
      <td style="font-family:monospace;font-size:12px;">${esc(it.item_code || '')}</td>
      <td style="max-width:280px;">${esc(it.item_name || '').replace(/\n/g, '<br>')}</td>
      <td>${esc(it.unit || '')}</td>
      <td>${pair(it.qty_left, it.qty_right)}</td>
      <td>${pair(it.price_left, it.price_right)}</td>
      <td>${pair(it.amount_left, it.amount_right)}</td>
      <td><span class="au-badge ${c.cls}">${c.label}</span></td>
      <td style="max-width:220px;font-size:12px;color:#b45309;">${esc(it.diff_desc || '')}</td>
      <td style="max-width:200px;font-size:12px;color:#64748b;">${esc(it.suggestion || '')}</td>
      <td style="white-space:nowrap;">${link('left')} ${link('right')}</td>
    </tr>`;
  }).join('');
}

async function runCheck(programType) {
  const btn = programType === 'visa_evidence'
    ? document.getElementById('btnRunVisa') : document.getElementById('btnRunBoq');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = '正在核对…';
  try {
    const r = await request('/audit/checks/run', { method: 'POST', body: JSON.stringify({ project_id: projectId, program_type: programType }) });
    showToast('核对完成：共 ' + r.summary.total + ' 项，差异/缺失 ' + r.summary.diff + ' 项');
    await loadPrograms();
  } catch (e) {
    showToast(e.message || '核对失败');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}
