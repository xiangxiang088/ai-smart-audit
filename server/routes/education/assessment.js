const express = require('express');
const db = require('../../db');
const auth = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const { getAIConfig } = require('../settings');
const { operLog } = require('../../logger');
const { recordAIRequest } = require('../../utils/aiLogger');

const router = express.Router();

// ===== 错题本自动入库 =====
async function upsertWrongQuestion(userId, questionId, knowledgeId, subjectId) {
  try {
    const nextReview = new Date();
    nextReview.setDate(nextReview.getDate() + 1);
    const id = snowflake.nextId();
    await db.query(
      `INSERT INTO edu_wrong_question
         (id, user_id, question_id, knowledge_id, subject_id, last_wrong_at, next_review_at)
       VALUES (?, ?, ?, ?, ?, NOW(3), ?) AS new_val
       ON DUPLICATE KEY UPDATE
         wrong_count    = wrong_count + 1,
         last_wrong_at  = new_val.last_wrong_at,
         next_review_at = new_val.next_review_at,
         review_stage   = GREATEST(0, review_stage - 1),
         is_mastered    = 0`,
      [id, userId, questionId, knowledgeId || null, subjectId || null, nextReview]
    );
  } catch (e) {
    // 错题本入库失败不阻断主流程
    console.error('[upsertWrongQuestion]', e.message);
  }
}

// ===== 掌握度分值 → 等级映射 =====
function scoreToLevel(score) {
  if (score <= 20) return 0; // 未学
  if (score <= 40) return 1; // 了解
  if (score <= 65) return 2; // 理解
  if (score <= 85) return 3; // 应用
  return 4;                  // 精通
}

// ===== 更新学生知识点掌握画像 =====
async function upsertStudentProfile(userId, knowledgeId, subjectId, isCorrect, timeSpentMs) {
  const [rows] = await db.query(
    'SELECT id, mastery_score, total_attempts, correct_count, avg_time_ms FROM edu_student_profile WHERE user_id = ? AND knowledge_id = ? AND del_flag = 0',
    [userId, knowledgeId]
  );

  const now = new Date();

  if (rows.length === 0) {
    // 首次记录，创建新画像
    const id = snowflake.nextId();
    const initScore = isCorrect === 1 ? 10.0 : 0.0;
    const level = scoreToLevel(initScore);
    await db.query(
      `INSERT INTO edu_student_profile
       (id, user_id, knowledge_id, subject_id, mastery_level, mastery_score, total_attempts, correct_count, avg_time_ms, last_assessed_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [id, userId, knowledgeId, subjectId, level, initScore,
       isCorrect === 1 ? 1 : 0, timeSpentMs || null, now]
    );
  } else {
    const profile = rows[0];
    // 答对+5，答错-3，范围限制在[0, 100]
    let newScore = parseFloat(profile.mastery_score);
    if (isCorrect === 1) newScore = Math.min(100, newScore + 5);
    else if (isCorrect === 0) newScore = Math.max(0, newScore - 3);
    // isCorrect为null时（主观题）不调整分值

    const newLevel = scoreToLevel(newScore);
    const newTotal = (profile.total_attempts || 0) + 1;
    const newCorrect = (profile.correct_count || 0) + (isCorrect === 1 ? 1 : 0);

    // 更新平均耗时
    let newAvgTime = profile.avg_time_ms;
    if (timeSpentMs && timeSpentMs > 0) {
      newAvgTime = profile.avg_time_ms
        ? Math.round((profile.avg_time_ms * (newTotal - 1) + timeSpentMs) / newTotal)
        : timeSpentMs;
    }

    await db.query(
      `UPDATE edu_student_profile
       SET mastery_score = ?, mastery_level = ?, total_attempts = ?, correct_count = ?,
           avg_time_ms = ?, last_assessed_at = ?
       WHERE user_id = ? AND knowledge_id = ? AND del_flag = 0`,
      [newScore, newLevel, newTotal, newCorrect, newAvgTime, now, userId, knowledgeId]
    );
  }
}

// ===== 自适应选题算法 =====
async function selectNextQuestion(sessionId, userId, subjectId, answeredIds, config) {
  // 1. 统计当前正确率
  const [[stats]] = await db.query(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
     FROM edu_answer_record WHERE session_id = ? AND del_flag = 0`,
    [sessionId]
  );
  const total = Number(stats.total) || 0;
  const correct = Number(stats.correct) || 0;
  const accuracy = total > 0 ? correct / total : 0.5;

  // 2. 动态调整目标难度（正确率≥70%升难，<40%降难）
  const minDiff = config.minDifficulty || 1;
  const maxDiff = config.maxDifficulty || 5;
  let targetDifficulty;
  if (accuracy >= 0.7) targetDifficulty = Math.min(maxDiff, 4);
  else if (accuracy < 0.4) targetDifficulty = Math.max(minDiff, 2);
  else targetDifficulty = 3;

  const makeExclude = (ids) => ids.length > 0
    ? `AND q.id NOT IN (${ids.map(() => '?').join(',')})`
    : '';

  // 3. 优先从薄弱知识点出题（精确难度）
  const [weakProfiles] = await db.query(
    `SELECT knowledge_id FROM edu_student_profile
     WHERE user_id = ? AND subject_id = ? AND mastery_score < 60 AND del_flag = 0
     ORDER BY mastery_score ASC LIMIT 10`,
    [userId, subjectId]
  );

  if (weakProfiles.length > 0) {
    const weakIds = weakProfiles.map(p => p.knowledge_id);
    const [rows] = await db.query(
      `SELECT q.id, q.subject_id, q.knowledge_id, q.type, q.difficulty, q.content, q.options_json, q.analysis
       FROM edu_question q
       WHERE q.subject_id = ? AND q.knowledge_id IN (?)
         AND q.difficulty = ? AND q.del_flag = 0
         ${makeExclude(answeredIds)}
       ORDER BY RAND() LIMIT 1`,
      [subjectId, weakIds, targetDifficulty, ...answeredIds]
    );
    if (rows.length > 0) return rows[0];
  }

  // 4. 全科兜底：目标难度±1，排除已答
  const [rows] = await db.query(
    `SELECT q.id, q.subject_id, q.knowledge_id, q.type, q.difficulty, q.content, q.options_json, q.analysis
     FROM edu_question q
     WHERE q.subject_id = ?
       AND q.difficulty BETWEEN ? AND ?
       AND q.del_flag = 0
       ${makeExclude(answeredIds)}
     ORDER BY RAND() LIMIT 1`,
    [subjectId, Math.max(1, targetDifficulty - 1), Math.min(5, targetDifficulty + 1), ...answeredIds]
  );
  if (rows.length > 0) return rows[0];

  // 5. 放宽兜底：任意难度，排除已答
  const [rows2] = await db.query(
    `SELECT q.id, q.subject_id, q.knowledge_id, q.type, q.difficulty, q.content, q.options_json, q.analysis
     FROM edu_question q
     WHERE q.subject_id = ? AND q.del_flag = 0
       ${makeExclude(answeredIds)}
     ORDER BY RAND() LIMIT 1`,
    [subjectId, ...answeredIds]
  );
  if (rows2.length > 0) return rows2[0];

  // 6. 最终兜底：允许重复题（题库总量不足时保证出完 max_questions 题）
  const [rows3] = await db.query(
    `SELECT q.id, q.subject_id, q.knowledge_id, q.type, q.difficulty, q.content, q.options_json, q.analysis
     FROM edu_question q
     WHERE q.subject_id = ? AND q.del_flag = 0
     ORDER BY RAND() LIMIT 1`,
    [subjectId]
  );
  return rows3[0] || null;
}

// ===== 启动评测会话 =====
router.post('/start', auth, operLog('智能评测', 1), async (req, res) => {
  const { subject_id, session_type = 'entry', config = {} } = req.body;
  if (!subject_id) return res.status(400).json({ error: '缺少subject_id参数' });

  const [subjectRows] = await db.query(
    'SELECT id, name FROM edu_subject WHERE id = ? AND del_flag = 0', [subject_id]
  );
  if (subjectRows.length === 0) return res.status(404).json({ error: '学科不存在' });

  // 检查是否有题目可用
  const [[{ qCount }]] = await db.query(
    'SELECT COUNT(*) AS qCount FROM edu_question WHERE subject_id = ? AND del_flag = 0',
    [subject_id]
  );
  if (Number(qCount) === 0) {
    return res.status(400).json({ error: '该学科暂无可用题目，请管理员先添加题目' });
  }

  const sessionId = snowflake.nextId();
  const maxQuestions = Math.min(config.max_questions || 15, 30);
  const sessionConfig = { maxDifficulty: 5, minDifficulty: 1, ...config, max_questions: maxQuestions };

  await db.query(
    `INSERT INTO edu_assessment_session
     (id, user_id, subject_id, session_type, status, total_questions, started_at, config_json, created_by)
     VALUES (?, ?, ?, ?, 'ongoing', ?, NOW(3), ?, ?)`,
    [sessionId, req.userId, subject_id, session_type, maxQuestions,
     JSON.stringify(sessionConfig), req.userId]
  );

  // 获取第一道题
  const firstQuestion = await selectNextQuestion(
    sessionId.toString(), req.userId, subject_id, [], sessionConfig
  );
  if (!firstQuestion) {
    // 回滚会话
    await db.query('UPDATE edu_assessment_session SET status = ? WHERE id = ?', ['aborted', sessionId]);
    return res.status(400).json({ error: '暂时无法获取题目，请稍后重试' });
  }

  res.json({
    session_id: sessionId.toString(),
    subject: subjectRows[0],
    seq_no: 1,
    total: maxQuestions,
    question: firstQuestion
  });
});

// ===== AI 判分：填空题/主观题根据参考答案合理打分，返回评分依据 =====
async function gradeWithAI(question, userAnswer, userId, sessionId) {
  const aiConfig = getAIConfig();
  if (!aiConfig || !aiConfig.enabled) return null;

  const prompt = `题目：${question.content}
参考答案：${question.answer}
${question.analysis ? `参考解析：${question.analysis}` : ''}
学生作答：${userAnswer}

请判断学生作答是否正确，只返回JSON，不要输出其他任何文字或markdown代码块围栏：
{"is_correct": 0或1, "score": 0到100的分数, "reason": "评分依据，说明学生答案对在哪/错在哪/如何改进，100字以内"}
评分标准：填空题允许同义词、合理不同表述视为正确；主观题按参考答案要点覆盖程度给分，覆盖大部分要点给较高分，不要求逐字匹配。`;

  const requestBody = {
    model: aiConfig.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 300
  };
  const requestTime = new Date();

  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${aiConfig.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      recordAIRequest({
        userId, businessType: 'assessment_grading', businessId: sessionId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model,
        requestBody, responseResult: null,
        requestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return null;
    }

    const result = await response.json();
    recordAIRequest({
      userId, businessType: 'assessment_grading', businessId: sessionId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model,
      requestBody, responseResult: result,
      requestTime, responseTime: new Date(),
      status: 0
    });

    let text = result.choices?.[0]?.message?.content || '';
    text = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(text);

    const isCorrect = Number(parsed.is_correct) === 1 ? 1 : 0;
    let score = Number(parsed.score);
    if (Number.isNaN(score)) score = isCorrect ? 100 : 0;
    score = Math.max(0, Math.min(100, score));
    const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 500) : null;

    return { is_correct: isCorrect, score, reason };
  } catch (e) {
    recordAIRequest({
      userId, businessType: 'assessment_grading', businessId: sessionId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model,
      requestBody, responseResult: null,
      requestTime, responseTime: new Date(),
      status: 1, errorMsg: e.message
    });
    return null;
  }
}

// ===== 提交答案，返回判断结果和下一题 =====
router.post('/:session_id/answer', auth, operLog('智能评测', 2), async (req, res) => {
  const { session_id } = req.params;
  const { question_id, user_answer, time_spent_ms } = req.body;

  if (!question_id || user_answer === undefined || user_answer === null) {
    return res.status(400).json({ error: '缺少question_id或user_answer参数' });
  }

  // 验证会话归属
  const [sessionRows] = await db.query(
    'SELECT * FROM edu_assessment_session WHERE id = ? AND user_id = ? AND del_flag = 0',
    [session_id, req.userId]
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: '评测会话不存在' });
  const session = sessionRows[0];
  if (session.status !== 'ongoing') return res.status(400).json({ error: '评测已结束，请开始新的评测' });

  // 获取题目
  const [qRows] = await db.query(
    'SELECT * FROM edu_question WHERE id = ? AND del_flag = 0', [question_id]
  );
  if (qRows.length === 0) return res.status(404).json({ error: '题目不存在' });
  const question = qRows[0];

  // 判断是否正确
  let isCorrect = null;
  let aiScore = null;
  let aiReason = null;
  if (question.type === 'single') {
    isCorrect = String(user_answer).trim().toUpperCase() === String(question.answer).trim().toUpperCase() ? 1 : 0;
    aiScore = isCorrect ? 100 : 0;
  } else if (question.type === 'multi') {
    // 多选题：排序后比较
    const userSorted = String(user_answer).split('').sort().join('').toUpperCase();
    const ansSorted  = String(question.answer).split('').sort().join('').toUpperCase();
    isCorrect = userSorted === ansSorted ? 1 : 0;
    aiScore = isCorrect ? 100 : 0;
  } else if (question.type === 'fill' || question.type === 'subjective') {
    // 填空题/主观题：优先用AI根据参考答案合理判分，失败则降级
    const graded = await gradeWithAI(question, user_answer, req.userId, session_id);
    if (graded) {
      isCorrect = graded.is_correct;
      aiScore = graded.score;
      aiReason = graded.reason;
    } else if (question.type === 'fill') {
      // AI不可用/失败时，填空题降级为精确字符串匹配
      isCorrect = String(user_answer).trim().toLowerCase() === String(question.answer).trim().toLowerCase() ? 1 : 0;
      aiScore = isCorrect ? 100 : 0;
    }
    // subjective 降级：isCorrect/aiScore/aiReason 保持 null，维持现状
  }

  // 获取当前序号
  const [[{ seqCount }]] = await db.query(
    'SELECT COUNT(*) AS seqCount FROM edu_answer_record WHERE session_id = ? AND del_flag = 0',
    [session_id]
  );
  const seqNo = Number(seqCount) + 1;

  // 保存答题记录
  const answerId = snowflake.nextId();
  await db.query(
    `INSERT INTO edu_answer_record
     (id, session_id, user_id, question_id, knowledge_id, seq_no, user_answer, is_correct, score, remark, time_spent_ms, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [answerId, session_id, req.userId, question_id, question.knowledge_id,
     seqNo, String(user_answer), isCorrect, aiScore, aiReason, time_spent_ms || null, req.userId]
  );

  // 更新会话统计
  await db.query(
    `UPDATE edu_assessment_session
     SET answered_count = answered_count + 1,
         correct_count  = correct_count + ?
     WHERE id = ?`,
    [isCorrect === 1 ? 1 : 0, session_id]
  );

  // 更新学生画像
  await upsertStudentProfile(req.userId, question.knowledge_id, session.subject_id, isCorrect, time_spent_ms);

  // 答错时自动写入错题本
  if (isCorrect === 0) {
    await upsertWrongQuestion(req.userId, question_id, question.knowledge_id, session.subject_id);
  }

  // 判断是否到最后一题
  const isLast = seqNo >= Number(session.total_questions);

  let nextQuestion = null;
  if (!isLast) {
    // 获取已答题目ID列表
    const [answeredRows] = await db.query(
      'SELECT question_id FROM edu_answer_record WHERE session_id = ? AND del_flag = 0',
      [session_id]
    );
    const answeredIds = answeredRows.map(r => r.question_id);
    const config = typeof session.config_json === 'string'
      ? JSON.parse(session.config_json)
      : (session.config_json || {});
    nextQuestion = await selectNextQuestion(session_id, req.userId, session.subject_id, answeredIds, config);
  }

  // 只有「已答完计划题数」才结束会话，找不到下一题（题库耗尽）也结束
  const shouldEnd = isLast || (!isLast && nextQuestion === null);

  if (shouldEnd) {
    const [[{ answered }]] = await db.query(
      'SELECT answered_count AS answered FROM edu_assessment_session WHERE id = ?', [session_id]
    );
    const score = answered > 0
      ? ((Number(session.correct_count) + (isCorrect === 1 ? 1 : 0)) / Number(answered) * 100).toFixed(2)
      : 0;
    await db.query(
      `UPDATE edu_assessment_session
       SET status = 'completed', score = ?, completed_at = NOW(3)
       WHERE id = ?`,
      [score, session_id]
    );

    return res.json({
      submitted: true,
      next_question: null,
      is_last: true,
      session_id,
      score: parseFloat(score)
    });
  }

  res.json({
    submitted: true,
    next_question: nextQuestion,
    next_seq_no: seqNo + 1,
    total: Number(session.total_questions),
    is_last: false
  });
});

// ===== 主动完成评测 =====
router.post('/:session_id/finish', auth, operLog('智能评测', 0), async (req, res) => {
  const { session_id } = req.params;

  const [sessionRows] = await db.query(
    'SELECT * FROM edu_assessment_session WHERE id = ? AND user_id = ? AND del_flag = 0',
    [session_id, req.userId]
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: '评测会话不存在' });
  const session = sessionRows[0];
  if (session.status === 'completed') return res.json({ success: true, session_id });

  const score = session.answered_count > 0
    ? (session.correct_count / session.answered_count * 100).toFixed(2)
    : 0;

  await db.query(
    `UPDATE edu_assessment_session
     SET status = 'completed', score = ?, completed_at = NOW(3)
     WHERE id = ?`,
    [score, session_id]
  );
  res.json({ success: true, session_id, score: parseFloat(score) });
});

// ===== 获取评测结果报告 =====
router.get('/:session_id/report', auth, async (req, res) => {
  const { session_id } = req.params;

  const [sessionRows] = await db.query(
    `SELECT s.*, sub.name AS subject_name, sub.icon AS subject_icon
     FROM edu_assessment_session s
     LEFT JOIN edu_subject sub ON s.subject_id = sub.id
     WHERE s.id = ? AND s.user_id = ? AND s.del_flag = 0`,
    [session_id, req.userId]
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: '评测会话不存在' });
  const session = sessionRows[0];

  // 获取答题明细（含知识点信息）
  const [answers] = await db.query(
    `SELECT ar.id, ar.question_id, ar.seq_no, ar.user_answer, ar.is_correct, ar.score AS ai_score, ar.remark AS ai_reason, ar.time_spent_ms,
            q.content AS question_content, q.type AS question_type, q.answer AS correct_answer,
            q.analysis, q.difficulty, q.options_json,
            kn.name AS knowledge_name, kn.id AS knowledge_id
     FROM edu_answer_record ar
     LEFT JOIN edu_question q ON ar.question_id = q.id
     LEFT JOIN edu_knowledge_node kn ON ar.knowledge_id = kn.id
     WHERE ar.session_id = ? AND ar.del_flag = 0
     ORDER BY ar.seq_no ASC`,
    [session_id]
  );

  // 统计薄弱和掌握知识点
  const knowledgeStats = {};
  for (const a of answers) {
    if (!a.knowledge_id) continue;
    if (!knowledgeStats[a.knowledge_id]) {
      knowledgeStats[a.knowledge_id] = {
        id: a.knowledge_id,
        name: a.knowledge_name,
        total: 0, correct: 0
      };
    }
    knowledgeStats[a.knowledge_id].total++;
    if (a.is_correct === 1) knowledgeStats[a.knowledge_id].correct++;
  }

  const knList = Object.values(knowledgeStats).map(k => ({
    ...k,
    accuracy: k.total > 0 ? Math.round(k.correct / k.total * 100) : 0
  }));

  const weakPoints = knList.filter(k => k.accuracy < 60).sort((a, b) => a.accuracy - b.accuracy);
  const strongPoints = knList.filter(k => k.accuracy >= 80).sort((a, b) => b.accuracy - a.accuracy);

  // AI生成评测总结
  let aiSummary = null;
  try {
    const aiConfig = await getAIConfig();
    if (aiConfig.apiKey && aiConfig.enabled) {
      const correctRate = session.answered_count > 0
        ? Math.round(session.correct_count / session.answered_count * 100)
        : 0;
      const weakNames = weakPoints.slice(0, 3).map(w => w.name).join('、');
      const strongNames = strongPoints.slice(0, 3).map(s => s.name).join('、');

      const userPrompt = `学生完成了${session.subject_name}学科的评测，共答${session.answered_count}题，正确率${correctRate}%。
薄弱知识点：${weakNames || '暂无'}；掌握较好的知识点：${strongNames || '暂无'}。
请用2-3句话给出简短的学习建议和鼓励，语气温和积极，适合学生阅读。`;

      const reportRequestBody = {
        model: aiConfig.model,
        messages: [
          { role: 'system', content: '你是一位温和专业的教育顾问，给学生提供个性化学习建议。' },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 300
      };
      const reportRequestTime = new Date();
      const response = await fetch(aiConfig.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${aiConfig.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(reportRequestBody)
      });
      if (response.ok) {
        const result = await response.json();
        aiSummary = result.choices?.[0]?.message?.content || null;
        recordAIRequest({
          userId: req.userId, businessType: 'assessment_report_summary', businessId: session_id,
          requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: reportRequestBody,
          responseResult: result, requestTime: reportRequestTime, responseTime: new Date(), status: 0
        });
      } else {
        recordAIRequest({
          userId: req.userId, businessType: 'assessment_report_summary', businessId: session_id,
          requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: reportRequestBody,
          responseResult: null, requestTime: reportRequestTime, responseTime: new Date(),
          status: 1, errorMsg: `HTTP ${response.status}`
        });
      }
    }
  } catch (e) {
    // AI摘要失败不影响主流程
    console.error('[报告AI总结] 失败:', e.message);
  }

  res.json({
    session,
    answers,
    weak_points: weakPoints,
    strong_points: strongPoints,
    ai_summary: aiSummary
  });
});

// ===== 获取历史评测列表 =====
router.get('/history', auth, async (req, res) => {
  const { subject_id, session_type, education_level, page = 1, page_size = 10 } = req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  const conditions = ['s.user_id = ?', 's.del_flag = 0'];
  const params = [req.userId];

  if (subject_id) { conditions.push('s.subject_id = ?'); params.push(subject_id); }
  if (session_type) { conditions.push('s.session_type = ?'); params.push(session_type); }
  if (education_level) { conditions.push('sub.education_level = ?'); params.push(education_level); }

  const where = conditions.join(' AND ');

  const [rows] = await db.query(
    `SELECT s.id, s.subject_id, s.session_type, s.status, s.total_questions,
            s.answered_count, s.correct_count, s.score, s.started_at, s.completed_at,
            sub.name AS subject_name, sub.icon AS subject_icon, sub.education_level
     FROM edu_assessment_session s
     LEFT JOIN edu_subject sub ON s.subject_id = sub.id
     WHERE ${where}
     ORDER BY s.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(page_size), offset]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM edu_assessment_session s
     LEFT JOIN edu_subject sub ON s.subject_id = sub.id
     WHERE ${where}`,
    params
  );

  res.json({ list: rows, total: Number(total), page: Number(page), page_size: Number(page_size) });
});

// ===== AI总结单次评测效果 =====
router.post('/:session_id/ai-summary', auth, operLog('AI评测总结', 1), async (req, res) => {
  const { session_id } = req.params;

  // 验证会话归属
  const [[session]] = await db.query(
    `SELECT s.*, sub.name AS subject_name
     FROM edu_assessment_session s
     LEFT JOIN edu_subject sub ON s.subject_id = sub.id
     WHERE s.id = ? AND s.user_id = ? AND s.del_flag = 0`,
    [session_id, req.userId]
  );

  if (!session) return res.status(404).json({ error: '评测会话不存在' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.apiKey) {
    return res.status(400).json({ error: '请先在设置中配置AI API Key' });
  }

  // 获取答题记录
  const [answers] = await db.query(
    `SELECT ar.is_correct, ar.time_spent_ms,
            q.type AS question_type, q.difficulty,
            kn.name AS knowledge_name
     FROM edu_answer_record ar
     LEFT JOIN edu_question q ON ar.question_id = q.id
     LEFT JOIN edu_knowledge_node kn ON ar.knowledge_id = kn.id
     WHERE ar.session_id = ? AND ar.del_flag = 0`,
    [session_id]
  );

  // 获取错因分析
  const [errorAnalysis] = await db.query(
    `SELECT ea.error_type, COUNT(*) AS count
     FROM edu_error_analysis ea
     JOIN edu_answer_record ar ON ea.answer_id = ar.id
     WHERE ar.session_id = ? AND ea.del_flag = 0
     GROUP BY ea.error_type`,
    [session_id]
  );

  const errorTypeLabels = {
    careless: '粗心大意',
    concept: '概念模糊',
    method: '方法缺失',
    prerequisite: '前置知识缺失',
    unknown: '原因未知'
  };

  const errorStats = errorAnalysis.map(e =>
    `${errorTypeLabels[e.error_type] || e.error_type}: ${e.count}道`
  ).join('、');

  // 计算用时
  let duration = '未知';
  if (session.started_at && session.completed_at) {
    const ms = new Date(session.completed_at) - new Date(session.started_at);
    const minutes = Math.floor(ms / 60000);
    duration = `${minutes}分钟`;
  }

  const accuracy = session.answered_count > 0
    ? Math.round((session.correct_count / session.answered_count) * 100)
    : 0;

  const systemPrompt = `你是一位专业的教育评测分析专家，擅长分析学生的学习表现并给出针对性建议。
请基于评测数据，生成一份简洁的学习总结（100字以内）和改进建议（80字以内）。
总结要客观、具体，建议要切实可行。

严格以JSON格式返回：
{"summary": "总体表现总结", "suggestions": "具体改进建议"}`;

  const userPrompt = `学科：${session.subject_name}
评测类型：${session.session_type === 'adaptive' ? '自适应评测' : '知识点练习'}
答题数：${session.answered_count}/${session.total_questions}
正确率：${accuracy}%
得分：${session.score}分
用时：${duration}
${errorStats ? `错误分布：${errorStats}` : ''}

请分析该学生本次评测表现，给出总结和建议。`;

  const summaryRequestBody = {
    model: aiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 500
  };
  const summaryRequestTime = new Date();

  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(summaryRequestBody)
    });

    if (!response.ok) {
      recordAIRequest({
        userId: req.userId, businessType: 'assessment_ai_summary', businessId: session_id,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: summaryRequestBody,
        responseResult: null, requestTime: summaryRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return res.status(500).json({ error: 'AI服务调用失败' });
    }

    const result = await response.json();
    const rawResponse = result.choices?.[0]?.message?.content || '';
    recordAIRequest({
      userId: req.userId, businessType: 'assessment_ai_summary', businessId: session_id,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: summaryRequestBody,
      responseResult: result, requestTime: summaryRequestTime, responseTime: new Date(), status: 0
    });

    let summary = null;
    let suggestions = null;

    try {
      const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        summary = parsed.summary || null;
        suggestions = parsed.suggestions || null;
      }
    } catch (e) {
      // JSON解析失败，尝试直接使用原文
      summary = rawResponse;
    }

    res.json({
      success: true,
      summary: summary || '暂无总结',
      suggestions: suggestions || '继续保持练习'
    });
  } catch (e) {
    console.error('[AI评测总结]', e);
    recordAIRequest({
      userId: req.userId, businessType: 'assessment_ai_summary', businessId: session_id,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: summaryRequestBody,
      responseResult: null, requestTime: summaryRequestTime, responseTime: new Date(),
      status: 1, errorMsg: e.message
    });
    res.status(500).json({ error: 'AI总结生成失败' });
  }
});

module.exports = router;
