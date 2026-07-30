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

/**
 * GET /admin/about-sections
 *
 * Every content.about_section row (including inactive/hidden ones) for the
 * admin content-management screen -- deliberately NOT filtered to
 * is_active=true like the public GET /about is, so Platform Ops can see
 * (and re-enable) hidden sections too.
 */
router.get('/about-sections', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const result = await client.query(
        `SELECT section_id, title, body, display_order, is_active, created_at, updated_at
           FROM content.about_section
          ORDER BY display_order ASC, section_id ASC`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/about-sections
 * Body: { title, body, display_order?, is_active? }
 *
 * Creates a new "เกี่ยวกับเรา" content section. This is plain content
 * management, not a workflow with downstream FK dependents like
 * marketplace.venue_listing -- nothing references content.about_section by
 * id, so unlike the "deactivate, don't delete" convention used for
 * listings, DELETE below is a real hard delete.
 */
router.post('/about-sections', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { title, body, display_order: displayOrder, is_active: isActive } = req.body || {};

  if (!title || !String(title).trim() || !body || !String(body).trim()) {
    return res.status(400).json({ error: 'missing_required_fields' });
  }

  try {
    const section = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO content.about_section (title, body, display_order, is_active)
         VALUES ($1, $2, $3, $4)
         RETURNING section_id, title, body, display_order, is_active, created_at, updated_at`,
        [
          String(title).trim(),
          String(body).trim(),
          Number.isFinite(displayOrder) ? displayOrder : 0,
          isActive !== false,
        ],
      );
      await logAccess(client, 'write', 'content.about_section', String(rows[0].section_id));
      return rows[0];
    });
    return res.status(201).json(section);
  } catch (err) {
    return next(err);
  }
});

/**
 * PUT /admin/about-sections/:id
 * Body: any of { title, body, display_order, is_active }
 *
 * Partial update -- only the fields present in the body are changed, so
 * the admin edit form can save a single field (e.g. just toggling
 * is_active to hide a section) without resending the whole section.
 */
router.put('/about-sections/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { title, body, display_order: displayOrder, is_active: isActive } = req.body || {};

  if (title !== undefined && !String(title).trim()) {
    return res.status(400).json({ error: 'title_cannot_be_empty' });
  }
  if (body !== undefined && !String(body).trim()) {
    return res.status(400).json({ error: 'body_cannot_be_empty' });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE content.about_section
            SET title = COALESCE($1, title),
                body = COALESCE($2, body),
                display_order = COALESCE($3, display_order),
                is_active = COALESCE($4, is_active),
                updated_at = now()
          WHERE section_id = $5
          RETURNING section_id, title, body, display_order, is_active, created_at, updated_at`,
        [
          title !== undefined ? String(title).trim() : null,
          body !== undefined ? String(body).trim() : null,
          Number.isFinite(displayOrder) ? displayOrder : null,
          typeof isActive === 'boolean' ? isActive : null,
          id,
        ],
      );
      if (rows.length === 0) return { notFound: true };
      await logAccess(client, 'write', 'content.about_section', id);
      return { section: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'section_not_found' });
    }
    return res.json(result.section);
  } catch (err) {
    return next(err);
  }
});

/**
 * DELETE /admin/about-sections/:id -- permanently removes the section. See
 * the doc comment on POST above for why a hard delete is safe here.
 */
router.delete('/about-sections/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        'DELETE FROM content.about_section WHERE section_id = $1 RETURNING section_id',
        [id],
      );
      if (rows.length === 0) return { notFound: true };
      await logAccess(client, 'write', 'content.about_section', id);
      return { deleted: true };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'section_not_found' });
    }
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/product-listings?featured_only=
 *
 * Browses marketplace.product_listing (InputSupplier catalog) across
 * every org, for the "จัดการสินค้า/บริการแนะนำ" (Featured Listing) admin
 * panel — see grant_featured_listings.sql's doc comment on why this is
 * admin-toggled rather than self-serve by the provider org. Only
 * is_active = true rows — a deactivated listing can't be featured.
 * featured_only=true narrows to rows currently effectively featured
 * (is_featured AND not yet expired), so the admin can see what's live
 * right now without scrolling the full catalog.
 */
router.get('/product-listings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { featured_only: featuredOnly } = req.query;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const filters = ['p.is_active = true'];
      if (featuredOnly === 'true') {
        filters.push('p.is_featured = true AND (p.featured_until IS NULL OR p.featured_until > now())');
      }
      const result = await client.query(
        `SELECT p.listing_id, p.org_id, o.org_name, p.category, p.product_name, p.brand,
                p.unit_price, p.price_unit, p.is_featured, p.featured_until
           FROM marketplace.product_listing p
           JOIN identity.organization o ON o.org_id = p.org_id
          WHERE ${filters.join(' AND ')}
          ORDER BY p.is_featured DESC, o.org_name, p.product_name`,
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
 * Body: { days } — positive number of days from now (e.g. 7 or 30, matching
 * however many days the provider paid the AgroLink team for offline).
 *
 * Re-running this on an already-featured listing simply resets the expiry
 * to `days` from NOW — it does not stack/extend on top of the remaining
 * time, so an admin re-charging a provider for another period always sets
 * a clean new expiry rather than accumulating.
 */
router.post('/product-listings/:id/feature', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { days } = req.body || {};

  const numDays = Number(days);
  if (!Number.isFinite(numDays) || numDays <= 0) {
    return res.status(400).json({ error: 'invalid_days', expected: 'positive_number' });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace.product_listing
            SET is_featured = true, featured_until = now() + ($2 || ' days')::interval, updated_at = now()
          WHERE listing_id = $1
          RETURNING listing_id, is_featured, featured_until`,
        [id, numDays],
      );
      if (rows.length === 0) return { notFound: true };
      await logAccess(client, 'write', 'marketplace.product_listing', id);
      return { listing: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'listing_not_found' });
    }
    return res.json(result.listing);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/product-listings/:id/unfeature — clears is_featured/
 * featured_until immediately (the provider's paid period ended, or the
 * admin needs to correct a mistake).
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
          RETURNING listing_id, is_featured, featured_until`,
        [id],
      );
      if (rows.length === 0) return { notFound: true };
      await logAccess(client, 'write', 'marketplace.product_listing', id);
      return { listing: rows[0] };
    });
    if (result.notFound) {
      return res.status(404).json({ error: 'listing_not_found' });
    }
    return res.json(result.listing);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /admin/service-listings?featured_only= — same shape as GET
 * /admin/product-listings above, for marketplace.service_listing
 * (Machinery rate card) instead. service_key IS NOT NULL filters out any
 * legacy non-rate-card rows the same way GET /farmer/machinery-providers
 * already does. NOTE: marketplace.service_listing has no updated_at
 * column (unlike product_listing) — see 02_full_schema.sql — so the
 * UPDATE below deliberately does not try to set one.
 */
router.get('/service-listings', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { featured_only: featuredOnly } = req.query;
  try {
    const rows = await withSessionContext('platform', subjectId, async (client) => {
      const filters = ['sl.is_active = true', 'sl.service_key IS NOT NULL'];
      if (featuredOnly === 'true') {
        filters.push('sl.is_featured = true AND (sl.featured_until IS NULL OR sl.featured_until > now())');
      }
      const result = await client.query(
        `SELECT sl.listing_id, sl.org_id, o.org_name, sl.service_key, sl.service_type,
                sl.description AS label_th, sl.unit_price, sl.price_unit,
                sl.is_featured, sl.featured_until
           FROM marketplace.service_listing sl
           JOIN identity.organization o ON o.org_id = sl.org_id
          WHERE ${filters.join(' AND ')}
          ORDER BY sl.is_featured DESC, o.org_name, sl.service_key`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/service-listings/:id/feature — same Body/behavior as POST
 * /admin/product-listings/:id/feature above, applied to
 * marketplace.service_listing.
 */
router.post('/service-listings/:id/feature', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { days } = req.body || {};

  const numDays = Number(days);
  if (!Number.isFinite(numDays) || numDays <= 0) {
    return res.status(400).json({ error: 'invalid_days', expected: 'positive_number' });
  }

  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace.service_listing
            SET is_featured = true, featured_until = now() + ($2 || ' days')::interval
          WHERE listing_id = $1
          RETURNING listing_id, is_featured, featured_until`,
        [id, numDays],
      );
      if (rows.length === 0) return { notFound: true };
      await logAccess(client, 'write', 'marketplace.service_listing', id);
      return { listing: rows[0] };
    });

    if (result.notFound) {
      return res.status(404).json({ error: 'listing_not_found' });
    }
    return res.json(result.listing);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /admin/service-listings/:id/unfeature — same as POST
 * /admin/product-listings/:id/unfeature above, applied to
 * marketplace.service_listing.
 */
router.post('/service-listings/:id/unfeature', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('platform', subjectId, async (client) => {
      const { rows } = await client.query(
        `UPDATE marketplace.service_listing
            SET is_featured = false, featured_until = NULL
          WHERE listing_id = $1
          RETURNING listing_id, is_featured, featured_until`,
        [id],
      );
      if (rows.length === 0) return { notFound: true };
      await logAccess(client, 'write', 'marketplace.service_listing', id);
      return { listing: rows[0] };
    });
    if (result.notFound) {
      return res.status(404).json({ error: 'listing_not_found' });
    }
    return res.json(result.listing);
  } catch (err) {
    return next(err);
  }
});



// ---------- คะแนนเครดิตด้วยโมเดลที่เรียนรู้จากข้อมูลจริง (Featured this round) ----------
// Backs the "credit score should be a model that learns from real data,
// not a fixed formula" request. See grant_credit_model.sql's doc comment
// for the full design rationale (why logistic regression, why gated on a
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
 * Population standard deviation, with a floor of 1 to avoid a div-by-zero
 * (or a wildly unstable z-score) when every training example happens to
 * share the exact same value for a feature.
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
