-- AgroLink -- โปรแกรมบริหารธุรกิจโคนมครบวงจร (พอร์ทัลสหกรณ์โคนม).
--
-- ตามเอกสาร "ร่างแนวทางออกแบบพอร์ทัลสหกรณ์โคนมและโปรแกรมบริหารธุรกิจโคนม
-- ครบวงจร" (9 พ.ย. 2569) และรายงานธุรกิจโคนมครบวงจรของประเทศไทย (ข้อเสนอ
-- AgroLink Dairy Intelligence). 12 โมดูล: (1) ทะเบียนสมาชิก ฟาร์ม โครายตัว
-- (2) สืบพันธุ์และสุขภาพ (3) รับน้ำนมที่ศูนย์รวบรวม (4) คุณภาพและราคา
-- (5) อาหารสัตว์และปัจจัยการผลิต (6) บัญชีสมาชิกและหักกลบ (7) สัญญาและส่งนม
-- ให้โรงงาน (8) แปรรูปและสต็อก (9) นมโรงเรียน (10) ตลาดนมส่วนเกิน
-- (11) ไบโอแก๊ส (12) พยากรณ์และ Dashboard นโยบาย.
--
-- ข้อตัดสินใจที่ใช้ออกแบบ (ผู้ใช้ยืนยันในเอกสารแล้ว):
--   * รอบจ่ายเงินสมาชิกทุก 15 วัน (ปรับได้ใน dairy.setting.settlement_days)
--   * ราคา = ราคาฐาน + บวก/หักตามตาราง Fat/SNF/SCC/TBC ที่สหกรณ์กรอกเอง
--   * ใช้ผลตรวจคุณภาพล่าสุด (ณ วันที่รับนม) กับทุกรอบจนกว่าจะมีผลใหม่
--   * โอนเงินผ่าน ธ.ก.ส. (ไฟล์กลาง — รูปแบบจริงต้องยืนยันกับธนาคาร)
--   * หักค่าอาหาร ยา ผสมเทียม สินเชื่อ ค่าหุ้น ตามลำดับที่สหกรณ์กำหนด
--   * ค่าบริการ AgroLink เป็น % ผู้ขายจ่าย ค่าเริ่มต้น 0 สมาชิกไม่ต้องจ่าย
--   * รองรับหลายสหกรณ์ตั้งแต่แรก; โมดูลแปรรูปใช้ได้ทั้งสหกรณ์ที่มี/ไม่มีโรงนม
--   * แจ้งเตือนสมาชิกผ่านเว็บมือถือก่อน (LINE ระยะถัดไป)
--
-- Security convention (เหมือน grant_straw_mushroom.sql): ไม่มี RLS ในสคีมา
-- นี้ ทุก query ใน src/routes/dairy*.js ต้องกรองด้วย coop_org_id / farmer_id
-- / linked_org_id / processor org / device / school token ของผู้เรียกเองเสมอ.
-- หน่วยงานรัฐเห็นตัวเลขรวมรายจังหวัด และเห็นรายสหกรณ์เฉพาะที่สหกรณ์เปิด
-- dairy.setting.gov_data_consent เท่านั้น ราคาสัญญารายบริษัทไม่ถูกส่งให้รัฐ.
--
-- Idempotent: รันซ้ำได้ (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT).
-- ต้องรันหลัง grant_cooperative_tenant_foundation.sql (identity.organization,
-- identity.farmer, registry.cooperative_profile, uuid-ossp).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS dairy;

-- ---------------------------------------------------------------------------
-- 0. ตั้งค่าสหกรณ์ + ประวัติ
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.setting (
  coop_org_id               uuid PRIMARY KEY REFERENCES identity.organization(org_id),
  base_price_per_kg         numeric(10,2) NOT NULL DEFAULT 0 CHECK (base_price_per_kg >= 0),
  settlement_days           smallint NOT NULL DEFAULT 15 CHECK (settlement_days BETWEEN 1 AND 31),
  deduction_order           text[] NOT NULL DEFAULT ARRAY['feed','vet_service','ai_service','loan_repayment','share','adjustment'],
  fee_rate_feed_pct         numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_feed_pct BETWEEN 0 AND 100),
  fee_rate_raw_milk_pct     numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_raw_milk_pct BETWEEN 0 AND 100),
  fee_rate_surplus_pct      numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_surplus_pct BETWEEN 0 AND 100),
  fee_rate_product_pct      numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_product_pct BETWEEN 0 AND 100),
  tank_temp_max             numeric(5,2) NOT NULL DEFAULT 4,
  alert_yellow_pct          numeric(5,2) NOT NULL DEFAULT 1,
  alert_orange_pct          numeric(5,2) NOT NULL DEFAULT 3,
  alert_red_pct             numeric(5,2) NOT NULL DEFAULT 5,
  gestation_days            smallint NOT NULL DEFAULT 283 CHECK (gestation_days BETWEEN 250 AND 310),
  dry_period_days           smallint NOT NULL DEFAULT 60 CHECK (dry_period_days BETWEEN 0 AND 120),
  gov_data_consent          boolean NOT NULL DEFAULT false,
  has_processing_plant      boolean NOT NULL DEFAULT false,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (alert_yellow_pct <= alert_orange_pct AND alert_orange_pct <= alert_red_pct)
);

CREATE TABLE IF NOT EXISTS dairy.setting_history (
  history_id   uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  field_name   text NOT NULL,
  old_value    text,
  new_value    text,
  changed_by   text,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_setting_hist ON dairy.setting_history (coop_org_id, changed_at DESC);

-- ตารางบวก/หักราคาตามคุณภาพ: ค่าที่ตรวจได้อยู่ในช่วง [min_value, max_value)
-- ได้ adjust_per_kg (บาท/กก. บวกหรือลบ). min/max ว่าง = ไม่จำกัดด้านนั้น.
CREATE TABLE IF NOT EXISTS dairy.quality_rule (
  rule_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  param          text NOT NULL CHECK (param IN ('fat', 'snf', 'scc', 'tbc')),
  min_value      numeric(12,3),
  max_value      numeric(12,3),
  adjust_per_kg  numeric(10,2) NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value < max_value)
);
CREATE INDEX IF NOT EXISTS idx_dairy_qrule ON dairy.quality_rule (coop_org_id, param) WHERE active;

-- ---------------------------------------------------------------------------
-- 1. ศูนย์รวบรวม สมาชิก คู่ค้า
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.collection_center (
  center_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  name             text NOT NULL,
  address          text,
  tank_capacity_kg numeric(12,2) NOT NULL DEFAULT 0 CHECK (tank_capacity_kg >= 0),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, name)
);

CREATE TABLE IF NOT EXISTS dairy.member (
  member_id              uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id            uuid NOT NULL REFERENCES identity.organization(org_id),
  farmer_id              uuid REFERENCES identity.farmer(farmer_id),
  member_code            text NOT NULL,
  full_name              text NOT NULL,
  phone                  text,
  address                text,
  farm_name              text,
  farm_registration_no   text,
  gap_certified          boolean NOT NULL DEFAULT false,
  center_id              uuid REFERENCES dairy.collection_center(center_id),
  distance_km            numeric(6,1),
  credit_limit           numeric(12,2) CHECK (credit_limit IS NULL OR credit_limit >= 0),
  share_deduct_per_round numeric(10,2) NOT NULL DEFAULT 0 CHECK (share_deduct_per_round >= 0),
  baac_account_no        text,
  baac_account_name      text,
  status                 text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Suspended')),
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  approved_at            timestamptz,
  UNIQUE (coop_org_id, member_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_member_farmer ON dairy.member (coop_org_id, farmer_id) WHERE farmer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dairy_member_farmer ON dairy.member (farmer_id);

CREATE TABLE IF NOT EXISTS dairy.partner (
  partner_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_type   text NOT NULL CHECK (partner_type IN ('processor', 'feed_supplier', 'vet', 'product_buyer', 'transporter')),
  name           text NOT NULL,
  contact_name   text,
  phone          text,
  address        text,
  linked_org_id  uuid REFERENCES identity.organization(org_id),
  note           text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_partner_coop ON dairy.partner (coop_org_id, partner_type);
CREATE INDEX IF NOT EXISTS idx_dairy_partner_linked ON dairy.partner (linked_org_id);

-- ---------------------------------------------------------------------------
-- 2. ฝูงโครายตัว + เหตุการณ์ (สืบพันธุ์ สุขภาพ ย้ายฝูง)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.animal (
  animal_id              uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id            uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id              uuid NOT NULL REFERENCES dairy.member(member_id),
  ear_tag                text NOT NULL,
  name                   text,
  breed                  text,
  sex                    text NOT NULL DEFAULT 'F' CHECK (sex IN ('F', 'M')),
  birth_date             date,
  dam_ear_tag            text,
  sire_code              text,
  status                 text NOT NULL DEFAULT 'Heifer'
                           CHECK (status IN ('Calf', 'Heifer', 'Milking', 'Dry', 'Bull', 'Sold', 'Dead', 'Culled')),
  lactation_no           smallint NOT NULL DEFAULT 0 CHECK (lactation_no >= 0),
  last_calving_date      date,
  last_insemination_date date,
  pregnant               boolean NOT NULL DEFAULT false,
  expected_calving_date  date,
  dry_off_due_date       date,
  withdrawal_until       date,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, ear_tag)
);
CREATE INDEX IF NOT EXISTS idx_dairy_animal_member ON dairy.animal (member_id, status);

CREATE TABLE IF NOT EXISTS dairy.animal_event (
  event_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id     uuid NOT NULL REFERENCES identity.organization(org_id),
  animal_id       uuid NOT NULL REFERENCES dairy.animal(animal_id),
  event_type      text NOT NULL CHECK (event_type IN ('heat', 'insemination', 'pregnancy_check', 'calving', 'dry_off',
                    'treatment', 'vaccination', 'sold', 'dead', 'culled', 'note')),
  event_date      date NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  vet_partner_id  uuid REFERENCES dairy.partner(partner_id),
  cost            numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  recorded_by     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_event_animal ON dairy.animal_event (animal_id, event_date DESC);

-- ---------------------------------------------------------------------------
-- 3. รับน้ำนมที่ศูนย์รวบรวม (รอบเช้า/เย็น) + 4. คุณภาพ
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.milk_round (
  round_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  center_id    uuid NOT NULL REFERENCES dairy.collection_center(center_id),
  round_date   date NOT NULL,
  shift        text NOT NULL CHECK (shift IN ('AM', 'PM')),
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Closed')),
  tank_temp_c  numeric(5,2),
  accepted_kg  numeric(12,2) NOT NULL DEFAULT 0,
  rejected_kg  numeric(12,2) NOT NULL DEFAULT 0,
  amount       numeric(14,2) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  UNIQUE (center_id, round_date, shift)
);
CREATE INDEX IF NOT EXISTS idx_dairy_round_coop ON dairy.milk_round (coop_org_id, round_date DESC);

CREATE TABLE IF NOT EXISTS dairy.milk_intake (
  intake_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  round_id       uuid NOT NULL REFERENCES dairy.milk_round(round_id),
  member_id      uuid NOT NULL REFERENCES dairy.member(member_id),
  weight_kg      numeric(10,2) NOT NULL CHECK (weight_kg > 0),
  status         text NOT NULL DEFAULT 'Accepted' CHECK (status IN ('Accepted', 'Rejected')),
  reject_reason  text CHECK (reject_reason IS NULL OR reject_reason IN ('antibiotic', 'temperature', 'smell', 'clot', 'other')),
  sample_no      text,
  price_per_kg   numeric(10,2),
  amount         numeric(14,2),
  price_detail   jsonb,
  source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'scale')),
  recorded_by    text,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_dairy_intake_member ON dairy.milk_intake (member_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS dairy.quality_test (
  test_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id      uuid NOT NULL REFERENCES dairy.member(member_id),
  sample_date    date NOT NULL,
  fat_pct        numeric(5,2) CHECK (fat_pct IS NULL OR fat_pct BETWEEN 0 AND 20),
  snf_pct        numeric(5,2) CHECK (snf_pct IS NULL OR snf_pct BETWEEN 0 AND 20),
  protein_pct    numeric(5,2) CHECK (protein_pct IS NULL OR protein_pct BETWEEN 0 AND 20),
  scc_k          numeric(10,1) CHECK (scc_k IS NULL OR scc_k >= 0),
  tbc_k          numeric(10,1) CHECK (tbc_k IS NULL OR tbc_k >= 0),
  antibiotic_pos boolean NOT NULL DEFAULT false,
  lab_name       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_qtest_member ON dairy.quality_test (member_id, sample_date DESC);

-- ---------------------------------------------------------------------------
-- 5. อาหารสัตว์และปัจจัยการผลิต (คลังสหกรณ์ → สมาชิกเบิกแบบเชื่อ)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.supply_item (
  item_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  code           text NOT NULL,
  name           text NOT NULL,
  category       text NOT NULL CHECK (category IN ('concentrate', 'roughage', 'mineral', 'medicine', 'semen', 'other')),
  unit           text NOT NULL DEFAULT 'กก.',
  sell_price     numeric(12,2) NOT NULL DEFAULT 0 CHECK (sell_price >= 0),
  reorder_level  numeric(12,2) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, code)
);

CREATE TABLE IF NOT EXISTS dairy.stock_movement (
  movement_id  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  item_id      uuid NOT NULL REFERENCES dairy.supply_item(item_id),
  direction    text NOT NULL CHECK (direction IN ('in', 'out')),
  qty          numeric(12,2) NOT NULL CHECK (qty > 0),
  unit_cost    numeric(12,2) NOT NULL DEFAULT 0,
  source_type  text NOT NULL CHECK (source_type IN ('purchase', 'member_issue', 'adjust', 'treatment')),
  ref_id       uuid,
  note         text,
  moved_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_stock ON dairy.stock_movement (coop_org_id, item_id);

CREATE TABLE IF NOT EXISTS dairy.purchase_order (
  po_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_id     uuid NOT NULL REFERENCES dairy.partner(partner_id),
  status         text NOT NULL DEFAULT 'Ordered' CHECK (status IN ('Ordered', 'Confirmed', 'Delivered', 'Cancelled')),
  expected_date  date,
  total_amount   numeric(14,2) NOT NULL DEFAULT 0,
  fee_rate_pct   numeric(6,3),
  fee_amount     numeric(14,2),
  note           text,
  ordered_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz,
  delivered_at   timestamptz,
  paid_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dairy_po ON dairy.purchase_order (coop_org_id, ordered_at DESC);

CREATE TABLE IF NOT EXISTS dairy.purchase_order_line (
  line_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  po_id       uuid NOT NULL REFERENCES dairy.purchase_order(po_id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES dairy.supply_item(item_id),
  qty         numeric(12,2) NOT NULL CHECK (qty > 0),
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  amount      numeric(14,2) NOT NULL
);

-- คำขอจากสมาชิก: เบิกอาหาร/ปัจจัย, เรียกสัตวแพทย์, เรียกผสมเทียม
CREATE TABLE IF NOT EXISTS dairy.service_request (
  request_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id         uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id           uuid NOT NULL REFERENCES dairy.member(member_id),
  request_type        text NOT NULL CHECK (request_type IN ('feed', 'vet', 'ai')),
  animal_id           uuid REFERENCES dairy.animal(animal_id),
  item_id             uuid REFERENCES dairy.supply_item(item_id),
  qty                 numeric(12,2) CHECK (qty IS NULL OR qty > 0),
  description         text,
  photo_data_url      text,
  status              text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Assigned', 'Done', 'Cancelled')),
  assigned_partner_id uuid REFERENCES dairy.partner(partner_id),
  result_ref_id       uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  done_at             timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dairy_req ON dairy.service_request (coop_org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS dairy.member_issue (
  issue_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id   uuid NOT NULL REFERENCES dairy.member(member_id),
  item_id     uuid NOT NULL REFERENCES dairy.supply_item(item_id),
  qty         numeric(12,2) NOT NULL CHECK (qty > 0),
  unit_price  numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  amount      numeric(14,2) NOT NULL,
  request_id  uuid REFERENCES dairy.service_request(request_id),
  issued_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_issue ON dairy.member_issue (coop_org_id, issued_at DESC);

-- ---------------------------------------------------------------------------
-- 7. สัญญา (MOU) และการส่งนมดิบให้โรงงาน
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.contract (
  contract_id   uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_id    uuid NOT NULL REFERENCES dairy.partner(partner_id),
  contract_no   text,
  start_date    date NOT NULL,
  end_date      date NOT NULL,
  daily_kg      numeric(12,2) NOT NULL CHECK (daily_kg > 0),
  price_per_kg  numeric(10,2) NOT NULL CHECK (price_per_kg >= 0),
  payment_days  smallint NOT NULL DEFAULT 15 CHECK (payment_days BETWEEN 0 AND 120),
  status        text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Ended', 'Cancelled')),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_dairy_contract ON dairy.contract (coop_org_id, status);

CREATE TABLE IF NOT EXISTS dairy.shipment (
  shipment_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_id           uuid NOT NULL REFERENCES dairy.partner(partner_id),
  contract_id          uuid REFERENCES dairy.contract(contract_id),
  proposal_id          uuid,
  center_id            uuid REFERENCES dairy.collection_center(center_id),
  ship_date            date NOT NULL,
  vehicle              text,
  driver_name          text,
  sent_kg              numeric(12,2) NOT NULL CHECK (sent_kg > 0),
  tank_temp_c          numeric(5,2),
  status               text NOT NULL DEFAULT 'Sent' CHECK (status IN ('Sent', 'Received', 'Rejected', 'Cancelled')),
  received_kg          numeric(12,2),
  fat_pct              numeric(5,2),
  snf_pct              numeric(5,2),
  scc_k                numeric(10,1),
  tbc_k                numeric(10,1),
  price_per_kg         numeric(10,2),
  amount               numeric(14,2),
  reject_reason        text,
  fee_type             text,
  fee_rate_pct         numeric(6,3),
  fee_amount           numeric(14,2),
  sent_at              timestamptz NOT NULL DEFAULT now(),
  received_at          timestamptz,
  paid_at              timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dairy_ship ON dairy.shipment (coop_org_id, ship_date DESC);
CREATE INDEX IF NOT EXISTS idx_dairy_ship_partner ON dairy.shipment (partner_id, status);

-- ---------------------------------------------------------------------------
-- 10. ตลาดนมส่วนเกิน (ข้ามสหกรณ์/โรงงาน)
-- ---------------------------------------------------------------------------
-- โปรไฟล์โรงงานแปรรูป (องค์กรที่ผ่าน KYB แล้วลงทะเบียนเองในพอร์ทัลคู่ค้า)
CREATE TABLE IF NOT EXISTS dairy.processor_profile (
  org_id          uuid PRIMARY KEY REFERENCES identity.organization(org_id),
  display_name    text NOT NULL,
  province_code   text,
  products        text,
  contact_phone   text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- กำลังรับนมว่างที่โรงงานประกาศ
CREATE TABLE IF NOT EXISTS dairy.processor_capacity (
  capacity_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES dairy.processor_profile(org_id),
  available_from  date NOT NULL,
  available_to    date NOT NULL,
  kg_per_day      numeric(12,2) NOT NULL CHECK (kg_per_day > 0),
  price_per_kg    numeric(10,2) NOT NULL CHECK (price_per_kg >= 0),
  note            text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (available_to >= available_from)
);
CREATE INDEX IF NOT EXISTS idx_dairy_capacity ON dairy.processor_capacity (active, available_to);

-- สหกรณ์ประกาศน้ำนมส่วนเกิน
CREATE TABLE IF NOT EXISTS dairy.surplus_offer (
  offer_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  start_date     date NOT NULL,
  days           smallint NOT NULL CHECK (days BETWEEN 1 AND 90),
  kg_per_day     numeric(12,2) NOT NULL CHECK (kg_per_day > 0),
  min_price      numeric(10,2) NOT NULL DEFAULT 0 CHECK (min_price >= 0),
  avg_fat_pct    numeric(5,2),
  avg_snf_pct    numeric(5,2),
  note           text,
  status         text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Matched', 'Closed', 'Cancelled')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_offer ON dairy.surplus_offer (status, start_date);

-- ข้อเสนอจับคู่ระหว่างประกาศส่วนเกินกับโรงงาน (ฝ่ายหนึ่งเสนอ อีกฝ่ายตอบรับ)
CREATE TABLE IF NOT EXISTS dairy.surplus_proposal (
  proposal_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  offer_id          uuid NOT NULL REFERENCES dairy.surplus_offer(offer_id),
  processor_org_id  uuid NOT NULL REFERENCES dairy.processor_profile(org_id),
  capacity_id       uuid REFERENCES dairy.processor_capacity(capacity_id),
  kg_per_day        numeric(12,2) NOT NULL CHECK (kg_per_day > 0),
  price_per_kg      numeric(10,2) NOT NULL CHECK (price_per_kg >= 0),
  proposed_by       text NOT NULL CHECK (proposed_by IN ('coop', 'processor')),
  status            text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Accepted', 'Rejected', 'Withdrawn')),
  partner_id        uuid REFERENCES dairy.partner(partner_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_proposal_pending ON dairy.surplus_proposal (offer_id, processor_org_id) WHERE status = 'Pending';

-- ---------------------------------------------------------------------------
-- 8. แปรรูปและสต็อก (เฉพาะสหกรณ์ที่มีโรงนม)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.product (
  product_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id       uuid NOT NULL REFERENCES identity.organization(org_id),
  name              text NOT NULL,
  product_type      text NOT NULL CHECK (product_type IN ('pasteurized', 'uht', 'yogurt', 'cheese', 'butter', 'powder', 'other')),
  unit              text NOT NULL DEFAULT 'ถุง',
  milk_kg_per_unit  numeric(10,4) NOT NULL CHECK (milk_kg_per_unit > 0),
  shelf_life_days   smallint NOT NULL CHECK (shelf_life_days > 0),
  sell_price        numeric(10,2) NOT NULL DEFAULT 0 CHECK (sell_price >= 0),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, name)
);

CREATE TABLE IF NOT EXISTS dairy.production_batch (
  batch_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  product_id    uuid NOT NULL REFERENCES dairy.product(product_id),
  lot_code      text NOT NULL,
  produced_on   date NOT NULL,
  expires_on    date NOT NULL,
  milk_used_kg  numeric(12,2) NOT NULL CHECK (milk_used_kg > 0),
  units         integer NOT NULL CHECK (units > 0),
  units_left    integer NOT NULL CHECK (units_left >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, lot_code)
);
CREATE INDEX IF NOT EXISTS idx_dairy_pbatch ON dairy.production_batch (coop_org_id, expires_on);

CREATE TABLE IF NOT EXISTS dairy.product_sale (
  sale_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  batch_id      uuid NOT NULL REFERENCES dairy.production_batch(batch_id),
  partner_id    uuid REFERENCES dairy.partner(partner_id),
  school_id     uuid,
  buyer_name    text,
  units         integer NOT NULL CHECK (units > 0),
  unit_price    numeric(10,2) NOT NULL CHECK (unit_price >= 0),
  amount        numeric(14,2) NOT NULL,
  fee_rate_pct  numeric(6,3),
  fee_amount    numeric(14,2),
  sold_on       date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 9. นมโรงเรียน
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.school (
  school_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id     uuid NOT NULL REFERENCES identity.organization(org_id),
  name            text NOT NULL,
  district        text,
  province        text,
  students        integer NOT NULL DEFAULT 0 CHECK (students >= 0),
  contact_name    text,
  phone           text,
  product_id      uuid REFERENCES dairy.product(product_id),
  units_per_student_day numeric(5,2) NOT NULL DEFAULT 1 CHECK (units_per_student_day > 0),
  delivery_weekdays smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[],
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, name)
);

CREATE TABLE IF NOT EXISTS dairy.school_term (
  term_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  school_id    uuid REFERENCES dairy.school(school_id) ON DELETE CASCADE,
  name         text NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  CHECK (end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS idx_dairy_term ON dairy.school_term (coop_org_id, start_date);

CREATE TABLE IF NOT EXISTS dairy.school_delivery (
  delivery_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  school_id        uuid NOT NULL REFERENCES dairy.school(school_id),
  delivery_date    date NOT NULL,
  batch_id         uuid REFERENCES dairy.production_batch(batch_id),
  units            integer NOT NULL CHECK (units > 0),
  status           text NOT NULL DEFAULT 'Planned' CHECK (status IN ('Planned', 'Delivered', 'Confirmed', 'Issue', 'Cancelled')),
  confirm_token    text NOT NULL UNIQUE,
  received_units   integer,
  issue_note       text,
  delivered_at     timestamptz,
  confirmed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, delivery_date)
);

-- ---------------------------------------------------------------------------
-- 11. ไบโอแก๊สและปุ๋ยอินทรีย์
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.biogas_log (
  log_id             uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id        uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id          uuid REFERENCES dairy.member(member_id),
  site_name          text NOT NULL,
  log_date           date NOT NULL,
  manure_kg          numeric(12,2) NOT NULL DEFAULT 0 CHECK (manure_kg >= 0),
  gas_m3             numeric(12,2) NOT NULL DEFAULT 0 CHECK (gas_m3 >= 0),
  electricity_kwh    numeric(12,2) NOT NULL DEFAULT 0 CHECK (electricity_kwh >= 0),
  digestate_kg       numeric(12,2) NOT NULL DEFAULT 0 CHECK (digestate_kg >= 0),
  digestate_sold_kg  numeric(12,2) NOT NULL DEFAULT 0 CHECK (digestate_sold_kg >= 0),
  digestate_revenue  numeric(12,2) NOT NULL DEFAULT 0 CHECK (digestate_revenue >= 0),
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_biogas ON dairy.biogas_log (coop_org_id, log_date DESC);

-- ---------------------------------------------------------------------------
-- 6. บัญชีสมาชิก รอบจ่าย (ทุก 15 วัน) ไฟล์ ธ.ก.ส. และค่าบริการ AgroLink
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.settlement_run (
  run_id         uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  status         text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted', 'Paid', 'Cancelled')),
  total_net      numeric(14,2) NOT NULL DEFAULT 0,
  member_count   integer NOT NULL DEFAULT 0,
  baac_batch_ref text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  submitted_at   timestamptz,
  paid_at        timestamptz,
  CHECK (period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS dairy.member_ledger (
  entry_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id     uuid NOT NULL REFERENCES dairy.member(member_id),
  entry_date    date NOT NULL DEFAULT CURRENT_DATE,
  entry_type    text NOT NULL CHECK (entry_type IN ('milk_sale', 'feed', 'vet_service', 'ai_service', 'loan_repayment', 'share', 'adjustment')),
  amount        numeric(14,2) NOT NULL,
  ref_type      text,
  ref_id        uuid,
  run_id        uuid REFERENCES dairy.settlement_run(run_id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dairy_ledger_member ON dairy.member_ledger (member_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_dairy_ledger_open ON dairy.member_ledger (coop_org_id, run_id);

CREATE TABLE IF NOT EXISTS dairy.settlement_line (
  run_id            uuid NOT NULL REFERENCES dairy.settlement_run(run_id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES dairy.member(member_id),
  total_credit      numeric(14,2) NOT NULL DEFAULT 0,
  total_debit       numeric(14,2) NOT NULL DEFAULT 0,
  net_amount        numeric(14,2) NOT NULL DEFAULT 0,
  carried_debit     numeric(14,2) NOT NULL DEFAULT 0,
  baac_account_no   text,
  baac_account_name text,
  PRIMARY KEY (run_id, member_id)
);

CREATE TABLE IF NOT EXISTS dairy.platform_fee (
  fee_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  fee_type     text NOT NULL CHECK (fee_type IN ('feed_purchase', 'raw_milk_sale', 'surplus_sale', 'product_sale')),
  payer_type   text NOT NULL CHECK (payer_type IN ('partner', 'coop')),
  payer_ref    uuid,
  base_amount  numeric(14,2) NOT NULL,
  rate_pct     numeric(6,3) NOT NULL,
  fee_amount   numeric(14,2) NOT NULL,
  ref_type     text NOT NULL,
  ref_id       uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_id, fee_type)
);
CREATE INDEX IF NOT EXISTS idx_dairy_fee_coop ON dairy.platform_fee (coop_org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 12. IoT (ถังเย็น เครื่องชั่ง/มิเตอร์นม รถขนนม บ่อไบโอแก๊ส โรงเรือน)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dairy.iot_device (
  device_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  name          text NOT NULL,
  device_type   text NOT NULL CHECK (device_type IN ('cooling_tank', 'milk_scale', 'vehicle', 'biogas', 'barn')),
  center_id     uuid REFERENCES dairy.collection_center(center_id),
  member_id     uuid REFERENCES dairy.member(member_id),
  api_key_hash  text NOT NULL,
  temp_min      numeric(5,2),
  temp_max      numeric(5,2),
  active        boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dairy_iot_key ON dairy.iot_device (api_key_hash);

CREATE TABLE IF NOT EXISTS dairy.iot_reading (
  reading_id   bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES dairy.iot_device(device_id) ON DELETE CASCADE,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  temp_c       numeric(5,2),
  level_kg     numeric(12,2),
  gas_m3       numeric(12,3),
  lat          numeric(9,6),
  lng          numeric(9,6)
);
CREATE INDEX IF NOT EXISTS idx_dairy_iot_reading ON dairy.iot_reading (device_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS dairy.iot_alert (
  alert_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  device_id       uuid NOT NULL REFERENCES dairy.iot_device(device_id) ON DELETE CASCADE,
  alert_type      text NOT NULL CHECK (alert_type IN ('temp_low', 'temp_high', 'offline')),
  value           numeric(8,2),
  message         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_dairy_iot_alert ON dairy.iot_alert (device_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- ค่าเริ่มต้นต่อสหกรณ์ (เรียกจาก route ครั้งแรกที่สหกรณ์เข้าโมดูล)
-- ราคาฐาน ราคาขาย และค่าบริการเริ่มที่ 0 — สหกรณ์ต้องตั้งเอง (ไม่เดาตัวเลขแทน)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dairy.ensure_coop_defaults(p_coop_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO dairy.setting (coop_org_id) VALUES (p_coop_org_id) ON CONFLICT DO NOTHING;

    INSERT INTO dairy.collection_center (coop_org_id, name) VALUES (p_coop_org_id, 'ศูนย์รวบรวมน้ำนมหลัก')
    ON CONFLICT (coop_org_id, name) DO NOTHING;

    INSERT INTO dairy.supply_item (coop_org_id, code, name, category, unit) VALUES
      (p_coop_org_id, 'concentrate', 'อาหารข้นโคนม',          'concentrate', 'กก.'),
      (p_coop_org_id, 'silage',      'ข้าวโพดหมัก/หญ้าหมัก',  'roughage',    'กก.'),
      (p_coop_org_id, 'straw',       'ฟางข้าว',               'roughage',    'กก.'),
      (p_coop_org_id, 'mineral',     'แร่ธาตุก้อน',            'mineral',     'ก้อน'),
      (p_coop_org_id, 'semen',       'น้ำเชื้อผสมเทียม',       'semen',       'โดส')
    ON CONFLICT (coop_org_id, code) DO NOTHING;
END;
$$;

COMMENT ON SCHEMA dairy IS 'โปรแกรมบริหารธุรกิจโคนมครบวงจร (พอร์ทัลสหกรณ์โคนม) — ไม่มี RLS ทุก query ต้องกรองด้วย coop_org_id/farmer_id/linked_org_id/processor org/device ของผู้เรียก';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA dairy TO agrolink_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA dairy TO agrolink_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dairy TO agrolink_app;
GRANT EXECUTE ON FUNCTION dairy.ensure_coop_defaults(uuid) TO agrolink_app;
GRANT SELECT ON identity.farmer, identity.organization TO agrolink_app;
GRANT SELECT ON registry.cooperative_profile, registry.province TO agrolink_app;
