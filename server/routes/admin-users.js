const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const snowflake = require('../utils/snowflake');

const router = express.Router();

// 确保 sl_sys_user 有 is_admin 字段，并迁移数据
async function ensureIsAdminColumn() {
  const [cols] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sl_sys_user' AND COLUMN_NAME = 'is_admin'`
  );
  if (!cols.length) {
    await db.query(
      `ALTER TABLE sl_sys_user
       ADD COLUMN is_admin TINYINT NOT NULL DEFAULT 0 COMMENT '0普通用户 1超级管理员' AFTER email`
    );
    // 将原来最小 id 用户标记为超级管理员
    await db.query(
      `UPDATE sl_sys_user SET is_admin = 1
       WHERE id = (SELECT min_id FROM (SELECT MIN(id) AS min_id FROM sl_sys_user WHERE del_flag = 0) t)`
    );
  }
}

// 用户列表（分页 + 关键词搜索）
router.get('/', auth, auth.requireAdmin, async (req, res) => {
  await ensureIsAdminColumn();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 20));
  const offset = (page - 1) * pageSize;
  const keyword = (req.query.keyword || '').trim();

  const where = ['u.del_flag = 0'];
  const params = [];
  if (keyword) {
    where.push('(u.username LIKE ? OR u.nickname LIKE ?)');
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM sl_sys_user u WHERE ${where.join(' AND ')}`,
    params
  );
  const [rows] = await db.query(
    `SELECT u.id, u.username, u.nickname, u.email, u.is_admin, u.created_at,
            GROUP_CONCAT(r.role_name ORDER BY r.sort_no SEPARATOR ',') AS role_names,
            GROUP_CONCAT(r.id ORDER BY r.sort_no SEPARATOR ',') AS role_ids
     FROM sl_sys_user u
     LEFT JOIN sl_sys_user_role ur ON ur.user_id = u.id
     LEFT JOIN sl_sys_role r ON r.id = ur.role_id AND r.del_flag = 0 AND r.status = 1
     WHERE ${where.join(' AND ')}
     GROUP BY u.id
     ORDER BY u.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  res.json({
    list: rows.map(r => ({
      ...r,
      id: String(r.id),
      role_names: r.role_names ? r.role_names.split(',') : [],
      role_ids: r.role_ids ? r.role_ids.split(',') : [],
    })),
    total: countRows[0].total,
    page,
    page_size: pageSize,
  });
});

// 新增用户
router.post('/', auth, auth.requireAdmin, operLog('用户管理', 1), async (req, res) => {
  await ensureIsAdminColumn();
  const { username, password, nickname, is_admin } = req.body;
  if (!username || typeof username !== 'string' || !username.trim()) {
    return res.status(400).json({ error: '用户名不能为空' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: '密码不能少于6位' });
  }
  if (password.length > 50) {
    return res.status(400).json({ error: '密码不能超过50位' });
  }
  const cleanUsername = username.trim().slice(0, 30);
  const [exists] = await db.query(
    'SELECT id FROM sl_sys_user WHERE username = ? AND del_flag = 0',
    [cleanUsername]
  );
  if (exists.length) return res.status(400).json({ error: '用户名已存在' });

  const userId = snowflake.nextId();
  const hashed = await bcrypt.hash(password, 10);
  await db.query(
    'INSERT INTO sl_sys_user (id, username, password, nickname, is_admin, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, cleanUsername, hashed, (nickname || cleanUsername).slice(0, 20), is_admin ? 1 : 0, req.userId]
  );
  res.json({ success: true, id: String(userId) });
});

// 编辑用户（昵称/邮箱/是否超管）
router.put('/:id', auth, auth.requireAdmin, operLog('用户管理', 2), async (req, res) => {
  await ensureIsAdminColumn();
  const { nickname, email, is_admin } = req.body;
  const targetId = req.params.id;

  const [rows] = await db.query('SELECT id, is_admin FROM sl_sys_user WHERE id = ? AND del_flag = 0', [targetId]);
  if (!rows.length) return res.status(404).json({ error: '用户不存在' });

  const target = rows[0];

  // 超管账号：不允许通过此接口修改 is_admin 字段（防止互相撤权）
  if (target.is_admin && is_admin !== undefined) {
    return res.status(400).json({ error: '超级管理员权限不可通过此接口修改' });
  }
  // 不允许取消自己的超管权限
  if (String(targetId) === String(req.userId) && is_admin === 0) {
    return res.status(400).json({ error: '不能取消自己的超管权限' });
  }

  const updates = [];
  const vals = [];
  if (nickname !== undefined) { updates.push('nickname = ?'); vals.push(String(nickname).trim().slice(0, 20)); }
  if (email !== undefined) { updates.push('email = ?'); vals.push(email || null); }
  if (is_admin !== undefined && !target.is_admin) { updates.push('is_admin = ?'); vals.push(is_admin ? 1 : 0); }
  if (!updates.length) return res.status(400).json({ error: '没有要更新的字段' });

  vals.push(targetId);
  await db.query(`UPDATE sl_sys_user SET ${updates.join(', ')} WHERE id = ?`, vals);
  res.json({ success: true });
});

// 重置密码（不可重置超管账号）
router.post('/:id/reset-password', auth, auth.requireAdmin, operLog('用户管理', 2), async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: '新密码不能少于6位' });
  if (newPassword.length > 50) return res.status(400).json({ error: '密码不能超过50位' });

  const [rows] = await db.query('SELECT id, is_admin FROM sl_sys_user WHERE id = ? AND del_flag = 0', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '用户不存在' });
  if (rows[0].is_admin) return res.status(400).json({ error: '超级管理员密码不可通过此接口重置' });

  const hashed = await bcrypt.hash(newPassword, 10);
  await db.query('UPDATE sl_sys_user SET password = ? WHERE id = ?', [hashed, req.params.id]);
  res.json({ success: true });
});

// 为用户分配角色
router.post('/:id/roles', auth, auth.requireAdmin, operLog('用户管理', 2), async (req, res) => {
  const { role_ids } = req.body;
  if (!Array.isArray(role_ids)) return res.status(400).json({ error: 'role_ids 必须为数组' });

  const [rows] = await db.query('SELECT id FROM sl_sys_user WHERE id = ? AND del_flag = 0', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '用户不存在' });

  // 先删除原有关联，再插入新关联
  await db.query('DELETE FROM sl_sys_user_role WHERE user_id = ?', [req.params.id]);
  for (const roleId of role_ids) {
    await db.query(
      'INSERT IGNORE INTO sl_sys_user_role (user_id, role_id) VALUES (?, ?)',
      [req.params.id, roleId]
    );
  }
  res.json({ success: true });
});

// 删除用户（逻辑删除，不可删自己，不可删超管）
router.delete('/:id', auth, auth.requireAdmin, operLog('用户管理', 3), async (req, res) => {
  if (String(req.params.id) === String(req.userId)) {
    return res.status(400).json({ error: '不能删除自己的账号' });
  }
  const [rows] = await db.query('SELECT id, is_admin FROM sl_sys_user WHERE id = ? AND del_flag = 0', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: '用户不存在' });
  if (rows[0].is_admin) return res.status(400).json({ error: '超级管理员账号不可删除' });

  await db.query('UPDATE sl_sys_user SET del_flag = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

module.exports = router;
module.exports.ensureIsAdminColumn = ensureIsAdminColumn;
