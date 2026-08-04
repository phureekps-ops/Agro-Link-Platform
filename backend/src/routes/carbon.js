const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');

const router = express.Router();

// Mounted at the SAME '/farmer' prefix as src/routes/farmer.js,
// src/routes/stagecalendar.js and src/routes/fertilizer.js (Express allows
// more than one router on one prefix — see server.js).
router.use(requireAuth, requireFarmer);

// Assessment statuses in which the farmer may still add water-log entries
// or (re)submit for review. Once 'pending_review' or 'verified' the record
// is locked — see grant_carbon_awd.sql's table comment for the full state
// machine (draft -> pending_review -> verified | rejected -> draft-like).
const UNLOCKED_STATUSES = ['draft', 'rejected'];

/**
 * Recomputes carbon.awd_cycle_assessment for one cycle from its current
 * carbon.awd_water_log rows + whichever carbon.awd_config is currently
 * active, and upserts the result. Deliberately a no-op (returns the
 * existing row untouched) if the assessment is already 'pending_review' or
 * 'verified' — those states are locked, see UNLOCKED_STATUSES above. Must
 * be called with a client already inside withSessionContext().
 *
 * The "qualifying dry event" model: walk the cycle's water_log rows in
 * chronological order and group consecutive readings that count as
 * "AWD-dry" (water_status='dry' AND (water_level_cm IS NULL OR
 * water_level_cm <= -min_water_level_drop_cm) — a reading with no precise
 * cm value is trusted on the farmer's reported status alone) into runs. A
 * run "qualifies" as one AWD dry event if its span (last reading's
 * recorded_at minus first reading's recorded_at) is at least
 * min_dry_period_days. The cycle is eligible for the full per-rai credit
 * only if it accumulates at least min_dry_events_required qualifying
 * events in the whole crop cycle — an all-or-nothing threshold per cycle,
 * not partial credit per event, to keep this estimate model simple and
 * honest about how rough it is (see grant_carbon_awd.sql header comment).
 */
async function recomputeAssessment(client, cycleId) {
  const cycleRes = await client.query(
    `SELECT cc.cycle_id, cc.unit_id, cc.commodity_code, cc.status AS cycle_status,
            pu.owner_farmer_id, pu.area_rai
       FROM production.crop_cycle cc
       JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
      WHERE cc.cycle_id = $1`,
    [cycleId],
  );
  if (cycleRes.rows.length === 0) return { cycleNotFound: true };
  const cycle = cycleRes.rows[0];

  const existingRes = await client.query(
    'SELECT status FROM carbon.awd_cycle_assessment WHERE cycle_id = $1',
    [cycleId],
  );
  if (existingRes.rows.length > 0 && !UNLOCKED_STATUSES.includes(existingRes.rows[0].status)) {
    // Locked (pending_review/verified) — leave it exactly as Platform Ops
    // last saw it. Recomputing here would let a farmer silently change the
    // numbers under review, which defeats the point of the review gate.
    const locked = await client.query(
      'SELECT * FROM carbon.awd_cycle_assessment WHERE cycle_id = $1', [cycleId],
    );
    return { assessment: locked.rows[0], locked: true };
  }

  const configRes = await client.query(
    'SELECT * FROM carbon.awd_config WHERE is_active = true ORDER BY effective_from DESC LIMIT 1',
  );
  if (configRes.rows.length === 0) return { noActiveConfig: true };
  const config = configRes.rows[0];

  const logsRes = await client.query(
    `SELECT water_status, water_level_cm, recorded_at
       FROM carbon.awd_water_log
      WHERE cycle_id = $1
      ORDER BY recorded_at ASC`,
    [cycleId],
  );

  let qualifyingEvents = 0;
  let totalDryDays = 0;
  let runStart = null;
  let runEnd = null;
  const minDropCm = Number(config.min_water_level_drop_cm);

  const closeRun = () => {
    if (runStart && runEnd) {
      const days = Math.floor((runEnd.getTime() - runStart.getTime()) / (24 * 60 * 60 * 1000));
      if (days >= config.min_dry_period_days) {
        qualifyingEvents += 1;
        totalDryDays += days;
      }
    }
    runStart = null;
    runEnd = null;
  };

  for (const log of logsRes.rows) {
    const levelQualifies = log.water_level_cm === null || Number(log.water_level_cm) <= -minDropCm;
    const isQualifyingDry = log.water_status === 'dry' && levelQualifies;
    if (isQualifyingDry) {
      const t = new Date(log.recorded_at);
      if (!runStart) runStart = t;
      runEnd = t;
    } else {
      closeRun();
    }
  }
  closeRun();

  const isEligible = qualifyingEvents >= config.min_dry_events_required;
  const estimatedCredit = isEligible
    ? Number((Number(cycle.area_rai) * Number(config.emission_factor_tco2e_per_rai)).toFixed(4))
    : 0;

  const upsertRes = await client.query(
    `INSERT INTO carbon.awd_cycle_assessment
       (cycle_id, unit_id, farmer_id, area_rai, config_id, methodology_ref,
        emission_factor_tco2e_per_rai, min_dry_events_required,
        qualifying_dry_events, total_dry_days, is_eligible, estimated_credit_tco2e,
        status, last_calculated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft', now(), now())
     ON CONFLICT (cycle_id) DO UPDATE SET
       area_rai = EXCLUDED.area_rai,
       config_id = EXCLUDED.config_id,
       methodology_ref = EXCLUDED.methodology_ref,
       emission_factor_tco2e_per_rai = EXCLUDED.emission_factor_tco2e_per_rai,
       min_dry_events_required = EXCLUDED.min_dry_events_required,
       qualifying_dry_events = EXCLUDED.qualifying_dry_events,
       total_dry_days = EXCLUDED.total_dry_days,
       is_eligible = EXCLUDED.is_eligible,
       estimated_credit_tco2e = EXCLUDED.estimated_credit_tco2e,
       status = 'draft',
       review_note = NULL,
       last_calculated_at = now(),
       updated_at = now()
     RETURNING *`,
    [
      cycleId, cycle.unit_id, cycle.owner_farmer_id, cycle.area_rai, config.config_id, config.methodology_ref,
      config.emission_factor_tco2e_per_rai, config.min_dry_events_required,
      qualifyingEvents, totalDryDays, isEligible, estimatedCredit,
    ],
  );

  return { assessment: upsertRes.rows[0] };
}

/**
 * GET /farmer/carbon/cycles — this farmer's rice crop cycles (AWD only
 * applies to paddy rice — see grant_carbon_awd.sql header comment on the
 * RICE_% filter) with the latest assessment summary, if any, attached.
 */
router.get('/carbon/cycles', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT cc.cycle_id, cc.unit_id, cc.commodity_code, r.name_th AS commodity_name_th,
                cc.planned_start_date, cc.planned_harvest_date, cc.actual_harvest_date, cc.status,
                a.assessment_id, a.status AS assessment_status, a.qualifying_dry_events,
                a.min_dry_events_required, a.is_eligible, a.estimated_credit_tco2e
           FROM production.crop_cycle cc
           JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
           JOIN registry.commodity_ref r ON r.commodity_code = cc.commodity_code
           LEFT JOIN carbon.awd_cycle_assessment a ON a.cycle_id = cc.cycle_id
          WHERE pu.owner_farmer_id = $1 AND cc.commodity_code LIKE 'RICE\\_%' ESCAPE '\\'
          ORDER BY cc.created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'carbon.awd_cycle_assessment', subjectId);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/carbon/cycles/:cycleId — one cycle's full AWD picture: the
 * water-log history, the current assessment (auto-created as an empty
 * 'draft' the first time this is viewed, so the frontend always has a
 * config/thresholds to show even before the farmer logs anything), and any
 * satellite observations Platform Ops has attached to the same plot within
 * this cycle's date range (read-only corroborating evidence — see
 * carbon.satellite_observation's table comment).
 */
router.get('/carbon/cycles/:cycleId', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { cycleId } = req.params;

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const cycleRes = await client.query(
        `SELECT cc.cycle_id, cc.unit_id, cc.commodity_code, r.name_th AS commodity_name_th,
                cc.planned_start_date, cc.planned_harvest_date, cc.actual_harvest_date, cc.status
           FROM production.crop_cycle cc
           JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
           JOIN registry.commodity_ref r ON r.commodity_code = cc.commodity_code
          WHERE cc.cycle_id = $1 AND pu.owner_farmer_id = $2
            AND cc.commodity_code LIKE 'RICE\\_%' ESCAPE '\\'`,
        [cycleId, subjectId],
      );
      if (cycleRes.rows.length === 0) return { cycleNotFound: true };
      const cycle = cycleRes.rows[0];

      let assessmentRes = await client.query(
        'SELECT * FROM carbon.awd_cycle_assessment WHERE cycle_id = $1',
        [cycleId],
      );
      if (assessmentRes.rows.length === 0) {
        const recomputed = await recomputeAssessment(client, cycleId);
        if (recomputed.noActiveConfig) return { noActiveConfig: true };
        assessmentRes = { rows: [recomputed.assessment] };
      }

      const logsRes = await client.query(
        `SELECT log_id, water_status, water_level_cm, photo_url, note, recorded_at
           FROM carbon.awd_water_log
          WHERE cycle_id = $1
          ORDER BY recorded_at DESC`,
        [cycleId],
      );

      const satelliteRes = await client.query(
        `SELECT obs_id, observation_date, source_provider, inferred_water_status, image_ref, note
           FROM carbon.satellite_observation
          WHERE unit_id = $1
            AND observation_date BETWEEN $2 AND COALESCE($3, CURRENT_DATE)
          ORDER BY observation_date DESC`,
        [cycle.unit_id, cycle.planned_start_date, cycle.actual_harvest_date],
      );

      await logAccess(client, 'read', 'carbon.awd_cycle_assessment', cycleId);
      return {
        cycle,
        assessment: assessmentRes.rows[0],
        water_log: logsRes.rows,
        satellite_observations: satelliteRes.rows,
      };
    });

    if (result.cycleNotFound) {
      return res.status(404).json({ error: 'crop_cycle_not_found' });
    }
    if (result.noActiveConfig) {
      return res.status(503).json({ error: 'no_active_awd_config' });
    }
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/carbon/cycles/:cycleId/water-log
 * Body: { water_status: 'flooded'|'dry', water_level_cm?, photo_url?, note?, recorded_at? }
 *
 * Records one self-reported water-level reading and immediately
 * recomputes the cycle's draft assessment from the full log history (see
 * recomputeAssessment above). Logging is only allowed while the cycle is
 * 'active' (AWD tracking during an already-completed or still-planning
 * cycle makes no agronomic sense) and while the assessment is unlocked
 * (see UNLOCKED_STATUSES) — once submitted for review, the farmer cannot
 * add more entries until Platform Ops verifies or rejects it.
 */
router.post('/carbon/cycles/:cycleId/water-log', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { cycleId } = req.params;
  const {
    water_status: waterStatus,
    water_level_cm: waterLevelCm,
    photo_url: photoUrl,
    note,
    recorded_at: recordedAt,
  } = req.body || {};

  if (!waterStatus || !['flooded', 'dry'].includes(waterStatus)) {
    return res.status(400).json({ error: 'invalid_water_status', valid: ['flooded', 'dry'] });
  }
  if (waterLevelCm !== undefined && waterLevelCm !== null && Number.isNaN(Number(waterLevelCm))) {
    return res.status(400).json({ error: 'invalid_water_level_cm' });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const cycleRes = await client.query(
        `SELECT cc.cycle_id, cc.unit_id, cc.status, pu.owner_farmer_id
           FROM production.crop_cycle cc
           JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
          WHERE cc.cycle_id = $1 AND pu.owner_farmer_id = $2
            AND cc.commodity_code LIKE 'RICE\\_%' ESCAPE '\\'`,
        [cycleId, subjectId],
      );
      if (cycleRes.rows.length === 0) return { cycleNotFound: true };
      const cycle = cycleRes.rows[0];

      if (cycle.status !== 'active') {
        return { cycleNotActive: true };
      }

      const assessmentRes = await client.query(
        'SELECT status FROM carbon.awd_cycle_assessment WHERE cycle_id = $1',
        [cycleId],
      );
      if (assessmentRes.rows.length > 0 && !UNLOCKED_STATUSES.includes(assessmentRes.rows[0].status)) {
        return { assessmentLocked: true, status: assessmentRes.rows[0].status };
      }

      const logRes = await client.query(
        `INSERT INTO carbon.awd_water_log
           (cycle_id, unit_id, farmer_id, water_status, water_level_cm, photo_url, note, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
         RETURNING log_id, water_status, water_level_cm, photo_url, note, recorded_at`,
        [cycleId, cycle.unit_id, subjectId, waterStatus, waterLevelCm ?? null, photoUrl || null, note || null, recordedAt || null],
      );
      await logAccess(client, 'write', 'carbon.awd_water_log', logRes.rows[0].log_id);

      const recomputed = await recomputeAssessment(client, cycleId);
      if (recomputed.noActiveConfig) return { noActiveConfig: true };

      return { log: logRes.rows[0], assessment: recomputed.assessment };
    });

    if (result.cycleNotFound) {
      return res.status(404).json({ error: 'crop_cycle_not_found' });
    }
    if (result.cycleNotActive) {
      return res.status(400).json({ error: 'cycle_not_active' });
    }
    if (result.assessmentLocked) {
      return res.status(409).json({ error: 'assessment_locked', status: result.status });
    }
    if (result.noActiveConfig) {
      return res.status(503).json({ error: 'no_active_awd_config' });
    }
    return res.status(201).json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/carbon/cycles/:cycleId/submit
 *
 * Farmer-initiated submission for Platform Ops review — requires at least
 * one water-log entry already recorded (submitting an empty draft is
 * rejected, same "nothing to review yet" shape as other submit endpoints
 * in this project). Moves status draft/rejected -> pending_review, which
 * (per UNLOCKED_STATUSES) locks out further water-log inserts until
 * Platform Ops verifies or rejects it.
 */
router.post('/carbon/cycles/:cycleId/submit', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { cycleId } = req.params;

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const cycleRes = await client.query(
        `SELECT cc.cycle_id
           FROM production.crop_cycle cc
           JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
          WHERE cc.cycle_id = $1 AND pu.owner_farmer_id = $2`,
        [cycleId, subjectId],
      );
      if (cycleRes.rows.length === 0) return { cycleNotFound: true };

      const assessmentRes = await client.query(
        'SELECT * FROM carbon.awd_cycle_assessment WHERE cycle_id = $1',
        [cycleId],
      );
      if (assessmentRes.rows.length === 0) return { noWaterLogData: true };
      const assessment = assessmentRes.rows[0];
      if (!UNLOCKED_STATUSES.includes(assessment.status)) {
        return { alreadySubmitted: true, status: assessment.status };
      }

      const logCountRes = await client.query(
        'SELECT COUNT(*)::int AS n FROM carbon.awd_water_log WHERE cycle_id = $1',
        [cycleId],
      );
      if (logCountRes.rows[0].n === 0) return { noWaterLogData: true };

      const updateRes = await client.query(
        `UPDATE carbon.awd_cycle_assessment
            SET status = 'pending_review', submitted_at = now(), updated_at = now()
          WHERE cycle_id = $1
        RETURNING *`,
        [cycleId],
      );
      await logAccess(client, 'write', 'carbon.awd_cycle_assessment', assessment.assessment_id);
      return { assessment: updateRes.rows[0] };
    });

    if (result.cycleNotFound) {
      return res.status(404).json({ error: 'crop_cycle_not_found' });
    }
    if (result.noWaterLogData) {
      return res.status(400).json({ error: 'no_water_log_data' });
    }
    if (result.alreadySubmitted) {
      return res.status(409).json({ error: 'already_submitted', status: result.status });
    }
    return res.json(result.assessment);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/carbon/methodology — the currently active carbon.awd_config,
 * for the frontend to display eligibility thresholds (min dry events,
 * min dry period, min water-level drop, emission factor) before/while a
 * farmer is logging water levels.
 */
router.get('/carbon/methodology', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const config = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        'SELECT * FROM carbon.awd_config WHERE is_active = true ORDER BY effective_from DESC LIMIT 1',
      );
      return result.rows[0] || null;
    });
    if (!config) return res.status(503).json({ error: 'no_active_awd_config' });
    return res.json(config);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
