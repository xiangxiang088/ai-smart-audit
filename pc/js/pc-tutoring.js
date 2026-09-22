/**
 * AI 交互辅导页面逻辑 - pc-tutoring.js
 * 功能：智能答疑（对话式）、主观题批改、口语评测、虚拟实验指导
 */

'use strict';

// ──────────────────────────────────────────────────────────────
// 全局状态
// ──────────────────────────────────────────────────────────────
let currentTab       = 'qa';
let qaSessionId      = null;       // 当前答疑会话 ID
let qaSubjects       = [];         // 学科列表
let speechRecognizer = null;       // Web Speech API 实例
let isRecording      = false;      // 是否正在录音
let expSessionId     = null;       // 当前实验会话 ID
let currentExpId     = null;       // 当前实验 ID
let experiments      = [];         // 实验列表

// ──────────────────────────────────────────────────────────────
// 页面初始化
// ──────────────────────────────────────────────────────────────
async function pageInit() {
  renderPCTopbar('AI 交互辅导');
  await Promise.all([
    loadQaSubjects(),
    loadQaHistory(),
    loadExperiments(),
    initSpeechRecognition()
  ]);
}

// ──────────────────────────────────────────────────────────────
// Tab 切换
// ──────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tut-tab-btn').forEach((btn, i) => {
    const tabs = ['qa', 'grade', 'oral', 'experiment'];
    btn.classList.toggle('active', tabs[i] === tab);
  });
  document.querySelectorAll('.tut-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('panel-' + tab);
  if (panel) panel.classList.add('active');
}

// ══════════════════════════════════════════════════════════════
// Tab1 — 智能答疑
// ══════════════════════════════════════════════════════════════

async function loadQaSubjects() {
  try {
    const data = await request('/edu/subjects');
    qaSubjects = Array.isArray(data) ? data : (data.list || []);
    const sel = document.getElementById('qaSubjectSelect');
    // 按学段分组渲染 <optgroup>
    const LEVEL_NAMES = { primary: '🏫 小学', junior: '📚 初中', high: '🎓 高中', university: '🎓 大学' };
    const LEVEL_ORDER = ['primary', 'junior', 'high', 'university'];
    const groups = {};
    for (const s of qaSubjects) {
      const lvl = s.education_level || 'junior';
      if (!groups[lvl]) groups[lvl] = [];
      groups[lvl].push(s);
    }
    const levelsPresent = LEVEL_ORDER.filter(l => groups[l]);
    let optHtml = '<option value="">全科</option>';
    if (levelsPresent.length > 1) {
      optHtml += levelsPresent.map(lvl => `
        <optgroup label="${LEVEL_NAMES[lvl] || lvl}">
          ${groups[lvl].map(s => `<option value="${esc(s.id)}">${esc(s.icon || '')} ${esc(s.name)}</option>`).join('')}
        </optgroup>
      `).join('');
    } else {
      optHtml += qaSubjects.map(s => `<option value="${esc(s.id)}">${esc(s.icon || '')} ${esc(s.name)}</option>`).join('');
    }
    sel.innerHTML = optHtml;
  } catch (e) {
    // 加载学科失败不影响答疑功能
  }
}

async function loadQaHistory() {
  const container = document.getElementById('qaHistoryList');
  try {
    const { list } = await request('/edu/tutoring/chat/history?type=qa&page=1&page_size=20');
    if (!list || list.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:20px 0;color:var(--text-muted);font-size:12px;">暂无历史会话</div>';
      return;
    }
    container.innerHTML = list.map(s => `
      <div class="tut-history-item ${s.id === qaSessionId ? 'active' : ''}"
           onclick="loadQaSession('${esc(s.id)}')">
        <div class="tut-history-item-title">${esc(s.title || '未命名会话')}</div>
        <div class="tut-history-item-meta">${s.message_count}条消息 · ${new Date(s.updated_at).toLocaleDateString('zh-CN')}</div>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px;">加载失败</div>';
  }
}

async function newQaSession() {
  const subjectId = document.getElementById('qaSubjectSelect').value || undefined;
  try {
    const { session_id } = await request('/edu/tutoring/chat/start', {
      method: 'POST',
      body: JSON.stringify({ subject_id: subjectId || null })
    });
    qaSessionId = session_id;
    document.getElementById('qaChatMessages').innerHTML = `
      <div class="tut-chat-empty">
        <div class="tut-empty-icon">💬</div>
        <div>新会话已创建，请开始提问！</div>
      </div>`;
    document.getElementById('qaSessionTitle').textContent = '新会话';
    await loadQaHistory();
  } catch (e) {
    showToast('创建会话失败');
  }
}

async function loadQaSession(sessionId) {
  qaSessionId = sessionId;
  // 更新历史列表高亮
  document.querySelectorAll('.tut-history-item').forEach(el => {
    el.classList.toggle('active', el.onclick.toString().includes(sessionId));
  });
  try {
    const { messages } = await request(`/edu/tutoring/chat/${sessionId}/messages`);
    renderQaMessages(messages || []);
    const first = (messages || []).find(m => m.role === 'user');
    document.getElementById('qaSessionTitle').textContent =
      first ? (first.content.slice(0, 20) + (first.content.length > 20 ? '…' : '')) : '会话记录';
  } catch (e) {
    showToast('加载会话失败');
  }
}

function renderQaMessages(messages) {
  const container = document.getElementById('qaChatMessages');
  if (!messages || messages.length === 0) {
    container.innerHTML = `<div class="tut-chat-empty"><div class="tut-empty-icon">💬</div><div>会话为空，发消息开始对话</div></div>`;
    return;
  }
  container.innerHTML = messages.map(m => renderMsgBubble(m.role, m.content)).join('');
  container.scrollTop = container.scrollHeight;
}

function renderMsgBubble(role, content) {
  const isUser  = role === 'user';
  const avatar  = isUser ? '👤' : '🤖';
  return `
    <div class="tut-msg ${isUser ? 'tut-msg-user' : 'tut-msg-ai'}">
      <div class="tut-msg-avatar">${avatar}</div>
      <div class="tut-msg-bubble">${esc(content)}</div>
    </div>`;
}

function appendMsg(role, content) {
  const container = document.getElementById('qaChatMessages');
  // 移除空态
  const empty = container.querySelector('.tut-chat-empty');
  if (empty) empty.remove();
  const div = document.createElement('div');
  div.innerHTML = renderMsgBubble(role, content);
  container.appendChild(div.firstElementChild);
  container.scrollTop = container.scrollHeight;
}

function appendThinking() {
  const container = document.getElementById('qaChatMessages');
  const div = document.createElement('div');
  div.className = 'tut-msg tut-msg-ai';
  div.id = 'thinkingBubble';
  div.innerHTML = `
    <div class="tut-msg-avatar">🤖</div>
    <div class="tut-msg-thinking">
      <span class="tut-dot"></span>
      <span class="tut-dot"></span>
      <span class="tut-dot"></span>
    </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeThinking() {
  const el = document.getElementById('thinkingBubble');
  if (el) el.remove();
}

function onQaInputKeydown(e) {
  // Ctrl+Enter 发送
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendQaMessage();
  }
}

async function onQaSubjectChange() {
  // 学科切换时，自动创建新会话（绑定学科）
  qaSessionId = null;
  document.getElementById('qaChatMessages').innerHTML = `
    <div class="tut-chat-empty">
      <div class="tut-empty-icon">💬</div>
      <div>学科已切换，发消息自动创建新会话</div>
    </div>`;
}

async function sendQaMessage() {
  const input = document.getElementById('qaInput');
  const content = input.value.trim();
  if (!content) return;

  const btn = document.getElementById('qaSendBtn');
  btn.disabled = true;
  input.value = '';

  // 若没有会话，先创建
  if (!qaSessionId) {
    try {
      const subjectId = document.getElementById('qaSubjectSelect').value || null;
      const { session_id } = await request('/edu/tutoring/chat/start', {
        method: 'POST',
        body: JSON.stringify({ subject_id: subjectId })
      });
      qaSessionId = session_id;
    } catch (e) {
      showToast('创建会话失败');
      btn.disabled = false;
      input.value = content;
      return;
    }
  }

  appendMsg('user', content);
  appendThinking();

  try {
    const { reply } = await request(`/edu/tutoring/chat/${qaSessionId}`, {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    removeThinking();
    appendMsg('assistant', reply);
    await loadQaHistory(); // 更新历史列表（标题）
  } catch (e) {
    removeThinking();
    appendMsg('assistant', '抱歉，回复失败，请稍后再试。');
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

// ══════════════════════════════════════════════════════════════
// Tab2 — 主观题批改
// ══════════════════════════════════════════════════════════════

async function submitGrade() {
  const question = document.getElementById('gradeQuestion').value.trim();
  const answer   = document.getElementById('gradeAnswer').value.trim();
  const type     = document.getElementById('gradeType').value;
  const maxScore = parseInt(document.getElementById('gradeMaxScore').value) || 10;

  if (!question) { showToast('请输入题目内容'); return; }
  if (!answer)   { showToast('请输入学生答案'); return; }

  const btn = document.getElementById('gradeSubmitBtn');
  btn.disabled = true;
  btn.textContent = '⏳ AI 批改中...';
  document.getElementById('gradeResult').innerHTML = `
    <div class="tut-grade-empty"><div style="font-size:36px;margin-bottom:8px;">⏳</div><div>AI 正在批改，请稍候...</div></div>`;

  try {
    const result = await request('/edu/tutoring/grade', {
      method: 'POST',
      body: JSON.stringify({
        question_content: question,
        question_type:    type,
        user_answer:      answer,
        max_score:        maxScore
      })
    });
    renderGradeResult(result);
  } catch (e) {
    document.getElementById('gradeResult').innerHTML = `
      <div class="tut-grade-empty">批改失败：${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 AI 批改';
  }
}

function renderGradeResult(result) {
  const { score, max_score, feedback, suggestions, error_points } = result;
  const pct  = Math.round((score / max_score) * 100);
  const color = pct >= 80 ? '#10b981' : pct >= 60 ? '#f59e0b' : '#ef4444';
  // SVG 圆环
  const r = 40, cx = 50, cy = 50;
  const circumference = 2 * Math.PI * r;
  const dashoffset = circumference * (1 - pct / 100);

  const errorHtml = Array.isArray(error_points) && error_points.length > 0
    ? `<div class="tut-grade-section">
         <div class="tut-grade-section-title">❌ 错误点</div>
         <div>${error_points.map(e => `<span class="tut-error-tag">${esc(e)}</span>`).join('')}</div>
       </div>`
    : '';

  document.getElementById('gradeResult').innerHTML = `
    <div class="tut-score-ring-wrap">
      <div class="tut-score-ring">
        <svg width="100" height="100" viewBox="0 0 100 100">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="10"/>
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${dashoffset}"
            stroke-linecap="round"/>
        </svg>
        <div class="tut-score-ring-text">
          <span class="tut-score-num" style="color:${color};">${score}</span>
          <span class="tut-score-max">/${max_score}</span>
        </div>
      </div>
    </div>
    <div class="tut-grade-section">
      <div class="tut-grade-section-title">📝 总体评语</div>
      <div class="tut-grade-section-body">${esc(feedback)}</div>
    </div>
    <div class="tut-grade-section">
      <div class="tut-grade-section-title">💡 改进建议</div>
      <div class="tut-grade-section-body">${esc(suggestions)}</div>
    </div>
    ${errorHtml}`;
}

// ══════════════════════════════════════════════════════════════
// Tab3 — 口语评测
// ══════════════════════════════════════════════════════════════

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('speechUnsupported').style.display = 'block';
    document.getElementById('recordBtn').disabled = true;
    return;
  }
  speechRecognizer = new SpeechRecognition();
  speechRecognizer.continuous    = true;
  speechRecognizer.interimResults = true;
  speechRecognizer.lang           = 'zh-CN'; // 默认中文，可根据学科切换

  speechRecognizer.onresult = (e) => {
    let transcript = '';
    for (let i = 0; i < e.results.length; i++) {
      transcript += e.results[i][0].transcript;
    }
    document.getElementById('oralTranscript').textContent = transcript;
  };

  speechRecognizer.onerror = (e) => {
    stopRecording();
    if (e.error === 'not-allowed') {
      showToast('麦克风权限被拒绝，请在浏览器设置中允许访问');
    }
  };

  speechRecognizer.onend = () => {
    if (isRecording) stopRecording();
  };
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startRecording() {
  if (!speechRecognizer) return;
  isRecording = true;
  document.getElementById('recordBtn').textContent = '⏹️';
  document.getElementById('recordBtn').classList.add('recording');
  document.getElementById('recordStatus').textContent = '正在录音，请朗读原文...';
  document.getElementById('oralTranscript').textContent = '';
  speechRecognizer.start();
}

function stopRecording() {
  isRecording = false;
  if (speechRecognizer) {
    try { speechRecognizer.stop(); } catch (e) { /* 忽略 */ }
  }
  document.getElementById('recordBtn').textContent = '🎙️';
  document.getElementById('recordBtn').classList.remove('recording');
  document.getElementById('recordStatus').textContent = '录音已停止，可提交评测';
}

async function submitOralEval() {
  const originalText   = document.getElementById('oralOriginal').value.trim();
  const transcribedEl  = document.getElementById('oralTranscript');
  const transcribedText = (transcribedEl.textContent || transcribedEl.innerText || '').trim();

  if (!originalText)    { showToast('请输入朗读原文'); return; }
  if (!transcribedText) { showToast('请先录音或手动输入转录内容'); return; }

  const btn = document.getElementById('oralEvalBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 评测中...';
  document.getElementById('oralResult').innerHTML = `
    <div class="tut-oral-empty"><div style="font-size:36px;margin-bottom:8px;">⏳</div><div>AI 正在评测，请稍候...</div></div>`;

  try {
    const result = await request('/edu/tutoring/oral/evaluate', {
      method: 'POST',
      body: JSON.stringify({
        original_text:    originalText,
        transcribed_text: transcribedText
      })
    });
    renderOralResult(result);
  } catch (e) {
    document.getElementById('oralResult').innerHTML = `
      <div class="tut-oral-empty">评测失败：${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '📊 提交评测';
  }
}

function renderOralResult(result) {
  const { accuracy_score, fluency_score, completeness_score, overall_score, ai_feedback } = result;

  document.getElementById('oralResult').innerHTML = `
    <div class="tut-overall-score">
      <div class="tut-overall-num">${overall_score}</div>
      <div class="tut-overall-label">综合得分（满分100）</div>
    </div>
    <div class="tut-oral-scores">
      ${renderOralScoreRow('准确度', accuracy_score)}
      ${renderOralScoreRow('流利度', fluency_score)}
      ${renderOralScoreRow('完整度', completeness_score)}
    </div>
    <div class="tut-oral-feedback">${esc(ai_feedback)}</div>`;
}

function renderOralScoreRow(label, score) {
  return `
    <div class="tut-oral-score-row">
      <span class="tut-oral-score-label">${label}</span>
      <div class="tut-oral-bar-track">
        <div class="tut-oral-bar-fill" style="width:${score}%"></div>
      </div>
      <span class="tut-oral-score-val">${score}</span>
    </div>`;
}

// ══════════════════════════════════════════════════════════════
// Tab4 — 虚拟实验
// ══════════════════════════════════════════════════════════════

async function loadExperiments() {
  try {
    const { list } = await request('/edu/tutoring/experiments');
    experiments = list || [];
    renderExpSelector();
  } catch (e) {
    document.getElementById('expSelector').innerHTML =
      '<div style="color:var(--text-muted);font-size:13px;">加载实验列表失败</div>';
  }
}

function renderExpSelector() {
  const container = document.getElementById('expSelector');
  if (!experiments || experiments.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无可用实验</div>';
    return;
  }
  container.innerHTML = experiments.map(exp => `
    <div class="tut-exp-card ${exp.id === currentExpId ? 'active' : ''}" id="expCard-${esc(exp.id)}">
      <div class="tut-exp-subject">${esc(exp.subject)}</div>
      <div class="tut-exp-name">${esc(exp.name)}</div>
      <div class="tut-exp-goal">${esc(exp.goal)}</div>
      <button class="tut-exp-start-btn" onclick="startExperiment('${esc(exp.id)}')">开始实验</button>
    </div>
  `).join('');
}

async function startExperiment(expId) {
  currentExpId = expId;
  renderExpSelector(); // 更新高亮

  const expSendBtn = document.getElementById('expSendBtn');
  const expInput   = document.getElementById('expInput');
  if (expSendBtn) expSendBtn.disabled = true;

  try {
    const result = await request('/edu/tutoring/experiment/start', {
      method: 'POST',
      body: JSON.stringify({ experiment_id: expId })
    });
    expSessionId = result.session_id;
    const exp    = result.experiment || {};

    document.getElementById('expChatTitle').textContent = `🔬 ${exp.name || '虚拟实验'}`;

    // 隐藏引导空态，显示"重新选择"按钮
    const guide = document.getElementById('expChatGuide');
    if (guide) guide.style.display = 'none';
    const resetBtn = document.getElementById('expResetBtn');
    if (resetBtn) resetBtn.style.display = '';

    // 启用输入框
    if (expInput) {
      expInput.disabled = false;
      expInput.style.opacity = '';
      expInput.style.cursor = '';
      expInput.placeholder = '向 AI 提问操作规范、现象原理...';
    }

    const messages = document.getElementById('expChatMessages');
    messages.innerHTML = renderMsgBubble('assistant', result.intro_message || `实验【${exp.name}】已开始，请开始提问！`);
    messages.scrollTop = messages.scrollHeight;
  } catch (e) {
    showToast('启动实验失败：' + e.message);
  } finally {
    if (expSendBtn) {
      expSendBtn.disabled = false;
      expSendBtn.style.opacity = '';
    }
  }
}

function resetExpChat() {
  currentExpId = null;
  expSessionId = null;
  renderExpSelector();

  // 恢复引导空态
  document.getElementById('expChatTitle').textContent = '🔬 实验指导对话';
  const messages = document.getElementById('expChatMessages');
  messages.innerHTML = `
    <div class="tut-chat-empty" id="expChatGuide">
      <div class="tut-empty-icon">🔬</div>
      <div style="font-weight:600;margin-bottom:6px;">从上方选择一个实验，即可开始与 AI 对话</div>
      <div style="font-size:12px;color:var(--text-muted);">AI 将引导你完成实验步骤，解答原理和现象</div>
    </div>`;

  // 禁用输入框
  const expInput = document.getElementById('expInput');
  if (expInput) {
    expInput.disabled = true;
    expInput.style.opacity = '0.5';
    expInput.style.cursor = 'not-allowed';
    expInput.placeholder = '⬆️ 请先从上方选择一个实验...';
    expInput.value = '';
  }
  const expSendBtn = document.getElementById('expSendBtn');
  if (expSendBtn) {
    expSendBtn.disabled = true;
    expSendBtn.style.opacity = '0.5';
  }

  // 隐藏"重新选择"按钮
  const resetBtn = document.getElementById('expResetBtn');
  if (resetBtn) resetBtn.style.display = 'none';
}

function onExpInputKeydown(e) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendExpMessage();
  }
}

async function sendExpMessage() {
  if (!expSessionId || !currentExpId) {
    showToast('请先选择并启动一个实验');
    return;
  }
  const input   = document.getElementById('expInput');
  const content = input.value.trim();
  if (!content) return;

  const btn = document.getElementById('expSendBtn');
  btn.disabled = true;
  input.value = '';

  const messages = document.getElementById('expChatMessages');
  messages.innerHTML += renderMsgBubble('user', content);
  // 添加思考中动画
  const thinkDiv = document.createElement('div');
  thinkDiv.id = 'expThinking';
  thinkDiv.innerHTML = `
    <div class="tut-msg tut-msg-ai">
      <div class="tut-msg-avatar">🔬</div>
      <div class="tut-msg-thinking">
        <span class="tut-dot"></span><span class="tut-dot"></span><span class="tut-dot"></span>
      </div>
    </div>`;
  messages.appendChild(thinkDiv);
  messages.scrollTop = messages.scrollHeight;

  try {
    const { reply } = await request(`/edu/tutoring/experiment/chat/${expSessionId}`, {
      method: 'POST',
      body: JSON.stringify({ content, experiment_id: currentExpId })
    });
    const thinking = document.getElementById('expThinking');
    if (thinking) thinking.remove();
    messages.innerHTML += renderMsgBubble('assistant', reply);
    messages.scrollTop = messages.scrollHeight;
  } catch (e) {
    const thinking = document.getElementById('expThinking');
    if (thinking) thinking.remove();
    messages.innerHTML += renderMsgBubble('assistant', '实验指导服务暂时不可用，请稍后再试。');
  } finally {
    btn.disabled = false;
    input.focus();
  }
}
