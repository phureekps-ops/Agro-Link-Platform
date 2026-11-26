-- AgroLink -- เชื่อมโควตานำเข้าสินค้านมกับระบบบริหารโคนมแห่งชาติ
--
-- ใช้โควตานำเข้า (WTO / TAFTA / TNZCEP / AFTA) เป็นปัจจัยหนึ่งในทางเลือกแก้ปัญหานมล้น:
--   1) ภาครัฐ (/dairy-gov/import-quota): เทียบปริมาณนำเข้าแต่ละงวดเป็น "น้ำนมดิบเทียบเท่า" กับนมเกินที่ระบบตรวจพบ
--      แล้วคำนวณทางเลือกเชิงนโยบาย — ให้ผู้ถือโควตารับซื้อนมดิบส่วนเกินตามสัดส่วนโควตา (กลุ่มนิติบุคคล 1/2),
--      ชะลอการนำเข้างวดที่ยังไม่เปิด (ต้องตัดสินใจก่อนวันเปิดงวด), แปรรูปนมส่วนเกินเป็นนมผงทดแทนการนำเข้า
--   2) สหกรณ์ (ระบบแนะนำนมเกิน): ระหว่างมีมาตรการรับซื้อนมส่วนเกิน ผู้ถือโควตาที่เป็นโรงงานในระบบและยังรับไม่ครบ
--      ส่วนของตน จะเป็นทางเลือก "ผู้ถือโควตานำเข้า (ตามมาตรการ)" — อนุมัติแล้วส่งข้อเสนอให้โรงงานตอบรับ
--
-- ระบบแนะนำเท่านั้น — การจัดสรร/ชะลอโควตาเป็นอำนาจของคณะกรรมการโคนมและผลิตภัณฑ์นม ผู้ดูแลระบบบันทึกตามมติ
-- ค่าแปลงเป็นน้ำนมดิบเทียบเท่าเป็นค่าตั้งต้นเพื่อการวางแผน ปรับได้ในหน้าผู้ดูแล
--
-- Idempotent: รันซ้ำได้ ไม่ลบข้อมูลเดิม. ต้องรันหลัง grant_dairy_cooperative.sql และ grant_dairy_surplus_cases.sql
-- ============================================================================
SET client_min_messages = warning;

-- ชนิดสินค้านมนำเข้า + ค่าแปลงเป็นน้ำนมดิบ (กก. น้ำนมดิบต่อ กก. สินค้า)
CREATE TABLE IF NOT EXISTS dairy.import_product (
  product_code       text PRIMARY KEY,
  name_th            text NOT NULL,
  raw_milk_factor    numeric(6,2) NOT NULL CHECK (raw_milk_factor > 0),
  factor_note        text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO dairy.import_product (product_code, name_th, raw_milk_factor, factor_note) VALUES
  ('smp', 'นมผงขาดมันเนย', 11.00, 'ค่าตั้งต้น: น้ำนมดิบ ~11 กก. ต่อนมผงขาดมันเนย 1 กก. (ขึ้นกับของแข็งไม่รวมมันเนย) — ปรับได้'),
  ('milk_cream', 'นมและครีม', 1.00, 'ค่าตั้งต้น: เทียบน้ำนมดิบ 1:1 — ปรับได้'),
  ('flavored_milk', 'เครื่องดื่มประเภทนมปรุงแต่ง', 0.80, 'ค่าตั้งต้น: มีส่วนผสมนม ~80% — ปรับได้')
ON CONFLICT (product_code) DO NOTHING;

-- โควตา/ปริมาณนำเข้ารายงวดตามมติคณะกรรมการ (ระดับประเทศ)
CREATE TABLE IF NOT EXISTS dairy.import_quota_tranche (
  tranche_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  quota_year    smallint NOT NULL CHECK (quota_year BETWEEN 2560 AND 2700),  -- พ.ศ.
  agreement     text NOT NULL CHECK (agreement IN ('WTO', 'TAFTA', 'TNZCEP', 'TAFTA_TNZCEP', 'AFTA', 'ALL')),
  product_code  text NOT NULL REFERENCES dairy.import_product(product_code),
  entity_group  smallint CHECK (entity_group IN (1, 2)),                    -- NULL = ไม่แยกกลุ่ม
  tranche_no    smallint NOT NULL DEFAULT 1 CHECK (tranche_no BETWEEN 1 AND 4),
  quantity_t    numeric(12,2) NOT NULL CHECK (quantity_t >= 0),
  opens_on      date NOT NULL,                                               -- วันที่ลงระบบอิเล็กทรอนิกส์ของกรมการค้าต่างประเทศ
  status        text NOT NULL DEFAULT 'Planned' CHECK (status IN ('Planned', 'Open', 'DeferProposed', 'Deferred', 'Closed')),
  deferred_t    numeric(12,2) NOT NULL DEFAULT 0 CHECK (deferred_t >= 0),
  imported_t    numeric(12,2) CHECK (imported_t >= 0),                       -- ปริมาณที่นำเข้าจริง (ถ้ามีรายงาน)
  source_ref    text,
  note          text,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (deferred_t <= quantity_t)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_import_tranche
  ON dairy.import_quota_tranche (quota_year, agreement, product_code, COALESCE(entity_group, 0), tranche_no);

-- ผู้ได้รับจัดสรรโควตารายนิติบุคคล (ผู้ดูแลบันทึกตามประกาศ) — ผูกกับโรงงานในระบบได้ถ้ามี
CREATE TABLE IF NOT EXISTS dairy.import_quota_holder (
  holder_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  quota_year         smallint NOT NULL,
  holder_name        text NOT NULL CHECK (length(holder_name) BETWEEN 2 AND 200),
  org_id             uuid REFERENCES dairy.processor_profile(org_id),
  entity_group       smallint NOT NULL CHECK (entity_group IN (1, 2)),
  product_code       text NOT NULL DEFAULT 'smp' REFERENCES dairy.import_product(product_code),
  quantity_t         numeric(12,2) NOT NULL CHECK (quantity_t > 0),
  mou_raw_milk_kg_day numeric(12,2) CHECK (mou_raw_milk_kg_day >= 0),         -- ปริมาณรับซื้อน้ำนมดิบตาม MOU
  active             boolean NOT NULL DEFAULT true,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_quota_holder ON dairy.import_quota_holder (quota_year, product_code, lower(holder_name));
CREATE INDEX IF NOT EXISTS idx_dairy_quota_holder_org ON dairy.import_quota_holder (org_id) WHERE org_id IS NOT NULL;

-- มาตรการเร่งด่วนรับซื้อน้ำนมดิบส่วนเกิน แบ่งภาระตามกลุ่มนิติบุคคลผู้ถือโควตา
CREATE TABLE IF NOT EXISTS dairy.absorption_measure (
  measure_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  title          text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  quota_year     smallint NOT NULL,
  product_code   text NOT NULL DEFAULT 'smp' REFERENCES dairy.import_product(product_code),
  total_kg_day   numeric(12,2) NOT NULL CHECK (total_kg_day > 0),
  start_date     date NOT NULL,
  days           smallint NOT NULL CHECK (days BETWEEN 1 AND 365),
  group1_pct     numeric(5,2) NOT NULL DEFAULT 80 CHECK (group1_pct BETWEEN 0 AND 100),
  status         text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Active', 'Closed')),
  source_ref     text,
  note           text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ระบบแนะนำนมเกินของสหกรณ์: เพิ่มทางเลือก "ผู้ถือโควตานำเข้า (ตามมาตรการ)"
ALTER TABLE dairy.surplus_option DROP CONSTRAINT IF EXISTS surplus_option_kind_check;
ALTER TABLE dairy.surplus_option ADD CONSTRAINT surplus_option_kind_check CHECK (kind IN (
  'buyer_extra', 'transfer_center', 'processor_match', 'directory_buyer', 'own_plant', 'herd_plan', 'gov_help', 'quota_holder'));
ALTER TABLE dairy.surplus_option ADD COLUMN IF NOT EXISTS measure_id uuid REFERENCES dairy.absorption_measure(measure_id);

-- ข้อมูลตั้งต้น ปี 2570 ตามมติคณะกรรมการโคนมและผลิตภัณฑ์นม ครั้งที่ 7/2569 (ตามที่สื่อรายงาน — ตรวจกับประกาศทางการก่อนใช้)
INSERT INTO dairy.import_quota_tranche (quota_year, agreement, product_code, entity_group, tranche_no, quantity_t, opens_on, source_ref) VALUES
  (2570, 'WTO',          'smp',           1,    1, 25391.00, '2027-01-01', 'มติคณะกรรมการโคนมฯ ครั้งที่ 7/2569'),
  (2570, 'WTO',          'smp',           2,    1,  9607.00, '2027-01-01', 'มติคณะกรรมการโคนมฯ ครั้งที่ 7/2569'),
  (2570, 'TAFTA_TNZCEP', 'smp',           NULL, 1, 45189.13, '2027-01-01', 'มติคณะกรรมการโคนมฯ ครั้งที่ 7/2569 (ครั้งที่ 1 สัดส่วน 70%)'),
  (2570, 'TAFTA_TNZCEP', 'smp',           NULL, 2, 19366.27, '2027-06-01', 'มติคณะกรรมการโคนมฯ ครั้งที่ 7/2569 (ครั้งที่ 2 สัดส่วน 30%)'),
  (2570, 'ALL',          'milk_cream',    NULL, 1, 17202.20, '2027-01-01', 'มติคณะกรรมการโคนมฯ ครั้งที่ 7/2569'),
  (2570, 'ALL',          'flavored_milk', NULL, 1,  9642.97, '2027-01-01', 'มติคณะกรรมการโคนมฯ ครั้งที่ 7/2569')
ON CONFLICT DO NOTHING;

COMMENT ON TABLE dairy.import_quota_tranche IS 'โควตา/ปริมาณนำเข้าสินค้านมรายงวด (ระดับประเทศ) — ใช้เทียบกับนมเกินในประเทศเป็นทางเลือกเชิงนโยบาย';
COMMENT ON TABLE dairy.absorption_measure IS 'มาตรการรับซื้อน้ำนมดิบส่วนเกิน แบ่งภาระตามกลุ่มนิติบุคคลและสัดส่วนโควตาของผู้ถือโควตา';

GRANT SELECT, INSERT, UPDATE ON dairy.import_product, dairy.import_quota_tranche, dairy.import_quota_holder, dairy.absorption_measure TO agrolink_app;
GRANT DELETE ON dairy.import_quota_holder TO agrolink_app;
