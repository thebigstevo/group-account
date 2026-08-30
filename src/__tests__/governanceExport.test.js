'use strict';

jest.mock('../dal', () => ({ query: jest.fn() }));
jest.mock('../services', () => ({ arrearsReport: jest.fn(), budgetVsActual: jest.fn() }));

const dal = require('../dal');
const { budgetVsActual } = require('../services');
const { exportBudgetActualCsv, exportTransactionsCsv } = require('../csvExport');

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
});
