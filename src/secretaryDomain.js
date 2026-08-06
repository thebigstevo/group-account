'use strict';

const MEETING_TYPES = Object.freeze(['regular', 'special', 'board']);
const ATTENDANCE_STATUSES = Object.freeze(['present', 'excuse', 'absent']);
const MEETING_STATUSES = Object.freeze(['draft', 'submitted', 'approved']);

function validateMeetingInput(input) {
  const errors = [];
  if (!input.meeting_date) errors.push('Meeting date is required.');
  if (!MEETING_TYPES.includes(input.meeting_type)) errors.push('Select a valid meeting type.');
  return errors;
}

function validateCharitableWork(input) {
  const errors = [];
  if (!input.beneficiary || !input.beneficiary.trim()) errors.push('Beneficiary is required.');
  if (!input.purpose || !input.purpose.trim()) errors.push('Purpose is required.');
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) errors.push('Amount must be a non-negative number.');
  return errors;
}

function validateVolunteerHours(input) {
  const errors = [];
  if (!input.purpose || !input.purpose.trim()) errors.push('Purpose is required.');
  const numBrothers = Number(input.num_brothers);
  if (!Number.isInteger(numBrothers) || numBrothers < 1) errors.push('Number of brothers must be at least 1.');
  const timeSpent = Number(input.time_spent);
  if (!Number.isFinite(timeSpent) || timeSpent <= 0) errors.push('Time spent must be greater than 0.');
  return errors;
}

module.exports = {
  MEETING_TYPES,
  ATTENDANCE_STATUSES,
  MEETING_STATUSES,
  validateMeetingInput,
  validateCharitableWork,
  validateVolunteerHours
};
