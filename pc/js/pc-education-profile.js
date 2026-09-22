/**
 * 能力画像页面逻辑 - pc-education-profile.js
 * 展示知识点热力图、掌握度统计、薄弱知识点列表
 */

const MASTERY_COLORS = ['#94a3b8', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'];
const MASTERY_LABELS = ['未学', '了解', '理解', '应用', '精通'];

let currentSubjectId = null;
let currentLevel = null;   // 当前激活学段
let allSubjects = [];

async function pageInit() {
  renderPCTopbar('能力画像');
  await loadSubjectsAndProfile();
}

// 加载学科列表并渲染标签
async function loadSubjectsAndProfile() {
  try {
    allSubjects = await request('/edu/subjects');
    if (!allSubjects || allSubjects.length === 0) {
      document.getElementById('subjectTabs').innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无学科数据</div>';
      return;
    }

    // 渲染学科标签
    renderSubjectTabs(allSubjects[0].id);
    // 加载第一个学科的热力图
    await loadHeatmap(allSubjects[0].id);
  } catch (e) {
    document.getElementById('subjectTabs').innerHTML = '<div style="color:var(--danger);">加载失败</div>';
  }
}

// 渲染学科切换标签
function renderSubjectTabs(activeId) {
  currentSubjectId = activeId;
  const container = document.getElementById('subjectTabs');
  container.innerHTML = renderGroupedSubjectTabs(allSubjects, activeId, 'edu-tab-btn', 'switchSubject', currentLevel);
}

// 学段切换（只切换学段 Tab，自动选该学段第一个学科）
async function switchSubject__level(level) {
  currentLevel = level;
  const first = allSubjects.find(s => s.education_level === level);
  if (first) {
    await switchSubject(first.id);
  } else {
    renderSubjectTabs(currentSubjectId);
  }
}

// 切换学科
async function switchSubject(subjectId) {
  const found = allSubjects.find(s => String(s.id) === String(subjectId));
  if (found) currentLevel = found.education_level;
  renderSubjectTabs(subjectId);
  await loadHeatmap(subjectId);
}

// 加载热力图数据
async function loadHeatmap(subjectId) {
  currentSubjectId = subjectId;
  const container = document.getElementById('heatmapContainer');
  container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">⏳</div><div class="pc-empty-text">加载中...</div></div>';

  try {
    const nodes = await request(`/edu/profile/heatmap/${subjectId}`);

    // 更新统计卡片
    updateMasteryStats(nodes);

    // 更新薄弱知识点列表
    updateWeakList(nodes);

    if (nodes.length === 0) {
      container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">📚</div><div class="pc-empty-text">该学科暂无知识点数据</div></div>';
      return;
    }

    // 渲染热力图
    renderHeatmap(nodes, container);
  } catch (e) {
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-text">加载失败，请刷新重试</div></div>';
  }
}

// 更新掌握度统计卡片
function updateMasteryStats(nodes) {
  // 只统计叶子节点（level=3 的知识点）
  const leafNodes = nodes.filter(n => n.level === 3);
  const counts = [0, 0, 0, 0, 0];
  for (const n of leafNodes) {
    const level = n.mastery_level || 0;
    counts[level] = (counts[level] || 0) + 1;
  }
  for (let i = 0; i <= 4; i++) {
    const el = document.getElementById(`countLevel${i}`);
    if (el) el.textContent = counts[i];
  }
}

// 更新薄弱知识点列表
function updateWeakList(nodes) {
  const container = document.getElementById('weakKnowledgeList');
  const weak = nodes
    .filter(n => n.level === 3 && n.total_attempts > 0 && n.mastery_score < 60)
    .sort((a, b) => a.mastery_score - b.mastery_score)
    .slice(0, 10);

  if (weak.length === 0) {
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-icon">✨</div><div class="pc-empty-text">完成评测后显示薄弱知识点</div></div>';
    return;
  }

  container.innerHTML = weak.map(n => {
    const color = MASTERY_COLORS[n.mastery_level] || '#94a3b8';
    return `
      <div class="edu-weak-item">
        <div style="flex:1;">
          <div style="font-size:13px;font-weight:600;">${esc(n.name)}</div>
          <div style="font-size:11px;color:var(--text-muted);">
            ${n.accuracy_rate !== null ? '正确率 ' + n.accuracy_rate + '%' : '未评测'} ·
            作答${n.total_attempts}次
          </div>
        </div>
        <span class="edu-mastery-badge" style="background:${color}20;color:${color};">
          ${MASTERY_LABELS[n.mastery_level]}
        </span>
      </div>
    `;
  }).join('');
}

// 渲染树形热力图
function renderHeatmap(nodes, container) {
  // 构建树形结构
  const map = {};
  for (const n of nodes) map[n.id] = { ...n, children: [] };
  const roots = [];
  for (const n of nodes) {
    if (n.parent_id && map[n.parent_id]) {
      map[n.parent_id].children.push(map[n.id]);
    } else {
      roots.push(map[n.id]);
    }
  }

  container.innerHTML = roots.map(chapter => renderChapterNode(chapter)).join('');
}

// 渲染章节节点
function renderChapterNode(chapter) {
  const sectionHtml = chapter.children.map(section => renderSectionNode(section)).join('');
  return `
    <div class="heatmap-chapter">
      <div class="heatmap-chapter-title">${esc(chapter.name)}</div>
      <div class="heatmap-sections">${sectionHtml}</div>
    </div>
  `;
}

// 渲染小节节点
function renderSectionNode(section) {
  const knHtml = section.children.map(kn => renderKnowledgeNode(kn)).join('');
  return `
    <div class="heatmap-section">
      <div class="heatmap-section-title">${esc(section.name)}</div>
      <div class="heatmap-nodes">${knHtml}</div>
    </div>
  `;
}

// 渲染知识点节点（热力格）
function renderKnowledgeNode(kn) {
  const color = MASTERY_COLORS[kn.mastery_level] || '#94a3b8';
  const opacity = kn.total_attempts === 0 ? 0.2 : 0.2 + (kn.mastery_score / 100) * 0.8;
  const bgColor = hexToRgba(color, opacity);
  const label = MASTERY_LABELS[kn.mastery_level];
  const tooltip = kn.total_attempts > 0
    ? `${kn.name}\n${label}（${kn.mastery_score.toFixed(0)}分）\n正确率：${kn.accuracy_rate !== null ? kn.accuracy_rate + '%' : '--'}`
    : `${kn.name}\n尚未评测`;

  return `
    <div class="heatmap-node" style="background:${bgColor};border-color:${color};" title="${esc(tooltip)}">
      <div class="heatmap-node-name">${esc(kn.name)}</div>
      <div class="heatmap-node-label" style="color:${color};">${kn.total_attempts > 0 ? label : '未测'}</div>
    </div>
  `;
}

// 颜色转rgba辅助
function hexToRgba(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity.toFixed(2)})`;
}
