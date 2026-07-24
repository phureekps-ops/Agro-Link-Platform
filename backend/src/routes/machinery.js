const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT. requireOrganization
// runs after requireAuth so req.subject is guaranteed populated first.
router.use(requireAuth, requireOrganization);

/**
 * The five org_types folded into this one unified portal — see the
 * conversation that led here: rather than a separate portal per machine
 * type (TractorService, DroneService, HarvesterService, TruckService) or
 * for drying-yard providers (DryingYardService), all five share one
 * "ผู้ให้บริการเครื่องจักรกล/ลานตากข้าว" portal and one shared rate card,
 * since a single provider commonly offers more than one of these services
 * (e.g. a tractor operator who also runs a truck).
 */
const MACHINERY_ORG_TYPES = ['TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService'];

/**
 * The seven fixed rate-card line items this portal exposes. Each maps to
 * exactly one marketplace.service_listing row per org (upserted via
 * service_key), tagged with the service_type value marketplace.service_listing
 * already constrains to (land_preparation / harvesting / pest_control /
 * transport / drying_storage — all pre-existing values, no widening needed
 * there). label_th is the Thai description stored on the row and shown in
 * responses; price_unit is stored verbatim as marketplace.service_listing.price_unit.
 */
const RATE_CARD_ITEMS = {
  plow_rough: { service_type: 'land_preparation', label_th: 'ไถดะ', price_unit: 'บาท/ไร่' },
  plow_secondary_seed: { service_type: 'land_preparation', label_th: 'ไถแปรและหว่าน', price_unit: 'บาท/ไร่' },
  rotary_till: { service_type: 'land_preparation', label_th: 'ปั่นดิน', price_unit: 'บาท/ไร่' },
  spraying: { service_type: 'pest_control', label_th: 'ฉีดพ่นสารเคมี (โดรน/รถฉีดพ่น)', price_unit: 'บาท/ไร่' },
  harvesting: { service_type: 'harvesting', label_th: 'เกี่ยวข้าว', price_unit: 'บาท/ไร่' },
  trucking: { service_type: 'transport', label_th: 'ขนส่งด้วยรถบรรทุก', price_unit: 'บาท/ตัน-กม.' },
  drying: { service_type: 'drying_storage', label_th: 'ลานตากข้าว/ตากผลผลิต', price_unit: 'บาท/ตัน' },
};
const RATE_CARD_KEYS = Object.keys(RATE_CARD_ITEMS);

/**
 * Confirms the authenticated organization HOLDS at least one Verified role
 * from the five machinery/drying-yard types. Same two-layer pattern as
 * requireLenderOrg/requireBuyerOrg in lender.js/buyer.js — see that doc
 * comment for the full explanation — with one difference: since this
 * portal already unifies five role types into one, access requires ANY ONE
 * of them to be Verified (not a specific single role_type check like the
 * Lender/Buyer gates), so an org that's Verified for e.g. TractorService
 * but still Pending on a separately-requested DroneService role gets in
 * (the rate card itself has no per-role field gating — see PUT
 * /machinery/rate-card's own doc comment).
 *
 * Also still gates on the entity-level kyb_status === 'Verified' first,
 * for the same reason as Lender/Buyer: POST /auth/org-register issues a
 * real, working JWT the moment someone registers, before Platform Ops ever
 * reviews the application.
 */
async function requireMachineryOrg(req, res, next) {
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
        [subjectId, MACHINERY_ORG_TYPES],
      );
      const verifiedRole = roles.rows.find((r) => r.status === 'Verified');
      // Best-effort status to report when nothing is Verified yet: prefer
      // Pending over Rejected over "never requested at all" (null), so the
      // pending notice reads as encouragingly as the real state allows.
      const bestPendingStatus = roles.rows.some((r) => r.status === 'Pending')
        ? 'Pending'
        : (roles.rows.some((r) => r.status === 'Rejected') ? 'Rejected' : null);

      // Every VERIFIED machinery role this org actually holds — deliberately
      // NOT identity.organization.org_type (the entity's PRIMARY role from
      // registration). For a genuinely multi-role org those can differ: e.g.
      // an org registered as Buyer that later got a TractorService role
      // Verified here has org_type = 'Buyer', which would be actively
      // misleading if shown as "this org's service type" inside the
      // machinery portal. Found via manual multi-role testing (see
      // README) — GET /dashboard below uses this instead of org_type.
      const verifiedRoleTypes = roles.rows.filter((r) => r.status === 'Verified').map((r) => r.role_type);

      return { org: orgRow, roleStatus: verifiedRole ? 'Verified' : bestPendingStatus, verifiedRoleTypes };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'machinery_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'machinery', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    req.org.verified_role_types = result.verifiedRoleTypes;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireMachineryOrg);

/**
 * IMPORTANT: marketplace.service_listing and marketplace.vendor_photo have
 * NO row-level security at all (relrowsecurity = false — verified, see the
 * comment block at the end of grant_machinery_marketplace.sql). There is no
 * database-level backstop scoping rows to this org. Every query below MUST
 * include an explicit `WHERE org_id = $1` — this is not defense-in-depth
 * here, it is the entire security boundary, same situation as
 * GET /buyer/deliveries and GET /farmer/notifications elsewhere in this
 * project.
 */

/**
 * GET /machinery/dashboard — org info plus how many of the seven rate-card
 * items are currently priced, and a photo count, so the frontend has enough
 * to render a summary without a second round trip.
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
      const photos = await client.query(
        'SELECT COUNT(*)::int AS count FROM marketplace.vendor_photo WHERE org_id = $1',
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.service_listing', subjectId);

      const pricedCount = listings.rows.filter((r) => r.is_active).length;
      return {
        org_name: req.org.org_name,
        // Verified machinery role(s) actually held (e.g. ["TractorService",
        // "TruckService"]) — NOT the entity's primary org_type, which can be
        // a different, non-machinery type for a multi-role org (e.g. a
        // Buyer that also added a Verified TractorService role). See the
        // doc comment on requireMachineryOrg above.
        service_types: req.org.verified_role_types,
        kyb_status: req.org.kyb_status,
        priced_items_count: pricedCount,
        total_rate_card_items: RATE_CARD_KEYS.length,
        photo_count: photos.rows[0].count,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /machinery/rate-card — this org's current prices for all seven fixed
 * line items, keyed by service_key, so the frontend can pre-fill the form
 * in one call. Items never priced come back with price: null.
 */
router.get('/rate-card', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT service_key, unit_price, price_unit, is_active
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
      return {
        service_key: key,
        label_th: def.label_th,
        service_type: def.service_type,
        price_unit: def.price_unit,
        unit_price: existing && existing.is_active ? Number(existing.unit_price) : null,
      };
    });

    return res.json({ items });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /machinery/rate-card
 * Body: { prices: { plow_rough?: number|null, plow_secondary_seed?: number|null, ... } }
 *
 * Upserts a marketplace.service_listing row per key present in `prices`
 * with a positive numeric value (ON CONFLICT (org_id, service_key), the
 * partial unique index added in grant_machinery_marketplace.sql). A key set
 * to null/0/omitted-then-explicitly-cleared is handled by setting
 * is_active = false rather than deleting the row outright — deleting could
 * violate marketplace.service_request's FK to listing_id if a farmer has
 * already booked against it (no ON DELETE clause = NO ACTION), and
 * is_active = false already has the right meaning ("not currently offered")
 * without that risk. GET /machinery/rate-card and the dashboard both filter
 * on is_active accordingly.
 *
 * A provider is never required to price all seven items — most will only
 * fill in the ones matching their actual equipment (e.g. a DroneService org
 * likely only sets `spraying`).
 */
router.put('/rate-card', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { prices } = req.body || {};

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

  try {
    const items = await withSessionContext('organization', subjectId, async (client) => {
      for (const [key, rawValue] of Object.entries(prices)) {
        const def = RATE_CARD_ITEMS[key];
        const value = rawValue === '' || rawValue === undefined ? null : rawValue;

        if (value === null || Number(value) <= 0) {
          // Clearing a price: deactivate the row if it exists, create nothing new.
          await client.query(
            `UPDATE marketplace.service_listing
                SET is_active = false
              WHERE org_id = $1 AND service_key = $2`,
            [subjectId, key],
          );
          continue;
        }

        // The ON CONFLICT target must repeat the partial index's own WHERE
        // clause (service_key IS NOT NULL) — Postgres only infers a partial
        // unique index as the arbiter when the predicate matches exactly;
        // omitting it here fails with "no unique or exclusion constraint
        // matching the ON CONFLICT specification" even though the index
        // exists (confirmed the hard way while building this route).
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

      await logAccess(client, 'write', 'marketplace.service_listing', subjectId);

      const result = await client.query(
        `SELECT service_key, unit_price, price_unit, is_active
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
      return {
        service_key: key,
        label_th: def.label_th,
        service_type: def.service_type,
        price_unit: def.price_unit,
        unit_price: existing && existing.is_active ? Number(existing.unit_price) : null,
      };
    });

    return res.json({ items: responseItems });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /machinery/photos — this org's photo gallery (service + machinery
 * photos), newest first.
 */
router.get('/photos', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT photo_id, photo_type, photo_data_url, caption, created_at
           FROM marketplace.vendor_photo
          WHERE org_id = $1
          ORDER BY created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.vendor_photo', subjectId);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const MAX_PHOTO_DATA_URL_LENGTH = 3 * 1024 * 1024; // ~3MB of base64 text — generous for a demo, not a real upload limit.

/**
 * POST /machinery/photos
 * Body: { photo_type: 'service'|'machinery', photo_data_url: string, caption?: string }
 *
 * photo_data_url is expected to be a data: URL (the frontend reads the
 * chosen file client-side via FileReader.readAsDataURL and posts the result
 * directly) — there is no object storage / CDN in this sandbox, see the
 * comment on marketplace.vendor_photo in grant_machinery_marketplace.sql.
 */
router.post('/photos', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { photo_type: photoType, photo_data_url: photoDataUrl, caption } = req.body || {};

  if (photoType !== 'service' && photoType !== 'machinery') {
    return res.status(400).json({ error: 'invalid_photo_type', valid: ['service', 'machinery'] });
  }
  if (!photoDataUrl || typeof photoDataUrl !== 'string' || !photoDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'invalid_photo_data_url' });
  }
  if (photoDataUrl.length > MAX_PHOTO_DATA_URL_LENGTH) {
    return res.status(413).json({ error: 'photo_too_large' });
  }

  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO marketplace.vendor_photo (org_id, photo_type, photo_data_url, caption)
         VALUES ($1, $2, $3, $4)
         RETURNING photo_id, photo_type, photo_data_url, caption, created_at`,
        [subjectId, photoType, photoDataUrl, caption || null],
      );
      await logAccess(client, 'write', 'marketplace.vendor_photo', subjectId);
      return rows[0];
    });
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /machinery/photos/:id — ownership-gated the same way the loan-
 * application approve/decline routes in lender.js are: the DELETE's own
 * WHERE clause requires org_id = subjectId, so it silently deletes 0 rows
 * (reported as 404) for a photo_id that doesn't exist OR belongs to a
 * different org, rather than ever touching another provider's row.
 */
router.delete('/photos/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const deleted = await withSessionContext('organization', subjectId, async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM marketplace.vendor_photo WHERE org_id = $1 AND photo_id = $2',
        [subjectId, id],
      );
      if (rowCount > 0) {
        await logAccess(client, 'write', 'marketplace.vendor_photo', id);
      }
      return rowCount > 0;
    });

    if (!deleted) {
      return res.status(404).json({ error: 'photo_not_found' });
    }
    return res.status(204).send();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
