'use strict';

const { createTransferRegisterDoc } = require('../pdfReports');

function renderPdf(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.end();
  });
}

describe('transfer register PDF', () => {
  test('generates a valid multi-page PDF containing posted and reversed audit rows', async () => {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      id: index + 1,
      tx_date: `2024-${String((index % 12) + 1).padStart(2, '0')}-15`,
      from_account: 'Cash Account',
      to_account: 'Republic Bank',
      amount: 100 + index,
      reference: `DEP-${index + 1}`,
      description: 'Cash deposited into the bank',
      status: index === 4 ? 'reversed' : 'posted',
      reversal_reason: index === 4 ? 'Duplicate entry' : null
    }));
    const postedTotal = rows
      .filter((row) => row.status === 'posted')
      .reduce((sum, row) => sum + row.amount, 0);

    const doc = createTransferRegisterDoc({
      rows,
      postedTotal,
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      groupName: 'KSJI',
      org: { name: 'KSJI' }
    });
    const buffer = await renderPdf(doc);

    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(5000);
    expect((buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length).toBeGreaterThan(1);
  });
});
