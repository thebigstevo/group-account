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
    // Mock: member_dues not overridden, falls through to payment_splits
    dal.queryOne.mockResolvedValueOnce(null); // no member_dues override
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
