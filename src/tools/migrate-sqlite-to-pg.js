#!/usr/bin/env node
'use strict';

/**
 * SQLite to PostgreSQL Data Migration Tool
 *
 * One-time migration script that transfers all data from an existing SQLite
 * database to the PostgreSQL database configured via environment variables.
 *
 * Prerequisites:
 *   npm install better-sqlite3
 *
 * Usage:
 *   SQLITE_PATH=/path/to/database.db node src/tools/migrate-sqlite-to-pg.js
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8
 */

const fs = require('fs');
const path = require('path');

// ─── Load better-sqlite3 (must be installed separately) ─────────────────────
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.error('[migrate-sqlite-to-pg] ERROR: better-sqlite3 is not installed.');
  console.error('  Install it before running this migration tool:');
  console.error('    npm install better-sqlite3');
  process.exit(1);
}

const dal = require('../dal');

// ─── Table migration order (respects foreign key dependencies) ───────────────
const MIGRATION_ORDER = [
  'users',
  'members',
  'accounts',
  'fiscal_years',
  'dues_rules',
  'payment_splits',
  'transaction_categories',
  'member_dues',
  'transactions',
  'reconciliations',
  'audit_log',
];

// ─── Column definitions per table (for type conversions) ─────────────────────
// Columns marked as 'boolean' will convert 0/1 → false/true
// Columns marked as 'numeric' will be kept as NUMERIC(12,2)
// Columns marked as 'text' or 'date' are passed as-is
const TABLE_COLUMNS = {
  users: {
    columns: ['id', 'name', 'email', 'password_hash', 'role', 'active', 'created_at'],
    booleans: ['active'],
    numerics: [],
  },
  members: {
    columns: ['id', 'name', 'phone', 'dob', 'status', 'opening_arrears', 'notes', 'created_at'],
    booleans: [],
    numerics: ['opening_arrears'],
  },
  accounts: {
    columns: ['id', 'name', 'type', 'opening_balance', 'active'],
    booleans: ['active'],
    numerics: ['opening_balance'],
  },
  fiscal_years: {
    columns: ['year', 'status', 'opened_at', 'closed_at', 'closed_by', 'notes'],
    booleans: [],
    numerics: [],
  },
  dues_rules: {
    columns: ['id', 'year', 'label', 'min_age', 'max_age', 'annual_assessment', 'welfare_portion', 'active'],
    booleans: ['active'],
    numerics: ['annual_assessment', 'welfare_portion'],
  },
  payment_splits: {
    columns: ['id', 'year', 'category', 'assessment_amount', 'welfare_amount', 'active'],
    booleans: ['active'],
    numerics: ['assessment_amount', 'welfare_amount'],
  },
  transaction_categories: {
    columns: ['id', 'name', 'kind', 'active', 'sort_order'],
    booleans: ['active'],
    numerics: [],
  },
  member_dues: {
    columns: ['id', 'member_id', 'year', 'assessment_due', 'welfare_portion', 'reason'],
    booleans: [],
    numerics: ['assessment_due', 'welfare_portion'],
  },
  transactions: {
    columns: [
      'id', 'tx_date', 'tx_type', 'member_id', 'account_id', 'to_account_id',
      'category', 'description', 'amount', 'welfare_component', 'status',
      'reversed_by', 'reconciled', 'reference', 'created_by', 'created_at', 'updated_at',
    ],
    booleans: ['reconciled'],
    numerics: ['amount', 'welfare_component'],
  },
  reconciliations: {
    columns: [
      'id', 'account_id', 'period_start', 'period_end',
      'statement_balance', 'system_balance', 'difference',
      'notes', 'created_by', 'created_at',
    ],
    booleans: [],
    numerics: ['statement_balance', 'system_balance', 'difference'],
  },
  audit_log: {
    columns: [
      'id', 'user_id', 'action', 'entity', 'entity_id',
      'details', 'before_value', 'after_value', 'ip_address', 'created_at',
    ],
    booleans: [],
    numerics: [],
  },
};

// ─── Tables with SERIAL primary keys (need sequence reset) ──────────────────
// fiscal_years uses 'year' as a plain INTEGER PK (no sequence)
const SERIAL_TABLES = MIGRATION_ORDER.filter(t => t !== 'fiscal_years');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateSqlitePath() {
  const sqlitePath = process.env.SQLITE_PATH;

  if (!sqlitePath) {
    console.error('[migrate-sqlite-to-pg] ERROR: SQLITE_PATH environment variable is not set.');
    console.error('  Usage: SQLITE_PATH=/path/to/database.db node src/tools/migrate-sqlite-to-pg.js');
    process.exit(1);
  }

  const resolved = path.resolve(sqlitePath);

  if (!fs.existsSync(resolved)) {
    console.error(`[migrate-sqlite-to-pg] ERROR: File not found: ${resolved}`);
    process.exit(1);
  }

  // Validate it's a valid SQLite file by checking the magic header
  const fd = fs.openSync(resolved, 'r');
  const header = Buffer.alloc(16);
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);

  const magic = header.toString('utf8', 0, 15);
  if (magic !== 'SQLite format 3') {
    console.error(`[migrate-sqlite-to-pg] ERROR: File is not a valid SQLite database: ${resolved}`);
    process.exit(1);
  }

  return resolved;
}

/**
 * Convert a row's values based on the table's column type definitions.
 * - INTEGER booleans (0/1) → true/false
 * - REAL/numeric values → kept as numbers (pg driver handles NUMERIC conversion)
 * - TEXT dates → passed as-is
 */
function convertRow(row, tableDef) {
  const converted = { ...row };

  for (const col of tableDef.booleans) {
    if (converted[col] !== null && converted[col] !== undefined) {
      converted[col] = converted[col] === 1 || converted[col] === true;
    }
  }

  // Numeric columns: ensure null stays null, numbers stay numbers
  for (const col of tableDef.numerics) {
    if (converted[col] !== null && converted[col] !== undefined) {
      converted[col] = Number(converted[col]);
    }
  }

  return converted;
}

/**
 * Build a parameterized INSERT statement for a table.
 */
function buildInsertSQL(table, columns) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const colNames = columns.join(', ');
  return `INSERT INTO ${table} (${colNames}) VALUES (${placeholders})`;
}

/**
 * Reset SERIAL sequence for a table to MAX(id) + 1 or 1 if empty.
 */
async function resetSequence(client, table) {
  const seqName = `${table}_id_seq`;
  const result = await client.query(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${table}`);
  const maxId = result.rows[0].max_id;
  const nextVal = maxId > 0 ? maxId + 1 : 1;
  await client.query(`SELECT setval($1, $2, $3)`, [seqName, nextVal, maxId > 0]);
}

// ─── Main migration function ────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('[migrate-sqlite-to-pg] SQLite → PostgreSQL Data Migration Tool');
  console.log('─'.repeat(60));

  // 1. Validate SQLite path
  const sqlitePath = validateSqlitePath();
  console.log(`[migrate-sqlite-to-pg] Source: ${sqlitePath}`);

  // 2. Open SQLite database
  let sqliteDb;
  try {
    sqliteDb = new Database(sqlitePath, { readonly: true });
    sqliteDb.pragma('journal_mode = WAL');
  } catch (err) {
    console.error(`[migrate-sqlite-to-pg] ERROR: Failed to open SQLite database: ${err.message}`);
    process.exit(1);
  }

  // 3. Check target PG tables are empty
  console.log('[migrate-sqlite-to-pg] Checking target PostgreSQL tables...');
  for (const table of MIGRATION_ORDER) {
    const result = await dal.queryOne(`SELECT COUNT(*)::int AS count FROM ${table}`);
    if (result.count > 0) {
      console.error(`[migrate-sqlite-to-pg] ERROR: Target table "${table}" already contains ${result.count} rows.`);
      console.error('  The database is not empty. Migration cannot proceed.');
      console.error('  Clear all target tables first or use a fresh PostgreSQL database.');
      sqliteDb.close();
      await dal.shutdown();
      process.exit(1);
    }
  }
  console.log('[migrate-sqlite-to-pg] ✓ All target tables are empty.');

  // 4. Run migration within a single PG transaction
  let totalRows = 0;
  const tableSummary = [];

  try {
    await dal.transaction(async (client) => {
      // Temporarily disable triggers/constraints for bulk insert speed
      // We rely on the dependency order to satisfy FK constraints

      for (const table of MIGRATION_ORDER) {
        const tableStart = Date.now();
        const tableDef = TABLE_COLUMNS[table];

        // Get all rows from SQLite
        let rows;
        try {
          const columns = tableDef.columns.join(', ');
          rows = sqliteDb.prepare(`SELECT ${columns} FROM ${table}`).all();
        } catch (err) {
          // Table might not exist in older SQLite schemas
          if (err.message.includes('no such table')) {
            console.log(`[migrate-sqlite-to-pg]   ⊘ ${table}: table not found in source (skipping)`);
            tableSummary.push({ table, rows: 0, duration: 0, skipped: true });
            continue;
          }
          throw err;
        }

        if (rows.length === 0) {
          const duration = Date.now() - tableStart;
          console.log(`[migrate-sqlite-to-pg]   ✓ ${table}: 0 rows (empty) [${duration}ms]`);
          tableSummary.push({ table, rows: 0, duration });
          continue;
        }

        // Build INSERT statement
        const insertSQL = buildInsertSQL(table, tableDef.columns);

        // Insert each row with type conversions
        for (const row of rows) {
          const converted = convertRow(row, tableDef);
          const values = tableDef.columns.map(col => {
            const val = converted[col];
            return val === undefined ? null : val;
          });
          await client.query(insertSQL, values);
        }

        const duration = Date.now() - tableStart;
        totalRows += rows.length;
        console.log(`[migrate-sqlite-to-pg]   ✓ ${table}: ${rows.length} rows [${duration}ms]`);
        tableSummary.push({ table, rows: rows.length, duration });
      }

      // 5. Reset SERIAL sequences
      console.log('[migrate-sqlite-to-pg] Resetting sequences...');
      for (const table of SERIAL_TABLES) {
        await resetSequence(client, table);
      }
      console.log('[migrate-sqlite-to-pg] ✓ Sequences reset.');
    });
  } catch (err) {
    console.error(`[migrate-sqlite-to-pg] ERROR: Migration failed — all changes rolled back.`);
    console.error(`  Reason: ${err.message}`);
    sqliteDb.close();
    await dal.shutdown();
    process.exit(1);
  }

  // 6. Verify row counts match source
  console.log('[migrate-sqlite-to-pg] Verifying row counts...');
  let discrepancies = 0;

  for (const entry of tableSummary) {
    if (entry.skipped) continue;

    const pgResult = await dal.queryOne(`SELECT COUNT(*)::int AS count FROM ${entry.table}`);
    const pgCount = pgResult.count;

    if (pgCount !== entry.rows) {
      console.error(`[migrate-sqlite-to-pg]   ✗ ${entry.table}: expected ${entry.rows}, got ${pgCount}`);
      discrepancies++;
    } else {
      console.log(`[migrate-sqlite-to-pg]   ✓ ${entry.table}: ${pgCount} rows verified`);
    }
  }

  // 7. Close connections
  sqliteDb.close();

  // 8. Final summary
  const totalDuration = Date.now() - startTime;
  console.log('─'.repeat(60));
  console.log(`[migrate-sqlite-to-pg] Migration Summary:`);
  console.log(`  Tables migrated: ${tableSummary.filter(t => !t.skipped).length}`);
  console.log(`  Total rows:      ${totalRows}`);
  console.log(`  Total duration:  ${totalDuration}ms`);

  if (discrepancies > 0) {
    console.error(`[migrate-sqlite-to-pg] ERROR: ${discrepancies} table(s) have row count discrepancies.`);
    await dal.shutdown();
    process.exit(1);
  }

  console.log('[migrate-sqlite-to-pg] ✓ Migration completed successfully.');
  await dal.shutdown();
  process.exit(0);
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`[migrate-sqlite-to-pg] FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
