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

/**
 * GET /farmer/rice-prices — every rice grade in registry.rice_grade_ref,
 * each with every Buyer's current ACTIVE price quote for it (see
 * PUT /buyer/price-quotes), so a farmer can compare buyers before deciding
 * where to sell — the whole point of a price "announcement" rather than a
 * buyer-only internal tool. Grouped by grade (not by buyer) since that's
 * the natural comparison shape: "who's paying the most for HOMMALI105
 * today", not "what does this one buyer pay for everything". A grade with
 * zero buyers currently quoting it still appears, with an empty `quotes`
 * array, so the frontend can show "ยังไม่มีผู้รับซื้อประกาศราคา" rather than
 * silently omitting it.
 */
router.get('/rice-prices', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const grades = await withSessionContext('farmer', subjectId, async (client) => {
      const gradeRows = await client.query(
        'SELECT grade_code, name_th FROM registry.rice_grade_ref ORDER BY sort_order',
      );
      const quoteRows = await client.query(
        `SELECT q.grade_code, q.org_id, o.org_name, q.quoted_price, q.price_unit, q.updated_at
           FROM marketplace.buy_price_quote q
           JOIN identity.organization o ON o.org_id = q.org_id
          WHERE q.is_active = true
          ORDER BY q.quoted_price DESC`,
      );

      const quotesByGrade = {};
      quoteRows.rows.forEach((r) => {
        if (!quotesByGrade[r.grade_code]) quotesByGrade[r.grade_code] = [];
        quotesByGrade[r.grade_code].push({
          org_id: r.org_id, org_name: r.org_name, quoted_price: r.quoted_price,
          price_unit: r.price_unit, updated_at: r.updated_at,
        });
      });

      return gradeRows.rows.map((g) => ({
        grade_code: g.grade_code,
        name_th: g.name_th,
        quotes: quotesByGrade[g.grade_code] || [],
      }));
    });

    return res.json(grades);
  } catch (err) {
    return next(err);
  }
});

const PRODUCT_CATEGORIES = ['fertilizer_hormone', 'chemical_pesticide', 'equipment', 'other'];

/**
 * GET /farmer/input-suppliers — every Verified InputSupplier organization,
 * with how many active products it currently has listed, so a farmer can
 * browse "by supplier" before drilling into GET /farmer/products?org_id=.
 * Mirrors GET /farmer/lenders' shape (a small supporting directory endpoint
 * so the frontend never has to hardcode an org_id).
 */
router.get('/input-suppliers', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT o.org_id, o.org_name, COUNT(p.listing_id) FILTER (WHERE p.is_active) AS active_product_count
           FROM identity.organization o
           JOIN identity.organization_role r ON r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified'
           LEFT JOIN marketplace.product_listing p ON p.org_id = o.org_id
          WHERE o.kyb_status = 'Verified'
          GROUP BY o.org_id, o.org_name
          ORDER BY o.org_name`,
      );
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/products?category=&org_id= — browse the ACTIVE catalog
 * across every Verified InputSupplier (or one, via org_id), joined with the
 * supplier's org_name so a farmer knows who they'd be buying from. Only
 * `is_active = true` rows — a deactivated listing (see the deactivate-only
 * note on DELETE /inputsupplier/products/:id) simply stops appearing here,
 * same as a deactivated machinery rate-card item stops appearing priced.
 */
router.get('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { category, org_id: orgId } = req.query;

  if (category && !PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: PRODUCT_CATEGORIES });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [];
      const filters = ['p.is_active = true'];
      if (category) { params.push(category); filters.push(`p.category = $${params.length}`); }
      if (orgId) { params.push(orgId); filters.push(`p.org_id = $${params.length}`); }

      const result = await client.query(
        `SELECT p.listing_id, p.org_id, o.org_name, p.category, p.product_name, p.brand,
                p.description, p.unit_price, p.price_unit, p.updated_at
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
          WHERE ${filters.join(' AND ')}
          ORDER BY o.org_name, p.category, p.product_name`,
        params,
      );
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/orders
 * Body: { listing_id, quantity }
 *
 * Places a new order at status='requested'. Price/name/category are
 * SNAPSHOTTED from the listing at this moment onto the new
 * marketplace.product_order row (see grant_farmer_product_orders.sql's
 * comment on why) — later edits to the listing's price never retroactively
 * change an already-placed order. farmer_id is always req.subject, never
 * the request body, same as POST /farmer/loan-applications.
 */
router.post('/orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { listing_id: listingId, quantity } = req.body || {};

  if (!listingId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['listing_id', 'quantity'] });
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'invalid_quantity' });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const listing = await client.query(
        `SELECT listing_id, org_id, category, product_name, unit_price, price_unit
           FROM marketplace.product_listing
          WHERE listing_id = $1 AND is_active = true`,
        [listingId],
      );
      if (listing.rows.length === 0) return { listingNotFound: true };
      const l = listing.rows[0];
      const totalPrice = Math.round(qty * Number(l.unit_price) * 100) / 100;

      const { rows } = await client.query(
        `INSERT INTO marketplace.product_order
           (listing_id, org_id, farmer_id, product_name, category, unit_price, price_unit, quantity, total_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING order_id, listing_id, org_id, product_name, category, unit_price, price_unit,
                   quantity, total_price, status, requested_at`,
        [listingId, l.org_id, subjectId, l.product_name, l.category, l.unit_price, l.price_unit, qty, totalPrice],
      );
      await logAccess(client, 'write', 'marketplace.product_order', rows[0].order_id);
      return { order: rows[0] };
    });

    if (result.listingNotFound) {
      return res.status(404).json({ error: 'product_not_found' });
    }
    return res.status(201).json(result.order);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/orders?status=... — this farmer's own order history across
 * every supplier, joined with the supplier's org_name.
 */
router.get('/orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status) { params.push(status); filter = 'AND o.status = $2'; }

      const result = await client.query(
        `SELECT o.order_id, o.org_id, org.org_name, o.product_name, o.category, o.unit_price,
                o.price_unit, o.quantity, o.total_price, o.status, o.decided_reason,
                o.requested_at, o.decided_at, o.fulfilled_at
           FROM marketplace.product_order o
           JOIN identity.organization org ON org.org_id = o.org_id
          WHERE o.farmer_id = $1 ${filter}
          ORDER BY o.requested_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'marketplace.product_order', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/orders/:id/cancel — a farmer can cancel their OWN order,
 * only while it's still `requested` (before the supplier has acted on it —
 * once `confirmed`, the supplier is already committed, so cancellation past
 * that point would need to go through the supplier, not this endpoint).
 * Ownership-gated the same way as every other subject-scoped write in this
 * project: re-read WHERE farmer_id = $1 AND order_id = $2 first, 404 if
 * that finds nothing (an order that exists but belongs to someone else
 * looks identical to one that doesn't exist at all, from this farmer's
 * point of view).
 */
router.post('/orders/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE farmer_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.product_order
            SET status = 'cancelled', updated_at = now()
          WHERE farmer_id = $1 AND order_id = $2
          RETURNING order_id, status`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.product_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'order_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'order_not_cancellable', current_status: result.wrongStatus });
    }
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
