'use strict';

const EVENT_LEVELS = Object.freeze(['local', 'district', 'grand', 'supreme_subordinate']);
const ATTENDANCE_STATUSES = Object.freeze(['present', 'excuse', 'absent']);

const EVENT_LEVEL_LABELS = Object.freeze({
  local: 'Local Commandery',
  district: 'District / Regiment',
  grand: 'Grand Commandery',
  supreme_subordinate: 'Supreme Subordinate'
});

function validateEventInput(input) {
  const errors = [];
  if (!input.title || !input.title.trim()) errors.push('Event name is required.');
  if (!input.event_date) errors.push('Date is required.');
  if (!EVENT_LEVELS.includes(input.event_level)) errors.push('Select a valid event level.');
  if (!input.event_type) errors.push('Select an event type.');
  return errors;
}

module.exports = {
  EVENT_LEVELS,
  EVENT_LEVEL_LABELS,
  ATTENDANCE_STATUSES,
  validateEventInput
};
