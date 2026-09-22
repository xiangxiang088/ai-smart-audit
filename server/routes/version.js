const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();

// 确保版本记录表存在
async function ensureVersionTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sl_sys_version (
      id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '自增主键',
      version      VARCHAR(20)  NOT NULL COMMENT '版本号，如 v2.0.1',
      release_date DATE         NOT NULL COMMENT '发布日期',
      title        VARCHAR(100) DEFAULT NULL COMMENT '版本副标题（可选）',
      content      TEXT         NOT NULL COMMENT '更新内容（换行分隔的条目，每行一条）',
      created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP COMMENT '记录创建时间',
      INDEX idx_release_date (release_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统版本升级记录'
  `);
}

// 获取全部版本记录（按发布日期降序，最新版本在前）
router.get('/', auth, async (req, res) => {
  await ensureVersionTable();
  const [rows] = await db.query(
    'SELECT id, version, release_date, title, content FROM sl_sys_version ORDER BY release_date DESC, id DESC'
  );
  res.json(rows);
});

module.exports = router;
