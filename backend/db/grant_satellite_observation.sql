-- AgroLink -- M14 Data/AI/Satellite, piece #2: a general-purpose satellite/
-- remote-sensing observation adapter (P1 priority per the Master
-- Blueprint's own Gap Analysis).
--
-- Context: carbon.satellite_observation ALREADY exists (grant_carbon_awd.
-- sql) but is narrowly scoped to ONE thing — AWD rice water-status
-- (flooded/dry/uncertain) for a specific carbon-credit methodology, tied to
-- a production_unit and (best-effort) a crop cycle. That is NOT the
-- general-purpose remote-sensing feed M14 calls for (crop health/NDVI,
-- land cover, flood extent, etc., useful to any commodity/module, not just
-- AWD carbon assessments) — this migration adds a SEPARATE table for that
-- broader purpose rather than either duplicating carbon's narrow one or
-- awkwardly overloading it with unrelated observation_type values. The two
-- tables will likely stay separate even once real satellite integrations
-- exist, because carbon.satellite_observation feeds a specific, audited
-- credit-calculation pipeline (see carbon.awd_cycle_assessment) that
-- should not silently start reading rows meant for something else.
--
-- Design decision: same "manual today, real API later" honesty pattern as
-- carbon.satellite_observation — source_provider defaults to 'manual'
-- (Platform Ops enters it by hand, since no Sentinel Hub/Google Earth
-- Engine/GISTDA account is connected in this sandbox) with the same set of
-- forward-looking provider values already reserved so switching to a real
-- feed later is a data-source change, not a schema change.
--
-- Design decision: observation_type + value_numeric/value_label (rather
-- than one fixed enum column like carbon's inferred_water_status) is what
-- makes this table general-purpose — an NDVI reading is a number, a
-- land-cover classification is a label, and a future observation_type can
-- be added without a migration (same "purpose is a free-form tag" pattern
-- storage.file_object uses, see grant_object_storage.sql).
--
-- Follow-up (not built in this pass):
--   1. No automatic ingestion — every row is Platform Ops manual entry via
--      POST /admin/satellite-observations, same as carbon's own admin
--      route. A real integration would populate source_provider with the
--      actual provider and stop requiring manual entry for that provider.
--   2. No alerting/threshold logic (e.g. "NDVI dropped below X, notify the
--      farmer") — this table only stores observations; a rule engine
--      consuming it is separate future work.
--   3. No linkage into carbon's AWD assessment pipeline — deliberately, per
--      the header note above.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS satellite;
GRANT USAGE ON SCHEMA satellite TO agrolink_app;

CREATE TABLE IF NOT EXISTS satellite.observation (
  observation_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  unit_id            uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  observation_date   date NOT NULL,
  source_provider    text NOT NULL DEFAULT 'manual',
  observation_type   text NOT NULL,
  value_numeric      numeric(10,4),
  value_label        text,
  image_ref          text,
  note               text,
  recorded_by        text NOT NULL,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT satellite_observation_source_check
    CHECK (source_provider IN ('manual', 'sentinel1_sar', 'sentinel2_optical', 'landsat', 'gistda', 'other')),
  CONSTRAINT satellite_observation_type_check
    CHECK (observation_type IN ('ndvi', 'crop_health', 'land_cover', 'flood_extent', 'other')),
  CONSTRAINT satellite_observation_value_shape_check
    CHECK (value_numeric IS NOT NULL OR value_label IS NOT NULL),
  CONSTRAINT uq_satellite_observation UNIQUE (unit_id, observation_date, source_provider, observation_type)
);

CREATE INDEX IF NOT EXISTS idx_satellite_observation_unit ON satellite.observation (unit_id, observation_date);

GRANT SELECT, INSERT, UPDATE ON satellite.observation TO agrolink_app;

COMMENT ON TABLE satellite.observation IS
  'ข้อมูลจากภาพถ่ายดาวเทียม/remote sensing แบบทั่วไป (NDVI, สุขภาพพืช, การใช้ที่ดิน, พื้นที่น้ำท่วม ฯลฯ) ต่อแปลง (registry.production_unit) — แยกจาก carbon.satellite_observation ซึ่งใช้เฉพาะสถานะน้ำสำหรับประเมินเครดิตคาร์บอน AWD เท่านั้น (ดู header comment ของไฟล์นี้) วันนี้ป้อนด้วยมือโดย Platform Ops (source_provider=''manual'')';
COMMENT ON COLUMN satellite.observation.observation_type IS
  'ประเภทข้อมูล — ndvi (ค่าดัชนีพืชพรรณ), crop_health (สุขภาพพืชเชิงคุณภาพ), land_cover (การใช้ที่ดิน), flood_extent (พื้นที่น้ำท่วม), other';
COMMENT ON COLUMN satellite.observation.value_numeric IS
  'ค่าตัวเลข เช่น NDVI (-1 ถึง 1) — ใช้เมื่อ observation_type เป็นค่าที่วัดเป็นตัวเลขได้ (อย่างน้อยหนึ่งใน value_numeric/value_label ต้องมีค่า)';
COMMENT ON COLUMN satellite.observation.value_label IS
  'ค่าป้ายกำกับเชิงคุณภาพ เช่น "Healthy"/"Stressed"/"Bare Soil" — ใช้เมื่อ observation_type ไม่ใช่ค่าตัวเลขล้วน (อย่างน้อยหนึ่งใน value_numeric/value_label ต้องมีค่า)';
