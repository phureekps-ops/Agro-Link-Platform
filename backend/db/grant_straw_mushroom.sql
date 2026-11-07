-- AgroLink -- โปรแกรมบริหารจัดการการผลิตเห็ดฟางครบวงจร (Straw Mushroom Hub).
--
-- ตามเอกสาร "แนวทางพัฒนาโปรแกรมบริหารจัดการการผลิตเห็ดฟางครบวงจร" และการผลิต
-- เห็ดฟางแบบใหม่ของ อ.อานนท์ (แบบ 2589): สหกรณ์เป็นศูนย์ผลิตกล่องเพาะ
-- สมาชิกรับกล่องไปเปิดดอกแบบ "ฝากเลี้ยง" แล้วขายเห็ดคืนให้สหกรณ์.
--
-- ข้อตัดสินใจที่ใช้ออกแบบ schema นี้ (ยืนยันกับผู้ใช้แล้ว):
--   * กล่องเพาะเป็นทรัพย์สินของสหกรณ์ (ฝากเลี้ยง) สมาชิกไม่ซื้อกล่อง
--   * กล่องสูญหาย/แตกหัก สมาชิกรับผิดชอบตามราคาที่สหกรณ์กำหนด (ตั้งค่า/แก้ได้)
--   * จ่ายสมาชิกตามน้ำหนักเห็ดอย่างเดียว ราคารับซื้อสหกรณ์ประกาศรายวันตามเกรด
--   * รอบจ่ายเงินสัปดาห์ละครั้ง หักกลบผ่าน ธ.ก.ส. ตั้งแต่ระยะแรก
--   * ค่าบริการ AgroLink เป็น % ของ (1) ซื้อเชื้อเห็ด (2) ซื้อวัสดุเพาะ
--     (3) ยอดขายเห็ดจากสมาชิกให้สหกรณ์ หรือจากสหกรณ์ให้ผู้ซื้อภายนอก
--     ผู้ขายเป็นผู้จ่าย อัตรา % ตั้งค่า/แก้ได้
--
-- Security convention: ทุกตารางในสคีมานี้ไม่มี RLS — ตามธรรมเนียมเดียวกับ
-- produce.lot / warehouse.* / processing.* (ดู grant_cooperative_collection_
-- station.sql) ทุก query ใน src/routes/mushroom*.js ต้องกรองด้วย
-- coop_org_id / farmer_id / linked_org_id / device ของผู้เรียกเองเสมอ
-- ซึ่งคือขอบเขตความปลอดภัยทั้งหมด ไม่ใช่แค่ defense-in-depth.
--
-- Idempotent: รันซ้ำได้ (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT).
-- ต้องรันหลัง grant_cooperative_tenant_foundation.sql (ใช้ identity.organization,
-- identity.farmer, uuid-ossp).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS mushroom;

-- ---------------------------------------------------------------------------
-- 1. ตั้งค่าสหกรณ์ + ประวัติการแก้ไข
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.setting (
  coop_org_id              uuid PRIMARY KEY REFERENCES identity.organization(org_id),
  fee_rate_spawn_pct       numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_spawn_pct >= 0 AND fee_rate_spawn_pct <= 100),
  fee_rate_substrate_pct   numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_substrate_pct >= 0 AND fee_rate_substrate_pct <= 100),
  fee_rate_member_sale_pct numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_member_sale_pct >= 0 AND fee_rate_member_sale_pct <= 100),
  fee_rate_external_sale_pct numeric(6,3) NOT NULL DEFAULT 0 CHECK (fee_rate_external_sale_pct >= 0 AND fee_rate_external_sale_pct <= 100),
  straw_price_per_kg       numeric(10,2) NOT NULL DEFAULT 0 CHECK (straw_price_per_kg >= 0),
  settlement_weekday       smallint NOT NULL DEFAULT 5 CHECK (settlement_weekday BETWEEN 0 AND 6),
  spawn_run_temp_min       numeric(5,2) NOT NULL DEFAULT 32,
  spawn_run_temp_max       numeric(5,2) NOT NULL DEFAULT 36,
  spawn_run_days           smallint NOT NULL DEFAULT 7,
  max_delivery_km          numeric(6,1) NOT NULL DEFAULT 150,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mushroom.setting_history (
  history_id   uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  field_name   text NOT NULL,
  old_value    text,
  new_value    text,
  changed_by   text,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_setting_hist ON mushroom.setting_history (coop_org_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS mushroom.box_type (
  box_type_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id       uuid NOT NULL REFERENCES identity.organization(org_id),
  name              text NOT NULL,
  replacement_price numeric(10,2) NOT NULL DEFAULT 0 CHECK (replacement_price >= 0),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, name)
);

-- ---------------------------------------------------------------------------
-- 2. สมาชิก (จุดเปิดดอก) และคู่ค้า
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.member (
  member_id              uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id            uuid NOT NULL REFERENCES identity.organization(org_id),
  farmer_id              uuid REFERENCES identity.farmer(farmer_id),
  member_code            text NOT NULL,
  full_name              text NOT NULL,
  phone                  text,
  address                text,
  lat                    numeric(9,6),
  lng                    numeric(9,6),
  distance_km            numeric(6,1),
  capacity_boxes         integer NOT NULL DEFAULT 0 CHECK (capacity_boxes >= 0),
  wind_protected         boolean NOT NULL DEFAULT false,
  water_available        boolean NOT NULL DEFAULT false,
  site_photo_url         text,
  baac_account_no        text,
  baac_account_name      text,
  consent_finance_share  boolean NOT NULL DEFAULT false,
  status                 text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Suspended')),
  note                   text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  approved_at            timestamptz,
  UNIQUE (coop_org_id, member_code)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mush_member_farmer ON mushroom.member (coop_org_id, farmer_id) WHERE farmer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mush_member_farmer ON mushroom.member (farmer_id);

CREATE TABLE IF NOT EXISTS mushroom.partner (
  partner_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_type   text NOT NULL CHECK (partner_type IN ('biomass_seller', 'spawn_seller', 'buyer', 'transporter')),
  name           text NOT NULL,
  contact_name   text,
  phone          text,
  address        text,
  linked_org_id  uuid REFERENCES identity.organization(org_id),
  note           text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_partner_coop ON mushroom.partner (coop_org_id, partner_type);
CREATE INDEX IF NOT EXISTS idx_mush_partner_linked ON mushroom.partner (linked_org_id);

-- ---------------------------------------------------------------------------
-- 3. วัตถุดิบและคลัง
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.material (
  material_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id     uuid NOT NULL REFERENCES identity.organization(org_id),
  code            text NOT NULL,
  name            text NOT NULL,
  category        text NOT NULL DEFAULT 'main' CHECK (category IN ('main', 'mix', 'supplement')),
  reorder_level_kg numeric(12,2) NOT NULL DEFAULT 0,
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (coop_org_id, code)
);

CREATE TABLE IF NOT EXISTS mushroom.purchase_order (
  po_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_id     uuid NOT NULL REFERENCES mushroom.partner(partner_id),
  po_type        text NOT NULL CHECK (po_type IN ('substrate', 'spawn')),
  status         text NOT NULL DEFAULT 'Ordered' CHECK (status IN ('Ordered', 'Confirmed', 'Delivered', 'Cancelled')),
  expected_date  date,
  total_amount   numeric(14,2) NOT NULL DEFAULT 0,
  fee_rate_pct   numeric(6,3) NOT NULL DEFAULT 0,
  fee_amount     numeric(14,2) NOT NULL DEFAULT 0,
  note           text,
  ordered_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz,
  delivered_at   timestamptz,
  paid_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mush_po_coop ON mushroom.purchase_order (coop_org_id, ordered_at DESC);

CREATE TABLE IF NOT EXISTS mushroom.purchase_order_line (
  line_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  po_id            uuid NOT NULL REFERENCES mushroom.purchase_order(po_id) ON DELETE CASCADE,
  material_id      uuid REFERENCES mushroom.material(material_id),
  item_name        text NOT NULL,
  qty              numeric(14,2) NOT NULL CHECK (qty > 0),
  unit             text NOT NULL DEFAULT 'kg',
  unit_price       numeric(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  amount           numeric(14,2) NOT NULL DEFAULT 0,
  spawn_lot_no     text,
  spawn_produced_on date
);

CREATE TABLE IF NOT EXISTS mushroom.spawn_lot (
  spawn_lot_id   uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_id     uuid REFERENCES mushroom.partner(partner_id),
  po_id          uuid REFERENCES mushroom.purchase_order(po_id),
  lot_no         text NOT NULL,
  produced_on    date,
  qty_bags       numeric(12,2) NOT NULL DEFAULT 0,
  qty_used_bags  numeric(12,2) NOT NULL DEFAULT 0,
  unit_cost      numeric(12,2) NOT NULL DEFAULT 0,
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_spawn_lot_coop ON mushroom.spawn_lot (coop_org_id);

-- ---------------------------------------------------------------------------
-- 4. สูตรวัสดุ รุ่นการผลิต และต้นทุน
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.recipe (
  recipe_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  name          text NOT NULL,
  kg_per_box    numeric(8,2) NOT NULL CHECK (kg_per_box > 0),
  spawn_bags_per_box numeric(8,3) NOT NULL DEFAULT 0,
  approved_by   text,
  note          text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mushroom.recipe_item (
  recipe_id    uuid NOT NULL REFERENCES mushroom.recipe(recipe_id) ON DELETE CASCADE,
  material_id  uuid NOT NULL REFERENCES mushroom.material(material_id),
  pct          numeric(6,2) NOT NULL CHECK (pct > 0 AND pct <= 100),
  PRIMARY KEY (recipe_id, material_id)
);

CREATE TABLE IF NOT EXISTS mushroom.batch (
  batch_id            uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id         uuid NOT NULL REFERENCES identity.organization(org_id),
  batch_code          text NOT NULL,
  recipe_id           uuid NOT NULL REFERENCES mushroom.recipe(recipe_id),
  status              text NOT NULL DEFAULT 'Composting'
                        CHECK (status IN ('Composting', 'Pasteurized', 'SpawnRun', 'Ready', 'Distributed', 'Closed', 'Failed')),
  boxes_planned       integer NOT NULL CHECK (boxes_planned > 0),
  boxes_good          integer,
  boxes_bad           integer NOT NULL DEFAULT 0,
  compost_started_on  date NOT NULL DEFAULT CURRENT_DATE,
  turn_count          integer NOT NULL DEFAULT 0,
  pasteurize_temp_c   numeric(5,2),
  pasteurize_hours    numeric(5,2),
  pasteurized_at      timestamptz,
  spawn_lot_id        uuid REFERENCES mushroom.spawn_lot(spawn_lot_id),
  spawned_at          timestamptz,
  ready_at            timestamptz,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, batch_code)
);
CREATE INDEX IF NOT EXISTS idx_mush_batch_coop ON mushroom.batch (coop_org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mushroom.batch_event (
  event_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  batch_id    uuid NOT NULL REFERENCES mushroom.batch(batch_id) ON DELETE CASCADE,
  event_type  text NOT NULL CHECK (event_type IN ('create', 'turn', 'pasteurize', 'spawn', 'ready', 'qc', 'distribute', 'close', 'fail', 'note')),
  temp_c      numeric(5,2),
  hours       numeric(5,2),
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_batch_event ON mushroom.batch_event (batch_id, at);

CREATE TABLE IF NOT EXISTS mushroom.batch_cost (
  cost_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  batch_id   uuid NOT NULL REFERENCES mushroom.batch(batch_id) ON DELETE CASCADE,
  cost_type  text NOT NULL CHECK (cost_type IN ('material', 'spawn', 'energy', 'labor', 'other')),
  amount     numeric(14,2) NOT NULL CHECK (amount >= 0),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mushroom.material_movement (
  movement_id  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  material_id  uuid NOT NULL REFERENCES mushroom.material(material_id),
  direction    text NOT NULL CHECK (direction IN ('in', 'out')),
  qty_kg       numeric(14,2) NOT NULL CHECK (qty_kg > 0),
  unit_price   numeric(12,2) NOT NULL DEFAULT 0,
  moisture_pct numeric(5,2),
  source_type  text NOT NULL CHECK (source_type IN ('member_straw', 'purchase', 'batch_use', 'adjust')),
  member_id    uuid REFERENCES mushroom.member(member_id),
  po_id        uuid REFERENCES mushroom.purchase_order(po_id),
  batch_id     uuid REFERENCES mushroom.batch(batch_id),
  note         text,
  moved_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_mm_coop ON mushroom.material_movement (coop_org_id, material_id, moved_at DESC);

-- ---------------------------------------------------------------------------
-- 5. ทะเบียนกล่อง (ทรัพย์สินสหกรณ์) และการฝากเลี้ยง
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.box (
  box_id            uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id       uuid NOT NULL REFERENCES identity.organization(org_id),
  box_type_id       uuid NOT NULL REFERENCES mushroom.box_type(box_type_id),
  qr_code           text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'Available'
                      CHECK (status IN ('Available', 'InBatch', 'WithMember', 'Lost', 'Broken', 'Retired')),
  current_batch_id  uuid REFERENCES mushroom.batch(batch_id),
  current_member_id uuid REFERENCES mushroom.member(member_id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_box_coop ON mushroom.box (coop_org_id, status);

CREATE TABLE IF NOT EXISTS mushroom.box_booking (
  booking_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id     uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id       uuid NOT NULL REFERENCES mushroom.member(member_id),
  requested_boxes integer NOT NULL CHECK (requested_boxes > 0),
  wanted_date     date NOT NULL,
  status          text NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested', 'Allocated', 'Delivered', 'Cancelled')),
  batch_id        uuid REFERENCES mushroom.batch(batch_id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_booking ON mushroom.box_booking (coop_org_id, status, wanted_date);

-- trip/trip_stop ต้องมาก่อน box_assignment (FK)
CREATE TABLE IF NOT EXISTS mushroom.trip (
  trip_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  trip_date    date NOT NULL,
  vehicle      text,
  driver_name  text,
  partner_id   uuid REFERENCES mushroom.partner(partner_id),
  status       text NOT NULL DEFAULT 'Planned' CHECK (status IN ('Planned', 'InProgress', 'Done', 'Cancelled')),
  distance_km  numeric(8,1),
  cost         numeric(12,2) NOT NULL DEFAULT 0,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mushroom.trip_stop (
  stop_id          uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  trip_id          uuid NOT NULL REFERENCES mushroom.trip(trip_id) ON DELETE CASCADE,
  member_id        uuid NOT NULL REFERENCES mushroom.member(member_id),
  seq              integer NOT NULL DEFAULT 1,
  drop_boxes       integer NOT NULL DEFAULT 0 CHECK (drop_boxes >= 0),
  booking_id       uuid REFERENCES mushroom.box_booking(booking_id),
  collect_mushroom boolean NOT NULL DEFAULT true,
  collect_straw    boolean NOT NULL DEFAULT false,
  collect_boxes    boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Done', 'Skipped')),
  done_at          timestamptz,
  note             text
);

CREATE TABLE IF NOT EXISTS mushroom.box_assignment (
  assignment_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  box_id           uuid NOT NULL REFERENCES mushroom.box(box_id),
  batch_id         uuid NOT NULL REFERENCES mushroom.batch(batch_id),
  member_id        uuid NOT NULL REFERENCES mushroom.member(member_id),
  trip_id          uuid REFERENCES mushroom.trip(trip_id),
  delivered_at     timestamptz NOT NULL DEFAULT now(),
  returned_at      timestamptz,
  outcome          text CHECK (outcome IN ('Returned', 'Lost', 'Broken')),
  liability_amount numeric(10,2) NOT NULL DEFAULT 0,
  spent_substrate_kg numeric(10,2)
);
CREATE INDEX IF NOT EXISTS idx_mush_assign_member ON mushroom.box_assignment (member_id, returned_at);
CREATE INDEX IF NOT EXISTS idx_mush_assign_box ON mushroom.box_assignment (box_id, returned_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mush_assign_open ON mushroom.box_assignment (box_id) WHERE returned_at IS NULL;

CREATE TABLE IF NOT EXISTS mushroom.issue_report (
  report_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id    uuid NOT NULL REFERENCES mushroom.member(member_id),
  batch_id     uuid REFERENCES mushroom.batch(batch_id),
  issue_type   text NOT NULL CHECK (issue_type IN ('no_mycelium', 'mold', 'pest', 'box_damaged', 'other')),
  note         text,
  photo_url    text,
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Resolved')),
  resolution   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- 6. ราคารายวัน รับซื้อเห็ด แปรรูป และขาย
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.daily_price (
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  price_date    date NOT NULL,
  grade         text NOT NULL CHECK (grade IN ('A', 'B', 'C')),
  price_per_kg  numeric(10,2) NOT NULL CHECK (price_per_kg >= 0),
  announced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coop_org_id, price_date, grade)
);

CREATE TABLE IF NOT EXISTS mushroom.product_lot (
  lot_id         uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  lot_code       text NOT NULL,
  product_type   text NOT NULL CHECK (product_type IN ('fresh', 'blanched_frozen', 'soy_pickled', 'canned')),
  grade          text,
  qty_kg         numeric(12,2) NOT NULL CHECK (qty_kg >= 0),
  qty_available_kg numeric(12,2) NOT NULL CHECK (qty_available_kg >= 0),
  input_fresh_kg numeric(12,2),
  produced_on    date NOT NULL DEFAULT CURRENT_DATE,
  expires_on     date,
  storage_location text,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coop_org_id, lot_code)
);

CREATE TABLE IF NOT EXISTS mushroom.harvest (
  harvest_id    uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id     uuid NOT NULL REFERENCES mushroom.member(member_id),
  batch_id      uuid REFERENCES mushroom.batch(batch_id),
  trip_id       uuid REFERENCES mushroom.trip(trip_id),
  lot_id        uuid REFERENCES mushroom.product_lot(lot_id),
  grade         text NOT NULL CHECK (grade IN ('A', 'B', 'C')),
  weight_kg     numeric(10,2) NOT NULL CHECK (weight_kg > 0),
  price_per_kg  numeric(10,2) NOT NULL CHECK (price_per_kg >= 0),
  amount        numeric(14,2) NOT NULL,
  fee_rate_pct  numeric(6,3) NOT NULL DEFAULT 0,
  fee_amount    numeric(14,2) NOT NULL DEFAULT 0,
  recorded_by   text,
  collected_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_harvest ON mushroom.harvest (coop_org_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_mush_harvest_member ON mushroom.harvest (member_id, collected_at DESC);

-- ผู้ใช้เป็นคนเขียนการคาดการณ์ "เห็ดที่จะเก็บได้" ของตัวเองบนมือถือ (ไม่บังคับ)
CREATE TABLE IF NOT EXISTS mushroom.member_harvest_log (
  log_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  member_id   uuid NOT NULL REFERENCES mushroom.member(member_id),
  log_date    date NOT NULL DEFAULT CURRENT_DATE,
  est_kg      numeric(10,2) NOT NULL CHECK (est_kg >= 0),
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mushroom.sales_order (
  order_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  partner_id     uuid NOT NULL REFERENCES mushroom.partner(partner_id),
  order_kind     text NOT NULL DEFAULT 'spot' CHECK (order_kind IN ('spot', 'contract')),
  status         text NOT NULL DEFAULT 'Requested'
                   CHECK (status IN ('Requested', 'Confirmed', 'Delivered', 'Paid', 'Cancelled')),
  product_type   text NOT NULL CHECK (product_type IN ('fresh', 'blanched_frozen', 'soy_pickled', 'canned')),
  grade          text,
  qty_kg         numeric(12,2) NOT NULL CHECK (qty_kg > 0),
  price_per_kg   numeric(10,2) NOT NULL CHECK (price_per_kg >= 0),
  amount         numeric(14,2) NOT NULL,
  fee_rate_pct   numeric(6,3) NOT NULL DEFAULT 0,
  fee_amount     numeric(14,2) NOT NULL DEFAULT 0,
  deliver_on     date,
  contract_end   date,
  created_by     text NOT NULL DEFAULT 'coop' CHECK (created_by IN ('coop', 'buyer')),
  invoice_no     text,
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz,
  delivered_at   timestamptz,
  paid_at        timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mush_so_coop ON mushroom.sales_order (coop_org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mushroom.sales_allocation (
  order_id  uuid NOT NULL REFERENCES mushroom.sales_order(order_id) ON DELETE CASCADE,
  lot_id    uuid NOT NULL REFERENCES mushroom.product_lot(lot_id),
  qty_kg    numeric(12,2) NOT NULL CHECK (qty_kg > 0),
  PRIMARY KEY (order_id, lot_id)
);

-- ---------------------------------------------------------------------------
-- 7. บัญชีสมาชิก การหักกลบรายสัปดาห์ (ธ.ก.ส.) และค่าบริการ AgroLink
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.settlement_run (
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

CREATE TABLE IF NOT EXISTS mushroom.member_ledger (
  entry_id      uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  member_id     uuid NOT NULL REFERENCES mushroom.member(member_id),
  entry_date    date NOT NULL DEFAULT CURRENT_DATE,
  entry_type    text NOT NULL CHECK (entry_type IN ('straw_sale', 'mushroom_sale', 'sale_fee', 'box_liability', 'adjustment')),
  amount        numeric(14,2) NOT NULL,
  ref_type      text,
  ref_id        uuid,
  run_id        uuid REFERENCES mushroom.settlement_run(run_id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mush_ledger_member ON mushroom.member_ledger (member_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_mush_ledger_open ON mushroom.member_ledger (coop_org_id, run_id);

CREATE TABLE IF NOT EXISTS mushroom.settlement_line (
  run_id          uuid NOT NULL REFERENCES mushroom.settlement_run(run_id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES mushroom.member(member_id),
  total_credit    numeric(14,2) NOT NULL DEFAULT 0,
  total_debit     numeric(14,2) NOT NULL DEFAULT 0,
  net_amount      numeric(14,2) NOT NULL DEFAULT 0,
  baac_account_no text,
  baac_account_name text,
  PRIMARY KEY (run_id, member_id)
);

CREATE TABLE IF NOT EXISTS mushroom.platform_fee (
  fee_id       uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  fee_type     text NOT NULL CHECK (fee_type IN ('spawn_purchase', 'substrate_purchase', 'member_sale', 'external_sale')),
  payer_type   text NOT NULL CHECK (payer_type IN ('partner', 'member', 'coop')),
  payer_ref    uuid,
  base_amount  numeric(14,2) NOT NULL,
  rate_pct     numeric(6,3) NOT NULL,
  fee_amount   numeric(14,2) NOT NULL,
  ref_type     text NOT NULL,
  ref_id       uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_id, fee_type)
);
CREATE INDEX IF NOT EXISTS idx_mush_fee_coop ON mushroom.platform_fee (coop_org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. IoT ห้องอบ/ห้องบ่ม/จุดเปิดดอก
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mushroom.iot_device (
  device_id     uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  coop_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  name          text NOT NULL,
  location_type text NOT NULL CHECK (location_type IN ('steam_room', 'spawn_room', 'fruiting_site', 'cold_storage')),
  member_id     uuid REFERENCES mushroom.member(member_id),
  api_key_hash  text NOT NULL,
  temp_min      numeric(5,2),
  temp_max      numeric(5,2),
  rh_min        numeric(5,2),
  rh_max        numeric(5,2),
  auto_mist     boolean NOT NULL DEFAULT false,
  active        boolean NOT NULL DEFAULT true,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mush_iot_key ON mushroom.iot_device (api_key_hash);

CREATE TABLE IF NOT EXISTS mushroom.iot_reading (
  reading_id   bigserial PRIMARY KEY,
  device_id    uuid NOT NULL REFERENCES mushroom.iot_device(device_id) ON DELETE CASCADE,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  temp_c       numeric(5,2),
  rh_pct       numeric(5,2)
);
CREATE INDEX IF NOT EXISTS idx_mush_iot_reading ON mushroom.iot_reading (device_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS mushroom.iot_alert (
  alert_id        uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  device_id       uuid NOT NULL REFERENCES mushroom.iot_device(device_id) ON DELETE CASCADE,
  alert_type      text NOT NULL CHECK (alert_type IN ('temp_low', 'temp_high', 'rh_low', 'rh_high', 'offline')),
  value           numeric(6,2),
  message         text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mush_iot_alert ON mushroom.iot_alert (device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mushroom.iot_command (
  command_id  uuid PRIMARY KEY DEFAULT public.uuid_generate_v4(),
  device_id   uuid NOT NULL REFERENCES mushroom.iot_device(device_id) ON DELETE CASCADE,
  command     text NOT NULL CHECK (command IN ('mist_on', 'mist_off')),
  status      text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Sent')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- 9. ค่าเริ่มต้นต่อสหกรณ์ (เรียกจาก route ครั้งแรกที่สหกรณ์เข้าโมดูล)
--    ค่าบริการและราคากล่องเริ่มที่ 0 — สหกรณ์ต้องตั้งเอง (ไม่เดาตัวเลขแทน)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mushroom.ensure_coop_defaults(p_coop_org_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO mushroom.setting (coop_org_id) VALUES (p_coop_org_id) ON CONFLICT DO NOTHING;

    INSERT INTO mushroom.material (coop_org_id, code, name, category) VALUES
      (p_coop_org_id, 'palm_bunch',    'ทะลายปาล์มเปล่า', 'main'),
      (p_coop_org_id, 'cassava_pulp',  'กากมันสำปะหลัง',  'main'),
      (p_coop_org_id, 'water_hyacinth','ผักตบชวาสด',      'main'),
      (p_coop_org_id, 'rice_straw',    'ฟางข้าว',          'mix'),
      (p_coop_org_id, 'rice_bran',     'รำข้าว',           'supplement'),
      (p_coop_org_id, 'cotton_waste',  'กากฝ้าย / ขี้ฝ้าย', 'supplement')
    ON CONFLICT (coop_org_id, code) DO NOTHING;

    INSERT INTO mushroom.box_type (coop_org_id, name) VALUES
      (p_coop_org_id, 'ลังพลาสติก'),
      (p_coop_org_id, 'กล่องโฟมความหนาแน่นสูง')
    ON CONFLICT (coop_org_id, name) DO NOTHING;
END;
$$;

COMMENT ON SCHEMA mushroom IS 'โปรแกรมบริหารจัดการการผลิตเห็ดฟางครบวงจร (สหกรณ์ผลิตกล่องเพาะ สมาชิกเปิดดอกแบบฝากเลี้ยง) — ไม่มี RLS ทุก query ต้องกรองด้วย coop_org_id/farmer_id/linked_org_id/device ของผู้เรียก';

-- ---------------------------------------------------------------------------
-- 10. Grants
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA mushroom TO agrolink_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA mushroom TO agrolink_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mushroom TO agrolink_app;
GRANT EXECUTE ON FUNCTION mushroom.ensure_coop_defaults(uuid) TO agrolink_app;
-- อ่านข้อมูลเกษตรกร/องค์กรเพื่อเชื่อมสมาชิกและคู่ค้า (มีสิทธิ์ SELECT อยู่แล้วจาก
-- migration ก่อนหน้า — ใส่ซ้ำไว้เพื่อให้ไฟล์นี้รันเดี่ยวได้บนฐานที่ครบ)
GRANT SELECT ON identity.farmer, identity.organization TO agrolink_app;
