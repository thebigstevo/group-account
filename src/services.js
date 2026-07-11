'use strict';

const dal = require('./dal');

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

/**
 * Build a date-range WHERE clause using $N numbered placeholders.
 * @param {string} column - The column name to filter on
 * @param {string|null} startDate - Start date (inclusive), or null
 * @param {string|null} endDate - End date (inclusive), or null
 * @param {number} startIndex - The next available $N index (1-based)
 * @returns {{ sql: string, params: Array, nextIndex: number }}
 */
function dateClause(column, startDate, endDate, startIndex = 1) {
  const clauses = [];
  const params = [];
  let idx = startIndex;
  if (startDate) {
    clauses.push(`${column} >= $${idx}`);
    params.push(startDate);
    idx++;
  }
  if (endDate) {
    clauses.push(`${column} <= $${idx}`);
    params.push(endDate);
    idx++;
  }
  return { sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params, nextIndex: idx };
}

async function accountBalances(asOfDate = null) {
  const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
  const results = [];
  for (const account of accounts) {
    let incomingSql;
    let incomingParams;
    if (asOfDate) {
      incomingSql = `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE (
          (tx_type = 'receipt' AND account_id = $1)
          OR (tx_type = 'transfer' AND to_account_id = $2)
        ) AND status = 'posted' AND tx_date <= $3
      `;
      incomingParams = [account.id, account.id, asOfDate];
    } else {
      incomingSql = `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE (
          (tx_type = 'receipt' AND account_id = $1)
          OR (tx_type = 'transfer' AND to_account_id = $2)
        ) AND status = 'posted'
      `;
      incomingParams = [account.id, account.id];
    }
    const incomingRow = await dal.queryOne(incomingSql, incomingParams);

    let outgoingSql;
    let outgoingParams;
    if (asOfDate) {
      outgoingSql = `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE (
          (tx_type IN ('expense','welfare_payout') AND account_id = $1)
          OR (tx_type = 'transfer' AND account_id = $2)
        ) AND status = 'posted' AND tx_date <= $3
      `;
      outgoingParams = [account.id, account.id, asOfDate];
    } else {
      outgoingSql = `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE (
          (tx_type IN ('expense','welfare_payout') AND account_id = $1)
          OR (tx_type = 'transfer' AND account_id = $2)
        ) AND status = 'posted'
      `;
      outgoingParams = [account.id, account.id];
    }
    const outgoingRow = await dal.queryOne(outgoingSql, outgoingParams);

    results.push({
      ...account,
      balance: money(account.opening_balance) + money(incomingRow.total) - money(outgoingRow.total)
    });
  }
  return results;
}

async function welfareLiability(asOfDate = null) {
  let collectedSql;
  let collectedParams;
  if (asOfDate) {
    collectedSql = `
      SELECT COALESCE(SUM(welfare_component), 0) AS total
      FROM transactions
      WHERE tx_type = 'receipt' AND status = 'posted' AND tx_date <= $1
    `;
    collectedParams = [asOfDate];
  } else {
    collectedSql = `
      SELECT COALESCE(SUM(welfare_component), 0) AS total
      FROM transactions
      WHERE tx_type = 'receipt' AND status = 'posted'
    `;
    collectedParams = [];
  }
  const collectedRow = await dal.queryOne(collectedSql, collectedParams);

  let paidOutSql;
  let paidOutParams;
  if (asOfDate) {
    paidOutSql = `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE tx_type = 'welfare_payout' AND status = 'posted' AND tx_date <= $1
    `;
    paidOutParams = [asOfDate];
  } else {
    paidOutSql = `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM transactions
      WHERE tx_type = 'welfare_payout' AND status = 'posted'
    `;
    paidOutParams = [];
  }
  const paidOutRow = await dal.queryOne(paidOutSql, paidOutParams);

  return money(collectedRow.total) - money(paidOutRow.total);
}

async function totalIncome(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'${period.sql}
  `, period.params);
  return money(row.total);
}

async function totalReceipts(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'${period.sql}
  `, period.params);
  return money(row.total);
}

async function totalWelfareCollected(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'${period.sql}
  `, period.params);
  return money(row.total);
}

async function totalExpenses(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'expense' AND status = 'posted'${period.sql}
  `, period.params);
  return money(row.total);
}

async function memberPaid(memberId, year) {
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt'
      AND member_id = $1
      AND category = 'Assessment'
      AND SUBSTRING(tx_date FROM 1 FOR 4) = $2
      AND status = 'posted'
  `, [memberId, String(year)]);
  return money(row.total);
}

async function memberDue(member, year) {
  const override = await dal.queryOne(`
    SELECT assessment_due, welfare_portion
    FROM member_dues
    WHERE member_id = $1 AND year = $2
  `, [member.id, year]);
  if (override) return override;

  const age = ageFromDob(member.dob, year);
  const rules = await dal.query(`
    SELECT * FROM dues_rules
    WHERE year = $1 AND active = true
    ORDER BY min_age DESC
  `, [year]);

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

async function paymentSplit(year, category) {
  return await dal.queryOne(`
    SELECT *
    FROM payment_splits
    WHERE year = $1 AND category = $2 AND active = true
  `, [year, category]);
}

async function calculateWelfareComponent({ memberId, category, amount, txDate, enteredWelfare }) {
  if (enteredWelfare !== undefined && enteredWelfare !== null && String(enteredWelfare).trim() !== '') {
    return money(enteredWelfare);
  }

  if (category === 'Welfare') return money(amount);
  if (category !== 'Assessment') return 0;

  const year = Number(String(txDate || '').slice(0, 4)) || currentYear();
  let member = null;
  if (memberId) {
    member = await dal.queryOne('SELECT * FROM members WHERE id = $1', [memberId]);
  }
  if (member) {
    const due = await memberDue(member, year);
    if (money(due.assessment_due) > 0 && money(due.welfare_portion) > 0) {
      return Math.round((money(amount) * money(due.welfare_portion) / money(due.assessment_due)) * 100) / 100;
    }
  }

  const split = await paymentSplit(year, category);
  if (!split || money(split.assessment_amount) <= 0 || money(split.welfare_amount) <= 0) return 0;
  return Math.round((money(amount) * money(split.welfare_amount) / money(split.assessment_amount)) * 100) / 100;
}

async function arrearsReport(year = currentYear()) {
  const members = await dal.query('SELECT * FROM members WHERE status = $1 ORDER BY name', ['active']);
  const results = [];
  for (const member of members) {
    const due = await memberDue(member, year);
    const paid = await memberPaid(member.id, year);
    const balance = money(member.opening_arrears) + money(due.assessment_due) - paid;
    results.push({
      member_id: member.id,
      name: member.name,
      phone: member.phone,
      opening_arrears: money(member.opening_arrears),
      assessment_due: money(due.assessment_due),
      welfare_portion: money(due.welfare_portion),
      paid,
      balance
    });
  }
  return results;
}

async function latestReconciliations(endDate = null) {
  const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');
  const results = [];
  for (const account of accounts) {
    let row;
    if (endDate) {
      row = await dal.queryOne(`
        SELECT *
        FROM reconciliations
        WHERE account_id = $1 AND period_end <= $2
        ORDER BY period_end DESC, id DESC
        LIMIT 1
      `, [account.id, endDate]);
    } else {
      row = await dal.queryOne(`
        SELECT *
        FROM reconciliations
        WHERE account_id = $1
        ORDER BY period_end DESC, id DESC
        LIMIT 1
      `, [account.id]);
    }
    results.push({
      account_id: account.id,
      account_name: account.name,
      statement_balance: row ? money(row.statement_balance) : null,
      system_balance: row ? money(row.system_balance) : null,
      difference: row ? money(row.difference) : null,
      period_end: row ? row.period_end : null
    });
  }
  return results;
}

async function runningBalanceRows(startDate, endDate) {
  const dayBefore = new Date(`${startDate}T00:00:00Z`);
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
  const openingDate = dayBefore.toISOString().slice(0, 10);
  const openingBalances = await accountBalances(openingDate);
  let running = openingBalances.reduce((sum, item) => sum + item.balance, 0);

  const rows = await dal.query(`
    SELECT t.*, m.name AS member_name, a.name AS account_name, ta.name AS to_account_name
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    WHERE t.tx_date >= $1 AND t.tx_date <= $2 AND t.status = 'posted'
    ORDER BY t.tx_date ASC, t.id ASC
  `, [startDate, endDate]);

  return rows.map((row) => {
    let cashImpact = 0;
    if (row.tx_type === 'receipt') cashImpact = money(row.amount);
    if (row.tx_type === 'expense' || row.tx_type === 'welfare_payout') cashImpact = -money(row.amount);
    running += cashImpact;
    return { ...row, cashImpact, runningBalance: running };
  });
}

async function reportSummary(startDate = null, endDate = null) {
  const balances = await accountBalances(endDate);
  const welfare = await welfareLiability(endDate);
  return {
    balances,
    totalCashPosition: balances.reduce((sum, item) => sum + item.balance, 0),
    spendableBalance: balances.reduce((sum, item) => sum + item.balance, 0) - welfare,
    grossReceipts: await totalReceipts(startDate, endDate),
    welfareCollected: await totalWelfareCollected(startDate, endDate),
    income: await totalIncome(startDate, endDate),
    expenses: await totalExpenses(startDate, endDate),
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
