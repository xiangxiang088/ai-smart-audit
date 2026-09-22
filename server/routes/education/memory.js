/**
 * 长期记忆与成长记录路由 - memory.js
 * 功能：成长时间轴、日历热力图、掌握度趋势、AI历史搜索、全局统计
 * 挂载路径：/api/edu/memory
 */

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../../db');
const auth    = require('../../middleware/auth');

// 所有接口均需登录
router.use(auth);

// ============================================================
// 工具：计算日历格子强度（0-4）
// ============================================================
function calcIntensity(count) {
  if (!count || count === 0) return 0;
  if (count <= 5)  return 1;
  if (count <= 15) return 2;
  if (count <= 30) return 3;
  return 4;
}

// ============================================================
// GET /timeline/daily?days=180
// 近 N 天每日学习摘要（日历热力图数据）
// ============================================================
router.get('/timeline/daily', async (req, res) => {
  const userId = req.userId;
  const days   = Math.min(parseInt(req.query.days) || 180, 365);

  const [rows] = await db.query(
    `SELECT
       DATE(created_at)             AS day,
       COUNT(*)                     AS answer_count,
       ROUND(AVG(is_correct)*100,1) AS accuracy_rate
     FROM edu_answer_record
     WHERE user_id = ? AND del_flag = 0
       AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(created_at)
     ORDER BY day ASC`,
    [userId, days]
  );

  const data = rows.map(r => ({
    date:          r.day instanceof Date
                     ? r.day.toISOString().slice(0, 10)
                     : String(r.day),
    answer_count:  r.answer_count,
    accuracy_rate: r.accuracy_rate,
    intensity:     calcIntensity(r.answer_count)
  }));

  res.json({ data });
});

// ============================================================
// GET /timeline/day-detail/:date
// 某天所有学习事件详情（YYYY-MM-DD）
// ============================================================
router.get('/timeline/day-detail/:date', async (req, res) => {
  const userId = req.userId;
  const date   = req.params.date;

  // 校验日期格式
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '日期格式错误，请使用 YYYY-MM-DD' });
  }

  // 评测会话
  const [sessions] = await db.query(
    `SELECT s.id, s.session_type, s.score, s.total_questions, s.correct_count,
            sub.name AS subject_name
     FROM edu_assessment_session s
     LEFT JOIN edu_subject sub ON sub.id = s.subject_id
     WHERE s.user_id = ? AND DATE(s.completed_at) = ? AND s.status = 'completed'
     ORDER BY s.completed_at DESC`,
    [userId, date]
  );

  // 问答会话（取当天更新的）
  const [chatSessions] = await db.query(
    `SELECT cs.id, cs.title, cs.message_count, cs.session_type,
            sub.name AS subject_name
     FROM edu_chat_session cs
     LEFT JOIN edu_subject sub ON sub.id = cs.subject_id
     WHERE cs.user_id = ? AND DATE(cs.updated_at) = ? AND cs.del_flag = 0
     ORDER BY cs.updated_at DESC`,
    [userId, date]
  );

  // 口语评测
  const [oralRecords] = await db.query(
    `SELECT or_.id, or_.overall_score, or_.accuracy_score, or_.fluency_score,
            or_.completeness_score, or_.original_text,
            sub.name AS subject_name
     FROM edu_oral_record or_
     LEFT JOIN edu_subject sub ON sub.id = or_.subject_id
     WHERE or_.user_id = ? AND DATE(or_.created_at) = ? AND or_.del_flag = 0
     ORDER BY or_.created_at DESC`,
    [userId, date]
  );

  // 答题统计（按知识点聚合）
  const [answerStats] = await db.query(
    `SELECT
       kn.name  AS knowledge_name,
       sub.name AS subject_name,
       COUNT(*) AS total,
       SUM(ar.is_correct) AS correct
     FROM edu_answer_record ar
     LEFT JOIN edu_knowledge_node kn  ON kn.id  = ar.knowledge_id
     LEFT JOIN edu_subject         sub ON sub.id = kn.subject_id
     WHERE ar.user_id = ? AND DATE(ar.created_at) = ? AND ar.del_flag = 0
     GROUP BY ar.knowledge_id, kn.name, sub.name
     ORDER BY total DESC
     LIMIT 20`,
    [userId, date]
  );

  // 当天答题总计
  const [totals] = await db.query(
    `SELECT COUNT(*) AS total, SUM(is_correct) AS correct
     FROM edu_answer_record
     WHERE user_id = ? AND DATE(created_at) = ? AND del_flag = 0`,
    [userId, date]
  );

  res.json({
    date,
    summary: {
      total_answers: totals[0]?.total || 0,
      correct:       totals[0]?.correct || 0
    },
    assessment_sessions: sessions,
    chat_sessions:       chatSessions,
    oral_records:        oralRecords,
    answer_stats:        answerStats
  });
});

// ============================================================
// GET /timeline/mastery-trend/:subject_id?days=90
// 近 N 天掌握度趋势（折线图，实时计算）
// ============================================================
router.get('/timeline/mastery-trend/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;
  const days      = Math.min(parseInt(req.query.days) || 90, 180);

  const [rows] = await db.query(
    `SELECT
       DATE(last_assessed_at)         AS day,
       ROUND(AVG(mastery_score), 1)   AS avg_mastery
     FROM edu_student_profile
     WHERE user_id = ? AND subject_id = ? AND del_flag = 0
       AND last_assessed_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(last_assessed_at)
     ORDER BY day ASC`,
    [userId, subjectId, days]
  );

  const data = rows.map(r => ({
    date:        r.day instanceof Date
                   ? r.day.toISOString().slice(0, 10)
                   : String(r.day),
    avg_mastery: r.avg_mastery
  }));

  res.json({ subject_id: subjectId, data });
});

// ============================================================
// GET /history/search?q=&type=&subject_id=&page=&page_size=
// AI交互统一历史搜索（问答 + 口语，混合排序）
// ============================================================
router.get('/history/search', async (req, res) => {
  const userId    = req.userId;
  const q         = (req.query.q || '').trim();
  const type      = req.query.type || '';        // 'qa' | 'oral' | ''
  const subjectId = req.query.subject_id || '';
  const page      = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize  = Math.min(20, Math.max(1, parseInt(req.query.page_size) || 10));
  const offset    = (page - 1) * pageSize;

  // 构建问答记录查询（取 role='user' 的第一条消息作为摘要）
  let qaRows = [], oralRows = [];

  if (!type || type === 'qa') {
    const qaParams = [userId];
    let qaWhere = 'cs.user_id = ? AND cs.del_flag = 0';

    if (subjectId) {
      qaWhere += ' AND cs.subject_id = ?';
      qaParams.push(subjectId);
    }
    if (q) {
      qaWhere += ' AND (cs.title LIKE ? OR cm.content LIKE ?)';
      qaParams.push(`%${q}%`, `%${q}%`);
    }

    const [rows] = await db.query(
      `SELECT
         cs.id, 'qa' AS type,
         cs.subject_id,
         sub.name   AS subject_name,
         cs.title   AS preview,
         cs.message_count,
         cs.updated_at AS event_at,
         NULL AS score
       FROM edu_chat_session cs
       LEFT JOIN edu_subject sub ON sub.id = cs.subject_id
       ${q ? 'LEFT JOIN edu_chat_message cm ON cm.session_id = cs.id AND cm.role = \'user\'' : ''}
       WHERE ${qaWhere}
       GROUP BY cs.id
       ORDER BY cs.updated_at DESC
       LIMIT 200`,
      qaParams
    );
    qaRows = rows;
  }

  if (!type || type === 'oral') {
    const oralParams = [userId];
    let oralWhere = 'or_.user_id = ? AND or_.del_flag = 0';

    if (subjectId) {
      oralWhere += ' AND or_.subject_id = ?';
      oralParams.push(subjectId);
    }
    if (q) {
      oralWhere += ' AND (or_.original_text LIKE ? OR or_.transcribed_text LIKE ?)';
      oralParams.push(`%${q}%`, `%${q}%`);
    }

    const [rows] = await db.query(
      `SELECT
         or_.id, 'oral' AS type,
         or_.subject_id,
         sub.name       AS subject_name,
         SUBSTRING(or_.original_text, 1, 80) AS preview,
         NULL           AS message_count,
         or_.created_at AS event_at,
         or_.overall_score AS score
       FROM edu_oral_record or_
       LEFT JOIN edu_subject sub ON sub.id = or_.subject_id
       WHERE ${oralWhere}
       ORDER BY or_.created_at DESC
       LIMIT 200`,
      oralParams
    );
    oralRows = rows;
  }

  // 合并并按时间倒序排列
  const combined = [...qaRows, ...oralRows].sort(
    (a, b) => new Date(b.event_at) - new Date(a.event_at)
  );

  const total   = combined.length;
  const items   = combined.slice(offset, offset + pageSize).map(r => ({
    id:            String(r.id),
    type:          r.type,
    subject_id:    r.subject_id ? String(r.subject_id) : null,
    subject_name:  r.subject_name || null,
    preview:       r.preview || '',
    message_count: r.message_count || null,
    score:         r.score != null ? Number(r.score) : null,
    event_at:      r.event_at instanceof Date
                     ? r.event_at.toISOString()
                     : String(r.event_at)
  }));

  res.json({
    total,
    page,
    page_size: pageSize,
    pages:     Math.ceil(total / pageSize),
    items
  });
});

// ============================================================
// GET /stats/overview
// 全局学习统计（总天数、连续天数、总答题数、已掌握知识点数）
// ============================================================
router.get('/stats/overview', async (req, res) => {
  const userId = req.userId;

  // 总答题数
  const [[answerRow]] = await db.query(
    `SELECT COUNT(*) AS total FROM edu_answer_record WHERE user_id = ? AND del_flag = 0`,
    [userId]
  );

  // 有学习记录的总天数
  const [[dayRow]] = await db.query(
    `SELECT COUNT(DISTINCT DATE(created_at)) AS total_days
     FROM edu_answer_record
     WHERE user_id = ? AND del_flag = 0`,
    [userId]
  );

  // 已掌握知识点数（mastery_level = 4 即精通）
  const [[masteredRow]] = await db.query(
    `SELECT COUNT(*) AS mastered
     FROM edu_student_profile
     WHERE user_id = ? AND mastery_level = 4 AND del_flag = 0`,
    [userId]
  );

  // 连续学习天数（从今天倒推，查近60天）
  const [streakDays] = await db.query(
    `SELECT DATE(created_at) AS day
     FROM edu_answer_record
     WHERE user_id = ? AND del_flag = 0
       AND created_at >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
     GROUP BY DATE(created_at)
     ORDER BY day DESC`,
    [userId]
  );

  let streak = 0;
  const checkDate = new Date();
  checkDate.setHours(0, 0, 0, 0);

  for (const row of streakDays) {
    const d = new Date(row.day);
    d.setHours(0, 0, 0, 0);
    const diffDays = Math.round((checkDate - d) / 86400000);
    if (diffDays <= 1) {
      streak++;
      checkDate.setTime(d.getTime());
    } else {
      break;
    }
  }

  res.json({
    total_answers:    answerRow.total || 0,
    total_days:       dayRow.total_days || 0,
    streak_days:      streak,
    mastered_count:   masteredRow.mastered || 0
  });
});

module.exports = router;
