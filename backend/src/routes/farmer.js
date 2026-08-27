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
 * GET /farmer/commodities — registry.commodity_ref, for the plot
 * registration form's commodity dropdown instead of hardcoding commodity
 * codes in the frontend. Same query as GET /buyer/commodities and
 * GET /coop/commodities — registry.commodity_ref has no owner/subject
 * column, it is a flat reference list, so there is nothing to scope this
 * to besides "every logged-in farmer sees the same list".
 */
router.get('/commodities', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query('SELECT commodity_code, name_th FROM registry.commodity_ref ORDER BY name_th');
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const PRODUCTION_UNIT_TYPES = ['Plot', 'Pen', 'Pond', 'Orchard'];

/**
 * POST /farmer/production-units — a farmer registers a NEW plot/production
 * unit (แปลง/หน่วยผลิต) belonging to themselves.
 * Body: { unit_type, gps_boundary (GeoJSON Polygon object), area_rai,
 *         commodity_code, season_id }
 *
 * Added 2026-08-23 — see grant_farmer_plot_registration.sql. Just like
 * loan-applications above, owner_farmer_id/farmer_id is NEVER taken from
 * the request body — it is always req.subject's id, so a farmer can only
 * ever register a plot as themselves. Deeper business-rule validation
 * (commodity_code exists, GeoJSON parses to a valid Polygon, area > 0)
 * lives in registry.register_production_unit() itself, same pattern as
 * underwriting.submit_application().
 */
router.post('/production-units', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { unit_type: unitType, gps_boundary: gpsBoundary, area_rai: areaRai, commodity_code: commodityCode, season_id: seasonId } = req.body || {};

  if (!unitType || !gpsBoundary || areaRai === undefined || areaRai === null || !commodityCode || !seasonId) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['unit_type', 'gps_boundary', 'area_rai', 'commodity_code', 'season_id'],
    });
  }

  if (!PRODUCTION_UNIT_TYPES.includes(unitType)) {
    return res.status(400).json({ error: 'invalid_unit_type', allowed: PRODUCTION_UNIT_TYPES });
  }

  const areaRaiNumber = Number(areaRai);
  if (!Number.isFinite(areaRaiNumber) || areaRaiNumber <= 0) {
    return res.status(400).json({ error: 'invalid_area_rai' });
  }

  try {
    const unitId = await withSessionContext('farmer', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT registry.register_production_unit($1, $2, $3, $4, $5, $6) AS unit_id',
        [subjectId, unitType, JSON.stringify(gpsBoundary), areaRaiNumber, commodityCode, seasonId],
      );
      const newUnitId = rows[0].unit_id;
      await logAccess(client, 'write', 'registry.production_unit', newUnitId);
      return newUnitId;
    });

    return res.status(201).json({ unit_id: unitId });
  } catch (err) {
    // registry.register_production_unit() raises plain RAISE EXCEPTION
    // (SQLSTATE P0001) for every validation failure it does itself — those
    // are safe, farmer-facing Thai-language messages, not internal detail,
    // so surface them as 400s instead of falling through to the generic
    // 500 "internal_error" the error-handling middleware in server.js
    // returns for everything else.
    if (err.code === 'P0001') {
      return res.status(400).json({ error: 'production_unit_registration_failed', message: err.message });
    }
    return next(err);
  }
});

/**
 * GET /farmer/memberships — the farmer's OWN "which organizations am I a
 * member/customer of" list (สมาชิกภาพของฉัน). This is the farmer-facing
 * counterpart to the Farmer 360° View built for organization staff (see
 * FARMER_360_ARCHITECTURE.md and src/routes/farmer360.js) — same
 * underlying table (`identity.farmer_org_relationship`), just filtered to
 * the calling farmer's own row instead of requiring an org to already have
 * a relationship. Deliberately simple this pass (name + type + joined
 * date only, no transaction detail) — this is exactly the kind of list a
 * future consent screen (Phase 2, see architecture doc §5) would extend
 * with "who has access to what" controls, but that's out of scope here.
 */
router.get('/memberships', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT r.relationship_id, o.org_id, o.org_name, o.org_type,
                r.relationship_type, r.joined_at
           FROM identity.farmer_org_relationship r
           JOIN identity.organization o ON o.org_id = r.org_id
          WHERE r.farmer_id = $1 AND r.status = 'active'
          ORDER BY r.joined_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'identity.farmer_org_relationship', subjectId);
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
        `SELECT o.org_id, o.org_name,
                COUNT(p.listing_id) FILTER (
                  WHERE p.is_active AND p.category = ANY($1) AND (o.org_type <> 'Cooperative' OR p.category <> 'other')
                ) AS active_product_count
           FROM identity.organization o
           JOIN identity.organization_role r ON r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified'
           LEFT JOIN marketplace.product_listing p ON p.org_id = o.org_id
          WHERE o.kyb_status = 'Verified'
          GROUP BY o.org_id, o.org_name
          ORDER BY o.org_name`,
        [PRODUCT_CATEGORIES],
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
 *
 * Featured listings (see grant_featured_listings.sql / the
 * /admin/product-listings routes in admin.js) sort first — `featured` in
 * the response is computed live (is_featured AND featured_until in the
 * future, or no expiry at all) rather than trusting a possibly-stale
 * is_featured flag, since that column is never auto-cleared once it
 * expires.
 *
 * Sellers are gated by an EXISTS check against a VERIFIED 'InputSupplier'
 * identity.organization_role — NOT identity.organization.org_type — so
 * this correctly admits any multi-role org holding that role (e.g. a
 * Cooperative that requested it via POST /organization/roles and got it
 * approved, per grant_organization_roles.sql), same pattern already used
 * by GET /farmer/machinery-providers in farmermachinery.js for
 * multi-role machinery providers. `p.category = ANY(PRODUCT_CATEGORIES)`
 * is a second, FIXED (not client-controlled) filter on top of that,
 * because org-level role gating alone is not enough: a Cooperative that
 * holds BOTH the Cooperative role (for its own produce/processed-goods
 * catalog aimed at BUYER orgs — see GET /buyer/coop-products in
 * buyer.js) AND the InputSupplier role would otherwise leak its own rice
 * listings into this farmer-buys-inputs marketplace just by virtue of
 * being InputSupplier-Verified. The `o.org_type <> 'Cooperative' OR
 * p.category <> 'other'` clause further excludes a Cooperative's
 * 'other'-tagged rows specifically, since 'other' is also a valid
 * category on the buyer-facing side and nothing on product_listing
 * records which audience a given 'other' row was meant for — a
 * Cooperative selling miscellaneous inputs to farmers should list them
 * under one of the three specific input categories instead.
 */
router.get('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { category, org_id: orgId } = req.query;

  if (category && !PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: PRODUCT_CATEGORIES });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [PRODUCT_CATEGORIES];
      const filters = [
        'p.is_active = true',
        `p.category = ANY($${params.length})`,
        "(o.org_type <> 'Cooperative' OR p.category <> 'other')",
        `EXISTS (
           SELECT 1 FROM identity.organization_role r
            WHERE r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified'
         )`,
      ];
      if (category) { params.push(category); filters.push(`p.category = $${params.length}`); }
      if (orgId) { params.push(orgId); filters.push(`p.org_id = $${params.length}`); }

      const result = await client.query(
        `SELECT p.listing_id, p.org_id, o.org_name, p.category, p.product_name, p.brand,
                p.description, p.unit_price, p.price_unit, p.updated_at,
                (p.is_featured AND (p.featured_until IS NULL OR p.featured_until > now())) AS featured,
                (SELECT photo_data_url FROM marketplace.product_photo
                  WHERE listing_id = p.listing_id ORDER BY created_at ASC LIMIT 1) AS cover_photo_url
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
          WHERE ${filters.join(' AND ')}
          ORDER BY (p.is_featured AND (p.featured_until IS NULL OR p.featured_until > now())) DESC,
                   o.org_name, p.category, p.product_name`,
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
 * GET /farmer/products/recommended — "แนะนำสำหรับท่าน" (AI Matching).
 * Backs a "recommended for you" section on marketplace.html. This is a
 * legitimate multi-factor CONTENT-BASED scoring/ranking system — NOT deep
 * learning or an LLM — computed fresh on every request in pure SQL against
 * the same live data GET /farmer/products already reads (no offline
 * training step, unlike risk.credit_model — see grant_credit_model.sql).
 * Every candidate listing gets a match_score in [0, 1] from three signals:
 *
 *   40% region match          — does the farmer's identity.farmer.
 *                                region_code appear in the supplier's
 *                                partner.vendor_profile.service_regions? A
 *                                supplier that has never set a service area
 *                                gets a neutral 0.5, not a penalty.
 *   30% price competitiveness — this listing's price vs. the average price
 *                                of other active listings in the same
 *                                category. At-or-below average scores 1.0,
 *                                falling linearly to 0 at double the
 *                                average. No comparable data (only listing
 *                                in its category) gets a neutral 0.5.
 *   30% reliability            — this supplier's historical order success
 *                                rate: fulfilled / (fulfilled + rejected)
 *                                product_order rows. Pending/cancelled rows
 *                                are excluded from both sides. No terminal
 *                                history yet gets a neutral 0.5, not a
 *                                penalty for being new.
 *
 * Re-uses the exact same base filters as GET /farmer/products above
 * (is_active, InputSupplier role verification, the coop-catalog audience
 * safety net) so a supplier that wouldn't show up in the normal browse
 * list never shows up here either.
 *
 * Query: category? (see PRODUCT_CATEGORIES), limit? (default 10, max 50)
 */
router.get('/products/recommended', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { category } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

  if (category && !PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: PRODUCT_CATEGORIES });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId, PRODUCT_CATEGORIES];
      const filters = [
        'p.is_active = true',
        `p.category = ANY($${params.length})`,
        "(o.org_type <> 'Cooperative' OR p.category <> 'other')",
        `EXISTS (
           SELECT 1 FROM identity.organization_role r
            WHERE r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified'
         )`,
      ];
      if (category) { params.push(category); filters.push(`p.category = $${params.length}`); }
      params.push(limit);
      const limitPlaceholder = `$${params.length}`;

      const result = await client.query(
        `WITH farmer_region AS (
           SELECT region_code FROM identity.farmer WHERE farmer_id = $1
         ),
         reliability AS (
           SELECT org_id,
                  count(*) FILTER (WHERE status = 'fulfilled') AS success_count,
                  count(*) FILTER (WHERE status IN ('fulfilled', 'rejected')) AS terminal_count
             FROM marketplace.product_order
            GROUP BY org_id
         )
         SELECT p.listing_id, p.org_id, o.org_name, p.category, p.product_name, p.brand,
                p.description, p.unit_price, p.price_unit, p.updated_at,
                (p.is_featured AND (p.featured_until IS NULL OR p.featured_until > now())) AS featured,
                (SELECT photo_data_url FROM marketplace.product_photo
                  WHERE listing_id = p.listing_id ORDER BY created_at ASC LIMIT 1) AS cover_photo_url,
                ROUND((
                  0.4 * (CASE
                           WHEN COALESCE(cardinality(vp.service_regions), 0) = 0 THEN 0.5
                           WHEN fr.region_code = ANY(vp.service_regions) THEN 1.0
                           ELSE 0.0
                         END)
                + 0.3 * COALESCE(LEAST(1.0, GREATEST(0.0,
                    1 - (p.unit_price - cat_avg.avg_price) / NULLIF(cat_avg.avg_price, 0)
                  )), 0.5)
                + 0.3 * (CASE WHEN COALESCE(rel.terminal_count, 0) = 0 THEN 0.5
                              ELSE rel.success_count::numeric / rel.terminal_count END)
                )::numeric, 4) AS match_score
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
           LEFT JOIN partner.vendor_profile vp ON vp.org_id = p.org_id
           CROSS JOIN farmer_region fr
           LEFT JOIN reliability rel ON rel.org_id = p.org_id
           LEFT JOIN LATERAL (
             SELECT AVG(p2.unit_price) AS avg_price
               FROM marketplace.product_listing p2
              WHERE p2.category = p.category AND p2.is_active = true AND p2.listing_id <> p.listing_id
           ) cat_avg ON true
          WHERE ${filters.join(' AND ')}
          ORDER BY match_score DESC, p.updated_at DESC
          LIMIT ${limitPlaceholder}`,
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
      // Same role+category safety net as GET /farmer/products (see that
      // route's doc comment) — a farmer must never be able to place an
      // order against a listing this endpoint's own browse route would
      // not have shown them (e.g. a Cooperative's own produce listing,
      // reachable only if someone guessed its listing_id).
      const listing = await client.query(
        `SELECT p.listing_id, p.org_id, p.category, p.product_name, p.unit_price, p.price_unit
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
          WHERE p.listing_id = $1 AND p.is_active = true
            AND p.category = ANY($2)
            AND (o.org_type <> 'Cooperative' OR p.category <> 'other')
            AND EXISTS (
              SELECT 1 FROM identity.organization_role r
               WHERE r.org_id = p.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified'
            )`,
        [listingId, PRODUCT_CATEGORIES],
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
                o.payment_status,
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

// Platform fee taken out of what the supplier receives when a purchase is
// funded through a credit line — a flat percentage of the transaction, per
// product decision (2026-08-27). Not yet configurable per-lender/per-tier;
// a single platform-wide constant is an honest MVP starting point rather
// than building a policy table nobody asked for yet.
const CREDIT_LINE_PLATFORM_FEE_PERCENT = 1.5;

/**
 * GET /farmer/credit-lines — this farmer's own standing revolving credit
 * lines (one per lender that has extended one), with how much is currently
 * drawn down vs. still available to spend.
 */
router.get('/credit-lines', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT cl.credit_line_id, cl.lender_org_id, o.org_name AS lender_name,
                cl.credit_limit, cl.interest_rate_daily_bps, cl.tenor_days, cl.status, cl.created_at,
                COALESCE(d.outstanding_total, 0) AS outstanding_total,
                cl.credit_limit - COALESCE(d.outstanding_total, 0) AS available_credit
           FROM credit.credit_line cl
           JOIN identity.organization o ON o.org_id = cl.lender_org_id
           LEFT JOIN (
                SELECT credit_line_id, SUM(principal_amount) AS outstanding_total
                  FROM credit.credit_drawdown WHERE status = 'outstanding' GROUP BY credit_line_id
              ) d ON d.credit_line_id = cl.credit_line_id
          WHERE cl.farmer_id = $1
          ORDER BY cl.created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'credit.credit_line', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/credit-line-drawdowns?status=outstanding — every purchase
 * this farmer has funded through any of their credit lines, across every
 * lender, so the repayment screen can show everything owed in one list.
 */
router.get('/credit-line-drawdowns', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status) { params.push(status); filter = 'AND d.status = $2'; }

      const result = await client.query(
        `SELECT d.drawdown_id, d.credit_line_id, o.org_name AS lender_name,
                po.product_name, po.order_id,
                d.principal_amount, d.platform_fee_amount, d.interest_rate_daily_bps,
                d.drawn_at, d.due_date, d.status, d.repaid_amount, d.repaid_at,
                ROUND(d.principal_amount * (d.interest_rate_daily_bps / 10000.0) *
                      GREATEST(0, (CURRENT_DATE - d.drawn_at::date)), 2) AS interest_accrued_to_date,
                d.principal_amount + ROUND(d.principal_amount * (d.interest_rate_daily_bps / 10000.0) *
                      GREATEST(0, (CURRENT_DATE - d.drawn_at::date)), 2) AS total_due_today
           FROM credit.credit_drawdown d
           JOIN credit.credit_line cl ON cl.credit_line_id = d.credit_line_id
           JOIN identity.organization o ON o.org_id = cl.lender_org_id
           LEFT JOIN marketplace.product_order po ON po.order_id = d.order_id
          WHERE cl.farmer_id = $1 ${filter}
          ORDER BY d.drawn_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'credit.credit_drawdown', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/orders/:id/pay-with-credit-line
 * Body: { credit_line_id }
 *
 * Draws the given credit line to pay the supplier NOW (net of the platform
 * fee) for an order this farmer already placed and the supplier has
 * already confirmed — see credit.draw_credit_for_order() in
 * grant_input_credit_line.sql for the full validation (ownership, credit
 * line active, order status, available headroom). Ownership of the ORDER
 * is re-checked here first (WHERE farmer_id = $1), same 404-before-touching
 * shape as POST /farmer/orders/:id/cancel above — ownership of the CREDIT
 * LINE itself is re-checked inside the SQL function.
 */
router.post('/orders/:id/pay-with-credit-line', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { credit_line_id: creditLineId } = req.body || {};

  if (!creditLineId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['credit_line_id'] });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT order_id FROM marketplace.product_order WHERE farmer_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { notFound: true };

      try {
        const { rows } = await client.query(
          'SELECT credit.draw_credit_for_order($1, $2, $3) AS drawdown_id',
          [id, creditLineId, CREDIT_LINE_PLATFORM_FEE_PERCENT],
        );
        await logAccess(client, 'write', 'credit.credit_drawdown', rows[0].drawdown_id);
        return { drawdownId: rows[0].drawdown_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'order_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_draw_credit_line', detail: result.businessError });
    }
    return res.json({ drawdown_id: result.drawdownId, order_id: id, payment_status: 'paid_via_credit_line' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/credit-line-drawdowns/:id/repay
 * Body: { unit_id }
 *
 * Pays off ONE drawdown in full — principal plus interest accrued to today
 * — from the named production unit's wallet. credit.repay_drawdown()
 * computes the exact amount owed itself (see grant_input_credit_line.sql
 * on why this is full-payoff-only, no partial amount is accepted here).
 * Ownership of the drawdown is checked via an explicit join through
 * credit_line.farmer_id before ever calling the SECURITY DEFINER function.
 */
router.post('/credit-line-drawdowns/:id/repay', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { unit_id: unitId } = req.body || {};

  if (!unitId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['unit_id'] });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const owned = await client.query(
        `SELECT d.drawdown_id FROM credit.credit_drawdown d
           JOIN credit.credit_line cl ON cl.credit_line_id = d.credit_line_id
          WHERE cl.farmer_id = $1 AND d.drawdown_id = $2`,
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { notFound: true };

      try {
        const { rows } = await client.query(
          'SELECT credit.repay_drawdown($1, $2) AS repayment_id',
          [id, unitId],
        );
        await logAccess(client, 'write', 'credit.credit_line_repayment', rows[0].repayment_id);
        return { repaymentId: rows[0].repayment_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'drawdown_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_repay_drawdown', detail: result.businessError });
    }
    return res.json({ repayment_id: result.repaymentId, drawdown_id: id, status: 'repaid' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
