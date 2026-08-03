-- grant_fertilizer_formula.sql
--
-- Backs the "ปุ๋ยสั่งตัด" (Prescription Fertilizer) enablement service
-- described in AgroLink_Prescription_Fertilizer_Soil_Sang_Tat_Service_Plan.md
-- (analysis doc, 2569-08-03). That plan proposes 4 modules; THIS migration
-- + its sibling routes build module 2.2 (AI Fertilizer Formula Calculator)
-- and the "tier 2" half of module 2.1 (real, farmer/self-reported soil-test
-- data feeding the calculator) — see backend/README.md's new
-- "## Prescription Fertilizer (ปุ๋ยสั่งตัด)" section for exactly what is and
-- is NOT built this round (modules 2.3/2.4 — the fulfillment marketplace
-- and bulk แม่ปุ๋ย sourcing — are deliberately deferred; they need a new org
-- role/portal this platform doesn't have yet).
--
-- **Important, per the analysis doc's own explicit caution (section 2.2 /
-- section 6)**: production.crop_nutrient_requirement below is a
-- deliberately simple, transparent PLACEHOLDER built from general public-
-- domain agronomy figures — it is NOT the Department of Agriculture's
-- (กรมวิชาการเกษตร, DOA) actual published ปุ๋ยสั่งตัด mixing tables, which are
-- that department's own methodology and require formal permission before
-- any commercial use. Every calculated result surfaces this caveat back to
-- the farmer (see POST /farmer/fertilizer-formula/calculate's response
-- shape in src/routes/fertilizer.js) rather than presenting the estimate as
-- an authoritative government figure.

-- ---------------------------------------------------------------------
-- 1. production.soil_test — a farmer-reported (or future field-technician-
--    reported) soil test result for one production unit. Deliberately
--    categorical (low/medium/high) rather than raw ppm for the primary
--    N/P/K reading, matching how the rapid color-based NPK test kits the
--    analysis doc references (Kasetsart University RDI's) actually report
--    results — a farmer reads a color chart, not a lab printout. Optional
--    raw ppm columns exist alongside for when a more precise LDD lab
--    result (ห้องแล็บวิเคราะห์ดิน-น้ำ-พืช-ปุ๋ย, สำนักวิทยาศาสตร์เพื่อการพัฒนาที่ดิน)
--    is available instead — informational only, not read by the calculator.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production.soil_test (
  soil_test_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id            uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  tested_at          timestamptz NOT NULL DEFAULT now(),
  n_level            text NOT NULL,
  p_level            text NOT NULL,
  k_level            text NOT NULL,
  ph_value           numeric(3,1),
  organic_matter_pct numeric(4,2),
  n_ppm              numeric(8,2),
  p_ppm              numeric(8,2),
  k_ppm              numeric(8,2),
  source             text NOT NULL DEFAULT 'manual',
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soil_test_n_level_check CHECK (n_level IN ('low', 'medium', 'high')),
  CONSTRAINT soil_test_p_level_check CHECK (p_level IN ('low', 'medium', 'high')),
  CONSTRAINT soil_test_k_level_check CHECK (k_level IN ('low', 'medium', 'high')),
  CONSTRAINT soil_test_source_check CHECK (source IN ('manual', 'ldd_baseline')),
  CONSTRAINT soil_test_ph_check CHECK (ph_value IS NULL OR (ph_value BETWEEN 0 AND 14)),
  CONSTRAINT soil_test_om_check CHECK (organic_matter_pct IS NULL OR organic_matter_pct >= 0)
);

CREATE INDEX IF NOT EXISTS idx_soil_test_unit ON production.soil_test (unit_id, tested_at DESC);

GRANT SELECT, INSERT ON production.soil_test TO agrolink_app;

COMMENT ON TABLE production.soil_test IS 'ผลตรวจดินรายแปลง (tier 2 ของ Soil Fertility Data Layer ในเอกสารวิเคราะห์ปุ๋ยสั่งตัด) — ปัจจุบันบันทึกโดยเกษตรกรเอง (self-reported); เครือข่าย "นักตรวจดินเคลื่อนที่"/เกษตรตำบล ที่เอกสารเสนอไว้ยังไม่ได้สร้างเป็นบทบาทจริงในระบบ (ต้องเจรจา MOU กับ DOAE ก่อน) ดู POST /farmer/soil-tests ใน src/routes/fertilizer.js';

-- ---------------------------------------------------------------------
-- 2. production.crop_nutrient_requirement — reference table keyed to the
--    SAME registry.commodity_ref domain already used everywhere else in
--    this project (RICE_JASMINE / RICE_PADDY / CASSAVA — see
--    04_reference_data.sql). See the placeholder-data warning at the top
--    of this file.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production.crop_nutrient_requirement (
  commodity_code  text PRIMARY KEY REFERENCES registry.commodity_ref(commodity_code),
  n_kg_per_rai    numeric(6,2) NOT NULL,
  p2o5_kg_per_rai numeric(6,2) NOT NULL,
  k2o_kg_per_rai  numeric(6,2) NOT NULL,
  notes           text,
  CONSTRAINT crop_nutrient_requirement_positive_check
    CHECK (n_kg_per_rai >= 0 AND p2o5_kg_per_rai >= 0 AND k2o_kg_per_rai >= 0)
);

GRANT SELECT ON production.crop_nutrient_requirement TO agrolink_app;

INSERT INTO production.crop_nutrient_requirement (commodity_code, n_kg_per_rai, p2o5_kg_per_rai, k2o_kg_per_rai, notes) VALUES
  ('RICE_JASMINE', 8.00, 4.00, 6.00,  'ค่าประมาณการทั่วไป (เป้าหมายผลผลิตปานกลาง) — ไม่ใช่ตารางทางการของกรมวิชาการเกษตร ต้องยืนยัน/ขออนุญาตใช้ระเบียบวิธีจริงก่อนใช้เชิงพาณิชย์'),
  ('RICE_PADDY',   10.00, 5.00, 6.00,  'ค่าประมาณการทั่วไป (เป้าหมายผลผลิตปานกลาง) — ไม่ใช่ตารางทางการของกรมวิชาการเกษตร ต้องยืนยัน/ขออนุญาตใช้ระเบียบวิธีจริงก่อนใช้เชิงพาณิชย์'),
  ('CASSAVA',      12.00, 6.00, 12.00, 'มันสำปะหลังต้องการโพแทสเซียมสูงกว่าข้าวตามลักษณะพืชหัว — ค่าประมาณการทั่วไป ไม่ใช่ตารางทางการของกรมวิชาการเกษตร')
ON CONFLICT (commodity_code) DO NOTHING;

COMMENT ON TABLE production.crop_nutrient_requirement IS 'ตารางอ้างอิงความต้องการธาตุอาหารต่อไร่ต่อพืช — PLACEHOLDER จากความรู้เกษตรทั่วไปสาธารณะ ไม่ใช่ตารางผสมปุ๋ยที่เผยแพร่โดยกรมวิชาการเกษตร (DOA) ห้ามใช้อ้างอิงเป็นคำแนะนำทางการก่อนได้รับอนุญาต/ยืนยันจาก DOA — ดูหมวด 2.2 และ 6 ของเอกสารวิเคราะห์ปุ๋ยสั่งตัด';

-- ---------------------------------------------------------------------
-- 3. production.fertilizer_formula_calc — one row per calculator run,
--    kept as history (same "keep every run, don't overwrite" convention as
--    risk.credit_model). cycle_id is a NULLABLE forward-reference to
--    production.crop_cycle for a future version — no route in this
--    project lets a farmer create a crop_cycle/stage_calendar row yet
--    (production.stage_calendar is currently seed-data-only; see
--    backend/README.md), so this calculator works standalone off
--    registry.production_unit today and simply has nowhere to attach a
--    cycle_id yet.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production.fertilizer_formula_calc (
  calc_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id          uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  farmer_id        uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  soil_test_id     uuid REFERENCES production.soil_test(soil_test_id),
  cycle_id         uuid REFERENCES production.crop_cycle(cycle_id),
  commodity_code   text NOT NULL,
  area_rai         numeric(10,2) NOT NULL,
  n_required_kg    numeric(8,2) NOT NULL,
  p2o5_required_kg numeric(8,2) NOT NULL,
  k2o_required_kg  numeric(8,2) NOT NULL,
  urea_kg          numeric(8,2) NOT NULL,
  dap_kg           numeric(8,2) NOT NULL,
  mop_kg           numeric(8,2) NOT NULL,
  estimated_cost   numeric(12,2),
  price_data_complete boolean NOT NULL DEFAULT false,
  price_snapshot   jsonb,
  calculated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fertilizer_formula_calc_area_check CHECK (area_rai > 0)
);

CREATE INDEX IF NOT EXISTS idx_fertilizer_calc_farmer ON production.fertilizer_formula_calc (farmer_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fertilizer_calc_unit ON production.fertilizer_formula_calc (unit_id, calculated_at DESC);

GRANT SELECT, INSERT ON production.fertilizer_formula_calc TO agrolink_app;

COMMENT ON TABLE production.fertilizer_formula_calc IS 'ประวัติผลการคำนวณสูตรปุ๋ยสั่งตัดแต่ละครั้ง (AI Fertilizer Formula Calculator, module 2.2 ของเอกสารวิเคราะห์) — ดู POST /farmer/fertilizer-formula/calculate ใน src/routes/fertilizer.js';

-- ---------------------------------------------------------------------
-- 4. marketplace.product_listing — add optional fertilizer-grade tagging
--    so the calculator can price its urea/DAP/MOP shopping list against
--    REAL currently-listed InputSupplier prices (module 2.2's 4th required
--    input, "ราคาแม่ปุ๋ยปัจจุบันในตลาด") instead of a fragile guess from the
--    free-text product_name. fertilizer_kg_per_unit exists because
--    price_unit is free text across this catalog (a supplier's own
--    placeholder text already suggests "บาท/กระสอบ" — a 50kg sack — is
--    common for fertilizer, NOT บาท/กก.); without knowing the weight a
--    listing's price actually covers, a per-kg cost estimate would be
--    silently wrong by whatever the sack size is. Both columns are
--    NULL-safe no-ops for every existing/non-fertilizer listing — nothing
--    about GET /farmer/products or any other existing query changes.
-- ---------------------------------------------------------------------
ALTER TABLE marketplace.product_listing
  ADD COLUMN IF NOT EXISTS fertilizer_npk_grade text,
  ADD COLUMN IF NOT EXISTS fertilizer_kg_per_unit numeric(8,2);

ALTER TABLE marketplace.product_listing DROP CONSTRAINT IF EXISTS product_listing_fertilizer_kg_per_unit_check;
ALTER TABLE marketplace.product_listing
  ADD CONSTRAINT product_listing_fertilizer_kg_per_unit_check
  CHECK (fertilizer_kg_per_unit IS NULL OR fertilizer_kg_per_unit > 0);

COMMENT ON COLUMN marketplace.product_listing.fertilizer_npk_grade IS 'เกรดปุ๋ย N-P-K เช่น 46-0-0 (ยูเรีย)/18-46-0 (DAP)/0-0-60 (โพแทสเซียมคลอไรด์/MOP) — ระบุเฉพาะเมื่อ category=fertilizer_hormone ไม่บังคับกรอก ใช้จับคู่ราคากับ AI ปุ๋ยสั่งตัด (POST /farmer/fertilizer-formula/calculate)';
COMMENT ON COLUMN marketplace.product_listing.fertilizer_kg_per_unit IS 'น้ำหนัก (กก.) ที่ unit_price ครอบคลุมจริง เช่น 50 สำหรับกระสอบ 50 กก. — จำเป็นสำหรับแปลง unit_price เป็นราคาต่อกก. ให้ AI ปุ๋ยสั่งตัดคำนวณต้นทุนได้ถูกต้อง ถ้าไม่ระบุ ระบบจะไม่ใช้รายการนี้ประเมินราคา';
