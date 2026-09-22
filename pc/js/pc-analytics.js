/**
 * 学情智能分析页面逻辑 - pc-analytics.js
 * 功能：实时学情看板、折线图、热力图、预警干预
 */

'use strict';

// ─── 全局状态 ───
let currentSubjectId = null;
let currentLevel     = null;
let subjects         = [];

const MASTERY_COLORS  = ['#94a3b8', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'];
const MASTERY_LABELS  = ['未学', '了解', '理解', '应用', '精通'];

// ──────────────────────────────────────────────────────────────
// 页面初始化
// ──────────────────────────────────────────────────────────────
async function pageInit() {
  renderPCTopbar('学情分析');
  await loadSubjects();
}

// ──────────────────────────────────────────────────────────────
// 学科 Tabs
// ──────────────────────────────────────────────────────────────
async function loadSubjects() {
  const container = document.getElementById('subjectTabs');
  try {
    const data = await request('/edu/subjects');
    subjects = Array.isArray(data) ? data : (data.list || []);
    if (subjects.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无学科数据</div>';
      return;
    }

    container.innerHTML = renderGroupedSubjectTabs(subjects, currentSubjectId, 'an-tab-btn', 'switchSubject', currentLevel);

    // 默认加载第一个学科的数据
    if (!currentSubjectId && subjects.length > 0) {
      await switchSubject(subjects[0].id);
    }
  } catch (e) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">加载学科失败</div>';
  }
}

async function switchSubject(subjectId) {
  currentSubjectId = subjectId;
  const found = subjects.find(s => String(s.id) === String(subjectId));
  if (found) currentLevel = found.education_level;
  // 重新渲染 tabs（含学段+学科高亮）
  const container = document.getElementById('subjectTabs');
  container.innerHTML = renderGroupedSubjectTabs(subjects, currentSubjectId, 'an-tab-btn', 'switchSubject', currentLevel);
  // 并行加载该学科数据
  await Promise.all([
    loadDashboard(subjectId),
    loadDailyTrend(subjectId),
    loadSessionTrend(subjectId),
    loadHeatmap(subjectId)
  ]);
}

async function switchSubject__level(level) {
  currentLevel = level;
  const first = subjects.find(s => s.education_level === level);
  if (first) {
    await switchSubject(first.id);
  } else {
    const container = document.getElementById('subjectTabs');
    container.innerHTML = renderGroupedSubjectTabs(subjects, currentSubjectId, 'an-tab-btn', 'switchSubject', currentLevel);
  }
}

// ──────────────────────────────────────────────────────────────
// ① 统计看板
// ──────────────────────────────────────────────────────────────
async function loadDashboard(subjectId) {
  const container = document.getElementById('statCards');
  try {
    const d = await request(`/edu/analytics/dashboard/${subjectId}`);
    const trendHtml = d.progress === null
      ? '<span class="an-stat-trend none">暂无对比数据</span>'
      : d.progress > 0
        ? `<span class="an-stat-trend up">▲ ${d.progress} 较上次</span>`
        : d.progress < 0
          ? `<span class="an-stat-trend down">▼ ${Math.abs(d.progress)} 较上次</span>`
          : '<span class="an-stat-trend none">持平</span>';

    container.innerHTML = `
      <div class="an-stat-card">
        <div class="an-stat-label">总评测次数</div>
        <div class="an-stat-num primary">${d.session_count}</div>
        <div class="an-stat-trend none">次</div>
      </div>
      <div class="an-stat-card">
        <div class="an-stat-label">平均评测得分</div>
        <div class="an-stat-num">${d.avg_score !== null ? d.avg_score : '--'}</div>
        ${trendHtml}
      </div>
      <div class="an-stat-card">
        <div class="an-stat-label">已评测知识点</div>
        <div class="an-stat-num">${d.assessed_count}</div>
        <div class="an-stat-trend none">平均掌握 ${d.avg_mastery !== null ? d.avg_mastery : '--'} 分</div>
      </div>
      <div class="an-stat-card">
        <div class="an-stat-label">待攻克错题</div>
        <div class="an-stat-num ${d.wrong_count > 0 ? 'primary' : ''}">${d.wrong_count}</div>
        <div class="an-stat-trend none">道</div>
      </div>
    `;
  } catch (e) {
    container.innerHTML = '<div class="an-stat-card"><div class="an-stat-label">加载失败</div></div>';
  }
}

// ──────────────────────────────────────────────────────────────
// ② 折线图
// ──────────────────────────────────────────────────────────────
async function loadDailyTrend(subjectId) {
  try {
    const { data } = await request(`/edu/analytics/trend/daily/${subjectId}`);
    drawLineChart('dailyTrendChart', data, '#3b82f6', '%');
  } catch (e) {
    clearCanvas('dailyTrendChart', '加载失败');
  }
}

async function loadSessionTrend(subjectId) {
  try {
    const { data } = await request(`/edu/analytics/trend/sessions/${subjectId}`);
    drawLineChart('sessionTrendChart', data, '#10b981', '分');
  } catch (e) {
    clearCanvas('sessionTrendChart', '加载失败');
  }
}

// drawLineChart 已移至 pc-common.js，此处不再重复定义

function clearCanvas(canvasId, msg) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(msg || '无数据', canvas.width / 2, canvas.height / 2);
}

// ──────────────────────────────────────────────────────────────
// ③ 知识点热力图
// ──────────────────────────────────────────────────────────────
async function loadHeatmap(subjectId) {
  const container = document.getElementById('heatmapGrid');
  try {
    const { list } = await request(`/edu/analytics/heatmap/${subjectId}`);
    if (!list || list.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">完成评测后生成热力图</div>';
      return;
    }
    container.innerHTML = list.map(node => {
      const level = node.mastery_level || 0;
      const color = MASTERY_COLORS[level];
      const score = node.mastery_score ? parseFloat(node.mastery_score).toFixed(0) : '0';
      return `<div class="an-heatmap-node"
                   style="background:${color}22;color:${color};border:1px solid ${color}66;"
                   title="${esc(node.knowledge_name)} · ${MASTERY_LABELS[level]} ${score}分">
                ${esc(node.knowledge_name)}
              </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">加载失败</div>';
  }
}

// ──────────────────────────────────────────────────────────────
// ④ 预警检测
// ──────────────────────────────────────────────────────────────
async function runAlertCheck() {
  const alertArea = document.getElementById('alertArea');
  alertArea.innerHTML = '<div class="an-alert-empty">🔍 检测中，请稍候...</div>';

  try {
    const body = currentSubjectId ? JSON.stringify({ subject_id: currentSubjectId }) : '{}';
    const result = await request('/edu/analytics/alert/check', {
      method: 'POST',
      body
    });

    if (!result.alerts_sent || result.alerts_sent.length === 0) {
      alertArea.innerHTML = '<div class="an-alert-empty">✅ 学习状态良好，暂无预警</div>';
      document.getElementById('remedySection').style.display = 'none';
      return;
    }

    const alertDefs = {
      stagnation:   { icon: '😴', title: '学习停滞提醒', msg: '你已连续7天未进行练习，建议今日开始学习！', cls: '' },
      decline:      { icon: '📉', title: '成绩下滑预警', msg: '最近3次评测成绩连续下降，建议回顾薄弱知识点。', cls: 'danger' },
      low_accuracy: { icon: '❓', title: '正确率偏低预警', msg: '近期答题正确率较低，建议放慢节奏，重点复习基础知识。', cls: 'danger' }
    };

    alertArea.innerHTML = result.alerts_sent.map(type => {
      const def = alertDefs[type] || { icon: '⚠️', title: type, msg: '', cls: '' };
      return `
        <div class="an-alert-card ${def.cls}">
          <div class="an-alert-icon">${def.icon}</div>
          <div class="an-alert-body">
            <div class="an-alert-title">${def.title}</div>
            <div class="an-alert-msg">${def.msg}</div>
          </div>
        </div>`;
    }).join('');

    // 显示补救练习包
    if (currentSubjectId) {
      document.getElementById('remedySection').style.display = 'block';
      await loadRemedyQuestions(currentSubjectId);
    }
  } catch (e) {
    alertArea.innerHTML = '<div class="an-alert-empty">检测失败，请稍后重试</div>';
  }
}

async function loadRemedyQuestions(subjectId) {
  const listEl = document.getElementById('remedyList');
  try {
    const { questions } = await request(`/edu/analytics/alert/remedy/${subjectId}`);
    if (!questions || questions.length === 0) {
      listEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;">暂无补救练习题</div>';
      return;
    }
    listEl.innerHTML = `<div class="an-remedy-list">${questions.map(q => `
      <div class="an-remedy-item">
        <div class="an-remedy-knowledge">${esc(q.knowledge_name || '')}</div>
        <div class="an-remedy-content">${esc(q.content)}</div>
      </div>`).join('')}</div>`;
  } catch (e) {
    listEl.innerHTML = '<div style="padding:12px;color:var(--text-muted);">加载失败</div>';
  }
}

function toggleRemedy() {
  const listEl = document.getElementById('remedyList');
  const iconEl = document.getElementById('remedyToggleIcon');
  const hidden = listEl.style.display === 'none';
  listEl.style.display = hidden ? 'block' : 'none';
  iconEl.textContent = hidden ? '▲' : '▼';
}
