const db = require('../db');

/**
 * 验证用户是否有权访问某个账本（是所有者或成员）
 * 返回角色信息: 'owner' | 'editor' | 'viewer' | null（无权限）
 */
async function getBookRole(userId, bookId) {
  const [books] = await db.query(
    `SELECT b.owner_id, bm.role
     FROM sl_ledger_book b
     LEFT JOIN sl_ledger_book_member bm ON b.id = bm.book_id AND bm.user_id = ? AND bm.del_flag = 0
     WHERE b.id = ? AND b.del_flag = 0`,
    [userId, bookId]
  );
  if (books.length === 0) return null;
  const book = books[0];
  if (book.owner_id === userId) return 'owner';
  return book.role || null;
}

/**
 * 中间件：验证用户对book_id参数指定的账本有访问权限
 * 将 req.bookRole 设置为用户角色
 */
async function requireBookAccess(req, res, next) {
  const bookId = (req.query.book_id || req.body.book_id || req.params.book_id);
  if (!bookId) {
    return res.status(400).json({ error: '缺少book_id参数' });
  }
  const role = await getBookRole(req.userId, bookId);
  if (!role) {
    return res.status(403).json({ error: '无权访问该账本' });
  }
  req.bookId = bookId;
  req.bookRole = role;
  next();
}

module.exports = { getBookRole, requireBookAccess };
