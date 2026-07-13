'use strict';

function asValidDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Format PostgreSQL DATE/TIMESTAMP values consistently whether pg returns a
 * JavaScript Date or a string. Date-only strings are preserved to avoid a
 * timezone shift.
 */
function formatDate(value, fallback = '') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') {
    const isoDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoDate) return isoDate[1];
  }
  const date = asValidDate(value);
  return date ? date.toISOString().slice(0, 10) : fallback;
}

function formatDateTime(value, fallback = '') {
  const date = asValidDate(value);
  if (!date) return fallback;
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;
}

module.exports = { formatDate, formatDateTime };
