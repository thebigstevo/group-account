'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../config', () => ({ groupName: 'Test Commandery' }));
jest.mock('../dal', () => ({
  transaction: jest.fn(),
  shutdown: jest.fn(),
}));

const dal = require('../dal');
const { migrate } = require('../migrate');

describe('Phase 1 migration contract', () => {
  let logSpy;
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = {
      query: jest.fn().mockImplementation(async (sql) => {
        const s = String(sql);
        if (s.includes('SELECT COUNT(*)::int AS count')) return { rowCount: 1, rows: [{ count: 1 }] };
        if (s.includes('SELECT COUNT(*) AS cnt')) return { rowCount: 1, rows: [{ cnt: '0' }] };
        // Fund classification lookups for receipt_allocations backfill
        if (s.includes("FROM fund_classifications WHERE code = 'mens_operating'")) return { rows: [{ id: 1 }] };
        if (s.includes("FROM fund_classifications WHERE code = 'joint_welfare'")) return { rows: [{ id: 2 }] };
        if (s.includes('FROM accounts WHERE is_welfare_fund')) return { rows: [{ id: 10 }] };
        // Split group and transaction queries return empty results
        if (s.includes('SELECT DISTINCT split_group_id')) return { rows: [] };
        // Migration verification query (no mismatches = success)
        if (s.includes('HAVING ABS(t.amount')) return { rows: [] };
        return { rowCount: 0, rows: [] };
      }),
    };
    dal.transaction.mockImplementation(async callback => callback(client));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => logSpy.mockRestore());

  test('is repeatable and includes the membership foundation schema', async () => {
    await expect(migrate()).resolves.toBeUndefined();
    await expect(migrate()).resolves.toBeUndefined();

    const sql = client.query.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS commanderies');
    expect(sql).toContain('CREATE SEQUENCE IF NOT EXISTS member_membership_number_seq');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS member_status_history');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS member_emergency_contacts');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS member_import_batches');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS member_import_rows');
    expect(sql).toContain('idx_fiscal_years_one_active');
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS purpose VARCHAR(30)");
    expect(sql).toContain('idx_transaction_categories_unique_active_purpose');
    expect(sql).toContain("CHECK (kind IN ('income','expense','both'))");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS annual_budgets');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS annual_budget_lines');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_reviews');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS audit_review_items');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS fiscal_year');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION assign_member_foundation_defaults');
    expect(sql).toContain("CHECK (status IN ('active','suspended','expelled','transferred','resigned'))");
    expect(sql).toContain("'secretary','finance_secretary','treasurer'");
    // Reversal metadata migration
    expect(sql).toContain('UPDATE transactions');
    expect(sql).toContain('SET reversal_transaction_id = reversed_by');
    expect(sql).toContain('SET reverses_transaction_id = orig.id');
    // Receipt allocations backfill
    expect(sql).toContain("FROM fund_classifications WHERE code = 'mens_operating'");
    expect(sql).toContain("FROM fund_classifications WHERE code = 'joint_welfare'");
    expect(sql).toContain('FROM accounts WHERE is_welfare_fund');
    // Phase 1 migration: drop is_welfare_fund and verify allocations
    expect(sql).toContain('ALTER TABLE accounts DROP COLUMN IF EXISTS is_welfare_fund');
    expect(sql).toContain('HAVING ABS(t.amount');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS migration_history');
    const params = client.query.mock.calls.flatMap(call => call[1] || []);
    expect(params).toContain('2026-08-effective-welfare-allocations-v1');
    expect(fs.readFileSync(path.join(__dirname, '..', 'migrate.js'), 'utf8')).toContain('Effective dues welfare repair');
    expect(sql).toContain("'migration', 'schema'");
  });
});
