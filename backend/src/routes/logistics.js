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

/**
 * GET /logistics/empty-legs — the backhaul/empty-leg BOARD: any
 * authenticated organization can browse open postings a carrier made
 * ("I have spare capacity from A to B on date X"), not just Logistics-role
 * ones — see grant_logistics_marketplace.sql's design note 4 for why this
 * sits BEFORE requireLogisticsOrg below (restricting the read side to
 * carriers only would make the board pointless, since the whole point is
 * a cooperative/buyer discovering cheap spare capacity). Not gated on KYB
 * status either, matching GET /procurement/rfqs's own "browse is open"
 * convention. Posting one (further below, after the gate) still requires
 * a Verified Logistics org — only a real carrier has a truck to offer.
 * Optional ?status= (defaults to Open, the only status useful to browse).
 */
router.get('/empty-legs', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const effectiveStatus = status || 'Open';
      const result = await client.query(
        `SELECT el.empty_leg_id, el.org_id, o.org_name AS carrier_org_name, el.carrier_vehicle_id,
                cv.vehicle_type, cv.license_plate, cv.capacity_ton AS vehicle_capacity_ton,
                el.origin, el.destination, el.available_date, el.capacity_ton, el.note, el.contact_phone,
                el.status, el.created_at
           FROM logistics.empty_leg el
           JOIN identity.organization o ON o.org_id = el.org_id
           LEFT JOIN logistics.carrier_vehicle cv ON cv.carrier_vehicle_id = el.carrier_vehicle_id
          WHERE el.status = $1
          ORDER BY el.available_date ASC`,
        [effectiveStatus],
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

router.use(requireLogisticsOrg);

const EXCEPTION_TYPES = ['Damage', 'Shortage', 'Delay', 'Rejected', 'Other'];
const VEHICLE_TYPES = ['Truck', 'Trailer', 'Pickup', 'Other'];
const EMPTY_LEG_STATUSES = ['Open', 'Booked', 'Cancelled', 'Expired'];

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
      // active_vehicle_count / open_empty_leg_count (grant_logistics_
      // marketplace.sql): the two new self-service pieces this org
      // manages directly, surfaced here so the dashboard's overview cards
      // don't need two extra round trips just to show a count.
      const vehicleCount = await client.query(
        `SELECT COUNT(*)::int AS count FROM logistics.carrier_vehicle WHERE org_id = $1 AND status = 'active'`,
        [subjectId],
      );
      const openEmptyLegCount = await client.query(
        `SELECT COUNT(*)::int AS count FROM logistics.empty_leg WHERE org_id = $1 AND status = 'Open'`,
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
        active_vehicle_count: vehicleCount.rows[0].count,
        open_empty_leg_count: openEmptyLegCount.rows[0].count,
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

// =============================================================================
// Fleet registry (ทะเบียนรถบรรทุก/รถพ่วง) — logistics.carrier_vehicle, this
// org's OWN self-declared fleet (see grant_logistics_marketplace.sql's
// design note 1 for why this is a separate table from the cooperative-side
// logistics.vehicle used earlier in this file).
// =============================================================================

/** GET /logistics/vehicles — this org's own fleet, every status. */
router.get('/vehicles', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT carrier_vehicle_id, vehicle_type, license_plate, capacity_ton, status, created_at
           FROM logistics.carrier_vehicle WHERE org_id = $1 ORDER BY created_at DESC`,
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
 * POST /logistics/vehicles — add one vehicle to this org's fleet.
 * Body: { vehicle_type: Truck|Trailer|Pickup|Other, license_plate, capacity_ton? }
 */
router.post('/vehicles', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { vehicle_type: vehicleType, license_plate: licensePlate, capacity_ton: capacityTon } = req.body || {};

  if (!vehicleType || !licensePlate) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['vehicle_type', 'license_plate'] });
  }
  if (!VEHICLE_TYPES.includes(vehicleType)) {
    return res.status(400).json({ error: 'invalid_vehicle_type', valid: VEHICLE_TYPES });
  }
  if (capacityTon !== undefined && capacityTon !== null
    && (!Number.isFinite(Number(capacityTon)) || Number(capacityTon) <= 0)) {
    return res.status(400).json({ error: 'invalid_capacity_ton' });
  }

  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO logistics.carrier_vehicle (org_id, vehicle_type, license_plate, capacity_ton)
         VALUES ($1, $2, $3, $4)
         RETURNING carrier_vehicle_id, vehicle_type, license_plate, capacity_ton, status, created_at`,
        [subjectId, vehicleType, licensePlate.trim(), capacityTon || null],
      );
      await logAccess(client, 'write', 'logistics.carrier_vehicle', rows[0].carrier_vehicle_id);
      return rows[0];
    });
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /logistics/vehicles/:id/status — activate/deactivate a fleet
 * vehicle (soft delete — same active/inactive convention as logistics.
 * carrier.status and logistics.vehicle.status already used earlier in
 * this schema; no hard DELETE on any vehicle-like table in this project).
 * Body: { status: active|inactive }
 */
router.post('/vehicles/:id/status', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { status } = req.body || {};
  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: ['active', 'inactive'] });
  }

  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE logistics.carrier_vehicle SET status = $3, updated_at = now()
          WHERE carrier_vehicle_id = $1 AND org_id = $2
          RETURNING carrier_vehicle_id, vehicle_type, license_plate, capacity_ton, status, created_at`,
        [id, subjectId, status],
      );
      return rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'vehicle_not_found' });
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

// =============================================================================
// Service area (พื้นที่ให้บริการ) — identical shape to GET/PUT /machinery/
// service-regions (see that route's own doc comment in src/routes/
// machinery.js): partner.vendor_profile.service_regions is a generic
// column every self-registered org already has (auth.js's POST /auth/
// org-register creates the row for every org_type, Logistics included),
// not machinery-specific — no schema change needed for this piece at all.
// =============================================================================

router.get('/service-area', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const regions = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        'SELECT service_regions FROM partner.vendor_profile WHERE org_id = $1',
        [subjectId],
      );
      return result.rows[0] ? result.rows[0].service_regions : [];
    });
    return res.json({ service_regions: regions });
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /logistics/service-area
 * Body: { service_regions: string[] }
 * Replaces (not merges) wholesale, same as PUT /machinery/service-regions.
 */
router.put('/service-area', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { service_regions: serviceRegions } = req.body || {};

  if (!Array.isArray(serviceRegions) || !serviceRegions.every((r) => typeof r === 'string')) {
    return res.status(400).json({ error: 'invalid_service_regions', expected: 'array_of_strings' });
  }

  try {
    const regions = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `UPDATE partner.vendor_profile
            SET service_regions = $2, updated_at = now()
          WHERE org_id = $1
          RETURNING service_regions`,
        [subjectId, serviceRegions],
      );
      await logAccess(client, 'write', 'partner.vendor_profile', subjectId);
      return result.rows[0] ? result.rows[0].service_regions : [];
    });
    return res.json({ service_regions: regions });
  } catch (err) {
    return next(err);
  }
});

// =============================================================================
// Empty-leg / backhaul board (รถเที่ยวเปล่า) — logistics.empty_leg. The
// BROWSE side (GET /logistics/empty-legs) is defined earlier in this file,
// above the requireLogisticsOrg gate, so any organization can see the open
// board; everything below (post/list-mine/change-status) requires a
// Verified Logistics org, same as everything else past that gate.
// =============================================================================

/**
 * POST /logistics/empty-legs — post spare capacity on a route/date.
 * Body: { origin, destination, available_date, carrier_vehicle_id?, capacity_ton?, note?, contact_phone? }
 */
router.post('/empty-legs', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    origin, destination, available_date: availableDate, carrier_vehicle_id: carrierVehicleId,
    capacity_ton: capacityTon, note, contact_phone: contactPhone,
  } = req.body || {};

  if (!origin || !destination || !availableDate) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['origin', 'destination', 'available_date'] });
  }
  if (capacityTon !== undefined && capacityTon !== null
    && (!Number.isFinite(Number(capacityTon)) || Number(capacityTon) <= 0)) {
    return res.status(400).json({ error: 'invalid_capacity_ton' });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      if (carrierVehicleId) {
        const check = await client.query(
          'SELECT carrier_vehicle_id FROM logistics.carrier_vehicle WHERE carrier_vehicle_id = $1 AND org_id = $2',
          [carrierVehicleId, subjectId],
        );
        if (check.rows.length === 0) return { vehicleNotOwned: true };
      }
      const { rows } = await client.query(
        `INSERT INTO logistics.empty_leg (org_id, carrier_vehicle_id, origin, destination, available_date, capacity_ton, note, contact_phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING empty_leg_id, origin, destination, available_date, capacity_ton, note, contact_phone, status, created_at`,
        [subjectId, carrierVehicleId || null, origin.trim(), destination.trim(), availableDate, capacityTon || null, note || null, contactPhone || null],
      );
      await logAccess(client, 'write', 'logistics.empty_leg', rows[0].empty_leg_id);
      return { emptyLeg: rows[0] };
    });
    if (result.vehicleNotOwned) return res.status(400).json({ error: 'vehicle_not_owned' });
    return res.status(201).json(result.emptyLeg);
  } catch (err) {
    return next(err);
  }
});

/** GET /logistics/empty-legs/mine — this org's own posted legs, every status. */
router.get('/empty-legs/mine', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, async (client) => {
      const result = await client.query(
        `SELECT empty_leg_id, carrier_vehicle_id, origin, destination, available_date, capacity_ton, note, contact_phone, status, created_at
           FROM logistics.empty_leg WHERE org_id = $1 ORDER BY created_at DESC`,
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
 * POST /logistics/empty-legs/:id/status — owner-only status change
 * (e.g. Open -> Booked once a shipper contacts this carrier directly, or
 * -> Cancelled/Expired). Body: { status }
 */
router.post('/empty-legs/:id/status', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { status } = req.body || {};
  if (!EMPTY_LEG_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: EMPTY_LEG_STATUSES });
  }

  try {
    const row = await withSessionContext('organization', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE logistics.empty_leg SET status = $3, updated_at = now()
          WHERE empty_leg_id = $1 AND org_id = $2
          RETURNING empty_leg_id, origin, destination, available_date, capacity_ton, note, contact_phone, status, created_at`,
        [id, subjectId, status],
      );
      return rows[0] || null;
    });
    if (!row) return res.status(404).json({ error: 'empty_leg_not_found' });
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
