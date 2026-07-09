const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { db, audit } = require('./db');

const workbookPath = process.env.WORKBOOK_PATH || process.argv[2];
if (!workbookPath) {
  console.error('Set WORKBOOK_PATH or pass the workbook path as the first argument.');
  process.exit(1);
}

function unzipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  const entries = new Map();
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;

  for (let index = buffer.length - 22; index >= 0; index -= 1) {
    if (buffer.readUInt32LE(index) === eocdSignature) {
      eocdOffset = index;
      break;
    }
  }

  if (eocdOffset === -1) throw new Error('Invalid ZIP file: central directory not found.');

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;

  while (offset < centralDirectoryEnd) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x02014b50) break;

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
  const pattern = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'g');
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function openTags(xml, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*(?:\\/>|>[\\s\\S]*?<\\/${name}>)`, 'g');
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : '';
}

function text(tag) {
  return tag.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

function columnIndex(ref) {
  const letters = String(ref || '').match(/[A-Z]+/);
  if (!letters) return 0;
  return letters[0].split('').reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function excelDate(serial) {
  const value = Number(serial);
  if (!value) return null;
  const date = new Date(Date.UTC(1899, 11, 30));
  date.setUTCDate(date.getUTCDate() + value);
  return date.toISOString().slice(0, 10);
}

function readSheetRows(entries, sheetName) {
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = tags(sharedXml, 'si').map((item) => text(item));

  const workbook = entries.get('xl/workbook.xml').toString('utf8');
  const rels = entries.get('xl/_rels/workbook.xml.rels').toString('utf8');
  const relMap = new Map(openTags(rels, 'Relationship').map((item) => [attr(item, 'Id'), attr(item, 'Target')]));
  const sheetTag = openTags(workbook, 'sheet').find((item) => attr(item, 'name') === sheetName);
  if (!sheetTag) throw new Error(`Sheet not found: ${sheetName}`);

  const relId = attr(sheetTag, 'r:id');
  const target = relMap.get(relId);
  const xmlPath = path.posix.join('xl', target);
  const sheet = entries.get(xmlPath).toString('utf8');

  return tags(sheet, 'row').map((rowTag) => {
    const values = [];
    tags(rowTag, 'c').forEach((cell) => {
      const index = columnIndex(attr(cell, 'r')) - 1;
      const type = attr(cell, 't');
      const valueTag = cell.match(/<v>([\s\S]*?)<\/v>/);
      let value = valueTag ? valueTag[1] : '';
      if (type === 's') value = shared[Number(value)] || '';
      values[index] = value;
    });
    return values;
  });
}

const entries = unzipEntries(workbookPath);
const rows = readSheetRows(entries, 'Members');
const dataRows = rows.slice(1).filter((row) => row[0]);

const upsert = db.prepare(`
  INSERT INTO members (name, opening_arrears, phone, dob, status)
  VALUES (?, ?, ?, ?, 'active')
  ON CONFLICT(name) DO UPDATE SET
    opening_arrears = excluded.opening_arrears,
    phone = excluded.phone,
    dob = excluded.dob
`);

let imported = 0;
const importMany = db.transaction(() => {
  for (const row of dataRows) {
    upsert.run(
      String(row[0] || '').trim(),
      Number(row[1] || 0),
      row[2] ? String(row[2]).trim() : null,
      row[3] ? excelDate(row[3]) : null
    );
    imported += 1;
  }
});

importMany();
audit(null, 'import', 'workbook', null, `${imported} members from ${workbookPath}`);
console.log(`Imported or updated ${imported} members.`);
