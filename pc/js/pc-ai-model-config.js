/**
 * 模型配置页（独立页面 /pc/ai-model-config.html）
 *
 * 目的：让管理员自己决定「审计功能用哪个模型、按什么顺序降级」，不必改代码、不必重启服务。
 * 配置落在 audit_ai_config（单行 JSON），保存后 arkClient 清缓存立即生效。
 *
 * 三个核心概念（页面上也做了显式提示）：
 *   1) 列表顺序 = 降级顺序：第 1 个是主模型，只有它失败才会试第 2 个
 *   2) 关掉某个模型 = 彻底跳过它，一次都不会试
 *   3) 关闭「自动故障切换」= 只跑主模型，绝不试备用
 */

const MCFG_MINUTE = 60000;

let mcfg = null;       // 编辑中的配置
let mcfgSnap = null;   // 加载/保存时的快照（供「还原」使用）
let mcfgAdmin = false;
let mcfgDirty = false;

async function pageInit() {
  renderPCTopbar('🤖 模型配置');
  mcfgAdmin = localStorage.getItem('isAdmin') === 'true';
  if (!mcfgAdmin) {
    document.getElementById('btnSave').disabled = true;
    document.getElementById('btnReset').disabled = true;
  }
  bindMcfgEvents();
  await loadMcfg();
}

function bindMcfgEvents() {
  document.getElementById('btnTest').addEventListener('click', mcfgTest);
  document.getElementById('btnSave').addEventListener('click', mcfgSave);
  document.getElementById('btnReset').addEventListener('click', () => {
    if (!mcfgSnap) return;
    mcfg = JSON.parse(JSON.stringify(mcfgSnap));
    renderMcfgAll();
    mcfgDirty = false;
    updateMcfgHint();
    showToast('已还原为上次保存的配置');
  });
  document.getElementById('failoverToggle').addEventListener('change', e => {
    mcfg.failoverEnabled = e.target.checked;
    renderMcfgPreview();  // 关闭后预览只剩主模型
    markMcfgDirty();
  });
  document.getElementById('chainTimeoutInput').addEventListener('input', e => {
    const min = Number(e.target.value);
    mcfg.chainTimeoutMs = Number.isFinite(min) && min > 0 ? Math.round(min * MCFG_MINUTE) : 0;
    markMcfgDirty();
  });
}

async function loadMcfg() {
  try {
    mcfg = await request('/audit/ai-config');
    mcfgSnap = JSON.parse(JSON.stringify(mcfg));
    normalizeMcfg();      // 主模型固定排首位，与后端保存逻辑一致
    renderMcfgAll();
    mcfgDirty = false;
    updateMcfgHint();
  } catch (err) {
    document.getElementById('modelList').innerHTML =
      '<div class="au-empty">配置加载失败：' + esc(err.message) + '</div>';
  }
}

/** 把 activeModel 对应项移到数组首位 —— 列表顺序即真实调用顺序 */
function normalizeMcfg() {
  const list = mcfg.models || [];
  if (!list.length) return;
  let idx = list.findIndex(m => m.model === mcfg.activeModel || m.key === mcfg.activeModel);
  if (idx < 0) idx = list.findIndex(m => m.role === 'primary');
  if (idx < 0) idx = 0;
  mcfg.activeModel = list[idx].model;
  if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
  mcfg.models = list;
}

function shortLabel(label) {
  return String(label || '').split('（')[0].split('(')[0].trim();
}

function msToMin(ms) {
  return ms > 0 ? Math.round(ms / MCFG_MINUTE * 100) / 100 : '';
}

function markMcfgDirty() { mcfgDirty = true; updateMcfgHint(); }

function updateMcfgHint() {
  const el = document.getElementById('saveHint');
  if (!mcfgAdmin) { el.textContent = '⚠️ 仅管理员可修改模型配置'; el.style.color = '#d97706'; return; }
  el.textContent = mcfgDirty ? '● 有未保存的修改' : '';
  el.style.color = mcfgDirty ? '#d97706' : '';
}

// ---------------- 渲染 ----------------

function renderMcfgAll() {
  document.getElementById('failoverToggle').checked = mcfg.failoverEnabled !== false;
  document.getElementById('chainTimeoutInput').value =
    mcfg.chainTimeoutMs > 0 ? (mcfg.chainTimeoutMs / MCFG_MINUTE) : '';
  renderMcfgPreview();
  renderMcfgList();
  updateMcfgHint();
}

/** 顶部「当前实际调用顺序」预览 —— 让用户一眼看清会先试谁 */
function renderMcfgPreview() {
  const el = document.getElementById('chainPreview');
  const list = mcfg.models || [];
  const active = list.find(m => m.model === mcfg.activeModel || m.key === mcfg.activeModel);
  if (!active) { el.innerHTML = '<span style="color:#ef4444">未选择主模型</span>'; return; }
  const chain = mcfg.failoverEnabled !== false
    ? [active, ...list.filter(m => m !== active && m.enabled !== false)]
    : [active];
  let html = chain.map((m, i) => `
    <span class="au-chain-node ${i === 0 ? 'lead' : ''}">
      <span class="au-chain-order">${i + 1}</span>${esc(shortLabel(m.label))}
    </span>`).join('<span class="au-chain-arrow">→</span>');
  if (mcfg.failoverEnabled === false) {
    html += '<span class="au-chain-tail">（故障切换已关闭，不会尝试备用模型）</span>';
  } else {
    const skipped = list.filter(m => m.enabled === false);
    if (skipped.length) {
      html += '<span class="au-chain-tail">已停用：'
        + skipped.map(m => esc(shortLabel(m.label))).join('、') + '</span>';
    }
  }
  el.innerHTML = html;
}

function renderMcfgList() {
  const el = document.getElementById('modelList');
  const list = mcfg.models || [];
  el.innerHTML = list.map((m, i) => {
    const isActive = m.model === mcfg.activeModel || m.key === mcfg.activeModel;
    const off = m.enabled === false;
    const dis = mcfgAdmin ? '' : 'disabled';
    return `
    <div class="au-model-card${isActive ? ' active' : ''}${off ? ' off' : ''}">
      <div class="au-model-main">
        <label class="au-model-radio">
          <input type="radio" name="mcfgActive" value="${esc(m.model)}" ${isActive ? 'checked' : ''} ${dis}>
          <span class="au-model-name">${esc(shortLabel(m.label))}</span>
          ${isActive ? '<span class="au-tag primary">主模型</span>' : `<span class="au-tag">备用 ${i}</span>`}
          ${off ? '<span class="au-tag off">已停用</span>' : ''}
        </label>
        <div class="au-model-id">model: <code>${esc(m.model)}</code></div>
        <div class="au-model-note">${esc(m.note || '')}</div>
        <div class="au-model-key">Key：${m.hasKey
          ? (m.usingEnvKey ? '✅ 使用环境变量 ARK_API_KEY' : '✅ 已配置独立 Key')
          : '⚠️ 未配置（将回退环境变量）'}</div>
      </div>
      <div class="au-model-right">
        <span class="au-model-time" title="该模型单次调用的最长等待（流式下为「空闲超时」）；留空 = 默认">
          超时 <input type="number" min="0" step="0.5" data-time="${i}" value="${msToMin(m.timeoutMs)}" ${dis}> 分
        </span>
        <div class="au-model-sort">
          <button data-up="${i}" title="上移：提高优先级" ${i === 0 || !mcfgAdmin ? 'disabled' : ''}>▲</button>
          <button data-down="${i}" title="下移：降低优先级" ${i === list.length - 1 || !mcfgAdmin ? 'disabled' : ''}>▼</button>
        </div>
        <label class="au-model-enable" title="${isActive ? '主模型必须启用' : '取消勾选即彻底跳过该模型'}">
          <input type="checkbox" data-enable="${i}" ${off ? '' : 'checked'} ${isActive || !mcfgAdmin ? 'disabled' : ''}>
          <span>启用</span>
        </label>
        ${mcfgAdmin && !isActive ? `<button class="au-btn-mini" data-only="${i}" title="设为主模型并关闭故障切换">仅用此模型</button>` : ''}
      </div>
    </div>`;
  }).join('');
  bindMcfgListEvents();
}

function bindMcfgListEvents() {
  const el = document.getElementById('modelList');
  el.querySelectorAll('input[name="mcfgActive"]').forEach(r =>
    r.addEventListener('change', () => mcfgSetActive(r.value)));
  el.querySelectorAll('input[data-enable]').forEach(cb =>
    cb.addEventListener('change', () => {
      mcfg.models[Number(cb.dataset.enable)].enabled = cb.checked;
      renderMcfgAll();
      markMcfgDirty();
    }));
  el.querySelectorAll('input[data-time]').forEach(inp =>
    inp.addEventListener('input', () => {
      const min = Number(inp.value);
      mcfg.models[Number(inp.dataset.time)].timeoutMs =
        Number.isFinite(min) && min > 0 ? Math.round(min * MCFG_MINUTE) : 0;
      markMcfgDirty();
    }));
  el.querySelectorAll('button[data-up]').forEach(b =>
    b.addEventListener('click', () => mcfgMove(Number(b.dataset.up), -1)));
  el.querySelectorAll('button[data-down]').forEach(b =>
    b.addEventListener('click', () => mcfgMove(Number(b.dataset.down), 1)));
  el.querySelectorAll('button[data-only]').forEach(b =>
    b.addEventListener('click', () => mcfgOnlyThis(Number(b.dataset.only))));
}

// ---------------- 交互 ----------------

function mcfgSetActive(modelId) {
  const list = mcfg.models;
  const idx = list.findIndex(m => m.model === modelId || m.key === modelId);
  if (idx < 0) return;
  mcfg.activeModel = list[idx].model;
  if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
  renderMcfgAll();
  markMcfgDirty();
}

function mcfgMove(i, delta) {
  const list = mcfg.models;
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
  mcfg.activeModel = list[0].model;  // 队首即主模型，顺序变了主模型也跟着变
  renderMcfgAll();
  markMcfgDirty();
}

/** 一键「只用此模型」：设为主模型 + 关闭故障切换（不再试任何备用） */
function mcfgOnlyThis(i) {
  const list = mcfg.models;
  mcfg.activeModel = list[i].model;
  if (i > 0) list.unshift(list.splice(i, 1)[0]);
  mcfg.failoverEnabled = false;
  renderMcfgAll();
  markMcfgDirty();
  showToast('已设为「只用 ' + shortLabel(list[0].label) + '」，记得点「保存并生效」');
}

async function mcfgTest() {
  const out = document.getElementById('modelTestResult');
  out.innerHTML = '⏳ 正在逐个测试（每个模型一次极简请求），约需 10-30 秒...';
  try {
    const res = await request('/audit/ai-config/test', { method: 'POST', body: JSON.stringify({}) });
    out.innerHTML = '<div class="au-model-test-grid">' + res.results.map(r => `
      <div class="au-model-test-item ${r.ok ? 'ok' : 'fail'}">
        <b>${r.isActive ? '⭐ ' : ''}${esc(shortLabel(r.label))}</b>
        ${r.ok
          ? '✅ 正常 <span class="au-model-lat">' + r.latencyMs + 'ms</span><div class="au-model-reply">' + esc(r.reply || '') + '</div>'
          : '❌ ' + esc(r.error || ('HTTP ' + r.status))}
      </div>`).join('') + '</div>';
  } catch (err) {
    out.innerHTML = '<span style="color:#ef4444">测试失败：' + esc(err.message) + '</span>';
  }
}

async function mcfgSave() {
  if (!mcfgAdmin) return;
  const list = mcfg.models || [];
  const active = list.find(m => m.model === mcfg.activeModel || m.key === mcfg.activeModel);
  if (!active) return showToast('请先选择主模型');
  if (active.enabled === false) return showToast('主模型不能停用，请先启用它');
  if (list.every(m => m.enabled === false)) return showToast('至少要启用一个模型');

  const btn = document.getElementById('btnSave');
  btn.disabled = true;
  btn.textContent = '保存中...';
  try {
    const res = await request('/audit/ai-config', {
      method: 'PUT',
      body: JSON.stringify({
        activeModel: mcfg.activeModel,
        failoverEnabled: document.getElementById('failoverToggle').checked,
        chainTimeoutMs: mcfg.chainTimeoutMs,
        // 顺序即优先级：按当前列表顺序提交，后端以此重排模型链
        models: list.map(m => ({
          key: m.key, model: m.model,
          enabled: m.enabled !== false,
          timeoutMs: m.timeoutMs || 0
        }))
      })
    });
    mcfg = res.config || mcfg;
    mcfgSnap = JSON.parse(JSON.stringify(mcfg));
    normalizeMcfg();
    renderMcfgAll();
    mcfgDirty = false;
    updateMcfgHint();
    showToast('已保存，下一次分析立即生效（无需重启服务）');
  } catch (err) {
    // request() 已弹出错误提示，这里只恢复按钮
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 保存并生效';
  }
}
