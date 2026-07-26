const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT.
router.use(requireAuth, requireOrganization);

const VENUE_TYPES = ['wholesale_market', 'fresh_market', 'popup_market', 'other'];

/**
 * Confirms the authenticated organization actually HOLDS a Verified
 * 'MarketVenue' role. Same two-layer pattern as requireInputSupplierOrg /
 * requireLenderOrg (see inputsupplier.js's doc comment for the full
 * explanation) — entity kyb_status first, then this specific role's own
 * status.
 */
async function requireMarketVenueOrg(req, res, next) {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      if (org.rows.length === 0) return { orgMissing: true };
      const orgRow = org.rows[0];
      if (orgRow.kyb_status !== 'Verified') return { kybNotVerified: true, org: orgRow };

      const role = await client.query(
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'MarketVenue'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'market_venue_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'MarketVenue', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireMarketVenueOrg);

/**
 * IMPORTANT: marketplace.venue_listing and marketplace.venue_booking have
 * NO row-level security at all — same situation as every other
 * marketplace.* table (see the note at the top of src/routes/machinery.js).
 * Every query below MUST include an explicit `WHERE org_id = $1` — this is
 * the entire security boundary, not defense-in-depth.
 */

/**
 * GET /marketvenue/dashboard — org info plus listing/booking counts, so the
 * frontend has enough for a summary without extra round trips.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const listings = await client.query(
        `SELECT COUNT(*) FILTER (WHERE is_active) AS active_count, COUNT(*)::int AS total_count
           FROM marketplace.venue_listing
          WHERE org_id = $1`,
        [subjectId],
      );
      const bookings = await client.query(
        `SELECT status, COUNT(*)::int AS count FROM marketplace.venue_booking
          WHERE org_id = $1 GROUP BY status`,
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.venue_listing', subjectId);

      const bookingsByStatus = { Requested: 0, Accepted: 0, Declined: 0, Cancelled: 0 };
      bookings.rows.forEach((r) => { bookingsByStatus[r.status] = r.count; });

      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        active_listing_count: Number(listings.rows[0].active_count),
        total_listing_count: listings.rows[0].total_count,
        bookings_by_status: bookingsByStatus,
        pending_bookings_count: bookingsByStatus.Requested,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /marketvenue/listings — this org's own listings (every one, active or
 * not — the management view needs to see and re-activate deactivated
 * listings too, not just what's currently live to farmers).
 */
router.get('/listings', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT listing_id, venue_name, venue_type, province_code, address_detail,
                accepted_products, space_description, fee_amount, fee_unit,
                schedule_note, is_active, created_at, updated_at
           FROM marketplace.venue_listing
          WHERE org_id = $1
          ORDER BY created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.venue_listing', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /marketvenue/listings
 * Body: { venue_name, venue_type, province_code, address_detail?,
 *         accepted_products?, space_description?, fee_amount?, fee_unit?,
 *         schedule_note? }
 */
router.post('/listings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    venue_name: venueName, venue_type: venueType, province_code: provinceCode,
    address_detail: addressDetail, accepted_products: acceptedProducts,
    space_description: spaceDescription, fee_amount: feeAmount, fee_unit: feeUnit,
    schedule_note: scheduleNote,
  } = req.body || {};

  if (!venueName || !venueName.trim()) {
    return res.status(400).json({ error: 'venue_name_required' });
  }
  if (!venueType || !VENUE_TYPES.includes(venueType)) {
    return res.status(400).json({ error: 'invalid_venue_type', valid: VENUE_TYPES });
  }
  if (!provinceCode || !provinceCode.trim()) {
    return res.status(400).json({ error: 'province_code_required' });
  }
  if (feeAmount !== undefined && feeAmount !== null && feeAmount !== '' && (!Number.isFinite(Number(feeAmount)) || Number(feeAmount) < 0)) {
    return res.status(400).json({ error: 'invalid_fee_amount' });
  }

  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO marketplace.venue_listing
           (org_id, venue_name, venue_type, province_code, address_detail,
            accepted_products, space_description, fee_amount, fee_unit, schedule_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING listing_id, venue_name, venue_type, province_code, address_detail,
                   accepted_products, space_description, fee_amount, fee_unit,
                   schedule_note, is_active, created_at, updated_at`,
        [
          subjectId, venueName.trim(), venueType, provinceCode.trim(), addressDetail || null,
          acceptedProducts || null, spaceDescription || null,
          feeAmount === '' || feeAmount === undefined ? null : feeAmount,
          feeUnit || null, scheduleNote || null,
        ],
      );
      await logAccess(client, 'write', 'marketplace.venue_listing', rows[0].listing_id);
      return rows[0];
    });

    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /marketvenue/listings/:id — ownership-gated the same way as every
 * other org-scoped write in this project (WHERE org_id = $1 AND
 * listing_id = $2 first, 404 if that finds nothing).
 */
router.put('/listings/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const {
    venue_name: venueName, venue_type: venueType, province_code: provinceCode,
    address_detail: addressDetail, accepted_products: acceptedProducts,
    space_description: spaceDescription, fee_amount: feeAmount, fee_unit: feeUnit,
    schedule_note: scheduleNote, is_active: isActive,
  } = req.body || {};

  if (venueType !== undefined && !VENUE_TYPES.includes(venueType)) {
    return res.status(400).json({ error: 'invalid_venue_type', valid: VENUE_TYPES });
  }
  if (venueName !== undefined && !venueName.trim()) {
    return res.status(400).json({ error: 'venue_name_required' });
  }
  if (feeAmount !== undefined && feeAmount !== null && feeAmount !== '' && (!Number.isFinite(Number(feeAmount)) || Number(feeAmount) < 0)) {
    return res.status(400).json({ error: 'invalid_fee_amount' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT listing_id FROM marketplace.venue_listing WHERE org_id = $1 AND listing_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { notFound: true };

      const { rows } = await client.query(
        `UPDATE marketplace.venue_listing SET
           venue_name        = COALESCE($3, venue_name),
           venue_type        = COALESCE($4, venue_type),
           province_code     = COALESCE($5, province_code),
           address_detail    = CASE WHEN $6::boolean THEN $7 ELSE address_detail END,
           accepted_products = CASE WHEN $8::boolean THEN $9 ELSE accepted_products END,
           space_description = CASE WHEN $10::boolean THEN $11 ELSE space_description END,
           fee_amount        = CASE WHEN $12::boolean THEN $13 ELSE fee_amount END,
           fee_unit          = CASE WHEN $14::boolean THEN $15 ELSE fee_unit END,
           schedule_note     = CASE WHEN $16::boolean THEN $17 ELSE schedule_note END,
           is_active         = COALESCE($18, is_active),
           updated_at        = now()
         WHERE org_id = $1 AND listing_id = $2
         RETURNING listing_id, venue_name, venue_type, province_code, address_detail,
                   accepted_products, space_description, fee_amount, fee_unit,
                   schedule_note, is_active, created_at, updated_at`,
        [
          subjectId, id,
          venueName ? venueName.trim() : null, venueType || null, provinceCode ? provinceCode.trim() : null,
          addressDetail !== undefined, addressDetail || null,
          acceptedProducts !== undefined, acceptedProducts || null,
          spaceDescription !== undefined, spaceDescription || null,
          feeAmount !== undefined, feeAmount === '' ? null : feeAmount,
          feeUnit !== undefined, feeUnit || null,
          scheduleNote !== undefined, scheduleNote || null,
          isActive !== undefined ? Boolean(isActive) : null,
        ],
      );
      await logAccess(client, 'write', 'marketplace.venue_listing', id);
      return { listing: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'listing_not_found' });
    }
    return res.json(result.listing);
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /marketvenue/listings/:id — DEACTIVATE, not a real delete, same
 * reasoning as DELETE /inputsupplier/products/:id: a farmer may have
 * already booked against this exact listing (marketplace.venue_booking.
 * listing_id references it), so a hard delete would orphan that booking's
 * FK. `is_active = false` removes it from GET /farmer/venue-listings
 * (which only returns is_active = true) without disturbing booking history.
 */
router.delete('/listings/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const deactivated = await withSessionContext('organization', subjectId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE marketplace.venue_listing SET is_active = false, updated_at = now()
          WHERE org_id = $1 AND listing_id = $2`,
        [subjectId, id],
      );
      if (rowCount > 0) {
        await logAccess(client, 'write', 'marketplace.venue_listing', id);
      }
      return rowCount > 0;
    });

    if (!deactivated) {
      return res.status(404).json({ error: 'listing_not_found' });
    }
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /marketvenue/bookings?status=... — booking requests against THIS
 * org's listings (never another venue owner's), joined with the requesting
 * farmer's name/phone. `status=action_needed` is shorthand for `Requested`
 * — the only status this portal still needs to act on (same shorthand
 * pattern as GET /inputsupplier/orders?status=action_needed, just a
 * single-value set here since there's no intermediate "confirmed, awaiting
 * fulfillment" state for a venue booking).
 */
router.get('/bookings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status === 'action_needed') {
        filter = "AND b.status = 'Requested'";
      } else if (status) {
        params.push(status);
        filter = 'AND b.status = $2';
      }
      const result = await client.query(
        `SELECT b.booking_id, b.listing_id, b.venue_name, b.venue_type, b.fee_amount, b.fee_unit,
                b.product_type, b.quantity_note, b.preferred_date, b.farmer_note, b.status,
                b.decided_reason, b.requested_at, b.decided_at, b.farmer_id,
                f.full_name AS farmer_name, f.phone AS farmer_phone
           FROM marketplace.venue_booking b
           JOIN identity.farmer f ON f.farmer_id = b.farmer_id
          WHERE b.org_id = $1 ${filter}
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
 * POST /marketvenue/bookings/:id/accept — Requested -> Accepted. Same
 * ownership-gate + status-guard shape as POST /inputsupplier/orders/:id/
 * confirm: re-read WHERE org_id = $1 first, 409 with the current status if
 * it isn't Requested.
 */
router.post('/bookings/:id/accept', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.venue_booking WHERE org_id = $1 AND booking_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.venue_booking
            SET status = 'Accepted', decided_at = now(), updated_at = now()
          WHERE org_id = $1 AND booking_id = $2
          RETURNING booking_id, status, decided_at`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.venue_booking', id);
      return { booking: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'booking_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'booking_not_requested', current_status: result.wrongStatus });
    }
    return res.json(result.booking);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /marketvenue/bookings/:id/decline
 * Body: { reason? } — Requested -> Declined. Same ownership-gate + status
 * guard as accept above.
 */
router.post('/bookings/:id/decline', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.venue_booking WHERE org_id = $1 AND booking_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.venue_booking
            SET status = 'Declined', decided_reason = $3, decided_at = now(), updated_at = now()
          WHERE org_id = $1 AND booking_id = $2
          RETURNING booking_id, status, decided_reason, decided_at`,
        [subjectId, id, reason || null],
      );
      await logAccess(client, 'write', 'marketplace.venue_booking', id);
      return { booking: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'booking_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'booking_not_requested', current_status: result.wrongStatus });
    }
    return res.json(result.booking);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
