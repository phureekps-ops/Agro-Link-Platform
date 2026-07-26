const express = require('express');

const { withServiceRole } = require('../db/pool');

const router = express.Router();

/**
 * GET /about -- public, no auth required. Renders the "เกี่ยวกับเรา" page
 * (frontend/about.html) from content.about_section, active rows only,
 * ordered for direct display. content.about_section has no RLS and no
 * per-actor ownership column (see grant_about_content.sql) -- this is the
 * only route in the whole project that touches the database with no
 * session context at all, hence withServiceRole() (SET ROLE agrolink_app,
 * no security.set_session_context() call) rather than withSessionContext().
 */
router.get('/', async (_req, res, next) => {
  try {
    const rows = await withServiceRole(async (client) => {
      const result = await client.query(
        `SELECT section_id, title, body, display_order
           FROM content.about_section
          WHERE is_active = true
          ORDER BY display_order ASC, section_id ASC`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
