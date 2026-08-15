const express = require('express');

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
 * GET /coop/logistics/carriers — this cooperative's transport providers,
 * each with its vehicle count.
 */
router.get('/logistics/carriers', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT c.carrier_id, c.carrier_name, c.carrier_type, c.contact_phone, c.status, c.created_at,
                COUNT(v.vehicle_id)::int AS vehicle_count
           FROM logistics.carrier c
           LEFT JOIN logistics.vehicle v ON v.carrier_id = c.carrier_id
          WHERE c.org_id = $1
          GROUP BY c.carrier_id
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
 * Body: { carrier_name, carrier_type: Internal|ThirdParty, contact_phone? }
 */
router.post('/logistics/carriers', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { carrier_name: carrierName, carrier_type: carrierType, contact_phone: contactPhone } = req.body || {};

  if (!carrierName || !carrierType) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['carrier_name', 'carrier_type'] });
  }
  if (!CARRIER_TYPES.includes(carrierType)) {
    return res.status(400).json({ error: 'invalid_carrier_type', valid: CARRIER_TYPES });
  }

  try {
    const carrierId = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT logistics.create_carrier($1, $2, $3, $4) AS carrier_id',
        [subjectId, carrierName, carrierType, contactPhone || null],
      );
      await logAccess(client, 'write', 'logistics.carrier', rows[0].carrier_id);
      return rows[0].carrier_id;
    });
    return res.status(201).json({ carrier_id: carrierId });
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
        'SELECT carrier_id, carrier_name, carrier_type, contact_phone, status, created_at FROM logistics.carrier WHERE carrier_id = $1 AND org_id = $2',
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
                je.entry_type, je.description, je.reference_type, je.reference_id, je.posted_at
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

module.exports = router;
