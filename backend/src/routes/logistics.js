const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

/**
 * Logistics (โลจิสติกส์/ขนส่งทั่วไป) portal — the org-facing side of the
 * schema grant_cooperative_logistics.sql already built for cooperatives
 * (see src/routes/coopcollection.js's own "M13 Logistics" section). Until
 * grant_logistics_portal.sql, a "carrier" was just a free-text record a
 * cooperative typed in itself — a real, self-registered org_type=
 * 'Logistics' organization had no way to log in and see its own assigned
 * work at all (this was the one remaining self-registerable org_type with
 * no dedicated portal — see backend/README.md).
 *
 * This file is deliberately thin: it does NOT duplicate any business logic
 * from grant_cooperative_logistics.sql's functions (dispatch_shipment /
 * record_pod / report_exception) — it calls the exact same SQL functions
 * coopcollection.js calls, just gated by a different ownership check
 * ("does this shipment's carrier.linked_org_id match my own org_id"
 * instead of coopcollection.js's "does this shipment.org_id match my own
 * org_id"). Two different, equally legitimate parties act on the same
 * shipment lifecycle — the cooperative that books it, the carrier that
 * carries it out — exactly like a real shipment works.
 *
 * Deliberately simple auth gate (requireOrganization, not
 * requireOrganizationOrStaff) — same choice villagefund.js made for the
 * same reason: this is a brand-new portal for a standalone company logging
 * in with its own org account, not a cooperative-staff-delegated one.
 */
router.use(requireAuth, requireOrganization);

/**
 * Confirms the authenticated organization actually HOLDS a Verified
 * 'Logistics' role — same two-layer pattern (entity kyb_status, then
 * role-level identity.organization_role status) as every other portal's
 * own requireXxxOrg (see requireVillageFundOrg in villagefund.js for the
 * closest twin — copy-paste pattern, since there is no generic
 * requireOrgType() helper in this codebase).
 */
async function requireLogisticsOrg(req, res, next) {
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
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Logistics'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'logistics_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({
        error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name,
      });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'Logistics', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireLogisticsOrg);

const EXCEPTION_TYPES = ['Damage', 'Shortage', 'Delay', 'Rejected', 'Other'];

/**
 * Resolves a shipment_id iff a carrier LINKED to this org (see
 * grant_logistics_portal.sql) is the one carrying it, else null. Mirrors
 * coopcollection.js's assertShipmentOwned, just scoped by
 * carrier.linked_org_id instead of shipment.org_id.
 */
async function assertShipmentAssignedToOrg(client, subjectId, shipmentId) {
  const { rows } = await client.query(
    `SELECT s.shipment_id FROM logistics.shipment s
       JOIN logistics.carrier c ON c.carrier_id = s.carrier_id
      WHERE s.shipment_id = $1 AND c.linked_org_id = $2`,
    [shipmentId, subjectId],
  );
  return rows.length > 0;
}

/**
 * GET /logistics/dashboard — org info plus a count of assigned shipments
 * by status, from logistics.v_shipment_summary filtered by
 * carrier.linked_org_id (widened onto that view by grant_logistics_portal.sql).
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const counts = await client.query(
        `SELECT status, COUNT(*)::int AS count
           FROM logistics.v_shipment_summary
          WHERE linked_org_id = $1
          GROUP BY status`,
        [subjectId],
      );
      const openExceptions = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM logistics.shipment_exception e
           JOIN logistics.shipment s ON s.shipment_id = e.shipment_id
           JOIN logistics.carrier c ON c.carrier_id = s.carrier_id
          WHERE c.linked_org_id = $1 AND e.resolved = false`,
        [subjectId],
      );
      await logAccess(client, 'read', 'logistics.shipment', subjectId);

      const statusCounts = { Pending: 0, InTransit: 0, Delivered: 0, Cancelled: 0 };
      counts.rows.forEach((r) => { statusCounts[r.status] = r.count; });

      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        shipments_by_status: statusCounts,
        needs_action_count: statusCounts.Pending + statusCounts.InTransit,
        open_exception_count: openExceptions.rows[0].count,
      };
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /logistics/shipments — every shipment assigned to this org (across
 * however many different cooperatives link to it — see
 * grant_logistics_portal.sql's Follow-up note), most recent first.
 * Optional ?status= filter (Pending|InTransit|Delivered|Cancelled).
 */
router.get('/shipments', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status) {
        params.push(status);
        filter = 'AND status = $2';
      }
      const result = await client.query(
        `SELECT shipment_id, org_id, coop_org_name, carrier_id, carrier_name, vehicle_id, license_plate,
                destination_name, destination_org_id, driver_name, status,
                scheduled_at, dispatched_at, delivered_at, cancelled_at, cancelled_by, cancel_reason,
                created_by, created_at, item_count, total_quantity_ton,
                pod_received_by, pod_received_quantity_ton, pod_recorded_at, exception_count
           FROM logistics.v_shipment_summary
          WHERE linked_org_id = $1 ${filter}
          ORDER BY created_at DESC`,
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
 * GET /logistics/shipments/:id — shipment detail: the summary row, every
 * cargo item, the proof-of-delivery (if any), and the exception log. Same
 * shape as GET /coop/logistics/shipments/:id.
 */
router.get('/shipments/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const shipment = await client.query(
        `SELECT shipment_id, org_id, coop_org_name, carrier_id, carrier_name, vehicle_id, license_plate,
                destination_name, destination_org_id, driver_name, status,
                scheduled_at, dispatched_at, delivered_at, cancelled_at, cancelled_by, cancel_reason,
                created_by, created_at, item_count, total_quantity_ton,
                pod_received_by, pod_received_quantity_ton, pod_recorded_at, exception_count
           FROM logistics.v_shipment_summary WHERE shipment_id = $1 AND linked_org_id = $2`,
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
 * POST /logistics/shipments/:id/dispatch — the carrier marks that the
 * truck has actually left. Body: { dispatched_by }
 */
router.post('/shipments/:id/dispatch', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { dispatched_by: dispatchedBy } = req.body || {};

  if (!dispatchedBy) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['dispatched_by'] });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (!(await assertShipmentAssignedToOrg(client, subjectId, id))) return { shipmentNotFound: true };

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
 * POST /logistics/shipments/:id/pod — the carrier records proof of
 * delivery once the destination has received the cargo.
 * Body: { received_by, received_quantity_ton, recorded_by, signature_name?, note? }
 */
router.post('/shipments/:id/pod', async (req, res, next) => {
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
      if (!(await assertShipmentAssignedToOrg(client, subjectId, id))) return { shipmentNotFound: true };

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
 * POST /logistics/shipments/:id/exceptions — the carrier reports something
 * that went wrong (damage, shortage, delay, rejection) along the way.
 * Resolving an exception stays the cooperative's own call (POST
 * /coop/logistics/exceptions/:id/resolve) — not exposed here.
 * Body: { exception_type: Damage|Shortage|Delay|Rejected|Other, description, reported_by }
 */
router.post('/shipments/:id/exceptions', async (req, res, next) => {
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
      if (!(await assertShipmentAssignedToOrg(client, subjectId, id))) return { shipmentNotFound: true };

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

module.exports = router;
