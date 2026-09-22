const express = require('express');
const db = require('../../db');
const auth = require('../../middleware/auth');

const router = express.Router();

// 掌握等级标签
const MASTERY_LABELS = ['未学', '了解', '理解', '应用', '精通'];

// ===== 获取自己的全量画像 =====
router.get('/me', auth, async (req, res) => {
  const { subject_id } = req.query;

  const conditions = ['sp.user_id = ?', 'sp.del_flag = 0'];
  const params = [req.userId];

  if (subject_id) {
    conditions.push('sp.subject_id = ?');
    params.push(subject_id);
  }

  const [profiles] = await db.query(
    `SELECT sp.id, sp.knowledge_id, sp.subject_id, sp.mastery_level, sp.mastery_score,
            sp.total_attempts, sp.correct_count, sp.avg_time_ms, sp.last_assessed_at,
            kn.name AS knowledge_name, kn.parent_id, kn.level AS kn_level,
            s.name AS subject_name, s.icon AS subject_icon
     FROM edu_student_profile sp
     LEFT JOIN edu_knowledge_node kn ON sp.knowledge_id = kn.id
     LEFT JOIN edu_subject s ON sp.subject_id = s.id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sp.subject_id ASC, sp.mastery_score DESC`,
    params
  );

  // 附加等级标签
  const result = profiles.map(p => ({
    ...p,
    mastery_label: MASTERY_LABELS[p.mastery_level] || '未知',
    accuracy_rate: p.total_attempts > 0
      ? Math.round(p.correct_count / p.total_attempts * 100)
      : null
  }));

  res.json(result);
});

// ===== 获取指定学科的知识点热力图数据 =====
router.get('/heatmap/:subject_id', auth, async (req, res) => {
  const { subject_id } = req.params;

  // 获取所有知识点（包含没有作答记录的）
  const [nodes] = await db.query(
    `SELECT id, parent_id, name, level AS kn_level, sort_order
     FROM edu_knowledge_node
     WHERE subject_id = ? AND del_flag = 0
     ORDER BY level ASC, sort_order ASC`,
    [subject_id]
  );

  // 获取当前用户的掌握情况
  const [profiles] = await db.query(
    `SELECT knowledge_id, mastery_level, mastery_score, total_attempts, correct_count
     FROM edu_student_profile
     WHERE user_id = ? AND subject_id = ? AND del_flag = 0`,
    [req.userId, subject_id]
  );

  const profileMap = {};
  for (const p of profiles) {
    profileMap[p.knowledge_id] = p;
  }

  // 合并数据
  const heatmapData = nodes.map(node => {
    const profile = profileMap[node.id] || null;
    return {
      id: node.id,
      parent_id: node.parent_id,
      name: node.name,
      level: node.kn_level,
      sort_order: node.sort_order,
      mastery_level: profile ? profile.mastery_level : 0,
      mastery_label: MASTERY_LABELS[profile ? profile.mastery_level : 0],
      mastery_score: profile ? parseFloat(profile.mastery_score) : 0,
      total_attempts: profile ? profile.total_attempts : 0,
      accuracy_rate: (profile && profile.total_attempts > 0)
        ? Math.round(profile.correct_count / profile.total_attempts * 100)
        : null
    };
  });

  res.json(heatmapData);
});

// ===== 获取各学科掌握度汇总（首页用）=====
router.get('/summary', auth, async (req, res) => {
  // 获取所有学科
  const [subjects] = await db.query(
    'SELECT id, name, code, icon FROM edu_subject WHERE del_flag = 0 ORDER BY sort_order ASC'
  );

  // 获取每个学科的知识点总数和已掌握数
  const summaries = [];
  for (const sub of subjects) {
    const [[{ total_nodes }]] = await db.query(
      'SELECT COUNT(*) AS total_nodes FROM edu_knowledge_node WHERE subject_id = ? AND del_flag = 0 AND level = 3',
      [sub.id]
    );

    const [[{ assessed, avg_score, mastered }]] = await db.query(
      `SELECT
         COUNT(*) AS assessed,
         ROUND(AVG(mastery_score), 1) AS avg_score,
         SUM(CASE WHEN mastery_level >= 2 THEN 1 ELSE 0 END) AS mastered
       FROM edu_student_profile
       WHERE user_id = ? AND subject_id = ? AND del_flag = 0`,
      [req.userId, sub.id]
    );

    // 获取最近一次该学科的评测
    const [lastSession] = await db.query(
      `SELECT id, score, completed_at, session_type
       FROM edu_assessment_session
       WHERE user_id = ? AND subject_id = ? AND status = 'completed' AND del_flag = 0
       ORDER BY completed_at DESC LIMIT 1`,
      [req.userId, sub.id]
    );

    summaries.push({
      subject_id: sub.id,
      subject_name: sub.name,
      subject_code: sub.code,
      subject_icon: sub.icon,
      total_knowledge_nodes: Number(total_nodes),
      assessed_count: Number(assessed),
      mastered_count: Number(mastered),
      avg_mastery_score: avg_score ? parseFloat(avg_score) : 0,
      progress_rate: Number(total_nodes) > 0
        ? Math.round(Number(assessed) / Number(total_nodes) * 100)
        : 0,
      last_session: lastSession[0] || null
    });
  }

  res.json(summaries);
});

module.exports = router;
