-- AgroLink -- ทะเบียนสหกรณ์ล่วงหน้า (Cooperative Directory) สำหรับตลาดสินเชื่อระหว่างสหกรณ์
--   1) ผู้ดูแลนำเข้ารายชื่อสหกรณ์จากไฟล์ทะเบียน (Excel/CSV) — ยังไม่เปิดบัญชีให้ใคร
--   2) สหกรณ์ที่สมัคร/ถูกจัดตั้งในระบบแล้ว "ยืนยันสิทธิ์" รายการของตน (แนบหนังสือมอบอำนาจ/มติ) → ผู้ดูแลตรวจ → เชื่อมกัน
--      หรือผู้ดูแลเชื่อม/จัดตั้งบัญชีสหกรณ์การเกษตรจากรายการโดยตรง
--   3) นำเข้างบการเงินจากแหล่งทางการ (เช่น งบที่ผู้สอบบัญชีรับรอง) → เทียบกับที่สหกรณ์ผู้กู้กรอก
--      ไม่ตรง = สัญญาณ fr_official_mismatch ในระบบสัญญาณทุจริต (grant_coop_lending_risk.sql)
--   4) กรมส่งเสริมสหกรณ์เห็นว่าสหกรณ์ไหนในจังหวัดยังไม่เข้าร่วม
--
-- รันหลัง grant_coop_lending_risk.sql · รันซ้ำได้
-- ============================================================================
SET client_min_messages = warning;

CREATE TABLE IF NOT EXISTS registry.coop_directory_import (
  import_id     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind          text NOT NULL CHECK (kind IN ('directory', 'financials')),
  filename      text NOT NULL,
  file_format   text NOT NULL,
  file_sha256   text NOT NULL,
  source_label  text NOT NULL CHECK (length(source_label) BETWEEN 2 AND 200),   -- เช่น "กรมส่งเสริมสหกรณ์ ทะเบียน ณ 30 ก.ย. 2569"
  as_of         date,
  rows          jsonb NOT NULL,                 -- แถวที่แปลงแล้ว (ใช้ตอนยืนยัน)
  summary       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'Preview' CHECK (status IN ('Preview', 'Committed', 'Discarded')),
  result        jsonb,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  committed_by  text,
  committed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_coop_dir_import ON registry.coop_directory_import (created_at DESC);

CREATE TABLE IF NOT EXISTS registry.coop_directory (
  directory_id     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  coop_type        text NOT NULL CHECK (coop_type IN ('agriculture', 'fisheries', 'settlement', 'store', 'service', 'savings', 'credit_union')),
  coop_name        text NOT NULL CHECK (length(coop_name) BETWEEN 3 AND 300),
  name_key         text NOT NULL,                -- ชื่อที่ตัดคำนำหน้า/ช่องว่าง ใช้จับคู่
  registration_no  text CHECK (registration_no IS NULL OR length(registration_no) BETWEEN 1 AND 60),
  tax_id           text CHECK (tax_id IS NULL OR tax_id ~ '^[0-9]{13}$'),
  province_code    text NOT NULL REFERENCES registry.province(province_code),
  district         text,
  established_year int CHECK (established_year IS NULL OR established_year BETWEEN 2400 AND 2700),
  member_count     int CHECK (member_count IS NULL OR member_count >= 0),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'dissolving', 'dissolved')),
  source_label     text NOT NULL,
  import_id        uuid REFERENCES registry.coop_directory_import(import_id),
  org_id           uuid UNIQUE REFERENCES identity.organization(org_id),   -- บัญชีในระบบที่ยืนยันแล้ว
  linked_at        timestamptz,
  linked_by        text,
  link_method      text CHECK (link_method IS NULL OR link_method IN ('claim', 'admin_link', 'provisioned')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_coop_dir_regno ON registry.coop_directory (registration_no) WHERE registration_no IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_coop_dir_tax ON registry.coop_directory (tax_id) WHERE tax_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_coop_dir_province ON registry.coop_directory (province_code, coop_type);
CREATE INDEX IF NOT EXISTS idx_coop_dir_name ON registry.coop_directory (name_key);

-- งบการเงินจากแหล่งทางการ (ต่อรายการทะเบียน ต่อปีบัญชี พ.ศ.)
CREATE TABLE IF NOT EXISTS registry.coop_directory_financial (
  directory_id        uuid NOT NULL REFERENCES registry.coop_directory(directory_id) ON DELETE CASCADE,
  year                int NOT NULL CHECK (year BETWEEN 2400 AND 2700),
  total_assets        numeric(18,2),
  total_liabilities   numeric(18,2),
  equity              numeric(18,2),
  share_capital       numeric(18,2),
  reserve             numeric(18,2),
  current_assets      numeric(18,2),
  current_liabilities numeric(18,2),
  revenue             numeric(18,2),
  net_income          numeric(18,2),
  audit_opinion       text,
  source_label        text NOT NULL,
  import_id           uuid REFERENCES registry.coop_directory_import(import_id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (directory_id, year)
);

-- คำขอยืนยันสิทธิ์ของสหกรณ์ที่มีบัญชีในระบบแล้ว
CREATE TABLE IF NOT EXISTS registry.coop_directory_claim (
  claim_id       uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  directory_id   uuid NOT NULL REFERENCES registry.coop_directory(directory_id),
  org_id         uuid NOT NULL REFERENCES identity.organization(org_id),
  contact_name   text NOT NULL CHECK (length(contact_name) BETWEEN 2 AND 160),
  contact_position text CHECK (contact_position IS NULL OR length(contact_position) <= 120),
  note           text CHECK (note IS NULL OR length(note) <= 1000),
  file_id        uuid NOT NULL REFERENCES storage.file_object(file_id),   -- หนังสือมอบอำนาจ/มติคณะกรรมการ
  status         text NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Withdrawn')),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text CHECK (decision_note IS NULL OR length(decision_note) <= 1000)
);
-- องค์กรหนึ่งมีคำขอค้างได้ครั้งละหนึ่งรายการ
CREATE UNIQUE INDEX IF NOT EXISTS uq_coop_dir_claim_pending ON registry.coop_directory_claim (org_id) WHERE status = 'Pending';
CREATE INDEX IF NOT EXISTS idx_coop_dir_claim_status ON registry.coop_directory_claim (status, created_at);

-- สัญญาณใหม่: งบที่ผู้กู้กรอกไม่ตรงกับแหล่งทางการ (เกณฑ์ปรับได้)
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS fraud_official_diff_pct numeric(6,2) NOT NULL DEFAULT 5;

-- การแจ้งเตือน: ผลการยืนยันทะเบียนสหกรณ์
ALTER TABLE coop_lending.dunning_notice DROP CONSTRAINT IF EXISTS dunning_notice_kind_check;
ALTER TABLE coop_lending.dunning_notice ADD CONSTRAINT dunning_notice_kind_check CHECK (kind IN (
  'sc_transfer_late', 'ac_payment_late', 'tranche_overdue', 'installment_overdue', 'facility_suspended', 'plan_held', 'stage_check_waiting',
  'listing_match', 'offer_received', 'offer_update', 'question', 'listing_review', 'agreement', 'tranche_review', 'compliance', 'risk_alert', 'registry'));

COMMENT ON TABLE registry.coop_directory IS 'ทะเบียนสหกรณ์ล่วงหน้าจากไฟล์ทางการ — ไม่ใช่บัญชีผู้ใช้ เชื่อมกับ identity.organization เมื่อยืนยันสิทธิ์แล้ว';

GRANT SELECT, INSERT, UPDATE ON registry.coop_directory, registry.coop_directory_import, registry.coop_directory_financial, registry.coop_directory_claim TO agrolink_app;
