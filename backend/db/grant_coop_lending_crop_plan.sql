-- AgroLink Platform — สินเชื่อการผลิตแบบแบ่งงวดตามรอบการเพาะปลูก (Concept Note ประเภท A)
-- ต่อยอด grant_coop_lending.sql (ต้องรันไฟล์นั้นก่อน) — รันซ้ำได้ ไม่ลบข้อมูลเดิม
--
-- แผนสินเชื่อหนึ่งแผน = เกษตรกรหนึ่งราย × แปลงหนึ่งแปลง × หนึ่งฤดู แบ่งเป็นงวดตามกิจกรรมจริง
-- (ข้าว: เตรียมดิน → ปัจจัย/เมล็ดพันธุ์ → เพาะปลูก → ใส่ปุ๋ย → ดูแลรักษา → เก็บเกี่ยว)
-- งวดถัดไปเปิดได้ต่อเมื่อสหกรณ์การเกษตรส่งผลตรวจแปลงของงวดก่อน (ภาพหน้างาน + ผลดาวเทียม)
-- และสหกรณ์ออมทรัพย์ "ผ่าน" งวดนั้น — พบความผิดปกติสหกรณ์ออมทรัพย์ระงับแผนได้ทันที
-- เงินยังออกเป็นรายการเบิก (coop_lending.disbursement_item) จ่ายตรงถึงผู้ขายเหมือนเดิม แต่ผูกกับงวด

SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS coop_lending.crop_plan (
  plan_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  facility_id      uuid NOT NULL REFERENCES coop_lending.facility(facility_id),
  borrower_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  lender_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  farmer_id        uuid NOT NULL REFERENCES identity.farmer(farmer_id),
  unit_id          uuid NOT NULL REFERENCES registry.production_unit(unit_id),
  commodity_code   text NOT NULL,
  template_key     text NOT NULL,
  season_label     text NOT NULL CHECK (length(season_label) BETWEEN 2 AND 60),
  planting_date    date NOT NULL,
  area_rai         numeric(10,2) NOT NULL CHECK (area_rai > 0),
  total_amount     numeric(16,2) NOT NULL CHECK (total_amount > 0),
  note             text CHECK (note IS NULL OR length(note) <= 1000),
  status           text NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'Active', 'Suspended', 'Completed', 'Rejected', 'Cancelled')),
  decided_reason   text,
  suspended_reason text,
  approved_at      timestamptz,
  approved_by      text,
  completed_at     timestamptz,
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'Rejected' OR decided_reason IS NOT NULL)
);
-- แปลงหนึ่งมีแผนที่ยังไม่จบได้ครั้งละหนึ่งแผน
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_crop_plan_unit_open ON coop_lending.crop_plan (unit_id)
  WHERE status IN ('Submitted', 'Active', 'Suspended');
CREATE INDEX IF NOT EXISTS idx_cl_crop_plan_facility ON coop_lending.crop_plan (facility_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_crop_plan_lender ON coop_lending.crop_plan (lender_org_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_crop_plan_farmer ON coop_lending.crop_plan (farmer_id);

CREATE TABLE IF NOT EXISTS coop_lending.crop_plan_stage (
  plan_id            uuid NOT NULL REFERENCES coop_lending.crop_plan(plan_id) ON DELETE CASCADE,
  seq                int NOT NULL CHECK (seq BETWEEN 1 AND 12),
  stage_key          text NOT NULL,
  name_th            text NOT NULL,
  purposes           text[] NOT NULL,
  planned_amount     numeric(16,2) NOT NULL CHECK (planned_amount >= 0),
  window_start       date NOT NULL,
  window_end         date NOT NULL,
  check_method_th    text NOT NULL,
  status             text NOT NULL DEFAULT 'Locked' CHECK (status IN ('Locked', 'Open', 'CheckSubmitted', 'Passed', 'Held')),
  opened_at          timestamptz,
  check_file_id      uuid REFERENCES storage.file_object(file_id),
  check_sha256       text,
  check_note         text,
  check_submitted_by text,
  check_submitted_at timestamptz,
  satellite_result   text CHECK (satellite_result IS NULL OR satellite_result IN ('pass', 'review', 'insufficient', 'na')),
  satellite_detail   jsonb,
  decided_by         text,
  decided_at         timestamptz,
  decision_note      text,
  PRIMARY KEY (plan_id, seq),
  CHECK (window_end >= window_start)
);
-- ภาพตรวจแปลงใช้ได้ครั้งเดียว
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_stage_check_hash ON coop_lending.crop_plan_stage (check_sha256) WHERE check_sha256 IS NOT NULL;

ALTER TABLE coop_lending.disbursement_item ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES coop_lending.crop_plan(plan_id);
ALTER TABLE coop_lending.disbursement_item ADD COLUMN IF NOT EXISTS stage_seq int;
CREATE INDEX IF NOT EXISTS idx_cl_item_plan ON coop_lending.disbursement_item (plan_id, stage_seq) WHERE plan_id IS NOT NULL;

COMMENT ON TABLE coop_lending.crop_plan IS 'แผนสินเชื่อการผลิตแบบแบ่งงวด (เกษตรกร × แปลง × ฤดู) — งวดถัดไปเปิดเมื่อสหกรณ์ออมทรัพย์ผ่านผลตรวจแปลงของงวดก่อน';

GRANT SELECT, INSERT, UPDATE ON coop_lending.crop_plan, coop_lending.crop_plan_stage TO agrolink_app;
GRANT SELECT ON identity.government_officer, registry.cooperative_profile, registry.province TO agrolink_app;

-- การทวงถาม/แจ้งเตือนเพิ่มชนิด: ระงับแผน (plan_held) และงวดรอตรวจ (stage_check_waiting)
ALTER TABLE coop_lending.dunning_notice DROP CONSTRAINT IF EXISTS dunning_notice_kind_check;
ALTER TABLE coop_lending.dunning_notice ADD CONSTRAINT dunning_notice_kind_check CHECK (kind IN (
  'sc_transfer_late', 'ac_payment_late', 'tranche_overdue', 'installment_overdue', 'facility_suspended', 'plan_held', 'stage_check_waiting'));
ALTER TABLE coop_lending.dunning_notice ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES coop_lending.crop_plan(plan_id);
