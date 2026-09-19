const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');
const carbonAggregation = require('../lib/carbonAggregation');

const router = express.Router();

/**
 * VillageFund (กองทุนหมู่บ้าน) Carbon Module portal — Phase 1 (see
 * backend/db/grant_carbon_module_portal_aggregation.sql). Mounted at its
 * own '/villagefund-carbon' prefix, distinct from '/villagefund'
 * (villagefund.js, which hosts the Farmer 360° View only) — same
 * "own prefix, not sharing an existing one" reasoning as coopcarbon.js.
 *
 * requireVillageFundOrg() below is a copy-paste of villagefund.js's own
 * function of the same name (no generic requireOrgType() helper exists in
 * this codebase — see FARMER_360_ARCHITECTURE.md §6) — duplicated here on
 * purpose per the user's explicit "แยก 3 ไฟล์" decision. All actual
 * business logic is in the shared backend/src/lib/carbonAggregation.js
 * helper, used identically by this file, coopcarbon.js, and
 * communityenterprisecarbon.js.
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

const ORG_ROLE_TYPE = 'VillageFund';
const RELATIONSHIP_TYPE = carbonAggregation.ORG_ROLE_TO_RELATIONSHIP_TYPE[ORG_ROLE_TYPE];

// GET /villagefund-carbon/eligible-assessments
router.get('/eligible-assessments', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, (client) =>
      carbonAggregation.listEligibleAssessments(client, { orgId: subjectId, relationshipType: RELATIONSHIP_TYPE }));
    return res.json({ assessments: rows });
  } catch (err) {
    return next(err);
  }
});

// GET /villagefund-carbon/projects
router.get('/projects', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('organization', subjectId, (client) =>
      carbonAggregation.listProjects(client, { orgId: subjectId }));
    return res.json({ projects: rows });
  } catch (err) {
    return next(err);
  }
});

// POST /villagefund-carbon/projects — create a new project
router.post('/projects', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { project_name: projectName, methodology_ref: methodologyRef, farmer_pool_pct: farmerPoolPct, platform_fee_pct: platformFeePct, note } = req.body || {};
  try {
    const project = await withSessionContext('organization', subjectId, async (client) => {
      const created = await carbonAggregation.createProject(client, {
        orgId: subjectId, orgRoleType: ORG_ROLE_TYPE, createdBySubjectId: subjectId,
        projectName, methodologyRef, farmerPoolPct, platformFeePct, note,
      });
      await logAccess(client, 'create', 'carbon_project', created.project_id);
      return created;
    });
    return res.status(201).json({ project });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// GET /villagefund-carbon/projects/:projectId — detail + member list
router.get('/projects/:projectId', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId } = req.params;
  try {
    const detail = await withSessionContext('organization', subjectId, (client) =>
      carbonAggregation.getProjectDetail(client, { orgId: subjectId, projectId }));
    if (!detail) return res.status(404).json({ error: 'project_not_found' });
    return res.json(detail);
  } catch (err) {
    return next(err);
  }
});

// POST /villagefund-carbon/projects/:projectId/update
router.post('/projects/:projectId/update', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId } = req.params;
  const fields = {
    project_name: req.body && req.body.project_name,
    status: req.body && req.body.status,
    farmer_pool_pct: req.body && req.body.farmer_pool_pct,
    platform_fee_pct: req.body && req.body.platform_fee_pct,
    note: req.body && req.body.note,
  };
  try {
    const updated = await withSessionContext('organization', subjectId, async (client) => {
      const row = await carbonAggregation.updateProject(client, { orgId: subjectId, projectId, fields });
      if (row) await logAccess(client, 'update', 'carbon_project', projectId);
      return row;
    });
    if (!updated) return res.status(404).json({ error: 'project_not_found' });
    return res.json({ project: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// POST /villagefund-carbon/projects/:projectId/members — body: { assessment_ids: [uuid, ...] }
router.post('/projects/:projectId/members', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId } = req.params;
  const assessmentIds = Array.isArray(req.body && req.body.assessment_ids) ? req.body.assessment_ids : [];
  if (assessmentIds.length === 0) {
    return res.status(400).json({ error: 'assessment_ids_required' });
  }
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const outcome = await carbonAggregation.addMembers(client, {
        orgId: subjectId, relationshipType: RELATIONSHIP_TYPE, projectId, assessmentIds, addedBySubjectId: subjectId,
      });
      if (outcome.added.length > 0) await logAccess(client, 'update', 'carbon_project', projectId);
      return outcome;
    });
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// POST /villagefund-carbon/projects/:projectId/members/:memberId/remove
router.post('/projects/:projectId/members/:memberId/remove', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId, memberId } = req.params;
  try {
    const removed = await withSessionContext('organization', subjectId, async (client) => {
      const ok = await carbonAggregation.removeMember(client, { orgId: subjectId, projectId, memberId });
      if (ok) await logAccess(client, 'update', 'carbon_project', projectId);
      return ok;
    });
    if (!removed) return res.status(404).json({ error: 'member_not_found' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
