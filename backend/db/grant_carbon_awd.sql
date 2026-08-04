-- grant_carbon_awd.sql
--
-- ระบบยืนยันการปลูกข้าวแบบคาร์บอนต่ำ (Low-Carbon Rice Cultivation Verification)
-- — เกษตรกรบันทึกรอบ "เปียกสลับแห้ง" (Alternate Wetting and Drying, AWD) ของ
-- แปลงนาระหว่างฤดูปลูก แล้ว Platform Ops ตรวจสอบ/รับรองข้อมูลก่อนระบบ
-- "ประเมิน" ปริมาณคาร์บอนเครดิตที่แปลงนั้นน่าจะเข้าเกณฑ์ได้รับในรอบปลูกนั้น.
--
-- **สำคัญ — ขอบเขตของฟีเจอร์นี้**: นี่คือเครื่องมือ MRV (Measurement,
-- Reporting, Verification) + เครื่องมือ "ประเมิน" เครดิตภายในแพลตฟอร์ม
-- เท่านั้น ไม่ใช่การขึ้นทะเบียนคาร์บอนเครดิตจริงกับหน่วยงานใด — การจะได้
-- เครดิตที่ซื้อขายได้จริงต้องยื่นเรื่องแยกต่างหากกับผู้รับรอง (เช่น อบก./
-- TGO ภายใต้โครงการ T-VER, หรือผู้รับรองมาตรฐานสากลอื่น) ซึ่งมีขั้นตอน
-- baseline/project boundary/leakage/third-party validation ที่ซับซ้อนกว่า
-- สิ่งที่ตารางชุดนี้คำนวณมาก แนวคิดการคำนวณด้านล่าง (จำนวนรอบแห้งขั้นต่ำ,
-- ระดับน้ำขั้นต่ำที่ต้องลดลง, emission factor ต่อไร่) ได้รับแรงบันดาลใจจาก
-- แนวทาง AWD ของ T-VER แต่ "ค่าคงที่" ทุกตัวเป็นค่าตั้งต้นโดยประมาณ
-- (placeholder) ที่ผู้ดูแลระบบ (Platform Ops) ต้องปรับให้ตรงกับตัวเลขจริง
-- ที่ อบก. ประกาศ ก่อนใช้ผลลัพธ์นี้ไปอ้างอิงเชิงพาณิชย์หรือยื่นขอเครดิตจริง
-- — เช่นเดียวกับคำเตือนเรื่อง typical_offset_days ใน
-- grant_stage_calendar_farmer.sql และ crop_nutrient_requirement ใน
-- grant_fertilizer_formula.sql.
--
-- **ทำไมภาพถ่ายดาวเทียมไม่ได้อยู่ในตารางบันทึกหลัก**: ผู้ใช้เลือกให้ภาพถ่าย
-- ดาวเทียมเป็น "ข้อมูลยืนยันเสริม" ไม่ใช่แหล่งข้อมูลหลัก และยังไม่มีบัญชี/
-- API ของผู้ให้บริการภาพถ่ายดาวเทียม (Sentinel Hub / Google Earth Engine /
-- GISTDA ฯลฯ) จึงแยกเป็นตาราง carbon.satellite_observation ต่างหาก ที่
-- Platform Ops ป้อนข้อมูลเข้าเองได้ (manual) วันนี้ และเสียบ integration
-- อัตโนมัติเข้ามาแทนที่ทีหลังได้โดยไม่ต้องแก้ schema (ดู source_provider).
--
-- **ทำไมจึงจำกัดเฉพาะพืชรหัส RICE_%**: AWD เป็นเทคนิคเฉพาะนาข้าวเท่านั้น
-- (ควบคุมระดับน้ำในแปลงที่มีการทำนาแบบขังน้ำ) ไม่ใช้กับพืชไร่อื่น จึงกรอง
-- ด้วย commodity_code LIKE 'RICE_%' ในระดับ query แทนการเพิ่มคอลัมน์ใหม่ —
-- ครอบคลุม RICE_JASMINE/RICE_PADDY ที่มีอยู่แล้ว และพันธุ์ข้าวใหม่ในอนาคต
-- โดยอัตโนมัติหากตั้งชื่อรหัสด้วย prefix เดียวกัน.

CREATE SCHEMA IF NOT EXISTS carbon;
GRANT USAGE ON SCHEMA carbon TO agrolink_app;

-- ---------------------------------------------------------------------
-- 1. carbon.awd_config — ค่าคงที่ของวิธีคำนวณ (เวอร์ชันได้ — ปรับค่าได้โดย
--    Platform Ops ผ่าน POST /admin/carbon/config โดยไม่แก้ไขแถวเดิม
--    (เพิ่มแถวใหม่ + ปิด is_active ของแถวเก่า) เพื่อให้ carbon.
--    awd_cycle_assessment ที่คำนวณไปแล้วยังอ้างอิงค่าที่ใช้ ณ ตอนคำนวณได้
--    ถูกต้องตามประวัติ (snapshot pattern เดียวกับราคาที่ snapshot ลงบน
--    order/booking ทุกตัวในโปรเจกต์นี้) แม้ค่าปัจจุบันจะถูกปรับเปลี่ยนไปแล้ว.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carbon.awd_config (
  config_id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  methodology_ref              text NOT NULL DEFAULT 'T-VER_AWD_RICE_v1_estimate',
  -- ตันคาร์บอนไดออกไซด์เทียบเท่าที่ประเมินว่าจะได้ต่อไร่ ต่อ 1 รอบปลูกที่
  -- ผ่านเกณฑ์ AWD (ค่าตั้งต้นเป็นค่าประมาณการหยาบ — ดูคำเตือนด้านบนไฟล์)
  emission_factor_tco2e_per_rai numeric(10,4) NOT NULL DEFAULT 0.0800,
  -- ต้องมี "รอบแห้ง" ที่ผ่านเกณฑ์อย่างน้อยกี่รอบต่อฤดูปลูก จึงจะถือว่า
  -- แปลงนี้เข้าเกณฑ์ AWD ของรอบปลูกนั้น (ทั้งหมดหรือไม่ได้เลย ไม่มีเครดิต
  -- บางส่วน — เพื่อความง่ายและตรงไปตรงมาของโมเดลประเมินนี้)
  min_dry_events_required      integer NOT NULL DEFAULT 3,
  -- หนึ่ง "รอบแห้ง" ที่นับได้ ต้องมีช่วงแห้งต่อเนื่องอย่างน้อยกี่วัน
  min_dry_period_days          integer NOT NULL DEFAULT 7,
  -- ระดับน้ำต้องลดลงต่ำกว่าผิวดินอย่างน้อยกี่เซนติเมตร (อ่านจากท่อวัด
  -- ระดับน้ำแบบเจาะรู) จึงจะนับว่าเป็น "แห้งแบบปลอดภัย" ตามแนวทาง AWD ไม่ใช่
  -- แค่ไม่มีน้ำขังผิวดินเฉยๆ
  min_water_level_drop_cm      numeric(6,2) NOT NULL DEFAULT 15.00,
  is_active                    boolean NOT NULL DEFAULT true,
  effective_from               date NOT NULL DEFAULT CURRENT_DATE,
  note                         text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awd_config_emission_factor_check CHECK (emission_factor_tco2e_per_rai >= 0),
  CONSTRAINT awd_config_min_dry_events_check CHECK (min_dry_events_required > 0),
  CONSTRAINT awd_config_min_dry_period_check CHECK (min_dry_period_days > 0),
  CONSTRAINT awd_config_min_water_level_check CHECK (min_water_level_drop_cm >= 0)
);

-- อนุญาตให้มี config ที่ is_active = true ได้ครั้งละ 1 แถวเท่านั้น (ตัวที่
-- ระบบใช้คำนวณ assessment ใหม่ทุกครั้ง) — unique partial index แทน CHECK
-- เพราะ CHECK ข้ามแถวไม่ได้ใน Postgres
CREATE UNIQUE INDEX IF NOT EXISTS idx_awd_config_one_active
  ON carbon.awd_config ((is_active)) WHERE is_active = true;

COMMENT ON TABLE carbon.awd_config IS 'ค่าคงที่ของวิธีคำนวณคาร์บอนเครดิตประมาณการจากการทำนาแบบเปียกสลับแห้ง (AWD) — ปรับได้โดย Platform Ops, เวอร์ชันละแถว (ไม่ UPDATE ทับของเดิม) เพื่อให้ carbon.awd_cycle_assessment ที่คำนวณไปแล้วอ้างอิงค่า ณ ตอนคำนวณได้ถูกต้องตามประวัติ ค่าตั้งต้นทุกตัวเป็นค่าประมาณการหยาบ ต้องตรวจสอบกับแนวทาง T-VER ของ อบก. ฉบับจริงก่อนใช้เชิงพาณิชย์';

-- Seed ค่าเริ่มต้น 1 แถว ให้ระบบมีค่าใช้งานได้ทันที (ถ้ายังไม่มี active
-- config เลย) — idempotent: ใส่เฉพาะตอนที่ตารางยังว่างอยู่เท่านั้น
INSERT INTO carbon.awd_config (methodology_ref, note)
SELECT 'T-VER_AWD_RICE_v1_estimate',
       'ค่าตั้งต้นอัตโนมัติ — เป็นค่าประมาณการหยาบ Platform Ops ควรปรับให้ตรงกับตัวเลขที่ อบก. ประกาศจริงก่อนใช้งานเชิงพาณิชย์'
WHERE NOT EXISTS (SELECT 1 FROM carbon.awd_config);

-- ---------------------------------------------------------------------
-- 2. carbon.awd_water_log — บันทึกระดับน้ำที่เกษตรกรรายงานเอง (แหล่งข้อมูล
--    หลัก) ต่อ 1 รอบปลูก (production.crop_cycle) หนึ่งแถวต่อการรายงานหนึ่ง
--    ครั้ง — append-only (ไม่มี UPDATE/DELETE ให้แก้ไขข้อมูลย้อนหลัง เพื่อ
--    ความน่าเชื่อถือของ MRV log เหมือนหลักการ risk.credit_score).
--    photo_url เป็นเพียงลิงก์อ้างอิงไปยังรูปภาพ (ยังไม่มีระบบอัปโหลด/จัด
--    เก็บไฟล์จริงในโปรเจกต์นี้ — เกษตรกรต้องอัปโหลดรูปไปที่อื่นแล้ววางลิงก์
--    เอง เหมือน partner.vendor_document.document_ref).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carbon.awd_water_log (
  log_id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_id       uuid NOT NULL REFERENCES production.crop_cycle(cycle_id) ON DELETE CASCADE,
  unit_id        uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  -- denormalized จาก production_unit.owner_farmer_id ตอนบันทึก — เพื่อให้
  -- ทุก query ฝั่งเกษตรกร WHERE farmer_id = $1 ได้ตรงๆ โดยไม่ต้อง JOIN
  -- (แบบเดียวกับ marketplace.fertilizer_mixing_order)
  farmer_id      uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  water_status   text NOT NULL,
  water_level_cm numeric(6,2),
  photo_url      text,
  note           text,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awd_water_log_status_check CHECK (water_status IN ('flooded', 'dry'))
);

CREATE INDEX IF NOT EXISTS idx_awd_water_log_cycle ON carbon.awd_water_log (cycle_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_awd_water_log_farmer ON carbon.awd_water_log (farmer_id);

-- ไม่มี GRANT UPDATE/DELETE โดยเจตนา — ดูคอมเมนต์ "append-only" ด้านบน
GRANT SELECT, INSERT ON carbon.awd_water_log TO agrolink_app;

COMMENT ON TABLE carbon.awd_water_log IS 'บันทึกระดับน้ำ (ท่วม/แห้ง) ที่เกษตรกรรายงานเองต่อรอบปลูกข้าว — แหล่งข้อมูลหลักสำหรับประเมิน AWD append-only ไม่มีการแก้ไข/ลบย้อนหลัง ดู src/routes/carbon.js';

-- ---------------------------------------------------------------------
-- 3. carbon.satellite_observation — ข้อมูลยืนยันเสริมจากภาพถ่ายดาวเทียม/
--    remote sensing ต่อแปลง (registry.production_unit) ไม่ผูกกับรอบปลูก
--    โดยตรง (ผูกแบบ best-effort ผ่าน cycle_id ซึ่งเป็นได้ NULL) เนื่องจาก
--    ภาพดาวเทียมอ้างอิงตามวันที่ถ่ายภาพ ไม่ใช่ตามรอบปลูก การจับคู่ว่าภาพ
--    วันไหนตรงกับรอบปลูกไหนทำที่ชั้น query (WHERE observation_date BETWEEN
--    cycle.planned_start_date AND ...).
--    source_provider = 'manual' คือ Platform Ops ป้อนเองวันนี้ (ยังไม่มี
--    บัญชี/API ผู้ให้บริการภาพถ่ายดาวเทียมจริง) ค่าอื่น (sentinel1_sar,
--    sentinel2_optical, gistda, other) เตรียมไว้สำหรับต่อ integration
--    อัตโนมัติในอนาคตโดยไม่ต้องแก้ schema.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carbon.satellite_observation (
  obs_id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id               uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  cycle_id              uuid REFERENCES production.crop_cycle(cycle_id) ON DELETE SET NULL,
  observation_date      date NOT NULL,
  source_provider       text NOT NULL DEFAULT 'manual',
  inferred_water_status text NOT NULL,
  image_ref             text,
  note                  text,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT satellite_observation_source_check
    CHECK (source_provider IN ('manual', 'sentinel1_sar', 'sentinel2_optical', 'gistda', 'other')),
  CONSTRAINT satellite_observation_status_check
    CHECK (inferred_water_status IN ('flooded', 'dry', 'uncertain')),
  CONSTRAINT uq_satellite_observation UNIQUE (unit_id, observation_date, source_provider)
);

CREATE INDEX IF NOT EXISTS idx_satellite_observation_unit ON carbon.satellite_observation (unit_id, observation_date);

GRANT SELECT, INSERT, UPDATE ON carbon.satellite_observation TO agrolink_app;

COMMENT ON TABLE carbon.satellite_observation IS 'ข้อมูลยืนยันเสริมจากภาพถ่ายดาวเทียม/remote sensing ต่อแปลง (ข้อมูลรอง ไม่ใช่แหล่งข้อมูลหลัก) — วันนี้ป้อนด้วยมือโดย Platform Ops (source_provider=''manual'') เนื่องจากยังไม่มีบัญชี/API ผู้ให้บริการภาพถ่ายดาวเทียมจริง ดู POST /admin/carbon/satellite-observations ใน src/routes/admin.js';

-- ---------------------------------------------------------------------
-- 4. carbon.awd_cycle_assessment — "สำนวนประเมินเครดิต" หนึ่งแถวต่อหนึ่ง
--    รอบปลูก (UNIQUE(cycle_id)) คำนวณใหม่ทุกครั้งที่มีการบันทึกระดับน้ำ
--    เพิ่ม (ตราบใดที่ยังไม่ถูกส่งตรวจ/ยืนยัน) แล้วอัปเดตทับแถวเดิม —
--    เหมือน identity.organization_role ไม่ใช่แบบ immutable-log อย่าง
--    risk.credit_score เพราะนี่คือ "ร่าง" ที่พร้อมคำนวณซ้ำได้เรื่อยๆ
--    จนกว่าจะถูกส่งตรวจ (pending_review) และ Platform Ops ตัดสิน.
--
--    สถานะ: draft (ร่าง แก้ไขได้) -> pending_review (ส่งตรวจแล้ว ล็อกการ
--    แก้ไข) -> verified (Platform Ops รับรองแล้ว, ล็อกถาวร) หรือ rejected
--    (ถูกตีกลับ พร้อมเหตุผลใน review_note — เกษตรกรแก้ไข/เพิ่มข้อมูลแล้ว
--    ส่งใหม่ได้ เหมือน draft).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS carbon.awd_cycle_assessment (
  assessment_id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  cycle_id                      uuid NOT NULL UNIQUE REFERENCES production.crop_cycle(cycle_id) ON DELETE CASCADE,
  unit_id                       uuid NOT NULL REFERENCES registry.production_unit(unit_id) ON DELETE CASCADE,
  farmer_id                     uuid NOT NULL REFERENCES identity.farmer(farmer_id) ON DELETE CASCADE,
  -- snapshot จาก production_unit.area_rai ตอนคำนวณล่าสุด (เนื้อที่แปลง
  -- แก้ไขได้ในอนาคต แต่ assessment ที่คำนวณไปแล้วต้องอ้างอิงเนื้อที่ ณ
  -- ตอนคำนวณ ไม่ใช่ค่าปัจจุบันที่อาจเปลี่ยนไปแล้ว)
  area_rai                      numeric(10,2) NOT NULL,
  -- snapshot ค่าคงที่จาก carbon.awd_config ที่ใช้คำนวณครั้งนี้
  config_id                     uuid NOT NULL REFERENCES carbon.awd_config(config_id),
  methodology_ref                text NOT NULL,
  emission_factor_tco2e_per_rai numeric(10,4) NOT NULL,
  min_dry_events_required       integer NOT NULL,
  qualifying_dry_events         integer NOT NULL DEFAULT 0,
  total_dry_days                integer NOT NULL DEFAULT 0,
  is_eligible                   boolean NOT NULL DEFAULT false,
  estimated_credit_tco2e        numeric(12,4) NOT NULL DEFAULT 0,
  status                        text NOT NULL DEFAULT 'draft',
  submitted_at                  timestamptz,
  -- ข้อความอิสระ ไม่ใช่ FK — สอดคล้องกับแบบแผน production.stage_calendar.
  -- verified_by ('self_reported:<farmer_id>' ฯลฯ) เนื่องจากโปรเจกต์นี้ไม่มี
  -- ตารางบัญชีผู้ดูแลระบบรายบุคคล (platform subject ไม่มี subjectId จริง —
  -- ดู middleware/auth.js requireAuth) ค่าที่ใช้คือ 'platform_ops' คงที่
  verified_by                   text,
  verified_at                   timestamptz,
  review_note                   text,
  last_calculated_at            timestamptz NOT NULL DEFAULT now(),
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT awd_cycle_assessment_status_check
    CHECK (status IN ('draft', 'pending_review', 'verified', 'rejected')),
  CONSTRAINT awd_cycle_assessment_area_check CHECK (area_rai > 0)
);

CREATE INDEX IF NOT EXISTS idx_awd_cycle_assessment_farmer ON carbon.awd_cycle_assessment (farmer_id);
CREATE INDEX IF NOT EXISTS idx_awd_cycle_assessment_status ON carbon.awd_cycle_assessment (status);

GRANT SELECT, INSERT, UPDATE ON carbon.awd_cycle_assessment TO agrolink_app;
-- config ใช้อ่านเป็นหลัก (ทั้งฝั่งเกษตรกรและ Platform Ops) แต่ Platform Ops
-- ต้อง INSERT ค่าเวอร์ชันใหม่ + UPDATE is_active ของเวอร์ชันเก่าให้เป็น
-- false ได้ (ดู POST /admin/carbon/config)
GRANT SELECT, INSERT, UPDATE ON carbon.awd_config TO agrolink_app;

COMMENT ON TABLE carbon.awd_cycle_assessment IS 'สำนวนประเมินคาร์บอนเครดิตจากการทำนาแบบ AWD หนึ่งแถวต่อหนึ่งรอบปลูก (production.crop_cycle) — คำนวณ/อัปเดตทับใหม่ได้ตราบเท่าที่ยังไม่ถูกส่งตรวจ (pending_review) หรือรับรอง (verified) ดู src/routes/carbon.js (ฝั่งเกษตรกร) และ src/routes/admin.js (ฝั่ง Platform Ops ตรวจสอบ/รับรอง)';

-- ---------------------------------------------------------------------
-- Reminder เดียวกับทุกตารางที่ไม่มี Row Level Security ในโปรเจกต์นี้: ไม่มี
-- RLS บนตาราง carbon.* เหล่านี้เลย — WHERE farmer_id = $1 / WHERE cycle_id
-- ...(join ผ่าน owner_farmer_id) ที่ชัดเจนใน src/routes/carbon.js และ
-- src/routes/admin.js คือขอบเขตความปลอดภัยทั้งหมด ไม่ใช่แค่ defense-in-depth
-- ---------------------------------------------------------------------
