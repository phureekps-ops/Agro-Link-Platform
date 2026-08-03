const express = require('express');

const { withSessionContext, logAccess } = require('../db/pool');
const { requireAuth, requireFarmer } = require('../middleware/auth');

const router = express.Router();

// Mounted at the SAME '/farmer' prefix as src/routes/farmer.js (Express
// allows more than one router on one prefix — see server.js) so this stays
// a separate file instead of growing farmer.js (already 1300+ lines)
// further. Same auth gate as every other farmer.* route.
router.use(requireAuth, requireFarmer);

// ---------------------------------------------------------------------
// Shared constants / helpers for the ปุ๋ยสั่งตัด (Prescription Fertilizer)
// feature — see grant_fertilizer_formula.sql's header comment for the
// full scope statement (what this builds vs. explicitly defers) and the
// placeholder-data caveat on production.crop_nutrient_requirement.
// ---------------------------------------------------------------------
const SOIL_LEVELS = ['low', 'medium', 'high'];
const SOIL_SOURCES = ['manual', 'ldd_baseline'];

// Soil-test-level adjustment for P and K: a "low" reading means the soil
// already has little of that nutrient, so the crop needs MORE than the
// baseline table value; "high" means less. N is not adjusted by soil
// level here — soil N tests are notoriously unstable/short-lived compared
// to P and K, so this calculator deliberately does not pretend to read
// N level as a multiplier; it uses organic matter for N instead (below).
const PK_LEVEL_MULTIPLIER = { low: 1.25, medium: 1.0, high: 0.5 };

/**
 * Organic-matter-based adjustment to the N requirement — soil with more
 * organic matter mineralizes more of its own nitrogen over a season, so
 * the crop needs less supplemental N; soil with very little organic
 * matter needs more. Missing/unreadable organic_matter_pct is treated as
 * "unknown" (multiplier 1.0, no adjustment) rather than guessed.
 */
function nOrganicMatterMultiplier(organicMatterPct) {
  if (organicMatterPct === null || organicMatterPct === undefined) return 1.0;
  const pct = Number(organicMatterPct);
  if (!Number.isFinite(pct)) return 1.0;
  if (pct >= 3) return 0.8;
  if (pct < 1.5) return 1.15;
  return 1.0;
}

// Standard, publicly-documented straight-fertilizer nutrient content —
// NOT DOA proprietary data. Urea/DAP/MOP are the 3 straight fertilizers
// the analysis doc names as the standard blending inputs for ปุ๋ยสั่งตัด.
const UREA = { grade: '46-0-0', n: 0.46, p2o5: 0, k2o: 0, label_th: 'ยูเรีย (46-0-0)' };
const DAP = { grade: '18-46-0', n: 0.18, p2o5: 0.46, k2o: 0, label_th: 'ไดแอมโมเนียมฟอสเฟต / DAP (18-46-0)' };
const MOP = { grade: '0-0-60', n: 0, p2o5: 0, k2o: 0.60, label_th: 'โพแทสเซียมคลอไรด์ / MOP (0-0-60)' };

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/**
 * Finds each grade's cheapest currently-listed active InputSupplier price,
 * normalized to บาท/กก. via fertilizer_kg_per_unit (see
 * grant_fertilizer_formula.sql's comment on why price_unit alone can't be
 * trusted — a "บาท/กระสอบ" listing without this column would silently be
 * read as a per-kg price). Listings missing fertilizer_kg_per_unit are
 * excluded rather than mis-priced.
 */
async function findCheapestPricePerKg(client, grade) {
  const { rows } = await client.query(
    `SELECT p.listing_id, p.org_id, o.org_name, p.product_name, p.unit_price, p.fertilizer_kg_per_unit,
            (p.unit_price / p.fertilizer_kg_per_unit) AS price_per_kg
       FROM marketplace.product_listing p
       JOIN identity.organization o ON o.org_id = p.org_id
      WHERE p.is_active = true
        AND p.category = 'fertilizer_hormone'
        AND p.fertilizer_npk_grade = $1
        AND p.fertilizer_kg_per_unit IS NOT NULL
        AND p.fertilizer_kg_per_unit > 0
      ORDER BY (p.unit_price / p.fertilizer_kg_per_unit) ASC
      LIMIT 1`,
    [grade],
  );
  return rows[0] || null;
}

/**
 * GET /farmer/soil-tests?unit_id=REQUIRED — soil test history for one of
 * this farmer's own production units, newest first. Ownership of unit_id
 * is checked explicitly (same "WHERE owner_farmer_id = $1" shape used
 * everywhere else a farmer reaches into registry.production_unit) so a
 * farmer can never read another farmer's soil-test history by guessing a
 * unit_id.
 */
router.get('/soil-tests', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { unit_id: unitId } = req.query;

  if (!unitId) {
    return res.status(400).json({ error: 'missing_required_query_param', required: ['unit_id'] });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const unit = await client.query(
        'SELECT unit_id FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2',
        [unitId, subjectId],
      );
      if (unit.rows.length === 0) return { unitNotFound: true };

      const { rows } = await client.query(
        `SELECT soil_test_id, unit_id, tested_at, n_level, p_level, k_level,
                ph_value, organic_matter_pct, n_ppm, p_ppm, k_ppm, source, notes, created_at
           FROM production.soil_test
          WHERE unit_id = $1
          ORDER BY tested_at DESC`,
        [unitId],
      );
      await logAccess(client, 'read', 'production.soil_test', subjectId);
      return { soilTests: rows };
    });

    if (result.unitNotFound) {
      return res.status(404).json({ error: 'production_unit_not_found' });
    }
    return res.json(result.soilTests);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/soil-tests
 * Body: { unit_id, n_level, p_level, k_level, ph_value?, organic_matter_pct?,
 *         n_ppm?, p_ppm?, k_ppm?, source?, notes? }
 *
 * Tier-2 (self-reported) half of the analysis doc's Soil Fertility Data
 * Layer — see grant_fertilizer_formula.sql's comment on
 * production.soil_test for what tier this is and what tier (the
 * เกษตรตำบล / นักตรวจดินเคลื่อนที่ network) is NOT built yet.
 */
router.post('/soil-tests', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    unit_id: unitId, n_level: nLevel, p_level: pLevel, k_level: kLevel,
    ph_value: phValue, organic_matter_pct: organicMatterPct,
    n_ppm: nPpm, p_ppm: pPpm, k_ppm: kPpm,
    source, notes,
  } = req.body || {};

  if (!unitId || !nLevel || !pLevel || !kLevel) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['unit_id', 'n_level', 'p_level', 'k_level'],
    });
  }
  if (![nLevel, pLevel, kLevel].every((lvl) => SOIL_LEVELS.includes(lvl))) {
    return res.status(400).json({ error: 'invalid_soil_level', valid: SOIL_LEVELS });
  }
  if (source !== undefined && source !== null && !SOIL_SOURCES.includes(source)) {
    return res.status(400).json({ error: 'invalid_source', valid: SOIL_SOURCES });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const unit = await client.query(
        'SELECT unit_id FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2',
        [unitId, subjectId],
      );
      if (unit.rows.length === 0) return { unitNotFound: true };

      const { rows } = await client.query(
        `INSERT INTO production.soil_test
           (unit_id, n_level, p_level, k_level, ph_value, organic_matter_pct, n_ppm, p_ppm, k_ppm, source, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'manual'), $11)
         RETURNING soil_test_id, unit_id, tested_at, n_level, p_level, k_level,
                   ph_value, organic_matter_pct, n_ppm, p_ppm, k_ppm, source, notes, created_at`,
        [
          unitId, nLevel, pLevel, kLevel,
          phValue ?? null, organicMatterPct ?? null,
          nPpm ?? null, pPpm ?? null, kPpm ?? null,
          source || null, notes || null,
        ],
      );
      await logAccess(client, 'write', 'production.soil_test', rows[0].soil_test_id);
      return { soilTest: rows[0] };
    });

    if (result.unitNotFound) {
      return res.status(404).json({ error: 'production_unit_not_found' });
    }
    return res.status(201).json(result.soilTest);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/fertilizer-formula/crops — every commodity this calculator
 * currently supports (production.crop_nutrient_requirement joined with
 * registry.commodity_ref for the Thai display name), so the frontend
 * dropdown never has to hardcode the list. A commodity NOT in this list
 * (anything beyond RICE_JASMINE / RICE_PADDY / CASSAVA today) simply isn't
 * offered yet — see grant_fertilizer_formula.sql's placeholder-data
 * caveat on why this list starts small.
 */
router.get('/fertilizer-formula/crops', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT r.commodity_code, r.name_th,
                c.n_kg_per_rai, c.p2o5_kg_per_rai, c.k2o_kg_per_rai
           FROM production.crop_nutrient_requirement c
           JOIN registry.commodity_ref r ON r.commodity_code = c.commodity_code
          ORDER BY r.name_th`,
      );
      return result.rows;
    });
    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/fertilizer-formula/calculate
 * Body: { unit_id, commodity_code?, soil_test_id? }
 *
 * commodity_code defaults to the production unit's own registered crop
 * if omitted. soil_test_id defaults to that unit's MOST RECENT soil test
 * if omitted — a farmer who has already logged a soil test doesn't have
 * to look up its id again just to run a calculation. If the unit has NO
 * soil test at all yet, the calculation still runs using baseline (no
 * soil-level adjustment) but the response says so explicitly rather than
 * silently guessing "medium" on the farmer's behalf.
 *
 * This is a RULE-BASED calculation (fixed multipliers + standard
 * urea/DAP/MOP blending arithmetic) — not a machine-learning model — same
 * AI-honesty stance already used for "AI Matching" elsewhere in this
 * project. See grant_fertilizer_formula.sql's header comment for the
 * placeholder-data caveat this response's `disclaimer` field surfaces.
 */
router.post('/fertilizer-formula/calculate', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { unit_id: unitId, commodity_code: commodityCodeOverride, soil_test_id: soilTestIdOverride } = req.body || {};

  if (!unitId) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['unit_id'] });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const unitRes = await client.query(
        `SELECT unit_id, area_rai, commodity_code
           FROM registry.production_unit
          WHERE unit_id = $1 AND owner_farmer_id = $2`,
        [unitId, subjectId],
      );
      if (unitRes.rows.length === 0) return { unitNotFound: true };
      const unit = unitRes.rows[0];
      const commodityCode = commodityCodeOverride || unit.commodity_code;

      const cropRes = await client.query(
        `SELECT c.commodity_code, r.name_th, c.n_kg_per_rai, c.p2o5_kg_per_rai, c.k2o_kg_per_rai
           FROM production.crop_nutrient_requirement c
           JOIN registry.commodity_ref r ON r.commodity_code = c.commodity_code
          WHERE c.commodity_code = $1`,
        [commodityCode],
      );
      if (cropRes.rows.length === 0) {
        const supported = await client.query('SELECT commodity_code FROM production.crop_nutrient_requirement');
        return { unsupportedCommodity: true, supported: supported.rows.map((r) => r.commodity_code) };
      }
      const crop = cropRes.rows[0];

      // Resolve the soil test to use: explicit id (must belong to this
      // unit) → else this unit's most recent one → else none.
      let soilTest = null;
      if (soilTestIdOverride) {
        const soilRes = await client.query(
          'SELECT * FROM production.soil_test WHERE soil_test_id = $1 AND unit_id = $2',
          [soilTestIdOverride, unitId],
        );
        if (soilRes.rows.length === 0) return { soilTestNotFound: true };
        soilTest = soilRes.rows[0];
      } else {
        const soilRes = await client.query(
          'SELECT * FROM production.soil_test WHERE unit_id = $1 ORDER BY tested_at DESC LIMIT 1',
          [unitId],
        );
        soilTest = soilRes.rows[0] || null;
      }

      const areaRai = Number(unit.area_rai);
      const baseN = Number(crop.n_kg_per_rai) * areaRai;
      const baseP2O5 = Number(crop.p2o5_kg_per_rai) * areaRai;
      const baseK2O = Number(crop.k2o_kg_per_rai) * areaRai;

      const pMultiplier = soilTest ? (PK_LEVEL_MULTIPLIER[soilTest.p_level] ?? 1.0) : 1.0;
      const kMultiplier = soilTest ? (PK_LEVEL_MULTIPLIER[soilTest.k_level] ?? 1.0) : 1.0;
      const nMultiplier = soilTest ? nOrganicMatterMultiplier(soilTest.organic_matter_pct) : 1.0;

      const nRequiredKg = round2(baseN * nMultiplier);
      const p2o5RequiredKg = round2(baseP2O5 * pMultiplier);
      const k2oRequiredKg = round2(baseK2O * kMultiplier);

      // Blend: MOP covers all K2O, DAP covers all P2O5 (and contributes
      // some N as a side effect of supplying phosphate), Urea tops up
      // whatever N is still needed after DAP's contribution.
      const mopKg = round2(k2oRequiredKg / MOP.k2o);
      const dapKg = round2(p2o5RequiredKg / DAP.p2o5);
      const nFromDap = dapKg * DAP.n;
      const remainingN = Math.max(nRequiredKg - nFromDap, 0);
      const ureaKg = round2(remainingN / UREA.n);

      const [ureaPrice, dapPrice, mopPrice] = await Promise.all([
        findCheapestPricePerKg(client, UREA.grade),
        findCheapestPricePerKg(client, DAP.grade),
        findCheapestPricePerKg(client, MOP.grade),
      ]);

      const breakdown = [
        { ...UREA, kg: ureaKg, price: ureaPrice },
        { ...DAP, kg: dapKg, price: dapPrice },
        { ...MOP, kg: mopKg, price: mopPrice },
      ].map((item) => ({
        grade: item.grade,
        label_th: item.label_th,
        kg: item.kg,
        price_per_kg: item.price ? round2(item.price.price_per_kg) : null,
        subtotal: item.price ? round2(item.kg * item.price.price_per_kg) : null,
        cheapest_listing: item.price
          ? {
            listing_id: item.price.listing_id, org_id: item.price.org_id,
            org_name: item.price.org_name, product_name: item.price.product_name,
          }
          : null,
      }));

      const priceDataComplete = breakdown.every((item) => item.subtotal !== null);
      const estimatedCost = breakdown.reduce((sum, item) => sum + (item.subtotal || 0), 0);

      const insertRes = await client.query(
        `INSERT INTO production.fertilizer_formula_calc
           (unit_id, farmer_id, soil_test_id, commodity_code, area_rai,
            n_required_kg, p2o5_required_kg, k2o_required_kg,
            urea_kg, dap_kg, mop_kg, estimated_cost, price_data_complete, price_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING calc_id, calculated_at`,
        [
          unitId, subjectId, soilTest ? soilTest.soil_test_id : null, commodityCode, areaRai,
          nRequiredKg, p2o5RequiredKg, k2oRequiredKg,
          ureaKg, dapKg, mopKg,
          priceDataComplete ? round2(estimatedCost) : null,
          priceDataComplete,
          JSON.stringify(breakdown),
        ],
      );
      await logAccess(client, 'write', 'production.fertilizer_formula_calc', insertRes.rows[0].calc_id);

      return {
        calc: {
          calc_id: insertRes.rows[0].calc_id,
          calculated_at: insertRes.rows[0].calculated_at,
          unit_id: unitId,
          commodity_code: commodityCode,
          commodity_name_th: crop.name_th,
          area_rai: areaRai,
          soil_test_used: soilTest
            ? {
              soil_test_id: soilTest.soil_test_id, tested_at: soilTest.tested_at,
              n_level: soilTest.n_level, p_level: soilTest.p_level, k_level: soilTest.k_level,
              organic_matter_pct: soilTest.organic_matter_pct,
            }
            : null,
          soil_test_missing_note: soilTest
            ? null
            : 'ยังไม่มีผลตรวจดินสำหรับแปลงนี้ — คำนวณโดยใช้ค่ามาตรฐาน (ไม่ปรับตามระดับธาตุอาหารในดิน) แนะนำให้บันทึกผลตรวจดินก่อนเพื่อความแม่นยำที่สูงขึ้น (POST /farmer/soil-tests)',
          n_required_kg: nRequiredKg,
          p2o5_required_kg: p2o5RequiredKg,
          k2o_required_kg: k2oRequiredKg,
          fertilizer_breakdown: breakdown,
          estimated_cost: priceDataComplete ? round2(estimatedCost) : null,
          price_data_complete: priceDataComplete,
          disclaimer: 'ผลการคำนวณนี้เป็นการประมาณการจากความรู้เกษตรทั่วไปที่เผยแพร่แก่สาธารณะ ไม่ใช่ตารางผสมปุ๋ยสั่งตัดอย่างเป็นทางการของกรมวิชาการเกษตร (DOA) ใช้เพื่อประกอบการตัดสินใจเบื้องต้นเท่านั้น',
        },
      };
    });

    if (result.unitNotFound) {
      return res.status(404).json({ error: 'production_unit_not_found' });
    }
    if (result.soilTestNotFound) {
      return res.status(404).json({ error: 'soil_test_not_found' });
    }
    if (result.unsupportedCommodity) {
      return res.status(400).json({ error: 'unsupported_commodity', supported: result.supported });
    }
    return res.status(201).json(result.calc);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/fertilizer-formula/history?unit_id= — this farmer's past
 * calculator runs, optionally filtered to one production unit, newest
 * first. Same "keep every run" convention as GET /farmer/credit-score's
 * history array.
 */
router.get('/fertilizer-formula/history', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { unit_id: unitId } = req.query;

  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (unitId) {
        params.push(unitId);
        filter = 'AND unit_id = $2';
      }
      const result = await client.query(
        `SELECT calc_id, unit_id, commodity_code, area_rai,
                n_required_kg, p2o5_required_kg, k2o_required_kg,
                urea_kg, dap_kg, mop_kg, estimated_cost, price_data_complete,
                price_snapshot, calculated_at
           FROM production.fertilizer_formula_calc
          WHERE farmer_id = $1 ${filter}
          ORDER BY calculated_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'production.fertilizer_formula_calc', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
