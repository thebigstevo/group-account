'use strict';

const BUDGET_KINDS = Object.freeze(['income', 'expense']);
const AUDIT_ITEM_STATUSES = Object.freeze(['pending', 'pass', 'exception', 'not_applicable']);
const AUDIT_CHECKLIST = Object.freeze([
  { key: 'income_completeness', label: 'Income completeness', help: 'Trace receipts to references, accounts, and the income register.' },
  { key: 'expense_support', label: 'Expense support', help: 'Check vouchers, descriptions, approvals, and payee evidence.' },
  { key: 'account_reconciliation', label: 'Account reconciliation', help: 'Review bank, cash, and mobile-money reconciliations and differences.' },
  { key: 'budget_variance', label: 'Budget variance', help: 'Review material differences between the approved budget and actuals.' },
  { key: 'audit_trail', label: 'Audit trail and reversals', help: 'Review changes, reversals, exports, and user activity for unusual items.' },
  { key: 'closing_balances', label: 'Closing balances', help: 'Confirm year-end balances and outstanding welfare liabilities.' }
]);

function validateBudgetLine(input) {
  const errors = [];
  const year = Number(input.year);
  const category = String(input.category || '').trim();
  const kind = String(input.kind || '');
  const amount = Number(input.amount);
  const notes = String(input.notes || '').trim();
  if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push('Select a valid fiscal year.');
  if (!category) errors.push('Select a budget category.');
  if (!BUDGET_KINDS.includes(kind)) errors.push('Select income or expense for the budget line.');
  if (!Number.isFinite(amount) || amount < 0) errors.push('Budget amount must be zero or greater.');
  return { errors, values: { year, category, kind, amount, notes } };
}

function validateAuditItem(input) {
  const status = String(input.status || '');
  const notes = String(input.notes || '').trim();
  const errors = [];
  if (!AUDIT_ITEM_STATUSES.includes(status) || status === 'pending') errors.push('Select a completed review outcome.');
  if (status === 'exception' && !notes) errors.push('Explain the exception and the action required.');
  return { errors, values: { status, notes } };
}

module.exports = {
  AUDIT_CHECKLIST,
  AUDIT_ITEM_STATUSES,
  BUDGET_KINDS,
  validateAuditItem,
  validateBudgetLine
};
