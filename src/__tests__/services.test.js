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
  latestCompletedAudit,
  periodComparison,
  auditCountSummary,
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

  test('calculates welfare from an effective member dues rule without a payment split', async () => {
    dal.queryOne
      .mockResolvedValueOnce({ purpose: 'assessment' })
      .mockResolvedValueOnce({ id: 9, dob: '1980-01-01' })
      .mockResolvedValueOnce({ assessment_due: 560, welfare_portion: 240 });

    const welfare = await calculateWelfareComponent({
      memberId: 9, category: 'Assessment', amount: 200,
      txDate: '2024-05-11', enteredWelfare: null
    });
    expect(welfare).toBe(85.71);
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


describe('Services: latestCompletedAudit', () => {
  test('returns null when no completed audit exists', async () => {
    dal.queryOne.mockResolvedValueOnce(null);
    const result = await latestCompletedAudit();
    expect(result).toBeNull();
  });

  test('returns date, conclusion, and trusteeName for most recent completed audit', async () => {
    dal.queryOne.mockResolvedValueOnce({
      date: '2024-11-15T10:30:00.000Z',
      conclusion: 'All accounts in order.',
      trustee_name: 'John Smith'
    });
    const result = await latestCompletedAudit();
    expect(result).toEqual({
      date: '2024-11-15T10:30:00.000Z',
      conclusion: 'All accounts in order.',
      trusteeName: 'John Smith'
    });
  });

  test('returns null trusteeName when completed_by user is not found', async () => {
    dal.queryOne.mockResolvedValueOnce({
      date: '2024-06-01T08:00:00.000Z',
      conclusion: 'Minor discrepancies noted.',
      trustee_name: null
    });
    const result = await latestCompletedAudit();
    expect(result).toEqual({
      date: '2024-06-01T08:00:00.000Z',
      conclusion: 'Minor discrepancies noted.',
      trusteeName: null
    });
  });
});

describe('Services: periodComparison', () => {
  test('returns category comparisons with variance and highlighting', async () => {
    // Current year query result
    dal.query
      .mockResolvedValueOnce([
        { category: 'Assessment', income: '1200', expense: '0' },
        { category: 'Offertory', income: '500', expense: '0' },
        { category: 'Office Supplies', income: '0', expense: '300' }
      ])
      // Previous year query result
      .mockResolvedValueOnce([
        { category: 'Assessment', income: '1000', expense: '0' },
        { category: 'Offertory', income: '800', expense: '0' },
        { category: 'Office Supplies', income: '0', expense: '250' }
      ]);

    const results = await periodComparison(2025);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'Assessment',
        currentIncome: 1200,
        previousIncome: 1000,
        currentExpense: 0,
        previousExpense: 0,
        variancePercent: 20,
        highlighted: false // exactly 20% is NOT > 20
      }),
      expect.objectContaining({
        category: 'Offertory',
        currentIncome: 500,
        previousIncome: 800,
        currentExpense: 0,
        previousExpense: 0,
        variancePercent: -37.5,
        highlighted: true // |-37.5| > 20
      }),
      expect.objectContaining({
        category: 'Office Supplies',
        currentIncome: 0,
        previousIncome: 0,
        currentExpense: 300,
        previousExpense: 250,
        variancePercent: 20,
        highlighted: false // exactly 20% is NOT > 20
      })
    ]));

    // Verify correct date ranges were used in queries
    expect(dal.query).toHaveBeenCalledTimes(2);
    expect(dal.query.mock.calls[0][1]).toEqual(['2025-01-01', '2025-12-31']);
    expect(dal.query.mock.calls[1][1]).toEqual(['2024-01-01', '2024-12-31']);
  });

  test('handles category only present in previous year', async () => {
    dal.query
      .mockResolvedValueOnce([
        { category: 'Assessment', income: '500', expense: '0' }
      ])
      .mockResolvedValueOnce([
        { category: 'Assessment', income: '400', expense: '0' },
        { category: 'Donations', income: '300', expense: '0' }
      ]);

    const results = await periodComparison(2025);

    const donations = results.find(r => r.category === 'Donations');
    expect(donations).toEqual(expect.objectContaining({
      category: 'Donations',
      currentIncome: 0,
      previousIncome: 300,
      currentExpense: 0,
      previousExpense: 0,
      variancePercent: -100,
      highlighted: true
    }));
  });

  test('handles category only present in current year (previousTotal = 0)', async () => {
    dal.query
      .mockResolvedValueOnce([
        { category: 'NewCategory', income: '250', expense: '0' }
      ])
      .mockResolvedValueOnce([]);

    const results = await periodComparison(2025);

    expect(results).toEqual([
      expect.objectContaining({
        category: 'NewCategory',
        currentIncome: 250,
        previousIncome: 0,
        currentExpense: 0,
        previousExpense: 0,
        variancePercent: 100,
        highlighted: true
      })
    ]);
  });

  test('returns empty array when no transactions in either year', async () => {
    dal.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const results = await periodComparison(2025);
    expect(results).toEqual([]);
  });

  test('results are sorted alphabetically by category', async () => {
    dal.query
      .mockResolvedValueOnce([
        { category: 'Zebra Fund', income: '100', expense: '0' },
        { category: 'Appeal', income: '200', expense: '0' }
      ])
      .mockResolvedValueOnce([]);

    const results = await periodComparison(2025);
    expect(results[0].category).toBe('Appeal');
    expect(results[1].category).toBe('Zebra Fund');
  });
});

describe('Services: auditCountSummary', () => {
  test('returns counts for flags, unreconciled transactions, and checklist progress', async () => {
    // First call: get review scope
    dal.queryOne
      .mockResolvedValueOnce({ scope_start: '2025-01-01', scope_end: '2025-12-31' })
      // Second call: count flagged transactions
      .mockResolvedValueOnce({ count: 3 })
      // Third call: count unreconciled transactions
      .mockResolvedValueOnce({ count: 5 })
      // Fourth call: checklist progress
      .mockResolvedValueOnce({ total: 6, completed: 4 });

    const result = await auditCountSummary(1);

    expect(result).toEqual({
      flaggedCount: 3,
      unreconciledCount: 5,
      completedItems: 4,
      totalItems: 6
    });
  });

  test('returns zero unreconciled when review not found', async () => {
    // Review not found
    dal.queryOne
      .mockResolvedValueOnce(null)
      // Flagged count
      .mockResolvedValueOnce({ count: 2 })
      // Checklist progress
      .mockResolvedValueOnce({ total: 6, completed: 6 });

    const result = await auditCountSummary(999);

    expect(result).toEqual({
      flaggedCount: 2,
      unreconciledCount: 0,
      completedItems: 6,
      totalItems: 6
    });
  });

  test('returns all zeros when no flags, no unreconciled, no items', async () => {
    dal.queryOne
      .mockResolvedValueOnce({ scope_start: '2025-01-01', scope_end: '2025-12-31' })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ total: 0, completed: 0 });

    const result = await auditCountSummary(1);

    expect(result).toEqual({
      flaggedCount: 0,
      unreconciledCount: 0,
      completedItems: 0,
      totalItems: 0
    });
  });

  test('handles null values in query results gracefully', async () => {
    dal.queryOne
      .mockResolvedValueOnce({ scope_start: '2025-01-01', scope_end: '2025-12-31' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await auditCountSummary(1);

    expect(result).toEqual({
      flaggedCount: 0,
      unreconciledCount: 0,
      completedItems: 0,
      totalItems: 0
    });
  });
});
