/**
 * Database side of AgroLink SatAI กลุ่มที่ 1 (see lib/plotAI.js for the
 * models themselves and db/grant_plot_ai.sql for the tables). Every
 * function takes a `client` that the route has already opened with its own
 * session context (platform / organization), so access rules stay with the
 * route — same convention as lib/plotSatellite.js.
 */
const ai = require('./plotAI');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ASSESS_BATCH_LIMIT = 300;

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function isDate(v) { return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)); }
function todayBangkok() { return new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10); }

async function loadProfiles(client) {
  const r = await client.query('SELECT * FROM ai.crop_profile');
  const out = {};
  r.rows.forEach((p) => {
    out[p.crop_code] = {
      ...p,
      typical_yield_t_per_rai: p.typical_yield_t_per_rai === null ? null : Number(p.typical_yield_t_per_rai),
      max_yield_t_per_rai: p.max_yield_t_per_rai === null ? null : Number(p.max_yield_t_per_rai),
      reference_peak_ndvi: p.reference_peak_ndvi === null ? null : Number(p.reference_peak_ndvi),
    };
  });
  return out;
}

async function loadActiveModels(client) {
  const r = await client.query('SELECT model_id, model_kind, crop_code, params FROM ai.model WHERE is_active');
  const models = { crop: null, yield: {} };
  r.rows.forEach((m) => {
    if (m.model_kind === 'crop_classifier') models.crop = m;
    else models.yield[m.crop_code] = m;
  });
  return models;
}

/**
 * Everything the models need for a set of plots, in 5 queries.
 * unitIds = null → every active Plot.
 */
async function loadUnitInputs(client, unitIds) {
  const params = [];
  let where = "pu.status = 'active' AND pu.unit_type = 'Plot'";
  if (unitIds) { params.push(unitIds); where += ' AND pu.unit_id = ANY($1::uuid[])'; }
  const units = (await client.query(
    `SELECT pu.unit_id, pu.commodity_code, c.name_th AS commodity_name_th, pu.area_rai,
            round((ST_Area(pu.gps_boundary::geography) / 1600.0)::numeric, 2) AS poly_area_rai,
            pu.owner_farmer_id, f.full_name AS farmer_name
       FROM registry.production_unit pu
       JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
       LEFT JOIN registry.commodity_ref c ON c.commodity_code = pu.commodity_code
      WHERE ${where}
      ORDER BY f.full_name, pu.unit_id`,
    params,
  )).rows;
  if (!units.length) return [];
  const ids = units.map((u) => u.unit_id);
  const [obs, del, stages, gts] = await Promise.all([
    client.query(
      `SELECT unit_id, observation_date::text AS date, value_numeric::float8 AS ndvi
         FROM satellite.observation
        WHERE unit_id = ANY($1::uuid[]) AND source_provider = 'sentinel2_optical'
          AND observation_type = 'ndvi' AND value_numeric IS NOT NULL
        ORDER BY observation_date`, [ids]),
    client.query(
      `SELECT unit_id, delivery_id, (delivered_at AT TIME ZONE 'Asia/Bangkok')::date::text AS delivered_at,
              quantity_ton::float8 AS quantity_ton, status, commodity_code
         FROM produce.delivery WHERE unit_id = ANY($1::uuid[])`, [ids]),
    client.query(
      `SELECT cc.unit_id, sc.actual_date::text AS actual_date
         FROM production.stage_calendar sc
         JOIN production.crop_cycle cc ON cc.cycle_id = sc.cycle_id
        WHERE cc.unit_id = ANY($1::uuid[]) AND sc.actual_date IS NOT NULL AND sc.stage_name LIKE '%เก็บเกี่ยว%'`, [ids]),
    client.query(
      `SELECT DISTINCT ON (unit_id) unit_id, gt_id, crop_code, planting_date::text AS planting_date,
              harvest_date::text AS harvest_date, source, created_at
         FROM ai.ground_truth WHERE unit_id = ANY($1::uuid[])
        ORDER BY unit_id, created_at DESC`, [ids]),
  ]);
  const group = (rows) => {
    const m = new Map();
    rows.forEach((r) => { if (!m.has(r.unit_id)) m.set(r.unit_id, []); m.get(r.unit_id).push(r); });
    return m;
  };
  const o = group(obs.rows); const d = group(del.rows); const s = group(stages.rows);
  const g = new Map(gts.rows.map((r) => [r.unit_id, r]));
  return units.map((u) => ({
    unit: { ...u, area_rai: Number(u.area_rai), poly_area_rai: u.poly_area_rai === null ? null : Number(u.poly_area_rai) },
    points: o.get(u.unit_id) || [],
    deliveries: d.get(u.unit_id) || [],
    harvestStages: s.get(u.unit_id) || [],
    groundTruth: g.get(u.unit_id) || null,
  }));
}

async function saveAssessment(client, unitId, r, assessedByType) {
  const f = r.forecast || {};
  const res = await client.query(
    `INSERT INTO ai.plot_assessment
       (unit_id, as_of, declared_crop, confirmed_crop, predicted_crop, crop_confidence, crop_method,
        planting_date, harvest_date, expected_harvest_date, season_status,
        forecast_crop, forecast_tons, forecast_tons_low, forecast_tons_high, forecast_method,
        risk_level, flags, result, assessed_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     RETURNING assessment_id, assessed_at`,
    [unitId, r.as_of, r.declared_crop, r.confirmed_crop, r.predicted_crop, r.crop_confidence, r.crop_method,
      r.planting_date || null, r.harvest_date || null, r.expected_harvest_date || null, r.season_status,
      f.crop || null, f.tons ?? null, f.tons_low ?? null, f.tons_high ?? null, f.method || null,
      r.risk_level, JSON.stringify(r.flags), JSON.stringify(r), assessedByType],
  );
  return res.rows[0];
}

/** Assess plots (one id, a list, or every active plot up to ASSESS_BATCH_LIMIT) and store the results. */
async function assessUnits(client, { unitIds = null, assessedByType, asOf } = {}) {
  const [profiles, models, inputs] = await Promise.all([loadProfiles(client), loadActiveModels(client), loadUnitInputs(client, unitIds)]);
  const day = asOf || todayBangkok();
  const results = [];
  for (const input of inputs.slice(0, ASSESS_BATCH_LIMIT)) {
    const r = ai.assessPlot({ ...input, profiles, models, asOf: day });
    const saved = await saveAssessment(client, input.unit.unit_id, r, assessedByType);
    results.push({
      unit_id: input.unit.unit_id, farmer_name: input.unit.farmer_name, assessment_id: saved.assessment_id,
      predicted_crop: r.predicted_crop, risk_level: r.risk_level, flags: r.flags.map((x) => x.code), observations: input.points.length,
    });
  }
  return { assessed: results.length, total_plots: inputs.length, truncated: inputs.length > ASSESS_BATCH_LIMIT, results };
}

const LIST_SQL = `
  SELECT pu.unit_id, pu.commodity_code, c.name_th AS commodity_name_th, pu.area_rai, f.farmer_id, f.full_name AS farmer_name,
         (SELECT count(*)::int FROM satellite.observation o WHERE o.unit_id = pu.unit_id
             AND o.source_provider = 'sentinel2_optical' AND o.observation_type = 'ndvi') AS ndvi_points,
         a.assessment_id, a.assessed_at, a.as_of::text AS as_of, a.declared_crop, a.confirmed_crop, a.predicted_crop, a.crop_confidence::float8 AS crop_confidence, a.crop_method,
         a.planting_date::text AS planting_date, a.harvest_date::text AS harvest_date,
         a.expected_harvest_date::text AS expected_harvest_date, a.season_status,
         a.forecast_crop, a.forecast_tons::float8 AS forecast_tons, a.forecast_tons_low::float8 AS forecast_tons_low,
         a.forecast_tons_high::float8 AS forecast_tons_high, a.forecast_method,
         a.risk_level, a.flags, a.result->>'forecast_note' AS forecast_note, (a.result->>'crop_ambiguous')::boolean AS crop_ambiguous
    FROM registry.production_unit pu
    JOIN identity.farmer f ON f.farmer_id = pu.owner_farmer_id
    LEFT JOIN registry.commodity_ref c ON c.commodity_code = pu.commodity_code
    LEFT JOIN ai.v_latest_assessment a ON a.unit_id = pu.unit_id
   WHERE pu.status = 'active' AND pu.unit_type = 'Plot'`;

const RISK_ORDER = "CASE a.risk_level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'unknown' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";

async function listUnits(client, { risk } = {}) {
  const params = [];
  let extra = '';
  if (risk) { params.push(risk); extra = ` AND a.risk_level = $${params.length}`; }
  const r = await client.query(`${LIST_SQL}${extra} ORDER BY ${RISK_ORDER}, f.full_name`, params);
  return r.rows;
}

async function unitDetail(client, unitId) {
  const r = await client.query(`${LIST_SQL} AND pu.unit_id = $1`, [unitId]);
  if (!r.rows.length) return null;
  const [latest, gts, history] = await Promise.all([
    client.query('SELECT result FROM ai.v_latest_assessment WHERE unit_id = $1', [unitId]),
    client.query(
      `SELECT gt_id, crop_code, planting_date::text AS planting_date, harvest_date::text AS harvest_date, note, source, created_at
         FROM ai.ground_truth WHERE unit_id = $1 ORDER BY created_at DESC`, [unitId]),
    client.query(
      `SELECT assessed_at, predicted_crop, risk_level, forecast_tons
         FROM ai.plot_assessment WHERE unit_id = $1 ORDER BY assessed_at DESC LIMIT 10`, [unitId]),
  ]);
  return { ...r.rows[0], result: latest.rows[0] ? latest.rows[0].result : null, ground_truth: gts.rows, history: history.rows };
}

async function addGroundTruth(client, { unitId, cropCode, plantingDate, harvestDate, note, source, byType, byId }) {
  const r = await client.query(
    `INSERT INTO ai.ground_truth (unit_id, crop_code, planting_date, harvest_date, note, source, confirmed_by_type, confirmed_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING gt_id, created_at`,
    [unitId, cropCode, plantingDate || null, harvestDate || null, note || null, source, byType, byId || null],
  );
  return r.rows[0];
}

/**
 * Cooperative-level forecast: plots whose crop is still growing, summed by
 * crop and expected harvest month (from the latest assessment of each).
 */
async function forecastSummary(client) {
  const r = await client.query(
    `SELECT a.forecast_crop AS crop, to_char(a.expected_harvest_date, 'YYYY-MM') AS harvest_month,
            count(*)::int AS plots, sum(pu.area_rai)::float8 AS area_rai,
            sum(a.forecast_tons)::float8 AS tons, sum(a.forecast_tons_low)::float8 AS tons_low, sum(a.forecast_tons_high)::float8 AS tons_high,
            count(*) FILTER (WHERE a.forecast_method LIKE 'ml_%')::int AS by_ml
       FROM ai.v_latest_assessment a
       JOIN registry.production_unit pu ON pu.unit_id = a.unit_id
      WHERE pu.status = 'active' AND a.season_status = 'growing' AND a.forecast_tons IS NOT NULL
      GROUP BY 1, 2 ORDER BY 2, 1`,
  );
  const unforecast = await client.query(
    `SELECT count(*)::int AS n FROM registry.production_unit pu
       LEFT JOIN ai.v_latest_assessment a ON a.unit_id = pu.unit_id
      WHERE pu.status = 'active' AND pu.unit_type = 'Plot' AND (a.unit_id IS NULL OR a.forecast_tons IS NULL)`,
  );
  return { rows: r.rows, plots_without_forecast: unforecast.rows[0].n };
}

async function summary(client) {
  const [risk, models, gt, last] = await Promise.all([
    client.query(
      `SELECT COALESCE(a.risk_level, 'not_assessed') AS risk_level, count(*)::int AS n
         FROM registry.production_unit pu LEFT JOIN ai.v_latest_assessment a ON a.unit_id = pu.unit_id
        WHERE pu.status = 'active' AND pu.unit_type = 'Plot' GROUP BY 1`),
    client.query(
      `SELECT model_id, model_kind, crop_code, trained_at, sample_size, is_active, reason, metrics
         FROM ai.model ORDER BY trained_at DESC LIMIT 30`),
    client.query('SELECT crop_code, count(DISTINCT unit_id)::int AS plots, count(*)::int AS labels FROM ai.ground_truth GROUP BY 1 ORDER BY 1'),
    client.query('SELECT max(assessed_at) AS last_assessed_at FROM ai.plot_assessment'),
  ]);
  return {
    risk_counts: Object.fromEntries(risk.rows.map((x) => [x.risk_level, x.n])),
    models: models.rows,
    active_models: models.rows.filter((m) => m.is_active),
    ground_truth: gt.rows,
    last_assessed_at: last.rows[0].last_assessed_at,
    thresholds: {
      crop_min_samples: ai.CROP_MODEL_MIN_SAMPLES, crop_min_per_class: ai.CROP_MODEL_MIN_PER_CLASS,
      yield_min_samples: ai.YIELD_MODEL_MIN_SAMPLES,
    },
  };
}

// ------------------------------------------------------------ training
function pointsAsOf(points, iso) { return points.filter((p) => p.date <= iso); }
function addDays(iso, n) { return ai.dayToIso(ai.toDay(iso) + n); }

/**
 * Builds training sets from what the platform has already recorded and
 * trains both models. A model run is always stored (for the audit trail);
 * it only replaces the active one when it passed its gate in lib/plotAI.js.
 */
async function trainModels(client) {
  const [profiles, inputs, labels] = await Promise.all([
    loadProfiles(client),
    loadUnitInputs(client, null),
    client.query(
      `SELECT gt.unit_id, gt.crop_code, gt.planting_date::text AS planting_date, gt.harvest_date::text AS harvest_date,
              (gt.created_at AT TIME ZONE 'Asia/Bangkok')::date::text AS confirmed_on
         FROM ai.ground_truth gt`),
  ]);
  const byUnit = new Map(inputs.map((i) => [i.unit.unit_id, i]));
  const today = todayBangkok();

  // crop classifier: one sample per label, features as of that label's season
  const cropSamples = [];
  labels.rows.forEach((l) => {
    const input = byUnit.get(l.unit_id);
    if (!input) return;
    const asOf = l.harvest_date ? addDays(l.harvest_date, 20) : l.confirmed_on;
    const pts = pointsAsOf(input.points, asOf > today ? today : asOf);
    const series = ai.composite(pts, ai.toDay(asOf > today ? today : asOf), 540);
    const f = ai.extractFeatures(series, ai.detectSeasons(series));
    if (f.max === null || f.coverage < 0.25) return;
    cropSamples.push({ features: f, crop: l.crop_code });
  });
  const cropRun = ai.trainCropModel(cropSamples);

  // yield: harvested seasons matched to the tons the cooperative recorded
  const latestLabel = new Map();
  labels.rows.forEach((l) => {
    const prev = latestLabel.get(l.unit_id);
    if (!prev || l.confirmed_on > prev.confirmed_on) latestLabel.set(l.unit_id, l);
  });
  const yieldSamples = {};
  inputs.forEach((input) => {
    const deliveries = input.deliveries.filter((d) => d.status !== 'rejected');
    if (!deliveries.length || !input.unit.area_rai) return;
    const crop = latestLabel.has(input.unit.unit_id) ? latestLabel.get(input.unit.unit_id).crop_code : ai.commodityToCrop(input.unit.commodity_code);
    const profile = profiles[crop];
    if (!profile || !profile.typical_yield_t_per_rai) return;
    const series = ai.composite(input.points, ai.toDay(today), 730);
    ai.detectSeasons(series).filter((s) => s.eosDay !== null).forEach((s) => {
      const tons = deliveries
        .filter((d) => { const dd = ai.toDay(d.delivered_at); return dd >= s.eosDay - 20 && dd <= s.eosDay + 120; })
        .reduce((acc, d) => acc + Number(d.quantity_ton), 0);
      if (!tons) return;
      const perRai = tons / input.unit.area_rai;
      if (profile.max_yield_t_per_rai && perRai > profile.max_yield_t_per_rai) return; // impossible → bad record, not a label
      (yieldSamples[crop] = yieldSamples[crop] || []).push({
        features: ai.seasonYieldFeatures(s), yield_t_per_rai: perRai, baseline: ai.baselineYieldPerRai(profile, s),
      });
    });
  });

  const runs = [];
  const store = async (kind, crop, run) => {
    const { params, ...report } = run;
    if (run.activated) {
      await client.query('UPDATE ai.model SET is_active = false WHERE is_active AND model_kind = $1 AND COALESCE(crop_code, \'\') = COALESCE($2, \'\')', [kind, crop]);
    }
    const ins = await client.query(
      `INSERT INTO ai.model (model_kind, crop_code, sample_size, is_active, reason, metrics, params, report)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING model_id, trained_at`,
      [kind, crop, run.sample_size || 0, !!run.activated, run.reason, JSON.stringify(run.metrics || null),
        params ? JSON.stringify(params) : null, JSON.stringify(report)],
    );
    runs.push({ model_kind: kind, crop_code: crop, model_id: ins.rows[0].model_id, ...report });
  };
  await store('crop_classifier', null, cropRun);
  for (const crop of ['rice', 'maize', 'cassava', 'sugarcane']) {
    await store('yield_forecaster', crop, ai.trainYieldModel(crop, yieldSamples[crop] || []));
  }
  return { runs, label_count: labels.rows.length, crop_samples: cropSamples.length };
}

module.exports = {
  isUuid, isDate, todayBangkok, loadProfiles, loadActiveModels, loadUnitInputs,
  assessUnits, listUnits, unitDetail, addGroundTruth, forecastSummary, summary, trainModels, ASSESS_BATCH_LIMIT,
};
