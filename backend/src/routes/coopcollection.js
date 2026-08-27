const express = require('express');
const crypto = require('crypto');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT. requireOrganization
// runs after requireAuth so req.subject is guaranteed populated first.
router.use(requireAuth, requireOrganization);

/**
 * M09 Collection & Quality — the cooperative's produce collection-station
 * portal (จุดรับซื้อผลผลิตของสหกรณ์). Deliberately reuses the SAME
 * produce.delivery table and produce.record_delivery() / produce.
 * confirm_quality() / produce.settle_delivery() functions the Buyer
 * Portal (src/routes/buyer.js) uses — a cooperative buying from its
 * members is, at the ledger/contract level, doing exactly what a private
 * Buyer does; see grant_cooperative_collection_station.sql for the two
 * things that genuinely are new (ความชื้น/moisture capture, and the
 * produce.lot batching concept).
 *
 * Confirms the authenticated organization actually HOLDS a Verified
 * 'Cooperative' role — same two-layer pattern (entity kyb_status, then
 * role-level identity.organization_role status) as requireBuyerOrg in
 * buyer.js / requireLenderOrg in lender.js. A cooperative provisioned via
 * POST /admin/cooperatives always has both already 'Verified' at creation,
 * so this only actually blocks something in edge cases (e.g. if Platform
 * Ops later revokes the role).
 */
async function requireCooperativeOrg(req, res, next) {
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
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Cooperative'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'cooperative_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'Cooperative', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireCooperativeOrg);

/**
 * IMPORTANT: produce.delivery and produce.lot have NO row-level security
 * (relrowsecurity = false — same situation buyer.js documents for
 * produce.delivery; produce.lot was created alongside it in the same
 * migration with the identical convention on purpose). Every query below
 * that touches either table MUST include an explicit
 * `WHERE buyer_org_id = $1` — this is not defense-in-depth, it is the
 * entire security boundary.
 */

/**
 * GET /coop/dashboard — same shape as GET /buyer/dashboard, plus an
 * open-lot count.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const counts = await client.query(
        `SELECT status, COUNT(*)::int AS count
           FROM produce.delivery
          WHERE buyer_org_id = $1
          GROUP BY status`,
        [subjectId],
      );
      const settledTotal = await client.query(
        `SELECT COALESCE(SUM(total_amount), 0)::numeric AS total
           FROM produce.delivery
          WHERE buyer_org_id = $1 AND status = 'settled'`,
        [subjectId],
      );
      const openLots = await client.query(
        `SELECT COUNT(*)::int AS count FROM produce.lot WHERE buyer_org_id = $1 AND status = 'Open'`,
        [subjectId],
      );
      await logAccess(client, 'read', 'produce.delivery', subjectId);

      const statusCounts = { delivered: 0, accepted: 0, rejected: 0, settled: 0 };
      counts.rows.forEach((r) => { statusCounts[r.status] = r.count; });

      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        deliveries_by_status: statusCounts,
        needs_action_count: statusCounts.delivered + statusCounts.accepted,
        total_settled_amount: settledTotal.rows[0].total,
        open_lots: openLots.rows[0].count,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

const VALID_STATUSES = ['delivered', 'accepted', 'rejected', 'settled'];
const ACTION_NEEDED_STATUSES = ['delivered', 'accepted'];

/**
 * GET /coop/deliveries?status=delivered|accepted|rejected|settled|action_needed
 */
router.get('/deliveries', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;

  if (status && status !== 'action_needed' && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: [...VALID_STATUSES, 'action_needed'] });
  }

  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let statusFilter = '';
      if (status === 'action_needed') {
        params.push(ACTION_NEEDED_STATUSES);
        statusFilter = 'AND d.status = ANY($2)';
      } else if (status) {
        params.push(status);
        statusFilter = 'AND d.status = $2';
      }
      const result = await client.query(
        `SELECT d.delivery_id, d.unit_id, pu.commodity_code AS unit_commodity_code, pu.area_rai,
                f.farmer_id, f.full_name AS farmer_name,
                d.commodity_code, d.quantity_ton, d.unit_price, d.total_amount,
                d.quality_grade, d.moisture_pct, d.status, d.contract_id, d.lot_id,
                d.inspected_by, d.inspected_at, d.delivered_at, d.settled_at
           FROM produce.delivery d
           LEFT JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
           LEFT JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
          WHERE d.buyer_org_id = $1 ${statusFilter}
          ORDER BY d.delivered_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'produce.delivery', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/deliveries/:id
 */
router.get('/deliveries/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT d.delivery_id, d.unit_id, pu.commodity_code AS unit_commodity_code, pu.area_rai,
                f.farmer_id, f.full_name AS farmer_name, f.phone AS farmer_phone,
                d.commodity_code, d.quantity_ton, d.unit_price, d.total_amount,
                d.quality_grade, d.moisture_pct, d.status, d.contract_id, d.lot_id,
                d.inspected_by, d.inspected_at, d.delivered_at, d.settled_at, d.settlement_entry_id
           FROM produce.delivery d
           LEFT JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
           LEFT JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
          WHERE d.buyer_org_id = $1 AND d.delivery_id = $2`,
        [subjectId, id],
      );
      if (result.rows.length > 0) {
        await logAccess(client, 'read', 'produce.delivery', id);
      }
      return result.rows[0] || null;
    });

    if (!row) {
      return res.status(404).json({ error: 'delivery_not_found' });
    }
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/deliveries — record a new delivery brought in by a member.
 * Body: { unit_id, commodity_code, quantity_ton, contract_id?, cycle_id?, unit_price? }
 *
 * buyer_org_id is NEVER taken from the request body — always req.subject.
 * Identical validation to POST /buyer/deliveries — see that route's
 * comment for the contract-vs-spot-sale rule (produce.record_delivery()
 * itself enforces it either way).
 */
router.post('/deliveries', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    unit_id: unitId,
    commodity_code: commodityCode,
    quantity_ton: quantityTon,
    contract_id: contractId,
    cycle_id: cycleId,
    unit_price: unitPrice,
  } = req.body || {};

  if (!unitId || !commodityCode || !quantityTon) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['unit_id', 'commodity_code', 'quantity_ton'],
    });
  }
  if (!contractId && !unitPrice) {
    return res.status(400).json({ error: 'unit_price_required_for_spot_sale' });
  }

  try {
    const deliveryId = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT produce.record_delivery($1, $2, $3, $4, $5, $6, $7) AS delivery_id`,
        [unitId, subjectId, commodityCode, quantityTon, contractId || null, cycleId || null, unitPrice || null],
      );
      const newDeliveryId = rows[0].delivery_id;
      await logAccess(client, 'write', 'produce.delivery', newDeliveryId);
      return newDeliveryId;
    });

    return res.status(201).json({ delivery_id: deliveryId, status: 'delivered' });
  } catch (err) {
    if (err.message && (err.message.includes('ไม่พบสัญญา') || err.message.includes('ต้อง active') || err.message.includes('ไม่มีราคาที่ตกลงกัน') || err.message.includes('ไม่ใช่ผู้ซื้อ') || err.message.includes('ต้องระบุ p_unit_price'))) {
      return res.status(409).json({ error: 'cannot_record_delivery', detail: err.message });
    }
    return next(err);
  }
});

/**
 * POST /coop/deliveries/:id/confirm-quality
 * Body: { quality_grade, accepted, inspected_by, moisture_pct? }
 *
 * Same ownership-gating pattern as POST /buyer/deliveries/:id/confirm-
 * quality (the SELECT below, scoped by buyer_org_id, IS the security
 * check — produce.confirm_quality() itself still does not check
 * ownership). moisture_pct is optional and, when given, must be 0-100
 * (also enforced by the delivery_moisture_pct_check constraint at the
 * database level as a backstop).
 */
router.post('/deliveries/:id/confirm-quality', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const {
    quality_grade: qualityGrade, accepted, inspected_by: inspectedBy, moisture_pct: moisturePct,
  } = req.body || {};

  if (!qualityGrade || typeof accepted !== 'boolean' || !inspectedBy) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['quality_grade', 'accepted (boolean)', 'inspected_by'],
    });
  }
  if (moisturePct !== undefined && moisturePct !== null) {
    const m = Number(moisturePct);
    if (!Number.isFinite(m) || m < 0 || m > 100) {
      return res.status(400).json({ error: 'invalid_moisture_pct' });
    }
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT status FROM produce.delivery WHERE buyer_org_id = $1 AND delivery_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) {
        return { notFound: true };
      }
      try {
        await client.query(
          'SELECT produce.confirm_quality($1, $2, $3, $4, $5)',
          [id, qualityGrade, accepted, inspectedBy, moisturePct === undefined ? null : moisturePct],
        );
        await logAccess(client, 'write', 'produce.delivery', id);
        return { status: accepted ? 'accepted' : 'rejected' };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'delivery_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_confirm_quality', detail: result.businessError });
    }
    return res.json({ status: result.status });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/deliveries/:id/settle
 * Same ownership-gating pattern as confirm-quality. Requires the
 * cooperative to already be an activated vendor (settlement_account_id
 * set) — see POST /admin/cooperatives/:id/activate-settlement in
 * admin.js, the M01→M09 bridge that makes this possible for a
 * Platform-Ops-provisioned cooperative in the first place. If not yet
 * activated, produce.settle_delivery() raises and that surfaces as a 409
 * here rather than a generic 500.
 */
router.post('/deliveries/:id/settle', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT status FROM produce.delivery WHERE buyer_org_id = $1 AND delivery_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) {
        return { notFound: true };
      }
      try {
        const { rows } = await client.query('SELECT produce.settle_delivery($1) AS entry_id', [id]);
        await logAccess(client, 'write', 'produce.delivery', id);
        return { entryId: rows[0].entry_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'delivery_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_settle', detail: result.businessError });
    }
    return res.json({ status: 'settled', settlement_entry_id: result.entryId });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/production-units — SAME unrestricted "browse all active
 * production units" behaviour as GET /buyer/production-units.
 *
 * Scope boundary, explicit and temporary: there is no farmer<->cooperative
 * membership table anywhere in this codebase yet (M02 Digital Member &
 * Farmer, which would define "is this farmer actually a member of THIS
 * cooperative," has not been built). Rather than block the whole M09
 * module on M02 landing first, this mirrors buyer.js's own existing,
 * already-shipped precedent of an unrestricted directory. When M02 lands,
 * this should be narrowed to member-only for cooperatives specifically
 * (a private Buyer legitimately has no such restriction; a cooperative
 * conceptually should, once membership exists to check against).
 */
router.get('/production-units', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT pu.unit_id, pu.unit_type, pu.commodity_code, pu.area_rai,
                f.farmer_id, f.full_name AS farmer_name
           FROM registry.production_unit pu
           JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
          WHERE pu.status = 'active'
          ORDER BY f.full_name`,
      );
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/commodities — registry.commodity_ref, for the delivery form's
 * commodity dropdown. Same as GET /buyer/commodities.
 */
router.get('/commodities', async (req, res, next) => {
  try {
    const rows = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const result = await client.query('SELECT commodity_code, name_th FROM registry.commodity_ref ORDER BY name_th');
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/lots?status=Open|Closed — this cooperative's collection lots.
 */
router.get('/lots', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;

  if (status && !['Open', 'Closed'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: ['Open', 'Closed'] });
  }

  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let statusFilter = '';
      if (status) {
        params.push(status);
        statusFilter = 'AND l.status = $2';
      }
      const result = await client.query(
        `SELECT l.lot_id, l.commodity_code, l.quality_grade, l.status, l.lot_note,
                l.created_at, l.closed_at,
                COUNT(d.delivery_id)::int AS delivery_count,
                COALESCE(SUM(d.quantity_ton), 0)::numeric AS total_quantity_ton
           FROM produce.lot l
           LEFT JOIN produce.delivery d ON d.lot_id = l.lot_id
          WHERE l.buyer_org_id = $1 ${statusFilter}
          GROUP BY l.lot_id
          ORDER BY l.created_at DESC`,
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
 * GET /coop/lots/:id — lot detail plus the deliveries assigned to it.
 */
router.get('/lots/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const lot = await client.query(
        `SELECT lot_id, commodity_code, quality_grade, status, lot_note, created_at, closed_at
           FROM produce.lot WHERE buyer_org_id = $1 AND lot_id = $2`,
        [subjectId, id],
      );
      if (lot.rows.length === 0) return null;

      const deliveries = await client.query(
        `SELECT d.delivery_id, d.unit_id, f.full_name AS farmer_name, d.quantity_ton,
                d.quality_grade, d.moisture_pct, d.status, d.delivered_at
           FROM produce.delivery d
           LEFT JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
           LEFT JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
          WHERE d.lot_id = $2 AND d.buyer_org_id = $1
          ORDER BY d.delivered_at`,
        [subjectId, id],
      );

      return { lot: lot.rows[0], deliveries: deliveries.rows };
    });

    if (!result) {
      return res.status(404).json({ error: 'lot_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/lots — open a new collection lot.
 * Body: { commodity_code, quality_grade?, lot_note? }
 */
router.post('/lots', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { commodity_code: commodityCode, quality_grade: qualityGrade, lot_note: lotNote } = req.body || {};

  if (!commodityCode) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['commodity_code'] });
  }

  try {
    const lotId = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT produce.create_lot($1, $2, $3, $4) AS lot_id',
        [subjectId, commodityCode, qualityGrade || null, lotNote || null],
      );
      const newLotId = rows[0].lot_id;
      await logAccess(client, 'write', 'produce.lot', newLotId);
      return newLotId;
    });

    return res.status(201).json({ lot_id: lotId, status: 'Open' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/deliveries/:id/assign-lot
 * Body: { lot_id }
 * Ownership-gated the same way as confirm-quality/settle: both the
 * delivery AND the target lot must belong to this cooperative — checked
 * explicitly here before calling produce.assign_delivery_to_lot(), which
 * itself validates lot is Open, delivery isn't already settled, and the
 * commodity matches.
 */
router.post('/deliveries/:id/assign-lot', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { lot_id: lotId } = req.body || {};

  if (!lotId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['lot_id'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT status FROM produce.delivery WHERE buyer_org_id = $1 AND delivery_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { deliveryNotFound: true };

      const lotOwned = await client.query(
        'SELECT status FROM produce.lot WHERE buyer_org_id = $1 AND lot_id = $2',
        [subjectId, lotId],
      );
      if (lotOwned.rows.length === 0) return { lotNotFound: true };

      try {
        await client.query('SELECT produce.assign_delivery_to_lot($1, $2)', [id, lotId]);
        await logAccess(client, 'write', 'produce.delivery', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.deliveryNotFound) {
      return res.status(404).json({ error: 'delivery_not_found' });
    }
    if (result.lotNotFound) {
      return res.status(404).json({ error: 'lot_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_assign_lot', detail: result.businessError });
    }
    return res.json({ status: 'assigned' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/lots/:id/close
 * Ownership-gated the same way as the delivery routes above.
 */
router.post('/lots/:id/close', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT status FROM produce.lot WHERE buyer_org_id = $1 AND lot_id = $2',
        [subjectId, id],
      );
      if (owned.rows.length === 0) return { notFound: true };

      try {
        await client.query('SELECT produce.close_lot($1)', [id]);
        await logAccess(client, 'write', 'produce.lot', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'lot_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_close_lot', detail: result.businessError });
    }
    return res.json({ status: 'Closed' });
  } catch (err) {
    return next(err);
  }
});

/**
 * ============================================================================
 * M10 Warehouse / Drying — a cooperative's own storage sites (bins/
 * facilities), inventory movements for produce.lot batches, and moisture
 * readings taken over time while a lot dries. See
 * grant_cooperative_warehouse.sql for the full schema/design rationale —
 * in particular why this is a NEW `warehouse` schema, not the same thing
 * as the pre-existing M08 machinery/drying-yard BOOKING system
 * (src/routes/machinery.js), and how a lot's current location/utilization
 * is derived (warehouse.v_lot_current_location / v_bin_utilization) rather
 * than stored redundantly.
 *
 * Same ownership-gating discipline as the M09 routes above: warehouse.*
 * has no row-level security, so every route below explicitly scopes
 * facilities by `org_id = $subject` and bins/lots through their owning
 * facility/lot — this is the entire security boundary, not
 * defense-in-depth.
 * ============================================================================
 */

/** Resolves a facility_id iff it belongs to this cooperative, else null. */
async function assertFacilityOwned(client, subjectId, facilityId) {
  const { rows } = await client.query(
    'SELECT facility_id FROM warehouse.facility WHERE facility_id = $1 AND org_id = $2',
    [facilityId, subjectId],
  );
  return rows.length > 0;
}

/** Resolves a bin_id iff its facility belongs to this cooperative, else null. */
async function assertBinOwned(client, subjectId, binId) {
  const { rows } = await client.query(
    `SELECT b.bin_id FROM warehouse.bin b
       JOIN warehouse.facility f ON f.facility_id = b.facility_id
      WHERE b.bin_id = $1 AND f.org_id = $2`,
    [binId, subjectId],
  );
  return rows.length > 0;
}

/** Resolves a lot_id iff it belongs to this cooperative, else null — same check as M09's assign-lot/close-lot routes. */
async function assertLotOwned(client, subjectId, lotId) {
  const { rows } = await client.query(
    'SELECT lot_id FROM produce.lot WHERE lot_id = $1 AND buyer_org_id = $2',
    [lotId, subjectId],
  );
  return rows.length > 0;
}

/**
 * GET /coop/warehouse/facilities — this cooperative's storage sites, each
 * with its bins rolled up into a simple occupied/capacity summary (per-bin
 * detail is GET /coop/warehouse/facilities/:id below).
 */
router.get('/warehouse/facilities', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT f.facility_id, f.facility_name, f.facility_type, f.capacity_ton, f.status, f.created_at,
                COUNT(b.bin_id)::int AS bin_count,
                COALESCE(SUM(u.current_quantity_ton), 0)::numeric AS total_stored_ton
           FROM warehouse.facility f
           LEFT JOIN warehouse.bin b ON b.facility_id = f.facility_id
           LEFT JOIN warehouse.v_bin_utilization u ON u.bin_id = b.bin_id
          WHERE f.org_id = $1
          GROUP BY f.facility_id
          ORDER BY f.created_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

// 'ProcessingPlant' added by grant_cooperative_processing.sql (M11) —
// widening warehouse.facility.facility_type's CHECK constraint rather than
// creating a parallel "plant" table, so a cooperative's own mill can be
// registered through this same form/route. Kept here (not inline below) so
// this array and the DB CHECK constraint's allowed list can't drift apart
// silently — this list IS the source of truth for the route-level check.
const FACILITY_TYPES = ['Warehouse', 'DryingYard', 'Silo', 'ProcessingPlant'];

/**
 * POST /coop/warehouse/facilities — open a new facility.
 * Body: { facility_name, facility_type: Warehouse|DryingYard|Silo|ProcessingPlant, capacity_ton? }
 */
router.post('/warehouse/facilities', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { facility_name: facilityName, facility_type: facilityType, capacity_ton: capacityTon } = req.body || {};

  if (!facilityName || !facilityType) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['facility_name', 'facility_type'] });
  }
  if (!FACILITY_TYPES.includes(facilityType)) {
    return res.status(400).json({ error: 'invalid_facility_type', valid: FACILITY_TYPES });
  }

  try {
    const facilityId = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO warehouse.facility (org_id, facility_name, facility_type, capacity_ton)
         VALUES ($1, $2, $3, $4) RETURNING facility_id`,
        [subjectId, facilityName, facilityType, capacityTon || null],
      );
      await logAccess(client, 'write', 'warehouse.facility', rows[0].facility_id);
      return rows[0].facility_id;
    });
    return res.status(201).json({ facility_id: facilityId });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/warehouse/facilities/:id — facility detail with per-bin
 * utilization (from warehouse.v_bin_utilization).
 */
router.get('/warehouse/facilities/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const facility = await client.query(
        'SELECT facility_id, facility_name, facility_type, capacity_ton, status, created_at FROM warehouse.facility WHERE facility_id = $1 AND org_id = $2',
        [id, subjectId],
      );
      if (facility.rows.length === 0) return null;

      const bins = await client.query(
        `SELECT u.bin_id, b.bin_code, u.capacity_ton, u.current_quantity_ton, u.utilization_pct, b.status
           FROM warehouse.v_bin_utilization u
           JOIN warehouse.bin b ON b.bin_id = u.bin_id
          WHERE u.facility_id = $1
          ORDER BY b.bin_code`,
        [id],
      );

      return { facility: facility.rows[0], bins: bins.rows };
    });

    if (!result) return res.status(404).json({ error: 'facility_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/warehouse/facilities/:id/bins — open a new bin within a
 * facility this cooperative owns.
 * Body: { bin_code, capacity_ton? }
 */
router.post('/warehouse/facilities/:id/bins', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { bin_code: binCode, capacity_ton: capacityTon } = req.body || {};

  if (!binCode) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['bin_code'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertFacilityOwned(client, subjectId, id))) return { facilityNotFound: true };

      try {
        const { rows } = await client.query(
          'INSERT INTO warehouse.bin (facility_id, bin_code, capacity_ton) VALUES ($1, $2, $3) RETURNING bin_id',
          [id, binCode, capacityTon || null],
        );
        await logAccess(client, 'write', 'warehouse.bin', rows[0].bin_id);
        return { binId: rows[0].bin_id };
      } catch (dbErr) {
        if (dbErr.code === '23505') return { duplicateBinCode: true };
        throw dbErr;
      }
    });

    if (result.facilityNotFound) return res.status(404).json({ error: 'facility_not_found' });
    if (result.duplicateBinCode) return res.status(409).json({ error: 'bin_code_already_used_in_facility' });
    return res.status(201).json({ bin_id: result.binId });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/warehouse/lots — this cooperative's lots with their current
 * warehouse status (in_storage / released / not_in_warehouse) and age —
 * the entry point for "which lots are sitting in my warehouse right now."
 */
router.get('/warehouse/lots', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT l.lot_id, l.commodity_code, l.quality_grade, l.status AS lot_status, l.lot_note,
                loc.current_bin_id, b.bin_code, f.facility_name,
                loc.warehouse_status, loc.first_received_at, loc.age_days
           FROM produce.lot l
           LEFT JOIN warehouse.v_lot_current_location loc ON loc.lot_id = l.lot_id
           LEFT JOIN warehouse.bin b ON b.bin_id = loc.current_bin_id
           LEFT JOIN warehouse.facility f ON f.facility_id = b.facility_id
          WHERE l.buyer_org_id = $1
          ORDER BY l.created_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/warehouse/lots/:lotId/history — full movement + drying-reading
 * history for one lot (traceability/aging detail view).
 */
router.get('/warehouse/lots/:lotId/history', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { lotId } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertLotOwned(client, subjectId, lotId))) return null;

      const movements = await client.query(
        `SELECT m.movement_id, m.movement_type, m.quantity_ton, m.moisture_pct, m.recorded_by, m.recorded_at, m.note,
                fb.bin_code AS from_bin_code, tb.bin_code AS to_bin_code
           FROM warehouse.movement m
           LEFT JOIN warehouse.bin fb ON fb.bin_id = m.from_bin_id
           LEFT JOIN warehouse.bin tb ON tb.bin_id = m.to_bin_id
          WHERE m.lot_id = $1
          ORDER BY m.recorded_at`,
        [lotId],
      );
      const readings = await client.query(
        `SELECT r.reading_id, r.moisture_pct, r.recorded_by, r.recorded_at, b.bin_code
           FROM warehouse.drying_reading r
           JOIN warehouse.bin b ON b.bin_id = r.bin_id
          WHERE r.lot_id = $1
          ORDER BY r.recorded_at`,
        [lotId],
      );
      return { movements: movements.rows, drying_readings: readings.rows };
    });

    if (!result) return res.status(404).json({ error: 'lot_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/warehouse/receive
 * Body: { lot_id, bin_id, quantity_ton, recorded_by, moisture_pct? }
 * Brings a lot into warehouse tracking for the first time (or again, if it
 * was previously released — warehouse.receive_lot() doesn't forbid that).
 */
router.post('/warehouse/receive', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    lot_id: lotId, bin_id: binId, quantity_ton: quantityTon, recorded_by: recordedBy, moisture_pct: moisturePct,
  } = req.body || {};

  if (!lotId || !binId || !quantityTon || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['lot_id', 'bin_id', 'quantity_ton', 'recorded_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertLotOwned(client, subjectId, lotId))) return { lotNotFound: true };
      if (!(await assertBinOwned(client, subjectId, binId))) return { binNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT warehouse.receive_lot($1, $2, $3, $4, $5) AS movement_id',
          [lotId, binId, quantityTon, recordedBy, moisturePct === undefined ? null : moisturePct],
        );
        await logAccess(client, 'write', 'warehouse.movement', rows[0].movement_id);
        return { movementId: rows[0].movement_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.lotNotFound) return res.status(404).json({ error: 'lot_not_found' });
    if (result.binNotFound) return res.status(404).json({ error: 'bin_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_receive_lot', detail: result.businessError });
    return res.status(201).json({ movement_id: result.movementId, status: 'received' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/warehouse/transfer
 * Body: { lot_id, from_bin_id, to_bin_id, quantity_ton, recorded_by }
 */
router.post('/warehouse/transfer', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    lot_id: lotId, from_bin_id: fromBinId, to_bin_id: toBinId, quantity_ton: quantityTon, recorded_by: recordedBy,
  } = req.body || {};

  if (!lotId || !fromBinId || !toBinId || !quantityTon || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['lot_id', 'from_bin_id', 'to_bin_id', 'quantity_ton', 'recorded_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertLotOwned(client, subjectId, lotId))) return { lotNotFound: true };
      if (!(await assertBinOwned(client, subjectId, fromBinId)) || !(await assertBinOwned(client, subjectId, toBinId))) {
        return { binNotFound: true };
      }

      try {
        const { rows } = await client.query(
          'SELECT warehouse.transfer_lot($1, $2, $3, $4, $5) AS movement_id',
          [lotId, fromBinId, toBinId, quantityTon, recordedBy],
        );
        await logAccess(client, 'write', 'warehouse.movement', rows[0].movement_id);
        return { movementId: rows[0].movement_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.lotNotFound) return res.status(404).json({ error: 'lot_not_found' });
    if (result.binNotFound) return res.status(404).json({ error: 'bin_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_transfer_lot', detail: result.businessError });
    return res.status(201).json({ movement_id: result.movementId, status: 'transferred' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/warehouse/release
 * Body: { lot_id, from_bin_id, quantity_ton, recorded_by, note? }
 * Marks a lot as having left warehouse tracking (sold, sent onward, etc.)
 * — see the migration's Follow-up note on why this doesn't yet link to
 * what the lot became.
 */
router.post('/warehouse/release', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    lot_id: lotId, from_bin_id: fromBinId, quantity_ton: quantityTon, recorded_by: recordedBy, note,
  } = req.body || {};

  if (!lotId || !fromBinId || !quantityTon || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['lot_id', 'from_bin_id', 'quantity_ton', 'recorded_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertLotOwned(client, subjectId, lotId))) return { lotNotFound: true };
      if (!(await assertBinOwned(client, subjectId, fromBinId))) return { binNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT warehouse.release_lot($1, $2, $3, $4, $5) AS movement_id',
          [lotId, fromBinId, quantityTon, recordedBy, note || null],
        );
        await logAccess(client, 'write', 'warehouse.movement', rows[0].movement_id);
        return { movementId: rows[0].movement_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.lotNotFound) return res.status(404).json({ error: 'lot_not_found' });
    if (result.binNotFound) return res.status(404).json({ error: 'bin_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_release_lot', detail: result.businessError });
    return res.status(201).json({ movement_id: result.movementId, status: 'released' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/warehouse/drying-readings
 * Body: { lot_id, bin_id, moisture_pct, recorded_by }
 * A standalone reading, independent of any movement — lets a cooperative
 * log ความชื้น daily while a lot sits drying without needing to also
 * transfer it.
 */
router.post('/warehouse/drying-readings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    lot_id: lotId, bin_id: binId, moisture_pct: moisturePct, recorded_by: recordedBy,
  } = req.body || {};

  if (!lotId || !binId || moisturePct === undefined || moisturePct === null || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['lot_id', 'bin_id', 'moisture_pct', 'recorded_by'] });
  }
  const m = Number(moisturePct);
  if (!Number.isFinite(m) || m < 0 || m > 100) {
    return res.status(400).json({ error: 'invalid_moisture_pct' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertLotOwned(client, subjectId, lotId))) return { lotNotFound: true };
      if (!(await assertBinOwned(client, subjectId, binId))) return { binNotFound: true };

      const { rows } = await client.query(
        'SELECT warehouse.record_drying_reading($1, $2, $3, $4) AS reading_id',
        [lotId, binId, m, recordedBy],
      );
      await logAccess(client, 'write', 'warehouse.drying_reading', rows[0].reading_id);
      return { readingId: rows[0].reading_id };
    });

    if (result.lotNotFound) return res.status(404).json({ error: 'lot_not_found' });
    if (result.binNotFound) return res.status(404).json({ error: 'bin_not_found' });
    return res.status(201).json({ reading_id: result.readingId });
  } catch (err) {
    return next(err);
  }
});

/**
 * ============================================================================
 * M11 Processing — turns collected/warehoused lots into finished goods
 * (milling, drying, sorting, packaging), tracking yield and the input->
 * output traceability chain back to contributing farmers. See
 * grant_cooperative_processing.sql for the full design rationale, in
 * particular why finished goods are free-text product names rather than a
 * commodity_code FK, and why this doesn't (yet) mint a
 * traceability.certificate row.
 *
 * Same ownership-gating discipline as every other module here: processing.*
 * has no row-level security, so every route below explicitly scopes batches
 * by `org_id = $subject` and any facility/lot/finished_good it touches
 * through their owning batch — this is the entire security boundary.
 * ============================================================================
 */

/** Resolves a batch_id iff it belongs to this cooperative, else null. */
async function assertBatchOwned(client, subjectId, batchId) {
  const { rows } = await client.query(
    'SELECT batch_id FROM processing.batch WHERE batch_id = $1 AND org_id = $2',
    [batchId, subjectId],
  );
  return rows.length > 0;
}

/** Resolves a finished_good_id iff its batch belongs to this cooperative, else null. */
async function assertFinishedGoodOwned(client, subjectId, finishedGoodId) {
  const { rows } = await client.query(
    `SELECT fg.finished_good_id FROM processing.finished_good fg
       JOIN processing.batch b ON b.batch_id = fg.batch_id
      WHERE fg.finished_good_id = $1 AND b.org_id = $2`,
    [finishedGoodId, subjectId],
  );
  return rows.length > 0;
}

const PROCESS_TYPES = ['Milling', 'Drying', 'Sorting', 'Packaging', 'Other'];

/**
 * GET /coop/processing/batches — every processing run this cooperative has
 * started, most recent first, with live input/output/yield figures from
 * processing.v_batch_summary.
 */
router.get('/processing/batches', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT batch_id, facility_id, facility_name, source_commodity_code, source_commodity_name,
                process_type, output_product_name, status, started_by, started_at,
                completed_by, completed_at, cancelled_by, cancelled_at, cancel_reason, batch_note,
                input_quantity_ton, output_quantity_ton, yield_pct
           FROM processing.v_batch_summary
          WHERE org_id = $1
          ORDER BY started_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/processing/batches — start a new processing run.
 * Body: { facility_id?, source_commodity_code, process_type, output_product_name, started_by, batch_note? }
 */
router.post('/processing/batches', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    facility_id: facilityId, source_commodity_code: sourceCommodityCode, process_type: processType,
    output_product_name: outputProductName, started_by: startedBy, batch_note: batchNote,
  } = req.body || {};

  if (!sourceCommodityCode || !processType || !outputProductName || !startedBy) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['source_commodity_code', 'process_type', 'output_product_name', 'started_by'],
    });
  }
  if (!PROCESS_TYPES.includes(processType)) {
    return res.status(400).json({ error: 'invalid_process_type', valid: PROCESS_TYPES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (facilityId && !(await assertFacilityOwned(client, subjectId, facilityId))) return { facilityNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT processing.create_batch($1, $2, $3, $4, $5, $6, $7) AS batch_id',
          [subjectId, facilityId || null, sourceCommodityCode, processType, outputProductName, startedBy, batchNote || null],
        );
        await logAccess(client, 'write', 'processing.batch', rows[0].batch_id);
        return { batchId: rows[0].batch_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.facilityNotFound) return res.status(404).json({ error: 'facility_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_create_batch', detail: result.businessError });
    return res.status(201).json({ batch_id: result.batchId, status: 'InProgress' });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/processing/batches/:id — batch detail: the summary row, every
 * lot committed as input, every finished-good line item recorded so far,
 * and the distinct list of farmers whose produce fed into it (the
 * practical meaning of "batch traceability" — see the migration's design
 * note on why this isn't a traceability.certificate row).
 */
router.get('/processing/batches/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const batch = await client.query(
        `SELECT batch_id, facility_id, facility_name, source_commodity_code, source_commodity_name,
                process_type, output_product_name, status, started_by, started_at,
                completed_by, completed_at, cancelled_by, cancelled_at, cancel_reason, batch_note,
                input_quantity_ton, output_quantity_ton, yield_pct
           FROM processing.v_batch_summary WHERE batch_id = $1 AND org_id = $2`,
        [id, subjectId],
      );
      if (batch.rows.length === 0) return null;

      const inputs = await client.query(
        `SELECT bi.batch_input_id, bi.lot_id, bi.quantity_ton, bi.recorded_at, l.lot_note, l.quality_grade
           FROM processing.batch_input bi
           JOIN produce.lot l ON l.lot_id = bi.lot_id
          WHERE bi.batch_id = $1
          ORDER BY bi.recorded_at`,
        [id],
      );

      const finishedGoods = await client.query(
        `SELECT fg.finished_good_id, fg.product_name, fg.quantity_ton, fg.is_primary_product, fg.recorded_at,
                s.dispatched_quantity_ton, s.quantity_on_hand_ton
           FROM processing.finished_good fg
           JOIN processing.v_finished_good_stock s ON s.finished_good_id = fg.finished_good_id
          WHERE fg.batch_id = $1
          ORDER BY fg.is_primary_product DESC, fg.recorded_at`,
        [id],
      );

      const farmers = await client.query(
        `SELECT DISTINCT f.farmer_id, f.full_name AS farmer_name
           FROM processing.batch_input bi
           JOIN produce.delivery d ON d.lot_id = bi.lot_id
           LEFT JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
           LEFT JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
          WHERE bi.batch_id = $1 AND f.farmer_id IS NOT NULL
          ORDER BY f.full_name`,
        [id],
      );

      return { batch: batch.rows[0], inputs: inputs.rows, finished_goods: finishedGoods.rows, contributing_farmers: farmers.rows };
    });

    if (!result) return res.status(404).json({ error: 'batch_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/processing/lots-available?commodity_code=... — lots this
 * cooperative can still commit to a batch (available_quantity_ton > 0),
 * optionally filtered to one commodity — the UI's picker for "which lot(s)
 * go into this batch."
 */
router.get('/processing/lots-available', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { commodity_code: commodityCode } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT a.lot_id, a.commodity_code, a.lot_status, a.total_quantity_ton, a.committed_quantity_ton, a.available_quantity_ton,
                l.lot_note, l.quality_grade
           FROM processing.v_lot_processing_availability a
           JOIN produce.lot l ON l.lot_id = a.lot_id
          WHERE a.org_id = $1 AND a.available_quantity_ton > 0
                AND ($2::text IS NULL OR a.commodity_code = $2)
          ORDER BY l.created_at DESC`,
        [subjectId, commodityCode || null],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/processing/batches/:id/commit-lot
 * Body: { lot_id, quantity_ton }
 */
router.post('/processing/batches/:id/commit-lot', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { lot_id: lotId, quantity_ton: quantityTon } = req.body || {};

  if (!lotId || !quantityTon) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['lot_id', 'quantity_ton'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertBatchOwned(client, subjectId, id))) return { batchNotFound: true };
      if (!(await assertLotOwned(client, subjectId, lotId))) return { lotNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT processing.commit_lot_to_batch($1, $2, $3) AS batch_input_id',
          [id, lotId, quantityTon],
        );
        await logAccess(client, 'write', 'processing.batch_input', rows[0].batch_input_id);
        return { batchInputId: rows[0].batch_input_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.batchNotFound) return res.status(404).json({ error: 'batch_not_found' });
    if (result.lotNotFound) return res.status(404).json({ error: 'lot_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_commit_lot', detail: result.businessError });
    return res.status(201).json({ batch_input_id: result.batchInputId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/processing/batches/:id/finished-goods — record one output
 * line item (call again for by-products, e.g. รำข้าว/ปลายข้าว alongside
 * the primary ข้าวสาร).
 * Body: { product_name, quantity_ton, is_primary_product? }
 */
router.post('/processing/batches/:id/finished-goods', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { product_name: productName, quantity_ton: quantityTon, is_primary_product: isPrimaryProduct } = req.body || {};

  if (!productName || !quantityTon) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['product_name', 'quantity_ton'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertBatchOwned(client, subjectId, id))) return { batchNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT processing.add_finished_good($1, $2, $3, $4) AS finished_good_id',
          [id, productName, quantityTon, isPrimaryProduct === undefined ? true : !!isPrimaryProduct],
        );
        await logAccess(client, 'write', 'processing.finished_good', rows[0].finished_good_id);
        return { finishedGoodId: rows[0].finished_good_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.batchNotFound) return res.status(404).json({ error: 'batch_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_add_finished_good', detail: result.businessError });
    return res.status(201).json({ finished_good_id: result.finishedGoodId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/processing/batches/:id/complete
 * Body: { completed_by }
 */
router.post('/processing/batches/:id/complete', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { completed_by: completedBy } = req.body || {};

  if (!completedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['completed_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertBatchOwned(client, subjectId, id))) return { batchNotFound: true };

      try {
        await client.query('SELECT processing.complete_batch($1, $2)', [id, completedBy]);
        await logAccess(client, 'write', 'processing.batch', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.batchNotFound) return res.status(404).json({ error: 'batch_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_complete_batch', detail: result.businessError });
    return res.json({ status: 'Completed' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/processing/batches/:id/cancel
 * Body: { cancelled_by, reason }
 */
router.post('/processing/batches/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { cancelled_by: cancelledBy, reason } = req.body || {};

  if (!cancelledBy || !reason) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['cancelled_by', 'reason'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertBatchOwned(client, subjectId, id))) return { batchNotFound: true };

      try {
        await client.query('SELECT processing.cancel_batch($1, $2, $3)', [id, cancelledBy, reason]);
        await logAccess(client, 'write', 'processing.batch', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.batchNotFound) return res.status(404).json({ error: 'batch_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_cancel_batch', detail: result.businessError });
    return res.json({ status: 'Cancelled' });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/processing/finished-goods — this cooperative's finished-goods
 * stock across all batches, from processing.v_finished_good_stock.
 */
router.get('/processing/finished-goods', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT s.finished_good_id, s.batch_id, s.product_name, s.is_primary_product,
                s.produced_quantity_ton, s.dispatched_quantity_ton, s.quantity_on_hand_ton, s.recorded_at,
                b.output_product_name AS batch_output_product_name, b.status AS batch_status
           FROM processing.v_finished_good_stock s
           JOIN processing.batch b ON b.batch_id = s.batch_id
          WHERE s.org_id = $1
          ORDER BY s.recorded_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/processing/finished-goods/:id/dispatch — record finished
 * goods leaving inventory (sold/distributed/sent onward). See the
 * migration's Follow-up note: this is inventory drawdown only, not yet
 * wired to a real buyer/order.
 * Body: { quantity_ton, recorded_by, note? }
 */
router.post('/processing/finished-goods/:id/dispatch', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { quantity_ton: quantityTon, recorded_by: recordedBy, note } = req.body || {};

  if (!quantityTon || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['quantity_ton', 'recorded_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertFinishedGoodOwned(client, subjectId, id))) return { finishedGoodNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT processing.record_dispatch($1, $2, $3, $4) AS dispatch_id',
          [id, quantityTon, recordedBy, note || null],
        );
        await logAccess(client, 'write', 'processing.finished_good_dispatch', rows[0].dispatch_id);
        return { dispatchId: rows[0].dispatch_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.finishedGoodNotFound) return res.status(404).json({ error: 'finished_good_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_dispatch', detail: result.businessError });
    return res.status(201).json({ dispatch_id: result.dispatchId });
  } catch (err) {
    return next(err);
  }
});

/**
 * ============================================================================
 * M13 Logistics — moving cargo (a raw produce.lot or a processing.
 * finished_good) out to a destination on a tracked shipment, with a single
 * proof-of-delivery and an append-only exception log. See
 * grant_cooperative_logistics.sql for the full design rationale, in
 * particular why adding a FinishedGood item calls processing.
 * record_dispatch() immediately, why cancellation only works on an empty
 * shipment, and why processing.v_lot_processing_availability was widened
 * alongside this migration.
 *
 * Same ownership-gating discipline as every other module here: logistics.*
 * has no row-level security, so every route below explicitly scopes
 * carriers/shipments by `org_id = $subject` and anything they touch
 * (vehicles via their carrier, lots/finished_goods via assertLotOwned /
 * assertFinishedGoodOwned already defined in the M09/M11 sections above)
 * — this is the entire security boundary.
 * ============================================================================
 */

/** Resolves a carrier_id iff it belongs to this cooperative, else null. */
async function assertCarrierOwned(client, subjectId, carrierId) {
  const { rows } = await client.query(
    'SELECT carrier_id FROM logistics.carrier WHERE carrier_id = $1 AND org_id = $2',
    [carrierId, subjectId],
  );
  return rows.length > 0;
}

/** Resolves a vehicle_id iff its carrier belongs to this cooperative, else null. */
async function assertVehicleOwned(client, subjectId, vehicleId) {
  const { rows } = await client.query(
    `SELECT v.vehicle_id FROM logistics.vehicle v
       JOIN logistics.carrier c ON c.carrier_id = v.carrier_id
      WHERE v.vehicle_id = $1 AND c.org_id = $2`,
    [vehicleId, subjectId],
  );
  return rows.length > 0;
}

/** Resolves a shipment_id iff it belongs to this cooperative, else null. */
async function assertShipmentOwned(client, subjectId, shipmentId) {
  const { rows } = await client.query(
    'SELECT shipment_id FROM logistics.shipment WHERE shipment_id = $1 AND org_id = $2',
    [shipmentId, subjectId],
  );
  return rows.length > 0;
}

const CARRIER_TYPES = ['Internal', 'ThirdParty'];
const VEHICLE_TYPES = ['Truck', 'Pickup', 'Trailer', 'Other'];
const EXCEPTION_TYPES = ['Damage', 'Shortage', 'Delay', 'Rejected', 'Other'];

/**
 * GET /coop/logistics/linkable-orgs?q=... — Verified 'Logistics' orgs this
 * cooperative can link a carrier record to (see grant_logistics_portal.sql).
 * Optional ?q= filters org_name case-insensitively (ILIKE); with no q,
 * returns the full list (expected to stay small in practice). This is a
 * plain directory lookup — identity.organization has no RLS at all (every
 * other portal's own "browse other verified orgs" list, e.g. GET
 * /farmer/lenders, reads it the same way) — so it's fine to expose beyond
 * this cooperative's own data.
 */
router.get('/logistics/linkable-orgs', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { q } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [];
      let filter = '';
      if (q) {
        params.push(`%${q}%`);
        filter = 'AND org_name ILIKE $1';
      }
      const result = await client.query(
        `SELECT org_id, org_name, tax_id
           FROM identity.organization
          WHERE org_type = 'Logistics' AND kyb_status = 'Verified' ${filter}
          ORDER BY org_name
          LIMIT 50`,
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
 * GET /coop/logistics/carriers — this cooperative's transport providers,
 * each with its vehicle count.
 */
router.get('/logistics/carriers', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT c.carrier_id, c.carrier_name, c.carrier_type, c.contact_phone, c.status, c.created_at,
                c.linked_org_id, lo.org_name AS linked_org_name,
                COUNT(v.vehicle_id)::int AS vehicle_count
           FROM logistics.carrier c
           LEFT JOIN logistics.vehicle v ON v.carrier_id = c.carrier_id
           LEFT JOIN identity.organization lo ON lo.org_id = c.linked_org_id
          WHERE c.org_id = $1
          GROUP BY c.carrier_id, lo.org_name
          ORDER BY c.created_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/carriers — register a new transport provider.
 * Body: { carrier_name, carrier_type: Internal|ThirdParty, contact_phone?,
 *         linked_org_id? } — linked_org_id (added alongside
 * grant_logistics_portal.sql) optionally ties this carrier record to a
 * real, self-registered org_type='Logistics' organization (must be
 * kyb_status='Verified' — see logistics.assert_linkable_logistics_org), so
 * that organization can log into its own portal (frontend/logistics/) and
 * see shipments this cooperative assigns to it. Leave unset for a plain
 * free-text carrier (a member's own truck, a company that isn't itself a
 * platform user) exactly as before this feature.
 */
router.post('/logistics/carriers', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    carrier_name: carrierName, carrier_type: carrierType, contact_phone: contactPhone,
    linked_org_id: linkedOrgId,
  } = req.body || {};

  if (!carrierName || !carrierType) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['carrier_name', 'carrier_type'] });
  }
  if (!CARRIER_TYPES.includes(carrierType)) {
    return res.status(400).json({ error: 'invalid_carrier_type', valid: CARRIER_TYPES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      try {
        const { rows } = await client.query(
          'SELECT logistics.create_carrier($1, $2, $3, $4, $5) AS carrier_id',
          [subjectId, carrierName, carrierType, contactPhone || null, linkedOrgId || null],
        );
        await logAccess(client, 'write', 'logistics.carrier', rows[0].carrier_id);
        return { carrierId: rows[0].carrier_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });
    if (result.businessError) return res.status(409).json({ error: 'cannot_create_carrier', detail: result.businessError });
    return res.status(201).json({ carrier_id: result.carrierId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/carriers/:id/link — link (or, with linked_org_id:
 * null, unlink) an EXISTING carrier record to a real Logistics org after
 * the fact — for a carrier that was typed in as free text before that org
 * ever self-registered, or before this feature existed at all.
 * Body: { linked_org_id: uuid | null }
 */
router.post('/logistics/carriers/:id/link', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { linked_org_id: linkedOrgId } = req.body || {};

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertCarrierOwned(client, subjectId, id))) return { carrierNotFound: true };

      try {
        await client.query('SELECT logistics.link_carrier_org($1, $2)', [id, linkedOrgId || null]);
        await logAccess(client, 'write', 'logistics.carrier', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.carrierNotFound) return res.status(404).json({ error: 'carrier_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_link_carrier', detail: result.businessError });
    return res.json({ linked: linkedOrgId ? true : false });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/logistics/carriers/:id — carrier detail with its vehicles.
 */
router.get('/logistics/carriers/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const carrier = await client.query(
        `SELECT c.carrier_id, c.carrier_name, c.carrier_type, c.contact_phone, c.status, c.created_at,
                c.linked_org_id, lo.org_name AS linked_org_name
           FROM logistics.carrier c
           LEFT JOIN identity.organization lo ON lo.org_id = c.linked_org_id
          WHERE c.carrier_id = $1 AND c.org_id = $2`,
        [id, subjectId],
      );
      if (carrier.rows.length === 0) return null;

      const vehicles = await client.query(
        'SELECT vehicle_id, vehicle_type, license_plate, capacity_ton, status, created_at FROM logistics.vehicle WHERE carrier_id = $1 ORDER BY created_at',
        [id],
      );

      return { carrier: carrier.rows[0], vehicles: vehicles.rows };
    });

    if (!result) return res.status(404).json({ error: 'carrier_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/carriers/:id/vehicles
 * Body: { vehicle_type: Truck|Pickup|Trailer|Other, license_plate, capacity_ton? }
 */
router.post('/logistics/carriers/:id/vehicles', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { vehicle_type: vehicleType, license_plate: licensePlate, capacity_ton: capacityTon } = req.body || {};

  if (!vehicleType || !licensePlate) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['vehicle_type', 'license_plate'] });
  }
  if (!VEHICLE_TYPES.includes(vehicleType)) {
    return res.status(400).json({ error: 'invalid_vehicle_type', valid: VEHICLE_TYPES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertCarrierOwned(client, subjectId, id))) return { carrierNotFound: true };

      const { rows } = await client.query(
        'SELECT logistics.create_vehicle($1, $2, $3, $4) AS vehicle_id',
        [id, vehicleType, licensePlate, capacityTon || null],
      );
      await logAccess(client, 'write', 'logistics.vehicle', rows[0].vehicle_id);
      return { vehicleId: rows[0].vehicle_id };
    });

    if (result.carrierNotFound) return res.status(404).json({ error: 'carrier_not_found' });
    return res.status(201).json({ vehicle_id: result.vehicleId });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/logistics/shipments — this cooperative's shipments, most
 * recent first, from logistics.v_shipment_summary.
 */
router.get('/logistics/shipments', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT shipment_id, carrier_id, carrier_name, vehicle_id, license_plate,
                destination_name, destination_org_id, driver_name, status,
                scheduled_at, dispatched_at, delivered_at, cancelled_at, cancelled_by, cancel_reason,
                created_by, created_at, item_count, total_quantity_ton,
                pod_received_by, pod_received_quantity_ton, pod_recorded_at, exception_count
           FROM logistics.v_shipment_summary
          WHERE org_id = $1
          ORDER BY created_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/shipments — plan a new shipment.
 * Body: { carrier_id, vehicle_id?, destination_name, destination_org_id?, driver_name?, scheduled_at?, created_by }
 */
router.post('/logistics/shipments', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    carrier_id: carrierId, vehicle_id: vehicleId, destination_name: destinationName, destination_org_id: destinationOrgId,
    driver_name: driverName, scheduled_at: scheduledAt, created_by: createdBy,
  } = req.body || {};

  if (!carrierId || !destinationName || !createdBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['carrier_id', 'destination_name', 'created_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertCarrierOwned(client, subjectId, carrierId))) return { carrierNotFound: true };
      if (vehicleId && !(await assertVehicleOwned(client, subjectId, vehicleId))) return { vehicleNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT logistics.create_shipment($1, $2, $3, $4, $5, $6, $7, $8) AS shipment_id',
          [subjectId, carrierId, vehicleId || null, destinationName, destinationOrgId || null, driverName || null, scheduledAt || null, createdBy],
        );
        await logAccess(client, 'write', 'logistics.shipment', rows[0].shipment_id);
        return { shipmentId: rows[0].shipment_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.carrierNotFound) return res.status(404).json({ error: 'carrier_not_found' });
    if (result.vehicleNotFound) return res.status(404).json({ error: 'vehicle_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_create_shipment', detail: result.businessError });
    return res.status(201).json({ shipment_id: result.shipmentId, status: 'Pending' });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/logistics/shipments/:id — shipment detail: the summary row,
 * every cargo item (with lot/finished-good labels resolved), and the
 * exception log.
 */
router.get('/logistics/shipments/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const shipment = await client.query(
        `SELECT shipment_id, carrier_id, carrier_name, vehicle_id, license_plate,
                destination_name, destination_org_id, driver_name, status,
                scheduled_at, dispatched_at, delivered_at, cancelled_at, cancelled_by, cancel_reason,
                created_by, created_at, item_count, total_quantity_ton,
                pod_received_by, pod_received_quantity_ton, pod_recorded_at, exception_count
           FROM logistics.v_shipment_summary WHERE shipment_id = $1 AND org_id = $2`,
        [id, subjectId],
      );
      if (shipment.rows.length === 0) return null;

      const items = await client.query(
        `SELECT si.shipment_item_id, si.item_type, si.quantity_ton, si.recorded_by, si.recorded_at,
                l.lot_note, l.commodity_code AS lot_commodity_code,
                fg.product_name AS finished_good_product_name
           FROM logistics.shipment_item si
           LEFT JOIN produce.lot l ON l.lot_id = si.lot_id
           LEFT JOIN processing.finished_good fg ON fg.finished_good_id = si.finished_good_id
          WHERE si.shipment_id = $1
          ORDER BY si.recorded_at`,
        [id],
      );

      const pod = await client.query(
        'SELECT pod_id, received_by, received_quantity_ton, signature_name, note, recorded_by, recorded_at FROM logistics.proof_of_delivery WHERE shipment_id = $1',
        [id],
      );

      const exceptions = await client.query(
        `SELECT exception_id, exception_type, description, reported_by, reported_at, resolved, resolved_at, resolution_note
           FROM logistics.shipment_exception WHERE shipment_id = $1 ORDER BY reported_at DESC`,
        [id],
      );

      return {
        shipment: shipment.rows[0],
        items: items.rows,
        proof_of_delivery: pod.rows[0] || null,
        exceptions: exceptions.rows,
      };
    });

    if (!result) return res.status(404).json({ error: 'shipment_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/logistics/lots-available?commodity_code=... — lots this
 * cooperative can still put on a shipment (available_quantity_ton > 0,
 * already netting out both processing commitments AND other shipments —
 * see logistics.v_lot_shipping_availability).
 */
router.get('/logistics/lots-available', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { commodity_code: commodityCode } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT a.lot_id, a.commodity_code, a.lot_status, a.total_quantity_ton,
                a.processing_committed_quantity_ton, a.shipment_committed_quantity_ton, a.available_quantity_ton,
                l.lot_note, l.quality_grade
           FROM logistics.v_lot_shipping_availability a
           JOIN produce.lot l ON l.lot_id = a.lot_id
          WHERE a.org_id = $1 AND a.available_quantity_ton > 0
                AND ($2::text IS NULL OR a.commodity_code = $2)
          ORDER BY l.created_at DESC`,
        [subjectId, commodityCode || null],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/shipments/:id/items
 * Body: { item_type: Lot|FinishedGood, lot_id?, finished_good_id?, quantity_ton }
 */
router.post('/logistics/shipments/:id/items', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { item_type: itemType, lot_id: lotId, finished_good_id: finishedGoodId, quantity_ton: quantityTon } = req.body || {};

  if (!itemType || !quantityTon) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['item_type', 'quantity_ton'] });
  }
  if (!['Lot', 'FinishedGood'].includes(itemType)) {
    return res.status(400).json({ error: 'invalid_item_type', valid: ['Lot', 'FinishedGood'] });
  }
  if (itemType === 'Lot' && !lotId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['lot_id'] });
  }
  if (itemType === 'FinishedGood' && !finishedGoodId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['finished_good_id'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertShipmentOwned(client, subjectId, id))) return { shipmentNotFound: true };
      if (itemType === 'Lot' && !(await assertLotOwned(client, subjectId, lotId))) return { cargoNotFound: true };
      if (itemType === 'FinishedGood' && !(await assertFinishedGoodOwned(client, subjectId, finishedGoodId))) return { cargoNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT logistics.add_shipment_item($1, $2, $3, $4, $5, $6) AS shipment_item_id',
          [id, itemType, lotId || null, finishedGoodId || null, quantityTon, req.body.recorded_by || req.body.created_by || 'ไม่ระบุ'],
        );
        await logAccess(client, 'write', 'logistics.shipment_item', rows[0].shipment_item_id);
        return { shipmentItemId: rows[0].shipment_item_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.shipmentNotFound) return res.status(404).json({ error: 'shipment_not_found' });
    if (result.cargoNotFound) return res.status(404).json({ error: 'cargo_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_add_shipment_item', detail: result.businessError });
    return res.status(201).json({ shipment_item_id: result.shipmentItemId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/shipments/:id/dispatch
 * Body: { dispatched_by }
 */
router.post('/logistics/shipments/:id/dispatch', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { dispatched_by: dispatchedBy } = req.body || {};

  if (!dispatchedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['dispatched_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertShipmentOwned(client, subjectId, id))) return { shipmentNotFound: true };

      try {
        await client.query('SELECT logistics.dispatch_shipment($1, $2)', [id, dispatchedBy]);
        await logAccess(client, 'write', 'logistics.shipment', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.shipmentNotFound) return res.status(404).json({ error: 'shipment_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_dispatch_shipment', detail: result.businessError });
    return res.json({ status: 'InTransit' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/shipments/:id/pod
 * Body: { received_by, received_quantity_ton, recorded_by, signature_name?, note? }
 */
router.post('/logistics/shipments/:id/pod', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const {
    received_by: receivedBy, received_quantity_ton: receivedQuantityTon, recorded_by: recordedBy,
    signature_name: signatureName, note,
  } = req.body || {};

  if (!receivedBy || receivedQuantityTon === undefined || receivedQuantityTon === null || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['received_by', 'received_quantity_ton', 'recorded_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertShipmentOwned(client, subjectId, id))) return { shipmentNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT logistics.record_pod($1, $2, $3, $4, $5, $6) AS pod_id',
          [id, receivedBy, receivedQuantityTon, recordedBy, signatureName || null, note || null],
        );
        await logAccess(client, 'write', 'logistics.proof_of_delivery', rows[0].pod_id);
        return { podId: rows[0].pod_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.shipmentNotFound) return res.status(404).json({ error: 'shipment_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_record_pod', detail: result.businessError });
    return res.status(201).json({ pod_id: result.podId, status: 'Delivered' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/shipments/:id/exceptions
 * Body: { exception_type: Damage|Shortage|Delay|Rejected|Other, description, reported_by }
 */
router.post('/logistics/shipments/:id/exceptions', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { exception_type: exceptionType, description, reported_by: reportedBy } = req.body || {};

  if (!exceptionType || !description || !reportedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['exception_type', 'description', 'reported_by'] });
  }
  if (!EXCEPTION_TYPES.includes(exceptionType)) {
    return res.status(400).json({ error: 'invalid_exception_type', valid: EXCEPTION_TYPES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertShipmentOwned(client, subjectId, id))) return { shipmentNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT logistics.report_exception($1, $2, $3, $4) AS exception_id',
          [id, exceptionType, description, reportedBy],
        );
        await logAccess(client, 'write', 'logistics.shipment_exception', rows[0].exception_id);
        return { exceptionId: rows[0].exception_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.shipmentNotFound) return res.status(404).json({ error: 'shipment_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_report_exception', detail: result.businessError });
    return res.status(201).json({ exception_id: result.exceptionId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/exceptions/:id/resolve
 * Body: { resolution_note }
 */
router.post('/logistics/exceptions/:id/resolve', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { resolution_note: resolutionNote } = req.body || {};

  if (!resolutionNote) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['resolution_note'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT e.exception_id FROM logistics.shipment_exception e
           JOIN logistics.shipment s ON s.shipment_id = e.shipment_id
          WHERE e.exception_id = $1 AND s.org_id = $2`,
        [id, subjectId],
      );
      if (rows.length === 0) return { exceptionNotFound: true };

      await client.query('SELECT logistics.resolve_exception($1, $2)', [id, resolutionNote]);
      await logAccess(client, 'write', 'logistics.shipment_exception', id);
      return { ok: true };
    });

    if (result.exceptionNotFound) return res.status(404).json({ error: 'exception_not_found' });
    return res.json({ resolved: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/logistics/shipments/:id/cancel — only works while the
 * shipment has zero items (see the migration's design note on why).
 * Body: { cancelled_by, reason }
 */
router.post('/logistics/shipments/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { cancelled_by: cancelledBy, reason } = req.body || {};

  if (!cancelledBy || !reason) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['cancelled_by', 'reason'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertShipmentOwned(client, subjectId, id))) return { shipmentNotFound: true };

      try {
        await client.query('SELECT logistics.cancel_shipment($1, $2, $3)', [id, cancelledBy, reason]);
        await logAccess(client, 'write', 'logistics.shipment', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.shipmentNotFound) return res.status(404).json({ error: 'shipment_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_cancel_shipment', detail: result.businessError });
    return res.json({ status: 'Cancelled' });
  } catch (err) {
    return next(err);
  }
});

/**
 * ============================================================================
 * M15 Government Integration Gateway — consent -> credential -> submission
 * (queue/attempt/acknowledge/retry/dead-letter), all scoped to this
 * cooperative's own org_id. See grant_cooperative_gov_gateway.sql for the
 * full design rationale, in particular why this is inside the existing
 * backend rather than a separate service (Open Decision #5), why
 * govgw.credential never stores a real secret, why the retry/dead-letter
 * mechanism is a status-field simulation rather than a real message
 * broker, and why govgw.gov_audit_log exists as a second, government-
 * specific audit trail alongside the platform's existing audit.access_log.
 *
 * govgw.endpoint_catalog is migration-seeded reference data (same pattern
 * as registry.commodity_ref) — there is deliberately no POST route to
 * create endpoints here; only GET to read the catalog.
 * ============================================================================
 */

/** Resolves a consent_id iff it belongs to this cooperative, else null. */
async function assertConsentOwned(client, subjectId, consentId) {
  const { rows } = await client.query(
    'SELECT consent_id FROM govgw.consent WHERE consent_id = $1 AND org_id = $2',
    [consentId, subjectId],
  );
  return rows.length > 0;
}

/** Resolves a credential_id iff it belongs to this cooperative, else null. */
async function assertCredentialOwned(client, subjectId, credentialId) {
  const { rows } = await client.query(
    'SELECT credential_id FROM govgw.credential WHERE credential_id = $1 AND org_id = $2',
    [credentialId, subjectId],
  );
  return rows.length > 0;
}

/** Resolves a submission_id iff it belongs to this cooperative, else null. */
async function assertSubmissionOwned(client, subjectId, submissionId) {
  const { rows } = await client.query(
    'SELECT submission_id FROM govgw.data_submission WHERE submission_id = $1 AND org_id = $2',
    [submissionId, subjectId],
  );
  return rows.length > 0;
}

const SUBMISSION_OUTCOMES = ['Success', 'Failure'];

/**
 * GET /coop/gov/endpoints — the platform-wide catalog of government
 * endpoint categories this gateway knows about (see the migration's
 * header note: two placeholder categories, not a real live API catalog).
 */
router.get('/gov/endpoints', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT endpoint_id, endpoint_code, endpoint_name, agency_name, description, status
           FROM govgw.endpoint_catalog
          WHERE status = 'Active'
          ORDER BY agency_name, endpoint_name`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/gov/consents — this cooperative's consent decisions.
 */
router.get('/gov/consents', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT consent_id, endpoint_id, endpoint_name, agency_name, scope_note, status,
                granted_by, granted_at, revoked_by, revoked_at, revoke_reason
           FROM govgw.v_consent_status
          WHERE org_id = $1
          ORDER BY granted_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/consents — record a consent decision.
 * Body: { endpoint_id?: null-for-blanket, scope_note?, granted_by }
 */
router.post('/gov/consents', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { endpoint_id: endpointId, scope_note: scopeNote, granted_by: grantedBy } = req.body || {};

  if (!grantedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['granted_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      try {
        const { rows } = await client.query(
          'SELECT govgw.grant_consent($1, $2, $3, $4) AS consent_id',
          [subjectId, endpointId || null, scopeNote || null, grantedBy],
        );
        await logAccess(client, 'write', 'govgw.consent', rows[0].consent_id);
        return { consentId: rows[0].consent_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.businessError) return res.status(409).json({ error: 'cannot_grant_consent', detail: result.businessError });
    return res.status(201).json({ consent_id: result.consentId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/consents/:id/revoke
 * Body: { revoked_by, reason }
 */
router.post('/gov/consents/:id/revoke', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { revoked_by: revokedBy, reason } = req.body || {};

  if (!revokedBy || !reason) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['revoked_by', 'reason'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertConsentOwned(client, subjectId, id))) return { consentNotFound: true };

      try {
        await client.query('SELECT govgw.revoke_consent($1, $2, $3)', [id, revokedBy, reason]);
        await logAccess(client, 'write', 'govgw.consent', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.consentNotFound) return res.status(404).json({ error: 'consent_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_revoke_consent', detail: result.businessError });
    return res.json({ status: 'Revoked' });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/gov/credentials — this cooperative's government API accounts.
 */
router.get('/gov/credentials', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT credential_id, endpoint_id, endpoint_name, agency_name, credential_label, status,
                requested_by, requested_at, activated_at, expires_at, last_rotated_at,
                revoked_by, revoked_at, revoke_reason, note, is_expiring_soon
           FROM govgw.v_credential_status
          WHERE org_id = $1
          ORDER BY requested_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/credentials — request a government API account for an
 * endpoint. Requires an Active consent on file for that endpoint (or a
 * blanket one) — enforced inside govgw.request_credential() itself.
 * Body: { endpoint_id, credential_label, requested_by }
 */
router.post('/gov/credentials', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { endpoint_id: endpointId, credential_label: credentialLabel, requested_by: requestedBy } = req.body || {};

  if (!endpointId || !credentialLabel || !requestedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['endpoint_id', 'credential_label', 'requested_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      try {
        const { rows } = await client.query(
          'SELECT govgw.request_credential($1, $2, $3, $4) AS credential_id',
          [subjectId, endpointId, credentialLabel, requestedBy],
        );
        await logAccess(client, 'write', 'govgw.credential', rows[0].credential_id);
        return { credentialId: rows[0].credential_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.businessError) return res.status(409).json({ error: 'cannot_request_credential', detail: result.businessError });
    return res.status(201).json({ credential_id: result.credentialId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/credentials/:id/activate
 * Body: { activated_by, expires_at }
 */
router.post('/gov/credentials/:id/activate', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { activated_by: activatedBy, expires_at: expiresAt } = req.body || {};

  if (!activatedBy || !expiresAt) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['activated_by', 'expires_at'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertCredentialOwned(client, subjectId, id))) return { credentialNotFound: true };

      try {
        await client.query('SELECT govgw.activate_credential($1, $2, $3)', [id, activatedBy, expiresAt]);
        await logAccess(client, 'write', 'govgw.credential', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.credentialNotFound) return res.status(404).json({ error: 'credential_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_activate_credential', detail: result.businessError });
    return res.json({ status: 'Active' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/credentials/:id/rotate
 * Body: { rotated_by, new_expires_at }
 */
router.post('/gov/credentials/:id/rotate', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { rotated_by: rotatedBy, new_expires_at: newExpiresAt } = req.body || {};

  if (!rotatedBy || !newExpiresAt) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['rotated_by', 'new_expires_at'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertCredentialOwned(client, subjectId, id))) return { credentialNotFound: true };

      try {
        await client.query('SELECT govgw.rotate_credential($1, $2, $3)', [id, rotatedBy, newExpiresAt]);
        await logAccess(client, 'write', 'govgw.credential', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.credentialNotFound) return res.status(404).json({ error: 'credential_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_rotate_credential', detail: result.businessError });
    return res.json({ status: 'Active' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/credentials/:id/revoke
 * Body: { revoked_by, reason }
 */
router.post('/gov/credentials/:id/revoke', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { revoked_by: revokedBy, reason } = req.body || {};

  if (!revokedBy || !reason) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['revoked_by', 'reason'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertCredentialOwned(client, subjectId, id))) return { credentialNotFound: true };

      try {
        await client.query('SELECT govgw.revoke_credential($1, $2, $3)', [id, revokedBy, reason]);
        await logAccess(client, 'write', 'govgw.credential', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.credentialNotFound) return res.status(404).json({ error: 'credential_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_revoke_credential', detail: result.businessError });
    return res.json({ status: 'Revoked' });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/gov/submissions — this cooperative's submission queue/history.
 */
router.get('/gov/submissions', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT submission_id, endpoint_id, endpoint_name, agency_name, period_label, status,
                max_attempts, attempt_count, created_by, created_at, last_attempted_at,
                acknowledged_at, ack_reference, last_error, cancelled_by, cancelled_at, cancel_reason,
                last_attempt_outcome, last_attempt_response_code, last_attempt_at
           FROM govgw.v_submission_summary
          WHERE org_id = $1
          ORDER BY created_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/gov/submissions/:id — submission detail + its full attempt
 * history + related audit-log entries.
 */
router.get('/gov/submissions/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const submission = await client.query(
        `SELECT submission_id, endpoint_id, endpoint_name, agency_name, period_label, payload, status,
                max_attempts, attempt_count, created_by, created_at, last_attempted_at,
                acknowledged_at, ack_reference, last_error, cancelled_by, cancelled_at, cancel_reason
           FROM govgw.v_submission_summary
          WHERE submission_id = $1 AND org_id = $2`,
        [id, subjectId],
      );
      if (submission.rows.length === 0) return null;

      const attempts = await client.query(
        `SELECT attempt_id, attempt_number, attempted_at, outcome, response_code, error_message, recorded_by
           FROM govgw.submission_attempt
          WHERE submission_id = $1
          ORDER BY attempt_number`,
        [id],
      );

      const auditLog = await client.query(
        `SELECT gov_audit_id, event_type, actor, detail, occurred_at
           FROM govgw.gov_audit_log
          WHERE related_table = 'govgw.data_submission' AND related_id = $1
          ORDER BY occurred_at`,
        [id],
      );

      return { submission: submission.rows[0], attempts: attempts.rows, audit_log: auditLog.rows };
    });

    if (!result) return res.status(404).json({ error: 'submission_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/submissions — queue a new submission. Requires an Active
 * consent AND a usable credential for the endpoint — enforced inside
 * govgw.create_submission() itself. `summary` is wrapped into the opaque
 * payload jsonb column (see the migration's header note on why there is
 * no real field-level government schema to map into yet).
 * Body: { endpoint_id, period_label, summary, created_by, max_attempts? }
 */
router.post('/gov/submissions', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    endpoint_id: endpointId, period_label: periodLabel, summary, created_by: createdBy, max_attempts: maxAttempts,
  } = req.body || {};

  if (!endpointId || !periodLabel || !summary || !createdBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['endpoint_id', 'period_label', 'summary', 'created_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      try {
        const payload = JSON.stringify({ summary });
        const { rows } = await client.query(
          'SELECT govgw.create_submission($1, $2, $3, $4::jsonb, $5, $6) AS submission_id',
          [subjectId, endpointId, periodLabel, payload, createdBy, maxAttempts || 3],
        );
        await logAccess(client, 'write', 'govgw.data_submission', rows[0].submission_id);
        return { submissionId: rows[0].submission_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.businessError) return res.status(409).json({ error: 'cannot_create_submission', detail: result.businessError });
    return res.status(201).json({ submission_id: result.submissionId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/submissions/:id/attempt — record the outcome of one
 * attempt to actually send this submission. See the migration's header
 * note: this endpoint does NOT itself call any real government system —
 * it records the outcome its caller reports, exactly like every other
 * "record what happened" action in this platform.
 * Body: { outcome: Success|Failure, response_code?, error_message?, recorded_by }
 */
router.post('/gov/submissions/:id/attempt', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const {
    outcome, response_code: responseCode, error_message: errorMessage, recorded_by: recordedBy,
  } = req.body || {};

  if (!outcome || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['outcome', 'recorded_by'] });
  }
  if (!SUBMISSION_OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: 'invalid_outcome', valid: SUBMISSION_OUTCOMES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertSubmissionOwned(client, subjectId, id))) return { submissionNotFound: true };

      try {
        const { rows } = await client.query(
          'SELECT govgw.attempt_submission($1, $2, $3, $4, $5) AS new_status',
          [id, outcome, responseCode || null, errorMessage || null, recordedBy],
        );
        await logAccess(client, 'write', 'govgw.data_submission', id);
        return { newStatus: rows[0].new_status };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.submissionNotFound) return res.status(404).json({ error: 'submission_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_attempt_submission', detail: result.businessError });
    return res.json({ status: result.newStatus });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/submissions/:id/acknowledge — record the government
 * side's confirmation reference once a Sent submission is acknowledged.
 * Body: { ack_reference, recorded_by }
 */
router.post('/gov/submissions/:id/acknowledge', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { ack_reference: ackReference, recorded_by: recordedBy } = req.body || {};

  if (!ackReference || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['ack_reference', 'recorded_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertSubmissionOwned(client, subjectId, id))) return { submissionNotFound: true };

      try {
        await client.query('SELECT govgw.record_acknowledgement($1, $2, $3)', [id, ackReference, recordedBy]);
        await logAccess(client, 'write', 'govgw.data_submission', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.submissionNotFound) return res.status(404).json({ error: 'submission_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_acknowledge_submission', detail: result.businessError });
    return res.json({ status: 'Acknowledged' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/submissions/:id/cancel — only works while Queued (never
 * successfully sent).
 * Body: { cancelled_by, reason }
 */
router.post('/gov/submissions/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { cancelled_by: cancelledBy, reason } = req.body || {};

  if (!cancelledBy || !reason) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['cancelled_by', 'reason'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertSubmissionOwned(client, subjectId, id))) return { submissionNotFound: true };

      try {
        await client.query('SELECT govgw.cancel_submission($1, $2, $3)', [id, cancelledBy, reason]);
        await logAccess(client, 'write', 'govgw.data_submission', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.submissionNotFound) return res.status(404).json({ error: 'submission_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_cancel_submission', detail: result.businessError });
    return res.json({ status: 'Cancelled' });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/gov/submissions/:id/requeue — manual ops recovery for a
 * Dead-lettered submission: raises max_attempts and puts it back in the
 * queue. Body: { additional_attempts, recorded_by }
 */
router.post('/gov/submissions/:id/requeue', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { additional_attempts: additionalAttempts, recorded_by: recordedBy } = req.body || {};

  if (!additionalAttempts || !recordedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['additional_attempts', 'recorded_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertSubmissionOwned(client, subjectId, id))) return { submissionNotFound: true };

      try {
        await client.query('SELECT govgw.retry_dead_letter($1, $2, $3)', [id, additionalAttempts, recordedBy]);
        await logAccess(client, 'write', 'govgw.data_submission', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.submissionNotFound) return res.status(404).json({ error: 'submission_not_found' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_requeue_submission', detail: result.businessError });
    return res.json({ status: 'Queued' });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/gov/dead-letter — this cooperative's Dead-lettered
 * submissions, the queryable "dead-letter queue" itself.
 */
router.get('/gov/dead-letter', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT submission_id, endpoint_id, endpoint_name, agency_name, period_label, status,
                max_attempts, attempt_count, created_by, created_at, last_attempted_at, last_error
           FROM govgw.v_dead_letter_queue
          WHERE org_id = $1
          ORDER BY last_attempted_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/gov/audit-log — this cooperative's government-gateway audit
 * trail (govgw.gov_audit_log — see the migration's header note on why
 * this is separate from audit.access_log).
 */
router.get('/gov/audit-log', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT gov_audit_id, event_type, related_table, related_id, actor, detail, occurred_at
           FROM govgw.gov_audit_log
          WHERE org_id = $1
          ORDER BY occurred_at DESC
          LIMIT 100`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * ============================================================================
 * M04 Cooperative Finance — a read-only KPI dashboard for cooperative
 * executives (Coop Manager/Accountant), built entirely on top of the
 * existing ledger/produce/warehouse data — no new money-movement logic
 * lives here. See grant_cooperative_finance_dashboard.sql for the full
 * design rationale, in particular why there is NO receivables figure (no
 * onward-sale/invoicing model exists yet for cooperatives — reporting a
 * number with nothing behind it would be fabricated data).
 * ============================================================================
 */

/**
 * GET /coop/finance/summary — headline KPI row via
 * reporting.coop_finance_summary(). A cooperative that was never activated
 * for settlement (see POST /admin/cooperatives/:id/activate-settlement)
 * gets cash_balance/cash_account_status = null — the frontend renders that
 * as "ยังไม่เปิดใช้งานบัญชีชำระเงิน" rather than treating it as a zero
 * balance (those are different situations).
 */
router.get('/finance/summary', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query('SELECT * FROM reporting.coop_finance_summary($1)', [subjectId]);
      await logAccess(client, 'read', 'reporting.coop_finance_summary', subjectId);
      return rows[0];
    });
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/finance/monthly — last 6 calendar months of collection/
 * settlement value, for a simple trend view. A one-off time-series query
 * kept out of the summary function since it returns multiple rows, not one.
 */
router.get('/finance/monthly', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT date_trunc('month', delivered_at) AS month,
                COUNT(*)::int AS delivery_count,
                COALESCE(SUM(total_amount), 0)::numeric AS collected_value,
                COALESCE(SUM(total_amount) FILTER (WHERE status = 'settled'), 0)::numeric AS settled_value
           FROM produce.delivery
          WHERE buyer_org_id = $1 AND delivered_at >= date_trunc('month', now()) - interval '5 months'
          GROUP BY 1
          ORDER BY 1`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/finance/transactions — the cooperative's own recent ledger
 * activity (most recent 50 lines across all of its ledger.account rows —
 * currently just vendor_settlement, but this stays correct if a
 * cooperative ever gets a second account type). Read-only, same
 * `WHERE ... owner_id = $1` scoping discipline as everywhere else — a
 * cooperative's ledger.account rows have no RLS either.
 */
router.get('/finance/transactions', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT jl.line_id, jl.direction, jl.amount, jl.currency,
                je.entry_type, je.description, je.reference_type, je.reference_id, je.posted_at,
                je.source_role_type
           FROM ledger.journal_line jl
           JOIN ledger.journal_entry je ON je.entry_id = jl.entry_id
           JOIN ledger.account a ON a.account_id = jl.account_id
          WHERE a.owner_id = $1
          ORDER BY je.posted_at DESC
          LIMIT 50`,
        [subjectId],
      );
      await logAccess(client, 'read', 'ledger.journal_line', subjectId);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/finance/revenue-by-function — cash in/out broken down by
 * `ledger.journal_entry.source_role_type` via `reporting.
 * coop_revenue_by_function()` — added 2026-08-17,
 * MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md §5.3a. See
 * grant_ledger_revenue_segregation.sql for the full audit of which of this
 * platform's money flows actually carry this tag today (only wholesale
 * produce sales via `procurement.pay_invoice()` — every other row still
 * comes back with `source_role_type: null`, which is a real, honest
 * "not yet attributed" bucket, not a bug). The frontend should render the
 * `null` row with its own label (e.g. "ยังไม่ระบุหน้าที่") rather than
 * hiding it, for the same reason the SQL function doesn't filter it out.
 */
router.get('/finance/revenue-by-function', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query('SELECT * FROM reporting.coop_revenue_by_function($1)', [subjectId]);
      await logAccess(client, 'read', 'reporting.coop_revenue_by_function', subjectId);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * ============================================================================
 * M01 Tenant Foundation, remaining piece — per-staff-member login. Lets a
 * Coop Admin create DISTINCT login accounts for their own people
 * (coop.manager/coop.accountant/coop.credit_officer/coop.member_officer/
 * coop.warehouse_officer/coop.admin) instead of everyone sharing the one
 * organization-level login this platform has used until now. See
 * grant_staff_and_government_access.sql for the full design rationale.
 *
 * Scope note: this is the LOGIN/IDENTITY primitive only. A staff member's
 * JWT carries subjectType='organization_member' with subjectId=member_id
 * (NOT org_id) — every OTHER route in this file still assumes subjectId
 * IS org_id (requireOrganization gates on subjectType==='organization'
 * specifically), so an organization_member token cannot yet call any of
 * the M09-M15 routes above. Retrofitting the entire existing coop.* route
 * surface to accept a second subject type and resolve it to the right
 * org_id is real future work — deliberately not attempted here. What DOES
 * work end-to-end today: a staff member can log in, see their own
 * profile, and every action taken while managing staff is individually
 * audit-logged (subject_type='organization_member', subject_id=member_id)
 * rather than blurring into the shared org identity.
 * ============================================================================
 */

// national_id_hash exists specifically so the raw national ID is never
// stored — only a one-way hash of it. Same convention (and same caveat
// about a real deployment needing a per-deployment pepper) as
// hashNationalId() in auth.js — duplicated here rather than imported,
// same one-line-helper-not-worth-coupling-files-together reasoning
// admin.js's own generateOrgAuthSubjectId() comment already gives.
function hashNationalId(nationalId) {
  return crypto.createHash('sha256').update(String(nationalId).trim()).digest('hex');
}

function generateStaffAuthSubjectId() {
  return `oidc|staff-${crypto.randomUUID()}`;
}

/**
 * GET /coop/staff/roles — the coop.* operational role catalog, read live
 * from identity.role rather than hard-coded client-side — same
 * config-drift lesson as the FACILITY_TYPES bug fixed in the M10/M11
 * section above (a hard-coded copy silently going stale when the DB's own
 * list changes).
 */
router.get('/staff/roles', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT role_code, description FROM identity.role WHERE role_code LIKE 'coop.%' ORDER BY role_code`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/staff — this cooperative's staff login accounts (eKYB-only
 * signatory/representative rows with no auth_subject_id are excluded —
 * this list is specifically about who can log in).
 */
router.get('/staff', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT m.member_id, m.full_name, m.status, m.created_at, sr.role_code, r.description AS role_description
           FROM identity.organization_member m
           LEFT JOIN identity.subject_role sr ON sr.subject_type = 'organization_member' AND sr.subject_id = m.member_id
           LEFT JOIN identity.role r ON r.role_code = sr.role_code
          WHERE m.org_id = $1 AND m.auth_subject_id IS NOT NULL
          ORDER BY m.created_at DESC`,
        [subjectId],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/staff — create a new staff login account.
 * Body: { full_name, national_id, role_code, created_by }
 * Returns auth_subject_id — the Coop Admin relays this to the staff
 * member out-of-band (same pattern as POST /admin/cooperatives returning
 * the cooperative's own auth_subject_id for Platform Ops to relay).
 */
router.post('/staff', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    full_name: fullName, national_id: nationalId, role_code: roleCode, created_by: createdBy,
  } = req.body || {};

  if (!fullName || !nationalId || !roleCode || !createdBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['full_name', 'national_id', 'role_code', 'created_by'] });
  }

  const nationalIdHash = hashNationalId(nationalId);
  const authSubjectId = generateStaffAuthSubjectId();

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      try {
        const { rows } = await client.query(
          'SELECT identity.register_staff_member($1, $2, $3, $4, $5, $6) AS member_id',
          [subjectId, fullName, nationalIdHash, authSubjectId, roleCode, createdBy],
        );
        await logAccess(client, 'write', 'identity.organization_member', rows[0].member_id);
        return { memberId: rows[0].member_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.businessError) return res.status(409).json({ error: 'cannot_create_staff_member', detail: result.businessError });
    return res.status(201).json({ member_id: result.memberId, auth_subject_id: authSubjectId });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'subject_claim_collision' });
    return next(err);
  }
});

/**
 * POST /coop/staff/:id/deactivate — revokes login (audit trail is kept).
 */
router.post('/staff/:id/deactivate', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        'SELECT member_id FROM identity.organization_member WHERE member_id = $1 AND org_id = $2',
        [id, subjectId],
      );
      if (owned.rows.length === 0) return { staffNotFound: true };

      await client.query('SELECT identity.deactivate_staff_member($1)', [id]);
      await logAccess(client, 'write', 'identity.organization_member', id);
      return { ok: true };
    });

    if (result.staffNotFound) return res.status(404).json({ error: 'staff_not_found' });
    return res.json({ status: 'Inactive' });
  } catch (err) {
    return next(err);
  }
});

// ============================================================================
// M01 — object storage: cooperative registration document. The generic
// upload lives at POST /storage/upload (src/routes/storage.js, purpose=
// 'cooperative_registration_document') — the frontend calls that FIRST to
// get a file_id, then calls POST /coop/registration-document/link below to
// actually attach it to this cooperative's profile. Two calls rather than
// one so /storage/upload stays a domain-agnostic primitive any future
// module can reuse without coopcollection.js needing to know about them
// (see grant_object_storage.sql's header comment for the full rationale).
// ============================================================================
const REGISTRATION_DOCUMENT_PURPOSE = 'cooperative_registration_document';

/**
 * GET /coop/registration-document — metadata of the document currently on
 * file (via a join through storage.file_object), or { file: null } if none
 * has been uploaded yet. Never returns the file bytes themselves — the
 * frontend fetches those from GET /storage/:id separately, same ownership
 * check applying there.
 */
router.get('/registration-document', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.file_id, f.original_filename, f.content_type, f.byte_size, f.uploaded_by, f.created_at
           FROM registry.cooperative_profile cp
           JOIN storage.file_object f ON f.file_id = cp.registration_document_file_id
          WHERE cp.org_id = $1`,
        [subjectId],
      );
      return rows[0] || null;
    });
    return res.json({ file: result });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/registration-document/link
 * Body: { file_id } — must be a file this SAME organization already
 * uploaded via POST /storage/upload with purpose='cooperative_registration_
 * document'. Rejects any other file_id (wrong owner, wrong purpose, or
 * doesn't exist) rather than trusting the caller — same "route validates
 * ownership, trusts nothing about the ID it was handed" convention used
 * everywhere else in this codebase.
 */
router.post('/registration-document/link', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { file_id: fileId } = req.body || {};
  if (!fileId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['file_id'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const file = await client.query(
        `SELECT file_id FROM storage.file_object
          WHERE file_id = $1 AND owner_subject_type = 'organization' AND owner_subject_id = $2 AND purpose = $3`,
        [fileId, subjectId, REGISTRATION_DOCUMENT_PURPOSE],
      );
      if (file.rows.length === 0) return { fileNotFound: true };

      await client.query(
        'UPDATE registry.cooperative_profile SET registration_document_file_id = $1, updated_at = now() WHERE org_id = $2',
        [fileId, subjectId],
      );
      await logAccess(client, 'write', 'registry.cooperative_profile', subjectId);
      return { ok: true };
    });

    if (result.fileNotFound) return res.status(404).json({ error: 'uploaded_file_not_found_for_this_cooperative' });
    return res.json({ status: 'linked', file_id: fileId });
  } catch (err) {
    return next(err);
  }
});

/**
 * M14.1 Cooperative produce/processed-goods catalog — reuses the
 * InputSupplier product-catalog machinery (marketplace.product_listing /
 * product_photo / product_order, see src/routes/inputsupplier.js) instead
 * of a bespoke table set, per an explicit user request to have the
 * cooperative "use this same catalog." See grant_cooperative_product_
 * catalog.sql for the two schema changes that made this possible: widened
 * category CHECK constraints, and product_order.farmer_id becoming
 * nullable alongside a new buyer_org_id (exactly one of the two set).
 *
 * The buyer-facing counterpart (browse + place order) lives in buyer.js as
 * GET/POST /buyer/coop-products* — this file only has the seller side
 * (list management + deciding on incoming orders), same split as
 * inputsupplier.js (seller) / farmer.js (buyer) for the InputSupplier
 * catalog.
 *
 * IMPORTANT: marketplace.product_listing/product_photo/product_order have
 * NO row-level security (same situation as every other marketplace.*
 * table — see the note at the top of src/routes/machinery.js). Every
 * query below MUST include an explicit `WHERE org_id = $1` — this is the
 * entire security boundary, not defense-in-depth.
 */
const COOP_PRODUCT_CATEGORIES = ['produce', 'processed_good', 'other'];
const COOP_MAX_PHOTO_DATA_URL_LENGTH = 4 * 1024 * 1024;

/**
 * marketplace.product_listing.org_id REFERENCES partner.vendor_profile
 * (org_id) — a cooperative provisioned via POST /admin/cooperatives does
 * NOT get a vendor_profile row automatically (see the doc comment on
 * POST /admin/cooperatives/:id/activate-settlement in admin.js, which
 * exists for the exact same FK gap for a different reason — M09
 * settlement). Rather than forcing every cooperative through that
 * settlement-activation endpoint before it can even list a product, this
 * helper provisions an idempotent vendor_profile row inline the first
 * time a cooperative creates a listing. Reuses an existing row if one
 * already exists (e.g. because the coop already settled a buyer delivery
 * before) instead of erroring.
 */
async function ensureVendorProfile(client, orgId) {
  const existing = await client.query('SELECT org_id FROM partner.vendor_profile WHERE org_id = $1', [orgId]);
  if (existing.rows.length > 0) return;
  const org = await client.query('SELECT tax_id FROM identity.organization WHERE org_id = $1', [orgId]);
  await client.query(
    `INSERT INTO partner.vendor_profile (org_id, business_registration_no)
     VALUES ($1, $2)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId, org.rows[0].tax_id],
  );
}

/**
 * GET /coop/products?category= — this cooperative's own catalog rows
 * (active and inactive alike — the seller needs to see deactivated
 * products too, unlike the buyer-facing browse route which only shows
 * is_active = true). Mirrors GET /inputsupplier/products exactly.
 */
router.get('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { category } = req.query;

  if (category && !COOP_PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: COOP_PRODUCT_CATEGORIES });
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
        `SELECT listing_id, category, product_name, brand, description, unit_price, price_unit,
                is_active, is_featured, featured_until, created_at, updated_at
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
 * POST /coop/products
 * Body: { category, product_name, brand?, description?, unit_price, price_unit? }
 * category is restricted server-side to COOP_PRODUCT_CATEGORIES
 * ('produce' / 'processed_good' / 'other') — the DB CHECK constraint is
 * the union across both InputSupplier and Cooperative sellers (see
 * grant_cooperative_product_catalog.sql), so this application-level check
 * is what actually stops a cooperative from listing something under
 * 'fertilizer_hormone', not the database.
 */
router.post('/products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    category, product_name: productName, brand, description,
    unit_price: unitPrice, price_unit: priceUnit,
  } = req.body || {};

  if (!category || !COOP_PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: COOP_PRODUCT_CATEGORIES });
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
      await ensureVendorProfile(client, subjectId);
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
 * PUT /coop/products/:id
 * Body: any of { category, product_name, brand, description, unit_price, price_unit, is_active }
 * Same ownership-gated update shape as PUT /inputsupplier/products/:id.
 */
router.put('/products/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const {
    category, product_name: productName, brand, description,
    unit_price: unitPrice, price_unit: priceUnit, is_active: isActive,
  } = req.body || {};

  if (category !== undefined && !COOP_PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: COOP_PRODUCT_CATEGORIES });
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
 * DELETE /coop/products/:id — deactivate-only, same reasoning as
 * DELETE /inputsupplier/products/:id (marketplace.product_order can
 * reference a listing_id, so a hard delete would orphan any order already
 * placed against it). Removes it from GET /buyer/coop-products
 * (is_active = true only) without touching order history.
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
 * GET /coop/products/:id/photos
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
 * POST /coop/products/:id/photos
 * Body: { photo_data_url, caption? }
 */
router.post('/products/:id/photos', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { photo_data_url: photoDataUrl, caption } = req.body || {};

  if (!photoDataUrl || typeof photoDataUrl !== 'string' || !photoDataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'invalid_photo_data_url' });
  }
  if (photoDataUrl.length > COOP_MAX_PHOTO_DATA_URL_LENGTH) {
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
 * DELETE /coop/products/:id/photos/:photoId
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
 * GET /coop/products/orders?status=... — orders placed by BUYER orgs
 * against this cooperative's catalog. Joined with the ordering buyer's
 * org_name (buyer_org_id, not farmer_id — see grant_cooperative_product_
 * catalog.sql's orderer_check). `status` accepts the same
 * `action_needed` shorthand (`requested` + `confirmed`) as
 * GET /inputsupplier/orders.
 */
router.get('/products/orders', async (req, res, next) => {
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
                o.requested_at, o.decided_at, o.fulfilled_at, o.buyer_org_id, bo.org_name AS buyer_org_name
           FROM marketplace.product_order o
           JOIN identity.organization bo ON bo.org_id = o.buyer_org_id
          WHERE o.org_id = $1 AND o.buyer_org_id IS NOT NULL ${filter}
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
 * GET /coop/products/orders/:id — single order detail.
 */
router.get('/products/orders/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT o.order_id, o.listing_id, o.product_name, o.category, o.unit_price,
                o.price_unit, o.quantity, o.total_price, o.status, o.decided_reason,
                o.requested_at, o.decided_at, o.fulfilled_at, o.buyer_org_id, bo.org_name AS buyer_org_name
           FROM marketplace.product_order o
           JOIN identity.organization bo ON bo.org_id = o.buyer_org_id
          WHERE o.org_id = $1 AND o.order_id = $2 AND o.buyer_org_id IS NOT NULL`,
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
 * POST /coop/products/orders/:id/confirm — requested -> confirmed.
 * Same ownership-gate + status-guard shape as
 * POST /inputsupplier/orders/:id/confirm. The explicit
 * `AND buyer_org_id IS NOT NULL` on every query in this section makes
 * sure a cooperative can only ever act on orders placed by a BUYER org
 * against ITS OWN catalog — never a farmer's InputSupplier order that
 * happens to share the same org_id column shape.
 */
router.post('/products/orders/:id/confirm', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE org_id = $1 AND order_id = $2 AND buyer_org_id IS NOT NULL',
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
 * POST /coop/products/orders/:id/reject
 * Body: { reason? } — requested -> rejected.
 */
router.post('/products/orders/:id/reject', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { reason } = req.body || {};
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE org_id = $1 AND order_id = $2 AND buyer_org_id IS NOT NULL',
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
 * POST /coop/products/orders/:id/fulfill — confirmed -> fulfilled.
 */
router.post('/products/orders/:id/fulfill', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE org_id = $1 AND order_id = $2 AND buyer_org_id IS NOT NULL',
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


// ============================================================================
// ระบบเติมทุนหมุนเวียนสหกรณ์ (Cooperative Working Capital Top-Up) — 2026-08-27
// ต่อยอดจากเอกสารออกแบบ "AgroLink Cooperative Credit Scoring And Monitoring
// System Design" — ดูหมายเหตุขอบเขตทั้งหมดที่หัวไฟล์
// backend/db/grant_cooperative_working_capital_topup.sql การอนุมัติ/ปฏิเสธ
// คำขอวงเงินและการประเมินธรรมาภิบาลอยู่ในสิทธิ์ของแอดมินเท่านั้น (ดู admin.js)
// — สหกรณ์ทำได้แค่ยื่นคำขอ/ถอนคำขอของตัวเอง และบันทึกการเบิก-คืนวงเงินที่อนุมัติ
// แล้วเท่านั้น เพื่อไม่ให้สหกรณ์รับรองวงเงินภายนอกของตัวเองได้ฝ่ายเดียว
// ============================================================================

/**
 * GET /coop/capital-topup/score — AgroLink Cooperative Credit Score แบบ
 * เรียลไทม์ (คำนวณสดทุกครั้ง ไม่มี cache) พร้อมปัจจัยย่อย 5 ตัวและเหตุผล
 * ประกอบที่อธิบายได้ (ดู credit.compute_cooperative_credit_score())
 */
router.get('/capital-topup/score', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query('SELECT * FROM credit.compute_cooperative_credit_score($1)', [subjectId]);
      return rows[0];
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/capital-topup/funding-sources — ไดเรกทอรีแหล่งทุนภายนอกที่ยื่น
 * ขอวงเงินได้ (อ่านอย่างเดียว — แอดมินเป็นผู้ดูแลรายชื่อ)
 */
router.get('/capital-topup/funding-sources', async (req, res, next) => {
  try {
    const result = await withSessionContext('organization', req.subject.subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT funding_source_id, source_name, source_type, contact_note
           FROM credit.external_funding_source WHERE is_active = true ORDER BY source_type, source_name`,
      );
      return rows;
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/capital-topup/applications — คำขอวงเงินทั้งหมดที่สหกรณ์นี้เคยยื่น
 */
router.get('/capital-topup/applications', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.application_id, a.purpose, a.amount_requested, a.term_months, a.purpose_note,
                a.status, a.approved_amount, a.approved_interest_rate_daily_bps, a.approved_tenor_months,
                a.decision_note, a.submitted_at, a.decided_at,
                s.source_name, s.source_type,
                sc.score AS score_at_submission, sc.grade AS grade_at_submission
           FROM credit.cooperative_funding_application a
           JOIN credit.external_funding_source s ON s.funding_source_id = a.funding_source_id
           LEFT JOIN credit.cooperative_credit_score_snapshot sc ON sc.snapshot_id = a.score_snapshot_id
          WHERE a.org_id = $1
          ORDER BY a.submitted_at DESC`,
        [subjectId],
      );
      return rows;
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/capital-topup/applications — ยื่นคำขอวงเงินใหม่ไปยังแหล่งทุน
 * ภายนอกหนึ่งราย (ยื่นได้หลายรายพร้อมกัน — เรียกซ้ำได้หลายครั้งคนละแหล่งทุน)
 */
router.post('/capital-topup/applications', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { funding_source_id: fundingSourceId, purpose, amount_requested: amountRequested, term_months: termMonths, purpose_note: purposeNote } = req.body || {};
  if (!fundingSourceId || !['member_onlending', 'procurement_working_capital'].includes(purpose)
    || !(Number(amountRequested) > 0) || !(Number(termMonths) > 0)) {
    return res.status(400).json({ error: 'invalid_application_input' });
  }
  try {
    const applicationId = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT credit.submit_funding_application($1, $2, $3, $4, $5, $6) AS application_id',
        [subjectId, fundingSourceId, purpose, amountRequested, termMonths, purposeNote || null],
      );
      await logAccess(client, 'write', 'credit.cooperative_funding_application', rows[0].application_id);
      return rows[0].application_id;
    });
    return res.status(201).json({ application_id: applicationId });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/capital-topup/applications/:id/withdraw — ถอนคำขอของตัวเอง
 * (ทำได้เฉพาะตอนยังไม่มีผลการพิจารณา — Submitted/UnderReview เท่านั้น)
 */
router.post('/capital-topup/applications/:id/withdraw', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE credit.cooperative_funding_application
            SET status = 'Withdrawn', updated_at = now()
          WHERE application_id = $1 AND org_id = $2 AND status IN ('Submitted', 'UnderReview')
          RETURNING application_id`,
        [id, subjectId],
      );
      return rows[0] || null;
    });
    if (!result) {
      return res.status(409).json({ error: 'application_not_withdrawable' });
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/capital-topup/facilities — วงเงินภายนอกที่อนุมัติแล้วทั้งหมด
 * พร้อมยอดใช้ไป/คงเหลือ (รวมทั้งสองวัตถุประสงค์)
 */
router.get('/capital-topup/facilities', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.facility_id, f.purpose, f.facility_limit, f.interest_rate_daily_bps, f.tenor_months,
                f.status, f.opened_at, f.closed_at, s.source_name, s.source_type,
                COALESCE((
                  SELECT SUM(d.drawn_amount - d.repaid_amount) FROM credit.cooperative_procurement_drawdown d
                   WHERE d.facility_id = f.facility_id AND d.status = 'outstanding'
                ), 0) + COALESCE((
                  SELECT SUM(cd.principal_amount) FROM credit.credit_line cl
                    JOIN credit.credit_drawdown cd ON cd.credit_line_id = cl.credit_line_id
                   WHERE cl.funding_facility_id = f.facility_id AND cd.status = 'outstanding'
                ), 0) AS drawn_outstanding
           FROM credit.cooperative_funding_facility f
           JOIN credit.external_funding_source s ON s.funding_source_id = f.funding_source_id
          WHERE f.org_id = $1
          ORDER BY f.opened_at DESC`,
        [subjectId],
      );
      return rows;
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/capital-topup/facilities/:id/member-onlending — Roll-up Report
 * สำหรับวงเงินประเภทปล่อยกู้ต่อสมาชิก (เอกสารออกแบบ §7.1) — ใช้ credit_line/
 * credit_drawdown เดิมที่ตั้ง funding_facility_id ชี้มาที่วงเงินนี้ ไม่เปิดเผย
 * ชื่อสมาชิกรายบุคคลเกินจำเป็น (แสดงเฉพาะรหัสวงเงินและยอด)
 */
router.get('/capital-topup/facilities/:id/member-onlending', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const facility = await client.query(
        `SELECT facility_id FROM credit.cooperative_funding_facility WHERE facility_id = $1 AND org_id = $2 AND purpose = 'member_onlending'`,
        [id, subjectId],
      );
      if (facility.rows.length === 0) return { notFound: true };

      const { rows } = await client.query(
        `SELECT cl.credit_line_id, cl.credit_limit, cl.status AS line_status,
                COUNT(cd.drawdown_id)::int AS drawdown_count,
                COALESCE(SUM(cd.principal_amount) FILTER (WHERE cd.status = 'outstanding'), 0) AS outstanding_amount,
                COALESCE(SUM(cd.principal_amount) FILTER (WHERE cd.status = 'repaid'), 0) AS repaid_amount
           FROM credit.credit_line cl
           LEFT JOIN credit.credit_drawdown cd ON cd.credit_line_id = cl.credit_line_id
          WHERE cl.funding_facility_id = $1
          GROUP BY cl.credit_line_id, cl.credit_limit, cl.status
          ORDER BY cl.created_at DESC`,
        [id],
      );
      return { lines: rows };
    });
    if (result.notFound) {
      return res.status(404).json({ error: 'facility_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/capital-topup/eligible-lots — ล็อตผลผลิตของสหกรณ์นี้ที่ยังไม่เคย
 * เบิกวงเงินทุนหมุนเวียน (ใช้เลือกตอนกดเบิกวงเงินสำหรับล็อตใหม่)
 */
router.get('/capital-topup/eligible-lots', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `SELECT l.lot_id, l.commodity_code, l.quality_grade, l.status, l.created_at,
                COALESCE(SUM(d.total_amount) FILTER (WHERE d.status IN ('accepted','settled')), 0) AS lot_value
           FROM produce.lot l
           LEFT JOIN produce.delivery d ON d.lot_id = l.lot_id
          WHERE l.buyer_org_id = $1
            AND NOT EXISTS (SELECT 1 FROM credit.cooperative_procurement_drawdown pd WHERE pd.lot_id = l.lot_id)
          GROUP BY l.lot_id, l.commodity_code, l.quality_grade, l.status, l.created_at
         HAVING COALESCE(SUM(d.total_amount) FILTER (WHERE d.status IN ('accepted','settled')), 0) > 0
          ORDER BY l.created_at DESC`,
        [subjectId],
      );
      return rows;
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/capital-topup/facilities/:id/lots — ล็อตที่เบิกวงเงินไปแล้วภายใต้
 * วงเงินทุนหมุนเวียนรับซื้อผลผลิตนี้ พร้อมอายุการค้างสต๊อกจริง (วันนี้ - วันที่
 * เบิก) และสัญญาณราคาตกเทียบราคารับซื้อเฉลี่ยของตลาดปัจจุบัน (เอกสารออกแบบ
 * §7.2 ข้อ 3 และ 5)
 */
router.get('/capital-topup/facilities/:id/lots', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const staleDaysThreshold = Number(req.query.stale_days_threshold) > 0 ? Number(req.query.stale_days_threshold) : 45;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const facility = await client.query(
        `SELECT facility_id FROM credit.cooperative_funding_facility WHERE facility_id = $1 AND org_id = $2 AND purpose = 'procurement_working_capital'`,
        [id, subjectId],
      );
      if (facility.rows.length === 0) return { notFound: true };

      const { rows } = await client.query(
        `SELECT pd.drawdown_id, pd.lot_id, pd.drawn_amount, pd.repaid_amount, pd.status,
                pd.drawn_at, pd.first_repaid_at, pd.fully_repaid_at,
                l.commodity_code, l.quality_grade,
                GREATEST(0, EXTRACT(DAY FROM (now() - pd.drawn_at))::int) AS days_held,
                del.avg_purchase_unit_price,
                mkt.avg_market_price
           FROM credit.cooperative_procurement_drawdown pd
           JOIN produce.lot l ON l.lot_id = pd.lot_id
           LEFT JOIN LATERAL (
             SELECT AVG(d.unit_price) AS avg_purchase_unit_price
               FROM produce.delivery d
              WHERE d.lot_id = pd.lot_id AND d.status IN ('accepted', 'settled')
           ) del ON true
           LEFT JOIN LATERAL (
             SELECT AVG(q.quoted_price) AS avg_market_price
               FROM marketplace.buy_price_quote q
              WHERE q.grade_code = l.quality_grade AND q.is_active = true
           ) mkt ON true
          WHERE pd.facility_id = $1
          ORDER BY pd.drawn_at DESC`,
        [id],
      );

      const lots = rows.map((r) => ({
        ...r,
        is_stale: r.status === 'outstanding' && r.days_held >= staleDaysThreshold,
        is_price_drop: r.status === 'outstanding' && r.avg_market_price !== null
          && Number(r.avg_market_price) < Number(r.avg_purchase_unit_price),
      }));
      return { lots, stale_days_threshold: staleDaysThreshold };
    });
    if (result.notFound) {
      return res.status(404).json({ error: 'facility_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/capital-topup/facilities/:id/lots/:lotId/draw — เบิกวงเงินสำหรับ
 * ล็อตที่รับซื้อจริงแล้ว (จำนวนเงินคำนวณอัตโนมัติจากยอดส่งมอบจริงในล็อตนั้น)
 */
router.post('/capital-topup/facilities/:id/lots/:lotId/draw', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id, lotId } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const facility = await client.query(
        'SELECT facility_id FROM credit.cooperative_funding_facility WHERE facility_id = $1 AND org_id = $2',
        [id, subjectId],
      );
      if (facility.rows.length === 0) return { notFound: true };

      const { rows } = await client.query(
        'SELECT credit.draw_procurement_facility_for_lot($1, $2) AS drawdown_id',
        [id, lotId],
      );
      await logAccess(client, 'write', 'credit.cooperative_procurement_drawdown', rows[0].drawdown_id);
      return { drawdown_id: rows[0].drawdown_id };
    });
    if (result.notFound) {
      return res.status(404).json({ error: 'facility_not_found' });
    }
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /coop/capital-topup/drawdowns/:drawdownId/repay — บันทึกยอดคืนวงเงิน
 * (บางส่วน/เต็มจำนวน) เมื่อขายผลผลิตในล็อตนั้นได้จริง
 */
router.post('/capital-topup/drawdowns/:drawdownId/repay', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { drawdownId } = req.params;
  const { amount } = req.body || {};
  if (!(Number(amount) > 0)) {
    return res.status(400).json({ error: 'invalid_repay_amount' });
  }
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const owned = await client.query(
        `SELECT pd.drawdown_id FROM credit.cooperative_procurement_drawdown pd
           JOIN credit.cooperative_funding_facility f ON f.facility_id = pd.facility_id
          WHERE pd.drawdown_id = $1 AND f.org_id = $2`,
        [drawdownId, subjectId],
      );
      if (owned.rows.length === 0) return { notFound: true };

      await client.query('SELECT credit.repay_procurement_drawdown($1, $2)', [drawdownId, amount]);
      await logAccess(client, 'write', 'credit.cooperative_procurement_drawdown', drawdownId);
      return { ok: true };
    });
    if (result.notFound) {
      return res.status(404).json({ error: 'drawdown_not_found' });
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/capital-topup/governance — สถานะการประเมินธรรมาภิบาลของสหกรณ์
 * นี้ (อ่านอย่างเดียว — แอดมินเท่านั้นที่บันทึกผลได้ ดู admin.js เพื่อป้องกัน
 * การรับรองตัวเอง)
 */
router.get('/capital-topup/governance', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT no_material_findings, notes, assessed_by, assessed_at FROM credit.cooperative_governance_assessment WHERE org_id = $1',
        [subjectId],
      );
      return rows[0] || null;
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});


// ============================================================
// แค็ตตาล็อกปัจจัยการผลิต (Input Product Catalog) — เรียกดู/สั่งซื้อจากผู้
// จำหน่ายปัจจัยการผลิต (InputSupplier) — 2026-08-27
// ใช้โครงสร้างเดิมทั้งหมด (marketplace.product_listing / product_order)
// แบบเดียวกับ GET /buyer/coop-products* ใน buyer.js — สหกรณ์ในบทบาทนี้เป็น
// แค่ "ผู้ซื้อ" อีกประเภทหนึ่งของ marketplace.product_order.buyer_org_id
// ซึ่งเป็น FK ทั่วไปไปยัง identity.organization ไม่จำกัด org_type ในระดับ
// ฐานข้อมูล — ฝั่งแอปพลิเคชันเป็นผู้กำหนดว่าใครซื้อจากใครได้ผ่าน org_type
// filter ในแต่ละเส้นทาง (ดู GET /farmer/products และ GET /buyer/coop-
// products สำหรับอีกสองทิศทางที่มีอยู่แล้ว) ไม่ต้องเพิ่มตาราง/คอลัมน์ใหม่
// เลยในฟีเจอร์นี้ — สหกรณ์ยังไม่ใช่ผู้ให้กู้/ผู้ชำระเงินแทนสมาชิก การชำระเงิน
// เป็นเรื่องระหว่างสหกรณ์กับผู้จำหน่ายปัจจัยการผลิตโดยตรง (payment_status
// เริ่มที่ 'unpaid' เหมือนคำสั่งซื้อทุกประเภท ยังไม่เชื่อมช่องทางชำระเงินจริง)
// ============================================================
const INPUT_PRODUCT_CATEGORIES = ['fertilizer_hormone', 'chemical_pesticide', 'equipment', 'other'];

/**
 * GET /coop/input-suppliers — ผู้จำหน่ายปัจจัยการผลิต (InputSupplier) ที่
 * ผ่าน KYB แล้วทุกราย พร้อมจำนวนสินค้าที่ยังเปิดขายอยู่ — มิเรอร์ GET
 * /farmer/input-suppliers ทุกประการ (ดูฟังก์ชันนั้นสำหรับที่มาของดีไซน์)
 */
router.get('/input-suppliers', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT o.org_id, o.org_name, COUNT(p.listing_id) FILTER (WHERE p.is_active) AS active_product_count
           FROM identity.organization o
           JOIN identity.organization_role r ON r.org_id = o.org_id AND r.role_type = 'InputSupplier' AND r.status = 'Verified'
           LEFT JOIN marketplace.product_listing p ON p.org_id = o.org_id
          WHERE o.kyb_status = 'Verified'
          GROUP BY o.org_id, o.org_name
          ORDER BY o.org_name`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /coop/input-products?category=&org_id= — เรียกดูแค็ตตาล็อกที่เปิดขาย
 * อยู่ (is_active=true) ของผู้จำหน่ายปัจจัยการผลิตทุกราย (หรือรายเดียวผ่าน
 * org_id) — มิเรอร์ GET /buyer/coop-products ทุกประการ ยกเว้นกรอง
 * org_type='InputSupplier' แทน 'Cooperative' (คนละทิศทางการซื้อขายกัน)
 */
router.get('/input-products', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { category, org_id: orgId } = req.query;

  if (category && !INPUT_PRODUCT_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: 'invalid_category', valid: INPUT_PRODUCT_CATEGORIES });
  }

  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [];
      const filters = ['p.is_active = true', "o.org_type = 'InputSupplier'"];
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
 * POST /coop/input-products/orders
 * Body: { listing_id, quantity }
 * บันทึกราคา/ชื่อ/หมวดหมู่ ณ วินาทีที่สั่งซื้อลงใน marketplace.product_order
 * โดยตรง (เหมือน POST /buyer/coop-products/orders) — buyer_org_id เป็น
 * req.subject เสมอ ไม่รับจาก body, farmer_id ปล่อยเป็น NULL (CHECK
 * constraint ของตารางบังคับให้ตั้งค่าอย่างใดอย่างหนึ่งเท่านั้น)
 */
router.post('/input-products/orders', async (req, res, next) => {
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
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const listing = await client.query(
        `SELECT p.listing_id, p.org_id, p.category, p.product_name, p.unit_price, p.price_unit
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
          WHERE p.listing_id = $1 AND p.is_active = true AND o.org_type = 'InputSupplier'`,
        [listingId],
      );
      if (listing.rows.length === 0) return { listingNotFound: true };
      const l = listing.rows[0];
      const totalPrice = Math.round(qty * Number(l.unit_price) * 100) / 100;

      const { rows } = await client.query(
        `INSERT INTO marketplace.product_order
           (listing_id, org_id, buyer_org_id, product_name, category, unit_price, price_unit, quantity, total_price)
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
 * GET /coop/input-products/orders?status=... — ประวัติคำสั่งซื้อของสหกรณ์
 * นี้ทั้งหมด ข้ามผู้จำหน่ายทุกราย
 */
router.get('/input-products/orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status) { params.push(status); filter = 'AND o.status = $2'; }

      const result = await client.query(
        `SELECT o.order_id, o.org_id, supplier.org_name AS supplier_org_name, o.product_name, o.category,
                o.unit_price, o.price_unit, o.quantity, o.total_price, o.status, o.decided_reason,
                o.payment_status, o.requested_at, o.decided_at, o.fulfilled_at
           FROM marketplace.product_order o
           JOIN identity.organization supplier ON supplier.org_id = o.org_id
          WHERE o.buyer_org_id = $1 ${filter}
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
 * POST /coop/input-products/orders/:id/cancel — ยกเลิกคำสั่งซื้อของตัวเอง
 * ได้เฉพาะตอนยังเป็นสถานะ requested เท่านั้น (ก่อนผู้จำหน่ายตอบรับ) — กติกา
 * เดียวกับ POST /farmer/orders/:id/cancel และ POST /buyer/coop-products/
 * orders/:id/cancel
 */
router.post('/input-products/orders/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.product_order WHERE buyer_org_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.product_order
            SET status = 'cancelled', updated_at = now()
          WHERE buyer_org_id = $1 AND order_id = $2
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
      return res.status(409).json({ error: 'order_not_requested', current_status: result.wrongStatus });
    }
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});


module.exports = router;
