/**
 * PDF Report Generator for Treasurio
 * Modern, colorful, professional accounting-formatted PDF documents.
 */
const PDFDocument = require('pdfkit');

const MARGIN = 45;
const PAGE_WIDTH = 595.28; // A4
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

// Brand colors
const COLORS = {
  primary: '#1e40af',       // Deep blue
  primaryLight: '#3b82f6',  // Lighter blue
  primaryBg: '#eff6ff',     // Very light blue background
  accent: '#0f766e',        // Teal for positive numbers
  danger: '#dc2626',        // Red for negative
  dark: '#1e293b',          // Near-black for headings
  muted: '#64748b',         // Gray for secondary text
  border: '#cbd5e1',        // Light gray border
  surface: '#f8fafc',       // Light surface
  white: '#ffffff'
};

/**
 * Create a standard report PDF document with a modern colored header.
 * @param {Object} opts - { title, subtitle, groupName, period, org }
 * @returns {PDFDocument}
 */
function createDoc(opts = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 50, left: MARGIN, right: MARGIN },
    info: {
      Title: opts.title || 'Report',
      Author: 'Treasurio',
      Creator: 'Treasurio Financial Management'
    }
  });

  const org = opts.org || {};

  // ─── Header Banner ───
  doc.rect(0, 0, PAGE_WIDTH, 85).fill(COLORS.primary);

  // Organization name (white on blue)
  const orgName = org.letterhead_line1 || org.name || opts.groupName || 'Organization';
  doc.font('Helvetica-Bold').fontSize(16).fillColor(COLORS.white);
  doc.text(orgName, MARGIN, 18, { width: CONTENT_WIDTH, align: 'center' });

  // Subtitle line (lighter text)
  if (org.letterhead_line2 || org.motto) {
    doc.font('Helvetica').fontSize(9).fillColor('#bfdbfe');
    doc.text(org.letterhead_line2 || org.motto, MARGIN, 38, { width: CONTENT_WIDTH, align: 'center' });
  }

  // Contact line
  if (org.letterhead_line3 || org.phone || org.email) {
    const contactLine = org.letterhead_line3 || [org.phone, org.email].filter(Boolean).join(' • ');
    doc.font('Helvetica').fontSize(7.5).fillColor('#93c5fd');
    doc.text(contactLine, MARGIN, 52, { width: CONTENT_WIDTH, align: 'center' });
  }

  // Report title bar (slightly lighter strip)
  doc.rect(0, 85, PAGE_WIDTH, 32).fill('#1d4ed8');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.white);
  doc.text(opts.title || 'Financial Report', MARGIN, 93, { width: CONTENT_WIDTH, align: 'center' });

  // Period / subtitle below the banner
  doc.fillColor(COLORS.dark);
  doc.y = 125;

  if (opts.subtitle || opts.period) {
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.muted);
    doc.text(opts.subtitle || opts.period || '', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
    doc.moveDown(0.2);
  }

  // Generated date - right aligned
  doc.fontSize(7).fillColor(COLORS.muted);
  doc.text(`Generated: ${new Date().toISOString().slice(0, 10)}`, MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'right' });
  doc.fillColor(COLORS.dark);
  doc.moveDown(0.8);

  return doc;
}

/**
 * Draw a section heading with colored accent bar.
 */
function sectionHeading(doc, text) {
  if (doc.y > 700) doc.addPage();
  doc.moveDown(0.6);

  // Accent bar
  const y = doc.y;
  doc.rect(MARGIN, y, 4, 14).fill(COLORS.primaryLight);

  doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.dark);
  doc.text(text.toUpperCase(), MARGIN + 12, y + 1, { width: CONTENT_WIDTH - 12 });
  doc.moveDown(0.5);

  // Subtle line below
  const lineY = doc.y;
  doc.moveTo(MARGIN, lineY).lineTo(PAGE_WIDTH - MARGIN, lineY).lineWidth(0.5).strokeColor(COLORS.border).stroke();
  doc.strokeColor('#000');
  doc.moveDown(0.4);
}

/**
 * Draw a table row (two columns: label + amount).
 */
function tableRow(doc, label, amount, opts = {}) {
  if (doc.y > 730) doc.addPage();
  const isBold = opts.bold || false;
  const isTotal = opts.total || false;
  const indent = opts.indent || 0;

  if (isTotal) {
    const y = doc.y - 2;
    doc.moveTo(MARGIN + CONTENT_WIDTH * 0.55, y).lineTo(PAGE_WIDTH - MARGIN, y).lineWidth(0.5).strokeColor(COLORS.border).stroke();
    doc.strokeColor('#000');
    doc.moveDown(0.1);
  }

  const fontName = isBold ? 'Helvetica-Bold' : 'Helvetica';
  const fontSize = isBold ? 9.5 : 9;
  doc.font(fontName).fontSize(fontSize);

  const startY = doc.y;

  // Label
  doc.fillColor(isBold ? COLORS.dark : '#334155');
  doc.text(label, MARGIN + indent, startY, { width: CONTENT_WIDTH * 0.6 - indent, continued: false });

  // Amount (colored for totals)
  const amountColor = isBold ? COLORS.primary : '#334155';
  doc.font(fontName).fontSize(fontSize).fillColor(amountColor);
  doc.text(String(amount), MARGIN + CONTENT_WIDTH * 0.6, startY, { width: CONTENT_WIDTH * 0.4, align: 'right' });

  doc.fillColor(COLORS.dark);
  doc.y = startY + (isBold ? 16 : 14);

  if (isTotal && isBold) {
    const y2 = doc.y;
    doc.moveTo(MARGIN + CONTENT_WIDTH * 0.55, y2).lineTo(PAGE_WIDTH - MARGIN, y2).lineWidth(1.5).strokeColor(COLORS.primary).stroke();
    doc.strokeColor('#000');
    doc.moveDown(0.4);
  }
}

/**
 * Draw a multi-column table header with colored background.
 */
function tableHeader(doc, columns) {
  if (doc.y > 700) doc.addPage();
  const y = doc.y;

  // Header background
  const headerHeight = 16;
  doc.rect(MARGIN, y - 2, CONTENT_WIDTH, headerHeight).fill(COLORS.primaryBg);

  doc.font('Helvetica-Bold').fontSize(7).fillColor(COLORS.primary);
  let x = MARGIN;
  columns.forEach(col => {
    doc.text(col.label.toUpperCase(), x + 4, y + 2, { width: col.width - 8, align: col.align || 'left' });
    x += col.width;
  });

  doc.fillColor(COLORS.dark);
  doc.y = y + headerHeight + 4;

  // Bottom border
  doc.moveTo(MARGIN, doc.y - 2).lineTo(PAGE_WIDTH - MARGIN, doc.y - 2).lineWidth(0.75).strokeColor(COLORS.primary).stroke();
  doc.strokeColor('#000');
}

/**
 * Draw a multi-column data row with alternating shading.
 */
function dataRow(doc, columns, values, opts = {}) {
  if (doc.y > 740) doc.addPage();
  const isBold = opts.bold || false;
  const rowIdx = opts.rowIndex || 0;
  const y = doc.y;

  // Alternating row background
  if (rowIdx % 2 === 0) {
    doc.rect(MARGIN, y - 1, CONTENT_WIDTH, 13).fill(COLORS.surface);
  }

  doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(COLORS.dark);
  let x = MARGIN;
  columns.forEach((col, i) => {
    const val = String(values[i] || '');
    doc.text(val, x + 4, y + 1, { width: col.width - 8, align: col.align || 'left' });
    x += col.width;
  });

  doc.fillColor(COLORS.dark);
  doc.y = y + 14;
}

/**
 * Add a modern signature block at the bottom.
 */
function signatureBlock(doc) {
  if (doc.y > 680) doc.addPage();
  doc.moveDown(2.5);

  // Separator
  const sepY = doc.y;
  doc.moveTo(MARGIN, sepY).lineTo(PAGE_WIDTH - MARGIN, sepY).lineWidth(0.5).strokeColor(COLORS.border).stroke();
  doc.strokeColor('#000');
  doc.moveDown(0.8);

  doc.font('Helvetica').fontSize(7.5).fillColor(COLORS.muted);
  doc.text('Prepared and presented as a true record of the financial position for the period stated above.', MARGIN, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(2);

  const sigY = doc.y;
  const sigWidth = CONTENT_WIDTH * 0.38;
  const gap = CONTENT_WIDTH * 0.24;

  // Signature lines
  doc.moveTo(MARGIN, sigY).lineTo(MARGIN + sigWidth, sigY).lineWidth(0.5).strokeColor(COLORS.muted).stroke();
  doc.moveTo(MARGIN + sigWidth + gap, sigY).lineTo(PAGE_WIDTH - MARGIN, sigY).lineWidth(0.5).stroke();
  doc.strokeColor('#000');

  doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted);
  doc.text('Treasurer / Finance Secretary', MARGIN, sigY + 5, { width: sigWidth, align: 'center' });
  doc.text('President / Chairman', MARGIN + sigWidth + gap, sigY + 5, { width: sigWidth, align: 'center' });

  // Footer branding
  doc.moveDown(2);
  doc.fontSize(6).fillColor(COLORS.border);
  doc.text('Generated by Treasurio Financial Management System', MARGIN, doc.y, { width: CONTENT_WIDTH, align: 'center' });
  doc.fillColor(COLORS.dark);
}

/**
 * Format money value.
 */
function fmtMoney(value) {
  const num = Number(value || 0);
  return 'GHS ' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

/**
 * Add page footer with page numbers (call before doc.end()).
 */
function addPageNumbers(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.font('Helvetica').fontSize(7).fillColor(COLORS.muted);
    doc.text(`Page ${i + 1} of ${range.count}`, MARGIN, 780, { width: CONTENT_WIDTH, align: 'center' });
  }
  doc.fillColor(COLORS.dark);
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
  addPageNumbers,
  MARGIN,
  CONTENT_WIDTH,
  COLORS
};
