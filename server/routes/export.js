const express = require('express');
const dayjs = require('dayjs');
const db = require('../db');
const auth = require('../middleware/auth');
const { getBookRole } = require('../middleware/bookAccess');

const router = express.Router();

// 防止CSV公式注入：前缀 = + - @ 开头的单元格
function csvEscape(val) {
  const s = String(val == null ? '' : val).replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(s)) {
    return "'" + s;
  }
  return s;
}

// 导出CSV
router.get('/csv', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const month = req.query.month;
  let dateFilter = '';
  const params = [bookId];

  if (month) {
    dateFilter = 'AND r.record_date BETWEEN ? AND ?';
    params.push(`${month}-01`, dayjs(`${month}-01`).endOf('month').format('YYYY-MM-DD'));
  }

  const [records] = await db.query(`
    SELECT r.record_date, r.type, c.name as category, pc.name as parent_category,
      r.amount, a.name as account, r.note
    FROM sl_biz_record r
    LEFT JOIN sl_biz_category c ON r.category_id = c.id AND c.del_flag = 0
    LEFT JOIN sl_biz_category pc ON c.parent_id = pc.id AND pc.del_flag = 0
    LEFT JOIN sl_acc_account a ON r.account_id = a.id AND a.del_flag = 0
    WHERE r.book_id = ? AND r.is_template = false AND r.del_flag = 0 ${dateFilter}
    ORDER BY r.record_date DESC
  `, params);

  const typeMap = { expense: '支出', income: '收入', transfer: '转账' };
  let csv = '\uFEFF日期,类型,分类,子分类,金额,账户,备注\n';
  records.forEach(r => {
    csv += `${csvEscape(r.record_date)},${csvEscape(typeMap[r.type] || r.type)},"${csvEscape(r.parent_category)}","${csvEscape(r.category)}",${r.amount},"${csvEscape(r.account)}","${csvEscape(r.note)}"\n`;
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ledger-${month || 'all'}.csv"`);
  res.send(csv);
});

// 导出JSON（完整备份）
router.get('/json', auth, async (req, res) => {
  const bookId = req.query.book_id;
  if (!bookId) return res.status(400).json({ error: '缺少book_id参数' });
  const role = await getBookRole(req.userId, bookId);
  if (!role) return res.status(403).json({ error: '无权访问该账本' });

  const [records] = await db.query(
    'SELECT * FROM sl_biz_record WHERE book_id = ? AND is_template = false AND del_flag = 0 ORDER BY record_date DESC',
    [bookId]
  );

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="ledger-backup-${dayjs().format('YYYYMMDD')}.json"`);
  res.json({ export_date: dayjs().format('YYYY-MM-DD HH:mm:ss'), records });
});

module.exports = router;
