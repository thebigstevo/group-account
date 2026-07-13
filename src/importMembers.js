const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dal = require('./dal');
const { normalizePhone } = require('./memberDomain');

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
function memberSnapshot(member) {
  return {
    name: member.name,
    opening_arrears: Number(member.opening_arrears || 0).toFixed(2),
    phone: member.phone || null,
    dob: member.dob || null,
    status: member.status
  };
}

function sameSnapshot(member, snapshot, includeIdentity = false) {
  if (!member || !snapshot) return false;
  const current = memberSnapshot(member);
  const fields = includeIdentity
    ? ['name', 'opening_arrears', 'phone', 'dob', 'status']
    : ['opening_arrears', 'phone', 'dob'];
  return fields.every(field => current[field] === snapshot[field]);
}

function summarizeBalances(values) {
  return values.reduce((summary, value) => {
    const amount = Number(value) || 0;
    if (amount > 0) summary.positive++;
    else if (amount < 0) summary.negative++;
    else summary.zero++;
    summary.total += amount;
    return summary;
  }, { positive: 0, negative: 0, zero: 0, total: 0 });
}

async function importMembers(buffer, filename, userId) {
  const safeFilename = path.basename(filename || 'member-import').slice(0, 255);
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

  let imported = 0;
  let skipped = 0;
  const errors = [];
  const importedBalances = [];
  const processedMemberIds = new Set();
  let batchId;

  await dal.transaction(async (client) => {
    const batch = await client.query(`
      INSERT INTO member_import_batches (filename, created_by)
      VALUES ($1, $2) RETURNING id
    `, [safeFilename, userId]);
    batchId = batch.rows[0].id;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row[mapping.name] || '').trim();
      if (!name) { skipped++; continue; }

      const phoneRaw = 'phone' in mapping ? String(row[mapping.phone] || '').trim() || null : null;
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
        await client.query('SAVEPOINT member_import_row');
        const phone = normalizePhone(phoneRaw);
        const matches = await client.query(`
          SELECT id, name, opening_arrears, phone, dob, status FROM members
          WHERE LOWER(name) = LOWER($1)
            AND (($2::varchar IS NOT NULL AND phone = $2) OR ($3::varchar IS NOT NULL AND dob = $3) OR ($2::varchar IS NULL AND $3::varchar IS NULL))
          ORDER BY id
          FOR UPDATE
        `, [name, phone, dob]);
        if (matches.rows.length > 1) {
          errors.push(`Row ${i + 1} (${name}): multiple possible matches; review manually.`);
          skipped++;
          await client.query('RELEASE SAVEPOINT member_import_row');
          continue;
        }
        if (matches.rows.length === 1 && processedMemberIds.has(matches.rows[0].id)) {
          errors.push(`Row ${i + 1} (${name}): duplicate member row in this file; only the first occurrence was applied.`);
          skipped++;
          await client.query('RELEASE SAVEPOINT member_import_row');
          continue;
        }
        let member;
        let action;
        let beforeValue = null;
        if (matches.rows.length === 1) {
          beforeValue = memberSnapshot(matches.rows[0]);
          const updated = await client.query(`UPDATE members SET
            opening_arrears = $1,
            phone = COALESCE($2, phone), dob = COALESCE($3, dob)
            WHERE id = $4
            RETURNING id, name, opening_arrears, phone, dob, status
          `, [arrears, phone, dob, matches.rows[0].id]);
          member = updated.rows[0];
          action = 'updated';
        } else {
          const inserted = await client.query(`
            INSERT INTO members (name, opening_arrears, phone, dob, status)
            VALUES ($1, $2, $3, $4, 'active')
            RETURNING id, name, opening_arrears, phone, dob, status, commandery_id
          `, [name, arrears, phone, dob]);
          member = inserted.rows[0];
          action = 'created';
          await client.query(`
            INSERT INTO member_status_history
              (commandery_id, member_id, previous_status, new_status, effective_date, reason, changed_by)
            VALUES ($1, $2, NULL, 'active', CURRENT_DATE, $3, $4)
          `, [member.commandery_id, member.id, `Initial status recorded during member import batch ${batchId}`, userId]);
        }
        await client.query(`
          INSERT INTO member_import_rows
            (batch_id, row_number, member_id, action, before_value, after_value)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
        `, [batchId, i + 1, member.id, action, beforeValue && JSON.stringify(beforeValue), JSON.stringify(memberSnapshot(member))]);
        await client.query('RELEASE SAVEPOINT member_import_row');
        processedMemberIds.add(member.id);
        imported++;
        importedBalances.push(arrears);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT member_import_row');
        await client.query('RELEASE SAVEPOINT member_import_row');
        errors.push(`Row ${i + 1} (${name}): ${err.message}`);
        skipped++;
      }
    }

    const summary = summarizeBalances(importedBalances);
    await client.query(`
      UPDATE member_import_batches SET
        imported_count = $1, skipped_count = $2, positive_count = $3,
        negative_count = $4, zero_count = $5, total_opening_balance = $6,
        errors = $7::jsonb
      WHERE id = $8
    `, [imported, skipped, summary.positive, summary.negative, summary.zero,
      summary.total, JSON.stringify(errors), batchId]);
    await dal.audit(userId, 'import', 'member_import_batch', batchId,
      { filename: safeFilename, imported, skipped, balanceSummary: summary }, { client });
  });

  return { imported, skipped, errors, mapping: Object.keys(mapping), batchId, balanceSummary: summarizeBalances(importedBalances) };
}

async function rollbackMemberImport(batchId, userId) {
  return dal.transaction(async (client) => {
    const batchResult = await client.query('SELECT * FROM member_import_batches WHERE id = $1 FOR UPDATE', [batchId]);
    const batch = batchResult.rows[0];
    if (!batch) throw new Error('Import batch not found.');
    if (batch.status !== 'completed') throw new Error('This import has already been reversed.');

    const rowsResult = await client.query('SELECT * FROM member_import_rows WHERE batch_id = $1 ORDER BY id DESC', [batchId]);
    const blockers = [];
    for (const row of rowsResult.rows) {
      const memberResult = await client.query(`
        SELECT id, name, opening_arrears, phone, dob, status FROM members WHERE id = $1 FOR UPDATE
      `, [row.member_id]);
      const member = memberResult.rows[0];
      const after = row.after_value;
      if (!member) {
        blockers.push(`row ${row.row_number}: member no longer exists`);
        continue;
      }
      if (!sameSnapshot(member, after, row.action === 'created')) {
        blockers.push(`row ${row.row_number} (${after.name}): member was changed after import`);
        continue;
      }
      if (row.action === 'created') {
        const dependencies = await client.query(`
          SELECT
            (SELECT COUNT(*)::int FROM transactions WHERE member_id = $1) AS transactions,
            (SELECT COUNT(*)::int FROM member_dues WHERE member_id = $1) AS dues,
            (SELECT COUNT(*)::int FROM member_emergency_contacts WHERE member_id = $1) AS contacts,
            (SELECT COUNT(*)::int FROM member_status_history
              WHERE member_id = $1 AND reason <> $2) AS later_statuses
        `, [member.id, `Initial status recorded during member import batch ${batchId}`]);
        const counts = dependencies.rows[0];
        if (counts.transactions || counts.dues || counts.contacts || counts.later_statuses) {
          blockers.push(`row ${row.row_number} (${after.name}): member has later financial or membership activity`);
        }
      }
    }
    if (blockers.length) {
      throw new Error(`Rollback stopped safely. ${blockers.slice(0, 5).join('; ')}${blockers.length > 5 ? `; and ${blockers.length - 5} more` : ''}.`);
    }

    for (const row of rowsResult.rows) {
      if (row.action === 'created') {
        await client.query('DELETE FROM member_status_history WHERE member_id = $1 AND reason = $2',
          [row.member_id, `Initial status recorded during member import batch ${batchId}`]);
        await client.query('DELETE FROM members WHERE id = $1', [row.member_id]);
      } else {
        const before = row.before_value;
        await client.query(`
          UPDATE members SET opening_arrears = $1, phone = $2, dob = $3 WHERE id = $4
        `, [before.opening_arrears, before.phone, before.dob, row.member_id]);
      }
    }
    await client.query(`
      UPDATE member_import_batches
      SET status = 'reversed', reversed_by = $1, reversed_at = NOW()
      WHERE id = $2
    `, [userId, batchId]);
    await dal.audit(userId, 'rollback', 'member_import_batch', batchId,
      { filename: batch.filename, affectedMembers: rowsResult.rows.length }, { client });
    return { affected: rowsResult.rows.length, filename: batch.filename };
  });
}

module.exports = {
  importMembers,
  rollbackMemberImport,
  parseCsv,
  detectColumnMapping,
  memberSnapshot,
  sameSnapshot,
  summarizeBalances
};
