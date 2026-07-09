const { stringify } = require('csv-stringify/sync');

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
function incomeAndExpenditureReport(db, startDate, endDate, periodLabel) {
  // Income (assessment income, net of welfare)
  const income = db.prepare(`
    SELECT category, COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'
      AND tx_date >= ? AND tx_date <= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(startDate, endDate);

  // Expenses
  const expenses = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type IN ('expense', 'welfare_payout') AND status = 'posted'
      AND tx_date >= ? AND tx_date <= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(startDate, endDate);

  const totalIncome = income.reduce((s, r) => s + r.total, 0);
  const totalExpenses = expenses.reduce((s, r) => s + r.total, 0);
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
function receiptsAndPaymentsReport(db, startDate, endDate, periodLabel) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all();

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

  accounts.forEach(account => {
    // Opening balance as of start date (opening_balance + transactions before start)
    const priorIncoming = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type = 'receipt' AND account_id = ?) OR (tx_type = 'transfer' AND to_account_id = ?))
        AND status = 'posted' AND tx_date < ?
    `).get(account.id, account.id, startDate).total;

    const priorOutgoing = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type IN ('expense','welfare_payout') AND account_id = ?) OR (tx_type = 'transfer' AND account_id = ?))
        AND status = 'posted' AND tx_date < ?
    `).get(account.id, account.id, startDate).total;

    const openingBalance = Number(account.opening_balance) + priorIncoming - priorOutgoing;

    // Receipts in period
    const receipts = db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type = 'receipt' AND account_id = ?) OR (tx_type = 'transfer' AND to_account_id = ?))
        AND status = 'posted' AND tx_date >= ? AND tx_date <= ?
      GROUP BY category ORDER BY total DESC
    `).all(account.id, account.id, startDate, endDate);

    // Payments in period
    const payments = db.prepare(`
      SELECT category, COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type IN ('expense','welfare_payout') AND account_id = ?) OR (tx_type = 'transfer' AND account_id = ?))
        AND status = 'posted' AND tx_date >= ? AND tx_date <= ?
      GROUP BY category ORDER BY total DESC
    `).all(account.id, account.id, startDate, endDate);

    const totalReceipts = receipts.reduce((s, r) => s + r.total, 0);
    const totalPayments = payments.reduce((s, r) => s + r.total, 0);
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
  });

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
function welfareFundReport(db, startDate, endDate, periodLabel) {
  // Opening welfare liability (all welfare collected before period minus payouts before period)
  const priorCollected = db.prepare(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' AND tx_date < ?
  `).get(startDate).total;

  const priorPaidOut = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
    WHERE tx_type = 'welfare_payout' AND status = 'posted' AND tx_date < ?
  `).get(startDate).total;

  const openingLiability = priorCollected - priorPaidOut;

  // Period welfare collections by member
  const collections = db.prepare(`
    SELECT m.name AS member, COALESCE(SUM(t.welfare_component), 0) AS total
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    WHERE t.tx_type = 'receipt' AND t.status = 'posted'
      AND t.tx_date >= ? AND t.tx_date <= ?
      AND t.welfare_component > 0
    GROUP BY t.member_id
    ORDER BY m.name
  `).all(startDate, endDate);

  // Period welfare payouts
  const payouts = db.prepare(`
    SELECT t.tx_date, t.description, t.amount
    FROM transactions t
    WHERE t.tx_type = 'welfare_payout' AND t.status = 'posted'
      AND t.tx_date >= ? AND t.tx_date <= ?
    ORDER BY t.tx_date
  `).all(startDate, endDate);

  const totalCollected = collections.reduce((s, r) => s + r.total, 0);
  const totalPaidOut = payouts.reduce((s, r) => s + r.amount, 0);
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
function financialPositionReport(db, asOfDate, periodLabel) {
  const accounts = db.prepare('SELECT * FROM accounts WHERE active = 1 ORDER BY id').all();

  const balances = accounts.map(account => {
    const incoming = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type = 'receipt' AND account_id = ?) OR (tx_type = 'transfer' AND to_account_id = ?))
        AND status = 'posted' AND tx_date <= ?
    `).get(account.id, account.id, asOfDate).total;

    const outgoing = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
      WHERE ((tx_type IN ('expense','welfare_payout') AND account_id = ?) OR (tx_type = 'transfer' AND account_id = ?))
        AND status = 'posted' AND tx_date <= ?
    `).get(account.id, account.id, asOfDate).total;

    return {
      name: account.name,
      type: account.type,
      balance: Number(account.opening_balance) + incoming - outgoing
    };
  });

  const totalAssets = balances.reduce((s, b) => s + b.balance, 0);

  // Welfare liability
  const welfareCollected = db.prepare(`
    SELECT COALESCE(SUM(welfare_component), 0) AS total FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted' AND tx_date <= ?
  `).get(asOfDate).total;

  const welfarePaid = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
    WHERE tx_type = 'welfare_payout' AND status = 'posted' AND tx_date <= ?
  `).get(asOfDate).total;

  const welfareLiability = welfareCollected - welfarePaid;
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
function memberStatementReport(db, memberId, year) {
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
  if (!member) return '';

  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  const transactions = db.prepare(`
    SELECT t.tx_date, t.tx_type, t.category, t.amount, t.welfare_component, t.description, a.name AS account_name
    FROM transactions t
    LEFT JOIN accounts a ON a.id = t.account_id
    WHERE t.member_id = ? AND t.status = 'posted'
      AND t.tx_date >= ? AND t.tx_date <= ?
    ORDER BY t.tx_date ASC, t.id ASC
  `).all(memberId, startDate, endDate);

  // Assessment dues for the year
  const duesRules = db.prepare('SELECT * FROM dues_rules WHERE year = ? AND active = 1 ORDER BY min_age DESC').all(year);
  const override = db.prepare('SELECT * FROM member_dues WHERE member_id = ? AND year = ?').get(memberId, year);

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
    .reduce((s, t) => s + t.amount, 0);
  const balance = Number(member.opening_arrears) + assessmentDue - totalPaid;

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
