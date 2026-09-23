'use strict';

jest.mock('../dal', () => ({ transaction: jest.fn(), audit: jest.fn(), query: jest.fn() }));
jest.mock('../services', () => ({
  arrearsReport: jest.fn(),
  calculateWelfareComponent: jest.fn()
}));
jest.mock('../allocationService', () => ({
  calculateAllocations: jest.fn(),
  calculateExpenseAllocations: jest.fn()
}));

const dal = require('../dal');
const services = require('../services');
const allocationService = require('../allocationService');
const {
  YearEndValidationError,
  approveAuditAdjustment,
  finalizeFiscalYear,
  proposeAuditAdjustment,
  rejectAuditAdjustment,
  submitYearForAudit
} = require('../yearEndService');

function transactionClient(responses) {
  const client = { query: jest.fn() };
  responses.forEach((response) => client.query.mockResolvedValueOnce(response));
  dal.transaction.mockImplementationOnce((callback) => callback(client));
  return client;
}

afterEach(() => jest.clearAllMocks());

describe('safer year-end workflow service', () => {
  test('submitting an active year freezes it and writes provisional next-year openings', async () => {
    services.arrearsReport.mockResolvedValue([{ member_id: 7, opening_arrears: 25, balance: 125.5 }]);
    const client = transactionClient([
      { rows: [] },
      { rows: [{ year: 2024, status: 'open', is_active: true }] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] }
    ]);

    await expect(submitYearForAudit({ year: 2024, userId: 1, notes: 'Ready' }))
      .resolves.toEqual({ memberCount: 1 });
    expect(client.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    expect(client.query.mock.calls[2][1]).toEqual([7, 2024, 25, 1]);
    expect(client.query.mock.calls[3][0]).toContain('member_year_openings');
    expect(client.query.mock.calls[3][1]).toEqual([7, 2025, 125.5, 2024, true, 1]);
    expect(client.query.mock.calls[4][0]).toContain("status='pending_audit'");
  });

  test('permanent close is blocked until the audit is signed', async () => {
    transactionClient([
      { rows: [] },
      { rows: [{ year: 2024, status: 'pending_audit' }] },
      { rows: [{ year: 2024, status: 'in_progress' }] },
      { rows: [{ count: 0 }] }
    ]);
    await expect(finalizeFiscalYear({ year: 2024, userId: 1 }))
      .rejects.toThrow(YearEndValidationError);
    expect(services.arrearsReport).not.toHaveBeenCalled();
  });

  test('permanent close finalises carry-forwards only after signed audit and decided adjustments', async () => {
    services.arrearsReport.mockResolvedValue([{ member_id: 7, opening_arrears: 25, balance: 125.5 }]);
    const client = transactionClient([
      { rows: [] },
      { rows: [{ year: 2024, status: 'pending_audit' }] },
      { rows: [{ year: 2024, status: 'completed' }] },
      { rows: [{ count: 0 }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] }
    ]);
    await expect(finalizeFiscalYear({ year: 2024, userId: 1, notes: 'Signed' }))
      .resolves.toEqual({ memberCount: 1 });
    expect(client.query.mock.calls.some(([sql, params]) => String(sql).includes('UPDATE members') && params[0] === 125.5)).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("status='closed'"))).toBe(true);
  });

  test('a missed receipt is proposed without changing the transaction ledger', async () => {
    services.calculateWelfareComponent.mockResolvedValue(75);
    const client = transactionClient([
      { rows: [{ year: 2024, status: 'pending_audit' }] },
      { rows: [{ id: 3, status: 'in_progress' }] },
      { rows: [{ id: 2 }] },
      { rows: [{ name: 'Assessment', purpose: 'assessment' }] },
      { rows: [{ id: 7 }] },
      { rows: [{ id: 19 }] }
    ]);
    await expect(proposeAuditAdjustment({
      year: 2024, userId: 4,
      input: {
        tx_type: 'receipt', tx_date: '2024-05-11', member_id: '7', account_id: '2',
        category: 'Assessment', amount: '500', reference: 'R-19',
        description: 'Receipt located in cashbook', reason: 'Missed during the initial data entry'
      }
    })).resolves.toEqual({ id: 19 });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO audit_adjustments'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO transactions'))).toBe(false);
  });

  test('approved adjustment posts once, updates provisional arrears, and reopens a signed audit', async () => {
    allocationService.calculateAllocations.mockResolvedValue([
      { fund_classification_id: 2, amount: 500 }
    ]);
    const adjustment = {
      id: 9, year: 2024, review_id: 3, review_status: 'completed', review_revision: 1,
      tx_type: 'receipt', tx_date: '2024-05-11', member_id: 7, account_id: 2,
      category: 'Assessment', category_purpose: 'assessment', description: 'Missed receipt',
      amount: '500.00', welfare_component: '0.00', reference: 'R-19', requested_by: 4,
      status: 'proposed'
    };
    const client = transactionClient([
      { rows: [adjustment] },
      { rows: [] },
      { rows: [{ year: 2024, status: 'pending_audit' }] },
      { rows: [{ id: 88 }] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [] }
    ]);

    await expect(approveAuditAdjustment({ adjustmentId: 9, userId: 6, decisionNotes: 'Voucher checked' }))
      .resolves.toEqual({ transactionId: 88, auditReopened: true, year: 2024 });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('is_audit_adjustment'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('opening_arrears=opening_arrears-$1'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("status='in_progress'"))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("status='pending'"))).toBe(true);
  });

  test('requester cannot approve their own adjustment', async () => {
    transactionClient([{ rows: [{ id: 9, requested_by: 4, status: 'proposed' }] }]);
    await expect(approveAuditAdjustment({ adjustmentId: 9, userId: 4 }))
      .rejects.toThrow('The person who proposed an adjustment cannot approve it.');
  });

  test('rejection requires and stores a decision reason without posting a transaction', async () => {
    const client = transactionClient([
      { rows: [{ id: 9, year: 2024, requested_by: 4, status: 'proposed' }] },
      { rows: [] }
    ]);
    await expect(rejectAuditAdjustment({ adjustmentId: 9, userId: 6, decisionNotes: 'No supporting voucher' }))
      .resolves.toEqual({ year: 2024 });
    expect(client.query.mock.calls[1][0]).toContain("status='rejected'");
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO transactions'))).toBe(false);
  });
});
