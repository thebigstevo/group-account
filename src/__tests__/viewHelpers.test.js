'use strict';

const ejs = require('ejs');
const path = require('path');
const { formatDate, formatDateTime } = require('../viewHelpers');

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
        opened_at: new Date('2026-01-01T00:00:00.000Z'),
        closed_at: null,
        notes: null,
      }],
      currentYear: 2026,
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
});
