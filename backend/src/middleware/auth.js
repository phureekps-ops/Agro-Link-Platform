const jwt = require('jsonwebtoken');

const { withSessionContext, logAccess } = require('../db/pool');

/**
 * Verifies the `Authorization: Bearer <jwt>` header issued by POST /auth/login
 * and exposes the validated identity as req.subject = { subjectType, subjectId }.
 *
 * This is the ONLY thing that stands between an HTTP request and being able to
 * claim an identity — everything downstream (withSessionContext, RLS) trusts
 * req.subject completely. So this must run, and must succeed, before any
 * farmer.* route handler executes.
 */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing_bearer_token' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Every OTHER subject type must carry a real subjectId (a farmer_id or
    // org_id) — but 'platform' is deliberately the one exception: there is
    // no per-admin identity table in this sandbox (see POST
    // /auth/admin-login), and security.set_session_context() itself
    // accepts a NULL subject_id specifically for subject_type='platform'.
    if (!payload.subjectType || (payload.subjectType !== 'platform' && !payload.subjectId)) {
      return res.status(401).json({ error: 'malformed_token' });
    }
    req.subject = { subjectType: payload.subjectType, subjectId: payload.subjectId || null };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'token_expired' });
    }
    return res.status(401).json({ error: 'invalid_token' });
  }
}

/**
 * Extra gate for routes that are specifically farmer-facing (the whole
 * /farmer/* slice). A valid JWT for an organization or platform subject is
 * still a valid JWT, but it has no business calling these endpoints.
 */
function requireFarmer(req, res, next) {
  if (!req.subject || req.subject.subjectType !== 'farmer') {
    return res.status(403).json({ error: 'farmer_subject_required' });
  }
  return next();
}

/**
 * Extra gate for the /lender/* slice — mirrors requireFarmer. A valid JWT
 * for a farmer or platform subject is still a valid JWT, but it has no
 * business calling these endpoints. This only checks subjectType — whether
 * the organization is actually a *Lender* (as opposed to a Buyer/Mill/etc.)
 * is checked separately in lender.js, since that requires a DB lookup this
 * middleware doesn't have the connection pool for.
 */
function requireOrganization(req, res, next) {
  if (!req.subject || req.subject.subjectType !== 'organization') {
    return res.status(403).json({ error: 'organization_subject_required' });
  }
  return next();
}

/**
 * Extra gate for the /admin/* slice (platform ops). A valid farmer or
 * organization JWT is still a valid JWT, but it has no business calling
 * these endpoints — only a token issued by POST /auth/admin-login
 * (subjectType='platform') does.
 */
function requirePlatform(req, res, next) {
  if (!req.subject || req.subject.subjectType !== 'platform') {
    return res.status(403).json({ error: 'platform_subject_required' });
  }
  return next();
}

/**
 * Extra gate for the /gov/* slice (Provincial/National government officer
 * portal — see grant_staff_and_government_access.sql). A valid farmer/
 * organization/organization_member/platform JWT is still a valid JWT, but
 * it has no business calling these endpoints.
 */
function requireGovernmentOfficer(req, res, next) {
  if (!req.subject || req.subject.subjectType !== 'government_officer') {
    return res.status(403).json({ error: 'government_officer_subject_required' });
  }
  return next();
}

/**
 * Extra gate for routes meant for an individual cooperative staff login
 * (subjectType='organization_member', subjectId=member_id — NOT org_id).
 * See coopcollection.js's M01 staff section for the scope note on how
 * far this identity currently reaches.
 */
function requireOrganizationMember(req, res, next) {
  if (!req.subject || req.subject.subjectType !== 'organization_member') {
    return res.status(403).json({ error: 'organization_member_subject_required' });
  }
  return next();
}

/**
 * Staff permission scoping — added 2026-08-17 (MULTI_ROLE_ORGANIZATION_
 * ARCHITECTURE.md §5.2). Until now, a cooperative staff login
 * (subjectType='organization_member', see register_staff_member() /
 * coopcollection.js's M01 staff section) could authenticate but could not
 * reach ANY business route — every requireXOrg gate in lender.js/
 * machinery.js/etc. only ever accepted subjectType==='organization' (the
 * shared org-level login). This section is what lets a NAMED staff member
 * reach the business route(s) their OPERATIONAL role (coop.credit_officer,
 * coop.warehouse_officer, ...) is meant to cover — and only those — instead
 * of every staff member seeing everything their org can do.
 *
 * Maps an operational role_code (identity.role, `coop.*`, seeded by
 * grant_cooperative_tenant_foundation.sql — see that file's own
 * descriptions, e.g. coop.credit_officer -> "ดูแล M05 Loan & Agri Credit",
 * coop.warehouse_officer -> "ดูแล M10 Warehouse/Drying") to the business
 * role_type(s) (identity.organization_role) that operational role should be
 * allowed to act as the org for.
 *
 * `null` = oversight roles that should reach EVERY business role_type a
 * retrofitted route asks for (coop.admin/coop.manager, matching their
 * seeded descriptions "จัดการบัญชีผู้ใช้และการตั้งค่า" / "เห็นภาพรวมทุกโมดูล").
 * `[]` = a real, seeded operational role that has no retrofitted route yet
 * (coop.accountant — M04 Cooperative Finance has no route gate wired to
 * this mechanism in this pass, see the architecture doc's file map) —
 * kept as an explicit empty array (not simply omitted) so it reads as
 * "known role, nothing to grant yet" rather than "unrecognized role_code",
 * which resolveEffectiveOrgSubject below treats as a DIFFERENT, harder
 * failure (an operational role this map has never heard of at all).
 * An UNMAPPED role_code (missing from this object entirely) fails closed —
 * never silently falls through to "everything", the opposite direction a
 * missing-key bug would otherwise be dangerous in.
 */
const STAFF_ROLE_TO_BUSINESS_ROLES = {
  'coop.admin': null,
  'coop.manager': null,
  'coop.accountant': [],
  'coop.credit_officer': ['Lender'],
  'coop.member_officer': ['Cooperative'],
  'coop.warehouse_officer': ['DryingYardService'],
};

/**
 * Subject-type gate for a `router.use(...)` at the top of a business route
 * file — the retrofitted equivalent of requireOrganization, widened to also
 * admit a staff (organization_member) login. Whether the specific staff
 * member's operational role actually covers THIS route's business
 * module(s) is a separate, finer-grained check — see
 * resolveEffectiveOrgSubject below, called from the route file's own
 * requireXOrg (e.g. requireLenderOrg) same as it already checks the org's
 * own Verified role status today.
 */
function requireOrganizationOrStaff(req, res, next) {
  const subjectType = req.subject && req.subject.subjectType;
  if (subjectType !== 'organization' && subjectType !== 'organization_member') {
    return res.status(403).json({ error: 'organization_subject_required' });
  }
  return next();
}

/**
 * Called from inside a route file's own requireXOrg (e.g. requireLenderOrg
 * in lender.js, requireMachineryOrg in machinery.js) as the FIRST thing it
 * does, before its existing entity-KYB/role-Verified checks. Two cases:
 *
 *   - req.subject.subjectType === 'organization' (the shared org login,
 *     the only case that has ever existed until now): a no-op, resolves
 *     true immediately — every existing caller/route/query downstream is
 *     completely unaffected by this feature.
 *
 *   - req.subject.subjectType === 'organization_member' (a named staff
 *     login): resolves the staff member's own org_id + operational
 *     role_code, confirms the member is Active and their operational role
 *     covers at least one of `allowedBusinessRoleTypes` (the SAME set the
 *     calling route already checks the ORG holds Verified — this does not
 *     duplicate that check, it just decides whether this staff member is
 *     allowed to trigger it at all), individually audit-logs this
 *     resolution (subject_type='organization_member', subject_id=member_id
 *     — see logAccess call below), then REWRITES req.subject to
 *     `{ subjectType: 'organization', subjectId: <resolved org_id> }`.
 *     That rewrite is deliberate: it means every existing line of code in
 *     lender.js/machinery.js/etc. — none of which has ever needed to know
 *     a request might be coming from a staff member rather than the org's
 *     own login — keeps working completely unchanged. req.actingStaff is
 *     also set (memberId/roleCode) for any route that wants to surface
 *     "logged in as staff member X" in its response (e.g. a dashboard route).
 *
 * Returns true if the caller should proceed, false if a response (403) has
 * already been sent. Does NOT catch errors — a thrown error (e.g. a DB
 * error from withSessionContext) propagates to the caller's own try/catch,
 * same as every other async middleware in this project.
 */
async function resolveEffectiveOrgSubject(req, res, allowedBusinessRoleTypes) {
  const { subjectType, subjectId } = req.subject;

  if (subjectType === 'organization') {
    return true;
  }

  const resolved = await withSessionContext('organization_member', subjectId, async (client) => {
    const member = await client.query(
      `SELECT m.org_id, m.status, sr.role_code
         FROM identity.organization_member m
         LEFT JOIN identity.subject_role sr
           ON sr.subject_type = 'organization_member' AND sr.subject_id = m.member_id
        WHERE m.member_id = $1`,
      [subjectId],
    );
    if (member.rows.length === 0) return { deny: 'staff_member_not_found' };
    const row = member.rows[0];
    if (row.status !== 'Active') return { deny: 'staff_member_inactive' };
    if (!row.role_code) return { deny: 'staff_member_no_operational_role' };

    const allowed = STAFF_ROLE_TO_BUSINESS_ROLES[row.role_code];
    if (allowed === undefined) return { deny: 'operational_role_not_recognized', roleCode: row.role_code };
    const coversModule = allowed === null || allowedBusinessRoleTypes.some((t) => allowed.includes(t));
    if (!coversModule) return { deny: 'operational_role_does_not_cover_module', roleCode: row.role_code };

    await logAccess(client, 'read', 'identity.organization_member', subjectId);
    return { orgId: row.org_id, roleCode: row.role_code };
  });

  if (resolved.deny) {
    res.status(403).json({ error: resolved.deny, role_code: resolved.roleCode });
    return false;
  }

  req.subject = { subjectType: 'organization', subjectId: resolved.orgId };
  req.actingStaff = { memberId: subjectId, roleCode: resolved.roleCode };
  return true;
}

module.exports = {
  requireAuth, requireFarmer, requireOrganization, requirePlatform,
  requireGovernmentOfficer, requireOrganizationMember,
  requireOrganizationOrStaff, resolveEffectiveOrgSubject,
};
