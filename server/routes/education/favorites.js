const express = require('express');
const db = require('../../db');
const auth = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const { operLog } = require('../../logger');

const router = express.Router();

// ===== 获取当前用户收藏分类列表 =====
router.get('/categories', auth, async (req, res) => {
  const [rows] = await db.query(
    `SELECT id, name, sort_order, created_at
     FROM edu_favorite_category
     WHERE user_id = ? AND del_flag = 0
     ORDER BY sort_order ASC, created_at ASC`,
    [req.userId]
  );
  res.json({ list: rows });
});

// ===== 新建收藏分类 =====
router.post('/categories', auth, operLog('收藏分类', 1), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '分类名称不能为空' });

  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO edu_favorite_category (id, user_id, name, created_by) VALUES (?, ?, ?, ?)`,
    [id, req.userId, name.trim(), req.userId]
  );
  res.json({ success: true, id: id.toString() });
});

// ===== 修改收藏分类（重命名/排序） =====
router.put('/categories/:id', auth, operLog('收藏分类', 2), async (req, res) => {
  const { id } = req.params;
  const { name, sort_order } = req.body;

  const [rows] = await db.query(
    'SELECT id FROM edu_favorite_category WHERE id = ? AND user_id = ? AND del_flag = 0',
    [id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: '分类不存在' });

  const fields = [];
  const values = [];
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: '分类名称不能为空' });
    fields.push('name = ?'); values.push(name.trim());
  }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(Number(sort_order)); }
  if (fields.length === 0) return res.status(400).json({ error: '没有要修改的字段' });

  fields.push('updated_by = ?');
  values.push(req.userId, id);

  await db.query(`UPDATE edu_favorite_category SET ${fields.join(', ')} WHERE id = ?`, values);
  res.json({ success: true });
});

// ===== 删除收藏分类（不级联删除收藏，仅置空分类） =====
router.delete('/categories/:id', auth, operLog('收藏分类', 3), async (req, res) => {
  const { id } = req.params;
  const [rows] = await db.query(
    'SELECT id FROM edu_favorite_category WHERE id = ? AND user_id = ? AND del_flag = 0',
    [id, req.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: '分类不存在' });

  await db.query(
    'UPDATE edu_question_favorite SET category_id = NULL WHERE category_id = ? AND user_id = ?',
    [id, req.userId]
  );
  await db.query(
    'UPDATE edu_favorite_category SET del_flag = 1, updated_by = ? WHERE id = ?',
    [req.userId, id]
  );
  res.json({ success: true });
});

// ===== 获取收藏列表（含题目详情） =====
router.get('/', auth, async (req, res) => {
  const { category_id, subject_id } = req.query;
  const conditions = ['f.user_id = ?', 'f.del_flag = 0'];
  const params = [req.userId];

  if (category_id === 'none') {
    conditions.push('f.category_id IS NULL');
  } else if (category_id) {
    conditions.push('f.category_id = ?');
    params.push(category_id);
  }
  if (subject_id) { conditions.push('f.subject_id = ?'); params.push(subject_id); }

  const where = conditions.join(' AND ');

  const [rows] = await db.query(
    `SELECT f.id AS favorite_id, f.question_id, f.category_id, f.created_at AS favorited_at,
            q.content, q.type, q.difficulty, q.options_json, q.answer, q.analysis,
            s.id AS subject_id, s.name AS subject_name,
            kn.name AS knowledge_name,
            fc.name AS category_name
     FROM edu_question_favorite f
     LEFT JOIN edu_question q ON f.question_id = q.id
     LEFT JOIN edu_subject s ON q.subject_id = s.id
     LEFT JOIN edu_knowledge_node kn ON q.knowledge_id = kn.id
     LEFT JOIN edu_favorite_category fc ON f.category_id = fc.id
     WHERE ${where}
     ORDER BY f.created_at DESC`,
    params
  );
  res.json({ list: rows });
});

// ===== 收藏题目（存在则更新分类） =====
router.post('/', auth, operLog('题目收藏', 1), async (req, res) => {
  const { question_id, category_id } = req.body;
  if (!question_id) return res.status(400).json({ error: '缺少question_id参数' });

  const [qRows] = await db.query(
    'SELECT id, subject_id FROM edu_question WHERE id = ? AND del_flag = 0',
    [question_id]
  );
  if (qRows.length === 0) return res.status(404).json({ error: '题目不存在' });

  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO edu_question_favorite (id, user_id, question_id, category_id, subject_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE category_id = VALUES(category_id), del_flag = 0, updated_by = VALUES(created_by)`,
    [id, req.userId, question_id, category_id || null, qRows[0].subject_id, req.userId]
  );
  res.json({ success: true });
});

// ===== 取消收藏 =====
router.delete('/:question_id', auth, operLog('题目收藏', 3), async (req, res) => {
  const { question_id } = req.params;
  await db.query(
    'UPDATE edu_question_favorite SET del_flag = 1, updated_by = ? WHERE question_id = ? AND user_id = ? AND del_flag = 0',
    [req.userId, question_id, req.userId]
  );
  res.json({ success: true });
});

// ===== 查询某题是否已收藏 =====
router.get('/check/:question_id', auth, async (req, res) => {
  const { question_id } = req.params;
  const [rows] = await db.query(
    'SELECT id, category_id FROM edu_question_favorite WHERE question_id = ? AND user_id = ? AND del_flag = 0',
    [question_id, req.userId]
  );
  res.json({ favorited: rows.length > 0, category_id: rows.length > 0 ? rows[0].category_id : null });
});

module.exports = router;
