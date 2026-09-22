/**
 * 还款提醒定时任务
 * - 借贷到期前3天通知一次
 * - 借贷到期当天若未结清再通知一次
 * - 信用卡还款日前3天通知一次
 * - 信用卡还款日当天若有未还账单再通知一次
 *
 * 使用唯一索引 (user_id, type, related_id, stage, period) 自动去重，
 * 重复执行不会产生重复通知。
 */
const db = require('../db');
const snowflake = require('../utils/snowflake');

// 插入通知（利用 INSERT IGNORE + 唯一索引自动去重），返回是否实际插入
async function insertNotification({ user_id, type, title, content, related_type, related_id, stage, period }) {
  try {
    const [result] = await db.query(
      `INSERT IGNORE INTO sl_sys_notification
        (id, user_id, type, title, content, related_type, related_id, stage, period)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [snowflake.nextId(), user_id, type, title, content, related_type || null, related_id || null, stage || null, period || null]
    );
    return result.affectedRows > 0;
  } catch (e) {
    console.error('[reminderJob] insert notification failed:', e.message);
    return false;
  }
}

// 计算某天的日期字符串 (YYYY-MM-DD)，offsetDays 为相对今天的天数（使用本地时区）
function dateStr(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 计算信用卡下一个还款日（考虑月末日期不存在的情况）
function getNextCreditDueDate(repayDay) {
  if (!repayDay || repayDay < 1 || repayDay > 31) return null;
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  let dueY = y, dueM = m;
  if (today > repayDay) {
    dueM = m + 1;
    if (dueM > 11) { dueM = 0; dueY = y + 1; }
  }
  const daysInMonth = new Date(dueY, dueM + 1, 0).getDate();
  const day = Math.min(repayDay, daysInMonth);
  return { date: `${dueY}-${String(dueM + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, period: `${dueY}-${String(dueM + 1).padStart(2, '0')}` };
}

// 获取账本的所有成员ID（包括owner）
async function getBookMemberIds(bookId) {
  const [rows] = await db.query(
    `SELECT b.owner_id AS user_id FROM sl_ledger_book b WHERE b.id = ? AND b.del_flag = 0
     UNION
     SELECT bm.user_id FROM sl_ledger_book_member bm WHERE bm.book_id = ? AND bm.del_flag = 0`,
    [bookId, bookId]
  );
  return rows.map(r => r.user_id);
}

// 主逻辑：检查并生成提醒
async function generateReminders() {
  const today = dateStr(0);
  const in3Days = dateStr(3);

  // 确保表存在
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

  let inserted = 0;

  // ========== 1. 借贷到期前3天提醒 ==========
  const [soonLoans] = await db.query(
    `SELECT id, book_id, user_id, type, contact_name, amount, remaining, due_date
     FROM sl_biz_loan
     WHERE due_date = ? AND is_settled = 0 AND del_flag = 0`,
    [in3Days]
  );
  for (const loan of soonLoans) {
    const typeText = loan.type === 'lend' ? '借出' : '借入';
    const title = `⏰ ${typeText}即将到期`;
    const content = `${loan.contact_name}的${typeText}${Number(loan.amount).toFixed(2)}元，剩余${Number(loan.remaining).toFixed(2)}元，将于3天后（${loan.due_date}）到期，请及时处理。`;
    if (await insertNotification({
      user_id: loan.user_id, type: 'loan_due', title, content,
      related_type: 'loan', related_id: loan.id, stage: 'soon', period: String(loan.due_date)
    })) inserted++;
  }

  // ========== 2. 借贷到期当天提醒（未结清）==========
  const [todayLoans] = await db.query(
    `SELECT id, book_id, user_id, type, contact_name, amount, remaining, due_date
     FROM sl_biz_loan
     WHERE due_date = ? AND is_settled = 0 AND del_flag = 0`,
    [today]
  );
  for (const loan of todayLoans) {
    const typeText = loan.type === 'lend' ? '借出' : '借入';
    const title = `🔔 ${typeText}今日到期`;
    const content = `${loan.contact_name}的${typeText}${Number(loan.amount).toFixed(2)}元，剩余${Number(loan.remaining).toFixed(2)}元，今日（${loan.due_date}）到期，请尽快${loan.type === 'lend' ? '催收' : '还款'}。`;
    if (await insertNotification({
      user_id: loan.user_id, type: 'loan_due', title, content,
      related_type: 'loan', related_id: loan.id, stage: 'today', period: String(loan.due_date)
    })) inserted++;
  }

  // ========== 3. 信用卡还款提醒 ==========
  const [creditCards] = await db.query(
    `SELECT id, book_id, user_id, name, icon, balance, bill_day, repay_day
     FROM sl_acc_account
     WHERE type = 'credit' AND repay_day IS NOT NULL AND del_flag = 0`
  );

  let creditNotified = 0;
  for (const card of creditCards) {
    const due = getNextCreditDueDate(card.repay_day);
    if (!due) continue;

    const cardName = `${card.icon || '💳'} ${card.name}`;
    const hasDebt = Number(card.balance) < 0;
    const memberIds = await getBookMemberIds(card.book_id);

    // 3天后到期提醒（有欠款才提醒）
    if (due.date === in3Days && hasDebt) {
      const debtAmount = Math.abs(Number(card.balance)).toFixed(2);
      let cardNotified = false;
      for (const userId of memberIds) {
        if (await insertNotification({
          user_id: userId, type: 'credit_due',
          title: '💳 信用卡还款提醒',
          content: `${cardName}将在3天后（${due.date}）还款日，当前待还金额${debtAmount}元，请提前准备还款资金。`,
          related_type: 'account', related_id: card.id, stage: 'soon', period: due.period
        })) { inserted++; cardNotified = true; }
      }
      if (cardNotified) creditNotified++;
    }

    // 当天到期提醒（有欠款才提醒）
    if (due.date === today && hasDebt) {
      const debtAmount = Math.abs(Number(card.balance)).toFixed(2);
      let cardNotified = false;
      for (const userId of memberIds) {
        if (await insertNotification({
          user_id: userId, type: 'credit_due',
          title: '🔔 信用卡今日还款',
          content: `${cardName}今日（${due.date}）还款日，当前待还金额${debtAmount}元，请及时还款以免逾期。`,
          related_type: 'account', related_id: card.id, stage: 'today', period: due.period
        })) { inserted++; cardNotified = true; }
      }
      if (cardNotified) creditNotified++;
    }
  }

  if (inserted > 0) {
    console.log(`[reminderJob] 生成${inserted}条提醒：${soonLoans.length}笔3天后到期借贷，${todayLoans.length}笔今日到期借贷，${creditNotified}张信用卡需还款`);
  } else {
    console.log(`[reminderJob] 检查完成：今日无到期/即将到期的借贷，${creditCards.length}张信用卡均无需提醒（还款日不在3天内或无欠款）`);
  }
}

// 启动定时任务：每天上午9点执行
function startReminderJob() {
  const scheduleNext = () => {
    const now = new Date();
    const next9am = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0, 0);
    if (now >= next9am) next9am.setDate(next9am.getDate() + 1);
    const ms = next9am - now;
    setTimeout(async () => {
      try {
        await generateReminders();
      } catch (e) {
        console.error('[reminderJob] 执行失败:', e.message);
      }
      scheduleNext();
    }, ms);
  };

  // 启动时立即执行一次（服务重启后补检，唯一索引保证不重复）
  generateReminders().catch(e => console.error('[reminderJob] 启动执行失败:', e.message));
  scheduleNext();
  console.log('[reminderJob] 还款提醒定时任务已启动（每天9:00执行）');
}

module.exports = { generateReminders, startReminderJob };
