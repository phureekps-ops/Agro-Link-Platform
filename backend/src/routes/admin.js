const express = require('express');
const crypto = require('crypto');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requirePlatform } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid platform-ops JWT (see POST
// /auth/admin-login). requirePlatform runs after requireAuth so
// req.subject is guaranteed populated first.
router.use(requireAuth, requirePlatform);

const FARMER_STATUSES = ['pending_kyc', 'active', 'suspended', 'closed'];
const ORG_KYB_STATUSES = ['Pending', 'Verified', 'Rejected'];

// Same "23505" constant + constraint-name-to-error-code mapping idiom as
// src/routes/auth.js's REGISTER_CONSTRAINT_ERRORS / ORG_REGISTER_CONSTRAINT_
// ERRORS — this file never needed it before because nothing here INSERTed
// into identity.organization until POST /admin/cooperatives below.
const UNIQUE_VIOLATION = '23505';
const COOPERATIVE_CONSTRAINT_ERRORS = {
  uq_organization_tax_id: 'tax_id_already_registered',
  organization_auth_subject_id_key: 'subject_claim_collision',
};

/**
 * GET /admin/dashboard — a small at-a-glance summary: how many farmers are
 * waiting on KYC, how many organizations are waiting on KYB, and whether
 * the platform's own invariants (ledger balance, Go-Live checklist) are
 * currently healthy. The last part reuses ops.v_integrity_checksum and
 * monitoring.v_go_live_readiness — both already existed from Layer 9/10 and
 * agrolink_app already had SELECT on them, but nothing had ever exposed
 * them through the API before; every previous check of these views in this
 * whole project was a manual psql query.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const farmerCounts = await client.query(
        `SELECT status, COUNT(*)::int AS count FROM identity.farmer GROUP BY status`,
      );
      const orgCounts = await client.query(
        `SELECT kyb_status, COUNT(*)::int AS count FROM identity.organization GROUP BY kyb_status`,
      );
      const integrity = await client.query('SELECT * FROM ops.v_integrity_checksum');
      const readiness = await client.query('SELECT * FROM monitoring.v_go_live_readiness');
      const activeAlerts = await client.query('SELECT COUNT(*)::int AS count FROM monitoring.v_active_alerts');
      await logAccess(client, 'read', 'identity.farmer', null);

      const farmerStatusCounts = { pending_kyc: 0, active: 0, suspended: 0, closed: 0 };
      farmerCounts.rows.forEach((r) => { farmerStatusCounts[r.status] = r.count; });
      const orgKybCounts = { Pending: 0, Verified: 0, Rejected: 0 };
      orgCounts.rows.forEach((r) => { orgKybCounts[r.kyb_status] = r.count; });

      return {
        farmers_by_status: farmerStatusCounts,
        organizations_by_kyb_status: orgKybCounts,
        pending_kyc_count: farmerStatusCounts.pending_kyc,
        pending_kyb_count: orgKybCounts.Pending,
        system_health: {
          ledger_balanced: integrity.rows[0] ? Number(integrity.rows[0].ledger_variance) === 0 : null,
          integrity: integrity.rows[0] || null,
          go_live_ready: readiness.rows[0] ? readiness.rows[0].ready_for_go_live : null,
          go_live_readiness: readiness.rows[0] || null,
          active_alerts_count: activeAlerts.rows[0].count,
        },
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/system-health — the detailed version of the summary above,
 * including the actual list of currently-active alerts (not just a count).
 */
router.get('/system-health', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const integrity = await client.query('SELECT * FROM ops.v_integrity_checksum');
      const readiness = await client.query('SELECT * FROM monitoring.v_go_live_readiness');
      const alerts = await client.query(
        'SELECT alert_id, severity, message, fired_at, metric_name, observed_value, source FROM monitoring.v_active_alerts ORDER BY fired_at DESC',
      );
      return {
        integrity: integrity.rows[0] || null,
        go_live_readiness: readiness.rows[0] || null,
        active_alerts: alerts.rows,
      };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/farmers?status=pending_kyc — list farmers, optionally
 * filtered by status. identity.farmer has no RLS (platform sees everyone
 * regardless), so this is a plain query — no ownership scoping needed,
 * unlike every other portal's own-data-only endpoints.
 */
router.get('/farmers', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;

  if (status && !FARMER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: FARMER_STATUSES });
  }

  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      let statusFilter = '';
      if (status) {
        params.push(status);
        statusFilter = 'WHERE status = $1';
      }
      const result = await client.query(
        `SELECT farmer_id, full_name, phone, region_code, status, trust_score, created_at, updated_at
           FROM identity.farmer
           ${statusFilter}
          ORDER BY created_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'identity.farmer', null);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/farmers/:id/status
 * Body: { status, reason? }
 *
 * This is the KYC decision point: 'pending_kyc' -> 'active' is a KYC
 * approval, 'pending_kyc' -> 'closed' is a rejection (identity.farmer's
 * own status_check constraint has no distinct "kyc_rejected" value, so
 * 'closed' is the correct terminal state for a rejected application).
 * The same endpoint also covers ordinary account moderation
 * (suspend/reactivate/close an already-active farmer) since the
 * constraint allows any of the four values and there's no reason to
 * special-case KYC vs later moderation at the API layer.
 *
 * Sends the farmer a real notification via notification.notify() with the
 * reason (if given) — this is the ONLY way a farmer finds out about the
 * decision, since there's no separate "KYC result" email/SMS system in
 * this sandbox. It shows up through their existing
 * GET /farmer/notifications, unread, same as any other notification.
 */
router.post('/farmers/:id/status', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { status, reason } = req.body || {};

  if (!status || !FARMER_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: FARMER_STATUSES });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        'UPDATE identity.farmer SET status = $1, updated_at = now() WHERE farmer_id = $2 RETURNING farmer_id, full_name, status',
        [status, id],
      );
      if (rows.length === 0) {
        return { notFound: true };
      }
      await logAccess(client, 'write', 'identity.farmer', id);

      const statusLabel = {
        active: 'อนุมัติแล้ว บัญชีของท่านใช้งานได้เต็มรูปแบบ',
        suspended: 'ถูกระงับการใช้งานชั่วคราว',
        closed: 'ถูกปฏิเสธ/ปิดบัญชี',
        pending_kyc: 'อยู่ระหว่างการตรวจสอบเอกสารอีกครั้ง',
      }[status];
      const message = `สถานะบัญชีของท่านเปลี่ยนเป็น: ${statusLabel}` + (reason ? ` — เหตุผล: ${reason}` : '');
      await client.query(
        `SELECT notification.notify($1, $2, 'farmer', $3, $4)`,
        ['farmer_kyc_decision', status === 'active' ? 'info' : 'warning', id, message],
      );

      return { farmer: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'farmer_not_found' });
    }
    return res.json(result.farmer);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/organizations?kyb_status=Pending — list organizations,
 * optionally filtered by kyb_status. Same "platform sees everyone" shape
 * as GET /admin/farmers.
 */
router.get('/organizations', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { kyb_status: kybStatus } = req.query;

  if (kybStatus && !ORG_KYB_STATUSES.includes(kybStatus)) {
    return res.status(400).json({ error: 'invalid_kyb_status', valid: ORG_KYB_STATUSES });
  }

  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      let filter = '';
      if (kybStatus) {
        params.push(kybStatus);
        filter = 'WHERE o.kyb_status = $1';
      }
      const result = await client.query(
        `SELECT o.org_id, o.org_name, o.org_type, o.kyb_status, o.verified_badge, o.created_at,
                vp.commercial_status, vp.activated_at
           FROM identity.organization o
           LEFT JOIN partner.vendor_profile vp ON vp.org_id = o.org_id
           ${filter}
          ORDER BY o.created_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'identity.organization', null);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/organizations/:id/kyb-status
 * Body: { kyb_status, reason? }
 *
 * The KYB decision point: 'Pending' -> 'Verified' is approval,
 * 'Pending' -> 'Rejected' is rejection. When approving to 'Verified' AND
 * the organization already has a partner.vendor_profile row, this also
 * calls partner.activate_vendor() — that function itself requires
 * kyb_status = 'Verified' before it will do anything, so the ordering
 * here (UPDATE kyb_status first, then attempt activation) matches what it
 * expects. activate_vendor() being idempotent (checks for an existing
 * ledger.account before creating one) means calling it again on an
 * already-active org is harmless, so this always attempts it rather than
 * tracking whether it "already ran" separately.
 *
 * Since multi-role support (grant_organization_roles.sql), this endpoint
 * ALSO keeps the organization's PRIMARY role row in
 * identity.organization_role (role_type = org_type) in sync with
 * kyb_status — same status, same decision. This is deliberately the ONLY
 * place that happens automatically: a brand-new org's first (and only, so
 * far) role is approved together with its entity-level KYB in this one
 * action, so nothing about the existing KYB approval flow/UI needed to
 * change. Any role requested LATER via POST /organization/roles is a
 * genuinely separate decision, made through the new
 * POST /organizations/:id/roles/:role_type/status endpoint below — not
 * this one.
 */
router.post('/organizations/:id/kyb-status', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { kyb_status: kybStatus, reason } = req.body || {};

  if (!kybStatus || !ORG_KYB_STATUSES.includes(kybStatus)) {
    return res.status(400).json({ error: 'invalid_kyb_status', valid: ORG_KYB_STATUSES });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        'UPDATE identity.organization SET kyb_status = $1, updated_at = now() WHERE org_id = $2 RETURNING org_id, org_name, org_type, kyb_status',
        [kybStatus, id],
      );
      if (rows.length === 0) {
        return { notFound: true };
      }
      await logAccess(client, 'write', 'identity.organization', id);

      // Keep the primary-role row in lockstep — see the doc comment above.
      // ON CONFLICT DO UPDATE rather than a plain UPDATE because a handful
      // of pre-multi-role seeded orgs might not have had a row inserted for
      // them yet in some future re-seed scenario; this makes the sync
      // self-healing either way.
      await client.query(
        `INSERT INTO identity.organization_role (org_id, role_type, status, decided_at, decided_reason)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (org_id, role_type) DO UPDATE
           SET status = EXCLUDED.status, decided_at = now(), decided_reason = EXCLUDED.decided_reason`,
        [id, rows[0].org_type, kybStatus, reason || null],
      );

      let activated = false;
      if (kybStatus === 'Verified') {
        const hasVendorProfile = await client.query('SELECT 1 FROM partner.vendor_profile WHERE org_id = $1', [id]);
        if (hasVendorProfile.rows.length > 0) {
          try {
            await client.query('SELECT partner.activate_vendor($1)', [id]);
            activated = true;
          } catch (activateErr) {
            // Don't fail the whole KYB approval over activation — the org
            // is still legitimately Verified even if commercial activation
            // needs a manual follow-up (e.g. vendor_profile incomplete).
            console.error('[admin] partner.activate_vendor failed after KYB approval:', activateErr.message);
          }
        }
      }

      const statusLabel = { Verified: 'ผ่านการตรวจสอบแล้ว', Rejected: 'ถูกปฏิเสธ', Pending: 'อยู่ระหว่างการตรวจสอบ' }[kybStatus];
      const message = `สถานะการตรวจสอบธุรกิจ (KYB) ขององค์กรท่านเปลี่ยนเป็น: ${statusLabel}` + (reason ? ` — เหตุผล: ${reason}` : '');
      await client.query(
        `SELECT notification.notify($1, $2, 'organization', $3, $4)`,
        ['organization_kyb_decision', kybStatus === 'Verified' ? 'info' : 'warning', id, message],
      );

      return { organization: rows[0], vendor_activated: activated };
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
 * GET /admin/role-requests?status=Pending
 *
 * Every row in identity.organization_role, joined with the organization's
 * name/primary org_type/entity kyb_status for display, optionally filtered
 * by the ROLE's own status (defaults to no filter — same "platform sees
 * everyone" shape as every other admin list route). This is the queue for
 * secondary-role requests submitted through POST /organization/roles — but
 * also shows every org's primary role, since both live in the same table
 * (see grant_organization_roles.sql). The frontend distinguishes "this is
 * the org's original/primary role, already handled by the KYB queue" from
 * "this is a genuinely separate request" by comparing role_type to
 * org_type client-side, rather than needing a second column here.
 */
router.get('/role-requests', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;

  if (status && !ORG_KYB_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: ORG_KYB_STATUSES });
  }

  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      let filter = '';
      if (status) {
        params.push(status);
        filter = 'WHERE r.status = $1';
      }
      const result = await client.query(
        `SELECT r.org_id, r.role_type, r.status, r.requested_at, r.decided_at, r.decided_reason,
                o.org_name, o.org_type AS primary_org_type, o.kyb_status AS entity_kyb_status
           FROM identity.organization_role r
           JOIN identity.organization o ON o.org_id = r.org_id
           ${filter}
          ORDER BY r.requested_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'identity.organization_role', null);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/organizations/:id/roles/:role_type/status
 * Body: { status, reason? }
 *
 * The decision point for a SECONDARY role request (see
 * POST /organization/roles) — a separate approval from the org's primary
 * KYB, per the explicit product decision that every new role, not just the
 * organization's first, needs its own Platform Ops sign-off. Requires the
 * organization's entity-level kyb_status to already be 'Verified' (an org
 * that hasn't cleared base KYB can't have a secondary role request to
 * begin with — POST /organization/roles itself gates on that), and
 * requires an existing row for (org_id, role_type) — 404s if the org never
 * requested this role, rather than silently creating one via this
 * endpoint (that would let Platform Ops grant a role nobody asked for).
 */
router.post('/organizations/:id/roles/:role_type/status', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id, role_type: roleType } = req.params;
  const { status, reason } = req.body || {};

  if (!status || !ORG_KYB_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: ORG_KYB_STATUSES });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const org = await client.query(
        'SELECT org_id, org_name, kyb_status FROM identity.organization WHERE org_id = $1',
        [id],
      );
      if (org.rows.length === 0) {
        return { notFound: true };
      }
      if (org.rows[0].kyb_status !== 'Verified') {
        return { entityNotVerified: true };
      }

      const { rows } = await client.query(
        `UPDATE identity.organization_role
            SET status = $1, decided_at = now(), decided_reason = $2
          WHERE org_id = $3 AND role_type = $4
          RETURNING org_id, role_type, status`,
        [status, reason || null, id, roleType],
      );
      if (rows.length === 0) {
        return { roleNotFound: true };
      }
      await logAccess(client, 'write', 'identity.organization_role', id);

      let activated = false;
      if (status === 'Verified') {
        const hasVendorProfile = await client.query('SELECT 1 FROM partner.vendor_profile WHERE org_id = $1', [id]);
        if (hasVendorProfile.rows.length > 0) {
          try {
            await client.query('SELECT partner.activate_vendor_role($1, $2)', [id, roleType]);
            activated = true;
          } catch (activateErr) {
            console.error('[admin] partner.activate_vendor_role failed after role approval:', activateErr.message);
          }
        }
      }

      const statusLabel = { Verified: 'ผ่านการตรวจสอบแล้ว', Rejected: 'ถูกปฏิเสธ', Pending: 'อยู่ระหว่างการตรวจสอบ' }[status];
      const message = `คำขอเพิ่มบทบาทธุรกิจ "${roleType}" ของท่านเปลี่ยนสถานะเป็น: ${statusLabel}` + (reason ? ` — เหตุผล: ${reason}` : '');
      await client.query(
        `SELECT notification.notify($1, $2, 'organization', $3, $4)`,
        ['organization_role_decision', status === 'Verified' ? 'info' : 'warning', id, message],
      );

      return { role: rows[0], vendor_activated: activated };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'organization_not_found' });
    }
    if (result.entityNotVerified) {
      return res.status(409).json({ error: 'entity_kyb_not_verified' });
    }
    if (result.roleNotFound) {
      return res.status(404).json({ error: 'role_request_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------
// คาร์บอนเครดิต AWD (Low-Carbon Rice / Alternate Wetting and Drying) —
// Platform Ops review queue for carbon.awd_cycle_assessment, reusing the
// same team/role that already reviews KYC/KYB (see AskUserQuestion answer
// captured in this migration's commit — no dedicated verifier org role was
// built). See grant_carbon_awd.sql for the full schema + methodology
// caveats and src/routes/carbon.js for the farmer-facing side.
// ---------------------------------------------------------------------
const AWD_ASSESSMENT_STATUSES = ['draft', 'pending_review', 'verified', 'rejected'];

/**
 * GET /admin/carbon/assessments?status=pending_review — the review queue.
 * Defaults to no filter (every assessment) if status is omitted; the admin
 * frontend always passes status=pending_review for its queue section.
 */
router.get('/carbon/assessments', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;

  if (status && !AWD_ASSESSMENT_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: AWD_ASSESSMENT_STATUSES });
  }

  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      let filter = '';
      if (status) {
        params.push(status);
        filter = 'WHERE a.status = $1';
      }
      const result = await client.query(
        `SELECT a.assessment_id, a.cycle_id, a.unit_id, a.farmer_id, a.area_rai,
                a.methodology_ref, a.emission_factor_tco2e_per_rai, a.min_dry_events_required,
                a.qualifying_dry_events, a.total_dry_days, a.is_eligible, a.estimated_credit_tco2e,
                a.status, a.submitted_at, a.verified_by, a.verified_at, a.review_note,
                a.last_calculated_at,
                f.full_name AS farmer_name, cc.commodity_code, r.name_th AS commodity_name_th
           FROM carbon.awd_cycle_assessment a
           JOIN identity.farmer f ON f.farmer_id = a.farmer_id
           JOIN production.crop_cycle cc ON cc.cycle_id = a.cycle_id
           JOIN registry.commodity_ref r ON r.commodity_code = cc.commodity_code
           ${filter}
          ORDER BY a.submitted_at DESC NULLS LAST, a.updated_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'carbon.awd_cycle_assessment', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/carbon/assessments/:id — full detail for one assessment,
 * including its water-log history and any satellite observations for the
 * same plot, so Platform Ops can cross-check the farmer's self-reported
 * log against the (optional, manually-ingested for now) satellite evidence
 * before deciding.
 */
router.get('/carbon/assessments/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const assessmentRes = await client.query(
        `SELECT a.*, f.full_name AS farmer_name, f.phone AS farmer_phone,
                cc.commodity_code, cc.planned_start_date, cc.planned_harvest_date,
                cc.actual_harvest_date, cc.status AS cycle_status
           FROM carbon.awd_cycle_assessment a
           JOIN identity.farmer f ON f.farmer_id = a.farmer_id
           JOIN production.crop_cycle cc ON cc.cycle_id = a.cycle_id
          WHERE a.assessment_id = $1`,
        [id],
      );
      if (assessmentRes.rows.length === 0) return { notFound: true };
      const assessment = assessmentRes.rows[0];

      const logsRes = await client.query(
        `SELECT log_id, water_status, water_level_cm, photo_url, note, recorded_at
           FROM carbon.awd_water_log
          WHERE cycle_id = $1
          ORDER BY recorded_at ASC`,
        [assessment.cycle_id],
      );

      const satelliteRes = await client.query(
        `SELECT obs_id, observation_date, source_provider, inferred_water_status, image_ref, note
           FROM carbon.satellite_observation
          WHERE unit_id = $1
            AND observation_date BETWEEN $2 AND COALESCE($3, CURRENT_DATE)
          ORDER BY observation_date ASC`,
        [assessment.unit_id, assessment.planned_start_date, assessment.actual_harvest_date],
      );

      await logAccess(client, 'read', 'carbon.awd_cycle_assessment', id);
      return { assessment, water_log: logsRes.rows, satellite_observations: satelliteRes.rows };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'assessment_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/carbon/assessments/:id/verify
 * Body: { review_note? }
 *
 * Only valid from 'pending_review' (an assessment must be submitted by the
 * farmer first — Platform Ops does not reach into a draft and certify it
 * unasked). verified_by is a fixed free-text label, not an FK, matching
 * production.stage_calendar.verified_by's convention — this project has no
 * per-admin identity table (see middleware/auth.js requireAuth's note on
 * subjectType='platform' having no real subjectId).
 */
router.post('/carbon/assessments/:id/verify', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { review_note: reviewNote } = req.body || {};

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const current = await client.query(
        'SELECT assessment_id, farmer_id, status FROM carbon.awd_cycle_assessment WHERE assessment_id = $1',
        [id],
      );
      if (current.rows.length === 0) return { notFound: true };
      if (current.rows[0].status !== 'pending_review') {
        return { notPendingReview: true, status: current.rows[0].status };
      }

      const updateRes = await client.query(
        `UPDATE carbon.awd_cycle_assessment
            SET status = 'verified', verified_by = 'platform_ops', verified_at = now(),
                review_note = $2, updated_at = now()
          WHERE assessment_id = $1
        RETURNING *`,
        [id, reviewNote || null],
      );
      await logAccess(client, 'write', 'carbon.awd_cycle_assessment', id);

      const a = updateRes.rows[0];
      const message = a.is_eligible
        ? `รอบปลูกของท่านผ่านการตรวจสอบแล้ว ประเมินได้รับคาร์บอนเครดิตประมาณ ${Number(a.estimated_credit_tco2e).toLocaleString('th-TH')} tCO2e (เป็นการประเมินเบื้องต้น ไม่ใช่การขึ้นทะเบียนเครดิตจริง)`
        : 'รอบปลูกของท่านผ่านการตรวจสอบแล้ว แต่ยังไม่เข้าเกณฑ์จำนวนรอบแห้งขั้นต่ำสำหรับคาร์บอนเครดิต';
      await client.query(
        `SELECT notification.notify($1, $2, 'farmer', $3, $4)`,
        ['awd_assessment_verified', 'info', a.farmer_id, message],
      );

      return { assessment: a };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'assessment_not_found' });
    }
    if (result.notPendingReview) {
      return res.status(409).json({ error: 'not_pending_review', status: result.status });
    }
    return res.json(result.assessment);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/carbon/assessments/:id/reject
 * Body: { review_note } (required — the farmer needs to know what to fix)
 *
 * Sets status back to 'rejected', which — per UNLOCKED_STATUSES in
 * src/routes/carbon.js — re-opens the assessment so the farmer can log
 * more water-level readings and resubmit, rather than a dead end.
 */
router.post('/carbon/assessments/:id/reject', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { review_note: reviewNote } = req.body || {};

  if (!reviewNote || !reviewNote.trim()) {
    return res.status(400).json({ error: 'review_note_required' });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const current = await client.query(
        'SELECT assessment_id, farmer_id, status FROM carbon.awd_cycle_assessment WHERE assessment_id = $1',
        [id],
      );
      if (current.rows.length === 0) return { notFound: true };
      if (current.rows[0].status !== 'pending_review') {
        return { notPendingReview: true, status: current.rows[0].status };
      }

      const updateRes = await client.query(
        `UPDATE carbon.awd_cycle_assessment
            SET status = 'rejected', verified_by = 'platform_ops', verified_at = now(),
                review_note = $2, updated_at = now()
          WHERE assessment_id = $1
        RETURNING *`,
        [id, reviewNote.trim()],
      );
      await logAccess(client, 'write', 'carbon.awd_cycle_assessment', id);

      await client.query(
        `SELECT notification.notify($1, $2, 'farmer', $3, $4)`,
        ['awd_assessment_rejected', 'warning', current.rows[0].farmer_id, `ข้อมูล AWD ของรอบปลูกถูกตีกลับ — เหตุผล: ${reviewNote.trim()} ท่านสามารถบันทึกข้อมูลเพิ่มเติมและส่งตรวจใหม่ได้`],
      );

      return { assessment: updateRes.rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'assessment_not_found' });
    }
    if (result.notPendingReview) {
      return res.status(409).json({ error: 'not_pending_review', status: result.status });
    }
    return res.json(result.assessment);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/carbon/config — every carbon.awd_config version, newest
 * first, so Platform Ops can see the current active thresholds plus the
 * history of past values (each carbon.awd_cycle_assessment row keeps
 * referencing whichever version was active when it was computed — see
 * grant_carbon_awd.sql).
 */
router.get('/carbon/config', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query(
        'SELECT * FROM carbon.awd_config ORDER BY effective_from DESC, created_at DESC',
      );
      await logAccess(client, 'read', 'carbon.awd_config', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/carbon/config
 * Body: { emission_factor_tco2e_per_rai, min_dry_events_required,
 *         min_dry_period_days, min_water_level_drop_cm, methodology_ref?, note? }
 *
 * Adds a NEW active config version rather than editing the current one in
 * place (see grant_carbon_awd.sql's snapshot-pattern comment) — deactivates
 * whichever version is currently active, then inserts the new one as
 * active. Existing assessments are untouched; only assessments computed
 * AFTER this call will use the new values.
 */
router.post('/carbon/config', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    emission_factor_tco2e_per_rai: emissionFactor,
    min_dry_events_required: minDryEvents,
    min_dry_period_days: minDryPeriodDays,
    min_water_level_drop_cm: minWaterLevelDropCm,
    methodology_ref: methodologyRef,
    note,
  } = req.body || {};

  if ([emissionFactor, minDryEvents, minDryPeriodDays, minWaterLevelDropCm].some(
    (v) => v === undefined || v === null || Number.isNaN(Number(v)),
  )) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['emission_factor_tco2e_per_rai', 'min_dry_events_required', 'min_dry_period_days', 'min_water_level_drop_cm'],
    });
  }
  if (Number(emissionFactor) < 0 || Number(minDryEvents) <= 0 || Number(minDryPeriodDays) <= 0 || Number(minWaterLevelDropCm) < 0) {
    return res.status(400).json({ error: 'invalid_field_values' });
  }

  try {
    const config = await withSessionContext('platform', subjectId, async (client) => {
      await client.query('UPDATE carbon.awd_config SET is_active = false WHERE is_active = true');
      const insertRes = await client.query(
        `INSERT INTO carbon.awd_config
           (methodology_ref, emission_factor_tco2e_per_rai, min_dry_events_required,
            min_dry_period_days, min_water_level_drop_cm, note, is_active, effective_from)
         VALUES ($1, $2, $3, $4, $5, $6, true, CURRENT_DATE)
         RETURNING *`,
        [
          methodologyRef || 'T-VER_AWD_RICE_v1_estimate', emissionFactor, minDryEvents,
          minDryPeriodDays, minWaterLevelDropCm, note || null,
        ],
      );
      await logAccess(client, 'write', 'carbon.awd_config', insertRes.rows[0].config_id);
      return insertRes.rows[0];
    });
    return res.status(201).json(config);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/carbon/satellite-observations?unit_id=
 */
router.get('/carbon/satellite-observations', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { unit_id: unitId } = req.query;

  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      let filter = '';
      if (unitId) {
        params.push(unitId);
        filter = 'WHERE unit_id = $1';
      }
      const result = await client.query(
        `SELECT obs_id, unit_id, cycle_id, observation_date, source_provider,
                inferred_water_status, image_ref, note, ingested_at
           FROM carbon.satellite_observation
           ${filter}
          ORDER BY observation_date DESC`,
        params,
      );
      await logAccess(client, 'read', 'carbon.satellite_observation', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/carbon/satellite-observations
 * Body: { unit_id, observation_date, source_provider?, inferred_water_status, image_ref?, note?, cycle_id? }
 *
 * Manual ingestion point standing in for a real satellite-data-provider
 * integration (Sentinel Hub / Google Earth Engine / GISTDA — none
 * connected in this environment yet, see grant_carbon_awd.sql). Upserts on
 * (unit_id, observation_date, source_provider) so re-ingesting the same
 * plot/date/provider corrects rather than duplicates.
 */
router.post('/carbon/satellite-observations', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    unit_id: unitId,
    observation_date: observationDate,
    source_provider: sourceProvider,
    inferred_water_status: inferredWaterStatus,
    image_ref: imageRef,
    note,
    cycle_id: cycleId,
  } = req.body || {};

  if (!unitId || !observationDate || !inferredWaterStatus) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['unit_id', 'observation_date', 'inferred_water_status'],
    });
  }
  if (!['flooded', 'dry', 'uncertain'].includes(inferredWaterStatus)) {
    return res.status(400).json({ error: 'invalid_inferred_water_status', valid: ['flooded', 'dry', 'uncertain'] });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const unit = await client.query('SELECT unit_id FROM registry.production_unit WHERE unit_id = $1', [unitId]);
      if (unit.rows.length === 0) return { unitNotFound: true };

      const obsRes = await client.query(
        `INSERT INTO carbon.satellite_observation
           (unit_id, cycle_id, observation_date, source_provider, inferred_water_status, image_ref, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (unit_id, observation_date, source_provider) DO UPDATE SET
           inferred_water_status = EXCLUDED.inferred_water_status,
           image_ref = EXCLUDED.image_ref,
           note = EXCLUDED.note,
           cycle_id = EXCLUDED.cycle_id,
           ingested_at = now()
         RETURNING *`,
        [unitId, cycleId || null, observationDate, sourceProvider || 'manual', inferredWaterStatus, imageRef || null, note || null],
      );
      await logAccess(client, 'write', 'carbon.satellite_observation', obsRes.rows[0].obs_id);
      return { observation: obsRes.rows[0] };
    });

    if (result.unitNotFound) {
      return res.status(404).json({ error: 'production_unit_not_found' });
    }
    return res.status(201).json(result.observation);
  } catch (err) {
    return next(err);
  }
});

// ===========================================================================
// Cooperative SaaS — M01 Tenant Foundation
// (see backend/db/grant_cooperative_tenant_foundation.sql for the schema
// this section depends on, and its header comment for what is/isn't in
// scope yet — most importantly: every role below is granted at the
// ORGANIZATION level, since per-staff-member login doesn't exist in this
// codebase yet.)
// ===========================================================================

/**
 * GET /admin/provinces — reference list for the "create cooperative" form's
 * province dropdown. Read-only, no filtering needed yet (only 16 rows).
 */
router.get('/provinces', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query(
        `SELECT province_code, province_name_th, region_th
           FROM registry.province
          ORDER BY region_th, province_name_th`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/roles — the full identity.role catalog. Exists mainly so the
 * cooperative detail screen can show a human-readable description next to
 * each role_code a cooperative holds, without hardcoding the label list a
 * second time in the frontend.
 */
router.get('/roles', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query('SELECT role_code, description FROM identity.role ORDER BY role_code');
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/cooperatives — every Cooperative-typed organization, joined
 * with its registry.cooperative_profile + province. This is deliberately
 * the FIRST thing in the codebase that lists cooperatives as their own
 * concept (rather than as one row among every org_type on GET
 * /admin/organizations) — the seed of the future Government Dashboard
 * (M15), standing in for a real CPD National login until one exists.
 */
router.get('/cooperatives', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query(
        `SELECT o.org_id, o.org_name, o.tax_id, o.kyb_status, o.verified_badge, o.created_at,
                cp.province_code, p.province_name_th, p.region_th,
                cp.cooperative_registration_no, cp.established_year, cp.member_count_reported
           FROM identity.organization o
           JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id
           JOIN registry.province p ON p.province_code = cp.province_code
          WHERE o.org_type = 'Cooperative'
          ORDER BY o.created_at DESC`,
      );
      await logAccess(client, 'read', 'identity.organization', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/cooperatives/:id — single cooperative detail, including every
 * role currently granted to it (identity.subject_role joined to
 * identity.role for the description).
 */
router.get('/cooperatives/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const coopOrgId = req.params.id;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const orgRes = await client.query(
        `SELECT o.org_id, o.org_name, o.tax_id, o.kyb_status, o.verified_badge, o.auth_subject_id, o.created_at,
                cp.province_code, p.province_name_th, p.region_th,
                cp.cooperative_registration_no, cp.established_year, cp.member_count_reported, cp.notes
           FROM identity.organization o
           JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id
           JOIN registry.province p ON p.province_code = cp.province_code
          WHERE o.org_id = $1 AND o.org_type = 'Cooperative'`,
        [coopOrgId],
      );
      if (orgRes.rows.length === 0) return { notFound: true };

      const rolesRes = await client.query(
        `SELECT sr.role_code, r.description, sr.granted_at
           FROM identity.subject_role sr
           JOIN identity.role r ON r.role_code = sr.role_code
          WHERE sr.subject_type = 'organization' AND sr.subject_id = $1
          ORDER BY sr.granted_at ASC`,
        [coopOrgId],
      );
      await logAccess(client, 'read', 'identity.organization', coopOrgId);
      return { cooperative: orgRes.rows[0], roles: rolesRes.rows };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'cooperative_not_found' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/cooperatives
 * Body: { org_name, tax_id, province_code, cooperative_registration_no?,
 *         established_year?, member_count_reported?, notes? }
 *
 * The tenant-provisioning endpoint the product decision to remove
 * 'Cooperative' from public self-registration (2026-07-24, see auth.js)
 * always implied would need to exist somewhere — this is it. Unlike
 * POST /auth/org-register, this:
 *   - lands the org at kyb_status = 'Verified' immediately (Platform Ops
 *     creating it directly IS the verification — there is no separate
 *     applicant submitting evidence to review, unlike a self-registered
 *     service provider);
 *   - grants BOTH 'org.admin' (so every existing piece of code that only
 *     knows about that role keeps working unchanged) AND the new
 *     'coop.admin' role from the reconciled Master Blueprint role model;
 *   - writes the matching registry.cooperative_profile row in the SAME
 *     transaction, so a cooperative organization can never exist without
 *     its province/profile data (the profile's own trigger would reject a
 *     non-Cooperative org_id anyway, but this also means the reverse can
 *     never happen: no Cooperative org left with no profile row);
 *   - does NOT create a partner.vendor_profile row — that table backs the
 *     commercial marketplace/settlement machinery used by service
 *     providers (Lender/Buyer/Machinery/etc.), which is out of scope for
 *     M01 Tenant Foundation. A future module that needs it (e.g. M04
 *     Cooperative Finance) can add that row itself when it lands.
 */
router.post('/cooperatives', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    org_name: orgName,
    tax_id: taxId,
    province_code: provinceCode,
    cooperative_registration_no: coopRegNo,
    established_year: establishedYear,
    member_count_reported: memberCountReported,
    notes,
  } = req.body || {};

  if (!orgName || !taxId || !provinceCode) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['org_name', 'tax_id', 'province_code'],
    });
  }

  // Same mock-OIDC-claim convention as generateOrgAuthSubjectId() in
  // auth.js (kept local here rather than exported/imported — it's a
  // one-line generator, not worth coupling this file to auth.js for).
  const authSubjectId = `oidc|coop-${crypto.randomUUID()}`;

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const province = await client.query(
        'SELECT province_code FROM registry.province WHERE province_code = $1',
        [provinceCode],
      );
      if (province.rows.length === 0) return { provinceNotFound: true };

      const orgRes = await client.query(
        `INSERT INTO identity.organization (org_type, org_name, tax_id, kyb_status, verified_badge, auth_subject_id)
         VALUES ('Cooperative', $1, $2, 'Verified', true, $3)
         RETURNING org_id, org_name, org_type, kyb_status, verified_badge, auth_subject_id, created_at`,
        [orgName, taxId, authSubjectId],
      );
      const newOrgId = orgRes.rows[0].org_id;

      await client.query(
        `INSERT INTO identity.subject_role (subject_type, subject_id, role_code)
         VALUES ('organization', $1, 'org.admin'), ('organization', $1, 'coop.admin')`,
        [newOrgId],
      );

      await client.query(
        `INSERT INTO identity.organization_role (org_id, role_type, status, decided_at, decided_reason)
         VALUES ($1, 'Cooperative', 'Verified', now(), 'จัดตั้งโดย Platform Ops โดยตรง (Tenant Provisioning ตาม M01)')`,
        [newOrgId],
      );

      const profileRes = await client.query(
        `INSERT INTO registry.cooperative_profile
           (org_id, province_code, cooperative_registration_no, established_year, member_count_reported, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING org_id, province_code, cooperative_registration_no, established_year, member_count_reported, notes, created_at`,
        [newOrgId, provinceCode, coopRegNo || null, establishedYear || null, memberCountReported || null, notes || null],
      );

      await logAccess(client, 'write', 'identity.organization', newOrgId);
      return { organization: orgRes.rows[0], profile: profileRes.rows[0] };
    });

    if (result.provinceNotFound) {
      return res.status(400).json({ error: 'invalid_province_code' });
    }
    return res.status(201).json(result);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      const mapped = COOPERATIVE_CONSTRAINT_ERRORS[err.constraint];
      if (mapped) {
        return res.status(409).json({ error: mapped });
      }
    }
    return next(err);
  }
});

/**
 * POST /admin/cooperatives/:id/activate-settlement
 *
 * M01→M09 bridge. POST /admin/cooperatives (above) deliberately does NOT
 * create a partner.vendor_profile row for a newly-provisioned cooperative
 * — that table backs the commercial marketplace/settlement machinery, out
 * of scope for Tenant Foundation. But M09's collection-station settle step
 * (coopcollection.js's POST /coop/deliveries/:id/settle, calling the same
 * produce.settle_delivery() the Buyer Portal uses) requires the buyer
 * organization to already be an ACTIVE vendor with a settlement_account_id
 * — partner.activate_vendor_role() raises 'ยังไม่มีข้อมูล vendor_profile'
 * otherwise. This endpoint is that missing step for cooperatives: create a
 * vendor_profile row if one doesn't exist yet (idempotent — reuses an
 * existing one instead of erroring), then call partner.activate_vendor(),
 * which itself is idempotent (COALESCE(activated_at, now())) and already
 * requires this org's identity.organization_role row for role_type =
 * 'Cooperative' to be 'Verified' — which POST /admin/cooperatives always
 * sets it to immediately, so this will never fail for a cooperative
 * provisioned through that endpoint. No new Postgres GRANTs were needed
 * for this route (verified: agrolink_app already holds SELECT/INSERT/
 * UPDATE on partner.vendor_profile and SELECT/INSERT on ledger.account,
 * all from grant_platform_ops.sql / grant_provider_registration.sql).
 */
router.post('/cooperatives/:id/activate-settlement', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const org = await client.query(
        `SELECT org_id, org_name, org_type, tax_id FROM identity.organization WHERE org_id = $1`,
        [id],
      );
      if (org.rows.length === 0 || org.rows[0].org_type !== 'Cooperative') {
        return { notFound: true };
      }

      const existingProfile = await client.query(
        `SELECT org_id FROM partner.vendor_profile WHERE org_id = $1`,
        [id],
      );
      if (existingProfile.rows.length === 0) {
        await client.query(
          `INSERT INTO partner.vendor_profile (org_id, business_registration_no)
           VALUES ($1, $2)`,
          [id, org.rows[0].tax_id],
        );
      }

      try {
        await client.query('SELECT partner.activate_vendor($1)', [id]);
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }

      const profile = await client.query(
        `SELECT org_id, commercial_status, settlement_account_id, activated_at FROM partner.vendor_profile WHERE org_id = $1`,
        [id],
      );
      await logAccess(client, 'write', 'partner.vendor_profile', id);
      return { profile: profile.rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'cooperative_not_found' });
    }
    if (result.businessError) {
      return res.status(409).json({ error: 'cannot_activate_settlement', detail: result.businessError });
    }
    return res.json(result.profile);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
