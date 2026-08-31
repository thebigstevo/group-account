'use strict';

const dal = require('./dal');
const { getDefaultFund, getFundByCode } = require('./fundClassifications');

/**
 * Allocation Service
 *
 * Determines how a receipt amount should be split across fund classifications
 * (e.g. Men's Operating vs Joint Welfare) using the welfare amount already
 * calculated from the effective member, dues, or category rule.
 *
 * Key invariant: SUM(allocations[].amount) === input amount (no rounding loss).
 * The remainder goes to operating.
 */

/**
 * Look up the active payment_splits rule for a given category and year.
 * @param {string} category - The transaction category name
 * @param {number} year - The fiscal year
 * @returns {Promise<object|null>} The split rule or null
 */
async function getSplitRule(category, year) {
  return dal.queryOne(
    'SELECT * FROM payment_splits WHERE category = $1 AND year = $2 AND active = true',
    [category, year]
  );
}

/**
 * Calculate fund allocations for a receipt amount.
 *
 * Algorithm:
 * 1. Prefer the supplied welfare component calculated by the receipt workflow
 * 2. For backward compatibility, otherwise look up payment_splits
 * 3. Allocate the welfare amount exactly and send the remainder to operating
 * 4. Guarantees SUM(allocations) === amount (no rounding loss)
 *
 * @param {number} amount - Positive receipt amount
 * @param {string} category - Transaction category
 * @param {number} year - Fiscal year
 * @param {number|null} [memberId=null] - Optional member ID (retained for API compatibility)
 * @param {number|null} [welfareComponent=null] - Effective welfare amount for this receipt
 * @returns {Promise<Array<{fund_classification_id: number, amount: number}>>}
 * @throws {Error} If amount is not positive
 */
async function calculateAllocations(amount, category, year, memberId = null, welfareComponent = null) {
  if (!amount || amount <= 0) {
    throw new Error('Amount must be positive');
  }

  let welfareAllocation;
  if (welfareComponent !== null && welfareComponent !== undefined) {
    welfareAllocation = Math.round(Number(welfareComponent) * 100) / 100;
    if (!Number.isFinite(welfareAllocation) || welfareAllocation < 0 || welfareAllocation > amount) {
      throw new Error('Welfare component must be between zero and the receipt amount');
    }
  } else {
    const splitRule = await getSplitRule(category, year);
    const assessmentAmount = splitRule ? Number(splitRule.assessment_amount) || 0 : 0;
    const welfareAmount = splitRule ? Number(splitRule.welfare_amount) || 0 : 0;
    // assessment_amount is the full receipt amount, inclusive of welfare.
    welfareAllocation = assessmentAmount > 0
      ? Math.round((amount * welfareAmount / assessmentAmount) * 100) / 100
      : 0;
  }

  if (welfareAllocation === 0) {
    const defaultFund = await getDefaultFund();
    if (!defaultFund) {
      throw new Error('No default fund classification configured');
    }
    return [{ fund_classification_id: defaultFund.id, amount }];
  }

  const operatingAllocation = Math.round((amount - welfareAllocation) * 100) / 100;

  // Fetch fund classification IDs
  const operatingFund = await getFundByCode('mens_operating');
  const welfareFund = await getFundByCode('joint_welfare');

  if (!operatingFund) {
    throw new Error('Operating fund classification (mens_operating) not found');
  }
  if (!welfareFund) {
    throw new Error('Welfare fund classification (joint_welfare) not found');
  }

  const allocations = [];

  if (operatingAllocation > 0) {
    allocations.push({
      fund_classification_id: operatingFund.id,
      amount: operatingAllocation
    });
  }

  if (welfareAllocation > 0) {
    allocations.push({
      fund_classification_id: welfareFund.id,
      amount: welfareAllocation
    });
  }

  return allocations;
}

/**
 * Allocate an outgoing transaction to the fund that bears the cost.
 * Allocation amounts are stored as positive magnitudes; reporting applies the
 * transaction type's sign when calculating a fund balance.
 *
 * @param {number} amount - Positive expense amount
 * @param {string} purpose - Transaction category purpose
 * @returns {Promise<Array<{fund_classification_id: number, amount: number}>>}
 */
async function calculateExpenseAllocations(amount, purpose) {
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new Error('Amount must be positive');
  }

  const fundCode = purpose === 'welfare_payout' ? 'joint_welfare' : 'mens_operating';
  const fund = await getFundByCode(fundCode);
  if (!fund) {
    throw new Error(`Fund classification (${fundCode}) not found`);
  }

  return [{ fund_classification_id: fund.id, amount: Number(amount) }];
}

module.exports = { calculateAllocations, calculateExpenseAllocations };
