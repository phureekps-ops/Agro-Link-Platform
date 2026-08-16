const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');

const router = express.Router();

// Farmer-facing side of the "book a machinery/drying-yard service" feature
// — mirrors marketplace.machinery_booking, added by grant_machinery_booking.
// sql specifically for this (see that file's own comment for why it is a
// dedicated table rather than reusing the older, unwired marketplace.
// service_request mechanism). Mounted at '/farmer' in server.js alongside
// farmer.js/stagecalendar.js/fertilizer.js/carbon.js — same shared-prefix
// pattern, no path collision (none of those define a /machinery-* sub-path).
router.use(requireAuth, requireFarmer);

// Same five org_types as MACHINERY_ORG_TYPES in src/routes/machinery.js —
// duplicated here rather than shared, matching this project's existing
// convention (see FERTILIZER_MIXING_ORG_TYPES in fertilizer.js, also
// duplicated rather than imported).
const MACHINERY_ORG_TYPES = ['TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService'];

/**
 * GET /farmer/machinery-providers — every currently-priced rate-card item
 * (marketplace.service_listing, service_key IS NOT NULL) from a Verified
 * machinery/drying-yard org, joined with the provider's org_name, so a
 * farmer can compare providers before booking. Optional ?service_type=
 * filter (land_preparation / harvesting / pest_control / transport /
 * drying_storage — the five values RATE_CARD_ITEMS in machinery.js maps its
 * seven service_keys onto). Mirrors GET /farmer/fertilizer-mixing-providers'
 * shape, just without the single fixed service_key filter that route uses.
 *
 * Featured listings (see grant_featured_listings.sql / the
 * /admin/service-listings routes in admin.js) sort first — `featured` is
 * computed live the same way GET /farmer/products does, since is_featured
 * is never auto-cleared once featured_until passes.
 */
router.get('/machinery-providers', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { service_type: serviceType } = req.query;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [MACHINERY_ORG_TYPES];
      let filter = '';
      if (serviceType) {
        params.push(serviceType);
        filter = 'AND sl.service_type = $2';
      }
      const result = await client.query(
        `SELECT sl.listing_id, sl.org_id, o.org_name, sl.service_key, sl.service_type,
                sl.description AS label_th, sl.unit_price, sl.price_unit,
                (sl.is_featured AND (sl.featured_until IS NULL OR sl.featured_until > now())) AS featured
           FROM marketplace.service_listing sl
           JOIN identity.organization o ON o.org_id = sl.org_id
          WHERE sl.is_active = true
            AND sl.service_key IS NOT NULL
            AND o.kyb_status = 'Verified'
            AND EXISTS (
              SELECT 1 FROM identity.organization_role r
               WHERE r.org_id = sl.org_id AND r.role_type = ANY($1) AND r.status = 'Verified'
            )
            ${filter}
          ORDER BY (sl.is_featured AND (sl.featured_until IS NULL OR sl.featured_until > now())) DESC,
                   o.org_name, sl.service_type`,
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
 * POST /farmer/machinery-bookings
 * Body: { listing_id, preferred_date, quantity_note?, farmer_note? }
 *
 * No unit_id/cycle_id/stage_id here, unlike POST /farmer/fertilizer-mixing-
 * orders — marketplace.machinery_booking deliberately has no such columns
 * (see grant_machinery_booking.sql's own comment: this table mirrors
 * venue_booking's simpler "just a request/accept/decline record" shape,
 * not the full production_unit-linked service_request mechanism).
 *
 * service_key/label_th/service_type/unit_price/price_unit are SNAPSHOTTED
 * from the listing at this moment — a provider changing their rate card
 * tomorrow must not silently change what a farmer already booked today
 * (same reasoning as every other marketplace order/booking route here).
 */
router.post('/machinery-bookings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    listing_id: listingId, preferred_date: preferredDate,
    quantity_note: quantityNote, farmer_note: farmerNote,
  } = req.body || {};

  if (!listingId || !preferredDate) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['listing_id', 'preferred_date'] });
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
           (listing_id, org_id, farmer_id, service_key, label_th, service_type,
            unit_price, price_unit, quantity_note, preferred_date, farmer_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING booking_id, listing_id, org_id, service_key, label_th, service_type,
                   unit_price, price_unit, quantity_note, preferred_date, farmer_note,
                   status, requested_at`,
        [
          listingId, l.org_id, subjectId, l.service_key, l.label_th, l.service_type,
          l.unit_price, l.price_unit, quantityNote || null, preferredDate, farmerNote || null,
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
 * GET /farmer/machinery-bookings?status=... — this farmer's own bookings
 * across every provider, joined with the provider's org_name.
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
        `SELECT b.booking_id, b.listing_id, b.org_id, org.org_name,
                b.service_key, b.label_th, b.service_type, b.unit_price, b.price_unit,
                b.quantity_note, b.preferred_date, b.farmer_note,
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
 * OWN booking, only while it's still `Requested` (before the provider has
 * acted on it). Same ownership-gate + status-guard shape as
 * POST /farmer/fertilizer-mixing-orders/:id/cancel.
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

module.exports = router;
