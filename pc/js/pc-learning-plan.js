/**
 * 今日学习计划页面逻辑 - pc-learning-plan.js
 */

'use strict';

let currentSubjectId = null;
let currentLevel = null;   // 当前激活学段
let subjects = [];
let currentPlan = null;

// ──────────────────────────────────────────────────────────────
// 页面初始化
// ──────────────────────────────────────────────────────────────
async function pageInit() {
  renderPCTopbar('今日学习计划');

  // 从 URL 参数读取 subject_id
  const params = new URLSearchParams(location.search);
  const urlSubject = params.get('subject');

  await loadSubjects(urlSubject);
}

async function loadSubjects(preferSubjectId) {
  try {
    const data = await request('/edu/subjects');
    subjects = Array.isArray(data) ? data : (data.list || []);
    if (subjects.length === 0) {
      document.getElementById('subjectTabs').innerHTML =
        '<span style="color:var(--text-muted);font-size:13px;">暂无学科数据</span>';
      return;
    }
    renderSubjectTabs();
    const firstId = preferSubjectId || subjects[0].id;
    await switchSubject(firstId);
  } catch (e) {
    document.getElementById('subjectTabs').innerHTML =
      `<span style="color:var(--danger);font-size:13px;">加载失败：${esc(e.message)}</span>`;
  }
}

function renderSubjectTabs() {
  const container = document.getElementById('subjectTabs');
  container.innerHTML = renderGroupedSubjectTabs(subjects, currentSubjectId, 'lp-tab-btn', 'switchSubject', currentLevel);
}

// 学段切换（只切换学段 Tab，自动选该学段第一个学科）
async function switchSubject__level(level) {
  currentLevel = level;
  // 找该学段第一个学科
  const first = subjects.find(s => s.education_level === level);
  if (first) {
    await switchSubject(first.id);
  } else {
    renderSubjectTabs();
  }
}

async function switchSubject(subjectId) {
  currentSubjectId = subjectId;
  // 同步更新当前学段
  const found = subjects.find(s => String(s.id) === String(subjectId));
  if (found) currentLevel = found.education_level;
  renderSubjectTabs();
  // 并行加载今日计划、知识图谱、推荐题
  await Promise.all([
    loadTodayPlan(subjectId),
    loadKnowledgeGraph(subjectId),
    loadRecommendQuestions(subjectId)
  ]);
}

// ──────────────────────────────────────────────────────────────
// 今日学习计划
// ──────────────────────────────────────────────────────────────
async function loadTodayPlan(subjectId) {
  // 显示加载状态
  document.getElementById('planContent').innerHTML =
    '<div class="lp-plan-loading">⏳ 正在生成个性化学习计划，请稍候...</div>';
  document.getElementById('planActions').style.display = 'none';
  document.getElementById('nodeList').innerHTML =
    '<div class="lp-plan-loading">⏳ 加载中...</div>';

  try {
    const plan = await request(`/edu/learning-engine/today-plan/${subjectId}`);
    currentPlan = plan;
    renderPlanCard(plan);
    renderNodeList(plan.recommended_nodes || []);
  } catch (e) {
    document.getElementById('planContent').innerHTML = `
      <div class="lp-plan-empty">
        <div class="lp-empty-icon">📋</div>
        <div>${esc(e.message || '暂无学习数据，请先完成一次评测')}</div>
        <a href="/pc/assessment.html" class="pc-btn pc-btn-primary" style="margin-top:12px;display:inline-block;">
          去参加评测
        </a>
      </div>`;
    document.getElementById('nodeList').innerHTML =
      '<div class="lp-plan-empty">请先完成评测以获取推荐</div>';
  }
}

function renderPlanCard(plan) {
  const aiText = plan.ai_recommendation_text || '';
  document.getElementById('planContent').innerHTML = aiText
    ? `<div class="lp-ai-text">${esc(aiText)}</div>`
    : `<div class="lp-plan-empty"><div class="lp-empty-icon">📋</div><div>AI建议生成中，请稍后刷新</div></div>`;

  const genAt = plan.generated_at ? new Date(plan.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  document.getElementById('planMeta').textContent = genAt ? `生成于 ${genAt}` : '';
  document.getElementById('cacheTag').textContent = plan.from_cache ? '来自缓存' : '刚刚生成';
  document.getElementById('planActions').style.display = 'flex';
}

async function refreshPlan() {
  const ok = await showConfirm({
    title: '重新生成计划',
    message: '将重新调用 AI 生成今日学习计划，消耗一次 AI 请求，是否继续？',
    okText: '重新生成'
  });
  if (!ok) return;

  const btn = document.getElementById('refreshPlanBtn');
  btn.disabled = true;
  btn.textContent = '⏳ 生成中...';

  try {
    const plan = await request(`/edu/learning-engine/today-plan/${currentSubjectId}/refresh`, {
      method: 'POST'
    });
    currentPlan = plan;
    renderPlanCard(plan);
    renderNodeList(plan.recommended_nodes || []);
    showToast('今日学习计划已更新');
  } catch (e) {
    showToast('生成失败：' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 重新生成';
  }
}

// ──────────────────────────────────────────────────────────────
// 推荐知识点列表
// ──────────────────────────────────────────────────────────────
function renderNodeList(nodes) {
  const container = document.getElementById('nodeList');
  if (!nodes || nodes.length === 0) {
    container.innerHTML = '<div class="lp-plan-empty">暂无推荐知识点，请先完成评测</div>';
    return;
  }

  container.innerHTML = `<div class="lp-node-list">${nodes.map((n, i) => {
    const mastery = Math.round(parseFloat(n.mastery_score) || 0);
    const comp    = Math.round(parseFloat(n.comprehension_score) || 0);
    const mem     = Math.round(parseFloat(n.memory_score) || 0);
    const app     = Math.round(parseFloat(n.application_score) || 0);
    const prioClass = `lp-priority-${Math.min(n.priority || i + 1, 3)}`;
    const prioLabel = ['', '优先', '重要', '建议'][Math.min(n.priority || i + 1, 3)];
    const barClass  = mastery < 30 ? 'low' : mastery < 60 ? 'medium' : 'high';

    return `
      <div class="lp-node-item">
        <div class="lp-node-row1">
          <span class="lp-priority-badge ${prioClass}">${prioLabel}</span>
          <span class="lp-node-name">${esc(n.name)}</span>
          ${!n.prerequisite_met ? '<span class="lp-prereq-warn">⚠️ 前置未满足</span>' : ''}
        </div>
        <div class="lp-mastery-bar">
          <span class="lp-mastery-label">综合掌握度</span>
          <div class="lp-bar-track">
            <div class="lp-bar-fill ${barClass}" style="width:${mastery}%"></div>
          </div>
          <span class="lp-bar-score">${mastery}</span>
        </div>
        <div class="lp-dim-bars">
          <div class="lp-dim-row">
            <span class="lp-dim-label">理解</span>
            <div class="lp-dim-track"><div class="lp-dim-fill comp" style="width:${comp}%"></div></div>
            <span class="lp-dim-score">${comp}</span>
          </div>
          <div class="lp-dim-row">
            <span class="lp-dim-label">记忆</span>
            <div class="lp-dim-track"><div class="lp-dim-fill mem" style="width:${mem}%"></div></div>
            <span class="lp-dim-score">${mem}</span>
          </div>
          <div class="lp-dim-row">
            <span class="lp-dim-label">应用</span>
            <div class="lp-dim-track"><div class="lp-dim-fill app" style="width:${app}%"></div></div>
            <span class="lp-dim-score">${app}</span>
          </div>
        </div>
        ${n.reason ? `<div class="lp-node-reason">${esc(n.reason)}</div>` : ''}
        <div class="lp-node-actions">
          <button class="lp-start-btn"
            onclick="startPractice('${esc(n.knowledge_id)}','${esc(n.name)}')">
            开始练习 →
          </button>
        </div>
      </div>`;
  }).join('')}</div>`;
}

function startPractice(knowledgeId, name) {
  // 跳转到评测页，带上知识点参数
  window.location.href = `/pc/assessment.html?subject=${encodeURIComponent(currentSubjectId)}&knowledge=${encodeURIComponent(knowledgeId)}`;
}

// ──────────────────────────────────────────────────────────────
// 推荐练习题
// ──────────────────────────────────────────────────────────────
async function loadRecommendQuestions(subjectId) {
  const container = document.getElementById('questionList');
  container.innerHTML = '<div class="lp-plan-loading">⏳ 加载推荐题目...</div>';

  try {
    const data = await request(`/edu/learning-engine/recommend-questions/${subjectId}?count=5`);
    renderQuestionList(data.questions || []);
  } catch (e) {
    container.innerHTML = `<div class="lp-plan-empty">加载失败：${esc(e.message)}</div>`;
  }
}

function renderQuestionList(questions) {
  const container = document.getElementById('questionList');
  if (!questions || questions.length === 0) {
    container.innerHTML = '<div class="lp-plan-empty">暂无推荐题目，请先完成更多评测</div>';
    return;
  }

  container.innerHTML = `<div class="lp-question-list">${questions.map((q, i) => {
    const options = Array.isArray(q.options_json) ? q.options_json : [];
    const diffStars = '★'.repeat(q.difficulty || 1) + '☆'.repeat(5 - (q.difficulty || 1));
    const optionHtml = options.map(opt => `
      <div class="lp-option ${opt.key === q.answer ? 'correct' : ''}">
        ${esc(opt.key)}. ${esc(opt.text)}${opt.key === q.answer ? ' ✓' : ''}
      </div>`).join('');

    const answerHtml = options.length > 0
      ? `<div class="lp-answer-row">答案：<span class="lp-answer-val">${esc(q.answer)}</span></div>`
      : `<div class="lp-answer-row">答案：<span class="lp-answer-val">${esc(q.answer)}</span></div>`;

    return `
      <div class="lp-question-item">
        <div class="lp-question-header" onclick="toggleQuestion(this)">
          <div class="lp-question-num">${i + 1}</div>
          <div class="lp-question-content">${esc(q.content)}</div>
          <div class="lp-question-tags">
            <span class="lp-q-tag">${esc(q.knowledge_name || '')}</span>
            <span class="lp-q-tag">${diffStars}</span>
          </div>
          <div class="lp-expand-icon">▼</div>
        </div>
        <div class="lp-question-body">
          ${optionHtml}
          ${answerHtml}
          ${q.analysis ? `<div class="lp-analysis">💡 ${esc(q.analysis)}</div>` : ''}
        </div>
      </div>`;
  }).join('')}</div>`;
}

function toggleQuestion(header) {
  const body = header.nextElementSibling;
  const icon = header.querySelector('.lp-expand-icon');
  if (body.classList.contains('open')) {
    body.classList.remove('open');
    icon.textContent = '▼';
  } else {
    body.classList.add('open');
    icon.textContent = '▲';
  }
}

// ──────────────────────────────────────────────────────────────
// 三维知识图谱
// ──────────────────────────────────────────────────────────────
async function loadKnowledgeGraph(subjectId) {
  try {
    const data = await request(`/edu/learning-engine/knowledge-graph/${subjectId}`);
    const summary = data.summary || {};

    // 更新统计数字
    document.getElementById('statSessionCount').textContent = summary.total_nodes || '--';
    document.getElementById('statAssessedNodes').textContent = summary.assessed_nodes || '--';
    document.getElementById('statAvgMastery').textContent =
      summary.avg_mastery ? parseFloat(summary.avg_mastery).toFixed(0) : '--';

    // 绘制雷达图
    const comp = parseFloat(summary.avg_comprehension) || 0;
    const mem  = parseFloat(summary.avg_memory) || 0;
    const app  = parseFloat(summary.avg_application) || 0;
    drawRadarChart('radarCanvas', { comprehension: comp, memory: mem, application: app });

    // 更新三维进度条
    setDimBar('dimCompFill', 'dimCompVal', comp);
    setDimBar('dimMemFill', 'dimMemVal', mem);
    setDimBar('dimAppFill', 'dimAppVal', app);

    // 雷达图提示
    const weakDim = [
      { label: '理解', val: comp },
      { label: '记忆', val: mem },
      { label: '应用', val: app }
    ].sort((a, b) => a.val - b.val)[0];

    document.getElementById('radarHint').textContent =
      summary.assessed_nodes > 0
        ? `当前最薄弱维度：${weakDim.label}（平均 ${weakDim.val.toFixed(0)}分），建议重点练习相关类型题目。`
        : '完成评测后，这里将展示你在理解、记忆、应用三个维度的学习状态。';
  } catch (e) {
    // 图谱加载失败不阻断页面
  }
}

function setDimBar(fillId, valId, score) {
  document.getElementById(fillId).style.width = Math.min(100, score) + '%';
  document.getElementById(valId).textContent = score.toFixed(0);
}

// ──────────────────────────────────────────────────────────────
// Canvas 原生雷达图绘制（不引入第三方库）
// ──────────────────────────────────────────────────────────────
let _lastRadarData = null; // 缓存最后一次数据，主题切换时重绘

function drawRadarChart(canvasId, data) {
  _lastRadarData = { canvasId, data };
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(cx, cy) - 28;

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const gridColor = isDark ? 'rgba(255,255,255,0.12)' : '#e2e8f0';
  const axisColor = isDark ? 'rgba(255,255,255,0.18)' : '#cbd5e1';

  // 三轴角度（从顶部开始，顺时针120°）
  const axes = ['理解', '记忆', '应用'];
  const colors = ['#3b82f6', '#10b981', '#8b5cf6'];
  const values = [
    (data.comprehension || 0) / 100,
    (data.memory || 0) / 100,
    (data.application || 0) / 100
  ];
  const angles = axes.map((_, i) => (i * 2 * Math.PI / 3) - Math.PI / 2);

  ctx.clearRect(0, 0, W, H);

  // 绘制背景格（4层）
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  for (let r = 0.25; r <= 1; r += 0.25) {
    ctx.beginPath();
    angles.forEach((a, i) => {
      const x = cx + Math.cos(a) * R * r;
      const y = cy + Math.sin(a) * R * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
  }

  // 绘制轴线
  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  angles.forEach(a => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();
  });

  // 绘制数据区域
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = cx + Math.cos(angles[i]) * R * v;
    const y = cy + Math.sin(angles[i]) * R * v;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(102, 126, 234, 0.18)';
  ctx.fill();
  ctx.strokeStyle = '#667eea';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 绘制数据点
  values.forEach((v, i) => {
    const x = cx + Math.cos(angles[i]) * R * v;
    const y = cy + Math.sin(angles[i]) * R * v;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = colors[i];
    ctx.fill();
  });

  // 绘制轴标签
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  axes.forEach((label, i) => {
    const lx = cx + Math.cos(angles[i]) * (R + 18);
    const ly = cy + Math.sin(angles[i]) * (R + 18);
    ctx.fillStyle = colors[i];
    ctx.fillText(`${label} ${Math.round(values[i] * 100)}`, lx, ly);
  });
}

// 主题切换时重绘雷达图
const _origToggleTheme = window.toggleTheme;
window.toggleTheme = function() {
  if (typeof _origToggleTheme === 'function') _origToggleTheme();
  if (_lastRadarData) drawRadarChart(_lastRadarData.canvasId, _lastRadarData.data);
};
