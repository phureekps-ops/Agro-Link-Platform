const express = require('express');

const { withSessionContext, withServiceRole, logAccess } = require('../db/pool');
const { requireAuth, requireOrganizationOrStaff, resolveEffectiveOrgSubject } = require('../middleware/auth');

const router = express.Router();

// The 5 fixed biomass product categories the user named, in the order
// they named them. Single source of truth for this route file — the DB's
// own CHECK constraint (biomass.producer_product, see grant_biomass_
// producer_portal.sql) is the real enforcement; this list is just what
// validates a request body before it ever reaches the database, and what
// GET /biomass/dashboard echoes back so the frontend doesn't have to
// hardcode a second copy of the category list + Thai labels.
const PRODUCT_TYPES = [
  { product_type: 'baled_straw', label_th: 'ฟางอัดก้อน' },
  { product_type: 'baled_sugarcane_top', label_th: 'ยอดอ้อยอัดก้อน' },
  { product_type: 'pelletized_straw', label_th: 'ฟางอัดเม็ด' },
  { product_type: 'biochar', label_th: 'Biochar' },
  { product_type: 'organic_fertilizer', label_th: 'ปุ๋ยอินทรีย์' },
];
const PRODUCT_TYPE_VALUES = PRODUCT_TYPES.map((p) => p.product_type);
const PRODUCT_TYPE_LABEL_TH = Object.fromEntries(PRODUCT_TYPES.map((p) => [p.product_type, p.label_th]));

/**
 * GET /biomass/directory — PUBLIC, no auth. Backs the new aggregate card
 * page (frontend/biomassproducer-directory.html). Deliberately registered
 * BEFORE router.use(requireAuth, ...) below so it is NOT gated by it —
 * Express only applies a router.use() middleware to routes registered
 * after it in the same router's stack, same technique content.js's
 * public GET /about relies on (withServiceRole(), no session context —
 * see that file's own doc comment for why that's the right primitive for
 * a route with no authenticated actor at all).
 *
 * Optional query filters: ?product_type=biochar (one of PRODUCT_TYPE_
 * VALUES) and/or ?region_code=TH-10 — both narrow, neither is required.
 */
router.get('/directory', async (req, res, next) => {
  const { product_type: productType, region_code: regionCode } = req.query;

  if (productType && !PRODUCT_TYPE_VALUES.includes(productType)) {
    return res.status(400).json({ error: 'invalid_product_type', valid: PRODUCT_TYPE_VALUES });
  }

  try {
    const rows = await withServiceRole(async (client) => {
      const conditions = [];
      const params = [];
      if (productType) {
        params.push(productType);
        conditions.push(`$${params.length} = ANY(product_types)`);
      }
      if (regionCode) {
        params.push(regionCode);
        conditions.push(`region_code = $${params.length}`);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await client.query(
        `SELECT org_id, org_name, region_code, district_code, description, capacity_note,
                cover_photo_data_url, contact_phone, product_types
           FROM biomass.v_producer_directory
           ${where}
          ORDER BY org_name ASC`,
        params,
      );
      return result.rows;
    });
    return res.json({
      producers: rows.map((r) => ({
        ...r,
        product_type_labels: (r.product_types || []).map((t) => PRODUCT_TYPE_LABEL_TH[t] || t),
      })),
      product_types: PRODUCT_TYPES,
    });
  } catch (err) {
    return next(err);
  }
});

// Every route below requires a valid organization JWT — OR a named
// cooperative staff login whose operational role covers this module (see
// resolveEffectiveOrgSubject's doc comment in middleware/auth.js). Same
// shape as every other single-role portal (lender.js/buyer.js) — staff
// roles mapped to `null` in STAFF_ROLE_TO_BUSINESS_ROLES (coop.admin/
// coop.manager) already cover this module with no change needed there.
router.use(requireAuth, requireOrganizationOrStaff);

/**
 * Confirms the authenticated organization holds a Verified
 * 'BiomassProducer' role, on top of entity-level KYB — same two-layer
 * check as requireLenderOrg (src/routes/lender.js), copied near-verbatim;
 * see that function's own doc comment for the full reasoning (entity KYB
 * vs. per-role Verified being two separate checks, staff resolution,
 * etc.) — not repeated here to avoid drift between two copies of the
 * same prose.
 */
async function requireBiomassProducerOrg(req, res, next) {
  try {
    const resolved = await resolveEffectiveOrgSubject(req, res, ['BiomassProducer']);
    if (!resolved) return;
    const { subjectId } = req.subject;
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status, region_code, district_code FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      if (org.rows.length === 0) return { orgMissing: true };
      const orgRow = org.rows[0];
      if (orgRow.kyb_status !== 'Verified') return { kybNotVerified: true, org: orgRow };

      const role = await client.query(
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'BiomassProducer'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'biomassproducer_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'BiomassProducer', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireBiomassProducerOrg);

/**
 * IMPORTANT: biomass.producer_profile / biomass.producer_product have NO
 * row-level security (see grant_biomass_producer_portal.sql's closing
 * comment) — every query below MUST include an explicit
 * `WHERE org_id = $1`. This is not defense-in-depth here, it is the
 * entire security boundary, same situation as GET /lender/dashboard and
 * every other single-org-scoped portal route in this project.
 */

/**
 * GET /biomass/dashboard — org info, the org's own profile fields, which
 * of the 5 product categories it has currently selected, and whether a
 * public card is currently visible (profile exists + is_active) — enough
 * for the frontend to render the whole dashboard in one round trip.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const profile = await client.query(
        `SELECT description, capacity_note, cover_photo_data_url, contact_phone, is_active, updated_at
           FROM biomass.producer_profile WHERE org_id = $1`,
        [subjectId],
      );
      const products = await client.query(
        'SELECT product_type FROM biomass.producer_product WHERE org_id = $1',
        [subjectId],
      );
      await logAccess(client, 'read', 'biomass.producer_profile', subjectId);

      const selected = new Set(products.rows.map((r) => r.product_type));
      return {
        org_name: req.org.org_name,
        region_code: req.org.region_code,
        district_code: req.org.district_code,
        profile: profile.rows[0] || null,
        card_visible: Boolean(profile.rows[0] && profile.rows[0].is_active),
        product_types: PRODUCT_TYPES.map((p) => ({ ...p, selected: selected.has(p.product_type) })),
      };
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /biomass/profile
 * Body: { description?, capacity_note?, contact_phone?, cover_photo_data_url?, is_active? }
 *
 * Upserts the org's one profile row — ON CONFLICT (org_id) DO UPDATE,
 * same upsert-by-org_id shape as marketplace.service_listing's ON
 * CONFLICT (org_id, service_key) elsewhere in this project, simplified
 * here since there's only one row per org, not one per key. is_active
 * defaults to true on first creation (the common case: fill in the
 * profile, expect to be listed) but can be explicitly set false to pull
 * the card from the public directory without deleting any data — same
 * is_active-as-soft-toggle convention as marketplace.product_listing.
 */
router.put('/profile', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    description, capacity_note: capacityNote, contact_phone: contactPhone,
    cover_photo_data_url: coverPhotoDataUrl, is_active: isActive,
  } = req.body || {};

  if (coverPhotoDataUrl && coverPhotoDataUrl.length > 3 * 1024 * 1024) {
    // Base64 data URLs run ~33% larger than the source file — this caps
    // the stored string around a ~2MB source image, same ceiling the
    // frontend file picker enforces client-side (see dashboard.js).
    return res.status(400).json({ error: 'cover_photo_too_large' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO biomass.producer_profile (org_id, description, capacity_note, contact_phone, cover_photo_data_url, is_active)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, true))
         ON CONFLICT (org_id) DO UPDATE SET
           description = EXCLUDED.description,
           capacity_note = EXCLUDED.capacity_note,
           contact_phone = EXCLUDED.contact_phone,
           cover_photo_data_url = EXCLUDED.cover_photo_data_url,
           is_active = EXCLUDED.is_active,
           updated_at = now()
         RETURNING description, capacity_note, contact_phone, cover_photo_data_url, is_active, updated_at`,
        [subjectId, description || null, capacityNote || null, contactPhone || null, coverPhotoDataUrl || null, isActive],
      );
      await logAccess(client, 'write', 'biomass.producer_profile', subjectId);
      return rows[0];
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /biomass/products
 * Body: { product_types: string[] }
 *
 * Replaces the FULL set of selected categories in one call (delete-then-
 * insert inside a transaction) — matches the frontend's checkbox-grid UI
 * (submit the whole current selection), rather than separate add/remove
 * endpoints. An empty array is valid (an org temporarily producing
 * nothing it wants listed) — it just clears all rows.
 */
router.put('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { product_types: productTypes } = req.body || {};

  if (!Array.isArray(productTypes)) {
    return res.status(400).json({ error: 'product_types_must_be_array' });
  }
  const invalid = productTypes.filter((t) => !PRODUCT_TYPE_VALUES.includes(t));
  if (invalid.length > 0) {
    return res.status(400).json({ error: 'invalid_product_type', invalid, valid: PRODUCT_TYPE_VALUES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM biomass.producer_product WHERE org_id = $1', [subjectId]);
        const unique = [...new Set(productTypes)];
        for (const productType of unique) {
          await client.query(
            'INSERT INTO biomass.producer_product (org_id, product_type) VALUES ($1, $2)',
            [subjectId, productType],
          );
        }
        await logAccess(client, 'write', 'biomass.producer_product', subjectId);
        await client.query('COMMIT');
        return unique;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    });
    return res.json({
      product_types: PRODUCT_TYPES.map((p) => ({ ...p, selected: result.includes(p.product_type) })),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
