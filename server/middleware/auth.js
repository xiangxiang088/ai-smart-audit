const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const { runWithUser } = require('../utils/auditContext');

// JWT密钥：优先使用环境变量，否则启动时随机生成（开发模式下重启会使旧token失效）
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须设置 JWT_SECRET 环境变量');
  }
  console.warn('⚠️  警告: 未设置 JWT_SECRET 环境变量，已生成临时密钥（重启后token失效）');
  return crypto.randomBytes(32).toString('hex');
})();

module.exports = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: '请先登录' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = String(decoded.userId);  // 雪花ID统一为字符串，避免精度丢失
    req.user = { id: String(decoded.userId), username: decoded.username || '' };
    // 将 userId 注入异步上下文，后续所有 DB 操作可通过 createdBy()/updatedBy() 读取
    runWithUser(req.userId, next);
  } catch (err) {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
};

// 判断用户是否为系统管理员
// 优先读 is_admin 字段；字段不存在时回退到"最小 id = 管理员"逻辑（兼容旧数据库）
async function isAdmin(userId) {
  try {
    const [rows] = await db.query(
      'SELECT is_admin FROM sl_sys_user WHERE id = ? AND del_flag = 0', [userId]
    );
    if (rows.length > 0 && rows[0].is_admin !== undefined) {
      return rows[0].is_admin === 1;
    }
  } catch {}
  // 兼容回退
  const [users] = await db.query('SELECT id FROM sl_sys_user ORDER BY id LIMIT 1');
  return users.length > 0 && String(users[0].id) === String(userId);
}

// 仅管理员可访问
async function requireAdmin(req, res, next) {
  if (await isAdmin(req.userId)) return next();
  return res.status(403).json({ error: '仅管理员可操作' });
}

module.exports.JWT_SECRET = JWT_SECRET;
module.exports.isAdmin = isAdmin;
module.exports.requireAdmin = requireAdmin;
