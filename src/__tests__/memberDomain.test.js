'use strict';

const {
  MEMBER_STATUSES,
  USER_ROLES,
  buildDisplayName,
  canEditMembership,
  canViewEmergencyContacts,
  normalizePhone,
  validateMemberInput,
  validateStatusChange,
} = require('../memberDomain');

describe('member domain', () => {
  test('normalizes Ghanaian local and international phone numbers', () => {
    expect(normalizePhone('024 123 4567')).toBe('+233241234567');
    expect(normalizePhone('233-24-123-4567')).toBe('+233241234567');
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
  });

  test('rejects an invalid phone number', () => {
    expect(() => normalizePhone('123')).toThrow('valid phone number');
  });

  test('builds the finance-compatible display name from structured names', () => {
    expect(buildDisplayName({ title: 'Sir', first_name: 'Kojo', middle_name: 'A', last_name: 'Mensah' }))
      .toBe('Sir Kojo A Mensah');
  });

  test('requires first and last names and validates email', () => {
    expect(validateMemberInput({ first_name: '', last_name: '', email: 'wrong' }))
      .toEqual(['First name is required.', 'Last name is required.', 'Email address is invalid.']);
  });

  test('membership mutation is limited to admin and secretary', () => {
    expect(canEditMembership('admin')).toBe(true);
    expect(canEditMembership('secretary')).toBe(true);
    expect(canEditMembership('finance_secretary')).toBe(false);
    expect(canEditMembership('viewer')).toBe(false);
  });

  test('emergency contact visibility excludes finance and audit roles', () => {
    expect(canViewEmergencyContacts('president')).toBe(true);
    expect(canViewEmergencyContacts('commander')).toBe(true);
    expect(canViewEmergencyContacts('treasurer')).toBe(false);
    expect(canViewEmergencyContacts('auditor')).toBe(false);
  });

  test('status changes require a different allowed status, date, and reason', () => {
    expect(validateStatusChange('active', 'suspended', 'Disciplinary decision', '2026-07-13')).toEqual([]);
    expect(validateStatusChange('active', 'active', '', '')).toHaveLength(3);
    expect(MEMBER_STATUSES).toEqual(['active', 'suspended', 'expelled', 'transferred', 'resigned']);
  });

  test('Officer is not a selectable application role', () => {
    expect(USER_ROLES).not.toContain('officer');
  });
});
