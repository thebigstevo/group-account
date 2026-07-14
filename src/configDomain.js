'use strict';

const CATEGORY_PURPOSES = ['standard', 'assessment', 'welfare_income', 'welfare_payout'];

function validateDuesRule(values) {
  const errors = [];
  const label = String(values.label || '').trim();
  const minAge = values.min_age === '' || values.min_age == null ? null : Number(values.min_age);
  const maxAge = values.max_age === '' || values.max_age == null ? null : Number(values.max_age);
  const assessment = Number(values.annual_assessment);
  const welfare = Number(values.welfare_portion);
  if (!label) errors.push('Label is required.');
  if (minAge != null && (!Number.isInteger(minAge) || minAge < 0)) errors.push('Minimum age must be a non-negative whole number.');
  if (maxAge != null && (!Number.isInteger(maxAge) || maxAge < 0)) errors.push('Maximum age must be a non-negative whole number.');
  if (minAge != null && maxAge != null && minAge > maxAge) errors.push('Minimum age cannot exceed maximum age.');
  if (!Number.isFinite(assessment) || assessment < 0) errors.push('Assessment must be zero or greater.');
  if (!Number.isFinite(welfare) || welfare < 0) errors.push('Welfare portion must be zero or greater.');
  if (Number.isFinite(assessment) && Number.isFinite(welfare) && welfare > assessment) errors.push('Welfare portion cannot exceed the assessment.');
  return { errors, values: { label, minAge, maxAge, assessment, welfare } };
}

function ageBandsOverlap(first, second) {
  const firstMin = first.min_age == null ? -Infinity : Number(first.min_age);
  const firstMax = first.max_age == null ? Infinity : Number(first.max_age);
  const secondMin = second.min_age == null ? -Infinity : Number(second.min_age);
  const secondMax = second.max_age == null ? Infinity : Number(second.max_age);
  return firstMin <= secondMax && secondMin <= firstMax;
}

function validateCategory(values) {
  const errors = [];
  const name = String(values.name || '').trim();
  const kind = String(values.kind || '');
  const purpose = String(values.purpose || 'standard');
  const sortOrder = Number(values.sort_order == null || values.sort_order === '' ? 100 : values.sort_order);
  if (!name) errors.push('Category name is required.');
  if (!['income', 'expense'].includes(kind)) errors.push('Select a valid category type.');
  if (!CATEGORY_PURPOSES.includes(purpose)) errors.push('Select a valid accounting purpose.');
  if (['assessment', 'welfare_income'].includes(purpose) && kind !== 'income') errors.push('Assessment and welfare collection purposes must be income categories.');
  if (purpose === 'welfare_payout' && kind !== 'expense') errors.push('Welfare payout purpose must be an expense category.');
  if (!Number.isInteger(sortOrder)) errors.push('Sort order must be a whole number.');
  return { errors, values: { name, kind, purpose, sortOrder } };
}

module.exports = { CATEGORY_PURPOSES, validateDuesRule, ageBandsOverlap, validateCategory };
