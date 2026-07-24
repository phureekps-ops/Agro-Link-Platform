const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requirePlatform } = require('../middleware/auth');

const router = express.Router();

// Every route below requires a valid platform-ops JWT (see POST
// /auth/admin-login). requirePlatform runs after requireAuth so
// req.subject is guaranteed populated first.
router.use(requireAuth, requirePlatform);

const FARMER_STATUSES = ['pending_kyc', 'active', 'suspended', 'closed'];
const ORG_KYB_STATUSES = ['Pending', 'Verified', 'Rejected'];

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

module.exports = router;
