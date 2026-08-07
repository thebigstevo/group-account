'use strict';

const {
  TX_STATUS,
  LOCKED_FIELDS,
  EDITABLE_FIELDS,
  validateTransactionEdit,
  validateStatusTransition
} = require('../transactionLifecycle');

describe('transactionLifecycle', () => {
  describe('TX_STATUS', () => {
    it('has the expected status values', () => {
      expect(TX_STATUS.DRAFT).toBe('draft');
      expect(TX_STATUS.POSTED).toBe('posted');
      expect(TX_STATUS.REVERSED).toBe('reversed');
    });

    it('is frozen (immutable)', () => {
      expect(Object.isFrozen(TX_STATUS)).toBe(true);
    });
  });

  describe('LOCKED_FIELDS', () => {
    it('contains the required financial fields', () => {
      expect(LOCKED_FIELDS).toContain('amount');
      expect(LOCKED_FIELDS).toContain('tx_date');
      expect(LOCKED_FIELDS).toContain('member_id');
      expect(LOCKED_FIELDS).toContain('category');
      expect(LOCKED_FIELDS).toContain('account_id');
      expect(LOCKED_FIELDS).toContain('to_account_id');
      expect(LOCKED_FIELDS).toContain('welfare_component');
    });
  });

  describe('EDITABLE_FIELDS', () => {
    it('contains the expected metadata fields', () => {
      expect(EDITABLE_FIELDS).toContain('description');
      expect(EDITABLE_FIELDS).toContain('reference');
      expect(EDITABLE_FIELDS).toContain('reconciled');
    });
  });

  describe('validateTransactionEdit', () => {
    describe('draft transactions', () => {
      const draftTx = { status: 'draft' };

      it('allows changes to any field', () => {
        const result = validateTransactionEdit(draftTx, {
          amount: 1000, tx_date: '2025-01-01', description: 'test'
        });
        expect(result).toEqual({ allowed: true, errors: [] });
      });

      it('allows empty changes', () => {
        const result = validateTransactionEdit(draftTx, {});
        expect(result).toEqual({ allowed: true, errors: [] });
      });
    });

    describe('posted transactions', () => {
      const postedTx = { status: 'posted' };

      it('allows changes to editable fields only', () => {
        const result = validateTransactionEdit(postedTx, {
          description: 'updated', reference: 'REF-001', reconciled: true
        });
        expect(result).toEqual({ allowed: true, errors: [] });
      });

      it('rejects changes to locked fields with user-friendly error', () => {
        const result = validateTransactionEdit(postedTx, { amount: 500 });
        expect(result.allowed).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/Cannot modify 'amount' on a posted transaction/);
        expect(result.errors[0]).toMatch(/reverse and create a new transaction/);
      });

      it('returns multiple errors for multiple locked fields', () => {
        const result = validateTransactionEdit(postedTx, {
          amount: 500, tx_date: '2025-06-01', member_id: 99
        });
        expect(result.allowed).toBe(false);
        expect(result.errors).toHaveLength(3);
      });

      it('rejects locked fields while ignoring valid editable fields', () => {
        const result = validateTransactionEdit(postedTx, {
          amount: 500, description: 'updated'
        });
        expect(result.allowed).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/amount/);
      });

      it('allows empty changes', () => {
        const result = validateTransactionEdit(postedTx, {});
        expect(result).toEqual({ allowed: true, errors: [] });
      });
    });

    describe('reversed transactions', () => {
      const reversedTx = { status: 'reversed' };

      it('rejects any changes', () => {
        const result = validateTransactionEdit(reversedTx, { description: 'nope' });
        expect(result.allowed).toBe(false);
        expect(result.errors[0]).toBe('Cannot modify a reversed transaction.');
      });

      it('allows empty changes (no-op)', () => {
        const result = validateTransactionEdit(reversedTx, {});
        expect(result).toEqual({ allowed: true, errors: [] });
      });
    });
  });

  describe('validateStatusTransition', () => {
    it('allows draft → posted', () => {
      const result = validateStatusTransition('draft', 'posted');
      expect(result).toEqual({ allowed: true, error: null });
    });

    it('allows posted → reversed', () => {
      const result = validateStatusTransition('posted', 'reversed');
      expect(result).toEqual({ allowed: true, error: null });
    });

    it('rejects posted → draft (backward transition)', () => {
      const result = validateStatusTransition('posted', 'draft');
      expect(result.allowed).toBe(false);
      expect(result.error).toMatch(/Invalid transition/);
    });

    it('rejects reversed → posted (backward transition)', () => {
      const result = validateStatusTransition('reversed', 'posted');
      expect(result.allowed).toBe(false);
      expect(result.error).toMatch(/No further transitions allowed/);
    });

    it('rejects draft → reversed (skipping posted)', () => {
      const result = validateStatusTransition('draft', 'reversed');
      expect(result.allowed).toBe(false);
      expect(result.error).toMatch(/Invalid transition/);
    });

    it('rejects same-status transitions', () => {
      const result = validateStatusTransition('posted', 'posted');
      expect(result.allowed).toBe(false);
      expect(result.error).toMatch(/already 'posted'/);
    });
  });
});
