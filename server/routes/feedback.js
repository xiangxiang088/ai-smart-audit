const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

const ALLOWED_TYPES = ['bug', 'suggestion', 'other'];
const ALLOWED_STATUS = ['pending', 'processing', 'resolved'];

// 确保反馈表存在（兼容未手动执行迁移脚本的情况）
async function ensureFeedbackTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_feedback (
      id BIGINT UNSIGNED PRIMARY KEY COMMENT '反馈ID（雪花算法）',
      user_id BIGINT UNSIGNED NOT NULL COMMENT '提交用户ID',
      type VARCHAR(20) NOT NULL DEFAULT 'suggestion' COMMENT '反馈类型：bug-缺陷反馈/suggestion-功能建议/other-其他',
      content TEXT NOT NULL COMMENT '反馈内容',
      contact VARCHAR(100) DEFAULT NULL COMMENT '联系方式（选填，邮箱/微信/手机号）',
      status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT '处理状态：pending-待处理/processing-处理中/resolved-已处理',
      admin_reply TEXT DEFAULT NULL COMMENT '管理员回复',
      replied_at DATETIME(3) NULL DEFAULT NULL COMMENT '回复时间',
      replied_by BIGINT UNSIGNED DEFAULT NULL COMMENT '回复管理员ID',
      del_flag TINYINT NOT NULL DEFAULT 0 COMMENT '删除标志（0正常 1删除）',
      created_by BIGINT UNSIGNED DEFAULT NULL COMMENT '创建用户ID',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
      updated_by BIGINT UNSIGNED DEFAULT NULL COMMENT '修改用户ID',
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
      remark VARCHAR(500) DEFAULT NULL COMMENT '备注',
      INDEX idx_user_id (user_id),
      INDEX idx_status (status),
      INDEX idx_created_at (created_at),
      INDEX idx_del_flag (del_flag)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户反馈表'
  `);
}

// 提交反馈
router.post('/', auth, operLog('用户反馈', 1), async (req, res) => {
  await ensureFeedbackTable();
  const { type, content, contact } = req.body;

  if (!content || !content.trim()) {
    return res.status(400).json({ error: '请填写反馈内容' });
  }
  if (content.trim().length > 2000) {
    return res.status(400).json({ error: '反馈内容不能超过2000字' });
  }
  const feedbackType = ALLOWED_TYPES.includes(type) ? type : 'suggestion';
  const contactVal = contact ? contact.trim().slice(0, 100) : null;

  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO sl_sys_feedback (id, user_id, type, content, contact, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, req.userId, feedbackType, content.trim(), contactVal, createdBy()]
  );

  res.json({ success: true, id });
});

// 获取当前用户的反馈历史
router.get('/', auth, async (req, res) => {
  await ensureFeedbackTable();
  const [rows] = await db.query(
    `SELECT id, type, content, contact, status, admin_reply, replied_at, created_at
     FROM sl_sys_feedback
     WHERE user_id = ? AND del_flag = 0
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.userId]
  );
  res.json(rows);
});

// 删除自己的反馈（逻辑删除）
router.delete('/:id', auth, operLog('用户反馈', 3), async (req, res) => {
  await ensureFeedbackTable();
  const feedbackId = req.params.id;
  const [rows] = await db.query(
    'SELECT user_id FROM sl_sys_feedback WHERE id = ? AND del_flag = 0',
    [feedbackId]
  );
  if (rows.length === 0) return res.status(404).json({ error: '反馈不存在' });
  if (String(rows[0].user_id) !== String(req.userId)) {
    return res.status(403).json({ error: '无权操作' });
  }
  await db.query('UPDATE sl_sys_feedback SET del_flag = 1 WHERE id = ?', [feedbackId]);
  res.json({ success: true });
});

// ===== 管理员接口 =====

// 管理员查看所有反馈
router.get('/admin/list', auth, auth.requireAdmin, async (req, res) => {
  await ensureFeedbackTable();
  const status = req.query.status;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 20));
  const offset = (page - 1) * pageSize;

  const where = ['f.del_flag = 0'];
  const params = [];
  if (status && ALLOWED_STATUS.includes(status)) {
    where.push('f.status = ?');
    params.push(status);
  }

  const [countRows] = await db.query(
    `SELECT COUNT(*) as total FROM sl_sys_feedback f WHERE ${where.join(' AND ')}`,
    params
  );
  const [rows] = await db.query(
    `SELECT f.*, u.username, u.nickname
     FROM sl_sys_feedback f
     LEFT JOIN sl_sys_user u ON f.user_id = u.id AND u.del_flag = 0
     WHERE ${where.join(' AND ')}
     ORDER BY f.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  res.json({
    list: rows,
    total: countRows[0].total,
    page,
    page_size: pageSize,
    has_more: offset + rows.length < countRows[0].total
  });
});

// 管理员回复反馈
router.put('/admin/:id/reply', auth, auth.requireAdmin, operLog('反馈回复', 2), async (req, res) => {
  await ensureFeedbackTable();
  const feedbackId = req.params.id;
  const { admin_reply, status } = req.body;

  if (!admin_reply || !admin_reply.trim()) {
    return res.status(400).json({ error: '请填写回复内容' });
  }
  if (admin_reply.trim().length > 2000) {
    return res.status(400).json({ error: '回复内容不能超过2000字' });
  }
  const newStatus = ALLOWED_STATUS.includes(status) ? status : 'resolved';

  const [rows] = await db.query(
    'SELECT id FROM sl_sys_feedback WHERE id = ? AND del_flag = 0',
    [feedbackId]
  );
  if (rows.length === 0) return res.status(404).json({ error: '反馈不存在' });

  await db.query(
    `UPDATE sl_sys_feedback
     SET admin_reply = ?, status = ?, replied_at = NOW(), replied_by = ?
     WHERE id = ?`,
    [admin_reply.trim(), newStatus, req.userId, feedbackId]
  );
  res.json({ success: true });
});

module.exports = router;
