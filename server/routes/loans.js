const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const { getBookRole } = require('../middleware/bookAccess');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

// 兼容已有数据库：补 image_url 字段
db.query(`
  SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sl_biz_loan' AND COLUMN_NAME = 'image_url'
`).then(([cols]) => {
  if (!cols.length) {
    return db.query(
      `ALTER TABLE sl_biz_loan ADD COLUMN image_url VARCHAR(255) DEFAULT NULL COMMENT '凭证图片URL' AFTER note`
    );
  }
}).catch(() => {});

// 获取借贷列表
router.get('/', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const [loans] = await db.query(
    'SELECT * FROM sl_biz_loan WHERE user_id = ? AND book_id = ? AND del_flag = 0 ORDER BY created_at DESC',
    [req.userId, bookId]
  );

  for (const loan of loans) {
    const [records] = await db.query(
      'SELECT * FROM sl_biz_loan_record WHERE loan_id = ? AND del_flag = 0 ORDER BY repay_date',
      [loan.id]
    );
    loan.records = records;
  }

  res.json(loans);
});

// 创建借贷记录
router.post('/', auth, operLog('借贷记录', 1), async (req, res) => {
  const { book_id, type, contact_name, amount, note, loan_date, due_date, image_url } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  const loanNewId = snowflake.nextId();
  await db.query(`
    INSERT INTO sl_biz_loan (id, book_id, user_id, type, contact_name, amount, remaining, note, loan_date, due_date, image_url, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [loanNewId, bookId, req.userId, type, contact_name, amount, amount, note || '', loan_date, due_date || null, image_url || null, createdBy()]);
  res.json({ id: loanNewId, ...req.body });
});

// 还款
router.post('/:id/repay', auth, operLog('借贷还款', 1), async (req, res) => {
  const loanId = req.params.id;
  if (!loanId) return res.status(400).json({ error: '无效的ID' });
  const { amount, repay_date, note } = req.body;

  // 验证该借贷记录属于当前用户
  const [loans] = await db.query('SELECT user_id, book_id FROM sl_biz_loan WHERE id = ? AND del_flag = 0', [loanId]);
  if (loans.length === 0) return res.status(404).json({ error: '记录不存在' });
  if (loans[0].user_id !== req.userId) return res.status(403).json({ error: '无权操作' });
  const role = await getBookRole(req.userId, loans[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    const repayId = snowflake.nextId();
    await connection.query(
      'INSERT INTO sl_biz_loan_record (id, loan_id, amount, repay_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [repayId, loanId, amount, repay_date, note || '', createdBy()]
    );
    await connection.query(
      'UPDATE sl_biz_loan SET remaining = remaining - ? WHERE id = ? AND user_id = ?',
      [amount, loanId, req.userId]
    );
    await connection.query(
      'UPDATE sl_biz_loan SET is_settled = (remaining <= 0) WHERE id = ?',
      [loanId]
    );
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

// 编辑备注和凭证图片
router.patch('/:id', auth, operLog('借贷记录', 2), async (req, res) => {
  const loanId = req.params.id;
  const { note, image_url } = req.body;

  const [loans] = await db.query('SELECT user_id FROM sl_biz_loan WHERE id = ? AND del_flag = 0', [loanId]);
  if (loans.length === 0) return res.status(404).json({ error: '记录不存在' });
  if (loans[0].user_id !== req.userId) return res.status(403).json({ error: '无权操作' });

  await db.query(
    'UPDATE sl_biz_loan SET note = ?, image_url = ?, updated_by = ? WHERE id = ?',
    [note ?? null, image_url || null, updatedBy(), loanId]
  );
  res.json({ success: true });
});

// 删除借贷
router.delete('/:id', auth, operLog('借贷记录', 3), async (req, res) => {
  const loanId = req.params.id;
  if (!loanId) return res.status(400).json({ error: '无效的ID' });

  const [loans] = await db.query('SELECT user_id, book_id FROM sl_biz_loan WHERE id = ? AND del_flag = 0', [loanId]);
  if (loans.length === 0) return res.status(404).json({ error: '记录不存在' });
  if (loans[0].user_id !== req.userId) return res.status(403).json({ error: '无权操作' });
  const role = await getBookRole(req.userId, loans[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  await db.query('UPDATE sl_biz_loan_record SET del_flag = 1 WHERE loan_id = ?', [loanId]);
  await db.query('UPDATE sl_biz_loan SET del_flag = 1 WHERE id = ? AND user_id = ?', [loanId, req.userId]);
  res.json({ success: true });
});

module.exports = router;
