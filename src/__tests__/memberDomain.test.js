'use strict';

const {
  MEMBER_STATUSES,
  USER_ROLES,
  buildDisplayName,
  canEditMembership,
  canViewEmergencyContacts,
  normalizePhone,
  validateMemberInput,
  validatePositionEntry,
  validateRankEntry,
  validateStatusChange,
  validateTransferRecord,
} = require('../memberDomain');

function localDateString(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

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

  describe('validateRankEntry', () => {
    test('returns no errors for valid rank entry', () => {
      const input = { rank_title: 'Knight Commander', date_conferred: '2024-01-15', conferring_authority: 'Grand Prior' };
      expect(validateRankEntry(input)).toEqual([]);
    });

    test('returns error when rank_title is missing', () => {
      const input = { rank_title: '', date_conferred: '2024-01-15' };
      const errors = validateRankEntry(input);
      expect(errors).toContain('Rank title is required.');
    });

    test('returns error when rank_title exceeds 100 characters', () => {
      const input = { rank_title: 'A'.repeat(101), date_conferred: '2024-01-15' };
      const errors = validateRankEntry(input);
      expect(errors).toContain('Rank title must not exceed 100 characters.');
    });

    test('accepts rank_title at exactly 100 characters', () => {
      const input = { rank_title: 'A'.repeat(100), date_conferred: '2024-01-15' };
      expect(validateRankEntry(input)).toEqual([]);
    });

    test('returns error when date_conferred is missing', () => {
      const input = { rank_title: 'Knight', date_conferred: '' };
      const errors = validateRankEntry(input);
      expect(errors).toContain('Date conferred is required.');
    });

    test('returns error when date_conferred is in the future', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const input = { rank_title: 'Knight', date_conferred: localDateString(tomorrow) };
      const errors = validateRankEntry(input);
      expect(errors).toContain('Date conferred must not be in the future.');
    });

    test('accepts date_conferred that is today', () => {
      const today = new Date().toISOString().slice(0, 10);
      const input = { rank_title: 'Knight', date_conferred: today };
      expect(validateRankEntry(input)).toEqual([]);
    });

    test('accepts date_conferred in the past', () => {
      const input = { rank_title: 'Knight', date_conferred: '2020-06-01' };
      expect(validateRankEntry(input)).toEqual([]);
    });

    test('returns error when conferring_authority exceeds 200 characters', () => {
      const input = { rank_title: 'Knight', date_conferred: '2024-01-15', conferring_authority: 'B'.repeat(201) };
      const errors = validateRankEntry(input);
      expect(errors).toContain('Conferring authority must not exceed 200 characters.');
    });

    test('accepts conferring_authority at exactly 200 characters', () => {
      const input = { rank_title: 'Knight', date_conferred: '2024-01-15', conferring_authority: 'B'.repeat(200) };
      expect(validateRankEntry(input)).toEqual([]);
    });

    test('accepts missing conferring_authority (optional field)', () => {
      const input = { rank_title: 'Knight', date_conferred: '2024-01-15' };
      expect(validateRankEntry(input)).toEqual([]);
    });

    test('returns multiple errors when multiple fields are invalid', () => {
      const input = { rank_title: '', date_conferred: '', conferring_authority: 'C'.repeat(201) };
      const errors = validateRankEntry(input);
      expect(errors).toHaveLength(3);
      expect(errors).toContain('Rank title is required.');
      expect(errors).toContain('Date conferred is required.');
      expect(errors).toContain('Conferring authority must not exceed 200 characters.');
    });
  });

  describe('validatePositionEntry', () => {
    test('returns no errors for valid position entry with start date only', () => {
      const input = { position_title: 'Secretary', start_date: '2024-03-01' };
      expect(validatePositionEntry(input)).toEqual([]);
    });

    test('returns no errors for valid position entry with start and end dates', () => {
      const input = { position_title: 'Treasurer', start_date: '2023-01-01', end_date: '2024-06-30' };
      expect(validatePositionEntry(input)).toEqual([]);
    });

    test('returns error when position_title is missing', () => {
      const input = { position_title: '', start_date: '2024-01-15' };
      const errors = validatePositionEntry(input);
      expect(errors).toContain('Position title is required.');
    });

    test('returns error when position_title exceeds 100 characters', () => {
      const input = { position_title: 'P'.repeat(101), start_date: '2024-01-15' };
      const errors = validatePositionEntry(input);
      expect(errors).toContain('Position title must not exceed 100 characters.');
    });

    test('accepts position_title at exactly 100 characters', () => {
      const input = { position_title: 'P'.repeat(100), start_date: '2024-01-15' };
      expect(validatePositionEntry(input)).toEqual([]);
    });

    test('returns error when start_date is missing', () => {
      const input = { position_title: 'Secretary', start_date: '' };
      const errors = validatePositionEntry(input);
      expect(errors).toContain('Start date is required.');
    });

    test('returns error when start_date is in the future', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const input = { position_title: 'Secretary', start_date: localDateString(tomorrow) };
      const errors = validatePositionEntry(input);
      expect(errors).toContain('Start date must not be in the future.');
    });

    test('accepts start_date that is today', () => {
      const today = new Date().toISOString().slice(0, 10);
      const input = { position_title: 'Secretary', start_date: today };
      expect(validatePositionEntry(input)).toEqual([]);
    });

    test('returns error when end_date is before start_date', () => {
      const input = { position_title: 'Secretary', start_date: '2024-06-01', end_date: '2024-05-01' };
      const errors = validatePositionEntry(input);
      expect(errors).toContain('End date must not be before start date.');
    });

    test('accepts end_date equal to start_date', () => {
      const input = { position_title: 'Secretary', start_date: '2024-06-01', end_date: '2024-06-01' };
      expect(validatePositionEntry(input)).toEqual([]);
    });

    test('accepts missing end_date (position still current)', () => {
      const input = { position_title: 'Secretary', start_date: '2024-01-01' };
      expect(validatePositionEntry(input)).toEqual([]);
    });

    test('returns multiple errors for completely invalid input', () => {
      const input = { position_title: '', start_date: '' };
      const errors = validatePositionEntry(input);
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors).toContain('Position title is required.');
      expect(errors).toContain('Start date is required.');
    });
  });

  describe('validateTransferRecord', () => {
    const memberJoinDate = '2024-06-01';

    test('returns no errors for valid transfer record', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-03-15', reference_number: 'TRF-001' };
      expect(validateTransferRecord(input, memberJoinDate)).toEqual([]);
    });

    test('returns error when origin_commandery_name is missing', () => {
      const input = { origin_commandery_name: '', transfer_date: '2024-03-15' };
      const errors = validateTransferRecord(input, memberJoinDate);
      expect(errors).toContain('Origin commandery name is required.');
    });

    test('returns error when origin_commandery_name exceeds 150 characters', () => {
      const input = { origin_commandery_name: 'A'.repeat(151), transfer_date: '2024-03-15' };
      const errors = validateTransferRecord(input, memberJoinDate);
      expect(errors).toContain('Origin commandery name must not exceed 150 characters.');
    });

    test('accepts origin_commandery_name at exactly 150 characters', () => {
      const input = { origin_commandery_name: 'A'.repeat(150), transfer_date: '2024-03-15' };
      expect(validateTransferRecord(input, memberJoinDate)).toEqual([]);
    });

    test('returns error when transfer_date is missing', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '' };
      const errors = validateTransferRecord(input, memberJoinDate);
      expect(errors).toContain('Transfer date is required.');
    });

    test('returns error when transfer_date is in the future', () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: localDateString(tomorrow) };
      const errors = validateTransferRecord(input, '2030-01-01');
      expect(errors).toContain('Transfer date must not be in the future.');
    });

    test('returns error when transfer_date is after member join date', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-07-01' };
      const errors = validateTransferRecord(input, '2024-06-01');
      expect(errors).toContain('Transfer date must be on or before the member join date.');
    });

    test('accepts transfer_date equal to member join date', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-06-01' };
      expect(validateTransferRecord(input, '2024-06-01')).toEqual([]);
    });

    test('accepts transfer_date before member join date', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-01-15' };
      expect(validateTransferRecord(input, '2024-06-01')).toEqual([]);
    });

    test('accepts transfer_date that is today when join date allows', () => {
      const today = new Date().toISOString().slice(0, 10);
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: today };
      expect(validateTransferRecord(input, today)).toEqual([]);
    });

    test('returns error when reference_number exceeds 100 characters', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-03-15', reference_number: 'R'.repeat(101) };
      const errors = validateTransferRecord(input, memberJoinDate);
      expect(errors).toContain('Reference number must not exceed 100 characters.');
    });

    test('accepts reference_number at exactly 100 characters', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-03-15', reference_number: 'R'.repeat(100) };
      expect(validateTransferRecord(input, memberJoinDate)).toEqual([]);
    });

    test('accepts missing reference_number (optional field)', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-03-15' };
      expect(validateTransferRecord(input, memberJoinDate)).toEqual([]);
    });

    test('skips join date validation when memberJoinDate is not provided', () => {
      const input = { origin_commandery_name: 'Accra Commandery', transfer_date: '2024-03-15' };
      expect(validateTransferRecord(input, null)).toEqual([]);
    });

    test('returns multiple errors when multiple fields are invalid', () => {
      const input = { origin_commandery_name: '', transfer_date: '', reference_number: 'R'.repeat(101) };
      const errors = validateTransferRecord(input, memberJoinDate);
      expect(errors).toHaveLength(3);
      expect(errors).toContain('Origin commandery name is required.');
      expect(errors).toContain('Transfer date is required.');
      expect(errors).toContain('Reference number must not exceed 100 characters.');
    });
  });
});
