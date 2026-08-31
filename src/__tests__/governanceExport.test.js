'use strict';

jest.mock('../dal', () => ({ query: jest.fn() }));
jest.mock('../services', () => ({ arrearsReport: jest.fn(), budgetVsActual: jest.fn() }));

const dal = require('../dal');
const { budgetVsActual } = require('../services');
const { exportBudgetActualCsv, exportTransactionsCsv, exportTransfersCsv } = require('../csvExport');

afterEach(() => jest.clearAllMocks());

describe('governance evidence exports', () => {
  test('exports annual budget versus actual with direction and variance', async () => {
    budgetVsActual.mockResolvedValue({
      lines: [{ kind: 'income', category: 'Appeal', budget: 1000, actual: 1200, variance: 200, notes: 'Transport appeal' }]
    });
    const csv = await exportBudgetActualCsv(2026);
    expect(csv).toContain('Year,Direction,Category,Budget,Actual,Variance (Actual - Budget),Notes');
    expect(csv).toContain('2026,Income,Appeal,1000.00,1200.00,200.00,Transport appeal');
  });

  test('transaction evidence includes references, recorder, timestamp, and reconciliation status', async () => {
    dal.query.mockResolvedValue([{
      tx_date: '2026-07-01', tx_type: 'receipt', category: 'Offertory', member: '', account: 'Cash',
      to_account: '', amount: 250, welfare_component: 0, reference: 'RCPT-10', reconciled: true,
      status: 'posted', description: 'Sunday offertory', recorded_by: 'Finance Secretary', created_at: '2026-07-01T12:00:00Z'
    }]);
    const csv = await exportTransactionsCsv({ startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(csv).toContain('Reference');
    expect(csv).toContain('Recorded By');
    expect(csv).toContain('Recorded At');
    expect(csv).toContain('RCPT-10');
    expect(csv).toContain('Finance Secretary');
    expect(dal.query.mock.calls[0][0]).toContain("t.status = 'posted' AND t.reverses_transaction_id IS NULL");
  });

  test('transfer register preserves reversed originals, excludes reversal rows, and totals only posted transfers', async () => {
    dal.query.mockResolvedValue([
      {
        id: 31, tx_date: '2024-05-10', from_account: 'Cash', to_account: 'Republic Bank',
        amount: 500, reference: 'DEP-31', description: 'Cash deposit', status: 'posted',
        reconciled: true, reversal_reason: null, recorded_by: 'Treasurer', created_at: '2024-05-10T12:00:00Z'
      },
      {
        id: 32, tx_date: '2024-06-10', from_account: 'Cash', to_account: 'Republic Bank',
        amount: 200, reference: 'DEP-32', description: 'Entered in error', status: 'reversed',
        reconciled: false, reversal_reason: 'Duplicate', recorded_by: 'Treasurer', created_at: '2024-06-10T12:00:00Z'
      }
    ]);

    const csv = await exportTransfersCsv({ startDate: '2024-01-01', endDate: '2024-12-31' });
    expect(csv).toContain('Transaction ID,Date,From Account,To Account,Amount,Reference');
    expect(csv).toContain('31,2024-05-10,Cash,Republic Bank,500.00,DEP-31');
    expect(csv).toContain('32,2024-06-10,Cash,Republic Bank,200.00,DEP-32');
    expect(csv).toContain('TOTAL POSTED TRANSFERS,,,500.00');
    expect(csv).toContain('Duplicate');
    expect(dal.query.mock.calls[0][0]).toContain("t.tx_type = 'transfer'");
    expect(dal.query.mock.calls[0][0]).toContain('t.reverses_transaction_id IS NULL');
    expect(dal.query.mock.calls[0][1]).toEqual(['2024-01-01', '2024-12-31']);
  });
});
