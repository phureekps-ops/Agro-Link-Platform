const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireOrganization } = require('../middleware/auth');
const carbonAggregation = require('../lib/carbonAggregation');

const router = express.Router();

/**
 * Agricultural Community Enterprise (วิสาหกิจชุมชนด้านการเกษตร) Carbon
 * Module portal — Phase 1 (see backend/db/grant_carbon_module_portal_
 * aggregation.sql). This is the FIRST dedicated backend route file for
 * org_type='AgriCommunityEnterprise' — frontend/communityenterprise/
 * dashboard.html's other tabs (loans/machinery/inputs/buyer) are all
 * embedded iframes into the bundled Lender/MachineryService/InputSupplier/
 * Buyer role portals (see grant_farmer_aid_fund_community_enterprise.sql's
 * own header comment), so there was no existing "communityenterprise.js"
 * to extend — mounted at its own '/communityenterprise-carbon' prefix.
 *
 * requireCommunityEnterpriseOrg() below is a copy-paste of villagefund.js's
 * requireVillageFundOrg() shape (no generic requireOrgType() helper exists
 * in this codebase — see FARMER_360_ARCHITECTURE.md §6), just checking
 * role_type = 'AgriCommunityEnterprise' instead. All actual business logic
 * is in the shared backend/src/lib/carbonAggregation.js helper, used
 * identically by this file, coopcarbon.js, and villagefundcarbon.js — the
 * user's explicit "แยก 3 ไฟล์" decision (per-portal gate + mount prefix)
 * without tripling the query logic.
 *
 * IMPORTANT: every endpoint here is GET/POST only, never PUT/DELETE/PATCH
 * — frontend/communityenterprise/js/api.js's AgroLinkCommunityEnterpriseAPI
 * only exposes `get`/`post` (unlike coop's and villagefund's api.js, which
 * both also have `del`), so this constraint was designed in from the start
 * rather than requiring an api.js change.
 */
router.use(requireAuth, requireOrganization);

async function requireCommunityEnterpriseOrg(req, res, next) {
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
        `SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'AgriCommunityEnterprise'`,
        [subjectId],
      );
      return { org: orgRow, roleStatus: role.rows[0] ? role.rows[0].status : null };
    });

    if (result.orgMissing) {
      return res.status(403).json({ error: 'agricommunityenterprise_subject_required' });
    }
    if (result.kybNotVerified) {
      return res.status(403).json({
        error: 'kyb_not_verified', kyb_status: result.org.kyb_status, org_name: result.org.org_name,
      });
    }
    if (result.roleStatus !== 'Verified') {
      return res.status(403).json({
        error: 'role_not_verified', role_type: 'AgriCommunityEnterprise', role_status: result.roleStatus, org_name: result.org.org_name,
      });
    }
    req.org = result.org;
    return next();
  } catch (err) {
    return next(err);
  }
}

router.use(requireCommunityEnterpriseOrg);

const ORG_ROLE_TYPE = 'AgriCommunityEnterprise';
const RELATIONSHIP_TYPE = carbonAggregation.ORG_ROLE_TO_RELATIONSHIP_TYPE[ORG_ROLE_TYPE];

// GET /communityenterprise-carbon/eligible-assessments
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

// GET /communityenterprise-carbon/projects
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

// POST /communityenterprise-carbon/projects — create a new project
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

// GET /communityenterprise-carbon/projects/:projectId — detail + member list
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

// POST /communityenterprise-carbon/projects/:projectId/update — POST, not
// PUT/PATCH, per this file's own header note on api.js's capabilities.
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

// POST /communityenterprise-carbon/projects/:projectId/members — body: { assessment_ids: [uuid, ...] }
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

// POST /communityenterprise-carbon/projects/:projectId/members/:memberId/remove
// — POST, not DELETE, per this file's own header note.
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

// ---------------------------------------------------------------------
// Phase 2 — MRV Data Room (see backend/db/grant_carbon_module_mrv_
// evidence.sql). Evidence files themselves go through the existing
// generic POST /storage/upload (not this router) — these endpoints only
// manage the carbon.vvb_evidence link rows on top of that. GET/POST only,
// same constraint as every endpoint above.
// ---------------------------------------------------------------------

// GET /communityenterprise-carbon/projects/:projectId/evidence
router.get('/projects/:projectId/evidence', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId } = req.params;
  try {
    const rows = await withSessionContext('organization', subjectId, (client) =>
      carbonAggregation.listEvidence(client, { orgId: subjectId, projectId }));
    return res.json({ evidence: rows });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// POST /communityenterprise-carbon/projects/:projectId/evidence
// Body: { evidence_type, title, file_id?, geo_data?, note? }
router.post('/projects/:projectId/evidence', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId } = req.params;
  const {
    evidence_type: evidenceType, title, file_id: fileId, geo_data: geoData, note,
  } = req.body || {};
  try {
    const evidence = await withSessionContext('organization', subjectId, async (client) => {
      const created = await carbonAggregation.addEvidence(client, {
        orgId: subjectId, projectId, evidenceType, title, fileId, geoData, note, uploadedBySubjectId: subjectId,
      });
      await logAccess(client, 'create', 'carbon_vvb_evidence', created.evidence_id);
      return created;
    });
    return res.status(201).json({ evidence });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// POST /communityenterprise-carbon/projects/:projectId/evidence/:evidenceId/remove
router.post('/projects/:projectId/evidence/:evidenceId/remove', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId, evidenceId } = req.params;
  try {
    const removed = await withSessionContext('organization', subjectId, async (client) => {
      const ok = await carbonAggregation.removeEvidence(client, { orgId: subjectId, projectId, evidenceId });
      if (ok) await logAccess(client, 'delete', 'carbon_vvb_evidence', evidenceId);
      return ok;
    });
    if (!removed) return res.status(404).json({ error: 'evidence_not_found' });
    return res.json({ ok: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
});

// GET /communityenterprise-carbon/projects/:projectId/export — read-only
// manifest (project + members + evidence list) for staff to assemble a
// document package by hand; no อบก./TGO integration exists yet.
router.get('/projects/:projectId/export', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { projectId } = req.params;
  try {
    const manifest = await withSessionContext('organization', subjectId, (client) =>
      carbonAggregation.getExportManifest(client, { orgId: subjectId, projectId }));
    if (!manifest) return res.status(404).json({ error: 'project_not_found' });
    return res.json(manifest);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
