'use strict';

const { createCashbookRegisterDoc } = require('../pdfReports');

function renderPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}

describe('detailed cashbook PDF', () => {
  test('generates a valid multi-page income and expense register', async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      tx_date: `2024-${String((index % 12) + 1).padStart(2, '0')}-15`,
      tx_type: index % 2 === 0 ? 'receipt' : 'expense',
      category: index % 2 === 0 ? 'Assessment' : 'General expense',
      amount: 100 + index,
      reference: `REF-${index + 1}`,
      description: index % 2 === 0 ? 'Annual assessment payment' : 'Paid to local supplier',
      member_name: index % 2 === 0 ? `Member ${index + 1}` : null,
      account_name: 'Cash',
      recorded_by: 'Treasurer',
      status: index === 5 ? 'reversed' : 'posted'
    }));
    const posted = rows.filter((row) => row.status === 'posted');
    const incomeTotal = posted.filter((row) => row.tx_type === 'receipt').reduce((sum, row) => sum + row.amount, 0);
    const expenseTotal = posted.filter((row) => row.tx_type === 'expense').reduce((sum, row) => sum + row.amount, 0);
    const doc = createCashbookRegisterDoc({
      rows, incomeTotal, expenseTotal, netMovement: incomeTotal - expenseTotal,
      startDate: '2024-01-01', endDate: '2024-12-31', groupName: 'KSJI', org: { name: 'KSJI' }
    });
    const buffer = await renderPdf(doc);

    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(7000);
    expect((buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(1);
  });
});
