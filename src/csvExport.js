const { stringify } = require('csv-stringify/sync');
const dal = require('./dal');
const { arrearsReport, budgetVsActual } = require('./services');

/**
 * Convert array of objects to CSV string
 * @param {Array} rows - Array of objects
 * @param {Array} columns - Column names (optional; defaults to object keys)
 * @returns {string} CSV text
 */
function arrayToCsv(rows, columns = null) {
  if (!rows || rows.length === 0) {
    return '';
  }

  const cols = columns || Object.keys(rows[0]);
  const data = rows.map(row => cols.map(col => row[col] !== undefined && row[col] !== null ? row[col] : ''));

  return stringify([cols, ...data]);
}

/**
 * Format for CSV export: rounds to 2 decimals
 */
function formatCurrency(value) {
  return Number(value || 0).toFixed(2);
}

/**
 * Export transactions as CSV
 */
async function exportTransactionsCsv(filters = {}) {
  const { startDate, endDate, status = 'posted', includeReversed = false } = filters;

  let query = `
    SELECT 
      t.id,
      t.tx_date,
      t.tx_type,
      t.category,
      m.name AS member,
      a.name AS account,
      ta.name AS to_account,
      t.amount,
      t.welfare_component,
      t.reference,
      t.description,
      t.reconciled,
      t.status,
      t.created_at,
      u.name AS recorded_by
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE 1=1
  `;

  const params = [];
  let idx = 1;

  if (startDate) {
    query += ` AND t.tx_date >= $${idx}`;
    params.push(startDate);
    idx++;
  }
  if (endDate) {
    query += ` AND t.tx_date <= $${idx}`;
    params.push(endDate);
    idx++;
  }

  if (!includeReversed) {
    query += ` AND t.status = 'posted' AND t.reverses_transaction_id IS NULL`;
  }

  query += ` ORDER BY t.tx_date DESC, t.id DESC`;

  const rows = await dal.query(query, params);

  const formatted = rows.map(row => ({
    Date: row.tx_date,
    Type: row.tx_type,
    Category: row.category,
    Member: row.member || '',
    Account: row.account || '',
    'To Account': row.to_account || '',
    Amount: formatCurrency(row.amount),
    'Welfare Component': formatCurrency(row.welfare_component),
    Reference: row.reference || '',
    Cleared: row.reconciled ? 'Yes' : 'No',
    Status: row.status,
    Description: row.description || '',
    'Recorded By': row.recorded_by || '',
    'Recorded At': row.created_at || ''
  }));

  return arrayToCsv(formatted);
}

/**
 * Export the original transfer register for comparison with cashbooks,
 * deposit slips, and bank statements. Reversal audit rows are omitted, while
 * reversed original transfers remain visible and are excluded from the total.
 */
async function transferRegisterReport({ startDate, endDate }) {
  const rows = await dal.query(`
    SELECT
      t.id,
      t.tx_date,
      source.name AS from_account,
      destination.name AS to_account,
      t.amount,
      t.reference,
      t.description,
      t.status,
      t.reconciled,
      t.reversal_reason,
      u.name AS recorded_by,
      t.created_at
    FROM transactions t
    JOIN accounts source ON source.id = t.account_id
    JOIN accounts destination ON destination.id = t.to_account_id
    LEFT JOIN users u ON u.id = t.created_by
    WHERE t.tx_type = 'transfer'
      AND t.reverses_transaction_id IS NULL
      AND t.tx_date >= $1
      AND t.tx_date <= $2
    ORDER BY t.tx_date, t.id
  `, [startDate, endDate]);

  const postedTotal = rows
    .filter((row) => row.status === 'posted')
    .reduce((sum, row) => sum + Number(row.amount), 0);

  return { rows, postedTotal };
}

async function exportTransfersCsv({ startDate, endDate }) {
  const { rows, postedTotal } = await transferRegisterReport({ startDate, endDate });

  const formatted = rows.map((row) => ({
    'Transaction ID': row.id,
    Date: row.tx_date,
    'From Account': row.from_account,
    'To Account': row.to_account,
    Amount: formatCurrency(row.amount),
    Reference: row.reference || '',
    Description: row.description || '',
    Status: row.status,
    'Included in Account Balances': row.status === 'posted' ? 'Yes' : 'No',
    Cleared: row.reconciled ? 'Yes' : 'No',
    'Reversal Reason': row.reversal_reason || '',
    'Recorded By': row.recorded_by || '',
    'Recorded At': row.created_at || ''
  }));

  formatted.push({
    'Transaction ID': '',
    Date: 'TOTAL POSTED TRANSFERS',
    'From Account': '',
    'To Account': '',
    Amount: formatCurrency(postedTotal),
    Reference: '',
    Description: `${startDate} to ${endDate}`,
    Status: '',
    'Included in Account Balances': '',
    Cleared: '',
    'Reversal Reason': '',
    'Recorded By': '',
    'Recorded At': ''
  });

  return arrayToCsv(formatted);
}

/**
 * Export arrears report as CSV
 */
async function exportArrearsCsv(year) {
  const rows = await dal.query(`
    SELECT 
      m.name,
      m.phone,
      m.opening_arrears,
      COALESCE(md.assessment_due, dr.annual_assessment, 0) as assessment_due,
      COALESCE(md.welfare_portion, dr.welfare_portion, 0) as welfare_portion,
      COALESCE((
        SELECT SUM(amount)
        FROM transactions t
        JOIN transaction_categories c ON c.name = t.category
        WHERE t.tx_type = 'receipt'
          AND t.member_id = m.id
          AND c.purpose = 'assessment'
          AND SUBSTRING(t.tx_date FROM 1 FOR 4) = $1
          AND t.status = 'posted'
          AND t.reverses_transaction_id IS NULL
      ), 0) as paid,
      m.opening_arrears + COALESCE(md.assessment_due, dr.annual_assessment, 0) - COALESCE((
        SELECT SUM(amount)
        FROM transactions t
        JOIN transaction_categories c ON c.name = t.category
        WHERE t.tx_type = 'receipt'
          AND t.member_id = m.id
          AND c.purpose = 'assessment'
          AND SUBSTRING(t.tx_date FROM 1 FOR 4) = $2
          AND t.status = 'posted'
          AND t.reverses_transaction_id IS NULL
      ), 0) as balance
    FROM members m
    LEFT JOIN member_dues md ON md.member_id = m.id AND md.year = $3
    LEFT JOIN dues_rules dr ON dr.year = $4 AND dr.active = true AND (
      (dr.min_age IS NULL OR EXTRACT(YEAR FROM AGE(CURRENT_DATE, m.dob::date)) >= dr.min_age) AND
      (dr.max_age IS NULL OR EXTRACT(YEAR FROM AGE(CURRENT_DATE, m.dob::date)) <= dr.max_age)
    )
    WHERE m.status = 'active'
    ORDER BY m.name
  `, [String(year), String(year), year, year]);

  const formatted = rows.map(row => ({
    Name: row.name,
    Phone: row.phone,
    'Opening Arrears': formatCurrency(row.opening_arrears),
    'Assessment Due': formatCurrency(row.assessment_due),
    'Welfare Portion': formatCurrency(row.welfare_portion),
    Paid: formatCurrency(row.paid),
    Balance: formatCurrency(row.balance)
  }));

  return arrayToCsv(formatted);
}

/**
 * Export a stable, re-importable membership cleanup register. Calculated
 * financial columns are deliberately ignored by the importer.
 */
async function exportMemberCleanupCsv(year) {
  const [members, balances] = await Promise.all([
    dal.query(`
      SELECT m.id, m.membership_number, m.name, m.phone, m.dob, m.status, m.opening_arrears,
        (SELECT COUNT(*)::int FROM transactions t WHERE t.member_id = m.id) AS transaction_count,
        CASE WHEN EXISTS (
          SELECT 1 FROM members d
          WHERE d.id <> m.id AND (
            LOWER(BTRIM(d.name)) = LOWER(BTRIM(m.name))
            OR (m.phone IS NOT NULL AND BTRIM(m.phone) <> '' AND d.phone = m.phone)
          )
        ) THEN 'REVIEW' ELSE '' END AS potential_duplicate
      FROM members m
      ORDER BY m.name, m.id
    `),
    arrearsReport(year)
  ]);
  const balanceByMember = new Map(balances.map(row => [row.member_id, row]));
  const formatted = members.map(member => {
    const balance = balanceByMember.get(member.id);
    return {
      'Membership Number': member.membership_number,
      Name: member.name,
      Phone: member.phone || '',
      DOB: member.dob || '',
      Status: member.status,
      'Opening Balance': formatCurrency(member.opening_arrears),
      'Reference Year': year,
      'Assessment Due (reference only)': balance ? formatCurrency(balance.assessment_due) : '',
      'Payments (reference only)': balance ? formatCurrency(balance.paid) : '',
      'Calculated Balance (reference only)': balance ? formatCurrency(balance.balance) : '',
      'Transaction Count (reference only)': member.transaction_count,
      'Potential Duplicate (reference only)': member.potential_duplicate
    };
  });

  return arrayToCsv(formatted);
}

/**
 * Export income/expense report as CSV
 */
async function exportReportCsv(startDate, endDate) {
  const incomeByCategory = await dal.query(`
    SELECT category, COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'
      AND reverses_transaction_id IS NULL
      AND tx_date >= $1
      AND tx_date <= $2
    GROUP BY category
    ORDER BY total DESC
  `, [startDate, endDate]);

  const expensesByCategory = await dal.query(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'expense' AND status = 'posted'
      AND reverses_transaction_id IS NULL
      AND tx_date >= $1
      AND tx_date <= $2
    GROUP BY category
    ORDER BY total DESC
  `, [startDate, endDate]);

  const totalIncome = incomeByCategory.reduce((sum, row) => sum + Number(row.total), 0);
  const totalExpenses = expensesByCategory.reduce((sum, row) => sum + Number(row.total), 0);

  const incomeFormatted = incomeByCategory.map(row => ({
    Type: 'Income',
    Category: row.category,
    Amount: formatCurrency(row.total)
  }));

  const expenseFormatted = expensesByCategory.map(row => ({
    Type: 'Expense',
    Category: row.category,
    Amount: formatCurrency(row.total)
  }));

  const summary = [
    { Type: 'SUMMARY', Category: '', Amount: '' },
    { Type: 'Total Income', Category: '', Amount: formatCurrency(totalIncome) },
    { Type: 'Total Expenses', Category: '', Amount: formatCurrency(totalExpenses) },
    { Type: 'Net', Category: '', Amount: formatCurrency(totalIncome - totalExpenses) }
  ];

  return arrayToCsv([...incomeFormatted, ...expenseFormatted, ...summary]);
}

/**
 * Export reconciliation records as CSV
 */
async function exportReconciliationsCsv() {
  const rows = await dal.query(`
    SELECT 
      a.name as account,
      r.period_start,
      r.period_end,
      r.statement_balance,
      r.system_balance,
      r.difference,
      r.notes,
      u.name as reconciled_by,
      r.created_at
    FROM reconciliations r
    JOIN accounts a ON a.id = r.account_id
    LEFT JOIN users u ON u.id = r.created_by
    ORDER BY r.period_end DESC
  `);

  const formatted = rows.map(row => ({
    Account: row.account,
    'Period Start': row.period_start,
    'Period End': row.period_end,
    'Statement Balance': formatCurrency(row.statement_balance),
    'System Balance': formatCurrency(row.system_balance),
    Difference: formatCurrency(row.difference),
    Notes: row.notes || '',
    'Reconciled By': row.reconciled_by || '',
    'Created At': row.created_at
  }));

  return arrayToCsv(formatted);
}

/**
 * Export audit log as CSV
 */
async function exportAuditLogCsv(limitDays = 90) {
  const rows = await dal.query(`
    SELECT 
      l.created_at,
      u.name as user,
      l.action,
      l.entity,
      l.entity_id,
      l.details,
      l.before_value,
      l.after_value,
      l.reason,
      l.ip_address,
      l.user_agent
    FROM audit_log l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.created_at >= NOW() - ($1 || ' days')::interval
    ORDER BY l.created_at DESC
  `, [limitDays]);

  const formatted = rows.map(row => ({
    'Date/Time': row.created_at,
    User: row.user || 'System',
    Action: row.action,
    Entity: row.entity,
    'Entity ID': row.entity_id || '',
    Details: row.details || '',
    'Before Value': row.before_value || '',
    'After Value': row.after_value || '',
    Reason: row.reason || '',
    'IP Address': row.ip_address || '',
    'User Agent': row.user_agent || ''
  }));

  return arrayToCsv(formatted);
}

async function exportBudgetActualCsv(year) {
  const report = await budgetVsActual(year);
  return arrayToCsv(report.lines.map((line) => ({
    Year: year,
    Direction: line.kind === 'income' ? 'Income' : 'Expense',
    Category: line.category,
    Budget: formatCurrency(line.budget),
    Actual: formatCurrency(line.actual),
    'Variance (Actual - Budget)': formatCurrency(line.variance),
    Notes: line.notes || ''
  })));
}

module.exports = {
  exportTransactionsCsv,
  transferRegisterReport,
  exportTransfersCsv,
  exportArrearsCsv,
  exportMemberCleanupCsv,
  exportReportCsv,
  exportReconciliationsCsv,
  exportAuditLogCsv,
  exportBudgetActualCsv,
  arrayToCsv,
  formatCurrency
};
