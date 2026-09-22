/**
 * 学习数据智能分析路由 - analytics.js
 * 功能：实时学情看板、预警检测、错题本管理
 * 挂载路径：/api/edu/analytics
 */

'use strict';

const express  = require('express');
const router   = express.Router();
const db       = require('../../db');
const auth     = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const nextId = () => snowflake.nextId();
const { getAIConfig } = require('../settings');
const { operLog } = require('../../logger');

// 所有接口均需登录
router.use(auth);

// 艾宾浩斯复习间隔（天）
const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30];

// ============================================================
// 工具：调用 AI（非流式）
// ============================================================
async function callAI(systemPrompt, userPrompt, maxTokens = 500, temperature = 0.7) {
  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) return null;
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   }
        ],
        max_tokens:  maxTokens,
        temperature: temperature
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    return null;
  }
}

function extractJSON(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ============================================================
// ① 看板总览
// GET /api/edu/analytics/dashboard/:subject_id
// ============================================================
router.get('/dashboard/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    // 总评测次数 + 平均分
    const [[sessStats]] = await db.query(
      `SELECT COUNT(*) AS session_count, ROUND(AVG(score), 1) AS avg_score
       FROM edu_assessment_session
       WHERE user_id = ? AND subject_id = ? AND status = 'completed' AND del_flag = 0`,
      [userId, subjectId]
    );

    // 知识点总数（已评测）
    const [[profStats]] = await db.query(
      `SELECT COUNT(*) AS assessed_count,
              ROUND(AVG(mastery_score), 1) AS avg_mastery
       FROM edu_student_profile
       WHERE user_id = ? AND subject_id = ? AND total_attempts > 0 AND del_flag = 0`,
      [userId, subjectId]
    );

    // 近两次评测得分差（进步幅度）
    const [recentScores] = await db.query(
      `SELECT score FROM edu_assessment_session
       WHERE user_id = ? AND subject_id = ? AND status = 'completed' AND del_flag = 0
       ORDER BY completed_at DESC LIMIT 2`,
      [userId, subjectId]
    );
    let progress = null;
    if (recentScores.length === 2) {
      progress = parseFloat(recentScores[0].score) - parseFloat(recentScores[1].score);
      progress = Math.round(progress * 10) / 10;
    }

    // 错题数
    const [[wqStats]] = await db.query(
      `SELECT COUNT(*) AS wrong_count
       FROM edu_wrong_question
       WHERE user_id = ? AND subject_id = ? AND is_mastered = 0 AND del_flag = 0`,
      [userId, subjectId]
    );

    res.json({
      session_count:  Number(sessStats.session_count) || 0,
      avg_score:      sessStats.avg_score ? parseFloat(sessStats.avg_score) : null,
      assessed_count: Number(profStats.assessed_count) || 0,
      avg_mastery:    profStats.avg_mastery ? parseFloat(profStats.avg_mastery) : null,
      progress,
      wrong_count:    Number(wqStats.wrong_count) || 0
    });
  } catch (e) {
    console.error('[analytics/dashboard]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ② 近14天每日正确率趋势
// GET /api/edu/analytics/trend/daily/:subject_id
// ============================================================
router.get('/trend/daily/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    const [rows] = await db.query(
      `SELECT DATE(ar.created_at) AS day,
              ROUND(AVG(ar.is_correct) * 100, 1) AS accuracy_rate,
              COUNT(*) AS answer_count
       FROM edu_answer_record ar
       JOIN edu_question q ON ar.question_id = q.id
       WHERE ar.user_id = ? AND q.subject_id = ?
         AND ar.is_correct IS NOT NULL
         AND ar.created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
         AND ar.del_flag = 0
       GROUP BY DATE(ar.created_at)
       ORDER BY day ASC`,
      [userId, subjectId]
    );

    // 补全近14天（无数据的天填null）
    const result = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = rows.find(r => {
        const rDay = r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day).slice(0, 10);
        return rDay === key;
      });
      result.push({
        label: key.slice(5),  // MM-DD
        value: found ? parseFloat(found.accuracy_rate) : null,
        count: found ? Number(found.answer_count) : 0
      });
    }

    res.json({ data: result });
  } catch (e) {
    console.error('[analytics/trend/daily]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ③ 近10次评测得分趋势
// GET /api/edu/analytics/trend/sessions/:subject_id
// ============================================================
router.get('/trend/sessions/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    const [rows] = await db.query(
      `SELECT id, score, completed_at, session_type
       FROM edu_assessment_session
       WHERE user_id = ? AND subject_id = ? AND status = 'completed' AND del_flag = 0
       ORDER BY completed_at DESC LIMIT 10`,
      [userId, subjectId]
    );

    const data = rows.reverse().map((r, i) => ({
      label: `第${i + 1}次`,
      value: r.score ? parseFloat(r.score) : null,
      session_type: r.session_type,
      completed_at: r.completed_at
    }));

    res.json({ data });
  } catch (e) {
    console.error('[analytics/trend/sessions]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ④ 知识点热力图数据
// GET /api/edu/analytics/heatmap/:subject_id
// ============================================================
router.get('/heatmap/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    const [rows] = await db.query(
      `SELECT sp.knowledge_id, sp.mastery_level, sp.mastery_score,
              sp.total_attempts, sp.correct_count, sp.last_assessed_at,
              kn.name AS knowledge_name, kn.level AS node_level, kn.parent_id
       FROM edu_student_profile sp
       JOIN edu_knowledge_node kn ON sp.knowledge_id = kn.id
       WHERE sp.user_id = ? AND sp.subject_id = ? AND sp.del_flag = 0
         AND kn.del_flag = 0
       ORDER BY kn.sort_order ASC, kn.id ASC`,
      [userId, subjectId]
    );

    res.json({ list: rows });
  } catch (e) {
    console.error('[analytics/heatmap]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ⑤ 预警检测
// POST /api/edu/analytics/alert/check
// Body: { subject_id? }
// ============================================================
router.post('/alert/check', operLog('学情预警', 0), async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.body.subject_id || null;

  const alerts = [];

  try {
    // ─── 1. 停滞预警：近7天无答题记录 ───
    const [[{ recentCount }]] = await db.query(
      `SELECT COUNT(*) AS recentCount FROM edu_answer_record
       WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) AND del_flag = 0`,
      [userId]
    );

    if (Number(recentCount) === 0) {
      const notPushed = await checkAlertDedup(userId, 'stagnation', subjectId);
      if (notPushed) {
        await pushAlert(userId, 'stagnation', subjectId, { days: 7 });
        alerts.push('stagnation');
      }
    }

    // ─── 2. 下降预警：近3次评测得分连续递减 ───
    const [recentSessions] = await db.query(
      `SELECT score FROM edu_assessment_session
       WHERE user_id = ? ${subjectId ? 'AND subject_id = ?' : ''}
         AND status = 'completed' AND del_flag = 0
       ORDER BY completed_at DESC LIMIT 3`,
      subjectId ? [userId, subjectId] : [userId]
    );

    if (recentSessions.length === 3) {
      const scores = recentSessions.map(s => parseFloat(s.score));
      if (scores[0] < scores[1] && scores[1] < scores[2]) {
        const notPushed = await checkAlertDedup(userId, 'decline', subjectId);
        if (notPushed) {
          await pushAlert(userId, 'decline', subjectId, { scores: scores.reverse() });
          alerts.push('decline');
        }
      }
    }

    // ─── 3. 低正确率预警：近50题正确率 < 40% ───
    const [[{ lowAccuracy, lowTotal }]] = await db.query(
      `SELECT ROUND(AVG(is_correct) * 100, 1) AS lowAccuracy, COUNT(*) AS lowTotal
       FROM (
         SELECT is_correct FROM edu_answer_record
         WHERE user_id = ? AND is_correct IS NOT NULL AND del_flag = 0
         ORDER BY created_at DESC LIMIT 50
       ) t`,
      [userId]
    );

    if (Number(lowTotal) >= 10 && parseFloat(lowAccuracy) < 40) {
      const notPushed = await checkAlertDedup(userId, 'low_accuracy', subjectId);
      if (notPushed) {
        await pushAlert(userId, 'low_accuracy', subjectId, { accuracy: parseFloat(lowAccuracy) });
        alerts.push('low_accuracy');
      }
    }

    res.json({ alerts_sent: alerts, count: alerts.length });
  } catch (e) {
    console.error('[analytics/alert/check]', e);
    res.status(500).json({ error: '预警检测失败' });
  }
});

// 防重：同类型24小时内已推送则跳过（true=未推送，可推送）
async function checkAlertDedup(userId, alertType, subjectId) {
  const [[{ cnt }]] = await db.query(
    `SELECT COUNT(*) AS cnt FROM edu_alert_log
     WHERE user_id = ? AND alert_type = ?
       ${subjectId ? 'AND subject_id = ?' : 'AND subject_id IS NULL'}
       AND alerted_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    subjectId ? [userId, alertType, subjectId] : [userId, alertType]
  );
  return Number(cnt) === 0;
}

// 推送预警：写 edu_alert_log + sl_sys_notification
async function pushAlert(userId, alertType, subjectId, detail) {
  const alertId = nextId();
  await db.query(
    `INSERT INTO edu_alert_log (id, user_id, alert_type, subject_id, detail_json)
     VALUES (?, ?, ?, ?, ?)`,
    [alertId, userId, alertType, subjectId || null, JSON.stringify(detail)]
  );

  const msgMap = {
    stagnation:   '你已连续7天未进行练习，建议今日开始学习保持学习节奏！',
    decline:      '检测到你最近3次评测成绩连续下降，建议回顾薄弱知识点并加强练习。',
    low_accuracy: `最近答题正确率较低（${detail.accuracy || 0}%），建议放慢节奏，重点复习基础知识。`
  };
  const title = { stagnation: '学习停滞提醒', decline: '成绩下滑预警', low_accuracy: '正确率预警' }[alertType];
  const message = msgMap[alertType];

  try {
    const notifId = nextId();
    await db.query(
      `INSERT IGNORE INTO sl_sys_notification
         (id, user_id, type, title, message, related_id, stage, period, is_read)
       VALUES (?, ?, 'edu_alert', ?, ?, ?, 0, '', 0)`,
      [notifId, userId, title, message, alertId.toString()]
    );
  } catch (e) {
    // 忽略重复推送错误
  }
}

// ============================================================
// ⑥ AI补救练习包
// GET /api/edu/analytics/alert/remedy/:subject_id
// ============================================================
router.get('/alert/remedy/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    // 取最多5个薄弱知识点
    const [weakPoints] = await db.query(
      `SELECT sp.knowledge_id, sp.mastery_score, kn.name AS knowledge_name
       FROM edu_student_profile sp
       JOIN edu_knowledge_node kn ON sp.knowledge_id = kn.id
       WHERE sp.user_id = ? AND sp.subject_id = ? AND sp.mastery_score < 60 AND sp.del_flag = 0
       ORDER BY sp.mastery_score ASC LIMIT 5`,
      [userId, subjectId]
    );

    if (weakPoints.length === 0) {
      return res.json({ questions: [], message: '暂无薄弱知识点，继续保持！' });
    }

    const knowledgeIds = weakPoints.map(p => p.knowledge_id);

    // 每个薄弱知识点取1道题（排除近30天已做）
    const [questions] = await db.query(
      `SELECT q.id, q.content, q.type, q.difficulty, q.options_json, q.analysis,
              kn.name AS knowledge_name
       FROM edu_question q
       JOIN edu_knowledge_node kn ON q.knowledge_id = kn.id
       WHERE q.knowledge_id IN (?)
         AND q.del_flag = 0
         AND q.id NOT IN (
           SELECT question_id FROM edu_answer_record
           WHERE user_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND del_flag = 0
         )
       GROUP BY q.knowledge_id
       ORDER BY q.difficulty ASC
       LIMIT 5`,
      [knowledgeIds, userId]
    );

    res.json({ questions, weak_points: weakPoints });
  } catch (e) {
    console.error('[analytics/alert/remedy]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ⑦ 错题列表（分页）
// GET /api/edu/analytics/wrong-questions?page=1&page_size=10&subject_id=&error_type=
// ============================================================
router.get('/wrong-questions', async (req, res) => {
  const userId   = req.userId;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, parseInt(req.query.page_size) || 10);
  const offset   = (page - 1) * pageSize;
  const { subject_id, error_type } = req.query;

  const conditions = ['wq.user_id = ?', 'wq.del_flag = 0'];
  const params     = [userId];

  if (subject_id)  { conditions.push('wq.subject_id = ?');  params.push(subject_id); }
  if (error_type)  { conditions.push('wq.error_type = ?');  params.push(error_type); }
  const { source } = req.query;
  if (source)      { conditions.push('wq.source = ?');      params.push(source); }

  const where = conditions.join(' AND ');

  try {
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM edu_wrong_question wq WHERE ${where}`,
      params
    );

    const [list] = await db.query(
      `SELECT wq.id, wq.question_id, wq.knowledge_id, wq.subject_id,
              wq.error_type, wq.wrong_count, wq.last_wrong_at,
              wq.next_review_at, wq.review_stage, wq.is_mastered,
              wq.source, wq.manual_content, wq.manual_answer, wq.manual_type, wq.manual_image_url, wq.manual_options,
              q.content AS question_content, q.type AS question_type,
              q.options_json, q.answer AS correct_answer, q.analysis,
              q.difficulty,
              kn.name AS knowledge_name,
              sub.name AS subject_name, sub.icon AS subject_icon
       FROM edu_wrong_question wq
       LEFT JOIN edu_question q   ON wq.question_id = q.id
       LEFT JOIN edu_knowledge_node kn ON wq.knowledge_id = kn.id
       LEFT JOIN edu_subject sub  ON wq.subject_id = sub.id
       WHERE ${where}
       ORDER BY wq.last_wrong_at DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    res.json({ total: Number(total), page, page_size: pageSize, list });
  } catch (e) {
    console.error('[analytics/wrong-questions]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ⑧ 今日待复习错题
// GET /api/edu/analytics/wrong-questions/due
// ============================================================
router.get('/wrong-questions/due', async (req, res) => {
  const userId = req.userId;

  try {
    const [list] = await db.query(
      `SELECT wq.id, wq.question_id, wq.knowledge_id, wq.subject_id,
              wq.error_type, wq.wrong_count, wq.review_stage,
              wq.source, wq.manual_content, wq.manual_answer, wq.manual_type, wq.manual_image_url, wq.manual_options,
              q.content AS question_content, q.type AS question_type,
              q.options_json, q.answer AS correct_answer, q.analysis,
              kn.name AS knowledge_name,
              sub.name AS subject_name, sub.icon AS subject_icon
       FROM edu_wrong_question wq
       LEFT JOIN edu_question q   ON wq.question_id = q.id
       LEFT JOIN edu_knowledge_node kn ON wq.knowledge_id = kn.id
       LEFT JOIN edu_subject sub  ON wq.subject_id = sub.id
       WHERE wq.user_id = ? AND wq.is_mastered = 0 AND wq.del_flag = 0
         AND (wq.next_review_at IS NULL OR wq.next_review_at <= NOW())
       ORDER BY wq.next_review_at ASC
       LIMIT 20`,
      [userId]
    );

    res.json({ list, count: list.length });
  } catch (e) {
    console.error('[analytics/wrong-questions/due]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ⑨ 更新复习结果（答对/答错后更新遗忘曲线进度）
// POST /api/edu/analytics/wrong-questions/:id/reviewed
// Body: { is_correct: 0|1 }
// ============================================================
router.post('/wrong-questions/:id/reviewed', operLog('错题本', 2), async (req, res) => {
  const { id }      = req.params;
  const isCorrect   = req.body.is_correct === 1 || req.body.is_correct === true ? 1 : 0;
  const userId      = req.userId;

  try {
    const [[wq]] = await db.query(
      'SELECT id, review_stage, wrong_count FROM edu_wrong_question WHERE id = ? AND user_id = ? AND del_flag = 0',
      [id, userId]
    );
    if (!wq) return res.status(404).json({ error: '错题不存在' });

    let newStage = wq.review_stage;
    let isMastered = 0;

    if (isCorrect) {
      newStage = Math.min(5, newStage + 1);
      if (newStage >= 5) isMastered = 1;
    } else {
      newStage = Math.max(0, newStage - 1);
    }

    const intervalDays = REVIEW_INTERVALS[newStage] || 30;
    const nextReview = new Date();
    nextReview.setDate(nextReview.getDate() + intervalDays);

    await db.query(
      `UPDATE edu_wrong_question
       SET review_stage = ?, next_review_at = ?, is_mastered = ?
       WHERE id = ? AND user_id = ?`,
      [newStage, nextReview, isMastered, id, userId]
    );

    res.json({ success: true, review_stage: newStage, next_review_at: nextReview, is_mastered: isMastered });
  } catch (e) {
    console.error('[analytics/wrong-questions/reviewed]', e);
    res.status(500).json({ error: '更新失败' });
  }
});

// ============================================================
// ⑩ AI生成变式题（带缓存）
// POST /api/edu/analytics/wrong-questions/:id/variant
// ============================================================
router.post('/wrong-questions/:id/variant', operLog('错题变式', 0), async (req, res) => {
  const { id }  = req.params;
  const userId  = req.userId;

  try {
    const [[wq]] = await db.query(
      `SELECT wq.id, wq.variant_question_json,
              q.content AS question_content, q.type AS question_type,
              q.options_json, q.answer AS correct_answer,
              kn.name AS knowledge_name
       FROM edu_wrong_question wq
       LEFT JOIN edu_question q  ON wq.question_id = q.id
       LEFT JOIN edu_knowledge_node kn ON wq.knowledge_id = kn.id
       WHERE wq.id = ? AND wq.user_id = ? AND wq.del_flag = 0`,
      [id, userId]
    );
    if (!wq) return res.status(404).json({ error: '错题不存在' });

    // 有缓存直接返回
    if (wq.variant_question_json) {
      const cached = typeof wq.variant_question_json === 'string'
        ? JSON.parse(wq.variant_question_json)
        : wq.variant_question_json;
      return res.json({ variant: cached, from_cache: true });
    }

    const systemPrompt = `你是一位专业命题老师。根据原题生成一道变式题（改变数字/条件，保持相同知识点考察方向）。`;
    const userPrompt = `【原题】${wq.question_content}
【知识点】${wq.knowledge_name || '未知'}
【正确答案】${wq.correct_answer}

请生成一道同类型变式题，以JSON格式返回（不加代码块标记）：
{"content":"变式题题干","options_json":[{"key":"A","text":"..."},{"key":"B","text":"..."},{"key":"C","text":"..."},{"key":"D","text":"..."}],"answer":"A","analysis":"解析说明"}`;

    const aiText = await callAI(systemPrompt, userPrompt, 500, 0.8);
    const variant = extractJSON(aiText);

    if (variant && variant.content) {
      // 缓存到数据库
      await db.query(
        'UPDATE edu_wrong_question SET variant_question_json = ? WHERE id = ?',
        [JSON.stringify(variant), id]
      );
      res.json({ variant, from_cache: false });
    } else {
      res.json({ variant: null, message: 'AI生成失败，请稍后重试' });
    }
  } catch (e) {
    console.error('[analytics/wrong-questions/variant]', e);
    res.status(500).json({ error: '生成失败' });
  }
});

// ============================================================
// ⑪ 错题统计
// GET /api/edu/analytics/wrong-questions/stats
// ============================================================
router.get('/wrong-questions/stats', async (req, res) => {
  const userId = req.userId;

  try {
    // 按错因分布
    const [byType] = await db.query(
      `SELECT error_type, COUNT(*) AS count
       FROM edu_wrong_question
       WHERE user_id = ? AND del_flag = 0
       GROUP BY error_type ORDER BY count DESC`,
      [userId]
    );

    // 按学科分布
    const [bySubject] = await db.query(
      `SELECT wq.subject_id, sub.name AS subject_name, sub.icon AS subject_icon,
              COUNT(*) AS count,
              SUM(CASE WHEN wq.is_mastered = 1 THEN 1 ELSE 0 END) AS mastered_count
       FROM edu_wrong_question wq
       LEFT JOIN edu_subject sub ON wq.subject_id = sub.id
       WHERE wq.user_id = ? AND wq.del_flag = 0
       GROUP BY wq.subject_id`,
      [userId]
    );

    // 今日待复习数
    const [[{ due_count }]] = await db.query(
      `SELECT COUNT(*) AS due_count FROM edu_wrong_question
       WHERE user_id = ? AND is_mastered = 0 AND del_flag = 0
         AND (next_review_at IS NULL OR next_review_at <= NOW())`,
      [userId]
    );

    // 总计
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_mastered = 1 THEN 1 ELSE 0 END) AS mastered
       FROM edu_wrong_question WHERE user_id = ? AND del_flag = 0`,
      [userId]
    );

    res.json({
      total:          Number(totals.total) || 0,
      mastered:       Number(totals.mastered) || 0,
      due_count:      Number(due_count) || 0,
      by_error_type:  byType,
      by_subject:     bySubject
    });
  } catch (e) {
    console.error('[analytics/wrong-questions/stats]', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ⑫ 手动录入错题
// POST /api/edu/analytics/wrong-questions/manual
// ============================================================
router.post('/wrong-questions/manual', operLog('错题本手动录入', 1), async (req, res) => {
  const userId = req.userId;
  const {
    subject_id, knowledge_id,
    manual_content, manual_answer, manual_type,
    manual_image_url, manual_options,
    error_type
  } = req.body;

  if (!manual_content || !String(manual_content).trim()) {
    return res.status(400).json({ error: '题目内容不能为空' });
  }
  if (!subject_id) {
    return res.status(400).json({ error: '请选择学科' });
  }

  try {
    const id = nextId();
    const now = new Date();

    // 将 manual_options 转换为 JSON 字符串（如果存在）
    const optionsJson = manual_options ? JSON.stringify(manual_options) : null;

    await db.query(
      `INSERT INTO edu_wrong_question
         (id, user_id, question_id, knowledge_id, subject_id, error_type,
          wrong_count, last_wrong_at, next_review_at, review_stage, is_mastered,
          source, manual_content, manual_answer, manual_type, manual_image_url, manual_options,
          del_flag, created_by, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 1, ?, DATE_ADD(?, INTERVAL 1 DAY), 0, 0,
               'manual', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        id, userId,
        knowledge_id || null, subject_id,
        error_type || 'unknown',
        now, now,
        String(manual_content).trim(),
        manual_answer ? String(manual_answer).trim() : null,
        manual_type || 'subjective',
        manual_image_url || null,
        optionsJson,
        userId, now, now
      ]
    );
    res.json({ success: true, id: String(id) });
  } catch (e) {
    console.error('[analytics/wrong-questions/manual]', e);
    res.status(500).json({ error: '录入失败' });
  }
});

// ============================================================
// ⑬ 删除错题（仅手动录入的可删除）
// DELETE /api/edu/analytics/wrong-questions/:id
// ============================================================
router.delete('/wrong-questions/:id', operLog('错题本删除', 3), async (req, res) => {
  const userId = req.userId;
  try {
    const [rows] = await db.query(
      'SELECT id, source FROM edu_wrong_question WHERE id = ? AND user_id = ? AND del_flag = 0',
      [req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: '错题不存在' });
    if (rows[0].source !== 'manual') {
      return res.status(400).json({ error: '系统评测错题不可手动删除' });
    }
    await db.query(
      'UPDATE edu_wrong_question SET del_flag = 1 WHERE id = ?',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[analytics/wrong-questions/delete]', e);
    res.status(500).json({ error: '删除失败' });
  }
});

module.exports = router;
