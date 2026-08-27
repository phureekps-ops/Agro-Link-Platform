const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');

const router = express.Router();

// Farmer-facing side of the "หาที่ขายสินค้า" (selling-space matching)
// feature — mirrors marketplace.venue_listing / marketplace.venue_booking
// (see grant_market_venue_marketplace.sql). Restored after being
// accidentally deleted with NO replacement in commit 6be68c3
// "แค๊ตตาล๊อก สหกรณ์" — a large farmer.js refactor that correctly relocated
// the machinery-provider routes into farmermachinery.js but dropped these
// venue routes entirely. frontend/js/venue-marketplace.js kept calling
// these endpoints the whole time, so venue-marketplace.html has been
// silently returning 404 on every button for every farmer since that
// commit — this file brings it back to life, unchanged in shape from the
// original (schema was verified unchanged before restoring).
//
// Mounted at '/farmer' in server.js, same shared-prefix pattern as
// farmer.js/stagecalendar.js/fertilizer.js/carbon.js/farmermachinery.js —
// no path collision (no other farmer route file defines a /venue-*
// sub-path).
router.use(requireAuth, requireFarmer);

const VENUE_TYPES = ['wholesale_market', 'fresh_market', 'popup_market', 'other'];

/**
 * GET /farmer/venue-listings?province_code=&venue_type= — browse ACTIVE
 * selling-space listings across every Verified MarketVenue organization,
 * joined with the venue owner's org_name. Same shape as GET
 * /farmer/products — is_active filter only, optional narrowing filters, no
 * pagination (matches every other browse endpoint in this project).
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
 * moment (same reasoning as POST /farmer/orders — a listing edited
 * tomorrow must not silently change what a farmer already agreed to
 * today). Payment happens OFFLINE directly between the farmer and the
 * venue owner on-site — this only records the booking request itself, per
 * the scope decision documented in grant_market_venue_marketplace.sql.
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

// ---------- "แนะนำสำหรับท่าน" (AI Matching) ----------
// Same legitimate multi-factor CONTENT-BASED scoring/ranking system as GET
// /farmer/products/recommended (see that route's doc comment in farmer.js
// for the full rationale) — NOT deep learning, computed fresh on every
// request in pure SQL:
//
//   40% region match          — v.province_code vs the farmer's
//                                identity.farmer.region_code directly (no
//                                vendor_profile join needed —
//                                venue_listing carries province_code on
//                                the row itself).
//   30% price competitiveness — this listing's fee_amount vs. the average
//                                fee of other active listings sharing the
//                                same venue_type (neutral 0.5 if
//                                fee_amount is null or no comparable fee
//                                data).
//   30% reliability            — Accepted / (Accepted + Declined)
//                                venue_booking rows for this venue owner
//                                (neutral 0.5 with no terminal history
//                                yet).
//
// Re-uses the exact same base filters as GET /farmer/venue-listings above,
// so a venue that wouldn't show up in the normal browse list never shows
// up here either.

/**
 * GET /farmer/venue-listings/recommended
 * Query: venue_type? (see VENUE_TYPES), limit? (default 10, max 50)
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
