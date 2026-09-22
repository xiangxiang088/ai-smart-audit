/**
 * 智能评测页面逻辑 - pc-assessment.js
 * 支持三个阶段：学科选择 → 答题进行中 → 评测结果
 */

const MASTERY_COLORS = ['#94a3b8', '#f59e0b', '#3b82f6', '#10b981', '#8b5cf6'];
const MASTERY_LABELS = ['未学', '了解', '理解', '应用', '精通'];
const DIFFICULTY_STARS = ['', '⭐', '⭐⭐', '⭐⭐⭐', '⭐⭐⭐⭐', '⭐⭐⭐⭐⭐'];
const TYPE_LABELS = { single: '单选题', multi: '多选题', fill: '填空题', subjective: '主观题' };

// 当前会话状态
let sessionState = {
  sessionId: null,
  subjectId: null,
  currentQuestion: null,
  seqNo: 1,
  total: 15,
  startTime: null,        // 当前题目开始答题时间
  answered: false,        // 当前题目是否已提交
  timerInterval: null,
  cards: []               // 答题卡：[{seq_no, status}] status: current/answered/unanswered
};

async function pageInit() {
  renderPCTopbar('智能评测');

  // 检查URL参数
  const params = new URLSearchParams(location.search);
  const reportId = params.get('report');
  const subjectId = params.get('subject');

  if (reportId) {
    // 直接显示报告
    showStage('result');
    await loadReport(reportId);
  } else {
    // 显示学科选择
    showStage('select');
    await loadSubjects(subjectId);
  }
}

// 切换显示阶段
function showStage(stage) {
  document.getElementById('stageSelect').style.display = stage === 'select' ? '' : 'none';
  document.getElementById('stageQuestion').style.display = stage === 'question' ? '' : 'none';
  document.getElementById('stageResult').style.display = stage === 'result' ? '' : 'none';
}

// 加载学科列表（按学段分组）
async function loadSubjects(preSelectId) {
  const container = document.getElementById('subjectList');
  try {
    const subjects = await request('/edu/subjects');
    if (!subjects || subjects.length === 0) {
      container.innerHTML = '<div class="pc-empty"><div class="pc-empty-text">暂无可用学科，请联系管理员</div></div>';
      return;
    }

    // 按学段分组
    window._subjectsByLevel = {};
    for (const s of subjects) {
      const lvl = s.education_level || 'junior';
      if (!window._subjectsByLevel[lvl]) window._subjectsByLevel[lvl] = [];
      window._subjectsByLevel[lvl].push(s);
    }

    // 确定默认展示学段
    const defaultLevel = 'junior';
    window._currentLevel = defaultLevel;

    renderSubjectCards(defaultLevel, preSelectId);
  } catch (e) {
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-text">加载失败，请刷新重试</div></div>';
  }
}

// 渲染指定学段的学科卡片
function renderSubjectCards(level, preSelectId) {
  const container = document.getElementById('subjectList');
  const subjects = (window._subjectsByLevel || {})[level] || [];

  if (subjects.length === 0) {
    container.innerHTML = '<div class="pc-empty"><div class="pc-empty-text">该学段暂无可用学科</div></div>';
    return;
  }

  container.innerHTML = subjects.map(s => `
    <div class="edu-subject-card ${preSelectId === String(s.id) ? 'selected' : ''}"
         id="subjectCard_${esc(s.id)}"
         onclick="selectSubject('${esc(s.id)}')">
      ${s.cover_image
        ? `<img class="edu-subject-cover" src="${esc(s.cover_image)}" alt="${esc(s.name)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''
      }
      <div class="edu-subject-cover-emoji" style="${s.cover_image ? 'display:none' : ''}">${esc(s.icon || '📚')}</div>
      <div class="edu-subject-card-name">${esc(s.name)}</div>
    </div>
  `).join('');

  if (preSelectId) {
    window._selectedSubjectId = preSelectId;
  }
}

// 切换学段
function switchLevel(level) {
  window._currentLevel = level;
  window._selectedSubjectId = null;

  // 更新 Tab 样式
  document.querySelectorAll('.edu-level-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.level === level);
  });

  renderSubjectCards(level);
}

// 选中学科
function selectSubject(subjectId) {
  window._selectedSubjectId = subjectId;
  document.querySelectorAll('.edu-subject-card').forEach(el => el.classList.remove('selected'));
  const card = document.getElementById(`subjectCard_${subjectId}`);
  if (card) card.classList.add('selected');
}

// 开始评测
async function startAssessment() {
  const subjectId = window._selectedSubjectId;
  if (!subjectId) {
    showToast('请先选择一个学科', 'error');
    return;
  }
  const maxQuestions = parseInt(document.getElementById('questionCount').value, 10) || 15;
  const sessionType = document.getElementById('sessionType').value || 'entry';

  const btn = document.getElementById('startAssessmentBtn');
  try {
    if (btn) { btn.disabled = true; btn.textContent = '启动中...'; }

    const data = await request('/edu/assessment/start', {
      method: 'POST',
      body: JSON.stringify({ subject_id: subjectId, session_type: sessionType, config: { max_questions: maxQuestions } })
    });

    if (!data || !data.session_id) {
      throw new Error('启动评测失败，请重试');
    }
    if (!data.question) {
      throw new Error('该学科暂无可用题目，请管理员先添加题目');
    }

    sessionState.sessionId = data.session_id;
    sessionState.subjectId = subjectId;
    sessionState.total = data.total;
    sessionState.seqNo = data.seq_no;
    sessionState.answered = false;

    showStage('question');
    renderQuestion(data.question, data.seq_no, data.total, data.subject);
    startTimer();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '🚀 开始评测'; }
    if (e && e.message && !e._toastShown) {
      showToast(e.message, 'error');
    }
  }
}

// 渲染题目
function renderQuestion(question, seqNo, total, subject) {
  sessionState.currentQuestion = question;
  sessionState.seqNo = seqNo;
  sessionState.answered = false;
  sessionState.startTime = Date.now();

  // 进度
  document.getElementById('progressText').textContent = `第 ${seqNo} 题 / 共 ${total} 题`;
  if (subject) document.getElementById('subjectLabel').textContent = subject.name || '';
  document.getElementById('progressFill').style.width = `${(seqNo - 1) / total * 100}%`;

  // 题目元信息
  document.getElementById('questionType').textContent = TYPE_LABELS[question.type] || question.type;
  document.getElementById('questionDifficulty').textContent = DIFFICULTY_STARS[question.difficulty] || '⭐⭐⭐';
  document.getElementById('questionDifficulty').className = `edu-badge difficulty-${question.difficulty}`;

  // 题干（使用textContent防XSS，支持换行）
  const contentEl = document.getElementById('questionContent');
  contentEl.textContent = '';
  contentEl.textContent = question.content;

  // 清空解析区
  const analysisArea = document.getElementById('analysisArea');
  analysisArea.style.display = 'none';
  analysisArea.innerHTML = '';

  // 重置按钮区
  document.getElementById('submitBtn').style.display = '';
  document.getElementById('submitBtn').disabled = false;
  document.getElementById('nextBtn').style.display = 'none';
  document.getElementById('finishBtn').style.display = 'none';

  // 清空所有答题区
  document.getElementById('optionsArea').innerHTML = '';
  document.getElementById('optionsArea').style.display = 'none';
  document.getElementById('fillArea').style.display = 'none';
  document.getElementById('fillAnswer').value = '';
  document.getElementById('subjectiveArea').style.display = 'none';
  document.getElementById('subjectiveAnswer').value = '';

  // 渲染答题区
  if (question.type === 'single' || question.type === 'multi') {
    const options = typeof question.options_json === 'string'
      ? JSON.parse(question.options_json)
      : (question.options_json || []);
    document.getElementById('optionsArea').style.display = '';
    document.getElementById('optionsArea').innerHTML = options.map(opt => `
      <div class="assessment-option" id="opt_${esc(opt.key)}" onclick="selectOption('${esc(opt.key)}', '${question.type}')">
        <span class="option-key">${esc(opt.key)}</span>
        <span class="option-text">${esc(opt.text)}</span>
      </div>
    `).join('');
  } else if (question.type === 'fill') {
    document.getElementById('fillArea').style.display = '';
    document.getElementById('fillAnswer').focus();
    document.getElementById('fillAnswer').onkeydown = (e) => {
      if (e.key === 'Enter') submitAnswer();
    };
  } else if (question.type === 'subjective') {
    document.getElementById('subjectiveArea').style.display = '';
    document.getElementById('subjectiveAnswer').focus();
  }

  // 更新答题卡
  ensureCurrentCard(seqNo);

  // 重置并回填收藏星标状态
  const favBtn = document.getElementById('questionFavBtn');
  if (favBtn) {
    favBtn.textContent = '☆';
    favBtn.classList.remove('favorited');
    favBtn.style.color = '';
    favBtn.dataset.questionId = question.id;
    if (question.id) {
      request(`/edu/favorites/check/${question.id}`).then(res => {
        if (res && res.favorited && favBtn.dataset.questionId == question.id) {
          favBtn.textContent = '★';
          favBtn.classList.add('favorited');
          favBtn.style.color = '#f59e0b';
        }
      }).catch(() => {});
    }
  }
}

// 收藏/取消收藏 当前题目
async function toggleCurrentQuestionFavorite() {
  const btn = document.getElementById('questionFavBtn');
  const questionId = sessionState.currentQuestion && sessionState.currentQuestion.id;
  if (!btn || !questionId) return;
  const favorited = btn.classList.contains('favorited');

  if (favorited) {
    // 取消收藏：直接操作，无需弹窗
    btn.disabled = true;
    try {
      await request(`/edu/favorites/${questionId}`, { method: 'DELETE' });
      btn.textContent = '☆';
      btn.classList.remove('favorited');
      btn.style.color = '';
      showToast('已取消收藏', 'info');
    } catch (e) {
      showToast('操作失败，请重试', 'error');
    } finally {
      btn.disabled = false;
    }
  } else {
    // 收藏：弹出分类选择弹窗
    openFavCategoryModal(questionId, (category_id) => {
      btn.textContent = '★';
      btn.classList.add('favorited');
      btn.style.color = '#f59e0b';
    });
  }
}

// ===== 收藏分类选择弹窗 =====
let _favModalState = { questionId: null, onSuccess: null };

async function openFavCategoryModal(questionId, onSuccess) {
  _favModalState.questionId = questionId;
  _favModalState.onSuccess = onSuccess;
  const modal = document.getElementById('favCategoryModal');
  const listEl = document.getElementById('favCategoryList');
  const input = document.getElementById('newFavCategoryName');
  if (input) input.value = '';
  if (listEl) listEl.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px 0;">加载中...</div>';
  if (modal) modal.classList.add('show');

  try {
    const res = await request('/edu/favorites/categories');
    const categories = (res && res.list) || [];
    renderFavCategoryList(categories);
  } catch (e) {
    if (listEl) listEl.innerHTML = '<div style="color:var(--danger);font-size:13px;padding:8px 0;">分类加载失败</div>';
  }
}

function renderFavCategoryList(categories) {
  const listEl = document.getElementById('favCategoryList');
  if (!listEl) return;
  let html = `
    <div class="fav-category-item" onclick="confirmFavoriteWithCategory(null)">
      <span>📌 不分类</span>
    </div>
  `;
  html += categories.map(c => `
    <div class="fav-category-item" onclick="confirmFavoriteWithCategory('${esc(c.id)}')">
      <span>📁 ${esc(c.name)}</span>
    </div>
  `).join('');
  listEl.innerHTML = html;
}

async function createFavCategory() {
  const input = document.getElementById('newFavCategoryName');
  const name = input && input.value.trim();
  if (!name) {
    showToast('请输入分类名称', 'error');
    return;
  }
  try {
    const res = await request('/edu/favorites/categories', { method: 'POST', body: JSON.stringify({ name }) });
    input.value = '';
    showToast('分类创建成功', 'success');
    // 直接用新分类完成收藏
    if (res && res.id) {
      await confirmFavoriteWithCategory(res.id);
    } else {
      const listRes = await request('/edu/favorites/categories');
      renderFavCategoryList((listRes && listRes.list) || []);
    }
  } catch (e) {
    showToast('创建分类失败，请重试', 'error');
  }
}

async function confirmFavoriteWithCategory(categoryId) {
  const { questionId, onSuccess } = _favModalState;
  if (!questionId) return;
  try {
    await request('/edu/favorites', {
      method: 'POST',
      body: JSON.stringify({ question_id: questionId, category_id: categoryId || null })
    });
    showToast('已收藏', 'success');
    closeFavCategoryModal();
    if (typeof onSuccess === 'function') onSuccess(categoryId);
  } catch (e) {
    showToast('收藏失败，请重试', 'error');
  }
}

function closeFavCategoryModal() {
  const modal = document.getElementById('favCategoryModal');
  if (modal) modal.classList.remove('show');
  _favModalState = { questionId: null, onSuccess: null };
}

// 选择选项
function selectOption(key, type) {
  if (sessionState.answered) return;
  if (type === 'single') {
    document.querySelectorAll('.assessment-option').forEach(el => el.classList.remove('selected'));
    const el = document.getElementById(`opt_${key}`);
    if (el) el.classList.add('selected');
    window._selectedOptions = [key];
  } else {
    // 多选
    const el = document.getElementById(`opt_${key}`);
    if (!el) return;
    if (!window._selectedOptions) window._selectedOptions = [];
    if (el.classList.contains('selected')) {
      el.classList.remove('selected');
      window._selectedOptions = window._selectedOptions.filter(k => k !== key);
    } else {
      el.classList.add('selected');
      window._selectedOptions.push(key);
    }
  }
}

// 获取当前答案
function getCurrentAnswer() {
  const q = sessionState.currentQuestion;
  if (!q) return null;
  if (q.type === 'single') {
    return window._selectedOptions && window._selectedOptions.length > 0 ? window._selectedOptions[0] : null;
  } else if (q.type === 'multi') {
    return window._selectedOptions && window._selectedOptions.length > 0
      ? window._selectedOptions.sort().join('')
      : null;
  } else if (q.type === 'fill') {
    return document.getElementById('fillAnswer').value.trim() || null;
  } else if (q.type === 'subjective') {
    return document.getElementById('subjectiveAnswer').value.trim() || null;
  }
  return null;
}

// 提交答案
async function submitAnswer() {
  if (sessionState.answered) return;
  const answer = getCurrentAnswer();
  if (answer === null || answer === '') {
    showToast('请先填写答案', 'error');
    return;
  }

  const timeSpentMs = Date.now() - sessionState.startTime;
  sessionState.answered = true;

  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = '提交中...';

  try {
    const data = await request(`/edu/assessment/${sessionState.sessionId}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        question_id: sessionState.currentQuestion.id,
        user_answer: answer,
        time_spent_ms: timeSpentMs
      })
    });

    submitBtn.textContent = '已提交';

    // 显示解析
    showAnswerResult(data);

    // 更新进度并自动进入下一题（无需手动点击）
    if (data.is_last || !data.next_question) {
      stopTimer();
      document.getElementById('finishBtn').style.display = '';
      sessionState.lastScore = data.score;
    } else {
      sessionState.nextQuestion = data.next_question;
      sessionState.nextSeqNo = data.next_seq_no;
      document.getElementById('nextBtn').style.display = 'none';
      setTimeout(() => {
        // 若用户已离开该题（如手动跳转），避免重复推进
        if (sessionState.nextQuestion === data.next_question) {
          nextQuestion();
        }
      }, 600);
    }
  } catch (e) {
    sessionState.answered = false;
    submitBtn.disabled = false;
    submitBtn.textContent = '提交答案';
    showToast(e.message || '提交失败，请重试', 'error');
  }
}

// 显示答题结果（延迟公布：不展示对错和解析，仅确认已提交）
function showAnswerResult(data) {
  // 禁止继续修改选项，但不做对错高亮
  document.querySelectorAll('.assessment-option').forEach(el => {
    el.style.pointerEvents = 'none';
  });

  const analysisArea = document.getElementById('analysisArea');
  analysisArea.style.display = '';
  analysisArea.innerHTML = `
    <div style="color:var(--text-secondary);font-weight:600;font-size:14px;">✅ 已提交，答案将在评测结束后统一公布</div>
  `;

  document.getElementById('submitBtn').style.display = 'none';

  // 更新答题卡：当前题标记为已答
  updateCurrentCardStatus('answered');
}

// ===== 答题卡 =====

// 折叠/展开答题卡
function toggleAnswerCard() {
  const wrap = document.getElementById('answerCardWrap');
  if (!wrap) return;
  wrap.classList.toggle('collapsed');
  const icon = document.getElementById('answerCardToggleIcon');
  if (icon) icon.textContent = wrap.classList.contains('collapsed') ? '▸' : '▾';
}

// 将当前题加入/更新答题卡（在renderQuestion时调用）
function ensureCurrentCard(seqNo) {
  // 之前的 current 卡片若未标记为 answered，则置为 unanswered（理论上不会发生，因为必须提交才能下一题）
  sessionState.cards.forEach(c => { if (c.status === 'current') c.status = 'answered'; });

  let card = sessionState.cards.find(c => c.seq_no === seqNo);
  if (!card) {
    card = { seq_no: seqNo, status: 'current' };
    sessionState.cards.push(card);
  } else {
    card.status = 'current';
  }
  renderAnswerCard();
}

// 更新当前题卡片状态（提交后调用）
function updateCurrentCardStatus(status) {
  const card = sessionState.cards.find(c => c.seq_no === sessionState.seqNo);
  if (card) card.status = status;
  renderAnswerCard();
}

// 渲染答题卡方块列表
function renderAnswerCard() {
  const container = document.getElementById('answerCard');
  if (!container) return;
  const total = sessionState.total || 0;
  const cardMap = {};
  sessionState.cards.forEach(c => { cardMap[c.seq_no] = c.status; });

  let html = '';
  for (let i = 1; i <= total; i++) {
    const status = cardMap[i] || 'unseen';
    const clickable = status === 'answered' || status === 'current';
    html += `<div class="assessment-card-item ${status}" ${clickable ? `onclick="peekAnsweredCard(${i})"` : ''}>${i}</div>`;
  }
  container.innerHTML = html;
}

// 点击已答/当前题卡片：只读回顾（不展示对错，答案延迟公布）
function peekAnsweredCard(seqNo) {
  if (seqNo === sessionState.seqNo) return; // 当前题无需弹窗
  const card = sessionState.cards.find(c => c.seq_no === seqNo);
  if (!card || card.status !== 'answered') return;
  showToast(`第 ${seqNo} 题已作答，答案将在评测结束后统一公布`, 'info');
}

// 下一题
function nextQuestion() {
  if (!sessionState.nextQuestion) return;
  window._selectedOptions = [];
  renderQuestion(sessionState.nextQuestion, sessionState.nextSeqNo, sessionState.total);
  resetTimer();
}

// 提前结束评测
async function abortAssessment() {
  const confirmed = await showConfirm({
    title: '提前结束评测',
    message: '确定要提前结束本次评测吗？已答题目将计入评测结果。',
    okText: '结束评测',
    variant: 'warning'
  });
  if (!confirmed) return;
  stopTimer();
  await request(`/edu/assessment/${sessionState.sessionId}/finish`, { method: 'POST' });
  showStage('result');
  await loadReport(sessionState.sessionId);
}

// 完成评测，查看结果
async function finishAssessment() {
  stopTimer();
  const finishBtn = document.getElementById('finishBtn');
  if (finishBtn) { finishBtn.disabled = true; finishBtn.textContent = '生成报告中...'; }
  showStage('result');
  await loadReport(sessionState.sessionId);
}

// 加载并渲染评测报告
async function loadReport(sessionId) {
  try {
    document.getElementById('resultIcon').textContent = '⏳';
    document.getElementById('resultScoreNum').textContent = '--';
    document.getElementById('resultStats').innerHTML = `
      <div style="text-align:center;padding:24px 0;color:var(--text-muted);">
        <div style="font-size:28px;margin-bottom:10px;">🤖</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px;">AI 正在分析答题数据...</div>
        <div style="font-size:13px;">正在生成知识点画像与评测报告，请稍候</div>
      </div>`;

    const data = await request(`/edu/assessment/${sessionId}/report`);
    const { session, answers, weak_points, strong_points, ai_summary } = data;

    sessionState.sessionId = session.id;

    // 得分和图标
    const score = parseFloat(session.score) || 0;
    document.getElementById('resultIcon').textContent = score >= 80 ? '🎉' : score >= 60 ? '👍' : '💪';
    document.getElementById('resultScoreNum').textContent = score.toFixed(0);

    // 统计信息
    const totalAnswered = session.answered_count || 0;
    const correct = session.correct_count || 0;
    const accuracy = totalAnswered > 0 ? Math.round(correct / totalAnswered * 100) : 0;
    document.getElementById('resultStats').innerHTML = `
      <div class="assessment-result-stat-item">
        <div style="font-size:22px;font-weight:700;">${totalAnswered}</div>
        <div style="font-size:12px;color:var(--text-muted);">答题数</div>
      </div>
      <div class="assessment-result-stat-item">
        <div style="font-size:22px;font-weight:700;color:#10b981;">${correct}</div>
        <div style="font-size:12px;color:var(--text-muted);">答对</div>
      </div>
      <div class="assessment-result-stat-item">
        <div style="font-size:22px;font-weight:700;color:#3b82f6;">${accuracy}%</div>
        <div style="font-size:12px;color:var(--text-muted);">正确率</div>
      </div>
    `;

    // AI总结
    if (ai_summary) {
      document.getElementById('aiSummaryArea').style.display = '';
      document.getElementById('aiSummaryText').textContent = ai_summary;
    }

    // 薄弱知识点
    const weakContainer = document.getElementById('weakPointsList');
    if (weak_points && weak_points.length > 0) {
      weakContainer.innerHTML = weak_points.slice(0, 5).map(w => `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-light,#f0f0f0);">
          <span style="font-size:20px;">⚠️</span>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:600;">${esc(w.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);">正确率 ${w.accuracy}%（答对${w.correct}/${w.total}题）</div>
          </div>
        </div>
      `).join('');
    } else if (totalAnswered === 0) {
      weakContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无答题记录</div>';
    } else {
      weakContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">本次没有明显薄弱知识点，表现优秀！</div>';
    }

    // 掌握较好的知识点
    const strongContainer = document.getElementById('strongPointsList');
    if (strong_points && strong_points.length > 0) {
      strongContainer.innerHTML = strong_points.slice(0, 5).map(s => `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--border-light,#f0f0f0);">
          <span style="font-size:20px;">✅</span>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:600;">${esc(s.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);">正确率 ${s.accuracy}%</div>
          </div>
        </div>
      `).join('');
    } else if (totalAnswered === 0) {
      strongContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无答题记录</div>';
    } else {
      strongContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无数据</div>';
    }

    // 答题详情（逐题：题目、选项、作答、正确答案、解析）
    renderAnswerDetailList(answers);
  } catch (e) {
    showToast('加载报告失败：' + (e.message || ''), 'error');
  }
}

// 渲染逐题答题详情
function renderAnswerDetailList(answers) {
  const container = document.getElementById('answerDetailList');
  if (!container) return;
  if (!answers || answers.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">暂无答题记录</div>';
    return;
  }

  container.innerHTML = answers.map((a, idx) => {
    // 解析选项
    let options = [];
    if (a.options_json) {
      try {
        options = typeof a.options_json === 'string' ? JSON.parse(a.options_json) : a.options_json;
      } catch (e) { options = []; }
    }
    const optionsHtml = Array.isArray(options) && options.length > 0
      ? `<div style="margin:8px 0;">
          ${options.map(o => `<div style="font-size:13px;color:var(--text-secondary);margin:3px 0;">
            <span style="display:inline-block;min-width:22px;font-weight:600;color:var(--text-muted);">${esc(o.key)}.</span>${esc(o.text)}
          </div>`).join('')}
        </div>`
      : '';

    const isCorrect = a.is_correct === 1;
    const statusIcon = a.is_correct === null ? '❓' : (isCorrect ? '✅' : '❌');
    const statusColor = a.is_correct === null ? '#94a3b8' : (isCorrect ? '#10b981' : '#ef4444');
    const userAnswerColor = a.is_correct === null ? 'var(--text-primary)' : (isCorrect ? '#10b981' : '#ef4444');

    return `
      <div style="padding:14px 0;border-bottom:1px solid var(--border-light,#f0f0f0);">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <span style="font-size:16px;flex-shrink:0;">${statusIcon}</span>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;">
              <div style="font-size:11px;color:var(--text-muted);">
                第${idx + 1}题 · ${esc(TYPE_LABELS[a.question_type] || a.question_type || '')} ${a.knowledge_name ? '· ' + esc(a.knowledge_name) : ''}
              </div>
              <button type="button" class="fav-star-btn" data-question-id="${esc(a.question_id)}" onclick="toggleFavorite(this, '${esc(a.question_id)}')" title="收藏本题" style="flex-shrink:0;border:none;background:none;cursor:pointer;font-size:18px;line-height:1;padding:2px 4px;color:var(--text-muted);">☆</button>
            </div>
            <div style="font-size:14px;font-weight:500;color:var(--text-primary);line-height:1.6;">${esc(a.question_content || '')}</div>
            ${optionsHtml}
            <div style="display:flex;gap:16px;margin:8px 0;font-size:13px;flex-wrap:wrap;">
              <span>你的答案：<strong style="color:${userAnswerColor};">${esc(a.user_answer || '未作答')}</strong></span>
              <span>正确答案：<strong style="color:#10b981;">${esc(a.correct_answer || '--')}</strong></span>
            </div>
            ${(a.question_type === 'fill' || a.question_type === 'subjective') && a.ai_reason ? `
              <div style="margin:8px 0;padding:10px;background:#fff7ed;border-radius:6px;border-left:3px solid #f59e0b;font-size:13px;color:var(--text-secondary);line-height:1.6;">
                <strong style="color:var(--text-primary);">🤖 AI评分：${a.ai_score !== null && a.ai_score !== undefined ? esc(a.ai_score) + '分' : '--'}</strong>
                <div style="margin-top:4px;">评分依据：${esc(a.ai_reason)}</div>
              </div>
            ` : ''}
            ${a.analysis ? `
              <div style="margin-top:6px;padding:10px;background:var(--bg-secondary);border-radius:6px;border-left:3px solid ${statusColor};font-size:13px;color:var(--text-secondary);line-height:1.6;">
                <strong style="color:var(--text-primary);">💡 解析：</strong>${esc(a.analysis)}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // 逐题查询收藏状态，回填星标高亮
  answers.forEach(a => {
    if (!a.question_id) return;
    request(`/edu/favorites/check/${a.question_id}`).then(res => {
      if (res && res.favorited) {
        const btn = container.querySelector(`.fav-star-btn[data-question-id="${a.question_id}"]`);
        if (btn) { btn.textContent = '★'; btn.classList.add('favorited'); btn.style.color = '#f59e0b'; }
      }
    }).catch(() => {});
  });
}

// 收藏/取消收藏 切换
async function toggleFavorite(btn, questionId) {
  const favorited = btn.classList.contains('favorited');
  btn.disabled = true;
  try {
    if (favorited) {
      await request(`/edu/favorites/${questionId}`, { method: 'DELETE' });
      btn.textContent = '☆';
      btn.classList.remove('favorited');
      btn.style.color = 'var(--text-muted)';
      showToast('已取消收藏', 'info');
    } else {
      await request('/edu/favorites', { method: 'POST', body: JSON.stringify({ question_id: questionId }) });
      btn.textContent = '★';
      btn.classList.add('favorited');
      btn.style.color = '#f59e0b';
      showToast('已收藏', 'success');
    }
  } catch (e) {
    showToast('操作失败，请重试', 'error');
  } finally {
    btn.disabled = false;
  }
}

// AI错因分析
async function analyzeErrors() {
  const sessionId = sessionState.sessionId;
  if (!sessionId) { showToast('请先完成评测', 'error'); return; }
  const btn = document.getElementById('analyzeErrorsBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;"><span class="assess-spin"></span>AI分析中...</span>'; }
  try {
    await request(`/edu/error-analysis/session/${sessionId}`, { method: 'POST' });
    window.location.href = '/pc/errors.html';
  } catch (e) {
    showToast(e.message || 'AI分析失败', 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = '🔍 AI错因分析'; }
  }
}

// 查看能力画像
function viewProfile() {
  window.location.href = '/pc/profile.html';
}

// 重新开始评测
function restartAssessment() {
  stopTimer();
  sessionState = { sessionId: null, subjectId: null, currentQuestion: null, seqNo: 1, total: 15, startTime: null, answered: false, timerInterval: null };
  window._selectedOptions = [];
  window._selectedSubjectId = null;
  // 重置按钮状态，防止上次流程残留 disabled
  const btn = document.getElementById('startAssessmentBtn');
  if (btn) { btn.disabled = false; btn.textContent = '🚀 开始评测'; }
  showStage('select');
  history.replaceState(null, '', '/pc/assessment.html');
  // 重新渲染当前学段的学科卡片（去除 selected 状态）
  if (window._subjectsByLevel && window._currentLevel) {
    renderSubjectCards(window._currentLevel, null);
  }
}

// ===== 计时器 =====
let timerSeconds = 0;

function startTimer() {
  timerSeconds = 0;
  updateTimerDisplay();
  if (sessionState.timerInterval) clearInterval(sessionState.timerInterval);
  sessionState.timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
  }, 1000);
}

function resetTimer() {
  timerSeconds = 0;
  updateTimerDisplay();
}

function stopTimer() {
  if (sessionState.timerInterval) {
    clearInterval(sessionState.timerInterval);
    sessionState.timerInterval = null;
  }
}

function updateTimerDisplay() {
  const el = document.getElementById('timerDisplay');
  if (!el) return;
  const m = Math.floor(timerSeconds / 60).toString().padStart(2, '0');
  const s = (timerSeconds % 60).toString().padStart(2, '0');
  el.textContent = `${m}:${s}`;
  // 超过2分钟变红
  el.style.color = timerSeconds > 120 ? '#ef4444' : '';
}
