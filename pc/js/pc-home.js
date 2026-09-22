/**
 * 审计驾驶舱 pc-home.js
 * 全局统计（项目/资料/已解析/疑点）+ 最近项目卡片 + 项目核对状态表
 * 数据全部来自 GET /audit/projects（每行已含 doc_count/parsed_count/finding_count）
 */

async function pageInit() {
  renderPCTopbar('🧭 审计驾驶舱');
  let list = [];
  try {
    list = await request('/audit/projects');
  } catch (e) {
    document.getElementById('recentGrid').innerHTML =
      '<div class="au-empty" style="grid-column:1/-1;">加载失败，请刷新重试</div>';
    return;
  }

  // 统计汇总
  const totals = list.reduce((acc, p) => ({
    projects: acc.projects + 1,
    docs: acc.docs + (Number(p.doc_count) || 0),
    parsed: acc.parsed + (Number(p.parsed_count) || 0),
    findings: acc.findings + (Number(p.finding_count) || 0)
  }), { projects: 0, docs: 0, parsed: 0, findings: 0 });
  document.getElementById('statProjects').textContent = totals.projects;
  document.getElementById('statDocs').textContent = totals.docs;
  document.getElementById('statParsed').textContent = totals.parsed;
  document.getElementById('statFindings').textContent = totals.findings;

  // 最近项目卡片（最多 6 个，列表已按 updated_at DESC）
  const recentGrid = document.getElementById('recentGrid');
  if (list.length === 0) {
    recentGrid.innerHTML = `
      <div class="au-empty" style="grid-column:1/-1;"><span class="icon">📂</span>
        暂无审计项目，<a href="/pc/audit-project.html" style="color:var(--primary);font-weight:600;">立即新建</a>
      </div>`;
  } else {
    recentGrid.innerHTML = list.slice(0, 6).map(p => `
      <div class="au-project-card" data-id="${p.id}">
        <div class="au-project-name">${esc(p.project_name)}</div>
        <div class="au-project-meta">
          ${p.project_code ? '编号：' + esc(p.project_code) + '<br>' : ''}
          ${p.audit_period ? '期间：' + esc(p.audit_period) : ''}
        </div>
        <div class="au-project-stats">
          <span class="au-stat-chip">资料 <b>${Number(p.doc_count) || 0}</b></span>
          <span class="au-stat-chip">已解析 <b>${Number(p.parsed_count) || 0}</b></span>
          <span class="au-stat-chip">疑点 <b>${Number(p.finding_count) || 0}</b></span>
        </div>
      </div>`).join('');
    recentGrid.querySelectorAll('.au-project-card').forEach(card => {
      card.addEventListener('click', () => {
        setAuditProject(card.dataset.id);
        location.href = '/pc/audit-documents.html?id=' + card.dataset.id;
      });
    });
  }

  // 项目核对状态表
  document.getElementById('statusRows').innerHTML = list.map(p => `
    <tr>
      <td style="font-weight:600;">${esc(p.project_name)}</td>
      <td>${Number(p.doc_count) || 0}</td>
      <td>${Number(p.parsed_count) || 0}</td>
      <td style="${Number(p.finding_count) > 0 ? 'color:#b91c1c;font-weight:600;' : ''}">${Number(p.finding_count) || 0}</td>
      <td><a class="au-btn sm" href="/pc/audit-documents.html?id=${p.id}"
             onclick="setAuditProject('${p.id}')">进入项目</a></td>
    </tr>`).join('');
}
