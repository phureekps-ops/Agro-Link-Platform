const jwt = require('jsonwebtoken');

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

module.exports = { requireAuth, requireFarmer, requireOrganization, requirePlatform };
