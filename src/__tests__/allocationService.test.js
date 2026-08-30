'use strict';

jest.mock('../dal', () => ({ queryOne: jest.fn() }));
jest.mock('../fundClassifications', () => ({
  getDefaultFund: jest.fn(),
  getFundByCode: jest.fn()
}));

const dal = require('../dal');
const funds = require('../fundClassifications');
const { calculateAllocations } = require('../allocationService');

beforeEach(() => {
  jest.clearAllMocks();
  funds.getDefaultFund.mockResolvedValue({ id: 1, code: 'mens_operating' });
  funds.getFundByCode.mockImplementation(async (code) => code === 'mens_operating'
    ? { id: 1, code }
    : { id: 2, code });
});

describe('receipt fund allocations', () => {
  test('uses the effective welfare amount calculated from a member dues rule', async () => {
    await expect(calculateAllocations(100, 'Assessment', 2024, 17, 40)).resolves.toEqual([
      { fund_classification_id: 1, amount: 60 },
      { fund_classification_id: 2, amount: 40 }
    ]);
    expect(dal.queryOne).not.toHaveBeenCalled();
  });

  test('supports a member override ratio without recalculating it', async () => {
    await expect(calculateAllocations(200, 'Assessment', 2024, 9, 85.71)).resolves.toEqual([
      { fund_classification_id: 1, amount: 114.29 },
      { fund_classification_id: 2, amount: 85.71 }
    ]);
  });

  test('allocates a direct welfare collection entirely to joint welfare', async () => {
    await expect(calculateAllocations(75, 'Welfare', 2024, null, 75)).resolves.toEqual([
      { fund_classification_id: 2, amount: 75 }
    ]);
  });

  test('uses full assessment as the legacy split denominator', async () => {
    dal.queryOne.mockResolvedValue({ assessment_amount: 600, welfare_amount: 240 });
    await expect(calculateAllocations(100, 'Assessment', 2024)).resolves.toEqual([
      { fund_classification_id: 1, amount: 60 },
      { fund_classification_id: 2, amount: 40 }
    ]);
  });

  test('allocates receipts with zero welfare to the default operating fund', async () => {
    await expect(calculateAllocations(100, 'Offertory', 2024, null, 0)).resolves.toEqual([
      { fund_classification_id: 1, amount: 100 }
    ]);
  });

  test.each([-1, 101, Number.NaN])('rejects invalid welfare amount %s', async (welfare) => {
    await expect(calculateAllocations(100, 'Assessment', 2024, 1, welfare))
      .rejects.toThrow('Welfare component must be between zero and the receipt amount');
  });
});
