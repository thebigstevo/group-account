'use strict';

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(src, 'server.js'), 'utf8');
const servicesSource = fs.readFileSync(path.join(src, 'services.js'), 'utf8');
const auditSource = fs.readFileSync(path.join(src, 'autoAudit.js'), 'utf8');
const exportSource = fs.readFileSync(path.join(src, 'csvExport.js'), 'utf8');

describe('reversal accounting regression contracts', () => {
  test('operational registers select original business entries but not reversal audit rows', () => {
    expect(serverSource).toMatch(
      /async function financeTransactions[\s\S]*?WHERE t\.tx_type = ANY\(\$1::varchar\[\]\)[\s\S]*?AND t\.reverses_transaction_id IS NULL/
    );
  });

  test('trustee and downloadable financial totals exclude reversal audit rows', () => {
    expect(serverSource).toMatch(
      /app\.get\('\/trustee-dashboard'[\s\S]*?WHERE status = 'posted' AND reverses_transaction_id IS NULL/
    );
    expect(serverSource).toMatch(
      /app\.get\('\/download\/income-expenditure'[\s\S]*?t\.reverses_transaction_id IS NULL/
    );
    expect(serverSource).toMatch(
      /app\.get\('\/download\/receipts-payments'[\s\S]*?reverses_transaction_id IS NULL/
    );
  });

  test('audit summaries and exports distinguish active entries from preserved reversal evidence', () => {
    expect(servicesSource).toContain("status = 'posted' AND reverses_transaction_id IS NULL");
    expect(auditSource).toContain("status = 'posted' AND reverses_transaction_id IS NULL");
    expect(exportSource).toContain("t.status = 'posted' AND t.reverses_transaction_id IS NULL");
    expect(servicesSource).toContain("COUNT(*) FILTER (WHERE status = 'reversed')");
  });
});
