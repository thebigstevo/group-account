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
    CREATE TABLE IF NOT EXISTS fund_classifications (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      is_default BOOLEAN NOT NULL DEFAULT false,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`
    INSERT INTO fund_classifications (code, name, is_default)
    VALUES ('mens_operating', 'Men''s Operating Funds', true)
    ON CONFLICT (code) DO NOTHING
  `);
  await run(`
    INSERT INTO fund_classifications (code, name, is_default)
    VALUES ('joint_welfare', 'Joint Welfare Funds Held', false)
    ON CONFLICT (code) DO NOTHING
  `);
  console.log('[migrate]   ✓ fund_classifications');

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
      kind VARCHAR(50) NOT NULL CHECK (kind IN ('income','expense','both')),
      purpose VARCHAR(30) NOT NULL DEFAULT 'standard',
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 100
    )
  `);
  await run(`ALTER TABLE transaction_categories ADD COLUMN IF NOT EXISTS purpose VARCHAR(30) NOT NULL DEFAULT 'standard'`);
  await run(`ALTER TABLE transaction_categories DROP CONSTRAINT IF EXISTS transaction_categories_kind_check`);
  await run(`ALTER TABLE transaction_categories ADD CONSTRAINT transaction_categories_kind_check CHECK (kind IN ('income','expense','both'))`);
  await run(`UPDATE transaction_categories SET purpose = 'assessment' WHERE name = 'Assessment' AND purpose = 'standard'`);
  await run(`UPDATE transaction_categories SET purpose = 'welfare_income' WHERE name = 'Welfare' AND purpose = 'standard'`);
  await run(`UPDATE transaction_categories SET purpose = 'welfare_payout' WHERE name = 'Welfare Payout' AND purpose = 'standard'`);
  await run(`ALTER TABLE transaction_categories DROP CONSTRAINT IF EXISTS transaction_categories_purpose_check`);
  await run(`ALTER TABLE transaction_categories ADD CONSTRAINT transaction_categories_purpose_check CHECK (purpose IN ('standard','assessment','welfare_income','welfare_payout'))`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transaction_categories_unique_active_purpose ON transaction_categories(purpose) WHERE active = true AND purpose <> 'standard'`);
  console.log('[migrate]   ✓ transaction_categories');

  await run(`
    CREATE TABLE IF NOT EXISTS annual_budgets (
      year INTEGER PRIMARY KEY REFERENCES fiscal_years(year) ON DELETE RESTRICT,
      status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      approved_at TIMESTAMP
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS annual_budget_lines (
      id SERIAL PRIMARY KEY,
      year INTEGER NOT NULL REFERENCES annual_budgets(year) ON DELETE CASCADE,
      category VARCHAR(255) NOT NULL REFERENCES transaction_categories(name) ON UPDATE CASCADE ON DELETE RESTRICT,
      kind VARCHAR(20) NOT NULL CHECK (kind IN ('income','expense')),
      amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(year, category, kind)
    )
  `);
  console.log('[migrate]   ✓ annual budgets');

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
    CREATE TABLE IF NOT EXISTS receipt_allocations (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE RESTRICT,
      fund_classification_id INTEGER NOT NULL REFERENCES fund_classifications(id) ON DELETE RESTRICT,
      amount NUMERIC(12,2) NOT NULL,
      category VARCHAR(255),
      description TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_receipt_allocations_tx ON receipt_allocations(transaction_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_receipt_allocations_fund ON receipt_allocations(fund_classification_id)`);
  console.log('[migrate]   ✓ receipt_allocations');

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

  await run(`
    CREATE TABLE IF NOT EXISTS audit_reviews (
      id SERIAL PRIMARY KEY,
      year INTEGER NOT NULL REFERENCES fiscal_years(year) ON DELETE RESTRICT,
      status VARCHAR(20) NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed')),
      scope_start VARCHAR(10) NOT NULL,
      scope_end VARCHAR(10) NOT NULL,
      overall_notes TEXT,
      started_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      started_at TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMP,
      UNIQUE(year)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS audit_review_items (
      id SERIAL PRIMARY KEY,
      review_id INTEGER NOT NULL REFERENCES audit_reviews(id) ON DELETE CASCADE,
      item_key VARCHAR(60) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','pass','exception','not_applicable')),
      notes TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      UNIQUE(review_id, item_key)
    )
  `);
  console.log('[migrate]   ✓ trustee audit reviews');

  // Lookup table: available ranks (admin-managed)
  await run(`
    CREATE TABLE IF NOT EXISTS rank_definitions (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id),
      title VARCHAR(100) NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT chk_rank_def_title CHECK (char_length(title) >= 1)
    )
  `);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rank_definitions_unique ON rank_definitions(commandery_id, title)`);
  console.log('[migrate]   ✓ rank_definitions');

  // Lookup table: available positions (admin-managed)
  await run(`
    CREATE TABLE IF NOT EXISTS position_definitions (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id),
      title VARCHAR(100) NOT NULL,
      level VARCHAR(50) NOT NULL DEFAULT 'local_commandery',
      sort_order INTEGER DEFAULT 0,
      active BOOLEAN DEFAULT TRUE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT chk_position_def_title CHECK (char_length(title) >= 1),
      CONSTRAINT chk_position_level CHECK (level IN ('local_commandery', 'district_regiment', 'grand_commandery', 'supreme_subordinate', 'supreme_commandery'))
    )
  `);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_position_definitions_unique ON position_definitions(commandery_id, title, level)`);
  console.log('[migrate]   ✓ position_definitions');

  // Member rank history (immutable records)
  await run(`
    CREATE TABLE IF NOT EXISTS member_rank_history (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id),
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      rank_title VARCHAR(100) NOT NULL,
      date_conferred DATE NOT NULL,
      conferring_authority VARCHAR(200),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT chk_rank_title_length CHECK (char_length(rank_title) >= 1),
      CONSTRAINT chk_date_not_future CHECK (date_conferred <= CURRENT_DATE)
    )
  `);
  console.log('[migrate]   ✓ member_rank_history');

  // Member degree history (1st through 5th degree - immutable records)
  await run(`
    CREATE TABLE IF NOT EXISTS member_degrees (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id),
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      degree INTEGER NOT NULL,
      date_conferred DATE NOT NULL,
      conferring_authority VARCHAR(200),
      notes VARCHAR(500),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT chk_degree_range CHECK (degree BETWEEN 1 AND 5),
      CONSTRAINT chk_degree_date_not_future CHECK (date_conferred <= CURRENT_DATE)
    )
  `);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_degrees_unique ON member_degrees(member_id, degree)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_member_degrees_member ON member_degrees(member_id)`);
  console.log('[migrate]   ✓ member_degrees');

  // Member position history
  await run(`
    CREATE TABLE IF NOT EXISTS member_position_history (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id),
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      position_title VARCHAR(100) NOT NULL,
      position_level VARCHAR(50) NOT NULL DEFAULT 'local_commandery',
      start_date DATE NOT NULL,
      end_date DATE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP,
      CONSTRAINT chk_position_title_length CHECK (char_length(position_title) BETWEEN 1 AND 100),
      CONSTRAINT chk_start_not_future CHECK (start_date <= CURRENT_DATE),
      CONSTRAINT chk_end_after_start CHECK (end_date IS NULL OR end_date >= start_date),
      CONSTRAINT chk_pos_level CHECK (position_level IN ('local_commandery', 'district_regiment', 'grand_commandery', 'supreme_subordinate', 'supreme_commandery'))
    )
  `);
  // Add level column if upgrading from previous schema
  await run(`ALTER TABLE member_position_history ADD COLUMN IF NOT EXISTS position_level VARCHAR(50) NOT NULL DEFAULT 'local_commandery'`);
  console.log('[migrate]   ✓ member_position_history');

  // Member transfer records (one per member max)
  await run(`
    CREATE TABLE IF NOT EXISTS member_transfers (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id),
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      origin_commandery_name VARCHAR(150) NOT NULL,
      transfer_date DATE NOT NULL,
      reference_number VARCHAR(100),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP,
      CONSTRAINT chk_origin_length CHECK (char_length(origin_commandery_name) >= 1),
      CONSTRAINT chk_transfer_not_future CHECK (transfer_date <= CURRENT_DATE)
    )
  `);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_member_transfers_member_id ON member_transfers(member_id)`);
  console.log('[migrate]   ✓ member_transfers');

  // Audit transaction flags
  await run(`
    CREATE TABLE IF NOT EXISTS audit_flags (
      id SERIAL PRIMARY KEY,
      review_id INTEGER NOT NULL REFERENCES audit_reviews(id),
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      reason VARCHAR(1000) NOT NULL,
      flagged_by INTEGER NOT NULL REFERENCES users(id),
      flagged_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT chk_flag_reason_length CHECK (char_length(reason) >= 1 AND char_length(reason) <= 1000)
    )
  `);
  console.log('[migrate]   ✓ audit_flags');

  // Audit transaction investigation notes
  await run(`
    CREATE TABLE IF NOT EXISTS audit_transaction_notes (
      id SERIAL PRIMARY KEY,
      review_id INTEGER NOT NULL REFERENCES audit_reviews(id),
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      note VARCHAR(1000) NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      CONSTRAINT chk_note_length CHECK (char_length(note) >= 1 AND char_length(note) <= 1000)
    )
  `);
  console.log('[migrate]   ✓ audit_transaction_notes');

  // Enhance audit_reviews with overall_conclusion and recommendation columns
  await run(`ALTER TABLE audit_reviews ADD COLUMN IF NOT EXISTS overall_conclusion TEXT`);
  await run(`ALTER TABLE audit_reviews ADD COLUMN IF NOT EXISTS recommendation VARCHAR(5000)`);
  console.log('[migrate]   ✓ audit_reviews enhanced (overall_conclusion, recommendation)');

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
  await run(`CREATE INDEX IF NOT EXISTS idx_budget_lines_year_kind ON annual_budget_lines(year, kind)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_review_items_review ON audit_review_items(review_id, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_members_commandery_status ON members(commandery_id, status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_member_status_history_member_date ON member_status_history(member_id, effective_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_emergency_contacts_member ON member_emergency_contacts(member_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_rank_history_member ON member_rank_history(member_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_position_history_member ON member_position_history(member_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_flags_review ON audit_flags(review_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_flags_transaction ON audit_flags(transaction_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_notes_review ON audit_transaction_notes(review_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_audit_notes_transaction ON audit_transaction_notes(transaction_id)`);

  console.log('[migrate]   ✓ Indexes created');

  // ─── Welfare auto-split: designate an account as the welfare fund target ───
  await run(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_welfare_fund BOOLEAN NOT NULL DEFAULT false`);
  console.log('[migrate]   ✓ accounts.is_welfare_fund column');

  // ─── Split transaction linking ───
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS split_group_id INTEGER`);
  await run(`CREATE INDEX IF NOT EXISTS idx_transactions_split_group ON transactions(split_group_id) WHERE split_group_id IS NOT NULL`);
  console.log('[migrate]   ✓ transactions.split_group_id column');

  // ─── Transaction reversal & lifecycle columns ───
  // Expand status check to include 'draft'
  await run(`ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check`);
  await run(`ALTER TABLE transactions ADD CONSTRAINT transactions_status_check CHECK (status IN ('draft', 'posted', 'reversed'))`);

  // Reversal metadata columns
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reversal_transaction_id INTEGER REFERENCES transactions(id)`);
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reverses_transaction_id INTEGER REFERENCES transactions(id)`);
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMP`);
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reversed_by_user INTEGER REFERENCES users(id)`);
  await run(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reversal_reason TEXT`);

  // Ensure reversal is a one-to-one relationship
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_reversal_unique ON transactions(reverses_transaction_id) WHERE reverses_transaction_id IS NOT NULL`);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_reversed_unique ON transactions(reversal_transaction_id) WHERE reversal_transaction_id IS NOT NULL`);
  console.log('[migrate]   ✓ transactions reversal & lifecycle columns');

  // ─── Migrate existing reversal metadata ───
  // Move data from the old reversed_by column into the new reversal_transaction_id /
  // reverses_transaction_id columns, and fix reversal entry status to 'posted'.
  const migrationCheck = await run(`SELECT COUNT(*) AS cnt FROM transactions WHERE reversal_transaction_id IS NOT NULL`);
  if (migrationCheck.rows[0].cnt === '0' || parseInt(migrationCheck.rows[0].cnt) === 0) {
    // Only run if not already migrated
    // Step 1: For each original tx (status='reversed', reversed_by IS NOT NULL),
    // set reversal_transaction_id = reversed_by (pointing to the reversal entry)
    await run(`
      UPDATE transactions
      SET reversal_transaction_id = reversed_by
      WHERE status = 'reversed'
        AND reversed_by IS NOT NULL
        AND reversal_transaction_id IS NULL
    `);

    // Step 2: For each reversal entry (pointed to by an original's reversed_by),
    // set reverses_transaction_id = original.id and status = 'posted'
    // so reversals participate in balance calculations
    await run(`
      UPDATE transactions AS rev
      SET reverses_transaction_id = orig.id,
          status = 'posted'
      FROM transactions AS orig
      WHERE orig.status = 'reversed'
        AND orig.reversed_by IS NOT NULL
        AND orig.reversed_by = rev.id
        AND rev.reverses_transaction_id IS NULL
    `);

    console.log('[migrate]   ✓ reversal metadata migrated');
  } else {
    console.log('[migrate]   ✓ reversal metadata already migrated (skipped)');
  }

  // ─── Backfill receipt_allocations for existing transactions ───
  const allocCheck = await run(`SELECT COUNT(*) AS cnt FROM receipt_allocations`);
  if (parseInt(allocCheck.rows[0].cnt) === 0) {
    // Look up fund classification IDs by code
    const opFundRow = await run(`SELECT id FROM fund_classifications WHERE code = 'mens_operating'`);
    const wfFundRow = await run(`SELECT id FROM fund_classifications WHERE code = 'joint_welfare'`);
    const operatingFundId = opFundRow.rows[0].id;
    const welfareFundId = wfFundRow.rows[0].id;

    // Identify the welfare account (used for split-pair detection)
    const welfareAcctRow = await run(`SELECT id FROM accounts WHERE is_welfare_fund = true LIMIT 1`);
    const welfareAcctId = welfareAcctRow.rows.length > 0 ? welfareAcctRow.rows[0].id : null;

    // --- Split-pair receipts (same split_group_id) ---
    if (welfareAcctId) {
      const splitGroups = await run(`
        SELECT DISTINCT split_group_id
        FROM transactions
        WHERE split_group_id IS NOT NULL
          AND tx_type = 'receipt'
          AND status = 'posted'
      `);

      for (const row of splitGroups.rows) {
        const groupId = row.split_group_id;
        const siblings = await run(
          `SELECT * FROM transactions WHERE split_group_id = $1 AND tx_type = 'receipt' AND status = 'posted' ORDER BY id`,
          [groupId]
        );

        if (siblings.rows.length < 2) continue;

        // Determine which is operating leg and which is welfare leg
        const welfareLeg = siblings.rows.find(r => parseInt(r.account_id) === parseInt(welfareAcctId));
        const operatingLeg = siblings.rows.find(r => parseInt(r.account_id) !== parseInt(welfareAcctId));

        if (!welfareLeg || !operatingLeg) continue;

        const operatingAmount = parseFloat(operatingLeg.amount);
        const welfareAmount = parseFloat(welfareLeg.amount);
        const totalAmount = operatingAmount + welfareAmount;

        // Update operating leg: set amount to total, welfare_component to welfare amount
        await run(
          `UPDATE transactions SET amount = $1, welfare_component = $2 WHERE id = $3`,
          [totalAmount, welfareAmount, operatingLeg.id]
        );

        // Create allocations for the operating leg
        await run(
          `INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount) VALUES ($1, $2, $3)`,
          [operatingLeg.id, operatingFundId, operatingAmount]
        );
        await run(
          `INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount) VALUES ($1, $2, $3)`,
          [operatingLeg.id, welfareFundId, welfareAmount]
        );

        // Mark welfare leg as superseded
        await run(
          `UPDATE transactions SET status = 'reversed', description = $1 WHERE id = $2`,
          ['MIGRATED: merged into tx #' + operatingLeg.id, welfareLeg.id]
        );
      }
    }

    // --- Non-split receipts with welfare_component > 0 ---
    const welfareReceipts = await run(`
      SELECT id, amount, welfare_component
      FROM transactions
      WHERE tx_type = 'receipt'
        AND status = 'posted'
        AND (split_group_id IS NULL)
        AND welfare_component > 0
        AND id NOT IN (SELECT transaction_id FROM receipt_allocations)
    `);
    for (const tx of welfareReceipts.rows) {
      const total = parseFloat(tx.amount);
      const welfare = parseFloat(tx.welfare_component);
      const operating = total - welfare;

      await run(
        `INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount) VALUES ($1, $2, $3)`,
        [tx.id, operatingFundId, operating]
      );
      await run(
        `INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount) VALUES ($1, $2, $3)`,
        [tx.id, welfareFundId, welfare]
      );
    }

    // --- Non-split receipts with no welfare component ---
    const plainReceipts = await run(`
      SELECT id, amount
      FROM transactions
      WHERE tx_type = 'receipt'
        AND status = 'posted'
        AND (split_group_id IS NULL)
        AND (welfare_component = 0 OR welfare_component IS NULL)
        AND id NOT IN (SELECT transaction_id FROM receipt_allocations)
    `);
    for (const tx of plainReceipts.rows) {
      await run(
        `INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount) VALUES ($1, $2, $3)`,
        [tx.id, operatingFundId, parseFloat(tx.amount)]
      );
    }

    // --- Expenses → mens_operating ---
    const expenses = await run(`
      SELECT id, amount
      FROM transactions
      WHERE tx_type = 'expense'
        AND status = 'posted'
        AND id NOT IN (SELECT transaction_id FROM receipt_allocations)
    `);
    for (const tx of expenses.rows) {
      await run(
        `INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount) VALUES ($1, $2, $3)`,
        [tx.id, operatingFundId, parseFloat(tx.amount)]
      );
    }

    // --- Welfare payouts → joint_welfare ---
    const welfarePay = await run(`
      SELECT id, amount
      FROM transactions
      WHERE tx_type = 'welfare_payout'
        AND status = 'posted'
        AND id NOT IN (SELECT transaction_id FROM receipt_allocations)
    `);
    for (const tx of welfarePay.rows) {
      await run(
        `INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount) VALUES ($1, $2, $3)`,
        [tx.id, welfareFundId, parseFloat(tx.amount)]
      );
    }

    console.log('[migrate]   ✓ receipt_allocations backfilled');
  } else {
    console.log('[migrate]   ✓ receipt_allocations already backfilled (skipped)');
  }

  // ─── Remove is_welfare_fund column and verify migration ───
  await run(`ALTER TABLE accounts DROP COLUMN IF EXISTS is_welfare_fund`);

  const verifyResult = await run(`
    SELECT t.id, t.amount, COALESCE(SUM(ra.amount), 0) AS alloc_total
    FROM transactions t
    LEFT JOIN receipt_allocations ra ON ra.transaction_id = t.id
    WHERE t.status = 'posted' AND t.tx_type IN ('receipt', 'expense', 'welfare_payout')
    GROUP BY t.id, t.amount
    HAVING ABS(t.amount - COALESCE(SUM(ra.amount), 0)) > 0.01
  `);
  if (verifyResult.rows.length > 0) {
    console.warn('[migrate]   ⚠ Allocation mismatch found for transactions:', verifyResult.rows.map(r => r.id).join(', '));
  } else {
    console.log('[migrate]   ✓ receipt_allocations verification passed');
  }

  // ─── Repair welfare allocations created before effective dues rules were
  //     connected to the fund-allocation model. A history marker prevents
  //     later dues changes from rewriting historical transactions.
  await run(`
    CREATE TABLE IF NOT EXISTS migration_history (
      key VARCHAR(120) PRIMARY KEY,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW(),
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  const welfareRepairKey = '2026-08-effective-welfare-allocations-v1';
  const welfareRepairDone = await run('SELECT key FROM migration_history WHERE key = $1', [welfareRepairKey]);
  if (welfareRepairDone.rows.length === 0) {
    const opFund = await run("SELECT id FROM fund_classifications WHERE code = 'mens_operating' AND active = true");
    const wfFund = await run("SELECT id FROM fund_classifications WHERE code = 'joint_welfare' AND active = true");
    if (!opFund.rows[0] || !wfFund.rows[0]) throw new Error('Required fund classifications are missing');

    const candidates = await run(`
      SELECT
        t.id, t.amount, t.category, t.reverses_transaction_id,
        tc.purpose,
        COALESCE(md.assessment_due, dr.annual_assessment, 0) AS assessment_due,
        COALESCE(md.welfare_portion, dr.welfare_portion, 0) AS dues_welfare,
        COALESCE(ps.assessment_amount, 0) AS split_assessment,
        COALESCE(ps.welfare_amount, 0) AS split_welfare,
        COALESCE(t.welfare_component, 0) AS current_welfare,
        COALESCE((
          SELECT SUM(ra.amount)
          FROM receipt_allocations ra
          WHERE ra.transaction_id = t.id
            AND ra.fund_classification_id = $1
        ), 0) AS current_welfare_allocation
      FROM transactions t
      JOIN transaction_categories tc ON tc.name = t.category
      LEFT JOIN members m ON m.id = t.member_id
      LEFT JOIN member_dues md
        ON md.member_id = t.member_id
        AND md.year = SUBSTRING(t.tx_date FROM 1 FOR 4)::int
      LEFT JOIN LATERAL (
        SELECT annual_assessment, welfare_portion
        FROM dues_rules rule
        WHERE rule.year = SUBSTRING(t.tx_date FROM 1 FOR 4)::int
          AND rule.active = true
          AND (
            rule.min_age IS NULL OR m.dob IS NULL OR m.dob !~ '^[0-9]{4}' OR
            SUBSTRING(t.tx_date FROM 1 FOR 4)::int - SUBSTRING(m.dob FROM 1 FOR 4)::int >= rule.min_age
          )
          AND (
            rule.max_age IS NULL OR m.dob IS NULL OR m.dob !~ '^[0-9]{4}' OR
            SUBSTRING(t.tx_date FROM 1 FOR 4)::int - SUBSTRING(m.dob FROM 1 FOR 4)::int <= rule.max_age
          )
        ORDER BY rule.min_age DESC NULLS LAST
        LIMIT 1
      ) dr ON true
      LEFT JOIN payment_splits ps
        ON ps.year = SUBSTRING(t.tx_date FROM 1 FOR 4)::int
        AND ps.category = t.category
        AND ps.active = true
      WHERE t.tx_type = 'receipt'
        AND t.status IN ('posted', 'reversed')
        AND (tc.purpose IN ('assessment', 'welfare_income') OR ps.id IS NOT NULL)
      ORDER BY t.id
    `, [wfFund.rows[0].id]);

    let repaired = 0;
    for (const tx of candidates.rows) {
      const amount = Number(tx.amount);
      let welfare = 0;
      if (tx.purpose === 'welfare_income') {
        welfare = amount;
      } else if (Number(tx.assessment_due) > 0 && Number(tx.dues_welfare) > 0) {
        welfare = Math.round((amount * Number(tx.dues_welfare) / Number(tx.assessment_due)) * 100) / 100;
      } else if (Number(tx.split_assessment) > 0 && Number(tx.split_welfare) > 0) {
        welfare = Math.round((amount * Number(tx.split_welfare) / Number(tx.split_assessment)) * 100) / 100;
      }
      const direction = tx.reverses_transaction_id == null ? 1 : -1;
      const expectedWelfareAllocation = direction * welfare;
      if (Math.abs(Number(tx.current_welfare) - welfare) < 0.005
          && Math.abs(Number(tx.current_welfare_allocation) - expectedWelfareAllocation) < 0.005) continue;

      await run('UPDATE transactions SET welfare_component = $1 WHERE id = $2', [welfare, tx.id]);
      await run('DELETE FROM receipt_allocations WHERE transaction_id = $1', [tx.id]);
      const operating = Math.round((amount - welfare) * 100) / 100;
      if (operating > 0) {
        await run(`INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount, category, description)
          VALUES ($1, $2, $3, $4, $5)`, [tx.id, opFund.rows[0].id, direction * operating, tx.category, 'Effective dues welfare repair']);
      }
      if (welfare > 0) {
        await run(`INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount, category, description)
          VALUES ($1, $2, $3, $4, $5)`, [tx.id, wfFund.rows[0].id, expectedWelfareAllocation, tx.category, 'Effective dues welfare repair']);
      }
      repaired++;
    }
    await run('INSERT INTO migration_history (key, details) VALUES ($1, $2::jsonb)', [
      welfareRepairKey, JSON.stringify({ repairedTransactions: repaired })
    ]);
    console.log(`[migrate]   ✓ effective welfare allocations repaired (${repaired} transactions)`);
  } else {
    console.log('[migrate]   ✓ effective welfare allocation repair already applied (skipped)');
  }

  await run(`INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (NULL, 'migration', 'schema', NULL, 'Phase 1 accounting model corrections: fund_classifications created, receipt_allocations backfilled, is_welfare_fund removed')`);
  console.log('[migrate]   ✓ is_welfare_fund column removed, migration verified');

  // ─── Organization settings ───
  await run(`
    CREATE TABLE IF NOT EXISTS organization_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      name VARCHAR(255) NOT NULL DEFAULT 'My Organization',
      short_name VARCHAR(50),
      address TEXT,
      city VARCHAR(100),
      region VARCHAR(100),
      country VARCHAR(100) DEFAULT 'Ghana',
      phone VARCHAR(50),
      email VARCHAR(255),
      website VARCHAR(255),
      motto TEXT,
      letterhead_line1 VARCHAR(255),
      letterhead_line2 VARCHAR(255),
      letterhead_line3 VARCHAR(255),
      currency VARCHAR(10) NOT NULL DEFAULT 'GHS',
      registration_number VARCHAR(100),
      founded_year INTEGER,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await run(`
    INSERT INTO organization_settings (id, name, currency)
    VALUES (1, 'My Organization', 'GHS')
    ON CONFLICT (id) DO NOTHING
  `);
  // Signatory columns
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS signatory1_title VARCHAR(100) DEFAULT 'Treasurer / Finance Secretary'`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS signatory1_name VARCHAR(255)`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS signatory2_title VARCHAR(100) DEFAULT 'President / Chairman'`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS signatory2_name VARCHAR(255)`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS signatory3_title VARCHAR(100)`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS signatory3_name VARCHAR(255)`);
  console.log('[migrate]   ✓ organization_settings table');

  // ─── Transaction attachments ───
  await run(`
    CREATE TABLE IF NOT EXISTS transaction_attachments (
      id SERIAL PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
      filename VARCHAR(255) NOT NULL,
      original_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_attachments_transaction ON transaction_attachments(transaction_id)`);
  console.log('[migrate]   ✓ transaction_attachments table');

  // Business-specific accounts, categories, and dues are configured in the application.

  // ─── Secretary Module: Events & Attendance ───

  await run(`
    CREATE TABLE IF NOT EXISTS meetings (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id) ON DELETE RESTRICT,
      meeting_date DATE NOT NULL,
      meeting_type VARCHAR(30) NOT NULL DEFAULT 'regular' CHECK (meeting_type IN ('regular','special','board')),
      location VARCHAR(255),
      start_time VARCHAR(10),
      end_time VARCHAR(10),
      opening_prayer_by VARCHAR(255),
      closing_prayer_by VARCHAR(255),
      mover VARCHAR(255),
      seconder VARCHAR(255),
      correspondence TEXT,
      finance_summary TEXT,
      matters_arising TEXT,
      agenda TEXT,
      good_of_order TEXT,
      other_notes TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  // Extend meetings table into a full events model
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS title VARCHAR(255)`);
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS event_level VARCHAR(30) NOT NULL DEFAULT 'local'`);
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS event_type VARCHAR(30) NOT NULL DEFAULT 'meeting'`);
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS minutes_url TEXT`);
  // Drop old constraints if they exist and add flexible ones
  await run(`ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_meeting_type_check`);
  await run(`ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_event_level_check`);
  await run(`ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_event_type_check`);
  await run(`ALTER TABLE meetings ADD CONSTRAINT meetings_event_level_check CHECK (event_level IN ('local','district','grand','supreme_subordinate'))`);
  // event_type is now free-text referencing event_types.slug (no CHECK constraint);
  // Additional fields for formal meeting minutes (kept for backward compat)
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS pro_tem_appointments TEXT`);
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS opening_rituals TEXT`);
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS previous_minutes TEXT`);
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS closing_notes TEXT`);
  await run(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS discussion_notes TEXT`);
  await run(`CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(meeting_date DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_meetings_commandery ON meetings(commandery_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_meetings_level_type ON meetings(event_level, event_type)`);
  console.log('[migrate]   ✓ meetings (events)');

  await run(`
    CREATE TABLE IF NOT EXISTS meeting_attendance (
      id SERIAL PRIMARY KEY,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'absent' CHECK (status IN ('present','excuse','absent')),
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(meeting_id, member_id)
    )
  `);
  await run(`ALTER TABLE meeting_attendance DROP CONSTRAINT IF EXISTS meeting_attendance_status_check`);
  await run(`ALTER TABLE meeting_attendance ADD CONSTRAINT meeting_attendance_status_check CHECK (status IN ('present','excuse','absent'))`);
  await run(`CREATE INDEX IF NOT EXISTS idx_meeting_attendance_meeting ON meeting_attendance(meeting_id)`);
  console.log('[migrate]   ✓ meeting_attendance');

  await run(`
    CREATE TABLE IF NOT EXISTS charitable_works (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id) ON DELETE RESTRICT,
      meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
      report_month INTEGER NOT NULL,
      report_year INTEGER NOT NULL,
      beneficiary VARCHAR(255) NOT NULL,
      purpose TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_charitable_works_period ON charitable_works(report_year, report_month)`);
  console.log('[migrate]   ✓ charitable_works');

  await run(`
    CREATE TABLE IF NOT EXISTS volunteer_hours (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id) ON DELETE RESTRICT,
      meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
      report_month INTEGER NOT NULL,
      report_year INTEGER NOT NULL,
      num_brothers INTEGER NOT NULL DEFAULT 1 CHECK (num_brothers > 0),
      time_spent NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (time_spent > 0),
      total_hours NUMERIC(10,2) NOT NULL DEFAULT 0,
      purpose TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_volunteer_hours_period ON volunteer_hours(report_year, report_month)`);
  console.log('[migrate]   ✓ volunteer_hours');

  // Cadets roll tracking
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS cadets_roll INTEGER NOT NULL DEFAULT 0`);
  // Commandery number and region for monthly report
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS commandery_number VARCHAR(50)`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS district VARCHAR(100)`);
  // SMS configuration (mNotify)
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_api_key TEXT`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_sender_id VARCHAR(11) DEFAULT 'KSJI'`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT false`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_event_reminder_days INTEGER NOT NULL DEFAULT 2`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_payment_notify BOOLEAN NOT NULL DEFAULT true`);
  // SMS message templates (editable with placeholders)
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_tpl_event_reminder TEXT DEFAULT 'Dear {name}, reminder: {event} on {date} at {time} at {location}. Attendance is expected. - KSJI'`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_tpl_payment TEXT DEFAULT 'Dear {name}, your payment of GHS {amount} for {category} has been received. Thank you. - KSJI'`);
  await run(`ALTER TABLE organization_settings ADD COLUMN IF NOT EXISTS sms_tpl_assessment TEXT DEFAULT 'Dear {name}, your outstanding balance for {year} is GHS {balance}. Kindly make payment. - KSJI'`);
  console.log('[migrate]   ✓ secretary module + SMS columns on organization_settings');

  // Event types (admin-configurable)
  await run(`
    CREATE TABLE IF NOT EXISTS event_types (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER NOT NULL REFERENCES commanderies(id) ON DELETE RESTRICT,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(50) NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_event_types_slug ON event_types(commandery_id, slug)`);
  // Seed default event types if empty
  await run(`
    INSERT INTO event_types (commandery_id, name, slug, sort_order)
    SELECT c.id, t.name, t.slug, t.sort_order
    FROM commanderies c,
    (VALUES
      ('Meeting', 'meeting', 1),
      ('Church Offertory', 'offertory', 2),
      ('Convention', 'convention', 3),
      ('Social Event', 'social', 4),
      ('Funeral', 'funeral', 5),
      ('Community Service', 'community_service', 6),
      ('Other', 'other', 7)
    ) AS t(name, slug, sort_order)
    WHERE NOT EXISTS (SELECT 1 FROM event_types WHERE commandery_id = c.id)
  `);
  console.log('[migrate]   ✓ event_types');

  // SMS log table
  await run(`
    CREATE TABLE IF NOT EXISTS sms_log (
      id SERIAL PRIMARY KEY,
      commandery_id INTEGER REFERENCES commanderies(id) ON DELETE SET NULL,
      recipient_phone VARCHAR(20) NOT NULL,
      recipient_name VARCHAR(255),
      member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      message TEXT NOT NULL,
      sms_type VARCHAR(30) NOT NULL DEFAULT 'general' CHECK (sms_type IN ('event_reminder','payment_confirmation','assessment_reminder','general')),
      status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
      provider_ref VARCHAR(255),
      error_message TEXT,
      sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_log(created_at DESC)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sms_log_member ON sms_log(member_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_sms_log_type ON sms_log(sms_type)`);
  console.log('[migrate]   ✓ sms_log');

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
