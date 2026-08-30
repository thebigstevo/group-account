'use strict';

jest.mock('../dal', () => ({ query: jest.fn() }));
jest.mock('../services', () => ({ arrearsReport: jest.fn() }));

const dal = require('../dal');
const { arrearsReport } = require('../services');
const { exportMemberCleanupCsv } = require('../csvExport');

describe('member cleanup export', () => {
  test('keeps editable opening balance separate from calculated reference values', async () => {
    dal.query.mockResolvedValueOnce([{
      id: 9,
      membership_number: 'KSJI-000009',
      name: 'Ama Owusu',
      phone: '0240000000',
      dob: '1990-08-25',
      status: 'active',
      opening_arrears: '-50.00',
      transaction_count: 2,
      potential_duplicate: 'REVIEW'
    }]);
    arrearsReport.mockResolvedValueOnce([{
      member_id: 9,
      assessment_due: 120,
      paid: 20,
      balance: 50
    }]);

    const csv = await exportMemberCleanupCsv(2026);

    expect(csv).toContain('Membership Number,Name,Phone,DOB,Status,Opening Balance');
    expect(csv).toContain('Calculated Balance (reference only)');
    expect(csv).toContain('KSJI-000009,Ama Owusu,0240000000,1990-08-25,active,-50.00');
    expect(csv).toContain('REVIEW');
  });
});
