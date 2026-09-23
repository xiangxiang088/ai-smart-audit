/**
 * 智能问答页（证据溯源）：会话管理 + Seed Agent 多轮取证问答
 * 助手答复中的 〔eN〕 为可点击证据角标，右侧抽屉展示文件/页码/sheet/坐标并可跳转资料舱原件
 */
const TOOL_CN = {
  list_documents: '列出资料文件',
  search_evidence: '关键词检索证据',
  get_evidence_detail: '读取证据完整内容',
  list_seals: '识别签章/名章',
  list_sheets: '列出 Excel 工作表',
  get_page: '逐页读取资料'
};
const CONF_CN = { high: ['高', 'conf-high'], mid: ['中', 'conf-mid'], low: ['低', 'conf-low'] };
const TYPE_CN = { table: '表格', text: '正文', title: '标题', seal: '印章', image: '图片', chart: '图表', formula: '公式' };
const MODEL_CN = { 'seed-evolving': 'Seed-Evolving（2.1-pro）', 'seed-21-turbo': 'Seed-2.1-turbo', 'seed-20-lite': 'Seed-2.0-lite' };

const SUGGEST_QUESTIONS = [
  '工程量清单综合单价分析表里，人工费、材料费、机械费分别是多少？标注依据页码。',
  '中标清单与结算书的工程量、综合单价、合价有哪些差异？逐项列出核增核减。',
  '变更签证单是否都有建设单位、监理、施工三方签字盖章？有无无签字、无照片、无审批的"三无签证"？',
  '资料里一共识别到哪些单位的印章？有没有同名但税号不一致的公司？',
  '有没有金额凑整、竣工后集中签证、连号发票等异常线索？',
  '就本次审计目标看，现有资料还缺哪些必要材料？'
];

let projects = [];
let projectId = new URLSearchParams(location.search).get('id');
let sessions = [];
let currentSession = null;
let sending = false;

async function loadModelTag() {
  try {
    const cfg = await request('/audit/ai-config');
    const m = (cfg.models || []).find(x => x.key === cfg.activeModel || x.model === cfg.activeModel);
    const tag = document.getElementById('modelTag');
    if (tag) tag.textContent = '🧠 ' + (m ? (m.label || m.key) : (cfg.activeModel || 'Seed'));
  } catch (e) { /* 未配置时静默 */ }
}

async function pageInit() {
  renderPCTopbar('💬 智能问答');
  loadModelTag();
  bindStatic();
  try {
    projects = await request('/audit/projects');
  } catch (e) { return; }
  const opts = projects.map(p => `<option value="${p.id}">${esc(p.project_name)}</option>`).join('');
  const ctxOpts = projects.map(p => `<option value="${p.id}">📁 ${esc(p.project_name)}</option>`).join('');
  document.getElementById('projectSelect').innerHTML = '<option value="">— 选择审计项目 —</option>' + ctxOpts;
  document.getElementById('projectPick').innerHTML = '<option value="">— 选择审计项目 —</option>' + opts;

  if (projectId && projects.some(p => String(p.id) === String(projectId))) {
    document.getElementById('chatView').style.display = 'flex';
    await setProject(projectId);
  } else if (projects.length === 1) {
    document.getElementById('chatView').style.display = 'flex';
    await setProject(projects[0].id);
  } else {
    document.getElementById('noProject').style.display = 'block';
  }
}

function bindStatic() {
  document.getElementById('projectPick').addEventListener('change', async e => {
    if (!e.target.value) return;
    document.getElementById('noProject').style.display = 'none';
    document.getElementById('chatView').style.display = 'flex';
    await setProject(e.target.value);
  });
  document.getElementById('projectSelect').addEventListener('change', async e => {
    if (e.target.value) await setProject(e.target.value);
  });
  document.getElementById('btnNewSession').addEventListener('click', newSession);
  document.getElementById('btnCloseEvidence').addEventListener('click', () => {
    document.getElementById('evidencePanel').style.display = 'none';
  });
  document.getElementById('btnSend').addEventListener('click', () => doSend());
  const ta = document.getElementById('askInput');
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  });
}

async function setProject(id) {
  projectId = String(id);
  setAuditProject(projectId);
  history.replaceState(null, '', '?id=' + projectId);
  document.getElementById('projectSelect').value = projectId;
  const proj = projects.find(p => String(p.id) === projectId);
  document.getElementById('chatTitle').textContent = proj ? proj.project_name + ' · 证据溯源问答' : '智能问答';
  currentSession = null;
  renderSuggest();
  document.getElementById('msgList').innerHTML = '';
  document.getElementById('welcome').style.display = 'block';
  document.getElementById('evidencePanel').style.display = 'none';
  await loadSessions();
}

function renderSuggest() {
  document.getElementById('suggestList').innerHTML = SUGGEST_QUESTIONS
    .map(q => `<button class="au-suggest-item" type="button">${esc(q)}</button>`).join('');
  document.querySelectorAll('.au-suggest-item').forEach(b => b.addEventListener('click', () => {
    document.getElementById('askInput').value = b.textContent;
    doSend();
  }));
}

async function loadSessions() {
  try {
    sessions = await request('/audit/chat/sessions?project_id=' + projectId);
  } catch (e) { sessions = []; }
  const box = document.getElementById('sessionList');
  if (!sessions.length) {
    box.innerHTML = '<div class="au-session-empty">还没有问答记录<br>直接在下方提问即可</div>';
    return;
  }
  box.innerHTML = sessions.map(s => {
    const title = s.title || s.first_question || '新会话';
    return `<div class="au-session ${String(s.id) === String(currentSession) ? 'active' : ''}" data-id="${s.id}">
      <span class="au-session-title">${esc(title)}</span>
      <button class="au-session-del" data-del="${s.id}" title="删除会话">×</button>
    </div>`;
  }).join('');
  box.querySelectorAll('.au-session').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.dataset.del) return;
      selectSession(el.dataset.id);
    });
  });
  box.querySelectorAll('.au-session-del').forEach(b => b.addEventListener('click', async e => {
    e.stopPropagation();
    const ok = await showConfirm('确认删除该问答会话？');
    if (!ok) return;
    try {
      await request('/audit/chat/sessions/' + b.dataset.del, { method: 'DELETE' });
      if (String(currentSession) === String(b.dataset.del)) {
        currentSession = null;
        document.getElementById('msgList').innerHTML = '';
        document.getElementById('welcome').style.display = 'block';
      }
      await loadSessions();
    } catch (err) { /* toast */ }
  }));
}

async function newSession() {
  if (!projectId) return showToast('请先选择项目');
  try {
    const s = await request('/audit/chat/sessions', { method: 'POST', body: JSON.stringify({ project_id: projectId, title: '新会话' }) });
    currentSession = s.id;
    await loadSessions();
    await selectSession(s.id);
    document.getElementById('askInput').focus();
  } catch (e) { /* toast */ }
}

async function selectSession(id) {
  currentSession = id;
  document.getElementById('welcome').style.display = 'none';
  await loadSessions();
  let msgs = [];
  try {
    msgs = await request('/audit/chat/sessions/' + id + '/messages');
  } catch (e) { return; }
  const list = document.getElementById('msgList');
  list.innerHTML = '';
  msgs.forEach(m => appendMessage(m.role, m.content, m.meta));
  scrollBottom();
}

/* ==================== 流式问答（SSE） ====================
 * Agent 取证一轮要等一次模型往返，整轮跑完可能几十秒。非流式下用户只能干等，
 * 所以这里把「第几轮取证 / 调了什么工具 / 查到几条证据 / 正文逐字生成」实时渲染出来。
 * 事件协议见 server/routes/audit/chat.js：
 *   start / progress / tool / answer / done / error
 * 注：POST 无法用 EventSource，只能 fetch + ReadableStream 手工解析。
 */

/** 创建一个「正在回答」的实时气泡，返回操作它的句柄 */
function createLiveAssistant() {
  const list = document.getElementById('msgList');
  const wrap = document.createElement('div');
  wrap.className = 'au-msg assistant';
  wrap.innerHTML = `
    <div class="au-avatar">AI</div>
    <div class="au-bubble assistant-bubble">
      <div class="au-steps" style="display:none;"></div>
      <div class="au-md"></div>
      <div class="au-wait"><span class="au-wait-dots"><i></i><i></i><i></i></span><em>正在启动取证…</em></div>
    </div>`;
  list.appendChild(wrap);

  const stepsEl = wrap.querySelector('.au-steps');
  const mdEl = wrap.querySelector('.au-md');
  const waitEl = wrap.querySelector('.au-wait');
  const waitEm = waitEl.querySelector('em');
  const stepEls = {};
  const pendingTools = [];
  let streamText = '';
  let hasAnswer = false;
  let renderTimer = null;
  let renderDirty = false;
  let finished = false;

  const t0 = Date.now();
  const ticker = setInterval(() => {
    if (finished || hasAnswer) return;
    waitEm.textContent = `审计助手正在分析资料…已用时 ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);

  function createStep(text) {
    stepsEl.style.display = 'block';
    const el = document.createElement('div');
    el.className = 'au-step running';
    el.innerHTML = `<span class="au-step-icon"></span><span class="au-step-text"></span><span class="au-step-extra"></span>`;
    el.querySelector('.au-step-text').textContent = text;
    stepsEl.appendChild(el);
    return el;
  }

  /** 每收到一段正文就重排一次 Markdown——按帧节流，避免逐字重排拖慢渲染 */
  function scheduleRender() {
    renderDirty = true;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (!renderDirty) return;
      renderDirty = false;
      mdEl.innerHTML = renderMarkdown(streamText);
      autoScrollIfNearBottom();
    }, 80);
  }

  return {
    onProgress(d) {
      const key = d.phase === 'finalize' ? 'finalize' : 'round-' + d.round;
      let el = stepEls[key];
      if (!el) { el = createStep(d.text || '取证中…'); stepEls[key] = el; }
      else el.querySelector('.au-step-text').textContent = d.text || el.querySelector('.au-step-text').textContent;
    },
    onTool(d) {
      if (d.status === 'running') {
        const el = createStep((TOOL_CN[d.tool] || d.tool) + (traceArgs(d) ? '：' + traceArgs(d) : ''));
        el.classList.add('tool');
        pendingTools.push({ round: d.round, tool: d.tool, el });
        return;
      }
      // 找最近一次同轮同名的 running 步骤来收尾
      let idx = -1;
      for (let i = pendingTools.length - 1; i >= 0; i--) {
        if (pendingTools[i].round === d.round && pendingTools[i].tool === d.tool) { idx = i; break; }
      }
      const item = idx >= 0 ? pendingTools.splice(idx, 1)[0] : null;
      const el = item ? item.el : createStep(TOOL_CN[d.tool] || d.tool);
      el.classList.remove('running');
      el.classList.add(d.status === 'ok' ? 'done' : 'fail');
      el.querySelector('.au-step-extra').textContent = d.status === 'ok'
        ? `${d.count != null ? d.count + ' 条' : '完成'}${d.ms != null ? ' · ' + (d.ms / 1000).toFixed(1) + 's' : ''}`
        : (d.error || '失败');
      autoScrollIfNearBottom();
    },
    appendAnswer(text) {
      streamText += text;
      if (!hasAnswer) {
        hasAnswer = true;
        waitEl.style.display = 'none';
        stepsEl.classList.add('compact');
      }
      scheduleRender();
    },
    resetAnswer() {
      streamText = '';
      hasAnswer = false;
      waitEl.style.display = 'flex';
      scheduleRender();
    },
    /** 定稿：用服务端最终正文覆盖预览（服务端会清掉无效证据编号），并补上元信息 */
    finalize(msg) {
      finished = true;
      clearInterval(ticker);
      waitEl.remove();
      stepsEl.remove();
      msg._latency = Math.round((Date.now() - t0) / 1000); // 元信息里显示本次总耗时
      mdEl.innerHTML = renderMarkdown(msg.content);
      wrap.querySelector('.assistant-bubble').insertAdjacentHTML('beforeend', renderMeta(msg));
      bindCitations(wrap, msg.citations);
      autoScrollIfNearBottom();
    },
    /** 连接中断：保留已渲染内容，等回退逻辑从服务端拉最新消息 */
    markInterrupted() {
      finished = true;
      clearInterval(ticker);
      waitEl.innerHTML = '<em>⚠️ 连接中断，正在与服务器核对最新结果…</em>';
      waitEl.style.display = 'flex';
      waitEl.classList.add('warn');
    },
    destroy() {
      finished = true;
      clearInterval(ticker);
      wrap.remove();
    },
    hasAnswer: () => hasAnswer
  };
}

/** 解析一个 SSE 事件块（`event: x\ndata: {...}`），心跳注释行返回 null */
function parseSseBlock(block) {
  let event = 'message';
  const dataLines = [];
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try { return { event, data: JSON.parse(dataLines.join('\n')) }; } catch { return null; }
}

/** 自动滚动：只在用户本来就贴着底部时跟随，避免打断向上翻阅 */
function autoScrollIfNearBottom() {
  const box = document.getElementById('chatScroll');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

/**
 * 发起流式提问并驱动 ui 渲染。
 * 抛出异常时用 err.fromServer 区分「服务端明确报错」与「网络中断」——
 * 前者回退到一次性接口，后者保留已渲染内容并重新拉取服务端结果。
 */
async function streamAsk(sessionId, question, ui) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(API + '/audit/chat/sessions/' + sessionId + '/ask-stream', {
    method: 'POST', headers, body: JSON.stringify({ content: question })
  });

  if (!res.ok) {
    let msg = '请求失败（HTTP ' + res.status + '）';
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* 非 JSON */ }
    const err = new Error(msg);
    err.fromServer = true;
    throw err;
  }
  if (!res.body) {
    const err = new Error('当前浏览器不支持流式响应');
    err.fromServer = true;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let doneMsg = null;
  let serverErr = null;
  let networkErr = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const ev = parseSseBlock(buf.slice(0, sep));
        buf = buf.slice(sep + 2);
        if (!ev) continue;
        if (ev.event === 'done') doneMsg = ev.data;
        else if (ev.event === 'error') serverErr = ev.data.message || '流式问答失败';
        else if (ev.event === 'start') { /* 已由 wait 提示覆盖 */ }
        else if (ev.event === 'progress') ui.onProgress(ev.data);
        else if (ev.event === 'tool') ui.onTool(ev.data);
        else if (ev.event === 'answer') {
          if (ev.data.reset) ui.resetAnswer();
          else if (ev.data.text) ui.appendAnswer(ev.data.text);
        }
      }
    }
  } catch (e) {
    networkErr = e;
  }

  if (serverErr) {
    const err = new Error(serverErr);
    err.fromServer = true;
    throw err;
  }
  if (networkErr) throw networkErr;
  if (!doneMsg) throw new Error('连接中断，未收到完整答复');
  ui.finalize(doneMsg);
  return doneMsg;
}

async function doSend() {
  if (sending) return;
  const ta = document.getElementById('askInput');
  const q = ta.value.trim();
  if (!q) return;
  if (!projectId) return showToast('请先选择项目');
  ta.value = '';
  ta.style.height = 'auto';

  if (!currentSession) {
    try {
      const s = await request('/audit/chat/sessions', { method: 'POST', body: JSON.stringify({ project_id: projectId, title: q.slice(0, 20) }) });
      currentSession = s.id;
      await loadSessions();
    } catch (e) { ta.value = q; return; }
  }
  document.getElementById('welcome').style.display = 'none';
  appendMessage('user', q, null);
  scrollBottom();
  sending = true;
  setTyping(true);
  const started = Date.now();

  // 流式：取证进度与正文实时渲染
  const ui = createLiveAssistant();
  document.getElementById('typing').style.display = 'none'; // 进度已在气泡里，不用跳动的小点
  scrollBottom();

  try {
    await streamAsk(currentSession, q, ui);
  } catch (e) {
    if (e.fromServer) {
      // 服务端明确失败：清掉半截气泡，退回一次性接口重试
      ui.destroy();
      // 回退链路同样是几十秒的等待，把加载提示放出来，别让用户对着空页面
      const hint = document.getElementById('typingHint');
      if (hint) hint.textContent = '正在重新分析…';
      document.getElementById('typing').style.display = 'flex';
      scrollBottom();
      try {
        const m = await request('/audit/chat/sessions/' + currentSession + '/ask', {
          method: 'POST', body: JSON.stringify({ content: q })
        });
        m._latency = Math.round((Date.now() - started) / 1000);
        appendMessage('assistant', m.content, m);
      } catch (e2) {
        appendMessage('assistant', '⚠️ ' + (e2.message || '本次分析失败，请稍后重试。'), { error: true });
      }
    } else {
      // 网络中断：Agent 可能仍在服务端跑完并落库，保留已渲染内容并回拉最新消息
      ui.markInterrupted();
      setTimeout(() => { if (currentSession) selectSession(currentSession); }, 2000);
    }
  } finally {
    sending = false;
    setTyping(false);
    loadSessions();
    scrollBottom();
  }
}

function setTyping(on) {
  const t = document.getElementById('typing');
  t.style.display = on ? 'flex' : 'none';
  // 文案可能被「回退重试」改过，下次发起时复位
  if (on) {
    const hint = document.getElementById('typingHint');
    if (hint) hint.textContent = '正在检索资料、多轮取证…';
  }
  document.getElementById('btnSend').disabled = on;
  if (on) scrollBottom();
}

function scrollBottom() {
  const box = document.getElementById('chatScroll');
  box.scrollTop = box.scrollHeight;
}

function appendMessage(role, content, meta) {
  const list = document.getElementById('msgList');
  const wrap = document.createElement('div');
  wrap.className = 'au-msg ' + role;
  if (role === 'user') {
    wrap.innerHTML = `<div class="au-bubble user-bubble">${esc(content).replace(/\n/g, '<br>')}</div>`;
  } else {
    const body = meta && meta.error
      ? `<div class="au-md">${esc(content)}</div>`
      : `<div class="au-md">${renderMarkdown(content)}</div>${renderMeta(meta || {})}`;
    wrap.innerHTML = `<div class="au-avatar">AI</div><div class="au-bubble assistant-bubble">${body}</div>`;
    bindCitations(wrap, meta && meta.citations);
  }
  list.appendChild(wrap);
}

/** 绑定证据角标点击：查不到对应证据的角标直接移除，避免点了没反应 */
function bindCitations(wrap, citations) {
  const byEid = {};
  (citations || []).forEach(c => { byEid[c.eid] = c; });
  wrap.querySelectorAll('[data-eid]').forEach(el => {
    const c = byEid[el.dataset.eid];
    if (!c) { el.remove(); return; }
    el.addEventListener('click', () => openEvidence(c));
  });
}

function renderMeta(meta) {
  if (!meta || meta.error) return '';
  const conf = CONF_CN[meta.confidence] || CONF_CN.mid;
  const model = MODEL_CN[meta.modelKey] || meta.modelKey || meta.model || 'Seed';
  const citeChips = (meta.citations || []).map(c => {
    const loc = c.sheetName ? 'sheet ' + esc(c.sheetName) : '第 ' + (c.pageNo || '?') + ' 页';
    return `<button type="button" class="au-cite-chip" data-eid="${c.eid}">📎 ${esc(c.fileName)} · ${loc}</button>`;
  }).join('');
  const missing = (meta.missing || []).length ? `
    <div class="au-missing">
      <div class="au-missing-head">🧾 资料缺失 / 需补充（${meta.missing.length}）</div>
      <ul>${meta.missing.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    </div>` : '';
  const trace = (meta.trace || []);
  const traceHtml = trace.length ? `
    <details class="au-trace">
      <summary>🔧 取证过程（${trace.length} 次工具调用 · ${meta.rounds || ''} 轮 · ${meta.evidenceCount || 0} 条证据）</summary>
      <ol class="au-trace-list">
        ${trace.map(t => `<li class="${t.ok ? '' : 'fail'}">
          <span class="au-trace-tool">${TOOL_CN[t.tool] || t.tool}</span>
          <span class="au-trace-args">${esc(traceArgs(t))}</span>
          ${t.count != null ? `<span class="au-trace-count">${t.count} 条</span>` : ''}
          ${t.error ? `<span class="au-trace-err">${esc(t.error)}</span>` : ''}
        </li>`).join('')}
      </ol>
    </details>` : '';
  const tokens = meta.usage && meta.usage.total_tokens ? ` · ${meta.usage.total_tokens} tokens` : '';
  const latency = meta._latency ? ` · ${meta._latency}s` : '';
  return `
    ${missing}
    ${citeChips ? `<div class="au-cite-row">${citeChips}</div>` : ''}
    ${traceHtml}
    <div class="au-msg-meta">
      <span class="au-conf ${conf[1]}">置信度 ${conf[0]}</span>
      <span>模型 ${esc(model)}</span>${tokens}${latency}
    </div>`;
}

function traceArgs(t) {
  const a = t.args || {};
  if (t.tool === 'search_evidence') return '「' + (a.query || '') + '」';
  if (t.tool === 'get_page') return `文件${a.doc_id || ''} 第${a.page || ''}页`;
  if (t.tool === 'get_evidence_detail') return a.eid || '';
  if (t.tool === 'list_seals' || t.tool === 'list_sheets') return a.doc_id ? '限定文件 ' + a.doc_id : '全项目';
  return '';
}

function openEvidence(c) {
  const panel = document.getElementById('evidencePanel');
  const body = document.getElementById('evidenceBody');
  const loc = c.sheetName
    ? `Excel 工作表「${esc(c.sheetName)}」`
    : `第 ${c.pageNo || '?'} 页${c.anchor ? ' · ' + esc(c.anchor.replace(/^第?\s*\d+\s*页?·?/, '')) : ''}`;
  const href = `/pc/audit-documents.html?id=${projectId}&doc=${c.docId}${c.pageNo ? '&page=' + c.pageNo : ''}`;
  body.innerHTML = `
    <div class="au-ev-card">
      <div class="au-ev-file">📄 ${esc(c.fileName)}</div>
      <div class="au-ev-loc"><span class="au-badge cat">${TYPE_CN[c.type] || c.type}</span> ${loc}</div>
      ${c.bbox ? '<div class="au-ev-coord">📍 含版面坐标（bbox），可在原件页面高亮定位</div>' : '<div class="au-ev-coord">📍 页码 / 工作表级定位</div>'}
      <div class="au-ev-snippet">${esc(c.snippet || '')}</div>
      <a class="au-btn sm primary" target="_blank" href="${href}">在资料舱查看原件 →</a>
    </div>`;
  panel.style.display = 'flex';
}

/* Markdown 渲染（renderMarkdown / inlineMd）已抽到共享的 pc/js/pc-md.js */
