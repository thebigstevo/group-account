/**
 * Automated Audit Checks for Treasurio
 * Runs data-driven financial integrity checks and returns pass/fail/warning results.
 */
const dal = require('./dal');

/**
 * Run all automated audit checks for a fiscal year.
 * @param {number} year - Fiscal year to audit
 * @returns {Object} { score, totalChecks, passed, warnings, failures, checks[] }
 */
async function runAutoAudit(year) {
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const checks = [];

  // ─── 1. Reconciliation Coverage ───
  const accounts = await dal.query('SELECT * FROM accounts WHERE active = true');
  const reconciliations = await dal.query('SELECT DISTINCT account_id FROM reconciliations WHERE period_end >= $1 AND period_start <= $2', [yearStart, yearEnd]);
  const reconciledAccountIds = new Set(reconciliations.map(r => r.account_id));
  const unreconciledAccounts = accounts.filter(a => !reconciledAccountIds.has(a.id));
  checks.push({
    id: 'reconciliation_coverage',
    title: 'Account Reconciliation',
    description: 'All active accounts should be reconciled at least once during the fiscal year.',
    status: unreconciledAccounts.length === 0 ? 'pass' : 'fail',
    detail: unreconciledAccounts.length === 0
      ? `All ${accounts.length} accounts reconciled.`
      : `${unreconciledAccounts.length} account(s) not reconciled: ${unreconciledAccounts.map(a => a.name).join(', ')}.`,
    severity: 'high'
  });

  // ─── 2. Transactions Without Descriptions ───
  const noDescRow = await dal.queryOne(`
    SELECT COUNT(*) AS count FROM transactions
    WHERE status = 'posted' AND tx_type != 'transfer'
      AND (description IS NULL OR TRIM(description) = '')
      AND tx_date >= $1 AND tx_date <= $2
  `, [yearStart, yearEnd]);
  const noDescCount = Number(noDescRow.count);
  const totalTxRow = await dal.queryOne(`SELECT COUNT(*) AS count FROM transactions WHERE status = 'posted' AND tx_date >= $1 AND tx_date <= $2`, [yearStart, yearEnd]);
  const totalTx = Number(totalTxRow.count);
  const descPct = totalTx > 0 ? Math.round((1 - noDescCount / totalTx) * 100) : 100;
  checks.push({
    id: 'description_completeness',
    title: 'Transaction Descriptions',
    description: 'All transactions should have a description or reference for traceability.',
    status: noDescCount === 0 ? 'pass' : descPct >= 90 ? 'warning' : 'fail',
    detail: noDescCount === 0
      ? `All ${totalTx} transactions have descriptions.`
      : `${noDescCount} of ${totalTx} transactions (${100 - descPct}%) lack a description.`,
    severity: 'medium'
  });

  // ─── 3. Reversed Transactions ───
  const reversedRow = await dal.queryOne(`
    SELECT COUNT(*) AS count FROM transactions
    WHERE status = 'reversed' AND tx_date >= $1 AND tx_date <= $2
  `, [yearStart, yearEnd]);
  const reversedCount = Number(reversedRow.count);
  checks.push({
    id: 'reversals',
    title: 'Transaction Reversals',
    description: 'A high number of reversals may indicate control weaknesses or data entry issues.',
    status: reversedCount === 0 ? 'pass' : reversedCount <= 5 ? 'warning' : 'fail',
    detail: reversedCount === 0
      ? 'No reversals recorded — clean transaction history.'
      : `${reversedCount} transaction(s) reversed during the year.`,
    severity: 'medium'
  });

  // ─── 4. Welfare Fund Integrity ───
  const welfareCollectedRow = await dal.queryOne(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' AND tx_date >= $1 AND tx_date <= $2
  `, [yearStart, yearEnd]);
  const welfarePaidRow = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
    WHERE tx_type = 'welfare_payout' AND status = 'posted' AND tx_date >= $1 AND tx_date <= $2
  `, [yearStart, yearEnd]);
  const welfareCollected = Number(welfareCollectedRow.total);
  const welfarePaid = Number(welfarePaidRow.total);
  const welfareBalance = welfareCollected - welfarePaid;
  checks.push({
    id: 'welfare_integrity',
    title: 'Welfare Fund Balance',
    description: 'Welfare payouts should not exceed welfare collections.',
    status: welfareBalance >= 0 ? 'pass' : 'fail',
    detail: `Collected: GHS ${welfareCollected.toFixed(2)}, Paid out: GHS ${welfarePaid.toFixed(2)}, Balance: GHS ${welfareBalance.toFixed(2)}.`,
    severity: 'high'
  });

  // ─── 5. Budget Adherence ───
  const budgetRow = await dal.queryOne('SELECT * FROM annual_budgets WHERE year = $1', [year]);
  if (budgetRow) {
    const budgetLines = await dal.query('SELECT * FROM annual_budget_lines WHERE year = $1 AND kind = $2', [year, 'expense']);
    const actualExpenses = await dal.query(`
      SELECT category, COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE tx_type IN ('expense','welfare_payout') AND status = 'posted'
        AND tx_date >= $1 AND tx_date <= $2
      GROUP BY category
    `, [yearStart, yearEnd]);
    const actualMap = Object.fromEntries(actualExpenses.map(r => [r.category, Number(r.total)]));
    const overBudget = budgetLines.filter(b => (actualMap[b.category] || 0) > Number(b.amount) * 1.1); // >10% over
    checks.push({
      id: 'budget_adherence',
      title: 'Budget Compliance',
      description: 'Expense categories should not exceed their approved budget by more than 10%.',
      status: overBudget.length === 0 ? 'pass' : overBudget.length <= 2 ? 'warning' : 'fail',
      detail: overBudget.length === 0
        ? 'All expense categories within approved budget.'
        : `${overBudget.length} category(ies) overspent: ${overBudget.map(b => b.category).join(', ')}.`,
      severity: 'high'
    });
  } else {
    checks.push({
      id: 'budget_adherence',
      title: 'Budget Compliance',
      description: 'An approved budget should exist for the fiscal year.',
      status: 'warning',
      detail: 'No budget found for this fiscal year. Cannot verify spending limits.',
      severity: 'high'
    });
  }

  // ─── 6. Negative Account Balances ───
  const accountBalances = [];
  for (const account of accounts) {
    const incRow = await dal.queryOne(`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE tx_type = 'receipt' AND account_id = $1 AND status = 'posted' AND tx_date <= $2`, [account.id, yearEnd]);
    const outRow = await dal.queryOne(`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE tx_type IN ('expense','welfare_payout') AND account_id = $1 AND status = 'posted' AND tx_date <= $2`, [account.id, yearEnd]);
    const balance = Number(account.opening_balance) + Number(incRow.total) - Number(outRow.total);
    if (balance < 0) accountBalances.push({ name: account.name, balance });
  }
  checks.push({
    id: 'negative_balances',
    title: 'Negative Account Balances',
    description: 'No account should have a negative balance (more paid out than received).',
    status: accountBalances.length === 0 ? 'pass' : 'fail',
    detail: accountBalances.length === 0
      ? 'All accounts have positive balances.'
      : `${accountBalances.length} account(s) negative: ${accountBalances.map(a => `${a.name} (GHS ${a.balance.toFixed(2)})`).join(', ')}.`,
    severity: 'high'
  });

  // ─── 7. Assessment Collection Rate ───
  const activeMembers = await dal.queryOne(`SELECT COUNT(*) AS count FROM members WHERE status = 'active'`);
  const membersWithPayments = await dal.queryOne(`
    SELECT COUNT(DISTINCT member_id) AS count FROM transactions t
    JOIN transaction_categories c ON c.name = t.category
    WHERE t.tx_type = 'receipt' AND c.purpose = 'assessment' AND t.status = 'posted'
      AND t.tx_date >= $1 AND t.tx_date <= $2
  `, [yearStart, yearEnd]);
  const totalActive = Number(activeMembers.count);
  const paidMembers = Number(membersWithPayments.count);
  const collectionRate = totalActive > 0 ? Math.round((paidMembers / totalActive) * 100) : 0;
  checks.push({
    id: 'collection_rate',
    title: 'Assessment Collection Rate',
    description: 'Percentage of active members who made at least one assessment payment.',
    status: collectionRate >= 80 ? 'pass' : collectionRate >= 60 ? 'warning' : 'fail',
    detail: `${paidMembers} of ${totalActive} active members paid (${collectionRate}% collection rate).`,
    severity: 'medium'
  });

  // ─── 8. Monthly Activity Gaps ───
  const monthsActive = await dal.query(`
    SELECT DISTINCT EXTRACT(MONTH FROM tx_date::date) AS m FROM transactions
    WHERE status = 'posted' AND tx_date >= $1 AND tx_date <= $2
    ORDER BY m
  `, [yearStart, yearEnd]);
  const activeMonths = monthsActive.map(r => Number(r.m));
  const currentMonth = new Date().getFullYear() === year ? new Date().getMonth() + 1 : 12;
  const expectedMonths = Array.from({ length: currentMonth }, (_, i) => i + 1);
  const missingMonths = expectedMonths.filter(m => !activeMonths.includes(m));
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  checks.push({
    id: 'monthly_activity',
    title: 'Monthly Recording Continuity',
    description: 'Transactions should be recorded every month without gaps.',
    status: missingMonths.length === 0 ? 'pass' : missingMonths.length <= 1 ? 'warning' : 'fail',
    detail: missingMonths.length === 0
      ? `Transactions recorded in all ${currentMonth} month(s).`
      : `No transactions in: ${missingMonths.map(m => monthNames[m - 1]).join(', ')}.`,
    severity: 'low'
  });

  // ─── 9. Transactions Outside Fiscal Year ───
  const outsideRow = await dal.queryOne(`
    SELECT COUNT(*) AS count FROM transactions
    WHERE status = 'posted' AND (tx_date < $1 OR tx_date > $2)
      AND created_at >= $3::timestamp AND created_at <= $4::timestamp
  `, [yearStart, yearEnd, `${yearStart} 00:00:00`, `${yearEnd} 23:59:59`]);
  const outsideCount = Number(outsideRow.count);
  checks.push({
    id: 'date_integrity',
    title: 'Transaction Date Integrity',
    description: 'Transactions recorded during this year should have dates within the fiscal year.',
    status: outsideCount === 0 ? 'pass' : 'warning',
    detail: outsideCount === 0
      ? 'All transactions dated within the fiscal year.'
      : `${outsideCount} transaction(s) have dates outside the ${year} fiscal year but were recorded during it.`,
    severity: 'low'
  });

  // ─── 10. Duplicate Transactions ───
  const duplicates = await dal.query(`
    SELECT tx_date, member_id, amount, category, COUNT(*) AS count
    FROM transactions
    WHERE status = 'posted' AND tx_date >= $1 AND tx_date <= $2
    GROUP BY tx_date, member_id, amount, category
    HAVING COUNT(*) > 1
  `, [yearStart, yearEnd]);
  checks.push({
    id: 'duplicates',
    title: 'Potential Duplicate Transactions',
    description: 'Same date, member, amount, and category may indicate a double-entry.',
    status: duplicates.length === 0 ? 'pass' : 'warning',
    detail: duplicates.length === 0
      ? 'No potential duplicates found.'
      : `${duplicates.length} group(s) of potentially duplicate transactions detected.`,
    severity: 'medium'
  });

  // ─── Score Summary ───
  const passed = checks.filter(c => c.status === 'pass').length;
  const warnings = checks.filter(c => c.status === 'warning').length;
  const failures = checks.filter(c => c.status === 'fail').length;
  const totalChecks = checks.length;
  const score = Math.round((passed / totalChecks) * 100);

  return { year, score, totalChecks, passed, warnings, failures, checks };
}

module.exports = { runAutoAudit };
