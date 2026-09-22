const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');

const router = express.Router();

// 内置菜单（审计产品 + 后台管理）
const BUILTIN_MENUS = [
  { page_key: 'admin', menu_name: '后台管理', menu_icon: '⚙️', menu_url: '/pc/admin.html', sort_no: 99, is_builtin: 1 },
];

// 后台管理下的功能分组节点（menu_type=0，挂在 admin 下）
const BUILTIN_GROUPS = [
  { page_key: 'grp_notice',   menu_name: '公告管理',   menu_icon: '📢', sort_no: 40 },
  { page_key: 'grp_user',     menu_name: '用户管理',   menu_icon: '👥', sort_no: 50 },
  { page_key: 'grp_role',     menu_name: '角色管理',   menu_icon: '🎭', sort_no: 60 },
  { page_key: 'grp_menu',     menu_name: '菜单管理',   menu_icon: '🗂️', sort_no: 70 },
];

// 按钮权限节点（menu_type=1，挂在各自分组下，group_key 对应 BUILTIN_GROUPS.page_key）
const BUILTIN_BUTTONS = [
  { page_key: 'btn_notice_add',         menu_name: '新增公告',    menu_icon: '🔘', perm_key: 'notice:add',           sort_no: 41, group_key: 'grp_notice'   },
  { page_key: 'btn_notice_edit',        menu_name: '编辑公告',    menu_icon: '🔘', perm_key: 'notice:edit',          sort_no: 42, group_key: 'grp_notice'   },
  { page_key: 'btn_notice_delete',      menu_name: '删除公告',    menu_icon: '🔘', perm_key: 'notice:delete',        sort_no: 43, group_key: 'grp_notice'   },
  { page_key: 'btn_user_add',           menu_name: '新增用户',    menu_icon: '🔘', perm_key: 'user:add',             sort_no: 51, group_key: 'grp_user'     },
  { page_key: 'btn_user_edit',          menu_name: '编辑用户',    menu_icon: '🔘', perm_key: 'user:edit',            sort_no: 52, group_key: 'grp_user'     },
  { page_key: 'btn_user_delete',        menu_name: '删除用户',    menu_icon: '🔘', perm_key: 'user:delete',          sort_no: 53, group_key: 'grp_user'     },
  { page_key: 'btn_user_assign_roles',  menu_name: '分配角色',    menu_icon: '🔘', perm_key: 'user:assign_roles',    sort_no: 54, group_key: 'grp_user'     },
  { page_key: 'btn_user_reset_pwd',     menu_name: '重置密码',    menu_icon: '🔘', perm_key: 'user:reset_password',  sort_no: 55, group_key: 'grp_user'     },
  { page_key: 'btn_role_add',           menu_name: '新增角色',    menu_icon: '🔘', perm_key: 'role:add',             sort_no: 61, group_key: 'grp_role'     },
  { page_key: 'btn_role_edit',          menu_name: '编辑角色',    menu_icon: '🔘', perm_key: 'role:edit',            sort_no: 62, group_key: 'grp_role'     },
  { page_key: 'btn_role_delete',        menu_name: '删除角色',    menu_icon: '🔘', perm_key: 'role:delete',          sort_no: 63, group_key: 'grp_role'     },
  { page_key: 'btn_role_assign_menus',  menu_name: '配置菜单权限',menu_icon: '🔘', perm_key: 'role:assign_menus',    sort_no: 64, group_key: 'grp_role'     },
  { page_key: 'btn_menu_add',           menu_name: '新增菜单',    menu_icon: '🔘', perm_key: 'menu:add',             sort_no: 71, group_key: 'grp_menu'     },
  { page_key: 'btn_menu_edit',          menu_name: '编辑菜单',    menu_icon: '🔘', perm_key: 'menu:edit',            sort_no: 72, group_key: 'grp_menu'     },
  { page_key: 'btn_menu_delete',        menu_name: '删除菜单',    menu_icon: '🔘', perm_key: 'menu:delete',          sort_no: 73, group_key: 'grp_menu'     },
];

async function ensureMenuTables() {
  // 建表（旧结构兼容）
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_menu (
      id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      page_key   VARCHAR(30)  NOT NULL UNIQUE COMMENT '页面标识',
      menu_name  VARCHAR(30)  NOT NULL COMMENT '显示名称',
      menu_icon  VARCHAR(20)  NOT NULL COMMENT '图标 emoji',
      menu_url   VARCHAR(100) NOT NULL DEFAULT '' COMMENT '页面路径',
      sort_no    INT NOT NULL DEFAULT 0,
      is_enabled TINYINT NOT NULL DEFAULT 1 COMMENT '1启用 0禁用',
      is_builtin TINYINT NOT NULL DEFAULT 0 COMMENT '1内置不可删',
      updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='菜单配置'
  `);

  // 迁移：添加按钮权限所需字段（幂等）
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sl_sys_menu'
     AND COLUMN_NAME IN ('parent_id','menu_type','perm_key')`
  );
  const existingCols = cols.map(c => c.COLUMN_NAME);
  if (!existingCols.includes('parent_id')) {
    await db.query(`ALTER TABLE sl_sys_menu ADD COLUMN parent_id INT NOT NULL DEFAULT 0 COMMENT '父菜单ID，0=一级' AFTER menu_url`);
  }
  if (!existingCols.includes('menu_type')) {
    await db.query(`ALTER TABLE sl_sys_menu ADD COLUMN menu_type TINYINT NOT NULL DEFAULT 0 COMMENT '0=菜单 1=按钮' AFTER parent_id`);
  }
  if (!existingCols.includes('perm_key')) {
    await db.query(`ALTER TABLE sl_sys_menu ADD COLUMN perm_key VARCHAR(60) DEFAULT NULL COMMENT '权限标识 如 question:add' AFTER menu_type`);
    await db.query(`ALTER TABLE sl_sys_menu ADD INDEX idx_perm_key (perm_key)`);
  }

  // 插入内置菜单
  for (const m of BUILTIN_MENUS) {
    await db.query(
      `INSERT IGNORE INTO sl_sys_menu (page_key, menu_name, menu_icon, menu_url, sort_no, is_enabled, is_builtin, parent_id, menu_type)
       VALUES (?, ?, ?, ?, ?, 1, ?, 0, 0)`,
      [m.page_key, m.menu_name, m.menu_icon, m.menu_url, m.sort_no, m.is_builtin]
    );
  }

  // 插入功能分组节点（挂在 admin 下，menu_type=0）
  const [adminRows] = await db.query(`SELECT id FROM sl_sys_menu WHERE page_key = 'admin' LIMIT 1`);
  if (adminRows.length) {
    const adminId = adminRows[0].id;
    for (const g of BUILTIN_GROUPS) {
      await db.query(
        `INSERT IGNORE INTO sl_sys_menu (page_key, menu_name, menu_icon, menu_url, sort_no, is_enabled, is_builtin, parent_id, menu_type)
         VALUES (?, ?, ?, '', ?, 1, 1, ?, 0)`,
        [g.page_key, g.menu_name, g.menu_icon, g.sort_no, adminId]
      );
    }
  }

  // 插入按钮权限节点（挂在各自分组下，menu_type=1）
  for (const b of BUILTIN_BUTTONS) {
    const [grpRows] = await db.query(`SELECT id FROM sl_sys_menu WHERE page_key = ? LIMIT 1`, [b.group_key]);
    if (!grpRows.length) continue;
    await db.query(
      `INSERT IGNORE INTO sl_sys_menu (page_key, menu_name, menu_icon, menu_url, sort_no, is_enabled, is_builtin, parent_id, menu_type, perm_key)
       VALUES (?, ?, ?, '', ?, 1, 1, ?, 1, ?)`,
      [b.page_key, b.menu_name, b.menu_icon, b.sort_no, grpRows[0].id, b.perm_key]
    );
  }

  // 确保 sl_sys_role_menu 表存在
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_role_menu (
      role_id  BIGINT UNSIGNED NOT NULL,
      menu_id  INT UNSIGNED NOT NULL,
      PRIMARY KEY (role_id, menu_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色菜单关联'
  `);

  // 错题本从学情分析拆分而来：已拥有 analytics 权限的角色自动继承 wrongbook 权限
  // （幂等：INSERT IGNORE + 主键约束，可安全重复执行）
  await db.query(`
    INSERT IGNORE INTO sl_sys_role_menu (role_id, menu_id)
    SELECT rm.role_id, wb.id
    FROM sl_sys_role_menu rm
    JOIN sl_sys_menu src ON src.id = rm.menu_id AND src.page_key = 'analytics'
    JOIN sl_sys_menu wb  ON wb.page_key = 'wrongbook'
  `);
}

// 当前用户可访问的菜单（给侧边栏使用，无需 requireAdmin）
router.get('/my', auth, async (req, res) => {
  await ensureMenuTables();
  const { isAdmin } = require('../middleware/auth');
  const adminFlag = await isAdmin(req.userId);

  if (adminFlag) {
    const [rows] = await db.query('SELECT * FROM sl_sys_menu WHERE is_enabled = 1 ORDER BY sort_no');
    return res.json(rows);
  }

  const [rows] = await db.query(`
    SELECT DISTINCT m.*
    FROM sl_sys_menu m
    INNER JOIN sl_sys_role_menu rm ON rm.menu_id = m.id
    INNER JOIN sl_sys_user_role ur ON ur.role_id = rm.role_id
    WHERE ur.user_id = ? AND m.is_enabled = 1
    ORDER BY m.sort_no
  `, [req.userId]);

  if (rows.length === 0) {
    const [all] = await db.query('SELECT * FROM sl_sys_menu WHERE is_enabled = 1 AND menu_type = 0 ORDER BY sort_no');
    return res.json(all);
  }
  res.json(rows);
});

// 菜单列表（管理员）
router.get('/', auth, auth.requireAdmin, async (req, res) => {
  await ensureMenuTables();
  const [rows] = await db.query('SELECT * FROM sl_sys_menu ORDER BY parent_id, sort_no');
  res.json(rows);
});

// 新增菜单或按钮
router.post('/', auth, auth.requireAdmin, operLog('菜单管理', 1), async (req, res) => {
  await ensureMenuTables();
  const { page_key, menu_name, menu_icon, menu_url, sort_no, parent_id, menu_type, perm_key } = req.body;
  if (!menu_name || !menu_name.trim()) return res.status(400).json({ error: '名称不能为空' });

  const type = Number(menu_type) === 1 ? 1 : 0;
  if (type === 0 && (!menu_url || !menu_url.trim())) return res.status(400).json({ error: '菜单页面路径不能为空' });
  if (type === 1 && (!perm_key || !perm_key.trim())) return res.status(400).json({ error: '按钮权限标识不能为空' });

  const key = page_key || `custom_${Date.now()}`;
  const pid = Number(parent_id) || 0;

  await db.query(
    `INSERT INTO sl_sys_menu (page_key, menu_name, menu_icon, menu_url, sort_no, is_enabled, is_builtin, parent_id, menu_type, perm_key)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?)`,
    [key, menu_name.trim().slice(0, 30), menu_icon || (type === 1 ? '🔘' : '📄'),
     menu_url ? menu_url.trim() : '', sort_no || 99, pid, type, perm_key ? perm_key.trim().slice(0, 60) : null]
  );
  res.json({ success: true });
});

// 编辑菜单/按钮
router.put('/:id', auth, auth.requireAdmin, operLog('菜单管理', 2), async (req, res) => {
  await ensureMenuTables();
  const [rows] = await db.query('SELECT id FROM sl_sys_menu WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '菜单不存在' });

  const { menu_name, menu_icon, menu_url, sort_no, is_enabled, parent_id, menu_type, perm_key } = req.body;
  const updates = [];
  const vals = [];
  if (menu_name  !== undefined) { updates.push('menu_name = ?');  vals.push(String(menu_name).trim().slice(0, 30)); }
  if (menu_icon  !== undefined) { updates.push('menu_icon = ?');  vals.push(String(menu_icon).slice(0, 20)); }
  if (menu_url   !== undefined) { updates.push('menu_url = ?');   vals.push(String(menu_url).trim().slice(0, 100)); }
  if (sort_no    !== undefined) { updates.push('sort_no = ?');    vals.push(Number(sort_no) || 0); }
  if (is_enabled !== undefined) { updates.push('is_enabled = ?'); vals.push(is_enabled ? 1 : 0); }
  if (parent_id  !== undefined) { updates.push('parent_id = ?'); vals.push(Number(parent_id) || 0); }
  if (menu_type  !== undefined) { updates.push('menu_type = ?'); vals.push(Number(menu_type) === 1 ? 1 : 0); }
  if (perm_key   !== undefined) { updates.push('perm_key = ?');  vals.push(perm_key ? String(perm_key).trim().slice(0, 60) : null); }
  if (!updates.length) return res.status(400).json({ error: '没有要更新的字段' });

  vals.push(req.params.id);
  await db.query(`UPDATE sl_sys_menu SET ${updates.join(', ')} WHERE id = ?`, vals);
  res.json({ success: true });
});

// 删除菜单/按钮（内置不可删，删父菜单时级联删子按钮）
router.delete('/:id', auth, auth.requireAdmin, operLog('菜单管理', 3), async (req, res) => {
  await ensureMenuTables();
  const [rows] = await db.query('SELECT id, is_builtin FROM sl_sys_menu WHERE id = ?', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '菜单不存在' });
  if (rows[0].is_builtin) return res.status(400).json({ error: '内置菜单不可删除' });

  // 级联删子按钮
  const [children] = await db.query('SELECT id FROM sl_sys_menu WHERE parent_id = ?', [req.params.id]);
  if (children.length) {
    const childIds = children.map(r => r.id);
    await db.query('DELETE FROM sl_sys_role_menu WHERE menu_id IN (?)', [childIds]);
    await db.query('DELETE FROM sl_sys_menu WHERE parent_id = ?', [req.params.id]);
  }

  await db.query('DELETE FROM sl_sys_menu WHERE id = ?', [req.params.id]);
  await db.query('DELETE FROM sl_sys_role_menu WHERE menu_id = ?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
module.exports.ensureMenuTables = ensureMenuTables;
