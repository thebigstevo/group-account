'use strict';

const { AUDIT_CHECKLIST, validateAuditCompletion, validateAuditConclusion, validateAuditFlag, validateAuditItem, validateBudgetLine, validateTransactionNote } = require('../governanceDomain');

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
    expect(validateAuditItem({ status: 'exception', notes: '' }).errors).toEqual(['Exception notes must be at least 10 characters.']);
    expect(validateAuditItem({ status: 'exception', notes: 'short' }).errors).toEqual(['Exception notes must be at least 10 characters.']);
    expect(validateAuditItem({ status: 'exception', notes: 'Voucher 14 is missing.' }).errors).toEqual([]);
  });

  test('enforces notes maximum length of 2000 characters', () => {
    const longNotes = 'x'.repeat(2001);
    const maxNotes = 'x'.repeat(2000);
    const validExceptionNotes = 'x'.repeat(10);

    // Exception status: notes too long
    expect(validateAuditItem({ status: 'exception', notes: longNotes }).errors).toEqual(['Exception notes must not exceed 2000 characters.']);
    // Exception status: notes at max length
    expect(validateAuditItem({ status: 'exception', notes: maxNotes }).errors).toEqual([]);
    // Exception status: notes at min length
    expect(validateAuditItem({ status: 'exception', notes: validExceptionNotes }).errors).toEqual([]);

    // Non-exception status: notes too long
    expect(validateAuditItem({ status: 'pass', notes: longNotes }).errors).toEqual(['Notes must not exceed 2000 characters.']);
    // Non-exception status: notes at max length
    expect(validateAuditItem({ status: 'pass', notes: maxNotes }).errors).toEqual([]);
    // not_applicable status: notes too long
    expect(validateAuditItem({ status: 'not_applicable', notes: longNotes }).errors).toEqual(['Notes must not exceed 2000 characters.']);
  });

  test('validateAuditItem returns errors array and values object', () => {
    const result = validateAuditItem({ status: 'pass', notes: '  some note  ' });
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('values');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.values).toEqual({ status: 'pass', notes: 'some note' });
  });

  test('validates audit flag with transaction_id and reason', () => {
    // Valid input returns no errors
    const valid = validateAuditFlag({ transaction_id: 42, reason: 'Suspicious amount' });
    expect(valid.errors).toEqual([]);
    expect(valid.values).toEqual({ transaction_id: 42, reason: 'Suspicious amount' });

    // Missing transaction_id
    expect(validateAuditFlag({ transaction_id: null, reason: 'Some reason' }).errors).toContain('A transaction is required.');
    expect(validateAuditFlag({ transaction_id: undefined, reason: 'Some reason' }).errors).toContain('A transaction is required.');
    expect(validateAuditFlag({ transaction_id: 0, reason: 'Some reason' }).errors).toContain('A transaction is required.');

    // Missing reason
    expect(validateAuditFlag({ transaction_id: 1, reason: '' }).errors).toContain('Provide a reason for flagging this transaction.');
    expect(validateAuditFlag({ transaction_id: 1, reason: '   ' }).errors).toContain('Provide a reason for flagging this transaction.');

    // Reason exceeds 1000 characters
    const longReason = 'x'.repeat(1001);
    expect(validateAuditFlag({ transaction_id: 1, reason: longReason }).errors).toContain('Flag reason must not exceed 1000 characters.');

    // Reason exactly 1000 characters is valid
    const maxReason = 'y'.repeat(1000);
    expect(validateAuditFlag({ transaction_id: 1, reason: maxReason }).errors).toEqual([]);
    expect(validateAuditFlag({ transaction_id: 1, reason: maxReason }).values.reason).toHaveLength(1000);

    // Both fields missing
    const both = validateAuditFlag({ transaction_id: null, reason: '' });
    expect(both.errors).toHaveLength(2);
  });

  test('validates audit conclusion requires text and enforces max 5000 characters', () => {
    // Valid conclusion returns no errors
    const valid = validateAuditConclusion({ conclusion: 'The accounts are in order.' });
    expect(valid.errors).toEqual([]);
    expect(valid.values).toEqual({ conclusion: 'The accounts are in order.' });

    // Missing conclusion
    expect(validateAuditConclusion({ conclusion: '' }).errors).toContain('An overall conclusion is required.');
    expect(validateAuditConclusion({ conclusion: '   ' }).errors).toContain('An overall conclusion is required.');
    expect(validateAuditConclusion({}).errors).toContain('An overall conclusion is required.');

    // Conclusion exceeds 5000 characters
    const longConclusion = 'x'.repeat(5001);
    expect(validateAuditConclusion({ conclusion: longConclusion }).errors).toContain('Conclusion must not exceed 5000 characters.');

    // Conclusion exactly 5000 characters is valid
    const maxConclusion = 'y'.repeat(5000);
    expect(validateAuditConclusion({ conclusion: maxConclusion }).errors).toEqual([]);
    expect(validateAuditConclusion({ conclusion: maxConclusion }).values.conclusion).toHaveLength(5000);
  });

  test('validateAuditConclusion returns errors array and values object', () => {
    const result = validateAuditConclusion({ conclusion: '  trimmed conclusion  ' });
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('values');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.values).toEqual({ conclusion: 'trimmed conclusion' });
  });

  test('validateAuditCompletion returns unreviewed item keys when items are pending', () => {
    const items = [
      { key: 'income_completeness', status: 'pass' },
      { key: 'expense_support', status: 'pending' },
      { key: 'account_reconciliation', status: 'exception' },
      { key: 'budget_variance', status: 'pending' },
      { key: 'audit_trail', status: 'not_applicable' },
      { key: 'closing_balances', status: 'pass' }
    ];
    const result = validateAuditCompletion(items, 6);
    expect(result).toEqual(['expense_support', 'budget_variance']);
  });

  test('validateAuditCompletion returns empty list when all items are completed', () => {
    const items = [
      { key: 'income_completeness', status: 'pass' },
      { key: 'expense_support', status: 'pass' },
      { key: 'account_reconciliation', status: 'exception' },
      { key: 'budget_variance', status: 'not_applicable' },
      { key: 'audit_trail', status: 'pass' },
      { key: 'closing_balances', status: 'pass' }
    ];
    const result = validateAuditCompletion(items, 6);
    expect(result).toEqual([]);
  });

  test('validateAuditCompletion returns all keys when no items are reviewed', () => {
    const items = [
      { key: 'income_completeness', status: 'pending' },
      { key: 'expense_support', status: 'pending' },
      { key: 'account_reconciliation', status: 'pending' },
      { key: 'budget_variance', status: 'pending' },
      { key: 'audit_trail', status: 'pending' },
      { key: 'closing_balances', status: 'pending' }
    ];
    const result = validateAuditCompletion(items, 6);
    expect(result).toEqual([
      'income_completeness', 'expense_support', 'account_reconciliation',
      'budget_variance', 'audit_trail', 'closing_balances'
    ]);
  });

  test('validateAuditCompletion handles empty checklist', () => {
    const result = validateAuditCompletion([], 0);
    expect(result).toEqual([]);
  });
});

describe('validateTransactionNote', () => {
  test('accepts a valid note and returns trimmed value', () => {
    const result = validateTransactionNote({ note: '  Checked against receipt.  ' });
    expect(result.errors).toEqual([]);
    expect(result.values).toEqual({ note: 'Checked against receipt.' });
  });

  test('rejects empty or whitespace-only note', () => {
    expect(validateTransactionNote({ note: '' }).errors).toContain('A note is required.');
    expect(validateTransactionNote({ note: '   ' }).errors).toContain('A note is required.');
    expect(validateTransactionNote({}).errors).toContain('A note is required.');
  });

  test('rejects note exceeding 1000 characters', () => {
    const longNote = 'x'.repeat(1001);
    expect(validateTransactionNote({ note: longNote }).errors).toContain('Note must not exceed 1000 characters.');
  });

  test('accepts note at exactly 1000 characters', () => {
    const maxNote = 'y'.repeat(1000);
    const result = validateTransactionNote({ note: maxNote });
    expect(result.errors).toEqual([]);
    expect(result.values.note).toHaveLength(1000);
  });

  test('accepts note at exactly 1 character', () => {
    const result = validateTransactionNote({ note: 'a' });
    expect(result.errors).toEqual([]);
    expect(result.values.note).toBe('a');
  });

  test('returns errors array and values object structure', () => {
    const result = validateTransactionNote({ note: 'test' });
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('values');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.values).toBe('object');
    expect(result.values).toHaveProperty('note');
  });
});
