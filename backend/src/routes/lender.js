const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT. requireOrganization
// runs after requireAuth so req.subject is guaranteed populated first.
router.use(requireAuth, requireOrganization);

/**
 * Confirms the authenticated organization is actually a Lender (as opposed
 * to a Buyer, Mill, InputSupplier, etc. — all of which also authenticate as
 * subjectType='organization'). identity.organization has no RLS at all (it
 * is effectively a shared directory — GET /farmer/lenders already reads it
 * the same way), so this is a plain lookup, not an RLS-scoped read; it just
 * needs *a* valid session context, which withSessionContext provides.
 *
 * Runs once per request rather than being folded into every handler below
 * so every /lender/* route gets the same guarantee without repeating itself.
 *
 * Also gates on kyb_status === 'Verified'. This wasn't necessary before
 * POST /auth/org-register existed — every seeded Lender org was already
 * Verified by the time it could ever log in. Now that an organization can
 * self-register and land at kyb_status='Pending' with a real, working JWT
 * before Platform Ops ever reviews it, skipping this check would let an
 * unapproved (or rejected) org approve/decline real loan applications.
 * Returns a distinct 'kyb_not_verified' error (rather than the generic
 * 'lender_subject_required') so the frontend can show a "your application
 * is under review" state instead of treating this like a wrong-subject-type
 * token and bouncing to login.
 */
async function requireLenderOrg(req, res, next) {
  const { subjectId } = req.subject;
  try {
    const org = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      return rows[0] || null;
    });

    if (!org || org.org_type !== 'Lender') {
      return res.status(403).json({ error: 'lender_subject_required' });
    }
    if (org.kyb_status !== 'Verified') {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: org.kyb_status, org_name: org.org_name });
    }
    req.org = org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireLenderOrg);

/**
 * GET /lender/dashboard — org info plus a count of applications by status,
 * scoped to this lender via the same RLS policy (lender_own_applications)
 * that every other query below relies on.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const counts = await client.query(
        `SELECT status, COUNT(*)::int AS count
           FROM underwriting.loan_application
          WHERE lender_org_id = $1
          GROUP BY status`,
        [subjectId],
      );
      const portfolio = await client.query(
        `SELECT COUNT(*)::int AS active_contracts,
                COALESCE(SUM(c.principal_amount), 0)::numeric AS total_principal_outstanding
           FROM contract.contract c
           JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
          WHERE cp.party_type = 'organization' AND cp.party_id = $1
            AND cp.party_role = 'lender' AND c.status = 'active'`,
        [subjectId],
      );
      await logAccess(client, 'read', 'underwriting.loan_application', subjectId);

      const statusCounts = { pending: 0, manual_review: 0, approved: 0, declined: 0, converted: 0 };
      counts.rows.forEach((r) => { statusCounts[r.status] = r.count; });

      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        applications_by_status: statusCounts,
        needs_action_count: statusCounts.manual_review + statusCounts.approved,
        active_contracts: portfolio.rows[0].active_contracts,
        total_principal_outstanding: portfolio.rows[0].total_principal_outstanding,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /lender/loan-applications?status=manual_review
 * Lists applications submitted to THIS lender, optionally filtered by
 * status. Joins in the farmer's name and latest credit score so the lender
 * has enough context to actually decide, without a separate round trip.
 *
 * lender_own_applications RLS policy already restricts rows to
 * lender_org_id = subjectId — the explicit WHERE mirrors that for clarity,
 * same pattern used throughout farmer.js.
 */
const VALID_STATUSES = ['pending', 'manual_review', 'approved', 'declined', 'converted'];
// Shorthand for the review queue: 'approved' still needs the lender to
// actively convert it into a contract (see approve_application below), so
// it is just as much "needs action" as 'manual_review' — only 'pending'
// (not yet auto-evaluated), 'declined', and 'converted' are truly at rest.
const ACTION_NEEDED_STATUSES = ['manual_review', 'approved'];

router.get('/loan-applications', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;

  if (status && status !== 'action_needed' && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: [...VALID_STATUSES, 'action_needed'] });
  }

  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let statusFilter = '';
      if (status === 'action_needed') {
        params.push(ACTION_NEEDED_STATUSES);
        statusFilter = 'AND la.status = ANY($2)';
      } else if (status) {
        params.push(status);
        statusFilter = 'AND la.status = $2';
      }
      const result = await client.query(
        `SELECT la.application_id, la.farmer_id, f.full_name AS farmer_name,
                la.related_unit_id, la.requested_amount, la.purpose, la.status,
                la.risk_tier_at_decision, la.decision_reason, la.approved_amount,
                la.contract_id, la.created_at, la.decided_at,
                s.score_value AS latest_score_value, s.risk_tier AS latest_risk_tier
           FROM underwriting.loan_application la
           JOIN identity.farmer f ON f.farmer_id = la.farmer_id
           LEFT JOIN risk.v_farmer_latest_score s ON s.farmer_id = la.farmer_id
          WHERE la.lender_org_id = $1 ${statusFilter}
          ORDER BY la.created_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'underwriting.loan_application', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /lender/loan-applications/:id — single application detail, including
 * the related production unit, for the review screen. Returns 404 for an
 * application that doesn't exist OR belongs to a different lender — RLS
 * makes those indistinguishable at the SQL level, which is the point (no
 * information leak about other lenders' applications).
 */
router.get('/loan-applications/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT la.application_id, la.farmer_id, f.full_name AS farmer_name, f.phone AS farmer_phone,
                la.related_unit_id, pu.unit_type, pu.commodity_code, pu.area_rai,
                la.requested_amount, la.purpose, la.status, la.risk_tier_at_decision,
                la.decision_reason, la.approved_amount, la.contract_id,
                la.created_at, la.decided_at,
                s.score_value AS latest_score_value, s.risk_tier AS latest_risk_tier,
                s.factors AS latest_score_factors
           FROM underwriting.loan_application la
           JOIN identity.farmer f ON f.farmer_id = la.farmer_id
           LEFT JOIN registry.production_unit pu ON pu.unit_id = la.related_unit_id
           LEFT JOIN risk.v_farmer_latest_score s ON s.farmer_id = la.farmer_id
          WHERE la.lender_org_id = $1 AND la.application_id = $2`,
        [subjectId, id],
      );
      if (result.rows.length > 0) {
        await logAccess(client, 'read', 'underwriting.loan_application', id);
      }
      return result.rows[0] || null;
    });

    if (!row) {
      return res.status(404).json({ error: 'application_not_found' });
    }
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /lender/loan-applications/:id/approve
 * Body: { final_amount? }
 *
 * underwriting.approve_application() is SECURITY DEFINER (see
 * fix_underwriting_decision_security.sql) but does NOT itself check that
 * the caller's org owns the application — only that its status is
 * 'approved' or 'manual_review'. That check happens here instead: the
 * SELECT below runs under this lender's own RLS-scoped session context, so
 * lender_own_applications narrows it to zero rows if the application isn't
 * this lender's (or doesn't exist) — either way the route responds 404
 * *before* ever calling approve_application(), so a lender can never
 * approve/decline another lender's application no matter what id it guesses.
 */
router.post('/loan-applications/:id/approve', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { final_amount: finalAmount } = req.body || {};

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT application_id, status FROM underwriting.loan_application WHERE lender_org_id = $1 AND application_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) {
        return { notFound: true };
      }
      try {
        const { rows } = await client.query(
          'SELECT underwriting.approve_application($1, $2) AS contract_id',
          [id, finalAmount || null],
        );
        await logAccess(client, 'write', 'underwriting.loan_application', id);
        return { contractId: rows[0].contract_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'application_not_found' });
    }
    if (result.businessError) {
      // e.g. wrong status, missing final amount — a real validation message
      // from the function body itself, not a generic 500.
      return res.status(409).json({ error: 'cannot_approve', detail: result.businessError });
    }
    return res.json({ contract_id: result.contractId, status: 'converted' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /lender/loan-applications/:id/decline
 * Body: { reason? }
 * Same ownership-gating pattern as approve, above.
 */
router.post('/loan-applications/:id/decline', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { reason } = req.body || {};

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT application_id, status FROM underwriting.loan_application WHERE lender_org_id = $1 AND application_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) {
        return { notFound: true };
      }
      try {
        await client.query('SELECT underwriting.decline_application($1, $2)', [id, reason || null]);
        await logAccess(client, 'write', 'underwriting.loan_application', id);
        return { declined: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'application_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_decline', detail: result.businessError });
    }
    return res.json({ status: 'declined' });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /lender/contracts — this org's loan-agreement portfolio (contracts
 * where it is the 'lender' party), for a simple portfolio view.
 * contract.contract's own RLS policy (party_own_contract) already scopes
 * this identically to the explicit JOIN below — same belt-and-suspenders
 * pattern as GET /farmer/contracts.
 */
router.get('/contracts', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT c.contract_id, c.contract_type, c.status, c.related_unit_id,
                c.principal_amount, c.currency, c.effective_date, c.expiry_date,
                c.terms_summary, c.created_at
           FROM contract.contract c
           JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
          WHERE cp.party_type = 'organization' AND cp.party_id = $1 AND cp.party_role = 'lender'
          ORDER BY c.created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'contract.contract', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
