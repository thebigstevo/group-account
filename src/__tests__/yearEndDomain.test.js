'use strict';

const {
  approvalError,
  finalCloseError,
  isIsoDateInYear,
  pendingAuditTransitionError,
  validateAuditAdjustment,
  validateAuditReversal
} = require('../yearEndDomain');

describe('safe fiscal year and audit adjustment rules', () => {
  test('only the active open year can move to pending audit', () => {
    expect(pendingAuditTransitionError({ status: 'open', is_active: true })).toBeNull();
    expect(pendingAuditTransitionError({ status: 'open', is_active: false })).toMatch(/active open/);
    expect(pendingAuditTransitionError({ status: 'closed', is_active: false })).toMatch(/active open/);
  });

  test('permanent close requires pending audit, signed review, and no undecided adjustments', () => {
    expect(finalCloseError({ status: 'pending_audit' }, { status: 'completed' }, 0)).toBeNull();
    expect(finalCloseError({ status: 'open' }, { status: 'completed' }, 0)).toMatch(/pending audit/);
    expect(finalCloseError({ status: 'pending_audit' }, { status: 'in_progress' }, 0)).toMatch(/Complete and sign/);
    expect(finalCloseError({ status: 'pending_audit' }, { status: 'completed' }, 1)).toMatch(/Approve or reject/);
  });

  test('validates real dates, positive amounts, and a meaningful adjustment reason', () => {
    expect(isIsoDateInYear('2024-02-29', 2024)).toBe(true);
    expect(isIsoDateInYear('2024-02-30', 2024)).toBe(false);
    expect(validateAuditAdjustment({
      tx_type: 'receipt', tx_date: '2024-05-11', account_id: '2', category: 'Assessment',
      member_id: '4', amount: '500', welfare_component: '100', reference: 'AUD-1',
      description: 'Missing receipt', reason: 'Located during trustee audit'
    }, 2024)).toEqual({
      errors: [],
      values: {
        tx_type: 'receipt', tx_date: '2024-05-11', account_id: 2, category: 'Assessment',
        member_id: 4, amount: 500, welfare_component: 100, reference: 'AUD-1',
        description: 'Missing receipt', reason: 'Located during trustee audit'
      }
    });
    const invalid = validateAuditAdjustment({ tx_type: 'transfer', tx_date: '2025-01-01', amount: 0, reason: 'short' }, 2024);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      'Select receipt or expense.',
      'The transaction date must be inside fiscal year 2024.',
      'Select an account.',
      'Select a category.',
      'Amount must be greater than zero.',
      'Adjustment reason must be at least 10 characters.'
    ]));
  });

  test('enforces independent approval', () => {
    expect(approvalError({ status: 'proposed', requested_by: 7 }, 8)).toBeNull();
    expect(approvalError({ status: 'proposed', requested_by: 7 }, 7)).toMatch(/cannot approve/);
    expect(approvalError({ status: 'approved', requested_by: 7 }, 8)).toMatch(/proposed/);
  });

  test('controlled reversal requires a transaction and meaningful reason', () => {
    expect(validateAuditReversal({ original_transaction_id: '42', reason: 'Duplicate cashbook entry' }))
      .toEqual({ errors: [], values: { original_transaction_id: 42, reason: 'Duplicate cashbook entry' } });
    expect(validateAuditReversal({ original_transaction_id: '', reason: 'short' }).errors)
      .toEqual(expect.arrayContaining([
        'Select a transaction to reverse.',
        'Reversal reason must be at least 10 characters.'
      ]));
  });
});
