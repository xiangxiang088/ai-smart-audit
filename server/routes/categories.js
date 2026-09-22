const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const { getBookRole } = require('../middleware/bookAccess');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

// 获取分类列表
router.get('/', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const type = req.query.type;
  let sql = 'SELECT * FROM sl_biz_category WHERE book_id = ? AND del_flag = 0';
  const params = [bookId];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' ORDER BY sort_order, id';
  const [cats] = await db.query(sql, params);

  // 构建二级层级结构（第三级分类扁平融合到对应一级分类下）
  const parents = cats.filter(c => c.parent_id === null);
  const catToTop = {};
  cats.forEach(c => {
    if (c.parent_id === null) {
      catToTop[c.id] = c.id;
    } else {
      catToTop[c.id] = catToTop[c.parent_id] || c.parent_id;
    }
  });
  const result = parents.map(p => {
    const children = cats
      .filter(c => catToTop[c.id] === p.id && c.parent_id !== null)
      .map(child => ({ ...child, children: [] }));
    return { ...p, children };
  });

  res.json(result);
});

// 创建分类
router.post('/', auth, operLog('收支分类', 1), async (req, res) => {
  const { name, parent_id, type, icon, color, book_id } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  const catId = snowflake.nextId();
  await db.query(`
    INSERT INTO sl_biz_category (id, book_id, name, parent_id, type, icon, color, is_system, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, false, ?)
  `, [catId, bookId, name, parent_id || null, type, icon || '💸', color || '#3b82f6', createdBy()]);
  res.json({ id: catId, ...req.body });
});

// 更新分类
router.put('/:id', auth, operLog('收支分类', 2), async (req, res) => {
  const catId = req.params.id;
  // 先查找分类所属账本并验证权限
  const [cats] = await db.query('SELECT book_id FROM sl_biz_category WHERE id = ?', [catId]);
  if (cats.length === 0) return res.status(404).json({ error: '分类不存在' });
  const role = await getBookRole(req.userId, cats[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  const { name, icon, color } = req.body;
  await db.query('UPDATE sl_biz_category SET name=?, icon=?, color=? WHERE id=?',
    [name, icon, color, catId]);
  res.json({ success: true });
});

// 删除分类
router.delete('/:id', auth, operLog('收支分类', 3), async (req, res) => {
  const catId = req.params.id;
  const [cats] = await db.query('SELECT book_id, is_system FROM sl_biz_category WHERE id = ?', [catId]);
  if (cats.length === 0) return res.status(404).json({ error: '分类不存在' });
  if (cats[0].is_system) return res.status(400).json({ error: '系统分类不能删除' });
  const role = await getBookRole(req.userId, cats[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  // 同时逻辑删除子分类和孙分类（三级）
  const [children] = await db.query('SELECT id FROM sl_biz_category WHERE parent_id = ? AND del_flag = 0', [catId]);
  for (const child of children) {
    await db.query('UPDATE sl_biz_category SET del_flag = 1 WHERE parent_id = ?', [child.id]);
  }
  await db.query('UPDATE sl_biz_category SET del_flag = 1 WHERE parent_id = ?', [catId]);
  await db.query('UPDATE sl_biz_category SET del_flag = 1 WHERE id = ?', [catId]);
  res.json({ success: true });
});

// 获取系统分类图标池（用于新增/编辑分类时选择图标）
router.get('/icons', auth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT DISTINCT icon FROM sl_biz_category WHERE is_system = 1 AND icon IS NOT NULL AND del_flag = 0'
  );
  res.json(rows.map(r => r.icon).filter(Boolean));
});

module.exports = router;
