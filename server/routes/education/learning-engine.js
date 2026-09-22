/**
 * 自适应学习引擎路由 - learning-engine.js
 * 挂载路径：/api/edu/learning-engine
 *
 * API端点：
 *   GET  /today-plan/:subject_id       — 获取今日学习计划（缓存优先）
 *   POST /today-plan/:subject_id/refresh — 强制重新生成今日计划
 *   GET  /knowledge-graph/:subject_id  — 三维知识图谱数据
 *   GET  /recommend-questions/:subject_id — 推荐练习题
 *   POST /sync-3d-scores               — 批量同步三维得分（评测结束后调用）
 */

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../../db');
const auth    = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const { getAIConfig } = require('../settings');
const { recordAIRequest } = require('../../utils/aiLogger');
const { operLog } = require('../../logger');

// 所有端点均需登录
router.use(auth);

// ─────────────────────────────────────────────────────────────
// GET /today-plan/:subject_id  — 获取今日学习计划
// ─────────────────────────────────────────────────────────────
router.get('/today-plan/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    // 1. 查缓存（同用户同学科今日有效计划）
    const [cached] = await db.query(
      `SELECT * FROM edu_learning_plan
       WHERE user_id = ? AND subject_id = ? AND plan_date = CURDATE()
         AND plan_type = 'daily' AND is_stale = 0 AND del_flag = 0
       LIMIT 1`,
      [userId, subjectId]
    );

    if (cached.length > 0) {
      return res.json(formatPlanResponse(cached[0], true));
    }

    // 2. 未命中缓存 → 生成并缓存
    const plan = await generateAndCachePlan(userId, subjectId);
    if (!plan) {
      return res.status(404).json({ error: '暂无足够的学习数据，请先完成一次评测' });
    }
    return res.json(formatPlanResponse(plan, false));
  } catch (err) {
    console.error('[learning-engine] today-plan error:', err);
    res.status(500).json({ error: '获取学习计划失败：' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /today-plan/:subject_id/refresh  — 强制重新生成
// ─────────────────────────────────────────────────────────────
router.post('/today-plan/:subject_id/refresh', operLog('学习计划', 0), async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    // 标记旧计划为过期
    await db.query(
      `UPDATE edu_learning_plan SET is_stale = 1, updated_by = ?
       WHERE user_id = ? AND subject_id = ? AND plan_date = CURDATE()
         AND plan_type = 'daily' AND del_flag = 0`,
      [userId, userId, subjectId]
    );

    const plan = await generateAndCachePlan(userId, subjectId);
    if (!plan) {
      return res.status(404).json({ error: '暂无足够的学习数据，请先完成一次评测' });
    }
    return res.json(formatPlanResponse(plan, false));
  } catch (err) {
    console.error('[learning-engine] refresh error:', err);
    res.status(500).json({ error: '重新生成学习计划失败：' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /knowledge-graph/:subject_id  — 三维知识图谱数据
// ─────────────────────────────────────────────────────────────
router.get('/knowledge-graph/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;

  try {
    const [nodes] = await db.query(
      `SELECT
         kn.id, kn.parent_id, kn.name, kn.level, kn.sort_order,
         kn.difficulty, kn.prerequisite_ids,
         COALESCE(sp.mastery_score, 0)         AS mastery_score,
         COALESCE(sp.comprehension_score, 0)   AS comprehension_score,
         COALESCE(sp.memory_score, 0)          AS memory_score,
         COALESCE(sp.application_score, 0)     AS application_score,
         COALESCE(sp.mastery_level, 0)         AS mastery_level,
         COALESCE(sp.total_attempts, 0)        AS total_attempts,
         COALESCE(sp.correct_count, 0)         AS correct_count,
         sp.last_assessed_at
       FROM edu_knowledge_node kn
       LEFT JOIN edu_student_profile sp
         ON kn.id = sp.knowledge_id AND sp.user_id = ? AND sp.del_flag = 0
       WHERE kn.subject_id = ? AND kn.del_flag = 0
       ORDER BY kn.level ASC, kn.sort_order ASC`,
      [userId, subjectId]
    );

    // 计算各维度平均分（仅level=3叶子节点）
    const leafNodes = nodes.filter(n => n.level === 3);
    const avg = (key) => leafNodes.length
      ? (leafNodes.reduce((s, n) => s + parseFloat(n[key] || 0), 0) / leafNodes.length).toFixed(1)
      : 0;

    res.json({
      nodes,
      summary: {
        avg_mastery:       avg('mastery_score'),
        avg_comprehension: avg('comprehension_score'),
        avg_memory:        avg('memory_score'),
        avg_application:   avg('application_score'),
        total_nodes:       leafNodes.length,
        assessed_nodes:    leafNodes.filter(n => n.total_attempts > 0).length,
      }
    });
  } catch (err) {
    console.error('[learning-engine] knowledge-graph error:', err);
    res.status(500).json({ error: '获取知识图谱失败：' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /recommend-questions/:subject_id  — 推荐练习题
// ─────────────────────────────────────────────────────────────
router.get('/recommend-questions/:subject_id', async (req, res) => {
  const userId    = req.userId;
  const subjectId = req.params.subject_id;
  const count     = Math.min(parseInt(req.query.count) || 5, 10);

  try {
    // 1. 查薄弱知识点（mastery_score<60，前5个）
    const [weakNodes] = await db.query(
      `SELECT sp.knowledge_id, sp.mastery_score, kn.name
       FROM edu_student_profile sp
       LEFT JOIN edu_knowledge_node kn ON sp.knowledge_id = kn.id
       WHERE sp.user_id = ? AND sp.subject_id = ? AND sp.mastery_score < 60
         AND sp.del_flag = 0 AND kn.level = 3
       ORDER BY sp.mastery_score ASC
       LIMIT 5`,
      [userId, subjectId]
    );

    if (weakNodes.length === 0) {
      return res.json({ questions: [], source_knowledge: [], message: '暂无薄弱知识点，请先完成评测' });
    }

    const questions = [];
    const usedIds   = [];

    // 已做过的题目（近30天）
    const [doneRows] = await db.query(
      `SELECT question_id FROM edu_answer_record
       WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY) AND del_flag = 0`,
      [userId]
    );
    const doneIds = doneRows.map(r => r.question_id);

    for (const node of weakNodes) {
      if (questions.length >= count) break;

      const score      = parseFloat(node.mastery_score);
      const minDiff    = score < 30 ? 1 : 2;
      const maxDiff    = score < 30 ? 3 : 4;

      const excludeAll = [...doneIds, ...usedIds];
      const excludeSql = excludeAll.length > 0
        ? `AND q.id NOT IN (${excludeAll.map(() => '?').join(',')})`
        : '';

      const [rows] = await db.query(
        `SELECT q.id, q.content, q.type, q.difficulty, q.options_json,
                q.analysis, q.knowledge_id, kn.name AS knowledge_name
         FROM edu_question q
         LEFT JOIN edu_knowledge_node kn ON q.knowledge_id = kn.id
         WHERE q.subject_id = ? AND q.knowledge_id = ?
           AND q.difficulty BETWEEN ? AND ?
           AND q.del_flag = 0
           ${excludeSql}
         ORDER BY RAND() LIMIT 1`,
        [subjectId, node.knowledge_id, minDiff, maxDiff, ...excludeAll]
      );

      if (rows.length > 0) {
        usedIds.push(rows[0].id);
        questions.push({
          ...rows[0],
          options_json: safeParseJson(rows[0].options_json),
          mastery_score: score
        });
      }
    }

    res.json({
      questions,
      source_knowledge: weakNodes.map(n => ({
        id: n.knowledge_id,
        name: n.name,
        mastery_score: n.mastery_score
      }))
    });
  } catch (err) {
    console.error('[learning-engine] recommend-questions error:', err);
    res.status(500).json({ error: '获取推荐题目失败：' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /sync-3d-scores  — 批量同步三维得分（评测结束后调用）
// Body: { session_id }
// ─────────────────────────────────────────────────────────────
router.post('/sync-3d-scores', operLog('三维得分同步', 2), async (req, res) => {
  const userId    = req.userId;
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: '缺少 session_id 参数' });
  }

  try {
    // 验证session归属
    const [[session]] = await db.query(
      'SELECT id FROM edu_assessment_session WHERE id = ? AND user_id = ? AND del_flag = 0',
      [session_id, userId]
    );
    if (!session) {
      return res.status(403).json({ error: '无权访问该评测会话' });
    }

    // 查询所有答题记录（JOIN 题目获取 difficulty）
    const [records] = await db.query(
      `SELECT ar.knowledge_id, ar.is_correct, q.difficulty
       FROM edu_answer_record ar
       LEFT JOIN edu_question q ON ar.question_id = q.id
       WHERE ar.session_id = ? AND ar.del_flag = 0 AND ar.is_correct IS NOT NULL`,
      [session_id]
    );

    if (records.length === 0) {
      return res.json({ updated: 0, message: '本次评测无可同步数据' });
    }

    // 按 knowledge_id 分组，按 difficulty 分流三维得分
    const grouped = {};
    for (const r of records) {
      const kid = r.knowledge_id;
      if (!grouped[kid]) {
        grouped[kid] = { comprehension: [], memory: [], application: [] };
      }
      const diff = r.difficulty || 3;
      const dim  = diff <= 2 ? 'memory' : diff >= 4 ? 'application' : 'comprehension';
      grouped[kid][dim].push(r.is_correct === 1 ? 1 : 0);
    }

    let updated = 0;
    for (const [knowledgeId, dims] of Object.entries(grouped)) {
      // 查当前三维得分
      const [[profile]] = await db.query(
        `SELECT comprehension_score, memory_score, application_score
         FROM edu_student_profile
         WHERE user_id = ? AND knowledge_id = ? AND del_flag = 0`,
        [userId, knowledgeId]
      );
      if (!profile) continue;

      const calcNewScore = (current, results) => {
        let score = parseFloat(current);
        for (const isCorrect of results) {
          score = isCorrect ? Math.min(100, score + 5) : Math.max(0, score - 3);
        }
        return score.toFixed(2);
      };

      const newComp = dims.comprehension.length
        ? calcNewScore(profile.comprehension_score, dims.comprehension)
        : profile.comprehension_score;
      const newMem = dims.memory.length
        ? calcNewScore(profile.memory_score, dims.memory)
        : profile.memory_score;
      const newApp = dims.application.length
        ? calcNewScore(profile.application_score, dims.application)
        : profile.application_score;

      await db.query(
        `UPDATE edu_student_profile
         SET comprehension_score = ?, memory_score = ?, application_score = ?, updated_by = ?
         WHERE user_id = ? AND knowledge_id = ? AND del_flag = 0`,
        [newComp, newMem, newApp, userId, userId, knowledgeId]
      );
      updated++;
    }

    res.json({ updated, message: `已同步 ${updated} 个知识点的三维得分` });
  } catch (err) {
    console.error('[learning-engine] sync-3d-scores error:', err);
    res.status(500).json({ error: '同步三维得分失败：' + err.message });
  }
});

// ═════════════════════════════════════════════════════════════
// 内部辅助函数
// ═════════════════════════════════════════════════════════════

/**
 * 生成并缓存今日学习计划
 * @param {string} userId
 * @param {string} subjectId
 * @returns {object|null} 生成的计划记录
 */
async function generateAndCachePlan(userId, subjectId) {
  // ── Step 1：查学科名称 ──
  const [[subject]] = await db.query(
    'SELECT name FROM edu_subject WHERE id = ? AND del_flag = 0',
    [subjectId]
  );
  if (!subject) return null;

  // ── Step 2：查薄弱知识点（level=3 叶子节点，mastery_score < 60）──
  const [weakNodes] = await db.query(
    `SELECT sp.knowledge_id, sp.mastery_score,
            COALESCE(sp.comprehension_score, 0) AS comprehension_score,
            COALESCE(sp.memory_score, 0)        AS memory_score,
            COALESCE(sp.application_score, 0)   AS application_score,
            COALESCE(sp.total_attempts, 0)      AS total_attempts,
            kn.name, kn.prerequisite_ids, kn.difficulty
     FROM edu_student_profile sp
     LEFT JOIN edu_knowledge_node kn ON sp.knowledge_id = kn.id
     WHERE sp.user_id = ? AND sp.subject_id = ?
       AND sp.mastery_score < 60 AND sp.del_flag = 0 AND kn.level = 3
     ORDER BY sp.mastery_score ASC
     LIMIT 20`,
    [userId, subjectId]
  );

  if (weakNodes.length === 0) return null;

  // ── Step 3：检查前置依赖 ──
  const allPrereqIds = [];
  for (const node of weakNodes) {
    const prereqs = safeParseJson(node.prerequisite_ids, []);
    allPrereqIds.push(...prereqs);
  }

  let prereqScoreMap = {};
  if (allPrereqIds.length > 0) {
    const [prereqRows] = await db.query(
      `SELECT knowledge_id, mastery_score FROM edu_student_profile
       WHERE user_id = ? AND knowledge_id IN (?) AND del_flag = 0`,
      [userId, allPrereqIds]
    );
    prereqRows.forEach(r => { prereqScoreMap[r.knowledge_id] = parseFloat(r.mastery_score); });
  }

  // ── Step 4：计算优先级，选前5个 ──
  const scoredNodes = weakNodes.map(node => {
    const prereqs    = safeParseJson(node.prerequisite_ids, []);
    const prereqMet  = prereqs.every(pid => (prereqScoreMap[pid] || 0) >= 40);
    const prereqNames = prereqs
      .filter(pid => (prereqScoreMap[pid] || 0) < 40)
      .map(pid => pid);  // 简化：此处存ID，前端可不显示具体名称

    const priority = (60 - parseFloat(node.mastery_score)) * 1.0
      + (prereqMet ? 20 : 0)
      + (node.total_attempts > 0 ? 10 : 0);

    return { ...node, prereqMet, prereqNames, priorityScore: priority };
  });

  scoredNodes.sort((a, b) => b.priorityScore - a.priorityScore);
  const topNodes = scoredNodes.slice(0, 5);

  // ── Step 5：查近期错因摘要 ──
  const [errorRows] = await db.query(
    `SELECT error_type, COUNT(*) AS cnt
     FROM edu_error_analysis
     WHERE user_id = ? AND del_flag = 0
     ORDER BY created_at DESC
     LIMIT 10`,
    [userId]
  );
  // 按 error_type 聚合
  const errorCount = {};
  for (const row of errorRows) {
    errorCount[row.error_type] = (errorCount[row.error_type] || 0) + Number(row.cnt);
  }
  const errorTypeLabel = {
    careless: '粗心',
    concept: '概念模糊',
    method: '方法缺失',
    prerequisite: '前置缺失',
    unknown: '未知'
  };
  const errorSummary = Object.entries(errorCount)
    .map(([t, c]) => `${errorTypeLabel[t] || t}×${c}`)
    .join('、') || '暂无错因记录';

  // ── Step 6：构建三维薄弱快照 ──
  const weakByDim = (dimKey) => scoredNodes
    .filter(n => parseFloat(n[dimKey]) < 50)
    .slice(0, 5)
    .map(n => ({ id: n.knowledge_id, name: n.name, score: parseFloat(n[dimKey]) }));

  const weakComp  = weakByDim('comprehension_score');
  const weakMem   = weakByDim('memory_score');
  const weakApp   = weakByDim('application_score');

  // ── Step 7：AI 生成建议文本 ──
  let aiText = '';
  try {
    const aiConfig = await getAIConfig();
    if (aiConfig.enabled && aiConfig.apiKey) {
      const today    = new Date().toISOString().slice(0, 10);
      const nodeList = topNodes.map((n, i) => {
        const prereqNote = n.prereqMet
          ? '前置知识已具备'
          : `⚠️ 前置知识尚未完全掌握，建议先复习前置内容`;
        return `${i + 1}. ${n.name}（掌握度 ${parseFloat(n.mastery_score).toFixed(0)}分）\n   三维分析：理解 ${parseFloat(n.comprehension_score).toFixed(0)}分 / 记忆 ${parseFloat(n.memory_score).toFixed(0)}分 / 应用 ${parseFloat(n.application_score).toFixed(0)}分\n   ${prereqNote}`;
      }).join('\n');

      const userPrompt = `请为以下学生制定今日（${today}）${subject.name} 学习计划：\n\n【薄弱知识点（按优先级排序）】\n${nodeList}\n\n【近期错因摘要】\n${errorSummary}\n\n请按以下格式输出：\n📅 今日学习重点：[1句话概括]\n📌 各知识点建议：（每个知识点2句：问题诊断+学法建议）\n📚 学习资源推荐：（直接描述推荐的练习方向、例题类型等，无需真实链接）\n💪 今日目标：[完成后预期收获]`;

      const requestBody = {
        model: aiConfig.model,
        messages: [
          {
            role: 'system',
            content: '你是专业的个性化学习顾问，擅长根据学生知识掌握情况制定高效学习计划。请用中文回答，语气积极鼓励，像老师朋友一样温和耐心。不要使用markdown格式，直接纯文本输出，适当使用emoji让内容生动。总字数控制在400字以内，突出重点，实用可操作。'
          },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 600,
        temperature: 0.7
      };

      const requestTime = new Date();
      let response, responseData, aiStatus = 0, aiErrMsg = null;
      try {
        response = await fetch(aiConfig.apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${aiConfig.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        if (response.ok) {
          responseData = await response.json();
          aiText = responseData?.choices?.[0]?.message?.content || '';
        } else {
          aiStatus = 1;
          aiErrMsg = `HTTP ${response.status}`;
        }
      } catch (fetchErr) {
        aiStatus = 1;
        aiErrMsg = fetchErr.message;
      } finally {
        recordAIRequest({
          userId: userId,
          businessType: 'today_learning_plan',
          businessId: subjectId,
          requestUrl: aiConfig.apiUrl,
          requestModel: aiConfig.model,
          requestBody: requestBody,
          responseResult: responseData || aiText || null,
          status: aiStatus,
          errorMsg: aiErrMsg,
          requestTime: requestTime,
          responseTime: new Date()
        });
      }
    }
  } catch (aiErr) {
    console.warn('[learning-engine] AI调用失败，使用默认建议:', aiErr.message);
  }

  // AI未启用或失败时的默认建议
  if (!aiText) {
    aiText = `📅 今日学习重点：专注提升 ${subject.name} 薄弱知识点\n\n📌 各知识点建议：\n${topNodes.map((n, i) => `${i + 1}. ${n.name}（当前掌握度 ${parseFloat(n.mastery_score).toFixed(0)}分）：建议通过练习相关例题来加强理解，重点关注错误原因。`).join('\n')}\n\n📚 学习资源推荐：建议搜索各知识点的基础例题，从简单到复杂逐步练习。\n\n💪 今日目标：完成今日推荐题目，争取每个知识点掌握度提升5分以上。`;
  }

  // ── Step 8：写入缓存（ON DUPLICATE KEY UPDATE）──
  const planId = snowflake.nextId();
  const recommendedJson = JSON.stringify(topNodes.map(n => ({
    knowledge_id:         n.knowledge_id,
    name:                 n.name,
    priority:             topNodes.indexOf(n) + 1,
    mastery_score:        parseFloat(n.mastery_score),
    comprehension_score:  parseFloat(n.comprehension_score),
    memory_score:         parseFloat(n.memory_score),
    application_score:    parseFloat(n.application_score),
    prerequisite_met:     n.prereqMet,
    reason:               n.prereqMet
      ? `掌握度 ${parseFloat(n.mastery_score).toFixed(0)}分，需要加强`
      : `掌握度 ${parseFloat(n.mastery_score).toFixed(0)}分，且前置知识未完全掌握`,
    suggested_question_count: 3
  })));

  await db.query(
    `INSERT INTO edu_learning_plan
       (id, user_id, subject_id, plan_date, plan_type,
        recommended_nodes_json, ai_recommendation_text,
        weak_comprehension_json, weak_memory_json, weak_application_json,
        is_stale, generated_at, created_by)
     VALUES (?, ?, ?, CURDATE(), 'daily', ?, ?, ?, ?, ?, 0, NOW(3), ?)
     ON DUPLICATE KEY UPDATE
       recommended_nodes_json  = VALUES(recommended_nodes_json),
       ai_recommendation_text  = VALUES(ai_recommendation_text),
       weak_comprehension_json = VALUES(weak_comprehension_json),
       weak_memory_json        = VALUES(weak_memory_json),
       weak_application_json   = VALUES(weak_application_json),
       is_stale                = 0,
       generated_at            = VALUES(generated_at),
       updated_by              = VALUES(created_by)`,
    [
      planId, userId, subjectId,
      recommendedJson, aiText,
      JSON.stringify(weakComp), JSON.stringify(weakMem), JSON.stringify(weakApp),
      userId
    ]
  );

  // 查回刚写入的记录
  const [[newPlan]] = await db.query(
    `SELECT * FROM edu_learning_plan
     WHERE user_id = ? AND subject_id = ? AND plan_date = CURDATE()
       AND plan_type = 'daily' AND del_flag = 0`,
    [userId, subjectId]
  );
  return newPlan;
}

/**
 * 格式化计划响应
 */
function formatPlanResponse(plan, fromCache) {
  return {
    from_cache:             fromCache,
    plan_date:              plan.plan_date,
    subject_id:             plan.subject_id,
    recommended_nodes:      safeParseJson(plan.recommended_nodes_json, []),
    ai_recommendation_text: plan.ai_recommendation_text || '',
    weak_summary: {
      comprehension: safeParseJson(plan.weak_comprehension_json, []),
      memory:        safeParseJson(plan.weak_memory_json, []),
      application:   safeParseJson(plan.weak_application_json, [])
    },
    generated_at: plan.generated_at
  };
}

/**
 * 安全解析 JSON 字段（MySQL 可能返回字符串或对象）
 */
function safeParseJson(val, defaultVal = null) {
  if (val === null || val === undefined) return defaultVal;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return defaultVal;
  }
}

module.exports = router;
