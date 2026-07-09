const { db } = require('./db');

function currentYear() {
  return new Date().getFullYear();
}

function ageFromDob(dob, asOfYear = currentYear()) {
  if (!dob) return null;
  const date = new Date(dob);
  if (Number.isNaN(date.getTime())) return null;
  return asOfYear - date.getFullYear();
}

function money(value) {
  return Number(value || 0);
}

function dateClause(column, startDate, endDate) {
  const clauses = [];
  const params = [];
  if (startDate) {
    clauses.push(`${column} >= ?`);
    params.push(startDate);
  }
  if (endDate) {
    clauses.push(`${column} <= ?`);
    params.push(endDate);
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

function accountBalances(asOfDate = null) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all();
  return accounts.map((account) => {
    const asOfSql = asOfDate ? ' AND tx_date <= ?' : '';
    const asOfParams = asOfDate ? [asOfDate] : [];
    const incoming = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE (
        (tx_type = 'receipt' AND account_id = ?)
        OR (tx_type = 'transfer' AND to_account_id = ?)
      ) AND status = 'posted' ${asOfSql}
    `).get(account.id, account.id, ...asOfParams).total;

    const outgoing = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE (
        (tx_type IN ('expense','welfare_payout') AND account_id = ?)
        OR (tx_type = 'transfer' AND account_id = ?)
      ) AND status = 'posted' ${asOfSql}
    `).get(account.id, account.id, ...asOfParams).total;

    return {
      ...account,
      balance: money(account.opening_balance) + money(incoming) - money(outgoing)
    };
  });
}

function welfareLiability(asOfDate = null) {
  const asOfSql = asOfDate ? ' AND tx_date <= ?' : '';
  const asOfParams = asOfDate ? [asOfDate] : [];
  const collected = db.prepare(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' ${asOfSql}
  `).get(...asOfParams).total;
  const paidOut = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'welfare_payout' AND status = 'posted' ${asOfSql}
  `).get(...asOfParams).total;
  return money(collected) - money(paidOut);
}

function totalIncome(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate);
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' ${period.sql}
  `).get(...period.params);
  return money(row.total);
}

function totalReceipts(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate);
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' ${period.sql}
  `).get(...period.params);
  return money(row.total);
}

function totalWelfareCollected(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate);
  const row = db.prepare(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' ${period.sql}
  `).get(...period.params);
  return money(row.total);
}

function totalExpenses(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate);
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'expense' AND status = 'posted' ${period.sql}
  `).get(...period.params);
  return money(row.total);
}

function memberPaid(memberId, year) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt'
      AND member_id = ?
      AND category = 'Assessment'
      AND strftime('%Y', tx_date) = ?
      AND status = 'posted'
  `).get(memberId, String(year));
  return money(row.total);
}

function memberDue(member, year) {
  const override = db.prepare(`
    SELECT assessment_due, welfare_portion
    FROM member_dues
    WHERE member_id = ? AND year = ?
  `).get(member.id, year);
  if (override) return override;

  const age = ageFromDob(member.dob, year);
  const rules = db.prepare(`
    SELECT * FROM dues_rules
    WHERE year = ? AND active = 1
    ORDER BY min_age DESC
  `).all(year);

  const rule = rules.find((item) => {
    const minOk = item.min_age == null || age == null || age >= item.min_age;
    const maxOk = item.max_age == null || age == null || age <= item.max_age;
    return minOk && maxOk;
  });

  return {
    assessment_due: rule ? money(rule.annual_assessment) : 0,
    welfare_portion: rule ? money(rule.welfare_portion) : 0
  };
}

function paymentSplit(year, category) {
  return db.prepare(`
    SELECT *
    FROM payment_splits
    WHERE year = ? AND category = ? AND active = 1
  `).get(year, category);
}

function calculateWelfareComponent({ memberId, category, amount, txDate, enteredWelfare }) {
  if (enteredWelfare !== undefined && enteredWelfare !== null && String(enteredWelfare).trim() !== '') {
    return money(enteredWelfare);
  }

  if (category === 'Welfare') return money(amount);
  if (category !== 'Assessment') return 0;

  const year = Number(String(txDate || '').slice(0, 4)) || currentYear();
  const member = memberId ? db.prepare('SELECT * FROM members WHERE id = ?').get(memberId) : null;
  if (member) {
    const due = memberDue(member, year);
    if (money(due.assessment_due) > 0 && money(due.welfare_portion) > 0) {
      return Math.round((money(amount) * money(due.welfare_portion) / money(due.assessment_due)) * 100) / 100;
    }
  }

  const split = paymentSplit(year, category);
  if (!split || money(split.assessment_amount) <= 0 || money(split.welfare_amount) <= 0) return 0;
  return Math.round((money(amount) * money(split.welfare_amount) / money(split.assessment_amount)) * 100) / 100;
}

function arrearsReport(year = currentYear()) {
  const members = db.prepare('SELECT * FROM members WHERE status = ? ORDER BY name').all('active');
  return members.map((member) => {
    const due = memberDue(member, year);
    const paid = memberPaid(member.id, year);
    const balance = money(member.opening_arrears) + money(due.assessment_due) - paid;
    return {
      member_id: member.id,
      name: member.name,
      phone: member.phone,
      opening_arrears: money(member.opening_arrears),
      assessment_due: money(due.assessment_due),
      welfare_portion: money(due.welfare_portion),
      paid,
      balance
    };
  });
}

function latestReconciliations(endDate = null) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all();
  return accounts.map((account) => {
    const row = db.prepare(`
      SELECT *
      FROM reconciliations
      WHERE account_id = ?
        AND (? IS NULL OR period_end <= ?)
      ORDER BY period_end DESC, id DESC
      LIMIT 1
    `).get(account.id, endDate, endDate);
    return {
      account_id: account.id,
      account_name: account.name,
      statement_balance: row ? money(row.statement_balance) : null,
      system_balance: row ? money(row.system_balance) : null,
      difference: row ? money(row.difference) : null,
      period_end: row ? row.period_end : null
    };
  });
}

function runningBalanceRows(startDate, endDate) {
  const dayBefore = new Date(`${startDate}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const openingDate = dayBefore.toISOString().slice(0, 10);
  let running = accountBalances(openingDate).reduce((sum, item) => sum + item.balance, 0);

  const rows = db.prepare(`
    SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    WHERE t.tx_date >= ? AND t.tx_date <= ? AND t.status = 'posted'
    ORDER BY t.tx_date ASC, t.id ASC
  `).all(startDate, endDate);

  return rows.map((row) => {
    let cashImpact = 0;
    if (row.tx_type === 'receipt') cashImpact = money(row.amount);
    if (row.tx_type === 'expense' || row.tx_type === 'welfare_payout') cashImpact = -money(row.amount);
    running += cashImpact;
    return { ...row, cashImpact, runningBalance: running };
  });
}

function reportSummary(startDate = null, endDate = null) {
  const balances = accountBalances(endDate);
  const welfare = welfareLiability(endDate);
  return {
    balances,
    totalCashPosition: balances.reduce((sum, item) => sum + item.balance, 0),
    spendableBalance: balances.reduce((sum, item) => sum + item.balance, 0) - welfare,
    grossReceipts: totalReceipts(startDate, endDate),
    welfareCollected: totalWelfareCollected(startDate, endDate),
    income: totalIncome(startDate, endDate),
    expenses: totalExpenses(startDate, endDate),
    welfareLiability: welfare
  };
}

module.exports = {
  accountBalances,
  welfareLiability,
  totalIncome,
  totalReceipts,
  totalWelfareCollected,
  totalExpenses,
  memberPaid,
  memberDue,
  arrearsReport,
  reportSummary,
  latestReconciliations,
  runningBalanceRows,
  calculateWelfareComponent,
  currentYear
};
