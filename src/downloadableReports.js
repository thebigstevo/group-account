const { stringify } = require('csv-stringify/sync');
const dal = require('./dal');

function fmt(value) {
  return Number(value || 0).toFixed(2);
}

function csvFromRows(rows) {
  return stringify(rows);
}

/**
 * Income & Expenditure Statement
 * Standard accounting report showing income categories, expense categories,
 * and net surplus/deficit for a period.
 */
async function incomeAndExpenditureReport(startDate, endDate, periodLabel) {
  // Income (assessment income, net of welfare)
  const income = await dal.query(`
    SELECT category, COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'
      AND tx_date >= $1 AND tx_date <= $2
    GROUP BY category
    ORDER BY total DESC
  `, [startDate, endDate]);

  // Expenses
  const expenses = await dal.query(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type IN ('expense', 'welfare_payout') AND status = 'posted'
      AND tx_date >= $1 AND tx_date <= $2
    GROUP BY category
    ORDER BY total DESC
  `, [startDate, endDate]);

  const totalIncome = income.reduce((s, r) => s + Number(r.total), 0);
  const totalExpenses = expenses.reduce((s, r) => s + Number(r.total), 0);
  const surplus = totalIncome - totalExpenses;

  const rows = [
    ['KSJI INCOME AND EXPENDITURE STATEMENT'],
    [`Period: ${periodLabel}`],
    [`Generated: ${new Date().toISOString().slice(0, 10)}`],
    [],
    ['INCOME', '', 'Amount (GHS)'],
  ];

  income.forEach(r => rows.push(['', r.category, fmt(r.total)]));
  rows.push(['', 'TOTAL INCOME', fmt(totalIncome)]);
  rows.push([]);
  rows.push(['EXPENDITURE', '', 'Amount (GHS)']);
  expenses.forEach(r => rows.push(['', r.category, fmt(r.total)]));
  rows.push(['', 'TOTAL EXPENDITURE', fmt(totalExpenses)]);
  rows.push([]);
  rows.push([surplus >= 0 ? 'SURPLUS' : 'DEFICIT', '', fmt(Math.abs(surplus))]);

  return csvFromRows(rows);
}

/**
 * Receipts & Payments Statement
 * Shows all cash movements grouped by account — what came in, what went out.
 */
async function receiptsAndPaymentsReport(startDate, endDate, periodLabel) {
  const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');

  const rows = [
    ['KSJI RECEIPTS AND PAYMENTS STATEMENT'],
    [`Period: ${periodLabel}`],
    [`Generated: ${new Date().toISOString().slice(0, 10)}`],
    [],
  ];

  let grandOpeningTotal = 0;
  let grandReceiptsTotal = 0;
  let grandPaymentsTotal = 0;
  let grandClosingTotal = 0;

  for (const account of accounts) {
    // Opening balance as of start date (opening_balance + transactions before start)
    const priorIncomingRow = await dal.queryOne(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type = 'receipt' AND account_id = $1) OR (tx_type = 'transfer' AND to_account_id = $2))
        AND status = 'posted' AND tx_date < $3
    `, [account.id, account.id, startDate]);

    const priorOutgoingRow = await dal.queryOne(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type IN ('expense','welfare_payout') AND account_id = $1) OR (tx_type = 'transfer' AND account_id = $2))
        AND status = 'posted' AND tx_date < $3
    `, [account.id, account.id, startDate]);

    const openingBalance = Number(account.opening_balance) + Number(priorIncomingRow.total) - Number(priorOutgoingRow.total);

    // Receipts in period
    const receipts = await dal.query(`
      SELECT category, COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type = 'receipt' AND account_id = $1) OR (tx_type = 'transfer' AND to_account_id = $2))
        AND status = 'posted' AND tx_date >= $3 AND tx_date <= $4
      GROUP BY category ORDER BY total DESC
    `, [account.id, account.id, startDate, endDate]);

    // Payments in period
    const payments = await dal.query(`
      SELECT category, COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type IN ('expense','welfare_payout') AND account_id = $1) OR (tx_type = 'transfer' AND account_id = $2))
        AND status = 'posted' AND tx_date >= $3 AND tx_date <= $4
      GROUP BY category ORDER BY total DESC
    `, [account.id, account.id, startDate, endDate]);

    const totalReceipts = receipts.reduce((s, r) => s + Number(r.total), 0);
    const totalPayments = payments.reduce((s, r) => s + Number(r.total), 0);
    const closingBalance = openingBalance + totalReceipts - totalPayments;

    grandOpeningTotal += openingBalance;
    grandReceiptsTotal += totalReceipts;
    grandPaymentsTotal += totalPayments;
    grandClosingTotal += closingBalance;

    rows.push([`ACCOUNT: ${account.name} (${account.type})`]);
    rows.push(['Opening Balance', '', fmt(openingBalance)]);
    rows.push([]);
    rows.push(['Receipts', 'Category', 'Amount (GHS)']);
    receipts.forEach(r => rows.push(['', r.category, fmt(r.total)]));
    rows.push(['', 'Total Receipts', fmt(totalReceipts)]);
    rows.push([]);
    rows.push(['Payments', 'Category', 'Amount (GHS)']);
    payments.forEach(r => rows.push(['', r.category, fmt(r.total)]));
    rows.push(['', 'Total Payments', fmt(totalPayments)]);
    rows.push([]);
    rows.push(['Closing Balance', '', fmt(closingBalance)]);
    rows.push([]);
    rows.push(['---', '---', '---']);
    rows.push([]);
  }

  rows.push(['GRAND TOTALS']);
  rows.push(['Total Opening Balances', '', fmt(grandOpeningTotal)]);
  rows.push(['Total Receipts', '', fmt(grandReceiptsTotal)]);
  rows.push(['Total Payments', '', fmt(grandPaymentsTotal)]);
  rows.push(['Total Closing Balances', '', fmt(grandClosingTotal)]);

  return csvFromRows(rows);
}

/**
 * Welfare Fund Statement
 * Shows welfare collections, payouts, and liability balance.
 */
async function welfareFundReport(startDate, endDate, periodLabel) {
  // Opening welfare liability (all welfare collected before period minus payouts before period)
  const priorCollectedRow = await dal.queryOne(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' AND tx_date < $1
  `, [startDate]);

  const priorPaidOutRow = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
    WHERE tx_type = 'welfare_payout' AND status = 'posted' AND tx_date < $1
  `, [startDate]);

  const openingLiability = Number(priorCollectedRow.total) - Number(priorPaidOutRow.total);

  // Period welfare collections by member
  const collections = await dal.query(`
    SELECT m.name AS member, COALESCE(SUM(t.welfare_component), 0) AS total
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    WHERE t.tx_type = 'receipt' AND t.status = 'posted'
      AND t.tx_date >= $1 AND t.tx_date <= $2
      AND t.welfare_component > 0
    GROUP BY t.member_id, m.name
    ORDER BY m.name
  `, [startDate, endDate]);

  // Period welfare payouts
  const payouts = await dal.query(`
    SELECT t.tx_date, t.description, t.amount
    FROM transactions t
    WHERE t.tx_type = 'welfare_payout' AND t.status = 'posted'
      AND t.tx_date >= $1 AND t.tx_date <= $2
    ORDER BY t.tx_date
  `, [startDate, endDate]);

  const totalCollected = collections.reduce((s, r) => s + Number(r.total), 0);
  const totalPaidOut = payouts.reduce((s, r) => s + Number(r.amount), 0);
  const closingLiability = openingLiability + totalCollected - totalPaidOut;

  const rows = [
    ['KSJI WELFARE FUND STATEMENT'],
    [`Period: ${periodLabel}`],
    [`Generated: ${new Date().toISOString().slice(0, 10)}`],
    [],
    ['Opening Welfare Liability', '', fmt(openingLiability)],
    [],
    ['WELFARE COLLECTIONS', 'Member', 'Amount (GHS)'],
  ];

  collections.forEach(r => rows.push(['', r.member || 'Unknown', fmt(r.total)]));
  rows.push(['', 'Total Collections', fmt(totalCollected)]);
  rows.push([]);
  rows.push(['WELFARE PAYOUTS', 'Date', 'Description', 'Amount (GHS)']);
  payouts.forEach(r => rows.push(['', r.tx_date, r.description || '', fmt(r.amount)]));
  rows.push(['', '', 'Total Payouts', fmt(totalPaidOut)]);
  rows.push([]);
  rows.push(['Closing Welfare Liability', '', fmt(closingLiability)]);

  return csvFromRows(rows);
}

/**
 * Statement of Financial Position (Balance Sheet-like)
 * Shows assets (account balances) and liabilities (welfare fund).
 */
async function financialPositionReport(asOfDate, periodLabel) {
  const accounts = await dal.query('SELECT * FROM accounts WHERE active = true ORDER BY id');

  const balances = [];
  for (const account of accounts) {
    const incomingRow = await dal.queryOne(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type = 'receipt' AND account_id = $1) OR (tx_type = 'transfer' AND to_account_id = $2))
        AND status = 'posted' AND tx_date <= $3
    `, [account.id, account.id, asOfDate]);

    const outgoingRow = await dal.queryOne(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type IN ('expense','welfare_payout') AND account_id = $1) OR (tx_type = 'transfer' AND account_id = $2))
        AND status = 'posted' AND tx_date <= $3
    `, [account.id, account.id, asOfDate]);

    balances.push({
      name: account.name,
      type: account.type,
      balance: Number(account.opening_balance) + Number(incomingRow.total) - Number(outgoingRow.total)
    });
  }

  const totalAssets = balances.reduce((s, b) => s + b.balance, 0);

  // Welfare liability
  const welfareCollectedRow = await dal.queryOne(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' AND tx_date <= $1
  `, [asOfDate]);

  const welfarePaidRow = await dal.queryOne(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
    WHERE tx_type = 'welfare_payout' AND status = 'posted' AND tx_date <= $1
  `, [asOfDate]);

  const welfareLiability = Number(welfareCollectedRow.total) - Number(welfarePaidRow.total);
  const netAssets = totalAssets - welfareLiability;

  const rows = [
    ['KSJI STATEMENT OF FINANCIAL POSITION'],
    [`As at: ${asOfDate}`],
    [`Generated: ${new Date().toISOString().slice(0, 10)}`],
    [],
    ['ASSETS', '', 'Amount (GHS)'],
  ];

  balances.forEach(b => rows.push(['', `${b.name} (${b.type})`, fmt(b.balance)]));
  rows.push(['', 'TOTAL ASSETS', fmt(totalAssets)]);
  rows.push([]);
  rows.push(['LIABILITIES', '', 'Amount (GHS)']);
  rows.push(['', 'Welfare Fund Payable', fmt(welfareLiability)]);
  rows.push(['', 'TOTAL LIABILITIES', fmt(welfareLiability)]);
  rows.push([]);
  rows.push(['NET ASSETS (Spendable Balance)', '', fmt(netAssets)]);

  return csvFromRows(rows);
}

/**
 * Member Statement — individual member's transactions for a year
 */
async function memberStatementReport(memberId, year) {
  const member = await dal.queryOne('SELECT * FROM members WHERE id = $1', [memberId]);
  if (!member) return '';

  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const transactions = await dal.query(`
    SELECT t.tx_date, t.tx_type, t.category, t.amount, t.welfare_component, t.description, a.name AS account_name
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.member_id = $1 AND t.status = 'posted'
      AND t.tx_date >= $2 AND t.tx_date <= $3
    ORDER BY t.tx_date ASC, t.id ASC
  `, [memberId, startDate, endDate]);

  // Assessment dues for the year
  const duesRules = await dal.query('SELECT * FROM dues_rules WHERE year = $1 AND active = true ORDER BY min_age DESC', [year]);
  const override = await dal.queryOne('SELECT * FROM member_dues WHERE member_id = $1 AND year = $2', [memberId, year]);

  let assessmentDue = 0;
  let welfarePortion = 0;
  if (override) {
    assessmentDue = override.assessment_due;
    welfarePortion = override.welfare_portion;
  } else {
    const age = member.dob ? year - new Date(member.dob).getFullYear() : null;
    const rule = duesRules.find(r => {
      const minOk = r.min_age == null || age == null || age >= r.min_age;
      const maxOk = r.max_age == null || age == null || age <= r.max_age;
      return minOk && maxOk;
    });
    if (rule) {
      assessmentDue = rule.annual_assessment;
      welfarePortion = rule.welfare_portion;
    }
  }

  const totalPaid = transactions
    .filter(t => t.tx_type === 'receipt' && t.category === 'Assessment')
    .reduce((s, t) => s + Number(t.amount), 0);
  const balance = Number(member.opening_arrears) + Number(assessmentDue) - totalPaid;

  const rows = [
    ['KSJI MEMBER STATEMENT'],
    [`Member: ${member.name}`],
    [`Phone: ${member.phone || 'N/A'}`],
    [`Year: ${year}`],
    [`Generated: ${new Date().toISOString().slice(0, 10)}`],
    [],
    ['SUMMARY', '', 'Amount (GHS)'],
    ['', 'Opening Arrears', fmt(member.opening_arrears)],
    ['', 'Annual Assessment Due', fmt(assessmentDue)],
    ['', 'Welfare Portion (of assessment)', fmt(welfarePortion)],
    ['', 'Total Paid', fmt(totalPaid)],
    ['', 'Outstanding Balance', fmt(balance)],
    [],
    ['TRANSACTIONS'],
    ['Date', 'Type', 'Category', 'Account', 'Amount (GHS)', 'Welfare', 'Description'],
  ];

  transactions.forEach(t => {
    rows.push([
      t.tx_date,
      t.tx_type,
      t.category,
      t.account_name || '',
      fmt(t.amount),
      fmt(t.welfare_component),
      t.description || ''
    ]);
  });

  if (transactions.length === 0) {
    rows.push(['No transactions recorded for this period.']);
  }

  return csvFromRows(rows);
}

module.exports = {
  incomeAndExpenditureReport,
  receiptsAndPaymentsReport,
  welfareFundReport,
  financialPositionReport,
  memberStatementReport
};
