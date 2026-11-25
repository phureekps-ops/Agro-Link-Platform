-- AgroLink Platform — สินเชื่อระหว่างสหกรณ์ (สหกรณ์ออมทรัพย์ → สหกรณ์การเกษตร)
--
-- ออกแบบตามเอกสาร "โมดูลสินเชื่อระหว่างสหกรณ์ — ร่างออกแบบ" และข้อตัดสินใจของผู้ใช้:
--   * สหกรณ์ออมทรัพย์เป็นประเภทองค์กรใหม่ 'SavingsCooperative' มีพอร์ทัลของตนเอง (frontend/savingscoop/)
--   * ไม่ปล่อยเงินเป็นก้อน — เบิกเป็นรายการตามหลักฐาน จ่ายตรงถึงผู้ขายผ่านบัญชีเฉพาะของสหกรณ์การเกษตร
--   * เชื่อมระบบโอนเงินธนาคารตั้งแต่ต้น (backend/src/lib/bankGateway.js — ตอนนี้มีไดรเวอร์ทดสอบ 'sandbox'
--     ที่ไม่โอนเงินจริง จนกว่าจะเลือกธนาคารคู่ค้า) ผู้จัดทำกับผู้อนุมัติการโอนต้องเป็นคนละคน
--   * สหกรณ์การเกษตรรับความเสี่ยงเกษตรกรไม่ชำระทั้งหมด
--   * ค่าธรรมเนียมแพลตฟอร์มเก็บจากสหกรณ์ออมทรัพย์เป็น % ของยอดที่โอนแต่ละงวด
--   * กำหนดเวลา: สหกรณ์ออมทรัพย์ 3 วันทำการ (นับจากหลักฐานครบ) สหกรณ์การเกษตร 4 วันทำการ (นับจากเงินเข้า)
--   * เลยกำหนด: ทวงถาม + ค่าปรับ 10% ต่อปีจากยอดค้าง (จ่ายผู้ขายช้า → เป็นของผู้ขาย,
--     ค่างวดช้า → ดอกเบี้ยผิดนัดแทนอัตราปกติ เป็นของสหกรณ์ออมทรัพย์)
--
-- รันซ้ำได้ (IF NOT EXISTS / ตรวจก่อนแก้ constraint) ไม่ลบข้อมูลเดิม
-- ไม่มี RLS ในสคีมานี้ — ทุก query ใน backend/src/routes/coopLending.js กรองด้วย org_id/farmer_id ของผู้เรียก

SET client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- 1) ประเภทองค์กรใหม่ 'SavingsCooperative' — ขยาย CHECK จากค่าที่มีอยู่จริงในฐานข้อมูล
--    (อ่านค่าปัจจุบันแล้วเติมค่าใหม่ จึงไม่ทำให้ค่าที่ migration อื่นเพิ่มไว้หายไป)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t record;
  def text;
  vals text[];
BEGIN
  FOR t IN SELECT * FROM (VALUES
      ('identity.organization'::regclass, 'organization_org_type_check', 'org_type'),
      ('identity.organization_role'::regclass, 'organization_role_role_type_check', 'role_type')) AS x(rel, con, col)
  LOOP
    SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid = t.rel AND conname = t.con;
    IF def IS NULL THEN
      RAISE EXCEPTION 'ไม่พบ constraint % — ฐานข้อมูลยังไม่ได้รัน migration พื้นฐาน', t.con;
    END IF;
    -- ค่าทุกตัวเป็นคำ CamelCase (รองรับทั้งรูป ARRAY['A'::text, ...] และ '{A,B}'::text[])
    SELECT array_agg(DISTINCT m[1]) INTO vals
      FROM regexp_matches(def, '([A-Z][A-Za-z]+)', 'g') AS m
     WHERE m[1] NOT IN ('ARRAY', 'ANY', 'CHECK');
    IF NOT ('SavingsCooperative' = ANY (vals)) THEN
      vals := vals || ARRAY['SavingsCooperative'];
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', t.rel, t.con);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[%s]))', t.rel, t.con, t.col,
        (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
    END IF;
  END LOOP;
END $$;

-- บัญชีเจ้าหน้าที่รายบุคคล (ใช้แยกผู้จัดทำ/ผู้อนุมัติการโอน) — เดิมเปิดเฉพาะ 'Cooperative'
CREATE OR REPLACE FUNCTION identity.register_staff_member(
  p_org_id uuid, p_full_name text, p_national_id_hash text, p_auth_subject_id text,
  p_role_code text, p_created_by text
) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_org_type TEXT;
    v_member_id uuid;
BEGIN
    SELECT org_type INTO v_org_type FROM identity.organization WHERE org_id = p_org_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ไม่พบองค์กร %', p_org_id;
    END IF;
    IF v_org_type NOT IN ('Cooperative', 'SavingsCooperative') THEN
        RAISE EXCEPTION 'บัญชีพนักงานรายบุคคลใช้ได้เฉพาะองค์กรประเภทสหกรณ์เท่านั้น (org_id % คือ %)', p_org_id, v_org_type;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM identity.role WHERE role_code = p_role_code AND role_code LIKE 'coop.%') THEN
        RAISE EXCEPTION 'role_code ไม่ถูกต้องหรือไม่ใช่สิทธิ์ระดับสหกรณ์: %', p_role_code;
    END IF;

    INSERT INTO identity.organization_member (org_id, full_name, national_id_hash, role_in_org, auth_subject_id, status)
    VALUES (p_org_id, p_full_name, p_national_id_hash, 'Staff', p_auth_subject_id, 'Active')
    RETURNING member_id INTO v_member_id;

    INSERT INTO identity.subject_role (subject_type, subject_id, role_code)
    VALUES ('organization_member', v_member_id, p_role_code);

    RETURN v_member_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) สคีมา coop_lending
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS coop_lending;

-- ค่าตั้งของแพลตฟอร์ม (แถวเดียว) — ผู้ดูแลแพลตฟอร์มแก้ผ่าน /admin/coop-lending/settings
CREATE TABLE IF NOT EXISTS coop_lending.setting (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  fee_pct              numeric(6,4) NOT NULL DEFAULT 0 CHECK (fee_pct >= 0 AND fee_pct <= 5),
  sc_sla_days          int NOT NULL DEFAULT 3 CHECK (sc_sla_days BETWEEN 1 AND 30),
  ac_sla_days          int NOT NULL DEFAULT 4 CHECK (ac_sla_days BETWEEN 1 AND 30),
  late_penalty_pct     numeric(6,3) NOT NULL DEFAULT 10 CHECK (late_penalty_pct >= 0 AND late_penalty_pct <= 30),
  platform_account_id  uuid,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO coop_lending.setting (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- วันหยุดราชการ (ผู้ดูแลระบบประกาศ) — เสาร์-อาทิตย์ตัดให้อัตโนมัติ
CREATE TABLE IF NOT EXISTS coop_lending.holiday (
  holiday_date  date PRIMARY KEY,
  name_th       text NOT NULL CHECK (length(name_th) BETWEEN 1 AND 120),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- บัญชีธนาคาร ของสหกรณ์ (ดำเนินงาน / บัญชีเฉพาะเงินกู้) ผู้ขาย (รับเงิน) และแพลตฟอร์ม
CREATE TABLE IF NOT EXISTS coop_lending.bank_account (
  account_id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_type           text NOT NULL CHECK (owner_type IN ('organization', 'farmer', 'platform')),
  owner_id             uuid,
  purpose              text NOT NULL CHECK (purpose IN ('operating', 'loan_dedicated', 'payout', 'platform')),
  bank_code            text NOT NULL CHECK (bank_code ~ '^[0-9]{3}$'),
  account_no           text NOT NULL CHECK (account_no ~ '^[0-9]{10,15}$'),
  account_name         text NOT NULL CHECK (length(account_name) BETWEEN 2 AND 160),
  verified_name        text,
  verification_status  text NOT NULL DEFAULT 'Pending' CHECK (verification_status IN ('Pending', 'Verified', 'Failed')),
  verification_note    text,
  verified_at          timestamptz,
  gateway              text,
  added_by_org_id      uuid REFERENCES identity.organization(org_id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_type = 'platform') = (owner_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_bank_account ON coop_lending.bank_account (owner_type, COALESCE(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), bank_code, account_no, purpose);
CREATE INDEX IF NOT EXISTS idx_cl_bank_account_owner ON coop_lending.bank_account (owner_type, owner_id);

-- โครงการให้กู้ของสหกรณ์ออมทรัพย์
CREATE TABLE IF NOT EXISTS coop_lending.program (
  program_id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  lender_org_id              uuid NOT NULL REFERENCES identity.organization(org_id),
  name                       text NOT NULL CHECK (length(name) BETWEEN 2 AND 160),
  purposes                   text[] NOT NULL CHECK (cardinality(purposes) > 0 AND purposes <@ ARRAY['inputs','machinery_service','procurement','asset']),
  total_limit                numeric(16,2) NOT NULL CHECK (total_limit > 0),
  per_borrower_limit         numeric(16,2) NOT NULL CHECK (per_borrower_limit > 0),
  rate_pct                   numeric(6,3) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 30),
  tranche_tenor_days         int NOT NULL DEFAULT 180 CHECK (tranche_tenor_days BETWEEN 7 AND 730),
  grace_days                 int NOT NULL DEFAULT 15 CHECK (grace_days BETWEEN 0 AND 120),
  per_farmer_limit           numeric(16,2) CHECK (per_farmer_limit IS NULL OR per_farmer_limit > 0),
  per_seller_limit           numeric(16,2) CHECK (per_seller_limit IS NULL OR per_seller_limit > 0),
  asset_min_down_pct         numeric(6,3) NOT NULL DEFAULT 10 CHECK (asset_min_down_pct BETWEEN 0 AND 90),
  asset_max_months           int NOT NULL DEFAULT 60 CHECK (asset_max_months BETWEEN 3 AND 120),
  asset_max_income_ratio_pct numeric(6,2) NOT NULL DEFAULT 50 CHECK (asset_max_income_ratio_pct BETWEEN 5 AND 100),
  province_codes             text[],
  conditions                 text CHECK (conditions IS NULL OR length(conditions) <= 2000),
  status                     text NOT NULL DEFAULT 'Open' CHECK (status IN ('Draft', 'Open', 'Paused', 'Closed')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CHECK (per_borrower_limit <= total_limit)
);
CREATE INDEX IF NOT EXISTS idx_cl_program_lender ON coop_lending.program (lender_org_id, status);

-- คำขอกู้ของสหกรณ์การเกษตร
CREATE TABLE IF NOT EXISTS coop_lending.application (
  application_id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  program_id        uuid NOT NULL REFERENCES coop_lending.program(program_id),
  borrower_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  requested_amount  numeric(16,2) NOT NULL CHECK (requested_amount > 0),
  purpose_amounts   jsonb NOT NULL DEFAULT '{}'::jsonb,
  member_count      int CHECK (member_count IS NULL OR member_count >= 0),
  plan_note         text CHECK (plan_note IS NULL OR length(plan_note) <= 3000),
  status            text NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'Approved', 'Rejected', 'Withdrawn')),
  decided_reason    text,
  decided_at        timestamptz,
  decided_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'Rejected' OR decided_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_application_open ON coop_lending.application (program_id, borrower_org_id) WHERE status = 'Submitted';
CREATE INDEX IF NOT EXISTS idx_cl_application_borrower ON coop_lending.application (borrower_org_id, created_at DESC);

-- วงเงินที่อนุมัติ
CREATE TABLE IF NOT EXISTS coop_lending.facility (
  facility_id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  application_id       uuid NOT NULL UNIQUE REFERENCES coop_lending.application(application_id),
  program_id           uuid NOT NULL REFERENCES coop_lending.program(program_id),
  lender_org_id        uuid NOT NULL REFERENCES identity.organization(org_id),
  borrower_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  limit_amount         numeric(16,2) NOT NULL CHECK (limit_amount > 0),
  purpose_limits       jsonb NOT NULL DEFAULT '{}'::jsonb,
  rate_pct             numeric(6,3) NOT NULL,
  member_rate_pct      numeric(6,3) CHECK (member_rate_pct IS NULL OR (member_rate_pct >= 0 AND member_rate_pct <= 30)),
  available_until      date NOT NULL,
  dedicated_account_id uuid REFERENCES coop_lending.bank_account(account_id),
  status               text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Suspended', 'Closed')),
  suspended_reason     text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_facility_borrower ON coop_lending.facility (borrower_org_id);
CREATE INDEX IF NOT EXISTS idx_cl_facility_lender ON coop_lending.facility (lender_org_id);

-- สินเชื่อซื้อเครื่องจักรและอุปกรณ์ (ผ่อนเป็นงวด)
CREATE TABLE IF NOT EXISTS coop_lending.asset_loan (
  asset_loan_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  facility_id          uuid NOT NULL REFERENCES coop_lending.facility(facility_id),
  borrower_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  lender_org_id        uuid NOT NULL REFERENCES identity.organization(org_id),
  buyer_type           text NOT NULL CHECK (buyer_type IN ('cooperative', 'member')),
  farmer_id            uuid REFERENCES identity.farmer(farmer_id),
  asset_kind           text NOT NULL CHECK (length(asset_kind) BETWEEN 2 AND 120),
  brand_model          text NOT NULL CHECK (length(brand_model) BETWEEN 2 AND 160),
  seller_org_id        uuid NOT NULL REFERENCES identity.organization(org_id),
  quotation_no         text CHECK (quotation_no IS NULL OR length(quotation_no) <= 60),
  price                numeric(16,2) NOT NULL CHECK (price > 0),
  down_payment         numeric(16,2) NOT NULL CHECK (down_payment >= 0),
  loan_amount          numeric(16,2) NOT NULL CHECK (loan_amount > 0),
  rate_pct             numeric(6,3) NOT NULL,
  term_months          int NOT NULL CHECK (term_months BETWEEN 3 AND 120),
  interval_months      int NOT NULL CHECK (interval_months IN (1, 3, 6, 12)),
  grace_periods        int NOT NULL DEFAULT 0 CHECK (grace_periods BETWEEN 0 AND 4),
  income_per_period    numeric(16,2) NOT NULL CHECK (income_per_period > 0),
  income_basis         text NOT NULL CHECK (length(income_basis) BETWEEN 3 AND 1000),
  installment          numeric(16,2) NOT NULL,
  income_ratio_pct     numeric(7,2) NOT NULL,
  serial_no            text CHECK (serial_no IS NULL OR length(serial_no) BETWEEN 3 AND 60),
  status               text NOT NULL DEFAULT 'Submitted' CHECK (status IN ('Submitted', 'Approved', 'Rejected', 'Active', 'Closed', 'Cancelled')),
  decided_reason       text,
  decided_at           timestamptz,
  decided_by           text,
  funded_at            date,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (down_payment + loan_amount = price),
  CHECK ((buyer_type = 'member') = (farmer_id IS NOT NULL)),
  CHECK (status <> 'Rejected' OR decided_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_asset_serial ON coop_lending.asset_loan (lower(serial_no)) WHERE serial_no IS NOT NULL AND status NOT IN ('Rejected', 'Cancelled');
CREATE INDEX IF NOT EXISTS idx_cl_asset_loan_facility ON coop_lending.asset_loan (facility_id);

CREATE TABLE IF NOT EXISTS coop_lending.repayment_schedule (
  asset_loan_id  uuid NOT NULL REFERENCES coop_lending.asset_loan(asset_loan_id) ON DELETE CASCADE,
  seq            int NOT NULL CHECK (seq >= 1),
  due_date       date NOT NULL,
  principal      numeric(16,2) NOT NULL,
  interest       numeric(16,2) NOT NULL,
  installment    numeric(16,2) NOT NULL,
  paid_amount    numeric(16,2) NOT NULL DEFAULT 0,
  penalty_paid   numeric(16,2) NOT NULL DEFAULT 0,
  paid_at        date,
  PRIMARY KEY (asset_loan_id, seq)
);

-- รายการเบิก (หนึ่งรายการ = จ่ายผู้ขายหนึ่งราย ตามหลักฐานหนึ่งชุด)
CREATE TABLE IF NOT EXISTS coop_lending.disbursement_item (
  item_id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  facility_id          uuid NOT NULL REFERENCES coop_lending.facility(facility_id),
  borrower_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  lender_org_id        uuid NOT NULL REFERENCES identity.organization(org_id),
  purpose              text NOT NULL CHECK (purpose IN ('inputs', 'machinery_service', 'procurement', 'asset')),
  farmer_id            uuid REFERENCES identity.farmer(farmer_id),
  seller_type          text NOT NULL CHECK (seller_type IN ('organization', 'farmer')),
  seller_id            uuid NOT NULL,
  seller_name          text NOT NULL,
  payout_account_id    uuid REFERENCES coop_lending.bank_account(account_id),
  amount               numeric(16,2) NOT NULL CHECK (amount > 0),
  description          text NOT NULL CHECK (length(description) BETWEEN 3 AND 500),
  source_type          text NOT NULL CHECK (source_type IN ('product_order', 'machinery_booking', 'produce_delivery', 'asset_loan', 'manual')),
  source_id            uuid,
  doc_no               text CHECK (doc_no IS NULL OR length(doc_no) BETWEEN 1 AND 60),
  service_date         date,
  service_area_rai     numeric(10,2) CHECK (service_area_rai IS NULL OR service_area_rai > 0),
  status               text NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'EvidencePending', 'EvidenceComplete', 'Funded', 'Paid', 'Rejected', 'Disputed', 'Cancelled')),
  farmer_confirmed_at  timestamptz,
  farmer_note          text,
  submitted_at         timestamptz,
  evidence_complete_at timestamptz,
  sc_due_date          date,
  funded_at            timestamptz,
  ac_due_date          date,
  paid_at              timestamptz,
  sc_penalty           numeric(16,2) NOT NULL DEFAULT 0,
  ac_penalty           numeric(16,2) NOT NULL DEFAULT 0,
  -- เงินกู้ชั้นสหกรณ์ของรายการนี้ (ไม่ใช้กับ purpose='asset' ซึ่งผ่อนตาม repayment_schedule)
  loan_due_date        date,
  principal_outstanding numeric(16,2) NOT NULL DEFAULT 0,
  interest_unpaid      numeric(16,2) NOT NULL DEFAULT 0,
  interest_accrued_to  date,
  satellite_result     text CHECK (satellite_result IS NULL OR satellite_result IN ('pass', 'review', 'insufficient', 'na')),
  satellite_detail     jsonb,
  satellite_checked_at timestamptz,
  satellite_ack_by     text,
  returned_reason      text,
  rejected_reason      text,
  disputed_reason      text,
  created_by           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_type = 'manual') = (source_id IS NULL)),
  CHECK (seller_type <> 'organization' OR seller_id <> borrower_org_id)
);
-- ต้นทางหนึ่ง (คำสั่งซื้อ/การจอง/การส่งผลผลิต/สินเชื่อเครื่องจักร) เบิกได้ครั้งเดียวทั้งแพลตฟอร์ม
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_item_source ON coop_lending.disbursement_item (source_type, source_id)
  WHERE source_id IS NOT NULL AND status NOT IN ('Rejected', 'Cancelled');
-- เลขเอกสาร (ใบกำกับภาษี) ของผู้ขายรายหนึ่งใช้ได้ครั้งเดียว
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_item_doc ON coop_lending.disbursement_item (seller_id, lower(doc_no))
  WHERE doc_no IS NOT NULL AND status NOT IN ('Rejected', 'Cancelled');
CREATE INDEX IF NOT EXISTS idx_cl_item_facility ON coop_lending.disbursement_item (facility_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_item_lender ON coop_lending.disbursement_item (lender_org_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_item_farmer ON coop_lending.disbursement_item (farmer_id, status);

CREATE TABLE IF NOT EXISTS coop_lending.item_plot (
  item_id  uuid NOT NULL REFERENCES coop_lending.disbursement_item(item_id) ON DELETE CASCADE,
  unit_id  uuid NOT NULL REFERENCES registry.production_unit(unit_id),
  PRIMARY KEY (item_id, unit_id)
);

-- หลักฐาน (ไฟล์อัปโหลดผ่าน /storage/upload แล้วผูกที่นี่) — ไฟล์เดียวกัน (sha256) ใช้ได้ครั้งเดียวทั้งแพลตฟอร์ม
CREATE TABLE IF NOT EXISTS coop_lending.evidence (
  evidence_id  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id      uuid NOT NULL REFERENCES coop_lending.disbursement_item(item_id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('invoice', 'delivery_note', 'work_photo', 'weighing_slip', 'contract', 'down_payment_slip', 'serial_photo', 'ownership_doc', 'insurance', 'other')),
  file_id      uuid NOT NULL REFERENCES storage.file_object(file_id),
  sha256_hash  text NOT NULL,
  doc_no       text CHECK (doc_no IS NULL OR length(doc_no) <= 60),
  note         text CHECK (note IS NULL OR length(note) <= 300),
  uploaded_by  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_evidence_hash ON coop_lending.evidence (sha256_hash);
CREATE INDEX IF NOT EXISTS idx_cl_evidence_item ON coop_lending.evidence (item_id);

-- คำสั่งโอนผ่านธนาคาร (ผู้จัดทำ → ผู้อนุมัติคนละคน → ส่งธนาคาร)
CREATE TABLE IF NOT EXISTS coop_lending.bank_transfer (
  transfer_id        uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind               text NOT NULL CHECK (kind IN ('disbursement', 'seller_payment', 'repayment', 'installment', 'platform_fee')),
  initiator_org_id   uuid NOT NULL REFERENCES identity.organization(org_id),
  from_account_id    uuid NOT NULL REFERENCES coop_lending.bank_account(account_id),
  to_account_id      uuid NOT NULL REFERENCES coop_lending.bank_account(account_id),
  amount             numeric(16,2) NOT NULL CHECK (amount > 0),
  penalty_amount     numeric(16,2) NOT NULL DEFAULT 0,
  fee_amount         numeric(16,2) NOT NULL DEFAULT 0,
  memo               text NOT NULL,
  facility_id        uuid REFERENCES coop_lending.facility(facility_id),
  asset_loan_id      uuid REFERENCES coop_lending.asset_loan(asset_loan_id),
  idempotency_key    text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'PendingApproval' CHECK (status IN ('PendingApproval', 'Submitted', 'Succeeded', 'Failed', 'Cancelled')),
  prepared_by        text NOT NULL,
  prepared_by_label  text,
  approved_by        text,
  approved_by_label  text,
  gateway            text,
  bank_ref           text,
  failure_reason     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  approved_at        timestamptz,
  settled_at         timestamptz,
  CHECK (approved_by IS NULL OR approved_by <> prepared_by)
);
CREATE INDEX IF NOT EXISTS idx_cl_transfer_initiator ON coop_lending.bank_transfer (initiator_org_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS coop_lending.transfer_item (
  transfer_id  uuid NOT NULL REFERENCES coop_lending.bank_transfer(transfer_id),
  item_id      uuid NOT NULL REFERENCES coop_lending.disbursement_item(item_id),
  amount       numeric(16,2) NOT NULL,
  penalty      numeric(16,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (transfer_id, item_id)
);
-- รายการหนึ่งมีคำสั่งโอนแต่ละประเภทที่ยังไม่จบได้ครั้งละหนึ่ง (กันโอนซ้ำ) — ตรวจใน backend ภายใต้ FOR UPDATE

-- การชำระคืน (ชั้นสหกรณ์) — แยกดอกเบี้ย/ดอกเบี้ยผิดนัด/เงินต้น ตามรายการ
CREATE TABLE IF NOT EXISTS coop_lending.repayment (
  repayment_id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  facility_id     uuid NOT NULL REFERENCES coop_lending.facility(facility_id),
  asset_loan_id   uuid REFERENCES coop_lending.asset_loan(asset_loan_id),
  transfer_id     uuid NOT NULL UNIQUE REFERENCES coop_lending.bank_transfer(transfer_id),
  amount          numeric(16,2) NOT NULL CHECK (amount > 0),
  interest_part   numeric(16,2) NOT NULL DEFAULT 0,
  penalty_part    numeric(16,2) NOT NULL DEFAULT 0,
  principal_part  numeric(16,2) NOT NULL DEFAULT 0,
  allocation      jsonb NOT NULL DEFAULT '[]'::jsonb,
  paid_on         date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- การทวงถาม (แสดงในพอร์ทัลของฝ่ายที่ค้าง)
CREATE TABLE IF NOT EXISTS coop_lending.dunning_notice (
  notice_id      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  target_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  kind           text NOT NULL CHECK (kind IN ('sc_transfer_late', 'ac_payment_late', 'tranche_overdue', 'installment_overdue', 'facility_suspended')),
  item_id        uuid REFERENCES coop_lending.disbursement_item(item_id),
  asset_loan_id  uuid REFERENCES coop_lending.asset_loan(asset_loan_id),
  notice_date    date NOT NULL,
  days_late      int NOT NULL DEFAULT 0,
  amount         numeric(16,2),
  message        text NOT NULL,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- ทวงได้วันละครั้งต่อเรื่อง
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_dunning_day ON coop_lending.dunning_notice
  (target_org_id, kind, COALESCE(item_id, asset_loan_id), notice_date);
CREATE INDEX IF NOT EXISTS idx_cl_dunning_target ON coop_lending.dunning_notice (target_org_id, created_at DESC);

-- บันทึกเหตุการณ์แบบเพิ่มอย่างเดียว
CREATE TABLE IF NOT EXISTS coop_lending.event (
  event_id     bigserial PRIMARY KEY,
  item_id      uuid,
  facility_id  uuid,
  asset_loan_id uuid,
  actor        text NOT NULL,
  action       text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_event_item ON coop_lending.event (item_id, event_id);
CREATE INDEX IF NOT EXISTS idx_cl_event_facility ON coop_lending.event (facility_id, event_id);

COMMENT ON SCHEMA coop_lending IS 'สินเชื่อระหว่างสหกรณ์ (สหกรณ์ออมทรัพย์ → สหกรณ์การเกษตร) — ไม่มี RLS ทุก query ต้องกรองด้วย org_id/farmer_id ของผู้เรียก';

GRANT USAGE ON SCHEMA coop_lending TO agrolink_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA coop_lending TO agrolink_app;
GRANT DELETE ON coop_lending.holiday, coop_lending.item_plot TO agrolink_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA coop_lending TO agrolink_app;
-- event เป็นแบบเพิ่มอย่างเดียว
REVOKE UPDATE ON coop_lending.event FROM agrolink_app;
GRANT SELECT ON marketplace.product_order, marketplace.machinery_booking, produce.delivery, registry.production_unit TO agrolink_app;
GRANT SELECT ON ai.v_latest_assessment TO agrolink_app;
GRANT SELECT ON storage.file_object TO agrolink_app;
