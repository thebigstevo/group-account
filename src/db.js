const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { dbPath } = require('./config');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','finance_secretary','treasurer','viewer','auditor')),
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      phone TEXT,
      dob TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      opening_arrears REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK (type IN ('cash','bank','mobile_money')),
      opening_balance REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS dues_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      label TEXT NOT NULL,
      min_age INTEGER,
      max_age INTEGER,
      annual_assessment REAL NOT NULL DEFAULT 0,
      welfare_portion REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(year, label)
    );

    CREATE TABLE IF NOT EXISTS payment_splits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER NOT NULL,
      category TEXT NOT NULL,
      assessment_amount REAL NOT NULL DEFAULT 0,
      welfare_amount REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(year, category)
    );

    CREATE TABLE IF NOT EXISTS transaction_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 100
    );

    CREATE TABLE IF NOT EXISTS member_dues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      year INTEGER NOT NULL,
      assessment_due REAL NOT NULL DEFAULT 0,
      welfare_portion REAL NOT NULL DEFAULT 0,
      reason TEXT,
      UNIQUE(member_id, year)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_date TEXT NOT NULL,
      tx_type TEXT NOT NULL CHECK (tx_type IN ('receipt','expense','transfer','welfare_payout')),
      member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
      to_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
      category TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL CHECK (amount >= 0),
      welfare_component REAL NOT NULL DEFAULT 0 CHECK (welfare_component >= 0),
      status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
      reversed_by INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
      reconciled INTEGER NOT NULL DEFAULT 0,
      reference TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      statement_balance REAL NOT NULL,
      system_balance REAL NOT NULL,
      difference REAL NOT NULL,
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fiscal_years (
      year INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TEXT,
      closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      entity TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      before_value TEXT,
      after_value TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(tx_date);
    CREATE INDEX IF NOT EXISTS idx_transactions_type_status ON transactions(tx_type, status);
    CREATE INDEX IF NOT EXISTS idx_transactions_member_year ON transactions(member_id, tx_date);
    CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, tx_date);
    CREATE INDEX IF NOT EXISTS idx_reconciliations_account_period ON reconciliations(account_id, period_end);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
  `);

  const count = db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO accounts (name, type) VALUES (?, ?)');
    insert.run('Cash', 'cash');
    insert.run('Bank', 'bank');
    insert.run('Mobile Money', 'mobile_money');
  }

  const categoryCount = db.prepare('SELECT COUNT(*) AS count FROM transaction_categories').get().count;
  if (categoryCount === 0) {
    const insertCategory = db.prepare('INSERT INTO transaction_categories (name, kind, sort_order) VALUES (?, ?, ?)');
    [
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
      ['Welfare Payout', 'expense', 60]
    ].forEach((item) => insertCategory.run(...item));
  }

  // Add missing columns to existing databases (schema upgrades)
  const auditColumns = db.prepare("PRAGMA table_info(audit_log)").all().map(c => c.name);
  if (!auditColumns.includes('before_value')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN before_value TEXT');
  }
  if (!auditColumns.includes('after_value')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN after_value TEXT');
  }
  if (!auditColumns.includes('ip_address')) {
    db.exec('ALTER TABLE audit_log ADD COLUMN ip_address TEXT');
  }

  const txColumns = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
  if (!txColumns.includes('status')) {
    db.exec("ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'posted'");
  }
  if (!txColumns.includes('reversed_by')) {
    db.exec('ALTER TABLE transactions ADD COLUMN reversed_by INTEGER');
  }
  if (!txColumns.includes('reconciled')) {
    db.exec('ALTER TABLE transactions ADD COLUMN reconciled INTEGER NOT NULL DEFAULT 0');
  }
  if (!txColumns.includes('reference')) {
    db.exec('ALTER TABLE transactions ADD COLUMN reference TEXT');
  }
  if (!txColumns.includes('updated_at')) {
    db.exec('ALTER TABLE transactions ADD COLUMN updated_at TEXT');
  }
}

function audit(userId, action, entity, entityId, details = '', options = {}) {
  const { before_value = null, after_value = null, ip_address = null } = options;
  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity, entity_id, details, before_value, after_value, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId || null, action, entity, entityId || null, details, before_value, after_value, ip_address);
}

migrate();

module.exports = { db, audit };
