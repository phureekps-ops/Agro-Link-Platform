const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT. requireOrganization
// runs after requireAuth so req.subject is guaranteed populated first.
router.use(requireAuth, requireOrganization);

/**
 * Confirms the authenticated organization is actually a Buyer (as opposed
 * to a Lender, Mill, InputSupplier, etc. — all of which also authenticate
 * as subjectType='organization'). Same pattern as requireLenderOrg in
 * lender.js. identity.organization has no RLS (it's a shared directory),
 * so this is a plain lookup under a valid session context.
 *
 * Also gates on kyb_status === 'Verified' — see the matching comment on
 * requireLenderOrg in lender.js for why this is now necessary (self-service
 * org registration via POST /auth/org-register means an unapproved org can
 * hold a real, working JWT before Platform Ops ever reviews it).
 */
async function requireBuyerOrg(req, res, next) {
  const { subjectId } = req.subject;
  try {
    const org = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      return rows[0] || null;
    });

    if (!org || org.org_type !== 'Buyer') {
      return res.status(403).json({ error: 'buyer_subject_required' });
    }
    if (org.kyb_status !== 'Verified') {
      return res.status(403).json({ error: 'kyb_not_verified', kyb_status: org.kyb_status, org_name: org.org_name });
    }
    req.org = org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireBuyerOrg);

/**
 * IMPORTANT: produce.delivery has NO row-level security at all
 * (relrowsecurity = false — verified, unlike risk.credit_score /
 * underwriting.loan_application / contract.contract, which are all FORCE
 * ROW LEVEL SECURITY). There is no database-level backstop scoping rows to
 * this buyer. Every query below that touches produce.delivery therefore
 * MUST include an explicit `WHERE buyer_org_id = $1` — this is not
 * defense-in-depth here, it is the entire security boundary, the same
 * situation as GET /farmer/notifications (see backend README).
 */

/**
 * GET /buyer/dashboard — org info plus delivery counts by status and a
 * lifetime settled-amount total, all explicitly scoped to this buyer.
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
      const contracts = await client.query(
        `SELECT COUNT(*)::int AS active_contracts
           FROM contract.contract c
           JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
          WHERE cp.party_type = 'organization' AND cp.party_id = $1
            AND cp.party_role = 'buyer' AND c.status = 'active'`,
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
        active_contracts: contracts.rows[0].active_contracts,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

const VALID_STATUSES = ['delivered', 'accepted', 'rejected', 'settled'];
// 'delivered' still needs quality confirmation; 'accepted' still needs
// settlement — both require the buyer to act. 'rejected' and 'settled' are
// at rest.
const ACTION_NEEDED_STATUSES = ['delivered', 'accepted'];

/**
 * GET /buyer/deliveries?status=delivered|accepted|rejected|settled|action_needed
 * Explicit `WHERE buyer_org_id = $1` — see the note at the top of this file.
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
                d.quality_grade, d.status, d.contract_id, d.inspected_by, d.inspected_at,
                d.delivered_at, d.settled_at
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
 * GET /buyer/deliveries/:id — single delivery detail. The explicit
 * `WHERE buyer_org_id = $1 AND delivery_id = $2` is what makes an
 * out-of-scope id return 404 instead of another buyer's data.
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
                d.quality_grade, d.status, d.contract_id, d.inspected_by, d.inspected_at,
                d.delivered_at, d.settled_at, d.settlement_entry_id
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
 * POST /buyer/deliveries — record a new delivery.
 * Body: { unit_id, commodity_code, quantity_ton, contract_id?, cycle_id?, unit_price? }
 *
 * buyer_org_id is NEVER taken from the request body — always req.subject,
 * same rule as farmer_id in POST /farmer/loan-applications. If contract_id
 * is given, produce.record_delivery() itself validates the contract is
 * active, has an agreed price, and that this buyer is really the buyer
 * party on it (raises otherwise) — a "Spot Sale" (no contract_id) instead
 * requires unit_price directly, since there's no contract to price it from.
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
 * POST /buyer/deliveries/:id/confirm-quality
 * Body: { quality_grade, accepted, inspected_by }
 *
 * produce.confirm_quality() does NOT check that the caller owns the
 * delivery, and produce.delivery has no RLS to fall back on — so the
 * ownership gate lives entirely here: the SELECT below is scoped by
 * `buyer_org_id = $1`; zero rows means either it doesn't exist or it isn't
 * this buyer's, and either way the route 404s before ever calling the
 * function.
 */
router.post('/deliveries/:id/confirm-quality', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { quality_grade: qualityGrade, accepted, inspected_by: inspectedBy } = req.body || {};

  if (!qualityGrade || typeof accepted !== 'boolean' || !inspectedBy) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['quality_grade', 'accepted (boolean)', 'inspected_by'],
    });
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
        await client.query('SELECT produce.confirm_quality($1, $2, $3, $4)', [id, qualityGrade, accepted, inspectedBy]);
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
 * POST /buyer/deliveries/:id/settle
 * Same ownership-gating pattern as confirm-quality, above. Triggers a real
 * ledger.transfer_funds() payment from the buyer's settlement account to
 * the production unit's wallet — requires the buyer to already be an
 * activated vendor (partner.vendor_profile.settlement_account_id set via
 * partner.activate_vendor()); if not, settle_delivery() raises and that
 * surfaces as a 409 here rather than a generic 500.
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
 * GET /buyer/contracts — this org's forward-purchase portfolio (contracts
 * where it is the 'buyer' party). Same belt-and-suspenders pattern as
 * GET /farmer/contracts / GET /lender/contracts — contract.contract's own
 * RLS policy (party_own_contract) already scopes this identically.
 */
router.get('/contracts', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT c.contract_id, c.contract_type, c.status, c.related_unit_id,
                c.agreed_quantity, c.agreed_unit_price, c.quantity_unit,
                c.effective_date, c.expiry_date, c.terms_summary, c.created_at
           FROM contract.contract c
           JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
          WHERE cp.party_type = 'organization' AND cp.party_id = $1 AND cp.party_role = 'buyer'
          ORDER BY c.created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'contract.contract', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /buyer/production-units — small directory of active production
 * units (with owning farmer's name) so the "record delivery" form doesn't
 * need the buyer to already know a unit_id by heart. Mirrors the intent of
 * GET /farmer/lenders. Deliberately read-only and minimal (no GPS
 * boundary, no farmer contact info) — a buyer doesn't need a full farmer
 * profile just to record what they physically received.
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
 * GET /buyer/commodities — registry.commodity_ref, for the delivery form's
 * commodity dropdown instead of hardcoding commodity codes in the frontend.
 */
router.get('/commodities', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query('SELECT commodity_code, name_th FROM registry.commodity_ref ORDER BY name_th');
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
