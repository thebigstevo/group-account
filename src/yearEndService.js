'use strict';

const dal = require('./dal');
const { arrearsReport, calculateWelfareComponent } = require('./services');
const { calculateAllocations, calculateExpenseAllocations } = require('./allocationService');
const {
  approvalError,
  finalCloseError,
  pendingAuditTransitionError,
  validateAuditAdjustment
} = require('./yearEndDomain');

class YearEndValidationError extends Error {}

async function writeCarryForward(client, sourceYear, arrears, userId, provisional) {
  for (const row of arrears) {
    // Preserve the source year's opening figure before the legacy member field is
    // updated. This keeps historical arrears and member statements reproducible.
    await client.query(`
      INSERT INTO member_year_openings (
        member_id, year, opening_arrears, source_year, provisional, updated_by, updated_at
      ) VALUES ($1,$2,$3,NULL,false,$4,NOW())
      ON CONFLICT (member_id, year) DO NOTHING
    `, [row.member_id, sourceYear, row.opening_arrears, userId]);
    await client.query(`
      INSERT INTO member_year_openings (
        member_id, year, opening_arrears, source_year, provisional, updated_by, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (member_id, year) DO UPDATE SET
        opening_arrears=EXCLUDED.opening_arrears,
        source_year=EXCLUDED.source_year,
        provisional=EXCLUDED.provisional,
        updated_by=EXCLUDED.updated_by,
        updated_at=NOW()
    `, [row.member_id, Number(sourceYear) + 1, row.balance, sourceYear, provisional, userId]);
    if (!provisional) {
      await client.query('UPDATE members SET opening_arrears=$1 WHERE id=$2', [row.balance, row.member_id]);
    }
  }
}

async function submitYearForAudit({ year, userId, notes }) {
  return dal.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(92301,$1)', [year]);
    const fyResult = await client.query('SELECT * FROM fiscal_years WHERE year=$1 FOR UPDATE', [year]);
    const fiscalYear = fyResult.rows[0];
    const transitionError = pendingAuditTransitionError(fiscalYear);
    if (transitionError) throw new YearEndValidationError(transitionError);
    const arrears = await arrearsReport(year);
    await writeCarryForward(client, year, arrears, userId, true);
    await client.query(`
      UPDATE fiscal_years SET status='pending_audit', is_active=false,
        pending_audit_at=NOW(), pending_audit_by=$1, notes=$2
      WHERE year=$3
    `, [userId, notes || null, year]);
    await dal.audit(userId, 'submit_for_audit', 'fiscal_year', year, {
      year, provisional_carry_forward_members: arrears.length, notes: notes || null
    }, { client });
    return { memberCount: arrears.length };
  });
}

async function finalizeFiscalYear({ year, userId, notes }) {
  return dal.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(92301,$1)', [year]);
    const fyResult = await client.query('SELECT * FROM fiscal_years WHERE year=$1 FOR UPDATE', [year]);
    const fiscalYear = fyResult.rows[0];
    const reviewResult = await client.query('SELECT * FROM audit_reviews WHERE year=$1', [year]);
    const proposedResult = await client.query("SELECT COUNT(*)::int AS count FROM audit_adjustments WHERE year=$1 AND status='proposed'", [year]);
    const closeError = finalCloseError(fiscalYear, reviewResult.rows[0], proposedResult.rows[0].count);
    if (closeError) throw new YearEndValidationError(closeError);
    const arrears = await arrearsReport(year);
    await writeCarryForward(client, year, arrears, userId, false);
    await client.query(`
      UPDATE fiscal_years SET status='closed', is_active=false, closed_at=NOW(), closed_by=$1,
        notes=COALESCE($2, notes)
      WHERE year=$3
    `, [userId, notes || null, year]);
    await dal.audit(userId, 'close', 'fiscal_year', year, {
      year, final_carry_forward_members: arrears.length, notes: notes || null
    }, { client });
    return { memberCount: arrears.length };
  });
}

async function proposeAuditAdjustment({ year, userId, input }) {
  const validated = validateAuditAdjustment(input, year);
  if (validated.errors.length) throw new YearEndValidationError(validated.errors.join(' '));
  const values = validated.values;
  return dal.transaction(async (client) => {
    const fyResult = await client.query('SELECT * FROM fiscal_years WHERE year=$1 FOR UPDATE', [year]);
    if (!fyResult.rows[0] || fyResult.rows[0].status !== 'pending_audit') {
      throw new YearEndValidationError('Audit adjustments are only allowed while the fiscal year is pending audit.');
    }
    const reviewResult = await client.query('SELECT * FROM audit_reviews WHERE year=$1', [year]);
    if (!reviewResult.rows[0]) throw new YearEndValidationError('Start the trustee audit before proposing an adjustment.');
    const accountResult = await client.query('SELECT id FROM accounts WHERE id=$1 AND active=true', [values.account_id]);
    if (!accountResult.rows[0]) throw new YearEndValidationError('Select an active account.');
    const categoryResult = await client.query(`
      SELECT * FROM transaction_categories
      WHERE name=$1 AND active=true AND kind IN ($2, 'both')
    `, [values.category, values.tx_type === 'receipt' ? 'income' : 'expense']);
    const category = categoryResult.rows[0];
    if (!category) throw new YearEndValidationError('Select an active category matching the adjustment type.');
    if (category.purpose === 'assessment' && !values.member_id) {
      throw new YearEndValidationError('Select a member for an assessment receipt adjustment.');
    }
    if (values.member_id) {
      const memberResult = await client.query('SELECT id FROM members WHERE id=$1', [values.member_id]);
      if (!memberResult.rows[0]) throw new YearEndValidationError('Select a valid member.');
    }
    let welfare = values.welfare_component;
    if (values.tx_type === 'receipt' && welfare == null) {
      welfare = await calculateWelfareComponent({
        memberId: values.member_id, category: values.category, amount: values.amount, txDate: values.tx_date
      });
    }
    welfare = values.tx_type === 'receipt' ? Number(welfare || 0) : 0;
    const result = await client.query(`
      INSERT INTO audit_adjustments (
        year, review_id, tx_type, tx_date, member_id, account_id, category,
        description, amount, welfare_component, reference, reason, requested_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id
    `, [year, reviewResult.rows[0].id, values.tx_type, values.tx_date, values.member_id,
      values.account_id, values.category, values.description || null, values.amount, welfare,
      values.reference || null, values.reason, userId]);
    await dal.audit(userId, 'propose', 'audit_adjustment', result.rows[0].id, {
      year, type: values.tx_type, amount: values.amount, reason: values.reason
    }, { client });
    return { id: result.rows[0].id };
  });
}

async function approveAuditAdjustment({ adjustmentId, userId, decisionNotes }) {
  return dal.transaction(async (client) => {
    const adjustmentResult = await client.query(`
      SELECT aa.*, ar.status AS review_status, ar.revision AS review_revision,
        tc.purpose AS category_purpose
      FROM audit_adjustments aa
      JOIN audit_reviews ar ON ar.id=aa.review_id
      JOIN transaction_categories tc ON tc.name=aa.category
      WHERE aa.id=$1 FOR UPDATE OF aa
    `, [adjustmentId]);
    const adjustment = adjustmentResult.rows[0];
    const decisionError = approvalError(adjustment, userId);
    if (decisionError) throw new YearEndValidationError(decisionError);
    await client.query('SELECT pg_advisory_xact_lock(92301,$1)', [adjustment.year]);
    const fyResult = await client.query('SELECT * FROM fiscal_years WHERE year=$1 FOR UPDATE', [adjustment.year]);
    if (!fyResult.rows[0] || fyResult.rows[0].status !== 'pending_audit') {
      throw new YearEndValidationError('The fiscal year is no longer pending audit.');
    }

    const actualType = adjustment.tx_type === 'expense' && adjustment.category_purpose === 'welfare_payout'
      ? 'welfare_payout' : adjustment.tx_type;
    const transactionResult = await client.query(`
      INSERT INTO transactions (
        tx_date, tx_type, member_id, account_id, category, description, amount,
        welfare_component, status, reference, created_by, is_audit_adjustment, audit_adjustment_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'posted',$9,$10,true,$11)
      RETURNING id
    `, [adjustment.tx_date, actualType, adjustment.member_id, adjustment.account_id,
      adjustment.category, adjustment.description, adjustment.amount, adjustment.welfare_component,
      adjustment.reference, adjustment.requested_by, adjustment.id]);
    const transactionId = transactionResult.rows[0].id;
    const allocations = adjustment.tx_type === 'receipt'
      ? await calculateAllocations(Number(adjustment.amount), adjustment.category, adjustment.year,
        adjustment.member_id, Number(adjustment.welfare_component || 0))
      : await calculateExpenseAllocations(Number(adjustment.amount), adjustment.category_purpose);
    for (const allocation of allocations) {
      await client.query(`
        INSERT INTO receipt_allocations (transaction_id, fund_classification_id, amount, category, description)
        VALUES ($1,$2,$3,$4,$5)
      `, [transactionId, allocation.fund_classification_id, allocation.amount,
        adjustment.category, `Audit adjustment #${adjustment.id}`]);
    }
    await client.query(`
      UPDATE audit_adjustments SET status='approved', decided_by=$1, decided_at=NOW(),
        decision_notes=$2, applied_transaction_id=$3 WHERE id=$4
    `, [userId, decisionNotes || null, transactionId, adjustment.id]);

    if (adjustment.tx_type === 'receipt' && adjustment.category_purpose === 'assessment' && adjustment.member_id) {
      await client.query(`
        UPDATE member_year_openings SET opening_arrears=opening_arrears-$1,
          provisional=true, updated_by=$2, updated_at=NOW()
        WHERE member_id=$3 AND year=$4
      `, [adjustment.amount, userId, adjustment.member_id, Number(adjustment.year) + 1]);
    }

    let auditReopened = false;
    if (adjustment.review_status === 'completed') {
      auditReopened = true;
      await client.query(`
        UPDATE audit_reviews SET status='in_progress', revision=revision+1,
          completed_by=NULL, completed_at=NULL, overall_conclusion=NULL, overall_notes=NULL,
          recommendation=NULL, reopened_at=NOW(), reopened_by=$1, reopen_reason=$2
        WHERE id=$3
      `, [userId, `Approved audit adjustment #${adjustment.id}`, adjustment.review_id]);
      await client.query(`
        UPDATE audit_review_items SET status='pending', notes=NULL, reviewed_by=NULL, reviewed_at=NULL
        WHERE review_id=$1
      `, [adjustment.review_id]);
    }
    await dal.audit(userId, 'approve', 'audit_adjustment', adjustment.id, {
      year: adjustment.year, transaction_id: transactionId, audit_reopened: auditReopened,
      decision_notes: decisionNotes || null
    }, { client });
    return { transactionId, auditReopened, year: adjustment.year };
  });
}

async function rejectAuditAdjustment({ adjustmentId, userId, decisionNotes }) {
  if (!String(decisionNotes || '').trim()) throw new YearEndValidationError('Give a reason for rejecting the adjustment.');
  return dal.transaction(async (client) => {
    const result = await client.query('SELECT * FROM audit_adjustments WHERE id=$1 FOR UPDATE', [adjustmentId]);
    const adjustment = result.rows[0];
    const decisionError = approvalError(adjustment, userId);
    if (decisionError) throw new YearEndValidationError(decisionError);
    await client.query(`
      UPDATE audit_adjustments SET status='rejected', decided_by=$1, decided_at=NOW(), decision_notes=$2
      WHERE id=$3
    `, [userId, String(decisionNotes).trim(), adjustmentId]);
    await dal.audit(userId, 'reject', 'audit_adjustment', adjustmentId, {
      year: adjustment.year, decision_notes: String(decisionNotes).trim()
    }, { client });
    return { year: adjustment.year };
  });
}

async function listAuditAdjustments(year) {
  return dal.query(`
    SELECT aa.*, requester.name AS requested_by_name, decider.name AS decided_by_name,
      member.name AS member_name, account.name AS account_name
    FROM audit_adjustments aa
    JOIN users requester ON requester.id=aa.requested_by
    LEFT JOIN users decider ON decider.id=aa.decided_by
    LEFT JOIN members member ON member.id=aa.member_id
    JOIN accounts account ON account.id=aa.account_id
    WHERE aa.year=$1 ORDER BY aa.requested_at DESC, aa.id DESC
  `, [year]);
}

async function listAuditSignoffs(reviewId) {
  if (!reviewId) return [];
  return dal.query(`
    SELECT s.*, u.name AS completed_by_name
    FROM audit_review_signoffs s LEFT JOIN users u ON u.id=s.completed_by
    WHERE s.review_id=$1 ORDER BY s.revision DESC
  `, [reviewId]);
}

module.exports = {
  YearEndValidationError,
  approveAuditAdjustment,
  finalizeFiscalYear,
  listAuditAdjustments,
  listAuditSignoffs,
  proposeAuditAdjustment,
  rejectAuditAdjustment,
  submitYearForAudit,
  writeCarryForward
};
