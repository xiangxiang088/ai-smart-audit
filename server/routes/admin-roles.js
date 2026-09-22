const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const snowflake = require('../utils/snowflake');

const router = express.Router();

// 确保角色表和关联表存在，并插入预置角色
async function ensureRoleTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_role (
      id          BIGINT UNSIGNED NOT NULL COMMENT '雪花ID',
      role_name   VARCHAR(30)  NOT NULL COMMENT '角色名称',
      role_code   VARCHAR(30)  NOT NULL COMMENT '角色标识（英文，唯一）',
      description VARCHAR(200) DEFAULT NULL COMMENT '角色描述',
      status      TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
      sort_no     INT NOT NULL DEFAULT 0,
      del_flag    TINYINT NOT NULL DEFAULT 0,
      created_at  DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
      updated_at  DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uk_role_code (role_code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色表'
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_user_role (
      user_id  BIGINT UNSIGNED NOT NULL,
      role_id  BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (user_id, role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户角色关联'
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_role_menu (
      role_id  BIGINT UNSIGNED NOT NULL,
      menu_id  INT UNSIGNED NOT NULL,
      PRIMARY KEY (role_id, menu_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色菜单关联'
  `);
  // 预置两个角色（仅在为空时插入）
  const [existing] = await db.query('SELECT COUNT(*) AS cnt FROM sl_sys_role WHERE del_flag = 0');
  if (existing[0].cnt === 0) {
    await db.query(`
      INSERT INTO sl_sys_role (id, role_name, role_code, description, status, sort_no) VALUES
      (1, '教务处管理员', 'ADMIN', '系统管理员，可访问所有功能', 1, 1),
      (2, '学生', 'STUDENT', '普通学生，访问学习功能', 1, 2)
    `);
  }
}

// 角色列表（含用户数）
router.get('/', auth, auth.requireAdmin, async (req, res) => {
  await ensureRoleTables();
  const [rows] = await db.query(`
    SELECT r.id, r.role_name, r.role_code, r.description, r.status, r.sort_no,
           COUNT(ur.user_id) AS user_count,
           GROUP_CONCAT(rm.menu_id ORDER BY rm.menu_id SEPARATOR ',') AS menu_ids
    FROM sl_sys_role r
    LEFT JOIN sl_sys_user_role ur ON ur.role_id = r.id
    LEFT JOIN sl_sys_role_menu rm ON rm.role_id = r.id
    WHERE r.del_flag = 0
    GROUP BY r.id
    ORDER BY r.sort_no, r.id
  `);
  res.json(rows.map(r => ({
    ...r,
    id: String(r.id),
    menu_ids: r.menu_ids ? r.menu_ids.split(',').map(Number) : [],
  })));
});

// 创建角色
router.post('/', auth, auth.requireAdmin, operLog('角色管理', 1), async (req, res) => {
  await ensureRoleTables();
  const { role_name, role_code, description, status, sort_no } = req.body;
  if (!role_name || !role_name.trim()) return res.status(400).json({ error: '角色名称不能为空' });
  if (!role_code || !/^[A-Z_]+$/.test(role_code.trim().toUpperCase())) {
    return res.status(400).json({ error: '角色标识只能为大写字母和下划线' });
  }
  const code = role_code.trim().toUpperCase();
  const [dup] = await db.query('SELECT id FROM sl_sys_role WHERE role_code = ? AND del_flag = 0', [code]);
  if (dup.length) return res.status(400).json({ error: '角色标识已存在' });

  const id = snowflake.nextId();
  await db.query(
    'INSERT INTO sl_sys_role (id, role_name, role_code, description, status, sort_no) VALUES (?, ?, ?, ?, ?, ?)',
    [id, role_name.trim(), code, description || null, status !== undefined ? (status ? 1 : 0) : 1, sort_no || 0]
  );
  res.json({ success: true, id: String(id) });
});

// 编辑角色
router.put('/:id', auth, auth.requireAdmin, operLog('角色管理', 2), async (req, res) => {
  await ensureRoleTables();
  const [rows] = await db.query('SELECT id FROM sl_sys_role WHERE id = ? AND del_flag = 0', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '角色不存在' });

  const { role_name, description, status, sort_no } = req.body;
  const updates = [];
  const vals = [];
  if (role_name !== undefined) { updates.push('role_name = ?'); vals.push(String(role_name).trim().slice(0, 30)); }
  if (description !== undefined) { updates.push('description = ?'); vals.push(description || null); }
  if (status !== undefined) { updates.push('status = ?'); vals.push(status ? 1 : 0); }
  if (sort_no !== undefined) { updates.push('sort_no = ?'); vals.push(Number(sort_no) || 0); }
  if (!updates.length) return res.status(400).json({ error: '没有要更新的字段' });

  vals.push(req.params.id);
  await db.query(`UPDATE sl_sys_role SET ${updates.join(', ')} WHERE id = ?`, vals);
  res.json({ success: true });
});

// 设置角色关联菜单
router.put('/:id/menus', auth, auth.requireAdmin, operLog('角色管理', 2), async (req, res) => {
  await ensureRoleTables();
  const { menu_ids } = req.body;
  if (!Array.isArray(menu_ids)) return res.status(400).json({ error: 'menu_ids 必须为数组' });

  const [rows] = await db.query('SELECT id FROM sl_sys_role WHERE id = ? AND del_flag = 0', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '角色不存在' });

  await db.query('DELETE FROM sl_sys_role_menu WHERE role_id = ?', [req.params.id]);
  for (const menuId of menu_ids) {
    await db.query('INSERT IGNORE INTO sl_sys_role_menu (role_id, menu_id) VALUES (?, ?)', [req.params.id, menuId]);
  }
  res.json({ success: true });
});

// 删除角色（预置角色 id=1/2 不可删）
router.delete('/:id', auth, auth.requireAdmin, operLog('角色管理', 3), async (req, res) => {
  if (req.params.id === '1' || req.params.id === '2') {
    return res.status(400).json({ error: '预置角色不可删除' });
  }
  const [rows] = await db.query('SELECT id FROM sl_sys_role WHERE id = ? AND del_flag = 0', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '角色不存在' });

  await db.query('UPDATE sl_sys_role SET del_flag = 1 WHERE id = ?', [req.params.id]);
  await db.query('DELETE FROM sl_sys_user_role WHERE role_id = ?', [req.params.id]);
  await db.query('DELETE FROM sl_sys_role_menu WHERE role_id = ?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
module.exports.ensureRoleTables = ensureRoleTables;
