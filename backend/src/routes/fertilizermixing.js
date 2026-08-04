const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT. requireOrganization
// runs after requireAuth so req.subject is guaranteed populated first.
router.use(requireAuth, requireOrganization);

/**
 * Fulfillment Marketplace เส้นทาง A (module 2.3) — one org_type,
 * FertilizerMixingService, unlike the machinery portal's five-types-in-one.
 * See grant_fertilizer_mixing_service.sql's header comment for the
 * scope decision (offline payment, dedicated table, not the older
 * marketplace.service_request mechanism).
 */
const FERTILIZER_MIXING_ORG_TYPES = ['FertilizerMixingService'];

/**
 * One fixed rate-card line item for v1 — a mixing provider offers
 * essentially one service (custom-blend a farmer's requested urea/DAP/MOP
 * mix), typically priced per kilogram of finished mix. Kept as a
 * single-entry map (rather than a hardcoded string) so a second item could
 * be added later the same way RATE_CARD_ITEMS grew in machinery.js,
 * without changing the upsert logic below.
 */
const RATE_CARD_ITEMS = {
  fertilizer_custom_mix: { service_type: 'fertilizer_mixing', label_th: 'บริการผสมปุ๋ยสั่งตัดตามสูตร', price_unit: 'บาท/กก.' },
};
const RATE_CARD_KEYS = Object.keys(RATE_CARD_ITEMS);

/**
 * Confirms the authenticated organization HOLDS a Verified
 * FertilizerMixingService role. Same two-layer pattern (entity kyb_status
 * Verified first, then a Verified role) as requireMachineryOrg in
 * src/routes/machinery.js — see that function's doc comment for the full
 * explanation of why both layers are needed (POST /auth/org-register
 * issues a real, working JWT immediately, before Platform Ops review).
 */
async function requireFertilizerMixingOrg(req, res, next) {
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

      const roles = await client.query(
        `SELECT role_type, status FROM identity.organization_role
          WHERE org_id = $1 AND role_type = ANY($2)`,
        [subjectId, FERTILIZER_MIXING_ORG_TYPES],
      );
      const verifiedRole = roles.rows.find((r) => r.status === 'Verified');
      const bestPendingStatus = roles.rows.some((r) => r.status === 'Pending')
        ? 'Pending'
        : (roles.rows.some((r) => r.status === 'Rejected') ? 'Rejected' : null);

      return { org: orgRow, roleStatus: verifiedRole ? 'Verified' : bestPendingStatus };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'fertilizermixing_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'fertilizermixing', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireFertilizerMixingOrg);

/**
 * IMPORTANT: marketplace.service_listing and marketplace.
 * fertilizer_mixing_order have NO row-level security at all
 * (relrowsecurity = false — same situation as every other marketplace.*
 * table in this project). There is no database-level backstop scoping
 * rows to this org. Every query below MUST include an explicit
 * `WHERE org_id = $1` — this is not defense-in-depth here, it is the
 * entire security boundary.
 */

/**
 * GET /fertilizermixing/dashboard — org info plus how many rate-card items
 * are priced and an order-status breakdown.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const listings = await client.query(
        `SELECT service_key, unit_price, price_unit, is_active
           FROM marketplace.service_listing
          WHERE org_id = $1 AND service_key IS NOT NULL`,
        [subjectId],
      );
      const ordersByStatus = await client.query(
        `SELECT status, COUNT(*)::int AS count
           FROM marketplace.fertilizer_mixing_order
          WHERE org_id = $1
          GROUP BY status`,
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.service_listing', subjectId);

      const pricedCount = listings.rows.filter((r) => r.is_active).length;
      const ordersByStatusMap = {};
      ordersByStatus.rows.forEach((r) => { ordersByStatusMap[r.status] = r.count; });

      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        priced_items_count: pricedCount,
        total_rate_card_items: RATE_CARD_KEYS.length,
        orders_by_status: ordersByStatusMap,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /fertilizermixing/rate-card — same shape as GET /machinery/rate-card,
 * just one item, plus (เส้นทาง B) that item's optional group-buying
 * discount policy: bulk_discount_min_kg / bulk_discount_percent, both null
 * when the provider hasn't opted into group discounts. See
 * grant_fertilizer_mixing_group_order.sql's header comment for the full
 * design — a farmer-organized group's combined kg crossing
 * bulk_discount_min_kg gets every order in that group priced at
 * unit_price * (1 - bulk_discount_percent/100) when the organizer submits
 * (POST /farmer/fertilizer-mixing-groups/:id/submit in src/routes/
 * fertilizer.js).
 */
router.get('/rate-card', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT service_key, unit_price, price_unit, is_active, bulk_discount_min_kg, bulk_discount_percent
           FROM marketplace.service_listing
          WHERE org_id = $1 AND service_key IS NOT NULL`,
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.service_listing', subjectId);
      return result.rows;
    });

    const byKey = {};
    rows.forEach((r) => { byKey[r.service_key] = r; });

    const items = RATE_CARD_KEYS.map((key) => {
      const def = RATE_CARD_ITEMS[key];
      const existing = byKey[key];
      const active = existing && existing.is_active;
      return {
        service_key: key,
        label_th: def.label_th,
        service_type: def.service_type,
        price_unit: def.price_unit,
        unit_price: active ? Number(existing.unit_price) : null,
        bulk_discount_min_kg: active && existing.bulk_discount_min_kg !== null ? Number(existing.bulk_discount_min_kg) : null,
        bulk_discount_percent: active && existing.bulk_discount_percent !== null ? Number(existing.bulk_discount_percent) : null,
      };
    });

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /fertilizermixing/rate-card
 * Body: { prices: { fertilizer_custom_mix?: number|null },
 *         bulk_discount?: { fertilizer_custom_mix?: { min_kg, percent } | null } }
 *
 * Same upsert-or-deactivate shape as PUT /machinery/rate-card — see that
 * route's doc comment for why clearing a price deactivates the row rather
 * than deleting it (marketplace.fertilizer_mixing_order's FK to listing_id
 * would break on delete if a farmer already ordered against it).
 *
 * bulk_discount (เส้นทาง B, additive on top of the existing prices shape —
 * a caller that omits it entirely leaves each item's existing discount
 * policy untouched) sets or clears that item's group-buying threshold:
 * { min_kg, percent } to set both together (both required, and only
 * meaningful together — a threshold with no percent, or a percent with no
 * threshold, cannot express a real discount policy), or null to clear
 * both. min_kg must be > 0; percent must be in (0, 50]. Only applied when
 * the item ALSO has an active price this same call (or already did) —
 * setting a discount policy on an item with no price makes no sense and
 * is rejected with 409 the same way an unpriced item is simply absent
 * from the marketplace already.
 */
router.put('/rate-card', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { prices, bulk_discount: bulkDiscount } = req.body || {};

  if (!prices || typeof prices !== 'object' || Array.isArray(prices)) {
    return res.status(400).json({ error: 'missing_prices_object' });
  }

  const unknownKeys = Object.keys(prices).filter((k) => !RATE_CARD_KEYS.includes(k));
  if (unknownKeys.length > 0) {
    return res.status(400).json({ error: 'unknown_service_key', unknown: unknownKeys, valid: RATE_CARD_KEYS });
  }

  for (const [key, value] of Object.entries(prices)) {
    if (value !== null && value !== undefined && value !== '' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      return res.status(400).json({ error: 'invalid_price', service_key: key });
    }
  }

  const discountEntries = bulkDiscount && typeof bulkDiscount === 'object' && !Array.isArray(bulkDiscount)
    ? Object.entries(bulkDiscount) : [];
  const unknownDiscountKeys = discountEntries.map(([k]) => k).filter((k) => !RATE_CARD_KEYS.includes(k));
  if (unknownDiscountKeys.length > 0) {
    return res.status(400).json({ error: 'unknown_service_key', unknown: unknownDiscountKeys, valid: RATE_CARD_KEYS });
  }
  for (const [key, policy] of discountEntries) {
    if (policy === null) continue;
    if (
      typeof policy !== 'object' || Array.isArray(policy)
      || typeof policy.min_kg !== 'number' || !Number.isFinite(policy.min_kg) || policy.min_kg <= 0
      || typeof policy.percent !== 'number' || !Number.isFinite(policy.percent) || policy.percent <= 0 || policy.percent > 50
    ) {
      return res.status(400).json({ error: 'invalid_bulk_discount', service_key: key });
    }
  }

  try {
    const items = await withSessionContext('organization', subjectId, async (client) => {
      for (const [key, rawValue] of Object.entries(prices)) {
        const def = RATE_CARD_ITEMS[key];
        const value = rawValue === '' || rawValue === undefined ? null : rawValue;

        if (value === null || Number(value) <= 0) {
          await client.query(
            `UPDATE marketplace.service_listing
                SET is_active = false
              WHERE org_id = $1 AND service_key = $2`,
            [subjectId, key],
          );
          continue;
        }

        // ON CONFLICT target repeats the partial unique index's own WHERE
        // clause (service_key IS NOT NULL) — see the identical comment in
        // PUT /machinery/rate-card for why this must match exactly.
        await client.query(
          `INSERT INTO marketplace.service_listing
             (org_id, service_type, description, unit_price, price_unit, service_key, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, true)
           ON CONFLICT (org_id, service_key) WHERE service_key IS NOT NULL DO UPDATE
             SET unit_price = EXCLUDED.unit_price,
                 service_type = EXCLUDED.service_type,
                 description = EXCLUDED.description,
                 price_unit = EXCLUDED.price_unit,
                 is_active = true`,
          [subjectId, def.service_type, def.label_th, value, def.price_unit, key],
        );
      }

      for (const [key, policy] of discountEntries) {
        await client.query(
          `UPDATE marketplace.service_listing
              SET bulk_discount_min_kg = $1, bulk_discount_percent = $2
            WHERE org_id = $3 AND service_key = $4`,
          [policy === null ? null : policy.min_kg, policy === null ? null : policy.percent, subjectId, key],
        );
      }

      await logAccess(client, 'write', 'marketplace.service_listing', subjectId);

      const result = await client.query(
        `SELECT service_key, unit_price, price_unit, is_active, bulk_discount_min_kg, bulk_discount_percent
           FROM marketplace.service_listing
          WHERE org_id = $1 AND service_key IS NOT NULL`,
        [subjectId],
      );
      return result.rows;
    });

    const byKey = {};
    items.forEach((r) => { byKey[r.service_key] = r; });
    const responseItems = RATE_CARD_KEYS.map((key) => {
      const def = RATE_CARD_ITEMS[key];
      const existing = byKey[key];
      const active = existing && existing.is_active;
      return {
        service_key: key,
        label_th: def.label_th,
        service_type: def.service_type,
        price_unit: def.price_unit,
        unit_price: active ? Number(existing.unit_price) : null,
        bulk_discount_min_kg: active && existing.bulk_discount_min_kg !== null ? Number(existing.bulk_discount_min_kg) : null,
        bulk_discount_percent: active && existing.bulk_discount_percent !== null ? Number(existing.bulk_discount_percent) : null,
      };
    });

    return res.json({ items: responseItems });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /fertilizermixing/orders?status=... — order requests against THIS
 * org's listing (never another provider's), joined with the requesting
 * farmer's name/phone. `status=action_needed` is shorthand for `Requested`.
 * Same shape as GET /machinery/bookings.
 */
router.get('/orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status === 'action_needed') {
        filter = "AND o.status = 'Requested'";
      } else if (status) {
        params.push(status);
        filter = 'AND o.status = $2';
      }
      const result = await client.query(
        `SELECT o.order_id, o.listing_id, o.service_key, o.label_th, o.service_type,
                o.unit_price, o.price_unit, o.requested_urea_kg, o.requested_dap_kg, o.requested_mop_kg,
                o.delivery_option, o.delivery_address, o.preferred_date, o.farmer_note,
                o.status, o.decided_reason, o.requested_at, o.decided_at, o.completed_at, o.farmer_id,
                o.group_id, f.full_name AS farmer_name, f.phone AS farmer_phone
           FROM marketplace.fertilizer_mixing_order o
           JOIN identity.farmer f ON f.farmer_id = o.farmer_id
          WHERE o.org_id = $1 ${filter}
          ORDER BY o.requested_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'marketplace.fertilizer_mixing_order', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /fertilizermixing/orders/:id/accept — Requested -> Accepted.
 */
router.post('/orders/:id/accept', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.fertilizer_mixing_order WHERE org_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.fertilizer_mixing_order
            SET status = 'Accepted', decided_at = now(), updated_at = now()
          WHERE org_id = $1 AND order_id = $2
          RETURNING order_id, status, decided_at`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'order_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'order_not_requested', current_status: result.wrongStatus });
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /fertilizermixing/orders/:id/decline
 * Body: { reason? } — Requested -> Declined.
 */
router.post('/orders/:id/decline', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.fertilizer_mixing_order WHERE org_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.fertilizer_mixing_order
            SET status = 'Declined', decided_reason = $3, decided_at = now(), updated_at = now()
          WHERE org_id = $1 AND order_id = $2
          RETURNING order_id, status, decided_reason, decided_at`,
        [subjectId, id, reason || null],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'order_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'order_not_requested', current_status: result.wrongStatus });
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /fertilizermixing/orders/:id/complete — Accepted -> Completed.
 * Marks the mix ready (for pickup or delivery, per delivery_option) —
 * still a record/status only, no fund transfer (see
 * grant_fertilizer_mixing_service.sql's header comment on why payment
 * stays offline for this feature).
 */
router.post('/orders/:id/complete', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.fertilizer_mixing_order WHERE org_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Accepted') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.fertilizer_mixing_order
            SET status = 'Completed', completed_at = now(), updated_at = now()
          WHERE org_id = $1 AND order_id = $2
          RETURNING order_id, status, completed_at`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'order_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'order_not_accepted', current_status: result.wrongStatus });
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
