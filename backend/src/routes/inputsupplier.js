const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT.
router.use(requireAuth, requireOrganization);

// Product photos are capped the same way machinery photos are (see
// src/routes/machinery.js) — no object storage/CDN in this sandbox,
// photos are stored as base64 data: URLs directly in Postgres, with a
// server-side size ceiling to keep rows sane. express.json()'s 5mb body
// limit (src/server.js) already accommodates this.
const MAX_PHOTO_DATA_URL_LENGTH = 4 * 1024 * 1024;

const PRODUCT_CATEGORIES = ['fertilizer_hormone', 'chemical_pesticide', 'equipment', 'other'];

/**
 * Confirms the authenticated organization actually HOLDS a Verified
 * 'InputSupplier' role. Same two-layer pattern as requireLenderOrg /
 * requireBuyerOrg (see lender.js's doc comment for the full explanation) —
 * entity kyb_status first, then the specific role's own status.
 */
async function requireInputSupplierOrg(req, res, next) {
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
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'InputSupplier'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'input_supplier_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'InputSupplier', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireInputSupplierOrg);

/**
 * IMPORTANT: marketplace.product_listing and marketplace.product_photo
 * have NO row-level security at all (same situation as
 * marketplace.service_listing/vendor_photo — see the note at the top of
 * src/routes/machinery.js). Every query below MUST include an explicit
 * `WHERE org_id = $1` — this is the entire security boundary, not
 * defense-in-depth.
 */

/**
 * GET /inputsupplier/dashboard — org info plus catalog counts (total
 * active products, and a breakdown by category) and a photo count, so the
 * frontend has enough for a summary without a second round trip.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const products = await client.query(
        `SELECT category, COUNT(*) FILTER (WHERE is_active) AS active_count
           FROM marketplace.product_listing
          WHERE org_id = $1
          GROUP BY category`,
        [subjectId],
      );
      const photos = await client.query(
        'SELECT COUNT(*)::int AS count FROM marketplace.product_photo WHERE org_id = $1',
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.product_listing', subjectId);

      const byCategory = { fertilizer_hormone: 0, chemical_pesticide: 0, equipment: 0, other: 0 };
      let totalActive = 0;
      products.rows.forEach((r) => {
        byCategory[r.category] = Number(r.active_count);
        totalActive += Number(r.active_count);
      });

      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        total_active_products: totalActive,
        products_by_category: byCategory,
        photo_count: photos.rows[0].count,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /inputsupplier/products?category=... — this org's own catalog
 * (every product regardless of is_active — the management view needs to
 * see and re-activate deactivated items too, not just what's currently
 * live), optionally filtered by category.
 */
router.get('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { category } = req.query;

  if (category && !PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: PRODUCT_CATEGORIES });
  }

  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (category) {
        params.push(category);
        filter = 'AND category = $2';
      }
      const result = await client.query(
        `SELECT listing_id, category, product_name, brand, description, unit_price, price_unit, is_active, created_at, updated_at
           FROM marketplace.product_listing
          WHERE org_id = $1 ${filter}
          ORDER BY category, product_name`,
        params,
      );
      await logAccess(client, 'read', 'marketplace.product_listing', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /inputsupplier/products
 * Body: { category, product_name, brand?, description?, unit_price, price_unit? }
 *
 * Unlike the Machinery Portal's fixed 7-key rate card, this catalog is an
 * open-ended list — a supplier creates as many product rows as they
 * actually sell, each with its own row (not an upsert-by-fixed-key like
 * PUT /machinery/rate-card).
 */
router.post('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    category, product_name: productName, brand, description,
    unit_price: unitPrice, price_unit: priceUnit,
  } = req.body || {};

  if (!category || !PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: PRODUCT_CATEGORIES });
  }
  if (!productName || !productName.trim()) {
    return res.status(400).json({ error: 'product_name_required' });
  }
  const price = Number(unitPrice);
  if (!Number.isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'invalid_unit_price' });
  }

  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO marketplace.product_listing (org_id, category, product_name, brand, description, unit_price, price_unit)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'บาท/หน่วย'))
         RETURNING listing_id, category, product_name, brand, description, unit_price, price_unit, is_active, created_at, updated_at`,
        [subjectId, category, productName.trim(), brand || null, description || null, price, priceUnit || null],
      );
      await logAccess(client, 'write', 'marketplace.product_listing', rows[0].listing_id);
      return rows[0];
    });

    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /inputsupplier/products/:id
 * Body: any of { category, product_name, brand, description, unit_price, price_unit, is_active }
 *
 * The explicit `WHERE org_id = $1 AND listing_id = $2` is what makes an
 * out-of-scope id 404 instead of silently editing another supplier's
 * product — same ownership-gating shape as every other org-scoped write
 * in this project (e.g. POST /buyer/deliveries/:id/confirm-quality).
 */
router.put('/products/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const {
    category, product_name: productName, brand, description,
    unit_price: unitPrice, price_unit: priceUnit, is_active: isActive,
  } = req.body || {};

  if (category !== undefined && !PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: PRODUCT_CATEGORIES });
  }
  if (productName !== undefined && !productName.trim()) {
    return res.status(400).json({ error: 'product_name_required' });
  }
  if (unitPrice !== undefined && (!Number.isFinite(Number(unitPrice)) || Number(unitPrice) <= 0)) {
    return res.status(400).json({ error: 'invalid_unit_price' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT listing_id FROM marketplace.product_listing WHERE org_id = $1 AND listing_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { notFound: true };

      const { rows } = await client.query(
        `UPDATE marketplace.product_listing SET
           category     = COALESCE($3, category),
           product_name = COALESCE($4, product_name),
           brand        = CASE WHEN $5::boolean THEN $6 ELSE brand END,
           description  = CASE WHEN $7::boolean THEN $8 ELSE description END,
           unit_price   = COALESCE($9, unit_price),
           price_unit   = COALESCE($10, price_unit),
           is_active    = COALESCE($11, is_active),
           updated_at   = now()
         WHERE org_id = $1 AND listing_id = $2
         RETURNING listing_id, category, product_name, brand, description, unit_price, price_unit, is_active, created_at, updated_at`,
        [
          subjectId, id,
          category || null, productName ? productName.trim() : null,
          brand !== undefined, brand || null,
          description !== undefined, description || null,
          unitPrice !== undefined ? Number(unitPrice) : null,
          priceUnit || null,
          isActive !== undefined ? Boolean(isActive) : null,
        ],
      );
      await logAccess(client, 'write', 'marketplace.product_listing', id);
      return { product: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'product_not_found' });
    }
    return res.json(result.product);
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /inputsupplier/products/:id — a real delete, not a deactivate.
 * Unlike marketplace.service_listing (deactivate-only in PUT /machinery/
 * rate-card, since a farmer might already have booked against a fixed
 * rate-card key via marketplace.service_request's FK), nothing else in
 * the schema references marketplace.product_listing — there is no booking/
 * order flow against it yet (see "what's mocked" in the README) — so a
 * hard delete is safe and matches what a supplier managing their own
 * catalog would expect ("remove this listing" should actually remove it).
 * ON DELETE CASCADE on product_photo takes the product's photos with it.
 */
router.delete('/products/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const deleted = await withSessionContext('organization', subjectId, async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM marketplace.product_listing WHERE org_id = $1 AND listing_id = $2',
        [subjectId, id],
      );
      if (rowCount > 0) {
        await logAccess(client, 'write', 'marketplace.product_listing', id);
      }
      return rowCount > 0;
    });

    if (!deleted) {
      return res.status(404).json({ error: 'product_not_found' });
    }
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /inputsupplier/products/:id/photos — photos for one product.
 * Ownership is checked the same way as PUT/DELETE above before returning
 * anything (a wrong-org listing_id 404s rather than leaking whether it
 * exists).
 */
router.get('/products/:id/photos', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT listing_id FROM marketplace.product_listing WHERE org_id = $1 AND listing_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { notFound: true };

      const photos = await client.query(
        `SELECT photo_id, photo_data_url, caption, created_at
           FROM marketplace.product_photo
          WHERE org_id = $1 AND listing_id = $2
          ORDER BY created_at DESC`,
        [subjectId, id],
      );
      return { photos: photos.rows };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'product_not_found' });
    }
    return res.json(result.photos);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /inputsupplier/products/:id/photos
 * Body: { photo_data_url, caption? }
 * Same client-side FileReader.readAsDataURL() → data: URL pattern as the
 * Machinery Portal's photo upload — see machinery.js / MAX_PHOTO_DATA_URL_LENGTH.
 */
router.post('/products/:id/photos', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { photo_data_url: photoDataUrl, caption } = req.body || {};

  if (!photoDataUrl || typeof photoDataUrl !== 'string' || !photoDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'invalid_photo_data_url' });
  }
  if (photoDataUrl.length > MAX_PHOTO_DATA_URL_LENGTH) {
    return res.status(400).json({ error: 'photo_too_large' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT listing_id FROM marketplace.product_listing WHERE org_id = $1 AND listing_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { notFound: true };

      const { rows } = await client.query(
        `INSERT INTO marketplace.product_photo (listing_id, org_id, photo_data_url, caption)
         VALUES ($1, $2, $3, $4)
         RETURNING photo_id, photo_data_url, caption, created_at`,
        [id, subjectId, photoDataUrl, caption || null],
      );
      await logAccess(client, 'write', 'marketplace.product_photo', rows[0].photo_id);
      return { photo: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'product_not_found' });
    }
    return res.status(201).json(result.photo);
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /inputsupplier/products/:id/photos/:photoId
 */
router.delete('/products/:id/photos/:photoId', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id, photoId } = req.params;
  try {
    const deleted = await withSessionContext('organization', subjectId, async (client) => {
      const { rowCount } = await client.query(
        'DELETE FROM marketplace.product_photo WHERE org_id = $1 AND listing_id = $2 AND photo_id = $3',
        [subjectId, id, photoId],
      );
      if (rowCount > 0) {
        await logAccess(client, 'write', 'marketplace.product_photo', photoId);
      }
      return rowCount > 0;
    });

    if (!deleted) {
      return res.status(404).json({ error: 'photo_not_found' });
    }
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
