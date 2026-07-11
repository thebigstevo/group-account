'use strict';

const dal = require('./dal');

/**
 * Idempotent PostgreSQL schema migration script.
 * Creates all tables, indexes, and seeds default data when tables are empty.
 * Safe to run multiple times — uses IF NOT EXISTS and count checks.
 */
async function migrate() {
  console.log('[migrate] Starting PostgreSQL schema migration...');

  // ─── CREATE TABLES ────────────────────────────────────────────────────────────

  console.log('[migrate] Creating tables...');

  await dal.run(`
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
  console.log('[migrate]   ✓ users');

  await dal.run(`
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

  await dal.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      type VARCHAR(50) NOT NULL CHECK (type IN ('cash','bank','mobile_money')),
      opening_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true
    )
  `);
  console.log('[migrate]   ✓ accounts');

  await dal.run(`
    CREATE TABLE IF NOT EXISTS fiscal_years (
      year INTEGER PRIMARY KEY,
      status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      opened_at TIMESTAMP NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMP,
      closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT
    )
  `);
  console.log('[migrate]   ✓ fiscal_years');

  await dal.run(`
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

  await dal.run(`
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

  await dal.run(`
    CREATE TABLE IF NOT EXISTS transaction_categories (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      kind VARCHAR(50) NOT NULL CHECK (kind IN ('income','expense')),
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 100
    )
  `);
  console.log('[migrate]   ✓ transaction_categories');

  await dal.run(`
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

  await dal.run(`
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

  await dal.run(`
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

  await dal.run(`
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
  console.log('[migrate]   ✓ audit_log');

  // Sessions table for connect-pg-simple
  await dal.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR NOT NULL PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMP(6) NOT NULL
    )
  `);
  console.log('[migrate]   ✓ sessions');

  // ─── CREATE INDEXES ───────────────────────────────────────────────────────────

  console.log('[migrate] Creating indexes...');

  await dal.run(`CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(tx_date)`);
  await dal.run(`CREATE INDEX IF NOT EXISTS idx_transactions_type_status ON transactions(tx_type, status)`);
  await dal.run(`CREATE INDEX IF NOT EXISTS idx_transactions_member_year ON transactions(member_id, tx_date)`);
  await dal.run(`CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, tx_date)`);
  await dal.run(`CREATE INDEX IF NOT EXISTS idx_reconciliations_account_period ON reconciliations(account_id, period_start, period_end)`);
  await dal.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at)`);
  await dal.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)`);

  console.log('[migrate]   ✓ All 7 indexes created');

  // ─── SEED DEFAULT DATA ────────────────────────────────────────────────────────

  console.log('[migrate] Checking seed data...');

  // Seed default accounts only when table is empty
  const accountCount = await dal.queryOne('SELECT COUNT(*)::int AS count FROM accounts');
  if (accountCount.count === 0) {
    await dal.run(`INSERT INTO accounts (name, type) VALUES ($1, $2)`, ['Cash', 'cash']);
    await dal.run(`INSERT INTO accounts (name, type) VALUES ($1, $2)`, ['Bank', 'bank']);
    await dal.run(`INSERT INTO accounts (name, type) VALUES ($1, $2)`, ['Mobile Money', 'mobile_money']);
    console.log('[migrate]   ✓ Seeded default accounts (Cash, Bank, Mobile Money)');
  } else {
    console.log('[migrate]   ⊘ Accounts table not empty, skipping seed');
  }

  // Seed default transaction categories only when table is empty
  const categoryCount = await dal.queryOne('SELECT COUNT(*)::int AS count FROM transaction_categories');
  if (categoryCount.count === 0) {
    const categories = [
      ['Assessment', 'income', 10],
      ['Welfare', 'income', 20],
      ['Anniversary', 'income', 30],
      ['Offertory', 'income', 40],
      ['Ad hoc', 'income', 50],
      ['General Expense', 'expense', 10],
      ['PCT', 'expense', 20],
      ['Convention Fees', 'expense', 30],
      ['Refreshment', 'expense', 40],
      ['Support', 'expense', 50],
      ['Welfare Payout', 'expense', 60],
    ];
    for (const [name, kind, sortOrder] of categories) {
      await dal.run(
        `INSERT INTO transaction_categories (name, kind, sort_order) VALUES ($1, $2, $3)`,
        [name, kind, sortOrder]
      );
    }
    console.log('[migrate]   ✓ Seeded default transaction categories (11 categories)');
  } else {
    console.log('[migrate]   ⊘ Transaction categories table not empty, skipping seed');
  }

  console.log('[migrate] Migration complete.');
}

// Run migration and exit
migrate()
  .then(() => {
    return dal.shutdown();
  })
  .then(() => {
    console.log('[migrate] Done. Pool closed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('[migrate] Migration failed:', err.message);
    process.exit(1);
  });
