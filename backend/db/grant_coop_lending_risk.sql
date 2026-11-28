-- AgroLink -- ตลาดสินเชื่อระหว่างสหกรณ์: ระบบเตือนภัยล่วงหน้า (Master Blueprint ข้อ 9.3) และสัญญาณทุจริต (ข้อ 10.3)
--   ระบบตรวจทุก 6 ชั่วโมง (และผู้ดูแลกดตรวจทันทีได้) บันทึกสัญญาณลง coop_lending.risk_alert
--   ทุกสัญญาณเป็น "เรื่องที่ต้องตรวจสอบ" ไม่ใช่ข้อสรุปว่ามีการทุจริต — ผู้ดูแลแพลตฟอร์มสอบสวน ผู้กู้ชี้แจง แล้วปิดเรื่อง
--   สัญญาณทุจริตแสดงต่อผู้กู้เมื่อผู้ดูแลเปิดการสอบสวนแล้วเท่านั้น (ผู้ให้กู้ของสัญญาเห็นทันที)
--
-- รันหลัง grant_coop_lending_controls.sql · รันซ้ำได้
-- ============================================================================
SET client_min_messages = warning;

-- เกณฑ์ (ผู้ดูแลปรับได้ในหน้าผู้ดูแล)
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS ew_purchase_below_pct numeric(6,2) NOT NULL DEFAULT 70;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS ew_price_drop_pct numeric(6,2) NOT NULL DEFAULT 15;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS ew_report_days int NOT NULL DEFAULT 100;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS ew_revenue_below_pct numeric(6,2) NOT NULL DEFAULT 70;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS ew_inventory_gap_pct numeric(6,2) NOT NULL DEFAULT 20;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS fraud_split_days int NOT NULL DEFAULT 90;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS fraud_new_member_days int NOT NULL DEFAULT 30;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS fraud_yield_factor numeric(6,2) NOT NULL DEFAULT 1.5;
ALTER TABLE coop_lending.setting ADD COLUMN IF NOT EXISTS risk_swept_at timestamptz;

-- ผู้กู้รายงานยอดที่ผู้ซื้อค้างชำระ (เตือนภัยข้อ "ผู้ซื้อผิดนัดชำระ")
ALTER TABLE coop_lending.listing_report ADD COLUMN IF NOT EXISTS buyer_overdue numeric(16,2) CHECK (buyer_overdue IS NULL OR buyer_overdue >= 0);

-- ---------------------------------------------------------------------------
-- สัญญาณความเสี่ยง
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coop_lending.risk_alert (
  alert_id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  category         text NOT NULL CHECK (category IN ('early_warning', 'fraud')),
  code             text NOT NULL,
  severity         text NOT NULL CHECK (severity IN ('warning', 'high')),
  title            text NOT NULL,
  detail           text NOT NULL,
  extra            jsonb,
  borrower_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  listing_id       uuid REFERENCES coop_lending.loan_listing(listing_id),
  agreement_id     uuid REFERENCES coop_lending.loan_agreement(agreement_id),
  item_id          uuid REFERENCES coop_lending.disbursement_item(item_id),
  dedupe_key       text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Investigating', 'Resolved', 'Dismissed')),
  active           boolean NOT NULL DEFAULT true,       -- ยังพบเงื่อนไขในการตรวจครั้งล่าสุด
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  borrower_note    text CHECK (borrower_note IS NULL OR length(borrower_note) <= 2000),
  borrower_note_by text,
  borrower_note_at timestamptz,
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text CHECK (decision_note IS NULL OR length(decision_note) <= 2000)
);
CREATE INDEX IF NOT EXISTS idx_cl_risk_borrower ON coop_lending.risk_alert (borrower_org_id, status);
CREATE INDEX IF NOT EXISTS idx_cl_risk_listing ON coop_lending.risk_alert (listing_id);
CREATE INDEX IF NOT EXISTS idx_cl_risk_status ON coop_lending.risk_alert (status, category, last_seen_at DESC);

-- ผู้มีผลประโยชน์ร่วมที่สหกรณ์ผู้กู้แจ้ง (กรรมการ/ผู้จัดการ และกิจการที่เกี่ยวข้อง)
CREATE TABLE IF NOT EXISTS coop_lending.related_party (
  party_id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  borrower_org_id  uuid NOT NULL REFERENCES identity.organization(org_id),
  person_name      text NOT NULL CHECK (length(person_name) BETWEEN 2 AND 160),
  role             text CHECK (role IS NULL OR length(role) <= 80),
  related_name     text CHECK (related_name IS NULL OR length(related_name) <= 200),
  related_tax_id   text CHECK (related_tax_id IS NULL OR related_tax_id ~ '^[0-9]{13}$'),
  related_org_id   uuid REFERENCES identity.organization(org_id),
  declared_by      text NOT NULL,
  declared_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_related_party ON coop_lending.related_party (borrower_org_id);

-- ประวัติการแก้งบการเงินของผู้กู้ (ตรวจการแก้ข้อมูลย้อนหลัง)
CREATE TABLE IF NOT EXISTS coop_lending.profile_history (
  history_id      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id          uuid NOT NULL REFERENCES identity.organization(org_id),
  old_financials  jsonb NOT NULL,
  new_financials  jsonb NOT NULL,
  changed_by      text,
  changed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cl_profile_history ON coop_lending.profile_history (org_id, changed_at);

CREATE OR REPLACE FUNCTION coop_lending.log_profile_financials() RETURNS trigger AS $$
BEGIN
  IF NEW.financials IS DISTINCT FROM OLD.financials THEN
    INSERT INTO coop_lending.profile_history (org_id, old_financials, new_financials, changed_by)
    VALUES (NEW.org_id, COALESCE(OLD.financials, '[]'::jsonb), COALESCE(NEW.financials, '[]'::jsonb), NEW.updated_by);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cl_profile_history ON coop_lending.borrower_profile;
CREATE TRIGGER trg_cl_profile_history AFTER UPDATE ON coop_lending.borrower_profile
  FOR EACH ROW EXECUTE FUNCTION coop_lending.log_profile_financials();

-- การแจ้งเตือน: สัญญาณความเสี่ยง
ALTER TABLE coop_lending.dunning_notice DROP CONSTRAINT IF EXISTS dunning_notice_kind_check;
ALTER TABLE coop_lending.dunning_notice ADD CONSTRAINT dunning_notice_kind_check CHECK (kind IN (
  'sc_transfer_late', 'ac_payment_late', 'tranche_overdue', 'installment_overdue', 'facility_suspended', 'plan_held', 'stage_check_waiting',
  'listing_match', 'offer_received', 'offer_update', 'question', 'listing_review', 'agreement', 'tranche_review', 'compliance', 'risk_alert'));

COMMENT ON TABLE coop_lending.risk_alert IS 'สัญญาณเตือนภัยล่วงหน้า (Blueprint 9.3) และสัญญาณทุจริต (10.3) — เป็นเรื่องที่ต้องตรวจสอบ ไม่ใช่ข้อสรุปว่ามีการทุจริต';

GRANT SELECT, INSERT, UPDATE ON coop_lending.risk_alert, coop_lending.profile_history TO agrolink_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON coop_lending.related_party TO agrolink_app;
GRANT SELECT ON identity.farmer_org_relationship TO agrolink_app;
