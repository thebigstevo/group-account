'use strict';

const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..');
const views = path.join(src, 'views');
const serverSource = fs.readFileSync(path.join(src, 'server.js'), 'utf8');
const servicesSource = fs.readFileSync(path.join(src, 'services.js'), 'utf8');

const locals = {
  user: { id: 1, name: 'Treasurer', role: 'treasurer' },
  currentPath: '/finance/transfers', csrfToken: 'csrf', groupName: 'KSJI', groupCurrency: 'GHS',
  assetVersion: 'test', activeFiscalYear: { year: 2024 },
  formatMoney: (value) => `GHS ${Number(value).toFixed(2)}`,
  formatDate: (value) => String(value).slice(0, 10),
  accounts: [
    { id: 1, name: 'Cash', balance: 1200 },
    { id: 2, name: 'Republic Bank', balance: 5000 }
  ],
  transfers: [{
    id: 9, tx_date: '2024-06-15', from_account_name: 'Cash',
    to_account_name: 'Republic Bank', amount: 500, status: 'posted',
    reference: 'DEP-100', description: 'Cash deposit'
  }],
  values: {}
};

describe('account transfer workflow', () => {
  test('renders an accessible transfer form, balances, guidance, and responsive history', async () => {
    const html = await ejs.renderFile(path.join(views, 'finance_transfer.ejs'), locals);
    expect(html).toContain('<h1>Transfer money</h1>');
    expect(html).toContain('action="/transactions/transfer"');
    expect(html).toContain('name="account_id"');
    expect(html).toContain('name="to_account_id"');
    expect(html).toContain('GHS 1200.00');
    expect(html).toContain('Does not record income or an expense.');
    expect(html).toContain('class="mobile-list"');
    expect(html).toContain('preventSameAccount');
  });

  test('finance navigation and overview expose transfers only to authorised roles', async () => {
    const navTreasurer = await ejs.renderFile(path.join(views, 'partials', 'finance-nav.ejs'), locals);
    const navViewer = await ejs.renderFile(path.join(views, 'partials', 'finance-nav.ejs'), {
      ...locals, user: { id: 3, name: 'Viewer', role: 'viewer' }
    });
    expect(navTreasurer).toContain('href="/finance/transfers"');
    expect(navTreasurer).toContain('aria-current="page"');
    expect(navViewer).not.toContain('href="/finance/transfers"');
  });

  test('server uses the atomic service and returns validation errors to the transfer page', () => {
    expect(serverSource).toContain("app.get('/finance/transfers', allow('admin', 'treasurer')");
    expect(serverSource).toContain('await createAccountTransfer({');
    expect(serverSource).toContain('error instanceof TransferValidationError');
    expect(serverSource).toContain("res.redirect('/finance/transfers')");
  });

  test('balance accounting debits the source, credits the destination, and nets transfers to zero', () => {
    expect(servicesSource).toContain("tx_type = 'transfer' AND to_account_id = $1");
    expect(servicesSource).toContain("tx_type = 'transfer' AND account_id = $1 AND to_account_id IS NOT NULL");
    expect(serverSource).toContain("original.tx_type === 'transfer' ? '/finance/transfers'");
  });
});
