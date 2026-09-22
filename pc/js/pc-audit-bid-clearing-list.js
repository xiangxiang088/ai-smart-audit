/**
 * 清标分析 - 任务列表页
 * 显示所有清标任务的卡片，点击进入详情页
 */
let sessions = [];

const SESSION_STATUS_CN = { draft: '草稿', analyzing: '分析中', done: '已完成', failed: '失败' };
const SESSION_STATUS_CLASS = { draft: '', analyzing: 'processing', done: 'done', failed: 'failed' };

async function pageInit() {
  renderPCTopbar('🧹 清标分析');
  document.getElementById('btnRefresh').addEventListener('click', loadSessions);
  document.getElementById('btnAddSession').addEventListener('click', createSession);
  await loadSessions();
}

async function loadSessions() {
  sessions = await request('/audit/bid-clearing/sessions');
  renderSessions();
}

function renderSessions() {
  const list = document.getElementById('sessionList');
  const empty = document.getElementById('sessionEmpty');

  if (sessions.length === 0) {
    list.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  list.style.display = 'grid';
  empty.style.display = 'none';

  list.innerHTML = sessions.map(s => {
    const statusBadge = `<span class="au-badge ${SESSION_STATUS_CLASS[s.status] || ''}">${SESSION_STATUS_CN[s.status] || s.status}</span>`;
    const updatedTime = new Date(s.updated_at).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    return `
      <div class="au-project-card" onclick="location.href='/pc/audit-bid-clearing-detail.html?id=${s.id}'">
        <div class="au-card-header">
          <h3 class="au-card-title">${esc(s.title)}</h3>
          ${statusBadge}
        </div>
        <div class="au-card-body">
          <div class="au-card-meta">
            <span>🏢 投标方：${s.party_count || 0} 家</span>
            <span>📋 控制价：${s.control_doc_id ? '已配置' : '未配置'}</span>
          </div>
        </div>
        <div class="au-card-footer">
          <span class="au-card-time">更新于 ${updatedTime}</span>
          <button class="au-btn sm danger" onclick="event.stopPropagation(); deleteSession('${s.id}')">删除</button>
        </div>
      </div>
    `;
  }).join('');
}

async function createSession() {
  const s = await request('/audit/bid-clearing/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: '清标任务 ' + (sessions.length + 1) })
  });

  // 自动初始化3家投标方
  const defaultNames = ['投标单位一', '投标单位二', '投标单位三'];
  for (const name of defaultNames) {
    await request('/audit/bid-clearing/sessions/' + s.id + '/parties', {
      method: 'POST',
      body: JSON.stringify({ party_name: name })
    });
  }

  showToast('任务已创建');
  location.href = '/pc/audit-bid-clearing-detail.html?id=' + s.id;
}

async function deleteSession(sessionId) {
  if (!await showConfirm({
    variant: 'danger',
    title: '删除清标任务',
    message: '将删除该任务及其投标方配置（原始资料保留在资料舱），确定？'
  })) return;

  await request('/audit/bid-clearing/sessions/' + sessionId, { method: 'DELETE' });
  showToast('已删除');
  await loadSessions();
}
