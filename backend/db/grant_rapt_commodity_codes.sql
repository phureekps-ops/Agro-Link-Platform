-- AgroLink -- P1/P4 (RAP-T readiness roadmap, see the "AgroLink x RAP-T:
-- Gap Analysis" report and grant_field_survey.sql's own header comment):
-- registers 8 new registry.commodity_ref rows for the 5 RAP-T value chains
-- that had NO commodity code at all before this migration -- durian, feed
-- corn, coffee, aromatic coconut, and 4 caged-fish species (tilapia, red
-- tilapia, seabass, grouper).
--
-- Context: registry.commodity_ref is explicitly a minimal lookup table
-- (commodity_code/name_th/agrovoc_ref only -- see its own COMMENT ON TABLE
-- in 02_full_schema.sql: "ตารางอ้างอิงชั่วคราวสำหรับความสมบูรณ์ของ FK
-- เท่านั้น"), so adding a commodity here is additive-only and needs no
-- schema change -- same pattern grant_shrimp_auction.sql already used to
-- add SHRIMP_VANNAMEI/SHRIMP_BLACKTIGER/SHRIMP_OTHER. This migration does
-- the SAME thing for the other 5 RAP-T chains, in one pass.
--
-- What this migration unblocks immediately: registry.farmer_plot_
-- registration() (grant_farmer_plot_registration.sql) validates
-- commodity_code against this table and RAISEs 'ไม่พบรหัสพืช/สัตว์เศรษฐกิจ
-- %' when it's missing -- these 8 codes existing means a farmer in any of
-- these 5 value chains can now register a real registry.production_unit,
-- and fieldsurvey.visit_record.migrated_to_unit_id (grant_field_survey.
-- sql) finally has something real to point at.
--
-- What this migration deliberately does NOT do (separate follow-up work,
-- not folded in here):
--   1. No production.stage_template rows (production-calendar stages) for
--      any of these 8 codes -- CASSAVA's 5-stage template (grant_
--      stage_calendar_farmer.sql) is the model to follow when that work
--      happens; until then, a production_unit for these commodities exists
--      but has no stage calendar to track against (same gap the Gap
--      Analysis report's ตารางที่ 1 already called out for ทุเรียน/
--      ข้าวโพดเลี้ยงสัตว์ specifically).
--   2. No carbon/MRV support -- that module is still filtered to
--      commodity_code LIKE 'RICE_%' (see the Gap Analysis report's ลำดับ 2).
--   3. agrovoc_ref left NULL for all 8 rows, same as the 3 SHRIMP_* rows
--      before this migration -- filling it needs a verified FAO AGROVOC
--      concept id per commodity, which this pass does not have confirmed
--      values for (guessing one would be worse than leaving it NULL, since
--      a wrong id is indistinguishable from a right one downstream).
--
-- Naming: one code per species/variety actually named in the RAP-T policy
-- announcement and AgroLink's own Concept Note -- ปลานิล (tilapia) and
-- ปลาทับทิม (red tilapia) are two distinct codes (not one "tilapia_group"
-- code) because they are commercially distinct products with different
-- prices, same reasoning RICE_JASMINE/RICE_PADDY already stay separate
-- codes rather than one "rice" code. Same for ปลากระพง (seabass) and
-- ปลาเก๋า (grouper) -- both farmed in cages but different species.
-- ============================================================================

INSERT INTO registry.commodity_ref (commodity_code, name_th, agrovoc_ref) VALUES
  ('DURIAN',            'ทุเรียน',            NULL),
  ('CORN_FEED',         'ข้าวโพดเลี้ยงสัตว์',   NULL),
  ('COFFEE',            'กาแฟ',               NULL),
  ('COCONUT_AROMATIC',  'มะพร้าวน้ำหอม',       NULL),
  ('TILAPIA_CAGE',      'ปลานิลกระชัง',        NULL),
  ('TILAPIA_RED_CAGE',  'ปลาทับทิมกระชัง',     NULL),
  ('SEABASS_CAGE',      'ปลากระพงกระชัง',      NULL),
  ('GROUPER_CAGE',      'ปลาเก๋ากระชัง',       NULL)
ON CONFLICT (commodity_code) DO NOTHING;
