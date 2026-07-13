'use strict';

jest.mock('../dal', () => ({
  transaction: jest.fn(),
  audit: jest.fn()
}));

const dal = require('../dal');

const {
  memberSnapshot,
  sameSnapshot,
  summarizeBalances,
  parseOpeningBalance
} = require('../importMembers');

describe('member import recovery helpers', () => {
  test('summarizes arrears, credits, and zero balances without changing signs', () => {
    expect(summarizeBalances([125, -40.5, 0, '25.50', '-10'])).toEqual({
      positive: 2,
      negative: 2,
      zero: 1,
      total: 100
    });
  });

  test('recognizes the stable membership number in cleanup exports', () => {
    const { detectColumnMapping } = require('../importMembers');
    expect(detectColumnMapping(['Membership Number', 'Name', 'Opening Balance'])).toEqual({
      membership_number: 0,
      name: 1,
      opening_arrears: 2
    });
  });

  test('parses signed and accounting-style balances without turning bad text into zero', () => {
    expect(parseOpeningBalance('-100.50')).toBe(-100.5);
    expect(parseOpeningBalance('(100.50)')).toBe(-100.5);
    expect(parseOpeningBalance('GHS 1,250.00')).toBe(1250);
    expect(parseOpeningBalance('credit')).toBeNull();
  });

  test('normalizes database numeric values for safe rollback comparisons', () => {
    const member = {
      name: 'Ama Owusu',
      opening_arrears: '-40.5',
      phone: null,
      dob: '1990-08-25',
      status: 'active'
    };
    const snapshot = memberSnapshot(member);

    expect(snapshot.opening_arrears).toBe('-40.50');
    expect(sameSnapshot({ ...member, opening_arrears: -40.5 }, snapshot, true)).toBe(true);
    expect(sameSnapshot({ ...member, opening_arrears: 0 }, snapshot, true)).toBe(false);
  });

  test('full snapshots detect later identity and status changes', () => {
    const snapshot = memberSnapshot({
      name: 'Old Name', opening_arrears: 50, phone: '0240000000', dob: null, status: 'active'
    });
    const renamed = {
      name: 'New Name', opening_arrears: 50, phone: '0240000000', dob: null, status: 'suspended'
    };

    expect(sameSnapshot(renamed, snapshot, false)).toBe(true);
    expect(sameSnapshot(renamed, snapshot, true)).toBe(false);
  });

  test('a corrected zero balance overwrites the existing balance exactly', async () => {
    const client = {
      query: jest.fn(async (sql, params = []) => {
        const text = String(sql);
        if (text.includes("FROM fiscal_years WHERE year = $1")) return { rows: [{ year: 2026 }] };
        if (text.includes('INSERT INTO member_import_batches')) return { rows: [{ id: 12 }] };
        if (text.includes('SELECT id, name, opening_arrears')) {
          return { rows: [{ id: 4, name: 'Ama Owusu', opening_arrears: '99.00', phone: null, dob: null, status: 'active' }] };
        }
        if (text.includes('UPDATE members SET')) {
          expect(text).toContain('opening_arrears = $2');
          expect(text).not.toContain('CASE WHEN');
          expect(params[0]).toBe('Ama Owusu');
          expect(params[1]).toBe(0);
          return { rows: [{ id: 4, name: 'Ama Owusu', opening_arrears: '0.00', phone: null, dob: null, status: 'active' }] };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    dal.transaction.mockImplementationOnce(callback => callback(client));

    const result = await require('../importMembers').importMembers(
      Buffer.from('Name,Opening Balance\nAma Owusu,0\n'), 'correction.csv', 1, 2026
    );

    expect(result.errors).toEqual([]);
    expect(result.imported).toBe(1);
    expect(result.balanceSummary).toEqual({ positive: 0, negative: 0, zero: 1, total: 0 });
  });
});
