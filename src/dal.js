'use strict';

const { Pool } = require('pg');
const config = require('./config');

// Connection errors that warrant a retry
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECTION_FAILURE',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/**
 * Determine if an error is a transient connection error worth retrying.
 */
function isRetryableError(err) {
  if (!err) return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  if (err.errno && RETRYABLE_CODES.has(err.errno)) return true;
  // Check message for common connection failure patterns
  const msg = (err.message || '').toLowerCase();
  return msg.includes('connection refused') ||
    msg.includes('connection terminated unexpectedly') ||
    msg.includes('connection timed out');
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize the connection pool
const pool = new Pool({
  connectionString: config.databaseUrl || undefined,
  host: config.databaseUrl ? undefined : config.pgHost,
  port: config.databaseUrl ? undefined : config.pgPort,
  database: config.databaseUrl ? undefined : config.pgDatabase,
  user: config.databaseUrl ? undefined : config.pgUser,
  password: config.databaseUrl ? undefined : config.pgPassword,
  max: config.pgPoolSize,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
});

// Log pool errors (do not crash the process)
pool.on('error', (err) => {
  console.error('Unexpected idle client error:', err.message);
});

/**
 * Execute a query with retry logic for transient connection errors.
 * @param {string} sql - SQL with $1, $2 placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function executeWithRetry(sql, params = []) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === MAX_RETRIES) {
        throw err;
      }
      // Exponential backoff: 1s, 2s, 4s
      const delay = BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Execute a query returning all matching rows.
 * @param {string} sql - SQL with $1, $2 placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<Array<object>>} Row objects
 */
async function query(sql, params = []) {
  const result = await executeWithRetry(sql, params);
  return result.rows;
}

/**
 * Execute a query returning the first row or null.
 * @param {string} sql - SQL with $1, $2 placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<object|null>}
 */
async function queryOne(sql, params = []) {
  const result = await executeWithRetry(sql, params);
  return result.rows[0] || null;
}

/**
 * Execute a statement (INSERT/UPDATE/DELETE).
 * @param {string} sql - SQL with $1, $2 placeholders
 * @param {Array} params - Parameter values
 * @returns {Promise<{rowCount: number, rows: Array}>}
 */
async function run(sql, params = []) {
  const result = await executeWithRetry(sql, params);
  return { rowCount: result.rowCount, rows: result.rows };
}

/**
 * Execute multiple statements in a transaction.
 * Acquires a client, runs BEGIN, calls the callback with the client,
 * COMMITs on success, ROLLBACKs and rethrows on error, always releases.
 * @param {function(import('pg').PoolClient): Promise<any>} callback
 * @returns {Promise<any>} Return value of callback
 */
async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Drain the connection pool (for graceful shutdown).
 * @returns {Promise<void>}
 */
async function shutdown() {
  await pool.end();
}

/**
 * Insert an audit log entry.
 * @param {number|null} userId - The user performing the action
 * @param {string} action - Action name (e.g. 'create', 'update', 'delete')
 * @param {string} entity - Entity type (e.g. 'transaction', 'member')
 * @param {number|string|null} entityId - ID of the affected entity
 * @param {object|string|null} details - Additional details (will be JSON-stringified if object)
 * @param {object} [options] - Options object
 * @param {import('pg').PoolClient} [options.client] - Optional client for use within transactions
 */
async function audit(userId, action, entity, entityId, details, options = {}) {
  const detailsStr = details && typeof details === 'object'
    ? JSON.stringify(details)
    : (details || null);

  const sql = `
    INSERT INTO audit_log (
      user_id, action, entity, entity_id, details, before_value, after_value,
      ip_address, user_agent, reason, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
  `;
  const serialize = (value) => value == null ? null : (typeof value === 'string' ? value : JSON.stringify(value));
  const params = [
    userId, action, entity, entityId, detailsStr,
    serialize(options.before_value), serialize(options.after_value),
    options.ip_address || null, options.user_agent || null, options.reason || null
  ];

  if (options && options.client) {
    await options.client.query(sql, params);
  } else {
    await executeWithRetry(sql, params);
  }
}

module.exports = {
  query,
  queryOne,
  run,
  transaction,
  shutdown,
  audit,
  pool, // Exposed for session store and direct access if needed
};
