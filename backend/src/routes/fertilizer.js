const express = require('express');
const crypto = require('crypto');

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


// =======================================================================
// Fulfillment Marketplace เส้นทาง A (module 2.3) — สั่งบริการผสมปุ๋ยสั่งตัด
// ผ่านผู้ให้บริการที่ลงทะเบียน/ผ่าน KYB แล้ว (FertilizerMixingService org
// type — see grant_fertilizer_mixing_service.sql). Kept in this file
// rather than farmer.js for the same reason this whole file is already
// separate from farmer.js: it's the same "ปุ๋ยสั่งตัด" feature area
// (calculate a formula, then order it mixed), and farmer.js is already
// 1300+ lines — see the file-header comment at the top of this file.
// Same offline-payment / dedicated-table design decision as the machinery
// and market-venue booking features — see grant_fertilizer_mixing_service
// .sql's header comment for the full reasoning.
// =======================================================================

const FERTILIZER_MIXING_ORG_TYPES = ['FertilizerMixingService'];

/**
 * GET /farmer/fertilizer-mixing-providers — browse ACTIVE, priced
 * fertilizer_custom_mix listings across every Verified
 * FertilizerMixingService organization, joined with the provider's
 * org_name. Same shape as GET /farmer/machinery-providers, minus the
 * province/photo columns (this portal doesn't collect those yet — see
 * grant_fertilizer_mixing_service.sql's scope note).
 */
router.get('/fertilizer-mixing-providers', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT sl.listing_id, sl.org_id, o.org_name, sl.service_key, sl.service_type,
                sl.description AS label_th, sl.unit_price, sl.price_unit
           FROM marketplace.service_listing sl
           JOIN identity.organization o ON o.org_id = sl.org_id
          WHERE sl.is_active = true
            AND sl.service_key = 'fertilizer_custom_mix'
            AND o.kyb_status = 'Verified'
            AND EXISTS (
              SELECT 1 FROM identity.organization_role r
               WHERE r.org_id = sl.org_id AND r.role_type = ANY($1) AND r.status = 'Verified'
            )
          ORDER BY o.org_name`,
        [FERTILIZER_MIXING_ORG_TYPES],
      );
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/fertilizer-mixing-orders
 * Body: { listing_id, unit_id, cycle_id?, stage_id?, calc_id?,
 *         requested_urea_kg?, requested_dap_kg?, requested_mop_kg?,
 *         delivery_option?, delivery_address?, preferred_date, farmer_note? }
 *
 * unit_id is REQUIRED and ownership-checked (WHERE owner_farmer_id = $1),
 * same as every other route that reaches into registry.production_unit.
 * cycle_id/stage_id/calc_id are each OPTIONAL but, when given, are also
 * ownership-checked through their own chain back to this farmer — a
 * cycle_id belonging to another farmer's unit, or a calc_id from another
 * farmer's calculator run, is rejected with 404 rather than silently
 * accepted (same "looks identical to not-found" convention used
 * everywhere else in this project).
 *
 * If calc_id is given and requested_urea_kg/dap_kg/mop_kg are omitted,
 * they default to that calculation's own urea_kg/dap_kg/mop_kg — so a
 * farmer coming straight from "ผลการคำนวณ" doesn't have to retype the
 * numbers the calculator already produced, but can still override them.
 *
 * service_key/label_th/service_type/unit_price/price_unit are SNAPSHOTTED
 * from the listing at this moment (same reasoning as every other
 * marketplace order/booking route in this project).
 */
router.post('/fertilizer-mixing-orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const {
    listing_id: listingId, unit_id: unitId, cycle_id: cycleId, stage_id: stageId, calc_id: calcId,
    requested_urea_kg: requestedUreaKgRaw, requested_dap_kg: requestedDapKgRaw, requested_mop_kg: requestedMopKgRaw,
    delivery_option: deliveryOptionRaw, delivery_address: deliveryAddress,
    preferred_date: preferredDate, farmer_note: farmerNote,
  } = req.body || {};

  if (!listingId || !unitId || !preferredDate) {
    return res.status(400).json({
      error: 'missing_required_fields',
      required: ['listing_id', 'unit_id', 'preferred_date'],
    });
  }
  if (Number.isNaN(Date.parse(preferredDate))) {
    return res.status(400).json({ error: 'invalid_preferred_date' });
  }
  const deliveryOption = deliveryOptionRaw || 'pickup';
  if (!['pickup', 'delivery'].includes(deliveryOption)) {
    return res.status(400).json({ error: 'invalid_delivery_option', valid: ['pickup', 'delivery'] });
  }
  if (deliveryOption === 'delivery' && !deliveryAddress) {
    return res.status(400).json({ error: 'missing_delivery_address' });
  }

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const unit = await client.query(
        'SELECT unit_id FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2',
        [unitId, subjectId],
      );
      if (unit.rows.length === 0) return { unitNotFound: true };

      if (cycleId) {
        const cycle = await client.query(
          `SELECT cc.cycle_id FROM production.crop_cycle cc
             JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
            WHERE cc.cycle_id = $1 AND pu.owner_farmer_id = $2`,
          [cycleId, subjectId],
        );
        if (cycle.rows.length === 0) return { cycleNotFound: true };
      }

      if (stageId) {
        const stage = await client.query(
          `SELECT sc.stage_id FROM production.stage_calendar sc
             JOIN production.crop_cycle cc ON cc.cycle_id = sc.cycle_id
             JOIN registry.production_unit pu ON pu.unit_id = cc.unit_id
            WHERE sc.stage_id = $1 AND pu.owner_farmer_id = $2`,
          [stageId, subjectId],
        );
        if (stage.rows.length === 0) return { stageNotFound: true };
      }

      let requestedUreaKg = requestedUreaKgRaw ?? null;
      let requestedDapKg = requestedDapKgRaw ?? null;
      let requestedMopKg = requestedMopKgRaw ?? null;

      if (calcId) {
        const calc = await client.query(
          `SELECT calc_id, urea_kg, dap_kg, mop_kg FROM production.fertilizer_formula_calc
            WHERE calc_id = $1 AND farmer_id = $2`,
          [calcId, subjectId],
        );
        if (calc.rows.length === 0) return { calcNotFound: true };
        const c = calc.rows[0];
        if (requestedUreaKg === null) requestedUreaKg = c.urea_kg;
        if (requestedDapKg === null) requestedDapKg = c.dap_kg;
        if (requestedMopKg === null) requestedMopKg = c.mop_kg;
      }

      const listing = await client.query(
        `SELECT listing_id, org_id, service_key, service_type, description AS label_th, unit_price, price_unit
           FROM marketplace.service_listing
          WHERE listing_id = $1 AND is_active = true AND service_key = 'fertilizer_custom_mix'`,
        [listingId],
      );
      if (listing.rows.length === 0) return { listingNotFound: true };
      const l = listing.rows[0];

      const { rows } = await client.query(
        `INSERT INTO marketplace.fertilizer_mixing_order
           (listing_id, org_id, farmer_id, unit_id, cycle_id, stage_id, calc_id,
            service_key, label_th, service_type, unit_price, price_unit,
            requested_urea_kg, requested_dap_kg, requested_mop_kg,
            delivery_option, delivery_address, preferred_date, farmer_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING order_id, listing_id, org_id, unit_id, cycle_id, stage_id, calc_id,
                   service_key, label_th, service_type, unit_price, price_unit,
                   requested_urea_kg, requested_dap_kg, requested_mop_kg,
                   delivery_option, delivery_address, preferred_date, farmer_note,
                   status, requested_at`,
        [
          listingId, l.org_id, subjectId, unitId, cycleId || null, stageId || null, calcId || null,
          l.service_key, l.label_th, l.service_type, l.unit_price, l.price_unit,
          requestedUreaKg, requestedDapKg, requestedMopKg,
          deliveryOption, deliveryAddress || null, preferredDate, farmerNote || null,
        ],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_order', rows[0].order_id);
      return { order: rows[0] };
    });

    if (result.unitNotFound) return res.status(404).json({ error: 'production_unit_not_found' });
    if (result.cycleNotFound) return res.status(404).json({ error: 'crop_cycle_not_found' });
    if (result.stageNotFound) return res.status(404).json({ error: 'stage_not_found' });
    if (result.calcNotFound) return res.status(404).json({ error: 'fertilizer_formula_calc_not_found' });
    if (result.listingNotFound) return res.status(404).json({ error: 'fertilizer_mixing_listing_not_found' });
    return res.status(201).json(result.order);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/fertilizer-mixing-orders?status=... — this farmer's own
 * orders across every provider, joined with the provider's org_name.
 */
router.get('/fertilizer-mixing-orders', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { status } = req.query;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const params = [subjectId];
      let filter = '';
      if (status) { params.push(status); filter = 'AND o.status = $2'; }

      const result = await client.query(
        `SELECT o.order_id, o.org_id, org.org_name, o.unit_id, o.cycle_id, o.stage_id, o.calc_id,
                o.service_key, o.label_th, o.service_type, o.unit_price, o.price_unit,
                o.requested_urea_kg, o.requested_dap_kg, o.requested_mop_kg,
                o.delivery_option, o.delivery_address, o.preferred_date, o.farmer_note,
                o.status, o.decided_reason, o.requested_at, o.decided_at, o.completed_at
           FROM marketplace.fertilizer_mixing_order o
           JOIN identity.organization org ON org.org_id = o.org_id
          WHERE o.farmer_id = $1 ${filter}
          ORDER BY o.requested_at DESC`,
        params,
      );
      await logAccess(client, 'read', 'marketplace.fertilizer_mixing_order', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/fertilizer-mixing-orders/:id/cancel — a farmer can cancel
 * their OWN order, only while it's still `Requested` (before the provider
 * has acted on it). Same ownership-gate + status-guard shape as
 * POST /farmer/machinery-bookings/:id/cancel.
 */
router.post('/fertilizer-mixing-orders/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const existing = await client.query(
        'SELECT status FROM marketplace.fertilizer_mixing_order WHERE farmer_id = $1 AND order_id = $2',
        [subjectId, id],
      );
      if (existing.rows.length === 0) return { notFound: true };
      if (existing.rows[0].status !== 'Requested') return { wrongStatus: existing.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.fertilizer_mixing_order
            SET status = 'Cancelled', updated_at = now()
          WHERE farmer_id = $1 AND order_id = $2
          RETURNING order_id, status`,
        [subjectId, id],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_order', id);
      return { order: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'order_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'order_not_cancellable', current_status: result.wrongStatus });
    return res.json(result.order);
  } catch (err) {
    return next(err);
  }
});

// =============================================================================
// Fulfillment Marketplace เส้นทาง B — รวมกลุ่มสั่งซื้อบริการผสมปุ๋ยสั่งตัด
// (group buying / order pooling). See grant_fertilizer_mixing_group_order
// .sql's header comment for the full design: a farmer starts a group
// against one provider's listing, shares group_code with other farmers,
// and only when the ORGANIZER explicitly submits does the group turn into
// real marketplace.fertilizer_mixing_order rows (one per participant),
// priced with a discount if the group's combined kg met the provider's
// bulk_discount_min_kg threshold.
// =============================================================================

const GROUP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — avoids misreads when a code is read aloud or handwritten
function generateGroupCode(length = 7) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += GROUP_CODE_ALPHABET[bytes[i] % GROUP_CODE_ALPHABET.length];
  }
  return code;
}

/** Sum of urea+dap+mop kg for one participant, nulls treated as 0. */
function participantTotalKg(p) {
  return Number(p.requested_urea_kg || 0) + Number(p.requested_dap_kg || 0) + Number(p.requested_mop_kg || 0);
}

/**
 * Shared validation for both POST /fertilizer-mixing-groups (creating,
 * where the organizer supplies their own participant fields) and POST
 * /fertilizer-mixing-groups/:code/join (a joiner supplying the same
 * shape) — kept as one function so the two entry points can never
 * silently drift apart on what counts as a valid participation.
 */
function validateParticipantFields(body) {
  const {
    unit_id: unitId,
    requested_urea_kg: requestedUreaKgRaw, requested_dap_kg: requestedDapKgRaw, requested_mop_kg: requestedMopKgRaw,
    delivery_option: deliveryOptionRaw, delivery_address: deliveryAddress,
    preferred_date: preferredDate, farmer_note: farmerNote,
  } = body || {};

  if (!unitId || !preferredDate) {
    return { error: { status: 400, body: { error: 'missing_required_fields', required: ['unit_id', 'preferred_date'] } } };
  }
  if (Number.isNaN(Date.parse(preferredDate))) {
    return { error: { status: 400, body: { error: 'invalid_preferred_date' } } };
  }
  const deliveryOption = deliveryOptionRaw || 'pickup';
  if (!['pickup', 'delivery'].includes(deliveryOption)) {
    return { error: { status: 400, body: { error: 'invalid_delivery_option', valid: ['pickup', 'delivery'] } } };
  }
  if (deliveryOption === 'delivery' && !deliveryAddress) {
    return { error: { status: 400, body: { error: 'missing_delivery_address' } } };
  }

  return {
    fields: {
      unitId,
      requestedUreaKg: requestedUreaKgRaw ?? null,
      requestedDapKg: requestedDapKgRaw ?? null,
      requestedMopKg: requestedMopKgRaw ?? null,
      deliveryOption,
      deliveryAddress: deliveryAddress || null,
      preferredDate,
      farmerNote: farmerNote || null,
    },
  };
}

/**
 * POST /farmer/fertilizer-mixing-groups
 * Body: { listing_id, join_deadline, unit_id, requested_urea_kg?,
 *         requested_dap_kg?, requested_mop_kg?, delivery_option?,
 *         delivery_address?, preferred_date, farmer_note? }
 *
 * Starts a new group against a Verified provider's listing AND enrolls the
 * organizer as its first participant, in one call — an organizer with no
 * fertilizer needs of their own isn't a real scenario this feature targets
 * (see header comment), so there is no separate "create empty group" step.
 * listing_id/join_deadline are new; every other field is the same
 * participation shape POST /fertilizer-mixing-orders already takes (see
 * that route's own doc comment) MINUS cycle_id/stage_id/calc_id, which
 * group orders don't support in v1 (documented scope cut — see migration
 * file header).
 */
router.post('/fertilizer-mixing-groups', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { listing_id: listingId, join_deadline: joinDeadline } = req.body || {};

  if (!listingId || !joinDeadline) {
    return res.status(400).json({ error: 'missing_required_fields', required: ['listing_id', 'join_deadline'] });
  }
  if (Number.isNaN(Date.parse(joinDeadline)) || new Date(joinDeadline).getTime() <= Date.now()) {
    return res.status(400).json({ error: 'invalid_join_deadline', reason: 'must_be_a_future_datetime' });
  }

  const validated = validateParticipantFields(req.body);
  if (validated.error) return res.status(validated.error.status).json(validated.error.body);
  const f = validated.fields;

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const unit = await client.query(
        'SELECT unit_id FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2',
        [f.unitId, subjectId],
      );
      if (unit.rows.length === 0) return { unitNotFound: true };

      const listing = await client.query(
        `SELECT listing_id, org_id, service_key, service_type, description AS label_th, unit_price, price_unit,
                bulk_discount_min_kg, bulk_discount_percent
           FROM marketplace.service_listing
          WHERE listing_id = $1 AND is_active = true AND service_key = 'fertilizer_custom_mix'`,
        [listingId],
      );
      if (listing.rows.length === 0) return { listingNotFound: true };
      const l = listing.rows[0];

      let groupRow;
      // Extremely low realistic collision odds (7 chars from a 33-symbol
      // alphabet ≈ 33^7 possibilities) — retry a few times rather than
      // failing outright on the rare unique-constraint hit.
      for (let attempt = 0; attempt < 5 && !groupRow; attempt += 1) {
        try {
          const { rows } = await client.query(
            `INSERT INTO marketplace.fertilizer_mixing_group_order
               (listing_id, org_id, organizer_farmer_id, group_code, join_deadline,
                service_key, label_th, service_type, unit_price, price_unit,
                bulk_discount_min_kg, bulk_discount_percent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING group_id, group_code, status, join_deadline, org_id, listing_id,
                       service_key, label_th, service_type, unit_price, price_unit,
                       bulk_discount_min_kg, bulk_discount_percent, created_at`,
            [
              listingId, l.org_id, subjectId, generateGroupCode(), joinDeadline,
              l.service_key, l.label_th, l.service_type, l.unit_price, l.price_unit,
              l.bulk_discount_min_kg, l.bulk_discount_percent,
            ],
          );
          groupRow = rows[0];
        } catch (insertErr) {
          if (insertErr.code === '23505' && attempt < 4) continue; // unique_violation on group_code — retry with a fresh one
          throw insertErr;
        }
      }

      const { rows: participantRows } = await client.query(
        `INSERT INTO marketplace.fertilizer_mixing_group_participant
           (group_id, farmer_id, unit_id, requested_urea_kg, requested_dap_kg, requested_mop_kg,
            delivery_option, delivery_address, preferred_date, farmer_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING participant_id, status, requested_urea_kg, requested_dap_kg, requested_mop_kg, joined_at`,
        [
          groupRow.group_id, subjectId, f.unitId, f.requestedUreaKg, f.requestedDapKg, f.requestedMopKg,
          f.deliveryOption, f.deliveryAddress, f.preferredDate, f.farmerNote,
        ],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_group_order', groupRow.group_id);

      return { group: groupRow, organizerParticipant: participantRows[0] };
    });

    if (result.unitNotFound) return res.status(404).json({ error: 'production_unit_not_found' });
    if (result.listingNotFound) return res.status(404).json({ error: 'fertilizer_mixing_listing_not_found' });
    return res.status(201).json({ ...result.group, my_participation: result.organizerParticipant, is_organizer: true });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/fertilizer-mixing-groups — every group this farmer is
 * involved in (as organizer OR as a joiner — the organizer is always also
 * a participant row, see POST above, so one query covers both), newest
 * first, with a live-computed current_total_kg/current_participant_count
 * across every still-Joined participant (only meaningful pre-submission;
 * once Submitted, final_total_kg on the group row itself is the number
 * that was actually used to price everyone).
 */
router.get('/fertilizer-mixing-groups', async (req, res, next) => {
  const { subjectId } = req.subject;
  try {
    const rows = await withSessionContext('farmer', subjectId, async (client) => {
      const result = await client.query(
        `SELECT g.group_id, g.group_code, g.status, g.join_deadline, g.org_id, org.org_name,
                g.listing_id, g.label_th, g.unit_price, g.price_unit,
                g.bulk_discount_min_kg, g.bulk_discount_percent,
                g.final_total_kg, g.final_unit_price, g.discount_applied,
                g.created_at, g.submitted_at, g.cancelled_at,
                (g.organizer_farmer_id = $1) AS is_organizer,
                mine.status AS my_status,
                COALESCE(agg.participant_count, 0) AS current_participant_count,
                COALESCE(agg.total_kg, 0) AS current_total_kg
           FROM marketplace.fertilizer_mixing_group_order g
           JOIN identity.organization org ON org.org_id = g.org_id
           JOIN marketplace.fertilizer_mixing_group_participant mine
             ON mine.group_id = g.group_id AND mine.farmer_id = $1
           LEFT JOIN (
             SELECT group_id, COUNT(*)::int AS participant_count,
                    SUM(COALESCE(requested_urea_kg, 0) + COALESCE(requested_dap_kg, 0) + COALESCE(requested_mop_kg, 0)) AS total_kg
               FROM marketplace.fertilizer_mixing_group_participant
              WHERE status = 'Joined'
              GROUP BY group_id
           ) agg ON agg.group_id = g.group_id
          ORDER BY g.created_at DESC`,
        [subjectId],
      );
      await logAccess(client, 'read', 'marketplace.fertilizer_mixing_group_order', subjectId);
      return result.rows;
    });

    return res.json(rows);
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /farmer/fertilizer-mixing-groups/:code — lookup by the SHAREABLE
 * code (not group_id) for a farmer following an invite link who may not
 * have joined yet. Deliberately readable by ANY authenticated farmer who
 * has the code (see the migration file's own reminder comment) — that's
 * the whole point of an invite code — but still reveals nothing a farmer
 * couldn't already see once they join (no other participants' personal
 * details, just the aggregate count/kg).
 */
router.get('/fertilizer-mixing-groups/:code', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { code } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const group = await client.query(
        `SELECT g.group_id, g.group_code, g.status, g.join_deadline, g.org_id, org.org_name,
                g.listing_id, g.label_th, g.unit_price, g.price_unit,
                g.bulk_discount_min_kg, g.bulk_discount_percent,
                g.final_total_kg, g.final_unit_price, g.discount_applied,
                g.created_at, g.submitted_at,
                (g.organizer_farmer_id = $2) AS is_organizer
           FROM marketplace.fertilizer_mixing_group_order g
           JOIN identity.organization org ON org.org_id = g.org_id
          WHERE g.group_code = $1`,
        [code.toUpperCase(), subjectId],
      );
      if (group.rows.length === 0) return { notFound: true };
      const g = group.rows[0];

      const agg = await client.query(
        `SELECT COUNT(*)::int AS participant_count,
                SUM(COALESCE(requested_urea_kg, 0) + COALESCE(requested_dap_kg, 0) + COALESCE(requested_mop_kg, 0)) AS total_kg
           FROM marketplace.fertilizer_mixing_group_participant
          WHERE group_id = $1 AND status = 'Joined'`,
        [g.group_id],
      );
      const mine = await client.query(
        `SELECT status FROM marketplace.fertilizer_mixing_group_participant WHERE group_id = $1 AND farmer_id = $2`,
        [g.group_id, subjectId],
      );

      return {
        group: {
          ...g,
          current_participant_count: agg.rows[0].participant_count || 0,
          current_total_kg: Number(agg.rows[0].total_kg || 0),
          my_status: mine.rows[0] ? mine.rows[0].status : null,
        },
      };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_not_found' });
    return res.json(result.group);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/fertilizer-mixing-groups/:code/join
 * Body: same participant shape as POST /fertilizer-mixing-groups (minus
 * listing_id/join_deadline, which are the GROUP's, not the joiner's, to
 * set).
 *
 * Rejects with 409 if the group isn't Open, the join_deadline has passed,
 * or this farmer already has a row for this group — INCLUDING a
 * Withdrawn one (re-joining the same group after withdrawing is not
 * supported in v1 — see UNIQUE(group_id, farmer_id) in the migration
 * file's own comment).
 */
router.post('/fertilizer-mixing-groups/:code/join', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { code } = req.params;

  const validated = validateParticipantFields(req.body);
  if (validated.error) return res.status(validated.error.status).json(validated.error.body);
  const f = validated.fields;

  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const group = await client.query(
        `SELECT group_id, status, join_deadline FROM marketplace.fertilizer_mixing_group_order WHERE group_code = $1`,
        [code.toUpperCase()],
      );
      if (group.rows.length === 0) return { notFound: true };
      const g = group.rows[0];
      if (g.status !== 'Open') return { wrongStatus: g.status };
      if (new Date(g.join_deadline).getTime() <= Date.now()) return { deadlinePassed: true };

      const existing = await client.query(
        'SELECT status FROM marketplace.fertilizer_mixing_group_participant WHERE group_id = $1 AND farmer_id = $2',
        [g.group_id, subjectId],
      );
      if (existing.rows.length > 0) return { alreadyParticipant: existing.rows[0].status };

      const unit = await client.query(
        'SELECT unit_id FROM registry.production_unit WHERE unit_id = $1 AND owner_farmer_id = $2',
        [f.unitId, subjectId],
      );
      if (unit.rows.length === 0) return { unitNotFound: true };

      const { rows } = await client.query(
        `INSERT INTO marketplace.fertilizer_mixing_group_participant
           (group_id, farmer_id, unit_id, requested_urea_kg, requested_dap_kg, requested_mop_kg,
            delivery_option, delivery_address, preferred_date, farmer_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING participant_id, status, requested_urea_kg, requested_dap_kg, requested_mop_kg, joined_at`,
        [
          g.group_id, subjectId, f.unitId, f.requestedUreaKg, f.requestedDapKg, f.requestedMopKg,
          f.deliveryOption, f.deliveryAddress, f.preferredDate, f.farmerNote,
        ],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_group_participant', rows[0].participant_id);
      return { participant: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_not_open', current_status: result.wrongStatus });
    if (result.deadlinePassed) return res.status(409).json({ error: 'join_deadline_passed' });
    if (result.alreadyParticipant) return res.status(409).json({ error: 'already_participant', current_status: result.alreadyParticipant });
    if (result.unitNotFound) return res.status(404).json({ error: 'production_unit_not_found' });
    return res.status(201).json(result.participant);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/fertilizer-mixing-groups/:id/withdraw — a non-organizer
 * participant leaves the group before it's submitted. The organizer
 * cannot withdraw through this endpoint (409 organizer_cannot_withdraw —
 * use POST .../:id/cancel instead, which ends the whole group), since a
 * group with participants but no organizer has no one able to submit or
 * cancel it.
 */
router.post('/fertilizer-mixing-groups/:id/withdraw', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const group = await client.query(
        'SELECT group_id, status, organizer_farmer_id FROM marketplace.fertilizer_mixing_group_order WHERE group_id = $1',
        [id],
      );
      if (group.rows.length === 0) return { notFound: true };
      if (group.rows[0].organizer_farmer_id === subjectId) return { isOrganizer: true };
      if (group.rows[0].status !== 'Open') return { wrongStatus: group.rows[0].status };

      const existing = await client.query(
        'SELECT participant_id, status FROM marketplace.fertilizer_mixing_group_participant WHERE group_id = $1 AND farmer_id = $2',
        [id, subjectId],
      );
      if (existing.rows.length === 0) return { notParticipant: true };
      if (existing.rows[0].status !== 'Joined') return { alreadyWithdrawn: true };

      const { rows } = await client.query(
        `UPDATE marketplace.fertilizer_mixing_group_participant
            SET status = 'Withdrawn', withdrawn_at = now()
          WHERE group_id = $1 AND farmer_id = $2
          RETURNING participant_id, status, withdrawn_at`,
        [id, subjectId],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_group_participant', rows[0].participant_id);
      return { participant: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_not_found' });
    if (result.isOrganizer) return res.status(409).json({ error: 'organizer_cannot_withdraw' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_not_open', current_status: result.wrongStatus });
    if (result.notParticipant) return res.status(404).json({ error: 'not_a_participant' });
    if (result.alreadyWithdrawn) return res.status(409).json({ error: 'already_withdrawn' });
    return res.json(result.participant);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/fertilizer-mixing-groups/:id/cancel — organizer-only, ends
 * the whole group before submission. Every participant's pledge stays in
 * the database (for history) but the group can never be submitted after
 * this — no real orders are ever created from a Cancelled group.
 */
router.post('/fertilizer-mixing-groups/:id/cancel', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const group = await client.query(
        'SELECT group_id, status FROM marketplace.fertilizer_mixing_group_order WHERE group_id = $1 AND organizer_farmer_id = $2',
        [id, subjectId],
      );
      if (group.rows.length === 0) return { notFound: true };
      if (group.rows[0].status !== 'Open') return { wrongStatus: group.rows[0].status };

      const { rows } = await client.query(
        `UPDATE marketplace.fertilizer_mixing_group_order
            SET status = 'Cancelled', cancelled_at = now(), updated_at = now()
          WHERE group_id = $1
          RETURNING group_id, status, cancelled_at`,
        [id],
      );
      await logAccess(client, 'write', 'marketplace.fertilizer_mixing_group_order', id);
      return { group: rows[0] };
    });

    if (result.notFound) return res.status(404).json({ error: 'group_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_not_open', current_status: result.wrongStatus });
    return res.json(result.group);
  } catch (err) {
    return next(err);
  }
});

/**
 * POST /farmer/fertilizer-mixing-groups/:id/submit — organizer-only,
 * finalizes the group: every current 'Joined' participant becomes a real
 * marketplace.fertilizer_mixing_order row (group_id set), priced at the
 * group's discounted unit_price if the combined kg met
 * bulk_discount_min_kg, at the normal snapshotted unit_price otherwise.
 *
 * The ONLY explicit multi-statement transaction (BEGIN/COMMIT/ROLLBACK)
 * in this codebase — every other write path here is a single INSERT/
 * UPDATE, but this one creates N order rows + updates N participant rows
 * + updates the group row, and a crash mid-loop must not leave some
 * participants with a real order and others silently without one.
 */
router.post('/fertilizer-mixing-groups/:id/submit', async (req, res, next) => {
  const { subjectId } = req.subject;
  const { id } = req.params;
  try {
    const result = await withSessionContext('farmer', subjectId, async (client) => {
      const group = await client.query(
        `SELECT group_id, status, listing_id, org_id, service_key, label_th, service_type,
                unit_price, price_unit, bulk_discount_min_kg, bulk_discount_percent
           FROM marketplace.fertilizer_mixing_group_order
          WHERE group_id = $1 AND organizer_farmer_id = $2`,
        [id, subjectId],
      );
      if (group.rows.length === 0) return { notFound: true };
      const g = group.rows[0];
      if (g.status !== 'Open') return { wrongStatus: g.status };

      const participants = await client.query(
        `SELECT participant_id, farmer_id, unit_id, requested_urea_kg, requested_dap_kg, requested_mop_kg,
                delivery_option, delivery_address, preferred_date, farmer_note
           FROM marketplace.fertilizer_mixing_group_participant
          WHERE group_id = $1 AND status = 'Joined'`,
        [id],
      );
      if (participants.rows.length === 0) return { noParticipants: true };

      const totalKg = participants.rows.reduce((sum, p) => sum + participantTotalKg(p), 0);
      const discountApplied = g.bulk_discount_min_kg !== null && g.bulk_discount_percent !== null
        && totalKg >= Number(g.bulk_discount_min_kg);
      const finalUnitPrice = discountApplied
        ? round2(Number(g.unit_price) * (1 - Number(g.bulk_discount_percent) / 100))
        : Number(g.unit_price);

      await client.query('BEGIN');
      try {
        const createdOrders = [];
        for (const p of participants.rows) {
          const { rows } = await client.query(
            `INSERT INTO marketplace.fertilizer_mixing_order
               (listing_id, org_id, farmer_id, unit_id, group_id,
                service_key, label_th, service_type, unit_price, price_unit,
                requested_urea_kg, requested_dap_kg, requested_mop_kg,
                delivery_option, delivery_address, preferred_date, farmer_note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             RETURNING order_id`,
            [
              g.listing_id, g.org_id, p.farmer_id, p.unit_id, id,
              g.service_key, g.label_th, g.service_type, finalUnitPrice, g.price_unit,
              p.requested_urea_kg, p.requested_dap_kg, p.requested_mop_kg,
              p.delivery_option, p.delivery_address, p.preferred_date, p.farmer_note,
            ],
          );
          const orderId = rows[0].order_id;
          createdOrders.push(orderId);
          await client.query(
            'UPDATE marketplace.fertilizer_mixing_group_participant SET order_id = $1 WHERE participant_id = $2',
            [orderId, p.participant_id],
          );
        }

        await client.query(
          `UPDATE marketplace.fertilizer_mixing_group_order
              SET status = 'Submitted', submitted_at = now(), updated_at = now(),
                  final_total_kg = $1, final_unit_price = $2, discount_applied = $3
            WHERE group_id = $4`,
          [totalKg, finalUnitPrice, discountApplied, id],
        );

        await client.query('COMMIT');
        await logAccess(client, 'write', 'marketplace.fertilizer_mixing_group_order', id);
        return {
          group: {
            group_id: id, status: 'Submitted', final_total_kg: totalKg,
            final_unit_price: finalUnitPrice, discount_applied: discountApplied,
            orders_created: createdOrders.length,
          },
        };
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      }
    });

    if (result.notFound) return res.status(404).json({ error: 'group_not_found' });
    if (result.wrongStatus) return res.status(409).json({ error: 'group_not_open', current_status: result.wrongStatus });
    if (result.noParticipants) return res.status(409).json({ error: 'no_participants' });
    return res.json(result.group);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
