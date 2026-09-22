const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const snowflake = require('../utils/snowflake');
const { operLog } = require('../logger');

const router = express.Router();

async function ensureDictTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_dict (
      id          BIGINT UNSIGNED NOT NULL PRIMARY KEY COMMENT '主键（雪花算法生成）',
      dict_type   VARCHAR(50)  NOT NULL COMMENT '字典类型，如 education_level/question_type',
      dict_code   VARCHAR(50)  NOT NULL COMMENT '字典项编码，如 primary/junior',
      dict_label  VARCHAR(100) NOT NULL COMMENT '字典项显示名称，如 小学',
      dict_icon   VARCHAR(20)  DEFAULT NULL COMMENT '字典项图标（emoji）',
      sort_order  INT NOT NULL DEFAULT 0 COMMENT '排序值，越小越靠前',
      status      TINYINT NOT NULL DEFAULT 1 COMMENT '状态：1启用 0停用',
      del_flag    TINYINT NOT NULL DEFAULT 0 COMMENT '删除标志（0正常 1删除）',
      created_by  BIGINT UNSIGNED DEFAULT NULL,
      created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_by  BIGINT UNSIGNED DEFAULT NULL,
      updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      remark      VARCHAR(500) DEFAULT NULL,
      UNIQUE KEY uk_type_code (dict_type, dict_code),
      INDEX idx_type (dict_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='通用字典表'
  `);

  // 预置学段字典数据（幂等）
  const [existing] = await db.query(`SELECT id FROM sl_sys_dict WHERE dict_type = 'education_level' LIMIT 1`);
  if (!existing.length) {
    const seed = [
      { code: 'primary',    label: '小学', icon: '🏫', sort: 1 },
      { code: 'junior',     label: '初中', icon: '📚', sort: 2 },
      { code: 'high',       label: '高中', icon: '🎓', sort: 3 },
      { code: 'university', label: '大学', icon: '🏛️', sort: 4 },
    ];
    for (const s of seed) {
      await db.query(
        `INSERT IGNORE INTO sl_sys_dict (id, dict_type, dict_code, dict_label, dict_icon, sort_order, status)
         VALUES (?, 'education_level', ?, ?, ?, ?, 1)`,
        [snowflake.nextId(), s.code, s.label, s.icon, s.sort]
      );
    }
  }
}

// 所有已使用的字典类型（去重列表，管理页面筛选用）
router.get('/types', auth, auth.requireAdmin, async (req, res) => {
  await ensureDictTable();
  const [rows] = await db.query(
    `SELECT DISTINCT dict_type FROM sl_sys_dict WHERE del_flag = 0 ORDER BY dict_type`
  );
  res.json(rows.map(r => r.dict_type));
});

// 按类型获取启用状态的字典项列表（供任意已登录页面消费，如题库筛选、学段展示）
router.get('/:type', auth, async (req, res) => {
  await ensureDictTable();
  const [rows] = await db.query(
    `SELECT id, dict_type, dict_code, dict_label, dict_icon, sort_order
     FROM sl_sys_dict WHERE dict_type = ? AND status = 1 AND del_flag = 0
     ORDER BY sort_order ASC`,
    [req.params.type]
  );
  res.json(rows);
});

// 管理员：查看全部字典项，支持 ?type= 过滤
router.get('/', auth, auth.requireAdmin, async (req, res) => {
  await ensureDictTable();
  const { type } = req.query;
  const where = ['del_flag = 0'];
  const params = [];
  if (type) { where.push('dict_type = ?'); params.push(type); }
  const [rows] = await db.query(
    `SELECT * FROM sl_sys_dict WHERE ${where.join(' AND ')} ORDER BY dict_type, sort_order ASC`,
    params
  );
  res.json(rows);
});

// 新增字典项
router.post('/', auth, auth.requireAdmin, operLog('字典管理', 1), async (req, res) => {
  await ensureDictTable();
  const { dict_type, dict_code, dict_label, dict_icon = '', sort_order = 0, status = 1 } = req.body;
  if (!dict_type || !dict_type.trim()) return res.status(400).json({ error: '字典类型不能为空' });
  if (!dict_code || !dict_code.trim()) return res.status(400).json({ error: '字典编码不能为空' });
  if (!dict_label || !dict_label.trim()) return res.status(400).json({ error: '字典名称不能为空' });

  const [dup] = await db.query(
    `SELECT id FROM sl_sys_dict WHERE dict_type = ? AND dict_code = ? AND del_flag = 0`,
    [dict_type.trim(), dict_code.trim()]
  );
  if (dup.length) return res.status(400).json({ error: '该类型下已存在相同编码的字典项' });

  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO sl_sys_dict (id, dict_type, dict_code, dict_label, dict_icon, sort_order, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, dict_type.trim().slice(0, 50), dict_code.trim().slice(0, 50), dict_label.trim().slice(0, 100),
     dict_icon ? String(dict_icon).slice(0, 20) : null, Number(sort_order) || 0, status ? 1 : 0, req.userId]
  );
  res.json({ success: true, id: id.toString() });
});

// 编辑字典项
router.put('/:id', auth, auth.requireAdmin, operLog('字典管理', 2), async (req, res) => {
  await ensureDictTable();
  const [rows] = await db.query(`SELECT id FROM sl_sys_dict WHERE id = ? AND del_flag = 0`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '字典项不存在' });

  const { dict_label, dict_icon, sort_order, status } = req.body;
  const updates = [];
  const vals = [];
  if (dict_label !== undefined) {
    if (!String(dict_label).trim()) return res.status(400).json({ error: '字典名称不能为空' });
    updates.push('dict_label = ?'); vals.push(String(dict_label).trim().slice(0, 100));
  }
  if (dict_icon !== undefined) { updates.push('dict_icon = ?'); vals.push(dict_icon ? String(dict_icon).slice(0, 20) : null); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); vals.push(Number(sort_order) || 0); }
  if (status !== undefined) { updates.push('status = ?'); vals.push(status ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: '没有要更新的字段' });

  vals.push(req.params.id);
  await db.query(`UPDATE sl_sys_dict SET ${updates.join(', ')} WHERE id = ?`, vals);
  res.json({ success: true });
});

// 删除字典项（软删除）
router.delete('/:id', auth, auth.requireAdmin, operLog('字典管理', 3), async (req, res) => {
  await ensureDictTable();
  const [rows] = await db.query(`SELECT id FROM sl_sys_dict WHERE id = ? AND del_flag = 0`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '字典项不存在' });

  await db.query(`UPDATE sl_sys_dict SET del_flag = 1 WHERE id = ?`, [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
module.exports.ensureDictTable = ensureDictTable;
