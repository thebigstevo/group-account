const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { db, audit } = require('./db');

// --- Column header aliases (case-insensitive, partial match) ---
const COLUMN_MAP = {
  name: ['name', 'full name', 'member name', 'member'],
  phone: ['phone', 'telephone', 'mobile', 'contact', 'phone number'],
  dob: ['dob', 'date of birth', 'birth date', 'birthday', 'born'],
  opening_arrears: ['opening arrears', 'arrears', 'opening balance', 'balance', 'owing', 'owed'],
  status: ['status', 'membership status']
};

function matchColumn(header) {
  const h = String(header || '').trim().toLowerCase();
  for (const [field, aliases] of Object.entries(COLUMN_MAP)) {
    if (aliases.some(a => h === a || h.includes(a))) return field;
  }
  return null;
}

function detectColumnMapping(headers) {
  const mapping = {};
  headers.forEach((header, index) => {
    const field = matchColumn(header);
    if (field && !(field in mapping)) mapping[field] = index;
  });
  return mapping;
}

// --- CSV parsing (handles quoted fields, newlines in quotes) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
      row.push(field);
      field = '';
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
      if (ch === '\r') i++;
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

// --- XLSX parsing (reused from importWorkbook.js) ---
function unzipEntries(buffer) {
  const entries = new Map();
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;

  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === eocdSignature) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('Invalid XLSX file.');

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  while (offset < centralDirectoryEnd) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);

    if (!name.endsWith('/')) {
      if (compression === 0) entries.set(name, data);
      if (compression === 8) entries.set(name, zlib.inflateRawSync(data));
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}[^>]*>[\\s\\S]*?<\\/${name}>`, 'g'))].map(m => m[0]);
}

function openTags(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g'))].map(m => m[0]);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

function xmlText(tag) {
  return tag.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function columnIndex(ref) {
  const letters = String(ref || '').match(/[A-Z]+/);
  if (!letters) return 0;
  return letters[0].split('').reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
}

function excelDate(serial) {
  const value = Number(serial);
  if (!value) return null;
  const date = new Date(Date.UTC(1899, 11, 30));
  date.setUTCDate(date.getUTCDate() + value);
  return date.toISOString().slice(0, 10);
}

function parseXlsx(buffer, sheetName) {
  const entries = unzipEntries(buffer);
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = tags(sharedXml, 'si').map(item => xmlText(item));
  const workbook = entries.get('xl/workbook.xml').toString('utf8');
  const rels = entries.get('xl/_rels/workbook.xml.rels').toString('utf8');
  const relMap = new Map(openTags(rels, 'Relationship').map(item => [attr(item, 'Id'), attr(item, 'Target')]));

  // Find the sheet — try exact match, then first sheet
  let sheetTag = openTags(workbook, 'sheet').find(item => attr(item, 'name') === sheetName);
  if (!sheetTag) sheetTag = openTags(workbook, 'sheet')[0];
  if (!sheetTag) throw new Error('No sheets found in workbook.');

  const relId = attr(sheetTag, 'r:id');
  const target = relMap.get(relId);
  const xmlPath = path.posix.join('xl', target);
  const sheet = entries.get(xmlPath).toString('utf8');

  return tags(sheet, 'row').map(rowTag => {
    const values = [];
    tags(rowTag, 'c').forEach(cell => {
      const idx = columnIndex(attr(cell, 'r')) - 1;
      const type = attr(cell, 't');
      const valueTag = cell.match(/<v>([\s\S]*?)<\/v>/);
      let value = valueTag ? valueTag[1] : '';
      if (type === 's') value = shared[Number(value)] || '';
      values[idx] = value;
    });
    return values;
  });
}

// --- Import logic ---
function importMembers(buffer, filename, userId) {
  const ext = path.extname(filename || '').toLowerCase();
  let rows;

  if (ext === '.csv' || ext === '.txt') {
    rows = parseCsv(buffer.toString('utf8'));
  } else {
    rows = parseXlsx(buffer, 'Members');
  }

  if (!rows || rows.length < 2) {
    return { imported: 0, skipped: 0, errors: ['File is empty or has no data rows.'] };
  }

  const headers = rows[0].map(h => String(h || '').trim());
  const mapping = detectColumnMapping(headers);

  if (!('name' in mapping)) {
    return { imported: 0, skipped: 0, errors: ['Could not find a "Name" column. Expected headers: Name, Phone, DOB, Opening Arrears.'] };
  }

  const upsert = db.prepare(`
    INSERT INTO members (name, opening_arrears, phone, dob, status)
    VALUES (?, ?, ?, ?, 'active')
    ON CONFLICT(name) DO UPDATE SET
      opening_arrears = CASE WHEN excluded.opening_arrears != 0 THEN excluded.opening_arrears ELSE members.opening_arrears END,
      phone = CASE WHEN excluded.phone IS NOT NULL THEN excluded.phone ELSE members.phone END,
      dob = CASE WHEN excluded.dob IS NOT NULL THEN excluded.dob ELSE members.dob END
  `);

  let imported = 0;
  let skipped = 0;
  const errors = [];

  const run = db.transaction(() => {
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row[mapping.name] || '').trim();
      if (!name) { skipped++; continue; }

      const phone = 'phone' in mapping ? String(row[mapping.phone] || '').trim() || null : null;
      const arrearsRaw = 'opening_arrears' in mapping ? row[mapping.opening_arrears] : 0;
      const arrears = Number(String(arrearsRaw || '0').replace(/[^0-9.\-]/g, '')) || 0;

      let dob = null;
      if ('dob' in mapping && row[mapping.dob]) {
        const raw = String(row[mapping.dob]).trim();
        // Try ISO date, dd/mm/yyyy, or Excel serial
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          dob = raw;
        } else if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(raw)) {
          const parts = raw.split(/[\/\-]/);
          const y = parts[2].length === 2 ? '19' + parts[2] : parts[2];
          dob = `${y}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        } else if (/^\d+$/.test(raw)) {
          dob = excelDate(raw);
        }
      }

      try {
        upsert.run(name, arrears, phone, dob);
        imported++;
      } catch (err) {
        errors.push(`Row ${i + 1} (${name}): ${err.message}`);
        skipped++;
      }
    }
  });

  run();
  audit(userId, 'import', 'members', null, `${imported} members from ${filename}`);
  return { imported, skipped, errors, mapping: Object.keys(mapping) };
}

module.exports = { importMembers, parseCsv, detectColumnMapping };
