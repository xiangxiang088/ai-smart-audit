const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { getBookRole } = require('../middleware/bookAccess');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

// 获取商家/成员列表
router.get('/', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const type = req.query.type;
  let sql = 'SELECT * FROM sl_biz_entity WHERE book_id = ? AND del_flag = 0';
  const params = [bookId];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  const [entities] = await db.query(sql + ' ORDER BY name', params);
  res.json(entities);
});

// 创建商家/成员
router.post('/', auth, async (req, res) => {
  const { name, type, icon, book_id } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  const entId = snowflake.nextId();
  await db.query(`
    INSERT INTO sl_biz_entity (id, book_id, name, type, icon, created_by) VALUES (?, ?, ?, ?, ?, ?)
  `, [entId, bookId, name, type, icon || '🏪', createdBy()]);
  res.json({ id: entId, ...req.body });
});

// 删除
router.delete('/:id', auth, async (req, res) => {
  const entId = req.params.id;
  if (!entId) return res.status(400).json({ error: '无效的ID' });

  // 先查找所属账本并验证权限
  const [ents] = await db.query('SELECT book_id FROM sl_biz_entity WHERE id = ?', [entId]);
  if (ents.length === 0) return res.status(404).json({ error: '记录不存在' });
  const role = await getBookRole(req.userId, ents[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  await db.query('UPDATE sl_biz_entity SET del_flag = 1 WHERE id = ?', [entId]);
  res.json({ success: true });
});

module.exports = router;
