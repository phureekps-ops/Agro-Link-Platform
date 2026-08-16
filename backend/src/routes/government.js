const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireGovernmentOfficer } = require('../middleware/auth');

const router = express.Router();

/**
 * Government Officer Portal (M01 Provincial/National role + the M14/M15
 * "government aggregate dashboard"). See grant_staff_and_government_
 * access.sql for how a government_officer identity gets created and logs
 * in (POST /admin/government-officers, then the SAME POST /auth/login
 * every other subject type uses).
 *
 * Every route below is READ-ONLY by design — a government officer (even
 * National scope) does not write to any cooperative's own operational
 * data in this MVP slice. That is a deliberate, conservative default
 * given the Master Blueprint's own emphasis on "consent, audit, security"
 * for M15 — write access for government staff (e.g. approving a
 * cooperative, flagging a compliance issue) is real future work, not
 * assumed here.
 *
 * Scope enforcement: every route resolves the officer's own scope_type/
 * province_code first, then filters. A National officer sees every
 * cooperative; a Province officer sees ONLY cooperatives whose
 * registry.cooperative_profile.province_code matches their own — this is
 * the actual point of M01's Provincial Officer role finally having
 * somewhere to bite.
 */
router.use(requireAuth, requireGovernmentOfficer);

/** Resolves the calling officer's own scope row, or null if not found/Inactive. */
async function loadOfficerScope(client, officerId) {
  const { rows } = await client.query(
    `SELECT officer_id, full_name, scope_type, province_code, status
       FROM identity.government_officer WHERE officer_id = $1 AND status = 'Active'`,
    [officerId],
  );
  return rows[0] || null;
}

/**
 * GET /gov/me — the officer's own profile + roles, mirroring GET
 * /coop/dashboard's "who am I" role in every other portal's init().
 */
router.get('/me', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOfficerScope(client, subjectId);
      if (!officer) return { notFound: true };

      const roles = await client.query(
        `SELECT sr.role_code, r.description
           FROM identity.subject_role sr JOIN identity.role r ON r.role_code = sr.role_code
          WHERE sr.subject_type = 'government_officer' AND sr.subject_id = $1
          ORDER BY sr.granted_at`,
        [subjectId],
      );
      let provinceName = null;
      if (officer.province_code) {
        const p = await client.query('SELECT province_name_th FROM registry.province WHERE province_code = $1', [officer.province_code]);
        provinceName = p.rows[0] ? p.rows[0].province_name_th : null;
      }
      await logAccess(client, 'read', 'identity.government_officer', subjectId);
      return { officer: { ...officer, province_name_th: provinceName }, roles: roles.rows };
    });

    if (result.notFound) return res.status(403).json({ error: 'officer_not_found_or_inactive' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /gov/cooperatives — cooperatives within this officer's scope, with
 * a light summary (member count reported, delivery count, warehouse
 * facility count) — descriptive only, no financial drill-down at this
 * list level.
 */
router.get('/cooperatives', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOfficerScope(client, subjectId);
      if (!officer) return { notFound: true };

      const params = [];
      let scopeClause = '';
      if (officer.scope_type === 'Province') {
        scopeClause = 'AND cp.province_code = $1';
        params.push(officer.province_code);
      }

      const rows = await client.query(
        `SELECT o.org_id, o.org_name, o.kyb_status, o.created_at,
                cp.province_code, p.province_name_th, cp.member_count_reported, cp.established_year,
                COALESCE(d.delivery_count, 0) AS delivery_count,
                COALESCE(f.facility_count, 0) AS facility_count
           FROM identity.organization o
           JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id
           JOIN registry.province p ON p.province_code = cp.province_code
           LEFT JOIN (
             SELECT buyer_org_id, COUNT(*)::int AS delivery_count FROM produce.delivery GROUP BY buyer_org_id
           ) d ON d.buyer_org_id = o.org_id
           LEFT JOIN (
             SELECT org_id, COUNT(*)::int AS facility_count FROM warehouse.facility GROUP BY org_id
           ) f ON f.org_id = o.org_id
          WHERE o.org_type = 'Cooperative' ${scopeClause}
          ORDER BY o.org_name`,
        params,
      );
      await logAccess(client, 'read', 'identity.organization', null);
      return { officer, cooperatives: rows.rows };
    });

    if (result.notFound) return res.status(403).json({ error: 'officer_not_found_or_inactive' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /gov/cooperatives/:id — one cooperative's descriptive detail, still
 * scope-checked (a Province officer cannot look up a cooperative outside
 * their own province just by guessing its org_id).
 */
router.get('/cooperatives/:id', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOfficerScope(client, subjectId);
      if (!officer) return { notFound: true };

      const coop = await client.query(
        `SELECT o.org_id, o.org_name, o.kyb_status, o.created_at,
                cp.province_code, p.province_name_th, cp.cooperative_registration_no,
                cp.established_year, cp.member_count_reported, cp.notes
           FROM identity.organization o
           JOIN registry.cooperative_profile cp ON cp.org_id = o.org_id
           JOIN registry.province p ON p.province_code = cp.province_code
          WHERE o.org_id = $1 AND o.org_type = 'Cooperative'`,
        [id],
      );
      if (coop.rows.length === 0) return { coopNotFound: true };
      if (officer.scope_type === 'Province' && coop.rows[0].province_code !== officer.province_code) {
        return { outOfScope: true };
      }

      const stats = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM produce.delivery WHERE buyer_org_id = $1) AS delivery_count,
           (SELECT COALESCE(SUM(quantity_ton), 0) FROM produce.delivery WHERE buyer_org_id = $1 AND status = 'settled') AS settled_quantity_ton,
           (SELECT COUNT(*)::int FROM warehouse.facility WHERE org_id = $1) AS facility_count,
           (SELECT COUNT(*)::int FROM processing.batch WHERE org_id = $1) AS processing_batch_count,
           (SELECT COUNT(*)::int FROM logistics.shipment WHERE org_id = $1) AS shipment_count`,
        [id],
      );
      await logAccess(client, 'read', 'identity.organization', id);
      return { officer, cooperative: coop.rows[0], stats: stats.rows[0] };
    });

    if (result.notFound) return res.status(403).json({ error: 'officer_not_found_or_inactive' });
    if (result.coopNotFound) return res.status(404).json({ error: 'cooperative_not_found' });
    if (result.outOfScope) return res.status(403).json({ error: 'cooperative_out_of_scope' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /gov/analytics — the M14+M15 "government aggregate dashboard": four
 * of the five analytics.v_* descriptive views (see grant_analytics_
 * warehouse.sql), scoped the SAME way GET /gov/cooperatives already is —
 * a National officer gets every province, a Province officer gets ONLY
 * their own.
 *
 * Deliberately excludes analytics.v_credit_score_distribution — that view
 * is platform-only BY CONSTRUCTION (risk.credit_score's own RLS has no
 * policy for subject_type='government_officer', see that view's own
 * COMMENT in grant_analytics_warehouse.sql), and a farmer's individual
 * credit tier is sensitive enough that this route does not attempt to
 * route around that restriction — even in aggregate, "how many farmers in
 * my province are Tier D" is a real policy decision AgroLink should make
 * deliberately, not something a schema migration should decide by
 * default.
 */
router.get('/analytics', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOfficerScope(client, subjectId);
      if (!officer) return { notFound: true };

      const scopeClause = officer.scope_type === 'Province' ? 'WHERE province_code = $1' : '';
      const scopeParams = officer.scope_type === 'Province' ? [officer.province_code] : [];

      const membership = await client.query(
        `SELECT province_code, province_name_th, region_th, cooperative_count, total_members_reported, avg_members_reported_per_coop
           FROM analytics.v_cooperative_membership_by_province
           ${scopeClause}
          ORDER BY province_name_th`,
        scopeParams,
      );
      const deliveryVolume = await client.query(
        `SELECT province_code, province_name_th, commodity_code, commodity_name_th, delivery_count, total_quantity_ton, settled_quantity_ton, settled_amount
           FROM analytics.v_delivery_volume_by_commodity_province
           ${scopeClause}
          ORDER BY province_name_th, commodity_code`,
        scopeParams,
      );
      const warehouseUtilization = await client.query(
        `SELECT province_code, province_name_th, facility_count, total_capacity_ton, total_current_quantity_ton, utilization_pct
           FROM analytics.v_warehouse_utilization_by_province
           ${scopeClause}
          ORDER BY province_name_th`,
        scopeParams,
      );
      // v_processing_yield has no province_code column of its own (see its
      // own COMMENT — processing.batch's FK is to identity.organization
      // generically, not cooperative-specific) — join through
      // cooperative_profile here, same pattern GET /gov/cooperatives uses.
      const yieldParams = [];
      let yieldClause = '';
      if (officer.scope_type === 'Province') {
        yieldClause = 'WHERE cp.province_code = $1';
        yieldParams.push(officer.province_code);
      }
      const processingYield = await client.query(
        `SELECT vpy.org_id, vpy.org_name, cp.province_code, p.province_name_th, vpy.process_type,
                vpy.source_commodity_code, vpy.source_commodity_name_th, vpy.completed_batch_count,
                vpy.total_input_ton, vpy.total_output_ton, vpy.yield_pct
           FROM analytics.v_processing_yield vpy
           JOIN registry.cooperative_profile cp ON cp.org_id = vpy.org_id
           JOIN registry.province p ON p.province_code = cp.province_code
           ${yieldClause}
          ORDER BY p.province_name_th, vpy.org_name`,
        yieldParams,
      );

      await logAccess(client, 'read', 'analytics.v_cooperative_membership_by_province', null);
      return {
        officer,
        membership: membership.rows,
        delivery_volume: deliveryVolume.rows,
        warehouse_utilization: warehouseUtilization.rows,
        processing_yield: processingYield.rows,
      };
    });

    if (result.notFound) return res.status(403).json({ error: 'officer_not_found_or_inactive' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
