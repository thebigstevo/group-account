'use strict';

const ADJUSTMENT_TYPES = Object.freeze(['receipt', 'expense']);

function isIsoDateInYear(value, year) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number(text.slice(0, 4)) !== Number(year)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validateAuditAdjustment(input, year) {
  const values = {
    tx_type: String(input.tx_type || ''),
    tx_date: String(input.tx_date || ''),
    member_id: input.member_id ? Number(input.member_id) : null,
    account_id: Number(input.account_id),
    category: String(input.category || '').trim(),
    description: String(input.description || '').trim(),
    amount: Number(input.amount),
    welfare_component: input.welfare_component === '' || input.welfare_component == null
      ? null : Number(input.welfare_component),
    reference: String(input.reference || '').trim(),
    reason: String(input.reason || '').trim()
  };
  const errors = [];
  if (!ADJUSTMENT_TYPES.includes(values.tx_type)) errors.push('Select receipt or expense.');
  if (!isIsoDateInYear(values.tx_date, year)) errors.push(`The transaction date must be inside fiscal year ${year}.`);
  if (!Number.isInteger(values.account_id) || values.account_id < 1) errors.push('Select an account.');
  if (!values.category) errors.push('Select a category.');
  if (!Number.isFinite(values.amount) || values.amount <= 0) errors.push('Amount must be greater than zero.');
  if (values.welfare_component != null && (!Number.isFinite(values.welfare_component) || values.welfare_component < 0 || values.welfare_component > values.amount)) {
    errors.push('Welfare component must be between zero and the transaction amount.');
  }
  if (values.reference.length > 255) errors.push('Reference must not exceed 255 characters.');
  if (values.description.length > 1000) errors.push('Description must not exceed 1000 characters.');
  if (values.reason.length < 10) errors.push('Adjustment reason must be at least 10 characters.');
  if (values.reason.length > 2000) errors.push('Adjustment reason must not exceed 2000 characters.');
  return { errors, values };
}

function pendingAuditTransitionError(fiscalYear) {
  if (!fiscalYear || fiscalYear.status !== 'open' || !fiscalYear.is_active) {
    return 'Only the active open fiscal year can be submitted for audit.';
  }
  return null;
}

function finalCloseError(fiscalYear, review, proposedCount) {
  if (!fiscalYear || fiscalYear.status !== 'pending_audit') return 'Only a year pending audit can be permanently closed.';
  if (!review || review.status !== 'completed') return 'Complete and sign the trustee audit before permanently closing the year.';
  if (Number(proposedCount) > 0) return 'Approve or reject every proposed audit adjustment before permanently closing the year.';
  return null;
}

function approvalError(adjustment, approverId) {
  if (!adjustment || adjustment.status !== 'proposed') return 'Only a proposed audit adjustment can be decided.';
  if (Number(adjustment.requested_by) === Number(approverId)) return 'The person who proposed an adjustment cannot approve it.';
  return null;
}

module.exports = {
  ADJUSTMENT_TYPES,
  approvalError,
  finalCloseError,
  isIsoDateInYear,
  pendingAuditTransitionError,
  validateAuditAdjustment
};
