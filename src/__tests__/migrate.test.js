'use strict';

jest.mock('../config', () => ({ groupName: 'Test Commandery' }));
jest.mock('../dal', () => ({
  run: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
  queryOne: jest.fn().mockResolvedValue({ count: 1 }),
  shutdown: jest.fn(),
}));

const dal = require('../dal');
const { migrate } = require('../migrate');

describe('Phase 1 migration contract', () => {
  let logSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    dal.run.mockResolvedValue({ rowCount: 0, rows: [] });
    dal.queryOne.mockResolvedValue({ count: 1 });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => logSpy.mockRestore());

  test('is repeatable and includes the membership foundation schema', async () => {
    await expect(migrate()).resolves.toBeUndefined();
    await expect(migrate()).resolves.toBeUndefined();

    const sql = dal.run.mock.calls.map(call => String(call[0])).join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS commanderies');
    expect(sql).toContain('CREATE SEQUENCE IF NOT EXISTS member_membership_number_seq');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS member_status_history');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS member_emergency_contacts');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION assign_member_foundation_defaults');
    expect(sql).toContain("CHECK (status IN ('active','suspended','expelled','transferred','resigned'))");
    expect(sql).toContain("'secretary','finance_secretary','treasurer'");
  });
});
