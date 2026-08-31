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
    const dateFilter = asOfDate ? ' AND tx_date <= $2' : '';
    const params = asOfDate ? [account.id, asOfDate] : [account.id];

    const sql = `
      SELECT COALESCE(SUM(
        CASE
          WHEN reverses_transaction_id IS NULL THEN
            CASE
              WHEN (tx_type = 'receipt' AND account_id = $1) OR (tx_type = 'transfer' AND to_account_id = $1) THEN amount
              WHEN (tx_type IN ('expense','welfare_payout') AND account_id = $1) OR (tx_type = 'transfer' AND account_id = $1 AND to_account_id IS NOT NULL) THEN -amount
              ELSE 0
            END
          ELSE
            CASE
              WHEN (tx_type = 'receipt' AND account_id = $1) OR (tx_type = 'transfer' AND to_account_id = $1) THEN -amount
              WHEN (tx_type IN ('expense','welfare_payout') AND account_id = $1) OR (tx_type = 'transfer' AND account_id = $1 AND to_account_id IS NOT NULL) THEN amount
              ELSE 0
            END
        END
      ), 0) AS net_movement
      FROM transactions
      WHERE status = 'posted' AND reverses_transaction_id IS NULL${dateFilter}
    `;

    const row = await dal.queryOne(sql, params);
    results.push({
      ...account,
      balance: money(account.opening_balance) + money(row.net_movement)
    });
  }
  return results;
}

async function computeFundBalances(asOfDate = null) {
  const dateFilter = asOfDate ? ' AND t.tx_date <= $1' : '';
  const params = asOfDate ? [asOfDate] : [];

  const sql = `
    SELECT
      fc.code,
      fc.name,
      COALESCE(SUM(
        CASE
          WHEN t.id IS NULL THEN 0
          WHEN t.tx_type IN ('expense', 'welfare_payout') THEN -ra.amount
          ELSE ra.amount
        END
      ), 0) AS balance
    FROM fund_classifications fc
    LEFT JOIN receipt_allocations ra ON ra.fund_classification_id = fc.id
    LEFT JOIN transactions t ON t.id = ra.transaction_id
      AND t.status = 'posted'
      AND t.reverses_transaction_id IS NULL${dateFilter}
    WHERE fc.active = true
    GROUP BY fc.id, fc.code, fc.name
    ORDER BY fc.id
  `;

  const rows = await dal.query(sql, params);
  const result = {};
  for (const row of rows) {
    result[row.code] = money(row.balance);
  }
  return result;
}

async function welfareLiability(asOfDate = null) {
  const dateFilter = asOfDate ? ' AND t.tx_date <= $1' : '';
  const params = asOfDate ? [asOfDate] : [];

  const sql = `
    SELECT COALESCE(SUM(
      CASE
        WHEN t.tx_type = 'welfare_payout' THEN -ra.amount
        ELSE ra.amount
      END
    ), 0) AS balance
    FROM receipt_allocations ra
    JOIN transactions t ON t.id = ra.transaction_id AND t.status = 'posted' AND t.reverses_transaction_id IS NULL${dateFilter}
    JOIN fund_classifications fc ON fc.id = ra.fund_classification_id AND fc.code = 'joint_welfare'
  `;

  const row = await dal.queryOne(sql, params);
  return money(row.balance);
}

async function totalIncome(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  // Operating income = receipt allocations classified as mens_operating
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(ra.amount), 0) AS total
    FROM receipt_allocations ra
    JOIN transactions t ON t.id = ra.transaction_id
      AND t.status = 'posted'
      AND t.reverses_transaction_id IS NULL
      AND t.tx_type = 'receipt'${period.sql}
    JOIN fund_classifications fc ON fc.id = ra.fund_classification_id
      AND fc.code = 'mens_operating'
  `, period.params);
  return money(row.total);
}

async function totalReceipts(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' AND reverses_transaction_id IS NULL${period.sql}
  `, period.params);
  return money(row.total);
}

async function totalWelfareCollected(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  // Welfare collected = receipt allocations classified as joint_welfare
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(ra.amount), 0) AS total
    FROM receipt_allocations ra
    JOIN transactions t ON t.id = ra.transaction_id
      AND t.status = 'posted'
      AND t.reverses_transaction_id IS NULL
      AND t.tx_type = 'receipt'${period.sql}
    JOIN fund_classifications fc ON fc.id = ra.fund_classification_id
      AND fc.code = 'joint_welfare'
  `, period.params);
  return money(row.total);
}

async function totalExpenses(startDate = null, endDate = null) {
  const period = dateClause('tx_date', startDate, endDate, 1);
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'expense' AND status = 'posted' AND reverses_transaction_id IS NULL${period.sql}
  `, period.params);
  return money(row.total);
}

async function memberPaid(memberId, year) {
  const row = await dal.queryOne(`
    SELECT COALESCE(SUM(t.amount), 0) AS total
    FROM transactions t
    JOIN transaction_categories c ON c.name = t.category
    WHERE t.tx_type = 'receipt'
      AND t.member_id = $1
      AND c.purpose = 'assessment'
      AND SUBSTRING(t.tx_date FROM 1 FOR 4) = $2
      AND t.status = 'posted'
      AND t.reverses_transaction_id IS NULL
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

  const categoryConfig = await dal.queryOne(
    'SELECT purpose FROM transaction_categories WHERE name = $1 AND active = true',
    [category]
  );
  if (!categoryConfig) return 0;
  if (categoryConfig.purpose === 'welfare_income') return money(amount);
  if (categoryConfig.purpose === 'welfare_payout') return 0;

  const year = Number(String(txDate || '').slice(0, 4)) || currentYear();

  // For assessment categories, try member-specific dues first
  if (categoryConfig.purpose === 'assessment') {
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
  }

  // For any income category (assessment, standard, etc.), check payment splits
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
    WHERE t.tx_date >= $1 AND t.tx_date <= $2 AND t.status = 'posted' AND t.reverses_transaction_id IS NULL
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

async function budgetVsActual(year) {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  const [header, budgetLines, actualRows] = await Promise.all([
    dal.queryOne('SELECT * FROM annual_budgets WHERE year = $1', [year]),
    dal.query(`
      SELECT l.*, c.active AS category_active
      FROM annual_budget_lines l
      LEFT JOIN transaction_categories c ON c.name = l.category
      WHERE l.year = $1
      ORDER BY l.kind, l.category
    `, [year]),
    dal.query(`
      SELECT category,
        CASE WHEN tx_type = 'receipt' THEN 'income' ELSE 'expense' END AS kind,
        COALESCE(SUM(amount), 0) AS actual
      FROM transactions
      WHERE status = 'posted'
        AND reverses_transaction_id IS NULL
        AND tx_type IN ('receipt','expense','welfare_payout')
        AND tx_date >= $1 AND tx_date <= $2
      GROUP BY category, CASE WHEN tx_type = 'receipt' THEN 'income' ELSE 'expense' END
      ORDER BY kind, category
    `, [startDate, endDate])
  ]);

  const byKey = new Map();
  budgetLines.forEach((line) => {
    byKey.set(`${line.kind}:${line.category}`, {
      id: line.id,
      category: line.category,
      kind: line.kind,
      budget: money(line.amount),
      actual: 0,
      notes: line.notes || '',
      categoryActive: line.category_active !== false
    });
  });
  actualRows.forEach((row) => {
    const key = `${row.kind}:${row.category}`;
    const item = byKey.get(key) || {
      id: null,
      category: row.category,
      kind: row.kind,
      budget: 0,
      actual: 0,
      notes: '',
      categoryActive: true
    };
    item.actual = money(row.actual);
    byKey.set(key, item);
  });

  const lines = Array.from(byKey.values())
    .map((line) => ({ ...line, variance: line.actual - line.budget }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.category.localeCompare(b.category));
  const totals = ['income', 'expense'].reduce((result, kind) => {
    const matching = lines.filter((line) => line.kind === kind);
    result[kind] = {
      budget: matching.reduce((sum, line) => sum + line.budget, 0),
      actual: matching.reduce((sum, line) => sum + line.actual, 0)
    };
    result[kind].variance = result[kind].actual - result[kind].budget;
    return result;
  }, {});
  return { year, header, lines, totals };
}

async function auditEvidence(year) {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  const [summary, transactions, balances, reconciliations] = await Promise.all([
    dal.queryOne(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'posted' AND reverses_transaction_id IS NULL)::int AS posted_count,
        COUNT(*) FILTER (WHERE status = 'reversed')::int AS reversed_count,
        COUNT(*) FILTER (WHERE status = 'posted' AND reverses_transaction_id IS NULL AND tx_type <> 'transfer' AND reconciled = false)::int AS unreconciled_count,
        COUNT(*) FILTER (WHERE status = 'posted' AND reverses_transaction_id IS NULL AND tx_type <> 'transfer' AND COALESCE(TRIM(reference), '') = '')::int AS missing_reference_count,
        COUNT(*) FILTER (WHERE status = 'posted' AND reverses_transaction_id IS NULL AND tx_type <> 'transfer' AND COALESCE(TRIM(description), '') = '')::int AS missing_description_count,
        COALESCE(SUM(amount) FILTER (WHERE status = 'posted' AND reverses_transaction_id IS NULL AND tx_type = 'receipt'), 0) AS receipts,
        COALESCE(SUM(amount) FILTER (WHERE status = 'posted' AND reverses_transaction_id IS NULL AND tx_type IN ('expense','welfare_payout')), 0) AS outflows
      FROM transactions
      WHERE tx_date >= $1 AND tx_date <= $2
    `, [startDate, endDate]),
    dal.query(`
      SELECT t.id, t.tx_date, t.tx_type, t.category, t.amount, t.reference,
        t.description, t.reconciled, t.status, a.name AS account_name,
        ta.name AS to_account_name, u.name AS recorded_by
      FROM transactions t
      LEFT JOIN accounts a ON a.id = t.account_id
      LEFT JOIN accounts ta ON ta.id = t.to_account_id
      LEFT JOIN users u ON u.id = t.created_by
      WHERE t.tx_date >= $1 AND t.tx_date <= $2
      ORDER BY t.tx_date DESC, t.id DESC
      LIMIT 250
    `, [startDate, endDate]),
    accountBalances(endDate),
    latestReconciliations(endDate)
  ]);
  return {
    year,
    startDate,
    endDate,
    summary: {
      postedCount: Number(summary && summary.posted_count || 0),
      reversedCount: Number(summary && summary.reversed_count || 0),
      unreconciledCount: Number(summary && summary.unreconciled_count || 0),
      missingReferenceCount: Number(summary && summary.missing_reference_count || 0),
      missingDescriptionCount: Number(summary && summary.missing_description_count || 0),
      receipts: money(summary && summary.receipts),
      outflows: money(summary && summary.outflows)
    },
    transactions,
    balances,
    reconciliations
  };
}

async function latestCompletedAudit() {
  const row = await dal.queryOne(`
    SELECT r.completed_at AS date, r.overall_conclusion AS conclusion, u.name AS trustee_name
    FROM audit_reviews r
    LEFT JOIN users u ON u.id = r.completed_by
    WHERE r.status = 'completed'
    ORDER BY r.completed_at DESC
    LIMIT 1
  `);
  if (!row) return null;
  return {
    date: row.date,
    conclusion: row.conclusion,
    trusteeName: row.trustee_name
  };
}

async function periodComparison(currentYearParam) {
  const previousYear = currentYearParam - 1;
  const currentStart = `${currentYearParam}-01-01`;
  const currentEnd = `${currentYearParam}-12-31`;
  const previousStart = `${previousYear}-01-01`;
  const previousEnd = `${previousYear}-12-31`;

  // Query income and expense totals grouped by category for both years
  const [currentRows, previousRows] = await Promise.all([
    dal.query(`
      SELECT category,
        COALESCE(SUM(amount) FILTER (WHERE tx_type = 'receipt'), 0) AS income,
        COALESCE(SUM(amount) FILTER (WHERE tx_type IN ('expense', 'welfare_payout')), 0) AS expense
      FROM transactions
      WHERE status = 'posted'
        AND reverses_transaction_id IS NULL
        AND tx_type IN ('receipt', 'expense', 'welfare_payout')
        AND tx_date >= $1 AND tx_date <= $2
      GROUP BY category
      ORDER BY category
    `, [currentStart, currentEnd]),
    dal.query(`
      SELECT category,
        COALESCE(SUM(amount) FILTER (WHERE tx_type = 'receipt'), 0) AS income,
        COALESCE(SUM(amount) FILTER (WHERE tx_type IN ('expense', 'welfare_payout')), 0) AS expense
      FROM transactions
      WHERE status = 'posted'
        AND reverses_transaction_id IS NULL
        AND tx_type IN ('receipt', 'expense', 'welfare_payout')
        AND tx_date >= $1 AND tx_date <= $2
      GROUP BY category
      ORDER BY category
    `, [previousStart, previousEnd])
  ]);

  // Build a map of all categories across both years
  const categoryMap = new Map();

  currentRows.forEach((row) => {
    categoryMap.set(row.category, {
      category: row.category,
      currentIncome: money(row.income),
      previousIncome: 0,
      currentExpense: money(row.expense),
      previousExpense: 0
    });
  });

  previousRows.forEach((row) => {
    const existing = categoryMap.get(row.category) || {
      category: row.category,
      currentIncome: 0,
      previousIncome: 0,
      currentExpense: 0,
      previousExpense: 0
    };
    existing.previousIncome = money(row.income);
    existing.previousExpense = money(row.expense);
    categoryMap.set(row.category, existing);
  });

  // Compute variance and highlighting for each category
  const results = Array.from(categoryMap.values()).map((item) => {
    const currentTotal = item.currentIncome + item.currentExpense;
    const previousTotal = item.previousIncome + item.previousExpense;

    let variancePercent = 0;
    if (previousTotal !== 0) {
      variancePercent = ((currentTotal - previousTotal) / previousTotal) * 100;
    } else if (currentTotal !== 0) {
      // Previous was zero but current has activity — treat as 100% increase
      variancePercent = 100;
    }

    // Round to 2 decimal places
    variancePercent = Math.round(variancePercent * 100) / 100;

    const highlighted = Math.abs(variancePercent) > 20;

    return {
      category: item.category,
      currentIncome: item.currentIncome,
      previousIncome: item.previousIncome,
      currentExpense: item.currentExpense,
      previousExpense: item.previousExpense,
      variancePercent,
      highlighted
    };
  });

  return results.sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Returns a count summary for an audit review:
 * - flaggedCount: number of transactions flagged by the trustee
 * - unreconciledCount: number of unreconciled transactions in the review's scope period
 * - completedItems: number of checklist items that have been reviewed (status != 'pending')
 * - totalItems: total number of checklist items for the review
 *
 * @param {number} reviewId - The audit review ID
 * @returns {Promise<{flaggedCount: number, unreconciledCount: number, completedItems: number, totalItems: number}>}
 */
async function auditCountSummary(reviewId) {
  // Get the review to determine its date scope
  const review = await dal.queryOne('SELECT scope_start, scope_end FROM audit_reviews WHERE id = $1', [reviewId]);

  // Count flagged transactions for this review
  const flagRow = await dal.queryOne(
    'SELECT COUNT(*)::int AS count FROM audit_flags WHERE review_id = $1',
    [reviewId]
  );
  const flaggedCount = Number(flagRow && flagRow.count || 0);

  // Count unreconciled transactions within the review's scope period
  let unreconciledCount = 0;
  if (review) {
    const unreconciledRow = await dal.queryOne(`
      SELECT COUNT(*)::int AS count
      FROM transactions
      WHERE status = 'posted'
        AND reverses_transaction_id IS NULL
        AND tx_type <> 'transfer'
        AND reconciled = false
        AND tx_date >= $1 AND tx_date <= $2
    `, [review.scope_start, review.scope_end]);
    unreconciledCount = Number(unreconciledRow && unreconciledRow.count || 0);
  }

  // Count checklist progress
  const progressRow = await dal.queryOne(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status <> 'pending')::int AS completed
    FROM audit_review_items
    WHERE review_id = $1
  `, [reviewId]);
  const totalItems = Number(progressRow && progressRow.total || 0);
  const completedItems = Number(progressRow && progressRow.completed || 0);

  return { flaggedCount, unreconciledCount, completedItems, totalItems };
}

module.exports = {
  accountBalances,
  computeFundBalances,
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
  budgetVsActual,
  auditEvidence,
  auditCountSummary,
  calculateWelfareComponent,
  currentYear,
  latestCompletedAudit,
  periodComparison
};
