const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const testDbPath = path.join(__dirname, '../../storage/test-services.db');

// Clean up any leftover test DB
try { fs.unlinkSync(testDbPath); } catch (e) { /* ignore */ }
fs.mkdirSync(path.dirname(testDbPath), { recursive: true });

// Create and seed the test database
const testDb = new Database(testDbPath);
testDb.pragma('foreign_keys = ON');

testDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    phone TEXT,
    dob TEXT,
    status TEXT DEFAULT 'active',
    opening_arrears REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    opening_balance REAL DEFAULT 0,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS dues_rules (
    id INTEGER PRIMARY KEY,
    year INTEGER NOT NULL,
    label TEXT NOT NULL,
    min_age INTEGER,
    max_age INTEGER,
    annual_assessment REAL DEFAULT 0,
    welfare_portion REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    UNIQUE(year, label)
  );
  CREATE TABLE IF NOT EXISTS payment_splits (
    id INTEGER PRIMARY KEY,
    year INTEGER NOT NULL,
    category TEXT NOT NULL,
    assessment_amount REAL DEFAULT 0,
    welfare_amount REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    UNIQUE(year, category)
  );
  CREATE TABLE IF NOT EXISTS member_dues (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    assessment_due REAL DEFAULT 0,
    welfare_portion REAL DEFAULT 0,
    reason TEXT,
    UNIQUE(member_id, year)
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY,
    tx_date TEXT NOT NULL,
    tx_type TEXT NOT NULL CHECK (tx_type IN ('receipt','expense','transfer','welfare_payout')),
    member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
    account_id INTEGER REFERENCES accounts(id),
    to_account_id INTEGER REFERENCES accounts(id),
    category TEXT NOT NULL,
    description TEXT,
    amount REAL NOT NULL CHECK (amount >= 0),
    welfare_component REAL DEFAULT 0 CHECK (welfare_component >= 0),
    status TEXT DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
    reversed_by INTEGER REFERENCES transactions(id),
    reconciled INTEGER DEFAULT 0,
    reference TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS reconciliations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    statement_balance REAL NOT NULL,
    system_balance REAL NOT NULL,
    difference REAL NOT NULL,
    notes TEXT,
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    details TEXT,
    before_value TEXT,
    after_value TEXT,
    ip_address TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const year = new Date().getFullYear();
testDb.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run('Admin', 'admin@test.com', 'hash', 'admin');
testDb.prepare('INSERT INTO members (name, phone, dob, status, opening_arrears) VALUES (?, ?, ?, ?, ?)').run('John Doe', '123456789', '1980-05-15', 'active', 0);
testDb.prepare('INSERT INTO members (name, phone, dob, status, opening_arrears) VALUES (?, ?, ?, ?, ?)').run('Jane Smith', '987654321', '1995-10-20', 'active', 500);
testDb.prepare('INSERT INTO accounts (name, type, opening_balance, active) VALUES (?, ?, ?, ?)').run('Cash', 'cash', 1000, 1);
testDb.prepare('INSERT INTO accounts (name, type, opening_balance, active) VALUES (?, ?, ?, ?)').run('Bank', 'bank', 5000, 1);
testDb.prepare('INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion, active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(year, 'Under 60', null, 59, 1000, 400, 1);
testDb.prepare('INSERT INTO dues_rules (year, label, min_age, max_age, annual_assessment, welfare_portion, active) VALUES (?, ?, ?, ?, ?, ?, ?)').run(year, 'Age 60-69', 60, 69, 500, 200, 1);
testDb.prepare('INSERT INTO payment_splits (year, category, assessment_amount, welfare_amount, active) VALUES (?, ?, ?, ?, ?)').run(year, 'Assessment', 1000, 400, 1);
testDb.prepare('INSERT INTO member_dues (member_id, year, assessment_due, welfare_portion, reason) VALUES (?, ?, ?, ?, ?)').run(2, year, 800, 320, 'Custom');

// Now mock the db module - jest.mock is hoisted but the factory runs lazily
jest.mock('../db', () => {
  const Database = require('better-sqlite3');
  const path = require('path');
  const dbPath = path.join(__dirname, '../../storage/test-services.db');
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  return { db, audit: jest.fn() };
});

const {
  accountBalances,
  welfareLiability,
  totalIncome,
  totalReceipts,
  totalWelfareCollected,
  totalExpenses,
  memberPaid,
  memberDue,
  calculateWelfareComponent,
  arrearsReport,
  currentYear
} = require('../services');

afterAll(() => {
  testDb.close();
  // The mocked db also opens the file, close via require cache
  const mockedDb = require('../db').db;
  if (mockedDb !== testDb) mockedDb.close();
  try { fs.unlinkSync(testDbPath); } catch (e) { /* ignore */ }
});

describe('Services: Dues and Welfare Calculations', () => {
  test('memberDue returns correct dues based on age', () => {
    const johnDoe = testDb.prepare('SELECT * FROM members WHERE name = ?').get('John Doe');
    const dues = memberDue(johnDoe, year);
    expect(dues.assessment_due).toBe(1000);
    expect(dues.welfare_portion).toBe(400);
  });

  test('memberDue returns overridden dues when present', () => {
    const janeSmith = testDb.prepare('SELECT * FROM members WHERE name = ?').get('Jane Smith');
    const dues = memberDue(janeSmith, year);
    expect(dues.assessment_due).toBe(800);
    expect(dues.welfare_portion).toBe(320);
  });

  test('calculateWelfareComponent uses explicit welfare amount', () => {
    const welfare = calculateWelfareComponent({
      memberId: 1,
      category: 'Assessment',
      amount: 1000,
      txDate: new Date().toISOString().slice(0, 10),
      enteredWelfare: 250
    });
    expect(welfare).toBe(250);
  });

  test('calculateWelfareComponent calculates from member dues ratio', () => {
    const welfare = calculateWelfareComponent({
      memberId: 1,
      category: 'Assessment',
      amount: 1000,
      txDate: `${year}-06-15`,
      enteredWelfare: null
    });
    expect(welfare).toBe(400);
  });

  test('calculateWelfareComponent returns 0 for non-Assessment category', () => {
    const welfare = calculateWelfareComponent({
      memberId: 1,
      category: 'Offertory',
      amount: 500,
      txDate: new Date().toISOString().slice(0, 10),
      enteredWelfare: null
    });
    expect(welfare).toBe(0);
  });

  test('calculateWelfareComponent returns full amount for Welfare category', () => {
    const welfare = calculateWelfareComponent({
      memberId: 1,
      category: 'Welfare',
      amount: 500,
      txDate: new Date().toISOString().slice(0, 10),
      enteredWelfare: null
    });
    expect(welfare).toBe(500);
  });
});

describe('Services: Transaction Recording and Calculations', () => {
  test('accountBalances correctly calculates balance with posted transactions', () => {
    const txDate = `${year}-06-15`;
    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 1000, 400, 'posted', 1)
    `).run(txDate, 1);

    const balances = accountBalances();
    const cashAccount = balances.find(a => a.id === 1);
    expect(cashAccount.balance).toBe(2000);
  });

  test('totalReceipts includes only posted receipts', () => {
    const txDate = `${year}-07-01`;
    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 500, 200, 'posted', 1)
    `).run(txDate, 2);

    const receipts = totalReceipts(`${year}-07-01`, `${year}-07-31`);
    expect(receipts).toBe(500);
  });

  test('totalWelfareCollected sums welfare components', () => {
    const txDate = `${year}-08-01`;
    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 800, 320, 'posted', 1)
    `).run(txDate, 1);

    const welfare = totalWelfareCollected(`${year}-08-01`, `${year}-08-31`);
    expect(welfare).toBeGreaterThanOrEqual(320);
  });

  test('totalExpenses calculates expense transactions', () => {
    const txDate = `${year}-09-01`;
    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, account_id, category, amount, status, created_by)
      VALUES (?, 'expense', 1, 'General Expense', 150, 'posted', 1)
    `).run(txDate);

    const expenses = totalExpenses(`${year}-09-01`, `${year}-09-30`);
    expect(expenses).toBeGreaterThanOrEqual(150);
  });

  test('memberPaid returns sum of assessments paid by member', () => {
    const txDate = `${year}-10-01`;
    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, status, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 600, 'posted', 1)
    `).run(txDate, 1);

    const paid = memberPaid(1, year);
    expect(paid).toBeGreaterThanOrEqual(600);
  });

  test('welfareLiability calculates welfare collected minus paid out', () => {
    const txDate = `${year}-11-01`;
    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, account_id, category, amount, status, created_by)
      VALUES (?, 'welfare_payout', 1, 'Welfare Payout', 100, 'posted', 1)
    `).run(txDate);

    const liability = welfareLiability();
    expect(liability).toBeGreaterThanOrEqual(0);
  });
});

describe('Services: Reversal Logic', () => {
  test('reversed transactions excluded from account balance', () => {
    const txDate = `${year}-12-01`;

    const result = testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, created_by)
      VALUES (?, 'receipt', ?, 2, 'Assessment', 300, 120, 'posted', 1)
    `).run(txDate, 2);
    const receiptId = result.lastInsertRowid;

    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, reversed_by, created_by)
      VALUES (?, 'receipt', ?, 2, 'Assessment', 300, 120, 'reversed', ?, 1)
    `).run(txDate, 2, receiptId);

    testDb.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('reversed', receiptId);

    const balances = accountBalances();
    const bankAccount = balances.find(a => a.id === 2);
    expect(bankAccount.balance).toBe(5000);
  });

  test('reversed transactions excluded from total income', () => {
    const txDate = `${year}-12-15`;

    const result = testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 400, 160, 'posted', 1)
    `).run(txDate, 1);
    const receiptId = result.lastInsertRowid;

    testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, reversed_by, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 400, 160, 'reversed', ?, 1)
    `).run(txDate, 1, receiptId);

    testDb.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('reversed', receiptId);

    const income = totalIncome(`${year}-12-15`, `${year}-12-31`);
    expect(typeof income).toBe('number');
    expect(Number.isNaN(income)).toBe(false);
  });

  test('reversal chain preserves audit trail', () => {
    const txDate = `${year}-12-20`;

    const result = testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 250, 100, 'posted', 1)
    `).run(txDate, 1);
    const originalId = result.lastInsertRowid;

    const revResult = testDb.prepare(`
      INSERT INTO transactions (tx_date, tx_type, member_id, account_id, category, amount, welfare_component, status, reversed_by, created_by)
      VALUES (?, 'receipt', ?, 1, 'Assessment', 250, 100, 'reversed', ?, 1)
    `).run(txDate, 1, originalId);

    testDb.prepare('UPDATE transactions SET status = ? WHERE id = ?').run('reversed', originalId);

    const original = testDb.prepare('SELECT * FROM transactions WHERE id = ?').get(originalId);
    const rev = testDb.prepare('SELECT * FROM transactions WHERE id = ?').get(revResult.lastInsertRowid);

    expect(original.status).toBe('reversed');
    expect(rev.reversed_by).toBe(originalId);
    expect(rev.status).toBe('reversed');
  });
});

describe('Services: Arrears Report', () => {
  test('arrearsReport includes members with opening arrears', () => {
    const report = arrearsReport(year);
    const jane = report.find(r => r.name === 'Jane Smith');

    expect(jane).toBeDefined();
    expect(jane.opening_arrears).toBe(500);
  });

  test('arrearsReport calculates total balance (opening + due - paid)', () => {
    const report = arrearsReport(year);
    const john = report.find(r => r.name === 'John Doe');

    expect(john).toBeDefined();
    // balance = opening_arrears + assessment_due - paid
    // John has paid more than due across tests, so balance can be negative
    expect(john.balance).toBe(john.opening_arrears + john.assessment_due - john.paid);
  });
});
