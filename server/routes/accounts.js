const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { getBookRole } = require('../middleware/bookAccess');
const { operLog } = require('../logger');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

/**
 * 在事务中锁定账户行（SELECT FOR UPDATE），返回余额
 */
async function lockAccount(connection, accountId) {
  const [rows] = await connection.query('SELECT id, balance, book_id FROM sl_acc_account WHERE id = ? AND del_flag = 0 FOR UPDATE', [accountId]);
  if (rows.length === 0) return null;
  return rows[0];
}

/**
 * 插入一条余额变动流水
 */
async function insertTxLog(connection, { account_id, book_id, change_type, before_balance, change_amount, after_balance, related_record_id, related_type, note, user_id }) {
  const id = snowflake.nextId();
  await connection.query(`
    INSERT INTO sl_acc_transaction
      (id, account_id, book_id, change_type, before_balance, change_amount, after_balance, related_record_id, related_type, note, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, account_id, book_id, change_type, before_balance, change_amount, after_balance, related_record_id || null, related_type || null, note || null, user_id]);
}

// 获取账户列表（按账本共享）
router.get('/', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });

  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const [accounts] = await db.query(`
    SELECT * FROM sl_acc_account
    WHERE book_id = ? AND del_flag = 0
    ORDER BY sort_order, id
  `, [bookId]);

  const totalAssets = accounts
    .filter(a => a.is_include_total !== false && a.type !== 'credit')
    .reduce((sum, a) => sum + Number(a.balance), 0);
  const totalLiabilities = accounts
    .filter(a => a.type === 'credit')
    .reduce((sum, a) => sum + Math.abs(Number(a.balance)), 0);

  res.json({
    accounts,
    summary: { totalAssets, totalLiabilities, netAssets: totalAssets - totalLiabilities }
  });
});

// 获取账户余额变动流水（支持分页，避免大数据量卡顿）
router.get('/:id/transactions', auth, async (req, res) => {
  const accId = req.params.id;
  if (!accId) return res.status(400).json({ error: '无效的账户ID' });

  const [accs] = await db.query('SELECT book_id FROM sl_acc_account WHERE id = ? AND del_flag = 0', [accId]);
  if (accs.length === 0) return res.status(404).json({ error: '账户不存在' });
  const role = await getBookRole(req.userId, accs[0].book_id);
  if (!role) return res.status(403).json({ error: '无权访问该账户' });

  const { start_date, end_date, page = 1, page_size = 20 } = req.query;
  const pageNum = Math.max(1, parseInt(page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(page_size) || 20)); // 每页最多100条
  const offset = (pageNum - 1) * pageSize;

  const where = ['t.account_id = ?', 't.del_flag = 0'];
  const params = [accId];
  if (start_date) { where.push('t.created_at >= ?'); params.push(start_date + ' 00:00:00'); }
  if (end_date) { where.push('t.created_at <= ?'); params.push(end_date + ' 23:59:59'); }

  // 查总数
  const [countRows] = await db.query(
    `SELECT COUNT(*) as total FROM sl_acc_transaction t WHERE ${where.join(' AND ')}`,
    params
  );
  const total = countRows[0].total;

  // 查分页数据（关联记账记录和分类，方便展示分类名称和备注）
  const [transactions] = await db.query(
    `SELECT t.*, u.nickname as operator_name,
            c.name as category_name, c.icon as category_icon, c.color as category_color,
            r.note as record_note, r.type as record_type
     FROM sl_acc_transaction t
     LEFT JOIN sl_sys_user u ON t.user_id = u.id AND u.del_flag = 0
     LEFT JOIN sl_biz_record r ON t.related_record_id = r.id AND r.del_flag = 0
     LEFT JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
     WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  res.json({
    list: transactions,
    total,
    page: pageNum,
    page_size: pageSize,
    has_more: offset + transactions.length < total
  });
});

// 允许的账户类型
const VALID_ACCOUNT_TYPES = ['cash', 'bank', 'credit', 'wechat', 'alipay', 'invest', 'other'];

// 创建账户
router.post('/', auth, operLog('资金账户', 1), async (req, res) => {
  const { name, type, icon, balance, book_id, bill_day, repay_day } = req.body;
  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  if (!name || name.length > 50) return res.status(400).json({ error: '账户名称不能为空且不超过50字' });
  if (!VALID_ACCOUNT_TYPES.includes(type)) return res.status(400).json({ error: '无效的账户类型' });

  const role = await getBookRole(req.userId, bookId);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  const initBalance = Number(balance) || 0;
  if (isNaN(initBalance)) return res.status(400).json({ error: '请输入有效金额' });

  // 信用卡账单日/还款日校验
  const billDay = type === 'credit' && bill_day ? parseInt(bill_day) : null;
  const repayDay = type === 'credit' && repay_day ? parseInt(repay_day) : null;
  if (billDay !== null && (billDay < 1 || billDay > 31)) return res.status(400).json({ error: '账单日需在1-31之间' });
  if (repayDay !== null && (repayDay < 1 || repayDay > 31)) return res.status(400).json({ error: '还款日需在1-31之间' });

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    const accId = snowflake.nextId();
    await connection.query(`
      INSERT INTO sl_acc_account (id, user_id, book_id, name, type, icon, balance, initial_balance, bill_day, repay_day, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [accId, req.userId, bookId, name, type, icon || '💳', initBalance, initBalance, billDay, repayDay, createdBy()]);

    // 期初余额不为0时，记录一条initial类型流水
    if (initBalance !== 0) {
      await insertTxLog(connection, {
        account_id: accId,
        book_id: bookId,
        change_type: 'initial',
        before_balance: 0,
        change_amount: initBalance,
        after_balance: initBalance,
        related_type: 'initial',
        note: '期初余额',
        user_id: req.userId
      });
    }

    await connection.commit();
    res.json({ id: accId, ...req.body });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

// 更新账户
router.put('/:id', auth, operLog('资金账户', 2), async (req, res) => {
  const accId = req.params.id;
  if (!accId) return res.status(400).json({ error: '无效的账户ID' });

  const { name, type, icon, bill_day, repay_day } = req.body;
  if (type && !VALID_ACCOUNT_TYPES.includes(type)) return res.status(400).json({ error: '无效的账户类型' });
  const [accs] = await db.query('SELECT book_id, type as old_type FROM sl_acc_account WHERE id = ? AND del_flag = 0', [accId]);
  if (accs.length === 0) return res.status(404).json({ error: '账户不存在' });
  const role = await getBookRole(req.userId, accs[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账户' });

  const effectiveType = type || accs[0].old_type;
  const billDay = effectiveType === 'credit' && bill_day ? parseInt(bill_day) : null;
  const repayDay = effectiveType === 'credit' && repay_day ? parseInt(repay_day) : null;
  if (billDay !== null && (billDay < 1 || billDay > 31)) return res.status(400).json({ error: '账单日需在1-31之间' });
  if (repayDay !== null && (repayDay < 1 || repayDay > 31)) return res.status(400).json({ error: '还款日需在1-31之间' });

  await db.query('UPDATE sl_acc_account SET name=?, type=?, icon=?, bill_day=?, repay_day=?, updated_by=? WHERE id=?',
    [name, type, icon, billDay, repayDay, updatedBy(), accId]);
  res.json({ success: true });
});

// 更新账户余额（手动调整）
router.put('/:id/balance', auth, operLog('资金账户', 2), async (req, res) => {
  const accId = req.params.id;
  if (!accId) return res.status(400).json({ error: '无效的账户ID' });

  const { balance, note } = req.body;
  const newBalance = Number(balance);
  if (isNaN(newBalance)) return res.status(400).json({ error: '请输入有效金额' });

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 锁定账户行
    const acc = await lockAccount(connection, accId);
    if (!acc) {
      await connection.rollback();
      return res.status(404).json({ error: '账户不存在' });
    }
    const role = await getBookRole(req.userId, acc.book_id);
    if (!role || role === 'viewer') {
      await connection.rollback();
      return res.status(403).json({ error: '无权操作该账户' });
    }

    const beforeBalance = Number(acc.balance);
    const changeAmount = newBalance - beforeBalance;

    // 余额没有变化则跳过
    if (changeAmount !== 0) {
      await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [newBalance, accId]);
      await insertTxLog(connection, {
        account_id: accId,
        book_id: acc.book_id,
        change_type: 'adjust',
        before_balance: beforeBalance,
        change_amount: changeAmount,
        after_balance: newBalance,
        related_type: 'adjust',
        note: note || '手动调整余额',
        user_id: req.userId
      });
    }

    await connection.commit();
    res.json({ success: true, before_balance: beforeBalance, change_amount: changeAmount, after_balance: newBalance });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

// 删除账户
router.delete('/:id', auth, operLog('资金账户', 3), async (req, res) => {
  const accId = req.params.id;
  if (!accId) return res.status(400).json({ error: '无效的账户ID' });

  const [accs] = await db.query('SELECT book_id FROM sl_acc_account WHERE id = ? AND del_flag = 0', [accId]);
  if (accs.length === 0) return res.status(404).json({ error: '账户不存在' });
  const role = await getBookRole(req.userId, accs[0].book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账户' });

  await db.query('UPDATE sl_acc_account SET del_flag = 1 WHERE id = ?', [accId]);
  res.json({ success: true });
});

module.exports = router;
