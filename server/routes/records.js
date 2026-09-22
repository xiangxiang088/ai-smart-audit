const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { getBookRole } = require('../middleware/bookAccess');
const { operLog } = require('../logger');
const snowflake = require('../utils/snowflake');
const { createdBy, updatedBy } = require('../utils/auditContext');

const router = express.Router();

// 允许更新的字段白名单（防止用户篡改user_id、is_template等）
const ALLOWED_UPDATE_FIELDS = [
  'type', 'category_id', 'amount', 'account_id', 'to_account_id',
  'entity_id', 'note', 'tags', 'record_date', 'record_time', 'image_url', 'location'
];

/**
 * 在事务中锁定指定账户行（SELECT FOR UPDATE），返回 id -> balance 映射
 * 账户ID会自动升序排列锁定，避免死锁
 */
async function lockAccounts(connection, accountIds) {
  // ID为雪花算法生成的字符串，使用BigInt比较排序以避免精度丢失
  const uniqueIds = [...new Set(accountIds.filter(id => id != null))].sort((a, b) => {
    const ba = BigInt(a), bb = BigInt(b);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  });
  const balanceMap = {};
  for (const id of uniqueIds) {
    const [rows] = await connection.query('SELECT id, balance FROM sl_acc_account WHERE id = ? FOR UPDATE', [id]);
    if (rows.length > 0) {
      balanceMap[id] = Number(rows[0].balance);
    }
  }
  return balanceMap;
}

/**
 * 插入一条余额变动流水记录
 */
async function insertTxLog(connection, { account_id, book_id, change_type, before_balance, change_amount, after_balance, related_record_id, related_type, note, user_id }) {
  const id = snowflake.nextId();
  await connection.query(`
    INSERT INTO sl_acc_transaction
      (id, account_id, book_id, change_type, before_balance, change_amount, after_balance, related_record_id, related_type, note, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, account_id, book_id, change_type, before_balance, change_amount, after_balance, related_record_id || null, related_type || null, note || null, user_id]);
}

// 获取记录列表（支持多维度筛选）——账本内成员共享记录
router.get('/', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const { start_date, end_date, type, category_id, parent_category_id, account_id, entity_id } = req.query;
  let sql = `
    SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
      c.parent_id as category_parent_id,
      pc.name as parent_category_name, pc.icon as parent_category_icon,
      pc.parent_id as grandparent_category_id,
      a.name as account_name, ea.name as to_account_name,
      e.name as entity_name,
      u.nickname as creator_nickname
    FROM sl_biz_record r
    LEFT JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    LEFT JOIN sl_acc_account a ON r.account_id = a.id AND a.del_flag = 0
    LEFT JOIN sl_acc_account ea ON r.to_account_id = ea.id AND ea.del_flag = 0
    LEFT JOIN sl_biz_entity e ON r.entity_id = e.id AND e.del_flag = 0
    LEFT JOIN sl_sys_user u ON r.user_id = u.id
    WHERE r.book_id = ? AND r.is_template = false AND r.del_flag = 0
  `;
  const params = [bookId];

  if (start_date) { sql += ' AND r.record_date >= ?'; params.push(start_date); }
  if (end_date) { sql += ' AND r.record_date <= ?'; params.push(end_date); }
  if (type && type !== 'all') { sql += ' AND r.type = ?'; params.push(type); }
  if (category_id) { sql += ' AND r.category_id = ?'; params.push(category_id); }
  if (parent_category_id) {
    sql += ' AND (r.category_id = ? OR c.parent_id = ? OR pc.parent_id = ?)';
    params.push(parent_category_id, parent_category_id, parent_category_id);
  }
  if (account_id) { sql += ' AND r.account_id = ?'; params.push(account_id); }
  if (entity_id) { sql += ' AND r.entity_id = ?'; params.push(entity_id); }

  sql += ' ORDER BY r.record_date DESC, r.id DESC';

  const [records] = await db.query(sql, params);
  res.json(records);
});

// 添加记录
router.post('/', auth, operLog('流水记录', 1), async (req, res) => {
  const {
    book_id, type, category_id, amount, account_id, to_account_id,
    entity_id, note, tags, record_date, record_time, image_url, location, is_template
  } = req.body;

  const bookId = book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该账本' });

  if (!type || !['expense', 'income', 'transfer'].includes(type)) {
    return res.status(400).json({ error: '请选择正确的交易类型' });
  }
  if (!category_id) return res.status(400).json({ error: '请选择分类' });
  if (!amount || amount <= 0) return res.status(400).json({ error: '请输入有效金额' });
  if (!account_id) return res.status(400).json({ error: '请选择账户' });
  if (!record_date) return res.status(400).json({ error: '请选择日期' });

  // 验证账户和分类都属于该账本（防止跨账本IDOR）
  const [accounts] = await db.query('SELECT id FROM sl_acc_account WHERE id = ? AND book_id = ? AND del_flag = 0', [account_id, bookId]);
  if (accounts.length === 0) return res.status(400).json({ error: '账户不存在' });

  const [cats] = await db.query('SELECT id FROM sl_biz_category WHERE id = ? AND book_id = ? AND del_flag = 0', [category_id, bookId]);
  if (cats.length === 0) return res.status(400).json({ error: '分类不存在' });

  // 转账时验证转入账户也属于同一账本
  if (to_account_id) {
    const [toAccs] = await db.query('SELECT id FROM sl_acc_account WHERE id = ? AND book_id = ? AND del_flag = 0', [to_account_id, bookId]);
    if (toAccs.length === 0) return res.status(400).json({ error: '转入账户不存在' });
  }

  // 验证商家/成员属于该账本
  if (entity_id) {
    const [ents] = await db.query('SELECT id FROM sl_biz_entity WHERE id = ? AND book_id = ? AND del_flag = 0', [entity_id, bookId]);
    if (ents.length === 0) return res.status(400).json({ error: '商家/成员不存在' });
  }

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 锁定涉及的账户行（按ID升序，防止死锁）
    const involvedAccounts = type === 'transfer' && to_account_id ? [account_id, to_account_id] : [account_id];
    const balances = await lockAccounts(connection, involvedAccounts);

    // 始终插入正式记录（更新余额、在列表中显示）
    const recordId = snowflake.nextId();
    await connection.query(`
      INSERT INTO sl_biz_record (
        id, book_id, user_id, type, category_id, amount, account_id, to_account_id,
        entity_id, note, tags, record_date, record_time, image_url, location, is_template, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, false, ?)
    `, [
      recordId, bookId, req.userId, type, category_id, amount, account_id, to_account_id || null,
      entity_id || null, note || '', tags || '', record_date, record_time || null,
      image_url || null, location || null, createdBy()
    ]);

    // 更新账户余额 + 记录流水（基于锁定时的余额计算）
    if (type === 'expense') {
      const before = balances[account_id];
      const after = before - Number(amount);
      await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, account_id]);
      await insertTxLog(connection, {
        account_id, book_id: bookId, change_type: 'expense',
        before_balance: before, change_amount: -Number(amount), after_balance: after,
        related_record_id: recordId, related_type: 'record', note: note || '支出', user_id: req.userId
      });
    } else if (type === 'income') {
      const before = balances[account_id];
      const after = before + Number(amount);
      await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, account_id]);
      await insertTxLog(connection, {
        account_id, book_id: bookId, change_type: 'income',
        before_balance: before, change_amount: Number(amount), after_balance: after,
        related_record_id: recordId, related_type: 'record', note: note || '收入', user_id: req.userId
      });
    } else if (type === 'transfer' && to_account_id) {
      // 转出账户
      const beforeOut = balances[account_id];
      const afterOut = beforeOut - Number(amount);
      await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterOut, account_id]);
      await insertTxLog(connection, {
        account_id, book_id: bookId, change_type: 'transfer_out',
        before_balance: beforeOut, change_amount: -Number(amount), after_balance: afterOut,
        related_record_id: recordId, related_type: 'record', note: note || '转账转出', user_id: req.userId
      });
      // 转入账户
      const beforeIn = balances[to_account_id];
      const afterIn = beforeIn + Number(amount);
      await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterIn, to_account_id]);
      await insertTxLog(connection, {
        account_id: to_account_id, book_id: bookId, change_type: 'transfer_in',
        before_balance: beforeIn, change_amount: Number(amount), after_balance: afterIn,
        related_record_id: recordId, related_type: 'record', note: note || '转账转入', user_id: req.userId
      });
    }

    // 如果勾选了"存为模板"，额外插入一条模板记录（不影响余额，不记录流水）
    if (is_template) {
      const tmplId = snowflake.nextId();
      await connection.query(`
        INSERT INTO sl_biz_record (
          id, book_id, user_id, type, category_id, amount, account_id, to_account_id,
          entity_id, note, tags, record_date, record_time, image_url, location, is_template, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true, ?)
      `, [
        tmplId, bookId, req.userId, type, category_id, amount, account_id, to_account_id || null,
        entity_id || null, note || '', tags || '', record_date, record_time || null,
        image_url || null, location || null, createdBy()
      ]);
    }

    await connection.commit();
    res.json({ id: recordId, ...req.body });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

// 更新记录
router.put('/:id', auth, operLog('流水记录', 2), async (req, res) => {
  const recId = req.params.id;
  if (!recId) return res.status(400).json({ error: '无效的记录ID' });

  const [recs] = await db.query('SELECT * FROM sl_biz_record WHERE id = ? AND del_flag = 0', [recId]);
  if (recs.length === 0) return res.status(404).json({ error: '记录不存在' });
  const old = recs[0];
  const role = await getBookRole(req.userId, old.book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该记录' });

  // 仅从请求体中提取白名单字段，防止篡改user_id/book_id/is_template等
  const newData = { ...old };
  for (const field of ALLOWED_UPDATE_FIELDS) {
    if (req.body[field] !== undefined) {
      newData[field] = req.body[field];
    }
  }

  // 验证类型合法性
  if (newData.type && !['expense', 'income', 'transfer'].includes(newData.type)) {
    return res.status(400).json({ error: '无效的交易类型' });
  }

  const bookId = old.book_id;

  // 验证关联资源都属于同一账本（防止跨账本IDOR）
  if (newData.account_id && newData.account_id !== old.account_id) {
    const [accs] = await db.query('SELECT id FROM sl_acc_account WHERE id = ? AND book_id = ? AND del_flag = 0', [newData.account_id, bookId]);
    if (accs.length === 0) return res.status(400).json({ error: '账户不属于当前账本' });
  }
  if (newData.to_account_id && newData.to_account_id !== old.to_account_id) {
    const [toAccs] = await db.query('SELECT id FROM sl_acc_account WHERE id = ? AND book_id = ? AND del_flag = 0', [newData.to_account_id, bookId]);
    if (toAccs.length === 0) return res.status(400).json({ error: '转入账户不属于当前账本' });
  }
  if (newData.category_id && newData.category_id !== old.category_id) {
    const [cats] = await db.query('SELECT id FROM sl_biz_category WHERE id = ? AND book_id = ? AND del_flag = 0', [newData.category_id, bookId]);
    if (cats.length === 0) return res.status(400).json({ error: '分类不属于当前账本' });
  }
  if (newData.entity_id && newData.entity_id !== old.entity_id) {
    const [ents] = await db.query('SELECT id FROM sl_biz_entity WHERE id = ? AND book_id = ? AND del_flag = 0', [newData.entity_id, bookId]);
    if (ents.length === 0) return res.status(400).json({ error: '商家/成员不属于当前账本' });
  }

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 收集所有涉及的账户：旧记录涉及的 + 新记录涉及的
    const involvedAccounts = new Set();
    if (!old.is_template) {
      involvedAccounts.add(old.account_id);
      if (old.type === 'transfer' && old.to_account_id) involvedAccounts.add(old.to_account_id);
    }
    if (!newData.is_template) {
      involvedAccounts.add(newData.account_id);
      if (newData.type === 'transfer' && newData.to_account_id) involvedAccounts.add(newData.to_account_id);
    }
    const balances = await lockAccounts(connection, [...involvedAccounts]);

    // 第一步：撤销旧记录对余额的影响
    if (!old.is_template) {
      // 将该记录之前的真实流水（非 adjust）标记为已作废，避免用户视角看到重复条目
      await connection.query(
        `UPDATE sl_acc_transaction SET del_flag = 1
         WHERE related_record_id = ? AND change_type != 'adjust'`,
        [recId]
      );
      if (old.type === 'expense') {
        const before = balances[old.account_id];
        const after = before + Number(old.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, old.account_id]);
        await insertTxLog(connection, {
          account_id: old.account_id, book_id: bookId, change_type: 'adjust',
          before_balance: before, change_amount: Number(old.amount), after_balance: after,
          related_record_id: recId, related_type: 'record', note: '编辑记录-撤销原支出', user_id: req.userId
        });
        balances[old.account_id] = after;
      } else if (old.type === 'income') {
        const before = balances[old.account_id];
        const after = before - Number(old.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, old.account_id]);
        await insertTxLog(connection, {
          account_id: old.account_id, book_id: bookId, change_type: 'adjust',
          before_balance: before, change_amount: -Number(old.amount), after_balance: after,
          related_record_id: recId, related_type: 'record', note: '编辑记录-撤销原收入', user_id: req.userId
        });
        balances[old.account_id] = after;
      } else if (old.type === 'transfer' && old.to_account_id) {
        // 撤销：退回转出账户，扣减转入账户
        const beforeOut = balances[old.account_id];
        const afterOut = beforeOut + Number(old.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterOut, old.account_id]);
        await insertTxLog(connection, {
          account_id: old.account_id, book_id: bookId, change_type: 'adjust',
          before_balance: beforeOut, change_amount: Number(old.amount), after_balance: afterOut,
          related_record_id: recId, related_type: 'record', note: '编辑记录-撤销原转账转出', user_id: req.userId
        });
        balances[old.account_id] = afterOut;

        const beforeIn = balances[old.to_account_id];
        const afterIn = beforeIn - Number(old.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterIn, old.to_account_id]);
        await insertTxLog(connection, {
          account_id: old.to_account_id, book_id: bookId, change_type: 'adjust',
          before_balance: beforeIn, change_amount: -Number(old.amount), after_balance: afterIn,
          related_record_id: recId, related_type: 'record', note: '编辑记录-撤销原转账转入', user_id: req.userId
        });
        balances[old.to_account_id] = afterIn;
      }
    }

    // 更新记录本身
    await connection.query(`
      UPDATE sl_biz_record SET type=?, category_id=?, amount=?, account_id=?, to_account_id=?,
        entity_id=?, note=?, tags=?, record_date=?, record_time=?, image_url=?, location=?, updated_by=?
      WHERE id=?
    `, [
      newData.type, newData.category_id, newData.amount, newData.account_id, newData.to_account_id,
      newData.entity_id, newData.note, newData.tags, newData.record_date, newData.record_time,
      newData.image_url, newData.location, updatedBy(), recId
    ]);

    // 第二步：应用新记录对余额的影响
    if (!newData.is_template) {
      if (newData.type === 'expense') {
        const before = balances[newData.account_id];
        const after = before - Number(newData.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, newData.account_id]);
        await insertTxLog(connection, {
          account_id: newData.account_id, book_id: bookId, change_type: 'expense',
          before_balance: before, change_amount: -Number(newData.amount), after_balance: after,
          related_record_id: recId, related_type: 'record', note: newData.note || '编辑后支出', user_id: req.userId
        });
      } else if (newData.type === 'income') {
        const before = balances[newData.account_id];
        const after = before + Number(newData.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, newData.account_id]);
        await insertTxLog(connection, {
          account_id: newData.account_id, book_id: bookId, change_type: 'income',
          before_balance: before, change_amount: Number(newData.amount), after_balance: after,
          related_record_id: recId, related_type: 'record', note: newData.note || '编辑后收入', user_id: req.userId
        });
      } else if (newData.type === 'transfer' && newData.to_account_id) {
        const beforeOut = balances[newData.account_id];
        const afterOut = beforeOut - Number(newData.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterOut, newData.account_id]);
        await insertTxLog(connection, {
          account_id: newData.account_id, book_id: bookId, change_type: 'transfer_out',
          before_balance: beforeOut, change_amount: -Number(newData.amount), after_balance: afterOut,
          related_record_id: recId, related_type: 'record', note: newData.note || '编辑后转账转出', user_id: req.userId
        });

        const beforeIn = balances[newData.to_account_id];
        const afterIn = beforeIn + Number(newData.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterIn, newData.to_account_id]);
        await insertTxLog(connection, {
          account_id: newData.to_account_id, book_id: bookId, change_type: 'transfer_in',
          before_balance: beforeIn, change_amount: Number(newData.amount), after_balance: afterIn,
          related_record_id: recId, related_type: 'record', note: newData.note || '编辑后转账转入', user_id: req.userId
        });
      }
    }

    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

// 删除记录
router.delete('/:id', auth, operLog('流水记录', 3), async (req, res) => {
  const recId = req.params.id;
  if (!recId) return res.status(400).json({ error: '无效的记录ID' });

  const [recs] = await db.query('SELECT * FROM sl_biz_record WHERE id = ?', [recId]);
  if (recs.length === 0) return res.status(404).json({ error: '记录不存在' });
  const record = recs[0];
  const role = await getBookRole(req.userId, record.book_id);
  if (!role || role === 'viewer') return res.status(403).json({ error: '无权操作该记录' });

  const connection = await db.getConnection();
  await connection.beginTransaction();

  try {
    // 锁定涉及的账户
    const involvedAccounts = new Set();
    if (!record.is_template) {
      involvedAccounts.add(record.account_id);
      if (record.type === 'transfer' && record.to_account_id) involvedAccounts.add(record.to_account_id);
    }
    const balances = await lockAccounts(connection, [...involvedAccounts]);

    // 反向操作余额，撤销该记录的影响
    if (!record.is_template) {
      if (record.type === 'expense') {
        const before = balances[record.account_id];
        const after = before + Number(record.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, record.account_id]);
        await insertTxLog(connection, {
          account_id: record.account_id, book_id: record.book_id, change_type: 'adjust',
          before_balance: before, change_amount: Number(record.amount), after_balance: after,
          related_record_id: recId, related_type: 'record', note: '删除记录-退回支出', user_id: req.userId
        });
      } else if (record.type === 'income') {
        const before = balances[record.account_id];
        const after = before - Number(record.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [after, record.account_id]);
        await insertTxLog(connection, {
          account_id: record.account_id, book_id: record.book_id, change_type: 'adjust',
          before_balance: before, change_amount: -Number(record.amount), after_balance: after,
          related_record_id: recId, related_type: 'record', note: '删除记录-扣减收入', user_id: req.userId
        });
      } else if (record.type === 'transfer' && record.to_account_id) {
        const beforeOut = balances[record.account_id];
        const afterOut = beforeOut + Number(record.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterOut, record.account_id]);
        await insertTxLog(connection, {
          account_id: record.account_id, book_id: record.book_id, change_type: 'adjust',
          before_balance: beforeOut, change_amount: Number(record.amount), after_balance: afterOut,
          related_record_id: recId, related_type: 'record', note: '删除记录-撤销转账转出', user_id: req.userId
        });

        const beforeIn = balances[record.to_account_id];
        const afterIn = beforeIn - Number(record.amount);
        await connection.query('UPDATE sl_acc_account SET balance = ? WHERE id = ?', [afterIn, record.to_account_id]);
        await insertTxLog(connection, {
          account_id: record.to_account_id, book_id: record.book_id, change_type: 'adjust',
          before_balance: beforeIn, change_amount: -Number(record.amount), after_balance: afterIn,
          related_record_id: recId, related_type: 'record', note: '删除记录-撤销转账转入', user_id: req.userId
        });
      }
    }

    await connection.query('UPDATE sl_biz_record SET del_flag = 1 WHERE id = ?', [recId]);
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
});

// 日历视图数据
router.get('/calendar', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { type } = req.query;
  const startDate = `${month}-01`;
  const endDate = new Date(month.split('-')[0], month.split('-')[1], 0).toISOString().slice(0, 10);

  let sql = `
    SELECT record_date,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
      COUNT(*) as count
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
  `;
  const params = [bookId, startDate, endDate];
  if (type && ['expense', 'income', 'transfer'].includes(type)) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' GROUP BY record_date';

  const [dailyData] = await db.query(sql, params);
  res.json(dailyData);
});

// 月度汇总（按年返回每月收支合计，极轻量）
router.get('/monthly-summary', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const year = parseInt(req.query.year) || new Date().getFullYear();
  const { type } = req.query;
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  let sql = `
    SELECT DATE_FORMAT(record_date, '%Y-%m') as month,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense,
      COUNT(*) as count
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
  `;
  const params = [bookId, startDate, endDate];
  if (type && ['expense', 'income', 'transfer'].includes(type)) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' GROUP BY DATE_FORMAT(record_date, "%Y-%m")';

  const [rows] = await db.query(sql, params);

  // 补齐12个月（没有数据的月填充0）
  const result = {};
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`;
    result[key] = { month: key, income: 0, expense: 0, count: 0 };
  }
  rows.forEach(r => {
    result[r.month] = { month: r.month, income: Number(r.income), expense: Number(r.expense), count: r.count };
  });

  res.json(Object.values(result));
});

module.exports = router;
