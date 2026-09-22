const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const snowflake = require('../utils/snowflake');

const router = express.Router();

// 确保通知表存在
async function ensureTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_notification (
      id BIGINT UNSIGNED PRIMARY KEY,
      user_id BIGINT UNSIGNED NOT NULL,
      type VARCHAR(30) NOT NULL,
      title VARCHAR(100) NOT NULL,
      content VARCHAR(500) NOT NULL,
      related_type VARCHAR(30) DEFAULT NULL,
      related_id BIGINT UNSIGNED DEFAULT NULL,
      stage VARCHAR(20) DEFAULT NULL,
      period VARCHAR(20) DEFAULT NULL,
      is_read TINYINT NOT NULL DEFAULT 0,
      read_at DATETIME(3) DEFAULT NULL,
      del_flag TINYINT NOT NULL DEFAULT 0,
      created_by BIGINT UNSIGNED DEFAULT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_by BIGINT UNSIGNED DEFAULT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      remark VARCHAR(500) DEFAULT NULL,
      UNIQUE KEY uk_dedup (user_id, type, related_id, stage, period),
      INDEX idx_user_read (user_id, is_read, del_flag),
      INDEX idx_user_list (user_id, del_flag, created_at DESC),
      FOREIGN KEY (user_id) REFERENCES sl_sys_user(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

// 获取未读数量
router.get('/unread-count', auth, async (req, res) => {
  await ensureTable();
  const [rows] = await db.query(
    'SELECT COUNT(*) AS cnt FROM sl_sys_notification WHERE user_id = ? AND is_read = 0 AND del_flag = 0',
    [req.userId]
  );
  res.json({ unread_count: rows[0].cnt });
});

// 获取通知列表（分页）
router.get('/', auth, async (req, res) => {
  await ensureTable();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 20));
  const offset = (page - 1) * pageSize;

  const [countRows] = await db.query(
    'SELECT COUNT(*) AS total FROM sl_sys_notification WHERE user_id = ? AND del_flag = 0',
    [req.userId]
  );
  const [rows] = await db.query(
    `SELECT id, type, title, content, related_type, related_id, stage, is_read, created_at
     FROM sl_sys_notification
     WHERE user_id = ? AND del_flag = 0
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`,
    [req.userId, pageSize, offset]
  );

  res.json({
    list: rows,
    total: countRows[0].total,
    page,
    page_size: pageSize,
    has_more: offset + rows.length < countRows[0].total
  });
});

// 标记单条已读
router.post('/:id/read', auth, operLog('个人通知', 2), async (req, res) => {
  await ensureTable();
  await db.query(
    'UPDATE sl_sys_notification SET is_read = 1, read_at = NOW(3) WHERE id = ? AND user_id = ? AND is_read = 0',
    [req.params.id, req.userId]
  );
  res.json({ success: true });
});

// 全部标记已读
router.post('/read-all', auth, operLog('个人通知', 2), async (req, res) => {
  await ensureTable();
  const [result] = await db.query(
    'UPDATE sl_sys_notification SET is_read = 1, read_at = NOW(3) WHERE user_id = ? AND is_read = 0 AND del_flag = 0',
    [req.userId]
  );
  res.json({ success: true, marked: result.affectedRows });
});

// 删除单条通知
router.delete('/:id', auth, operLog('个人通知', 3), async (req, res) => {
  await ensureTable();
  await db.query(
    'UPDATE sl_sys_notification SET del_flag = 1 WHERE id = ? AND user_id = ?',
    [req.params.id, req.userId]
  );
  res.json({ success: true });
});

module.exports = router;
