'use strict';

const EVENT_LEVELS = Object.freeze(['local', 'district', 'grand', 'supreme_subordinate']);
const EVENT_TYPES = Object.freeze(['meeting', 'offertory', 'convention', 'social', 'funeral', 'community_service', 'other']);
const ATTENDANCE_STATUSES = Object.freeze(['present', 'excuse', 'absent']);

const EVENT_LEVEL_LABELS = Object.freeze({
  local: 'Local Commandery',
  district: 'District / Regiment',
  grand: 'Grand Commandery',
  supreme_subordinate: 'Supreme Subordinate'
});

const EVENT_TYPE_LABELS = Object.freeze({
  meeting: 'Meeting',
  offertory: 'Church Offertory',
  convention: 'Convention',
  social: 'Social Event',
  funeral: 'Funeral',
  community_service: 'Community Service',
  other: 'Other'
});

function validateEventInput(input) {
  const errors = [];
  if (!input.title || !input.title.trim()) errors.push('Event name is required.');
  if (!input.event_date) errors.push('Date is required.');
  if (!EVENT_LEVELS.includes(input.event_level)) errors.push('Select a valid event level.');
  if (!EVENT_TYPES.includes(input.event_type)) errors.push('Select a valid event type.');
  return errors;
}

module.exports = {
  EVENT_LEVELS,
  EVENT_TYPES,
  EVENT_LEVEL_LABELS,
  EVENT_TYPE_LABELS,
  ATTENDANCE_STATUSES,
  validateEventInput
};
