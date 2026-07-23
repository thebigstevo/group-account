'use strict';

const { AUDIT_CHECKLIST, validateAuditItem, validateBudgetLine } = require('../governanceDomain');

describe('budget and trustee audit validation', () => {
  test('accepts a valid annual budget line and rejects invalid amounts or directions', () => {
    expect(validateBudgetLine({ year: 2026, category: 'Appeal', kind: 'income', amount: '2500.50', notes: 'Transport appeal' })).toEqual({
      errors: [], values: { year: 2026, category: 'Appeal', kind: 'income', amount: 2500.5, notes: 'Transport appeal' }
    });
    expect(validateBudgetLine({ year: 1999, category: '', kind: 'both', amount: '-1' }).errors).toEqual([
      'Select a valid fiscal year.', 'Select a budget category.', 'Select income or expense for the budget line.', 'Budget amount must be zero or greater.'
    ]);
  });

  test('requires notes for audit exceptions and defines the complete trustee checklist', () => {
    expect(AUDIT_CHECKLIST.map((item) => item.key)).toEqual([
      'income_completeness', 'expense_support', 'account_reconciliation',
      'budget_variance', 'audit_trail', 'closing_balances'
    ]);
    expect(validateAuditItem({ status: 'pass', notes: '' }).errors).toEqual([]);
    expect(validateAuditItem({ status: 'exception', notes: '' }).errors).toEqual(['Explain the exception and the action required.']);
    expect(validateAuditItem({ status: 'exception', notes: 'Voucher 14 is missing.' }).errors).toEqual([]);
  });
});
