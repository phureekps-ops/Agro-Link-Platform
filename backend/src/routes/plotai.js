/**
 * AgroLink SatAI กลุ่มที่ 1 — routes for Platform Ops (/admin/plot-ai) and
 * cooperatives (/coop/plot-ai). Kept in its own file (not admin.js /
 * coopcollection.js) so the AI work never has to touch those two large
 * files. Models: lib/plotAI.js · DB access: lib/plotAIService.js · tables:
 * db/grant_plot_ai.sql (must be run before these routes work).
 *
 * Cooperative scope = every active plot, same as GET /coop/satellite/units
 * in coopcollection.js (no farmer↔cooperative membership table exists yet;
 * narrow both together once it does).
 */
const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requirePlatform, requireOrganization } = require('../middleware/auth');
const ai = require('../lib/plotAI');
const svc = require('../lib/plotAIService');

const CROP_CODES = ai.CROPS;

function validateGroundTruth(body) {
  const { unit_id: unitId, crop_code: cropCode, planting_date: plantingDate, harvest_date: harvestDate, note } = body || {};
  if (!svc.isUuid(unitId)) return { error: 'invalid_unit_id' };
  if (!CROP_CODES.includes(cropCode)) return { error: 'invalid_crop_code', allowed: CROP_CODES };
  if (plantingDate && !svc.isDate(plantingDate)) return { error: 'invalid_planting_date' };
  if (harvestDate && !svc.isDate(harvestDate)) return { error: 'invalid_harvest_date' };
  if (plantingDate && harvestDate && harvestDate <= plantingDate) return { error: 'harvest_before_planting' };
  if (note && String(note).length > 500) return { error: 'note_too_long' };
  return { unitId, cropCode, plantingDate, harvestDate, note: note ? String(note).trim() : null };
}

function missingSchema(err) { return err && err.code === '42P01'; }
function handle(next, res) {
  return (err) => {
    if (missingSchema(err)) return res.status(503).json({ error: 'plot_ai_not_installed', detail: 'run backend/db/grant_plot_ai.sql' });
    return next(err);
  };
}

/** Routes shared by both portals; `ctx` = session context type, `source` = ground-truth source label. */
function sharedRoutes(router, ctx, source) {
  router.get('/units', async (req, res, next) => {
    const risk = ['low', 'medium', 'high', 'unknown'].includes(req.query.risk) ? req.query.risk : null;
    try {
      const rows = await withSessionContext(ctx, req.subject.subjectId, async (client) => {
        const r = await svc.listUnits(client, { risk });
        await logAccess(client, 'read', 'ai.plot_assessment', null);
        return r;
      });
      return res.json(rows);
    } catch (err) { return handle(next, res)(err); }
  });

  router.get('/units/:id', async (req, res, next) => {
    if (!svc.isUuid(req.params.id)) return res.status(400).json({ error: 'invalid_unit_id' });
    try {
      const data = await withSessionContext(ctx, req.subject.subjectId, async (client) => {
        const d = await svc.unitDetail(client, req.params.id);
        if (d) await logAccess(client, 'read', 'ai.plot_assessment', req.params.id);
        return d;
      });
      if (!data) return res.status(404).json({ error: 'production_unit_not_found' });
      return res.json(data);
    } catch (err) { return handle(next, res)(err); }
  });

  /** POST /assess { unit_id? } — one plot, or every active plot (up to svc.ASSESS_BATCH_LIMIT). */
  router.post('/assess', async (req, res, next) => {
    const unitId = req.body && req.body.unit_id;
    if (unitId !== undefined && unitId !== null && !svc.isUuid(unitId)) return res.status(400).json({ error: 'invalid_unit_id' });
    try {
      const out = await withSessionContext(ctx, req.subject.subjectId, async (client) => {
        const r = await svc.assessUnits(client, { unitIds: unitId ? [unitId] : null, assessedByType: ctx });
        await logAccess(client, 'write', 'ai.plot_assessment', unitId || null);
        return r;
      });
      if (unitId && out.assessed === 0) return res.status(404).json({ error: 'production_unit_not_found' });
      return res.json(out);
    } catch (err) { return handle(next, res)(err); }
  });

  /** POST /ground-truth { unit_id, crop_code, planting_date?, harvest_date?, note? } — confirm what the plot grows, then re-assess it. */
  router.post('/ground-truth', async (req, res, next) => {
    const v = validateGroundTruth(req.body);
    if (v.error) return res.status(400).json(v);
    try {
      const out = await withSessionContext(ctx, req.subject.subjectId, async (client) => {
        const exists = await client.query("SELECT 1 FROM registry.production_unit WHERE unit_id = $1 AND unit_type = 'Plot'", [v.unitId]);
        if (!exists.rows.length) return null;
        const gt = await svc.addGroundTruth(client, {
          ...v, source, byType: ctx, byId: req.subject.subjectId,
        });
        await logAccess(client, 'write', 'ai.ground_truth', gt.gt_id);
        const assessed = await svc.assessUnits(client, { unitIds: [v.unitId], assessedByType: ctx });
        return { ground_truth: gt, assessment: assessed.results[0] || null };
      });
      if (!out) return res.status(404).json({ error: 'production_unit_not_found' });
      return res.status(201).json(out);
    } catch (err) { return handle(next, res)(err); }
  });

  router.get('/forecast', async (req, res, next) => {
    try {
      const data = await withSessionContext(ctx, req.subject.subjectId, (client) => svc.forecastSummary(client));
      return res.json(data);
    } catch (err) { return handle(next, res)(err); }
  });

  router.get('/crop-profiles', async (req, res, next) => {
    try {
      const data = await withSessionContext(ctx, req.subject.subjectId, async (client) => Object.values(await svc.loadProfiles(client)));
      return res.json(data);
    } catch (err) { return handle(next, res)(err); }
  });
}

// ------------------------------------------------------------ platform
const admin = express.Router();
admin.use(requireAuth, requirePlatform);
sharedRoutes(admin, 'platform', 'platform');

admin.get('/summary', async (req, res, next) => {
  try {
    const data = await withSessionContext('platform', req.subject.subjectId, (client) => svc.summary(client));
    return res.json(data);
  } catch (err) { return handle(next, res)(err); }
});

/** POST /admin/plot-ai/retrain — train the crop classifier and per-crop yield models from recorded labels and deliveries. */
admin.post('/retrain', async (req, res, next) => {
  try {
    const data = await withSessionContext('platform', req.subject.subjectId, async (client) => {
      const r = await svc.trainModels(client);
      await logAccess(client, 'write', 'ai.model', null);
      return r;
    });
    return res.json(data);
  } catch (err) { return handle(next, res)(err); }
});

/** PUT /admin/plot-ai/crop-profiles/:crop — edit the reference values (approximate defaults ship with the migration). */
admin.put('/crop-profiles/:crop', async (req, res, next) => {
  const crop = req.params.crop;
  if (!CROP_CODES.includes(crop)) return res.status(400).json({ error: 'invalid_crop_code' });
  const fields = ['typical_yield_t_per_rai', 'max_yield_t_per_rai', 'reference_peak_ndvi', 'peak_to_harvest_days', 'typical_season_days'];
  const sets = []; const params = [crop];
  for (const k of fields) {
    if (!(k in (req.body || {}))) continue;
    const v = req.body[k];
    if (v !== null && (!Number.isFinite(Number(v)) || Number(v) < 0)) return res.status(400).json({ error: `invalid_${k}` });
    if (k === 'reference_peak_ndvi' && v !== null && Number(v) > 1) return res.status(400).json({ error: 'invalid_reference_peak_ndvi' });
    params.push(v === null ? null : Number(v)); sets.push(`${k} = $${params.length}`);
  }
  if (req.body && typeof req.body.source_note === 'string') { params.push(req.body.source_note.slice(0, 300)); sets.push(`source_note = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  try {
    const row = await withSessionContext('platform', req.subject.subjectId, async (client) => {
      const r = await client.query(`UPDATE ai.crop_profile SET ${sets.join(', ')}, updated_at = now() WHERE crop_code = $1 RETURNING *`, params);
      await logAccess(client, 'write', 'ai.crop_profile', null);
      return r.rows[0];
    });
    return res.json(row);
  } catch (err) { return handle(next, res)(err); }
});

// --------------------------------------------------------- cooperative
/** Same two-layer check as requireCooperativeOrg in coopcollection.js (copied, per this project's convention). */
async function requireCooperativeOrg(req, res, next) {
  const { subjectId } = req.subject;
  try {
    const result = await withSessionContext('organization', subjectId, async (client) => {
      const org = await client.query('SELECT org_id, kyb_status FROM identity.organization WHERE org_id = $1', [subjectId]);
      if (!org.rows.length) return { ok: false, error: 'cooperative_subject_required' };
      if (org.rows[0].kyb_status !== 'Verified') return { ok: false, error: 'kyb_not_verified' };
      const role = await client.query("SELECT status FROM identity.organization_role WHERE org_id = $1 AND role_type = 'Cooperative'", [subjectId]);
      if (!role.rows[0] || role.rows[0].status !== 'Verified') return { ok: false, error: 'cooperative_role_required' };
      return { ok: true };
    });
    if (!result.ok) return res.status(403).json({ error: result.error });
    return next();
  } catch (err) { return next(err); }
}

const coop = express.Router();
coop.use(requireAuth, requireOrganization, requireCooperativeOrg);
sharedRoutes(coop, 'organization', 'cooperative');

module.exports = { admin, coop, validateGroundTruth };
