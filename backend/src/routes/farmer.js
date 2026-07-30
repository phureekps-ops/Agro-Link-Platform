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
 * GET /farmer/input-suppliers?province_code= — every Verified InputSupplier
 * organization, with how many active products it currently has listed, so
 * a farmer can browse "by supplier" before drilling into GET /farmer/
 * products?org_id=. Mirrors GET /farmer/lenders' shape (a small supporting
 * directory endpoint so the frontend never has to hardcode an org_id).
 *
 * province_code filters on partner.vendor_profile.service_regions, same
 * column/shape as GET /farmer/machinery-providers?province_code= — see
 * PUT /inputsupplier/service-regions (src/routes/inputsupplier.js) for how
 * a supplier org declares which provinces it covers. An org that has never
 * set any service_regions (still '{}', the column default) simply never
 * matches a province filter — it still shows up under "ทั้งหมด" (no filter
 * applied).
 */
router.get('/input-suppliers', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { province_code: provinceCode } = req.query;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [];
      const filters = ["o.kyb_status = 'Verified'"];
      if (provinceCode) { params.push(provinceCode); filters.push(`$${params.length} = ANY(vp.service_regions)`); }

      const result = await client.query(
        `SELECT o.org_id, o.org_name, COALESCE(vp.service_regions, '{}') AS service_regions,
                COUNT(p.listing_id) FILTER (WHERE p.is_active) AS active_product_count
           FROM identity.organization o
           JOIN identity.organization_role r ON r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified'
           LEFT JOIN partner.vendor_profile vp ON vp.org_id = o.org_id
           LEFT JOIN marketplace.product_listing p ON p.org_id = o.org_id
          WHERE ${filters.join(' AND ')}
          GROUP BY o.org_id, o.org_name, vp.service_regions
          ORDER BY o.org_name`,
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
 * GET /farmer/products?category=&org_id=&province_code= — browse the
 * ACTIVE catalog across every Verified InputSupplier (or one, via org_id),
 * joined with the supplier's org_name so a farmer knows who they'd be
 * buying from, plus each product's own photos (marketplace.product_photo —
 * per-PRODUCT here, unlike marketplace.vendor_photo's per-ORG gallery on
 * the machinery side; see grant_input_supplier_and_buy_prices.sql's doc
 * comment). Only `is_active = true` rows — a deactivated listing (see the
 * deactivate-only note on DELETE /inputsupplier/products/:id) simply stops
 * appearing here, same as a deactivated machinery rate-card item stops
 * appearing priced.
 *
 * Suppliers have been able to upload per-product photos (GET/POST/DELETE
 * /inputsupplier/products/:id/photos) since this catalog was built, but
 * this route never surfaced them to the farmer browsing it until now — the
 * same "feature exists on one side, never wired to the other" gap already
 * fixed once for GET /farmer/machinery-providers' photo gallery.
 *
 * province_code filters on the supplier's partner.vendor_profile.
 * service_regions, same column/pattern as GET /farmer/machinery-providers
 * ?province_code= — see PUT /inputsupplier/service-regions for how a
 * supplier declares which provinces it covers.
 */
router.get('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { category, org_id: orgId, province_code: provinceCode } = req.query;

  if (category && !PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: PRODUCT_CATEGORIES });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [];
      const filters = ['p.is_active = true'];
      if (category) { params.push(category); filters.push(`p.category = $${params.length}`); }
      if (orgId) { params.push(orgId); filters.push(`p.org_id = $${params.length}`); }
      if (provinceCode) { params.push(provinceCode); filters.push(`$${params.length} = ANY(vp.service_regions)`); }

      const result = await client.query(
        `SELECT p.listing_id, p.org_id, o.org_name, p.category, p.product_name, p.brand,
                p.description, p.unit_price, p.price_unit, p.updated_at,
                COALESCE(vp.service_regions, '{}') AS service_regions,
                (p.is_featured AND (p.featured_until IS NULL OR p.featured_until > now())) AS is_featured,
                COALESCE(photos.photos, '[]'::json) AS photos
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
           LEFT JOIN partner.vendor_profile vp ON vp.org_id = p.org_id
           LEFT JOIN LATERAL (
             SELECT json_agg(
                      json_build_object(
                        'photo_id', ph.photo_id, 'photo_data_url', ph.photo_data_url, 'caption', ph.caption
                      ) ORDER BY ph.created_at DESC
                    ) AS photos
               FROM marketplace.product_photo ph
              WHERE ph.listing_id = p.listing_id
           ) photos ON true
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

const VENUE_TYPES = ['wholesale_market', 'fresh_market', 'popup_market', 'other'];

/**
 * GET /farmer/venue-listings?province_code=&venue_type= — browse ACTIVE
 * selling-space listings across every Verified MarketVenue organization
 * (see grant_market_venue_marketplace.sql), joined with the venue owner's
 * org_name. Same shape as GET /farmer/products — is_active filter only,
 * optional narrowing filters, no pagination (matches every other browse
 * endpoint in this project).
 */
router.get('/venue-listings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { province_code: provinceCode, venue_type: venueType } = req.query;

  if (venueType && !VENUE_TYPES.includes(venueType)) {
    return res.status(400).json({ error: 'invalid_venue_type', valid: VENUE_TYPES });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [];
      const filters = ['v.is_active = true', "r.status = 'Verified'", "o.kyb_status = 'Verified'"];
      if (provinceCode) { params.push(provinceCode); filters.push(`v.province_code = $${params.length}`); }
      if (venueType) { params.push(venueType); filters.push(`v.venue_type = $${params.length}`); }

      const result = await client.query(
        `SELECT v.listing_id, v.org_id, o.org_name, v.venue_name, v.venue_type, v.province_code,
                v.address_detail, v.accepted_products, v.space_description, v.fee_amount,
                v.fee_unit, v.schedule_note, v.updated_at
           FROM marketplace.venue_listing v
           JOIN identity.organization o ON o.org_id = v.org_id
           JOIN identity.organization_role r ON r.org_id = v.org_id AND r.role_type = 'MarketVenue'
          WHERE ${filters.join(' AND ')}
          ORDER BY v.updated_at DESC`,
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
 * POST /farmer/venue-bookings
 * Body: { listing_id, product_type, preferred_date, quantity_note?, farmer_note? }
 *
 * Requests to use one listing's space on a given date. venue_name/
 * venue_type/fee_amount/fee_unit are SNAPSHOTTED from the listing at this
 * moment (same reasoning as POST /farmer/orders — see grant_market_venue_
 * marketplace.sql's comment). Payment happens OFFLINE directly between the
 * farmer and the venue owner on-site — this only records the booking
 * request itself, per the explicit scope decision made with the user.
 */
router.post('/venue-bookings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    listing_id: listingId, product_type: productType, preferred_date: preferredDate,
    quantity_note: quantityNote, farmer_note: farmerNote,
  } = req.body || {};

  if (!listingId || !productType || !preferredDate) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['listing_id', 'product_type', 'preferred_date'],
    });
  }
  if (Number.isNaN(Date.parse(preferredDate))) {
    return res.status(400).json({ error: 'invalid_preferred_date' });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const listing = await client.query(
        `SELECT listing_id, org_id, venue_name, venue_type, fee_amount, fee_unit
           FROM marketplace.venue_listing
          WHERE listing_id = $1 AND is_active = true`,
        [listingId],
      );
      if (listing.rows.length === 0) return { listingNotFound: true };
      const l = listing.rows[0];

      const { rows } = await client.query(
        `INSERT INTO marketplace.venue_booking
           (listing_id, org_id, farmer_id, venue_name, venue_type, fee_amount, fee_unit,
            product_type, quantity_note, preferred_date, farmer_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING booking_id, listing_id, org_id, venue_name, venue_type, fee_amount, fee_unit,
                   product_type, quantity_note, preferred_date, farmer_note, status, requested_at`,
        [
          listingId, l.org_id, subjectId, l.venue_name, l.venue_type, l.fee_amount, l.fee_unit,
          productType.trim(), quantityNote || null, preferredDate, farmerNote || null,
        ],
      );
      await logAccess(client, 'write', 'marketplace.venue_booking', rows[0].booking_id);
      return { booking: rows[0] };
    });

    if (result.listingNotFound) {
      return res.status(404).json({ error: 'venue_listing_not_found' });
    }
    return res.status(201).json(result.booking);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/venue-bookings?status=... — this farmer's own booking
 * requests across every venue, joined with the venue owner's org_name.
 */
router.get('/venue-bookings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status) { params.push(status); filter = 'AND b.status = $2'; }

      const result = await client.query(
        `SELECT b.booking_id, b.org_id, org.org_name, b.venue_name, b.venue_type, b.fee_amount,
                b.fee_unit, b.product_type, b.quantity_note, b.preferred_date, b.farmer_note,
                b.status, b.decided_reason, b.requested_at, b.decided_at
           FROM marketplace.venue_booking b
           JOIN identity.organization org ON org.org_id = b.org_id
          WHERE b.farmer_id = $1 ${filter}
          ORDER BY b.requested_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'marketplace.venue_booking', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/venue-bookings/:id/cancel — a farmer can cancel their OWN
 * booking request, only while it's still `Requested` (before the venue
 * owner has acted on it). Same ownership-gate + status-guard shape as
 * POST /farmer/orders/:id/cancel.
 */
router.post('/venue-bookings/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.venue_booking WHERE farmer_id = $1 AND booking_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.venue_booking
            SET status = 'Cancelled', updated_at = now()
          WHERE farmer_id = $1 AND booking_id = $2
          RETURNING booking_id, status`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.venue_booking', id);
      return { booking: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'booking_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'booking_not_cancellable', current_status: result.wrongStatus });
    }
    return res.json(result.booking);
  } catch (err) {
    return next(err);
  }
});

// Same five role types src/routes/machinery.js's requireMachineryOrg gates
// on — duplicated locally rather than imported, matching this project's
// established pattern of small local constant duplicates across route
// files with no shared module bundler (e.g. SERVICE_TYPE_LABEL_TH in
// frontend/machinery/js/dashboard.js).
const MACHINERY_ORG_TYPES = ['TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService'];
const MACHINERY_SERVICE_KEYS = ['plow_rough', 'plow_secondary_seed', 'rotary_till', 'spraying', 'harvesting', 'trucking', 'drying'];

/**
 * GET /farmer/machinery-providers?service_key=&province_code= — browse
 * ACTIVE, priced rate-card items across every Verified machinery/drying-
 * yard organization (any of the five MACHINERY_ORG_TYPES — see
 * requireMachineryOrg in src/routes/machinery.js), joined with the
 * provider's org_name and, where recorded, the service regions they cover
 * (partner.vendor_profile.service_regions — see grant_machinery_booking.sql).
 * Uses EXISTS rather than a JOIN against identity.organization_role so an
 * org holding more than one Verified machinery role (e.g. TractorService +
 * TruckService) doesn't get its listings duplicated once per matching role.
 * Same shape as GET /farmer/venue-listings — is_active filter only,
 * optional narrowing filters, no pagination.
 */
router.get('/machinery-providers', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { service_key: serviceKey, province_code: provinceCode } = req.query;

  if (serviceKey && !MACHINERY_SERVICE_KEYS.includes(serviceKey)) {
    return res.status(400).json({ error: 'invalid_service_key', valid: MACHINERY_SERVICE_KEYS });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [MACHINERY_ORG_TYPES];
      const filters = [
        'sl.is_active = true',
        'sl.service_key IS NOT NULL',
        "o.kyb_status = 'Verified'",
        `EXISTS (
           SELECT 1 FROM identity.organization_role r
            WHERE r.org_id = sl.org_id AND r.role_type = ANY($1) AND r.status = 'Verified'
         )`,
      ];
      if (serviceKey) { params.push(serviceKey); filters.push(`sl.service_key = $${params.length}`); }
      if (provinceCode) { params.push(provinceCode); filters.push(`$${params.length} = ANY(vp.service_regions)`); }

      const result = await client.query(
        `SELECT sl.listing_id, sl.org_id, o.org_name, sl.service_key, sl.service_type,
                sl.description AS label_th, sl.unit_price, sl.price_unit,
                COALESCE(vp.service_regions, '{}') AS service_regions,
                (sl.is_featured AND (sl.featured_until IS NULL OR sl.featured_until > now())) AS is_featured,
                COALESCE(photos.photos, '[]'::json) AS photos
           FROM marketplace.service_listing sl
           JOIN identity.organization o ON o.org_id = sl.org_id
           LEFT JOIN partner.vendor_profile vp ON vp.org_id = sl.org_id
           LEFT JOIN LATERAL (
             SELECT json_agg(
                      json_build_object(
                        'photo_id', p.photo_id, 'photo_type', p.photo_type,
                        'photo_data_url', p.photo_data_url, 'caption', p.caption
                      ) ORDER BY p.created_at DESC
                    ) AS photos
               FROM marketplace.vendor_photo p
              WHERE p.org_id = sl.org_id
           ) photos ON true
          WHERE ${filters.join(' AND ')}
          ORDER BY (sl.is_featured AND (sl.featured_until IS NULL OR sl.featured_until > now())) DESC,
                   o.org_name, sl.service_key`,
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
 * GET /farmer/machinery-providers/:listingId/booked-dates — dates already
 * Requested/Accepted against ONE listing, so a farmer can see which days
 * are already spoken for before picking a preferred_date. Only exposes the
 * date + status — never who booked it or any other farmer's details. A
 * booking is still just a REQUEST (see grant_machinery_booking.sql's doc
 * comment on why this mirrors venue_booking rather than the older service_
 * request mechanism) — nothing stops a farmer from submitting a date
 * that's already Requested/Accepted by someone else, the provider is the
 * one who ultimately decides; this endpoint only helps a farmer pick a
 * less-contested date, it does not enforce exclusivity.
 */
router.get('/machinery-providers/:listingId/booked-dates', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { listingId } = req.params;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT preferred_date, status
           FROM marketplace.machinery_booking
          WHERE listing_id = $1 AND status IN ('Requested', 'Accepted')
          ORDER BY preferred_date ASC`,
        [listingId],
      );
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/machinery-bookings
 * Body: { listing_id, preferred_date, quantity_note?, farmer_note? }
 *
 * Requests one priced rate-card item on a given date. service_key/label_th/
 * service_type/unit_price/price_unit are SNAPSHOTTED from the listing at
 * this moment (same reasoning as POST /farmer/venue-bookings — a provider
 * editing their rate card tomorrow must not silently change what a farmer
 * already requested today). Payment happens OFFLINE directly between the
 * farmer and the provider — this only records the booking request itself,
 * per the same scope decision made for MarketVenue bookings.
 */
router.post('/machinery-bookings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    listing_id: listingId, preferred_date: preferredDate,
    quantity_note: quantityNote, farmer_note: farmerNote,
  } = req.body || {};

  if (!listingId || !preferredDate) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['listing_id', 'preferred_date'],
    });
  }
  if (Number.isNaN(Date.parse(preferredDate))) {
    return res.status(400).json({ error: 'invalid_preferred_date' });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const listing = await client.query(
        `SELECT listing_id, org_id, service_key, service_type, description AS label_th, unit_price, price_unit
           FROM marketplace.service_listing
          WHERE listing_id = $1 AND is_active = true AND service_key IS NOT NULL`,
        [listingId],
      );
      if (listing.rows.length === 0) return { listingNotFound: true };
      const l = listing.rows[0];

      const { rows } = await client.query(
        `INSERT INTO marketplace.machinery_booking
           (listing_id, org_id, farmer_id, service_key, label_th, service_type, unit_price, price_unit,
            quantity_note, preferred_date, farmer_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING booking_id, listing_id, org_id, service_key, label_th, service_type, unit_price,
                   price_unit, quantity_note, preferred_date, farmer_note, status, requested_at`,
        [
          listingId, l.org_id, subjectId, l.service_key, l.label_th, l.service_type, l.unit_price, l.price_unit,
          quantityNote || null, preferredDate, farmerNote || null,
        ],
      );
      await logAccess(client, 'write', 'marketplace.machinery_booking', rows[0].booking_id);
      return { booking: rows[0] };
    });

    if (result.listingNotFound) {
      return res.status(404).json({ error: 'machinery_listing_not_found' });
    }
    return res.status(201).json(result.booking);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/machinery-bookings?status=... — this farmer's own booking
 * requests across every provider, joined with the provider's org_name.
 */
router.get('/machinery-bookings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status) { params.push(status); filter = 'AND b.status = $2'; }

      const result = await client.query(
        `SELECT b.booking_id, b.org_id, org.org_name, b.service_key, b.label_th, b.service_type,
                b.unit_price, b.price_unit, b.quantity_note, b.preferred_date, b.farmer_note,
                b.status, b.decided_reason, b.requested_at, b.decided_at
           FROM marketplace.machinery_booking b
           JOIN identity.organization org ON org.org_id = b.org_id
          WHERE b.farmer_id = $1 ${filter}
          ORDER BY b.requested_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'marketplace.machinery_booking', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/machinery-bookings/:id/cancel — a farmer can cancel their
 * OWN booking request, only while it's still `Requested` (before the
 * provider has acted on it). Same ownership-gate + status-guard shape as
 * POST /farmer/venue-bookings/:id/cancel.
 */
router.post('/machinery-bookings/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.machinery_booking WHERE farmer_id = $1 AND booking_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.machinery_booking
            SET status = 'Cancelled', updated_at = now()
          WHERE farmer_id = $1 AND booking_id = $2
          RETURNING booking_id, status`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.machinery_booking', id);
      return { booking: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'booking_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'booking_not_cancellable', current_status: result.wrongStatus });
    }
    return res.json(result.booking);
  } catch (err) {
    return next(err);
  }
});


// ---------- "แนะนำสำหรับท่าน" (AI Matching) ----------
// Backs a "recommended for you" section on marketplace.html /
// machinery-marketplace.html / venue-marketplace.html. This is a
// legitimate multi-factor CONTENT-BASED scoring/ranking system — NOT deep
// learning or an LLM — deliberately built and described honestly this way
// per the "where in AgroLink is AI actually used" conversation earlier.
// Every candidate listing gets a match_score in [0, 1] from three signals,
// computed entirely in SQL against the same live data every other browse
// route already reads (no separate offline training step, unlike
// risk.credit_model above — this re-scores fresh on every request):
//
//   40% region match     — does the farmer's identity.farmer.region_code
//                           appear in the provider's service area (
//                           partner.vendor_profile.service_regions for
//                           InputSupplier/Machinery, marketplace.
//                           venue_listing.province_code directly for
//                           MarketVenue)? A provider that has never set a
//                           service area gets a neutral 0.5 rather than 0
//                           — many existing providers predate the service-
//                           area feature and shouldn't be penalized for it.
//   30% price competitiveness — this listing's price vs. the average
//                           price of other active listings in the same
//                           category/service_key/venue_type. At-or-below
//                           the group average scores 1.0, linearly falling
//                           to 0 at double the average. A listing with no
//                           comparable price data (e.g. only listing in
//                           its group, or a venue with no fee_amount set)
//                           gets a neutral 0.5.
//   30% reliability        — this provider's historical success rate:
//                           fulfilled product_order rows / (fulfilled +
//                           rejected) for InputSupplier, Accepted /
//                           (Accepted + Declined) machinery_booking rows
//                           for Machinery, same shape for venue_booking.
//                           Pending (requested/Requested) and farmer-
//                           cancelled rows are excluded from both the
//                           numerator and denominator — neither reflects
//                           on the provider. A provider with no terminal
//                           history yet gets a neutral 0.5, not a penalty
//                           for being new.
//
// Every route below re-uses the exact same base filters (is_active,
// kyb_status/organization_role verification where the plain browse route
// already checks them) as its non-"recommended" sibling above, so a
// provider that wouldn't show up in the normal browse list never shows up
// here either.

/**
 * GET /farmer/products/recommended
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
      const params = [subjectId];
      const filters = ['p.is_active = true'];
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
                COALESCE(vp.service_regions, '{}') AS service_regions,
                (p.is_featured AND (p.featured_until IS NULL OR p.featured_until > now())) AS is_featured,
                COALESCE(photos.photos, '[]'::json) AS photos,
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
           LEFT JOIN LATERAL (
             SELECT json_agg(
                      json_build_object(
                        'photo_id', ph.photo_id, 'photo_data_url', ph.photo_data_url, 'caption', ph.caption
                      ) ORDER BY ph.created_at DESC
                    ) AS photos
               FROM marketplace.product_photo ph
              WHERE ph.listing_id = p.listing_id
           ) photos ON true
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
 * GET /farmer/machinery-providers/recommended
 * Query: service_key? (see MACHINERY_SERVICE_KEYS), limit? (default 10, max 50)
 */
router.get('/machinery-providers/recommended', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { service_key: serviceKey } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

  if (serviceKey && !MACHINERY_SERVICE_KEYS.includes(serviceKey)) {
    return res.status(400).json({ error: 'invalid_service_key', valid: MACHINERY_SERVICE_KEYS });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId, MACHINERY_ORG_TYPES];
      const filters = [
        'sl.is_active = true',
        'sl.service_key IS NOT NULL',
        "o.kyb_status = 'Verified'",
        `EXISTS (
           SELECT 1 FROM identity.organization_role r
            WHERE r.org_id = sl.org_id AND r.role_type = ANY($2) AND r.status = 'Verified'
         )`,
      ];
      if (serviceKey) { params.push(serviceKey); filters.push(`sl.service_key = $${params.length}`); }
      params.push(limit);
      const limitPlaceholder = `$${params.length}`;

      const result = await client.query(
        `WITH farmer_region AS (
           SELECT region_code FROM identity.farmer WHERE farmer_id = $1
         ),
         reliability AS (
           SELECT org_id,
                  count(*) FILTER (WHERE status = 'Accepted') AS success_count,
                  count(*) FILTER (WHERE status IN ('Accepted', 'Declined')) AS terminal_count
             FROM marketplace.machinery_booking
            GROUP BY org_id
         )
         SELECT sl.listing_id, sl.org_id, o.org_name, sl.service_key, sl.service_type,
                sl.description AS label_th, sl.unit_price, sl.price_unit,
                COALESCE(vp.service_regions, '{}') AS service_regions,
                (sl.is_featured AND (sl.featured_until IS NULL OR sl.featured_until > now())) AS is_featured,
                COALESCE(photos.photos, '[]'::json) AS photos,
                ROUND((
                  0.4 * (CASE
                           WHEN COALESCE(cardinality(vp.service_regions), 0) = 0 THEN 0.5
                           WHEN fr.region_code = ANY(vp.service_regions) THEN 1.0
                           ELSE 0.0
                         END)
                + 0.3 * COALESCE(LEAST(1.0, GREATEST(0.0,
                    1 - (sl.unit_price - key_avg.avg_price) / NULLIF(key_avg.avg_price, 0)
                  )), 0.5)
                + 0.3 * (CASE WHEN COALESCE(rel.terminal_count, 0) = 0 THEN 0.5
                              ELSE rel.success_count::numeric / rel.terminal_count END)
                )::numeric, 4) AS match_score
           FROM marketplace.service_listing sl
           JOIN identity.organization o ON o.org_id = sl.org_id
           LEFT JOIN partner.vendor_profile vp ON vp.org_id = sl.org_id
           CROSS JOIN farmer_region fr
           LEFT JOIN reliability rel ON rel.org_id = sl.org_id
           LEFT JOIN LATERAL (
             SELECT AVG(sl2.unit_price) AS avg_price
               FROM marketplace.service_listing sl2
              WHERE sl2.service_key = sl.service_key AND sl2.is_active = true AND sl2.listing_id <> sl.listing_id
           ) key_avg ON true
           LEFT JOIN LATERAL (
             SELECT json_agg(
                      json_build_object(
                        'photo_id', p.photo_id, 'photo_type', p.photo_type,
                        'photo_data_url', p.photo_data_url, 'caption', p.caption
                      ) ORDER BY p.created_at DESC
                    ) AS photos
               FROM marketplace.vendor_photo p
              WHERE p.org_id = sl.org_id
           ) photos ON true
          WHERE ${filters.join(' AND ')}
          ORDER BY match_score DESC, sl.service_key
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
 * GET /farmer/venue-listings/recommended
 * Query: venue_type? (see VENUE_TYPES), limit? (default 10, max 50)
 *
 * marketplace.venue_listing carries province_code directly (no
 * vendor_profile join needed, unlike InputSupplier/Machinery) and
 * fee_amount is nullable — both handled below the same way GET
 * /farmer/venue-listings already handles them.
 */
router.get('/venue-listings/recommended', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { venue_type: venueType } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);

  if (venueType && !VENUE_TYPES.includes(venueType)) {
    return res.status(400).json({ error: 'invalid_venue_type', valid: VENUE_TYPES });
  }

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      const filters = ['v.is_active = true', "r.status = 'Verified'", "o.kyb_status = 'Verified'"];
      if (venueType) { params.push(venueType); filters.push(`v.venue_type = $${params.length}`); }
      params.push(limit);
      const limitPlaceholder = `$${params.length}`;

      const result = await client.query(
        `WITH farmer_region AS (
           SELECT region_code FROM identity.farmer WHERE farmer_id = $1
         ),
         reliability AS (
           SELECT org_id,
                  count(*) FILTER (WHERE status = 'Accepted') AS success_count,
                  count(*) FILTER (WHERE status IN ('Accepted', 'Declined')) AS terminal_count
             FROM marketplace.venue_booking
            GROUP BY org_id
         )
         SELECT v.listing_id, v.org_id, o.org_name, v.venue_name, v.venue_type, v.province_code,
                v.address_detail, v.accepted_products, v.space_description, v.fee_amount,
                v.fee_unit, v.schedule_note, v.updated_at,
                ROUND((
                  0.4 * (CASE WHEN fr.region_code = v.province_code THEN 1.0 ELSE 0.0 END)
                + 0.3 * (CASE WHEN v.fee_amount IS NULL THEN 0.5
                              ELSE COALESCE(LEAST(1.0, GREATEST(0.0,
                                1 - (v.fee_amount - type_avg.avg_fee) / NULLIF(type_avg.avg_fee, 0)
                              )), 0.5)
                         END)
                + 0.3 * (CASE WHEN COALESCE(rel.terminal_count, 0) = 0 THEN 0.5
                              ELSE rel.success_count::numeric / rel.terminal_count END)
                )::numeric, 4) AS match_score
           FROM marketplace.venue_listing v
           JOIN identity.organization o ON o.org_id = v.org_id
           JOIN identity.organization_role r ON r.org_id = v.org_id AND r.role_type = 'MarketVenue'
           CROSS JOIN farmer_region fr
           LEFT JOIN reliability rel ON rel.org_id = v.org_id
           LEFT JOIN LATERAL (
             SELECT AVG(v2.fee_amount) AS avg_fee
               FROM marketplace.venue_listing v2
              WHERE v2.venue_type = v.venue_type AND v2.is_active = true
                AND v2.fee_amount IS NOT NULL AND v2.listing_id <> v.listing_id
           ) type_avg ON true
          WHERE ${filters.join(' AND ')}
          ORDER BY match_score DESC, v.venue_name
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

module.exports = router;
