const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const auth = require('../middleware/auth');
const { getBookRole } = require('../middleware/bookAccess');
const { getAIConfig } = require('./settings');
const snowflake = require('../utils/snowflake');
const { recordAIRequest } = require('../utils/aiLogger');

const router = express.Router();

// 确保历史记录表存在（含新字段）
async function ensureHistoryTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_ai_analysis (
      id BIGINT UNSIGNED PRIMARY KEY COMMENT '记录ID（雪花算法生成）',
      user_id BIGINT UNSIGNED NOT NULL COMMENT '所属用户ID',
      book_id BIGINT UNSIGNED NOT NULL COMMENT '所属账本ID',
      period_type VARCHAR(20) NOT NULL COMMENT 'week/month/quarter/year/diet',
      period_label VARCHAR(100) NOT NULL COMMENT '周期显示标签',
      start_date DATE NOT NULL COMMENT '分析开始日期',
      end_date DATE NOT NULL COMMENT '分析结束日期',
      analysis_text TEXT NOT NULL COMMENT 'AI返回的分析内容',
      session_title VARCHAR(200) DEFAULT NULL COMMENT 'AI自动生成的会话标题',
      messages_json MEDIUMTEXT DEFAULT NULL COMMENT '完整会话消息JSON数组',
      total_income DECIMAL(12,2) DEFAULT 0 COMMENT '周期内总收入',
      total_expense DECIMAL(12,2) DEFAULT 0 COMMENT '周期内总支出',
      balance DECIMAL(12,2) DEFAULT 0 COMMENT '周期结余',
      del_flag TINYINT NOT NULL DEFAULT 0 COMMENT '删除标志（0正常 1删除）',
      created_by BIGINT UNSIGNED DEFAULT NULL COMMENT '创建用户ID',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
      updated_by BIGINT UNSIGNED DEFAULT NULL COMMENT '修改用户ID',
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
      remark VARCHAR(500) DEFAULT NULL COMMENT '备注',
      FOREIGN KEY (user_id) REFERENCES sl_sys_user(id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES sl_ledger_book(id) ON DELETE CASCADE,
      INDEX idx_user_book (user_id, book_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI账单分析历史表'
  `);
  // 兼容旧表：按需补列
  try { await db.query(`ALTER TABLE sl_ai_analysis ADD COLUMN session_title VARCHAR(200) DEFAULT NULL COMMENT 'AI自动生成的会话标题' AFTER analysis_text`); } catch(e) {}
  try { await db.query(`ALTER TABLE sl_ai_analysis ADD COLUMN messages_json MEDIUMTEXT DEFAULT NULL COMMENT '完整会话消息JSON数组' AFTER session_title`); } catch(e) {}
}

// AI 智能账单分析
router.post('/analyze', auth, async (req, res) => {
  const { book_id, start_date, end_date, period_label, period_type } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  // 读取AI配置
  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用，请先在设置中配置API Key' });
  }

  // 确定时间范围（默认当月）
  const start = start_date || dayjs().startOf('month').format('YYYY-MM-DD');
  const end = end_date || dayjs().endOf('month').format('YYYY-MM-DD');
  const label = period_label || `${start} ~ ${end}`;
  const pType = period_type || 'month';

  // 查询数据
  const [summaryRows] = await db.query(`
    SELECT
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense,
      COUNT(CASE WHEN type = 'income' THEN 1 END) as income_count,
      COUNT(CASE WHEN type = 'expense' THEN 1 END) as expense_count
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
  `, [bookId, start, end]);

  const summary = summaryRows[0] || {};
  const totalIncome = Number(summary.total_income) || 0;
  const totalExpense = Number(summary.total_expense) || 0;
  const balance = totalIncome - totalExpense;

  // 支出分类排行
  const [expenseCats] = await db.query(`
    SELECT c.name, COALESCE(gpc.name, pc.name) as parent_name, SUM(r.amount) as total
    FROM sl_biz_record r
    JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    LEFT JOIN sl_biz_category gpc ON pc.parent_id = gpc.id AND gpc.del_flag = 0
    WHERE r.book_id = ? AND r.type = 'expense' AND r.record_date BETWEEN ? AND ? AND r.is_template = false AND r.del_flag = 0
    GROUP BY COALESCE(gpc.name, pc.name, c.name)
    ORDER BY total DESC
    LIMIT 8
  `, [bookId, start, end]);

  // 收入分类
  const [incomeCats] = await db.query(`
    SELECT c.name, SUM(r.amount) as total
    FROM sl_biz_record r
    JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    WHERE r.book_id = ? AND r.type = 'income' AND r.record_date BETWEEN ? AND ? AND r.is_template = false AND r.del_flag = 0
    GROUP BY c.name
    ORDER BY total DESC
    LIMIT 5
  `, [bookId, start, end]);

  // 每日趋势
  const [dailyTrend] = await db.query(`
    SELECT record_date,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
    GROUP BY record_date
    ORDER BY record_date
  `, [bookId, start, end]);

  // 账户余额
  const [accounts] = await db.query(`
    SELECT name, type, balance FROM sl_acc_account WHERE book_id = ? AND del_flag = 0 ORDER BY balance DESC
  `, [bookId]);

  // 上月对比
  const prevStart = dayjs(start).subtract(1, 'month').format('YYYY-MM-DD');
  const prevEnd = dayjs(start).subtract(1, 'month').endOf('month').format('YYYY-MM-DD');
  const [prevRows] = await db.query(`
    SELECT
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
  `, [bookId, prevStart, prevEnd]);
  const prevIncome = Number(prevRows[0]?.total_income) || 0;
  const prevExpense = Number(prevRows[0]?.total_expense) || 0;

  // 构建提示词
  const expenseList = expenseCats.map((c, i) =>
    `${i+1}. ${c.parent_name}: ¥${Number(c.total).toFixed(2)} (${((Number(c.total)/totalExpense)*100).toFixed(1)}%)`
  ).join('\n');

  const incomeList = incomeCats.map((c, i) =>
    `${i+1}. ${c.name}: ¥${Number(c.total).toFixed(2)}`
  ).join('\n');

  const dailySummary = dailyTrend.length > 0
    ? `共${dailyTrend.length}天有记录，日均支出¥${(totalExpense/dailyTrend.length).toFixed(2)}`
    : '无记录';

  const accountList = accounts.map(a =>
    `- ${a.name}: ¥${Number(a.balance).toFixed(2)}`
  ).join('\n');

  const systemPrompt = `你是一位专业的个人理财顾问，擅长分析收支数据并给出实用的理财建议。请用中文回答，语气亲切自然，像朋友一样给出建议。回答要有条理，分段清晰。不要使用markdown格式，直接用纯文本，适当使用emoji让内容更生动。总字数控制在600字以内。
开头必须先给出财务健康评分，格式为：🏆 财务健康评分：XX/100分（评级），评级分为优秀(80-100)、良好(60-79)、一般(40-59)、需改善(0-39)。`;

  const userPrompt = `请帮我分析以下账单数据（${label}）：

【总体概况】
- 总收入：¥${totalIncome.toFixed(2)}（${Number(summary.income_count)||0}笔）
- 总支出：¥${totalExpense.toFixed(2)}（${Number(summary.expense_count)||0}笔）
- 结余：¥${balance.toFixed(2)}（储蓄率：${totalIncome > 0 ? ((balance/totalIncome)*100).toFixed(1) : 0}%）
${prevIncome > 0 || prevExpense > 0 ? `- 上月对比：收入${totalIncome > prevIncome ? '↑' : '↓'}${Math.abs(((totalIncome-prevIncome)/(prevIncome||1))*100).toFixed(1)}%，支出${totalExpense > prevExpense ? '↑' : '↓'}${Math.abs(((totalExpense-prevExpense)/(prevExpense||1))*100).toFixed(1)}%` : ''}

【支出分类排行】
${expenseList || '暂无支出数据'}

【收入来源】
${incomeList || '暂无收入数据'}

【每日趋势】
${dailySummary}

【账户余额】
${accountList || '暂无账户数据'}

请按以下结构回答：
🏆 财务健康评分：XX/100分（评级）
1. 📊 消费结构分析：指出支出的主要构成
2. ⚠️ 问题识别：消费异常或可优化的地方（如有异常超支请标注）
3. 💡 理财建议：具体可执行的省钱/储蓄建议
4. 🎯 下期预算：给出下月各类别预算建议`;

  // 调用智谱API
  const analyzeRequestBody = {
    model: aiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 1024
  };
  const analyzeRequestTime = new Date();
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(analyzeRequestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[AI API Error]', response.status, errText);
      recordAIRequest({
        userId: req.userId, businessType: 'financial_analysis', businessId: bookId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: analyzeRequestBody,
        responseResult: errText, requestTime: analyzeRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return res.status(500).json({ error: `AI接口调用失败(${response.status})，请检查API Key是否正确` });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || 'AI未返回有效内容';
    recordAIRequest({
      userId: req.userId, businessType: 'financial_analysis', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: analyzeRequestBody,
      responseResult: result, requestTime: analyzeRequestTime, responseTime: new Date(), status: 0
    });

    // 保存到历史记录
    try {
      await ensureHistoryTable();
      const analysisId = snowflake.nextId();
      await db.query(
        `INSERT INTO sl_ai_analysis
         (id, user_id, book_id, period_type, period_label, start_date, end_date, analysis_text, total_income, total_expense, balance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [analysisId, req.userId, bookId, pType, label, start, end, content, totalIncome, totalExpense, balance]
      );
    } catch (saveErr) {
      console.error('[AI History Save Error]', saveErr.message);
      // 保存失败不影响返回结果
    }

    res.json({
      success: true,
      analysis: content,
      data_summary: {
        total_income: totalIncome,
        total_expense: totalExpense,
        balance,
        period: label
      }
    });
  } catch (err) {
    console.error('[AI Analysis Error]', err.message);
    recordAIRequest({
      userId: req.userId, businessType: 'financial_analysis', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: analyzeRequestBody,
      responseResult: null, requestTime: analyzeRequestTime, responseTime: new Date(),
      status: 1, errorMsg: err.message
    });
    res.status(500).json({ error: 'AI分析失败：' + err.message });
  }
});

// 获取AI分析历史列表
router.get('/history', auth, async (req, res) => {
  await ensureHistoryTable();
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const page = parseInt(req.query.page) || 1;
  const pageSize = Math.min(parseInt(req.query.page_size) || 20, 50);
  const offset = (page - 1) * pageSize;
  const periodType = req.query.period_type || null;

  const typeFilter = periodType ? ' AND period_type = ?' : '';
  const queryParams = periodType ? [bookId, periodType, pageSize, offset] : [bookId, pageSize, offset];
  const countParams = periodType ? [bookId, periodType] : [bookId];

  const [rows] = await db.query(
    `SELECT id, period_type, period_label, start_date, end_date,
            total_income, total_expense, balance, created_at
     FROM sl_ai_analysis
     WHERE book_id = ? AND del_flag = 0${typeFilter}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    queryParams
  );

  const [countRows] = await db.query(
    `SELECT COUNT(*) as total FROM sl_ai_analysis WHERE book_id = ? AND del_flag = 0${typeFilter}`,
    countParams
  );

  res.json({
    list: rows,
    total: countRows[0].total,
    page,
    page_size: pageSize
  });
});

// 获取单条历史分析详情
router.get('/history/:id', auth, async (req, res) => {
  await ensureHistoryTable();
  const [rows] = await db.query(
    'SELECT * FROM sl_ai_analysis WHERE id = ?',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '记录不存在' });

  const record = rows[0];
  // 验证用户对该账本有权限
  const role = await getBookRole(req.userId, record.book_id);
  if (!role) return res.status(403).json({ error: '无权访问该记录' });

  res.json(record);
});

// 删除历史分析记录
router.delete('/history/:id', auth, async (req, res) => {
  await ensureHistoryTable();
  const [rows] = await db.query(
    'SELECT book_id FROM sl_ai_analysis WHERE id = ?',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '记录不存在' });

  const role = await getBookRole(req.userId, rows[0].book_id);
  if (!role) return res.status(403).json({ error: '无权操作' });

  await db.query('UPDATE sl_ai_analysis SET del_flag = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// AI智能解析自然语言记账
router.post('/parse', auth, async (req, res) => {
  const { text, book_id } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  if (!text || !text.trim()) {
    return res.status(400).json({ error: '请输入记账内容' });
  }

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用，请先在设置中配置API Key' });
  }

  // 获取账本分类（扁平化，包含层级信息）
  const [cats] = await db.query(
    `SELECT id, name, parent_id, type, icon FROM sl_biz_category WHERE book_id = ? AND del_flag = 0 ORDER BY sort_order, id`,
    [bookId]
  );

  // 构建分类层级映射：id -> { name, parent_name, grandparent_name, type, icon }
  const catMap = {};
  cats.forEach(c => { catMap[c.id] = c; });

  const catList = cats.map(c => {
    let path = c.name;
    let p = c.parent_id ? catMap[c.parent_id] : null;
    if (p) {
      path = p.name + ' > ' + path;
      let gp = p.parent_id ? catMap[p.parent_id] : null;
      if (gp) path = gp.name + ' > ' + path;
    }
    return `{"id":${c.id},"name":"${c.name}","path":"${path}","type":"${c.type}"}`;
  }).join(',');

  // 获取账户列表
  const [accounts] = await db.query(
    'SELECT id, name, type, icon FROM sl_acc_account WHERE book_id = ? AND del_flag = 0 ORDER BY sort_order, id',
    [bookId]
  );
  const accountList = accounts.map(a =>
    `{"id":${a.id},"name":"${a.name}","icon":"${a.icon}"}`
  ).join(',');

  const today = dayjs().format('YYYY-MM-DD');

  const systemPrompt = `你是一个智能记账助手，负责将用户的自然语言描述解析为结构化的记账数据。
请严格按照JSON格式返回，不要返回任何其他文字说明。
返回格式：{"type":"expense|income|transfer","amount":数字,"category_id":数字,"account_id":数字,"to_account_id":数字或null,"record_date":"YYYY-MM-DD","note":"备注文字"}
规则：
1. type只能是"expense"(支出)、"income"(收入)、"transfer"(转账)。默认支出，除非明确提到收入/工资/收款/还钱给我等。
2. amount为金额数字，从文本中提取。
3. category_id必须从给定分类列表中选择最匹配的id，优先选择最细分的分类。
4. account_id必须从给定账户列表中选择最匹配的id。如果用户提到"微信"选微信，"支付宝"选支付宝，"现金"选现金，"银行卡"选银行卡等。无法判断时选第一个。
5. to_account_id仅type为transfer时填写，否则为null。
6. record_date如果文本提到"今天"用今天日期${today}，"昨天"用${dayjs().subtract(1,'day').format('YYYY-MM-DD')}，具体日期按文本解析，未提及时用今天。
7. note为商家名或备注信息，从文本中提取（如店名、事由等），没有则为空字符串。`;

  const userPrompt = `请解析以下记账文本：
"${text}"

可选分类列表（JSON数组）：
[${catList}]

可选账户列表（JSON数组）：
[${accountList}]

只返回JSON，不要其他文字。`;

  const parseRequestBody = {
    model: aiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: 300
  };
  const parseRequestTime = new Date();
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(parseRequestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[AI Parse API Error]', response.status, errText);
      recordAIRequest({
        userId: req.userId, businessType: 'nlp_parse', businessId: bookId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: parseRequestBody,
        responseResult: errText, requestTime: parseRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return res.status(500).json({ error: `AI解析失败(${response.status})，请检查API Key` });
    }

    const result = await response.json();
    let content = result.choices?.[0]?.message?.content?.trim() || '';
    recordAIRequest({
      userId: req.userId, businessType: 'nlp_parse', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: parseRequestBody,
      responseResult: result, requestTime: parseRequestTime, responseTime: new Date(), status: 0
    });

    // 提取JSON部分
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'AI返回格式异常，请重试' });
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[AI Parse JSON Error]', content);
      return res.status(500).json({ error: 'AI返回数据解析失败，请重试' });
    }

    // 验证必填字段
    if (!parsed.type || !parsed.amount || !parsed.category_id) {
      return res.status(400).json({ error: '无法解析完整信息，请补充更详细的描述' });
    }

    // 返回解析结果，附带分类/账户名称方便前端展示
    const matchedCat = catMap[parsed.category_id];
    const matchedAcc = accounts.find(a => a.id === parsed.account_id);
    const matchedToAcc = parsed.to_account_id ? accounts.find(a => a.id === parsed.to_account_id) : null;

    res.json({
      success: true,
      parsed: {
        type: parsed.type,
        amount: Number(parsed.amount),
        category_id: parsed.category_id,
        category_name: matchedCat ? matchedCat.name : '',
        category_icon: matchedCat ? matchedCat.icon : '',
        account_id: parsed.account_id,
        account_name: matchedAcc ? matchedAcc.name : '',
        account_icon: matchedAcc ? matchedAcc.icon : '',
        to_account_id: parsed.to_account_id || null,
        to_account_name: matchedToAcc ? matchedToAcc.name : '',
        record_date: parsed.record_date || today,
        note: parsed.note || ''
      }
    });
  } catch (err) {
    console.error('[AI Parse Error]', err.message);
    recordAIRequest({
      userId: req.userId, businessType: 'nlp_parse', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: parseRequestBody,
      responseResult: null, requestTime: parseRequestTime, responseTime: new Date(),
      status: 1, errorMsg: err.message
    });
    res.status(500).json({ error: 'AI解析失败：' + err.message });
  }
});

// OCR小票识别（使用glm-4v-flash视觉模型）
router.post('/ocr', auth, async (req, res) => {
  const { image_base64, book_id } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  if (!image_base64) {
    return res.status(400).json({ error: '请提供图片数据' });
  }

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用' });
  }

  // 获取分类和账户列表（复用parse的逻辑）
  const [cats] = await db.query(
    `SELECT id, name, parent_id, type, icon FROM sl_biz_category WHERE book_id = ? AND del_flag = 0 ORDER BY sort_order, id`,
    [bookId]
  );
  const catMap = {};
  cats.forEach(c => { catMap[c.id] = c; });
  const catList = cats.filter(c => c.type === 'expense').map(c => {
    let path = c.name;
    let p = c.parent_id ? catMap[c.parent_id] : null;
    if (p) { path = p.name + ' > ' + path; let gp = p.parent_id ? catMap[p.parent_id] : null; if (gp) path = gp.name + ' > ' + path; }
    return `{"id":${c.id},"name":"${c.name}","path":"${path}"}`;
  }).join(',');

  const [accounts] = await db.query(
    'SELECT id, name, type, icon FROM sl_acc_account WHERE book_id = ? AND del_flag = 0 ORDER BY sort_order, id',
    [bookId]
  );
  const accountList = accounts.map(a => `{"id":${a.id},"name":"${a.name}"}`).join(',');
  const today = dayjs().format('YYYY-MM-DD');

  const systemPrompt = `你是一个小票OCR识别助手，请从用户上传的小票/收据图片中提取消费信息，并以JSON格式返回。
只返回JSON，不要任何其他文字。
返回格式：{"amount":数字,"category_id":数字,"account_id":数字,"record_date":"YYYY-MM-DD","note":"商家名或备注","merchant":"商家名称"}
规则：
1. amount为小票总金额（数字）。
2. category_id从给定支出分类中选择最匹配的id（如餐饮小票选餐饮相关分类）。
3. account_id默认选第一个（现金）。
4. record_date从小票中提取日期，无法识别则用今天${today}。
5. note为商家名或备注。
6. merchant为商家名称。
如果图片不是小票/收据/账单，返回 {"error": "无法识别为消费小票"}。`;

  const ocrRequestBody = {
    model: aiConfig.visionModel || 'glm-4v-flash',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `请识别这张小票，可选支出分类：[${catList}]，可选账户：[${accountList}]。只返回JSON。`
          },
          {
            type: 'image_url',
            image_url: { url: image_base64 }
          }
        ]
      }
    ],
    temperature: 0.1,
    max_tokens: 300
  };
  const ocrRequestTime = new Date();
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(ocrRequestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[OCR API Error]', response.status, errText);
      recordAIRequest({
        userId: req.userId, businessType: 'receipt_ocr', businessId: bookId,
        requestUrl: aiConfig.apiUrl, requestModel: ocrRequestBody.model, requestBody: ocrRequestBody,
        responseResult: errText, requestTime: ocrRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return res.status(500).json({ error: `OCR识别失败(${response.status})` });
    }

    const result = await response.json();
    recordAIRequest({
      userId: req.userId, businessType: 'receipt_ocr', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: ocrRequestBody.model, requestBody: ocrRequestBody,
      responseResult: result, requestTime: ocrRequestTime, responseTime: new Date(), status: 0
    });
    let content = result.choices?.[0]?.message?.content?.trim() || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'AI返回格式异常' });

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); } catch(e) { return res.status(500).json({ error: '数据解析失败' }); }
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const matchedCat = catMap[parsed.category_id];
    const matchedAcc = accounts.find(a => a.id === parsed.account_id);
    res.json({
      success: true,
      parsed: {
        type: 'expense',
        amount: Number(parsed.amount) || 0,
        category_id: parsed.category_id,
        category_name: matchedCat ? matchedCat.name : '',
        category_icon: matchedCat ? matchedCat.icon : '',
        account_id: parsed.account_id,
        account_name: matchedAcc ? matchedAcc.name : '',
        account_icon: matchedAcc ? matchedAcc.icon : '',
        record_date: parsed.record_date || today,
        note: parsed.merchant || parsed.note || ''
      }
    });
  } catch (err) {
    console.error('[OCR Error]', err.message);
    recordAIRequest({
      userId: req.userId, businessType: 'receipt_ocr', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: ocrRequestBody.model, requestBody: ocrRequestBody,
      responseResult: null, requestTime: ocrRequestTime, responseTime: new Date(),
      status: 1, errorMsg: err.message
    });
    res.status(500).json({ error: 'OCR识别失败：' + err.message });
  }
});

// 异常检测
router.post('/anomaly', auth, async (req, res) => {
  const { book_id } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用' });
  }

  // 最近30天数据 + 前30天对比
  const end = dayjs().format('YYYY-MM-DD');
  const start = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  const prevEnd = dayjs().subtract(31, 'day').format('YYYY-MM-DD');
  const prevStart = dayjs().subtract(60, 'day').format('YYYY-MM-DD');

  // 本期分类支出
  const [currCats] = await db.query(`
    SELECT c.name, COALESCE(gpc.name, pc.name) as parent_name, SUM(r.amount) as total, COUNT(*) as cnt
    FROM sl_biz_record r JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    LEFT JOIN sl_biz_category gpc ON pc.parent_id = gpc.id AND gpc.del_flag = 0
    WHERE r.book_id = ? AND r.type = 'expense' AND r.record_date BETWEEN ? AND ? AND r.is_template = false AND r.del_flag = 0
    GROUP BY COALESCE(gpc.name, pc.name, c.name) ORDER BY total DESC
  `, [bookId, start, end]);

  // 上期分类支出
  const [prevCats] = await db.query(`
    SELECT COALESCE(gpc.name, pc.name, c.name) as cat_name, SUM(r.amount) as total
    FROM sl_biz_record r JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    LEFT JOIN sl_biz_category gpc ON pc.parent_id = gpc.id AND gpc.del_flag = 0
    WHERE r.book_id = ? AND r.type = 'expense' AND r.record_date BETWEEN ? AND ? AND r.is_template = false AND r.del_flag = 0
    GROUP BY COALESCE(gpc.name, pc.name, c.name)
  `, [bookId, prevStart, prevEnd]);

  const prevMap = {};
  prevCats.forEach(c => { prevMap[c.cat_name] = Number(c.total); });

  // 构建异常列表：本期比上期增长超过50%的分类
  const anomalies = [];
  currCats.forEach(c => {
    const curr = Number(c.total);
    const prev = prevMap[c.parent_name] || 0;
    if (curr > 50 && (prev === 0 || (curr - prev) / prev > 0.5)) {
      const changePct = prev === 0 ? '新增' : `↑${(((curr - prev) / prev) * 100).toFixed(0)}%`;
      anomalies.push(`${c.parent_name}: ¥${curr.toFixed(0)}（${changePct}，${c.cnt}笔）`);
    }
  });

  // 单日大额支出
  const [bigDays] = await db.query(`
    SELECT record_date, SUM(amount) as total FROM sl_biz_record
    WHERE book_id = ? AND type = 'expense' AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
    GROUP BY record_date HAVING total > 500 ORDER BY total DESC LIMIT 5
  `, [bookId, start, end]);

  if (anomalies.length === 0 && bigDays.length === 0) {
    return res.json({ has_anomaly: false, message: '近30天支出正常，未发现异常波动', anomalies: [], big_days: [] });
  }

  const bigDayList = bigDays.map(d => `${d.record_date.slice(5)}: ¥${Number(d.total).toFixed(0)}`);

  res.json({
    has_anomaly: anomalies.length > 0 || bigDays.length > 0,
    anomalies,
    big_days: bigDayList,
    message: anomalies.length > 0
      ? `检测到${anomalies.length}个消费分类异常增长`
      : '大额支出提醒'
  });
});

// 预测月底结余
router.post('/predict', auth, async (req, res) => {
  const { book_id } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用' });
  }

  // 本月已过天数数据
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const today = dayjs().format('YYYY-MM-DD');
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysPassed = now.getDate();

  const [summary] = await db.query(`
    SELECT SUM(CASE WHEN type='income' THEN amount ELSE 0 END) as income,
           SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) as expense
    FROM sl_biz_record WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
  `, [bookId, monthStart, today]);

  const currIncome = Number(summary[0]?.income) || 0;
  const currExpense = Number(summary[0]?.expense) || 0;
  const daysRemaining = daysInMonth - daysPassed;

  // 前3个月的平均数据作为预测参考
  const threeMonthsAgo = dayjs().subtract(3, 'month').startOf('month').format('YYYY-MM-DD');
  const lastMonthEnd = dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');
  const [historyAvg] = await db.query(`
    SELECT
      AVG(CASE WHEN type='income' THEN amount END) as avg_daily_income,
      AVG(CASE WHEN type='expense' THEN amount END) as avg_daily_expense
    FROM (
      SELECT record_date, type, SUM(amount) as amount FROM sl_biz_record
      WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
      GROUP BY record_date, type
    ) t
  `, [bookId, threeMonthsAgo, lastMonthEnd]);

  // 简单线性预测
  const avgDailyExpense = daysPassed > 0 ? currExpense / daysPassed : (Number(historyAvg[0]?.avg_daily_expense) || 0);
  const avgDailyIncome = daysPassed > 0 ? currIncome / daysPassed : (Number(historyAvg[0]?.avg_daily_income) || 0);
  const predictedExpense = currExpense + avgDailyExpense * daysRemaining;
  const predictedIncome = currIncome + avgDailyIncome * daysRemaining;
  const predictedBalance = predictedIncome - predictedExpense;

  // 用AI润色建议
  const systemPrompt = `你是理财顾问，根据以下数据给出一句话简短预测和建议（50字以内，用中文，亲切自然）。`;
  const userPrompt = `本月已过${daysPassed}天（共${daysInMonth}天），剩余${daysRemaining}天。已收入¥${currIncome.toFixed(0)}，已支出¥${currExpense.toFixed(0)}。预计月底收入¥${predictedIncome.toFixed(0)}，支出¥${predictedExpense.toFixed(0)}，结余¥${predictedBalance.toFixed(0)}。请给出简短点评。`;

  let aiComment = '';
  const predictRequestBody = { model: aiConfig.model, messages: [{role:'system',content:systemPrompt},{role:'user',content:userPrompt}], temperature:0.7, max_tokens:150 };
  const predictRequestTime = new Date();
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${aiConfig.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(predictRequestBody)
    });
    if (response.ok) {
      const r = await response.json();
      aiComment = r.choices?.[0]?.message?.content?.trim() || '';
      recordAIRequest({
        userId: req.userId, businessType: 'budget_predict', businessId: bookId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: predictRequestBody,
        responseResult: r, requestTime: predictRequestTime, responseTime: new Date(), status: 0
      });
    } else {
      recordAIRequest({
        userId: req.userId, businessType: 'budget_predict', businessId: bookId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: predictRequestBody,
        responseResult: null, requestTime: predictRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
    }
  } catch(e) {
    recordAIRequest({
      userId: req.userId, businessType: 'budget_predict', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: predictRequestBody,
      responseResult: null, requestTime: predictRequestTime, responseTime: new Date(),
      status: 1, errorMsg: e.message
    });
    /* ignore AI comment failure */
  }

  res.json({
    days_passed: daysPassed,
    days_in_month: daysInMonth,
    days_remaining: daysRemaining,
    current_income: currIncome,
    current_expense: currExpense,
    current_balance: currIncome - currExpense,
    avg_daily_expense: avgDailyExpense,
    avg_daily_income: avgDailyIncome,
    predicted_expense: predictedExpense,
    predicted_income: predictedIncome,
    predicted_balance: predictedBalance,
    ai_comment: aiComment
  });
});

// 智能预算推荐
router.post('/budget-recommend', auth, async (req, res) => {
  const { book_id } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用' });
  }

  // 过去3个月分类平均支出
  const threeMonthsAgo = dayjs().subtract(3, 'month').startOf('month').format('YYYY-MM-DD');
  const lastMonthEnd = dayjs().subtract(1, 'month').endOf('month').format('YYYY-MM-DD');
  const [catAvgs] = await db.query(`
    SELECT cat_name, AVG(monthly_total) as avg_monthly
    FROM (
      SELECT DATE_FORMAT(record_date, '%Y-%m') as ym, COALESCE(gpc.name, pc.name, c.name) as cat_name, SUM(r.amount) as monthly_total
      FROM sl_biz_record r JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
      LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
      LEFT JOIN sl_biz_category gpc ON pc.parent_id = gpc.id AND gpc.del_flag = 0
      WHERE r.book_id = ? AND r.type = 'expense' AND r.record_date BETWEEN ? AND ? AND r.is_template = false AND r.del_flag = 0
      GROUP BY ym, cat_name
    ) t GROUP BY cat_name ORDER BY avg_monthly DESC
  `, [bookId, threeMonthsAgo, lastMonthEnd]);

  const [totalAvg] = await db.query(`
    SELECT AVG(monthly_total) as avg_total FROM (
      SELECT DATE_FORMAT(record_date, '%Y-%m') as ym, SUM(amount) as monthly_total
      FROM sl_biz_record WHERE book_id = ? AND type = 'expense' AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
      GROUP BY ym
    ) t
  `, [bookId, threeMonthsAgo, lastMonthEnd]);

  const avgTotal = Number(totalAvg[0]?.avg_total) || 0;
  const catList = catAvgs.map(c => `${c.cat_name}: ¥${Number(c.avg_monthly).toFixed(0)}/月`).join('\n');

  // 用AI给出建议预算
  const systemPrompt = `你是理财顾问，根据历史消费数据推荐下月各类别预算。返回JSON格式，不要其他文字。格式：{"total_budget":数字,"sl_biz_category":[{"name":"分类名","budget":数字,"suggestion":"建议"}]}`;
  const userPrompt = `过去3个月平均月支出¥${avgTotal.toFixed(0)}，各分类平均：\n${catList}\n请推荐下月预算，每个分类给出建议预算金额和一句话建议。只返回JSON。`;

  const budgetRequestBody = { model: aiConfig.model, messages: [{role:'system',content:systemPrompt},{role:'user',content:userPrompt}], temperature:0.5, max_tokens:800 };
  const budgetRequestTime = new Date();
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${aiConfig.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(budgetRequestBody)
    });
    if (!response.ok) {
      recordAIRequest({
        userId: req.userId, businessType: 'budget_recommend', businessId: bookId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: budgetRequestBody,
        responseResult: null, requestTime: budgetRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return res.json({
        total_budget: Math.round(avgTotal * 0.9),
        cats: catAvgs.map(c => ({ name: c.cat_name, budget: Math.round(Number(c.avg_monthly) * 0.9), suggestion: '建议控制在历史均值的90%以内' }))
      });
    }
    const r = await response.json();
    let content = r.choices?.[0]?.message?.content?.trim() || '';
    recordAIRequest({
      userId: req.userId, businessType: 'budget_recommend', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: budgetRequestBody,
      responseResult: r, requestTime: budgetRequestTime, responseTime: new Date(), status: 0
    });
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.json(parsed);
    }
    res.json({
      total_budget: Math.round(avgTotal * 0.9),
      cats: catAvgs.map(c => ({ name: c.cat_name, budget: Math.round(Number(c.avg_monthly) * 0.9), suggestion: '建议控制' }))
    });
  } catch (err) {
    recordAIRequest({
      userId: req.userId, businessType: 'budget_recommend', businessId: bookId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: budgetRequestBody,
      responseResult: null, requestTime: budgetRequestTime, responseTime: new Date(),
      status: 1, errorMsg: err.message
    });
    res.json({
      total_budget: Math.round(avgTotal * 0.9),
      cats: catAvgs.map(c => ({ name: c.cat_name, budget: Math.round(Number(c.avg_monthly) * 0.9), suggestion: '' }))
    });
  }
});

// AI 餐饮健康饮食建议
router.post('/diet', auth, async (req, res) => {
  const { book_id, start_date, end_date, period_label } = req.body;
  if (!book_id) return res.status(400).json({ error: '缺少book_id参数' });

  const role = await getBookRole(req.userId, book_id);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用，请先在设置中配置API Key' });
  }

  const start = start_date || dayjs().startOf('month').format('YYYY-MM-DD');
  const end   = end_date   || dayjs().endOf('month').format('YYYY-MM-DD');
  const label = period_label || `${start} ~ ${end}`;

  // 查询餐饮相关记录（餐饮一级分类下所有子分类）
  const [records] = await db.query(`
    SELECT r.amount, r.note, r.record_date,
           c.name AS cat_name,
           COALESCE(pc.name, c.name) AS parent_name
    FROM sl_biz_record r
    JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    WHERE r.book_id = ? AND r.del_flag = 0 AND r.is_template = false
      AND r.type = 'expense'
      AND r.record_date BETWEEN ? AND ?
      AND (
        (pc.name = '餐饮') OR
        (c.name = '餐饮' AND c.parent_id IS NULL)
      )
    ORDER BY r.record_date DESC
    LIMIT 100
  `, [book_id, start, end]);

  if (records.length === 0) {
    return res.status(400).json({ error: `${label} 暂无餐饮消费记录，无法生成健康建议` });
  }

  // 按子分类汇总
  const catMap = {};
  records.forEach(r => {
    const key = r.cat_name;
    if (!catMap[key]) catMap[key] = { total: 0, count: 0 };
    catMap[key].total += Number(r.amount);
    catMap[key].count++;
  });
  const catSummary = Object.entries(catMap)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, v]) => `- ${name}：${v.count}次，共¥${v.total.toFixed(2)}`)
    .join('\n');

  const totalExpense = records.reduce((s, r) => s + Number(r.amount), 0);

  // 提取商家/备注关键词（去重，取前20）
  const notes = [...new Set(records.map(r => r.note).filter(Boolean))].slice(0, 20);
  const notesText = notes.length > 0 ? notes.join('、') : '（无备注）';

  const systemPrompt = `你是一位专业的营养师和健康饮食顾问，善于根据用户的饮食消费记录分析其饮食结构，给出科学、亲切、实用的健康饮食建议。请用中文回答，语气温和友好，像营养师朋友一样。不要使用markdown格式，直接用纯文本，适当使用emoji让内容生动。总字数控制在500字以内。`;

  const userPrompt = `请根据我的餐饮消费记录（${label}），帮我分析饮食结构并给出健康饮食建议：

【餐饮消费汇总】
总餐饮支出：¥${totalExpense.toFixed(2)}（共${records.length}笔）

【各类消费分布】
${catSummary}

【常去的商家/食物】
${notesText}

请按以下结构回答：
🍽️ 饮食结构分析：分析我的饮食习惯和结构（外卖多/自炊少？偏某类食物？）
⚠️ 健康风险提示：指出可能存在的营养不均衡或健康风险
🥗 饮食改善建议：3-5条具体可行的改善建议（比如增加蔬菜、减少外卖等）
🎯 本周健康食谱推荐：推荐2-3天的简单健康饮食搭配示例`;

  const dietRequestBody = {
    model: aiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 1024
  };
  const dietRequestTime = new Date();
  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dietRequestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      recordAIRequest({
        userId: req.userId, businessType: 'diet_advice', businessId: book_id,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: dietRequestBody,
        responseResult: errText, requestTime: dietRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return res.status(500).json({ error: `AI接口调用失败(${response.status})` });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || 'AI未返回有效内容';
    recordAIRequest({
      userId: req.userId, businessType: 'diet_advice', businessId: book_id,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: dietRequestBody,
      responseResult: result, requestTime: dietRequestTime, responseTime: new Date(), status: 0
    });

    // 复用 sl_ai_analysis 表，period_type = 'diet'
    let analysisId = null;
    try {
      await ensureHistoryTable();
      analysisId = snowflake.nextId();
      // 生成简短会话标题（用AI）
      let sessionTitle = `🥗 ${label}`;
      const titleRequestBody = {
        model: aiConfig.model,
        messages: [
          { role: 'system', content: '请根据以下饮食分析内容，生成一句15字以内的简短标题（不含emoji，直接输出标题文字，不要任何其他说明）。' },
          { role: 'user', content: content.slice(0, 300) }
        ],
        temperature: 0.3, max_tokens: 30
      };
      const titleRequestTime = new Date();
      try {
        const titleRes = await fetch(aiConfig.apiUrl, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${aiConfig.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(titleRequestBody)
        });
        if (titleRes.ok) {
          const tr = await titleRes.json();
          const t = tr.choices?.[0]?.message?.content?.trim();
          if (t && t.length <= 30) sessionTitle = t;
          recordAIRequest({
            userId: req.userId, businessType: 'diet_title_gen', businessId: book_id,
            requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: titleRequestBody,
            responseResult: tr, requestTime: titleRequestTime, responseTime: new Date(), status: 0
          });
        } else {
          recordAIRequest({
            userId: req.userId, businessType: 'diet_title_gen', businessId: book_id,
            requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: titleRequestBody,
            responseResult: null, requestTime: titleRequestTime, responseTime: new Date(),
            status: 1, errorMsg: `HTTP ${titleRes.status}`
          });
        }
      } catch(e) {
        recordAIRequest({
          userId: req.userId, businessType: 'diet_title_gen', businessId: book_id,
          requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: titleRequestBody,
          responseResult: null, requestTime: titleRequestTime, responseTime: new Date(),
          status: 1, errorMsg: e.message
        });
        /* 标题生成失败不影响主流程 */
      }

      // 初始消息只保存第一轮（用户触发+AI回复）
      const initMessages = [{ role: 'assistant', content }];
      await db.query(
        `INSERT INTO sl_ai_analysis
         (id, user_id, book_id, period_type, period_label, start_date, end_date, analysis_text, session_title, messages_json, total_income, total_expense, balance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)`,
        [analysisId, req.userId, book_id, 'diet', `🥗 ${label}`, start, end, content, sessionTitle, JSON.stringify(initMessages), totalExpense]
      );
    } catch (saveErr) {
      console.error('[Diet History Save]', saveErr.message);
    }

    res.json({ success: true, analysis: content, record_count: records.length, total_expense: totalExpense, session_id: analysisId?.toString() || null });
  } catch (err) {
    recordAIRequest({
      userId: req.userId, businessType: 'diet_advice', businessId: book_id,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: dietRequestBody,
      responseResult: null, requestTime: dietRequestTime, responseTime: new Date(),
      status: 1, errorMsg: err.message
    });
    res.status(500).json({ error: 'AI分析失败：' + err.message });
  }
});

// AI 餐饮健康 - 追问对话（传入 messages 历史，返回回复，并更新session）
router.post('/diet-chat', auth, async (req, res) => {
  const { book_id, messages, session_id } = req.body;
  if (!book_id) return res.status(400).json({ error: '缺少book_id参数' });
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少对话内容' });
  }

  const role = await getBookRole(req.userId, book_id);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const aiConfig = await getAIConfig();
  if (!aiConfig.enabled || !aiConfig.apiKey) {
    return res.status(400).json({ error: 'AI功能未启用，请先在设置中配置API Key' });
  }

  const systemPrompt = `你是一位专业的营养师和健康饮食顾问，善于根据用户的饮食消费记录分析其饮食结构，给出科学、亲切、实用的健康饮食建议。请用中文回答，语气温和友好，像营养师朋友一样。不要使用markdown格式，直接用纯文本，适当使用emoji让内容生动。回答要简洁，300字以内。`;

  const dietChatRequestBody = {
    model: aiConfig.model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ],
    temperature: 0.7,
    max_tokens: 512
  };
  const dietChatRequestTime = new Date();
  const dietChatBusinessId = session_id || book_id;

  try {
    const response = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${aiConfig.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dietChatRequestBody)
    });

    if (!response.ok) {
      recordAIRequest({
        userId: req.userId, businessType: 'diet_chat', businessId: dietChatBusinessId,
        requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: dietChatRequestBody,
        responseResult: null, requestTime: dietChatRequestTime, responseTime: new Date(),
        status: 1, errorMsg: `HTTP ${response.status}`
      });
      return res.status(500).json({ error: `AI接口调用失败(${response.status})` });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || 'AI未返回有效内容';
    recordAIRequest({
      userId: req.userId, businessType: 'diet_chat', businessId: dietChatBusinessId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: dietChatRequestBody,
      responseResult: result, requestTime: dietChatRequestTime, responseTime: new Date(), status: 0
    });

    // 更新session的messages_json（追加本轮用户问+AI答）
    if (session_id) {
      try {
        await ensureHistoryTable();
        const [rows] = await db.query('SELECT messages_json FROM sl_ai_analysis WHERE id = ?', [session_id]);
        if (rows.length > 0) {
          let msgs = [];
          try { msgs = JSON.parse(rows[0].messages_json || '[]'); } catch(e) {}
          // 追加最后一条用户消息+本次AI回复
          const lastUserMsg = messages[messages.length - 1];
          if (lastUserMsg && lastUserMsg.role === 'user') msgs.push(lastUserMsg);
          msgs.push({ role: 'assistant', content });
          await db.query('UPDATE sl_ai_analysis SET messages_json = ?, updated_at = NOW(3) WHERE id = ?',
            [JSON.stringify(msgs), session_id]);
        }
      } catch(e) { console.error('[Diet Chat Save]', e.message); }
    }

    res.json({ success: true, reply: content });
  } catch (err) {
    recordAIRequest({
      userId: req.userId, businessType: 'diet_chat', businessId: dietChatBusinessId,
      requestUrl: aiConfig.apiUrl, requestModel: aiConfig.model, requestBody: dietChatRequestBody,
      responseResult: null, requestTime: dietChatRequestTime, responseTime: new Date(),
      status: 1, errorMsg: err.message
    });
    res.status(500).json({ error: 'AI对话失败：' + err.message });
  }
});

module.exports = router;
