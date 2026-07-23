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

module.exports = router;
