/**
 * PC端 AI健康饮食顾问
 * 复用后端接口 /ai/diet 和 /ai/diet-chat，UI为PC居中弹窗风格
 */

let _pcDietMessages = [];
let _pcDietCtx = null;
let _pcDietSessionId = null;
let _pcDietStart = '';
let _pcDietEnd = '';

function pcDietInitDates() {
  if (!_pcDietStart) {
    const now = new Date();
    _pcDietStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    _pcDietEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${lastDay}`;
  }
}

window.pcDietSetRange = function(range) {
  const now = new Date();
  let s, e;
  if (range === 'month') {
    s = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const ld = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    e = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${ld}`;
  } else if (range === 'lastmonth') {
    const lm = new Date(now.getFullYear(), now.getMonth(), 0);
    const lmo = lm.getMonth() + 1;
    s = `${lm.getFullYear()}-${String(lmo).padStart(2, '0')}-01`;
    e = `${lm.getFullYear()}-${String(lmo).padStart(2, '0')}-${lm.getDate()}`;
  } else if (range === 'year') {
    s = `${now.getFullYear()}-01-01`;
    e = `${now.getFullYear()}-12-31`;
  }
  _pcDietStart = s;
  _pcDietEnd = e;
  const si = document.getElementById('pcDietStart');
  const ei = document.getElementById('pcDietEnd');
  if (si) si.value = s;
  if (ei) ei.value = e;
};

window.pcDietInputChange = function() {
  const si = document.getElementById('pcDietStart');
  const ei = document.getElementById('pcDietEnd');
  if (si && si.value) _pcDietStart = si.value;
  if (ei && ei.value) _pcDietEnd = ei.value;
};

window.openDietAnalysis = function() {
  let modal = document.getElementById('pcDietModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pcDietModal';
    modal.className = 'modal show pc-diet-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <div class="pc-diet-header">
          <div class="pc-diet-header-title">🥗 AI健康饮食顾问</div>
          <button class="pc-diet-close" onclick="document.getElementById('pcDietModal').classList.remove('show')">✕</button>
        </div>
        <div class="pc-diet-tabs">
          <button class="pc-diet-tab active" data-tab="chat" onclick="pcDietSwitchTab('chat')">💬 对话</button>
          <button class="pc-diet-tab" data-tab="history" onclick="pcDietSwitchTab('history')">📋 历史记录</button>
        </div>
        <div class="pc-diet-body">
          <div class="pc-diet-chat" id="pcDietChatPane">
            <div class="pc-diet-msgs" id="pcDietMsgs"></div>
            <div class="pc-diet-input-bar">
              <input type="text" id="pcDietInput" class="pc-diet-input" placeholder="继续提问，如：多吃蔬菜有什么好处？" maxlength="200" disabled>
              <button class="pc-diet-send" id="pcDietSend" onclick="pcDietSendMsg()" disabled>发送</button>
            </div>
          </div>
          <div class="pc-diet-history" id="pcDietHistoryPane" style="display:none;"></div>
        </div>
      </div>`;
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('show'); });
    modal.querySelector('#pcDietInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pcDietSendMsg(); }
    });
    document.body.appendChild(modal);
  } else {
    modal.classList.add('show');
  }
  pcDietSwitchTab('chat');
};

window.pcDietSwitchTab = function(tab) {
  document.querySelectorAll('.pc-diet-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('pcDietChatPane').style.display = tab === 'chat' ? 'flex' : 'none';
  document.getElementById('pcDietHistoryPane').style.display = tab === 'history' ? 'block' : 'none';
  if (tab === 'chat' && _pcDietMessages.length === 0) pcDietRenderWelcome();
  if (tab === 'history') pcDietLoadHistory();
};

function pcDietRenderWelcome() {
  pcDietInitDates();
  const msgsEl = document.getElementById('pcDietMsgs');
  msgsEl.innerHTML = `
    <div class="pc-diet-welcome">
      <div class="pc-diet-welcome-icon">🥗</div>
      <div class="pc-diet-welcome-title">AI健康饮食顾问</div>
      <div class="pc-diet-welcome-desc">我会根据你的餐饮消费记录分析饮食结构，给出个性化健康建议。选择日期范围后开始分析。</div>
      <div class="pc-diet-range-bar">
        <button class="pc-diet-range-btn" onclick="pcDietSetRange('month')">本月</button>
        <button class="pc-diet-range-btn" onclick="pcDietSetRange('lastmonth')">上月</button>
        <button class="pc-diet-range-btn" onclick="pcDietSetRange('year')">本年</button>
      </div>
      <div class="pc-diet-range-inputs">
        <input type="date" id="pcDietStart" value="${_pcDietStart}" onchange="pcDietInputChange()">
        <span class="pc-diet-range-sep">~</span>
        <input type="date" id="pcDietEnd" value="${_pcDietEnd}" onchange="pcDietInputChange()">
      </div>
      <button class="pc-diet-start-btn" onclick="pcDietStartAnalysis()">🔍 开始分析</button>
    </div>`;
}

window.pcDietStartAnalysis = async function() {
  pcDietInitDates();
  const start = _pcDietStart;
  const end = _pcDietEnd;
  const label = start.slice(0, 7) === end.slice(0, 7)
    ? `${start.slice(0, 4)}年${parseInt(start.slice(5, 7))}月`
    : `${start} ~ ${end}`;

  _pcDietMessages = [];
  _pcDietCtx = null;
  _pcDietSessionId = null;

  const msgsEl = document.getElementById('pcDietMsgs');
  msgsEl.innerHTML = '';
  pcDietAppendBubble('ai', '🤖 正在分析你的餐饮数据，请稍候...', true);

  try {
    const data = await request('/ai/diet', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook, start_date: start, end_date: end, period_label: label })
    });

    _pcDietCtx = `【餐饮分析范围】${label}，共${data.record_count}笔，总支出¥${Number(data.total_expense).toFixed(2)}`;
    _pcDietMessages.push({ role: 'assistant', content: data.analysis });
    if (data.session_id) _pcDietSessionId = data.session_id;

    msgsEl.querySelector('.pc-diet-bubble-loading')?.remove();
    pcDietAppendBubble('ai', data.analysis);
    pcDietAppendBubble('system', `📅 ${label} · 🍽️ ${data.record_count}笔 · 💰 ¥${Number(data.total_expense).toFixed(2)} · 已保存到历史`);
    pcDietScrollBottom();

    document.getElementById('pcDietInput').disabled = false;
    document.getElementById('pcDietSend').disabled = false;
    document.getElementById('pcDietInput').focus();
  } catch (e) {
    msgsEl.querySelector('.pc-diet-bubble-loading')?.remove();
    pcDietAppendBubble('ai', `😕 ${e.message || '分析失败，请检查AI配置'}`);
    pcDietScrollBottom();
  }
};

window.pcDietSendMsg = async function() {
  const input = document.getElementById('pcDietInput');
  const sendBtn = document.getElementById('pcDietSend');
  const text = input.value.trim();
  if (!text) return;
  if (!_pcDietCtx) {
    pcDietAppendBubble('ai', '请先点击「开始分析」生成饮食分析，再进行提问。');
    pcDietScrollBottom();
    return;
  }

  input.value = '';
  input.disabled = true;
  sendBtn.disabled = true;

  pcDietAppendBubble('user', text);
  pcDietAppendBubble('ai', '🤖 思考中...', true);
  pcDietScrollBottom();

  _pcDietMessages.push({ role: 'user', content: text });

  const contextMsg = { role: 'user', content: `背景信息：${_pcDietCtx}\n\n用户问题：${text}` };
  const sendMessages = _pcDietMessages.length <= 2
    ? [contextMsg]
    : [..._pcDietMessages.slice(-6), { role: 'user', content: text }];

  try {
    const data = await request('/ai/diet-chat', {
      method: 'POST',
      body: JSON.stringify({ book_id: state.currentBook, messages: sendMessages, session_id: _pcDietSessionId || undefined })
    });
    _pcDietMessages.push({ role: 'assistant', content: data.reply });
    document.querySelector('#pcDietMsgs .pc-diet-bubble-loading')?.remove();
    pcDietAppendBubble('ai', data.reply);
  } catch (e) {
    document.querySelector('#pcDietMsgs .pc-diet-bubble-loading')?.remove();
    pcDietAppendBubble('ai', `😕 ${e.message || '回复失败，请重试'}`);
  } finally {
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
    pcDietScrollBottom();
  }
};

function pcDietAppendBubble(role, text, isLoading) {
  const msgsEl = document.getElementById('pcDietMsgs');
  const div = document.createElement('div');
  if (role === 'user') {
    div.className = 'pc-diet-bubble pc-diet-bubble-user';
    div.textContent = text;
  } else if (role === 'system') {
    div.className = 'pc-diet-bubble-system';
    div.innerHTML = esc(text);
  } else {
    div.className = isLoading ? 'pc-diet-bubble pc-diet-bubble-ai pc-diet-bubble-loading' : 'pc-diet-bubble pc-diet-bubble-ai';
    div.innerHTML = esc(text).replace(/\n/g, '<br>');
  }
  msgsEl.appendChild(div);
}

function pcDietScrollBottom() {
  const msgsEl = document.getElementById('pcDietMsgs');
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

async function pcDietLoadHistory() {
  const pane = document.getElementById('pcDietHistoryPane');
  pane.innerHTML = '<div style="text-align:center;padding:32px 0;color:var(--text-muted);font-size:14px;">⏳ 加载历史记录...</div>';
  try {
    const data = await request(`/ai/history?book_id=${state.currentBook}&period_type=diet&page_size=20`);
    if (!data.list || data.list.length === 0) {
      pane.innerHTML = '<div style="text-align:center;padding:48px 0;color:var(--text-muted);font-size:14px;">暂无历史记录</div>';
      return;
    }
    pane.innerHTML = data.list.map(item => {
      const title = item.session_title || item.period_label || '';
      const date = item.created_at ? item.created_at.slice(0, 10) : '';
      return `
        <div class="pc-diet-hist-item" data-id="${item.id}">
          <div class="pc-diet-hist-header" onclick="pcDietToggleHistory('${item.id}')">
            <div class="pc-diet-hist-label-wrap">
              <span class="pc-diet-hist-label">${esc(title)}</span>
              <span class="pc-diet-hist-time">${date}</span>
            </div>
            <span class="pc-diet-hist-chevron">›</span>
          </div>
          <div class="pc-diet-hist-stat">💰 餐饮支出 ¥${Number(item.total_expense).toFixed(2)}</div>
          <div class="pc-diet-hist-body" id="pcDietHistBody_${item.id}" style="display:none;"></div>
        </div>`;
    }).join('');
  } catch (e) {
    pane.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--danger);font-size:14px;">😕 ${esc(e.message || '加载失败')}</div>`;
  }
}

window.pcDietToggleHistory = async function(id) {
  const bodyEl = document.getElementById(`pcDietHistBody_${id}`);
  if (!bodyEl) return;
  const isOpen = bodyEl.style.display !== 'none';
  if (isOpen) {
    bodyEl.style.display = 'none';
    bodyEl.closest('.pc-diet-hist-item')?.querySelector('.pc-diet-hist-chevron')?.classList.remove('open');
    return;
  }
  bodyEl.style.display = 'block';
  bodyEl.closest('.pc-diet-hist-item')?.querySelector('.pc-diet-hist-chevron')?.classList.add('open');
  if (bodyEl.dataset.loaded) return;
  bodyEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">加载中...</div>';
  try {
    const record = await request(`/ai/history/${id}`);
    let msgs = [];
    try { msgs = JSON.parse(record.messages_json || '[]'); } catch (e) {}
    if (!msgs.length) {
      msgs = [{ role: 'assistant', content: record.analysis_text }];
    }
    const bubblesHtml = msgs.map(m => {
      if (m.role === 'user') {
        return `<div class="pc-diet-hist-bubble pc-diet-bubble pc-diet-bubble-user">${esc(m.content)}</div>`;
      }
      return `<div class="pc-diet-hist-bubble pc-diet-bubble pc-diet-bubble-ai">${esc(m.content).replace(/\n/g, '<br>')}</div>`;
    }).join('');
    bodyEl.innerHTML = `
      <div class="pc-diet-hist-chat">${bubblesHtml}</div>
      <button class="pc-diet-continue-btn" onclick="pcDietContinueFromHistory('${id}')">💬 继续对话</button>`;
    bodyEl.dataset.loaded = '1';
  } catch (e) {
    bodyEl.innerHTML = `<div style="color:var(--danger);font-size:13px;">加载失败</div>`;
  }
};

window.pcDietContinueFromHistory = async function(id) {
  try {
    const record = await request(`/ai/history/${id}`);
    let msgs = [];
    try { msgs = JSON.parse(record.messages_json || '[]'); } catch (e) {}
    if (!msgs.length) msgs = [{ role: 'assistant', content: record.analysis_text }];

    pcDietSwitchTab('chat');
    const msgsEl = document.getElementById('pcDietMsgs');
    msgsEl.innerHTML = '';

    _pcDietSessionId = id;
    _pcDietMessages = msgs.slice();
    const label = record.period_label || '';
    _pcDietCtx = `【餐饮分析范围】${label}，总支出¥${Number(record.total_expense).toFixed(2)}`;

    pcDietAppendBubble('system', `↩️ 继续历史对话：${record.session_title || label}`);
    msgs.forEach(m => pcDietAppendBubble(m.role === 'user' ? 'user' : 'ai', m.content));
    pcDietScrollBottom();

    document.getElementById('pcDietInput').disabled = false;
    document.getElementById('pcDietSend').disabled = false;
    document.getElementById('pcDietInput').focus();
  } catch (e) {
    showToast('加载对话失败：' + (e.message || ''));
  }
};
