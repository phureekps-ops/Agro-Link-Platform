-- AgroLink Platform — ตลาดสินเชื่อระหว่างสหกรณ์ (Cooperative Lending Marketplace) ตาม Concept Note เสนอกรมส่งเสริมสหกรณ์
-- ต่อยอด grant_coop_lending.sql และ grant_coop_lending_crop_plan.sql (ต้องรันสองไฟล์นั้นก่อน) — รันซ้ำได้ ไม่ลบข้อมูลเดิม
--
-- ผู้ขอกู้เป็นฝ่ายเริ่ม: สหกรณ์การเกษตรจัดทำ "โครงการขอกู้" (3 ประเภท) → ผู้ดูแลตรวจความครบถ้วน → ประกาศ
-- → สหกรณ์ออมทรัพย์ / สหกรณ์เครดิตยูเนี่ยนค้นหา ถาม–ตอบ ยื่นข้อเสนอ (เต็มวงเงินหรือบางส่วน ร่วมกันหลายรายได้)
-- → ผู้ขอกู้เปรียบเทียบ ยื่นข้อเสนอโต้ตอบ เลือก → ผู้ให้กู้ยืนยันตามอำนาจอนุมัติ (คนละคนกับผู้ยื่น) → จับคู่
-- → ระบบจัดทำชุดเอกสารสัญญา (.docx) → ทุกฝ่ายอัปโหลดฉบับลงนาม → ระบบเปิดวงเงิน (coop_lending.facility) ต่อผู้ให้กู้แต่ละราย
-- แล้วการเบิกจ่าย / โอน / ชำระคืน ใช้ระบบเดิมทั้งหมด
--
-- AgroLink เป็นผู้ให้บริการระบบเท่านั้น ไม่ใช่ผู้ให้สินเชื่อ ไม่รับฝากเงิน และไม่ถือเงินของคู่สัญญา

SET client_min_messages = warning;

-- ---------------------------------------------------------------------------
-- 1) ประเภทองค์กรใหม่: สหกรณ์เครดิตยูเนี่ยน (ผู้ให้กู้ เหมือนสหกรณ์ออมทรัพย์)
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
    SELECT array_agg(DISTINCT m[1]) INTO vals
      FROM regexp_matches(def, '([A-Z][A-Za-z]+)', 'g') AS m
     WHERE m[1] NOT IN ('ARRAY', 'ANY', 'CHECK');
    IF NOT ('CreditUnion' = ANY (vals)) THEN
      vals := vals || ARRAY['CreditUnion'];
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', t.rel, t.con);
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[%s]))', t.rel, t.con, t.col,
        (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v));
    END IF;
  END LOOP;
END $$;

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
    IF v_org_type NOT IN ('Cooperative', 'SavingsCooperative', 'CreditUnion') THEN
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
-- 2) ฐานข้อมูลผู้ให้กู้ (Concept Note ข้อ 4.1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coop_lending.lender_profile (
  org_id               uuid PRIMARY KEY REFERENCES identity.organization(org_id),
  registration_no      text,
  province_code        text,
  member_count         int CHECK (member_count IS NULL OR member_count >= 0),
  signatories          text,                     -- ผู้มีอำนาจลงนาม
  contact              text,
  financials           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{year, total_assets, share_capital, deposits, reserve, loans, investments, net_income, audited}]
  allocatable_amount   numeric(16,2) CHECK (allocatable_amount IS NULL OR allocatable_amount >= 0),  -- วงเงินที่สหกรณ์กำหนดว่าพร้อมให้สหกรณ์อื่นกู้
  liquidity_note       text,                     -- เงินกันสำรองตามระเบียบ ภาระผูกพัน
  approval_authority   text,                     -- ข้อบังคับ/ระเบียบ ลำดับขั้นการอนุมัติ
  resolution_file_id   uuid REFERENCES storage.file_object(file_id),  -- มติที่ประชุมใหญ่/คณะกรรมการที่อนุญาตให้กู้แก่สหกรณ์อื่น
  policy               jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- policy: { project_types[], min_amount, max_amount, min_tenor_months, max_tenor_months, rate_min, rate_max,
  --           collateral[], provinces[], commodities[], max_risk_grade, limit_per_borrower, limit_per_province, limit_per_type{} }
  data_as_of           date,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text
);

-- ---------------------------------------------------------------------------
-- 3) ฐานข้อมูลผู้ขอกู้ (Concept Note ข้อ 4.2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coop_lending.borrower_profile (
  org_id               uuid PRIMARY KEY REFERENCES identity.organization(org_id),
  coop_kind            text NOT NULL DEFAULT 'agriculture' CHECK (coop_kind IN ('agriculture', 'settlement', 'fisheries')),
  registration_no      text,
  established_year     int CHECK (established_year IS NULL OR established_year BETWEEN 2400 AND 2700),
  member_count         int CHECK (member_count IS NULL OR member_count >= 0),
  board                text,                     -- คณะกรรมการ ผู้จัดการ ผู้มีอำนาจลงนาม
  signatories          text,
  financials           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- [{year, total_assets, total_liabilities, equity, share_capital, reserve, current_assets, current_liabilities, revenue, net_income, audit_opinion}]
  businesses           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {credit:{volume,value}, supply:{}, collection:{}, processing:{}, service:{}}
  debts                jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{creditor, outstanding, status: 'current'|'late'|'restructured'|'default'}]
  assets               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{kind, description, value, pledged}]
  governance           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {standard_grade, audit_findings, unresolved_issues}
  consent_disclose     boolean NOT NULL DEFAULT false,        -- ยินยอมเปิดเผยข้อมูลแก่ผู้ให้กู้ในระบบ
  consent_at           timestamptz,
  data_as_of           date,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text
);

-- ---------------------------------------------------------------------------
-- 4) โครงการขอกู้ (Concept Note ข้อ 5–6)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coop_lending.loan_listing (
  listing_id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  borrower_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  project_type       text NOT NULL CHECK (project_type IN ('member_onlending', 'procurement', 'investment')),
  title              text NOT NULL CHECK (length(title) BETWEEN 5 AND 200),
  objective          text,
  amount_requested   numeric(16,2) NOT NULL CHECK (amount_requested > 0),
  min_amount         numeric(16,2) CHECK (min_amount IS NULL OR min_amount > 0),  -- รับข้อเสนอบางส่วนขั้นต่ำ
  tenor_months       int NOT NULL CHECK (tenor_months BETWEEN 1 AND 180),
  grace_months       int NOT NULL DEFAULT 0 CHECK (grace_months BETWEEN 0 AND 60),
  use_plan           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{item, amount, timing}]
  repayment_plan     text,
  repayment_source   text,
  collateral         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{kind, description, value}]
  province_code      text,
  commodities        text[] NOT NULL DEFAULT '{}',
  details            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- member_onlending: {members_count, per_member_limit, member_repayment_pct, production_plan, plots_count, area_rai}
  -- procurement:      {commodity, volume_t, period_from, period_to, reference_price, end_buyers, history}
  -- investment:       {business_plan, vendor, quotation_total, payback_years, projections:[{year, revenue, cost, net_cash}]}
  resolution_file_id uuid REFERENCES storage.file_object(file_id),   -- มติที่ประชุมที่อนุมัติให้กู้
  certified_by       text,                                            -- ผู้ขอกู้รับรองความถูกต้องของข้อมูล
  certified_at       timestamptz,
  score              jsonb,                                           -- คะแนนความน่าเชื่อถือ ณ วันส่งตรวจ/ประกาศ
  status             text NOT NULL DEFAULT 'Draft' CHECK (status IN
                       ('Draft', 'Review', 'Listed', 'Offered', 'Matched', 'Signed', 'Active', 'Closed', 'Withdrawn', 'Returned')),
  review_note        text,
  reviewed_by        text,
  listed_at          timestamptz,
  offers_close_on    date,
  matched_at         timestamptz,
  signed_at          timestamptz,
  closed_at          timestamptz,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (min_amount IS NULL OR min_amount <= amount_requested)
);
CREATE INDEX IF NOT EXISTS idx_cl_listing_borrower ON coop_lending.loan_listing (borrower_org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cl_listing_status ON coop_lending.loan_listing (status, listed_at DESC);

CREATE TABLE IF NOT EXISTS coop_lending.listing_document (
  doc_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id   uuid NOT NULL REFERENCES coop_lending.loan_listing(listing_id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('resolution', 'financial_statement', 'business_plan', 'quotation', 'member_list',
                                             'production_plan', 'buyer_contract', 'collateral', 'other')),
  title        text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  file_id      uuid NOT NULL REFERENCES storage.file_object(file_id),
  uploaded_by  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_listing_doc ON coop_lending.listing_document (listing_id);

-- ถาม–ตอบ (ผู้ให้กู้ทุกรายเห็นคำถามและคำตอบ โดยไม่เปิดเผยชื่อผู้ถาม)
CREATE TABLE IF NOT EXISTS coop_lending.listing_question (
  question_id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id     uuid NOT NULL REFERENCES coop_lending.loan_listing(listing_id) ON DELETE CASCADE,
  lender_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  kind           text NOT NULL DEFAULT 'question' CHECK (kind IN ('question', 'document_request', 'visit_request')),
  question       text NOT NULL CHECK (length(question) BETWEEN 3 AND 2000),
  asked_by       text NOT NULL,
  answer         text CHECK (answer IS NULL OR length(answer) <= 4000),
  answer_file_id uuid REFERENCES storage.file_object(file_id),
  answered_by    text,
  answered_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_listing_q ON coop_lending.listing_question (listing_id, created_at);

-- ข้อเสนอการให้กู้
CREATE TABLE IF NOT EXISTS coop_lending.loan_offer (
  offer_id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id         uuid NOT NULL REFERENCES coop_lending.loan_listing(listing_id),
  lender_org_id      uuid NOT NULL REFERENCES identity.organization(org_id),
  amount             numeric(16,2) NOT NULL CHECK (amount > 0),
  rate_pct           numeric(6,3) NOT NULL CHECK (rate_pct >= 0 AND rate_pct <= 30),
  tenor_months       int NOT NULL CHECK (tenor_months BETWEEN 1 AND 180),
  repayment_type     text NOT NULL DEFAULT 'installment' CHECK (repayment_type IN ('installment', 'bullet')),
  interval_months    int NOT NULL DEFAULT 6 CHECK (interval_months IN (1, 3, 6, 12)),
  grace_months       int NOT NULL DEFAULT 0 CHECK (grace_months BETWEEN 0 AND 60),
  collateral_required text CHECK (collateral_required IS NULL OR length(collateral_required) <= 2000),
  conditions         text CHECK (conditions IS NULL OR length(conditions) <= 4000),
  valid_until        date,
  status             text NOT NULL DEFAULT 'Submitted' CHECK (status IN
                       ('Submitted', 'Countered', 'Accepted', 'Confirmed', 'Declined', 'Withdrawn', 'Expired', 'Superseded')),
  counter            jsonb,                 -- ข้อเสนอโต้ตอบของผู้ขอกู้ {amount, rate_pct, tenor_months, note}
  countered_at       timestamptz,
  submitted_by       text NOT NULL,
  accepted_at        timestamptz,
  accepted_by        text,
  confirmed_at       timestamptz,
  confirmed_by       text,                  -- ผู้ยืนยันตามอำนาจอนุมัติของผู้ให้กู้ ต้องไม่ใช่ผู้ยื่น
  approval_ref       text,                  -- เลขที่มติ/บันทึกอนุมัติของผู้ให้กู้
  decline_reason     text,
  warnings           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- แจ้งเตือนเพดาน ณ วันยื่น
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (confirmed_by IS NULL OR confirmed_by <> submitted_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cl_offer_live ON coop_lending.loan_offer (listing_id, lender_org_id)
  WHERE status IN ('Submitted', 'Countered', 'Accepted', 'Confirmed');
CREATE INDEX IF NOT EXISTS idx_cl_offer_lender ON coop_lending.loan_offer (lender_org_id, created_at DESC);

-- สัญญา (จับคู่แล้ว) — หนึ่งสัญญาต่อโครงการ ผู้ให้กู้ร่วมหลายรายได้ (สัดส่วนตามวงเงิน รับชำระตามสัดส่วนเท่าเทียมกัน)
CREATE TABLE IF NOT EXISTS coop_lending.loan_agreement (
  agreement_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id         uuid NOT NULL UNIQUE REFERENCES coop_lending.loan_listing(listing_id),
  agreement_no       text NOT NULL UNIQUE,
  total_amount       numeric(16,2) NOT NULL CHECK (total_amount > 0),
  status             text NOT NULL DEFAULT 'Drafted' CHECK (status IN ('Drafted', 'Signed', 'Cancelled')),
  doc_version        int NOT NULL DEFAULT 1,
  borrower_signed_file_id uuid REFERENCES storage.file_object(file_id),
  borrower_signed_at timestamptz,
  borrower_signed_by text,
  project_account_id uuid REFERENCES coop_lending.bank_account(account_id),
  start_date         date,
  created_at         timestamptz NOT NULL DEFAULT now(),
  signed_at          timestamptz
);
CREATE TABLE IF NOT EXISTS coop_lending.agreement_lender (
  agreement_id     uuid NOT NULL REFERENCES coop_lending.loan_agreement(agreement_id) ON DELETE CASCADE,
  offer_id         uuid NOT NULL REFERENCES coop_lending.loan_offer(offer_id),
  lender_org_id    uuid NOT NULL REFERENCES identity.organization(org_id),
  amount           numeric(16,2) NOT NULL CHECK (amount > 0),
  share_pct        numeric(7,4) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  signed_file_id   uuid REFERENCES storage.file_object(file_id),
  signed_at        timestamptz,
  signed_by        text,
  facility_id      uuid REFERENCES coop_lending.facility(facility_id),
  PRIMARY KEY (agreement_id, offer_id)
);

-- รายงานผลการดำเนินงานเทียบแผน (โครงการลงทุน รายเดือน/รายไตรมาส และทุกประเภทได้)
CREATE TABLE IF NOT EXISTS coop_lending.listing_report (
  report_id     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id    uuid NOT NULL REFERENCES coop_lending.loan_listing(listing_id),
  period_label  text NOT NULL CHECK (length(period_label) BETWEEN 2 AND 40),
  revenue       numeric(16,2),
  cost          numeric(16,2),
  planned_revenue numeric(16,2),
  note          text CHECK (note IS NULL OR length(note) <= 2000),
  file_id       uuid REFERENCES storage.file_object(file_id),
  reported_by   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_listing_report ON coop_lending.listing_report (listing_id, created_at);

-- วงเงินที่เกิดจากตลาด: program/application ภายในระบบ (ไม่แสดงในรายการโครงการให้กู้เดิม)
ALTER TABLE coop_lending.program ADD COLUMN IF NOT EXISTS listing_id uuid REFERENCES coop_lending.loan_listing(listing_id);
ALTER TABLE coop_lending.application ADD COLUMN IF NOT EXISTS listing_id uuid REFERENCES coop_lending.loan_listing(listing_id);
ALTER TABLE coop_lending.facility ADD COLUMN IF NOT EXISTS listing_id uuid REFERENCES coop_lending.loan_listing(listing_id);
ALTER TABLE coop_lending.facility ADD COLUMN IF NOT EXISTS agreement_id uuid REFERENCES coop_lending.loan_agreement(agreement_id);
-- โครงการรับซื้อ: ราคาอ้างอิงตรวจมูลค่ารับซื้อแต่ละรายการ
ALTER TABLE coop_lending.disbursement_item ADD COLUMN IF NOT EXISTS price_check jsonb;

-- หลักฐานรับซื้อผลผลิตครบตาม Concept Note: ใบชั่ง + ใบตรวจคุณภาพ + ใบรับซื้อ · งานลงทุน: ใบตรวจรับงาน
ALTER TABLE coop_lending.evidence DROP CONSTRAINT IF EXISTS evidence_kind_check;
ALTER TABLE coop_lending.evidence ADD CONSTRAINT evidence_kind_check CHECK (kind IN ('invoice', 'delivery_note', 'work_photo', 'weighing_slip',
  'quality_slip', 'purchase_receipt', 'acceptance_report', 'contract', 'down_payment_slip', 'serial_photo', 'ownership_doc', 'insurance', 'other'));

-- การแจ้งเตือนเพิ่มชนิด: โครงการตรงนโยบาย, มีข้อเสนอใหม่, ข้อเสนอถูกตอบรับ/โต้ตอบ, คำถามใหม่, เกินเพดาน
ALTER TABLE coop_lending.dunning_notice DROP CONSTRAINT IF EXISTS dunning_notice_kind_check;
ALTER TABLE coop_lending.dunning_notice ADD CONSTRAINT dunning_notice_kind_check CHECK (kind IN (
  'sc_transfer_late', 'ac_payment_late', 'tranche_overdue', 'installment_overdue', 'facility_suspended', 'plan_held', 'stage_check_waiting',
  'listing_match', 'offer_received', 'offer_update', 'question', 'listing_review', 'agreement'));
ALTER TABLE coop_lending.dunning_notice ADD COLUMN IF NOT EXISTS listing_id uuid REFERENCES coop_lending.loan_listing(listing_id);

COMMENT ON TABLE coop_lending.loan_listing IS 'โครงการขอกู้ที่สหกรณ์การเกษตรประกาศ (ตลาดสินเชื่อระหว่างสหกรณ์) — ผู้ให้กู้ยื่นข้อเสนอ จับคู่ แล้วระบบจัดทำสัญญา';

GRANT SELECT, INSERT, UPDATE ON coop_lending.lender_profile, coop_lending.borrower_profile, coop_lending.loan_listing,
  coop_lending.listing_document, coop_lending.listing_question, coop_lending.loan_offer, coop_lending.loan_agreement,
  coop_lending.agreement_lender, coop_lending.listing_report TO agrolink_app;
GRANT DELETE ON coop_lending.listing_document TO agrolink_app;
