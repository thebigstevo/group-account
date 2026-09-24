'use strict';

jest.mock('../dal', () => ({ query: jest.fn(), queryOne: jest.fn() }));

const dal = require('../dal');
const { incomeAndExpenditureData, receiptsAndPaymentsData, welfareFundData } = require('../downloadableReports');

describe('downloadable report periods', () => {
  beforeEach(() => jest.clearAllMocks());

  test('income and expenditure uses the same operating-fund data for CSV and PDF', async () => {
    dal.query
      .mockResolvedValueOnce([{ category: 'Assessment', total: 900 }])
      .mockResolvedValueOnce([{ category: 'Stationery', total: 125 }]);

    const report = await incomeAndExpenditureData('2024-05-01', '2024-05-31');

    expect(report).toMatchObject({ totalIncome: 900, totalExpenses: 125, surplus: 775 });
    expect(dal.query.mock.calls[0][0]).toContain("fc.code = 'mens_operating'");
    expect(dal.query.mock.calls[1][0]).toContain("t.tx_type = 'expense'");
    expect(dal.query.mock.calls[1][0]).not.toContain('welfare_payout');
  });

  test('monthly receipts and payments carries prior activity into the opening balance', async () => {
    dal.query
      .mockResolvedValueOnce([{ id: 1, name: 'Cash', type: 'cash', opening_balance: 1000 }])
      .mockResolvedValueOnce([{ category: 'Assessment', total: 200 }])
      .mockResolvedValueOnce([{ category: 'Stationery', total: 50 }]);
    dal.queryOne
      .mockResolvedValueOnce({ total: 500 })
      .mockResolvedValueOnce({ total: 100 });

    const report = await receiptsAndPaymentsData('2024-05-01', '2024-05-31');

    expect(report.accounts[0]).toMatchObject({
      openingBalance: 1400,
      totalReceipts: 200,
      totalPayments: 50,
      closingBalance: 1550
    });
    expect(report.grandOpeningTotal).toBe(1400);
    expect(report.grandClosingTotal).toBe(1550);
    expect(dal.queryOne.mock.calls[0][0]).toContain('tx_date < $3');
    expect(dal.queryOne.mock.calls[0][1]).toEqual([1, 1, '2024-05-01']);
  });

  test('monthly welfare report carries the prior liability into its closing balance', async () => {
    dal.queryOne.mockResolvedValueOnce({ total: 400 });
    dal.query
      .mockResolvedValueOnce([{ member: 'Member One', total: 100 }])
      .mockResolvedValueOnce([{ tx_date: '2024-05-10', description: 'Benefit', amount: 50 }])
      .mockResolvedValueOnce([{ account_name: 'Cash', balance: 450 }]);

    const report = await welfareFundData('2024-05-01', '2024-05-31');

    expect(report).toMatchObject({
      openingBalance: 400,
      totalCollected: 100,
      totalPaidOut: 50,
      closingBalance: 450
    });
    expect(dal.queryOne.mock.calls[0][0]).toContain('t.tx_date < $1');
    expect(dal.queryOne.mock.calls[0][1]).toEqual(['2024-05-01']);
  });
});
