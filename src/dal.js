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

// ─── Rank Definitions (Admin-managed lookup) ──────────────────────────────

/**
 * Get all rank definitions for a commandery (active ones first, sorted by sort_order).
 */
async function getRankDefinitions(commanderyId, activeOnly = true) {
  const condition = activeOnly ? 'AND active = true' : '';
  return query(`SELECT * FROM rank_definitions WHERE commandery_id = $1 ${condition} ORDER BY sort_order, title`, [commanderyId]);
}

/**
 * Create a new rank definition.
 */
async function createRankDefinition(commanderyId, title, sortOrder, createdBy) {
  const result = await executeWithRetry(
    `INSERT INTO rank_definitions (commandery_id, title, sort_order, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
    [commanderyId, title.trim(), sortOrder || 0, createdBy]
  );
  return result.rows[0];
}

/**
 * Update a rank definition (title, sort_order, active).
 */
async function updateRankDefinition(id, data) {
  const result = await executeWithRetry(
    `UPDATE rank_definitions SET title = $1, sort_order = $2, active = $3 WHERE id = $4 RETURNING *`,
    [data.title.trim(), data.sort_order || 0, data.active !== false, id]
  );
  return result.rows[0];
}

// ─── Position Definitions (Admin-managed lookup) ──────────────────────────

/**
 * Get all position definitions for a commandery.
 */
async function getPositionDefinitions(commanderyId, activeOnly = true) {
  const condition = activeOnly ? 'AND active = true' : '';
  return query(`SELECT * FROM position_definitions WHERE commandery_id = $1 ${condition} ORDER BY level, sort_order, title`, [commanderyId]);
}

/**
 * Create a new position definition.
 */
async function createPositionDefinition(commanderyId, title, level, sortOrder, createdBy) {
  const result = await executeWithRetry(
    `INSERT INTO position_definitions (commandery_id, title, level, sort_order, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [commanderyId, title.trim(), level, sortOrder || 0, createdBy]
  );
  return result.rows[0];
}

/**
 * Update a position definition (title, level, sort_order, active).
 */
async function updatePositionDefinition(id, data) {
  const result = await executeWithRetry(
    `UPDATE position_definitions SET title = $1, level = $2, sort_order = $3, active = $4 WHERE id = $5 RETURNING *`,
    [data.title.trim(), data.level, data.sort_order || 0, data.active !== false, id]
  );
  return result.rows[0];
}

// ─── Member Degrees ───────────────────────────────────────────────────────

/**
 * Get all degree records for a member, ordered by degree number.
 */
async function getMemberDegrees(memberId) {
  return query('SELECT * FROM member_degrees WHERE member_id = $1 ORDER BY degree', [memberId]);
}

/**
 * Record a degree conferred on a member (upsert — one record per degree per member).
 */
async function conferDegree(commanderyId, memberId, degree, dateConferred, conferringAuthority, notes, createdBy) {
  const result = await executeWithRetry(`
    INSERT INTO member_degrees (commandery_id, member_id, degree, date_conferred, conferring_authority, notes, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (member_id, degree) DO UPDATE SET
      date_conferred = EXCLUDED.date_conferred,
      conferring_authority = EXCLUDED.conferring_authority,
      notes = EXCLUDED.notes
    RETURNING *
  `, [commanderyId, memberId, degree, dateConferred, conferringAuthority || null, notes || null, createdBy]);
  return result.rows[0];
}

// ─── Rank History ──────────────────────────────────────────────────────────

/**
 * Get all rank history entries for a member, ordered by most recent first.
 * @param {number} memberId - The member ID
 * @returns {Promise<Array<object>>} Rank history rows
 */
async function getRankHistory(memberId) {
  const sql = `
    SELECT id, rank_title, date_conferred, conferring_authority, created_at
    FROM member_rank_history
    WHERE member_id = $1
    ORDER BY date_conferred DESC
  `;
  return query(sql, [memberId]);
}

/**
 * Create a new rank history entry for a member.
 * @param {number} commanderyId - The commandery ID
 * @param {number} memberId - The member ID
 * @param {object} data - Rank entry data
 * @param {string} data.rank_title - Title of the rank
 * @param {string} data.date_conferred - Date the rank was conferred (YYYY-MM-DD)
 * @param {string} [data.conferring_authority] - Authority or event that conferred the rank
 * @param {number} createdBy - User ID of the person creating the entry
 * @returns {Promise<object>} The created rank history row
 */
async function createRankEntry(commanderyId, memberId, data, createdBy) {
  const sql = `
    INSERT INTO member_rank_history (commandery_id, member_id, rank_title, date_conferred, conferring_authority, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  const params = [
    commanderyId,
    memberId,
    data.rank_title,
    data.date_conferred,
    data.conferring_authority || null,
    createdBy,
  ];
  const result = await executeWithRetry(sql, params);
  return result.rows[0];
}

// ─── Position History ──────────────────────────────────────────────────────

/**
 * Get all position history entries for a member, ordered by start_date DESC.
 * @param {number} memberId - The member ID
 * @returns {Promise<Array<object>>} Position history rows
 */
async function getPositionHistory(memberId) {
  const sql = `
    SELECT id, position_title, position_level, start_date, end_date, created_at
    FROM member_position_history
    WHERE member_id = $1
    ORDER BY start_date DESC
  `;
  return query(sql, [memberId]);
}

/**
 * Create a new position history entry for a member.
 * @param {number} commanderyId - The commandery ID
 * @param {number} memberId - The member ID
 * @param {object} data - Position entry data
 * @param {string} data.position_title - Title of the position
 * @param {string} data.start_date - Start date (YYYY-MM-DD)
 * @param {string} [data.end_date] - End date (YYYY-MM-DD), null if currently held
 * @param {number} createdBy - User ID of the person creating the entry
 * @returns {Promise<object>} The created position history row
 */
async function createPositionEntry(commanderyId, memberId, data, createdBy) {
  const sql = `
    INSERT INTO member_position_history
      (commandery_id, member_id, position_title, position_level, start_date, end_date, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `;
  const params = [
    commanderyId,
    memberId,
    data.position_title,
    data.position_level || 'local_commandery',
    data.start_date,
    data.end_date || null,
    createdBy,
  ];
  const result = await executeWithRetry(sql, params);
  return result.rows[0];
}

/**
 * Set the end date on a position history entry (mark position as concluded).
 * @param {number} positionId - The position history entry ID
 * @param {string|Date} endDate - The end date to set
 * @param {number} updatedBy - User ID of the person updating the entry
 * @returns {Promise<object|null>} The updated row or null if not found
 */
async function setPositionEndDate(positionId, endDate, updatedBy) {
  const sql = `
    UPDATE member_position_history
    SET end_date = $1, updated_by = $2, updated_at = NOW()
    WHERE id = $3
    RETURNING *
  `;
  const params = [endDate, updatedBy, positionId];
  const result = await executeWithRetry(sql, params);
  return result.rows[0] || null;
}

// ─── Audit Flags ───────────────────────────────────────────────────────────

/**
 * Create an audit flag on a transaction within a review.
 * @param {number} reviewId - The audit review ID
 * @param {number} transactionId - The transaction being flagged
 * @param {string} reason - Reason for the flag (1-1000 chars)
 * @param {number} userId - The user creating the flag
 * @returns {Promise<object>} The created audit_flags row
 */
async function createAuditFlag(reviewId, transactionId, reason, userId) {
  const sql = `
    INSERT INTO audit_flags (review_id, transaction_id, reason, flagged_by)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  const result = await executeWithRetry(sql, [reviewId, transactionId, reason, userId]);
  return result.rows[0];
}

/**
 * Get all audit flags for a given review.
 * @param {number} reviewId - The audit review ID
 * @returns {Promise<Array<object>>} Flags with flagged_by_name joined from users
 */
async function getAuditFlags(reviewId) {
  const sql = `
    SELECT af.*, u.display_name as flagged_by_name
    FROM audit_flags af
    LEFT JOIN users u ON af.flagged_by = u.id
    WHERE af.review_id = $1
    ORDER BY af.flagged_at DESC
  `;
  return query(sql, [reviewId]);
}

// ─── Audit Transaction Notes ───────────────────────────────────────────────

/**
 * Create an investigation note on a transaction within a review.
 * @param {number} reviewId - The audit review ID
 * @param {number} transactionId - The transaction being annotated
 * @param {string} note - Note text (1-1000 chars)
 * @param {number} userId - The user creating the note
 * @returns {Promise<object>} The created audit_transaction_notes row
 */
async function createTransactionNote(reviewId, transactionId, note, userId) {
  const sql = `
    INSERT INTO audit_transaction_notes (review_id, transaction_id, note, created_by)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `;
  const result = await executeWithRetry(sql, [reviewId, transactionId, note, userId]);
  return result.rows[0];
}

/**
 * Get all investigation notes for a specific transaction within a review.
 * @param {number} reviewId - The audit review ID
 * @param {number} transactionId - The transaction ID
 * @returns {Promise<Array<object>>} Notes with created_by_name joined from users
 */
async function getTransactionNotes(reviewId, transactionId) {
  const sql = `
    SELECT atn.*, u.display_name as created_by_name
    FROM audit_transaction_notes atn
    LEFT JOIN users u ON atn.created_by = u.id
    WHERE atn.review_id = $1 AND atn.transaction_id = $2
    ORDER BY atn.created_at ASC
  `;
  return query(sql, [reviewId, transactionId]);
}

// ─── Member Transfers ──────────────────────────────────────────────────────

/**
 * Get the transfer record for a member.
 * @param {number} memberId - The member ID
 * @returns {Promise<object|null>} Transfer record or null if none exists
 */
async function getTransferRecord(memberId) {
  const sql = `
    SELECT id, origin_commandery_name, transfer_date, reference_number, created_at
    FROM member_transfers
    WHERE member_id = $1
  `;
  return queryOne(sql, [memberId]);
}

/**
 * Create or update a transfer record for a member.
 * Uses upsert (INSERT ON CONFLICT UPDATE) since each member can have at most one transfer record.
 * @param {number} commanderyId - The commandery ID
 * @param {number} memberId - The member ID
 * @param {object} data - Transfer data
 * @param {string} data.origin_commandery_name - Origin commandery name
 * @param {string} data.transfer_date - Transfer date (ISO string or date)
 * @param {string|null} [data.reference_number] - Optional reference number
 * @param {number} userId - The user performing the action
 * @returns {Promise<object>} The created or updated transfer record
 */
async function upsertTransferRecord(commanderyId, memberId, data, userId) {
  const sql = `
    INSERT INTO member_transfers (commandery_id, member_id, origin_commandery_name, transfer_date, reference_number, created_by)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (member_id) DO UPDATE SET
      origin_commandery_name = EXCLUDED.origin_commandery_name,
      transfer_date = EXCLUDED.transfer_date,
      reference_number = EXCLUDED.reference_number,
      updated_by = $6,
      updated_at = NOW()
    RETURNING *
  `;
  const params = [
    commanderyId,
    memberId,
    data.origin_commandery_name,
    data.transfer_date,
    data.reference_number || null,
    userId,
  ];
  const result = await executeWithRetry(sql, params);
  return result.rows[0];
}

module.exports = {
  query,
  queryOne,
  run,
  transaction,
  shutdown,
  audit,
  getRankDefinitions,
  createRankDefinition,
  updateRankDefinition,
  getPositionDefinitions,
  createPositionDefinition,
  updatePositionDefinition,
  getMemberDegrees,
  conferDegree,
  getRankHistory,
  createRankEntry,
  getPositionHistory,
  createPositionEntry,
  setPositionEndDate,
  getTransferRecord,
  upsertTransferRecord,
  createAuditFlag,
  getAuditFlags,
  createTransactionNote,
  getTransactionNotes,
  pool, // Exposed for session store and direct access if needed
};
