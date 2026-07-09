const { stringify } = require('csv-stringify/sync');

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
function exportTransactionsCsv(db, filters = {}) {
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
      t.description,
      t.reconciled,
      t.status
    FROM transactions t
    LEFT JOIN members m ON m.id = t.member_id
    LEFT JOIN accounts a ON a.id = t.account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id
    WHERE 1=1
  `;

  const params = [];

  if (startDate) {
    query += ` AND t.tx_date >= ?`;
    params.push(startDate);
  }
  if (endDate) {
    query += ` AND t.tx_date <= ?`;
    params.push(endDate);
  }

  if (!includeReversed) {
    query += ` AND t.status = 'posted'`;
  }

  query += ` ORDER BY t.tx_date DESC, t.id DESC`;

  const rows = db.prepare(query).all(...params);

  const formatted = rows.map(row => ({
    Date: row.tx_date,
    Type: row.tx_type,
    Category: row.category,
    Member: row.member || '',
    Account: row.account || '',
    'To Account': row.to_account || '',
    Amount: formatCurrency(row.amount),
    'Welfare Component': formatCurrency(row.welfare_component),
    Cleared: row.reconciled ? 'Yes' : 'No',
    Status: row.status,
    Description: row.description || ''
  }));

  return arrayToCsv(formatted);
}

/**
 * Export arrears report as CSV
 */
function exportArrearsCsv(db, year) {
  const rows = db.prepare(`
    SELECT 
      m.name,
      m.phone,
      m.opening_arrears,
      COALESCE(md.assessment_due, dr.annual_assessment, 0) as assessment_due,
      COALESCE(md.welfare_portion, dr.welfare_portion, 0) as welfare_portion,
      COALESCE((
        SELECT SUM(amount)
        FROM transactions
        WHERE tx_type = 'receipt'
          AND member_id = m.id
          AND category = 'Assessment'
          AND strftime('%Y', tx_date) = ?
          AND status = 'posted'
      ), 0) as paid,
      m.opening_arrears + COALESCE(md.assessment_due, dr.annual_assessment, 0) - COALESCE((
        SELECT SUM(amount)
        FROM transactions
        WHERE tx_type = 'receipt'
          AND member_id = m.id
          AND category = 'Assessment'
          AND strftime('%Y', tx_date) = ?
          AND status = 'posted'
      ), 0) as balance
    FROM members m
    LEFT JOIN member_dues md ON md.member_id = m.id AND md.year = ?
    LEFT JOIN dues_rules dr ON dr.year = ? AND (
      (dr.min_age IS NULL OR (julianday('now') - julianday(m.dob)) / 365.25 >= dr.min_age) AND
      (dr.max_age IS NULL OR (julianday('now') - julianday(m.dob)) / 365.25 <= dr.max_age)
    )
    WHERE m.status = 'active'
    ORDER BY m.name
  `).all(String(year), String(year), year, year);

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
 * Export income/expense report as CSV
 */
function exportReportCsv(db, startDate, endDate) {
  const incomeByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount - welfare_component), 0) AS total
    FROM transactions
    WHERE tx_type = 'receipt' AND status = 'posted'
      AND tx_date >= ?
      AND tx_date <= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(startDate, endDate);

  const expensesByCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE tx_type = 'expense' AND status = 'posted'
      AND tx_date >= ?
      AND tx_date <= ?
    GROUP BY category
    ORDER BY total DESC
  `).all(startDate, endDate);

  const totalIncome = incomeByCategory.reduce((sum, row) => sum + row.total, 0);
  const totalExpenses = expensesByCategory.reduce((sum, row) => sum + row.total, 0);

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
function exportReconciliationsCsv(db) {
  const rows = db.prepare(`
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
  `).all();

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
function exportAuditLogCsv(db, limitDays = 90) {
  const rows = db.prepare(`
    SELECT 
      l.created_at,
      u.name as user,
      l.action,
      l.entity,
      l.entity_id,
      l.details,
      l.ip_address
    FROM audit_log l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.created_at >= datetime('now', '-' || ? || ' days')
    ORDER BY l.created_at DESC
  `).all(limitDays);

  const formatted = rows.map(row => ({
    'Date/Time': row.created_at,
    User: row.user || 'System',
    Action: row.action,
    Entity: row.entity,
    'Entity ID': row.entity_id || '',
    Details: row.details || '',
    'IP Address': row.ip_address || ''
  }));

  return arrayToCsv(formatted);
}

module.exports = {
  exportTransactionsCsv,
  exportArrearsCsv,
  exportReportCsv,
  exportReconciliationsCsv,
  exportAuditLogCsv,
  arrayToCsv,
  formatCurrency
};
