'use strict';

/**
 * Unit tests for services.js (PostgreSQL / DAL-based).
 *
 * These tests mock the DAL module to verify service logic without
 * requiring a running PostgreSQL instance.
 */

jest.mock('../dal', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  run: jest.fn(),
  transaction: jest.fn(),
  shutdown: jest.fn(),
  audit: jest.fn(),
}));

const dal = require('../dal');
const {
  calculateWelfareComponent,
  budgetVsActual,
  currentYear,
} = require('../services');

afterEach(() => {
  jest.clearAllMocks();
});

describe('Services: calculateWelfareComponent', () => {
  const year = new Date().getFullYear();

  test('returns explicit welfare amount when provided', async () => {
    const welfare = await calculateWelfareComponent({
      memberId: 1,
      category: 'Assessment',
      amount: 1000,
      txDate: `${year}-06-15`,
      enteredWelfare: 250,
    });
    expect(welfare).toBe(250);
  });

  test('returns full amount for Welfare category', async () => {
    dal.queryOne.mockResolvedValueOnce({ purpose: 'welfare_income' });
    const welfare = await calculateWelfareComponent({
      memberId: 1,
      category: 'Welfare',
      amount: 500,
      txDate: `${year}-06-15`,
      enteredWelfare: null,
    });
    expect(welfare).toBe(500);
  });

  test('returns 0 for non-Assessment, non-Welfare category', async () => {
    dal.queryOne.mockResolvedValueOnce({ purpose: 'standard' });
    const welfare = await calculateWelfareComponent({
      memberId: 1,
      category: 'Offertory',
      amount: 500,
      txDate: `${year}-06-15`,
      enteredWelfare: null,
    });
    expect(welfare).toBe(0);
  });

  test('calculates welfare from payment splits ratio for Assessment', async () => {
    dal.queryOne.mockResolvedValueOnce({ purpose: 'assessment' });
    dal.queryOne.mockResolvedValueOnce(null); // no member selected; use payment split
    dal.queryOne.mockResolvedValueOnce({
      assessment_amount: 1000,
      welfare_amount: 400,
    }); // payment_splits

    const welfare = await calculateWelfareComponent({
      memberId: 1,
      category: 'Assessment',
      amount: 1000,
      txDate: `${year}-06-15`,
      enteredWelfare: null,
    });
    expect(welfare).toBe(400);
  });
});

describe('Services: currentYear', () => {
  test('returns the current calendar year', () => {
    expect(currentYear()).toBe(new Date().getFullYear());
  });
});

describe('Services: budgetVsActual', () => {
  test('combines budget lines with actual income, expense, and unbudgeted activity', async () => {
    dal.queryOne.mockResolvedValueOnce({ year: 2026, status: 'approved' });
    dal.query
      .mockResolvedValueOnce([
        { id: 1, year: 2026, category: 'Appeal', kind: 'income', amount: '1000', notes: '', category_active: true },
        { id: 2, year: 2026, category: 'Appeal', kind: 'expense', amount: '600', notes: '', category_active: true }
      ])
      .mockResolvedValueOnce([
        { category: 'Appeal', kind: 'income', actual: '1200' },
        { category: 'Appeal', kind: 'expense', actual: '450' },
        { category: 'Offertory', kind: 'income', actual: '100' }
      ]);

    const report = await budgetVsActual(2026);
    expect(report.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'Appeal', kind: 'income', budget: 1000, actual: 1200, variance: 200 }),
      expect.objectContaining({ category: 'Appeal', kind: 'expense', budget: 600, actual: 450, variance: -150 }),
      expect.objectContaining({ category: 'Offertory', kind: 'income', budget: 0, actual: 100, variance: 100 })
    ]));
    expect(report.totals.income).toEqual({ budget: 1000, actual: 1300, variance: 300 });
    expect(report.totals.expense).toEqual({ budget: 600, actual: 450, variance: -150 });
  });
});
