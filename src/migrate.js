'use strict';

const dal = require('./dal');
const config = require('./config');

/**
 * Idempotent PostgreSQL schema migration script.
 * Creates and upgrades all tables and indexes without injecting business data.
 * Safe to run multiple times — uses idempotent DDL and guarded backfills.
 */
async function migrate() {
  return dal.transaction(async (client) => {
    const run = (sql, params = []) => client.query(sql, params);
    // PostgreSQL's CREATE ... IF NOT EXISTS is not concurrency-safe when two
    // deploy processes create the same relation simultaneously. Serialize the
    // complete migration and keep all DDL atomic.
    await run(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['treasurio-schema-migration']
    );

    console.log('[migrate] Starting PostgreSQL schema migration...');

  // ─── CREATE TABLES ────────────────────────────────────────────────────────────

  console.log('[migrate] Creating tables...');

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role VARCHAR(50) NOT NULL CHECK (role IN ('admin','finance_secretary','treasurer','viewer','auditor')),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
  await run(`
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (
      'admin','president','first_vice_president','second_vice_president',
      'secretary','finance_secretary','treasurer','auditor','trustee',
      'commander','executive','viewer'
    ))
  `);
  console.log('[migrate]   ✓ users');

  await run(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      phone VARCHAR(255),
      dob VARCHAR(10),
      status VARCHAR(50) NOT NULL DEFAULT 'active',
      opening_arrears NUMERIC(12,2) NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[migrate]   ✓ members');

  // Phase 1: commandery membership foundation. The existing members table is
  // deliberately extended so all finance foreign keys retain their meaning.
  await run(`
    CREATE TABLE IF NOT EXISTS commanderies (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      commandery_number VARCHAR(50) NOT NULL UNIQUE,
      membership_prefix VARCHAR(20) NOT NULL DEFAULT 'KSJI',
      parish VARCHAR(255),
      postal_address TEXT,
      phone VARCHAR(50),
      email VARCHAR(255),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`
    INSERT INTO commanderies (name, commandery_number, membership_prefix)
    VALUES ($1, '001', 'KSJI')
    ON CONFLICT (commandery_number) DO NOTHING
  `, [config.groupName || 'KSJI Commandery']);

  await run(`CREATE SEQUENCE IF NOT EXISTS member_membership_number_seq START 1`);
  await run(`ALTER TABLE members DROP CONSTRAINT IF EXISTS members_name_key`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS commandery_id INTEGER REFERENCES commanderies(id) ON DELETE RESTRICT`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS membership_number VARCHAR(50)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS title VARCHAR(30)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS first_name VARCHAR(120)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS middle_name VARCHAR(120)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS last_name VARCHAR(120)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS preferred_name VARCHAR(120)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS secondary_phone VARCHAR(50)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS residential_address TEXT`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS parish VARCHAR(255)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS occupation VARCHAR(255)`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS date_first_admitted DATE`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS profile_photo_path TEXT`);
  await run(`ALTER TABLE members ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW()`);
  await run(`UPDATE members SET commandery_id = (SELECT id FROM commanderies ORDER BY id LIMIT 1) WHERE commandery_id IS NULL`);
  await run(`
    UPDATE members m
    SET membership_number = c.membership_prefix || '-' || LPAD(nextval('member_membership_number_seq')::text, 6, '0')
    FROM commanderies c
    WHERE m.commandery_id = c.id AND m.membership_number IS NULL
  `);
  await run(`ALTER TABLE members DROP CONSTRAINT IF EXISTS members_status_check`);
  await run(`UPDATE members SET status = 'resigned' WHERE status = 'inactive'`);
  await run(`ALTER TABLE members ALTER COLUMN commandery_id SET NOT NULL`);
  await run(`ALTER TABLE members ALTER COLUMN membership_number SET NOT NULL`);
  await run(`ALTER TABLE members ADD CONSTRAINT members_status_check CHECK (status IN ('active','suspended','expelled','transferred','resigned'))`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_membership_number ON members(membership_number)`);

  await run(`
    CREATE OR REPLACE FUNCTION assign_member_foundation_defaults()
    RETURNS TRIGGER AS $$
    DECLARE member_prefix VARCHAR(20);
    BEGIN
      IF NEW.commandery_id IS NULL THEN
        SELECT id INTO NEW.commandery_id FROM commanderies WHERE active = true ORDER BY id LIMIT 1;
      END IF;
      IF NEW.membership_number IS NULL OR BTRIM(NEW.membership_number) = '' THEN
        SELECT membership_prefix INTO member_prefix FROM commanderies WHERE id = NEW.commandery_id;
        NEW.membership_number := COALESCE(member_prefix, 'KSJI') || '-' || LPAD(nextval('member_membership_number_seq')::text, 6, '0');
      END IF;
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await run(`DROP TRIGGER IF EXISTS trg_member_foundation_defaults ON members`);
  await run(`
    CREATE TRIGGER trg_member_foundation_defaults
    BEFORE INSERT OR UPDATE ON members
    FOR EACH ROW EXECUTE FUNCTION assign_member_foundation_defaults()
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS member_status_history (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id) ON DELETE RESTRICT,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
      previous_status VARCHAR(50),
      new_status VARCHAR(50) NOT NULL CHECK (new_status IN ('active','suspended','expelled','transferred','resigned')),
      effective_date DATE NOT NULL,
      reason TEXT NOT NULL,
      supporting_reference VARCHAR(255),
      changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`
    INSERT INTO member_status_history (commandery_id, member_id, previous_status, new_status, effective_date, reason)
    SELECT commandery_id, id, NULL, status, COALESCE(date_first_admitted, created_at::date), 'Initial status recorded during membership foundation migration'
    FROM members m
    WHERE NOT EXISTS (SELECT 1 FROM member_status_history h WHERE h.member_id = m.id)
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS member_emergency_contacts (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id) ON DELETE RESTRICT,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
      name VARCHAR(255) NOT NULL,
      relationship VARCHAR(120) NOT NULL,
      primary_phone VARCHAR(50) NOT NULL,
      secondary_phone VARCHAR(50),
      address TEXT,
      notes TEXT,
      is_primary BOOLEAN NOT NULL DEFAULT false,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[migrate]   ✓ commandery membership foundation');

  await run(`
    CREATE TABLE IF NOT EXISTS member_import_batches (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','reversed')),
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      positive_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      zero_count INTEGER NOT NULL DEFAULT 0,
      total_opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      errors JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      reversed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reversed_at TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS member_import_rows (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES member_import_batches(id) ON DELETE RESTRICT,
      row_number INTEGER NOT NULL,
      member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      action VARCHAR(20) NOT NULL CHECK (action IN ('created','updated')),
      before_value JSONB,
      after_value JSONB NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_member_import_batches_created_at ON member_import_batches(created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_member_import_rows_batch_id ON member_import_rows(batch_id)`);
  console.log('[migrate]   ✓ member import history');

  await run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      type VARCHAR(50) NOT NULL CHECK (type IN ('cash','bank','mobile_money')),
      opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `);
  console.log('[migrate]   ✓ accounts');

  await run(`
    CREATE TABLE IF NOT EXISTS fiscal_years (
      year INTEGER PRIMARY KEY,
      status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      is_active BOOLEAN NOT NULL DEFAULT false,
      opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMP,
      closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT
    )
  `);
  await run(`ALTER TABLE fiscal_years ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT false`);
  await run(`UPDATE fiscal_years SET is_active = false WHERE status = 'closed' AND is_active = true`);
  await run(`
    UPDATE fiscal_years SET is_active = true
    WHERE year = (SELECT MAX(year) FROM fiscal_years WHERE status = 'open')
      AND NOT EXISTS (SELECT 1 FROM fiscal_years WHERE is_active = true)
  `);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_years_one_active ON fiscal_years(is_active) WHERE is_active = true`);
  await run(`ALTER TABLE member_import_batches ADD COLUMN IF NOT EXISTS fiscal_year INTEGER REFERENCES fiscal_years(year) ON DELETE RESTRICT`);
  console.log('[migrate]   ✓ fiscal_years');

  await run(`
    CREATE TABLE IF NOT EXISTS dues_rules (
      id SERIAL PRIMARY KEY,
      year INTEGER NOT NULL,
      label VARCHAR(255) NOT NULL,
      min_age INTEGER,
      max_age INTEGER,
      annual_assessment NUMERIC(12,2) NOT NULL DEFAULT 0,
      welfare_portion NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(year, label)
    )
  `);
  console.log('[migrate]   ✓ dues_rules');

  await run(`
    CREATE TABLE IF NOT EXISTS payment_splits (
      id SERIAL PRIMARY KEY,
      year INTEGER NOT NULL,
      category VARCHAR(255) NOT NULL,
      assessment_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      welfare_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      UNIQUE(year, category)
    )
  `);
  console.log('[migrate]   ✓ payment_splits');

  await run(`
    CREATE TABLE IF NOT EXISTS transaction_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      kind VARCHAR(50) NOT NULL CHECK (kind IN ('income','expense')),
      purpose VARCHAR(30) NOT NULL DEFAULT 'standard',
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 100
    )
  `);
  await run(`ALTER TABLE transaction_categories ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) NOT NULL DEFAULT 'standard'`);
  await run(`UPDATE transaction_categories SET purpose = 'assessment' WHERE name = 'Assessment' AND purpose = 'standard'`);
  await run(`UPDATE transaction_categories SET purpose = 'welfare_income' WHERE name = 'Welfare' AND purpose = 'standard'`);
  await run(`UPDATE transaction_categories SET purpose = 'welfare_payout' WHERE name = 'Welfare Payout' AND purpose = 'standard'`);
  await run(`ALTER TABLE transaction_categories DROP CONSTRAINT IF EXISTS transaction_categories_purpose_check`);
  await run(`ALTER TABLE transaction_categories ADD CONSTRAINT transaction_categories_purpose_check CHECK (purpose IN ('standard','assessment','welfare_income','welfare_payout'))`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_categories_unique_active_purpose ON transaction_categories(purpose) WHERE active = true AND purpose <> 'standard'`);
  console.log('[migrate]   ✓ transaction_categories');

  await run(`
    CREATE TABLE IF NOT EXISTS member_dues (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      assessment_due NUMERIC(12,2) NOT NULL DEFAULT 0,
      welfare_portion NUMERIC(12,2) NOT NULL DEFAULT 0,
      reason TEXT,
      UNIQUE(member_id, year)
    )
  `);
  console.log('[migrate]   ✓ member_dues');

  await run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      tx_date VARCHAR(10) NOT NULL,
      tx_type VARCHAR(50) NOT NULL CHECK (tx_type IN ('receipt','expense','transfer','welfare_payout')),
      member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
      to_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
      category VARCHAR(255) NOT NULL,
      description TEXT,
      amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
      welfare_component NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (welfare_component >= 0),
      status VARCHAR(20) NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
      reversed_by INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      reconciled BOOLEAN NOT NULL DEFAULT false,
      reference TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP
    )
  `);
  console.log('[migrate]   ✓ transactions');

  await run(`
    CREATE TABLE IF NOT EXISTS reconciliations (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      period_start VARCHAR(10) NOT NULL,
      period_end VARCHAR(10) NOT NULL,
      statement_balance NUMERIC(12,2) NOT NULL,
      system_balance NUMERIC(12,2) NOT NULL,
      difference NUMERIC(12,2) NOT NULL,
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[migrate]   ✓ reconciliations');

  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      action VARCHAR(255) NOT NULL,
      entity VARCHAR(255) NOT NULL,
      entity_id INTEGER,
      details TEXT,
      before_value TEXT,
      after_value TEXT,
      ip_address VARCHAR(255),
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS before_value TEXT`);
  await run(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS after_value TEXT`);
  await run(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS ip_address VARCHAR(255)`);
  await run(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT`);
  await run(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS reason TEXT`);
  console.log('[migrate]   ✓ audit_log');

  // Sessions table for connect-pg-simple
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    )
  `);
  console.log('[migrate]   ✓ sessions');

  // ─── CREATE INDEXES ───────────────────────────────────────────────────────────

  console.log('[migrate] Creating indexes...');

  await run(`CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(tx_date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_transactions_type_status ON transactions(tx_type, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_transactions_member_year ON transactions(member_id, tx_date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, tx_date)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_reconciliations_account_period ON reconciliations(account_id, period_start, period_end)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_members_commandery_status ON members(commandery_id, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_member_status_history_member_date ON member_status_history(member_id, effective_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_emergency_contacts_member ON member_emergency_contacts(member_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)`);

  console.log('[migrate]   ✓ Indexes created');

  // Business-specific accounts, categories, and dues are configured in the application.

  console.log('[migrate] Migration complete.');
  });
}

// Run from the CLI; exporting the function also allows CI to exercise the
// migration contract with an isolated DAL.
if (require.main === module) {
  migrate()
    .then(() => dal.shutdown())
    .then(() => {
      console.log('[migrate] Done. Pool closed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate] Migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { migrate };
