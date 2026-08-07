'use strict';

const dal = require('./dal');

/**
 * Create a proper financial reversal for a posted transaction.
 *
 * The reversal creates a new transaction that negates the financial effect
 * of the original, marks the original as reversed, copies and negates all
 * receipt_allocations, and writes audit trail entries for both transactions.
 *
 * @param {object} original - The posted transaction record to reverse
 * @param {string} reason - Required reversal reason
 * @param {number} userId - User performing the reversal
 * @returns {Promise<{reversalId: number}>}
 * @throws {Error} If original is not posted, already reversed, or reason is empty
 */
async function createReversal(original, reason, userId) {
  // ─── Input Validation ─────────────────────────────────────────────────────
  if (!original || typeof original !== 'object') {
    throw new Error('Original transaction is required');
  }

  if (original.status !== 'posted') {
    throw new Error(
      `Cannot reverse transaction #${original.id}: status is '${original.status}', must be 'posted'`
    );
  }

  if (original.reversal_transaction_id != null) {
    throw new Error(
      `Cannot reverse transaction #${original.id}: it has already been reversed (reversal_transaction_id = ${original.reversal_transaction_id})`
    );
  }

  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('Reversal reason is required and must be a non-empty string');
  }

  const trimmedReason = reason.trim();

  // ─── Execute in a DB Transaction ──────────────────────────────────────────
  const reversalId = await dal.transaction(async (client) => {
    // 1. Create the reversal transaction
    const insertReversalSql = `
      INSERT INTO transactions (
        tx_date, tx_type, member_id, account_id, to_account_id,
        category, description, amount, welfare_component,
        status, reverses_transaction_id, reversed_by_user, reversal_reason,
        created_by, created_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        'posted', $10, $11, $12,
        $11, NOW()
      ) RETURNING id
    `;
    const reversalParams = [
      original.tx_date,
      original.tx_type,
      original.member_id || null,
      original.account_id || null,
      original.to_account_id || null,
      original.category,
      'REVERSAL: ' + (original.description || ''),
      original.amount,
      original.welfare_component || 0,
      original.id,        // reverses_transaction_id
      userId,             // reversed_by_user / created_by
      trimmedReason       // reversal_reason
    ];

    const reversalResult = await client.query(insertReversalSql, reversalParams);
    const newReversalId = reversalResult.rows[0].id;

    // 2. Copy and negate all receipt_allocations from the original
    const allocationsResult = await client.query(
      'SELECT * FROM receipt_allocations WHERE transaction_id = $1',
      [original.id]
    );

    for (const alloc of allocationsResult.rows) {
      await client.query(
        `INSERT INTO receipt_allocations (
          transaction_id, fund_classification_id, amount, category, description, created_at
        ) VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          newReversalId,
          alloc.fund_classification_id,
          -Math.abs(parseFloat(alloc.amount)),  // Negate the amount
          alloc.category || null,
          'Reversal of allocation #' + alloc.id
        ]
      );
    }

    // 3. Mark original as reversed with metadata
    await client.query(
      `UPDATE transactions SET
        status = 'reversed',
        reversal_transaction_id = $1,
        reversed_at = NOW(),
        reversed_by_user = $2,
        reversal_reason = $3
      WHERE id = $4`,
      [newReversalId, userId, trimmedReason, original.id]
    );

    // 4. Audit trail for original transaction (marked as reversed)
    await dal.audit(
      userId,
      'reverse',
      'transaction',
      original.id,
      {
        reversal_transaction_id: newReversalId,
        reason: trimmedReason,
        original_amount: original.amount,
        original_category: original.category
      },
      { client }
    );

    // 5. Audit trail for the new reversal transaction
    await dal.audit(
      userId,
      'create_reversal',
      'transaction',
      newReversalId,
      {
        reverses_transaction_id: original.id,
        reason: trimmedReason,
        original_amount: original.amount,
        original_category: original.category
      },
      { client }
    );

    return newReversalId;
  });

  return { reversalId };
}

module.exports = { createReversal };
