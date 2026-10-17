const express = require('express');
const crypto = require('crypto');

const { withServiceRole } = require('../db/pool');

const router = express.Router();

const MAX_PATH_LEN = 300;
const MAX_REFERRER_LEN = 500;
const MAX_UA_LEN = 300;

/**
 * Daily-rotating visitor fingerprint: sha256(ip + "|" + userAgent + "|" +
 * todayBangkok + "|" + salt). Deliberately NOT a stable long-lived
 * fingerprint -- it changes every Bangkok calendar day for the same
 * visitor, so it cannot be used to reconstruct one visitor's history
 * across days or correlate with any other system. It exists ONLY so the
 * admin dashboard can show "how many distinct people, not just how many
 * hits" (COUNT DISTINCT visitor_hash) for a given day/week/month window.
 * Raw IP is used in-memory for this one hash computation and never written
 * to the database -- see grant_web_traffic.sql's header comment for the
 * full design rationale.
 */
function visitorHash(ip, userAgent) {
  const todayBangkok = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
  const salt = process.env.TRAFFIC_HASH_SALT || 'agrolink-traffic-default-salt-change-in-prod';
  return crypto.createHash('sha256').update(`${ip}|${userAgent}|${todayBangkok}|${salt}`).digest('hex');
}

/**
 * POST /traffic/track -- PUBLIC, no auth. Fired once per page load by
 * frontend/js/track.js on every public marketing-site page. Mirrors
 * content.js's withServiceRole() pattern -- the only other route in this
 * project that touches the database with no session context, because an
 * anonymous site visitor has no identity.subject_role row to set a session
 * context for in the first place. traffic.page_view has no RLS and no
 * per-actor ownership column, same reasoning as content.about_section.
 *
 * Deliberately permissive about malformed input (default/truncate, never
 * reject with an error visitor-side) -- a page-view counter must never
 * surface an error to a real visitor or block page render, and
 * frontend/js/track.js fires this with sendBeacon, which doesn't even wait
 * for a response.
 */
router.post('/track', async (req, res) => {
  try {
    const body = req.body || {};
    const path = typeof body.path === 'string' && body.path.trim()
      ? body.path.trim().slice(0, MAX_PATH_LEN)
      : '/';
    const referrer = typeof body.referrer === 'string' && body.referrer.trim()
      ? body.referrer.trim().slice(0, MAX_REFERRER_LEN)
      : null;
    const userAgent = (req.get('user-agent') || '').slice(0, MAX_UA_LEN);
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    const vHash = visitorHash(ip, userAgent);

    await withServiceRole(async (client) => {
      await client.query(
        `INSERT INTO traffic.page_view (path, referrer, visitor_hash, user_agent)
         VALUES ($1, $2, $3, $4)`,
        [path, referrer, vHash, userAgent || null],
      );
    });
    return res.status(204).end();
  } catch (err) {
    // Never let a tracking failure surface to the visitor or throw a 500 at
    // a script nobody is watching the response of -- log and move on.
    console.error('[traffic] failed to record page view:', err.message);
    return res.status(204).end();
  }
});

module.exports = router;
