const express = require('express');
const jwt = require('jsonwebtoken');

const { pool, withSessionContext } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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
