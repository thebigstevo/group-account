'use strict';

jest.mock('../dal', () => ({
  transaction: jest.fn(),
  audit: jest.fn()
}));

const dal = require('../dal');
const {
  TransferValidationError,
  normalizeTransferInput,
  createAccountTransfer
} = require('../transferService');

const validInput = {
  txDate: '2024-06-15',
  fromAccountId: 1,
  toAccountId: 2,
  amount: '500.00',
  reference: 'DEP-100',
  description: 'Cash deposited at bank',
  userId: 7
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('transfer input validation', () => {
  test('normalizes a valid two-decimal transfer', () => {
    expect(normalizeTransferInput(validInput)).toEqual({
      txDate: '2024-06-15', fromAccountId: 1, toAccountId: 2,
      amount: 500, reference: 'DEP-100', description: 'Cash deposited at bank', userId: 7
    });
  });

  test.each([
    [{ ...validInput, fromAccountId: 2 }, 'source and destination accounts must be different'],
    [{ ...validInput, amount: 0 }, 'Amount must be greater than zero'],
    [{ ...validInput, amount: '10.001' }, 'more than two decimal places'],
    [{ ...validInput, txDate: '' }, 'valid transfer date'],
    [{ ...validInput, toAccountId: 'bad' }, 'Select the account money is moving to']
  ])('rejects invalid transfer input %#', (input, message) => {
    expect(() => normalizeTransferInput(input)).toThrow(message);
  });
});

describe('atomic account transfer', () => {
  function arrangeClient(balance = '1000.00') {
    const client = { query: jest.fn() };
    client.query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Cash' }, { id: 2, name: 'Republic Bank' }] })
      .mockResolvedValueOnce({ rows: [{ current_balance: balance, balance_on_date: balance }] })
      .mockResolvedValueOnce({ rows: [{ id: 91 }] });
    dal.transaction.mockImplementation(async (callback) => callback(client));
    dal.audit.mockResolvedValue();
    return client;
  }

  test('locks both active accounts and records one audited transfer', async () => {
    const client = arrangeClient();

    await expect(createAccountTransfer(validInput)).resolves.toEqual({
      transactionId: 91, fromAccount: 'Cash', toAccount: 'Republic Bank', amount: 500
    });

    expect(client.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(client.query.mock.calls[0][1]).toEqual([[1, 2]]);
    expect(client.query.mock.calls[2][0]).toContain("VALUES ($1, 'transfer', $2, $3, 'Transfer'");
    expect(client.query.mock.calls[2][1]).toEqual([
      '2024-06-15', 1, 2, 'Cash deposited at bank', 500, 'DEP-100', 7
    ]);
    expect(dal.audit).toHaveBeenCalledWith(7, 'create', 'transfer', 91,
      expect.objectContaining({ from_account: 'Cash', to_account: 'Republic Bank', amount: 500 }),
      { client });
  });

  test('rejects an inactive source account before checking or inserting a transfer', async () => {
    const client = { query: jest.fn().mockResolvedValueOnce({ rows: [{ id: 2, name: 'Republic Bank' }] }) };
    dal.transaction.mockImplementation(async (callback) => callback(client));

    await expect(createAccountTransfer(validInput)).rejects.toThrow('source account is not active');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(dal.audit).not.toHaveBeenCalled();
  });

  test('rejects a transfer exceeding either current or transfer-date balance', async () => {
    const client = arrangeClient('400.00');

    await expect(createAccountTransfer(validInput)).rejects.toEqual(
      expect.objectContaining({ name: 'TransferValidationError', message: expect.stringContaining('400.00') })
    );
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(dal.audit).not.toHaveBeenCalled();
  });

  test('uses the lower historical balance when a transfer is backdated', async () => {
    const client = arrangeClient('1000.00');
    client.query.mockReset()
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Cash' }, { id: 2, name: 'Republic Bank' }] })
      .mockResolvedValueOnce({ rows: [{ current_balance: '1000.00', balance_on_date: '300.00' }] });

    await expect(createAccountTransfer(validInput)).rejects.toBeInstanceOf(TransferValidationError);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
