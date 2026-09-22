const express = require('express');
const db = require('../../db');
const auth = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const { getAIConfig } = require('../settings');
const { operLog } = require('../../logger');
const { recordAIRequest } = require('../../utils/aiLogger');

const router = express.Router();

// 错因类型标签
const ERROR_TYPE_LABELS = {
  careless:     '粗心大意',
  concept:      '概念模糊',
  method:       '方法缺失',
  prerequisite: '前置知识缺失',
  unknown:      '原因未知'
};

// ===== 对某次评测的错题批量AI分析错因 =====
router.post('/session/:session_id', auth, operLog('错因分析', 1), async (req, res) => {
  const { session_id } = req.params;

  // 验证会话归属
  const [sessionRows] = await db.query(
    `SELECT s.*, sub.name AS subject_name
     FROM edu_assessment_session s
     LEFT JOIN edu_subject sub ON s.subject_id = sub.id
     WHERE s.id = ? AND s.user_id = ? AND s.del_flag = 0`,
    [session_id, req.userId]
  );
  if (sessionRows.length === 0) return res.status(404).json({ error: '评测会话不存在' });
  const session = sessionRows[0];

  // 获取错题列表（is_correct = 0）
  const [wrongAnswers] = await db.query(
    `SELECT ar.id AS answer_id, ar.user_answer, ar.time_spent_ms,
            q.id AS question_id, q.content AS question_content, q.type AS question_type,
            q.answer AS correct_answer, q.difficulty, q.options_json,
            kn.id AS knowledge_id, kn.name AS knowledge_name,
            kn.prerequisite_ids
     FROM edu_answer_record ar
     LEFT JOIN edu_question q ON ar.question_id = q.id
     LEFT JOIN edu_knowledge_node kn ON ar.knowledge_id = kn.id
     WHERE ar.session_id = ? AND ar.is_correct = 0 AND ar.del_flag = 0`,
    [session_id]
  );

  if (wrongAnswers.length === 0) {
    return res.json({ success: true, message: '本次评测没有错题，表现优秀！', analyses: [] });
  }

  const aiConfig = await getAIConfig();
  if (!aiConfig.apiKey) {
    return res.status(400).json({ error: '请先在设置中配置AI API Key' });
  }

  const analyses = [];

  for (const wa of wrongAnswers) {
    // 检查是否已分析过，避免重复
    const [existing] = await db.query(
      'SELECT id FROM edu_error_analysis WHERE answer_id = ? AND del_flag = 0',
      [wa.answer_id]
    );
    if (existing.length > 0) {
      const [existRows] = await db.query(
        'SELECT * FROM edu_error_analysis WHERE answer_id = ? AND del_flag = 0 LIMIT 1',
        [wa.answer_id]
      );
      analyses.push({
        answer_id: wa.answer_id,
        question_id: wa.question_id,
        knowledge_id: wa.knowledge_id,
        knowledge_name: wa.knowledge_name,
        error_type: existRows[0].error_type,
        error_type_label: ERROR_TYPE_LABELS[existRows[0].error_type] || existRows[0].error_type,
        error_detail: existRows[0].error_detail,
        suggestion: existRows[0].suggestion,
        from_cache: true
      });
      continue;
    }

    // 准备AI分析提示词
    const options = wa.options_json
      ? (typeof wa.options_json === 'string' ? JSON.parse(wa.options_json) : wa.options_json)
          .map(o => `${o.key}. ${o.text}`).join('\n')
      : null;

    const systemPrompt = `你是一位专业的教育诊断专家，擅长分析学生答题错误原因。
请分析学生的答题错误，判断错误类型并给出针对性建议。

错误类型定义：
- careless（粗心大意）：学生可能已掌握知识，但因粗心、计算错误或书写失误导致答错
- concept（概念模糊）：学生对知识点的定义、概念或性质理解不准确
- method（方法缺失）：学生不知道解题方法、步骤或技巧
- prerequisite（前置知识缺失）：学生缺乏解此题所需的前置知识，导致根本无法正确作答
- unknown（原因未知）：根据现有信息无法判断具体原因

请严格以JSON格式返回，不要添加任何额外说明：
{"error_type": "类型代码", "detail": "详细分析（1-2句话）", "suggestion": "针对性改进建议（1-2句话）"}`;

    const userPrompt = `学科：${session.subject_name}
知识点：${wa.knowledge_name}
题目难度：${wa.difficulty}/5
题目类型：${wa.question_type}

题目内容：
${wa.question_content}
${options ? '\n选项：\n' + options : ''}

正确答案：${wa.correct_answer}
学生作答：${wa.user_answer}
作答耗时：${wa.time_spent_ms ? Math.round(wa.time_spent_ms / 1000) + '秒' : '未记录'}

请分析该学生的答题错误原因。`;

    const eaRequestBody = {
      model: aiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 400
    };
    const eaRequestTime = new Date();

    try {
      const response = await fetch(aiConfig.apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${aiConfig.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(eaRequestBody)
      });

      let errorType = 'unknown';
      let errorDetail = null;
      let suggestion = null;
      let rawResponse = null;

      if (response.ok) {
        const result = await response.json();
        rawResponse = result.choices?.[0]?.message?.content || '';
        recordAIRequest({
          userId: req.userId, businessType: 'error_analysis', businessId: wa.answer_id,
          requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: eaRequestBody,
          responseResult: result, requestTime: eaRequestTime, responseTime: new Date(), status: 0
        });

        try {
          const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            errorType = parsed.error_type in ERROR_TYPE_LABELS ? parsed.error_type : 'unknown';
            errorDetail = parsed.detail || null;
            suggestion = parsed.suggestion || null;
          }
        } catch {
          // JSON解析失败，使用默认值
        }
      } else {
        recordAIRequest({
          userId: req.userId, businessType: 'error_analysis', businessId: wa.answer_id,
          requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: eaRequestBody,
          responseResult: null, requestTime: eaRequestTime, responseTime: new Date(),
          status: 1, errorMsg: `HTTP ${response.status}`
        });
      }

      // 保存分析结果
      const analysisId = snowflake.nextId();
      await db.query(
        `INSERT INTO edu_error_analysis
         (id, user_id, answer_id, question_id, knowledge_id, error_type, error_detail,
          suggestion, ai_raw_response, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [analysisId, req.userId, wa.answer_id, wa.question_id, wa.knowledge_id,
         errorType, errorDetail, suggestion, rawResponse, req.userId]
      );

      analyses.push({
        answer_id: wa.answer_id,
        question_id: wa.question_id,
        knowledge_id: wa.knowledge_id,
        knowledge_name: wa.knowledge_name,
        question_content: wa.question_content,
        user_answer: wa.user_answer,
        correct_answer: wa.correct_answer,
        error_type: errorType,
        error_type_label: ERROR_TYPE_LABELS[errorType],
        error_detail: errorDetail,
        suggestion,
        from_cache: false
      });
    } catch (e) {
      console.error('[错因分析] AI调用失败:', e.message);
      recordAIRequest({
        userId: req.userId, businessType: 'error_analysis', businessId: wa.answer_id,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: eaRequestBody,
        responseResult: null, requestTime: eaRequestTime, responseTime: new Date(),
        status: 1, errorMsg: e.message
      });
      analyses.push({
        answer_id: wa.answer_id,
        question_id: wa.question_id,
        knowledge_id: wa.knowledge_id,
        knowledge_name: wa.knowledge_name,
        error_type: 'unknown',
        error_type_label: ERROR_TYPE_LABELS.unknown,
        error_detail: 'AI分析暂时不可用',
        suggestion: null,
        from_cache: false
      });
    }
  }

  res.json({ success: true, session_id, analyses });
});

// ===== 获取我的历史错因汇总 =====
router.get('/me', auth, async (req, res) => {
  const { knowledge_id, error_type, education_level, subject_id, page = 1, page_size = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  const conditions = ['ea.user_id = ?', 'ea.del_flag = 0'];
  const params = [req.userId];

  if (knowledge_id) { conditions.push('ea.knowledge_id = ?'); params.push(knowledge_id); }
  if (error_type) { conditions.push('ea.error_type = ?'); params.push(error_type); }
  if (education_level) { conditions.push('s.education_level = ?'); params.push(education_level); }
  if (subject_id) { conditions.push('s.id = ?'); params.push(subject_id); }

  const where = conditions.join(' AND ');

  const [rows] = await db.query(
    `SELECT ea.id, ea.error_type, ea.error_detail, ea.suggestion, ea.created_at,
            q.content AS question_content, q.type AS question_type, q.difficulty, q.options_json,
            ar.user_answer, q.answer AS correct_answer,
            kn.name AS knowledge_name, kn.id AS knowledge_id,
            s.name AS subject_name, s.icon AS subject_icon, s.education_level
     FROM edu_error_analysis ea
     LEFT JOIN edu_answer_record ar ON ea.answer_id = ar.id
     LEFT JOIN edu_question q ON ea.question_id = q.id
     LEFT JOIN edu_knowledge_node kn ON ea.knowledge_id = kn.id
     LEFT JOIN edu_subject s ON kn.subject_id = s.id
     WHERE ${where}
     ORDER BY ea.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(page_size), offset]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total
     FROM edu_error_analysis ea
     LEFT JOIN edu_knowledge_node kn ON ea.knowledge_id = kn.id
     LEFT JOIN edu_subject s ON kn.subject_id = s.id
     WHERE ${where}`,
    params
  );

  // 附加标签
  const result = rows.map(r => ({
    ...r,
    error_type_label: ERROR_TYPE_LABELS[r.error_type] || r.error_type
  }));

  // 错因类型分布统计
  const [[typeStats]] = await db.query(
    `SELECT
       SUM(CASE WHEN error_type = 'careless' THEN 1 ELSE 0 END) AS careless,
       SUM(CASE WHEN error_type = 'concept' THEN 1 ELSE 0 END) AS concept,
       SUM(CASE WHEN error_type = 'method' THEN 1 ELSE 0 END) AS method,
       SUM(CASE WHEN error_type = 'prerequisite' THEN 1 ELSE 0 END) AS prerequisite,
       SUM(CASE WHEN error_type = 'unknown' THEN 1 ELSE 0 END) AS unknown,
       COUNT(*) AS total_errors
     FROM edu_error_analysis
     WHERE user_id = ? AND del_flag = 0`,
    [req.userId]
  ) || [{}];

  res.json({
    list: result,
    total: Number(total),
    page: Number(page),
    page_size: Number(page_size),
    type_stats: typeStats || {}
  });
});

module.exports = router;
