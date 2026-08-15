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

module.exports = router;
