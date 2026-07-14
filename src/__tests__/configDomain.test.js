'use strict';

const { validateDuesRule, ageBandsOverlap, validateCategory } = require('../configDomain');

describe('financial configuration validation', () => {
  test('accepts configurable dues amounts and rejects invalid welfare allocation', () => {
    expect(validateDuesRule({ label: '2026 members', min_age: '', max_age: 64, annual_assessment: 900, welfare_portion: 250 }).errors).toEqual([]);
    expect(validateDuesRule({ label: 'Bad', min_age: 70, max_age: 60, annual_assessment: 100, welfare_portion: 150 }).errors).toEqual([
      'Minimum age cannot exceed maximum age.',
      'Welfare portion cannot exceed the assessment.'
    ]);
  });

  test('detects overlapping open-ended age bands', () => {
    expect(ageBandsOverlap({ min_age: null, max_age: 59 }, { min_age: 60, max_age: 69 })).toBe(false);
    expect(ageBandsOverlap({ min_age: 50, max_age: null }, { min_age: 60, max_age: 69 })).toBe(true);
  });

  test('enforces compatible category purposes and types', () => {
    expect(validateCategory({ name: 'Annual Levy', kind: 'income', purpose: 'assessment' }).errors).toEqual([]);
    expect(validateCategory({ name: 'Payout', kind: 'income', purpose: 'welfare_payout' }).errors).toEqual([
      'Welfare payout purpose must be an expense category.'
    ]);
  });
});
