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
 * active products, and a breakdown by category), a photo count, and an
 * order summary (counts by status, plus `pending_orders_count` — orders at
 * `requested` — as the number the review queue below needs the supplier to
 * act on), so the frontend has enough for a summary without extra round
 * trips.
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
      const orders = await client.query(
        `SELECT status, COUNT(*)::int AS count FROM marketplace.product_order
          WHERE org_id = $1 GROUP BY status`,
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.product_listing', subjectId);

      const byCategory = { fertilizer_hormone: 0, chemical_pesticide: 0, equipment: 0, other: 0 };
      let totalActive = 0;
      products.rows.forEach((r) => {
        byCategory[r.category] = Number(r.active_count);
        totalActive += Number(r.active_count);
      });

      const ordersByStatus = { requested: 0, confirmed: 0, rejected: 0, fulfilled: 0, cancelled: 0 };
      orders.rows.forEach((r) => { ordersByStatus[r.status] = r.count; });

      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        total_active_products: totalActive,
        products_by_category: byCategory,
        photo_count: photos.rows[0].count,
        orders_by_status: ordersByStatus,
        pending_orders_count: ordersByStatus.requested,
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
 * DELETE /inputsupplier/products/:id — DEACTIVATE, not a real delete.
 *
 * This used to be a genuine hard delete (there was nothing else in the
 * schema referencing marketplace.product_listing yet). Now that
 * marketplace.product_order can reference a listing_id (see
 * grant_farmer_product_orders.sql — a farmer may have already ordered
 * against this exact product), a hard delete would either orphan that
 * order's FK or silently break its traceability back to the catalog entry.
 * Switched to the same deactivate-only pattern PUT /machinery/rate-card
 * already uses for exactly this reason: `is_active = false` removes it from
 * the farmer-facing browse list (GET /farmer/products only returns
 * is_active = true) without disturbing any order history that already
 * points at it. The endpoint's shape (DELETE, 204 on success) is
 * unchanged — only what happens underneath changed — so no frontend
 * caller needed to change either.
 */
router.delete('/products/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const deactivated = await withSessionContext('organization', subjectId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE marketplace.product_listing SET is_active = false, updated_at = now()
          WHERE org_id = $1 AND listing_id = $2`,
        [subjectId, id],
      );
      if (rowCount > 0) {
        await logAccess(client, 'write', 'marketplace.product_listing', id);
      }
      return rowCount > 0;
    });

    if (!deactivated) {
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

/**
 * GET /inputsupplier/orders?status=... — orders placed against THIS org's
 * products (never another supplier's — see the explicit WHERE below),
 * joined with the ordering farmer's name. `status` accepts any real status
 * value, or the shorthand `action_needed` (`requested` + `confirmed` — the
 * same two-value shorthand pattern as `GET /lender/loan-applications` and
 * `GET /buyer/deliveries`: `requested` still needs a confirm/reject
 * decision, `confirmed` still needs to be marked `fulfilled`).
 */
router.get('/orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status === 'action_needed') {
        filter = "AND o.status IN ('requested', 'confirmed')";
      } else if (status) {
        params.push(status);
        filter = 'AND o.status = $2';
      }
      const result = await client.query(
        `SELECT o.order_id, o.listing_id, o.product_name, o.category, o.unit_price,
                o.price_unit, o.quantity, o.total_price, o.status, o.decided_reason,
                o.requested_at, o.decided_at, o.fulfilled_at, o.farmer_id, f.full_name AS farmer_name
           FROM marketplace.product_order o
           JOIN identity.farmer f ON f.farmer_id = o.farmer_id
          WHERE o.org_id = $1 ${filter}
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
 * GET /inputsupplier/orders/:id — single order detail, same ownership
 * gating (WHERE org_id = $1 AND order_id = $2) as every other org-scoped
 * read in this file.
 */
router.get('/orders/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT o.order_id, o.listing_id, o.product_name, o.category, o.unit_price,
                o.price_unit, o.quantity, o.total_price, o.status, o.decided_reason,
                o.requested_at, o.decided_at, o.fulfilled_at, o.farmer_id, f.full_name AS farmer_name,
                f.phone AS farmer_phone
           FROM marketplace.product_order o
           JOIN identity.farmer f ON f.farmer_id = o.farmer_id
          WHERE o.org_id = $1 AND o.order_id = $2`,
        [subjectId, id],
      );
      return rows[0] || null;
    });

    if (!result) {
      return res.status(404).json({ error: 'order_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /inputsupplier/orders/:id/confirm — requested -> confirmed.
 * Re-reads the order through the explicit `WHERE org_id = $1` ownership
 * gate first (same "404 before ever touching another org's row" shape as
 * POST /buyer/deliveries/:id/confirm-quality), and 409s with the order's
 * actual current status if it isn't `requested` — a supplier can't
 * re-confirm an already-fulfilled or already-rejected order.
 */
router.post('/orders/:id/confirm', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE org_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.product_order
            SET status = 'confirmed', decided_at = now(), updated_at = now()
          WHERE org_id = $1 AND order_id = $2
          RETURNING order_id, status, decided_at`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.product_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'order_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'order_not_requested', current_status: result.wrongStatus });
    }
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /inputsupplier/orders/:id/reject
 * Body: { reason? } — requested -> rejected. Same ownership-gate + status
 * guard as confirm above.
 */
router.post('/orders/:id/reject', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE org_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.product_order
            SET status = 'rejected', decided_reason = $3, decided_at = now(), updated_at = now()
          WHERE org_id = $1 AND order_id = $2
          RETURNING order_id, status, decided_reason, decided_at`,
        [subjectId, id, reason || null],
      );
      await logAccess(client, 'write', 'marketplace.product_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'order_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'order_not_requested', current_status: result.wrongStatus });
    }
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /inputsupplier/orders/:id/fulfill — confirmed -> fulfilled. This is
 * the terminal "handed the goods over" step; there is no further status
 * after this one. Same ownership-gate + status guard shape as confirm/reject.
 */
router.post('/orders/:id/fulfill', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE org_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'confirmed') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.product_order
            SET status = 'fulfilled', fulfilled_at = now(), updated_at = now()
          WHERE org_id = $1 AND order_id = $2
          RETURNING order_id, status, fulfilled_at`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.product_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'order_not_found' });
    }
    if (result.wrongStatus) {
      return res.status(409).json({ error: 'order_not_confirmed', current_status: result.wrongStatus });
    }
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
