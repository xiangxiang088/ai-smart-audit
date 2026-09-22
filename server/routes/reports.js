const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const auth = require('../middleware/auth');
const { getBookRole } = require('../middleware/bookAccess');

const router = express.Router();

// 月度/自定义范围汇总报表
router.get('/summary', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  let startDate, endDate;
  if (req.query.start_date && req.query.end_date) {
    startDate = req.query.start_date;
    endDate = req.query.end_date;
  } else {
    const month = req.query.month || dayjs().format('YYYY-MM');
    startDate = `${month}-01`;
    endDate = dayjs(startDate).endOf('month').format('YYYY-MM-DD');
  }

  const [summary] = await db.query(`
    SELECT
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as total_income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as total_expense,
      COUNT(CASE WHEN type = 'income' THEN 1 END) as income_count,
      COUNT(CASE WHEN type = 'expense' THEN 1 END) as expense_count
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
  `, [bookId, startDate, endDate]);

  const [categoryExpense] = await db.query(`
    SELECT c.id, c.name, c.icon, c.color, c.parent_id,
      pc.name as parent_name, pc.icon as parent_icon, pc.parent_id as grandparent_id,
      gpc.name as grandparent_name, gpc.icon as grandparent_icon, gpc.color as grandparent_color,
      SUM(r.amount) as total, COUNT(*) as count
    FROM sl_biz_record r
    JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    LEFT JOIN sl_biz_category gpc ON pc.parent_id = gpc.id AND gpc.del_flag = 0
    WHERE r.book_id = ? AND r.type = 'expense' AND r.del_flag = 0
      AND r.record_date BETWEEN ? AND ? AND r.is_template = false
    GROUP BY c.id
    ORDER BY total DESC
  `, [bookId, startDate, endDate]);

  const [categoryIncome] = await db.query(`
    SELECT c.id, c.name, c.icon, c.color, c.parent_id,
      pc.name as parent_name, pc.icon as parent_icon, pc.parent_id as grandparent_id,
      gpc.name as grandparent_name, gpc.icon as grandparent_icon, gpc.color as grandparent_color,
      SUM(r.amount) as total, COUNT(*) as count
    FROM sl_biz_record r
    JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    LEFT JOIN sl_biz_category gpc ON pc.parent_id = gpc.id AND gpc.del_flag = 0
    WHERE r.book_id = ? AND r.type = 'income' AND r.del_flag = 0
      AND r.record_date BETWEEN ? AND ? AND r.is_template = false
    GROUP BY c.id
    ORDER BY total DESC
  `, [bookId, startDate, endDate]);

  const [accountStats] = await db.query(`
    SELECT a.id, a.name, a.icon, a.type,
      SUM(CASE WHEN r.type = 'expense' THEN r.amount ELSE 0 END) as expense,
      SUM(CASE WHEN r.type = 'income' THEN r.amount ELSE 0 END) as income
    FROM sl_biz_record r
    JOIN sl_acc_account a ON r.account_id = a.id AND a.del_flag = 0
    WHERE r.book_id = ? AND r.del_flag = 0
      AND r.record_date BETWEEN ? AND ? AND r.is_template = false
    GROUP BY a.id
    ORDER BY expense DESC
  `, [bookId, startDate, endDate]);

  const [dailyTrend] = await db.query(`
    SELECT record_date,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
    GROUP BY record_date
    ORDER BY record_date
  `, [bookId, startDate, endDate]);

  let budgets = [];
  if (req.query.month) {
    const month = req.query.month;
    const [budgetData] = await db.query(`
      SELECT b.*, c.name as category_name,
        (SELECT SUM(amount) FROM sl_biz_record WHERE category_id = b.category_id AND type = 'expense' AND book_id = ? AND record_date BETWEEN ? AND ? AND del_flag = 0) as spent
      FROM sl_biz_budget b
      LEFT JOIN sl_biz_category c ON b.category_id = c.id AND c.del_flag = 0
      WHERE b.book_id = ? AND b.month = ? AND b.del_flag = 0
    `, [bookId, startDate, endDate, bookId, month]);
    budgets = budgetData;
  }

  const [entityStats] = await db.query(`
    SELECT e.id, e.name, e.type, SUM(r.amount) as total, COUNT(*) as count
    FROM sl_biz_record r
    JOIN sl_biz_entity e ON r.entity_id = e.id AND e.del_flag = 0
    WHERE r.book_id = ? AND r.type = 'expense' AND r.del_flag = 0
      AND r.record_date BETWEEN ? AND ? AND r.is_template = false
    GROUP BY e.id
    ORDER BY total DESC
    LIMIT 10
  `, [bookId, startDate, endDate]);

  res.json({
    summary: summary[0],
    categoryExpense, categoryIncome,
    dailyTrend, budgets, entityStats, accountStats
  });
});

// 年度报表
router.get('/yearly', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const year = req.query.year || dayjs().format('YYYY');
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const [monthlyTrend] = await db.query(`
    SELECT DATE_FORMAT(record_date, '%Y-%m') as month,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expense
    FROM sl_biz_record
    WHERE book_id = ? AND record_date BETWEEN ? AND ? AND is_template = false AND del_flag = 0
    GROUP BY month
    ORDER BY month
  `, [bookId, startDate, endDate]);

  res.json({ monthlyTrend });
});

module.exports = router;
