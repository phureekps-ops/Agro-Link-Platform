const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');

const router = express.Router();

// Mounted at the SAME '/farmer' prefix as src/routes/farmer.js and
// src/routes/fertilizer.js (Express allows more than one router on one
// prefix — see server.js).
router.use(requireAuth, requireFarmer);

/**
 * GET /farmer/crop-cycles?unit_id= — this farmer's own crop cycles,
 * optionally filtered to one production unit, newest first. Ownership is
 * enforced via the pu.owner_farmer_id join, same shape used everywhere
 * else a farmer route reaches into registry.production_unit.
 */
router.get('/crop-cycles', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { unit_id: unitId } = req.query;

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (unitId) {
        params.push(unitId);
        filter = 'AND cc.unit_id = $2';
      }
      const result = await client.query(
        `SELECT cc.cycle_id, cc.unit_id, cc.commodity_code, r.name_th AS commodity_name_th,
                cc.planned_start_date, cc.planned_harvest_date, cc.actual_harvest_date,
                cc.status, cc.created_at
           FROM production.crop_cycle cc
           JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
           JOIN registry.commodity_ref r ON r.commodity_code = cc.commodity_code
          WHERE pu.owner_farmer_id = $1 ${filter}
          ORDER BY cc.created_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'production.crop_cycle', subjectId);
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/crop-cycles
 * Body: { unit_id, commodity_code, planned_start_date }
 *
 * Starts a new production cycle for one of this farmer's own units and
 * seeds its stage_calendar from production.stage_template for the chosen
 * commodity (each stage's planned_date = planned_start_date +
 * typical_offset_days). Only one 'planning'/'active' cycle is allowed per
 * unit at a time — a simple one-crop-at-a-time model, not multi/relay
 * cropping. See grant_stage_calendar_farmer.sql for what "unsupported
 * commodity" means here (stage_template currently only has rows for the
 * same 3 commodities the fertilizer calculator supports).
 */
router.post('/crop-cycles', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    unit_id: unitId, commodity_code: commodityCode, planned_start_date: plannedStartDate,
  } = req.body || {};

  if (!unitId || !commodityCode || !plannedStartDate) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['unit_id', 'commodity_code', 'planned_start_date'],
    });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const unit = await client.query(
        'SELECT unit_id FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2',
        [unitId, subjectId],
      );
      if (unit.rows.length === 0) return { unitNotFound: true };

      const existing = await client.query(
        `SELECT cycle_id FROM production.crop_cycle
          WHERE unit_id = $1 AND status IN ('planning', 'active')`,
        [unitId],
      );
      if (existing.rows.length > 0) {
        return { cycleAlreadyActive: true, cycleId: existing.rows[0].cycle_id };
      }

      const templateRes = await client.query(
        `SELECT stage_seq, stage_name, typical_offset_days, stage_key
           FROM production.stage_template
          WHERE commodity_code = $1
          ORDER BY stage_seq`,
        [commodityCode],
      );
      if (templateRes.rows.length === 0) {
        const supported = await client.query('SELECT DISTINCT commodity_code FROM production.stage_template');
        return { unsupportedCommodity: true, supported: supported.rows.map((r) => r.commodity_code) };
      }
      const stages = templateRes.rows;
      const lastStage = stages[stages.length - 1];

      const cycleRes = await client.query(
        `INSERT INTO production.crop_cycle
           (unit_id, commodity_code, planned_start_date, planned_harvest_date, status)
         VALUES ($1, $2, $3, $3::date + make_interval(days => $4::int), 'active')
         RETURNING cycle_id, unit_id, commodity_code, planned_start_date, planned_harvest_date, status, created_at`,
        [unitId, commodityCode, plannedStartDate, lastStage.typical_offset_days],
      );
      const cycle = cycleRes.rows[0];

      const insertedStages = [];
      for (const stage of stages) {
        // eslint-disable-next-line no-await-in-loop -- seeding a handful of
        // stage rows (5 today) in a fixed, small, per-cycle template; not a
        // hot path, and each insert legitimately depends on the same
        // client/transaction context, so parallelizing buys nothing here.
        const stageRes = await client.query(
          `INSERT INTO production.stage_calendar
             (cycle_id, stage_seq, stage_name, planned_date, status, stage_key)
           VALUES ($1, $2, $3, $4::date + make_interval(days => $5::int), 'pending', $6)
           RETURNING stage_id, cycle_id, stage_seq, stage_name, planned_date, status, stage_key`,
          [cycle.cycle_id, stage.stage_seq, stage.stage_name, plannedStartDate, stage.typical_offset_days, stage.stage_key],
        );
        insertedStages.push(stageRes.rows[0]);
      }

      await logAccess(client, 'write', 'production.crop_cycle', cycle.cycle_id);
      return { cycle: { ...cycle, stages: insertedStages } };
    });

    if (result.unitNotFound) {
      return res.status(404).json({ error: 'production_unit_not_found' });
    }
    if (result.cycleAlreadyActive) {
      return res.status(400).json({ error: 'cycle_already_active', cycle_id: result.cycleId });
    }
    if (result.unsupportedCommodity) {
      return res.status(400).json({ error: 'unsupported_commodity', supported: result.supported });
    }
    return res.status(201).json(result.cycle);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/crop-cycles/:cycleId — one cycle's detail plus its full
 * stage list, ordered by stage_seq. Each stage carries
 * fertilizer_step_done (only meaningful for the stage_key =
 * 'soil_test_fertilizer' stage — null on every other stage) so the
 * frontend can explain why that one stage's confirm button is disabled
 * without a second round-trip.
 */
router.get('/crop-cycles/:cycleId', async (req, res, next) => {
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
          WHERE cc.cycle_id = $1 AND pu.owner_farmer_id = $2`,
        [cycleId, subjectId],
      );
      if (cycleRes.rows.length === 0) return { cycleNotFound: true };
      const cycle = cycleRes.rows[0];

      const stagesRes = await client.query(
        `SELECT stage_id, stage_seq, stage_name, planned_date, actual_date, status,
                verification_ref, verified_by, verified_at, stage_key
           FROM production.stage_calendar
          WHERE cycle_id = $1
          ORDER BY stage_seq`,
        [cycleId],
      );

      const fertilizerDoneRes = await client.query(
        'SELECT 1 FROM production.fertilizer_formula_calc WHERE unit_id = $1 LIMIT 1',
        [cycle.unit_id],
      );
      const fertilizerStepDone = fertilizerDoneRes.rows.length > 0;

      await logAccess(client, 'read', 'production.crop_cycle', cycleId);
      return {
        cycle: {
          ...cycle,
          stages: stagesRes.rows.map((s) => ({
            ...s,
            fertilizer_step_done: s.stage_key === 'soil_test_fertilizer' ? fertilizerStepDone : null,
          })),
        },
      };
    });

    if (result.cycleNotFound) {
      return res.status(404).json({ error: 'crop_cycle_not_found' });
    }
    return res.json(result.cycle);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/crop-cycles/:cycleId/stages/:stageId/confirm
 * Body: { actual_date? } (defaults to today)
 *
 * Self-service stage confirmation — the farmer confirms IN THE APP that a
 * stage is done. This is deliberately different from the one hardcoded
 * demo cycle in dev_sample_data.sql, which uses
 * verified_by='field_agent:...' (a field-agent verification workflow this
 * project has not built); self-reported confirmations here are stamped
 * verified_by='self_reported:<farmer_id>' instead, so nothing pretends a
 * human field agent checked the farmer's own claim.
 *
 * Two gates before a stage can be confirmed:
 *   1. Sequential — every earlier stage (lower stage_seq) in the same
 *      cycle must already be 'verified' or 'skipped'.
 *   2. stage_key='soil_test_fertilizer' additionally requires at least one
 *      production.fertilizer_formula_calc row for the cycle's unit — the
 *      farmer must have actually run the AI ปุ๋ยสั่งตัด calculator at
 *      least once before this specific stage can be ticked done. This is
 *      the concrete "Stage Calendar integration" the analysis doc asked
 *      for: the fertilizer step is a real gate, not just a label.
 * Confirming the LAST stage in the cycle also marks the cycle itself
 * 'completed' with actual_harvest_date set to the same actual_date.
 */
router.post('/crop-cycles/:cycleId/stages/:stageId/confirm', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { cycleId, stageId } = req.params;
  const { actual_date: actualDateOverride } = req.body || {};

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const cycleRes = await client.query(
        `SELECT cc.cycle_id, cc.unit_id
           FROM production.crop_cycle cc
           JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
          WHERE cc.cycle_id = $1 AND pu.owner_farmer_id = $2`,
        [cycleId, subjectId],
      );
      if (cycleRes.rows.length === 0) return { cycleNotFound: true };
      const cycle = cycleRes.rows[0];

      const stagesRes = await client.query(
        `SELECT stage_id, stage_seq, stage_name, status, stage_key
           FROM production.stage_calendar
          WHERE cycle_id = $1
          ORDER BY stage_seq`,
        [cycleId],
      );
      const stages = stagesRes.rows;
      const stage = stages.find((s) => s.stage_id === stageId);
      if (!stage) return { stageNotFound: true };

      if (stage.status === 'verified' || stage.status === 'skipped') {
        return { stageAlreadyDone: true };
      }

      const priorUnfinished = stages.find(
        (s) => s.stage_seq < stage.stage_seq && s.status !== 'verified' && s.status !== 'skipped',
      );
      if (priorUnfinished) {
        return { previousStageNotDone: true, blockingStage: priorUnfinished.stage_name };
      }

      if (stage.stage_key === 'soil_test_fertilizer') {
        const calcRes = await client.query(
          'SELECT 1 FROM production.fertilizer_formula_calc WHERE unit_id = $1 LIMIT 1',
          [cycle.unit_id],
        );
        if (calcRes.rows.length === 0) {
          return { fertilizerStepIncomplete: true };
        }
      }

      const actualDate = actualDateOverride || new Date().toISOString().slice(0, 10);
      const updateRes = await client.query(
        `UPDATE production.stage_calendar
            SET status = 'verified', actual_date = $2,
                verified_by = $3, verified_at = now()
          WHERE stage_id = $1
        RETURNING stage_id, cycle_id, stage_seq, stage_name, planned_date, actual_date,
                  status, verified_by, verified_at, stage_key`,
        [stageId, actualDate, `self_reported:${subjectId}`],
      );
      await logAccess(client, 'write', 'production.stage_calendar', stageId);

      const maxSeq = Math.max(...stages.map((s) => s.stage_seq));
      let cycleCompleted = false;
      if (stage.stage_seq === maxSeq) {
        await client.query(
          `UPDATE production.crop_cycle SET status = 'completed', actual_harvest_date = $2 WHERE cycle_id = $1`,
          [cycleId, actualDate],
        );
        await logAccess(client, 'write', 'production.crop_cycle', cycleId);
        cycleCompleted = true;
      }

      return { stage: updateRes.rows[0], cycleCompleted };
    });

    if (result.cycleNotFound) {
      return res.status(404).json({ error: 'crop_cycle_not_found' });
    }
    if (result.stageNotFound) {
      return res.status(404).json({ error: 'stage_not_found' });
    }
    if (result.stageAlreadyDone) {
      return res.status(400).json({ error: 'stage_already_done' });
    }
    if (result.previousStageNotDone) {
      return res.status(400).json({ error: 'previous_stage_not_done', blocking_stage: result.blockingStage });
    }
    if (result.fertilizerStepIncomplete) {
      return res.status(400).json({
        error: 'fertilizer_step_incomplete',
        message: 'กรุณาใช้เครื่องมือ AI ปุ๋ยสั่งตัด (คำนวณสูตรปุ๋ยอย่างน้อย 1 ครั้ง) ก่อนยืนยันขั้นตอนนี้',
      });
    }
    return res.json({ stage: result.stage, cycle_completed: result.cycleCompleted });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
