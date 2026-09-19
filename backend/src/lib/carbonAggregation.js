/**
 * AgroLink — Carbon Module, Phase 1 shared aggregation helper.
 *
 * Backs the 3 portal-specific route files (coopcarbon.js,
 * communityenterprisecarbon.js, villagefundcarbon.js — one per org_type,
 * per the user's explicit "แยก 3 ไฟล์" decision so each portal keeps its
 * own copy-pasted requireXOrg() gate and mount prefix) so the actual
 * business logic — querying eligible AWD assessments, creating/reading/
 * updating a carbon.carbon_project, adding/removing members — is written
 * ONCE here rather than 3 times. See backend/db/grant_carbon_module_
 * portal_aggregation.sql for the schema this queries.
 *
 * Every exported function takes an already-open `client` (the caller's
 * route file is expected to be inside a withSessionContext('organization',
 * subjectId, ...) block, same as every other route file in this codebase)
 * PLUS an explicit `orgId` that every query filters by — same "explicit
 * WHERE clause IS the security boundary" convention as farmer360.js and
 * carbon.js (no RLS on carbon.* or identity.farmer_org_relationship).
 *
 * Callers pass their own `orgRoleType` ('Cooperative' | 'AgriCommunity
 * Enterprise' | 'VillageFund') and matching `relationshipType`
 * ('CooperativeMember' | 'CommunityEnterpriseMember' | 'VillageFundMember')
 * — ORG_ROLE_TO_RELATIONSHIP_TYPE below is exported as a convenience for
 * route files that want to derive one from the other instead of hardcoding
 * both.
 */

const ORG_ROLE_TO_RELATIONSHIP_TYPE = {
  Cooperative: 'CooperativeMember',
  AgriCommunityEnterprise: 'CommunityEnterpriseMember',
  VillageFund: 'VillageFundMember',
};

const UPDATABLE_PROJECT_FIELDS = ['project_name', 'status', 'farmer_pool_pct', 'platform_fee_pct', 'note'];
const PROJECT_STATUSES = ['draft', 'mrv_prep', 'submitted_to_tver', 'registered', 'credits_issued'];

// Phase 2 — MRV Data Room (see backend/db/grant_carbon_module_mrv_
// evidence.sql). Evidence can only be added/removed while the project is
// still being prepared — once it moves to 'submitted_to_tver' or beyond,
// the evidence set is treated as frozen (same "UNLOCKED_STATUSES" idea as
// carbon.js's own awd_cycle_assessment editing rule).
const EVIDENCE_TYPES = ['satellite_image', 'gis_boundary', 'certification_document', 'other'];
const EVIDENCE_EDITABLE_STATUSES = ['draft', 'mrv_prep'];

/**
 * Verified AWD assessments belonging to a farmer who currently has an
 * active farmer_org_relationship of `relationshipType` with `orgId`, and
 * that are not already an ACTIVE member of any carbon project (the
 * "1 assessment, 1 project at a time" rule — enforced for real by the
 * partial unique index on carbon.project_cycle_member, this is just the
 * UI-facing pre-filter so staff don't see items they can't actually add).
 */
async function listEligibleAssessments(client, { orgId, relationshipType }) {
  const result = await client.query(
    `SELECT a.assessment_id, a.cycle_id, a.farmer_id, f.full_name AS farmer_name,
            f.farmer_code, a.area_rai, a.estimated_credit_tco2e, a.methodology_ref,
            a.verified_at
       FROM carbon.awd_cycle_assessment a
       JOIN identity.farmer f ON f.farmer_id = a.farmer_id
       JOIN identity.farmer_org_relationship r
         ON r.farmer_id = a.farmer_id AND r.org_id = $1 AND r.relationship_type = $2 AND r.status = 'active'
      WHERE a.status = 'verified'
        AND NOT EXISTS (
          SELECT 1 FROM carbon.project_cycle_member pcm
           WHERE pcm.assessment_id = a.assessment_id AND pcm.status = 'active'
        )
      ORDER BY a.verified_at DESC`,
    [orgId, relationshipType],
  );
  return result.rows;
}

async function listProjects(client, { orgId }) {
  const result = await client.query(
    `SELECT p.project_id, p.org_role_type, p.project_name, p.methodology_ref, p.status,
            p.farmer_pool_pct, p.platform_fee_pct, p.note, p.created_at, p.updated_at,
            COUNT(pcm.member_id) FILTER (WHERE pcm.status = 'active')::int AS member_count,
            COALESCE(SUM(pcm.allocated_credit_tco2e) FILTER (WHERE pcm.status = 'active'), 0) AS total_allocated_tco2e
       FROM carbon.carbon_project p
       LEFT JOIN carbon.project_cycle_member pcm ON pcm.project_id = p.project_id
      WHERE p.org_id = $1
      GROUP BY p.project_id
      ORDER BY p.created_at DESC`,
    [orgId],
  );
  return result.rows;
}

async function createProject(client, { orgId, orgRoleType, createdBySubjectId, projectName, methodologyRef, farmerPoolPct, platformFeePct, note }) {
  if (!projectName || !String(projectName).trim()) {
    const err = new Error('project_name_required');
    err.status = 400;
    throw err;
  }
  const result = await client.query(
    `INSERT INTO carbon.carbon_project (
       org_id, org_role_type, project_name, methodology_ref, farmer_pool_pct, platform_fee_pct, note, created_by_subject_id
     ) VALUES ($1, $2, $3, COALESCE($4, 'T-VER_AWD_RICE_v1_estimate'), COALESCE($5, 80.00), COALESCE($6, 10.00), $7, $8)
     RETURNING *`,
    [orgId, orgRoleType, projectName, methodologyRef || null, farmerPoolPct != null ? farmerPoolPct : null,
      platformFeePct != null ? platformFeePct : null, note || null, createdBySubjectId],
  );
  return result.rows[0];
}

async function getProjectDetail(client, { orgId, projectId }) {
  const projectResult = await client.query(
    `SELECT * FROM carbon.carbon_project WHERE project_id = $1 AND org_id = $2`,
    [projectId, orgId],
  );
  if (projectResult.rows.length === 0) return null;

  const membersResult = await client.query(
    `SELECT pcm.member_id, pcm.assessment_id, pcm.farmer_id, f.full_name AS farmer_name, f.farmer_code,
            pcm.allocated_credit_tco2e, pcm.status, pcm.added_at, pcm.removed_at,
            a.area_rai, a.cycle_id
       FROM carbon.project_cycle_member pcm
       JOIN identity.farmer f ON f.farmer_id = pcm.farmer_id
       JOIN carbon.awd_cycle_assessment a ON a.assessment_id = pcm.assessment_id
      WHERE pcm.project_id = $1
      ORDER BY pcm.status ASC, pcm.added_at DESC`,
    [projectId],
  );

  return { project: projectResult.rows[0], members: membersResult.rows };
}

async function updateProject(client, { orgId, projectId, fields }) {
  const setClauses = [];
  const values = [];
  for (const key of UPDATABLE_PROJECT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== undefined) {
      if (key === 'status' && !PROJECT_STATUSES.includes(fields[key])) {
        const err = new Error('invalid_status');
        err.status = 400;
        throw err;
      }
      values.push(fields[key]);
      setClauses.push(`${key} = $${values.length}`);
    }
  }
  if (setClauses.length === 0) {
    const err = new Error('no_fields_to_update');
    err.status = 400;
    throw err;
  }
  values.push(projectId, orgId);
  const result = await client.query(
    `UPDATE carbon.carbon_project SET ${setClauses.join(', ')}, updated_at = now()
      WHERE project_id = $${values.length - 1} AND org_id = $${values.length}
      RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

/**
 * Adds a batch of assessment_ids to a project. Each id is processed
 * independently so one bad/ineligible id doesn't fail the whole batch —
 * the caller gets back which ones succeeded and which failed and why.
 * allocated_credit_tco2e is snapshotted from the assessment's own
 * estimated_credit_tco2e at add time (same "snapshot at the moment of the
 * action" convention as carbon.awd_cycle_assessment itself snapshotting
 * carbon.awd_config's values).
 */
async function addMembers(client, { orgId, relationshipType, projectId, assessmentIds, addedBySubjectId }) {
  const project = await client.query(
    `SELECT project_id FROM carbon.carbon_project WHERE project_id = $1 AND org_id = $2`,
    [projectId, orgId],
  );
  if (project.rows.length === 0) {
    const err = new Error('project_not_found');
    err.status = 404;
    throw err;
  }

  const added = [];
  const failed = [];
  for (const assessmentId of assessmentIds) {
    try {
      const eligible = await client.query(
        `SELECT a.assessment_id, a.farmer_id, a.estimated_credit_tco2e
           FROM carbon.awd_cycle_assessment a
           JOIN identity.farmer_org_relationship r
             ON r.farmer_id = a.farmer_id AND r.org_id = $1 AND r.relationship_type = $2 AND r.status = 'active'
          WHERE a.assessment_id = $3 AND a.status = 'verified'`,
        [orgId, relationshipType, assessmentId],
      );
      if (eligible.rows.length === 0) {
        failed.push({ assessment_id: assessmentId, reason: 'not_eligible' });
        continue;
      }
      const row = eligible.rows[0];
      const insertResult = await client.query(
        `INSERT INTO carbon.project_cycle_member (
           project_id, assessment_id, farmer_id, allocated_credit_tco2e, added_by_subject_id
         ) VALUES ($1, $2, $3, $4, $5)
         RETURNING member_id`,
        [projectId, assessmentId, row.farmer_id, row.estimated_credit_tco2e, addedBySubjectId],
      );
      added.push({ assessment_id: assessmentId, member_id: insertResult.rows[0].member_id });
    } catch (err) {
      if (err.code === '23505') {
        // idx_project_cycle_member_one_active_assessment — already an
        // active member of some project (this one or another org's).
        failed.push({ assessment_id: assessmentId, reason: 'already_in_a_project' });
      } else {
        failed.push({ assessment_id: assessmentId, reason: 'error' });
      }
    }
  }
  return { added, failed };
}

async function removeMember(client, { orgId, projectId, memberId }) {
  const result = await client.query(
    `UPDATE carbon.project_cycle_member pcm
        SET status = 'removed', removed_at = now()
       FROM carbon.carbon_project p
      WHERE pcm.project_id = p.project_id
        AND p.org_id = $1 AND pcm.project_id = $2 AND pcm.member_id = $3 AND pcm.status = 'active'
      RETURNING pcm.member_id`,
    [orgId, projectId, memberId],
  );
  return result.rows.length > 0;
}

/** Loads a project row scoped to orgId, or null. Shared by the evidence
 * functions below so they all fail the same way on a missing/foreign
 * project before touching carbon.vvb_evidence. */
async function loadOwnedProject(client, { orgId, projectId }) {
  const result = await client.query(
    `SELECT project_id, status FROM carbon.carbon_project WHERE project_id = $1 AND org_id = $2`,
    [projectId, orgId],
  );
  return result.rows[0] || null;
}

async function listEvidence(client, { orgId, projectId }) {
  const project = await loadOwnedProject(client, { orgId, projectId });
  if (!project) {
    const err = new Error('project_not_found');
    err.status = 404;
    throw err;
  }
  const result = await client.query(
    `SELECT e.evidence_id, e.evidence_type, e.title, e.geo_data, e.note, e.created_at,
            e.file_id, f.original_filename, f.content_type, f.byte_size
       FROM carbon.vvb_evidence e
       LEFT JOIN storage.file_object f ON f.file_id = e.file_id
      WHERE e.project_id = $1
      ORDER BY e.created_at DESC`,
    [projectId],
  );
  return result.rows;
}

/**
 * Attaches one piece of MRV evidence to a project. `fileId`, when given,
 * MUST already be a file this same organization uploaded via the generic
 * POST /storage/upload (checked here against storage.file_object's own
 * owner_subject_type/owner_subject_id) — otherwise an org could link a
 * file_id it merely guessed at. `geoData` is a plain-text/GeoJSON field
 * for 'gis_boundary' evidence instead of a file (see the migration's own
 * header comment for why no GIS file type is accepted through storage.js).
 */
async function addEvidence(client, { orgId, projectId, evidenceType, title, fileId, geoData, note, uploadedBySubjectId }) {
  const project = await loadOwnedProject(client, { orgId, projectId });
  if (!project) {
    const err = new Error('project_not_found');
    err.status = 404;
    throw err;
  }
  if (!EVIDENCE_EDITABLE_STATUSES.includes(project.status)) {
    const err = new Error('project_not_editable');
    err.status = 409;
    throw err;
  }
  if (!EVIDENCE_TYPES.includes(evidenceType)) {
    const err = new Error('invalid_evidence_type');
    err.status = 400;
    throw err;
  }
  if (!title || !String(title).trim()) {
    const err = new Error('title_required');
    err.status = 400;
    throw err;
  }
  if (!fileId && !geoData) {
    const err = new Error('file_or_geo_data_required');
    err.status = 400;
    throw err;
  }

  if (fileId) {
    const fileCheck = await client.query(
      `SELECT file_id FROM storage.file_object WHERE file_id = $1 AND owner_subject_type = 'organization' AND owner_subject_id = $2`,
      [fileId, orgId],
    );
    if (fileCheck.rows.length === 0) {
      const err = new Error('file_not_owned_by_org');
      err.status = 403;
      throw err;
    }
  }

  const result = await client.query(
    `INSERT INTO carbon.vvb_evidence (project_id, evidence_type, title, file_id, geo_data, note, uploaded_by_subject_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING evidence_id`,
    [projectId, evidenceType, title, fileId || null, geoData || null, note || null, uploadedBySubjectId],
  );
  return result.rows[0];
}

async function removeEvidence(client, { orgId, projectId, evidenceId }) {
  const project = await loadOwnedProject(client, { orgId, projectId });
  if (!project) {
    const err = new Error('project_not_found');
    err.status = 404;
    throw err;
  }
  if (!EVIDENCE_EDITABLE_STATUSES.includes(project.status)) {
    const err = new Error('project_not_editable');
    err.status = 409;
    throw err;
  }
  const result = await client.query(
    `DELETE FROM carbon.vvb_evidence WHERE evidence_id = $1 AND project_id = $2 RETURNING evidence_id`,
    [evidenceId, projectId],
  );
  return result.rows.length > 0;
}

/**
 * Everything needed for staff to assemble a document package for the
 * external verifier (VVB) / อบก.-TGO by hand — see this module's own
 * Phase 2 scope note: no direct อบก./TGO integration exists, so this is a
 * read-only manifest (project + members + evidence list, each evidence
 * item still downloaded individually via GET /storage/:file_id) rather
 * than a generated archive file.
 */
async function getExportManifest(client, { orgId, projectId }) {
  const detail = await getProjectDetail(client, { orgId, projectId });
  if (!detail) return null;
  const evidence = await listEvidence(client, { orgId, projectId });
  return { ...detail, evidence };
}

module.exports = {
  ORG_ROLE_TO_RELATIONSHIP_TYPE,
  EVIDENCE_TYPES,
  listEligibleAssessments,
  listProjects,
  createProject,
  getProjectDetail,
  updateProject,
  addMembers,
  removeMember,
  listEvidence,
  addEvidence,
  removeEvidence,
  getExportManifest,
};
