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
                cp.cooperative_registration_no, cp.established_year, cp.member_count_reported, cp.notes,
                cp.registration_document_file_id, f.original_filename AS registration_document_filename,
                f.byte_size AS registration_document_byte_size
           FROM identity.organization o
           JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id
           JOIN registry.province p ON p.province_code = cp.province_code
           LEFT JOIN storage.file_object f ON f.file_id = cp.registration_document_file_id
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

/**
 * ============================================================================
 * M01 Tenant Foundation, remaining piece — government officer provisioning.
 * Same "Platform Ops provisions, no self-service signup" shape as POST
 * /admin/cooperatives above. See grant_staff_and_government_access.sql for
 * the full design rationale (why government_officer is its own table, not
 * an identity.organization row — a government officer isn't affiliated
 * with any organization at all).
 * ============================================================================
 */

const GOVERNMENT_OFFICER_CONSTRAINT_ERRORS = {
  government_officer_auth_subject_id_key: 'subject_claim_collision',
};

/**
 * GET /admin/government-officers — every government officer, most recent
 * first.
 */
router.get('/government-officers', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query(
        `SELECT g.officer_id, g.full_name, g.scope_type, g.province_code, p.province_name_th, g.status,
                g.created_by, g.created_at, sr.role_code, r.description AS role_description
           FROM identity.government_officer g
           LEFT JOIN registry.province p ON p.province_code = g.province_code
           LEFT JOIN identity.subject_role sr ON sr.subject_type = 'government_officer' AND sr.subject_id = g.officer_id
           LEFT JOIN identity.role r ON r.role_code = sr.role_code
          ORDER BY g.created_at DESC`,
      );
      await logAccess(client, 'read', 'identity.government_officer', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/government-officers/:id — single officer detail, including
 * auth_subject_id (shown here for Platform Ops to relay out-of-band, same
 * as the cooperative detail screen).
 */
router.get('/government-officers/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const officerId = req.params.id;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const officerRes = await client.query(
        `SELECT g.officer_id, g.full_name, g.scope_type, g.province_code, p.province_name_th, g.status,
                g.auth_subject_id, g.created_by, g.created_at
           FROM identity.government_officer g
           LEFT JOIN registry.province p ON p.province_code = g.province_code
          WHERE g.officer_id = $1`,
        [officerId],
      );
      if (officerRes.rows.length === 0) return { notFound: true };

      const rolesRes = await client.query(
        `SELECT sr.role_code, r.description, sr.granted_at
           FROM identity.subject_role sr
           JOIN identity.role r ON r.role_code = sr.role_code
          WHERE sr.subject_type = 'government_officer' AND sr.subject_id = $1
          ORDER BY sr.granted_at ASC`,
        [officerId],
      );
      await logAccess(client, 'read', 'identity.government_officer', officerId);
      return { officer: officerRes.rows[0], roles: rolesRes.rows };
    });

    if (result.notFound) return res.status(404).json({ error: 'government_officer_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/government-officers
 * Body: { full_name, national_id, scope_type: National|Province,
 *         province_code? (required iff Province), role_code, created_by }
 * Returns auth_subject_id for Platform Ops to relay to the officer
 * out-of-band — same shape as POST /admin/cooperatives.
 */
router.post('/government-officers', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    full_name: fullName, national_id: nationalId, scope_type: scopeType,
    province_code: provinceCode, role_code: roleCode, created_by: createdBy,
  } = req.body || {};

  if (!fullName || !nationalId || !scopeType || !roleCode || !createdBy) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['full_name', 'national_id', 'scope_type', 'role_code', 'created_by'],
    });
  }
  if (!['National', 'Province'].includes(scopeType)) {
    return res.status(400).json({ error: 'invalid_scope_type', valid: ['National', 'Province'] });
  }
  if (scopeType === 'Province' && !provinceCode) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['province_code'] });
  }

  const nationalIdHash = crypto.createHash('sha256').update(String(nationalId).trim()).digest('hex');
  const authSubjectId = `oidc|gov-${crypto.randomUUID()}`;

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      try {
        const { rows } = await client.query(
          'SELECT identity.register_government_officer($1, $2, $3, $4, $5, $6, $7) AS officer_id',
          [fullName, nationalIdHash, scopeType, provinceCode || null, authSubjectId, roleCode, createdBy],
        );
        await logAccess(client, 'write', 'identity.government_officer', rows[0].officer_id);
        return { officerId: rows[0].officer_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.businessError) return res.status(409).json({ error: 'cannot_create_government_officer', detail: result.businessError });
    return res.status(201).json({ officer_id: result.officerId, auth_subject_id: authSubjectId });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      const mapped = GOVERNMENT_OFFICER_CONSTRAINT_ERRORS[err.constraint];
      if (mapped) return res.status(409).json({ error: mapped });
    }
    return next(err);
  }
});

/**
 * POST /admin/government-officers/:id/deactivate
 */
router.post('/government-officers/:id/deactivate', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      try {
        await client.query('SELECT identity.deactivate_government_officer($1)', [id]);
        await logAccess(client, 'write', 'identity.government_officer', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.businessError) return res.status(404).json({ error: 'government_officer_not_found' });
    return res.json({ status: 'Inactive' });
  } catch (err) {
    return next(err);
  }
});

// ===========================================================================
// M14 Data/AI/Satellite — general-purpose satellite observation adapter
// (see grant_satellite_observation.sql for the schema and why this is
// deliberately a SEPARATE table from carbon.satellite_observation).
// ===========================================================================

/**
 * GET /admin/production-units — a flat, farmer-joined list of every
 * registry.production_unit, for the satellite-observations admin page to
 * pick a unit_id from (no such generic listing endpoint existed before
 * this — the carbon module's own admin UI reaches a unit_id through a
 * different, AWD-specific path). identity.farmer/registry.production_unit
 * have no RLS restricting 'platform', same as GET /admin/farmers above.
 */
router.get('/production-units', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query(
        `SELECT pu.unit_id, pu.unit_type, pu.commodity_code, c.name_th AS commodity_name_th,
                pu.area_rai, pu.status, f.farmer_id, f.full_name AS farmer_name
           FROM registry.production_unit pu
           JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
           LEFT JOIN registry.commodity_ref c ON c.commodity_code = pu.commodity_code
          ORDER BY f.full_name, pu.created_at DESC`,
      );
      await logAccess(client, 'read', 'registry.production_unit', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

const SATELLITE_OBSERVATION_TYPES = ['ndvi', 'crop_health', 'land_cover', 'flood_extent', 'other'];
const SATELLITE_SOURCE_PROVIDERS = ['manual', 'sentinel1_sar', 'sentinel2_optical', 'landsat', 'gistda', 'other'];

/**
 * GET /admin/satellite-observations?unit_id= — optionally filtered to one
 * plot, most recent first. Same shape as GET /admin/carbon/satellite-
 * observations.
 */
router.get('/satellite-observations', async (req, res, next) => {
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
        `SELECT observation_id, unit_id, observation_date, source_provider, observation_type,
                value_numeric, value_label, image_ref, note, recorded_by, ingested_at
           FROM satellite.observation
           ${filter}
          ORDER BY observation_date DESC`,
        params,
      );
      await logAccess(client, 'read', 'satellite.observation', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/satellite-observations
 * Body: { unit_id, observation_date, observation_type, value_numeric?,
 *         value_label?, source_provider?, image_ref?, note?, recorded_by }
 * At least one of value_numeric/value_label is required (see the DB
 * CHECK constraint this mirrors). Upserts on (unit_id, observation_date,
 * source_provider, observation_type) — re-entering the same plot/date/
 * provider/type corrects rather than duplicates, same convention as
 * carbon's own manual-entry route.
 */
router.post('/satellite-observations', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    unit_id: unitId, observation_date: observationDate, observation_type: observationType,
    value_numeric: valueNumeric, value_label: valueLabel, source_provider: sourceProvider,
    image_ref: imageRef, note, recorded_by: recordedBy,
  } = req.body || {};

  if (!unitId || !observationDate || !observationType || !recordedBy) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['unit_id', 'observation_date', 'observation_type', 'recorded_by'],
    });
  }
  if (!SATELLITE_OBSERVATION_TYPES.includes(observationType)) {
    return res.status(400).json({ error: 'invalid_observation_type', valid: SATELLITE_OBSERVATION_TYPES });
  }
  if (sourceProvider && !SATELLITE_SOURCE_PROVIDERS.includes(sourceProvider)) {
    return res.status(400).json({ error: 'invalid_source_provider', valid: SATELLITE_SOURCE_PROVIDERS });
  }
  if ((valueNumeric === undefined || valueNumeric === null || valueNumeric === '') && !valueLabel) {
    return res.status(400).json({ error: 'value_numeric_or_value_label_required' });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const unit = await client.query('SELECT unit_id FROM registry.production_unit WHERE unit_id = $1', [unitId]);
      if (unit.rows.length === 0) return { unitNotFound: true };

      const obsRes = await client.query(
        `INSERT INTO satellite.observation
           (unit_id, observation_date, source_provider, observation_type, value_numeric, value_label, image_ref, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (unit_id, observation_date, source_provider, observation_type) DO UPDATE SET
           value_numeric = EXCLUDED.value_numeric,
           value_label = EXCLUDED.value_label,
           image_ref = EXCLUDED.image_ref,
           note = EXCLUDED.note,
           recorded_by = EXCLUDED.recorded_by,
           ingested_at = now()
         RETURNING *`,
        [unitId, observationDate, sourceProvider || 'manual', observationType, valueNumeric || null, valueLabel || null, imageRef || null, note || null, recordedBy],
      );
      await logAccess(client, 'write', 'satellite.observation', obsRes.rows[0].observation_id);
      return { observation: obsRes.rows[0] };
    });

    if (result.unitNotFound) return res.status(404).json({ error: 'production_unit_not_found' });
    return res.status(201).json(result.observation);
  } catch (err) {
    return next(err);
  }
});

/**
 * Featured Listings — Platform-Ops-managed promotion for the InputSupplier
 * product catalog (marketplace.product_listing, also now used by the
 * Cooperative produce catalog — see grant_cooperative_product_catalog.sql)
 * and the Machinery/FertilizerMixingService rate card
 * (marketplace.service_listing). Schema (is_featured/featured_until) was
 * added by grant_featured_listings.sql, which explicitly promised these
 * exact routes — GET/POST /admin/product-listings*,
 * GET/POST /admin/service-listings* — surfaced as a sort-to-top +
 * "⭐ แนะนำ" badge on GET /farmer/products and
 * GET /farmer/machinery-providers. That file shipped with the schema only;
 * this is the first working implementation.
 *
 * Deliberately admin-toggled, not self-serve: like every other paid
 * interaction in this platform, there is no online payment gateway — a
 * provider pays AgroLink offline, Platform Ops flips is_featured on for a
 * chosen number of days. featured_until is computed server-side from a
 * `days` count (make_interval keeps this a plain integer param, no string
 * concatenation/casting needed) rather than accepting a raw timestamp from
 * the client.
 */
const FEATURED_DEFAULT_DAYS = 30;

/**
 * GET /admin/product-listings?org_id=&category=&featured=
 * Every product_listing row across every org (InputSupplier AND
 * Cooperative sellers alike), joined with org_name/org_type, so Platform
 * Ops can find the listing to feature without hunting through each
 * seller's own dashboard. `featured=true` filters to currently-featured
 * (is_featured AND (featured_until IS NULL OR featured_until > now())) —
 * an expired featured_until is treated as not-featured here even though
 * is_featured itself is never auto-cleared (see the farmer-facing routes'
 * identical live-expiry check).
 */
router.get('/product-listings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    org_id: orgId, category, featured,
  } = req.query;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      const filters = [];
      if (orgId) { params.push(orgId); filters.push(`p.org_id = $${params.length}`); }
      if (category) { params.push(category); filters.push(`p.category = $${params.length}`); }
      if (featured === 'true') filters.push('p.is_featured AND (p.featured_until IS NULL OR p.featured_until > now())');
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const result = await client.query(
        `SELECT p.listing_id, p.org_id, o.org_name, o.org_type, p.category, p.product_name, p.brand,
                p.unit_price, p.price_unit, p.is_active, p.is_featured, p.featured_until, p.created_at
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
           ${where}
          ORDER BY p.is_featured DESC, o.org_name, p.product_name`,
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
 * POST /admin/product-listings/:id/feature
 * Body: { days? } — defaults to FEATURED_DEFAULT_DAYS (30).
 */
router.post('/product-listings/:id/feature', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { days } = req.body || {};
  const numDays = days !== undefined && days !== null ? Number(days) : FEATURED_DEFAULT_DAYS;
  if (!Number.isFinite(numDays) || numDays <= 0) {
    return res.status(400).json({ error: 'invalid_days' });
  }
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace.product_listing
            SET is_featured = true, featured_until = now() + make_interval(days => $2::int), updated_at = now()
          WHERE listing_id = $1
          RETURNING listing_id, org_id, product_name, is_featured, featured_until`,
        [id, Math.round(numDays)],
      );
      if (rows.length > 0) await logAccess(client, 'write', 'marketplace.product_listing', id);
      return rows[0] || null;
    });
    if (!result) return res.status(404).json({ error: 'product_listing_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/product-listings/:id/unfeature
 */
router.post('/product-listings/:id/unfeature', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace.product_listing
            SET is_featured = false, featured_until = NULL, updated_at = now()
          WHERE listing_id = $1
          RETURNING listing_id, org_id, product_name, is_featured, featured_until`,
        [id],
      );
      if (rows.length > 0) await logAccess(client, 'write', 'marketplace.product_listing', id);
      return rows[0] || null;
    });
    if (!result) return res.status(404).json({ error: 'product_listing_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * Same three routes for marketplace.service_listing (Machinery /
 * FertilizerMixingService rate-card items) — service_listing has no
 * updated_at column, unlike product_listing, so the UPDATE statements
 * below omit it.
 */
router.get('/service-listings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { org_id: orgId, service_type: serviceType, featured } = req.query;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      const filters = [];
      if (orgId) { params.push(orgId); filters.push(`s.org_id = $${params.length}`); }
      if (serviceType) { params.push(serviceType); filters.push(`s.service_type = $${params.length}`); }
      if (featured === 'true') filters.push('s.is_featured AND (s.featured_until IS NULL OR s.featured_until > now())');
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const result = await client.query(
        `SELECT s.listing_id, s.org_id, o.org_name, o.org_type, s.service_key, s.service_type,
                s.description, s.unit_price, s.price_unit, s.is_active, s.is_featured, s.featured_until, s.created_at
           FROM marketplace.service_listing s
           JOIN identity.organization o ON o.org_id = s.org_id
           ${where}
          ORDER BY s.is_featured DESC, o.org_name, s.service_type`,
        params,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/service-listings/:id/feature', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { days } = req.body || {};
  const numDays = days !== undefined && days !== null ? Number(days) : FEATURED_DEFAULT_DAYS;
  if (!Number.isFinite(numDays) || numDays <= 0) {
    return res.status(400).json({ error: 'invalid_days' });
  }
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace.service_listing
            SET is_featured = true, featured_until = now() + make_interval(days => $2::int)
          WHERE listing_id = $1
          RETURNING listing_id, org_id, service_type, is_featured, featured_until`,
        [id, Math.round(numDays)],
      );
      if (rows.length > 0) await logAccess(client, 'write', 'marketplace.service_listing', id);
      return rows[0] || null;
    });
    if (!result) return res.status(404).json({ error: 'service_listing_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

router.post('/service-listings/:id/unfeature', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace.service_listing
            SET is_featured = false, featured_until = NULL
          WHERE listing_id = $1
          RETURNING listing_id, org_id, service_type, is_featured, featured_until`,
        [id],
      );
      if (rows.length > 0) await logAccess(client, 'write', 'marketplace.service_listing', id);
      return rows[0] || null;
    });
    if (!result) return res.status(404).json({ error: 'service_listing_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// ============================================================
// Group Buy (รวมออเดอร์ประมูลร่วมของสหกรณ์) — platform-ops side. See
// src/routes/groupbuy.js for the cooperative-facing endpoints (open a
// round, join, withdraw, settle) and GROUP_BUY_ARCHITECTURE.md for the
// full design. The user explicitly decided (2026-08-25) that AgroLink
// staff pick/approve the "lead cooperative" per round rather than an
// automatic rule (e.g. largest quantity) — that decision is what makes
// this a platform-ops action instead of something the round's initiator
// or any participant can trigger themselves.
// ============================================================

/**
 * GET /admin/group-buys?status= — same aggregate shape as GET
 * /procurement/group-buys (groupbuy.js) so the two list views stay
 * visually consistent, plus this is the queue platform-ops actually works
 * from: a round sitting in 'collecting' past its closes_at (or already at
 * min_total_qty) is "ready to convert" and needs a lead org picked.
 */
router.get('/group-buys', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  if (status && !['collecting', 'converted', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: ['collecting', 'converted', 'cancelled'] });
  }

  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const { rows: gbRows } = await client.query(
        `SELECT gb.group_buy_id, gb.category, gb.product_description, gb.target_unit, gb.min_total_qty,
                gb.opens_at, gb.closes_at, gb.status, gb.lead_org_id, gb.converted_rfq_id, gb.created_at,
                io.org_name AS initiator_org_name,
                lo.org_name AS lead_org_name,
                COALESCE(SUM(p.requested_qty) FILTER (WHERE p.status = 'joined'), 0) AS total_requested_qty,
                COUNT(*) FILTER (WHERE p.status = 'joined')::int AS participant_count
           FROM procurement.group_buy gb
           JOIN identity.organization io ON io.org_id = gb.initiator_org_id
           LEFT JOIN identity.organization lo ON lo.org_id = gb.lead_org_id
           LEFT JOIN procurement.group_buy_participant p ON p.group_buy_id = gb.group_buy_id
          WHERE ($1::text IS NULL OR gb.status = $1)
          GROUP BY gb.group_buy_id, io.org_name, lo.org_name
          ORDER BY gb.created_at DESC`,
        [status || null],
      );
      return gbRows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/group-buys/:id — detail + full participant roster (org name,
 * requested qty) so platform-ops has what it needs to pick a lead org —
 * e.g. whoever requested the largest quantity, or whoever platform-ops
 * already trusts with settlement float — without a separate lookup.
 */
router.get('/group-buys/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows: gbRows } = await client.query(
        `SELECT gb.*, io.org_name AS initiator_org_name, lo.org_name AS lead_org_name
           FROM procurement.group_buy gb
           JOIN identity.organization io ON io.org_id = gb.initiator_org_id
           LEFT JOIN identity.organization lo ON lo.org_id = gb.lead_org_id
          WHERE gb.group_buy_id = $1`,
        [id],
      );
      if (gbRows.length === 0) return { notFound: true };

      const { rows: participants } = await client.query(
        `SELECT p.participant_id, p.org_id, o.org_name, p.requested_qty, p.status, p.joined_at, p.withdrawn_at
           FROM procurement.group_buy_participant p
           JOIN identity.organization o ON o.org_id = p.org_id
          WHERE p.group_buy_id = $1
          ORDER BY p.requested_qty DESC`,
        [id],
      );
      return { groupBuy: gbRows[0], participants };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_buy_not_found' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/group-buys/:id/convert — close the round, appoint a lead
 * org, and create the RFQ+Auction pair from the pooled quantity. Reuses
 * the exact same tables POST /procurement/rfqs and POST /procurement/
 * auctions in procurement.js write to — deliberately re-implemented here
 * (rather than calling into procurement.js's route handlers, which are
 * closures bound to req/res, not exported functions) with the identical
 * shape, so everything downstream (bidding, close, contract, PO, GRN,
 * invoice, payment) behaves exactly as it does for any other RFQ/Auction.
 */
router.post('/group-buys/:id/convert', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { lead_org_id: leadOrgId, closes_at: closesAt, bid_visibility: bidVisibilityRaw } = req.body || {};

  if (!leadOrgId) return res.status(400).json({ error: 'lead_org_id_required' });
  const closesAtDate = closesAt ? new Date(closesAt) : null;
  if (!closesAtDate || Number.isNaN(closesAtDate.getTime()) || closesAtDate.getTime() <= Date.now()) {
    return res.status(400).json({ error: 'invalid_closes_at', detail: 'must be a valid future timestamp' });
  }
  // Sealed-bid is the recommended default for a group buy specifically —
  // suppliers competing for one large pooled order have the strongest
  // incentive to shade their price toward what they think a competitor
  // would bid, which is exactly what sealed-bid (no live price feed
  // during the auction) is meant to counter. See grant_sealed_bid_auction.
  // sql for what 'sealed' actually changes vs. the 'live' default.
  const bidVisibility = bidVisibilityRaw === undefined || bidVisibilityRaw === null ? 'sealed' : bidVisibilityRaw;
  if (!['live', 'sealed'].includes(bidVisibility)) {
    return res.status(400).json({ error: 'invalid_bid_visibility', valid: ['live', 'sealed'] });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const gb = await client.query(
        'SELECT * FROM procurement.group_buy WHERE group_buy_id = $1 FOR UPDATE',
        [id],
      );
      if (gb.rows.length === 0) return { notFound: true };
      if (gb.rows[0].status !== 'collecting') return { wrongStatus: gb.rows[0].status };

      const leadCheck = await client.query(
        `SELECT 1 FROM procurement.group_buy_participant WHERE group_buy_id = $1 AND org_id = $2 AND status = 'joined'`,
        [id, leadOrgId],
      );
      if (leadCheck.rows.length === 0) return { leadNotAParticipant: true };

      const { rows: totalRows } = await client.query(
        `SELECT COALESCE(SUM(requested_qty), 0) AS total_qty
           FROM procurement.group_buy_participant WHERE group_buy_id = $1 AND status = 'joined'`,
        [id],
      );
      const totalQty = Number(totalRows[0].total_qty);
      if (totalQty <= 0) return { noParticipants: true };

      const rfqRes = await client.query(
        `INSERT INTO procurement.rfq
           (requester_subject_type, requester_subject_id, title, category, description, quantity, quantity_unit)
         VALUES ('organization', $1, $2, $3, $4, $5, $6)
         RETURNING rfq_id`,
        [
          leadOrgId,
          `รวมออเดอร์ประมูลร่วม: ${gb.rows[0].product_description}`,
          gb.rows[0].category,
          `สร้างอัตโนมัติจากรอบรวมออเดอร์ ${id} — ปริมาณรวมจากสหกรณ์ที่เข้าร่วมทั้งหมด`,
          totalQty,
          gb.rows[0].target_unit,
        ],
      );
      const rfqId = rfqRes.rows[0].rfq_id;

      const auctionRes = await client.query(
        `INSERT INTO procurement.auction (rfq_id, closes_at, bid_visibility)
         VALUES ($1, $2, $3)
         RETURNING auction_id, rfq_id, starts_at, closes_at, status, bid_visibility`,
        [rfqId, closesAtDate.toISOString(), bidVisibility],
      );

      await client.query(
        `UPDATE procurement.group_buy
            SET status = 'converted', lead_org_id = $2, converted_rfq_id = $3,
                converted_by_subject_id = $4, updated_at = now()
          WHERE group_buy_id = $1`,
        [id, leadOrgId, rfqId, subjectId],
      );

      await logAccess(client, 'write', 'procurement.group_buy', id);
      await logAccess(client, 'write', 'procurement.rfq', rfqId);
      return { rfqId, auction: auctionRes.rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_buy_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_buy_not_collecting', current_status: result.wrongStatus });
    if (result.leadNotAParticipant) return res.status(400).json({ error: 'lead_org_must_be_a_joined_participant' });
    if (result.noParticipants) return res.status(409).json({ error: 'no_joined_participants' });
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});


// ============================================================================
// ระบบเติมทุนหมุนเวียนสหกรณ์ (Cooperative Working Capital Top-Up) — 2026-08-27
// ฝั่งแอดมิน: อนุมัติ/ปฏิเสธคำขอวงเงินจากแหล่งทุนภายนอก + ประเมินธรรมาภิบาล +
// จัดการไดเรกทอรีแหล่งทุน — ตั้งใจแยกจากฝั่งสหกรณ์ (coopcollection.js) เพื่อไม่
// ให้สหกรณ์รับรองวงเงิน/ธรรมาภิบาลของตัวเองได้ฝ่ายเดียว (ดูหมายเหตุขอบเขตใน
// backend/db/grant_cooperative_working_capital_topup.sql)
// ============================================================================

/**
 * GET /admin/capital-topup/applications?status=Submitted — คิวคำขอวงเงินจาก
 * ทุกสหกรณ์ (ค่าเริ่มต้นไม่กรอง แสดงทุกสถานะ)
 */
router.get('/capital-topup/applications', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  const VALID = ['Submitted', 'UnderReview', 'Approved', 'Rejected', 'Withdrawn'];
  if (status && !VALID.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', valid: VALID });
  }
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const params = [];
      let filter = '';
      if (status) { params.push(status); filter = 'WHERE a.status = $1'; }
      const result = await client.query(
        `SELECT a.application_id, a.org_id, o.org_name, a.purpose, a.amount_requested, a.term_months,
                a.purpose_note, a.status, a.approved_amount, a.approved_interest_rate_daily_bps,
                a.approved_tenor_months, a.decision_note, a.submitted_at, a.decided_at,
                s.source_name, s.source_type,
                sc.score AS score_at_submission, sc.grade AS grade_at_submission, sc.reasons AS score_reasons
           FROM credit.cooperative_funding_application a
           JOIN identity.organization o ON o.org_id = a.org_id
           JOIN credit.external_funding_source s ON s.funding_source_id = a.funding_source_id
           LEFT JOIN credit.cooperative_credit_score_snapshot sc ON sc.snapshot_id = a.score_snapshot_id
           ${filter}
          ORDER BY a.submitted_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'credit.cooperative_funding_application', null);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/capital-topup/applications/:id/decide
 * Body: { decision: 'Approved'|'Rejected', approved_amount?, interest_rate_daily_bps?, approved_tenor_months?, decision_note? }
 *
 * บันทึกผลการเจรจากับแหล่งทุนภายนอกที่เกิดขึ้นนอกระบบ (ดูหมายเหตุขอบเขตหัวไฟล์
 * migration) — เมื่ออนุมัติ ระบบสร้างวงเงินใช้งานจริงให้ทันทีผ่าน
 * credit.decide_funding_application()
 */
router.post('/capital-topup/applications/:id/decide', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { decision, approved_amount: approvedAmount, interest_rate_daily_bps: interestRateDailyBps,
    approved_tenor_months: approvedTenorMonths, decision_note: decisionNote } = req.body || {};

  if (!['Approved', 'Rejected'].includes(decision)) {
    return res.status(400).json({ error: 'invalid_decision' });
  }
  if (decision === 'Approved' && !(Number(approvedAmount) > 0)) {
    return res.status(400).json({ error: 'approved_amount_required' });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT credit.decide_funding_application($1, $2, $3, $4, $5, $6, $7) AS facility_id',
        [id, decision, decision === 'Approved' ? approvedAmount : null,
          interestRateDailyBps || 0, approvedTenorMonths || null, decisionNote || null, subjectId],
      );
      await logAccess(client, 'write', 'credit.cooperative_funding_application', id);
      return rows[0];
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/capital-topup/funding-sources — ไดเรกทอรีแหล่งทุนภายนอกทั้งหมด
 * (รวมที่ปิดใช้งานแล้ว เพื่อให้แอดมินจัดการได้ครบ)
 */
router.get('/capital-topup/funding-sources', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query(
        'SELECT funding_source_id, source_name, source_type, contact_note, is_active, created_at FROM credit.external_funding_source ORDER BY source_type, source_name',
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/capital-topup/funding-sources — เพิ่มแหล่งทุนภายนอกรายใหม่
 * (เมื่อมีการเจรจาจริงกับสถาบันการเงินรายใดรายหนึ่ง)
 */
router.post('/capital-topup/funding-sources', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { source_name: sourceName, source_type: sourceType, contact_note: contactNote } = req.body || {};
  const VALID_TYPES = ['BAAC', 'CommercialBank', 'SavingsCoop', 'CreditUnion', 'Fintech', 'ImpactFund', 'Other'];
  if (!sourceName || !VALID_TYPES.includes(sourceType)) {
    return res.status(400).json({ error: 'invalid_funding_source_input', valid_types: VALID_TYPES });
  }
  try {
    const row = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        'INSERT INTO credit.external_funding_source (source_name, source_type, contact_note) VALUES ($1, $2, $3) RETURNING funding_source_id',
        [sourceName, sourceType, contactNote || null],
      );
      return rows[0];
    });
    return res.status(201).json(row);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/cooperatives/:id/governance-assessment
 * POST /admin/cooperatives/:id/governance-assessment  Body: { no_material_findings, notes? }
 *
 * ผลประเมินธรรมาภิบาลที่แอดมิน/เจ้าหน้าที่ AgroLink บันทึกด้วยมือ ใช้เป็นปัจจัย
 * หนึ่งใน AgroLink Cooperative Credit Score (ดูหมายเหตุขอบเขตหัวไฟล์ migration
 * ว่าทำไมยังไม่เชื่อมข้อมูลจริงจากกรมส่งเสริมสหกรณ์)
 */
router.get('/cooperatives/:id/governance-assessment', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const row = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        'SELECT no_material_findings, notes, assessed_by, assessed_at FROM credit.cooperative_governance_assessment WHERE org_id = $1',
        [id],
      );
      return rows[0] || null;
    });
    return res.json(row);
  } catch (err) {
    return next(err);
  }
});

router.post('/cooperatives/:id/governance-assessment', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { no_material_findings: noMaterialFindings, notes } = req.body || {};
  if (typeof noMaterialFindings !== 'boolean') {
    return res.status(400).json({ error: 'no_material_findings_required_boolean' });
  }
  try {
    await withSessionContext('platform', subjectId, async (client) => {
      await client.query('SELECT credit.upsert_governance_assessment($1, $2, $3, $4)', [id, noMaterialFindings, notes || null, subjectId]);
      await logAccess(client, 'write', 'credit.cooperative_governance_assessment', id);
    });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});


// ---------- คะแนนเครดิตด้วยโมเดลที่เรียนรู้จากข้อมูลจริง ----------
// Restored 2026-08-27 — this exact route pair (POST /credit-model/retrain,
// GET /credit-model) was originally added in commit 70760bc ("AI Maching
// Scoring") together with grant_credit_model.sql, then accidentally
// dropped in a later large refactor commit (c1ed7ec) that never touched
// the SQL side — risk.credit_model / the ML branch inside risk.
// compute_credit_score() have been sitting in the database schema this
// whole time with no way to ever populate or activate them. Restoring
// verbatim (re-verified against the current schema — production.
// stage_calendar / contract.contract / contract.contract_party / credit.
// loan_repayment / produce.delivery / registry.production_unit / identity.
// farmer are all unchanged in shape since that commit) closes that gap:
// this is what actually lets risk.compute_credit_score() ever take its
// 'ml_logistic_regression' branch instead of always falling back to
// 'rule_based_fallback'. See grant_credit_model.sql's own doc comment for
// the full design rationale (why logistic regression, why gated on a
// minimum sample size, why the rule-based formula in 02_full_schema.sql's
// risk.compute_credit_score() is never removed — only optionally
// overridden when a sufficiently-trained model exists).
//
// MIN_TRAINING_SAMPLES / MIN_PER_CLASS are deliberately conservative for
// an early-stage pilot: below these, POST /admin/credit-model/retrain
// refuses to activate a new model and reports why, leaving whatever was
// previously active (or the rule-based formula, if nothing ever trained
// successfully) untouched.
const MIN_TRAINING_SAMPLES = 20;
const MIN_PER_CLASS = 5;
const CREDIT_MODEL_FEATURE_KEYS = ['production', 'contract', 'repayment', 'delivery'];

/**
 * Computes the mean of an array of numbers, or `fallback` if the array is
 * empty (e.g. a factor no farmer in the training set has any history for).
 */
function mean(values, fallback) {
  if (values.length === 0) return fallback;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Population standard deviation, with a floor of 1e-6 to avoid a
 * div-by-zero (or a wildly unstable z-score) when every training example
 * happens to share the exact same value for a feature.
 */
function stdDev(values, meanValue) {
  if (values.length === 0) return 1;
  const variance = values.reduce((s, v) => s + (v - meanValue) ** 2, 0) / values.length;
  return Math.max(Math.sqrt(variance), 1e-6);
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Hand-written gradient-descent logistic regression — deliberately not a
 * library dependency (this stack has never had one; see
 * grant_credit_model.sql's doc comment) — over the 4 already-computed
 * rule-based factor ratios as features, L2-regularized to reduce
 * overfitting on what is likely still a small pilot-stage sample.
 * Returns fitted weights (object keyed by CREDIT_MODEL_FEATURE_KEYS),
 * bias, and training accuracy (fraction of training rows the fitted
 * model classifies correctly at a 0.5 threshold).
 */
function trainLogisticRegression(featureRows, labels, { epochs = 800, learningRate = 0.15, l2 = 0.02 } = {}) {
  const n = featureRows.length;
  const d = CREDIT_MODEL_FEATURE_KEYS.length;
  let weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i += 1) {
      let z = bias;
      for (let j = 0; j < d; j += 1) z += featureRows[i][j] * weights[j];
      const pred = sigmoid(z);
      const error = pred - labels[i];
      for (let j = 0; j < d; j += 1) gradW[j] += error * featureRows[i][j];
      gradB += error;
    }
    for (let j = 0; j < d; j += 1) {
      weights[j] -= learningRate * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= learningRate * (gradB / n);
  }

  let correct = 0;
  for (let i = 0; i < n; i += 1) {
    let z = bias;
    for (let j = 0; j < d; j += 1) z += featureRows[i][j] * weights[j];
    const predictedLabel = sigmoid(z) >= 0.5 ? 1 : 0;
    if (predictedLabel === labels[i]) correct += 1;
  }

  const weightsObj = {};
  CREDIT_MODEL_FEATURE_KEYS.forEach((key, idx) => { weightsObj[key] = weights[idx]; });

  return { weights: weightsObj, bias, accuracy: n > 0 ? correct / n : null };
}

/**
 * GET /admin/credit-model — current active model's metadata, or a flag
 * saying nothing has ever been activated (every farmer is still scored by
 * the original rule-based formula in that case). Never returns the raw
 * weights to the frontend beyond what's needed to show training
 * diagnostics — there's nothing sensitive in them, but there's also no UI
 * need to show the actual coefficients.
 */
router.get('/credit-model', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const active = await client.query(
        `SELECT model_id, trained_at, sample_size, positive_count, negative_count, training_accuracy, is_active
           FROM risk.credit_model
          WHERE is_active = true
          LIMIT 1`,
      );
      const history = await client.query(
        `SELECT model_id, trained_at, sample_size, positive_count, negative_count, training_accuracy, is_active, notes
           FROM risk.credit_model
          ORDER BY trained_at DESC
          LIMIT 20`,
      );
      return { active: active.rows[0] || null, history: history.rows };
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/credit-model/retrain
 *
 * Pulls the SAME 4 factor ratios risk.compute_credit_score() already
 * computes per farmer (production-verification-on-time rate, contract-
 * completion rate, on-time-repayment rate, delivery-settlement rate),
 * fits a logistic regression against a label built from actual contract/
 * repayment outcomes (label = 1 "good" if every terminal contract this
 * farmer has ever had was 'completed' — none 'terminated'/'breached' — AND
 * every recorded repayment was 'paid_on_time'; label = 0 "risky" if either
 * had at least one bad outcome), and — ONLY if the result clears
 * MIN_TRAINING_SAMPLES/MIN_PER_CLASS — deactivates whatever model was
 * previously active and activates this new one.
 *
 * Farmers with NEITHER a terminal contract NOR a repayment record are
 * excluded entirely: there is no credit-relevant outcome to learn from for
 * them (matches risk.compute_credit_score()'s own "no signal → neutral
 * 50.00" treatment — this training step simply never sees them as
 * training examples, same underlying reasoning).
 *
 * Below the minimum thresholds, this is a NO-OP on risk.credit_model
 * (nothing is written) — the response explains why, and every farmer
 * keeps being scored however they were before this call (rule-based, or
 * whatever model was already active).
 */
router.post('/credit-model/retrain', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(`
        WITH per_farmer AS (
          SELECT
            f.farmer_id,
            (SELECT CASE WHEN count(*) = 0 THEN NULL
                         ELSE 100.0 * count(*) FILTER (WHERE sc.actual_date <= sc.planned_date) / count(*) END
               FROM production.stage_calendar sc
               JOIN production.crop_cycle cc ON cc.cycle_id = sc.cycle_id
               JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
              WHERE pu.owner_farmer_id = f.farmer_id AND sc.status = 'verified') AS production_factor,
            (SELECT count(DISTINCT c.contract_id) FILTER (WHERE c.status IN ('completed','terminated','breached'))
               FROM contract.contract c
               JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
              WHERE cp.party_type = 'farmer' AND cp.party_id = f.farmer_id) AS contract_total,
            (SELECT count(DISTINCT c.contract_id) FILTER (WHERE c.status = 'completed')
               FROM contract.contract c
               JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
              WHERE cp.party_type = 'farmer' AND cp.party_id = f.farmer_id) AS contract_completed,
            (SELECT count(r.repayment_id)
               FROM credit.loan_repayment r
               JOIN contract.contract c ON c.contract_id = r.contract_id
               JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
              WHERE cp.party_type = 'farmer' AND cp.party_id = f.farmer_id) AS repayment_total,
            (SELECT count(r.repayment_id) FILTER (WHERE r.status = 'paid_on_time')
               FROM credit.loan_repayment r
               JOIN contract.contract c ON c.contract_id = r.contract_id
               JOIN contract.contract_party cp ON cp.contract_id = c.contract_id
              WHERE cp.party_type = 'farmer' AND cp.party_id = f.farmer_id) AS repayment_on_time,
            (SELECT CASE WHEN count(*) FILTER (WHERE d.status IN ('settled','rejected')) = 0 THEN NULL
                         ELSE 100.0 * count(*) FILTER (WHERE d.status = 'settled')
                              / count(*) FILTER (WHERE d.status IN ('settled','rejected')) END
               FROM produce.delivery d
               JOIN registry.production_unit pu ON pu.unit_id = d.unit_id
              WHERE pu.owner_farmer_id = f.farmer_id) AS delivery_factor
          FROM identity.farmer f
        )
        SELECT farmer_id, production_factor, delivery_factor,
               contract_total, contract_completed, repayment_total, repayment_on_time,
               CASE WHEN contract_total > 0 THEN 100.0 * contract_completed / contract_total ELSE NULL END AS contract_factor,
               CASE WHEN repayment_total > 0 THEN 100.0 * repayment_on_time / repayment_total ELSE NULL END AS repayment_factor
          FROM per_farmer
         WHERE COALESCE(contract_total, 0) > 0 OR COALESCE(repayment_total, 0) > 0
      `);

      const trainingRows = rows.map((r) => ({
        production: r.production_factor === null ? null : Number(r.production_factor),
        contract: r.contract_factor === null ? null : Number(r.contract_factor),
        repayment: r.repayment_factor === null ? null : Number(r.repayment_factor),
        delivery: r.delivery_factor === null ? null : Number(r.delivery_factor),
        label: (
          (Number(r.contract_total) === 0 || Number(r.contract_completed) === Number(r.contract_total))
          && (Number(r.repayment_total) === 0 || Number(r.repayment_on_time) === Number(r.repayment_total))
        ) ? 1 : 0,
      }));

      const sampleSize = trainingRows.length;
      const positiveCount = trainingRows.filter((r) => r.label === 1).length;
      const negativeCount = sampleSize - positiveCount;

      if (sampleSize < MIN_TRAINING_SAMPLES || positiveCount < MIN_PER_CLASS || negativeCount < MIN_PER_CLASS) {
        return {
          activated: false,
          sample_size: sampleSize,
          positive_count: positiveCount,
          negative_count: negativeCount,
          min_training_samples: MIN_TRAINING_SAMPLES,
          min_per_class: MIN_PER_CLASS,
          reason: 'insufficient_data',
        };
      }

      // Per-feature mean/std — imputation mean is over only the farmers
      // who actually have that factor (production/delivery can be null
      // even for farmers included via contract/repayment history alone).
      const featureMeans = {};
      const featureStds = {};
      CREDIT_MODEL_FEATURE_KEYS.forEach((key) => {
        const observed = trainingRows.map((r) => r[key]).filter((v) => v !== null);
        const m = mean(observed, 50);
        featureMeans[key] = m;
        featureStds[key] = stdDev(observed, m);
      });

      const featureRows = trainingRows.map((r) => CREDIT_MODEL_FEATURE_KEYS.map((key) => {
        const raw = r[key] === null ? featureMeans[key] : r[key];
        return (raw - featureMeans[key]) / featureStds[key];
      }));
      const labels = trainingRows.map((r) => r.label);

      const { weights, bias, accuracy } = trainLogisticRegression(featureRows, labels);

      // Same `client` this whole route already has open (from the outer
      // withSessionContext call) — deliberately NOT a second nested
      // withSessionContext (that would open a wasted extra pool
      // connection for no benefit, since ROLE/session context are already
      // set on this one).
      await client.query('UPDATE risk.credit_model SET is_active = false WHERE is_active = true');
      const { rows: inserted } = await client.query(
        `INSERT INTO risk.credit_model
           (sample_size, positive_count, negative_count, feature_means, feature_stds, weights, bias, training_accuracy, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         RETURNING model_id, trained_at, sample_size, positive_count, negative_count, training_accuracy`,
        // jsonb columns — explicit JSON.stringify rather than relying on
        // pg's implicit object->JSON serialization, since no other route
        // in this codebase writes a jsonb column from a JS-side parameter
        // (every other jsonb write in this project builds the JSON at the
        // SQL level via jsonb_build_object) — nothing to match here, so
        // being explicit removes any ambiguity.
        [sampleSize, positiveCount, negativeCount, JSON.stringify(featureMeans), JSON.stringify(featureStds), JSON.stringify(weights), bias, accuracy],
      );
      const model = inserted[0];
      await logAccess(client, 'write', 'risk.credit_model', model.model_id);

      return { activated: true, ...model };
    });

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});


module.exports = router;
