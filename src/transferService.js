'use strict';

const dal = require('./dal');

class TransferValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransferValidationError';
  }
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeTransferInput(input) {
  const fromAccountId = Number(input.fromAccountId);
  const toAccountId = Number(input.toAccountId);
  const amount = Number(input.amount);
  const txDate = String(input.txDate || '').trim();
  const description = String(input.description || '').trim();
  const reference = String(input.reference || '').trim();
  const userId = Number(input.userId);

  if (!isValidIsoDate(txDate)) {
    throw new TransferValidationError('Enter a valid transfer date.');
  }
  if (!Number.isInteger(fromAccountId) || fromAccountId <= 0) {
    throw new TransferValidationError('Select the account money is moving from.');
  }
  if (!Number.isInteger(toAccountId) || toAccountId <= 0) {
    throw new TransferValidationError('Select the account money is moving to.');
  }
  if (fromAccountId === toAccountId) {
    throw new TransferValidationError('The source and destination accounts must be different.');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TransferValidationError('Amount must be greater than zero.');
  }
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    throw new TransferValidationError('Amount must not have more than two decimal places.');
  }
  if (amount > 9999999999.99) {
    throw new TransferValidationError('Amount is too large.');
  }
  if (reference.length > 255) {
    throw new TransferValidationError('Reference must be 255 characters or fewer.');
  }
  if (description.length > 1000) {
    throw new TransferValidationError('Description must be 1,000 characters or fewer.');
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new TransferValidationError('A valid user is required.');
  }

  return {
    fromAccountId,
    toAccountId,
    amount: Math.round(amount * 100) / 100,
    txDate,
    description: description || null,
    reference: reference || null,
    userId
  };
}

function normalizeTransferPeriod(year, startDate = '', endDate = '') {
  const fiscalYear = Number(year);
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) {
    throw new TransferValidationError('Select a valid fiscal year.');
  }

  const start = String(startDate || `${fiscalYear}-01-01`).trim();
  const end = String(endDate || `${fiscalYear}-12-31`).trim();
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) {
    throw new TransferValidationError('Enter valid report start and end dates.');
  }
  if (!start.startsWith(`${fiscalYear}-`) || !end.startsWith(`${fiscalYear}-`)) {
    throw new TransferValidationError(`Transfer reports must remain within fiscal year ${fiscalYear}.`);
  }
  if (start > end) {
    throw new TransferValidationError('Report start date must be on or before the end date.');
  }

  return { startDate: start, endDate: end };
}

async function createAccountTransfer(input) {
  const transfer = normalizeTransferInput(input);

  return dal.transaction(async (client) => {
    // Lock both accounts in a stable order so concurrent transfers cannot
    // spend the same source balance or deadlock each other.
    const accountsResult = await client.query(`
      SELECT id, name
      FROM accounts
      WHERE id = ANY($1::int[]) AND active = true
      ORDER BY id
      FOR UPDATE
    `, [[transfer.fromAccountId, transfer.toAccountId]]);

    const accountsById = new Map(accountsResult.rows.map((account) => [Number(account.id), account]));
    const source = accountsById.get(transfer.fromAccountId);
    const destination = accountsById.get(transfer.toAccountId);
    if (!source) throw new TransferValidationError('The source account is not active or does not exist.');
    if (!destination) throw new TransferValidationError('The destination account is not active or does not exist.');

    const balanceResult = await client.query(`
      SELECT
        a.opening_balance + COALESCE(SUM(
          CASE
            WHEN (t.tx_type = 'receipt' AND t.account_id = a.id)
              OR (t.tx_type = 'transfer' AND t.to_account_id = a.id) THEN t.amount
            WHEN (t.tx_type IN ('expense', 'welfare_payout') AND t.account_id = a.id)
              OR (t.tx_type = 'transfer' AND t.account_id = a.id) THEN -t.amount
            ELSE 0
          END
        ), 0) AS current_balance,
        a.opening_balance + COALESCE(SUM(
          CASE WHEN t.tx_date <= $2 THEN
            CASE
              WHEN (t.tx_type = 'receipt' AND t.account_id = a.id)
                OR (t.tx_type = 'transfer' AND t.to_account_id = a.id) THEN t.amount
              WHEN (t.tx_type IN ('expense', 'welfare_payout') AND t.account_id = a.id)
                OR (t.tx_type = 'transfer' AND t.account_id = a.id) THEN -t.amount
              ELSE 0
            END
          ELSE 0 END
        ), 0) AS balance_on_date
      FROM accounts a
      LEFT JOIN transactions t ON t.status = 'posted'
        AND t.reverses_transaction_id IS NULL
        AND (t.account_id = a.id OR t.to_account_id = a.id)
      WHERE a.id = $1
      GROUP BY a.id, a.opening_balance
    `, [transfer.fromAccountId, transfer.txDate]);

    const sourceBalance = balanceResult.rows[0];
    const currentBalance = Number(sourceBalance.current_balance);
    const balanceOnDate = Number(sourceBalance.balance_on_date);
    const availableBalance = Math.min(currentBalance, balanceOnDate);
    if (transfer.amount > availableBalance) {
      throw new TransferValidationError(
        `Transfer exceeds the available source balance of ${availableBalance.toFixed(2)}.`
      );
    }

    const result = await client.query(`
      INSERT INTO transactions (
        tx_date, tx_type, account_id, to_account_id, category,
        description, amount, status, reference, created_by
      ) VALUES ($1, 'transfer', $2, $3, 'Transfer', $4, $5, 'posted', $6, $7)
      RETURNING id
    `, [
      transfer.txDate,
      transfer.fromAccountId,
      transfer.toAccountId,
      transfer.description,
      transfer.amount,
      transfer.reference,
      transfer.userId
    ]);

    const transactionId = result.rows[0].id;
    await dal.audit(transfer.userId, 'create', 'transfer', transactionId, {
      from_account_id: transfer.fromAccountId,
      from_account: source.name,
      to_account_id: transfer.toAccountId,
      to_account: destination.name,
      amount: transfer.amount,
      reference: transfer.reference
    }, { client });

    return {
      transactionId,
      fromAccount: source.name,
      toAccount: destination.name,
      amount: transfer.amount
    };
  });
}

module.exports = {
  TransferValidationError,
  normalizeTransferInput,
  normalizeTransferPeriod,
  createAccountTransfer
};
