const express = require('express');
const db = require('../../db');
const auth = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const { getAIConfig } = require('../settings');
const { operLog } = require('../../logger');
const { recordAIRequest } = require('../../utils/aiLogger');

const router = express.Router();

// ===== 管理员：获取题目列表（含筛选）=====
router.get('/admin/questions', auth, auth.requireAdmin, async (req, res) => {
  const { subject_id, knowledge_id, difficulty, type, page = 1, page_size = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(page_size);

  const conditions = ['q.del_flag = 0'];
  const params = [];

  if (subject_id) { conditions.push('q.subject_id = ?'); params.push(subject_id); }
  if (knowledge_id) { conditions.push('q.knowledge_id = ?'); params.push(knowledge_id); }
  if (difficulty) { conditions.push('q.difficulty = ?'); params.push(Number(difficulty)); }
  if (type) { conditions.push('q.type = ?'); params.push(type); }

  const where = conditions.join(' AND ');

  const [rows] = await db.query(
    `SELECT q.id, q.subject_id, q.knowledge_id, q.type, q.difficulty,
            q.content, q.options_json, q.answer, q.analysis, q.tags, q.source,
            q.created_at, kn.name AS knowledge_name, s.name AS subject_name
     FROM edu_question q
     LEFT JOIN edu_knowledge_node kn ON q.knowledge_id = kn.id
     LEFT JOIN edu_subject s ON q.subject_id = s.id
     WHERE ${where}
     ORDER BY q.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(page_size), offset]
  );

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM edu_question q WHERE ${where}`,
    params
  );

  res.json({ list: rows, total: Number(total), page: Number(page), page_size: Number(page_size) });
});

// ===== 管理员：新增题目 =====
router.post('/admin/questions', auth, auth.requireAdmin, operLog('题目管理', 1), async (req, res) => {
  const { subject_id, knowledge_id, type, difficulty = 3, content, options_json, answer, analysis, tags, source } = req.body;
  if (!subject_id || !knowledge_id || !type || !content || !answer) {
    return res.status(400).json({ error: '学科ID、知识点ID、题型、题干和答案不能为空' });
  }
  if (!['single', 'multi', 'fill', 'subjective'].includes(type)) {
    return res.status(400).json({ error: '题型无效，只支持 single/multi/fill/subjective' });
  }
  if (type === 'single' || type === 'multi') {
    if (!options_json || !Array.isArray(options_json) || options_json.length < 2) {
      return res.status(400).json({ error: '选择题至少需要2个选项' });
    }
  }

  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO edu_question
     (id, subject_id, knowledge_id, type, difficulty, content, options_json, answer, analysis, tags, source, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, subject_id, knowledge_id, type, difficulty, content,
     options_json ? JSON.stringify(options_json) : null,
     answer, analysis || null,
     tags ? JSON.stringify(tags) : null,
     source || null, req.userId]
  );
  res.json({ success: true, id: id.toString() });
});

// ===== 管理员：修改题目 =====
router.put('/admin/questions/:id', auth, auth.requireAdmin, operLog('题目管理', 2), async (req, res) => {
  const { id } = req.params;
  const { type, difficulty, content, options_json, answer, analysis, tags, source } = req.body;

  const [rows] = await db.query(
    'SELECT id FROM edu_question WHERE id = ? AND del_flag = 0', [id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '题目不存在' });

  const fields = [];
  const values = [];

  if (type !== undefined) { fields.push('type = ?'); values.push(type); }
  if (difficulty !== undefined) { fields.push('difficulty = ?'); values.push(difficulty); }
  if (content !== undefined) { fields.push('content = ?'); values.push(content); }
  if (options_json !== undefined) { fields.push('options_json = ?'); values.push(options_json ? JSON.stringify(options_json) : null); }
  if (answer !== undefined) { fields.push('answer = ?'); values.push(answer); }
  if (analysis !== undefined) { fields.push('analysis = ?'); values.push(analysis); }
  if (tags !== undefined) { fields.push('tags = ?'); values.push(tags ? JSON.stringify(tags) : null); }
  if (source !== undefined) { fields.push('source = ?'); values.push(source); }
  if (fields.length === 0) return res.status(400).json({ error: '没有要修改的字段' });

  fields.push('updated_by = ?');
  values.push(req.userId);
  values.push(id);

  await db.query(`UPDATE edu_question SET ${fields.join(', ')} WHERE id = ?`, values);
  res.json({ success: true });
});

// ===== 管理员：逻辑删除题目 =====
router.delete('/admin/questions/:id', auth, auth.requireAdmin, operLog('题目管理', 3), async (req, res) => {
  const { id } = req.params;
  const [rows] = await db.query(
    'SELECT id FROM edu_question WHERE id = ? AND del_flag = 0', [id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '题目不存在' });

  await db.query(
    'UPDATE edu_question SET del_flag = 1, updated_by = ? WHERE id = ?',
    [req.userId, id]
  );
  res.json({ success: true });
});

// ===== 管理员：AI自动生成题目草稿 =====
router.post('/admin/questions/ai-gen', auth, auth.requireAdmin, operLog('AI生成题目', 0), async (req, res) => {
  const { knowledge_id, count = 3, difficulty = 3, type = 'single' } = req.body;
  if (!knowledge_id) return res.status(400).json({ error: '缺少knowledge_id参数' });

  // 获取知识点信息
  const [knRows] = await db.query(
    `SELECT kn.name AS kn_name, kn.subject_id, s.name AS sub_name
     FROM edu_knowledge_node kn
     LEFT JOIN edu_subject s ON kn.subject_id = s.id
     WHERE kn.id = ? AND kn.del_flag = 0`,
    [knowledge_id]
  );
  if (knRows.length === 0) return res.status(404).json({ error: '知识点不存在' });
  const { kn_name, sub_name } = knRows[0];

  const aiConfig = await getAIConfig();
  if (!aiConfig.apiKey) return res.status(400).json({ error: '请先在设置中配置AI API Key' });

  const typeDesc = { single: '单选题', multi: '多选题', fill: '填空题', subjective: '主观题' };
  const diffDesc = ['', '极简', '简单', '中等', '困难', '极难'];
  const isChoice = (type === 'single' || type === 'multi');

  const systemPrompt = `你是一位专业的${sub_name}教师，擅长出题。请严格按照JSON格式返回题目，不要添加任何额外说明。`;
  const userPrompt = isChoice
    ? `请为"${sub_name}"学科中的知识点"${kn_name}"生成${count}道${typeDesc[type] || '单选题'}，难度为${diffDesc[difficulty] || '中等'}。

要求：
1. 题目内容准确、无歧义
2. 需要4个选项（A/B/C/D）
3. answer字段：单选题为单个选项字母（如"A"）；多选题为多个选项字母组成的字符串（如"AC"）
4. 答案和解析要正确

请以JSON数组格式返回，每道题的格式如下：
{
  "content": "题干内容",
  "options": [{"key":"A","text":"选项A"},{"key":"B","text":"选项B"},{"key":"C","text":"选项C"},{"key":"D","text":"选项D"}],
  "answer": "A",
  "analysis": "解析说明"
}`
    : `请为"${sub_name}"学科中的知识点"${kn_name}"生成${count}道${typeDesc[type] || '填空题'}，难度为${diffDesc[difficulty] || '中等'}。

要求：
1. 题目内容准确、无歧义
2. 这是${typeDesc[type]}，没有选项供学生选择，题干本身**禁止**使用"以下哪项/下列哪个/选出正确的一项"等选择题式表述，必须是要求学生直接写出文字答案的开放式提问（如"请说出..."、"请解释..."、"...是什么？"、"请写出..."）
3. answer字段必须是完整的文字答案内容（填空题给出应填入的具体内容；主观题给出完整的参考答案/解题过程），禁止出现"A/B/C/D"选项字母作为答案，不能是单个字母
4. 答案和解析要正确

请以JSON数组格式返回，每道题的格式如下：
{
  "content": "题干内容",
  "options": null,
  "answer": "完整的文字答案内容",
  "analysis": "解析说明"
}`;

  const requestBody = {
    model: aiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.8,
    max_tokens: 2048
  };
  const requestTime = new Date();

  const response = await fetch(aiConfig.apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${aiConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[AI生成题目] 接口调用失败:', errText);
    recordAIRequest({
      userId: req.userId,
      businessType: 'question_generate',
      businessId: knowledge_id,
      requestUrl: aiConfig.apiUrl,
      requestModel: aiConfig.model,
      requestBody,
      responseResult: null,
      requestTime,
      responseTime: new Date(),
      status: 1,
      errorMsg: errText
    });
    return res.status(500).json({ error: `AI接口调用失败(${response.status})，请检查API Key` });
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || '';
  const responseTime = new Date();

  // 尝试解析JSON
  try {
    // 提取JSON数组部分
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('未找到JSON数组');
    const questions = JSON.parse(jsonMatch[0]);

    // 非选择题：校验/清洗答案，防止AI误返回单字母选项作为答案
    const cleaned = questions.map(q => {
      let answer = q.answer;
      if (!isChoice && typeof answer === 'string' && /^[A-D]{1,4}$/.test(answer.trim())) {
        // 若options里有对应字母的文字内容，替换为文字；否则保留原样但标记提示
        const optText = Array.isArray(q.options)
          ? q.options.find(o => o.key === answer.trim())?.text
          : null;
        answer = optText || answer;
      }
      return { ...q, answer };
    });

    // 格式化返回（作为草稿，需管理员审核后手动入库）
    const drafts = cleaned.map(q => ({
      subject_id: knRows[0].subject_id || null,
      knowledge_id,
      type,
      difficulty,
      content: q.content,
      options_json: isChoice ? (q.options || null) : null,
      answer: q.answer,
      analysis: q.analysis || null
    }));

    recordAIRequest({
      userId: req.userId,
      businessType: 'question_generate',
      businessId: knowledge_id,
      requestUrl: aiConfig.apiUrl,
      requestModel: aiConfig.model,
      requestBody,
      responseResult: content,
      requestTime,
      responseTime,
      status: 0
    });

    res.json({ success: true, drafts, raw: content });
  } catch (err) {
    recordAIRequest({
      userId: req.userId,
      businessType: 'question_generate',
      businessId: knowledge_id,
      requestUrl: aiConfig.apiUrl,
      requestModel: aiConfig.model,
      requestBody,
      responseResult: content,
      requestTime,
      responseTime,
      status: 1,
      errorMsg: err.message
    });
    res.json({ success: false, error: 'AI返回格式解析失败，请重试', raw: content });
  }
});

module.exports = router;
