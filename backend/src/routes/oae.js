const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireGovernmentOfficer } = require('../middleware/auth');

const router = express.Router();

/**
 * สศก. (Office of Agricultural Economics) Data Portal — the officer-facing
 * half of the oae.* schema (see grant_oae_data_portal.sql for the full
 * design rationale). Mounted at its own '/oae' prefix, same reasoning as
 * '/gov' in government.js: a government officer is its own subject type,
 * not Platform Ops and not a cooperative.
 *
 * Every route below additionally requires the calling officer's own
 * department_code to be 'OAE' — a National/Province CPD officer (the
 * existing /gov/* portal) has no business here, and an OAE officer has no
 * business in /gov/* either. That department check happens INSIDE the SQL
 * functions (oae.assert_active_oae_officer, called from set_dataset_
 * sharing/record_commodity_price) for the two write routes, and inline
 * here for the two read routes — same "route checks what it can cheaply
 * check, function double-checks before writing" split used throughout
 * this codebase.
 */
router.use(requireAuth, requireGovernmentOfficer);

/** Resolves the calling officer's own row iff Active AND department_code='OAE', else null. */
async function loadOaeOfficer(client, officerId) {
  const { rows } = await client.query(
    `SELECT officer_id, full_name, scope_type, province_code, department_code, status
       FROM identity.government_officer
      WHERE officer_id = $1 AND status = 'Active' AND department_code = 'OAE'`,
    [officerId],
  );
  return rows[0] || null;
}

/**
 * GET /oae/me — mirrors GET /gov/me's "who am I" role in every portal's
 * own init().
 */
router.get('/me', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOaeOfficer(client, subjectId);
      if (!officer) return { notFound: true };

      const roles = await client.query(
        `SELECT sr.role_code, r.description
           FROM identity.subject_role sr JOIN identity.role r ON r.role_code = sr.role_code
          WHERE sr.subject_type = 'government_officer' AND sr.subject_id = $1
          ORDER BY sr.granted_at`,
        [subjectId],
      );
      await logAccess(client, 'read', 'identity.government_officer', subjectId);
      return { officer, roles: roles.rows };
    });

    if (result.notFound) return res.status(403).json({ error: 'oae_officer_not_found_or_inactive' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /oae/datasets — the full oae.dataset catalog, with each row's
 * current sharing status for both audiences and a small recent-price
 * sample, so the officer's own management screen can show everything in
 * one call (same "one dashboard call" shape as GET /gov/cooperatives).
 */
router.get('/datasets', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOaeOfficer(client, subjectId);
      if (!officer) return { notFound: true };

      const datasets = await client.query(
        `SELECT d.dataset_id, d.dataset_code, d.dataset_name_th, d.description, d.update_frequency_th, d.status,
                COALESCE(bool_or(s.audience = 'cooperative' AND s.is_enabled), false) AS shared_with_cooperatives,
                COALESCE(bool_or(s.audience = 'farmer' AND s.is_enabled), false) AS shared_with_farmers,
                (SELECT COUNT(*)::int FROM oae.commodity_price p WHERE p.dataset_id = d.dataset_id) AS price_entry_count
           FROM oae.dataset d
           LEFT JOIN oae.dataset_sharing s ON s.dataset_id = d.dataset_id
          GROUP BY d.dataset_id, d.dataset_code, d.dataset_name_th, d.description, d.update_frequency_th, d.status
          ORDER BY d.dataset_name_th`,
      );
      await logAccess(client, 'read', 'oae.dataset', null);
      return { officer, datasets: datasets.rows };
    });

    if (result.notFound) return res.status(403).json({ error: 'oae_officer_not_found_or_inactive' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /oae/datasets/:id/sharing
 * Body: { audience: 'cooperative'|'farmer', is_enabled: boolean }
 */
router.post('/datasets/:id/sharing', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  const { audience, is_enabled: isEnabled } = req.body || {};

  if (!audience || typeof isEnabled !== 'boolean') {
    return res.status(400).json({ error: 'missing_required_fields', required: ['audience', 'is_enabled'] });
  }

  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOaeOfficer(client, subjectId);
      if (!officer) return { notFound: true };

      try {
        await client.query('SELECT oae.set_dataset_sharing($1, $2, $3, $4)', [id, audience, isEnabled, subjectId]);
        await logAccess(client, 'write', 'oae.dataset_sharing', id);
        return { ok: true };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) return res.status(403).json({ error: 'oae_officer_not_found_or_inactive' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_update_sharing', detail: result.businessError });
    return res.json({ dataset_id: id, audience, is_enabled: isEnabled });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /oae/commodity-prices?dataset_id= — the officer's own review list,
 * optionally filtered to one dataset.
 */
router.get('/commodity-prices', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { dataset_id: datasetId } = req.query;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOaeOfficer(client, subjectId);
      if (!officer) return { notFound: true };

      const params = [];
      let whereClause = '';
      if (datasetId) {
        whereClause = 'WHERE p.dataset_id = $1';
        params.push(datasetId);
      }
      const rows = await client.query(
        `SELECT p.price_id, p.dataset_id, d.dataset_name_th, p.commodity_name_th, p.price_date,
                p.price_value, p.unit, p.source_note, p.recorded_by, p.created_at
           FROM oae.commodity_price p
           JOIN oae.dataset d ON d.dataset_id = p.dataset_id
           ${whereClause}
          ORDER BY p.price_date DESC, p.created_at DESC
          LIMIT 200`,
        params,
      );
      await logAccess(client, 'read', 'oae.commodity_price', null);
      return { officer, prices: rows.rows };
    });

    if (result.notFound) return res.status(403).json({ error: 'oae_officer_not_found_or_inactive' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /oae/commodity-prices
 * Body: { dataset_id, commodity_name_th, price_date, price_value, unit, source_note?, recorded_by }
 * See grant_oae_data_portal.sql's header note — this is a REAL manual-entry
 * workflow (the officer types in a figure they actually have), not a
 * fabricated data generator. There is deliberately no bulk-import route in
 * this pass.
 */
router.post('/commodity-prices', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    dataset_id: datasetId, commodity_name_th: commodityNameTh, price_date: priceDate,
    price_value: priceValue, unit, source_note: sourceNote, recorded_by: recordedBy,
  } = req.body || {};

  if (!datasetId || !commodityNameTh || !priceDate || priceValue === undefined || priceValue === null || !unit || !recordedBy) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['dataset_id', 'commodity_name_th', 'price_date', 'price_value', 'unit', 'recorded_by'],
    });
  }

  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOaeOfficer(client, subjectId);
      if (!officer) return { notFound: true };

      try {
        const { rows } = await client.query(
          'SELECT oae.record_commodity_price($1, $2, $3, $4, $5, $6, $7, $8) AS price_id',
          [datasetId, commodityNameTh, priceDate, priceValue, unit, sourceNote || null, recordedBy, subjectId],
        );
        await logAccess(client, 'write', 'oae.commodity_price', rows[0].price_id);
        return { priceId: rows[0].price_id };
      } catch (fnErr) {
        return { businessError: fnErr.message };
      }
    });

    if (result.notFound) return res.status(403).json({ error: 'oae_officer_not_found_or_inactive' });
    if (result.businessError) return res.status(409).json({ error: 'cannot_record_price', detail: result.businessError });
    return res.status(201).json({ price_id: result.priceId });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /oae/usage-log — who has been viewing shared data, and when. A
 * concrete answer to "what does สศก. itself get out of this" — visibility
 * into actual usage it never had before.
 */
router.get('/usage-log', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('government_officer', subjectId, async (client) => {
      const officer = await loadOaeOfficer(client, subjectId);
      if (!officer) return { notFound: true };

      const rows = await client.query(
        `SELECT u.usage_id, u.dataset_id, d.dataset_name_th, u.viewer_subject_type, u.viewed_at,
                CASE WHEN u.viewer_subject_type = 'organization' THEN o.org_name ELSE f.full_name END AS viewer_name
           FROM oae.usage_log u
           JOIN oae.dataset d ON d.dataset_id = u.dataset_id
           LEFT JOIN identity.organization o ON u.viewer_subject_type = 'organization' AND o.org_id = u.viewer_ref_id
           LEFT JOIN identity.farmer f ON u.viewer_subject_type = 'farmer' AND f.farmer_id = u.viewer_ref_id
          ORDER BY u.viewed_at DESC
          LIMIT 200`,
      );
      await logAccess(client, 'read', 'oae.usage_log', null);
      return { officer, usage: rows.rows };
    });

    if (result.notFound) return res.status(403).json({ error: 'oae_officer_not_found_or_inactive' });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
