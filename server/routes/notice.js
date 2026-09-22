const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { operLog } = require('../logger');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

const ALLOWED_TYPES = ['1', '2'];    // 1=通知 2=公告
const ALLOWED_STATUS = ['0', '1'];   // 0=已发布 1=草稿/关闭

// 确保通知公告表及阅读记录表存在
async function ensureNoticeTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_notice (
      id BIGINT UNSIGNED PRIMARY KEY COMMENT '公告ID（雪花算法）',
      notice_title VARCHAR(100) NOT NULL COMMENT '公告标题',
      notice_type CHAR(1) NOT NULL DEFAULT '1' COMMENT '公告类型（1通知 2公告）',
      notice_content LONGTEXT NOT NULL COMMENT '公告内容',
      status CHAR(1) NOT NULL DEFAULT '0' COMMENT '状态（0正常/已发布 1关闭/草稿）',
      is_popup TINYINT NOT NULL DEFAULT 0 COMMENT '是否弹窗公告（0否 1是，系统升级等重要公告）',
      del_flag TINYINT NOT NULL DEFAULT 0 COMMENT '删除标志（0正常 1删除）',
      created_by BIGINT UNSIGNED DEFAULT NULL COMMENT '创建用户ID',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
      updated_by BIGINT UNSIGNED DEFAULT NULL COMMENT '修改用户ID',
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间',
      remark VARCHAR(500) DEFAULT NULL COMMENT '备注',
      INDEX idx_status (status),
      INDEX idx_type (notice_type),
      INDEX idx_popup (is_popup),
      INDEX idx_created_at (created_at),
      INDEX idx_del_flag (del_flag)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统通知/公告表'
  `);
  // 兼容已有数据库：补 is_popup 字段
  await db.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sl_sys_notice' AND COLUMN_NAME = 'is_popup'
  `).then(async ([cols]) => {
    if (!cols.length) {
      await db.query(
        `ALTER TABLE sl_sys_notice
         ADD COLUMN is_popup TINYINT NOT NULL DEFAULT 0 COMMENT '是否弹窗公告（0否 1是，系统升级等重要公告）' AFTER status,
         ADD INDEX idx_popup (is_popup)`
      );
    }
  });
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_notice_read (
      id BIGINT UNSIGNED PRIMARY KEY COMMENT '记录ID（雪花算法）',
      notice_id BIGINT UNSIGNED NOT NULL COMMENT '公告ID',
      user_id BIGINT UNSIGNED NOT NULL COMMENT '用户ID',
      read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '阅读时间',
      UNIQUE KEY uk_notice_user (notice_id, user_id),
      INDEX idx_user_id (user_id),
      INDEX idx_notice_id (notice_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='公告用户阅读记录表'
  `);
}

// 校验公告入参
function validateNotice(body) {
  const title = (body.notice_title || '').trim();
  const content = (body.notice_content || '').trim();
  const type = ALLOWED_TYPES.includes(body.notice_type) ? body.notice_type : '1';
  const status = ALLOWED_STATUS.includes(body.status) ? body.status : '0';
  const isPopup = body.is_popup === true || body.is_popup === 1 || body.is_popup === '1' ? 1 : 0;
  if (!title) return { error: '请填写公告标题' };
  if (title.length > 100) return { error: '标题不能超过100字' };
  if (!content) return { error: '请填写公告内容' };
  if (content.length > 10000) return { error: '内容不能超过10000字' };
  return { value: { notice_title: title, notice_content: content, notice_type: type, status, is_popup: isPopup } };
}

// ===== 用户接口 =====

// 未读数量 + 是否管理员（供铃铛显示及管理入口判断）
router.get('/unread-count', auth, async (req, res) => {
  await ensureNoticeTables();
  const [rows] = await db.query(
    `SELECT COUNT(*) AS cnt FROM sl_sys_notice n
     LEFT JOIN sl_sys_notice_read r
       ON r.notice_id = n.id AND r.user_id = ?
     WHERE n.status = '0' AND n.del_flag = 0 AND r.id IS NULL`,
    [req.userId]
  );
  const admin = await auth.isAdmin(req.userId);
  res.json({ unread_count: rows[0].cnt, is_admin: admin });
});

// 已发布公告列表（分页，含 per-user 已读状态）
router.get('/', auth, async (req, res) => {
  await ensureNoticeTables();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.page_size) || 20));
  const offset = (page - 1) * pageSize;

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM sl_sys_notice
     WHERE status = '0' AND del_flag = 0`
  );
  const [rows] = await db.query(
    `SELECT n.id, n.notice_title, n.notice_type, n.is_popup, n.created_at,
            CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS is_read
     FROM sl_sys_notice n
     LEFT JOIN sl_sys_notice_read r
       ON r.notice_id = n.id AND r.user_id = ?
     WHERE n.status = '0' AND n.del_flag = 0
     ORDER BY n.created_at DESC
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

// 获取当前用户未读的弹窗公告（系统升级/重要通知，启动时检查）
router.get('/popup', auth, async (req, res) => {
  await ensureNoticeTables();
  const [rows] = await db.query(
    `SELECT n.id, n.notice_title, n.notice_type, n.notice_content, n.created_at
     FROM sl_sys_notice n
     LEFT JOIN sl_sys_notice_read r
       ON r.notice_id = n.id AND r.user_id = ?
     WHERE n.status = '0' AND n.del_flag = 0 AND n.is_popup = 1 AND r.id IS NULL
     ORDER BY n.created_at DESC
     LIMIT 5`,
    [req.userId]
  );
  res.json({ list: rows });
});

// ===== 管理员接口（必须在 GET /:id 之前注册，否则 /admin/* 会被 /:id 拦截）=====

// 管理员创建公告
router.post('/admin', auth, auth.requireAdmin, operLog('通知公告', 1), async (req, res) => {
  await ensureNoticeTables();
  const result = validateNotice(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { notice_title, notice_content, notice_type, status, is_popup } = result.value;

  const id = snowflake.nextId();
  await db.query(
    `INSERT INTO sl_sys_notice (id, notice_title, notice_type, notice_content, status, is_popup, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, notice_title, notice_type, notice_content, status, is_popup, req.userId]
  );
  res.json({ success: true, id });
});

// 管理员公告列表（含草稿，分页）
router.get('/admin/list', auth, auth.requireAdmin, async (req, res) => {
  await ensureNoticeTables();
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size) || 20));
  const offset = (page - 1) * pageSize;
  const status = req.query.status;
  const noticeType = req.query.notice_type;

  const where = ['n.del_flag = 0'];
  const params = [];
  if (status && ALLOWED_STATUS.includes(status)) {
    where.push('n.status = ?');
    params.push(status);
  }
  if (noticeType && ALLOWED_TYPES.includes(noticeType)) {
    where.push('n.notice_type = ?');
    params.push(noticeType);
  }

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM sl_sys_notice n WHERE ${where.join(' AND ')}`,
    params
  );
  const [rows] = await db.query(
    `SELECT n.*, u.nickname AS created_by_name
     FROM sl_sys_notice n
     LEFT JOIN sl_sys_user u ON u.id = n.created_by AND u.del_flag = 0
     WHERE ${where.join(' AND ')}
     ORDER BY n.created_at DESC
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

// 管理员公告详情（含草稿）
router.get('/admin/:id', auth, auth.requireAdmin, async (req, res) => {
  await ensureNoticeTables();
  const [rows] = await db.query(
    `SELECT n.*, u.nickname AS created_by_name
     FROM sl_sys_notice n
     LEFT JOIN sl_sys_user u ON u.id = n.created_by AND u.del_flag = 0
     WHERE n.id = ? AND n.del_flag = 0`,
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '公告不存在' });
  res.json(rows[0]);
});

// 管理员更新公告
router.put('/admin/:id', auth, auth.requireAdmin, operLog('通知公告', 2), async (req, res) => {
  await ensureNoticeTables();
  const result = validateNotice(req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { notice_title, notice_content, notice_type, status, is_popup } = result.value;

  const [rows] = await db.query(
    'SELECT id FROM sl_sys_notice WHERE id = ? AND del_flag = 0',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '公告不存在' });

  await db.query(
    `UPDATE sl_sys_notice
     SET notice_title = ?, notice_type = ?, notice_content = ?, status = ?, is_popup = ?, updated_by = ?
     WHERE id = ?`,
    [notice_title, notice_type, notice_content, status, is_popup, req.userId, req.params.id]
  );
  res.json({ success: true });
});

// 管理员删除公告（逻辑删除）
router.delete('/admin/:id', auth, auth.requireAdmin, operLog('通知公告', 3), async (req, res) => {
  await ensureNoticeTables();
  const [rows] = await db.query(
    'SELECT id FROM sl_sys_notice WHERE id = ? AND del_flag = 0',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '公告不存在' });
  await db.query('UPDATE sl_sys_notice SET del_flag = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ===== 用户接口（带 :id 的通配路由必须放在 /admin/* 之后）=====

// 已发布公告详情
router.get('/:id', auth, async (req, res) => {
  await ensureNoticeTables();
  const [rows] = await db.query(
    `SELECT n.id, n.notice_title, n.notice_type, n.notice_content, n.status, n.is_popup,
            n.created_at, n.updated_at,
            CASE WHEN r.id IS NULL THEN 0 ELSE 1 END AS is_read
     FROM sl_sys_notice n
     LEFT JOIN sl_sys_notice_read r
       ON r.notice_id = n.id AND r.user_id = ?
     WHERE n.id = ? AND n.status = '0' AND n.del_flag = 0`,
    [req.userId, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: '公告不存在' });
  res.json(rows[0]);
});

// 标记单条已读（幂等）
router.post('/:id/read', auth, operLog('通知公告', 2), async (req, res) => {
  try {
    await ensureNoticeTables();
    const [result] = await db.query(
      `INSERT IGNORE INTO sl_sys_notice_read (id, notice_id, user_id)
       VALUES (?, ?, ?)`,
      [snowflake.nextId(), req.params.id, req.userId]
    );
    console.log(`[mark read] notice_id=${req.params.id} user_id=${req.userId} affectedRows=${result.affectedRows}`);
    res.json({ success: true, affectedRows: result.affectedRows });
  } catch (e) {
    console.error('[notice read]', e);
    res.status(500).json({ error: '操作失败' });
  }
});

// 全部标记已读
router.post('/read-all', auth, operLog('通知公告', 2), async (req, res) => {
  await ensureNoticeTables();
  const [unread] = await db.query(
    `SELECT n.id FROM sl_sys_notice n
     LEFT JOIN sl_sys_notice_read r
       ON r.notice_id = n.id AND r.user_id = ?
     WHERE n.status = '0' AND n.del_flag = 0 AND r.id IS NULL`,
    [req.userId]
  );
  for (const row of unread) {
    await db.query(
      `INSERT IGNORE INTO sl_sys_notice_read (id, notice_id, user_id)
       VALUES (?, ?, ?)`,
      [snowflake.nextId(), row.id, req.userId]
    );
  }
  res.json({ success: true, marked: unread.length });
});

module.exports = router;
