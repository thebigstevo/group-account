'use strict';

/**
 * Transaction Lifecycle Module
 *
 * Enforces the Draft → Posted → Reversed state machine for transactions.
 * Prevents edits to financial fields on posted/reversed transactions,
 * validates status transitions, and returns clear error messages.
 *
 * All functions are pure (no DB queries needed).
 */

// Transaction status constants
const TX_STATUS = Object.freeze({
  DRAFT: 'draft',
  POSTED: 'posted',
  REVERSED: 'reversed'
});

// Fields locked once status = 'posted'
const LOCKED_FIELDS = [
  'amount', 'tx_date', 'member_id', 'category',
  'account_id', 'to_account_id', 'welfare_component'
];

// Fields always editable (metadata)
const EDITABLE_FIELDS = ['description', 'reference', 'reconciled'];

// Valid forward-only status transitions
const VALID_TRANSITIONS = Object.freeze({
  [TX_STATUS.DRAFT]: TX_STATUS.POSTED,
  [TX_STATUS.POSTED]: TX_STATUS.REVERSED
});

/**
 * Validate whether proposed changes to a transaction are allowed based on its status.
 *
 * Rules:
 * - Draft: all changes allowed
 * - Posted: only EDITABLE_FIELDS allowed; locked fields return errors
 * - Reversed: no changes allowed
 *
 * @param {object} transaction - Valid transaction record from database
 * @param {object} proposedChanges - Object with field names as keys
 * @returns {{allowed: boolean, errors: string[]}}
 */
function validateTransactionEdit(transaction, proposedChanges) {
  const errors = [];
  const status = transaction.status;

  // Draft transactions can be freely edited
  if (status === TX_STATUS.DRAFT) {
    return { allowed: true, errors: [] };
  }

  // Reversed transactions cannot be edited at all
  if (status === TX_STATUS.REVERSED) {
    const changedFields = Object.keys(proposedChanges);
    if (changedFields.length > 0) {
      errors.push('Cannot modify a reversed transaction.');
      return { allowed: false, errors };
    }
    return { allowed: true, errors: [] };
  }

  // Posted transactions: only EDITABLE_FIELDS allowed
  if (status === TX_STATUS.POSTED) {
    const changedFields = Object.keys(proposedChanges);

    for (const field of changedFields) {
      if (LOCKED_FIELDS.includes(field)) {
        errors.push(
          `Cannot modify '${field}' on a posted transaction. To correct it, reverse and create a new transaction.`
        );
      } else if (!EDITABLE_FIELDS.includes(field)) {
        // Unknown field that isn't explicitly editable — treat as locked
        errors.push(
          `Cannot modify '${field}' on a posted transaction. To correct it, reverse and create a new transaction.`
        );
      }
    }

    return { allowed: errors.length === 0, errors };
  }

  // Unknown status — reject all changes
  errors.push(`Unknown transaction status: '${status}'.`);
  return { allowed: false, errors };
}

/**
 * Validate whether a status transition is allowed.
 * Only forward transitions are valid: draft → posted, posted → reversed.
 *
 * @param {string} currentStatus - The current transaction status
 * @param {string} newStatus - The proposed new status
 * @returns {{allowed: boolean, error: string|null}}
 */
function validateStatusTransition(currentStatus, newStatus) {
  if (currentStatus === newStatus) {
    return { allowed: false, error: `Transaction is already '${currentStatus}'.` };
  }

  const expectedNext = VALID_TRANSITIONS[currentStatus];

  if (!expectedNext) {
    return {
      allowed: false,
      error: `Cannot transition from '${currentStatus}'. No further transitions allowed.`
    };
  }

  if (newStatus !== expectedNext) {
    return {
      allowed: false,
      error: `Invalid transition: '${currentStatus}' → '${newStatus}'. Only '${currentStatus}' → '${expectedNext}' is allowed.`
    };
  }

  return { allowed: true, error: null };
}

module.exports = {
  TX_STATUS,
  LOCKED_FIELDS,
  EDITABLE_FIELDS,
  validateTransactionEdit,
  validateStatusTransition
};
