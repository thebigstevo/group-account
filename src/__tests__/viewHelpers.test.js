'use strict';

const ejs = require('ejs');
const path = require('path');
const { formatDate, formatDateTime, varianceHighlightClass } = require('../viewHelpers');

describe('view date helpers', () => {
  test('formats Date objects and PostgreSQL strings without throwing', () => {
    expect(formatDate(new Date('2026-07-13T18:52:43.000Z'))).toBe('2026-07-13');
    expect(formatDate('2026-07-13')).toBe('2026-07-13');
    expect(formatDate('2026-07-13 18:52:43')).toBe('2026-07-13');
    expect(formatDate(null, '—')).toBe('—');
    expect(formatDate('not-a-date', '—')).toBe('—');
    expect(formatDateTime(new Date('2026-07-13T18:52:43.000Z'))).toBe('2026-07-13 18:52 UTC');
  });

  test('renders fiscal years returned as Date objects', async () => {
    const filename = path.join(__dirname, '..', 'views', 'fiscal_years.ejs');
    const html = await ejs.renderFile(filename, {
      years: [{
        year: 2026,
        status: 'open',
        is_active: true,
        opened_at: new Date('2026-01-01T00:00:00.000Z'),
        closed_at: null,
        notes: null,
      }],
      currentYear: 2026,
      activeFiscalYear: { year: 2026, status: 'open', is_active: true },
      setup: false,
      csrfToken: 'test-token',
      user: { id: 1, name: 'System Admin', role: 'admin' },
      currentPath: '/fiscal-years',
      groupName: 'Test Commandery',
      groupCurrency: 'GHS',
      formatMoney: value => String(value),
      formatDate,
      formatDateTime,
      flash: null,
    });

    expect(html).toContain('2026-01-01');
    expect(html).toContain('Open a new year');
  });

  test('renders tracked member imports and the admin rollback control', async () => {
    const filename = path.join(__dirname, '..', 'views', 'members_import.ejs');
    const html = await ejs.renderFile(filename, {
      result: null,
      batches: [{
        id: 3,
        filename: 'members.csv',
        status: 'completed',
        imported_count: 2,
        skipped_count: 0,
        positive_count: 1,
        negative_count: 1,
        zero_count: 0,
        total_opening_balance: '75.00',
        created_at: new Date('2026-07-13T18:52:43.000Z'),
        created_by_name: 'System Admin',
        reversed_at: null
      }],
      activeFiscalYear: { year: 2026, status: 'open', is_active: true },
      csrfToken: 'test-token',
      user: { id: 1, name: 'System Admin', role: 'admin' },
      currentPath: '/members/import',
      groupName: 'Test Commandery',
      groupCurrency: 'GHS',
      formatMoney: value => `GHS ${value}`,
      formatDate,
      formatDateTime,
      flash: null,
    });

    expect(html).toContain('Import history');
    expect(html).toContain('/members/imports/3/rollback');
    expect(html).toContain('name="_csrf" value="test-token"');
  });

  test('renders the blocked-state message when no fiscal year is active', async () => {
    const filename = path.join(__dirname, '..', 'views', 'setup_required.ejs');
    const html = await ejs.renderFile(filename, {
      csrfToken: 'test-token',
      user: { id: 2, name: 'Viewer', role: 'viewer' },
      currentPath: '/',
      groupName: 'Test Commandery',
      groupCurrency: 'GHS',
      formatMoney: value => String(value),
      formatDate,
      formatDateTime,
      flash: null,
      activeFiscalYear: null
    });

    expect(html).toContain('No active fiscal year');
    expect(html).toContain('Operations are paused');
  });

  test('renders configurable categories and their edit controls', async () => {
    const filename = path.join(__dirname, '..', 'views', 'config.ejs');
    const html = await ejs.renderFile(filename, {
      accounts: [], splits: [], rules: [], year: 2026,
      categories: [{ id: 4, name: 'Annual Levy', kind: 'income', purpose: 'assessment', active: true, sort_order: 10 }],
      activeFiscalYear: { year: 2026, status: 'open', is_active: true },
      csrfToken: 'test-token', user: { id: 1, name: 'Admin', role: 'admin' },
      currentPath: '/config', groupName: 'Test Commandery', groupCurrency: 'GHS',
      formatMoney: value => `GHS ${value}`, formatDate, formatDateTime, flash: null,
    });

    expect(html).toContain('Annual Levy');
    expect(html).toContain('/config/categories/4');
    expect(html).toContain('Member assessment');
  });

  test('renders dues rule and override removal controls for the active year', async () => {
    const filename = path.join(__dirname, '..', 'views', 'dues.ejs');
    const html = await ejs.renderFile(filename, {
      rules: [{ id: 2, year: 2026, label: 'Custom band', min_age: 20, max_age: 40, annual_assessment: 500, welfare_portion: 100, active: true }],
      members: [{ id: 8, name: 'Member One' }],
      overrides: [{ id: 6, member_id: 8, year: 2026, name: 'Member One', assessment_due: 450, welfare_portion: 90, reason: 'Approved' }],
      effectiveDues: [{ id: 8, name: 'Member One', assessment_due: 450, welfare_portion: 90, source: 'Override' }],
      year: 2026, canManage: true,
      activeFiscalYear: { year: 2026, status: 'open', is_active: true },
      csrfToken: 'test-token', user: { id: 1, name: 'Admin', role: 'admin' },
      currentPath: '/dues', groupName: 'Test Commandery', groupCurrency: 'GHS',
      formatMoney: value => `GHS ${value}`, formatDate, formatDateTime, flash: null,
    });

    expect(html).toContain('/dues/rules/2/delete');
    expect(html).toContain('/dues/overrides/6/delete');
  });
});

describe('varianceHighlightClass', () => {
  test('returns highlight class when variance exceeds +20%', () => {
    expect(varianceHighlightClass(25)).toBe('variance-highlight');
    expect(varianceHighlightClass(50)).toBe('variance-highlight');
    expect(varianceHighlightClass(100)).toBe('variance-highlight');
  });

  test('returns highlight class when variance exceeds -20%', () => {
    expect(varianceHighlightClass(-25)).toBe('variance-highlight');
    expect(varianceHighlightClass(-50)).toBe('variance-highlight');
    expect(varianceHighlightClass(-100)).toBe('variance-highlight');
  });

  test('returns empty string when variance is within ±20%', () => {
    expect(varianceHighlightClass(0)).toBe('');
    expect(varianceHighlightClass(10)).toBe('');
    expect(varianceHighlightClass(-10)).toBe('');
    expect(varianceHighlightClass(15)).toBe('');
    expect(varianceHighlightClass(-15)).toBe('');
  });

  test('returns empty string at exactly ±20% (threshold not exceeded)', () => {
    expect(varianceHighlightClass(20)).toBe('');
    expect(varianceHighlightClass(-20)).toBe('');
  });

  test('returns highlight class just above ±20% threshold', () => {
    expect(varianceHighlightClass(20.01)).toBe('variance-highlight');
    expect(varianceHighlightClass(-20.01)).toBe('variance-highlight');
  });

  test('returns empty string for non-numeric inputs', () => {
    expect(varianceHighlightClass(null)).toBe('');
    expect(varianceHighlightClass(undefined)).toBe('');
    expect(varianceHighlightClass('25')).toBe('');
    expect(varianceHighlightClass(NaN)).toBe('');
  });
});
