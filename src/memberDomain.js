'use strict';

const MEMBER_STATUSES = Object.freeze(['active', 'suspended', 'expelled', 'transferred', 'resigned']);
const USER_ROLES = Object.freeze([
  'admin', 'president', 'first_vice_president', 'second_vice_president',
  'secretary', 'finance_secretary', 'treasurer', 'auditor', 'trustee',
  'commander', 'executive', 'viewer'
]);

const MEMBERSHIP_EDIT_ROLES = new Set(['admin', 'secretary']);
const EMERGENCY_CONTACT_VIEW_ROLES = new Set([
  'admin', 'president', 'first_vice_president', 'second_vice_president', 'secretary', 'commander'
]);

function clean(value) {
  const result = String(value || '').trim();
  return result || null;
}

function normalizePhone(value) {
  const raw = clean(value);
  if (!raw) return null;
  const compact = raw.replace(/[\s().-]/g, '');
  let normalized = compact;
  if (/^0\d{9}$/.test(compact)) normalized = `+233${compact.slice(1)}`;
  else if (/^233\d{9}$/.test(compact)) normalized = `+${compact}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error('Use a valid phone number, for example 024 123 4567 or +233 24 123 4567.');
  }
  return normalized;
}

function buildDisplayName(input) {
  return [clean(input.title), clean(input.first_name), clean(input.middle_name), clean(input.last_name)]
    .filter(Boolean)
    .join(' ');
}

function validateMemberInput(input) {
  const errors = [];
  if (!clean(input.first_name)) errors.push('First name is required.');
  if (!clean(input.last_name)) errors.push('Last name is required.');
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email).trim())) errors.push('Email address is invalid.');
  try { normalizePhone(input.phone); } catch (error) { errors.push(error.message); }
  try { normalizePhone(input.secondary_phone); } catch (error) { errors.push(`Secondary ${error.message.toLowerCase()}`); }
  return errors;
}

function memberValues(input) {
  return {
    title: clean(input.title),
    first_name: clean(input.first_name),
    middle_name: clean(input.middle_name),
    last_name: clean(input.last_name),
    preferred_name: clean(input.preferred_name),
    name: buildDisplayName(input),
    phone: normalizePhone(input.phone),
    secondary_phone: normalizePhone(input.secondary_phone),
    email: clean(input.email) && clean(input.email).toLowerCase(),
    dob: clean(input.dob),
    residential_address: clean(input.residential_address),
    parish: clean(input.parish),
    occupation: clean(input.occupation),
    date_first_admitted: clean(input.date_first_admitted),
    notes: clean(input.notes),
  };
}

function canEditMembership(role) {
  return MEMBERSHIP_EDIT_ROLES.has(role);
}

function canViewEmergencyContacts(role) {
  return EMERGENCY_CONTACT_VIEW_ROLES.has(role);
}

function validateRankEntry(input) {
  const errors = [];
  const title = clean(input.rank_title);
  if (!title) {
    errors.push('Rank title is required.');
  } else if (title.length > 100) {
    errors.push('Rank title must not exceed 100 characters.');
  }
  const dateStr = clean(input.date_conferred);
  if (!dateStr) {
    errors.push('Date conferred is required.');
  } else {
    const conferred = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    conferred.setHours(0, 0, 0, 0);
    if (isNaN(conferred.getTime())) {
      errors.push('Date conferred must be a valid date.');
    } else if (conferred > today) {
      errors.push('Date conferred must not be in the future.');
    }
  }
  const authority = clean(input.conferring_authority);
  if (authority && authority.length > 200) {
    errors.push('Conferring authority must not exceed 200 characters.');
  }
  return errors;
}

function validatePositionEntry(input) {
  const errors = [];
  const title = clean(input.position_title);
  if (!title) {
    errors.push('Position title is required.');
  } else if (title.length > 100) {
    errors.push('Position title must not exceed 100 characters.');
  }
  const startDate = clean(input.start_date);
  if (!startDate) {
    errors.push('Start date is required.');
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    errors.push('Start date must be a valid date.');
  } else {
    const start = new Date(startDate + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (start > today) errors.push('Start date must not be in the future.');

    const endDate = clean(input.end_date);
    if (endDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        errors.push('End date must be a valid date.');
      } else {
        const end = new Date(endDate + 'T00:00:00');
        if (end < start) errors.push('End date must not be before start date.');
      }
    }
  }
  return errors;
}

function validateTransferRecord(input, memberJoinDate) {
  const errors = [];
  const origin = clean(input.origin_commandery_name);
  if (!origin) {
    errors.push('Origin commandery name is required.');
  } else if (origin.length > 150) {
    errors.push('Origin commandery name must not exceed 150 characters.');
  }
  const dateStr = clean(input.transfer_date);
  if (!dateStr) {
    errors.push('Transfer date is required.');
  } else {
    const transferDate = new Date(dateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    transferDate.setHours(0, 0, 0, 0);
    if (isNaN(transferDate.getTime())) {
      errors.push('Transfer date must be a valid date.');
    } else {
      if (transferDate > today) {
        errors.push('Transfer date must not be in the future.');
      }
      if (memberJoinDate) {
        const joinDate = new Date(memberJoinDate);
        joinDate.setHours(0, 0, 0, 0);
        if (!isNaN(joinDate.getTime()) && transferDate > joinDate) {
          errors.push('Transfer date must be on or before the member join date.');
        }
      }
    }
  }
  const ref = clean(input.reference_number);
  if (ref && ref.length > 100) {
    errors.push('Reference number must not exceed 100 characters.');
  }
  return errors;
}

function validateStatusChange(currentStatus, nextStatus, reason, effectiveDate) {
  const errors = [];
  if (!MEMBER_STATUSES.includes(nextStatus)) errors.push('Select a valid membership status.');
  if (currentStatus === nextStatus) errors.push('Select a status different from the current status.');
  if (!clean(reason)) errors.push('A reason is required for every status change.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate || ''))) errors.push('An effective date is required.');
  return errors;
}

module.exports = {
  MEMBER_STATUSES,
  USER_ROLES,
  buildDisplayName,
  canEditMembership,
  canViewEmergencyContacts,
  clean,
  memberValues,
  normalizePhone,
  validateMemberInput,
  validatePositionEntry,
  validateRankEntry,
  validateTransferRecord,
  validateStatusChange,
};
