const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid organization JWT — deliberately NOT
// gated to any one org_type/role (unlike lender.js/buyer.js/machinery.js),
// since managing your own set of business roles is something every
// organization can do regardless of which roles it currently holds.
router.use(requireAuth, requireOrganization);

// Same domain as identity.organization.org_type / organization_role.role_type
// — kept as its own list here (rather than importing ORG_SELF_REGISTER_TYPES
// from auth.js) because the two lists could plausibly diverge in the future
// (e.g. a role only grantable by Platform Ops directly, never self-service
// requestable) — today they happen to be identical. 'Cooperative' and 'Mill'
// were removed from both lists together on 2026-07-24, per the same product
// decision as ORG_SELF_REGISTER_TYPES in auth.js — an org can no longer
// self-request either of these as an additional role, same as it can no
// longer self-register as one from scratch.
//
// 'FertilizerMixingService' added here for Fulfillment Marketplace เส้นทาง C
// (KYB-driven onboarding for NEW fertilizer-mixing providers) — per the
// explicit product decision, this deliberately does NOT introduce a
// separate KYB workflow. It reuses this exact self-service request +
// Platform Ops approval mechanism (already generic and already backing
// InputSupplier/Lender/Logistics/Buyer/the four machinery types/
// DryingYardService below) — the role_type/org_type CHECK constraints
// already allow 'FertilizerMixingService' (see grant_fertilizer_mixing
// _service.sql, written for เส้นทาง A), only this requestable-list entry
// was ever missing. The practical effect: an org that already cleared
// entity-level KYB for some OTHER primary role (e.g. an InputSupplier
// already selling fertilizer) can now request FertilizerMixingService as
// an ADDITIONAL role here — on top of the from-scratch self-registration
// path (org_type = FertilizerMixingService via POST /auth/org-register)
// that เส้นทาง A already shipped.
//
// 'VillageFund' added 2026-08-17 for the Farmer 360° View feature (see
// FARMER_360_ARCHITECTURE.md §6) — same reasoning as VillageFund's
// addition to ORG_SELF_REGISTER_TYPES in auth.js: no admin org-creation
// endpoint exists, so self-service request/approval (here, as an
// ADDITIONAL role on top of an existing org) has to be the path, same as
// every other type in this list.
//
// 'TractorService'/'DroneService'/'HarvesterService'/'TruckService'
// CONSOLIDATED into 'MachineryService' on 2026-08-17 — same change, same
// reasoning, as the matching edit to ORG_SELF_REGISTER_TYPES in auth.js
// (see that file's comment + MULTI_ROLE_ORGANIZATION_ARCHITECTURE.md
// §5.1): an org requesting machinery capability as an ADDITIONAL role
// (e.g. a Cooperative that already holds a different primary role) now
// requests the one consolidated type instead of up to four separate ones.
// The four individual values stay valid in the DB domain for any org that
// already holds one of them — only removed from this requestable list.
const ORG_REQUESTABLE_ROLE_TYPES = [
  'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
  'MachineryService', 'DryingYardService',
  'FertilizerMixingService',
];

// Kept covering ALL of TractorService/DroneService/HarvesterService/
// TruckService here even though they're gone from ORG_REQUESTABLE_ROLE_TYPES
// above — this map is also used by GET /roles to label whatever role_type
// rows an org ALREADY holds (see ROLE label_th mapping below), and an org
// that requested one of the four before the 2026-08-17 consolidation still
// has that exact row today (no backfill — see grant_machinery_service_
// consolidation.sql). Dropping their labels here would just replace a
// correct Thai label with a raw enum string for those existing orgs.
const ROLE_LABEL_TH = {
  InputSupplier: 'ผู้จำหน่ายปัจจัยการผลิต',
  Lender: 'ผู้ปล่อยกู้', Logistics: 'โลจิสติกส์/ขนส่งทั่วไป', Buyer: 'ผู้รับซื้อผลผลิต',
  VillageFund: 'กองทุนหมู่บ้าน',
  MachineryService: 'ผู้ให้บริการเครื่องจักรกล (รถไถ/โดรน/รถเกี่ยว/รถบรรทุก)',
  TractorService: 'บริการรถไถ', DroneService: 'บริการโดรน/ฉีดพ่นสารเคมี',
  HarvesterService: 'บริการรถเกี่ยวข้าว', TruckService: 'บริการรถบรรทุก',
  DryingYardService: 'บริการลานตากข้าว',
  FertilizerMixingService: 'ผู้ให้บริการผสมปุ๋ยสั่งตัด',
};

/**
 * GET /organization/roles — this org's full role picture: every role it
 * currently holds (with status), plus the list of roles it could still
 * request (every requestable type it doesn't already have a row for,
 * regardless of that existing row's status — a Rejected role is NOT
 * re-requestable through this endpoint; see the doc comment on POST below).
 */
router.get('/roles', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query(
        'SELECT org_id, org_name, org_type, kyb_status FROM identity.organization WHERE org_id = $1',
        [subjectId],
      );
      if (org.rows.length === 0) return { notFound: true };

      const roles = await client.query(
        `SELECT role_type, status, requested_at, decided_at, decided_reason
           FROM identity.organization_role
          WHERE org_id = $1
          ORDER BY requested_at ASC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'identity.organization_role', subjectId);

      const heldTypes = new Set(roles.rows.map((r) => r.role_type));
      const requestable = ORG_REQUESTABLE_ROLE_TYPES.filter((t) => !heldTypes.has(t));

      return {
        org_name: org.rows[0].org_name,
        primary_org_type: org.rows[0].org_type,
        entity_kyb_status: org.rows[0].kyb_status,
        roles: roles.rows.map((r) => ({ ...r, label_th: ROLE_LABEL_TH[r.role_type] || r.role_type })),
        requestable_roles: requestable.map((t) => ({ role_type: t, label_th: ROLE_LABEL_TH[t] || t })),
      };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'organization_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /organization/roles
 * Body: { role_type }
 *
 * Self-service request for an ADDITIONAL business role, per the explicit
 * product decision: register with one role first, request more later —
 * and every new role (this one included) needs its own Platform Ops
 * approval, same as the first. Requires:
 *   - the organization's entity-level kyb_status is already 'Verified' —
 *     you need to have cleared base KYB before adding business
 *     capabilities on top of it (409 entity_kyb_not_verified otherwise).
 *   - no existing row for (org_id, role_type) at all — this deliberately
 *     does NOT let a Rejected role be re-requested through self-service;
 *     that needs a human (Platform Ops) to intervene directly via the
 *     database or a future dedicated re-request flow, not an unlimited
 *     retry loop against the same rejection.
 */
router.post('/roles', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { role_type: roleType } = req.body || {};

  if (!roleType || !ORG_REQUESTABLE_ROLE_TYPES.includes(roleType)) {
    return res.status(400).json({ error: 'invalid_role_type', valid: ORG_REQUESTABLE_ROLE_TYPES });
  }

  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query('SELECT kyb_status FROM identity.organization WHERE org_id = $1', [subjectId]);
      if (org.rows.length === 0) return { notFound: true };
      if (org.rows[0].kyb_status !== 'Verified') return { entityNotVerified: true };

      const existing = await client.query(
        'SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = $2',
        [subjectId, roleType],
      );
      if (existing.rows.length > 0) {
        return { alreadyExists: true, existingStatus: existing.rows[0].status };
      }

      const { rows } = await client.query(
        `INSERT INTO identity.organization_role (org_id, role_type, status)
         VALUES ($1, $2, 'Pending')
         RETURNING org_id, role_type, status, requested_at`,
        [subjectId, roleType],
      );
      await logAccess(client, 'write', 'identity.organization_role', subjectId);
      return { role: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'organization_not_found' });
    }
    if (result.entityNotVerified) {
      return res.status(409).json({ error: 'entity_kyb_not_verified' });
    }
    if (result.alreadyExists) {
      return res.status(409).json({ error: 'role_already_requested', status: result.existingStatus });
    }
    return res.status(201).json(result.role);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
