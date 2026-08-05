/**
 * PDF Report Generator for Treasurio
 * Uses PDFKit to produce proper accounting-formatted PDF documents.
 */
const PDFDocument = require('pdfkit');

const MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

/**
 * Create a standard report PDF document with header.
 * @param {Object} opts - { title, subtitle, groupName, period, org }
 * @returns {PDFDocument}
 */
function createDoc(opts = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: opts.title || 'Report',
      Author: 'Treasurio',
      Creator: 'Treasurio Financial Management'
    }
  });

  const org = opts.org || {};

  // Letterhead (if configured)
  if (org.letterhead_line1 || org.letterhead_line2 || org.letterhead_line3) {
    doc.font('Helvetica-Bold').fontSize(12);
    if (org.letterhead_line1) doc.text(org.letterhead_line1, { align: 'center' });
    doc.font('Helvetica').fontSize(10);
    if (org.letterhead_line2) doc.text(org.letterhead_line2, { align: 'center' });
    doc.fontSize(8);
    if (org.letterhead_line3) doc.text(org.letterhead_line3, { align: 'center' });
    doc.moveDown(0.3);
  } else {
    // Fallback: use group name
    doc.font('Helvetica-Bold').fontSize(14).text(opts.groupName || org.name || 'Organization', { align: 'center' });
    if (org.motto) doc.font('Helvetica').fontSize(8).text(org.motto, { align: 'center' });
    doc.moveDown(0.2);
  }

  // Report title
  doc.font('Helvetica-Bold').fontSize(11).text(opts.title || 'Financial Report', { align: 'center' });
  if (opts.subtitle || opts.period) {
    doc.font('Helvetica').fontSize(9).text(opts.subtitle || opts.period || '', { align: 'center' });
  }
  doc.moveDown(0.3);
  doc.fontSize(7).fillColor('#666').text(`Generated: ${new Date().toISOString().slice(0, 10)}`, { align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.5);

  // Divider line
  const y = doc.y;
  doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).lineWidth(1.5).stroke();
  doc.moveDown(0.8);

  return doc;
}

/**
 * Draw a section heading.
 */
function sectionHeading(doc, text) {
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(10).text(text.toUpperCase());
  const y = doc.y + 2;
  doc.moveTo(MARGIN, y).lineTo(PAGE_WIDTH - MARGIN, y).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}

/**
 * Draw a table row (two columns: label + amount).
 */
function tableRow(doc, label, amount, opts = {}) {
  const isBold = opts.bold || false;
  const isTotal = opts.total || false;
  const indent = opts.indent || 0;

  if (isTotal) {
    const y = doc.y;
    doc.moveTo(MARGIN + CONTENT_WIDTH * 0.6, y).lineTo(PAGE_WIDTH - MARGIN, y).lineWidth(0.5).stroke();
    doc.moveDown(0.15);
  }

  doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
  const startY = doc.y;
  doc.text(label, MARGIN + indent, startY, { width: CONTENT_WIDTH * 0.65 - indent, continued: false });
  doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
  doc.text(amount, MARGIN + CONTENT_WIDTH * 0.65, startY, { width: CONTENT_WIDTH * 0.35, align: 'right' });
  doc.y = startY + 14;

  if (isTotal) {
    const y2 = doc.y;
    doc.moveTo(MARGIN + CONTENT_WIDTH * 0.6, y2).lineTo(PAGE_WIDTH - MARGIN, y2).lineWidth(isBold ? 1.5 : 0.5).stroke();
    doc.moveDown(0.3);
  }
}

/**
 * Draw a multi-column table header.
 */
function tableHeader(doc, columns) {
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(7.5);
  let x = MARGIN;
  columns.forEach(col => {
    doc.text(col.label.toUpperCase(), x, y, { width: col.width, align: col.align || 'left' });
    x += col.width;
  });
  doc.y = y + 12;
  const lineY = doc.y;
  doc.moveTo(MARGIN, lineY).lineTo(PAGE_WIDTH - MARGIN, lineY).lineWidth(1).stroke();
  doc.moveDown(0.3);
}

/**
 * Draw a multi-column data row.
 */
function dataRow(doc, columns, values, opts = {}) {
  if (doc.y > 750) { doc.addPage(); }
  const isBold = opts.bold || false;
  const y = doc.y;
  doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
  let x = MARGIN;
  columns.forEach((col, i) => {
    doc.text(String(values[i] || ''), x, y, { width: col.width, align: col.align || 'left' });
    x += col.width;
  });
  doc.y = y + 13;
}

/**
 * Add a signature block at the bottom.
 */
function signatureBlock(doc) {
  doc.moveDown(3);
  const y = doc.y;
  doc.font('Helvetica').fontSize(7.5).fillColor('#555');
  doc.text('Prepared and presented as a true record of the financial position for the period stated above.', MARGIN, y, { width: CONTENT_WIDTH });
  doc.moveDown(2.5);

  const sigY = doc.y;
  const sigWidth = CONTENT_WIDTH * 0.4;
  doc.moveTo(MARGIN, sigY).lineTo(MARGIN + sigWidth, sigY).lineWidth(0.5).stroke();
  doc.moveTo(MARGIN + CONTENT_WIDTH - sigWidth, sigY).lineTo(PAGE_WIDTH - MARGIN, sigY).lineWidth(0.5).stroke();

  doc.fontSize(7).fillColor('#333');
  doc.text('Treasurer / Finance Secretary', MARGIN, sigY + 4, { width: sigWidth, align: 'center' });
  doc.text('President / Chairman', MARGIN + CONTENT_WIDTH - sigWidth, sigY + 4, { width: sigWidth, align: 'center' });
  doc.fillColor('#000');
}

/**
 * Format money value.
 */
function fmtMoney(value) {
  return 'GHS ' + Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Pipe a PDFDocument to an Express response as a PDF download.
 */
function sendPdf(res, doc, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);
  doc.end();
}

module.exports = {
  createDoc,
  sectionHeading,
  tableRow,
  tableHeader,
  dataRow,
  signatureBlock,
  fmtMoney,
  sendPdf,
  MARGIN,
  CONTENT_WIDTH
};
