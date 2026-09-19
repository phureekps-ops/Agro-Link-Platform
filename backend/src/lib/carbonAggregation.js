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
 *
 * Phase 3 (marketplace/matchOrderToListing/distributions, near the bottom
 * of this file) also adds functions called from buyercarbon.js (buyer_org_id
 * scoped, no project ownership involved) and from admin.js under a
 * 'platform' session (matching + admin listing views — not scoped to any
 * one orgId, since Platform Ops sees across all orgs).
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

// Phase 3 — Marketplace + Automatic Revenue Sharing (see backend/db/
// grant_carbon_module_marketplace.sql). A project can only be listed for
// sale once it has actually reached 'registered' (or later, 'credits_
// issued') — listing an in-prep project would let a seller advertise
// credits that may never actually be issued.
const LISTING_ELIGIBLE_PROJECT_STATUSES = ['registered', 'credits_issued'];

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

// ===========================================================================
// Phase 3 — Marketplace + Automatic Revenue Sharing (see backend/db/
// grant_carbon_module_marketplace.sql). Seller-side (this file, used by
// coopcarbon.js / communityenterprisecarbon.js / villagefundcarbon.js) below;
// buyer-side and admin/platform-side functions further down.
// ===========================================================================

async function listListingsForOrg(client, { orgId }) {
  const result = await client.query(
    `SELECT l.listing_id, l.project_id, p.project_name, l.listed_credit_tco2e,
            l.asking_price_per_tco2e, l.status, l.note, l.created_at, l.updated_at
       FROM carbon.marketplace_listing l
       JOIN carbon.carbon_project p ON p.project_id = l.project_id
      WHERE l.org_id = $1
      ORDER BY l.created_at DESC`,
    [orgId],
  );
  return result.rows;
}

/**
 * Creates a marketplace listing for a project's credits. Only projects the
 * org owns AND that have already reached 'registered'/'credits_issued' are
 * listable (LISTING_ELIGIBLE_PROJECT_STATUSES) — a project still in MRV
 * prep has no real credits yet to advertise.
 */
async function createListing(client, { orgId, projectId, listedCreditTco2e, askingPricePerTco2e, note, createdBySubjectId }) {
  const project = await loadOwnedProject(client, { orgId, projectId });
  if (!project) {
    const err = new Error('project_not_found');
    err.status = 404;
    throw err;
  }
  if (!LISTING_ELIGIBLE_PROJECT_STATUSES.includes(project.status)) {
    const err = new Error('project_not_registered');
    err.status = 409;
    throw err;
  }
  const listedCredit = Number(listedCreditTco2e);
  const askingPrice = Number(askingPricePerTco2e);
  if (!(listedCredit > 0)) {
    const err = new Error('listed_credit_tco2e_must_be_positive');
    err.status = 400;
    throw err;
  }
  if (!(askingPrice > 0)) {
    const err = new Error('asking_price_per_tco2e_must_be_positive');
    err.status = 400;
    throw err;
  }
  const result = await client.query(
    `INSERT INTO carbon.marketplace_listing (project_id, org_id, listed_credit_tco2e, asking_price_per_tco2e, note, created_by_subject_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [projectId, orgId, listedCredit, askingPrice, note || null, createdBySubjectId],
  );
  return result.rows[0];
}

async function cancelListing(client, { orgId, listingId }) {
  const result = await client.query(
    `UPDATE carbon.marketplace_listing
        SET status = 'cancelled', updated_at = now()
      WHERE listing_id = $1 AND org_id = $2 AND status = 'open'
      RETURNING listing_id`,
    [listingId, orgId],
  );
  return result.rows.length > 0;
}

/**
 * All revenue_distribution rows tied to any of this org's projects — BOTH
 * the org's own cut (recipient_type='organization') AND every farmer cut
 * (recipient_type='farmer') the org itself is responsible for paying out
 * through its own channels (see this module's own payout_status note) —
 * so the org can see everything it owes at a glance.
 */
async function listDistributionsForOrg(client, { orgId }) {
  const result = await client.query(
    `SELECT d.distribution_id, d.order_id, d.project_id, p.project_name, d.recipient_type,
            d.recipient_org_id, d.recipient_farmer_id, f.full_name AS farmer_name, f.farmer_code,
            d.amount_baht, d.payout_status, d.paid_at, d.paid_note, d.created_at
       FROM carbon.revenue_distribution d
       JOIN carbon.carbon_project p ON p.project_id = d.project_id
       LEFT JOIN identity.farmer f ON f.farmer_id = d.recipient_farmer_id
      WHERE p.org_id = $1
      ORDER BY d.created_at DESC`,
    [orgId],
  );
  return result.rows;
}

async function listDistributionsForProject(client, { orgId, projectId }) {
  const project = await loadOwnedProject(client, { orgId, projectId });
  if (!project) {
    const err = new Error('project_not_found');
    err.status = 404;
    throw err;
  }
  const result = await client.query(
    `SELECT d.distribution_id, d.order_id, d.recipient_type, d.recipient_org_id,
            d.recipient_farmer_id, f.full_name AS farmer_name, f.farmer_code,
            d.amount_baht, d.payout_status, d.paid_at, d.paid_note, d.created_at
       FROM carbon.revenue_distribution d
       LEFT JOIN identity.farmer f ON f.farmer_id = d.recipient_farmer_id
      WHERE d.project_id = $1
      ORDER BY d.created_at DESC`,
    [projectId],
  );
  return result.rows;
}

/**
 * No real money moves through AgroLink (see this module's own Phase 3
 * scope note) — the org pays a farmer, or receives its own cut, through
 * its own existing channels outside the platform, then flips this flag
 * here purely as an audit trail. Scoped to the org that owns the
 * distribution's project (i.e. the org responsible for paying it out, or
 * confirming its own receipt), never the recipient farmer directly (there
 * is no farmer-facing "mark paid" — see GET /farmer/carbon/revenue below,
 * read-only for farmers).
 */
async function markDistributionPaid(client, { orgId, distributionId, paidNote }) {
  const result = await client.query(
    `UPDATE carbon.revenue_distribution d
        SET payout_status = 'paid', paid_at = now(), paid_note = $3
       FROM carbon.carbon_project p
      WHERE d.project_id = p.project_id
        AND p.org_id = $1 AND d.distribution_id = $2 AND d.payout_status = 'pending'
      RETURNING d.distribution_id`,
    [orgId, distributionId, paidNote || null],
  );
  return result.rows.length > 0;
}

/** For the farmer-facing GET /farmer/carbon/revenue endpoint — read-only,
 * a farmer only ever sees their own allocated amounts, never anyone else's
 * and never the org's own cut. */
async function listDistributionsForFarmer(client, { farmerId }) {
  const result = await client.query(
    `SELECT d.distribution_id, d.order_id, d.project_id, p.project_name, d.amount_baht,
            d.payout_status, d.paid_at, d.created_at
       FROM carbon.revenue_distribution d
       JOIN carbon.carbon_project p ON p.project_id = d.project_id
      WHERE d.recipient_type = 'farmer' AND d.recipient_farmer_id = $1
      ORDER BY d.created_at DESC`,
    [farmerId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------
// Phase 3 — Buyer side (used by buyercarbon.js, buyer_org_id scoped, no
// project ownership involved — a Buyer org never sees or touches a
// seller's carbon_project directly, only the listing/order/distribution
// rows exposed through these functions).
// ---------------------------------------------------------------------

async function createOrder(client, { buyerOrgId, requestedCreditTco2e, offeredPricePerTco2e, note }) {
  const requestedCredit = Number(requestedCreditTco2e);
  const offeredPrice = Number(offeredPricePerTco2e);
  if (!(requestedCredit > 0)) {
    const err = new Error('requested_credit_tco2e_must_be_positive');
    err.status = 400;
    throw err;
  }
  if (!(offeredPrice > 0)) {
    const err = new Error('offered_price_per_tco2e_must_be_positive');
    err.status = 400;
    throw err;
  }
  const result = await client.query(
    `INSERT INTO carbon.marketplace_order (buyer_org_id, requested_credit_tco2e, offered_price_per_tco2e, note)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [buyerOrgId, requestedCredit, offeredPrice, note || null],
  );
  return result.rows[0];
}

async function listOrdersForBuyer(client, { buyerOrgId }) {
  const result = await client.query(
    `SELECT o.*, l.project_id AS matched_project_id, p.project_name AS matched_project_name
       FROM carbon.marketplace_order o
       LEFT JOIN carbon.marketplace_listing l ON l.listing_id = o.listing_id
       LEFT JOIN carbon.carbon_project p ON p.project_id = l.project_id
      WHERE o.buyer_org_id = $1
      ORDER BY o.created_at DESC`,
    [buyerOrgId],
  );
  return result.rows;
}

async function cancelOrder(client, { buyerOrgId, orderId }) {
  const result = await client.query(
    `UPDATE carbon.marketplace_order
        SET status = 'cancelled', updated_at = now()
      WHERE order_id = $1 AND buyer_org_id = $2 AND status = 'pending'
      RETURNING order_id`,
    [orderId, buyerOrgId],
  );
  return result.rows.length > 0;
}

// ---------------------------------------------------------------------
// Phase 3 — Platform Ops / admin side (used by admin.js under a 'platform'
// session; not scoped to any one orgId since Platform Ops sees across all
// orgs — matching itself is deliberately MANUAL, never self-serve, see
// this module's own header note).
// ---------------------------------------------------------------------

async function listOpenListings(client) {
  const result = await client.query(
    `SELECT l.listing_id, l.project_id, p.project_name, l.org_id, o.org_name, o.org_type,
            l.listed_credit_tco2e, l.asking_price_per_tco2e, l.note, l.created_at
       FROM carbon.marketplace_listing l
       JOIN carbon.carbon_project p ON p.project_id = l.project_id
       JOIN identity.organization o ON o.org_id = l.org_id
      WHERE l.status = 'open'
      ORDER BY l.created_at ASC`,
  );
  return result.rows;
}

async function listPendingOrders(client) {
  const result = await client.query(
    `SELECT o.order_id, o.buyer_org_id, org.org_name AS buyer_org_name, o.requested_credit_tco2e,
            o.offered_price_per_tco2e, o.note, o.created_at
       FROM carbon.marketplace_order o
       JOIN identity.organization org ON org.org_id = o.buyer_org_id
      WHERE o.status = 'pending'
      ORDER BY o.created_at ASC`,
  );
  return result.rows;
}

/**
 * Core Revenue Sharing Engine — Platform Ops only. Pairs one pending order
 * to one open listing IN FULL: this pass does not support partial-sale /
 * remaining-quantity tracking on the listing (see the migration file's own
 * header comment for this deliberate scope limitation) — matchedCreditTco2e
 * must exactly exhaust the listing; a seller with more credit than one
 * order wants must create a second, separate listing for the remainder.
 *
 * Formula (see the design doc's Revenue Sharing Engine section / worked
 * example — 100 tCO2e @ 300 baht = 30,000 Gross; -2,000 cost; -3,000 (10%)
 * fee = 25,000 Net; 80% (20,000) to Farmer Pool by credit share; 20%
 * (5,000) to org):
 *   Gross Revenue = matchedCreditTco2e * matchedPricePerTco2e
 *   Net Revenue   = Gross - projectCostBaht - (platform_fee_pct% * Gross)
 *   Farmer Pool   = farmer_pool_pct% * Net Revenue, split among the
 *                   project's ACTIVE project_cycle_member rows
 *                   proportionally by their allocated_credit_tco2e share
 *   Org Amount    = Net Revenue - Farmer Pool
 * farmer_pool_pct/platform_fee_pct are read from the LISTING's own project
 * (configured per-project at creation — grant_carbon_module_portal_
 * aggregation.sql), not a system-wide constant.
 */
async function matchOrderToListing(client, { orderId, listingId, matchedCreditTco2e, matchedPricePerTco2e, projectCostBaht, matchedBySubjectId }) {
  const orderResult = await client.query(
    `SELECT * FROM carbon.marketplace_order WHERE order_id = $1 FOR UPDATE`,
    [orderId],
  );
  if (orderResult.rows.length === 0) {
    const err = new Error('order_not_found');
    err.status = 404;
    throw err;
  }
  const order = orderResult.rows[0];
  if (order.status !== 'pending') {
    const err = new Error('order_not_pending');
    err.status = 409;
    throw err;
  }

  const listingResult = await client.query(
    `SELECT * FROM carbon.marketplace_listing WHERE listing_id = $1 FOR UPDATE`,
    [listingId],
  );
  if (listingResult.rows.length === 0) {
    const err = new Error('listing_not_found');
    err.status = 404;
    throw err;
  }
  const listing = listingResult.rows[0];
  if (listing.status !== 'open') {
    const err = new Error('listing_not_open');
    err.status = 409;
    throw err;
  }

  const matchedCredit = Number(matchedCreditTco2e);
  const matchedPrice = Number(matchedPricePerTco2e);
  const projectCost = projectCostBaht != null ? Number(projectCostBaht) : 0;
  if (!(matchedCredit > 0)) {
    const err = new Error('matched_credit_tco2e_must_be_positive');
    err.status = 400;
    throw err;
  }
  if (!(matchedPrice > 0)) {
    const err = new Error('matched_price_per_tco2e_must_be_positive');
    err.status = 400;
    throw err;
  }
  if (projectCost < 0) {
    const err = new Error('project_cost_baht_cannot_be_negative');
    err.status = 400;
    throw err;
  }
  // "จับคู่ = ขายเต็มจำนวน" — see migration header comment. A partial match
  // (either side left with a remainder) is out of scope for this pass.
  if (Math.abs(matchedCredit - Number(listing.listed_credit_tco2e)) > 0.0001) {
    const err = new Error('matched_credit_must_equal_listed_credit');
    err.status = 400;
    throw err;
  }
  if (matchedCredit > Number(order.requested_credit_tco2e) + 0.0001) {
    const err = new Error('matched_credit_exceeds_requested_credit');
    err.status = 400;
    throw err;
  }

  const projectResult = await client.query(
    `SELECT project_id, org_id, farmer_pool_pct, platform_fee_pct FROM carbon.carbon_project WHERE project_id = $1`,
    [listing.project_id],
  );
  const project = projectResult.rows[0];
  if (!project) {
    const err = new Error('project_not_found');
    err.status = 404;
    throw err;
  }

  const grossRevenue = matchedCredit * matchedPrice;
  const platformFee = grossRevenue * (Number(project.platform_fee_pct) / 100);
  const netRevenue = grossRevenue - projectCost - platformFee;
  if (netRevenue < 0) {
    const err = new Error('net_revenue_negative');
    err.status = 400;
    throw err;
  }
  const farmerPoolAmount = netRevenue * (Number(project.farmer_pool_pct) / 100);
  const orgAmount = netRevenue - farmerPoolAmount;

  const membersResult = await client.query(
    `SELECT farmer_id, allocated_credit_tco2e FROM carbon.project_cycle_member
      WHERE project_id = $1 AND status = 'active' AND allocated_credit_tco2e > 0`,
    [project.project_id],
  );
  const members = membersResult.rows;
  if (members.length === 0) {
    const err = new Error('project_has_no_active_members');
    err.status = 409;
    throw err;
  }
  const totalAllocated = members.reduce((sum, m) => sum + Number(m.allocated_credit_tco2e), 0);

  // Round each farmer's share to the nearest satang (2 decimals); give the
  // last member whatever remains so the shares sum exactly to the rounded
  // farmer pool amount instead of drifting from rounding every share down.
  const roundedFarmerPoolAmount = Math.round(farmerPoolAmount * 100) / 100;
  let assigned = 0;
  const farmerShares = members.map((m, idx) => {
    if (idx === members.length - 1) {
      const amount = Math.round((roundedFarmerPoolAmount - assigned) * 100) / 100;
      return { farmerId: m.farmer_id, amount };
    }
    const share = Number(m.allocated_credit_tco2e) / totalAllocated;
    const amount = Math.round(roundedFarmerPoolAmount * share * 100) / 100;
    assigned += amount;
    return { farmerId: m.farmer_id, amount };
  });

  await client.query(
    `UPDATE carbon.marketplace_order
        SET status = 'matched', listing_id = $1, matched_credit_tco2e = $2, matched_price_per_tco2e = $3,
            project_cost_baht = $4, matched_by_subject_id = $5, matched_at = now(), updated_at = now()
      WHERE order_id = $6`,
    [listingId, matchedCredit, matchedPrice, projectCost, matchedBySubjectId, orderId],
  );
  await client.query(
    `UPDATE carbon.marketplace_listing SET status = 'matched', updated_at = now() WHERE listing_id = $1`,
    [listingId],
  );

  const distributions = [];
  const orgDist = await client.query(
    `INSERT INTO carbon.revenue_distribution (order_id, project_id, recipient_type, recipient_org_id, amount_baht)
     VALUES ($1, $2, 'organization', $3, $4)
     RETURNING *`,
    [orderId, project.project_id, project.org_id, Math.round(orgAmount * 100) / 100],
  );
  distributions.push(orgDist.rows[0]);

  for (const share of farmerShares) {
    if (share.amount <= 0) continue;
    const farmerDist = await client.query(
      `INSERT INTO carbon.revenue_distribution (order_id, project_id, recipient_type, recipient_farmer_id, amount_baht)
       VALUES ($1, $2, 'farmer', $3, $4)
       RETURNING *`,
      [orderId, project.project_id, share.farmerId, share.amount],
    );
    distributions.push(farmerDist.rows[0]);
  }

  return {
    gross_revenue: Math.round(grossRevenue * 100) / 100,
    platform_fee: Math.round(platformFee * 100) / 100,
    net_revenue: Math.round(netRevenue * 100) / 100,
    farmer_pool_amount: roundedFarmerPoolAmount,
    org_amount: Math.round(orgAmount * 100) / 100,
    distributions,
  };
}

/** Completes an order once every one of its revenue_distribution rows has
 * been marked 'paid' — a final closing step Platform Ops triggers by hand
 * (no automatic detection of real-world payment exists, see this module's
 * own no-payment-system note). */
async function completeOrder(client, { orderId }) {
  const orderResult = await client.query(
    `SELECT order_id, status FROM carbon.marketplace_order WHERE order_id = $1`,
    [orderId],
  );
  if (orderResult.rows.length === 0) {
    const err = new Error('order_not_found');
    err.status = 404;
    throw err;
  }
  if (orderResult.rows[0].status !== 'matched') {
    const err = new Error('order_not_matched');
    err.status = 409;
    throw err;
  }
  const unpaid = await client.query(
    `SELECT distribution_id FROM carbon.revenue_distribution WHERE order_id = $1 AND payout_status <> 'paid'`,
    [orderId],
  );
  if (unpaid.rows.length > 0) {
    const err = new Error('distributions_not_all_paid');
    err.status = 409;
    throw err;
  }
  const result = await client.query(
    `UPDATE carbon.marketplace_order SET status = 'completed', updated_at = now() WHERE order_id = $1 RETURNING *`,
    [orderId],
  );
  return result.rows[0];
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
  listListingsForOrg,
  createListing,
  cancelListing,
  listDistributionsForOrg,
  listDistributionsForProject,
  markDistributionPaid,
  listDistributionsForFarmer,
  createOrder,
  listOrdersForBuyer,
  cancelOrder,
  listOpenListings,
  listPendingOrders,
  matchOrderToListing,
  completeOrder,
};
