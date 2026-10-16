-- AgroLink -- P0 (RAP-T readiness roadmap, see the "AgroLink x RAP-T: Gap
-- Analysis" report): a lightweight digital field-survey tool, built ahead
-- of RAP-T's own field assessment visit (planned Nov 2569/2026).
--
-- Context: RICE_JASMINE/RICE_PADDY, CASSAVA, and the three SHRIMP_* codes
-- are the only rows registry.commodity_ref has today (see 04_reference_
-- data.sql and grant_shrimp_auction.sql) -- durian, feed corn, coffee,
-- aromatic coconut, and caged fish (tilapia/red tilapia/seabass/grouper)
-- have no commodity code at all, which means registry.farmer_plot_
-- registration() RAISEs on any attempt to register a plot/farm for them
-- (it looks up commodity_ref and fails closed when the code isn't found --
-- see that function's own body). RAP-T's field team needs a working
-- digital tool for these 5 value chains well before that schema work (P1/
-- P4 in the roadmap) can land, so this migration deliberately does NOT
-- extend registry.production_unit -- it adds a SEPARATE, standalone table
-- that captures baseline visit data without depending on commodity_ref at
-- all. commodity_label is free text for exactly that reason (the real
-- registry entry doesn't exist yet); target_chain is a small CHECK-
-- constrained column alongside it only so Platform Ops can group/count
-- visits per value chain for reporting, without forcing every nuance of
-- "what did the enumerator actually write down" into an enum.
--
-- Design decision: migrated_to_unit_id is reserved (nullable, FK'd, but
-- left NULL by every route in this pass -- see Follow-up #1 below) so that
-- once a real commodity_ref code + registry.production_unit row exists for
-- a visited farmer, this record can be linked to it without re-collecting
-- the same baseline data. The field survey table is meant to feed the real
-- registry later, not to live beside it forever.
--
-- Design decision: no RLS policy on fieldsurvey.visit_record -- same
-- precedent as storage.file_object (grant_object_storage.sql) and
-- satellite.observation (grant_satellite_observation.sql): every route
-- that touches this table requires a platform (Platform Ops / enumerator)
-- JWT via requirePlatform, enforced in backend/src/routes/admin.js, not at
-- the database layer. There is no separate "field enumerator" identity
-- table in this sandbox (same honesty as grant_staff_and_government_
-- access.sql's own notes) -- an enumerator logs in with the shared admin
-- passcode like any other Platform Ops user, and is identified in the data
-- only by the free-text recorded_by field, same convention as
-- satellite.observation.recorded_by / carbon.satellite_observation.
--
-- Follow-up (not built in this pass):
--   1. No route sets migrated_to_unit_id -- once P1/P4 add commodity_ref
--      codes + a farm/plot module for these 5 chains, a follow-up route
--      (and an UPDATE grant on this table, not included below) would let
--      Platform Ops link a visit record to the real production_unit it
--      became.
--   2. One photo per visit (photo_file_id), not a gallery -- sufficient for
--      a baseline visit; a multi-photo gallery would need its own join
--      table if ever needed.
--   3. No offline/sync support -- this is a plain online form; a
--      poor-connectivity field tool (queue-and-sync) is explicitly flagged
--      as a later decision in the Gap Analysis report, not assumed here.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS fieldsurvey;
GRANT USAGE ON SCHEMA fieldsurvey TO agrolink_app;

CREATE TABLE IF NOT EXISTS fieldsurvey.visit_record (
  record_id               uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  visit_date              date NOT NULL,
  target_chain            text NOT NULL,
  commodity_label         text NOT NULL,
  farmer_name             text NOT NULL,
  phone                   text,
  province                text NOT NULL,
  district                text,
  sub_district             text,
  gps_lat                 numeric(9,6),
  gps_lng                 numeric(9,6),
  estimated_area_rai      numeric(10,2),
  current_practices       text,
  climate_risks           text,
  finance_access          text,
  insurance_access        text,
  market_channel          text,
  interested_in_agrolink  boolean NOT NULL DEFAULT false,
  note                    text,
  photo_file_id           uuid REFERENCES storage.file_object(file_id),
  migrated_to_unit_id     uuid REFERENCES registry.production_unit(unit_id),
  recorded_by             text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_record_target_chain_check
    CHECK (target_chain IN ('durian', 'feed_corn', 'coffee', 'aromatic_coconut', 'caged_fish', 'other')),
  CONSTRAINT visit_record_gps_shape_check
    CHECK ((gps_lat IS NULL AND gps_lng IS NULL) OR (gps_lat IS NOT NULL AND gps_lng IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_visit_record_chain_date ON fieldsurvey.visit_record (target_chain, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_visit_record_province ON fieldsurvey.visit_record (province);

-- No UPDATE/DELETE grant in this pass -- see Follow-up #1 above; a visit
-- record is append-only until that follow-up route exists.
GRANT SELECT, INSERT ON fieldsurvey.visit_record TO agrolink_app;

COMMENT ON TABLE fieldsurvey.visit_record IS
  'บันทึกข้อมูลจากการลงพื้นที่สำรวจห่วงโซ่คุณค่าที่ยังไม่มีทะเบียนสินค้าในระบบ (ทุเรียน ข้าวโพดเลี้ยงสัตว์ กาแฟ มะพร้าวน้ำหอม ปลากระชัง) ใช้เป็นข้อมูลตั้งต้น (baseline) ก่อนที่ registry.commodity_ref/production_unit จะรองรับสินค้าเหล่านี้จริง (ดู P1/P4 ในแผนพัฒนา) -- ไม่ผูกกับ production_unit โดยตรง เพื่อให้เริ่มเก็บข้อมูลได้ทันทีโดยไม่ต้องรอ schema สินค้าใหม่';
COMMENT ON COLUMN fieldsurvey.visit_record.target_chain IS
  'กลุ่มห่วงโซ่คุณค่าเป้าหมายตาม RAP-T -- ใช้สำหรับนับจำนวน/จัดกลุ่มรายงานเท่านั้น รายละเอียดจริงอยู่ที่ commodity_label (ข้อความอิสระ)';
COMMENT ON COLUMN fieldsurvey.visit_record.commodity_label IS
  'ชนิด/สายพันธุ์สินค้าตามที่ผู้สำรวจบันทึก เป็นข้อความอิสระเพราะยังไม่มีรหัสสินค้า (commodity_ref) รองรับห่วงโซ่เหล่านี้';
COMMENT ON COLUMN fieldsurvey.visit_record.migrated_to_unit_id IS
  'อ้างอิง registry.production_unit หลังจากมีการขึ้นทะเบียนแปลงจริงแล้ว (ยังไม่มีเส้นทางในระบบที่ตั้งค่านี้ในรอบนี้ -- ดู Follow-up #1 ใน header comment) -- NULL หมายถึงยังเป็นข้อมูลภาคสนามล้วน ๆ';
COMMENT ON COLUMN fieldsurvey.visit_record.photo_file_id IS
  'อ้างอิงไฟล์รูปถ่ายแปลง/สวน/บ่อที่อัปโหลดผ่าน POST /storage/upload (purpose=''field_survey_photo'') -- ไม่บังคับ';
