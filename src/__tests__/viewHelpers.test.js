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
});
