'use strict';

const dal = require('./dal');
const { getDefaultFund, getFundByCode } = require('./fundClassifications');

/**
 * Allocation Service
 *
 * Determines how a receipt amount should be split across fund classifications
 * (e.g. Men's Operating vs Joint Welfare) based on payment_splits rules.
 *
 * Key invariant: SUM(allocations[].amount) === input amount (no rounding loss).
 * Uses ROUND_DOWN for welfare portion; remainder goes to operating.
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
 * 1. Look up payment_splits rule for (category, year)
 * 2. If no rule or zero total → allocate 100% to default fund
 * 3. Otherwise compute welfare ratio, ROUND_DOWN welfare, remainder to operating
 * 4. Guarantees SUM(allocations) === amount (no rounding loss)
 *
 * @param {number} amount - Positive receipt amount
 * @param {string} category - Transaction category
 * @param {number} year - Fiscal year
 * @param {number|null} [memberId=null] - Optional member ID (reserved for future per-member rules)
 * @returns {Promise<Array<{fund_classification_id: number, amount: number}>>}
 * @throws {Error} If amount is not positive
 */
async function calculateAllocations(amount, category, year, memberId = null) {
  if (!amount || amount <= 0) {
    throw new Error('Amount must be positive');
  }

  const splitRule = await getSplitRule(category, year);

  // No rule → allocate everything to the default fund
  if (!splitRule) {
    const defaultFund = await getDefaultFund();
    if (!defaultFund) {
      throw new Error('No default fund classification configured');
    }
    return [{ fund_classification_id: defaultFund.id, amount }];
  }

  const assessmentAmount = Number(splitRule.assessment_amount) || 0;
  const welfareAmount = Number(splitRule.welfare_amount) || 0;
  const totalRuleAmount = assessmentAmount + welfareAmount;

  // Zero total in rule → treat as no rule (all to default)
  if (totalRuleAmount === 0) {
    const defaultFund = await getDefaultFund();
    if (!defaultFund) {
      throw new Error('No default fund classification configured');
    }
    return [{ fund_classification_id: defaultFund.id, amount }];
  }

  // Calculate proportional welfare allocation using ROUND_DOWN
  const welfareRatio = welfareAmount / totalRuleAmount;
  const welfareAllocation = Math.floor(amount * welfareRatio * 100) / 100;
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

module.exports = { calculateAllocations };
