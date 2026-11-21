-- grant_fertilizer_ldd.sql — ปุ๋ยสั่งตัด × ข้อมูลดินกรมพัฒนาที่ดิน (กพด.)
--
-- 1) production.soil_test: แหล่งข้อมูลใหม่ 3 แบบ + รายละเอียดแหล่งที่มา
--      ldd_lab     = เกษตรกรกรอกจากใบรายงานผลวิเคราะห์ของห้องแล็บ กพด. (e-Service osd101)
--      ldd_testkit = กรอกจาก LDD Test Kit / บัตรดินดี
--      ldd_nearby  = ค่าดินจากผลวิเคราะห์สาธารณะของ กพด. จุดที่ใกล้แปลงที่สุด (ประมาณการ)
--    ('ldd_baseline' เดิมยังใช้ได้)
-- 2) production.ldd_soil_sample / ldd_soil_sync: สำเนาผลวิเคราะห์ดินสาธารณะของ กพด.
--    (ชุดข้อมูล osd01 "การตรวจวิเคราะห์ดิน" https://osd101.ldd.go.th/api/data.php)
--    แยกตามจังหวัด ดึงใหม่เมื่อเก่ากว่า 7 วัน — ดู backend/src/lib/lddSoil.js
--
-- Idempotent: รันซ้ำได้. ต้องรันหลัง grant_fertilizer_formula.sql
-- ============================================================================

ALTER TABLE production.soil_test DROP CONSTRAINT IF EXISTS soil_test_source_check;
ALTER TABLE production.soil_test ADD CONSTRAINT soil_test_source_check
  CHECK (source IN ('manual', 'ldd_baseline', 'ldd_lab', 'ldd_testkit', 'ldd_nearby'));
ALTER TABLE production.soil_test ADD COLUMN IF NOT EXISTS source_detail jsonb;

COMMENT ON COLUMN production.soil_test.source_detail IS
  'ที่มาของค่าดิน เช่น ldd_lab: {report_no, lab, sampled_on}; ldd_nearby: {sample_key, distance_km, sampled_on, province, amphur, district}';

CREATE TABLE IF NOT EXISTS production.ldd_soil_sample (
  sample_key  text PRIMARY KEY,
  province    text NOT NULL,
  amphur      text,
  district    text,
  village     text,
  latitude    numeric(9,6) NOT NULL,
  longitude   numeric(9,6) NOT NULL,
  sampled_on  date,
  ph          numeric(5,2),
  om_pct      numeric(7,3),
  n_pct       numeric(7,4),
  p_ppm       numeric(10,2),
  k_ppm       numeric(10,2),
  extra       jsonb,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ldd_soil_sample_prov ON production.ldd_soil_sample (province);
CREATE INDEX IF NOT EXISTS idx_ldd_soil_sample_ll ON production.ldd_soil_sample (latitude, longitude);

CREATE TABLE IF NOT EXISTS production.ldd_soil_sync (
  province       text PRIMARY KEY,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL CHECK (status IN ('ok', 'error')),
  rows_received  integer,
  rows_used      integer,
  samples        integer,
  unmapped       jsonb,
  error          text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON production.ldd_soil_sample, production.ldd_soil_sync TO agrolink_app;

COMMENT ON TABLE production.ldd_soil_sample IS 'สำเนาผลวิเคราะห์ดินสาธารณะของกรมพัฒนาที่ดิน (ชุดข้อมูล osd01) จัดกลุ่มเป็นจุดเก็บตัวอย่าง ใช้เติมค่าดินให้แปลงที่ยังไม่มีผลตรวจของตนเอง — แสดงที่มาและระยะห่างทุกครั้ง';
