const express = require('express');

const { withSessionContext } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');

const router = express.Router();

/**
 * VillageFund (กองทุนหมู่บ้าน) portal — brand new this pass, built solely
 * to host the Farmer 360° View (see FARMER_360_ARCHITECTURE.md §6). The
 * feature routes themselves live in the shared src/routes/farmer360.js
 * (mounted at /farmer360, any verified org can use it) — this file is
 * just the portal's own KYB/role gate + a minimal dashboard summary,
 * mirroring lender.js's requireLenderOrg shape exactly (copy-paste
 * pattern, since there is no generic requireOrgType() helper in this
 * codebase — see architecture doc §6 for why).
 */
router.use(requireAuth, requireOrganization);

async function requireVillageFundOrg(req, res, next) {
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
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'VillageFund'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'villagefund_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({
        error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name,
      });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'VillageFund', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireVillageFundOrg);

/**
 * GET /villagefund/dashboard — org info + a roster-size summary. All the
 * actual Farmer 360 work (search/link/view) happens against /farmer360/*
 * from the frontend directly; this is just enough for the dashboard
 * header + summary tile.
 */
router.get('/dashboard', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const roster = await client.query(
        `SELECT COUNT(*)::int AS member_count
           FROM identity.farmer_org_relationship WHERE org_id = $1 AND status = 'active'`,
        [subjectId],
      );
      return {
        org_name: req.org.org_name,
        kyb_status: req.org.kyb_status,
        member_count: roster.rows[0].member_count,
      };
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
