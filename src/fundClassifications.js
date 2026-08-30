'use strict';

const dal = require('./dal');

/**
 * Fund Classifications Service
 *
 * Provides access to fund classification records (e.g. Men's Operating, Joint Welfare).
 * Caches the default fund for performance; call clearCache() to invalidate.
 */

let cachedDefaultFund = null;

/**
 * Get all active fund classifications ordered by id.
 * @returns {Promise<Array<object>>} Active fund classification rows
 */
async function getActiveFunds() {
  return dal.query(
    'SELECT * FROM fund_classifications WHERE active = true ORDER BY id'
  );
}

/**
 * Get the default fund classification (cached after first fetch).
 * @returns {Promise<object|null>} The default fund or null if none configured
 */
async function getDefaultFund() {
  if (cachedDefaultFund) return cachedDefaultFund;
  const fund = await dal.queryOne(
    'SELECT * FROM fund_classifications WHERE is_default = true AND active = true LIMIT 1'
  );
  cachedDefaultFund = fund;
  return cachedDefaultFund;
}

/**
 * Get a specific fund classification by its code.
 * @param {string} code - The unique fund code (e.g. 'mens_operating', 'joint_welfare')
 * @returns {Promise<object|null>} The fund or null if not found/inactive
 */
async function getFundByCode(code) {
  return dal.queryOne(
    'SELECT * FROM fund_classifications WHERE code = $1 AND active = true',
    [code]
  );
}

/**
 * Clear the cached default fund. Call this when fund classifications are modified.
 */
function clearCache() {
  cachedDefaultFund = null;
}

module.exports = {
  getActiveFunds,
  getDefaultFund,
  getFundByCode,
  clearCache
};
