/**
 * 审计项目路由 /api/audit/projects
 */
const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const { operLog } = require('../../logger');
const snowflake = require('../../utils/snowflake');
const { createdBy, updatedBy } = require('../../utils/auditContext');
const db = require('../../db');

router.use(auth);

// 项目列表（当前用户；管理员可见全部）
router.get('/', async (req, res) => {
  const keyword = (req.query.keyword || '').trim();
  const isAdmin = await auth.isAdmin(req.userId);
  const where = ['p.del_flag = 0'];
  const params = [];
  if (!isAdmin) {
    where.push('p.user_id = ?');
    params.push(req.userId);
  }
  if (keyword) {
    where.push('(p.project_name LIKE ? OR p.project_code LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }
  const [rows] = await db.query(
    `SELECT p.*,
       u.username AS owner_username, u.nickname AS owner_nickname,
       (SELECT COUNT(*) FROM audit_document d WHERE d.project_id=p.id AND d.del_flag=0) AS doc_count,
       (SELECT COUNT(*) FROM audit_document d WHERE d.project_id=p.id AND d.del_flag=0 AND d.parse_status='done') AS parsed_count,
       (SELECT COUNT(*) FROM audit_finding f WHERE f.project_id=p.id AND f.del_flag=0) AS finding_count
     FROM audit_project p
     LEFT JOIN sl_sys_user u ON u.id = p.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.updated_at DESC, p.id DESC LIMIT 200`,
    params
  );
  res.json(rows);
});

// 新建项目
router.post('/', operLog('审计项目', 1), async (req, res) => {
  const { project_name, project_code, audit_type, audit_period, description } = req.body || {};
  if (!project_name || !String(project_name).trim()) {
    return res.status(400).json({ error: '项目名称不能为空' });
  }
  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO audit_project
      (id, project_name, project_code, audit_type, audit_period, description, status, user_id, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    [id, String(project_name).trim().slice(0, 200), project_code || null, audit_type || 'cost',
     audit_period || null, description || null, req.userId, createdBy(), updatedBy()]
  );
  const [rows] = await db.query('SELECT * FROM audit_project WHERE id=?', [id]);
  res.json(rows[0]);
});

// 项目详情
router.get('/:id', async (req, res) => {
  const [rows] = await db.query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM audit_document d WHERE d.project_id=p.id AND d.del_flag=0) AS doc_count,
       (SELECT COUNT(*) FROM audit_document d WHERE d.project_id=p.id AND d.del_flag=0 AND d.parse_status='done') AS parsed_count,
       (SELECT COUNT(*) FROM audit_document d WHERE d.project_id=p.id AND d.del_flag=0 AND d.parse_status='failed') AS failed_count,
       (SELECT COUNT(*) FROM audit_finding f WHERE f.project_id=p.id AND f.del_flag=0) AS finding_count
     FROM audit_project p WHERE p.id=? AND p.del_flag=0`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '项目不存在' });
  res.json(rows[0]);
});

// 更新项目
router.put('/:id', operLog('审计项目', 2), async (req, res) => {
  const fields = ['project_name', 'project_code', 'audit_type', 'audit_period', 'description', 'status', 'remark'];
  const sets = [], params = [];
  fields.forEach(f => {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) {
      sets.push(`${f} = ?`);
      params.push(req.body[f]);
    }
  });
  if (sets.length === 0) return res.status(400).json({ error: '没有可更新字段' });
  sets.push('updated_by = ?');
  params.push(updatedBy());
  params.push(req.params.id);
  await db.query(`UPDATE audit_project SET ${sets.join(', ')} WHERE id=?`, params);
  const [rows] = await db.query('SELECT * FROM audit_project WHERE id=?', [req.params.id]);
  res.json(rows[0]);
});

// 删除项目（软删，同时软删资料/要素）
router.delete('/:id', operLog('审计项目', 3), async (req, res) => {
  await db.query('UPDATE audit_project SET del_flag=1, updated_by=? WHERE id=?', [updatedBy(), req.params.id]);
  await db.query('UPDATE audit_document SET del_flag=1 WHERE project_id=?', [req.params.id]);
  await db.query('UPDATE audit_element SET del_flag=1 WHERE project_id=?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
