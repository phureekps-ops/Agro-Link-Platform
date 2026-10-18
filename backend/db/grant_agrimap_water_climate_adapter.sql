-- AgroLink -- P3 (RAP-T readiness roadmap, see the "AgroLink x RAP-T: Gap
-- Analysis" report): a water/climate-risk area-alert adapter, built toward
-- RAP-T's policy recommendation #3 ("เชื่อมโยงข้อมูลน้ำผ่านระบบ Agri-Map --
-- บูรณาการข้อมูลบริหารจัดการน้ำและการคาดการณ์ภัยพิบัติจากกรมชลประทานเข้ากับ
-- แอปพลิเคชัน Agri-Map เพื่อส่งตรงข้อมูลแจ้งเตือนล่วงหน้าให้เกษตรกรใช้
-- วางแผนเพาะปลูกได้อย่างแม่นยำ").
--
-- Honesty check done BEFORE writing this (so scope is not overstated):
-- Agri-Map is กรมพัฒนาที่ดิน's (Land Development Department, LDD) own
-- national agri-geospatial system, integrating spatial data from several
-- agencies (including, per RAP-T's own recommendation, water/disaster data
-- from กรมชลประทาน). As of this migration, Agri-Map itself is newly
-- launching (official unveiling ~Aug 2569, general availability targeted
-- mid-Sep 2569) and there is NO confirmed public API or open-data feed
-- from LDD yet -- a live integration is not something this migration can
-- build today, because the thing on the other end does not expose one
-- yet. What this migration DOES build is the same "manual today, real API
-- later" adapter shape already proven twice in this codebase
-- (satellite.observation, grant_satellite_observation.sql; carbon.
-- satellite_observation, grant_carbon_awd.sql): a schema shaped to receive
-- real area-level water/climate-risk data, populated by hand by Platform
-- Ops (reading published LDD/กรมชลประทาน bulletins) until a real feed or
-- data-sharing agreement exists, at which point source_provider switches
-- from 'manual' to a real value and an ingestion job replaces manual entry
-- -- a data-source change, not a schema change.
--
-- Design decision -- AREA-scoped, not plot-scoped: unlike satellite.
-- observation (tied to one registry.production_unit), this is explicitly
-- about province/district-level advance warning ("ส่งตรงข้อมูลแจ้งเตือน
-- ล่วงหน้า"), matching how RAP-T's own policy recommendation frames it --
-- a farmer who has not registered any plot yet should still be able to see
-- "น้ำท่วมฉับพลัน จ.อุบลราชธานี" before a disaster, not only after they
-- have an eligible registry.production_unit row. A unit-level drill-down
-- can be layered on later without a redesign (province_code/district_code
-- would simply gain a companion unit_id column).
--
-- Design decision -- province_code/district_code use the SAME code scheme
-- as identity.farmer.region_code/district_code (TH_PROVINCES/TH_DISTRICTS,
-- "TH-50"/"TH-50-01" -- see grant_farmer_district.sql, grant_org_district.
-- sql), NOT registry.province's Thai-name scheme that fieldsurvey.
-- visit_record's free-text province column happens to use. This is
-- deliberate: the whole point of this table is "show farmer X the alerts
-- for farmer X's own province/district", which has to be a plain equality
-- join against identity.farmer.region_code/district_code -- using
-- registry.province's name strings here would make that join fragile
-- (string-equality across two independently-typed free-text columns)
-- instead of comparing two columns that already share one code scheme by
-- convention across the codebase.
--
-- Design decision -- no dataset/sharing-toggle layer like oae.dataset /
-- oae.dataset_sharing: สศก.'s price data is commercially sensitive enough
-- to need a per-audience ON/OFF switch an OAE officer controls. A flood/
-- drought/water-level warning is public-safety information with no such
-- sensitivity -- gating it behind an extra toggle would only risk a
-- warning staying hidden by omission. Every row inserted here is visible
-- to every farmer in its province/district immediately; valid_until is the
-- only lifecycle control (see below).
--
-- Design decision -- registry.department also gets a row for LDD here
-- (reusing the generic multi-department mechanism grant_oae_data_portal.
-- sql already built -- no schema change needed for that table). No
-- officer-gated write path is wired up in this pass, same as satellite.
-- observation's own choice not to gate writes behind a specific-department
-- check: there is no real LDD/กรมชลประทาน officer account to provision
-- yet. The row exists so that WHEN one is provisioned later (same
-- mechanism grant_oae_data_portal.sql used for สศก.), self-service entry
-- is a new route, not a migration.
-- ============================================================================

INSERT INTO registry.department (department_code, department_name_th) VALUES
  ('LDD', 'กรมพัฒนาที่ดิน (เจ้าของระบบ Agri-Map)')
ON CONFLICT (department_code) DO NOTHING;

CREATE SCHEMA IF NOT EXISTS agrimap;
GRANT USAGE ON SCHEMA agrimap TO agrolink_app;

CREATE TABLE IF NOT EXISTS agrimap.area_risk_observation (
  observation_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  province_code     text NOT NULL,
  district_code     text,
  risk_type         text NOT NULL,
  severity_level    text,
  value_numeric     numeric(10,2),
  value_label       text,
  headline_th       text NOT NULL,
  detail_th         text,
  source_provider   text NOT NULL DEFAULT 'manual',
  valid_from        date NOT NULL DEFAULT CURRENT_DATE,
  valid_until       date,
  recorded_by       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agrimap_risk_type_check
    CHECK (risk_type IN ('water_level', 'flood_risk', 'drought_risk', 'rainfall_forecast',
                          'irrigation_schedule', 'soil_water_suitability', 'other')),
  CONSTRAINT agrimap_severity_level_check
    CHECK (severity_level IS NULL OR severity_level IN ('info', 'low', 'medium', 'high', 'critical')),
  CONSTRAINT agrimap_source_provider_check
    CHECK (source_provider IN ('manual', 'agri_map_ldd', 'rid_water_data', 'other')),
  CONSTRAINT agrimap_valid_range_check
    CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE INDEX IF NOT EXISTS idx_agrimap_area_risk_area
  ON agrimap.area_risk_observation (province_code, district_code, valid_from DESC);

GRANT SELECT, INSERT, UPDATE ON agrimap.area_risk_observation TO agrolink_app;

COMMENT ON TABLE agrimap.area_risk_observation IS
  'คำเตือน/ข้อมูลความเสี่ยงด้านน้ำและภูมิอากาศระดับพื้นที่ (จังหวัด/อำเภอ) ตามแนวทาง Agri-Map ของกรมพัฒนาที่ดิน (บูรณาการข้อมูลจากกรมชลประทาน) -- ดู header comment ของไฟล์นี้สำหรับเหตุผลที่ออกแบบระดับพื้นที่แทนระดับแปลง และป้อนด้วยมือโดย Platform Ops วันนี้ (source_provider=''manual'') จนกว่าจะมี API จริงจาก LDD/กรมชลประทาน';
COMMENT ON COLUMN agrimap.area_risk_observation.province_code IS
  'รหัสจังหวัดตามชุดรหัส TH_PROVINCES เดียวกับ identity.farmer.region_code (เช่น "TH-50") -- ไม่ใช่ registry.province.province_name_th -- เพื่อให้ join หาผู้ใช้ในพื้นที่ตรงกันได้แบบเทียบค่าตรงๆ';
COMMENT ON COLUMN agrimap.area_risk_observation.district_code IS
  'รหัสอำเภอตามชุดรหัส TH_DISTRICTS เดียวกับ identity.farmer.district_code (เช่น "TH-50-01") -- เว้นว่างหมายถึงคำเตือนครอบคลุมทั้งจังหวัด';
COMMENT ON COLUMN agrimap.area_risk_observation.risk_type IS
  'water_level (ระดับน้ำ), flood_risk (เสี่ยงน้ำท่วม), drought_risk (เสี่ยงภัยแล้ง), rainfall_forecast (พยากรณ์ฝน), irrigation_schedule (แผนส่งน้ำชลประทาน), soil_water_suitability (ความเหมาะสมดิน-น้ำตามข้อมูล Agri-Map), other';
COMMENT ON COLUMN agrimap.area_risk_observation.value_numeric IS
  'ค่าตัวเลข เช่น ระดับน้ำเป็นเมตร หรือปริมาณฝนคาดการณ์เป็นมิลลิเมตร (ไม่บังคับ)';
COMMENT ON COLUMN agrimap.area_risk_observation.value_label IS
  'ค่าป้ายกำกับเชิงคุณภาพ เช่น "สูงกว่าตลิ่ง 20 ซม." (ไม่บังคับ)';
COMMENT ON COLUMN agrimap.area_risk_observation.headline_th IS
  'ข้อความแจ้งเตือนสั้นที่แสดงให้เกษตรกรเห็นโดยตรง เช่น "เฝ้าระวังน้ำท่วมฉับพลัน ลุ่มน้ำมูลตอนล่าง" -- บังคับกรอกเสมอ';
COMMENT ON COLUMN agrimap.area_risk_observation.valid_until IS
  'วันที่คำเตือนสิ้นสุดผล -- NULL หมายถึงยังมีผลต่อเนื่อง (Platform Ops ปิดคำเตือนได้โดยตั้งค่านี้ย้อนหลัง แทนการลบแถว เพื่อรักษาประวัติ)';

-- ============================================================================
-- Follow-up (not built in this pass):
--   1. No real Agri-Map/กรมชลประทาน feed -- every row is Platform Ops
--      manual entry via POST /admin/agrimap-observations, reading published
--      LDD/กรมชลประทาน bulletins. Becomes a real integration once a formal
--      data-sharing agreement and API spec exist (see this file's header
--      note on Agri-Map's own launch timeline).
--   2. No self-service entry by an LDD/กรมชลประทาน officer account -- the
--      registry.department row is reserved for that; wiring it up follows
--      grant_oae_data_portal.sql's exact pattern (assert_active_X_officer
--      + an officer-scoped route) when a real account is ever provisioned.
--   3. No cooperative/government-portal read view yet -- this pass covers
--      the farmer-facing read (GET /farmer/agrimap/alerts) and the Platform
--      Ops admin panel only. A cooperative-facing view (province-wide, for
--      a coop's own service area) is straightforward future work following
--      GET /coop/oae/datasets' own precedent.
--   4. No plot-level (registry.production_unit) drill-down -- see this
--      file's header note on the area-vs-plot design decision.
--   5. No push notification/SMS -- a farmer only sees an alert by opening
--      their own dashboard; there is no proactive outbound channel in this
--      platform today (same limitation every other feature here has).
-- ============================================================================
