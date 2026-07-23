const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid farmer JWT. requireFarmer runs after
// requireAuth so req.subject is guaranteed populated first.
router.use(requireAuth, requireFarmer);

/**
 * GET /farmer/dashboard  →  reporting.v_farmer_360
 * Layer-9 rollup view (production units / contracts / credit score /
 * repayments / certificates / deliveries) for the logged-in farmer.
 *
 * risk.credit_score and underwriting.loan_application both carry real RLS
 * policies scoped to app.subject_type/app.subject_id, so even without the
 * explicit WHERE below the SET ROLE + set_session_context from
 * withSessionContext() would already narrow results to this farmer. The
 * WHERE is kept anyway as defense-in-depth and to make the intent explicit.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT * FROM reporting.v_farmer_360 WHERE farmer_id = $1',
        [subjectId],
      );
      await logAccess(client, 'read', 'reporting.v_farmer_360', subjectId);
      return rows[0] || null;
    });

    if (!result) {
      return res.status(404).json({ error: 'farmer_dashboard_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/credit-score  →  risk.v_farmer_latest_score (+ history from
 * risk.credit_score for anyone who wants to see the trend, not just latest).
 */
router.get('/credit-score', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const latest = await client.query(
        'SELECT * FROM risk.v_farmer_latest_score WHERE farmer_id = $1',
        [subjectId],
      );
      const history = await client.query(
        `SELECT score_id, score_value, risk_tier, model_version, computed_at
           FROM risk.credit_score
          WHERE farmer_id = $1
          ORDER BY computed_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'risk.credit_score', subjectId);
      return { latest: latest.rows[0] || null, history: history.rows };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/loan-applications  — list this farmer's applications.
 */
router.get('/loan-applications', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT application_id, lender_org_id, related_unit_id, requested_amount,
                purpose, status, risk_tier_at_decision, decision_reason,
                approved_amount, contract_id, created_at, decided_at
           FROM underwriting.loan_application
          WHERE farmer_id = $1
          ORDER BY created_at DESC`,
        [subjectId],
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
 * POST /farmer/loan-applications  — submit a new application.
 * Body: { lender_org_id, related_unit_id, requested_amount, purpose? }
 *
 * farmer_id is NEVER taken from the request body — it always comes from
 * req.subject (the JWT), so a farmer can only ever submit applications as
 * themselves, no matter what the client sends.
 */
router.post('/loan-applications', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { lender_org_id: lenderOrgId, related_unit_id: relatedUnitId, requested_amount: requestedAmount, purpose } = req.body || {};

  if (!lenderOrgId || !relatedUnitId || !requestedAmount) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['lender_org_id', 'related_unit_id', 'requested_amount'],
    });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT underwriting.submit_application($1, $2, $3, $4, $5) AS application_id',
        [subjectId, lenderOrgId, relatedUnitId, requestedAmount, purpose || null],
      );
      const applicationId = rows[0].application_id;
      // audit.access_log.action is constrained to ('read','write') only —
      // a new application is a write.
      await logAccess(client, 'write', 'underwriting.loan_application', applicationId);

      // Run the automated underwriting evaluation immediately, in the same
      // request, against the application we just created ourselves. This is
      // safe to do unconditionally here — unlike exposing evaluate_application
      // as its own endpoint, applicationId is guaranteed to belong to this
      // farmer, since submit_application() just returned it — and it gives
      // the farmer an instant decision (auto-approved / needs manual review /
      // auto-declined) instead of the application sitting at 'pending'
      // forever with nothing to move it forward. The Lender Portal then only
      // ever needs to act on the subset that lands in 'manual_review'.
      let decision;
      try {
        await client.query('SELECT underwriting.evaluate_application($1)', [applicationId]);
        const { rows: decisionRows } = await client.query(
          `SELECT status, risk_tier_at_decision, decision_reason, approved_amount
             FROM underwriting.loan_application
            WHERE application_id = $1`,
          [applicationId],
        );
        decision = decisionRows[0];
        await logAccess(client, 'write', 'underwriting.loan_application', applicationId);
      } catch (evalErr) {
        // evaluate_application() raises if the farmer has no credit score
        // yet at all (risk.compute_credit_score() never ran for them — e.g.
        // a newly-registered farmer with no production/delivery history) —
        // it deliberately does not guess. The application itself was
        // already inserted and stays at 'pending'; a real deployment would
        // have a scheduled job compute the score and retry evaluation once
        // enough history exists. This must not fail the whole request —
        // the farmer still gets their application_id back either way.
        console.error('[loan-applications] evaluate_application failed, leaving application pending:', evalErr.message);
        decision = {
          status: 'pending',
          risk_tier_at_decision: null,
          decision_reason: 'ยังไม่สามารถประเมินอัตโนมัติได้ในขณะนี้ (อาจยังไม่มีคะแนนสินเชื่อ) คำขอของท่านถูกบันทึกแล้วและรอการตรวจสอบ',
          approved_amount: null,
        };
      }

      return { applicationId, decision };
    });

    return res.status(201).json({
      application_id: result.applicationId,
      status: result.decision.status,
      risk_tier_at_decision: result.decision.risk_tier_at_decision,
      decision_reason: result.decision.decision_reason,
      approved_amount: result.decision.approved_amount,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/contracts  →  contract.contract joined through
 * contract.contract_party (party_type='farmer', party_id=subjectId).
 * contract.contract's RLS policy already keys off exactly this join, so
 * this mirrors what the database enforces rather than working around it.
 */
router.get('/contracts', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT c.contract_id, c.contract_type, c.status, c.related_unit_id,
                c.principal_amount, c.currency, c.effective_date, c.expiry_date,
                c.terms_summary, c.agreed_quantity, c.agreed_unit_price,
                c.quantity_unit, c.created_at, cp.party_role
           FROM contract.contract c
           JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
          WHERE cp.party_type = 'farmer' AND cp.party_id = $1
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

/**
 * GET /farmer/notifications  →  notification.v_unread_notifications
 *
 * IMPORTANT: unlike credit_score / loan_application / contract, the
 * notification tables have NO row-level security enabled (verified against
 * pg_class.relrowsecurity) and the view itself does not filter by subject —
 * it returns unread notifications for every subject in the system. The
 * explicit WHERE below is therefore not defense-in-depth here, it is the
 * ONLY thing preventing this endpoint from leaking every other farmer's,
 * contract's, and organization's notifications. Called out again in the
 * README.
 */
router.get('/notifications', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT notification_id, event_type, severity, message, created_at
           FROM notification.v_unread_notifications
          WHERE subject_type = 'farmer' AND subject_id = $1`,
        [subjectId],
      );
      await logAccess(client, 'read', 'notification.notification_log', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/production-units  →  registry.production_unit owned by this
 * farmer. gps_boundary is PostGIS geometry — converted to GeoJSON with
 * ST_AsGeoJSON so the API returns plain JSON, not a WKB hex blob.
 */
router.get('/production-units', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT unit_id, unit_type, area_rai, commodity_code, season_id,
                registration_date, status, created_at, updated_at,
                ST_AsGeoJSON(gps_boundary)::json AS gps_boundary
           FROM registry.production_unit
          WHERE owner_farmer_id = $1
          ORDER BY created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'registry.production_unit', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/lenders — active Lender organizations a farmer can pick from
 * when submitting a loan application. Small supporting endpoint so the
 * frontend doesn't have to hardcode org_ids; still behind requireAuth so it
 * isn't a public directory.
 */
router.get('/lenders', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT org_id, org_name
           FROM identity.organization
          WHERE org_type = 'Lender'
          ORDER BY org_name`,
      );
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
