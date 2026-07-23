'use strict';

const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const { AUDIT_CHECKLIST } = require('../governanceDomain');

const root = path.join(__dirname, '..');
const views = path.join(root, 'views');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const configSource = fs.readFileSync(path.join(views, 'config.ejs'), 'utf8');

const locals = {
  user: { id: 4, name: 'Trustee Test', role: 'trustee' },
  currentPath: '/trustee-audit', csrfToken: 'csrf', groupName: 'Test Commandery', groupCurrency: 'GHS',
  assetVersion: 'test', activeFiscalYear: { year: 2026 }, title: 'Test',
  formatMoney: (value) => `GHS ${Number(value || 0).toFixed(2)}`,
  formatDate: String, formatDateTime: String
};

describe('financial governance user interfaces', () => {
  test('annual budget renders budget, actual, variance, locking, and export controls', async () => {
    const html = await ejs.renderFile(path.join(views, 'budgets.ejs'), {
      ...locals, year: 2026, years: [{ year: 2026, status: 'open' }],
      report: {
        header: { status: 'draft', notes: 'Annual plan' },
        totals: { income: { budget: 1000, actual: 900 }, expense: { budget: 600, actual: 500 } },
        lines: [{ id: 1, category: 'Appeal', kind: 'income', budget: 1000, actual: 900, variance: -100, notes: '', categoryActive: true }]
      },
      categories: [{ name: 'Appeal', kind: 'both' }], canEdit: true, canApprove: true
    });
    expect(html).toContain('<h1>Annual budget</h1>');
    expect(html).toContain('Budget versus actual');
    expect(html).toContain('Approve and lock budget');
    expect(html).toContain('/export/budget-actual?year=2026');
  });

  test('trustee workspace renders evidence, checklist, budget, and completion controls', async () => {
    const itemByKey = Object.fromEntries(AUDIT_CHECKLIST.map((item, index) => [item.key, { id: index + 1, status: 'pending', notes: '' }]));
    const html = await ejs.renderFile(path.join(views, 'trustee_audit.ejs'), {
      ...locals, year: 2026, years: [{ year: 2026, status: 'open' }], canReview: true,
      evidence: {
        startDate: '2026-01-01', endDate: '2026-12-31',
        summary: { receipts: 1200, outflows: 500, unreconciledCount: 2, missingReferenceCount: 1, missingDescriptionCount: 1, reversedCount: 0 },
        balances: [{ name: 'Cash', type: 'cash', balance: 700 }],
        reconciliations: [{ account_name: 'Cash', period_end: '2026-06-30', difference: 0 }], transactions: []
      },
      budget: { lines: [] },
      review: { id: 1, status: 'in_progress', scope_start: '2026-01-01', scope_end: '2026-12-31', started_by_name: 'Trustee Test', started_at: '2026-07-23' },
      checklist: AUDIT_CHECKLIST, itemByKey
    });
    expect(html).toContain('<h1>Trustee audit workspace</h1>');
    expect(html).toContain('Income completeness');
    expect(html).toContain('Budget variance evidence');
    expect(html).toContain('Complete and sign audit');
    expect(html).toContain('Transaction evidence');
  });

  test('dual-purpose categories are offered and accepted for both transaction directions', () => {
    expect(configSource).toContain('value="both"');
    expect(configSource).toContain('Income &amp; expense');
    expect(serverSource).toContain("kind IN ($1, 'both')");
    expect(serverSource).toContain("kind IN ('income','both')");
    expect(serverSource).toContain("kind IN ('expense','both')");
  });

  test('trustees can review and export evidence but budget approval remains administrator-only', () => {
    expect(serverSource).toContain("app.get('/trustee-audit', allow('admin', 'auditor', 'trustee', 'treasurer')");
    expect(serverSource).toContain("app.post('/trustee-audit/start', allow('auditor', 'trustee')");
    expect(serverSource).toContain("app.post('/budgets/:year/approve', allow('admin')");
    expect(serverSource).toContain("app.get('/export/audit-log', allow('admin', 'auditor', 'trustee')");
  });
});
