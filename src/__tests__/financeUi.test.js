'use strict';

const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const views = path.join(__dirname, '..', 'views');
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');

const baseLocals = {
  user: { id: 1, name: 'Test Treasurer', role: 'treasurer' },
  currentPath: '/finance/income/new',
  csrfToken: 'csrf-token',
  groupName: 'KSJI Commandery',
  groupCurrency: 'GHS',
  activeFiscalYear: { year: 2026 },
  formatMoney: (value) => `GHS ${Number(value).toFixed(2)}`,
  formatDate: (value) => String(value).slice(0, 10),
};

describe('separated finance workflows', () => {
  test('server source remains syntactically valid', () => {
    expect(() => new Function('require', 'module', 'exports', '__dirname', serverSource)).not.toThrow();
  });

  test('dedicated income form only contains income fields and preserves its values', async () => {
    const html = await ejs.renderFile(path.join(views, 'finance_form.ejs'), {
      ...baseLocals,
      kind: 'income',
      accounts: [{ id: 1, name: 'Cash' }],
      categories: [{ name: 'Subscriptions' }],
      members: [{ id: 2, name: 'Ama Mensah' }],
      values: { amount: '125.50', reference: 'RCPT-7' }
    });
    expect(html).toContain('<h1>Record Income</h1>');
    expect(html).toContain('action="/transactions/receipt"');
    expect(html).toContain('value="125.50"');
    expect(html).toContain('value="RCPT-7"');
    expect(html).not.toContain('Save Expense');
  });

  test('dedicated expense form only contains expense labels and a constrained responsive grid', async () => {
    const html = await ejs.renderFile(path.join(views, 'finance_form.ejs'), {
      ...baseLocals,
      currentPath: '/finance/expenses/new',
      kind: 'expense',
      accounts: [{ id: 1, name: 'Republic Bank Account With A Very Long Name' }],
      categories: [{ name: 'General expense' }],
      members: []
    });
    expect(html).toContain('<h1>Record Expense</h1>');
    expect(html).toContain('action="/transactions/expense"');
    expect(html).toContain('class="field-grid"');
    expect(html).toContain('class="action-bar"');
    expect(html).not.toContain('Related member');
    expect(cssSource).toMatch(/--content-form-max:\s*1080px/);
    expect(cssSource).toMatch(/@media \(max-width: 767px\)[\s\S]*\.field-grid\s*\{\s*grid-template-columns:minmax\(0,1fr\)/);
  });

  test('server declares separate routes with their existing role permissions', () => {
    expect(serverSource).toContain("app.get('/finance/income/new', allow('admin', 'finance_secretary', 'treasurer')");
    expect(serverSource).toContain("app.get('/finance/expenses/new', allow('admin', 'treasurer')");
    expect(serverSource).toContain("app.get('/finance/income', requireLogin");
    expect(serverSource).toContain("app.get('/finance/expenses', requireLogin");
    expect(serverSource).toContain("res.redirect('/finance/income')");
    expect(serverSource).toContain("res.redirect('/finance/expenses')");
    expect(serverSource).toContain("SELECT id FROM accounts WHERE id = $1 AND active = true");
  });
});

describe('finance and dashboard template rendering', () => {
  const transaction = {
    id: 1, tx_date: '2026-07-22', tx_type: 'receipt', category: 'Subscriptions',
    amount: 125, account_name: 'Republic Bank Account With A Very Long Name', status: 'posted',
    reconciled: false, reference: 'REF-1', recorded_by: 'Test Treasurer', member_name: 'Ama Mensah'
  };
  const summary = { balances: [{ id: 1, name: transaction.account_name, type: 'bank', balance: 12000 }], totalCashPosition: 12000, income: 125, expenses: 20 };

  test.each([
    ['finance_overview.ejs', { summary, recent: [transaction], unreconciledCount: 1, arrearsCount: 2, lastReconciliation: null }],
    ['finance_list.ejs', { kind: 'income', transactions: [transaction] }],
    ['finance_accounts.ejs', { balances: summary.balances }],
    ['dashboard.ejs', { summary, monthSummary: { income: 125, expenses: 20 }, dashboardMonth: { label: 'July 2026' }, recent: [transaction], memberCount: 10, unreconciledCount: 1, arrearsCount: 2, lastReconciliation: null }]
  ])('%s renders populated state without markup errors', async (template, values) => {
    const html = await ejs.renderFile(path.join(views, template), { ...baseLocals, ...values });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Republic Bank Account With A Very Long Name');
    expect(html).toContain('</html>');
  });

  test('dashboard renders loading failure and empty data states', async () => {
    const html = await ejs.renderFile(path.join(views, 'dashboard.ejs'), {
      ...baseLocals,
      error: true,
      summary: { balances: [], totalCashPosition: 0 },
      monthSummary: { income: 0, expenses: 0 },
      dashboardMonth: { label: 'July 2026' },
      recent: [], memberCount: 0, unreconciledCount: 0, arrearsCount: 0, lastReconciliation: null
    });
    expect(html).toContain('Unable to load financial data');
  });
});

describe('role-aware navigation', () => {
  async function sidebar(role) {
    return ejs.renderFile(path.join(views, 'partials', 'sidebar.ejs'), {
      ...baseLocals,
      user: { id: 1, name: 'Role Test', role }
    });
  }

  test('treasurer sees both entry workflows but not user administration', async () => {
    const html = await sidebar('treasurer');
    expect(html).toContain('href="/finance/income/new"');
    expect(html).toContain('href="/finance/expenses/new"');
    expect(html).not.toContain('href="/users"');
    expect((html.match(/sidebar__link[^\"]* active/g) || [])).toHaveLength(1);
  });

  test('viewer sees finance registers without restricted entry or settings links', async () => {
    const html = await sidebar('viewer');
    expect(html).toContain('href="/finance/income"');
    expect(html).toContain('href="/finance/expenses"');
    expect(html).not.toContain('href="/finance/income/new"');
    expect(html).not.toContain('href="/finance/expenses/new"');
    expect(html).not.toContain('href="/config"');
  });
});

describe('responsive dashboard contracts', () => {
  test('dashboard includes compact account, attention, empty, and error states', () => {
    const dashboard = fs.readFileSync(path.join(views, 'dashboard.ejs'), 'utf8');
    expect(dashboard).toContain('Total available balance');
    expect(dashboard).toContain('class="account-list"');
    expect(dashboard).toContain('Work requiring attention');
    expect(dashboard).toContain('class="mobile-list"');
    expect(dashboard).toContain('class="error-state"');
    expect(cssSource).toMatch(/\.account-row__name[^}]*overflow-wrap:anywhere/);
    expect(cssSource).toMatch(/\.summary-strip__value[^}]*font-variant-numeric:tabular-nums/);
  });
});
