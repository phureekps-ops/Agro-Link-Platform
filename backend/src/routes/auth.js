const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const { pool, withSessionContext, withServiceRole, logAccess } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const UNIQUE_VIOLATION = '23505';
const REGISTER_CONSTRAINT_ERRORS = {
  uq_farmer_phone: 'phone_already_registered',
  uq_farmer_national_id_hash: 'national_id_already_registered',
  farmer_auth_subject_id_key: 'subject_claim_collision',
};

// Organization types a service provider can self-register as through
// POST /auth/org-register. Deliberately excludes 'Bank' and 'VillageFund'
// from identity.organization's full org_type list — those read as
// institutional/government-linked entities that wouldn't plausibly sign up
// through a public web form in a real deployment, unlike the genuine
// private-business categories below (all of which a real company could
// reasonably self-serve register as).
const ORG_SELF_REGISTER_TYPES = [
  'Cooperative', 'Mill', 'InputSupplier', 'Lender', 'Logistics', 'Buyer',
  'TractorService', 'DroneService', 'HarvesterService', 'TruckService', 'DryingYardService',
];
const ORG_REGISTER_CONSTRAINT_ERRORS = {
  uq_organization_tax_id: 'tax_id_already_registered',
  organization_auth_subject_id_key: 'subject_claim_collision',
  uq_vendor_business_registration_no: 'tax_id_already_registered',
};

// national_id_hash exists specifically so the raw national ID is never
// stored — only a one-way hash of it. This is a plain SHA-256, adequate for
// this sandbox; a production system would add a per-deployment pepper.
function hashNationalId(nationalId) {
  return crypto.createHash('sha256').update(String(nationalId).trim()).digest('hex');
}

// Real OIDC signup would come back from the IdP with a `sub` claim already
// assigned. Since no IdP is connected here (same mock as /auth/login), we
// mint one ourselves so this new farmer has something to log in with next
// time — and so this request can auto-issue a session token immediately.
function generateAuthSubjectId() {
  return `oidc|farmer-${crypto.randomUUID()}`;
}

function generateOrgAuthSubjectId() {
  return `oidc|org-${crypto.randomUUID()}`;
}

/**
 * POST /auth/login
 * Body: { external_subject_claim: string }
 *
 * SIMPLIFICATION / MOCK, called out explicitly in the README:
 * In a real deployment, `external_subject_claim` would be the `sub` claim of
 * an already-verified OIDC token (verified against the IdP's JWKS by an
 * upstream gateway or by this service). This sandbox has no IdP connected,
 * so the caller passes the claim value directly and we trust it as-is, then
 * resolve it to an internal (subjectType, subjectId) via the same
 * security.resolve_subject_from_external_claim() function Layer 8 designed
 * for exactly this purpose. Everything downstream of login (JWT issuance,
 * RLS, audit) is real.
 *
 * This query runs on the raw pool (agrolink_backend), NOT through
 * withSessionContext — there is no identity to set session context for yet;
 * that's precisely what this call resolves. agrolink_backend was granted a
 * direct EXECUTE on this one function for exactly this pre-identity step.
 */
router.post('/login', async (req, res, next) => {
  const { external_subject_claim } = req.body || {};

  if (!external_subject_claim || typeof external_subject_claim !== 'string') {
    return res.status(400).json({ error: 'external_subject_claim_required' });
  }

  try {
    const result = await pool.query(
      'SELECT subject_type, subject_id FROM security.resolve_subject_from_external_claim($1)',
      [external_subject_claim],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'unrecognized_subject_claim' });
    }

    const { subject_type: subjectType, subject_id: subjectId } = result.rows[0];

    const token = jwt.sign(
      { subjectType, subjectId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
    );

    return res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: process.env.JWT_EXPIRES_IN || '8h',
      subject_type: subjectType,
      subject_id: subjectId,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /auth/register
 * Body: { full_name, phone, national_id, region_code }
 *
 * Creates a new farmer (identity.farmer, status='pending_kyc') and
 * immediately signs them in — matches how most real signup flows behave,
 * and avoids a confusing extra step where the farmer has to somehow know
 * to go log in with a claim they never saw.
 *
 * identity.farmer has no RLS policies (verified: no forced-RLS on this
 * table), so this only needs SET ROLE agrolink_app, via withServiceRole() —
 * there is no existing subject to set session context to until the INSERT
 * below returns a farmer_id. Once it has one, it sets session context to
 * that brand-new farmer just long enough to log the registration itself via
 * audit.log_access(), on the same client, before releasing.
 */
router.post('/register', async (req, res, next) => {
  const { full_name: fullName, phone, national_id: nationalId, region_code: regionCode } = req.body || {};

  if (!fullName || !phone || !nationalId || !regionCode) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['full_name', 'phone', 'national_id', 'region_code'],
    });
  }

  const nationalIdHash = hashNationalId(nationalId);
  const authSubjectId = generateAuthSubjectId();

  try {
    const farmerId = await withServiceRole(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO identity.farmer (full_name, phone, national_id_hash, region_code, auth_subject_id, status)
         VALUES ($1, $2, $3, $4, $5, 'pending_kyc')
         RETURNING farmer_id`,
        [fullName, phone, nationalIdHash, regionCode, authSubjectId],
      );
      const newFarmerId = rows[0].farmer_id;

      // Every subject needs a role grant before set_session_context() (and
      // therefore RLS) will recognize them at all — every previously-seeded
      // farmer already had one; a brand-new registration needs it created
      // here. 'farmer.self' matches the role already used for every other
      // seeded farmer.
      await client.query(
        `INSERT INTO identity.subject_role (subject_type, subject_id, role_code)
         VALUES ('farmer', $1, 'farmer.self')`,
        [newFarmerId],
      );

      await client.query('SELECT security.set_session_context($1, $2)', ['farmer', newFarmerId]);
      await logAccess(client, 'write', 'identity.farmer', newFarmerId);

      return newFarmerId;
    });

    const token = jwt.sign(
      { subjectType: 'farmer', subjectId: farmerId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
    );

    return res.status(201).json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: process.env.JWT_EXPIRES_IN || '8h',
      subject_type: 'farmer',
      subject_id: farmerId,
      status: 'pending_kyc',
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      const reason = REGISTER_CONSTRAINT_ERRORS[err.constraint] || 'duplicate_value';
      return res.status(409).json({ error: reason });
    }
    return next(err);
  }
});

/**
 * POST /auth/org-register
 * Body: { org_name, tax_id, org_type }
 *
 * Self-service sign-up for service-provider organizations (lenders, buyers,
 * cooperatives, mills, input suppliers, and farm-machinery/mechanization
 * services — see ORG_SELF_REGISTER_TYPES above). Before this endpoint,
 * every organization in the system was inserted directly via a superuser
 * connection during seeding; there was no way for a new business to apply
 * to join AgroLink through the API at all — this was a documented gap in
 * both READMEs. This closes the *submission* half of the KYB loop; the
 * Platform Ops admin slice (`src/routes/admin.js`) already covers the
 * *approval* half.
 *
 * The new organization always lands at kyb_status = 'Pending' — nothing
 * here auto-approves. A brand-new `partner.vendor_profile` row is also
 * created (using `tax_id` as `business_registration_no`, a real
 * simplification: a real deployment would collect these as two distinct
 * numbers, not assume they're the same value) so that once Platform Ops
 * approves the KYB application, `partner.activate_vendor()` — which
 * requires an existing `vendor_profile` row before it will do anything —
 * finds one immediately, matching the flow already verified for seeded
 * organizations.
 *
 * Like farmer registration, this mints a fresh mock OIDC claim
 * (`oidc|org-<uuid>`) since no real IdP is connected, and auto-issues a
 * session JWT. Unlike farmer registration, logging in immediately does NOT
 * guarantee full portal access: `GET /lender/dashboard`, `GET /buyer/dashboard`,
 * and `GET /machinery/dashboard` all now require `kyb_status = 'Verified'`
 * (see the `requireLenderOrg`/`requireBuyerOrg`/`requireMachineryOrg` update
 * in their own route files) — a newly self-registered org sees a "your
 * application is under review" state in that portal instead of live data
 * until Platform Ops approves it. Organization types with no dedicated
 * portal at all yet (Cooperative, Mill, InputSupplier, Logistics) simply get
 * a registration-received confirmation on the frontend — there's nowhere
 * else for them to log into yet. TractorService, DroneService,
 * HarvesterService, TruckService, and DryingYardService all share ONE
 * portal (`frontend/machinery/`) — see `src/routes/machinery.js`.
 */
router.post('/org-register', async (req, res, next) => {
  const { org_name: orgName, tax_id: taxId, org_type: orgType } = req.body || {};

  if (!orgName || !taxId || !orgType) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['org_name', 'tax_id', 'org_type'],
    });
  }
  if (!ORG_SELF_REGISTER_TYPES.includes(orgType)) {
    return res.status(400).json({ error: 'invalid_org_type', valid: ORG_SELF_REGISTER_TYPES });
  }

  const authSubjectId = generateOrgAuthSubjectId();

  try {
    const orgId = await withServiceRole(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO identity.organization (org_type, org_name, tax_id, kyb_status, auth_subject_id)
         VALUES ($1, $2, $3, 'Pending', $4)
         RETURNING org_id`,
        [orgType, orgName, taxId, authSubjectId],
      );
      const newOrgId = rows[0].org_id;

      // Every subject needs a role grant before set_session_context() (and
      // therefore RLS) will recognize them — 'org.admin' matches the role
      // already used for every other seeded organization.
      await client.query(
        `INSERT INTO identity.subject_role (subject_type, subject_id, role_code)
         VALUES ('organization', $1, 'org.admin')`,
        [newOrgId],
      );

      await client.query(
        `INSERT INTO partner.vendor_profile (org_id, business_registration_no)
         VALUES ($1, $2)`,
        [newOrgId, taxId],
      );

      await client.query('SELECT security.set_session_context($1, $2)', ['organization', newOrgId]);
      await logAccess(client, 'write', 'identity.organization', newOrgId);

      return newOrgId;
    });

    const token = jwt.sign(
      { subjectType: 'organization', subjectId: orgId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
    );

    return res.status(201).json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: process.env.JWT_EXPIRES_IN || '8h',
      subject_type: 'organization',
      subject_id: orgId,
      org_type: orgType,
      kyb_status: 'Pending',
    });
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      const reason = ORG_REGISTER_CONSTRAINT_ERRORS[err.constraint] || 'duplicate_value';
      return res.status(409).json({ error: reason });
    }
    return next(err);
  }
});

/**
 * POST /auth/admin-login
 * Body: { passcode: string }
 *
 * SIMPLIFICATION / MOCK, called out explicitly in the README and in .env:
 * there is no per-admin identity table in this sandbox — no individual ops
 * accounts, no MFA, no real SSO — so a single shared passcode (from
 * ADMIN_PASSCODE in .env) stands in for "is this an authorized platform
 * operator at all". Every successful admin login is issued the SAME
 * subject_id-less 'platform' identity; audit.access_log therefore cannot
 * distinguish WHICH ops staff member performed a given action, only that
 * *a* platform operator did. A real deployment needs real per-admin
 * accounts precisely so that audit trail exists.
 *
 * subject_id is intentionally omitted from the token: security.
 * set_session_context() already treats subject_type='platform' as the one
 * case that needs no subject_id and no identity.subject_role row at all
 * (see that function's definition) — this was designed into Layer 8
 * specifically for platform-level operations, just never had an API path
 * exercising it until now.
 */
router.post('/admin-login', async (req, res, next) => {
  const { passcode } = req.body || {};

  if (!passcode || typeof passcode !== 'string') {
    return res.status(400).json({ error: 'passcode_required' });
  }

  try {
    if (passcode !== process.env.ADMIN_PASSCODE) {
      return res.status(401).json({ error: 'invalid_passcode' });
    }

    const token = jwt.sign(
      { subjectType: 'platform' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' },
    );

    return res.json({
      access_token: token,
      token_type: 'Bearer',
      expires_in: process.env.JWT_EXPIRES_IN || '8h',
      subject_type: 'platform',
      subject_id: null,
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /auth/session/current
 * Requires a valid Bearer token. Mirrors the intent of the
 * g14_rls_rbac_enforcement.yaml "who am I" endpoint from Layer 8 — echoes
 * back the resolved identity plus a friendly display name where available,
 * proving the token → session-context path actually works end to end.
 */
router.get('/session/current', requireAuth, async (req, res, next) => {
  const { subjectType, subjectId } = req.subject;

  try {
    const displayName = await withSessionContext(subjectType, subjectId, async (client) => {
      if (subjectType === 'farmer') {
        const { rows } = await client.query(
          'SELECT full_name FROM identity.farmer WHERE farmer_id = $1',
          [subjectId],
        );
        return rows[0] ? rows[0].full_name : null;
      }
      return null;
    });

    return res.json({ subject_type: subjectType, subject_id: subjectId, display_name: displayName });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
