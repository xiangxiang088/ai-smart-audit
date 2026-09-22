const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const { getBookRole } = require('../middleware/bookAccess');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

router.get('/', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const [budgets] = await db.query(`
    SELECT b.*, c.name as category_name, c.icon as category_icon
    FROM sl_biz_budget b
    LEFT JOIN sl_biz_category c ON b.category_id = c.id AND c.del_flag = 0
    WHERE b.book_id = ? AND b.month = ? AND b.del_flag = 0
  `, [bookId, month]);
  res.json(budgets);
});

router.post('/', auth, operLog('预算管理', 1), async (req, res) => {
  const { book_id, category_id, month, amount } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  const catId = category_id || null;

  // MySQL 唯一索引对 NULL 不去重，需手动查询是否已存在（兼容总预算 category_id=NULL 的场景）
  const existing = await db.query(
    'SELECT id FROM sl_biz_budget WHERE book_id = ? AND category_id <=> ? AND month = ? AND del_flag = 0 LIMIT 1',
    [bookId, catId, month]
  );

  if (existing[0].length > 0) {
    const keepId = existing[0][0].id;
    await db.query(
      'UPDATE sl_biz_budget SET amount = ?, updated_by = ? WHERE id = ?',
      [amount, createdBy(), keepId]
    );
    // 清理历史重复数据（MySQL 唯一索引对 NULL 不去重导致的重复总预算行）
    await db.query(
      'UPDATE sl_biz_budget SET del_flag = 1 WHERE book_id = ? AND category_id <=> ? AND month = ? AND id <> ? AND del_flag = 0',
      [bookId, catId, month, keepId]
    );
  } else {
    const budId = snowflake.nextId();
    await db.query(
      'INSERT INTO sl_biz_budget (id, book_id, category_id, month, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [budId, bookId, catId, month, amount, createdBy()]
    );
  }
  res.json({ success: true });
});

router.delete('/:id', auth, operLog('预算管理', 3), async (req, res) => {
  const budId = req.params.id;
  if (!budId) return res.status(400).json({ error: '无效的ID' });

  const [buds] = await db.query('SELECT book_id FROM sl_biz_budget WHERE id = ?', [budId]);
  if (buds.length === 0) return res.status(404).json({ error: '预算记录不存在' });
  const role = await getBookRole(req.userId, buds[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  await db.query('UPDATE sl_biz_budget SET del_flag = 1 WHERE id = ?', [budId]);
  res.json({ success: true });
});

module.exports = router;
