'use strict';

function validateActiveFiscalDate(activeFiscalYear, value) {
  const year = Number(String(value || '').slice(0, 4));
  if (!year) return 'Enter a valid transaction date.';
  if (!activeFiscalYear) return 'Select an active fiscal year before recording transactions.';
  if (year !== Number(activeFiscalYear.year)) {
    return `Transactions must be recorded in the active fiscal year ${activeFiscalYear.year}.`;
  }
  return null;
}

module.exports = { validateActiveFiscalDate };
