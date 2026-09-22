const express = require('express');
const db = require('../../db');
const auth = require('../../middleware/auth');
const snowflake = require('../../utils/snowflake');
const { operLog } = require('../../logger');

const router = express.Router();

// ===== 获取学科列表 =====
router.get('/subjects', auth, async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, name, code, icon, education_level, cover_image, sort_order FROM edu_subject WHERE del_flag = 0 ORDER BY education_level ASC, sort_order ASC'
  );
  res.json(rows);
});

// ===== 获取指定学科的知识点树（树形结构）=====
router.get('/subjects/:id/tree', auth, async (req, res) => {
  const { id } = req.params;
  const [nodes] = await db.query(
    `SELECT id, parent_id, name, level, sort_order, difficulty
     FROM edu_knowledge_node
     WHERE subject_id = ? AND del_flag = 0
     ORDER BY level ASC, sort_order ASC`,
    [id]
  );
  // 构建树形结构
  const map = {};
  const roots = [];
  for (const n of nodes) {
    map[n.id] = { ...n, children: [] };
  }
  for (const n of nodes) {
    if (n.parent_id && map[n.parent_id]) {
      map[n.parent_id].children.push(map[n.id]);
    } else {
      roots.push(map[n.id]);
    }
  }
  res.json(roots);
});

// ===== 获取指定学科的知识点扁平列表（热力图用）=====
router.get('/subjects/:id/nodes', auth, async (req, res) => {
  const { id } = req.params;
  const [nodes] = await db.query(
    `SELECT id, parent_id, name, level, sort_order, difficulty
     FROM edu_knowledge_node
     WHERE subject_id = ? AND del_flag = 0
     ORDER BY level ASC, sort_order ASC`,
    [id]
  );
  res.json(nodes);
});

// ===== 管理员：获取学科完整列表 =====
router.get('/admin/subjects', auth, auth.requireAdmin, async (req, res) => {
  const [rows] = await db.query(
    'SELECT id, name, code, icon, education_level, cover_image, sort_order, created_at FROM edu_subject WHERE del_flag = 0 ORDER BY education_level ASC, sort_order ASC'
  );
  res.json(rows);
});

// ===== 管理员：新建学科 =====
router.post('/admin/subjects', auth, auth.requireAdmin, operLog('学科管理', 1), async (req, res) => {
  const {
    name, code,
    icon = '📚',
    education_level = 'junior',
    cover_image = null,
    sort_order = 0
  } = req.body;
  if (!name || !code) return res.status(400).json({ error: '学科名称和编码不能为空' });

  const [levelRows] = await db.query(
    `SELECT dict_code FROM sl_sys_dict WHERE dict_type = 'education_level' AND status = 1 AND del_flag = 0`
  );
  const validLevels = levelRows.map(r => r.dict_code);
  if (!validLevels.includes(education_level)) {
    return res.status(400).json({ error: `education_level 无效，只支持 ${validLevels.join('/')}` });
  }

  const id = snowflake.nextId();
  await db.query(
    'INSERT INTO edu_subject (id, name, code, icon, education_level, cover_image, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, code.toUpperCase(), icon, education_level, cover_image, sort_order, req.userId]
  );
  res.json({ success: true, id: id.toString() });
});

// ===== 管理员：修改学科 =====
router.put('/admin/subjects/:id', auth, auth.requireAdmin, operLog('学科管理', 2), async (req, res) => {
  const { id } = req.params;
  const { name, code, icon, education_level, cover_image, sort_order } = req.body;

  const [rows] = await db.query('SELECT id FROM edu_subject WHERE id = ? AND del_flag = 0', [id]);
  if (rows.length === 0) return res.status(404).json({ error: '学科不存在' });

  const fields = [], values = [];
  if (name !== undefined)            { fields.push('name = ?');            values.push(name); }
  if (code !== undefined)            { fields.push('code = ?');            values.push(code.toUpperCase()); }
  if (icon !== undefined)            { fields.push('icon = ?');            values.push(icon); }
  if (education_level !== undefined) { fields.push('education_level = ?'); values.push(education_level); }
  if (cover_image !== undefined)     { fields.push('cover_image = ?');     values.push(cover_image); }
  if (sort_order !== undefined)      { fields.push('sort_order = ?');      values.push(Number(sort_order)); }
  if (fields.length === 0) return res.status(400).json({ error: '没有要修改的字段' });

  fields.push('updated_by = ?');
  values.push(req.userId, id);
  await db.query(`UPDATE edu_subject SET ${fields.join(', ')} WHERE id = ?`, values);
  res.json({ success: true });
});

// ===== 管理员：逻辑删除学科 =====
router.delete('/admin/subjects/:id', auth, auth.requireAdmin, operLog('学科管理', 3), async (req, res) => {
  const { id } = req.params;
  const [rows] = await db.query('SELECT id FROM edu_subject WHERE id = ? AND del_flag = 0', [id]);
  if (rows.length === 0) return res.status(404).json({ error: '学科不存在' });

  const [[{ cnt }]] = await db.query(
    'SELECT COUNT(*) AS cnt FROM edu_question WHERE subject_id = ? AND del_flag = 0', [id]
  );
  if (cnt > 0) return res.status(400).json({ error: `该学科下还有 ${cnt} 道题目，请先删除题目再删除学科` });

  await db.query('UPDATE edu_subject SET del_flag = 1, updated_by = ? WHERE id = ?', [req.userId, id]);
  res.json({ success: true });
});

// ===== 管理员：新建知识点 =====
router.post('/admin/knowledge-nodes', auth, auth.requireAdmin, operLog('知识点管理', 1), async (req, res) => {
  const { subject_id, parent_id = null, name, level = 3, sort_order = 0, difficulty = 3, prerequisite_ids = null } = req.body;
  if (!subject_id || !name) return res.status(400).json({ error: '学科ID和知识点名称不能为空' });

  // 验证学科存在
  const [subRows] = await db.query(
    'SELECT id FROM edu_subject WHERE id = ? AND del_flag = 0', [subject_id]
  );
  if (subRows.length === 0) return res.status(404).json({ error: '学科不存在' });

  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO edu_knowledge_node
     (id, subject_id, parent_id, name, level, sort_order, difficulty, prerequisite_ids, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, subject_id, parent_id || null, name, level, sort_order, difficulty,
     prerequisite_ids ? JSON.stringify(prerequisite_ids) : null, req.userId]
  );
  res.json({ success: true, id: id.toString() });
});

// ===== 管理员：修改知识点 =====
router.put('/admin/knowledge-nodes/:id', auth, auth.requireAdmin, operLog('知识点管理', 2), async (req, res) => {
  const { id } = req.params;
  const { name, level, sort_order, difficulty, prerequisite_ids } = req.body;

  const [rows] = await db.query('SELECT id FROM edu_knowledge_node WHERE id = ? AND del_flag = 0', [id]);
  if (rows.length === 0) return res.status(404).json({ error: '知识点不存在' });

  const fields = [], values = [];
  if (name !== undefined)             { fields.push('name = ?');             values.push(name); }
  if (level !== undefined)            { fields.push('level = ?');            values.push(Number(level)); }
  if (sort_order !== undefined)       { fields.push('sort_order = ?');       values.push(Number(sort_order)); }
  if (difficulty !== undefined)       { fields.push('difficulty = ?');       values.push(Number(difficulty)); }
  if (prerequisite_ids !== undefined) {
    fields.push('prerequisite_ids = ?');
    values.push(prerequisite_ids ? JSON.stringify(prerequisite_ids) : null);
  }
  if (fields.length === 0) return res.status(400).json({ error: '没有要修改的字段' });

  fields.push('updated_by = ?');
  values.push(req.userId, id);
  await db.query(`UPDATE edu_knowledge_node SET ${fields.join(', ')} WHERE id = ?`, values);
  res.json({ success: true });
});

// ===== 管理员：逻辑删除知识点 =====
router.delete('/admin/knowledge-nodes/:id', auth, auth.requireAdmin, operLog('知识点管理', 3), async (req, res) => {
  const { id } = req.params;
  const [rows] = await db.query('SELECT id FROM edu_knowledge_node WHERE id = ? AND del_flag = 0', [id]);
  if (rows.length === 0) return res.status(404).json({ error: '知识点不存在' });

  const [[{ childCnt }]] = await db.query(
    'SELECT COUNT(*) AS childCnt FROM edu_knowledge_node WHERE parent_id = ? AND del_flag = 0', [id]
  );
  if (childCnt > 0) return res.status(400).json({ error: '请先删除该节点下的子知识点' });

  await db.query('UPDATE edu_knowledge_node SET del_flag = 1, updated_by = ? WHERE id = ?', [req.userId, id]);
  res.json({ success: true });
});

module.exports = router;
