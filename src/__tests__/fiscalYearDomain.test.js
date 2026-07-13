'use strict';

const { validateActiveFiscalDate } = require('../fiscalYearDomain');

describe('active fiscal year rules', () => {
  test('requires setup before transaction entry', () => {
    expect(validateActiveFiscalDate(null, '2026-07-14')).toMatch(/Select an active fiscal year/);
  });

  test('accepts dates only inside the selected fiscal year', () => {
    const active = { year: 2025 };
    expect(validateActiveFiscalDate(active, '2025-12-31')).toBeNull();
    expect(validateActiveFiscalDate(active, '2026-01-01')).toBe(
      'Transactions must be recorded in the active fiscal year 2025.'
    );
  });
});
