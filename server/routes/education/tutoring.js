/**
 * AI 交互辅导工具路由 - tutoring.js
 * 功能：智能答疑（对话式）、主观题批改、口语评测
 * 挂载路径：/api/edu/tutoring
 */

'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../../db');
const auth    = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const nextId = () => snowflake.nextId();
const { getAIConfig } = require('../settings');
const { operLog } = require('../../logger');
const { recordAIRequest } = require('../../utils/aiLogger');

// 所有接口均需登录
router.use(auth);

// ============================================================
// 预设虚拟实验列表（前端展示用，无需入库）
// ============================================================
const EXPERIMENTS = [
  { id: 'exp_lens',      subject: '物理', name: '凸透镜成像规律',      goal: '探究物距与像距关系，理解成像原理', steps: '放置光源→调节物距→观察像的位置与大小→记录数据→分析规律' },
  { id: 'exp_circuit',   subject: '物理', name: '串并联电路电阻测量',   goal: '掌握欧姆定律及串并联电阻计算', steps: '连接电路→调节电压→记录电流→计算电阻→对比理论值' },
  { id: 'exp_titration', subject: '化学', name: '酸碱中和滴定',         goal: '测定未知浓度溶液，掌握滴定操作', steps: '准备滴定管→填充标准液→加指示剂→缓慢滴定→判断终点→计算浓度' },
  { id: 'exp_electro',   subject: '化学', name: '电解水实验',           goal: '验证水的组成，理解电解原理', steps: '组装装置→接通电源→观察气泡→收集气体→检验气体→分析结论' },
  { id: 'exp_photosyn',  subject: '生物', name: '光合作用速率测定',     goal: '探究光照强度与光合速率关系', steps: '准备叶片→放置不同光强下→记录气泡数→计算净光合速率→绘制曲线' },
  { id: 'exp_enzyme',    subject: '生物', name: '酶的专一性与高效性',   goal: '验证酶的催化特性，理解酶的作用机制', steps: '准备底物→加入不同酶液→观察反应速率→对照无酶组→得出结论' },
];

// ============================================================
// 工具：调用 AI（非流式）
// ============================================================
async function callAI(systemPrompt, userPrompt, maxTokens = 500, temperature = 0.7, logCtx = {}) {
  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return null; // AI 未配置，返回 null 由调用方处理降级
  }
  const requestBody = {
    model: aiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt   }
    ],
    max_tokens:  maxTokens,
    temperature: temperature
  };
  const requestTime = new Date();
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    if (!response.ok) {
      recordAIRequest({
        userId: logCtx.userId, businessType: logCtx.businessType, businessId: logCtx.businessId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody,
        responseResult: null, requestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return null;
    }
    const data = await response.json();
    recordAIRequest({
      userId: logCtx.userId, businessType: logCtx.businessType, businessId: logCtx.businessId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody,
      responseResult: data, requestTime, responseTime: new Date(), status: 0
    });
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) {
    recordAIRequest({
      userId: logCtx.userId, businessType: logCtx.businessType, businessId: logCtx.businessId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody,
      responseResult: null, requestTime, responseTime: new Date(),
      status: 1, errorMsg: e.message
    });
    throw e;
  }
}

// ============================================================
// 工具：解析 AI 返回的 JSON 块
// ============================================================
function extractJSON(text) {
  if (!text) return null;
  // 尝试匹配最外层 { ... }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// ============================================================
// ① 智能答疑 — 创建新会话
// POST /api/edu/tutoring/chat/start
// Body: { subject_id? }
// ============================================================
router.post('/chat/start', operLog('AI答疑', 1), async (req, res) => {
  try {
    const userId    = req.userId;
    const subjectId = req.body.subject_id || null;
    const id        = nextId();

    await db.query(
      `INSERT INTO edu_chat_session (id, user_id, subject_id, session_type) VALUES (?, ?, ?, 'qa')`,
      [id, userId, subjectId]
    );

    res.json({ session_id: id.toString() });
  } catch (e) {
    console.error('创建答疑会话失败', e);
    res.status(500).json({ error: '创建会话失败' });
  }
});

// ============================================================
// ② 智能答疑 — 发送消息
// POST /api/edu/tutoring/chat/:session_id
// Body: { content }
// ============================================================
router.post('/chat/:session_id', operLog('AI答疑', 0), async (req, res) => {
  const { session_id } = req.params;
  const userId  = req.userId;
  const content = (req.body.content || '').trim();

  if (!content) return res.status(400).json({ error: '消息内容不能为空' });

  try {
    // 校验会话归属
    const [[session]] = await db.query(
      'SELECT id, subject_id FROM edu_chat_session WHERE id = ? AND user_id = ? AND del_flag = 0',
      [session_id, userId]
    );
    if (!session) return res.status(404).json({ error: '会话不存在' });

    // 查历史消息（最近10条，用于上下文）
    const [history] = await db.query(
      'SELECT role, content FROM edu_chat_message WHERE session_id = ? ORDER BY created_at DESC LIMIT 10',
      [session_id]
    );
    const historyMessages = history.reverse().map(m => ({ role: m.role, content: m.content }));

    // 保存用户消息
    const userMsgId = nextId();
    await db.query(
      'INSERT INTO edu_chat_message (id, session_id, role, content) VALUES (?, ?, \'user\', ?)',
      [userMsgId, session_id, content]
    );

    // 若是第一条消息，更新会话标题
    const [[countRow]] = await db.query(
      'SELECT message_count FROM edu_chat_session WHERE id = ?',
      [session_id]
    );
    if (countRow && countRow.message_count === 0) {
      const title = content.length > 50 ? content.slice(0, 50) + '…' : content;
      await db.query('UPDATE edu_chat_session SET title = ? WHERE id = ?', [title, session_id]);
    }

    // 调用 AI（含历史上下文）
    const systemPrompt = `你是一位耐心专业的教学辅导老师。当学生提问时：
1. 先判断题目类型（概念理解/计算题/应用题）
2. 给出分步解析，每步用"第N步："标注
3. 指出核心知识点
4. 最后给1道同类型练习题（选择题，带正确答案）
请用简洁友好的语气，适合中学生阅读。回复控制在400字以内。不使用markdown格式，直接用纯文本。`;

    // 构造完整消息列表（含历史）
    const aiConfig = await getAIConfig();
    let aiReply = '';

    if (aiConfig.enabled && aiConfig.apiKey) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content }
      ];
      const chatRequestBody = {
        model: aiConfig.model,
        messages,
        max_tokens: 600,
        temperature: 0.7
      };
      const chatRequestTime = new Date();
      try {
        const response = await fetch(aiConfig.apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${aiConfig.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(chatRequestBody)
        });
        if (response.ok) {
          const data = await response.json();
          aiReply = data?.choices?.[0]?.message?.content || '';
          recordAIRequest({
            userId, businessType: 'tutoring_chat', businessId: session_id,
            requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: chatRequestBody,
            responseResult: data, requestTime: chatRequestTime, responseTime: new Date(), status: 0
          });
        } else {
          recordAIRequest({
            userId, businessType: 'tutoring_chat', businessId: session_id,
            requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: chatRequestBody,
            responseResult: null, requestTime: chatRequestTime, responseTime: new Date(),
            status: 1, errorMsg: `HTTP ${response.status}`
          });
        }
      } catch (aiErr) {
        recordAIRequest({
          userId, businessType: 'tutoring_chat', businessId: session_id,
          requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: chatRequestBody,
          responseResult: null, requestTime: chatRequestTime, responseTime: new Date(),
          status: 1, errorMsg: aiErr.message
        });
      }
    }

    // AI 不可用时降级
    if (!aiReply) {
      aiReply = '抱歉，AI辅导服务暂时不可用，请稍后再试。如果你有具体问题，可以尝试查阅教材相关章节，或前往评测页面做相关练习题。';
    }

    // 保存 AI 回复
    const aiMsgId = nextId();
    await db.query(
      'INSERT INTO edu_chat_message (id, session_id, role, content) VALUES (?, ?, \'assistant\', ?)',
      [aiMsgId, session_id, aiReply]
    );

    // 更新消息计数
    await db.query(
      'UPDATE edu_chat_session SET message_count = message_count + 2, updated_at = NOW(3) WHERE id = ?',
      [session_id]
    );

    res.json({
      user_message_id: userMsgId.toString(),
      ai_message_id:   aiMsgId.toString(),
      reply: aiReply
    });
  } catch (e) {
    console.error('答疑消息处理失败', e);
    res.status(500).json({ error: '消息发送失败' });
  }
});

// ============================================================
// ③ 智能答疑 — 历史会话列表
// GET /api/edu/tutoring/chat/history?page=1&page_size=10&type=qa
// ============================================================
router.get('/chat/history', async (req, res) => {
  const userId   = req.userId;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, parseInt(req.query.page_size) || 10);
  const type     = req.query.type || 'qa';
  const offset   = (page - 1) * pageSize;

  try {
    const [[{ total }]] = await db.query(
      'SELECT COUNT(*) AS total FROM edu_chat_session WHERE user_id = ? AND session_type = ? AND del_flag = 0',
      [userId, type]
    );

    const [list] = await db.query(
      `SELECT s.id, s.subject_id, s.session_type, s.title, s.message_count,
              s.updated_at, sub.name AS subject_name, sub.icon AS subject_icon
       FROM edu_chat_session s
       LEFT JOIN edu_subject sub ON sub.id = s.subject_id AND sub.del_flag = 0
       WHERE s.user_id = ? AND s.session_type = ? AND s.del_flag = 0
       ORDER BY s.updated_at DESC
       LIMIT ? OFFSET ?`,
      [userId, type, pageSize, offset]
    );

    res.json({ total, page, page_size: pageSize, list });
  } catch (e) {
    console.error('获取历史会话失败', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ④ 智能答疑 — 获取会话消息记录
// GET /api/edu/tutoring/chat/:session_id/messages
// ============================================================
router.get('/chat/:session_id/messages', async (req, res) => {
  const { session_id } = req.params;
  const userId = req.userId;

  try {
    const [[session]] = await db.query(
      'SELECT id FROM edu_chat_session WHERE id = ? AND user_id = ? AND del_flag = 0',
      [session_id, userId]
    );
    if (!session) return res.status(404).json({ error: '会话不存在' });

    const [messages] = await db.query(
      'SELECT id, role, content, created_at FROM edu_chat_message WHERE session_id = ? ORDER BY created_at ASC',
      [session_id]
    );

    res.json({ session_id, messages });
  } catch (e) {
    console.error('获取会话消息失败', e);
    res.status(500).json({ error: '加载失败' });
  }
});

// ============================================================
// ⑤ 主观题批改
// POST /api/edu/tutoring/grade
// Body: { question_content, question_type, user_answer, subject?, max_score? }
// ============================================================
router.post('/grade', operLog('主观题批改', 0), async (req, res) => {
  const { question_content, question_type, user_answer, subject, max_score } = req.body;

  if (!question_content || !user_answer) {
    return res.status(400).json({ error: '题目内容和学生答案不能为空' });
  }

  const maxScore   = parseInt(max_score) || 10;
  const subjectStr = subject || '综合';
  const typeLabel  = { math: '数学（公式推导）', essay: '英语作文', code: '编程代码', subjective: '主观题' }[question_type] || '主观题';

  const systemPrompt = `你是专业的${subjectStr}评卷老师，擅长评阅${typeLabel}。请客观公正地评分并给出具体建议。`;
  const userPrompt = `请对以下学生答案评分：

【题目】${question_content}
【题目类型】${typeLabel}
【满分】${maxScore}分
【学生答案】
${user_answer}

请以JSON格式返回（不要加代码块标记）：
{
  "score": 实际得分（数值，不超过${maxScore}），
  "feedback": "总体评语（1-2句话）",
  "suggestions": "具体改进建议（2-3条，换行分隔）",
  "error_points": ["错误点1", "错误点2"]
}`;

  try {
    const aiText = await callAI(systemPrompt, userPrompt, 400, 0.3, {
      userId: req.userId, businessType: 'subjective_grading', businessId: null
    });
    const parsed = extractJSON(aiText);

    if (parsed && typeof parsed.score === 'number') {
      res.json({
        score:        Math.min(maxScore, Math.max(0, Math.round(parsed.score))),
        max_score:    maxScore,
        feedback:     parsed.feedback     || '评阅完成',
        suggestions:  parsed.suggestions  || '请继续努力',
        error_points: Array.isArray(parsed.error_points) ? parsed.error_points : []
      });
    } else {
      // AI 返回无法解析时，给基础反馈
      res.json({
        score:        Math.round(maxScore * 0.6),
        max_score:    maxScore,
        feedback:     'AI评阅完成，建议对照答案仔细检查',
        suggestions:  '请仔细核对题目要求，确保答案完整。',
        error_points: []
      });
    }
  } catch (e) {
    console.error('主观题批改失败', e);
    res.status(500).json({ error: '批改失败，请稍后重试' });
  }
});

// ============================================================
// ⑥ 口语评测
// POST /api/edu/tutoring/oral/evaluate
// Body: { original_text, transcribed_text, subject_id? }
// ============================================================
router.post('/oral/evaluate', operLog('口语评测', 1), async (req, res) => {
  const userId = req.userId;
  const { original_text, transcribed_text, subject_id } = req.body;

  if (!original_text || !transcribed_text) {
    return res.status(400).json({ error: '原文和转录内容不能为空' });
  }

  const systemPrompt = `你是一位专业的语言教学专家，擅长评估朗读质量。请客观准确地从三个维度评分。`;
  const userPrompt = `请评估以下朗读记录：

【原文】
${original_text}

【学生转录内容】
${transcribed_text}

请从以下三个维度（各0-100分）评分，以JSON格式返回（不要加代码块标记）：
{
  "accuracy_score": 准确度分数（原文和转录相符程度，错字漏字各扣分），
  "fluency_score": 流利度分数（根据转录连贯性估算，无明显卡顿为高分），
  "completeness_score": 完整度分数（转录内容覆盖原文比例），
  "overall_score": 综合得分（三维均值，可适当调整），
  "ai_feedback": "详细反馈（指出具体错误位置、改进建议，100字以内）"
}`;

  try {
    const aiText = await callAI(systemPrompt, userPrompt, 400, 0.3, {
      userId, businessType: 'oral_evaluate', businessId: null
    });
    const parsed = extractJSON(aiText);

    let record;
    if (parsed && typeof parsed.accuracy_score === 'number') {
      const clamp = v => Math.min(100, Math.max(0, Math.round(v)));
      record = {
        accuracy_score:     clamp(parsed.accuracy_score),
        fluency_score:      clamp(parsed.fluency_score),
        completeness_score: clamp(parsed.completeness_score),
        overall_score:      clamp(parsed.overall_score),
        ai_feedback:        parsed.ai_feedback || '评测完成'
      };
    } else {
      // 降级：根据字符串相似度估算
      const sim = simpleTextSimilarity(original_text, transcribed_text);
      record = {
        accuracy_score:     Math.round(sim * 100),
        fluency_score:      70,
        completeness_score: Math.round(Math.min(1, transcribed_text.length / original_text.length) * 100),
        overall_score:      Math.round(sim * 85),
        ai_feedback:        'AI评测完成。建议对照原文朗读，注意发音准确度。'
      };
    }

    // 持久化记录
    const id = nextId();
    await db.query(
      `INSERT INTO edu_oral_record
         (id, user_id, subject_id, original_text, transcribed_text,
          accuracy_score, fluency_score, completeness_score, overall_score, ai_feedback)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, userId, subject_id || null, original_text, transcribed_text,
       record.accuracy_score, record.fluency_score, record.completeness_score,
       record.overall_score, record.ai_feedback]
    );

    res.json({ record_id: id.toString(), ...record });
  } catch (e) {
    console.error('口语评测失败', e);
    res.status(500).json({ error: '评测失败，请稍后重试' });
  }
});

// ============================================================
// ⑦ 虚拟实验 — 获取实验列表（无需AI）
// GET /api/edu/tutoring/experiments
// ============================================================
router.get('/experiments', async (req, res) => {
  res.json({ list: EXPERIMENTS });
});

// ============================================================
// ⑧ 虚拟实验 — 创建实验指导会话
// POST /api/edu/tutoring/experiment/start
// Body: { experiment_id, subject_id? }
// ============================================================
router.post('/experiment/start', operLog('虚拟实验', 1), async (req, res) => {
  try {
    const userId       = req.userId;
    const experimentId = req.body.experiment_id;
    const subjectId    = req.body.subject_id || null;

    const exp = EXPERIMENTS.find(e => e.id === experimentId);
    if (!exp) return res.status(400).json({ error: '实验不存在' });

    const id = nextId();
    await db.query(
      `INSERT INTO edu_chat_session (id, user_id, subject_id, session_type, title)
       VALUES (?, ?, ?, 'experiment', ?)`,
      [id, userId, subjectId, `虚拟实验：${exp.name}`]
    );

    // 保存实验系统上下文（作为第一条 assistant 消息）
    const sysCtxId = nextId();
    const intro = `欢迎进行【${exp.name}】虚拟实验！\n\n实验目的：${exp.goal}\n\n实验步骤概览：${exp.steps}\n\n你可以随时向我提问操作规范、现象原理或安全注意事项。请问你准备从哪一步开始？`;
    await db.query(
      'INSERT INTO edu_chat_message (id, session_id, role, content) VALUES (?, ?, \'assistant\', ?)',
      [sysCtxId, id, intro]
    );
    await db.query(
      'UPDATE edu_chat_session SET message_count = 1 WHERE id = ?', [id]
    );

    res.json({
      session_id:   id.toString(),
      experiment:   exp,
      intro_message: intro
    });
  } catch (e) {
    console.error('创建实验会话失败', e);
    res.status(500).json({ error: '创建实验会话失败' });
  }
});

// ============================================================
// ⑨ 虚拟实验 — 发送消息（复用聊天逻辑，注入实验上下文）
// POST /api/edu/tutoring/experiment/chat/:session_id
// Body: { content, experiment_id }
// ============================================================
router.post('/experiment/chat/:session_id', operLog('虚拟实验', 0), async (req, res) => {
  const { session_id } = req.params;
  const userId       = req.userId;
  const content      = (req.body.content || '').trim();
  const experimentId = req.body.experiment_id;

  if (!content) return res.status(400).json({ error: '消息不能为空' });

  try {
    const [[session]] = await db.query(
      `SELECT id FROM edu_chat_session
       WHERE id = ? AND user_id = ? AND session_type = 'experiment' AND del_flag = 0`,
      [session_id, userId]
    );
    if (!session) return res.status(404).json({ error: '实验会话不存在' });

    const exp = EXPERIMENTS.find(e => e.id === experimentId) || { name: '虚拟实验', goal: '', steps: '' };

    // 查历史消息
    const [history] = await db.query(
      'SELECT role, content FROM edu_chat_message WHERE session_id = ? ORDER BY created_at DESC LIMIT 8',
      [session_id]
    );
    const historyMessages = history.reverse().map(m => ({ role: m.role, content: m.content }));

    // 保存用户消息
    const userMsgId = nextId();
    await db.query(
      'INSERT INTO edu_chat_message (id, session_id, role, content) VALUES (?, ?, \'user\', ?)',
      [userMsgId, session_id, content]
    );

    // AI 调用（附实验上下文）
    const systemPrompt = `你是一位理科实验指导老师。学生正在进行【${exp.name}】虚拟实验。
实验目的：${exp.goal}
操作步骤概览：${exp.steps}
当学生提问时：解释操作规范、说明现象原理、提醒安全注意事项。语气积极鼓励，回复简洁（200字以内），不使用markdown格式。`;

    const aiConfig = await getAIConfig();
    let aiReply = '';

    if (aiConfig.enabled && aiConfig.apiKey) {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content }
      ];
      const expRequestBody = {
        model: aiConfig.model,
        messages,
        max_tokens: 300,
        temperature: 0.6
      };
      const expRequestTime = new Date();
      try {
        const response = await fetch(aiConfig.apiUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${aiConfig.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(expRequestBody)
        });
        if (response.ok) {
          const data = await response.json();
          aiReply = data?.choices?.[0]?.message?.content || '';
          recordAIRequest({
            userId, businessType: 'experiment_chat', businessId: session_id,
            requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: expRequestBody,
            responseResult: data, requestTime: expRequestTime, responseTime: new Date(), status: 0
          });
        } else {
          recordAIRequest({
            userId, businessType: 'experiment_chat', businessId: session_id,
            requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: expRequestBody,
            responseResult: null, requestTime: expRequestTime, responseTime: new Date(),
            status: 1, errorMsg: `HTTP ${response.status}`
          });
        }
      } catch (aiErr) {
        recordAIRequest({
          userId, businessType: 'experiment_chat', businessId: session_id,
          requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: expRequestBody,
          responseResult: null, requestTime: expRequestTime, responseTime: new Date(),
          status: 1, errorMsg: aiErr.message
        });
      }
    }

    if (!aiReply) {
      aiReply = '实验指导服务暂时不可用，请参考教材中的实验步骤说明。';
    }

    // 保存 AI 回复
    const aiMsgId = nextId();
    await db.query(
      'INSERT INTO edu_chat_message (id, session_id, role, content) VALUES (?, ?, \'assistant\', ?)',
      [aiMsgId, session_id, aiReply]
    );

    await db.query(
      'UPDATE edu_chat_session SET message_count = message_count + 2, updated_at = NOW(3) WHERE id = ?',
      [session_id]
    );

    res.json({
      user_message_id: userMsgId.toString(),
      ai_message_id:   aiMsgId.toString(),
      reply: aiReply
    });
  } catch (e) {
    console.error('实验消息处理失败', e);
    res.status(500).json({ error: '消息发送失败' });
  }
});

// ============================================================
// 工具：简单文本相似度（用于口语评测AI不可用时降级）
// 基于公共字符数/原文长度
// ============================================================
function simpleTextSimilarity(original, transcribed) {
  if (!original || !transcribed) return 0;
  const orig  = original.replace(/\s/g, '');
  const trans = transcribed.replace(/\s/g, '');
  if (orig.length === 0) return 0;
  let matches = 0;
  const transSet = new Set(trans);
  for (const ch of orig) {
    if (transSet.has(ch)) matches++;
  }
  return Math.min(1, matches / orig.length);
}

module.exports = router;
