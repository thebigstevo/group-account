'use strict';

const MEETING_TYPES = Object.freeze(['regular', 'special', 'board']);
const ATTENDANCE_STATUSES = Object.freeze(['present', 'excuse', 'absent']);

function validateMeetingInput(input) {
  const errors = [];
  if (!input.meeting_date) errors.push('Date is required.');
  if (!MEETING_TYPES.includes(input.meeting_type)) errors.push('Select a valid event type.');
  return errors;
}

module.exports = {
  MEETING_TYPES,
  ATTENDANCE_STATUSES,
  validateMeetingInput
};
