const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { syncCategoriesForBook } = require('../scripts/sync-categories');
const { operLog } = require('../logger');
const { getBookRole } = require('../middleware/bookAccess');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

// 获取用户所有账本
router.get('/', auth, async (req, res) => {
  const [books] = await db.query(`
    SELECT b.*,
      u.nickname as owner_nickname,
      (SELECT COUNT(*) FROM sl_biz_record r WHERE r.book_id = b.id AND r.del_flag = 0) as record_count,
      CASE WHEN b.owner_id = ? THEN 'owner' ELSE bm.role END as user_role
    FROM sl_ledger_book b
    LEFT JOIN sl_sys_user u ON b.owner_id = u.id
    LEFT JOIN sl_ledger_book_member bm ON b.id = bm.book_id AND bm.user_id = ? AND bm.del_flag = 0
    WHERE (b.owner_id = ? OR bm.user_id = ?) AND b.del_flag = 0
    ORDER BY b.created_at DESC
  `, [req.userId, req.userId, req.userId, req.userId]);
  res.json(books);
});

// 创建账本
router.post('/', auth, operLog('账本管理', 1), async (req, res) => {
  const { name, description, cover_icon, type } = req.body;
  if (!name || name.length > 50) return res.status(400).json({ error: '账本名称不能为空且不超过50字' });
  const validTypes = ['personal', 'family', 'business', 'travel'];
  const bookType = validTypes.includes(type) ? type : 'personal';
  const bookId = snowflake.nextId();
  await db.query(
    'INSERT INTO sl_ledger_book (id, name, description, cover_icon, type, owner_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [bookId, name, (description || '').slice(0, 255), cover_icon || '📒', bookType, req.userId, createdBy()]
  );

  // 复制系统分类（含二级、三级分类）
  await syncCategoriesForBook(bookId);

  // 创建默认账户
  const defaultAccounts = [
    ['现金', 'cash', '💵'],
    ['微信钱包', 'wechat', '💬'],
    ['支付宝', 'alipay', '💰'],
    ['银行卡', 'bank', '💳']
  ];
  for (const [accName, accType, accIcon] of defaultAccounts) {
    const accId = snowflake.nextId();
    await db.query(
      'INSERT INTO sl_acc_account (id, user_id, book_id, name, type, icon, balance, created_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      [accId, req.userId, bookId, accName, accType, accIcon, createdBy()]
    );
  }

  res.json({ id: bookId, name, ...req.body });
});

// 更新账本
router.put('/:id', auth, operLog('账本管理', 2), async (req, res) => {
  const bookId = req.params.id;
  const [books] = await db.query('SELECT owner_id FROM sl_ledger_book WHERE id = ? AND del_flag = 0', [bookId]);
  if (books.length === 0 || books[0].owner_id !== req.userId) {
    return res.status(403).json({ error: '只有账本所有者可以修改' });
  }
  const { name, description, cover_icon } = req.body;
  if (name && name.length > 50) return res.status(400).json({ error: '账本名称不超过50字' });
  await db.query(
    'UPDATE sl_ledger_book SET name=?, description=?, cover_icon=?, updated_by=? WHERE id=? AND owner_id=?',
    [name, description ? description.slice(0, 255) : description, cover_icon, updatedBy(), bookId, req.userId]
  );
  res.json({ success: true });
});

// 删除账本
router.delete('/:id', auth, operLog('账本管理', 3), async (req, res) => {
  const bookId = req.params.id;
  const [result] = await db.query('UPDATE sl_ledger_book SET del_flag = 1 WHERE id = ? AND owner_id = ?', [bookId, req.userId]);
  if (result.affectedRows === 0) return res.status(404).json({ error: '账本不存在或无权删除' });
  res.json({ success: true });
});

// 邀请成员加入账本（仅所有者）
router.post('/:id/invite', auth, async (req, res) => {
  const bookId = req.params.id;
  const role = await getBookRole(req.userId, bookId);
  if (role !== 'owner') return res.status(403).json({ error: '只有账本所有者可以邀请成员' });

  // 角色白名单校验
  const allowedRoles = ['owner', 'editor', 'viewer'];
  const assignRole = allowedRoles.includes(req.body.role) ? req.body.role : 'editor';

  const { username } = req.body;
  if (!username) return res.status(400).json({ error: '请输入用户名' });
  const [users] = await db.query('SELECT id FROM sl_sys_user WHERE username = ? AND del_flag = 0', [username]);
  if (users.length === 0) return res.status(400).json({ error: '用户不存在' });
  if (String(users[0].id) === String(req.userId)) return res.status(400).json({ error: '不能邀请自己' });

  const memberId = snowflake.nextId();
  await db.query(
    'INSERT INTO sl_ledger_book_member (id, book_id, user_id, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role=VALUES(role), del_flag=0',
    [memberId, bookId, users[0].id, assignRole]
  );
  res.json({ success: true });
});

// 移除成员（仅所有者）
router.delete('/:id/members/:userId', auth, async (req, res) => {
  const bookId = req.params.id;
  const role = await getBookRole(req.userId, bookId);
  if (role !== 'owner') return res.status(403).json({ error: '只有账本所有者可以移除成员' });

  await db.query('UPDATE sl_ledger_book_member SET del_flag = 1 WHERE book_id=? AND user_id=?',
    [bookId, req.params.userId]);
  res.json({ success: true });
});

// 获取账本成员（需有访问权限）
router.get('/:id/members', auth, async (req, res) => {
  const bookId = req.params.id;
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const [members] = await db.query(`
    SELECT u.id, u.username, u.nickname, bm.role
    FROM sl_ledger_book_member bm
    JOIN sl_sys_user u ON bm.user_id = u.id
    WHERE bm.book_id = ? AND bm.del_flag = 0
  `, [bookId]);
  res.json(members);
});

module.exports = router;
