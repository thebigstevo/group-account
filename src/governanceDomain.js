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
  if (status === 'exception') {
    if (notes.length < 10) errors.push('Exception notes must be at least 10 characters.');
    if (notes.length > 2000) errors.push('Exception notes must not exceed 2000 characters.');
  } else if (notes.length > 2000) {
    errors.push('Notes must not exceed 2000 characters.');
  }
  return { errors, values: { status, notes } };
}

function validateAuditFlag(input) {
  const errors = [];
  const transaction_id = input.transaction_id;
  const reason = String(input.reason || '').trim();
  if (!transaction_id) errors.push('A transaction is required.');
  if (!reason) errors.push('Provide a reason for flagging this transaction.');
  if (reason.length > 1000) errors.push('Flag reason must not exceed 1000 characters.');
  return { errors, values: { transaction_id, reason } };
}

function validateTransactionNote(input) {
  const errors = [];
  const note = String(input.note || '').trim();
  if (!note) errors.push('A note is required.');
  if (note.length > 1000) errors.push('Note must not exceed 1000 characters.');
  return { errors, values: { note } };
}

function validateAuditCompletion(checklistItems, totalRequired) {
  const completed = ['pass', 'exception', 'not_applicable'];
  const unreviewed = [];
  for (const item of checklistItems) {
    if (!completed.includes(item.status)) {
      unreviewed.push(item.key);
    }
  }
  return unreviewed;
}

function validateAuditConclusion(input) {
  const errors = [];
  const conclusion = String(input.conclusion || '').trim();
  if (!conclusion) errors.push('An overall conclusion is required.');
  if (conclusion.length > 5000) errors.push('Conclusion must not exceed 5000 characters.');
  return { errors, values: { conclusion } };
}

module.exports = {
  AUDIT_CHECKLIST,
  AUDIT_ITEM_STATUSES,
  BUDGET_KINDS,
  validateAuditCompletion,
  validateAuditConclusion,
  validateAuditFlag,
  validateAuditItem,
  validateBudgetLine,
  validateTransactionNote
};
