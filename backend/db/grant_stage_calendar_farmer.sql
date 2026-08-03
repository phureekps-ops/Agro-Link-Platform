-- grant_stage_calendar_farmer.sql
--
-- Turns production.crop_cycle / production.stage_calendar /
-- production.stage_template from "schema + one hardcoded demo row" into a
-- real farmer-facing feature, and — as part of the same change — adds the
-- "ตรวจดิน + สั่งสูตรปุ๋ย" (soil test + fertilizer formula) stage as the
-- first step of the production cycle, ahead of land preparation, per
-- section 4 of the Prescription Fertilizer service plan ("ปฏิทินแผนการ
-- ผลิต (Stage Calendar): กำหนดขั้น 'ตรวจดิน + สั่งสูตรปุ๋ย' เป็นขั้นตอน
-- แรกก่อนขั้น 'เตรียมดิน/หว่าน' ที่มีอยู่แล้ว").
--
-- **A real gap this build surfaced**: before this script, NOTHING granted
-- agrolink_app any privilege at all on production.crop_cycle or
-- production.stage_calendar — only schema-level USAGE (03_grant_schema_
-- usage.sql) existed. The one query that reads these tables today
-- (POST /admin/credit-model/retrain's production_factor subquery, in
-- src/routes/admin.js) would fail with "permission denied for table
-- crop_cycle" the moment it actually ran against a from-scratch database
-- with every grant_*.sql applied in order — it happened to go unnoticed
-- because retrain was only ever tested against the original hand-granted
-- sandbox database, never a clean restore. This script's GRANTs fix that
-- as a side effect of adding the farmer-facing routes that need the same
-- privileges anyway.
--
-- **Scope note**: this migration only adds self-service crop-cycle/stage
-- tracking for farmers (they start a cycle, and confirm each stage
-- themselves in the app — no field-agent verification workflow, unlike
-- the one hardcoded demo cycle in dev_sample_data.sql which uses
-- verified_by = 'field_agent:...'). Self-reported stages here use
-- verified_by = 'self_reported:<farmer_id>', consistent with the soil-test
-- self-report convention already established in
-- grant_fertilizer_formula.sql.

-- ---------------------------------------------------------------------
-- 1. stage_key — lets application code identify "special" stages (like
--    the fertilizer step, which needs an extra completion gate) reliably,
--    instead of string-matching the Thai stage_name text (fragile: a
--    typo or a future rename of stage_name would silently break the
--    gate). NULL means "an ordinary stage, no special handling".
-- ---------------------------------------------------------------------
ALTER TABLE production.stage_template ADD COLUMN IF NOT EXISTS stage_key text;
ALTER TABLE production.stage_template DROP CONSTRAINT IF EXISTS stage_template_stage_key_check;
ALTER TABLE production.stage_template
  ADD CONSTRAINT stage_template_stage_key_check
  CHECK (stage_key IS NULL OR stage_key IN ('soil_test_fertilizer'));

ALTER TABLE production.stage_calendar ADD COLUMN IF NOT EXISTS stage_key text;
ALTER TABLE production.stage_calendar DROP CONSTRAINT IF EXISTS stage_calendar_stage_key_check;
ALTER TABLE production.stage_calendar
  ADD CONSTRAINT stage_calendar_stage_key_check
  CHECK (stage_key IS NULL OR stage_key IN ('soil_test_fertilizer'));

COMMENT ON COLUMN production.stage_template.stage_key IS 'ตัวระบุขั้นตอนพิเศษที่แอปต้องมีเงื่อนไขเพิ่มก่อนยืนยันได้ (ปัจจุบันมีค่าเดียวคือ soil_test_fertilizer) NULL = ขั้นตอนทั่วไป ไม่มีเงื่อนไขพิเศษ';
COMMENT ON COLUMN production.stage_calendar.stage_key IS 'คัดลอกมาจาก stage_template ตอนสร้างรอบปลูก ใช้เป็นตัวระบุขั้นตอนพิเศษเช่นเดียวกัน';

-- ---------------------------------------------------------------------
-- 2. Seed stage_template — the table has been completely empty since it
--    was first created in 02_full_schema.sql (no route/script ever wrote
--    to it). Seeded here for the same 3 commodities
--    grant_fertilizer_formula.sql already seeded crop_nutrient_requirement
--    for, so "start a new crop cycle" and "AI ปุ๋ยสั่งตัด" cover the same
--    crop list. typical_offset_days values are rough, generic-knowledge
--    placeholders (same honesty caveat as crop_nutrient_requirement) —
--    NOT an official Department of Agriculture cropping calendar.
--
--    Re-runnable: deletes existing rows for these 3 commodities first,
--    then re-inserts, so running this script twice does not duplicate
--    rows (stage_template has no natural unique constraint to ON CONFLICT
--    against).
-- ---------------------------------------------------------------------
DELETE FROM production.stage_template WHERE commodity_code IN ('RICE_JASMINE', 'RICE_PADDY', 'CASSAVA');

INSERT INTO production.stage_template (commodity_code, stage_seq, stage_name, typical_offset_days, stage_key) VALUES
  ('RICE_JASMINE', 1, 'ตรวจดิน + สั่งสูตรปุ๋ย (ปุ๋ยสั่งตัด)', 0,   'soil_test_fertilizer'),
  ('RICE_JASMINE', 2, 'เตรียมดินและเพาะกล้า',                7,   NULL),
  ('RICE_JASMINE', 3, 'ปลูก/ปักดำ',                          25,  NULL),
  ('RICE_JASMINE', 4, 'ดูแลรักษา/ใส่ปุ๋ย',                    55,  NULL),
  ('RICE_JASMINE', 5, 'เก็บเกี่ยว',                          110, NULL),

  ('RICE_PADDY', 1, 'ตรวจดิน + สั่งสูตรปุ๋ย (ปุ๋ยสั่งตัด)', 0,   'soil_test_fertilizer'),
  ('RICE_PADDY', 2, 'เตรียมดินและเพาะกล้า',                7,   NULL),
  ('RICE_PADDY', 3, 'ปลูก/ปักดำ',                          20,  NULL),
  ('RICE_PADDY', 4, 'ดูแลรักษา/ใส่ปุ๋ย',                    50,  NULL),
  ('RICE_PADDY', 5, 'เก็บเกี่ยว',                          100, NULL),

  ('CASSAVA', 1, 'ตรวจดิน + สั่งสูตรปุ๋ย (ปุ๋ยสั่งตัด)', 0,   'soil_test_fertilizer'),
  ('CASSAVA', 2, 'เตรียมดิน',                            10,  NULL),
  ('CASSAVA', 3, 'ปลูก',                                20,  NULL),
  ('CASSAVA', 4, 'ดูแลรักษา/ใส่ปุ๋ย',                    90,  NULL),
  ('CASSAVA', 5, 'เก็บเกี่ยว',                          300, NULL);

COMMENT ON TABLE production.stage_template IS 'เทมเพลตขั้นตอนการผลิตต่อพืช ใช้สร้างปฏิทิน (production.stage_calendar) ตอนเกษตรกรเริ่มรอบปลูกใหม่ — typical_offset_days เป็นค่าประมาณการทั่วไปสำหรับต้นแบบเท่านั้น ไม่ใช่ปฏิทินเพาะปลูกทางการของกรมวิชาการเกษตร ควรตรวจสอบความแม่นยำก่อนใช้แนะนำเกษตรกรจริงจังเชิงพาณิชย์';

-- ---------------------------------------------------------------------
-- 3. Grants — see the gap note in the file header above.
-- ---------------------------------------------------------------------
GRANT SELECT ON production.stage_template TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON production.crop_cycle TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON production.stage_calendar TO agrolink_app;
