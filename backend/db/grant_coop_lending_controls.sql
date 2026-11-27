-- AgroLink -- ชั้นควบคุมของตลาดสินเชื่อระหว่างสหกรณ์ ตาม Master Blueprint 2026–2027
--   ข้อ 5.2 Regulatory Compliance Engine (ผู้ให้กู้ 8 ข้อ) + มาตรา 47 วงเงินกู้ยืมของผู้ขอกู้
--   ข้อ 7.2/7.3 งวดเบิกตามกิจกรรม: งวดถัดไปเปิดเมื่อผู้ให้กู้ตรวจปิดยอดงวดก่อน โดยผู้ตรวจและผู้อนุมัติคนละคน
--   ข้อ 8.2 ระดับความน่าเชื่อถือของหลักฐาน 1–5 (+ บันทึกผู้ตรวจอิสระ)
--   ข้อ 18 Go-live Gate G1–G8: ไม่เปิดโอนเงินจริงจนกว่าจะผ่านครบ
--   สหกรณ์โคนม/ธุรกิจอื่นเป็นผู้ขอกู้ได้ (Pilot B: เชื่อมข้อมูลรับน้ำนมจากระบบบริหารโคนมแห่งชาติ)
--
-- รันหลัง grant_coop_lending.sql, grant_coop_lending_crop_plan.sql, grant_coop_lending_marketplace.sql · รันซ้ำได้
-- ============================================================================
SET client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- ค่าตั้ง: เพดานลูกหนี้รายใหญ่ (ตรวจกับเกณฑ์ของนายทะเบียนฉบับปัจจุบันก่อนใช้จริง แก้ได้ในหน้าผู้ดูแล)
-- ---------------------------------------------------------------------------
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS large_exposure_pct numeric(6,3) NOT NULL DEFAULT 10;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS large_exposure_min_assets numeric(18,2) NOT NULL DEFAULT 5000000000;
ALTER TABLE coop_lending.setting DROP CONSTRAINT IF EXISTS setting_large_exposure_pct_check;
ALTER TABLE coop_lending.setting ADD CONSTRAINT setting_large_exposure_pct_check CHECK (large_exposure_pct > 0 AND large_exposure_pct <= 100);

-- ---------------------------------------------------------------------------
-- ผู้ขอกู้: ประเภทสหกรณ์ + วงเงินกู้ยืมที่ที่ประชุมใหญ่อนุมัติ (มาตรา 47) + ผลตรวจผู้ขอกู้ (Gate G3)
-- ---------------------------------------------------------------------------
ALTER TABLE coop_lending.borrower_profile DROP CONSTRAINT IF EXISTS borrower_profile_coop_kind_check;
ALTER TABLE coop_lending.borrower_profile ADD CONSTRAINT borrower_profile_coop_kind_check
  CHECK (coop_kind IN ('agriculture', 'settlement', 'fisheries', 'dairy', 'other'));
ALTER TABLE coop_lending.borrower_profile ADD COLUMN IF NOT EXISTS max_borrowing numeric(16,2) CHECK (max_borrowing IS NULL OR max_borrowing >= 0);
ALTER TABLE coop_lending.borrower_profile ADD COLUMN IF NOT EXISTS max_borrowing_ref text;   -- มติที่ประชุมใหญ่ ครั้งที่/ปี
ALTER TABLE coop_lending.borrower_profile ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE coop_lending.borrower_profile ADD COLUMN IF NOT EXISTS verified_by text;

-- ---------------------------------------------------------------------------
-- 5.2 เอกสารคุณสมบัติผู้ให้กู้ (ผู้ดูแลแพลตฟอร์มตรวจ ผ่าน/ไม่ผ่าน)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coop_lending.lender_compliance (
  org_id        uuid NOT NULL REFERENCES identity.organization(org_id),
  check_code    text NOT NULL CHECK (check_code IN ('registration', 'bylaws', 'lending_regulation', 'board_resolution', 'signatories')),
  status        text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Pass', 'Fail')),
  file_id       uuid REFERENCES storage.file_object(file_id),
  note          text CHECK (note IS NULL OR length(note) <= 1000),
  submitted_by  text NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text CHECK (review_note IS NULL OR length(review_note) <= 1000),
  valid_until   date,
  PRIMARY KEY (org_id, check_code)
);

-- ---------------------------------------------------------------------------
-- 7.2 งวดเบิกตามกิจกรรมของสัญญาจากตลาด
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coop_lending.agreement_tranche (
  agreement_id       uuid NOT NULL REFERENCES coop_lending.loan_agreement(agreement_id) ON DELETE CASCADE,
  seq                int NOT NULL CHECK (seq >= 1),
  name               text NOT NULL,
  amount             numeric(16,2) NOT NULL CHECK (amount > 0),
  timing             text,
  status             text NOT NULL DEFAULT 'Locked' CHECK (status IN ('Locked', 'Open', 'Submitted', 'Checked', 'Verified')),
  lead_lender_org_id uuid NOT NULL REFERENCES identity.organization(org_id),
  opened_at          timestamptz,
  borrower_input     jsonb,          -- {inventory_kg, inventory_value, sales_amount, note}
  delivery_file_id   uuid REFERENCES storage.file_object(file_id),
  reconciliation     jsonb,          -- สรุปที่ระบบคำนวณ ณ วันส่งปิดยอด
  submitted_by       text,
  submitted_at       timestamptz,
  checked_by         text,           -- ผู้ตรวจสอบกิจกรรมและเอกสาร
  checked_at         timestamptz,
  check_note         text,
  approved_by        text,           -- ผู้มีอำนาจอนุมัติเบิกจ่ายงวดถัดไป
  approved_at        timestamptz,
  returned_note      text,
  PRIMARY KEY (agreement_id, seq),
  CHECK (approved_by IS NULL OR approved_by <> checked_by)
);
ALTER TABLE coop_lending.disbursement_item ADD COLUMN IF NOT EXISTS tranche_seq int;
ALTER TABLE coop_lending.disbursement_item ADD COLUMN IF NOT EXISTS verification_level smallint NOT NULL DEFAULT 0;
ALTER TABLE coop_lending.disbursement_item ADD COLUMN IF NOT EXISTS verification jsonb;

-- 8.2 ระดับ 5: ผลตรวจจากบุคคลหรือหน่วยงานอิสระ (บันทึกโดยผู้ดูแลแพลตฟอร์มตามรายงานผู้ตรวจ)
CREATE TABLE IF NOT EXISTS coop_lending.item_inspection (
  inspection_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id       uuid NOT NULL REFERENCES coop_lending.disbursement_item(item_id),
  inspector     text NOT NULL CHECK (length(inspector) BETWEEN 2 AND 200),
  result        text NOT NULL CHECK (result IN ('pass', 'fail')),
  note          text CHECK (note IS NULL OR length(note) <= 2000),
  file_id       uuid REFERENCES storage.file_object(file_id),
  recorded_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_inspection_item ON coop_lending.item_inspection (item_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 18 Go-live Gates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coop_lending.golive_gate (
  code        text PRIMARY KEY CHECK (code IN ('G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8')),
  status      text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Pass', 'Fail')),
  note        text CHECK (note IS NULL OR length(note) <= 2000),
  file_id     uuid REFERENCES storage.file_object(file_id),
  decided_by  text,
  decided_at  timestamptz
);
INSERT INTO coop_lending.golive_gate (code) VALUES ('G1'), ('G2'), ('G3'), ('G4'), ('G5'), ('G6'), ('G7'), ('G8') ON CONFLICT (code) DO NOTHING;

-- การแจ้งเตือนเพิ่ม: งวดรอตรวจปิดยอด / ผลตรวจคุณสมบัติ
ALTER TABLE coop_lending.dunning_notice DROP CONSTRAINT IF EXISTS dunning_notice_kind_check;
ALTER TABLE coop_lending.dunning_notice ADD CONSTRAINT dunning_notice_kind_check CHECK (kind IN (
  'sc_transfer_late', 'ac_payment_late', 'tranche_overdue', 'installment_overdue', 'facility_suspended', 'plan_held', 'stage_check_waiting',
  'listing_match', 'offer_received', 'offer_update', 'question', 'listing_review', 'agreement', 'tranche_review', 'compliance'));

COMMENT ON TABLE coop_lending.agreement_tranche IS 'งวดเบิกตามกิจกรรม — งวดถัดไปเปิดเมื่อผู้ให้กู้หลักตรวจปิดยอดงวดก่อน (ผู้ตรวจ ≠ ผู้อนุมัติ)';
COMMENT ON TABLE coop_lending.golive_gate IS 'เงื่อนไขก่อนเปิดใช้งานจริง G1–G8 — ไม่ผ่านครบ = ระบบไม่สั่งโอนเงินผ่านธนาคารจริง';

GRANT SELECT, INSERT, UPDATE ON coop_lending.lender_compliance, coop_lending.agreement_tranche, coop_lending.item_inspection, coop_lending.golive_gate TO agrolink_app;
